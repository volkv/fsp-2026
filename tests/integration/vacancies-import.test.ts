// The aggregator: `vacancies.import` against the saved answers of both sources (no network), idempotency by
// `(source, external_id)` + `raw_sha256`, `vacancy.normalize` to the taxonomy with `match.refresh` of revised clusters,
// clustering of one vacancy published by two sources, taking postings off only by a complete listing or an explicit
// answer, `vacancy.embed` with and without the model, «this is our vacancy» — and an external vacancy is never invitable.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	auditEvents,
	embeddingSpaces,
	embeddings,
	jobs,
	mlResults,
	productPolicies,
	searchSettings,
	vacancies,
	vacancyImportRuns,
	vacancyPostings,
	vacancySources
} from '$lib/server/db/schema';
import { JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES, type JobPayload, type JobType } from '$lib/server/jobs/registry';
import { fail, ok } from '$lib/server/ml/result';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { decideVacancyClaim, submitVacancyClaim } from '$lib/server/vacancies/claims';
import { createVacancyEmbedHandler, type EmbedModels } from '$lib/server/vacancies/embed-job';
import { fixturePath } from '$lib/server/vacancies/fixtures/taxonomy';
import { createFreshnessCheckHandler } from '$lib/server/vacancies/freshness-job';
import { createVacanciesImportHandler, type ImportDeps } from '$lib/server/vacancies/import-job';
import { loadInvitability } from '$lib/server/vacancies/invitable';
import { createVacancyNormalizeHandler } from '$lib/server/vacancies/normalize-job';
import { createOwnVacancy, publishOwnVacancy } from '$lib/server/vacancies/own';
import { loadPoolCounter } from '$lib/server/vacancies/pool';
import { registerVacancySources } from '$lib/server/vacancies/sources/definitions';
import { HabrCareerSource } from '$lib/server/vacancies/sources/habr';
import { TrudvsemSource } from '$lib/server/vacancies/sources/trudvsem';
import type { SourcePosting, SourceResult, VacancySource } from '$lib/server/vacancies/sources/types';
import { sourceFail, sourceOk } from '$lib/server/vacancies/sources/types';
import { scheduleVacancyImports } from '$lib/server/vacancies/schedule';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCompany, createMember, createUser } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const TRUDVSEM_PAGE = await readFile(fixturePath('trudvsem-page.json'), 'utf8');
const HABR_RSS = await readFile(fixturePath('habr-rss.xml'), 'utf8');
const HABR_RSS_MIXED = await readFile(fixturePath('habr-rss-mixed.xml'), 'utf8');
const NOW = new Date('2026-09-25T12:00:00Z');

let clock = NOW;
const now = () => clock;

// --- Database per scenario ----------------------------------------------------------------------------------------

const databases: TestDatabase[] = [];

async function freshDatabase(): Promise<TestDatabase> {
	const database = await createTestDatabase();
	databases.push(database);
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	await registerVacancySources(database.sql);
	await database.db.update(vacancySources).set({ enabled: true });
	await database.db.insert(productPolicies).values([
		{
			kind: 'sourcing_policy',
			version: 1,
			params: { stale_after_days: 14 },
			effectiveFrom: new Date('2026-01-01T00:00:00Z')
		},
		{
			kind: 'catalog_policy',
			version: 1,
			params: { small_count_threshold: 5 },
			effectiveFrom: new Date('2026-01-01T00:00:00Z')
		}
	]);
	return database;
}

afterAll(async () => {
	await Promise.all(databases.map((d) => d.drop()));
});

// --- Adapters -----------------------------------------------------------------------------------------------------

const answer = (body: string, status = 200) => Promise.resolve(new Response(body, { status }));

const realTrudvsem = () =>
	new TrudvsemSource({
		http: { fetch: () => answer(TRUDVSEM_PAGE), userAgent: 'test', timeoutMs: 5_000 },
		now,
		queries: ['программист']
	});

const realHabr = (rss: string) =>
	new HabrCareerSource({
		http: { fetch: () => answer(rss), userAgent: 'test', timeoutMs: 5_000 },
		now
	});

/** A source whose listing and answers the test sets. */
class FakeSource implements VacancySource {
	readonly adapterVersion = 'fake/1';
	items: SourcePosting[] = [];
	listError: Parameters<typeof sourceFail>[0] | null = null;
	gone = new Set<string>();
	readonly source: string;
	readonly listing: 'snapshot' | 'recent_window';
	readonly itScope = 'source' as const;
	constructor(source: string, listing: 'snapshot' | 'recent_window' = 'snapshot') {
		this.source = source;
		this.listing = listing;
	}
	list(): Promise<
		SourceResult<{ items: SourcePosting[]; nextCursor: null; sourceVersion: null; declaredTotal: null }>
	> {
		if (this.listError) return Promise.resolve(sourceFail(this.listError, 'fake failure'));
		return Promise.resolve(sourceOk({ items: this.items, nextCursor: null, sourceVersion: null, declaredTotal: null }));
	}
	get(externalId: string): Promise<SourceResult<SourcePosting | { gone: true }>> {
		if (this.gone.has(externalId)) return Promise.resolve(sourceOk({ gone: true as const }));
		const item = this.items.find((p) => p.externalId === externalId);
		return Promise.resolve(item ? sourceOk(item) : sourceFail('protocol_error', 'unknown'));
	}
}

function posting(overrides: Partial<SourcePosting> & { externalId: string }): SourcePosting {
	return {
		url: `https://source.test/${overrides.externalId}`,
		title: 'Go-разработчик',
		organization: { name: 'ООО «Ромашка»', inn: null, sourceOrgId: null },
		publishedAt: '2026-09-20T00:00:00.000Z',
		updatedAt: '2026-09-20T00:00:00.000Z',
		salary: { min: null, max: null, currency: null, period: null, taxBase: null, rawText: null },
		grade: null,
		location: { city: 'Москва', remote: null, raw: null },
		employment: null,
		skillsRaw: ['Go', 'PostgreSQL'],
		description: null,
		contactsRemoved: false,
		rawSha256: 'a'.repeat(64),
		...overrides
	};
}

// --- Jobs as the worker runs them ---------------------------------------------------------------------------------

type Outcome = 'succeeded' | 'discarded_stale' | 'failed' | 'queued' | 'lease_lost';

async function runNext<T extends JobType>(database: TestDatabase, type: T, handler: JobHandler<T>): Promise<Outcome> {
	const { db } = database;
	const claimed = await claimJob(db, 'test-worker', [type]);
	if (claimed?.type !== type) throw new Error(`no ${type} job to run`);
	const job: ClaimedJob<T> = {
		...claimed,
		type,
		payload: JOB_TYPES[type].payload.parse(claimed.payload) as JobPayload<T>
	};
	let result: JobResult;
	try {
		result = await handler.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: createLogger({}, () => undefined)
		});
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		return failJob(db, job, { code: error.code, retryable: error.retryable, message: error.message });
	}
	return completeJob(db, job, result);
}

async function runAll<T extends JobType>(database: TestDatabase, type: T, handler: JobHandler<T>): Promise<Outcome[]> {
	const outcomes: Outcome[] = [];
	for (;;) {
		const [waiting] = await database.db
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.type, type), eq(jobs.status, 'queued')))
			.limit(1);
		if (!waiting) return outcomes;
		outcomes.push(await runNext(database, type, handler));
	}
}

async function enqueueImport(database: TestDatabase, source: string, mode: 'full' | 'incremental') {
	await database.db.transaction(async (tx) => {
		const { enqueueJob } = await import('$lib/server/jobs/queue');
		await enqueueJob(tx, 'vacancies.import', { source, mode }, { inputVersion: mode, createdBy: { kind: 'system' } });
	});
}

function importer(adapters: Record<string, VacancySource>) {
	const deps: ImportDeps = { source: (key) => adapters[key] ?? null, now };
	return createVacanciesImportHandler(() => deps);
}

const normalizer = createVacancyNormalizeHandler(now);

async function runImport(
	database: TestDatabase,
	adapters: Record<string, VacancySource>,
	source: string,
	mode: 'full' | 'incremental' = 'full'
) {
	await enqueueImport(database, source, mode);
	return runNext(database, 'vacancies.import', importer(adapters));
}

async function lastRun(database: TestDatabase, source: string) {
	const runs = await database.db
		.select()
		.from(vacancyImportRuns)
		.where(eq(vacancyImportRuns.source, source))
		.orderBy(vacancyImportRuns.startedAt);
	return runs.at(-1);
}

async function queuedFor(database: TestDatabase, type: JobType) {
	return database.db
		.select({ payload: jobs.payload, inputVersion: jobs.inputVersion })
		.from(jobs)
		.where(and(eq(jobs.type, type), eq(jobs.status, 'queued')));
}

// --- Scenarios ----------------------------------------------------------------------------------------------------

describe('import of «Работа России»', () => {
	let database: TestDatabase;
	beforeAll(async () => {
		clock = NOW;
		database = await freshDatabase();
	});

	it('stores fresh IT postings once, each in its own external vacancy, and journals a complete run', async () => {
		expect(await runImport(database, { trudvsem: realTrudvsem() }, 'trudvsem')).toBe('succeeded');
		const postings = await database.db.select().from(vacancyPostings);
		expect(postings).toHaveLength(4);
		expect(new Set(postings.map((p) => p.vacancyId)).size).toBe(4);
		expect(await lastRun(database, 'trudvsem')).toMatchObject({
			status: 'succeeded',
			completeness: 'complete',
			counts: { fetched: 4, created: 4, updated: 0, unchanged: 0, gone: 0 }
		});
		expect(await queuedFor(database, 'vacancy.normalize')).toHaveLength(4);
		for (const p of postings) {
			expect(JSON.stringify([p.organization, p.originalTerms])).not.toMatch(/example\.org|000\) 000|Контактное лицо/);
		}
	});

	it('imports the same listing again without duplicates: the same record only confirms freshness', async () => {
		clock = new Date(NOW.getTime() + 3_600_000);
		expect(await runImport(database, { trudvsem: realTrudvsem() }, 'trudvsem')).toBe('succeeded');
		expect(await database.db.select({ id: vacancyPostings.id }).from(vacancyPostings)).toHaveLength(4);
		expect(await database.db.select({ id: vacancies.id }).from(vacancies)).toHaveLength(4);
		expect(await lastRun(database, 'trudvsem')).toMatchObject({
			counts: { fetched: 4, created: 0, updated: 0, unchanged: 4, gone: 0 }
		});
		const postings = await database.db.select({ lastCheckedAt: vacancyPostings.lastCheckedAt }).from(vacancyPostings);
		expect(postings.every((p) => p.lastCheckedAt.getTime() === clock.getTime())).toBe(true);
		// The waiting normalization of each posting was joined, not duplicated.
		expect(await queuedFor(database, 'vacancy.normalize')).toHaveLength(4);
	});

	it('normalizes postings to the taxonomy and enqueues matches of the revised vacancies', async () => {
		expect(await runAll(database, 'vacancy.normalize', normalizer)).toEqual([
			'succeeded',
			'succeeded',
			'succeeded',
			'succeeded'
		]);
		const [qa] = await database.db
			.select()
			.from(vacancies)
			.where(eq(vacancies.title, 'Тестировщик (Верификатор) / QA Engineer'));
		expect(qa).toMatchObject({
			origin: 'external',
			status: 'active',
			revision: 2,
			roleKey: 'qa_manual',
			gradeMin: 'middle',
			gradeMax: 'middle',
			gradeBasis: 'stated',
			salaryMin: 149_426,
			salaryMax: null,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'unknown',
			companyId: null
		});
		const refreshes = await queuedFor(database, 'match.refresh');
		expect(refreshes).toContainEqual({ payload: { scope: 'vacancy', vacancy_id: qa?.id }, inputVersion: '2' });
		expect(await queuedFor(database, 'vacancy.embed')).toContainEqual({
			payload: { vacancy_id: qa?.id },
			inputVersion: '2'
		});
		if (!qa) throw new Error('vacancy missing');
		// A vacancy without a range is shown as «не указано», never as zero.
		const [noSalary] = await database.db.select().from(vacancies).where(eq(vacancies.title, 'Аналитик данных'));
		expect(noSalary).toMatchObject({ roleKey: 'data_analyst', salaryMin: null, salaryMax: null, salaryTaxBase: null });
		// Its tags resolve to no required skill: nobody can have one confirmed, so the pool is not counted.
		expect(qa.requiredSkillKeys).toEqual([]);
		expect(await loadPoolCounter(database.db, qa.id, clock)).toEqual({ status: 'insufficient_data' });
	});

	it('an external vacancy is never invitable', async () => {
		const [external] = await database.db.select({ id: vacancies.id }).from(vacancies).limit(1);
		if (!external) throw new Error('no vacancy');
		expect(await loadInvitability(database.db, external.id)).toEqual({ invitable: false, reason: 'external_vacancy' });
	});
});

describe('Habr Career feed', () => {
	let database: TestDatabase;
	beforeAll(async () => {
		clock = NOW;
		database = await freshDatabase();
	});

	it('imports the feed as a partial listing that takes nothing off', async () => {
		expect(await runImport(database, { habr_career: realHabr(HABR_RSS) }, 'habr_career')).toBe('succeeded');
		expect(await database.db.select({ id: vacancyPostings.id }).from(vacancyPostings)).toHaveLength(39);
		expect(await lastRun(database, 'habr_career')).toMatchObject({
			completeness: 'partial',
			incompleteReason: 'recent_window_listing',
			counts: { fetched: 50, created: 39, rejected: { not_it: 11 } }
		});
		// The first item of the feed is a sales posting: it was never stored, so nothing but the rest is confirmed.
		const shorter = HABR_RSS.replace(/<item>[\s\S]*?<\/item>/u, '');
		expect(await runImport(database, { habr_career: realHabr(shorter) }, 'habr_career')).toBe('succeeded');
		expect(await lastRun(database, 'habr_career')).toMatchObject({
			counts: { fetched: 49, gone: 0, unchanged: 39, rejected: { not_it: 10 } }
		});
		const gone = await database.db.select().from(vacancyPostings).where(eq(vacancyPostings.freshness, 'gone'));
		expect(gone).toHaveLength(0);
		const descriptions = await database.db.select({ description: vacancies.description }).from(vacancies);
		expect(descriptions.every((v) => v.description === null)).toBe(true);
	});
});

describe('postings of other industries', () => {
	let database: TestDatabase;
	beforeAll(async () => {
		clock = NOW;
		database = await freshDatabase();
	});

	it('stores only the IT postings of a feed that mixes industries and counts the rest', async () => {
		expect(await runImport(database, { habr_career: realHabr(HABR_RSS_MIXED) }, 'habr_career')).toBe('succeeded');
		expect(await lastRun(database, 'habr_career')).toMatchObject({
			status: 'succeeded',
			counts: { fetched: 9, created: 4, rejected: { not_it: 5 } }
		});
		const stored = await database.db.select({ title: vacancyPostings.title }).from(vacancyPostings);
		expect(stored.map((p) => p.title).sort()).toEqual([
			'Go-разработчик',
			'Аналитик данных',
			'Младший инженер ЦОД',
			'Программист 1С'
		]);
		const [audit] = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.action, 'vacancies.import_completed'));
		expect(audit?.details).toMatchObject({ source: 'habr_career', fetched: 9, created: 4 });
	});

	it('normalizes the glued tags of the kept postings', async () => {
		await runAll(database, 'vacancy.normalize', normalizer);
		const [datacenter] = await database.db.select().from(vacancies).where(eq(vacancies.title, 'Младший инженер ЦОД'));
		// «Техническаяподдержка» is a skill of the taxonomy, a general one: it is kept, but the posting is IT by networking.
		expect(datacenter).toMatchObject({ roleKey: null, requiredSkillKeys: ['networking', 'technical_support'] });
		const [onec] = await database.db.select().from(vacancies).where(eq(vacancies.title, 'Программист 1С'));
		expect(onec).toMatchObject({ roleKey: 'onec', requiredSkillKeys: ['onec'] });
	});

	it('does not filter a source that keeps to IT by its own category', async () => {
		const other = new FakeSource('trudvsem');
		other.items = [posting({ externalId: 'org/marketing', title: 'SMM маркетолог', skillsRaw: ['SMM'] })];
		expect(await runImport(database, { trudvsem: other }, 'trudvsem')).toBe('succeeded');
		expect(await lastRun(database, 'trudvsem')).toMatchObject({ counts: { fetched: 1, created: 1, rejected: {} } });
	});
});

describe('duplicates, freshness and claims', () => {
	let database: TestDatabase;
	const trudvsem = new FakeSource('trudvsem');
	const habr = new FakeSource('habr_career', 'recent_window');
	const adapters = { trudvsem, habr_career: habr };

	beforeAll(async () => {
		clock = NOW;
		database = await freshDatabase();
	});

	it('clusters one vacancy published by two sources and keeps both postings', async () => {
		trudvsem.items = [
			posting({
				externalId: 'org/1',
				organization: { name: 'ООО «Ромашка»', inn: '7700000001', sourceOrgId: 'org' },
				salary: { min: 200_000, max: 300_000, currency: 'RUB', period: 'month', taxBase: null, rawText: null },
				rawSha256: '1'.repeat(64)
			}),
			posting({ externalId: 'org/2', title: 'Java-разработчик', rawSha256: '2'.repeat(64) })
		];
		habr.items = [
			posting({
				externalId: '101',
				organization: { name: 'Ромашка', inn: null, sourceOrgId: null },
				salary: { min: 250_000, max: null, currency: 'RUB', period: 'month', taxBase: null, rawText: null },
				updatedAt: '2026-09-22T00:00:00.000Z',
				rawSha256: '3'.repeat(64)
			})
		];
		await runImport(database, adapters, 'trudvsem');
		await runImport(database, adapters, 'habr_career');
		await runAll(database, 'vacancy.normalize', normalizer);

		const postings = await database.db.select().from(vacancyPostings);
		const go = postings.filter((p) => p.title === 'Go-разработчик');
		expect(go).toHaveLength(2);
		expect(go[0]?.vacancyId).toBe(go[1]?.vacancyId);
		expect(go.find((p) => p.source === 'habr_career')?.dedup).toMatchObject({ method: 'fingerprint' });
		expect(new Set(postings.map((p) => p.vacancyId)).size).toBe(2);

		const [cluster] = await database.db
			.select()
			.from(vacancies)
			.where(eq(vacancies.id, go[0]?.vacancyId ?? ''));
		// Fields of the posting updated last; the other range is kept on its posting and the conflict is visible.
		expect(cluster).toMatchObject({
			roleKey: 'backend',
			salaryMin: 250_000,
			salaryMax: null,
			termsConflict: true,
			externalOrg: { name: 'Ромашка', inn: '7700000001', source_org_ids: ['trudvsem:org'] }
		});
		expect(cluster?.requiredSkillKeys).toEqual(expect.arrayContaining(['go', 'postgresql']));
	});

	it('does not take off a posting absent from an incremental listing, and does from a complete one', async () => {
		trudvsem.items = trudvsem.items.filter((p) => p.externalId !== 'org/2');
		await runImport(database, adapters, 'trudvsem', 'incremental');
		expect(await lastRun(database, 'trudvsem')).toMatchObject({
			completeness: 'partial',
			incompleteReason: 'incremental'
		});
		const [kept] = await database.db.select().from(vacancyPostings).where(eq(vacancyPostings.externalId, 'org/2'));
		expect(kept?.freshness).toBe('active');

		await runImport(database, adapters, 'trudvsem', 'full');
		const [gone] = await database.db.select().from(vacancyPostings).where(eq(vacancyPostings.externalId, 'org/2'));
		expect(gone?.freshness).toBe('gone');
		expect(gone?.goneAt).toBeInstanceOf(Date);
		const [closed] = await database.db
			.select()
			.from(vacancies)
			.where(eq(vacancies.id, gone?.vacancyId ?? ''));
		expect(closed?.status).toBe('closed');
		expect(closed?.closedAt).toBeInstanceOf(Date);
	});

	it('goes stale without confirmation and is taken off by an explicit answer of the source', async () => {
		clock = new Date(NOW.getTime() + 20 * 86_400_000);
		// The feed moved on: the Habr posting is no longer listed, the trudvsem one still is.
		habr.items = [];
		trudvsem.items = [];
		await runImport(database, adapters, 'habr_career');
		const [habrPosting] = await database.db.select().from(vacancyPostings).where(eq(vacancyPostings.externalId, '101'));
		expect(habrPosting?.freshness).toBe('active');
		const [cluster] = await database.db
			.select()
			.from(vacancies)
			.where(eq(vacancies.id, habrPosting?.vacancyId ?? ''));
		expect(cluster?.status).toBe('stale');

		// Unconfirmed for longer than the schedule: the run enqueued a check; the source answers «no such record».
		const checks = await queuedFor(database, 'vacancies.freshness_check');
		expect(checks).toContainEqual(expect.objectContaining({ payload: { posting_id: habrPosting?.id } }));
		habr.gone.add('101');
		const deps: ImportDeps = { source: (key) => adapters[key as keyof typeof adapters], now };
		const checker = createFreshnessCheckHandler(() => deps);
		await runAll(database, 'vacancies.freshness_check', checker);
		const [after] = await database.db.select().from(vacancyPostings).where(eq(vacancyPostings.externalId, '101'));
		expect(after?.freshness).toBe('gone');
	});

	it('turns a refusal of the source into a disabled source and a failed run', async () => {
		trudvsem.listError = 'forbidden';
		expect(await runImport(database, adapters, 'trudvsem')).toBe('failed');
		const [source] = await database.db.select().from(vacancySources).where(eq(vacancySources.key, 'trudvsem'));
		expect(source?.enabled).toBe(false);
		const run = await lastRun(database, 'trudvsem');
		expect(run).toMatchObject({
			status: 'failed',
			completeness: 'partial',
			incompleteReason: 'source_forbidden'
		});
		// The administrator learns of the switch-off, not of a completed import.
		const events = await database.db
			.select({ action: auditEvents.action, objectId: auditEvents.objectId, details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.objectId, 'trudvsem'));
		expect(events).toEqual([
			{
				action: 'vacancy_source.disabled',
				objectId: 'trudvsem',
				details: { source: 'trudvsem', reason: 'source_forbidden', via: 'import', run_id: run?.id }
			}
		]);
		const completions = await database.db
			.select({ id: auditEvents.id })
			.from(auditEvents)
			.where(eq(auditEvents.objectId, run?.id ?? ''));
		expect(completions).toEqual([]);
		trudvsem.listError = null;
		await database.db.update(vacancySources).set({ enabled: true }).where(eq(vacancySources.key, 'trudvsem'));
	});

	it('«this is our vacancy»: approval records the company but gives no right to invite', async () => {
		clock = NOW;
		trudvsem.items = [
			posting({
				externalId: 'org/9',
				title: 'Python-разработчик',
				organization: { name: 'ООО «Ромашка»', inn: '7700000001', sourceOrgId: 'org' },
				rawSha256: '9'.repeat(64)
			})
		];
		await runImport(database, adapters, 'trudvsem');
		await runAll(database, 'vacancy.normalize', normalizer);
		const [external] = await database.db.select().from(vacancies).where(eq(vacancies.title, 'Python-разработчик'));
		if (!external) throw new Error('no external vacancy');

		const company = await createCompany(database.db, { inn: '7700000001', status: 'verified' });
		const member = await createMember(database.db, company.id);
		if (!member.userId) throw new Error('member without user');
		const deps = { db: database.db, now };
		const claim = await submitVacancyClaim(
			deps,
			{
				userId: member.userId,
				companyId: company.id,
				audit: { kind: 'user', userId: member.userId, companyId: company.id },
				requestId: 'req'
			},
			external.id
		);
		expect(claim).toMatchObject({ status: 'pending_review', matchEvidence: { inn: 'match' } });

		const operator = await createUser(database.db);
		const decided = await decideVacancyClaim(deps, claim.id, {
			operatorUserId: operator.id,
			decision: 'approved',
			reason: null,
			requestId: 'req-op'
		});
		expect(decided.status).toBe('approved');
		const [claimed] = await database.db.select().from(vacancies).where(eq(vacancies.id, external.id));
		expect(claimed?.claimedCompanyId).toBe(company.id);
		expect(await loadInvitability(database.db, external.id)).toEqual({ invitable: false, reason: 'external_vacancy' });

		// The company invites through its own vacancy made from the external one; publishing it replaces the external one.
		const author = {
			memberId: member.id,
			companyId: company.id,
			audit: { kind: 'user' as const, userId: member.userId },
			requestId: 'req'
		};
		const own = await createOwnVacancy(
			deps,
			author,
			{
				title: 'Python-разработчик',
				description: 'Сервисы на Python и PostgreSQL для финансовой команды.',
				roleKey: 'backend',
				gradeMin: 'middle',
				gradeMax: 'senior',
				requiredSkillKeys: ['python'],
				niceSkillKeys: [],
				workFormat: 'remote',
				employmentForm: 'full',
				contractTypes: ['labor'],
				cityId: null,
				timezoneOverlapHours: null,
				salary: { min: 200_000, max: 300_000, currency: 'RUB', period: 'month', taxBase: 'gross' }
			},
			{ derivedFromVacancyId: external.id }
		);
		await publishOwnVacancy(deps, author, own.id);
		expect(await loadInvitability(database.db, own.id)).toEqual({ invitable: true });
		const [replaced] = await database.db.select().from(vacancies).where(eq(vacancies.id, external.id));
		expect(replaced?.supersededByVacancyId).toBe(own.id);
		expect(await loadInvitability(database.db, external.id)).toEqual({ invitable: false, reason: 'external_vacancy' });
	});

	it('refuses to approve against a mismatched INN without a reason', async () => {
		const [external] = await database.db.select().from(vacancies).where(eq(vacancies.title, 'Go-разработчик'));
		if (!external) throw new Error('no external vacancy');
		const company = await createCompany(database.db, { inn: '7800000002', status: 'verified' });
		const member = await createMember(database.db, company.id);
		if (!member.userId) throw new Error('member without user');
		const deps = { db: database.db, now };
		const claim = await submitVacancyClaim(
			deps,
			{
				userId: member.userId,
				companyId: company.id,
				audit: { kind: 'user', userId: member.userId },
				requestId: 'req'
			},
			external.id
		);
		expect(claim.matchEvidence).toMatchObject({ inn: 'mismatch', posting_inns: ['7700000001'] });
		const operator = await createUser(database.db);
		await expect(
			decideVacancyClaim(deps, claim.id, {
				operatorUserId: operator.id,
				decision: 'approved',
				reason: null,
				requestId: 'r'
			})
		).rejects.toMatchObject({ reason: 'claim_inn_mismatch_reason_required' });
	});
});

describe('vector of a vacancy', () => {
	let database: TestDatabase;
	const SPACE = 'test-embedder@r1/3';

	beforeAll(async () => {
		clock = NOW;
		database = await freshDatabase();
		await database.db.insert(embeddingSpaces).values({
			id: SPACE,
			modelName: 'test-embedder',
			modelRevision: 'r1',
			dimension: 3,
			queryPrefix: '',
			documentPrefix: '',
			pooling: 'mean',
			normalization: 'l2',
			maxInputTokens: 512,
			chunkingVersion: 'v1',
			status: 'active',
			activatedAt: NOW
		});
		await database.db.update(searchSettings).set({ activeEmbeddingSpaceId: SPACE });
		const source = new FakeSource('trudvsem');
		source.items = [posting({ externalId: 'org/1' })];
		await runImport(database, { trudvsem: source }, 'trudvsem');
		await runAll(database, 'vacancy.normalize', normalizer);
		await database.db.delete(jobs).where(eq(jobs.type, 'match.refresh'));
	});

	it('stores the vector of the current revision and enqueues the matches', async () => {
		const models: EmbedModels = {
			embed: (request) =>
				Promise.resolve(
					ok({
						spaceId: request.spaceId,
						vectors: request.inputs.map((i) => ({ id: i.id, vector: [0.6, 0.8, 0] })),
						latencyMs: 3
					})
				)
		};
		expect(
			await runAll(
				database,
				'vacancy.embed',
				createVacancyEmbedHandler(() => models)
			)
		).toEqual(['succeeded']);
		const [vacancy] = await database.db.select().from(vacancies);
		const [vector] = await database.db.select().from(embeddings);
		expect(vector).toMatchObject({
			ownerType: 'vacancy',
			ownerId: vacancy?.id,
			inputVersion: String(vacancy?.revision),
			spaceId: SPACE
		});
		expect(await queuedFor(database, 'match.refresh')).toEqual([
			{ payload: { scope: 'vacancy', vacancy_id: vacancy?.id }, inputVersion: String(vacancy?.revision) }
		]);
	});

	it('records a switched-off model as such and stores no vector', async () => {
		await database.db.delete(embeddings);
		const [vacancy] = await database.db.select().from(vacancies);
		if (!vacancy) throw new Error('no vacancy');
		await database.db.transaction(async (tx) => {
			const { enqueueJob } = await import('$lib/server/jobs/queue');
			await enqueueJob(
				tx,
				'vacancy.embed',
				{ vacancy_id: vacancy.id },
				{ inputVersion: String(vacancy.revision), createdBy: { kind: 'system' } }
			);
		});
		const off: EmbedModels = {
			embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' }))
		};
		expect(
			await runAll(
				database,
				'vacancy.embed',
				createVacancyEmbedHandler(() => off)
			)
		).toEqual(['succeeded']);
		expect(await database.db.select().from(embeddings)).toHaveLength(0);
		const envelopes = await database.db.select().from(mlResults).where(eq(mlResults.processingMode, 'failed'));
		expect(envelopes).toEqual([
			expect.objectContaining({ operation: 'embed', failure: { code: 'disabled', reason: 'switched_off' } })
		]);
	});
});

describe('schedule of imports', () => {
	it('enqueues the imports that are due, once', async () => {
		const database = await freshDatabase();
		const first = await scheduleVacancyImports(database.db, NOW);
		expect(first).toEqual(
			expect.arrayContaining([
				{ source: 'habr_career', mode: 'full' },
				{ source: 'trudvsem', mode: 'full' },
				{ source: 'trudvsem', mode: 'incremental' }
			])
		);
		expect(first).toHaveLength(3);
		expect(await scheduleVacancyImports(database.db, NOW)).toEqual([]);
	});
});
