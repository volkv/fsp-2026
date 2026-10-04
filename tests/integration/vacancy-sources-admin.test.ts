// Vacancy sources from the administrator cabinet: a source of the catalog is switched on and off under `jobs.manage`,
// enabling puts an out-of-turn full import in the queue in the same transaction as the switch and its journal entry,
// a source whose terms forbid use and a synthetic source of the demo seed are never enabled, and a demo actor only
// looks. The page state carries the latest run and the latest import job of each source.
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_LOCK_MESSAGE } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	parseSourceSwitch,
	switchVacancySource,
	vacancySourcesState,
	type SourcesDeps
} from '$lib/server/admin/sources';
import { auditEvents, jobs, vacancyImportRuns, vacancySources } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { scheduleVacancyImports } from '$lib/server/vacancies/schedule';
import {
	HABR_SOURCE_KEY,
	registerVacancySources,
	TRUDVSEM_SOURCE_KEY
} from '$lib/server/vacancies/sources/definitions';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createUser } from '../helpers/factories';

const NOW = new Date('2026-09-25T12:00:00Z');
const DEMO_SOURCE = 'demo_board';

let database: TestDatabase;
let deps: SourcesDeps;
let adminId: string;
let demoAdminId: string;
let employerId: string;
let meta: { requestId: string; ip: string; userAgent: string };

const subject = (userId: string, admin: boolean): AccessSubject => ({
	userId,
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: false, admin, extraPermissions: [] }
});

const as = (userId: string, admin = true) => ({ subject: subject(userId, admin), meta });

async function sourceRow(key: string) {
	const [row] = await database.db.select().from(vacancySources).where(eq(vacancySources.key, key));
	if (!row) throw new Error(`source ${key} missing`);
	return row;
}

async function importJobs(key: string) {
	return database.db
		.select()
		.from(jobs)
		.where(and(eq(jobs.type, 'vacancies.import'), sql`${jobs.payload}->>'source' = ${key}`));
}

async function journal(action: 'vacancy_source.enabled' | 'vacancy_source.disabled') {
	return database.db
		.select()
		.from(auditEvents)
		.where(and(eq(auditEvents.action, action), eq(auditEvents.requestId, meta.requestId)));
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
	const error = await promise.then(
		() => null,
		(cause: unknown) => cause
	);
	if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`);
	return error;
}

beforeAll(async () => {
	database = await createTestDatabase();
	await registerVacancySources(database.sql);
	// A synthetic source as the demo seed registers it: no adapter in the catalog.
	await database.db.insert(vacancySources).values({
		key: DEMO_SOURCE,
		name: 'Демо-лента',
		siteUrl: 'http://localhost:57300',
		adapterVersion: 'demo-listing/1',
		terms: {
			status: 'allowed',
			checked_at: '2026-09-25',
			url: 'http://localhost:57300',
			store_description: true,
			attribution: 'Синтетическая лента'
		},
		schedule: { full_every_hours: 8760, incremental_every_hours: null, check_after_hours: 8760 },
		enabled: false
	});
	deps = { db: database.db, now: () => NOW };
	adminId = (await createUser(database.db)).id;
	demoAdminId = (await createUser(database.db, { seedBatchId: 'demo-1' })).id;
	employerId = (await createUser(database.db)).id;
});

afterAll(async () => {
	await database.drop();
});

beforeEach(async () => {
	meta = { requestId: randomUUID(), ip: '127.0.0.1', userAgent: 'vitest' };
	await database.db.update(vacancySources).set({ enabled: false });
	await database.db.delete(jobs);
});

describe('switching a vacancy source', () => {
	it('enables a source with an out-of-turn full import, journaled with the job, and the schedule joins it', async () => {
		const result = await switchVacancySource(deps, as(adminId), { source: TRUDVSEM_SOURCE_KEY, enabled: true });
		expect(result).toMatchObject({ name: 'Работа России', changed: true });
		expect((await sourceRow(TRUDVSEM_SOURCE_KEY)).enabled).toBe(true);

		const queued = await importJobs(TRUDVSEM_SOURCE_KEY);
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({
			id: result.importJobId,
			status: 'queued',
			payload: { source: TRUDVSEM_SOURCE_KEY, mode: 'full' },
			createdBy: { kind: 'user', id: adminId }
		});

		const [entry] = await journal('vacancy_source.enabled');
		expect(entry).toMatchObject({
			outcome: 'success',
			actorKind: 'user',
			actorUserId: adminId,
			objectType: 'vacancy_source',
			objectId: TRUDVSEM_SOURCE_KEY,
			details: { source: TRUDVSEM_SOURCE_KEY, import_job_id: result.importJobId }
		});

		// The scheduler sees the waiting full import and adds only the incremental one of the source's schedule.
		expect(await scheduleVacancyImports(database.db, NOW)).toEqual([
			{ source: TRUDVSEM_SOURCE_KEY, mode: 'incremental' }
		]);
		expect(await importJobs(TRUDVSEM_SOURCE_KEY)).toHaveLength(2);
	});

	it('changes nothing when the source is already in the posted state', async () => {
		await switchVacancySource(deps, as(adminId), { source: HABR_SOURCE_KEY, enabled: true });
		const repeated = await switchVacancySource(deps, as(adminId), { source: HABR_SOURCE_KEY, enabled: true });
		expect(repeated).toEqual({ name: 'Хабр Карьера', changed: false, importJobId: null });
		expect(await journal('vacancy_source.enabled')).toHaveLength(1);
		expect(await importJobs(HABR_SOURCE_KEY)).toHaveLength(1);
	});

	it('disables a source, journaled as the administrator’s decision, without enqueueing anything', async () => {
		await database.db.update(vacancySources).set({ enabled: true }).where(eq(vacancySources.key, HABR_SOURCE_KEY));
		const result = await switchVacancySource(deps, as(adminId), { source: HABR_SOURCE_KEY, enabled: false });
		expect(result).toEqual({ name: 'Хабр Карьера', changed: true, importJobId: null });
		expect((await sourceRow(HABR_SOURCE_KEY)).enabled).toBe(false);
		expect(await importJobs(HABR_SOURCE_KEY)).toHaveLength(0);
		const [entry] = await journal('vacancy_source.disabled');
		expect(entry).toMatchObject({
			actorUserId: adminId,
			objectId: HABR_SOURCE_KEY,
			details: { source: HABR_SOURCE_KEY, reason: 'administrator' }
		});
		expect(await scheduleVacancyImports(database.db, NOW)).toEqual([]);
	});

	it('refuses to enable a source whose terms forbid use, with the reason in words', async () => {
		const [habr] = await database.db.select().from(vacancySources).where(eq(vacancySources.key, HABR_SOURCE_KEY));
		const terms = { ...(habr?.terms as Record<string, unknown>), status: 'forbidden' };
		await database.db.update(vacancySources).set({ terms }).where(eq(vacancySources.key, HABR_SOURCE_KEY));
		try {
			const error = await refusal(switchVacancySource(deps, as(adminId), { source: HABR_SOURCE_KEY, enabled: true }));
			expect(error.code).toBe('conflict');
			expect(error.details?.[0]?.code).toBe('source_terms_forbidden');
			expect(error.message).toContain('Условия использования «Хабр Карьера» запрещают импорт');
			expect((await sourceRow(HABR_SOURCE_KEY)).enabled).toBe(false);
			expect(await importJobs(HABR_SOURCE_KEY)).toHaveLength(0);
			expect(await journal('vacancy_source.enabled')).toHaveLength(0);

			const [state] = (await vacancySourcesState(deps, as(adminId))).filter((s) => s.key === HABR_SOURCE_KEY);
			expect(state?.control).toBe('terms_forbidden');
		} finally {
			await registerVacancySources(database.sql);
		}
	});

	it('never switches a synthetic source of the demo seed', async () => {
		const error = await refusal(switchVacancySource(deps, as(adminId), { source: DEMO_SOURCE, enabled: true }));
		expect(error.details?.[0]?.code).toBe('source_without_adapter');
		expect((await sourceRow(DEMO_SOURCE)).enabled).toBe(false);
		expect(await importJobs(DEMO_SOURCE)).toHaveLength(0);
	});

	it('refuses a demo actor with the demo explanation and somebody without the administrator role', async () => {
		const demo = await refusal(
			switchVacancySource(deps, as(demoAdminId), { source: TRUDVSEM_SOURCE_KEY, enabled: true })
		);
		expect(demo.code).toBe('forbidden');
		expect(demo.message).toBe(DEMO_LOCK_MESSAGE);

		const employer = await refusal(
			switchVacancySource(deps, as(employerId, false), { source: TRUDVSEM_SOURCE_KEY, enabled: true })
		);
		expect(employer.code).toBe('forbidden');
		await expect(vacancySourcesState(deps, as(employerId, false))).rejects.toBeInstanceOf(ApiError);

		expect((await sourceRow(TRUDVSEM_SOURCE_KEY)).enabled).toBe(false);
		expect(await importJobs(TRUDVSEM_SOURCE_KEY)).toHaveLength(0);
		expect(await journal('vacancy_source.enabled')).toHaveLength(0);
	});

	it('reads the switch form strictly', () => {
		const form = (entries: Record<string, string>) => {
			const data = new FormData();
			for (const [key, value] of Object.entries(entries)) data.set(key, value);
			return data;
		};
		expect(parseSourceSwitch(form({ source: 'trudvsem', enabled: 'false' }))).toEqual({
			source: 'trudvsem',
			enabled: false
		});
		expect(() => parseSourceSwitch(form({ source: 'trudvsem', enabled: 'on' }))).toThrow(ApiError);
		expect(() => parseSourceSwitch(form({ source: 'Trud vsem', enabled: 'true' }))).toThrow(ApiError);
	});
});

describe('the state of the sources', () => {
	it('shows the latest run with its counters and the error of the latest import job', async () => {
		await database.db.insert(vacancyImportRuns).values({
			source: HABR_SOURCE_KEY,
			adapterVersion: 'habr-rss/1',
			mode: 'full',
			startedAt: new Date('2026-09-25T10:00:00Z'),
			finishedAt: new Date('2026-09-25T10:00:05Z'),
			status: 'succeeded',
			completeness: 'partial',
			incompleteReason: 'recent_window_listing',
			counts: {
				fetched: 30,
				created: 28,
				updated: 0,
				unchanged: 0,
				gone: 0,
				reappeared: 0,
				rejected: { duplicate_in_listing: 2 }
			}
		});
		await database.db.insert(jobs).values({
			type: 'vacancies.import',
			typeVersion: 1,
			payload: { source: HABR_SOURCE_KEY, mode: 'full' },
			inputVersion: 'full:2026-09-25T11',
			dedupKey: `vacancies.import:${HABR_SOURCE_KEY}:full`,
			status: 'failed',
			attempts: 5,
			maxAttempts: 5,
			lastError: { code: 'source_unavailable', retryable: true, message: 'HTTP 503' },
			createdBy: { kind: 'system', id: 'scheduler' },
			finishedAt: new Date('2026-09-25T11:05:00Z')
		});

		const states = await vacancySourcesState(deps, as(adminId));
		expect(states.map((s) => [s.key, s.control])).toEqual([
			[DEMO_SOURCE, 'no_adapter'],
			[TRUDVSEM_SOURCE_KEY, 'switchable'],
			[HABR_SOURCE_KEY, 'switchable']
		]);
		const habr = states.find((s) => s.key === HABR_SOURCE_KEY);
		expect(habr).toMatchObject({
			enabled: false,
			terms: { status: 'restricted', store_description: false, attribution: 'По данным Хабр Карьеры' },
			schedule: { full_every_hours: 1 },
			activePostings: 0,
			lastRun: {
				mode: 'full',
				status: 'succeeded',
				completeness: 'partial',
				incompleteReason: 'recent_window_listing',
				counts: { fetched: 30, created: 28, rejected: { duplicate_in_listing: 2 } }
			},
			lastJob: {
				status: 'failed',
				mode: 'full',
				attempts: 5,
				error: { code: 'source_unavailable', message: 'HTTP 503' }
			}
		});
		expect(states.find((s) => s.key === TRUDVSEM_SOURCE_KEY)).toMatchObject({ lastRun: null, lastJob: null });
	});
});
