// Revocation of consents by the candidate (docs/domain.md, sections 6.3, 17.3, 19.1). `fsp_import`: in the transaction
// of the revocation the imports stop and the imported facts leave the profile — their receipts answer `not_valid`, the
// published category is blocked, the recalculations and `consent.revocation_cleanup` are enqueued; the cleanup removes
// the facts with their claims and receipts and the derivatives below the evidence floor, and journals `facts.purged`.
// Facts of other sources stay. A new grant imports again. The legal representative of a minor revokes the import by
// the link of a letter with the same consequences. `pd_processing`: the revocation is the deletion of the profile —
// processing stops at once and `account.purge` is enqueued; a resume waiting for its parse when the consent is gone
// (lapsed while the profile stays) fails with `no_processing_consent` instead of staying pending.
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { publishLegalDocuments, readLegalRelease } from '../../scripts/seed-legal';
import { publishPolicies, readPolicyRelease } from '../../scripts/seed-policies';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { AuthDeps } from '$lib/server/auth/context';
import { currentDocument } from '$lib/server/auth/documents';
import { confirmFspAchievements, unlinkFspIdentity } from '$lib/server/auth/identities';
import { createSession, type SessionRef } from '$lib/server/auth/sessions';
import { revokeFspImportConsent } from '$lib/server/candidates/consents';
import { createCategorizationHandler } from '$lib/server/categorization/job';
import { effectiveConsentOf } from '$lib/server/consent/effective';
import { processingAllowed } from '$lib/server/consent/processing';
import { revokeConsentsByRepresentative, sendConsentLetter } from '$lib/server/consent/representative';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	athleteLinks,
	auditEvents,
	candidates,
	categorizationRuns,
	claims,
	consentEvents,
	embeddingSpaces,
	embeddings,
	externalIdentities,
	files,
	jobs,
	legalRepresentatives,
	mlResults,
	notifications,
	passwordCredentials,
	representations,
	resumeDocuments,
	sourceFacts,
	users,
	verificationReceipts
} from '$lib/server/db/schema';
import { drainJobs } from '$lib/server/demo/queue';
import type { Docparse, DocparseResult } from '$lib/server/documents/docparse';
import { consentRevocationCleanup } from '$lib/server/erasure/fsp-import';
import { requestAccountDeletion } from '$lib/server/erasure/request';
import { ApiError } from '$lib/server/errors/api-error';
import { HttpAchievementsSource } from '$lib/server/fsp/adapter';
import { ServiceGrantIssuer } from '$lib/server/fsp/grant';
import { createReceiptSigner, verifyReceipt } from '$lib/server/fsp/receipts';
import { createFspSyncHandler } from '$lib/server/fsp/sync';
import { handlerRegistry } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import type { MailMessage, Mailer } from '$lib/server/mail/mailer';
import type { Redis } from '$lib/server/redis';
import { createResumeParseHandler } from '$lib/server/resumes/parse-job';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { testEnvironment } from '../helpers/environment';
import { createUser, randomSha256 } from '../helpers/factories';
import { FSP_MOCK_CREDENTIALS, startFspMock, type FspMock } from '../helpers/fsp-mock';

const ROOT = new URL('../../', import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, ROOT));
const REDIS_DATABASE = 13;
const SPACE = 'revocation-space@r1/q:none/d:none/mean/l2/4/t512/sections-v1';

const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

let database: TestDatabase;
let mock: FspMock;
let redis: Redis;

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});
const log = createLogger({}, () => undefined);
const meta = { requestId: 'revocation-test', ip: '127.0.0.1', userAgent: 'vitest', sessionHash: 'b'.repeat(64) };
const mailer: Mailer = { send: () => Promise.resolve({ ok: true, value: { messageId: 'm' } }) };

let pipeline: ReturnType<typeof handlerRegistry>;

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(path('taxonomy'))));
		await publishLegalDocuments(client, await readLegalRelease(path('legal')));
		await publishPolicies(client, await readPolicyRelease(path('policies')));
	} finally {
		await client.end({ timeout: 5 });
	}
	await database.db.insert(embeddingSpaces).values({
		id: SPACE,
		modelName: 'test-embedder',
		modelRevision: 'r1',
		dimension: 4,
		queryPrefix: '',
		documentPrefix: '',
		pooling: 'mean',
		normalization: 'l2',
		maxInputTokens: 512,
		chunkingVersion: 'sections-v1',
		status: 'active',
		activatedAt: new Date()
	});
	mock = await startFspMock({ athletes: 200 });
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
	Object.assign(
		env,
		testEnvironment({ DATABASE_URL: database.url, REDIS_URL: `${inject('redisUrl')}/${REDIS_DATABASE}` })
	);
	pipeline = handlerRegistry([
		createFspSyncHandler(() => ({
			source: new HttpAchievementsSource({ baseUrl: mock.origin, webhookSecret: FSP_MOCK_CREDENTIALS.webhookSecret }),
			grants: new ServiceGrantIssuer({
				issuer: mock.issuer,
				clientId: FSP_MOCK_CREDENTIALS.clientId,
				clientSecret: FSP_MOCK_CREDENTIALS.clientSecret,
				assertionSecret: FSP_MOCK_CREDENTIALS.assertionSecret
			}),
			signer: createReceiptSigner({ issuer: 'http://platform.test', keyId: 'test-1', seed: Buffer.alloc(32, 7) })
		})),
		createCategorizationHandler()
	]);
}, 240_000);

afterAll(async () => {
	await mock.stop();
	redis.destroy();
	await database.drop();
});

function authDeps(): AuthDeps {
	return { db: database.db, redis, crypto, mailer, appOrigin: 'http://localhost:57173', now: () => new Date() };
}

async function documentId(kind: 'pd_processing' | 'fsp_import') {
	const document = await currentDocument(database.db, kind, new Date());
	if (!document) throw new Error(`no current ${kind}`);
	return document.id;
}

async function drain(types: readonly ('fsp.sync' | 'categorization.compute')[]) {
	await drainJobs(database.db, pipeline, types, { since: new Date(0), log, label: 'revocation-test' });
}

/** An adult candidate with a verified birth date, the processing consent and a session signed in just now. */
async function person() {
	const email = `person-${randomBytes(4).toString('hex')}@example.org`;
	const user = await createUser(database.db, {
		emailEnc: crypto.encrypt(email, 'users.email'),
		emailHmac: crypto.lookupHmac('email', email),
		emailVerifiedAt: new Date()
	});
	const [row] = await database.db
		.insert(candidates)
		.values({
			userId: user.id,
			status: 'active',
			searchStatus: 'active',
			preferences: {},
			birthDate: '1997-04-17',
			birthDatePrecision: 'day',
			birthDateSource: 'operator_document',
			birthDateStatus: 'verified',
			birthDateVerifiedAt: new Date()
		})
		.returning();
	if (!row) throw new Error('candidate not inserted');
	await database.db.insert(consentEvents).values({
		subjectCandidateId: row.id,
		kind: 'pd_processing',
		documentId: await documentId('pd_processing'),
		action: 'grant',
		signerKind: 'subject',
		signerUserId: user.id,
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: new Date(Date.now() - 3_600_000)
	});
	const subject: AccessSubject = {
		userId: user.id,
		via: 'session',
		candidate: { id: row.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	const { session } = await createSession(
		redis,
		{ userId: user.id, authMethod: 'fsp_id', authTime: new Date(), ip: null, ua: null },
		new Date()
	);
	const ref: SessionRef = { hash: session.hash, userId: user.id, authTime: new Date() };
	return { userId: user.id, candidateId: row.id, subject, session: ref };
}

/**
 * A candidate aged 16 whose representative's authority is verified and who signed the processing and the import
 * consents on the representative's side; the candidate's own processing consent is given, the import one — by
 * confirming the achievements.
 */
async function ward() {
	const who = await person();
	await database.db.update(candidates).set({ birthDate: '2010-03-15' }).where(eq(candidates.id, who.candidateId));
	const representativeEmail = `parent-${randomBytes(4).toString('hex')}@example.org`;
	const [representative] = await database.db
		.insert(legalRepresentatives)
		.values({
			fullNameEnc: crypto.encrypt('Захарова Елена Викторовна', 'legal_representatives.full_name'),
			emailEnc: crypto.encrypt(representativeEmail, 'legal_representatives.email'),
			emailHmac: crypto.lookupHmac('email', representativeEmail)
		})
		.returning();
	if (!representative) throw new Error('representative not inserted');
	const [representation] = await database.db
		.insert(representations)
		.values({
			candidateId: who.candidateId,
			representativeId: representative.id,
			relation: 'parent',
			status: 'authority_verified',
			invitedAt: new Date(Date.now() - 7_200_000),
			contactConfirmedAt: new Date(Date.now() - 7_200_000)
		})
		.returning();
	if (!representation) throw new Error('representation not inserted');
	for (const kind of ['pd_processing', 'fsp_import'] as const) {
		await database.db.insert(consentEvents).values({
			subjectCandidateId: who.candidateId,
			kind,
			documentId: await documentId(kind),
			action: 'grant',
			signerKind: 'representative',
			representationId: representation.id,
			method: 'email_link',
			evidence: {},
			occurredAt: new Date(Date.now() - 3_600_000)
		});
	}
	return { ...who, representationId: representation.id, representativeEmail };
}

/** Signed in with FSP ID and confirmed the achievements: the consent, the link and the first import. */
async function importAchievements(who: Awaited<ReturnType<typeof person>>, hero: string) {
	const fspId = await mock.heroId(hero);
	await database.db
		.insert(externalIdentities)
		.values({
			userId: who.userId,
			issuer: mock.issuer,
			subject: fspId,
			linkedAt: new Date(),
			linkMethod: 'signup_via_provider'
		})
		.onConflictDoNothing();
	const confirmed = await confirmFspAchievements(authDeps(), meta, who.session, {
		issuer: mock.issuer,
		documentId: await documentId('fsp_import')
	});
	if (!confirmed.ok) throw new Error(`the achievements were not confirmed: ${confirmed.reason}`);
	await drain(['fsp.sync', 'categorization.compute']);
	return confirmed.linkId;
}

/** Runs the queued cleanup named by `key` (`consent_event_id` or `athlete_link_id` of its payload). */
async function runCleanup(revocationId: string, key: 'consent_event_id' | 'athlete_link_id' = 'consent_event_id') {
	const [row] = await database.db
		.select({ id: jobs.id })
		.from(jobs)
		.where(and(eq(jobs.type, 'consent.revocation_cleanup'), sql`${jobs.payload} ->> ${key} = ${revocationId}`));
	expect(row).toBeDefined();
	const claimed = (await claimJob(database.db, 'revocation-test', [
		'consent.revocation_cleanup'
	])) as ClaimedJob<'consent.revocation_cleanup'> | null;
	if (!claimed) throw new Error('the cleanup is not due');
	expect(claimed.payload).toEqual({ [key]: revocationId });
	const result = await consentRevocationCleanup.run({
		job: claimed,
		db: database.db,
		signal: new AbortController().signal,
		requestId: `job:${claimed.id}`,
		log
	});
	expect(await completeJob(database.db, claimed, result)).toBe('succeeded');
	return claimed.id;
}

describe('revoking fsp_import', () => {
	it('stops the imports and takes the facts out at once; the cleanup removes them with their derivatives', async () => {
		const { db } = database;
		const who = await person();
		const linkId = await importAchievements(who, 'Капитан, backend, МС');
		// A fact of another source, which the revocation does not touch.
		const [own] = await db
			.insert(sourceFacts)
			.values({
				candidateId: who.candidateId,
				source: 'self_declared',
				factType: 'questionnaire',
				sourceRecordRef: 'questionnaire:1',
				trustLevel: 'claimed',
				ownershipBasis: 'self_declared',
				payload: { answers: 1 },
				payloadSha256: randomSha256(),
				observedAt: new Date(),
				lastVerifiedAt: new Date(),
				status: 'active'
			})
			.returning();
		if (!own) throw new Error('fact not inserted');

		const imported = await db
			.select()
			.from(sourceFacts)
			.where(and(eq(sourceFacts.candidateId, who.candidateId), eq(sourceFacts.source, 'fsp')));
		expect(imported.length).toBeGreaterThan(0);
		const importedIds = imported.map((fact) => fact.id);
		const receipts = await db
			.select({ handle: verificationReceipts.handle })
			.from(verificationReceipts)
			.where(inArray(verificationReceipts.factId, importedIds));
		expect(receipts.length).toBeGreaterThan(0);
		expect((await verifyReceipt(db, receipts[0]?.handle ?? ''))?.status).toBe('valid');
		const [published] = await db
			.select({ id: categorizationRuns.id })
			.from(categorizationRuns)
			.where(and(eq(categorizationRuns.candidateId, who.candidateId), eq(categorizationRuns.status, 'published')));
		if (!published) throw new Error('no published category');
		const [before] = await db.select().from(candidates).where(eq(candidates.id, who.candidateId));
		if (!before) throw new Error('candidate disappeared');
		// Derivatives of the revision the facts counted in: a vector and its model envelope.
		await db.insert(embeddings).values({
			ownerType: 'candidate_section',
			ownerId: who.candidateId,
			section: 'summary',
			inputSha256: randomSha256(),
			inputVersion: String(before.profileRevision),
			spaceId: SPACE,
			vector: [1, 0, 0, 0]
		});
		const [envelope] = await db
			.insert(mlResults)
			.values({
				operation: 'embed',
				inputRef: { type: 'candidate', id: who.candidateId, revision: before.profileRevision },
				inputSha256: randomSha256(),
				inputVersion: String(before.profileRevision),
				schemaVersion: 'test',
				embeddingSpaceId: SPACE,
				processingMode: 'model',
				model: { model_id: 'test-embedder' }
			})
			.returning({ id: mlResults.id });
		if (!envelope) throw new Error('envelope not inserted');
		// An import waiting for its turn.
		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'fsp.sync',
				{ athlete_link_id: linkId },
				{ inputVersion: 'waiting', createdBy: { kind: 'system' } }
			)
		);

		const withdrawn = await revokeFspImportConsent(db, who.subject, meta, 'больше не хочу');
		expect(withdrawn).toBe(imported.length);

		// At once.
		expect(await effectiveConsentOf(db, who.candidateId, 'fsp_import', new Date())).toBeNull();
		const after = await db.select().from(sourceFacts).where(inArray(sourceFacts.id, importedIds));
		expect(after.every((fact) => fact.status === 'withdrawn' && fact.statusReason === 'consent_revoked')).toBe(true);
		const claimRows = await db.select().from(claims).where(inArray(claims.factId, importedIds));
		expect(claimRows.every((claim) => claim.status === 'invalidated')).toBe(true);
		for (const { handle } of receipts) expect((await verifyReceipt(db, handle))?.status).toBe('not_valid');
		const [link] = await db.select().from(athleteLinks).where(eq(athleteLinks.id, linkId));
		expect(link?.status).toBe('unlinked');
		const syncs = await db
			.select({ status: jobs.status })
			.from(jobs)
			.where(and(eq(jobs.type, 'fsp.sync'), sql`${jobs.payload} ->> 'athlete_link_id' = ${linkId}`));
		expect(syncs.map((job) => job.status)).toContain('cancelled');
		expect(syncs.map((job) => job.status)).not.toContain('queued');
		const [run] = await db.select().from(categorizationRuns).where(eq(categorizationRuns.id, published.id));
		expect(run?.status).toBe('blocked');
		const [candidate] = await db.select().from(candidates).where(eq(candidates.id, who.candidateId));
		expect(candidate?.evidenceFloorRevision).toBe(candidate?.profileRevision);
		expect(candidate?.profileRevision).toBeGreaterThan(before.profileRevision);
		const [revocation] = await db
			.select()
			.from(consentEvents)
			.where(
				and(
					eq(consentEvents.subjectCandidateId, who.candidateId),
					eq(consentEvents.kind, 'fsp_import'),
					eq(consentEvents.action, 'revoke')
				)
			);
		if (!revocation) throw new Error('no revocation event');
		expect(revocation).toMatchObject({ signerKind: 'subject', signerUserId: who.userId, reason: 'больше не хочу' });
		// Nothing more to revoke.
		await expect(revokeFspImportConsent(db, who.subject, meta)).rejects.toBeInstanceOf(ApiError);

		// The cleanup.
		const jobId = await runCleanup(revocation.id);
		expect(await db.select().from(sourceFacts).where(inArray(sourceFacts.id, importedIds))).toEqual([]);
		expect(await db.select().from(claims).where(inArray(claims.factId, importedIds))).toEqual([]);
		expect(
			await db.select().from(verificationReceipts).where(inArray(verificationReceipts.factId, importedIds))
		).toEqual([]);
		for (const { handle } of receipts) expect(await verifyReceipt(db, handle)).toBeNull();
		expect(await db.select().from(embeddings).where(eq(embeddings.ownerId, who.candidateId))).toEqual([]);
		expect(await db.select().from(mlResults).where(eq(mlResults.id, envelope.id))).toEqual([]);
		// The blocked run of the withdrawn revision is gone; the fact of another source stays.
		expect(await db.select().from(categorizationRuns).where(eq(categorizationRuns.id, published.id))).toEqual([]);
		const [kept] = await db.select().from(sourceFacts).where(eq(sourceFacts.id, own.id));
		expect(kept?.status).toBe('active');
		const [purged] = await db
			.select({ details: auditEvents.details, subject: auditEvents.subjectCandidateId })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'facts.purged'), eq(auditEvents.requestId, `job:${jobId}`)));
		expect(purged).toMatchObject({
			subject: who.candidateId,
			details: { count: imported.length, source: 'fsp', receipts: receipts.length }
		});

		// A new grant links the athlete anew and imports again.
		const relinked = await importAchievements(who, 'Капитан, backend, МС');
		expect(relinked).not.toBe(linkId);
		const again = await db
			.select({ id: sourceFacts.id, status: sourceFacts.status })
			.from(sourceFacts)
			.where(and(eq(sourceFacts.candidateId, who.candidateId), eq(sourceFacts.source, 'fsp')));
		expect(again.length).toBe(imported.length);
		expect(again.every((fact) => fact.status === 'active' && !importedIds.includes(fact.id))).toBe(true);
	});
});

describe('unlinking FSP ID', () => {
	it('withdraws the facts of the link at once and removes them by the same cleanup as a revocation', async () => {
		const { db } = database;
		const who = await person();
		// A password, so that the unlinking does not take the last way in.
		await db.insert(passwordCredentials).values({ userId: who.userId, hash: 'x', changedAt: new Date() });
		const linkId = await importAchievements(who, 'Командный призёр без специализации');
		const imported = await db
			.select({ id: sourceFacts.id })
			.from(sourceFacts)
			.where(and(eq(sourceFacts.candidateId, who.candidateId), eq(sourceFacts.source, 'fsp')));
		expect(imported.length).toBeGreaterThan(0);
		const importedIds = imported.map((fact) => fact.id);
		const receipts = await db
			.select({ handle: verificationReceipts.handle })
			.from(verificationReceipts)
			.where(inArray(verificationReceipts.factId, importedIds));
		expect(receipts.length).toBeGreaterThan(0);

		const unlinked = await unlinkFspIdentity(authDeps(), meta, who.session, mock.issuer);
		expect(unlinked).toEqual({ ok: true, withdrawnFacts: imported.length });
		for (const { handle } of receipts) expect((await verifyReceipt(db, handle))?.status).toBe('not_valid');

		const jobId = await runCleanup(linkId, 'athlete_link_id');
		expect(await db.select().from(sourceFacts).where(inArray(sourceFacts.id, importedIds))).toEqual([]);
		expect(await db.select().from(claims).where(inArray(claims.factId, importedIds))).toEqual([]);
		for (const { handle } of receipts) expect(await verifyReceipt(db, handle)).toBeNull();
		const [purged] = await db
			.select({ details: auditEvents.details, objectType: auditEvents.objectType, objectId: auditEvents.objectId })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'facts.purged'), eq(auditEvents.requestId, `job:${jobId}`)));
		expect(purged).toMatchObject({
			objectType: 'athlete_link',
			objectId: linkId,
			details: { count: imported.length, source: 'fsp', receipts: receipts.length }
		});
	});
});

describe('revoking fsp_import by the representative of a minor', () => {
	it("takes the facts out at once by the link of a letter, like the candidate's own revocation", async () => {
		const { db } = database;
		const who = await ward();
		const linkId = await importAchievements(who, 'Школьница, 16 лет, командный призёр');
		expect(await effectiveConsentOf(db, who.candidateId, 'fsp_import', new Date())).not.toBeNull();
		const imported = await db
			.select({ id: sourceFacts.id })
			.from(sourceFacts)
			.where(and(eq(sourceFacts.candidateId, who.candidateId), eq(sourceFacts.source, 'fsp')));
		expect(imported.length).toBeGreaterThan(0);
		const importedIds = imported.map((fact) => fact.id);

		const letters: MailMessage[] = [];
		const outbox: Mailer = {
			send: (message) => {
				letters.push(message);
				return Promise.resolve({ ok: true, value: { messageId: `letter-${letters.length}` } });
			}
		};
		const deps = { ...authDeps(), mailer: outbox };
		expect(await sendConsentLetter(deps, meta, { kind: 'system' }, who.representationId)).toEqual({ ok: true });
		const token = /\/representative\/consent\?token=([^\s&]+)/u.exec(letters.at(-1)?.text ?? '')?.[1];
		if (token === undefined) throw new Error('no link in the letter');

		expect(await revokeConsentsByRepresentative(deps, meta, decodeURIComponent(token), ['fsp_import'])).toEqual({
			ok: true,
			revoked: ['fsp_import'],
			profileDeleted: false,
			letterSent: true
		});

		// At once: the consent stops for both sides, the imports stop, the facts leave the profile.
		expect(await effectiveConsentOf(db, who.candidateId, 'fsp_import', new Date())).toBeNull();
		expect(await processingAllowed(db, who.candidateId, new Date())).toBe(true);
		const after = await db.select().from(sourceFacts).where(inArray(sourceFacts.id, importedIds));
		expect(after.every((fact) => fact.status === 'withdrawn' && fact.statusReason === 'consent_revoked')).toBe(true);
		const [link] = await db.select().from(athleteLinks).where(eq(athleteLinks.id, linkId));
		expect(link?.status).toBe('unlinked');
		const [revocation] = await db
			.select()
			.from(consentEvents)
			.where(
				and(
					eq(consentEvents.subjectCandidateId, who.candidateId),
					eq(consentEvents.kind, 'fsp_import'),
					eq(consentEvents.action, 'revoke')
				)
			);
		if (!revocation) throw new Error('no revocation event');
		expect(revocation).toMatchObject({ signerKind: 'representative', representationId: who.representationId });
		const [notice] = await db
			.select({ payload: notifications.payload })
			.from(notifications)
			.where(and(eq(notifications.userId, who.userId), eq(notifications.type, 'representation.consents_revoked')));
		expect(notice?.payload).toMatchObject({ fsp_import: true, catalog_visibility: false });

		// The same cleanup removes them physically.
		await runCleanup(revocation.id);
		expect(await db.select().from(sourceFacts).where(inArray(sourceFacts.id, importedIds))).toEqual([]);
	});
});

describe('revoking pd_processing', () => {
	it('is the deletion of the profile: processing stops at once and the purge is enqueued', async () => {
		const { db } = database;
		const who = await person();
		expect(await processingAllowed(db, who.candidateId, new Date())).toBe(true);
		const result = await requestAccountDeletion(authDeps(), meta, who.session, {
			cause: 'processing_revoked',
			reason: 'не пользуюсь'
		});
		expect(result).toMatchObject({ ok: true });
		expect(await processingAllowed(db, who.candidateId, new Date())).toBe(false);
		const [revocation] = await db
			.select()
			.from(consentEvents)
			.where(
				and(
					eq(consentEvents.subjectCandidateId, who.candidateId),
					eq(consentEvents.kind, 'pd_processing'),
					eq(consentEvents.action, 'revoke')
				)
			);
		expect(revocation).toMatchObject({ signerKind: 'subject', signerUserId: who.userId, reason: 'не пользуюсь' });
		const [candidate] = await db
			.select({ status: candidates.status })
			.from(candidates)
			.where(eq(candidates.id, who.candidateId));
		expect(candidate?.status).toBe('deletion_pending');
		const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, who.userId));
		expect(user?.status).toBe('deletion_pending');
		const purges = await db
			.select({ status: jobs.status })
			.from(jobs)
			.where(and(eq(jobs.type, 'account.purge'), sql`${jobs.payload} ->> 'user_id' = ${who.userId}`));
		expect(purges).toEqual([{ status: 'queued' }]);
		const [journal] = await db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'consent.revoked'), eq(auditEvents.subjectCandidateId, who.candidateId)));
		expect(journal?.details).toMatchObject({ kind: 'pd_processing', cause: 'processing_revoked' });
		expect(await redis.exists(`session:${who.session.hash}`)).toBe(0);
	});
});

describe('a resume waiting for its parse when pd_processing is gone', () => {
	const bytes = new TextEncoder().encode('Иван Петров. Go, PostgreSQL.');
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	const store: ObjectStore = {
		put: () => Promise.reject(new Error('the parse writes nothing to the store')),
		get: () =>
			Promise.resolve({
				body: new Blob([bytes]).stream(),
				sizeBytes: bytes.byteLength,
				contentType: 'text/plain'
			}),
		delete: () => Promise.reject(new Error('the parse deletes nothing from the store')),
		exists: () => Promise.resolve(true)
	};

	/** The candidate's current resume, uploaded and waiting for `resume.parse`. */
	async function pendingResume(who: Awaited<ReturnType<typeof person>>) {
		const { db } = database;
		const [file] = await db
			.insert(files)
			.values({
				ownerUserId: who.userId,
				purpose: 'resume',
				storageKey: `resumes/${randomBytes(8).toString('hex')}`,
				sha256,
				sizeBytes: bytes.byteLength,
				declaredName: 'cv.txt',
				detectedMime: 'text/plain',
				status: 'uploaded'
			})
			.returning();
		if (!file) throw new Error('file not inserted');
		const [resume] = await db
			.insert(resumeDocuments)
			.values({ candidateId: who.candidateId, fileId: file.id, seq: 1, isCurrent: true, parseStatus: 'pending' })
			.returning();
		if (!resume) throw new Error('resume not inserted');
		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'resume.parse',
				{ resume_document_id: resume.id },
				{ inputVersion: resume.id, createdBy: { kind: 'user', id: who.userId } }
			)
		);
		return { resumeDocumentId: resume.id, fileId: file.id };
	}

	/** The processing consent lapses while the profile stays, as when a new version asks to sign again. */
	async function lapse(candidateId: string) {
		await database.db.insert(consentEvents).values({
			subjectCandidateId: candidateId,
			kind: 'pd_processing',
			documentId: await documentId('pd_processing'),
			action: 'lapse',
			signerKind: 'system',
			method: 'system',
			evidence: { cause: 'test' },
			reason: 'test',
			occurredAt: new Date()
		});
	}

	async function runParse(parser: Docparse) {
		const claimed = (await claimJob(database.db, 'revocation-test', [
			'resume.parse'
		])) as ClaimedJob<'resume.parse'> | null;
		if (!claimed) throw new Error('the parse is not due');
		const handler = createResumeParseHandler({ store: () => store, parser: () => parser });
		const result = await handler.run({
			job: claimed,
			db: database.db,
			signal: new AbortController().signal,
			requestId: `job:${claimed.id}`,
			log
		});
		return completeJob(database.db, claimed, result);
	}

	async function resumeState(resumeDocumentId: string, fileId: string) {
		const [row] = await database.db
			.select({ parseStatus: resumeDocuments.parseStatus, parseError: resumeDocuments.parseError, file: files.status })
			.from(resumeDocuments)
			.innerJoin(files, eq(files.id, resumeDocuments.fileId))
			.where(and(eq(resumeDocuments.id, resumeDocumentId), eq(files.id, fileId)));
		return row;
	}

	const corrupt: DocparseResult = {
		ok: false,
		error: { code: 'corrupt', retryable: false, message: 'the file does not open' }
	};

	it('fails at once without reading the file when the consent is gone before the parse', async () => {
		const who = await person();
		const resume = await pendingResume(who);
		await lapse(who.candidateId);
		const parse = vi.fn(() => Promise.resolve(corrupt));
		expect(await runParse({ parse })).toBe('succeeded');
		expect(parse).not.toHaveBeenCalled();
		expect(await resumeState(resume.resumeDocumentId, resume.fileId)).toEqual({
			parseStatus: 'failed',
			parseError: 'no_processing_consent',
			file: 'rejected'
		});
	});

	it('records the lapse instead of the result when the consent is gone while the parser works', async () => {
		const who = await person();
		const resume = await pendingResume(who);
		const parse = vi.fn(async () => {
			await lapse(who.candidateId);
			return corrupt;
		});
		expect(await runParse({ parse })).toBe('succeeded');
		expect(parse).toHaveBeenCalledOnce();
		expect(await resumeState(resume.resumeDocumentId, resume.fileId)).toEqual({
			parseStatus: 'failed',
			parseError: 'no_processing_consent',
			file: 'rejected'
		});
	});

	it("records the parser's own code while the consent holds", async () => {
		const who = await person();
		const resume = await pendingResume(who);
		expect(await runParse({ parse: () => Promise.resolve(corrupt) })).toBe('succeeded');
		expect(await resumeState(resume.resumeDocumentId, resume.fileId)).toEqual({
			parseStatus: 'failed',
			parseError: 'corrupt',
			file: 'rejected'
		});
	});
});
