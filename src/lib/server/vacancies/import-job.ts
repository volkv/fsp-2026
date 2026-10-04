// Job `vacancies.import` (docs/domain.md, sections 13.2, 17.2; contracts 7): read the listing of one source page by
// page, then in one conditional write store the postings. The import journal (`vacancy_import_runs`) records every run
// with its completeness and counters. A posting is idempotent by `(source, external_id)` and `raw_sha256`: the same
// record again only confirms freshness; a changed one is normalized again. Postings leave only by a complete full
// listing (or a freshness check), never by an incremental or a partial one. A source whose listing mixes industries keeps only
// the postings the taxonomy recognizes as IT (`it-scope.ts`); the others are counted as `rejected.not_it`.
import { and, desc, eq, lt, ne, notInArray } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import { config } from '$lib/server/config';
import type { Database, Transaction } from '$lib/server/db';
import { vacancies, vacancyImportRuns, vacancyPostings, vacancySources } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { enqueueJob } from '$lib/server/jobs/queue';
import {
	findCluster,
	loadStaleAfterDays,
	PENDING_NORMALIZATION,
	PENDING_VERSION,
	postingKeys,
	recomputeCluster,
	sweepStaleness,
	type Dedup
} from './clusters';
import { enqueueRevisionDerivations } from './derivations';
import { disableRefusedSource } from './source-state';
import { itScopeOf } from './it-scope';
import { normalizationVersion, normalizePosting, originalTermsOf } from './normalize';
import { createVacancySource, type SourceFactoryDeps } from './sources/catalog';
import { sourceScheduleSchema, sourceTermsSchema } from './sources/definitions';
import type { SourceError, SourcePosting, VacancySource } from './sources/types';
import { checkVacancyText } from './text-check';
import { loadVacancyTaxonomy, TaxonomyUnavailable, type VacancyTaxonomy } from './taxonomy';

const system = { kind: 'system' } as const;

/** Pages one run reads at most: a guard against a source that never ends its listing. */
const MAX_PAGES = 500;
/** Freshness checks one run enqueues at most. */
const MAX_CHECKS = 500;

export interface ImportDeps {
	/** The adapter of a source key, bound to the run's signal; `null` — no adapter. */
	source: (key: string, signal: AbortSignal) => VacancySource | null;
	now: () => Date;
}

export interface ImportCounts {
	fetched: number;
	created: number;
	updated: number;
	unchanged: number;
	gone: number;
	reappeared: number;
	rejected: Record<string, number>;
}

const emptyCounts = (): ImportCounts => ({
	fetched: 0,
	created: 0,
	updated: 0,
	unchanged: 0,
	gone: 0,
	reappeared: 0,
	rejected: {}
});

type RunMode = 'full' | 'incremental';

interface RunRef {
	id: string;
	source: string;
	mode: RunMode;
}

interface RunOutcome {
	status: 'succeeded' | 'failed';
	completeness: 'complete' | 'partial';
	reason: string | null;
	counts: ImportCounts;
	cursor: string | null;
	now: Date;
}

/** Closes the run in the import journal. */
async function closeRun(tx: Transaction, run: RunRef, outcome: RunOutcome): Promise<void> {
	await tx
		.update(vacancyImportRuns)
		.set({
			status: outcome.status,
			completeness: outcome.completeness,
			incompleteReason: outcome.completeness === 'partial' ? (outcome.reason ?? 'unknown') : null,
			finishedAt: outcome.now,
			counts: outcome.counts,
			cursorState: outcome.cursor === null ? null : { cursor: outcome.cursor }
		})
		.where(eq(vacancyImportRuns.id, run.id));
}

/** Closes the run and records its completion in the audit journal. */
async function finishRun(tx: Transaction, run: RunRef, outcome: RunOutcome, requestId: string): Promise<void> {
	await closeRun(tx, run, outcome);
	await recordAuditEvent(tx, {
		action: 'vacancies.import_completed',
		outcome: outcome.status === 'succeeded' ? 'success' : 'failure',
		actor: system,
		object: { type: 'vacancy_import_run', id: run.id },
		requestId,
		details: {
			source: run.source,
			mode: run.mode,
			completeness: outcome.completeness,
			status: outcome.status,
			reason: outcome.reason,
			fetched: outcome.counts.fetched,
			created: outcome.counts.created,
			updated: outcome.counts.updated,
			gone: outcome.counts.gone
		}
	});
}

/** The start of an incremental listing: the start of the last succeeded run of the source. */
async function lastSuccessStart(db: Database, source: string): Promise<Date | null> {
	const [row] = await db
		.select({ startedAt: vacancyImportRuns.startedAt })
		.from(vacancyImportRuns)
		.where(and(eq(vacancyImportRuns.source, source), eq(vacancyImportRuns.status, 'succeeded')))
		.orderBy(desc(vacancyImportRuns.startedAt))
		.limit(1);
	return row?.startedAt ?? null;
}

type Listing =
	| { ok: true; items: Map<string, SourcePosting>; complete: boolean; reason: string | null; duplicates: number }
	| { ok: false; error: SourceError; cursor: string | null };

async function readListing(
	adapter: VacancySource,
	mode: RunMode,
	since: Date | null,
	signal: AbortSignal
): Promise<Listing> {
	const items = new Map<string, SourcePosting>();
	let duplicates = 0;
	let cursor: string | undefined;
	let version: string | null | undefined;
	let versionStable = true;
	for (let page = 0; page < MAX_PAGES; page++) {
		signal.throwIfAborted();
		const result = await adapter.list({
			mode,
			...(since === null ? {} : { since: since.toISOString() }),
			...(cursor === undefined ? {} : { cursor })
		});
		if (!result.ok) return { ok: false, error: result.error, cursor: cursor ?? null };
		if (version !== undefined && result.value.sourceVersion !== version) versionStable = false;
		version = result.value.sourceVersion;
		for (const item of result.value.items) {
			if (items.has(item.externalId)) duplicates++;
			items.set(item.externalId, item);
		}
		if (result.value.nextCursor === null) {
			const reason =
				mode === 'incremental'
					? 'incremental'
					: adapter.listing === 'recent_window'
						? 'recent_window_listing'
						: versionStable
							? null
							: 'source_version_changed';
			return { ok: true, items, complete: reason === null, reason, duplicates };
		}
		cursor = result.value.nextCursor;
	}
	return { ok: true, items, complete: false, reason: 'page_limit', duplicates };
}

interface StoreContext {
	run: RunRef;
	now: Date;
	taxonomy: VacancyTaxonomy;
	storeDescription: boolean;
	/** The listing mixes industries: only postings the taxonomy recognizes as IT are stored. */
	itFilter: boolean;
	counts: ImportCounts;
	/** Clusters whose postings changed in a way that changes the cluster without normalization (gone, back). */
	touched: Set<string>;
}

const organizationOf = (p: SourcePosting) => ({
	name: p.organization.name,
	inn: p.organization.inn,
	source_org_id: p.organization.sourceOrgId
});

const dateOrNull = (iso: string | null) => (iso === null ? null : new Date(iso));

async function enqueueNormalize(tx: Transaction, postingId: string, rawSha256: string): Promise<void> {
	await enqueueJob(tx, 'vacancy.normalize', { posting_id: postingId }, { inputVersion: rawSha256, createdBy: system });
}

/** Stores one posting of the listing; returns what happened to it. */
async function storePosting(tx: Transaction, posting: SourcePosting, ctx: StoreContext): Promise<void> {
	const { run, now, taxonomy } = ctx;
	if (posting.title.trim() === '' || posting.organization.name.trim() === '') {
		ctx.counts.rejected.missing_title_or_organization = (ctx.counts.rejected.missing_title_or_organization ?? 0) + 1;
		return;
	}
	if (ctx.itFilter) {
		const normalized = normalizePosting(posting.title, originalTermsOf(posting, ctx.storeDescription), taxonomy);
		if (!itScopeOf(normalized).it) {
			ctx.counts.rejected.not_it = (ctx.counts.rejected.not_it ?? 0) + 1;
			return;
		}
	}
	const [existing] = await tx
		.select()
		.from(vacancyPostings)
		.where(and(eq(vacancyPostings.source, run.source), eq(vacancyPostings.externalId, posting.externalId)))
		.for('update');

	if (existing) {
		const wasGone = existing.freshness === 'gone';
		if (existing.rawSha256 === posting.rawSha256) {
			await tx
				.update(vacancyPostings)
				.set({
					lastFetchedAt: now,
					lastCheckedAt: now,
					freshness: 'active',
					goneAt: null,
					lastImportRunId: run.id
				})
				.where(eq(vacancyPostings.id, existing.id));
			ctx.counts.unchanged++;
			if (existing.normalizationVersion !== normalizationVersion(taxonomy)) {
				await enqueueNormalize(tx, existing.id, existing.rawSha256);
			}
		} else {
			await tx
				.update(vacancyPostings)
				.set({
					url: posting.url,
					organization: organizationOf(posting),
					title: posting.title,
					originalTerms: originalTermsOf(posting, ctx.storeDescription),
					rawSha256: posting.rawSha256,
					sourcePublishedAt: dateOrNull(posting.publishedAt),
					sourceUpdatedAt: dateOrNull(posting.updatedAt),
					lastFetchedAt: now,
					lastCheckedAt: now,
					freshness: 'active',
					goneAt: null,
					lastImportRunId: run.id
				})
				.where(eq(vacancyPostings.id, existing.id));
			ctx.counts.updated++;
			await enqueueNormalize(tx, existing.id, posting.rawSha256);
		}
		if (wasGone) {
			ctx.counts.reappeared++;
			ctx.touched.add(existing.vacancyId);
		}
		return;
	}

	const keys = postingKeys({ title: posting.title, organization: posting.organization, city: posting.location.city });
	const cluster = await findCluster(tx, keys);
	let vacancyId: string;
	let dedup: Dedup;
	if (cluster) {
		vacancyId = cluster.vacancyId;
		dedup = cluster.dedup;
	} else {
		const description = ctx.storeDescription ? posting.description : null;
		const textCheck = checkVacancyText({ title: posting.title, description });
		const [created] = await tx
			.insert(vacancies)
			.values({
				origin: 'external',
				externalOrg: {
					name: posting.organization.name,
					...(posting.organization.inn === null ? {} : { inn: posting.organization.inn }),
					source_org_ids:
						posting.organization.sourceOrgId === null ? [] : [`${run.source}:${posting.organization.sourceOrgId}`]
				},
				title: posting.title,
				description,
				taxonomyVersionId: taxonomy.id,
				gradeBasis: 'unknown',
				textCheck,
				status: textCheck.result === 'blocked' ? 'hidden' : 'active'
			})
			.returning({ id: vacancies.id });
		if (!created) throw new Error('external vacancy was not inserted');
		vacancyId = created.id;
		dedup = { method: 'exact', score: 1, exact_key: keys.exact, fingerprint: keys.fingerprint };
	}
	const [inserted] = await tx
		.insert(vacancyPostings)
		.values({
			vacancyId,
			source: run.source,
			externalId: posting.externalId,
			url: posting.url,
			organization: organizationOf(posting),
			title: posting.title,
			originalTerms: originalTermsOf(posting, ctx.storeDescription),
			rawSha256: posting.rawSha256,
			normalized: PENDING_NORMALIZATION,
			normalizationVersion: PENDING_VERSION,
			sourcePublishedAt: dateOrNull(posting.publishedAt),
			sourceUpdatedAt: dateOrNull(posting.updatedAt),
			firstFetchedAt: now,
			lastFetchedAt: now,
			lastCheckedAt: now,
			freshness: 'active',
			dedup,
			lastImportRunId: run.id
		})
		.returning({ id: vacancyPostings.id });
	if (!inserted) throw new Error('posting was not inserted');
	ctx.counts.created++;
	await enqueueNormalize(tx, inserted.id, posting.rawSha256);
}

/** Postings of the source absent from a complete full listing are gone (domain 13.2). */
async function markAbsentGone(tx: Transaction, ctx: StoreContext, seen: readonly string[]): Promise<void> {
	const gone = await tx
		.update(vacancyPostings)
		.set({ freshness: 'gone', goneAt: ctx.now })
		.where(
			and(
				eq(vacancyPostings.source, ctx.run.source),
				ne(vacancyPostings.freshness, 'gone'),
				seen.length > 0 ? notInArray(vacancyPostings.externalId, [...seen]) : undefined
			)
		)
		.returning({ vacancyId: vacancyPostings.vacancyId });
	ctx.counts.gone = gone.length;
	for (const row of gone) ctx.touched.add(row.vacancyId);
}

/** Freshness checks of live postings of the source not confirmed for longer than the schedule allows. */
async function enqueueFreshnessChecks(tx: Transaction, source: string, olderThan: Date): Promise<number> {
	const due = await tx
		.select({ id: vacancyPostings.id })
		.from(vacancyPostings)
		.where(
			and(
				eq(vacancyPostings.source, source),
				ne(vacancyPostings.freshness, 'gone'),
				lt(vacancyPostings.lastCheckedAt, olderThan)
			)
		)
		.orderBy(vacancyPostings.lastCheckedAt)
		.limit(MAX_CHECKS);
	for (const { id } of due) {
		await enqueueJob(tx, 'vacancies.freshness_check', { posting_id: id }, { inputVersion: id, createdBy: system });
	}
	return due.length;
}

/** Recomputes clusters touched by gone or reappeared postings and enqueues derivations of revised ones. */
export async function recomputeTouched(
	tx: Transaction,
	vacancyIds: Iterable<string>,
	input: { now: Date; staleAfterDays: number | null }
): Promise<number> {
	let revised = 0;
	for (const vacancyId of vacancyIds) {
		const change = await recomputeCluster(tx, vacancyId, { ...input, taxonomyVersionId: null });
		if (change.revised) {
			revised++;
			await enqueueRevisionDerivations(tx, vacancyId, change.revision, system);
		}
	}
	return revised;
}

function failureOf(error: SourceError): JobFailure {
	const retryAfter = error.details?.retry_after_seconds;
	return new JobFailure(`source_${error.code}`, error.message, {
		retryable: error.retryable,
		...(typeof retryAfter === 'number' ? { retryAfterSeconds: retryAfter } : {})
	});
}

async function run(
	deps: ImportDeps,
	db: Database,
	payload: { source: string; mode: RunMode },
	jobId: string,
	requestId: string,
	signal: AbortSignal
): Promise<JobResult> {
	const [source] = await db.select().from(vacancySources).where(eq(vacancySources.key, payload.source));
	if (!source) throw new JobFailure('source_unknown', 'no such vacancy source', { retryable: false });
	if (!source.enabled) {
		return {
			isCurrent: () => Promise.resolve(false),
			write: () => Promise.resolve(),
			describe: () => ({ skipped: 'disabled' })
		};
	}
	const terms = sourceTermsSchema.parse(source.terms);
	const schedule = sourceScheduleSchema.parse(source.schedule);
	const adapter = deps.source(source.key, signal);
	if (!adapter) throw new JobFailure('adapter_missing', 'the source has no available adapter', { retryable: false });
	let taxonomy: VacancyTaxonomy;
	try {
		taxonomy = await loadVacancyTaxonomy(db);
	} catch (error) {
		if (error instanceof TaxonomyUnavailable)
			throw new JobFailure('taxonomy_missing', error.message, { retryable: true });
		throw error;
	}

	const started = deps.now();
	const since = payload.mode === 'incremental' ? await lastSuccessStart(db, source.key) : null;
	const runRef = await db.transaction(async (tx) => {
		// A run of the same source and mode still `running` lost its worker: the job key allows one at a time.
		await tx
			.update(vacancyImportRuns)
			.set({
				status: 'failed',
				completeness: 'partial',
				incompleteReason: 'abandoned',
				finishedAt: started
			})
			.where(
				and(
					eq(vacancyImportRuns.source, source.key),
					eq(vacancyImportRuns.mode, payload.mode),
					eq(vacancyImportRuns.status, 'running')
				)
			);
		const [row] = await tx
			.insert(vacancyImportRuns)
			.values({
				source: source.key,
				adapterVersion: adapter.adapterVersion,
				jobId,
				mode: payload.mode,
				startedAt: started,
				status: 'running',
				counts: {}
			})
			.returning({ id: vacancyImportRuns.id });
		if (!row) throw new Error('import run was not inserted');
		return { id: row.id, source: source.key, mode: payload.mode };
	});

	const listing = await readListing(adapter, payload.mode, since, signal);
	if (!listing.ok) {
		const error = listing.error;
		await db.transaction(async (tx) => {
			const outcome: RunOutcome = {
				status: 'failed',
				completeness: 'partial',
				reason: `source_${error.code}`,
				counts: emptyCounts(),
				cursor: listing.cursor,
				now: deps.now()
			};
			if (error.code === 'forbidden') {
				// Refused by rights or terms: the journal records the switch-off of the source, not a completed import.
				await closeRun(tx, runRef, outcome);
				await disableRefusedSource(tx, {
					source: source.key,
					via: { kind: 'import', runId: runRef.id },
					requestId
				});
			} else {
				await finishRun(tx, runRef, outcome, requestId);
			}
		});
		throw failureOf(error);
	}

	const counts = emptyCounts();
	counts.fetched = listing.items.size;
	if (listing.duplicates > 0) counts.rejected.duplicate_in_listing = listing.duplicates;
	let checks = 0;
	let revised = 0;
	return {
		// The write re-checks the source itself, so that a run always leaves the journal finished.
		isCurrent: () => Promise.resolve(true),
		write: async (tx) => {
			const now = deps.now();
			const [current] = await tx
				.select({ enabled: vacancySources.enabled })
				.from(vacancySources)
				.where(eq(vacancySources.key, source.key))
				.for('share');
			if (!current?.enabled) {
				await finishRun(
					tx,
					runRef,
					{ status: 'failed', completeness: 'partial', reason: 'source_disabled', counts, cursor: null, now },
					requestId
				);
				return;
			}
			const ctx: StoreContext = {
				run: runRef,
				now,
				taxonomy,
				storeDescription: terms.store_description,
				itFilter: adapter.itScope === 'taxonomy',
				counts,
				touched: new Set()
			};
			for (const posting of listing.items.values()) await storePosting(tx, posting, ctx);
			if (listing.complete) await markAbsentGone(tx, ctx, [...listing.items.keys()]);
			const staleAfterDays = await loadStaleAfterDays(tx, now);
			revised = await recomputeTouched(tx, ctx.touched, { now, staleAfterDays });
			await sweepStaleness(tx, now, staleAfterDays);
			checks = await enqueueFreshnessChecks(
				tx,
				source.key,
				new Date(now.getTime() - schedule.check_after_hours * 3_600_000)
			);
			await finishRun(
				tx,
				runRef,
				{
					status: 'succeeded',
					completeness: listing.complete ? 'complete' : 'partial',
					reason: listing.reason,
					counts,
					cursor: null,
					now
				},
				requestId
			);
		},
		describe: () => ({
			source: source.key,
			mode: payload.mode,
			complete: listing.complete,
			fetched: counts.fetched,
			created: counts.created,
			updated: counts.updated,
			unchanged: counts.unchanged,
			gone: counts.gone,
			revised,
			checks
		})
	};
}

export function createVacanciesImportHandler(deps: () => ImportDeps): JobHandler<'vacancies.import'> {
	return defineHandler({
		type: 'vacancies.import',
		concurrency: 1,
		run: async ({ job, db, signal, requestId }) => run(deps(), db, job.payload, job.id, requestId, signal)
	});
}

/** The adapters of the product over the platform HTTP client. */
export function productionSourceDeps(): SourceFactoryDeps {
	return {
		fetch: (input, init) => fetch(input, init),
		userAgent: `FSP-Career/1.0 (+${config().appOrigin})`,
		timeoutMs: 30_000,
		now: () => new Date()
	};
}

/** Handler of `vacancies.import` for the job registry. */
export const vacanciesImport = createVacanciesImportHandler(() => {
	const sourceDeps = productionSourceDeps();
	return { source: (key, signal) => createVacancySource(key, sourceDeps, signal), now: sourceDeps.now };
});
