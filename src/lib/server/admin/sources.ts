// Vacancy sources for the administrator (docs/domain.md, section 13.2): each source with its terms of use, schedule,
// the latest import run and import job, and the switch. Only a source of the catalog (`sources/definitions.ts`) can be
// switched: the synthetic sources of the demo seed have no adapter and are imported by the seed alone. A source whose
// terms forbid use cannot be enabled. Enabling puts an out-of-turn full import in the queue in the same transaction as
// the switch and its journal entry; the schedule then goes on from that run.
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireStandChange } from '$lib/server/access/demo-actor';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { ActionContext } from '$lib/server/companies/context';
import { conflict, invalid, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { Database, Executor } from '$lib/server/db';
import { jobs, vacancyImportRuns, vacancyPostings, vacancySources } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { enqueueJob } from '$lib/server/jobs/queue';
import {
	SOURCE_DEFINITIONS,
	sourceScheduleSchema,
	sourceTermsSchema,
	type SourceSchedule,
	type SourceTerms
} from '$lib/server/vacancies/sources/definitions';

export interface SourcesDeps {
	db: Database;
	now: () => Date;
}

/** What the administrator can do with the switch of a source. */
export type SourceControl = 'switchable' | 'terms_forbidden' | 'no_adapter';

/** Counters of a finished import run (`vacancies/import-job.ts`, `ImportCounts`). */
const runCountsSchema = z.object({
	fetched: z.int().nonnegative(),
	created: z.int().nonnegative(),
	updated: z.int().nonnegative(),
	unchanged: z.int().nonnegative(),
	gone: z.int().nonnegative(),
	reappeared: z.int().nonnegative(),
	rejected: z.record(z.string(), z.int().nonnegative())
});

export type RunCounts = z.infer<typeof runCountsSchema>;

export interface SourceRun {
	mode: 'full' | 'incremental' | 'check';
	status: 'running' | 'succeeded' | 'failed';
	completeness: 'complete' | 'partial' | null;
	/** Why the run is partial: `source_unavailable`, `source_disabled`, `abandoned`, … */
	incompleteReason: string | null;
	startedAt: Date;
	finishedAt: Date | null;
	/** `null` while the run is going: the counters are written when it closes. */
	counts: RunCounts | null;
}

/** The latest `vacancies.import` job of the source: the queue sees a failure before the run starts, the run does not. */
export interface SourceJob {
	status: 'queued' | 'running' | 'succeeded' | 'discarded_stale' | 'failed' | 'cancelled';
	mode: 'full' | 'incremental';
	attempts: number;
	maxAttempts: number;
	/** The error of the latest failed attempt: a code and a message without personal data. */
	error: { code: string; message: string } | null;
	createdAt: Date;
	finishedAt: Date | null;
}

export interface SourceState {
	key: string;
	name: string;
	siteUrl: string;
	adapterVersion: string;
	enabled: boolean;
	control: SourceControl;
	terms: SourceTerms;
	schedule: SourceSchedule;
	lastRun: SourceRun | null;
	lastJob: SourceJob | null;
	/** Postings of the source that are live in it now. */
	activePostings: number;
}

const importJobPayload = z.object({ source: z.string(), mode: z.enum(['full', 'incremental']) });
const jobError = z.object({ code: z.string(), message: z.string() });

const catalogKeys = new Set(SOURCE_DEFINITIONS.map((definition) => definition.key));

function controlOf(key: string, terms: SourceTerms): SourceControl {
	if (!catalogKeys.has(key)) return 'no_adapter';
	return terms.status === 'forbidden' ? 'terms_forbidden' : 'switchable';
}

async function lastRunOf(executor: Executor, key: string): Promise<SourceRun | null> {
	const [run] = await executor
		.select()
		.from(vacancyImportRuns)
		.where(eq(vacancyImportRuns.source, key))
		.orderBy(desc(vacancyImportRuns.startedAt))
		.limit(1);
	if (!run) return null;
	return {
		mode: run.mode,
		status: run.status,
		completeness: run.completeness,
		incompleteReason: run.incompleteReason,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		counts: run.status === 'running' ? null : runCountsSchema.parse(run.counts)
	};
}

async function lastJobOf(executor: Executor, key: string): Promise<SourceJob | null> {
	const [job] = await executor
		.select()
		.from(jobs)
		.where(and(eq(jobs.type, 'vacancies.import'), sql`${jobs.payload}->>'source' = ${key}`))
		.orderBy(desc(jobs.createdAt))
		.limit(1);
	if (!job) return null;
	return {
		status: job.status,
		mode: importJobPayload.parse(job.payload).mode,
		attempts: job.attempts,
		maxAttempts: job.maxAttempts,
		error: job.lastError === null ? null : jobError.parse(job.lastError),
		createdAt: job.createdAt,
		finishedAt: job.finishedAt
	};
}

export async function vacancySourcesState(deps: Pick<SourcesDeps, 'db'>, ctx: ActionContext): Promise<SourceState[]> {
	requirePermission(ctx.subject, 'jobs.manage', null);
	const [sources, active] = await Promise.all([
		deps.db.select().from(vacancySources).orderBy(vacancySources.name),
		deps.db
			.select({ source: vacancyPostings.source, n: count() })
			.from(vacancyPostings)
			.where(eq(vacancyPostings.freshness, 'active'))
			.groupBy(vacancyPostings.source)
	]);
	const activeBySource = new Map(active.map((row) => [row.source, row.n]));
	return Promise.all(
		sources.map(async (source): Promise<SourceState> => {
			const terms = sourceTermsSchema.parse(source.terms);
			const [lastRun, lastJob] = await Promise.all([lastRunOf(deps.db, source.key), lastJobOf(deps.db, source.key)]);
			return {
				key: source.key,
				name: source.name,
				siteUrl: source.siteUrl,
				adapterVersion: source.adapterVersion,
				enabled: source.enabled,
				control: controlOf(source.key, terms),
				terms,
				schedule: sourceScheduleSchema.parse(source.schedule),
				lastRun,
				lastJob,
				activePostings: activeBySource.get(source.key) ?? 0
			};
		})
	);
}

export interface SourceSwitch {
	source: string;
	enabled: boolean;
}

/** The switch form: the source key and the state it is set to. */
export function parseSourceSwitch(form: FormData): SourceSwitch {
	const source = form.get('source');
	const posted = form.get('enabled');
	if (typeof source !== 'string' || !/^[a-z][a-z0-9_]*$/.test(source) || (posted !== 'true' && posted !== 'false')) {
		throw invalid([{ path: 'enabled', code: 'invalid', message: 'Выберите источник и состояние' }]);
	}
	return { source, enabled: posted === 'true' };
}

export interface SourceSwitchResult {
	name: string;
	changed: boolean;
	/** The out-of-turn full import put in the queue by enabling; `null` — nothing was enqueued. */
	importJobId: string | null;
}

/**
 * Switches a source on or off. Running imports is operating the product, so the administrator's `jobs.manage` decides;
 * the sources are shared by every visitor of the stand, so a demo actor only looks at them. The switch, its journal
 * entry and the import job enqueued on enabling are one transaction; the row is locked, so two administrators switching
 * at once leave one entry each for a real change and none for a repeated one.
 */
export async function switchVacancySource(
	deps: SourcesDeps,
	ctx: ActionContext,
	change: SourceSwitch
): Promise<SourceSwitchResult> {
	requirePermission(ctx.subject, 'jobs.manage', null);
	const userId = sessionUserId(ctx.subject);
	await requireStandChange(deps.db, ctx.subject);
	return deps.db.transaction(async (tx) => {
		const [source] = await tx.select().from(vacancySources).where(eq(vacancySources.key, change.source)).for('update');
		if (!source) throw new ApiError('not_found', { message: 'Такого источника вакансий нет' });
		const terms = sourceTermsSchema.parse(source.terms);
		const control = controlOf(source.key, terms);
		if (control === 'no_adapter') {
			throw conflict(
				'source_without_adapter',
				`У источника «${source.name}» нет адаптера: его ленту загружает только посев демо-данных, включить его нельзя.`
			);
		}
		if (change.enabled && control === 'terms_forbidden') {
			throw conflict(
				'source_terms_forbidden',
				`Условия использования «${source.name}» запрещают импорт (проверено ${terms.checked_at}): включить источник нельзя, пока условия не изменятся.`
			);
		}
		if (source.enabled === change.enabled) return { name: source.name, changed: false, importJobId: null };

		await tx.update(vacancySources).set({ enabled: change.enabled }).where(eq(vacancySources.key, source.key));
		const audit = {
			outcome: 'success',
			actor: { kind: 'user', userId },
			object: { type: 'vacancy_source', id: source.key },
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent
		} as const;
		if (!change.enabled) {
			await recordAuditEvent(tx, {
				...audit,
				action: 'vacancy_source.disabled',
				details: { source: source.key, reason: 'administrator' }
			});
			return { name: source.name, changed: true, importJobId: null };
		}
		const { jobId } = await enqueueJob(
			tx,
			'vacancies.import',
			{ source: source.key, mode: 'full' },
			{ inputVersion: `enabled:${deps.now().toISOString()}`, createdBy: { kind: 'user', id: userId } }
		);
		await recordAuditEvent(tx, {
			...audit,
			action: 'vacancy_source.enabled',
			details: { source: source.key, import_job_id: jobId }
		});
		return { name: source.name, changed: true, importJobId: jobId };
	});
}
