// Job `embedding.reindex` (docs/domain.md, section 16.2): every vector of a space — candidate sections and vacancies —
// computed page by page, then the switch. A space being built becomes active in one transaction with
// `search_settings.active_embedding_space_id`; the space it replaces is retired and its vectors deleted; the matches of
// every vacancy are recomputed with the semantic component. Until then search stays where it was: in the previous space
// or, without one, in the explicit FTS-only mode. For the active space the job only fills gaps (vectors missing after a
// reset of the demo stand or a restore) and switches nothing.
//
// Pages are committed as they go, each write checked against the revision it was computed from, so a stopped job
// continues where it stopped: what is already current is skipped without calling the model. A runtime that is down is
// a retryable failure; a model that refuses the space or is switched off fails the job, and the application start
// enqueues it again (main.ts). Candidates without `pd_processing` in effect get no vectors (profile.ts); one whose
// consent lapsed while the model computed the page is skipped as stale.
import { and, asc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import { config } from '$lib/server/config';
import { processingAllowedFor } from '$lib/server/consent/processing';
import type { Database, Transaction } from '$lib/server/db';
import { candidates, embeddingSpaces, embeddings, searchSettings, vacancies } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import type { JobLogger } from '$lib/server/jobs/log';
import { enqueueJob } from '$lib/server/jobs/queue';
import { modelAdapter } from '$lib/server/ml';
import { enqueueMatchRefresh } from '$lib/server/vacancies/derivations';
import { EMBEDDED_CANDIDATE_STATUSES, loadCandidateProfiles, loadTaxonomyLabels, type TaxonomyLabels } from './profile';
import {
	embedDocuments,
	lockedRevisions,
	planCandidates,
	planVacancies,
	removeUnembeddedCandidates,
	UNEMBEDDED_VACANCY_STATUSES,
	writeCandidatePlan,
	writeVacancyPlans,
	type EmbedModels
} from './vectors';

export interface ReindexDeps {
	models: () => EmbedModels;
	/** Owners read, planned and written per transaction. */
	pageSize: () => number;
	now: () => Date;
}

interface Space {
	id: string;
	status: 'building' | 'active' | 'retired';
}

interface Counters {
	candidates: number;
	candidatesEmbedded: number;
	vacancies: number;
	vacanciesEmbedded: number;
	skippedStale: number;
}

/** A failure of the model: retryable ones go back to the queue, the others end the job. */
function modelFailure(error: { code: string; message: string; retryable: boolean }): JobFailure {
	return new JobFailure(`embed_${error.code}`, error.message, { retryable: error.retryable });
}

async function readSpace(executor: Database | Transaction, spaceId: string): Promise<Space | null> {
	const [row] = await executor
		.select({ id: embeddingSpaces.id, status: embeddingSpaces.status })
		.from(embeddingSpaces)
		.where(eq(embeddingSpaces.id, spaceId));
	return row ?? null;
}

async function candidatePage(
	deps: ReindexDeps,
	db: Database,
	space: Space,
	ids: readonly string[],
	labels: TaxonomyLabels,
	counters: Counters,
	signal: AbortSignal
): Promise<void> {
	const profiles = await loadCandidateProfiles(db, ids, labels, deps.now());
	const plans = await planCandidates(db, space.id, [...profiles.values()]);
	if (plans.length === 0) return;
	const embedded = await embedDocuments(
		deps.models(),
		space.id,
		plans.flatMap((plan) => plan.embed),
		signal
	);
	if (!embedded.ok) throw modelFailure(embedded.error);
	await db.transaction(async (tx) => {
		const ids = plans.map((plan) => plan.candidateId);
		const revisions = await lockedRevisions(tx, ids);
		const processable = await processingAllowedFor(tx, ids, deps.now());
		for (const plan of plans) {
			// A profile that changed meanwhile has its own `profile.embed` waiting, which writes to this space too.
			const lapsed = plan.embed.length > 0 && !processable.has(plan.candidateId);
			if (revisions.get(plan.candidateId) !== plan.revision || lapsed) {
				counters.skippedStale++;
				continue;
			}
			await writeCandidatePlan(tx, space.id, plan, embedded.vectors);
			counters.candidatesEmbedded += plan.embed.length > 0 ? 1 : 0;
			if (space.status === 'active') {
				await enqueueJob(
					tx,
					'match.refresh',
					{ scope: 'candidate', candidate_id: plan.candidateId },
					{ inputVersion: String(plan.revision), createdBy: { kind: 'system' } }
				);
			}
		}
	});
}

async function vacancyPage(
	deps: ReindexDeps,
	db: Database,
	space: Space,
	ids: readonly string[],
	counters: Counters,
	signal: AbortSignal
): Promise<void> {
	const plans = await planVacancies(db, space.id, ids);
	if (plans.length === 0) return;
	const embedded = await embedDocuments(
		deps.models(),
		space.id,
		plans.filter((plan) => !plan.keep).map((plan) => plan.input),
		signal
	);
	if (!embedded.ok) throw modelFailure(embedded.error);
	await db.transaction(async (tx) => {
		const written = await writeVacancyPlans(tx, space.id, plans, embedded.vectors);
		counters.skippedStale += plans.length - written.length;
		counters.vacanciesEmbedded += written.filter((plan) => !plan.keep).length;
		if (space.status === 'active') {
			for (const plan of written) await enqueueMatchRefresh(tx, plan.vacancyId, plan.revision, { kind: 'system' });
		}
	});
}

/** Pages of ids in id order, each read after the previous one is written. */
async function* pages(read: (after: string | null) => Promise<string[]>): AsyncGenerator<string[]> {
	let after: string | null = null;
	for (;;) {
		const ids = await read(after);
		if (ids.length === 0) return;
		yield ids;
		after = ids[ids.length - 1] ?? null;
	}
}

/** Vacancies to have vectors whose vector in the space is missing or not of their current revision. */
async function vacanciesBehind(executor: Database | Transaction, spaceId: string): Promise<string[]> {
	const rows = await executor
		.select({ id: vacancies.id })
		.from(vacancies)
		.leftJoin(
			embeddings,
			and(
				eq(embeddings.spaceId, spaceId),
				eq(embeddings.ownerType, 'vacancy'),
				eq(embeddings.ownerId, sql`${vacancies.id}::text`),
				eq(embeddings.inputVersion, sql`${vacancies.revision}::text`)
			)
		)
		.where(and(notInArray(vacancies.status, [...UNEMBEDDED_VACANCY_STATUSES]), sql`${embeddings.id} is null`));
	return rows.map((row) => row.id);
}

/** Vacancies changed while the pages ran are caught up; bounded, the rest is left to `vacancy.embed`. */
const CATCH_UP_ROUNDS = 3;

async function run(
	deps: ReindexDeps,
	db: Database,
	spaceId: string,
	signal: AbortSignal,
	log: JobLogger
): Promise<JobResult> {
	const space = await readSpace(db, spaceId);
	if (space === null || space.status === 'retired') {
		return { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };
	}
	const started = Date.now();
	const counters: Counters = {
		candidates: 0,
		candidatesEmbedded: 0,
		vacancies: 0,
		vacanciesEmbedded: 0,
		skippedStale: 0
	};
	const size = deps.pageSize();
	const labels = await loadTaxonomyLabels(db);
	const progress = (stage: string, total: number, done: number) => {
		log.info('embedding reindex progress', {
			space: space.id,
			stage,
			done,
			total,
			...counters,
			elapsed_ms: Date.now() - started
		});
	};

	const [candidateTotal] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(candidates)
		.where(inArray(candidates.status, [...EMBEDDED_CANDIDATE_STATUSES]));
	for await (const ids of pages((after) =>
		db
			.select({ id: candidates.id })
			.from(candidates)
			.where(
				and(
					inArray(candidates.status, [...EMBEDDED_CANDIDATE_STATUSES]),
					after === null ? undefined : gt(candidates.id, after)
				)
			)
			.orderBy(asc(candidates.id))
			.limit(size)
			.then((rows) => rows.map((row) => row.id))
	)) {
		signal.throwIfAborted();
		await candidatePage(deps, db, space, ids, labels, counters, signal);
		counters.candidates += ids.length;
		progress('candidates', candidateTotal?.n ?? 0, counters.candidates);
	}

	const [vacancyTotal] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(vacancies)
		.where(notInArray(vacancies.status, [...UNEMBEDDED_VACANCY_STATUSES]));
	for await (const ids of pages((after) =>
		db
			.select({ id: vacancies.id })
			.from(vacancies)
			.where(
				and(
					notInArray(vacancies.status, [...UNEMBEDDED_VACANCY_STATUSES]),
					after === null ? undefined : gt(vacancies.id, after)
				)
			)
			.orderBy(asc(vacancies.id))
			.limit(size)
			.then((rows) => rows.map((row) => row.id))
	)) {
		signal.throwIfAborted();
		await vacancyPage(deps, db, space, ids, counters, signal);
		counters.vacancies += ids.length;
		progress('vacancies', vacancyTotal?.n ?? 0, counters.vacancies);
	}
	for (let round = 0; round < CATCH_UP_ROUNDS; round++) {
		const behind = await vacanciesBehind(db, space.id);
		if (behind.length === 0) break;
		for (let from = 0; from < behind.length; from += size) {
			signal.throwIfAborted();
			await vacancyPage(deps, db, space, behind.slice(from, from + size), counters, signal);
		}
	}

	return {
		isCurrent: async (tx) => (await readSpace(tx, space.id))?.status === space.status,
		write: async (tx) => {
			await removeUnembeddedCandidates(tx, space.id);
			if (space.status === 'building') await activate(tx, space.id, log);
		},
		describe: () => ({ space: space.id, activated: space.status === 'building', ...counters })
	};
}

/**
 * The switch (domain 16.2): the space becomes active and the setting points to it in one transaction; the previous
 * active space is retired and its vectors deleted; every vacancy with a vector gets its matches recomputed.
 */
async function activate(tx: Transaction, spaceId: string, log: JobLogger): Promise<void> {
	const [settings] = await tx
		.select({ active: searchSettings.activeEmbeddingSpaceId })
		.from(searchSettings)
		.for('update');
	if (!settings) throw new Error('search_settings has no row');
	const previous = settings.active;
	if (previous !== null && previous !== spaceId) {
		await tx.update(embeddingSpaces).set({ status: 'retired' }).where(eq(embeddingSpaces.id, previous));
		await tx.delete(embeddings).where(eq(embeddings.spaceId, previous));
	}
	await tx
		.update(embeddingSpaces)
		.set({ status: 'active', activatedAt: sql`now()` })
		.where(eq(embeddingSpaces.id, spaceId));
	await tx.update(searchSettings).set({ activeEmbeddingSpaceId: spaceId });
	const embedded = await tx
		.select({ id: vacancies.id, revision: vacancies.revision })
		.from(vacancies)
		.innerJoin(
			embeddings,
			and(
				eq(embeddings.spaceId, spaceId),
				eq(embeddings.ownerType, 'vacancy'),
				eq(embeddings.ownerId, sql`${vacancies.id}::text`)
			)
		);
	for (const vacancy of embedded) {
		await enqueueMatchRefresh(tx, vacancy.id, vacancy.revision, { kind: 'system' });
	}
	log.info('embedding space activated', { space: spaceId, previous, match_refreshes: embedded.length });
}

export function createEmbeddingReindexHandler(deps: ReindexDeps): JobHandler<'embedding.reindex'> {
	return defineHandler({
		type: 'embedding.reindex',
		concurrency: 1,
		run: ({ job, db, signal, log }) => run(deps, db, job.payload.space_id, signal, log)
	});
}

/** Handler of `embedding.reindex` for the job registry. */
export const embeddingReindex = createEmbeddingReindexHandler({
	models: modelAdapter,
	// Four batches of the adapter per page; the model is called before the page's transaction, not inside it.
	pageSize: () => {
		const embed = config().models.embed;
		if (!embed) throw new JobFailure('embed_not_configured', 'embed: not configured', { retryable: false });
		return embed.batchSize * 4;
	},
	now: () => new Date()
});
