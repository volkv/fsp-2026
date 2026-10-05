// Demo sessions of the demonstration stand (docs/domain.md, section 19.3): every visitor gets a clone of the scenario
// cast with everything its originals own; what one session does is not seen by another, the originals of the cast are
// not shown inside a session anywhere a visitor could meet them, and a session opened later does not inherit a row
// that ties an original to an earlier session; the removal of a session takes exactly its rows, leaves the
// originals and the other sessions as they were, and stops on a reference from outside instead of breaking it. A
// visitor's own resume needs its separate consent, takes the profile out of the catalog and goes with the session,
// the file, the text and the results derived from it included. Administrator actions shared by all visitors are closed
// to demo accounts. The clone plan has a decision for every table and every foreign key of the schema.
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { publishLegalDocuments, readLegalRelease } from '../../scripts/seed-legal';
import { publishPolicies, readPolicyRelease } from '../../scripts/seed-policies';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import { searchVacancyIds, visibleVacancyId } from '$lib/server/api/read/vacancies';
import type { Actor } from '$lib/server/access/actor';
import { requireStandChange, standChangesLocked } from '$lib/server/access/demo-actor';
import { grantStaffRole } from '$lib/server/admin/staff';
import { loadSelfEvidence } from '$lib/server/candidates/profile';
import { currentDocument } from '$lib/server/auth/documents';
import { createEvidenceHandler } from '$lib/server/evidence/job';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	athleteLinks,
	auditEvents,
	candidateCompanyBlocks,
	candidates,
	companies,
	demoSessions,
	embeddings,
	embeddingSpaces,
	erasureLedger,
	files,
	invitations,
	jobs,
	matchScores,
	resumeDocuments,
	sourceFacts,
	users,
	vacancies
} from '$lib/server/db/schema';
import { castOriginals, castRoles } from '$lib/server/demo/cast';
import { companyPartnerships, readPartnerPool } from '$lib/server/partner-pool/pool';
import { MAX_LIVE_SESSIONS, openDemoSession, type OpenedSession } from '$lib/server/demo/clone';
import { compareWithClonePlan, isPlanComplete } from '$lib/server/demo/clone-plan';
import { readSeedData, type SeedData } from '$lib/server/demo/data';
import { foreignKeyColumns, loadSchemaGraph, ownedTables } from '$lib/server/demo/graph';
import { uploadOwnResume } from '$lib/server/demo/own-resume';
import { DemoIsolationLeak, purgeDemoSession, purgeExpiredDemoSessions, sessionRows } from '$lib/server/demo/purge';
import { drainJobs } from '$lib/server/demo/queue';
import { schemaTables } from '$lib/server/demo/reset';
import { seedDemo } from '$lib/server/demo/seed';
import type { DemoServices } from '$lib/server/demo/services';
import { DEMO_IDLE_MINUTES, idleEndOf, lastEndOf, redisDemoActivity } from '$lib/server/demo/activity';
import { cloneOfRole, demoTerms } from '$lib/server/demo/visit';
import { HttpAchievementsSource } from '$lib/server/fsp/adapter';
import { RATE_LIMIT_RULES } from '$lib/server/http/rate-limit';
import { ServiceGrantIssuer } from '$lib/server/fsp/grant';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { getInvitation, listInvitations } from '$lib/server/invitations/read';
import { respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation } from '$lib/server/invitations/send';
import { handlerRegistry } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { enqueueJob } from '$lib/server/jobs/queue';
import { recommendVacancies } from '$lib/server/matching/recommendations';
import { createMatchRefreshHandler } from '$lib/server/matching/refresh';
import { searchCandidates } from '$lib/server/matching/search';
import { fail } from '$lib/server/ml/result';
import type { Redis } from '$lib/server/redis';
import { createResumeExtractHandler } from '$lib/server/resumes/extract-job';
import { createResumeParseHandler } from '$lib/server/resumes/parse-job';
import { uploadResume } from '$lib/server/resumes/upload';
import type { ObjectStore, StoredObject } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { DEFAULT_SEED } from '../../services/fsp-mock/src/config.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { startParser, type StartedParser } from '../helpers/docparse';
import { testEnvironment } from '../helpers/environment';
import { createUser, offerTerms } from '../helpers/factories';
import { FSP_MOCK_CREDENTIALS, startFspMock, type FspMock } from '../helpers/fsp-mock';

const ROOT = new URL('../../', import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, ROOT));
const ATHLETES = 200;
const REDIS_DATABASE = 9;

const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

let database: TestDatabase;
let mock: FspMock;
let redis: Redis;
let services: DemoServices;
let data: SeedData;

class MemoryStore implements ObjectStore {
	readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
	put(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<void> {
		this.objects.set(key, { bytes, contentType });
		return Promise.resolve();
	}
	get(key: string): Promise<StoredObject | null> {
		const object = this.objects.get(key);
		if (!object) return Promise.resolve(null);
		const { bytes } = object;
		return Promise.resolve({
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				}
			}),
			sizeBytes: bytes.byteLength,
			contentType: object.contentType
		});
	}
	delete(key: string): Promise<void> {
		this.objects.delete(key);
		return Promise.resolve();
	}
	exists(key: string): Promise<boolean> {
		return Promise.resolve(this.objects.has(key));
	}
}

/** The real parser: the heroes' resumes are PDF and DOCX, a visitor's own one is text. */
let parser: StartedParser;
const store = new MemoryStore();
const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});
const log = createLogger({}, () => undefined);
const MODELS_OFF = {
	embed: () => Promise.resolve(fail('disabled', 'embed: off in the test', { reason: 'test' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: off in the test', { reason: 'test' }))
};
const handlers = handlerRegistry([
	createResumeParseHandler({ store: () => store, parser: () => parser.client }),
	createResumeExtractHandler({
		adapter: () => ({
			extract: () => Promise.resolve(fail('disabled', 'extract: off in the test', { reason: 'test' }))
		}),
		crypto: () => crypto,
		now: () => new Date()
	}),
	createEvidenceHandler(),
	createMatchRefreshHandler(() => MODELS_OFF)
]);

beforeAll(async () => {
	parser = await startParser();
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(path('taxonomy'))));
		await publishLegalDocuments(client, await readLegalRelease(path('legal')));
		await publishPolicies(client, await readPolicyRelease(path('policies')));
	} finally {
		await client.end({ timeout: 5 });
	}
	mock = await startFspMock({ athletes: ATHLETES });
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
	Object.assign(
		env,
		testEnvironment({ DATABASE_URL: database.url, REDIS_URL: `${inject('redisUrl')}/${REDIS_DATABASE}` })
	);
	services = {
		db: database.db,
		redis,
		crypto,
		store,
		parser: parser.client,
		fsp: {
			source: new HttpAchievementsSource({ baseUrl: mock.origin, webhookSecret: FSP_MOCK_CREDENTIALS.webhookSecret }),
			grants: new ServiceGrantIssuer({
				issuer: mock.issuer,
				clientId: FSP_MOCK_CREDENTIALS.clientId,
				clientSecret: FSP_MOCK_CREDENTIALS.clientSecret,
				assertionSecret: FSP_MOCK_CREDENTIALS.assertionSecret
			}),
			signer: createReceiptSigner({ issuer: 'http://platform.test', keyId: 'test-1', seed: Buffer.alloc(32, 7) })
		},
		fspIdIssuer: mock.issuer,
		fspMockOrigin: mock.origin,
		settings: {
			candidates: 40,
			vacancies: 30,
			world: { seed: DEFAULT_SEED, athletes: ATHLETES },
			nightlyReset: true,
			fspMockControlToken: FSP_MOCK_CREDENTIALS.controlToken
		},
		appOrigin: 'http://localhost:57173',
		seedsDir: path('seeds'),
		log
	};
	data = await readSeedData(path('seeds'));
}, 900_000);

afterAll(async () => {
	await mock.stop();
	redis.destroy();
	await Promise.all([database.drop(), parser.container.stop()]);
});

/** Rows of every table a session can own: the stand before any session is the baseline of the removal. */
async function census(): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const table of ownedTables()) {
		const [row] = await database.sql<{ n: number }[]>`select count(*)::int as n from ${database.sql(table)}`;
		counts[table] = row?.n ?? 0;
	}
	return counts;
}

async function rowsOf(sessionId: string): Promise<number> {
	const graph = await loadSchemaGraph(database.db);
	const rows = await sessionRows(database.db, graph, sessionId);
	return [...rows.values()].reduce((sum, ids) => sum + ids.size, 0);
}

async function subjectOf(userId: string) {
	const actor: Actor = {
		kind: 'session',
		userId,
		sessionHash: 'a'.repeat(64),
		authTime: new Date(),
		authMethod: 'password',
		csrfToken: ''
	};
	return loadAccessSubject(database.db, actor);
}

const meta = { requestId: 'demo-sessions-test', ip: null, userAgent: 'test', sessionHash: 'a'.repeat(64) };
const invitationDeps = () => ({ db: database.db, crypto, now: () => new Date() });
const deps = () => ({ db: database.db, crypto, store, activity: redisDemoActivity(redis), now: () => new Date() });

async function companyOf(userId: string): Promise<string> {
	const subject = await subjectOf(userId);
	if (!subject.membership) throw new Error(`user ${userId} is not a member`);
	return subject.membership.companyId;
}

async function candidateOfUser(userId: string): Promise<string> {
	const [row] = await database.db.select({ id: candidates.id }).from(candidates).where(eq(candidates.userId, userId));
	if (!row) throw new Error(`user ${userId} has no profile`);
	return row.id;
}

async function openInvitationOf(candidateId: string) {
	const [row] = await database.db
		.select({ id: invitations.id, status: invitations.status, termsId: invitations.currentTermsId })
		.from(invitations)
		.where(eq(invitations.candidateId, candidateId));
	if (!row?.termsId) throw new Error(`candidate ${candidateId} has no invitation`);
	return { ...row, termsId: row.termsId };
}

let baseline: Record<string, number>;
let a: OpenedSession;
let b: OpenedSession;
let c: OpenedSession;

describe('demo clone plan', () => {
	it('has a decision for every table and every foreign key of the migrated schema', async () => {
		const tables = await schemaTables(database.db);
		const keys = await foreignKeyColumns(database.db);
		expect(compareWithClonePlan(tables, keys)).toEqual({
			unplanned: [],
			missing: [],
			unclassified: [],
			stale: [],
			misdirected: []
		});
		// A table or a key the plan does not know stops cloning and purging.
		const probe = compareWithClonePlan(
			[...tables, 'demo_probe'],
			[...keys, { table: 'claims', column: 'reviewer_id', references: 'users', deferrable: false }]
		);
		expect(isPlanComplete(probe)).toBe(false);
		expect(probe.unplanned).toEqual(['demo_probe']);
		expect(probe.unclassified).toEqual(['claims.reviewer_id']);
	});
});

describe('demo sessions', () => {
	it('clones the whole cast for each visitor', { timeout: 600_000 }, async () => {
		const seeded = await seedDemo(services);
		expect(seeded.status).toBe('seeded');
		baseline = await census();

		const terms = await demoTerms(database.db);
		expect(terms).toEqual({ sessionHours: 24, ownResumeHours: 24 });
		a = await openDemoSession(deps(), data, terms, meta);
		b = await openDemoSession(deps(), data, terms, meta);
		expect(a.clones.size).toBe(castRoles(data).length);
		expect(a.rowsCopied).toBeGreaterThan(100);
		expect(a.filesCopied).toBeGreaterThan(0);
		expect(await rowsOf(b.sessionId)).toBe(await rowsOf(a.sessionId));

		// Clones are new accounts of the session, the originals stay outside any session.
		const originals = await castOriginals(database.db, crypto, castRoles(data));
		for (const [key, cloneId] of a.clones) {
			expect(cloneId).not.toBe(originals.users.get(key)?.id);
			expect(b.clones.get(key)).not.toBe(cloneId);
		}
		const clones = await database.db
			.select({ session: users.demoSessionId, batch: users.seedBatchId })
			.from(users)
			.where(inArray(users.id, [...a.clones.values()]));
		expect(new Set(clones.map((row) => row.session))).toEqual(new Set([a.sessionId]));
		// Each opening is in the journal with what it copied.
		const opened = await database.db
			.select({ objectId: auditEvents.objectId, details: auditEvents.details })
			.from(auditEvents)
			.where(eq(auditEvents.action, 'demo.session_opened'));
		expect(opened.find((row) => row.objectId === a.sessionId)?.details).toMatchObject({
			rows_copied: a.rowsCopied,
			files_copied: a.filesCopied
		});
		expect(opened).toHaveLength(2);
		expect(new Set(clones.map((row) => row.batch))).toEqual(new Set([originals.batch]));
		const cloneCompanies = await database.db
			.select({ inn: companies.inn })
			.from(companies)
			.where(eq(companies.demoSessionId, a.sessionId));
		expect(cloneCompanies).toHaveLength(originals.companyIds.length);

		// The seed marks the profiles and companies of the originals, and only them; the clones carry no mark.
		const marked = async (table: typeof candidates | typeof companies) =>
			(await database.db.select({ id: table.id }).from(table).where(eq(table.demoOriginal, true)))
				.map((row) => row.id)
				.sort();
		expect(await marked(candidates)).toEqual([...originals.candidateIds].sort());
		expect(await marked(companies)).toEqual([...originals.companyIds].sort());

		// The pool of every copied vacancy is counted again within its session.
		const vacanciesA = await database.db
			.select({ id: vacancies.id })
			.from(vacancies)
			.innerJoin(companies, eq(companies.id, vacancies.companyId))
			.where(eq(companies.demoSessionId, a.sessionId));
		expect(vacanciesA.length).toBeGreaterThan(0);
		const refreshes = await database.db
			.select({ vacancyId: sql<string>`${jobs.payload}->>'vacancy_id'` })
			.from(jobs)
			.where(
				and(
					eq(jobs.type, 'match.refresh'),
					eq(jobs.status, 'queued'),
					inArray(
						sql`${jobs.payload}->>'vacancy_id'`,
						vacanciesA.map((row) => row.id)
					)
				)
			);
		expect(refreshes.map((row) => row.vacancyId).sort()).toEqual(vacanciesA.map((row) => row.id).sort());

		// A clone of an athlete shows FSP as linked: the session holds an active link of its own, while the one active
		// link of the athlete outside sessions stays the original's.
		const athletes = data.demo.candidates.filter((hero) => hero.athlete !== undefined);
		expect(athletes.length).toBeGreaterThan(0);
		for (const hero of athletes) {
			for (const session of [a, b]) {
				const clone = await cloneOfRole(database.db, crypto, session.sessionId, role(hero.key));
				const links = await database.db
					.select({ status: athleteLinks.status, session: athleteLinks.demoSessionId })
					.from(athleteLinks)
					.where(eq(athleteLinks.userId, clone));
				expect(links).toEqual([{ status: 'active', session: session.sessionId }]);
				expect((await loadSelfEvidence(database.db, await subjectOf(clone), new Date())).fspLinked).toBe(true);
			}
			const original = originals.users.get(role(hero.key).key)?.id ?? '';
			const [own] = await database.db
				.select({ status: athleteLinks.status, session: athleteLinks.demoSessionId })
				.from(athleteLinks)
				.where(eq(athleteLinks.userId, original));
			expect(own).toEqual({ status: 'active', session: null });
		}

		// The clone of К-5 has the open invitation of the clone of the main employer, not of the original.
		const oleg = await candidateOfUser(await cloneOfRole(database.db, crypto, a.sessionId, role('k5')));
		const invitation = await openInvitationOf(oleg);
		expect(invitation.status).toBe('sent');
		const [sender] = await database.db
			.select({ session: companies.demoSessionId })
			.from(invitations)
			.innerJoin(companies, eq(companies.id, invitations.companyId))
			.where(eq(invitations.id, invitation.id));
		expect(sender?.session).toBe(a.sessionId);
		// Copied resume files have their own objects.
		const copiedFiles = await database.db
			.select({ key: files.storageKey })
			.from(files)
			.innerJoin(users, eq(users.id, files.ownerUserId))
			.where(eq(users.demoSessionId, a.sessionId));
		expect(copiedFiles.length).toBe(a.filesCopied);
		for (const file of copiedFiles) expect(store.objects.has(file.key)).toBe(true);
	});

	it('keeps what one visitor does out of the other session', { timeout: 120_000 }, async () => {
		// The visitor of A declines the invitation of К-5.
		const olegA = await cloneOfRole(database.db, crypto, a.sessionId, role('k5'));
		const invitationA = await openInvitationOf(await candidateOfUser(olegA));
		await respondToInvitation(invitationDeps(), await subjectOf(olegA), meta, invitationA.id, {
			termsId: invitationA.termsId,
			decision: 'decline',
			reasonCode: 'salary'
		});
		expect((await openInvitationOf(await candidateOfUser(olegA))).status).toBe('declined');

		// Session B does not see it: its К-5 still has the invitation unanswered, from its own employer.
		const olegB = await cloneOfRole(database.db, crypto, b.sessionId, role('k5'));
		expect((await openInvitationOf(await candidateOfUser(olegB))).status).toBe('sent');
		const recruiterB = await cloneOfRole(database.db, crypto, b.sessionId, role('recruiter@severny-kod.example'));
		const sentByB = await database.db
			.select({ status: invitations.status })
			.from(invitations)
			.where(eq(invitations.companyId, await companyOf(recruiterB)));
		expect(sentByB.map((row) => row.status)).not.toContain('declined');
	});

	it(
		'shows the clone of a partner the pool its original has, in each session its own',
		{ timeout: 120_000 },
		async () => {
			const matching = {
				db: database.db,
				models: MODELS_OFF,
				pseudonym: (candidateId: string, companyId: string) => crypto.pseudonym(candidateId, companyId),
				now: () => new Date(),
				testResults: GRADE_DECISION_RESULTS
			};
			const partner = role('recruiter@teply-stek.example');
			const originals = await castOriginals(database.db, crypto, castRoles(data));
			const pool = async (userId: string) => {
				const subject = await subjectOf(userId);
				const [partnership] = await companyPartnerships(database.db, subject, new Date());
				if (!partnership?.open) throw new Error(`the company of ${userId} has no open partnership`);
				return { partnershipId: partnership.id, pool: await readPartnerPool(matching, subject, partnership.id) };
			};
			// The background finalists consented to the original: its clone is the same company within the session.
			const stand = await pool(originals.users.get(partner.key)?.id ?? '');
			expect(stand.pool.members.length).toBeGreaterThan(0);
			const partnerA = await cloneOfRole(database.db, crypto, a.sessionId, partner);
			const partnerB = await cloneOfRole(database.db, crypto, b.sessionId, partner);
			const inA = await pool(partnerA);
			const inB = await pool(partnerB);
			const shape = (read: typeof stand) => read.pool.members.map((member) => JSON.stringify(member.result)).sort();
			expect(shape(inA)).toEqual(shape(stand));
			expect(shape(inB)).toEqual(shape(stand));
			const [cloneA] = await database.db
				.select({ original: companies.demoCloneOf })
				.from(companies)
				.where(eq(companies.id, await companyOf(partnerA)));
			expect(cloneA?.original).toBe(await companyOf(originals.users.get(partner.key)?.id ?? ''));
			// Each session reads its own partnership; the other session's is not found.
			expect(inA.partnershipId).not.toBe(inB.partnershipId);
			await expect(readPartnerPool(matching, await subjectOf(partnerA), inB.partnershipId)).rejects.toMatchObject({
				code: 'not_found'
			});
		}
	);

	it('does not show the originals of the cast inside a session', { timeout: 300_000 }, async () => {
		const originals = await castOriginals(database.db, crypto, castRoles(data));
		const originalIds = new Set(originals.candidateIds);
		const originalCompanies = new Set(originals.companyIds);
		const matching = {
			db: database.db,
			models: MODELS_OFF,
			pseudonym: (candidateId: string, companyId: string) => crypto.pseudonym(candidateId, companyId),
			now: () => new Date(),
			testResults: GRADE_DECISION_RESULTS
		};
		const sessionCandidates = async (sessionId: string) =>
			new Set(
				(
					await database.db
						.select({ id: candidates.id })
						.from(candidates)
						.where(eq(candidates.demoSessionId, sessionId))
				).map((row) => row.id)
			);
		const clonesA = await sessionCandidates(a.sessionId);

		// The catalog of the clone of an employer: the clones of its session and the background, no original.
		const recruiter = role('recruiter@severny-kod.example');
		const recruiterA = await cloneOfRole(database.db, crypto, a.sessionId, recruiter);
		const inSession = (await searchCandidates(matching, await subjectOf(recruiterA), { limit: 100 })).items.map(
			(item) => item.candidateId
		);
		expect(inSession.some((id) => clonesA.has(id))).toBe(true);
		expect(inSession.some((id) => !clonesA.has(id))).toBe(true);
		expect(inSession.filter((id) => originalIds.has(id))).toEqual([]);
		// The original employer sees the originals and no clone.
		const recruiterStand = originals.users.get(recruiter.key)?.id ?? '';
		const onStand = (await searchCandidates(matching, await subjectOf(recruiterStand), { limit: 100 })).items.map(
			(item) => item.candidateId
		);
		expect(onStand.some((id) => originalIds.has(id))).toBe(true);
		expect(onStand.filter((id) => clonesA.has(id))).toEqual([]);

		// An invitation of the clone of an employer to an original is refused as to a candidate it does not see.
		const companyA = await companyOf(recruiterA);
		const stepan = await candidateOfUser(originals.users.get(role('k1').key)?.id ?? '');
		const [vacancy] = await database.db
			.select({ id: vacancies.id, min: vacancies.salaryMin, max: vacancies.salaryMax })
			.from(vacancies)
			.where(
				and(
					eq(vacancies.companyId, companyA),
					eq(vacancies.status, 'published'),
					isNotNull(vacancies.salaryMin),
					sql`${vacancies.minAge} is null`
				)
			)
			.limit(1);
		if (!vacancy?.min || !vacancy.max) throw new Error('the clone of the main employer has no published vacancy');
		await expect(
			createInvitation(invitationDeps(), await subjectOf(recruiterA), meta, {
				...offerTerms({ vacancyId: vacancy.id, salaryMin: vacancy.min, salaryMax: vacancy.max, message: null }),
				candidateId: stepan
			})
		).rejects.toMatchObject({ code: 'not_found' });

		// The vacancies a clone of a hero is shown and the vacancies of the API: those of its session and of the
		// background, none of an original company; outside sessions the other way round.
		const companyOfVacancy = new Map(
			(await database.db.select({ id: vacancies.id, companyId: vacancies.companyId }).from(vacancies)).map((row) => [
				row.id,
				row.companyId
			])
		);
		const sessionOf = new Map(
			(await database.db.select({ id: companies.id, session: companies.demoSessionId }).from(companies)).map((row) => [
				row.id,
				row.session
			])
		);
		const reachOf = (companyId: string | null | undefined) =>
			companyId === null || companyId === undefined
				? 'external'
				: originalCompanies.has(companyId)
					? 'original'
					: (sessionOf.get(companyId) ?? 'background');
		const stepanA = await cloneOfRole(database.db, crypto, a.sessionId, role('k1'));
		const shown = await recommendVacancies({ db: database.db }, await subjectOf(stepanA), { limit: 100 });
		const shownReach = new Set(shown.items.map((item) => reachOf(item.companyId)));
		expect(shownReach.has(a.sessionId)).toBe(true);
		expect(shownReach.has('original')).toBe(false);
		expect(shownReach.has(b.sessionId)).toBe(false);
		const apiA = new Set(
			(await searchVacancyIds(database.db, {}, a.sessionId)).map((id) => reachOf(companyOfVacancy.get(id)))
		);
		expect(apiA.has(a.sessionId)).toBe(true);
		expect(apiA.has('original')).toBe(false);
		const apiStand = new Set(
			(await searchVacancyIds(database.db, {}, null)).map((id) => reachOf(companyOfVacancy.get(id)))
		);
		expect(apiStand.has('original')).toBe(true);
		expect(apiStand.has(a.sessionId)).toBe(false);
		const [originalVacancy] = await database.db
			.select({ id: vacancies.id })
			.from(vacancies)
			.where(and(inArray(vacancies.companyId, originals.companyIds), eq(vacancies.status, 'published')))
			.limit(1);
		if (!originalVacancy) throw new Error('the original companies have no published vacancy');
		expect(await visibleVacancyId(database.db, originalVacancy.id, { companyId: null, demoSessionId: null })).toBe(
			originalVacancy.id
		);
		expect(
			await visibleVacancyId(database.db, originalVacancy.id, { companyId: null, demoSessionId: a.sessionId })
		).toBeNull();
		expect(await visibleVacancyId(database.db, vacancy.id, { companyId: null, demoSessionId: b.sessionId })).toBeNull();
		expect(await visibleVacancyId(database.db, vacancy.id, { companyId: null, demoSessionId: a.sessionId })).toBe(
			vacancy.id
		);

		// Matching makes the same pairs: the vacancies of A — counted again since the session opened — with the clones of
		// A and the background, and the original of К-1 only with the vacancies outside sessions.
		await database.db.transaction((tx) =>
			enqueueJob(
				tx,
				'match.refresh',
				{ scope: 'candidate', candidate_id: stepan },
				{ inputVersion: 'demo-sessions-test', createdBy: { kind: 'system' } }
			)
		);
		await drainJobs(database.db, handlers, ['match.refresh'], { since: new Date(0), log, label: 'pairs' });
		const pairs = await database.db
			.select({ vacancyId: matchScores.vacancyId, candidateId: matchScores.candidateId })
			.from(matchScores);
		const ofSessionA = (pair: { vacancyId: string }) => reachOf(companyOfVacancy.get(pair.vacancyId)) === a.sessionId;
		expect(pairs.filter((pair) => ofSessionA(pair) && originalIds.has(pair.candidateId))).toEqual([]);
		expect(pairs.some((pair) => ofSessionA(pair) && clonesA.has(pair.candidateId))).toBe(true);
		expect(pairs.some((pair) => ofSessionA(pair) && !clonesA.has(pair.candidateId))).toBe(true);
		expect(pairs.some((pair) => pair.candidateId === stepan)).toBe(true);

		// An invitation of a company of session A addressed to the original of К-5 (written past the product, which
		// refuses it) is not the original's: absent from its list and «not found» by its id.
		const olegA = await candidateOfUser(await cloneOfRole(database.db, crypto, a.sessionId, role('k5')));
		const olegUser = originals.users.get(role('k5').key)?.id ?? '';
		const oleg = await candidateOfUser(olegUser);
		const invitationA = await openInvitationOf(olegA);
		const olegSubject = await subjectOf(olegUser);
		await database.db.update(invitations).set({ candidateId: oleg }).where(eq(invitations.id, invitationA.id));
		try {
			const listed = await listInvitations(invitationDeps(), olegSubject, 'candidate');
			expect(listed.length).toBeGreaterThan(0);
			expect(listed.map((item) => item.id)).not.toContain(invitationA.id);
			await expect(getInvitation(invitationDeps(), olegSubject, invitationA.id)).rejects.toMatchObject({
				code: 'not_found'
			});
		} finally {
			await database.db.update(invitations).set({ candidateId: olegA }).where(eq(invitations.id, invitationA.id));
		}
		const listedA = await listInvitations(
			invitationDeps(),
			await subjectOf(await cloneOfRole(database.db, crypto, a.sessionId, role('k5'))),
			'candidate'
		);
		expect(listedA.map((item) => item.id)).toContain(invitationA.id);
	});

	it('does not copy into a later session a row that ties an original to a session', { timeout: 300_000 }, async () => {
		// The original К-1 blocks the clone of the main employer of A (a row the product would not make: the original
		// does not see the companies of sessions).
		const recruiterA = await cloneOfRole(database.db, crypto, a.sessionId, role('recruiter@severny-kod.example'));
		const companyA = await companyOf(recruiterA);
		const originals = await castOriginals(database.db, crypto, castRoles(data));
		const stepan = await candidateOfUser(originals.users.get(role('k1').key)?.id ?? '');
		await database.db.insert(candidateCompanyBlocks).values({ candidateId: stepan, companyId: companyA });

		c = await openDemoSession(deps(), data, await demoTerms(database.db), meta);
		const stepanC = await candidateOfUser(await cloneOfRole(database.db, crypto, c.sessionId, role('k1')));
		const inheritedFromA = await database.db
			.select({ companyId: candidateCompanyBlocks.companyId })
			.from(candidateCompanyBlocks)
			.where(and(eq(candidateCompanyBlocks.candidateId, stepanC), eq(candidateCompanyBlocks.companyId, companyA)));
		expect(inheritedFromA).toEqual([]);
		expect(await rowsOf(c.sessionId)).toBe(await rowsOf(b.sessionId));
	});

	it('refuses to remove a session named from outside it, and changes nothing', { timeout: 120_000 }, async () => {
		const originals = await castOriginals(database.db, crypto, castRoles(data));
		const stepan = await candidateOfUser(originals.users.get(role('k1').key)?.id ?? '');
		const adminC = await cloneOfRole(database.db, crypto, c.sessionId, role('admin@fsp-career.example'));
		const before = await rowsOf(c.sessionId);
		await database.db.update(candidates).set({ birthDateVerifiedBy: adminC }).where(eq(candidates.id, stepan));
		try {
			const refusal = purgeDemoSession({ db: database.db, redis, store }, c.sessionId, new Date(), meta.requestId);
			await expect(refusal).rejects.toBeInstanceOf(DemoIsolationLeak);
			await expect(refusal).rejects.toThrow('candidates.birth_date_verified_by');
			expect(await rowsOf(c.sessionId)).toBe(before);
		} finally {
			await database.db.update(candidates).set({ birthDateVerifiedBy: null }).where(eq(candidates.id, stepan));
		}
	});

	it('removes a session with exactly its rows', { timeout: 300_000 }, async () => {
		const rowsB = await rowsOf(b.sessionId);
		const keysA = await database.db
			.select({ key: files.storageKey })
			.from(files)
			.innerJoin(users, eq(users.id, files.ownerUserId))
			.where(eq(users.demoSessionId, a.sessionId));
		const purged = await purgeDemoSession({ db: database.db, redis, store }, a.sessionId, new Date(), meta.requestId);
		expect(purged?.rowsRemoved).toBeGreaterThan(a.rowsCopied);
		expect(purged?.filesRemoved).toBe(keysA.length);
		for (const { key } of keysA) expect(store.objects.has(key)).toBe(false);
		expect(await database.db.select().from(demoSessions).where(eq(demoSessions.id, a.sessionId))).toEqual([]);
		expect(await database.db.select().from(users).where(eq(users.demoSessionId, a.sessionId))).toEqual([]);
		// The other sessions are untouched; with them gone the stand is what the seed made.
		expect(await rowsOf(b.sessionId)).toBe(rowsB);
		expect(
			await purgeDemoSession({ db: database.db, redis, store }, a.sessionId, new Date(), meta.requestId)
		).toBeNull();
		const [journaled] = await database.db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'demo.session_purged'), eq(auditEvents.objectId, a.sessionId)));
		expect(journaled?.details).toMatchObject({ rows_removed: purged?.rowsRemoved, files_removed: keysA.length });
	});

	it(
		'takes a visitor’s own resume only with its consent and removes it with everything derived',
		{
			timeout: 300_000
		},
		async () => {
			const dmitryB = await cloneOfRole(database.db, crypto, b.sessionId, role('k2'));
			const profile = await candidateOfUser(dmitryB);
			const subject = await subjectOf(dmitryB);
			const text =
				'Иван Судейский\n\nОпыт: Python-разработчик, 2019–2024, ООО «Пример».\n\nНавыки: Python, PostgreSQL, Docker.';
			const bytes = () => new TextEncoder().encode(text);

			// Without the consent a clone takes no resume.
			await expect(
				uploadResume(
					{ db: database.db, store, now: () => new Date() },
					subject,
					{ bytes: bytes(), declaredName: 'cv.txt' },
					meta
				)
			).rejects.toMatchObject({ code: 'policy_violation' });

			const document = await currentDocument(database.db, 'demo_resume_upload', new Date());
			if (!document) throw new Error('the consent of the demo resume is not published');
			const uploaded = await uploadOwnResume(
				{ db: database.db, store, now: () => new Date() },
				subject,
				meta,
				{ sessionId: b.sessionId, documentId: document.id, bytes: bytes(), declaredName: 'cv.txt' },
				await demoTerms(database.db)
			);
			const [session] = await database.db.select().from(demoSessions).where(eq(demoSessions.id, b.sessionId));
			expect(session?.ownResumeAt).not.toBeNull();
			expect(session?.expiresAt.getTime()).toBeLessThanOrEqual(uploaded.expiresAt.getTime());
			const [hidden] = await database.db
				.select({ visibility: candidates.visibility })
				.from(candidates)
				.where(eq(candidates.id, profile));
			expect(hidden?.visibility).toBe('hidden');

			await drainJobs(database.db, handlers, ['resume.parse', 'resume.extract', 'evidence.compute', 'match.refresh'], {
				since: new Date(Date.now() - 60_000),
				log,
				label: 'own resume'
			});
			const [ownFile] = await database.db
				.select({ key: files.storageKey })
				.from(resumeDocuments)
				.innerJoin(files, eq(files.id, resumeDocuments.fileId))
				.where(eq(resumeDocuments.id, uploaded.resume.resumeDocumentId));
			if (!ownFile) throw new Error('the own resume has no file');
			expect(store.objects.has(ownFile.key)).toBe(true);
			const facts = await database.db
				.select({ id: sourceFacts.id })
				.from(sourceFacts)
				.where(
					and(
						eq(sourceFacts.candidateId, profile),
						sql`${sourceFacts.sourceRecordRef} like ${`%${uploaded.resume.resumeDocumentId}%`}`
					)
				);
			expect(facts.length).toBeGreaterThan(0);
			// A vector of the profile, as the embedder would write it.
			await database.db.insert(embeddingSpaces).values({
				id: 'demo-test-space',
				modelName: 'test',
				modelRevision: '1',
				dimension: 3,
				queryPrefix: '',
				documentPrefix: '',
				pooling: 'mean',
				normalization: 'l2',
				maxInputTokens: 512,
				chunkingVersion: '1',
				status: 'building'
			});
			await database.db.insert(embeddings).values({
				ownerType: 'candidate_section',
				ownerId: profile,
				section: 'skills',
				inputSha256: 'b'.repeat(64),
				inputVersion: '1',
				spaceId: 'demo-test-space',
				vector: [0.1, 0.2, 0.3]
			});

			// The time of the session is over: B and C go, the stand is what the seed made.
			const later = new Date(Date.now() + 25 * 3_600_000);
			const purged = await purgeExpiredDemoSessions({ db: database.db, redis, store }, later, meta.requestId);
			expect(purged.failed).toEqual([]);
			expect(purged.purged.map((p) => p.sessionId).sort()).toEqual([b.sessionId, c.sessionId].sort());
			expect(store.objects.has(ownFile.key)).toBe(false);
			expect(await database.db.select().from(sourceFacts).where(eq(sourceFacts.candidateId, profile))).toEqual([]);
			expect(await database.db.select().from(embeddings).where(eq(embeddings.ownerId, profile))).toEqual([]);
			const [ledger] = await database.db.select().from(erasureLedger).where(eq(erasureLedger.userId, dmitryB));
			expect(ledger?.purgedAt).not.toBeNull();
			expect(await database.db.select().from(demoSessions)).toEqual([]);
			expect(await census()).toEqual(baseline);
		}
	);

	it('closes shared administrator actions to demo accounts', async () => {
		const originals = await castOriginals(database.db, crypto, castRoles(data));
		const admin = originals.users.get(role('admin@fsp-career.example').key)?.id ?? '';
		expect(await standChangesLocked(database.db, await subjectOf(admin))).toBe(true);
		const person = await createUser(database.db);
		expect(await standChangesLocked(database.db, await subjectOf(person.id))).toBe(false);
		await expect(requireStandChange(database.db, await subjectOf(admin))).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			grantStaffRole(
				{ db: database.db, crypto, now: () => new Date() },
				{ subject: await subjectOf(admin), meta },
				{
					userId: person.id,
					role: 'admin',
					auditRead: false
				}
			)
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('terms of a demo session', () => {
	const MINUTE = 60_000;
	const HOUR = 60 * MINUTE;

	it('outlasts a break of the working day and ends after the idle time', { timeout: 300_000 }, async () => {
		const terms = await demoTerms(database.db);
		const back = await openDemoSession(deps(), data, terms, meta);
		const gone = await openDemoSession(deps(), data, terms, meta);
		const now = new Date();
		const activity = redisDemoActivity(redis);
		// A juror away for lunch and a meeting comes back to the session as they left it; one who left for good does not
		// hold the rows and the place of the stand.
		await activity.touch(back.sessionId, new Date(now.getTime() - 4 * HOUR));
		await activity.touch(gone.sessionId, new Date(now.getTime() - DEMO_IDLE_MINUTES * MINUTE - MINUTE));
		const outcome = await purgeExpiredDemoSessions({ db: database.db, redis, store }, now, meta.requestId);
		expect(outcome.failed).toEqual([]);
		expect(outcome.idle).toEqual([gone.sessionId]);
		expect(outcome.purged.map((p) => p.sessionId)).toEqual([gone.sessionId]);
		expect(await database.db.select({ id: demoSessions.id }).from(demoSessions)).toEqual([{ id: back.sessionId }]);

		expect(await rowsOf(gone.sessionId)).toBe(0);
		expect(await rowsOf(back.sessionId)).toBeGreaterThan(100);
		await purgeDemoSession({ db: database.db, redis, store }, back.sessionId, now, meta.requestId);
	});

	it('lets a jury behind one address open as many sessions a day as the stand holds', () => {
		expect(RATE_LIMIT_RULES.demoSession.windowSeconds).toBe(24 * 3600);
		expect(RATE_LIMIT_RULES.demoSession.limit).toBeGreaterThanOrEqual(MAX_LIVE_SESSIONS);
	});

	it('shows the visitor the earliest end: the idle time, the nightly reset or the end of the session', () => {
		// 10:00 Moscow time: the idle time ends first, the nightly reset at 03:00 Moscow time comes before the day is over.
		const morning = new Date('2026-10-13T07:00:00Z');
		const dayLater = new Date(morning.getTime() + 24 * HOUR);
		expect(idleEndOf(dayLater, morning)).toEqual(new Date(morning.getTime() + DEMO_IDLE_MINUTES * MINUTE));
		expect(lastEndOf(dayLater, morning)).toEqual(new Date('2026-10-14T00:00:00Z'));
		// Late in the evening the reset comes before the idle time is over.
		const evening = new Date('2026-10-13T20:00:00Z');
		expect(idleEndOf(dayLater, evening)).toEqual(new Date('2026-10-14T00:00:00Z'));
		// A session shortened by an own resume ends at its own time when that is earlier.
		const shortened = new Date('2026-10-13T08:00:00Z');
		expect(idleEndOf(shortened, morning)).toEqual(shortened);
		expect(lastEndOf(shortened, morning)).toEqual(shortened);
	});
});

function role(keyOrEmail: string) {
	const roles = castRoles(data);
	const found = roles.find((r) => r.key === `candidate:${keyOrEmail}`) ?? roles.find((r) => r.email === keyOrEmail);
	if (!found) throw new Error(`no role ${keyOrEmail}`);
	return found;
}
