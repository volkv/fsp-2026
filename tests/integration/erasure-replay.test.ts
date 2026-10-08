// The erasure ledger applied again after a restore (docs/domain.md, section 19.2; case 39): a backup is taken, then a
// candidate deletes the account, a staff member whose role was taken away deletes theirs and a demo session is removed.
// The dump restored from before all that brings them back, with a ledger that does not name them; the ledger exported
// from the live database before the restore, replayed into the restored one, erases the candidate again — rows, the
// object restored into the bucket, the request moment of the ledger kept — removes the demo session, and leaves the
// staff account as restored, named with its reason. A second replay changes nothing.
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { Database } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import {
	applications,
	auditEvents,
	blockConfirmations,
	candidates,
	challengeDeliveries,
	challengeSolutions,
	companyChallenges,
	confirmationRequests,
	candidateSurveys,
	consentEvents,
	demoSessions,
	erasureLedger,
	files,
	gradeDeclarations,
	profileExperienceEntries,
	hiringNeeds,
	shortlistMarks,
	shortlists,
	staffRoles,
	testAttempts,
	users
} from '$lib/server/db/schema';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { GRADE_POLICY } from '$lib/server/assessments/contract/policy';
import { PROCEDURE } from '$lib/server/assessments/contract/procedure';
import { ensureAttestations } from '$lib/server/attestations/issue';
import { verifyAttestation } from '$lib/server/attestations/verify';
import { purgeDemoSession } from '$lib/server/demo/purge';
import { purgeAccountNow } from '$lib/server/erasure/purge';
import {
	exportLedger,
	formatLedger,
	parseLedger,
	replayLedger,
	type ReplayDeps
} from '$lib/server/erasure/replay/ledger';
import { beginAccountDeletion } from '$lib/server/erasure/request';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore, StoredObject } from '$lib/server/storage/object-store';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { decide } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { testEnvironment } from '../helpers/environment';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createTaxonomyVersion,
	createUser,
	randomSha256
} from '../helpers/factories';

const REDIS_DATABASE = 13;

const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

/** The bucket: objects by key. */
class MemoryStore implements ObjectStore {
	readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
	put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
		this.objects.set(key, bytes);
		return Promise.resolve();
	}
	get(key: string): Promise<StoredObject | null> {
		if (!this.objects.has(key)) return Promise.resolve(null);
		throw new Error('the replay reads no object');
	}
	delete(key: string): Promise<void> {
		this.objects.delete(key);
		return Promise.resolve();
	}
	exists(key: string): Promise<boolean> {
		return Promise.resolve(this.objects.has(key));
	}
}

let live: TestDatabase;
let restoredName: string;
let restoredClient: postgres.Sql;
let restored: Database;
let redis: Redis;
const store = new MemoryStore();

const people = {
	candidate: '',
	candidateProfile: '',
	resumeKey: '',
	attestation: '',
	bystander: '',
	staff: '',
	clone: '',
	session: '',
	application: ''
};
let exported = '';
let requestedAt: Date;

async function adminSql<T>(work: (admin: postgres.Sql) => Promise<T>): Promise<T> {
	const admin = postgres(inject('databaseUrl'), { max: 1, onnotice: () => undefined });
	try {
		return await work(admin);
	} finally {
		await admin.end({ timeout: 5 });
	}
}

const deps = (db: Database): ReplayDeps => ({ db, redis, store, now: () => new Date() });

beforeAll(async () => {
	live = await createTestDatabase();
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
	Object.assign(env, testEnvironment({ DATABASE_URL: live.url, REDIS_URL: `${inject('redisUrl')}/${REDIS_DATABASE}` }));
	const db = live.db;

	// The live stand before the backup.
	const candidate = await createCandidate(db);
	people.candidate = candidate.userId;
	people.candidateProfile = candidate.id;
	people.resumeKey = `resume/${crypto.randomUUID()}`;
	await db.insert(files).values({
		ownerUserId: candidate.userId,
		purpose: 'resume',
		storageKey: people.resumeKey,
		sha256: randomSha256(),
		sizeBytes: 3,
		declaredName: 'resume.pdf',
		detectedMime: 'application/pdf',
		status: 'ready'
	});
	await store.put(people.resumeKey, new Uint8Array([1, 2, 3]));
	// The survey and the declared grade: append-only rows the replay must erase again.
	const [survey] = await db
		.insert(candidateSurveys)
		.values({
			candidateId: candidate.id,
			version: 1,
			catalogVersion: '2026.10.1',
			taxonomyVersionId: (await createTaxonomyVersion(db)).id,
			direction: 'development',
			specialization: 'backend',
			declaredSkillKeys: ['go'],
			preferences: {}
		})
		.returning({ id: candidateSurveys.id });
	if (!survey) throw new Error('survey not inserted');
	await db.insert(gradeDeclarations).values({
		candidateId: candidate.id,
		surveyId: survey.id,
		specialization: 'backend',
		grade: 'junior',
		hint: { version: 1, suggested: null, bases: [], caveats: [] },
		declaredAt: new Date()
	});
	// The candidate's own profile fields and a confirmation of the category: rows and columns the replay must erase again.
	await db
		.update(candidates)
		.set({ telegramEnc: randomBytes(24), softSkillKeys: ['teamwork'] })
		.where(eq(candidates.id, candidate.id));
	await db.insert(profileExperienceEntries).values({
		candidateId: candidate.id,
		positionTitle: 'Разработчик',
		periodFrom: '2021-01-01',
		isCurrent: true
	});
	await decide(db, candidate.id, { specialization: 'backend', grade: 'junior' });
	const attestations = await db.transaction((tx) =>
		ensureAttestations(
			tx,
			createReceiptSigner({ issuer: 'http://localhost', keyId: 'test-1', seed: randomBytes(32) }),
			{
				candidateId: candidate.id,
				holder: { last: 'Иванова', first: 'Мария', middle: null },
				now: new Date()
			}
		)
	);
	people.attestation = attestations[0]?.handle ?? '';
	// A company's mark with its note about the candidate in a shortlist (domain 23.2): erased again by the replay.
	const company = await createCompany(db);
	const member = await createMember(db, company.id);
	const [need] = await db
		.insert(hiringNeeds)
		.values({
			companyId: company.id,
			createdByMemberId: member.id,
			form: { skill_keys: ['go'], nice_skill_keys: [] },
			textCheck: { result: 'clean', phrases: [] },
			status: 'active'
		})
		.returning({ id: hiringNeeds.id });
	if (!need) throw new Error('need not inserted');
	const [shortlist] = await db
		.insert(shortlists)
		.values({ companyId: company.id, needId: need.id, createdByMemberId: member.id, status: 'open' })
		.returning({ id: shortlists.id });
	if (!shortlist) throw new Error('shortlist not inserted');
	await db.insert(shortlistMarks).values({
		shortlistId: shortlist.id,
		candidateId: candidate.id,
		markedByMemberId: member.id,
		markedAt: new Date(),
		note: 'сильный SQL'
	});
	// A call delivered with the candidate's solution, a request of a confirmation closed by a block result, and an
	// application (domain 23.2): the replay erases them again and leaves the application a tombstone.
	const [challenge] = await db
		.insert(companyChallenges)
		.values({
			companyId: company.id,
			createdByMemberId: member.id,
			title: 'Идемпотентность платежей',
			statement:
				'Сервис принимает платёж и иногда получает один и тот же запрос дважды. Как сделать приём идемпотентным?',
			answerKind: 'approach',
			specialization: 'backend',
			grades: ['junior'],
			salaryMin: 150_000,
			salaryMax: 200_000,
			salaryCurrency: 'RUB',
			salaryPeriod: 'month',
			salaryTaxBase: 'gross',
			goal: 'Найти инженера',
			timeLimitMinutes: 15,
			status: 'active',
			startsAt: new Date(),
			endsAt: new Date(Date.now() + 86_400_000),
			textCheck: { validator_version: 'test', result: 'clean', phrases: [], warnings_confirmed: null, moderation: null }
		})
		.returning({ id: companyChallenges.id });
	if (!challenge) throw new Error('challenge not inserted');
	const [delivery] = await db
		.insert(challengeDeliveries)
		.values({
			challengeId: challenge.id,
			candidateId: candidate.id,
			deliveredAt: new Date(),
			clockAt: new Date(),
			status: 'solved',
			openedAt: new Date()
		})
		.returning({ id: challengeDeliveries.id });
	if (!delivery) throw new Error('delivery not inserted');
	await db
		.insert(challengeSolutions)
		.values({ deliveryId: delivery.id, content: 'ключ идемпотентности', submittedAt: new Date(), status: 'submitted' });
	await db.transaction(async (tx) => {
		const [request] = await tx
			.insert(confirmationRequests)
			.values({
				companyId: company.id,
				requestedByMemberId: member.id,
				candidateId: candidate.id,
				specialization: 'backend',
				block: 'be.api',
				grade: 'junior',
				status: 'accepted',
				answeredAt: new Date(),
				expiresAt: new Date(Date.now() + 86_400_000)
			})
			.returning({ id: confirmationRequests.id });
		if (!request) throw new Error('request not inserted');
		const [attempt] = await tx
			.insert(testAttempts)
			.values({
				candidateId: candidate.id,
				purpose: 'vacancy_block',
				specialization: 'backend',
				grade: 'junior',
				catalogVersion: CATALOG.version,
				bankReleaseId: 'test-release',
				procedureVersion: PROCEDURE.version,
				policyVersion: GRADE_POLICY.version,
				seed: randomBytes(16).toString('hex'),
				status: 'decided',
				startedAt: new Date(),
				deadlineAt: new Date(),
				endedAt: new Date(),
				confirmationRequestId: request.id
			})
			.returning({ id: testAttempts.id });
		if (!attempt) throw new Error('attempt not inserted');
		const [result] = await tx
			.insert(blockConfirmations)
			.values({
				candidateId: candidate.id,
				attemptId: attempt.id,
				specialization: 'backend',
				block: 'be.api',
				grade: 'junior',
				verdict: 'confirmed',
				scoreSum: 60,
				cutSum: 48,
				bankReleaseId: 'test-release',
				status: 'valid',
				visibility: 'requester',
				decidedAt: new Date()
			})
			.returning({ id: blockConfirmations.id });
		if (!result) throw new Error('result not inserted');
		await tx
			.update(confirmationRequests)
			.set({ status: 'completed', confirmationId: result.id })
			.where(eq(confirmationRequests.id, request.id));
	});
	const taxonomy = await createTaxonomyVersion(db);
	const vacancy = await createOwnVacancy(db, {
		companyId: company.id,
		memberId: member.id,
		taxonomyVersionId: taxonomy.id
	});
	const [application] = await db
		.insert(applications)
		.values({
			candidateId: candidate.id,
			companyId: company.id,
			vacancyId: vacancy.id,
			message: 'Работал с платежами',
			match: { score: 0.5 },
			status: 'submitted',
			submittedAt: new Date()
		})
		.returning({ id: applications.id });
	if (!application) throw new Error('application not inserted');
	people.application = application.id;
	people.bystander = (await createCandidate(db)).userId;
	const staff = await createCandidate(db);
	people.staff = staff.userId;
	await db.insert(staffRoles).values({ userId: staff.userId, role: 'operator', grantedAt: new Date() });
	const [session] = await db
		.insert(demoSessions)
		.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-test', expiresAt: new Date(Date.now() + 3_600_000) })
		.returning({ id: demoSessions.id });
	if (!session) throw new Error('demo session not inserted');
	people.session = session.id;
	people.clone = (await createUser(db, { demoSessionId: session.id })).id;

	// The backup: a copy of the live database as it is now.
	await live.sql.end({ timeout: 5 });
	const liveName = new URL(live.url).pathname.slice(1);
	restoredName = `restored_${randomBytes(5).toString('hex')}`;
	await adminSql((admin) => admin.unsafe(`create database ${restoredName} template ${liveName}`));
	const liveClient = postgres(live.url, { max: 4, onnotice: () => undefined });
	const liveDb = drizzle({ client: liveClient, schema, casing: 'snake_case' });

	// After the backup: the candidate deletes the account, the staff member loses the role and deletes theirs, the demo
	// session of a visitor who uploaded a resume of their own is removed and its account enters the ledger.
	requestedAt = new Date(Date.now() - 60_000);
	for (const userId of [people.candidate, people.staff]) {
		if (userId === people.staff) {
			await liveDb
				.update(staffRoles)
				.set({ revokedAt: requestedAt, revokedBy: people.bystander })
				.where(eq(staffRoles.userId, userId));
		}
		const refusal = await liveDb.transaction((tx) =>
			beginAccountDeletion(tx, {
				userId,
				cause: 'account_deleted',
				actor: { kind: 'user', userId },
				requestId: 'replay-test:live',
				at: requestedAt
			})
		);
		expect(refusal).toBeNull();
		await purgeAccountNow(deps(liveDb), userId, 'replay-test:live');
	}
	await purgeDemoSession(deps(liveDb), people.session, new Date(), 'replay-test:live');
	await liveDb.insert(erasureLedger).values({ userId: people.clone, requestedAt, purgedAt: new Date() });
	expect(store.objects.has(people.resumeKey)).toBe(false);

	// Before the restore: the ledger is exported from the live database.
	exported = formatLedger(await exportLedger(liveDb));
	await liveClient.end({ timeout: 5 });

	// The restore: the dump of the backup, and the files of the bucket from its mirror of the same time.
	const restoredUrl = new URL(live.url);
	restoredUrl.pathname = `/${restoredName}`;
	restoredClient = postgres(restoredUrl.toString(), { max: 4, onnotice: () => undefined });
	restored = drizzle({ client: restoredClient, schema, casing: 'snake_case' });
	await store.put(people.resumeKey, new Uint8Array([1, 2, 3]));
});

afterAll(async () => {
	await restoredClient.end({ timeout: 5 });
	await adminSql(async (admin) => {
		await admin.unsafe(`drop database if exists ${restoredName} with (force)`);
		await admin.unsafe(`drop database if exists ${new URL(live.url).pathname.slice(1)} with (force)`);
	});
	await redis.quit();
});

const statusOf = async (userId: string) =>
	(await restored.select({ status: users.status }).from(users).where(eq(users.id, userId)))[0]?.status;

describe('the erasure ledger after a restore', () => {
	it('exports one line per entry that reads back as the same entries', () => {
		const entries = parseLedger(exported);
		expect(entries.map((entry) => entry.userId).sort()).toEqual([people.candidate, people.staff, people.clone].sort());
		expect(formatLedger(entries)).toBe(exported);
		expect(() => parseLedger(`${exported}{"user_id":"x"}\n`)).toThrow(/line 4 of the ledger is not an entry/);
	});

	it('brings the deleted people back, and a replay erases them again except the one it must not touch', async () => {
		// The restore brought everything back and the ledger does not name them.
		expect(await statusOf(people.candidate)).toBe('active');
		expect(await statusOf(people.staff)).toBe('active');
		expect(await statusOf(people.clone)).toBe('active');
		expect(await restored.select().from(erasureLedger)).toEqual([]);
		expect(
			await restored.select().from(gradeDeclarations).where(eq(gradeDeclarations.candidateId, people.candidateProfile))
		).toHaveLength(1);

		const summary = await replayLedger(deps(restored), parseLedger(exported), 'replay-test:restore');

		expect(summary.outcomes).toEqual({ deleted_again: 1, purged: 0, demo_session_removed: 1, already_erased: 0 });
		expect(summary.refused).toEqual([{ userId: people.staff, reason: 'staff_role' }]);

		// The candidate: a tombstone again, the profile too, the resume gone from the rows and from the bucket.
		const [account] = await restored.select().from(users).where(eq(users.id, people.candidate));
		expect(account).toMatchObject({ status: 'deleted', emailEnc: null, emailHmac: null });
		const [profile] = await restored.select().from(candidates).where(eq(candidates.id, people.candidateProfile));
		expect(profile).toMatchObject({ status: 'deleted', birthDate: null, visibility: 'hidden' });
		expect(await restored.select().from(files).where(eq(files.ownerUserId, people.candidate))).toEqual([]);
		expect(store.objects.has(people.resumeKey)).toBe(false);
		expect(
			await restored.select().from(consentEvents).where(eq(consentEvents.subjectCandidateId, people.candidateProfile))
		).toEqual([]);
		expect(
			await restored.select().from(candidateSurveys).where(eq(candidateSurveys.candidateId, people.candidateProfile))
		).toEqual([]);
		expect(
			await restored.select().from(gradeDeclarations).where(eq(gradeDeclarations.candidateId, people.candidateProfile))
		).toEqual([]);
		expect(profile).toMatchObject({ telegramEnc: null, softSkillKeys: [] });
		expect(
			await restored
				.select()
				.from(profileExperienceEntries)
				.where(eq(profileExperienceEntries.candidateId, people.candidateProfile))
		).toEqual([]);
		expect(people.attestation).not.toBe('');
		expect(await verifyAttestation(restored, people.attestation)).toBeNull();
		expect(
			await restored.select().from(shortlistMarks).where(eq(shortlistMarks.candidateId, people.candidateProfile))
		).toEqual([]);
		for (const table of [challengeDeliveries, confirmationRequests, blockConfirmations] as const) {
			expect(await restored.select().from(table).where(eq(table.candidateId, people.candidateProfile))).toEqual([]);
		}
		expect(await restored.select().from(challengeSolutions)).toEqual([]);
		const [application] = await restored.select().from(applications).where(eq(applications.id, people.application));
		expect(application).toMatchObject({ status: 'withdrawn', message: null, match: null });
		expect(application?.purgedAt).not.toBeNull();
		// The deletion began again as the system's act, not the person's.
		const requested = await restored
			.select({ actorKind: auditEvents.actorKind, cause: sql<string>`${auditEvents.details} ->> 'cause'` })
			.from(auditEvents)
			.where(eq(auditEvents.action, 'account.deletion_requested'));
		expect(requested).toEqual([{ actorKind: 'system', cause: 'ledger_replay' }]);
		const consent = await restored
			.select({ action: auditEvents.action, actorKind: auditEvents.actorKind })
			.from(auditEvents)
			.where(eq(auditEvents.subjectCandidateId, people.candidateProfile));
		expect(consent).toContainEqual({ action: 'consent.lapsed', actorKind: 'system' });
		expect(consent.map((event) => event.action)).not.toContain('consent.revoked');
		// The ledger names the candidate with the moment of the request, and the purge of the replay.
		const [entry] = await restored.select().from(erasureLedger).where(eq(erasureLedger.userId, people.candidate));
		expect(entry?.requestedAt.getTime()).toBe(requestedAt.getTime());
		expect(entry?.purgedAt).not.toBeNull();

		// The demo session went with its clone.
		expect(await restored.select().from(demoSessions).where(eq(demoSessions.id, people.session))).toEqual([]);
		expect(await statusOf(people.clone)).toBeUndefined();

		// The staff account is left as restored, with its role, for the operator to decide.
		expect(await statusOf(people.staff)).toBe('active');
		expect(await restored.select().from(erasureLedger).where(eq(erasureLedger.userId, people.staff))).toEqual([]);

		// The bystander is untouched.
		expect(await statusOf(people.bystander)).toBe('active');
	});

	it('changes nothing on a second replay of the same export', async () => {
		const journal = async () => (await restored.select({ id: auditEvents.id }).from(auditEvents)).length;
		const before = await journal();
		const summary = await replayLedger(deps(restored), parseLedger(exported), 'replay-test:again');
		expect(summary.outcomes).toEqual({ deleted_again: 0, purged: 0, demo_session_removed: 0, already_erased: 2 });
		expect(summary.refused).toEqual([{ userId: people.staff, reason: 'staff_role' }]);
		expect(await journal()).toBe(before);
	});
});
