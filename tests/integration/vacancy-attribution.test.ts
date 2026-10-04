// Every external vacancy is shown with its source (docs/domain.md, 13.2; the terms of the sources): the candidate's page
// of vacancies and the public API name the source with the attribution its terms require, link the original on the
// site of the source and tell when its freshness was checked. Postings are imported by the product's import job from the
// saved answers of both sources; the pages and the API run as their routes run.
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { Actor } from '$lib/server/access/actor';
import { jobs, productPolicies, vacancies, vacancySources } from '$lib/server/db/schema';
import type { JobHandler } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob } from '$lib/server/jobs/queue';
import { JOB_TYPES, type JobPayload, type JobType } from '$lib/server/jobs/registry';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { fixturePath } from '$lib/server/vacancies/fixtures/taxonomy';
import { createVacanciesImportHandler } from '$lib/server/vacancies/import-job';
import { createVacancyNormalizeHandler } from '$lib/server/vacancies/normalize-job';
import { registerVacancySources, SOURCE_DEFINITIONS } from '$lib/server/vacancies/sources/definitions';
import { HabrCareerSource } from '$lib/server/vacancies/sources/habr';
import { TrudvsemSource } from '$lib/server/vacancies/sources/trudvsem';
import type { VacancySource } from '$lib/server/vacancies/sources/types';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, randomSha256 } from '../helpers/factories';

// The routes read `config()`: its environment points at this file's database once it exists.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const { closeDb } = await import('$lib/server/db');
const { testEnvironment } = await import('../helpers/environment');
const { load: vacanciesPage } = await import('../../src/routes/(app)/me/vacancies/+page.server');
const { GET: searchApi } = await import('../../src/routes/api/v1/vacancies/+server');
const { GET: vacancyApi } = await import('../../src/routes/api/v1/vacancies/[vacancy_id]/+server');

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const TRUDVSEM_PAGE = await readFile(fixturePath('trudvsem-page.json'), 'utf8');
const HABR_RSS = await readFile(fixturePath('habr-rss-mixed.xml'), 'utf8');
const DAY = 86_400_000;

/** What the terms of each source require the cards to show, and where its originals live. */
const EXPECTED = new Map(
	SOURCE_DEFINITIONS.map((source) => [source.key, { attribution: source.terms.attribution, site: source.siteUrl }])
);

let database: TestDatabase;

const now = () => new Date();
const answer = (body: string) => Promise.resolve(new Response(body, { status: 200 }));
const adapters: Record<string, VacancySource> = {
	habr_career: new HabrCareerSource({
		http: { fetch: () => answer(HABR_RSS), userAgent: 'test', timeoutMs: 5_000 },
		now
	}),
	trudvsem: new TrudvsemSource({
		http: { fetch: () => answer(TRUDVSEM_PAGE), userAgent: 'test', timeoutMs: 5_000 },
		now,
		queries: ['программист']
	})
};

async function runQueued<T extends JobType>(type: T, handler: JobHandler<T>): Promise<void> {
	const { db } = database;
	for (;;) {
		const claimed = await claimJob(db, 'test-worker', [type]);
		if (!claimed) return;
		if (claimed.type !== type) throw new Error(`claimed ${claimed.type} instead of ${type}`);
		const job = { ...claimed, type, payload: JOB_TYPES[type].payload.parse(claimed.payload) as JobPayload<T> };
		const result = await handler.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: createLogger({}, () => undefined)
		});
		expect(await completeJob(db, job, result)).toBe('succeeded');
	}
}

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl') }));
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const { db } = database;
	await registerVacancySources(database.sql);
	await db.update(vacancySources).set({ enabled: true });
	const effectiveFrom = new Date(Date.now() - 10 * DAY);
	await db.insert(productPolicies).values([
		{ kind: 'sourcing_policy', version: 1, params: { stale_after_days: 14 }, effectiveFrom },
		{ kind: 'catalog_policy', version: 1, params: { small_count_threshold: 5 }, effectiveFrom }
	]);
	for (const source of Object.keys(adapters)) {
		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'vacancies.import',
				{ source, mode: 'full' },
				{ inputVersion: source, createdBy: { kind: 'system' } }
			)
		);
	}
	await runQueued(
		'vacancies.import',
		createVacanciesImportHandler(() => ({ source: (key) => adapters[key] ?? null, now }))
	);
	await runQueued('vacancy.normalize', createVacancyNormalizeHandler(now));
});

afterAll(async () => {
	await closeDb();
	await database.drop();
});

let requests = 0;

/** The event of a request as the hooks leave it for a route. */
function event(actor: Actor, path: string, params: Record<string, string> = {}) {
	const url = new URL(`http://localhost:57173${path}`);
	return {
		url,
		params,
		request: new Request(url),
		locals: { requestId: `req-${++requests}`, actor },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {}
	};
}

interface ApiPosting {
	source: string;
	source_name: string;
	attribution: string;
	url: string;
	last_checked_at: string;
}

interface ApiVacancy {
	id: string;
	origin: 'own' | 'external';
	checked_at: string | null;
	postings: ApiPosting[];
}

async function api(
	route: (event: never) => Response | Promise<Response>,
	path: string,
	params: Record<string, string> = {}
) {
	const response = await route(event({ kind: 'anonymous' }, path, params) as never);
	expect(response.status, path).toBe(200);
	return (await response.json()) as unknown;
}

/** A posting names the attribution of its source and links the original on the site of the source. */
function expectAttributed(posting: { source: string; attribution: string; url: string }) {
	const expected = EXPECTED.get(posting.source);
	expect(expected, posting.source).toBeDefined();
	expect(posting.attribution).toBe(expected?.attribution);
	expect(new URL(posting.url).origin).toBe(new URL(expected?.site ?? 'http://invalid').origin);
}

const externalIds = async () =>
	(
		await database.db
			.select({ id: vacancies.id })
			.from(vacancies)
			.where(and(eq(vacancies.origin, 'external'), eq(vacancies.status, 'active')))
	).map((row) => row.id);

describe('attribution of external vacancies', () => {
	it('imported postings of both sources', async () => {
		const ids = await externalIds();
		// Four IT postings of the mixed feed and four of the portal page, all normalized.
		expect(ids).toHaveLength(8);
		const pending = await database.db
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.type, 'vacancy.normalize'), eq(jobs.status, 'queued')));
		expect(pending).toHaveLength(0);
	});

	it('the public search names the source of every external vacancy', async () => {
		const ids = await externalIds();
		const body = (await api(searchApi, '/api/v1/vacancies?origin=external&limit=100')) as { items: ApiVacancy[] };
		expect(body.items.map((item) => item.id).sort()).toEqual([...ids].sort());
		const sources = new Set<string>();
		for (const item of body.items) {
			expect(item.postings.length, item.id).toBeGreaterThan(0);
			expect(item.checked_at, item.id).not.toBeNull();
			for (const posting of item.postings) {
				expectAttributed(posting);
				expect(posting.last_checked_at).toEqual(expect.any(String));
				sources.add(posting.source);
			}
		}
		expect([...sources].sort()).toEqual(['habr_career', 'trudvsem']);
	});

	it('a vacancy read by id names its source too', async () => {
		for (const id of await externalIds()) {
			const body = (await api(vacancyApi, `/api/v1/vacancies/${id}`, { vacancy_id: id })) as ApiVacancy;
			expect(body.postings.length, id).toBeGreaterThan(0);
			for (const posting of body.postings) expectAttributed(posting);
		}
	});

	it('the candidate sees the source, the link to the original and the check date on every external card', async () => {
		const candidate = await createCandidate(database.db, { preferences: { work_formats: ['remote'] } });
		const actor: Actor = {
			kind: 'session',
			userId: candidate.userId,
			sessionHash: randomSha256(),
			authTime: new Date(),
			authMethod: 'password',
			csrfToken: `csrf-${randomBytes(4).toString('hex')}`
		};
		const data = (await vacanciesPage(event(actor, '/me/vacancies') as never)) as {
			page: {
				items: {
					vacancyId: string;
					origin: 'own' | 'external';
					sources: { attribution: string; url: string; lastCheckedAt: Date }[];
				}[];
			};
		};
		const external = data.page.items.filter((item) => item.origin === 'external');
		expect(external).toHaveLength(8);
		for (const item of external) {
			expect(item.sources.length, item.vacancyId).toBeGreaterThan(0);
			for (const source of item.sources) {
				expect([...EXPECTED.values()].map((e) => e.attribution)).toContain(source.attribution);
				expect(source.url).toMatch(/^https:\/\/(career\.habr\.com|trudvsem\.ru)\//u);
				expect(source.lastCheckedAt).toBeInstanceOf(Date);
			}
		}
	});
});
