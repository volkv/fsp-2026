// The demo actor (docs/domain.md, section 19.3): a clone of a demo session acting as the FSP operator or the
// administrator reaches the rows of its own session only, and no demo account takes an action that changes what every
// visitor of the stand shares. The world is written straight into the tables: two demo sessions and the stand outside
// them, each with a company waiting for verification (with the copy of its authority document), a verified company, an
// objection, a representation of a minor (with the copy of the authority document) and events in the journal. Every
// dangerous action is tried by the clone over the rows of its session, of another session and outside sessions. Around it: FSP ID never signs in to an account of the demo seed or a clone, a clone signs in no
// longer than its demo session lives, and the demo screen gives a new session to an address within its budget, takes
// the place of the quietest session when the stand is full and lets a browser switch roles for free.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq, gt, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { publishPolicies, readPolicyRelease } from '../../scripts/seed-policies';
import { DEMO_LOCK_MESSAGE, requireStandChange, standChangesLocked } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { readJournal } from '$lib/server/admin/audit';
import { findUser, grantStaffRole, setOperatorAuditRead, staffList } from '$lib/server/admin/staff';
import { annulAttempt } from '$lib/server/assessments/annul';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { recordAuditEvent } from '$lib/server/audit/record';
import { authenticateSession } from '$lib/server/auth/authenticate';
import type { AuthDeps } from '$lib/server/auth/context';
import { completeFspSignIn } from '$lib/server/auth/identities';
import { loginWithPassword } from '$lib/server/auth/login';
import { hashPassword } from '$lib/server/auth/password';
import type { FspIdAuthorization } from '$lib/server/auth/oidc';
import { createSession } from '$lib/server/auth/sessions';
import type { CompanyDeps } from '$lib/server/companies/context';
import { endPartnership } from '$lib/server/companies/partnerships';
import { registryNotConfigured } from '$lib/server/companies/registry';
import { decideVerification, suspendCompany } from '$lib/server/companies/verification';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	authorityChecks,
	candidates,
	assessmentObjections,
	companyVerifications,
	competitionPartnerships,
	demoSessions,
	externalIdentities,
	files,
	legalRepresentatives,
	passwordCredentials,
	representations,
	staffRoles,
	testAttempts,
	users
} from '$lib/server/db/schema';
import { DEMO_EVICTABLE_MINUTES, DEMO_IDLE_MINUTES, redisDemoActivity } from '$lib/server/demo/activity';
import { castRoles } from '$lib/server/demo/cast';
import { MAX_LIVE_SESSIONS } from '$lib/server/demo/clone';
import { readSeedData, type SeedData } from '$lib/server/demo/data';
import { purgeExpiredDemoSessions } from '$lib/server/demo/purge';
import { enterDemoRole, type DemoEntry } from '$lib/server/demo/visit';
import { batchHistory, importBatch, previewBatch, type BatchDeps } from '$lib/server/fsp/import/batches';
import { RATE_LIMIT_RULES } from '$lib/server/http/rate-limit';
import { resolveAgeConflict } from '$lib/server/operator/ages';
import { takeObjection } from '$lib/server/operator/objections';
import { openPartnershipFromForm } from '$lib/server/operator/partnership-forms';
import { decideAuthority } from '$lib/server/operator/representatives';
import type { Redis } from '$lib/server/redis';
import { openFile, type FileAccessContext } from '$lib/server/storage/access';
import type { ObjectStore, StoredObject } from '$lib/server/storage/object-store';
import { insertAttempt, releaseFixtureBank } from '../helpers/bank';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { recordDecision } from '../helpers/categories';
import { createCandidate, createCompany, createMember, createUser, randomSha256 } from '../helpers/factories';

const ROOT = new URL('../../', import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, ROOT));
const DAY = 86_400_000;
const MINUTE = 60_000;
const REDIS_DATABASE = 11;
const SEED_BATCH = 'demo-actor-batch';
const meta = { requestId: 'demo-actor-test', ip: null, userAgent: 'test' };

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 5)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 6)
});

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

let database: TestDatabase;
let redis: Redis;
let data: SeedData;
const store = new MemoryStore();
let bankReleaseId: string;

/** What one place of the stand holds: a demo session, or the stand outside sessions (`session: null`). */
interface Place {
	session: string | null;
	operator: AccessSubject;
	admin: AccessSubject;
	verificationId: string;
	verificationFileId: string;
	verifiedCompanyId: string;
	objectionId: string;
	representationId: string;
	authorityFileId: string;
	/** An event of the journal done by an account of the place. */
	eventUserId: string;
	/** A submitted attempt of the place's candidate, waiting for the operator's decision. */
	attemptId: string;
	/** A candidate of the place closed by a conflict of the birth date. */
	ageConflictCandidateId: string;
}

let first: Place;
let second: Place;
let stand: Place;

function staffSubject(userId: string, role: 'operator' | 'admin'): AccessSubject {
	return {
		userId,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: role === 'operator', admin: role === 'admin', extraPermissions: [] }
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

const fileDeps = () => ({ db: database.db, store, now: () => new Date() });
const staffDeps = () => ({ db: database.db, crypto, now: () => new Date() });

async function demoSession(expiresAt = new Date(Date.now() + DAY), createdAt = new Date()): Promise<string> {
	const [row] = await database.db
		.insert(demoSessions)
		.values({ joinTokenSha256: randomSha256(), seedBatchId: SEED_BATCH, expiresAt, createdAt })
		.returning();
	if (!row) throw new Error('demo session not inserted');
	return row.id;
}

/** A stored file of the owner with its object in the store. */
async function storedFile(ownerUserId: string, purpose: (typeof files.$inferInsert)['purpose']): Promise<string> {
	const id = randomUUID();
	const bytes = randomBytes(64);
	const storageKey = `test/${id}`;
	await store.put(storageKey, bytes, 'application/pdf');
	await database.db.insert(files).values({
		id,
		ownerUserId,
		purpose,
		storageKey,
		sha256: randomSha256(),
		sizeBytes: bytes.byteLength,
		declaredName: 'document.pdf',
		detectedMime: 'application/pdf',
		status: 'ready'
	});
	return id;
}

async function place(session: string | null): Promise<Place> {
	const { db } = database;
	const account = async () => {
		const email = `person-${randomUUID()}@example.org`;
		const user = await createUser(db, {
			demoSessionId: session,
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email)
		});
		return user.id;
	};
	const operatorId = await account();
	const adminId = await account();
	await db.insert(staffRoles).values([
		{ userId: operatorId, role: 'operator', grantedAt: new Date() },
		{ userId: adminId, role: 'admin', grantedAt: new Date() }
	]);

	const submitted = await createCompany(db, { status: 'submitted', demoSessionId: session });
	const applicant = await createMember(db, submitted.id, { userId: await account() });
	if (!applicant.userId) throw new Error('member without user');
	const verificationFileId = await storedFile(applicant.userId, 'company_authority_evidence');
	const [verification] = await db
		.insert(companyVerifications)
		.values({
			companyId: submitted.id,
			applicantMemberId: applicant.id,
			authorityMethod: 'power_of_attorney',
			authorityEvidenceFileId: verificationFileId
		})
		.returning();
	if (!verification) throw new Error('verification not inserted');
	const verified = await createCompany(db, { demoSessionId: session });
	const recruiter = await createMember(db, verified.id, { userId: await account() });
	if (!recruiter.userId) throw new Error('member without user');

	const objecting = await createCandidate(db, { userId: await account(), demoSessionId: session });
	const openedAt = new Date();
	const [objection] = await db
		.insert(assessmentObjections)
		.values({
			candidateId: objecting.id,
			decisionId: (
				await recordDecision(db, objecting.id, { specialization: 'backend', grade: 'junior', outcome: 'not_confirmed' })
			).id,
			reason: 'Не согласен с оценкой задания',
			openedAt,
			dueAt: new Date(openedAt.getTime() + 30 * DAY),
			status: 'open'
		})
		.returning();
	if (!objection) throw new Error('objection not inserted');

	const minor = await createCandidate(db, {
		userId: await account(),
		demoSessionId: session,
		birthDate: `${new Date().getUTCFullYear() - 16}-03-01`
	});
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
	const authorityFileId = await storedFile(minor.userId, 'authority_evidence');
	await db.insert(authorityChecks).values({
		representationId: representation.id,
		method: 'document_upload',
		basisKind: 'birth_certificate',
		evidenceFileId: authorityFileId,
		evidenceRetentionUntil: new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10),
		checkedBy: operatorId,
		checkedAt: new Date(),
		result: 'rejected',
		note: 'Копия неразборчива'
	});

	const submittedCandidate = await createCandidate(db, { userId: await account(), demoSessionId: session });
	const attempt = await insertAttempt(db, {
		candidateId: submittedCandidate.id,
		releaseId: bankReleaseId,
		status: 'expired'
	});

	const ageConflictCandidate = await createCandidate(db, {
		userId: await account(),
		demoSessionId: session,
		birthDate: '2000-03-15',
		birthDateStatus: 'conflict'
	});

	return {
		session,
		operator: staffSubject(operatorId, 'operator'),
		admin: staffSubject(adminId, 'admin'),
		verificationId: verification.id,
		verificationFileId,
		verifiedCompanyId: verified.id,
		objectionId: objection.id,
		representationId: representation.id,
		authorityFileId,
		attemptId: attempt.id,
		ageConflictCandidateId: ageConflictCandidate.id,
		eventUserId: recruiter.userId
	};
}

/** The originals of the scenario cast: one account per role of `seeds/demo.json`, nothing else. */
async function seedCast(): Promise<Map<string, string>> {
	const accounts = new Map<string, string>();
	for (const role of castRoles(data)) {
		const user = await createUser(database.db, {
			emailEnc: crypto.encrypt(role.email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', role.email),
			displayName: role.part,
			seedBatchId: SEED_BATCH
		});
		accounts.set(role.key, user.id);
	}
	return accounts;
}

let cast: Map<string, string>;

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishPolicies(client, await readPolicyRelease(path('policies')));
	} finally {
		await client.end({ timeout: 5 });
	}
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
	await redis.flushDb();
	data = await readSeedData(path('seeds'));
	const { db } = database;
	bankReleaseId = (await releaseFixtureBank(db, 'backend')).releaseId;
	first = await place(await demoSession());
	second = await place(await demoSession());
	stand = await place(null);
	cast = await seedCast();
}, 60_000);

afterAll(async () => {
	redis.destroy();
	await database.drop();
});

const others = () => [second, stand];

describe('a clone of the FSP operator', () => {
	it('decides the company verification of its own session only', async () => {
		for (const other of others()) {
			await expect(
				decideVerification(companyDeps(), { subject: first.operator, meta }, other.verificationId, {
					kind: 'approve'
				})
			).rejects.toMatchObject({ code: 'not_found' });
		}
		await decideVerification(companyDeps(), { subject: first.operator, meta }, first.verificationId, {
			kind: 'approve'
		});
		const decided = await database.db
			.select({ id: companyVerifications.id, decision: companyVerifications.decision })
			.from(companyVerifications)
			.where(
				inArray(
					companyVerifications.id,
					[first, second, stand].map((p) => p.verificationId)
				)
			);
		expect(Object.fromEntries(decided.map((row) => [row.id, row.decision]))).toEqual({
			[first.verificationId]: 'approved',
			[second.verificationId]: null,
			[stand.verificationId]: null
		});
	});

	it('suspends the companies of its own session only', async () => {
		for (const other of others()) {
			await expect(
				suspendCompany(companyDeps(), { subject: first.operator, meta }, other.verifiedCompanyId, {
					reasonCode: 'complaint'
				})
			).rejects.toMatchObject({ code: 'not_found' });
		}
		await suspendCompany(companyDeps(), { subject: first.operator, meta }, first.verifiedCompanyId, {
			reasonCode: 'complaint'
		});
	});

	it('takes the objections of its own session only', async () => {
		for (const other of others()) {
			await expect(takeObjection(database.db, first.operator, meta, other.objectionId)).rejects.toMatchObject({
				code: 'not_found'
			});
		}
		await takeObjection(database.db, first.operator, meta, first.objectionId);
		const [taken] = await database.db
			.select({ assignee: assessmentObjections.assigneeId })
			.from(assessmentObjections)
			.where(eq(assessmentObjections.id, first.objectionId));
		expect(taken?.assignee).toBe(first.operator.userId);
	});

	it('checks the authority of the representatives of its own session only', async () => {
		const decision = {
			result: 'rejected' as const,
			method: 'document_presented' as const,
			basisKind: 'birth_certificate' as const,
			basisNote: 'Сверено свидетельство о рождении',
			note: 'Имя в документе не совпадает'
		};
		for (const other of others()) {
			await expect(
				decideAuthority(database.db, first.operator, meta, other.representationId, decision, new Date())
			).rejects.toMatchObject({ code: 'not_found' });
		}
		await decideAuthority(database.db, first.operator, meta, first.representationId, decision, new Date());
	});

	it('opens and ends partnerships of the companies of its own session only', async () => {
		const form = (companyId: string) => {
			const posted = new FormData();
			posted.set('companyId', companyId);
			posted.set('kind', 'sponsor');
			posted.set('minAward', 'finalist');
			posted.append('stages', 'final');
			posted.set('competitionRef', 'competition-1');
			posted.set('validFrom', '2026-09-01');
			posted.set('basis', 'Договор № 1');
			return posted;
		};
		const verified = await createCompany(database.db, { demoSessionId: first.session });
		for (const other of others()) {
			await expect(
				openPartnershipFromForm(companyDeps(), { subject: first.operator, meta }, form(other.verifiedCompanyId))
			).rejects.toMatchObject({ code: 'not_found' });
		}
		await openPartnershipFromForm(companyDeps(), { subject: first.operator, meta }, form(verified.id));

		const partnershipOf = async (companyId: string) => {
			const [row] = await database.db
				.select({ id: competitionPartnerships.id })
				.from(competitionPartnerships)
				.where(eq(competitionPartnerships.companyId, companyId));
			if (!row) throw new Error(`company ${companyId} has no partnership`);
			return row.id;
		};
		await openPartnershipFromForm(companyDeps(), { subject: stand.operator, meta }, form(stand.verifiedCompanyId));
		await expect(
			endPartnership(companyDeps(), { subject: first.operator, meta }, await partnershipOf(stand.verifiedCompanyId))
		).rejects.toMatchObject({ code: 'not_found' });
		await endPartnership(companyDeps(), { subject: first.operator, meta }, await partnershipOf(verified.id));
	});

	it('reads the files of the cases of its own session only', async () => {
		const read = (who: AccessSubject, fileId: string, context: FileAccessContext) =>
			openFile(fileDeps(), who, fileId, context, meta);
		const cases = (p: Place): [string, FileAccessContext][] => [
			[p.verificationFileId, { kind: 'case', caseType: 'moderation', caseId: p.verificationId }],
			[p.authorityFileId, { kind: 'case', caseType: 'authority', caseId: p.representationId }]
		];
		for (const other of others()) {
			for (const [fileId, context] of cases(other)) {
				await expect(read(first.operator, fileId, context)).rejects.toMatchObject({ code: 'not_found' });
			}
		}
		for (const [fileId, context] of cases(first)) {
			expect((await read(first.operator, fileId, context)).fileId).toBe(fileId);
		}
		for (const [fileId, context] of cases(stand)) {
			expect((await read(stand.operator, fileId, context)).fileId).toBe(fileId);
		}

		// The source file of a batch of FSP results loaded on the stand.
		const batchFile = await storedFile(stand.operator.userId ?? '', 'source_batch');
		await expect(read(first.operator, batchFile, { kind: 'source_batch' })).rejects.toMatchObject({
			code: 'not_found'
		});
		expect((await read(stand.operator, batchFile, { kind: 'source_batch' })).fileId).toBe(batchFile);
	});

	it('neither previews nor imports a batch of FSP results, and sees no loads of the stand', async () => {
		const deps: BatchDeps = {
			db: database.db,
			store,
			parser: () => {
				throw new Error('a refused batch is never parsed');
			},
			signer: () => {
				throw new Error('a refused batch is never signed');
			},
			now: () => new Date()
		};
		for (const load of [previewBatch, importBatch]) {
			await expect(load(deps, { subject: first.operator, meta }, new FormData())).rejects.toMatchObject({
				code: 'forbidden',
				message: DEMO_LOCK_MESSAGE
			});
			// The operator of the stand goes past the barrier to the form itself.
			await expect(load(deps, { subject: stand.operator, meta }, new FormData())).rejects.toMatchObject({
				code: 'validation_failed'
			});
		}
		await recordAuditEvent(database.db, {
			action: 'fsp.batch_imported',
			outcome: 'success',
			actor: { kind: 'user', userId: stand.operator.userId ?? '' },
			requestId: meta.requestId,
			details: { file_id: randomUUID(), refused: 'row_issues' }
		});
		expect(await batchHistory(database.db, first.operator)).toEqual([]);
		expect(await batchHistory(database.db, stand.operator)).toHaveLength(1);
	});

	it('annuls the platform attempts of its own session only', async () => {
		for (const other of others()) {
			await expect(
				annulAttempt(database.db, OWNER_STANDING, first.operator, meta, other.attemptId, 'plagiarism', new Date())
			).rejects.toMatchObject({ code: 'not_found' });
		}
		const untouched = await database.db
			.select({ id: testAttempts.id, status: testAttempts.status })
			.from(testAttempts)
			.where(inArray(testAttempts.id, [second.attemptId, stand.attemptId]));
		expect(Object.fromEntries(untouched.map((row) => [row.id, row.status]))).toEqual({
			[second.attemptId]: 'expired',
			[stand.attemptId]: 'expired'
		});
		await annulAttempt(database.db, OWNER_STANDING, first.operator, meta, first.attemptId, 'plagiarism', new Date());
		const [annulled] = await database.db
			.select({ status: testAttempts.status })
			.from(testAttempts)
			.where(eq(testAttempts.id, first.attemptId));
		expect(annulled?.status).toBe('annulled');
	});

	it('resolves the age conflicts of its own session only', async () => {
		const decision = {
			birthDate: '1999-01-01',
			method: 'document_presented' as const,
			documentKind: 'passport' as const
		};
		for (const other of others()) {
			await expect(
				resolveAgeConflict(database.db, first.operator, meta, other.ageConflictCandidateId, decision, new Date())
			).rejects.toMatchObject({ code: 'not_found' });
		}
		const untouched = await database.db
			.select({ id: candidates.id, status: candidates.birthDateStatus })
			.from(candidates)
			.where(inArray(candidates.id, [second.ageConflictCandidateId, stand.ageConflictCandidateId]));
		expect(Object.fromEntries(untouched.map((row) => [row.id, row.status]))).toEqual({
			[second.ageConflictCandidateId]: 'conflict',
			[stand.ageConflictCandidateId]: 'conflict'
		});
		await resolveAgeConflict(database.db, first.operator, meta, first.ageConflictCandidateId, decision, new Date());
		const [resolved] = await database.db
			.select({ status: candidates.birthDateStatus })
			.from(candidates)
			.where(eq(candidates.id, first.ageConflictCandidateId));
		expect(resolved?.status).toBe('verified');
	});
});

describe('a clone of the administrator', () => {
	it('reads the journal of its own session only', async () => {
		for (const p of [first, second, stand]) {
			await recordAuditEvent(database.db, {
				action: 'invitation.sent',
				outcome: 'success',
				actor: { kind: 'user', userId: p.eventUserId },
				requestId: `event-of-${p.session ?? 'stand'}`
			});
		}
		const read = async (who: AccessSubject) =>
			(
				await readJournal(
					database.db,
					{ subject: who, meta },
					{
						action: 'invitation.sent',
						outcome: null,
						actorUserId: null,
						objectType: null,
						objectId: null,
						from: null,
						to: null,
						cursor: null
					}
				)
			).entries.map((entry) => entry.actorUserId);
		expect(await read(first.admin)).toEqual([first.eventUserId]);
		expect((await read(stand.admin)).sort()).toEqual([first.eventUserId, second.eventUserId, stand.eventUserId].sort());
	});

	it('finds and lists the accounts of its own session only, and changes no staff role', async () => {
		const ctx = { subject: first.admin, meta };
		expect(await findUser(staffDeps(), ctx, second.operator.userId ?? '')).toBeNull();
		expect(await findUser(staffDeps(), ctx, stand.operator.userId ?? '')).toBeNull();
		expect((await findUser(staffDeps(), ctx, first.operator.userId ?? ''))?.id).toBe(first.operator.userId);
		expect((await staffList(staffDeps(), ctx)).map((member) => member.userId).sort()).toEqual(
			[first.operator.userId, first.admin.userId].sort()
		);

		const target = first.eventUserId;
		await expect(
			grantStaffRole(staffDeps(), ctx, { userId: target, role: 'operator', auditRead: false })
		).rejects.toMatchObject({ code: 'forbidden', message: DEMO_LOCK_MESSAGE });
		await expect(
			setOperatorAuditRead(staffDeps(), ctx, { userId: first.operator.userId ?? '', enabled: true })
		).rejects.toMatchObject({ code: 'forbidden', message: DEMO_LOCK_MESSAGE });
		const granted = await database.db
			.select({ id: staffRoles.id })
			.from(staffRoles)
			.where(eq(staffRoles.userId, target));
		expect(granted).toEqual([]);

		// The administrator of the stand still grants roles.
		await grantStaffRole(
			staffDeps(),
			{ subject: stand.admin, meta },
			{
				userId: stand.eventUserId,
				role: 'operator',
				auditRead: false
			}
		);
	});

	it('does not switch the model modes: every demo account is refused a change of the whole stand', async () => {
		const original = staffSubject(cast.get('staff:admin') ?? '', 'admin');
		for (const who of [first.admin, original]) {
			expect(await standChangesLocked(database.db, who)).toBe(true);
			await expect(requireStandChange(database.db, who)).rejects.toMatchObject({
				code: 'forbidden',
				message: DEMO_LOCK_MESSAGE
			});
		}
		expect(await standChangesLocked(database.db, stand.admin)).toBe(false);
		await requireStandChange(database.db, stand.admin);
	});
});

describe('signing in', () => {
	const ISSUER = 'https://sso.fsp.test/realms/fsp';

	function authDeps(): AuthDeps {
		return {
			db: database.db,
			redis,
			crypto,
			mailer: { send: () => Promise.resolve({ ok: true, value: { messageId: randomUUID() } }) },
			appOrigin: 'http://app.test',
			now: () => new Date()
		};
	}

	/** An identity of the account, in the account's demo session as the product writes it. */
	async function identity(userId: string): Promise<string> {
		const subject = randomUUID();
		const [user] = await database.db.select({ session: users.demoSessionId }).from(users).where(eq(users.id, userId));
		await database.db.insert(externalIdentities).values({
			userId,
			issuer: ISSUER,
			subject,
			linkedAt: new Date(),
			linkMethod: 'linked_by_user',
			demoSessionId: user?.session ?? null
		});
		return subject;
	}

	const authorization = (subject: string, intent: 'login' | 'link' = 'login', forUserId: string | null = null) =>
		({
			intent,
			forUserId,
			returnTo: '/me',
			identity: { issuer: ISSUER, subject },
			authTime: Math.floor(Date.now() / 1000),
			profileClaims: {}
		}) satisfies FspIdAuthorization;

	it('refuses FSP ID into an original of the cast and into a clone, and signs in a person', async () => {
		const hero = cast.get(castRoles(data).find((role) => role.group === 'candidate')?.key ?? '') ?? '';
		expect(await completeFspSignIn(authDeps(), meta, authorization(await identity(hero)), null, null)).toEqual({
			kind: 'refused',
			reason: 'demo_account'
		});
		// A clone of the cast (an account of the seed batch in a session) is found within the visitor's session.
		const session = first.session;
		if (session === null) throw new Error('the first place is not a demo session');
		const castClone = await createUser(database.db, { demoSessionId: session, seedBatchId: 'demo-1' });
		const visitor = () => Promise.resolve({ ok: true as const, sessionId: session });
		expect(
			await completeFspSignIn(authDeps(), meta, authorization(await identity(castClone.id)), null, visitor)
		).toEqual({ kind: 'refused', reason: 'demo_account' });
		const person = await createUser(database.db);
		expect(
			await completeFspSignIn(authDeps(), meta, authorization(await identity(person.id)), null, null)
		).toMatchObject({
			kind: 'signed_in',
			userId: person.id
		});

		// A clone of the cast links no FSP ID either (an account a visitor registered within the session does).
		const current = { hash: 'b'.repeat(64), userId: castClone.id, authTime: new Date() };
		expect(
			await completeFspSignIn(authDeps(), meta, authorization(randomUUID(), 'link', castClone.id), current, null)
		).toEqual({
			kind: 'refused',
			reason: 'demo_account'
		});
	});

	it('refuses the password of an account of the demo seed, and signs in a person', async () => {
		const password = 'correct horse battery staple';
		const hash = await hashPassword(password);
		const operator = castRoles(data).find((role) => role.key === 'staff:operator');
		if (!operator) throw new Error('the cast has no operator');
		const original = cast.get(operator.key) ?? '';
		await database.db.insert(passwordCredentials).values({ userId: original, hash, changedAt: new Date() });
		const email = `person-${randomUUID()}@example.org`;
		const person = await createUser(database.db, {
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email)
		});
		await database.db.insert(passwordCredentials).values({ userId: person.id, hash, changedAt: new Date() });

		for (const attempt of [password, 'a wrong password']) {
			expect(
				await loginWithPassword(
					authDeps(),
					meta,
					{ email: operator.email, password: attempt, demoSessionId: null },
					null
				)
			).toEqual({
				ok: false,
				reason: 'demo_account',
				retryAfterSeconds: null
			});
		}
		expect(await loginWithPassword(authDeps(), meta, { email, password, demoSessionId: null }, null)).toMatchObject({
			ok: true,
			userId: person.id
		});
	});

	it('ends the sign-in of a clone whose demo session is over, and marks a live one as used', async () => {
		const now = new Date();
		const over = await demoSession(new Date(now.getTime() - MINUTE), new Date(now.getTime() - DAY));
		const expired = await createUser(database.db, { demoSessionId: over });
		const live = await createUser(database.db, { demoSessionId: first.session });
		const signIn = async (userId: string) =>
			(await createSession(redis, { userId, authMethod: 'password', authTime: now, ip: null, ua: null }, now))
				.sessionId;
		const deps = { db: database.db, redis, now: () => now };

		const expiredSession = await signIn(expired.id);
		expect(await authenticateSession(deps, expiredSession)).toBeNull();
		// The sign-in session is gone, not only refused this once.
		expect(
			await authenticateSession({ ...deps, now: () => new Date(now.getTime() - 2 * MINUTE) }, expiredSession)
		).toBeNull();

		expect(await authenticateSession(deps, await signIn(live.id))).toMatchObject({ userId: live.id });
		const used = await redisDemoActivity(redis).lastUsed([first.session ?? '']);
		expect(used.get(first.session ?? '')?.getTime()).toBe(now.getTime());
	});
});

describe('the demo screen', () => {
	const role = () => {
		const found = castRoles(data).find((r) => r.key === 'staff:operator');
		if (!found) throw new Error('the cast has no operator');
		return found;
	};
	const enterDeps = (now: Date) => ({ db: database.db, redis, crypto, store, now: () => now });
	const enter = (address: string, tokens: (string | null)[] = [], now = new Date()) =>
		enterDemoRole(enterDeps(now), {
			data,
			role: role(),
			tokens,
			address,
			previous: null,
			meta
		});
	const budgetUsed = async (address: string) =>
		Number((await redis.get(`ratelimit:${RATE_LIMIT_RULES.demoSession.name}:${address}`)) ?? 0);
	const entered = (entry: DemoEntry) => {
		if (entry.kind !== 'entered') throw new Error(`the entry was refused: ${entry.reason}`);
		return entry;
	};

	it('opens a session for a new browser, and switching roles in it costs nothing of the budget', async () => {
		const address = '198.51.100.1';
		const opened = entered(await enter(address));
		expect(opened.opened).toBe(true);
		expect(await budgetUsed(address)).toBe(1);
		for (const key of ['staff:admin', 'staff:operator']) {
			const other = castRoles(data).find((r) => r.key === key);
			if (!other) throw new Error(`the cast has no ${key}`);
			const switched = entered(
				await enterDemoRole(enterDeps(new Date()), {
					data,
					role: other,
					tokens: [null, opened.token],
					address,
					previous: null,
					meta
				})
			);
			expect(switched).toMatchObject({ opened: false, session: { id: opened.session.id } });
		}
		expect(await budgetUsed(address)).toBe(1);
	});

	it('refuses a new session to an address past its budget', async () => {
		const address = '198.51.100.2';
		for (let i = 0; i < RATE_LIMIT_RULES.demoSession.limit - 1; i++) {
			await redis.incr(`ratelimit:${RATE_LIMIT_RULES.demoSession.name}:${address}`);
		}
		await redis.expire(`ratelimit:${RATE_LIMIT_RULES.demoSession.name}:${address}`, 3600);
		entered(await enter(address));
		expect(await enter(address)).toMatchObject({ kind: 'refused', reason: 'address_budget' });
	});

	it('gives the place of the quietest session to a new visitor when the stand is full', async () => {
		const now = new Date();
		const activity = redisDemoActivity(redis);
		const live = await database.db
			.select({ id: demoSessions.id })
			.from(demoSessions)
			.where(gt(demoSessions.expiresAt, now));
		// Opened an hour ago: a session is never quiet for longer than it has existed.
		const filler: string[] = [];
		for (let i = live.length; i < MAX_LIVE_SESSIONS; i++) {
			filler.push(await demoSession(new Date(now.getTime() + DAY), new Date(now.getTime() - 60 * MINUTE)));
		}
		const all = [...live.map((s) => s.id), ...filler];
		for (const id of all) await activity.touch(id, now);
		// Every session is in use: the visitor is asked to come back.
		expect(await enter('198.51.100.3', [], now)).toMatchObject({ kind: 'refused', reason: 'stand_full' });

		const quiet = filler[0] ?? '';
		await activity.forget([quiet]);
		await activity.touch(quiet, new Date(now.getTime() - (DEMO_EVICTABLE_MINUTES + 1) * MINUTE));
		const newcomer = entered(await enter('198.51.100.4', [], now));
		expect(newcomer.opened).toBe(true);
		const [ended] = await database.db
			.select({ expiresAt: demoSessions.expiresAt })
			.from(demoSessions)
			.where(eq(demoSessions.id, quiet));
		expect(ended?.expiresAt.getTime()).toBeLessThanOrEqual(now.getTime());
		const stillLive = await database.db
			.select({ id: demoSessions.id })
			.from(demoSessions)
			.where(gt(demoSessions.expiresAt, now));
		expect(stillLive).toHaveLength(MAX_LIVE_SESSIONS);
	});

	it('ends and removes a session nobody has used for the idle time', async () => {
		const now = new Date();
		const activity = redisDemoActivity(redis);
		const idle = await demoSession(
			new Date(now.getTime() + DAY),
			new Date(now.getTime() - 3 * DEMO_IDLE_MINUTES * MINUTE)
		);
		const used = await demoSession(
			new Date(now.getTime() + DAY),
			new Date(now.getTime() - 3 * DEMO_IDLE_MINUTES * MINUTE)
		);
		await activity.touch(idle, new Date(now.getTime() - (DEMO_IDLE_MINUTES + 1) * MINUTE));
		await activity.touch(used, new Date(now.getTime() - MINUTE));
		const outcome = await purgeExpiredDemoSessions({ db: database.db, redis, store }, now, meta.requestId);
		expect(outcome.idle).toContain(idle);
		expect(outcome.idle).not.toContain(used);
		expect(outcome.purged.map((p) => p.sessionId)).toContain(idle);
		const left = await database.db
			.select({ id: demoSessions.id })
			.from(demoSessions)
			.where(inArray(demoSessions.id, [idle, used]));
		expect(left.map((row) => row.id)).toEqual([used]);
	});
});
