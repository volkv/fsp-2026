// Isolation of demo sessions in what the FSP operator works and in the link with an FSP athlete (docs/domain.md,
// section 19.3). The world is written straight into the tables: two demo sessions, the stand outside them and the
// originals of the scenario cast (outside sessions too), each with an operator, a company waiting for verification, an
// objection, a representation waiting for the check and a claim of an external vacancy. An operator of a session works
// the cases of that session only — never of the stand, the originals or another session; the operator of the stand
// works the stand and the originals, and a case out of reach is «not found» however it is asked for. A clone of
// an athlete holds an active link with the athlete within its session, while outside sessions the athlete still has one
// active account.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { confirmFspAchievements } from '$lib/server/auth/identities';
import { loadSelfEvidence } from '$lib/server/candidates/profile';
import type { ObjectionDecisions } from '$lib/server/categories/objections';
import type { CompanyDeps } from '$lib/server/companies/context';
import { registryNotConfigured } from '$lib/server/companies/registry';
import { verificationCase, verificationQueue } from '$lib/server/companies/verification';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	athleteLinks,
	assessmentObjections,
	companyVerifications,
	consentEvents,
	demoSessions,
	externalIdentities,
	legalRepresentatives,
	representations,
	vacancyClaims
} from '$lib/server/db/schema';
import { claimQueue } from '$lib/server/operator/claims';
import { companyDirectory, moderationCard } from '$lib/server/operator/companies';
import { objectionCase, objectionQueueView } from '$lib/server/operator/objections';
import { operatorOverview } from '$lib/server/operator/overview';
import { representationCase, representationQueue } from '$lib/server/operator/representatives';
import type { Redis } from '$lib/server/redis';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createExternalVacancy,
	createMember,
	createPublishedDocument,
	createTaxonomyVersion,
	createUser,
	randomSha256
} from '../helpers/factories';

const DAY = 86_400_000;
const REDIS_DATABASE = 10;
const meta = { requestId: 'demo-isolation-test', ip: null, userAgent: 'test' };

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 3)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 4)
});

let database: TestDatabase;
let redis: Redis;
let taxonomyVersionId: string;

/** Decisions of the test engine the objections refer to: the id of a decision → its candidate. */
const decided = new Map<string, string>();
const decisions: ObjectionDecisions = {
	decisionsOf: () => Promise.reject(new Error('not used')),
	find: (_, id) => {
		const candidateId = decided.get(id);
		return Promise.resolve(
			candidateId === undefined
				? null
				: {
						id,
						candidateId,
						attemptId: id,
						specialization: 'backend',
						grade: 'middle',
						outcome: 'confirmed',
						status: 'valid',
						decidedAt: new Date(),
						artifactsKeptUntil: new Date(Date.now() + 90 * DAY)
					}
		);
	},
	annul: () => Promise.reject(new Error('not used')),
	rescore: () => Promise.reject(new Error('not used'))
};

/** What each place of the stand holds: a demo session, or the stand outside sessions (`session: null`), the originals of
 * the cast among it. */
interface Place {
	session: string | null;
	operator: AccessSubject;
	submittedCompanyId: string;
	verifiedCompanyId: string;
	objectionId: string;
	representationId: string;
	claimId: string;
}

let stand: Place;
let cast: Place;
let first: Place;
let second: Place;

function operatorSubject(userId: string): AccessSubject {
	return {
		userId,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: true, admin: false, extraPermissions: [] }
	};
}

function companyDeps(): CompanyDeps {
	return {
		db: database.db,
		crypto,
		mailer: { send: () => Promise.resolve({ ok: true, value: { messageId: randomUUID() } }) },
		registry: registryNotConfigured,
		appOrigin: 'http://app.test',
		now: () => new Date()
	};
}

async function demoSession(): Promise<string> {
	const [row] = await database.db
		.insert(demoSessions)
		.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + DAY) })
		.returning();
	if (!row) throw new Error('demo session not inserted');
	return row.id;
}

/** A profile with its account, both in the session when one is given. */
async function profile(session: string | null, birthDate = '1998-05-10', demoOriginal = false) {
	const user = await createUser(database.db, { demoSessionId: session });
	return createCandidate(database.db, { userId: user.id, demoSessionId: session, birthDate, demoOriginal });
}

async function place(session: string | null, demoOriginal = false): Promise<Place> {
	const { db } = database;
	const operator = operatorSubject((await createUser(db, { demoSessionId: session })).id);
	const member = async (companyId: string) =>
		createMember(db, companyId, { userId: (await createUser(db, { demoSessionId: session })).id });

	const submitted = await createCompany(db, { status: 'submitted', demoSessionId: session, demoOriginal });
	const applicant = await member(submitted.id);
	await db
		.insert(companyVerifications)
		.values({ companyId: submitted.id, applicantMemberId: applicant.id, authorityMethod: 'director_self' });
	const verified = await createCompany(db, { demoSessionId: session, demoOriginal });
	const recruiter = await member(verified.id);
	if (!recruiter.userId) throw new Error('member without user');

	const objecting = await profile(session, undefined, demoOriginal);
	const decisionId = randomUUID();
	decided.set(decisionId, objecting.id);
	const openedAt = new Date();
	const [objection] = await db
		.insert(assessmentObjections)
		.values({
			candidateId: objecting.id,
			decisionId,
			reason: 'Не согласен с оценкой задания',
			openedAt,
			dueAt: new Date(openedAt.getTime() + 30 * DAY),
			status: 'open'
		})
		.returning();
	if (!objection) throw new Error('objection not inserted');

	const minor = await profile(session, `${new Date().getUTCFullYear() - 16}-03-01`, demoOriginal);
	const [representative] = await db
		.insert(legalRepresentatives)
		.values({
			fullNameEnc: crypto.encrypt('Мария Петрова', 'legal_representatives.full_name'),
			emailEnc: crypto.encrypt('parent@example.org', 'legal_representatives.email'),
			emailHmac: crypto.lookupHmac('email', `parent-${randomUUID()}@example.org`)
		})
		.returning();
	if (!representative) throw new Error('representative not inserted');
	const [representation] = await db
		.insert(representations)
		.values({
			candidateId: minor.id,
			representativeId: representative.id,
			relation: 'parent',
			status: 'contact_confirmed',
			invitedAt: new Date(),
			contactConfirmedAt: new Date()
		})
		.returning();
	if (!representation) throw new Error('representation not inserted');

	const external = await createExternalVacancy(db, taxonomyVersionId);
	const [claim] = await db
		.insert(vacancyClaims)
		.values({
			vacancyId: external.id,
			companyId: verified.id,
			requestedByUserId: recruiter.userId,
			status: 'pending_review',
			matchEvidence: { inn: 'unknown', posting_inns: [], name_similarity: 0.5 }
		})
		.returning();
	if (!claim) throw new Error('claim not inserted');

	return {
		session,
		operator,
		submittedCompanyId: submitted.id,
		verifiedCompanyId: verified.id,
		objectionId: objection.id,
		representationId: representation.id,
		claimId: claim.id
	};
}

beforeAll(async () => {
	database = await createTestDatabase();
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
	const { db } = database;
	taxonomyVersionId = (await createTaxonomyVersion(db)).id;
	stand = await place(null);
	cast = await place(null, true);
	first = await place(await demoSession());
	second = await place(await demoSession());
});

afterAll(async () => {
	redis.destroy();
	await database.drop();
});

const sorted = (values: readonly string[]) => [...values].sort();

describe('operator cases across demo sessions', () => {
	it('counts on the first screen the cases of the own session only, and the stand its own with the originals', async () => {
		const counts = async (who: Place) => {
			const overview = await operatorOverview(database.db, who.operator, new Date());
			return [
				overview.companies.open,
				overview.objections.open,
				overview.representatives.awaiting,
				overview.claims.pending
			];
		};
		expect(await counts(stand)).toEqual([2, 2, 2, 2]);
		expect(await counts(first)).toEqual([1, 1, 1, 1]);
		expect(await counts(second)).toEqual([1, 1, 1, 1]);
		expect(await counts(cast)).toEqual([2, 2, 2, 2]);
	});

	it('lists the companies and the verification requests of the own session only', async () => {
		const companies = (...places: Place[]) =>
			sorted(places.flatMap((p) => [p.submittedCompanyId, p.verifiedCompanyId]));
		const directory = async (who: Place) => {
			const found = await companyDirectory(database.db, who.operator, { status: null, q: '' });
			return { ids: sorted(found.items.map((item) => item.id)), counts: found.counts };
		};
		expect(await directory(stand)).toMatchObject({
			ids: companies(stand, cast),
			counts: { submitted: 2, verified: 2 }
		});
		expect(await directory(first)).toMatchObject({
			ids: companies(first),
			counts: { submitted: 1, verified: 1 }
		});

		const requests = async (who: Place) =>
			sorted(
				(await verificationQueue(companyDeps(), { subject: who.operator, meta })).items.map((item) => item.companyId)
			);
		expect(await requests(stand)).toEqual(sorted([stand.submittedCompanyId, cast.submittedCompanyId]));
		expect(await requests(second)).toEqual([second.submittedCompanyId]);

		await expect(moderationCard(database.db, second.operator, first.verifiedCompanyId)).rejects.toMatchObject({
			code: 'not_found'
		});
		await expect(moderationCard(database.db, stand.operator, first.verifiedCompanyId)).rejects.toMatchObject({
			code: 'not_found'
		});
		await expect(moderationCard(database.db, first.operator, stand.verifiedCompanyId)).rejects.toMatchObject({
			code: 'not_found'
		});
		expect((await moderationCard(database.db, first.operator, first.verifiedCompanyId)).id).toBe(
			first.verifiedCompanyId
		);
		await expect(moderationCard(database.db, first.operator, cast.verifiedCompanyId)).rejects.toMatchObject({
			code: 'not_found'
		});
		expect((await moderationCard(database.db, stand.operator, cast.verifiedCompanyId)).id).toBe(cast.verifiedCompanyId);
		const [request] = await database.db
			.select({ id: companyVerifications.id })
			.from(companyVerifications)
			.where(eq(companyVerifications.companyId, first.submittedCompanyId));
		await expect(
			verificationCase(companyDeps(), { subject: second.operator, meta }, request?.id ?? '')
		).rejects.toMatchObject({ code: 'not_found' });
		const [original] = await database.db
			.select({ id: companyVerifications.id })
			.from(companyVerifications)
			.where(eq(companyVerifications.companyId, cast.submittedCompanyId));
		await expect(
			verificationCase(companyDeps(), { subject: first.operator, meta }, original?.id ?? '')
		).rejects.toMatchObject({ code: 'not_found' });
		expect(
			(await verificationCase(companyDeps(), { subject: stand.operator, meta }, original?.id ?? '')).company.id
		).toBe(cast.submittedCompanyId);
	});

	it('queues the objections and the representations of the own session only', async () => {
		const objections = async (who: Place) =>
			sorted((await objectionQueueView(database.db, who.operator, new Date())).items.map((item) => item.id));
		expect(await objections(stand)).toEqual(sorted([stand.objectionId, cast.objectionId]));
		expect(await objections(first)).toEqual([first.objectionId]);
		const open = (who: Place, objectionId: string) =>
			objectionCase(database.db, decisions, who.operator, meta, objectionId, new Date());
		await expect(open(first, stand.objectionId)).rejects.toMatchObject({ code: 'not_found' });
		await expect(open(second, first.objectionId)).rejects.toMatchObject({ code: 'not_found' });
		expect((await open(first, first.objectionId)).candidate).not.toBeNull();
		await expect(open(first, cast.objectionId)).rejects.toMatchObject({ code: 'not_found' });

		const awaiting = async (who: Place) =>
			sorted((await representationQueue(database.db, who.operator, new Date())).map((item) => item.id));
		expect(await awaiting(stand)).toEqual(sorted([stand.representationId, cast.representationId]));
		expect(await awaiting(second)).toEqual([second.representationId]);
		await expect(
			representationCase(database.db, crypto, second.operator, meta, stand.representationId, new Date())
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			representationCase(database.db, crypto, stand.operator, meta, first.representationId, new Date())
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			representationCase(database.db, crypto, first.operator, meta, cast.representationId, new Date())
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('queues the claims of the companies of the own session only', async () => {
		const claims = async (who: Place) =>
			sorted((await claimQueue(database.db, who.operator)).items.map((item) => item.id));
		expect(await claims(stand)).toEqual(sorted([stand.claimId, cast.claimId]));
		expect(await claims(first)).toEqual([first.claimId]);
		expect(await claims(second)).toEqual([second.claimId]);
	});
});

describe('the link with an FSP athlete', () => {
	const ATHLETE = 'athlete-demo-isolation';

	/**
	 * An account with its FSP ID `subject` at `issuer` and, when `active`, an active link with the athlete. Within a
	 * session the identity carries the session, as a clone's identity keeps the subject of the original.
	 */
	async function athleteAccount(session: string | null, issuer: string, subject: string, active: boolean) {
		const { db } = database;
		const person = await profile(session);
		const [identity] = await db
			.insert(externalIdentities)
			.values({
				userId: person.userId,
				issuer,
				subject,
				linkedAt: new Date(),
				linkMethod: 'linked_by_user',
				demoSessionId: session
			})
			.returning();
		if (!identity) throw new Error('identity not inserted');
		if (active) {
			await db.insert(athleteLinks).values({
				userId: person.userId,
				source: 'fsp',
				sourceAthleteId: ATHLETE,
				basisIdentityId: identity.id,
				resolutionMethod: 'subject_equals_athlete_id',
				status: 'active',
				linkedAt: new Date(),
				demoSessionId: session
			});
		}
		return person;
	}

	const candidateSubject = (person: { id: string; userId: string }): AccessSubject => ({
		userId: person.userId,
		via: 'session',
		candidate: { id: person.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	});

	it('is active for the clones of every session while the athlete has one active account outside them', async () => {
		const { db } = database;
		const issuer = 'https://sso.fsp.test/realms/fsp';
		await athleteAccount(null, issuer, ATHLETE, true);
		for (const session of [first.session, second.session]) {
			const clone = await athleteAccount(session, issuer, ATHLETE, true);
			expect((await loadSelfEvidence(db, candidateSubject(clone), new Date())).fspLinked).toBe(true);
		}

		// A second real account of the same athlete (its FSP ID at another issuer) is refused, and the database refuses
		// a second active link outside sessions whoever writes it.
		const other = await athleteAccount(null, 'https://other.fsp.test/realms/fsp', ATHLETE, false);
		const document = await createPublishedDocument(db, 'fsp_import');
		await db.insert(consentEvents).values({
			subjectCandidateId: other.id,
			kind: 'pd_processing',
			documentId: (await createPublishedDocument(db, 'pd_processing')).id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: other.userId,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date()
		});
		const refused = await confirmFspAchievements(
			{
				db,
				redis,
				crypto,
				mailer: { send: () => Promise.resolve({ ok: true, value: { messageId: randomUUID() } }) },
				appOrigin: 'http://app.test',
				now: () => new Date()
			},
			meta,
			{ hash: 'a'.repeat(64), userId: other.userId, authTime: new Date() },
			{ issuer: 'https://other.fsp.test/realms/fsp', documentId: document.id }
		);
		expect(refused).toEqual({ ok: false, reason: 'athlete_taken' });
		await expect(athleteAccount(null, 'https://third.fsp.test/realms/fsp', ATHLETE, true)).rejects.toThrow();
		// Within one session the athlete has one active account too, whichever FSP ID the second account signed in with.
		await expect(athleteAccount(first.session, issuer, `${ATHLETE}-again`, true)).rejects.toThrow();
	});
});
