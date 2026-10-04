// «This is our vacancy» across demo sessions (docs/domain.md, sections 13.3, 19.3). External vacancies are shared by
// every session and by the stand outside them, so what a session does with one stays in the session: a company of
// session A claims a vacancy, the operator of A approves the claim and the company publishes its own vacancy made from
// it. Within A the vacancy is «claimed by you» and leaves the search and the feed; in session B and outside sessions it
// is still found, claimed by nobody, and a company there files and gets its own claim approved. Removing session A
// leaves nothing outside it that names its rows.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { searchVacancyIds } from '$lib/server/api/read/vacancies';
import {
	demoSessions,
	productPolicies,
	vacancies,
	vacancyClaims,
	vacancyImportRuns,
	vacancyPostings
} from '$lib/server/db/schema';
import { purgeDemoSession } from '$lib/server/demo/purge';
import { searchExternalVacancies } from '$lib/server/employer/external-vacancies';
import { recommendVacancies } from '$lib/server/matching/recommendations';
import { decideClaim } from '$lib/server/operator/claims';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { submitVacancyClaim } from '$lib/server/vacancies/claims';
import { PENDING_NORMALIZATION, PENDING_VERSION } from '$lib/server/vacancies/clusters';
import { createOwnVacancy, publishOwnVacancy } from '$lib/server/vacancies/own';
import { HABR_SOURCE_KEY, registerVacancySources } from '$lib/server/vacancies/sources/definitions';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createExternalVacancy,
	createMember,
	createUser,
	randomSha256
} from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;
const now = () => new Date();

const noObjects: ObjectStore = {
	put: () => Promise.reject(new Error('no objects in this test')),
	get: () => Promise.resolve(null),
	delete: () => Promise.resolve(),
	exists: () => Promise.resolve(false)
};

let database: TestDatabase;
let redis: Redis;
let taxonomyVersionId: string;

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const [version] = await database.sql<{ id: string }[]>`select id from taxonomy_versions where status = 'published'`;
	if (!version) throw new Error('taxonomy not published');
	taxonomyVersionId = version.id;
	await registerVacancySources(database.sql);
	await database.db.insert(productPolicies).values({
		kind: 'catalog_policy',
		version: 1,
		params: { small_count_threshold: 5 },
		effectiveFrom: new Date(Date.now() - 10 * DAY)
	});
	redis = createClient({ url: inject('redisUrl') });
	await redis.connect();
});

afterAll(async () => {
	redis.destroy();
	await database.drop();
});

async function demoSession(): Promise<string> {
	const [row] = await database.db
		.insert(demoSessions)
		.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + DAY) })
		.returning();
	if (!row) throw new Error('demo session not inserted');
	return row.id;
}

/** An external vacancy with the posting it was imported from. */
async function externalVacancy() {
	const { db } = database;
	const vacancy = await createExternalVacancy(db, taxonomyVersionId, { roleKey: 'backend', workFormat: 'remote' });
	const at = new Date();
	const [run] = await db
		.insert(vacancyImportRuns)
		.values({
			source: HABR_SOURCE_KEY,
			adapterVersion: 'test/1',
			mode: 'full',
			startedAt: at,
			finishedAt: at,
			status: 'succeeded',
			completeness: 'complete',
			counts: {}
		})
		.returning({ id: vacancyImportRuns.id });
	if (!run) throw new Error('import run not inserted');
	const externalId = String(randomBytes(4).readUInt32BE());
	await db.insert(vacancyPostings).values({
		vacancyId: vacancy.id,
		source: HABR_SOURCE_KEY,
		externalId,
		url: `https://career.habr.com/vacancies/${externalId}`,
		organization: { name: 'Пример', inn: null, source_org_id: null },
		title: vacancy.title,
		originalTerms: {},
		rawSha256: randomSha256(),
		normalized: PENDING_NORMALIZATION,
		normalizationVersion: PENDING_VERSION,
		firstFetchedAt: at,
		lastFetchedAt: at,
		lastCheckedAt: at,
		freshness: 'active',
		dedup: { method: 'exact', score: 1 },
		lastImportRunId: run.id
	});
	return vacancy;
}

/** A place of the stand: a demo session or the stand outside sessions (`null`), with a verified company and an operator. */
async function place(session: string | null) {
	const { db } = database;
	const company = await createCompany(db, { demoSessionId: session });
	const user = await createUser(db, { demoSessionId: session });
	const member = await createMember(db, company.id, { userId: user.id });
	const operator: AccessSubject = {
		userId: (await createUser(db, { demoSessionId: session })).id,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: true, admin: false, extraPermissions: [] }
	};
	const candidate = await createCandidate(db, {
		userId: (await createUser(db, { demoSessionId: session })).id,
		demoSessionId: session
	});
	const reader: AccessSubject = {
		userId: candidate.userId,
		via: 'session',
		candidate: { id: candidate.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { session, company, userId: user.id, member, operator, reader };
}

type Place = Awaited<ReturnType<typeof place>>;

async function claim(who: Place, vacancyId: string) {
	return submitVacancyClaim(
		{ db: database.db, now },
		{
			userId: who.userId,
			companyId: who.company.id,
			audit: { kind: 'user', userId: who.userId, companyId: who.company.id },
			requestId: `req-${randomUUID()}`
		},
		vacancyId
	);
}

async function approve(who: Place, claimId: string) {
	await decideClaim(
		database.db,
		who.operator,
		{ requestId: `req-${randomUUID()}`, ip: null, userAgent: 'test' },
		claimId,
		'approved',
		''
	);
}

/** «Claimed by» of the vacancy on the employer's page of external vacancies. */
async function claimedBy(who: Place, vacancyId: string) {
	const page = await searchExternalVacancies(
		database.db,
		{ userId: who.userId, companyId: who.company.id },
		{ text: '', roleKey: null, workFormats: [], cursor: undefined },
		new Date()
	);
	return page.items.find((item) => item.id === vacancyId)?.claimedBy ?? 'not_found';
}

async function found(who: Place, vacancyId: string) {
	const search = await searchVacancyIds(database.db, { origin: 'external' }, who.session);
	const feed = await recommendVacancies({ db: database.db }, who.reader, { limit: 100, origin: 'external' });
	return { search: search.includes(vacancyId), feed: feed.items.some((item) => item.vacancyId === vacancyId) };
}

async function stored(vacancyId: string) {
	const [row] = await database.db.select().from(vacancies).where(eq(vacancies.id, vacancyId));
	if (!row) throw new Error('vacancy is missing');
	return row;
}

describe('«this is our vacancy» within a demo session', () => {
	it('stays in the session: other sessions and the stand keep the vacancy and claim it themselves', async () => {
		const first = await place(await demoSession());
		const second = await place(await demoSession());
		const stand = await place(null);
		const vacancy = await externalVacancy();

		const filed = await claim(first, vacancy.id);
		expect(filed).toMatchObject({ status: 'pending_review', demoSessionId: first.session });
		await approve(first, filed.id);
		expect((await stored(vacancy.id)).claimedCompanyId).toBeNull();
		expect(await claimedBy(first, vacancy.id)).toBe('this_company');
		expect(await claimedBy(second, vacancy.id)).toBe('none');
		expect(await claimedBy(stand, vacancy.id)).toBe('none');
		await expect(claim(first, vacancy.id)).rejects.toMatchObject({ reason: 'claim_already_approved' });

		// The company of the session publishes its own vacancy made from the external one.
		const author = {
			memberId: first.member.id,
			companyId: first.company.id,
			audit: { kind: 'user' as const, userId: first.userId },
			requestId: 'req-own'
		};
		const own = await createOwnVacancy(
			{ db: database.db, now },
			author,
			{
				title: 'Go-разработчик',
				description: 'Сервисы на Go и PostgreSQL для платёжной команды.',
				roleKey: 'backend',
				gradeMin: 'middle',
				gradeMax: 'senior',
				requiredSkillKeys: ['go'],
				niceSkillKeys: [],
				workFormat: 'remote',
				employmentForm: 'full',
				contractTypes: ['labor'],
				cityId: null,
				timezoneOverlapHours: null,
				salary: { min: 200_000, max: 300_000, currency: 'RUB', period: 'month', taxBase: 'gross' }
			},
			{ derivedFromVacancyId: vacancy.id }
		);
		expect(await publishOwnVacancy({ db: database.db, now }, author, own.id)).toMatchObject({ status: 'published' });
		expect((await stored(vacancy.id)).supersededByVacancyId).toBeNull();
		expect(await found(first, vacancy.id)).toEqual({ search: false, feed: false });
		expect(await found(second, vacancy.id)).toEqual({ search: true, feed: true });
		expect(await found(stand, vacancy.id)).toEqual({ search: true, feed: true });

		// Another session and the stand claim the same vacancy, each for itself.
		const secondClaim = await claim(second, vacancy.id);
		await approve(second, secondClaim.id);
		expect(await claimedBy(second, vacancy.id)).toBe('this_company');
		expect(await claimedBy(stand, vacancy.id)).toBe('none');
		const standClaim = await claim(stand, vacancy.id);
		expect(standClaim.demoSessionId).toBeNull();
		await approve(stand, standClaim.id);
		expect((await stored(vacancy.id)).claimedCompanyId).toBe(stand.company.id);
		expect(await claimedBy(stand, vacancy.id)).toBe('this_company');
		// Session A replaced the vacancy with its own: it is not among the external ones there.
		expect(await claimedBy(first, vacancy.id)).toBe('not_found');
		expect(await claimedBy(second, vacancy.id)).toBe('this_company');

		// A company outside sessions holding the vacancy is seen from a session that has no claim of its own.
		const third = await place(await demoSession());
		expect(await claimedBy(third, vacancy.id)).toBe('other_company');
		await expect(claim(third, vacancy.id)).rejects.toMatchObject({ reason: 'claim_already_approved' });

		// The session goes with its claim and its vacancy; nothing outside it named them.
		const purged = await purgeDemoSession(
			{ db: database.db, redis, store: noObjects },
			first.session ?? '',
			new Date(),
			'req-purge'
		);
		expect(purged?.referencesDetached).toBe(0);
		expect(await database.db.$count(vacancyClaims, eq(vacancyClaims.id, filed.id))).toBe(0);
		expect(await database.db.$count(vacancies, eq(vacancies.id, own.id))).toBe(0);
		expect(await found(stand, vacancy.id)).toEqual({ search: true, feed: true });
	});
});
