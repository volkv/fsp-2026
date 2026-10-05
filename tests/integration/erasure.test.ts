// Deleting an account and `account.purge` (docs/domain.md, sections 3.1, 5.3, 19.1, 19.2): a candidate with the whole
// pipeline behind the profile — a parsed resume in the bucket, FSP achievements with receipts, a published evidence run, a
// category with an objection, section vectors, matches with vacancies, an invitation accepted with contacts handed over and one left open — deletes
// the account. The request takes the profile out at once; the purge removes every row that names the person, their
// objects, sessions and counters, and keeps only what the model keeps: the journal, the disclosure with the consent it
// proves, the invitation tombstone, the tombstones of the account and the profile, the erasure ledger. A failure of the
// bucket fails the attempt with the rows in place, and the next attempt finishes without losses. Every foreign key to a
// person has a decision of the purge. The last owner of a company and a staff account are refused.
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
import { registerFailure } from '$lib/server/auth/lockout';
import { createSession, type SessionRef } from '$lib/server/auth/sessions';
import { grantCatalogVisibility } from '$lib/server/candidates/consents';
import { createProfileEmbedHandler } from '$lib/server/candidates/embed-job';
import { createEvidenceHandler } from '$lib/server/evidence/job';
import { processingAllowed } from '$lib/server/consent/processing';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	apiKeys,
	athleteLinks,
	auditEvents,
	candidates,
	evidenceRuns,
	assessmentObjections,
	candidateCategories,
	claims,
	companyMembers,
	consentEvents,
	disclosures,
	documentExtractions,
	embeddingSpaces,
	embeddings,
	erasureLedger,
	externalIdentities,
	files,
	hiringProcesses,
	invitationResponses,
	invitations,
	invitationTerms,
	jobs,
	matchScores,
	mlResults,
	notifications,
	resumeDocuments,
	sourceFacts,
	staffRoles,
	users,
	verificationReceipts
} from '$lib/server/db/schema';
import type { Docparse, ParseRequest } from '$lib/server/documents/docparse';
import { foreignKeyColumns } from '$lib/server/demo/graph';
import { drainJobs } from '$lib/server/demo/queue';
import { fileComplaint } from '$lib/server/complaints/service';
import { compareWithErasurePlan, erasedColumns, ERASURE_PLAN } from '$lib/server/erasure/plan';
import { createAccountPurgeHandler } from '$lib/server/erasure/purge';
import { declareGrade } from '$lib/server/grades/declarations';
import { gradeSources, type GradeSources } from '$lib/server/grades/sources';
import { submitSurvey } from '$lib/server/grades/surveys';
import { requestAccountDeletion } from '$lib/server/erasure/request';
import { HttpAchievementsSource } from '$lib/server/fsp/adapter';
import { ServiceGrantIssuer } from '$lib/server/fsp/grant';
import { loadProjectionTaxonomy } from '$lib/server/fsp/projection';
import { createReceiptSigner, verifyReceipt } from '$lib/server/fsp/receipts';
import { createFspSyncHandler } from '$lib/server/fsp/sync';
import type { InvitationDeps } from '$lib/server/invitations/deps';
import { respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation } from '$lib/server/invitations/send';
import { handlerRegistry, JobFailure, type JobHandler } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import type { Mailer, MailMessage } from '$lib/server/mail/mailer';
import { createMatchRefreshHandler } from '$lib/server/matching/refresh';
import type { EmbedRequest } from '$lib/server/ml/adapter';
import { fail, ok } from '$lib/server/ml/result';
import type { Redis } from '$lib/server/redis';
import { createResumeExtractHandler } from '$lib/server/resumes/extract-job';
import { createResumeParseHandler } from '$lib/server/resumes/parse-job';
import { uploadResume } from '$lib/server/resumes/upload';
import { S3ObjectStore, StorageError, type ObjectStore } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { codePointLength } from '$lib/text/offsets';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { testEnvironment } from '../helpers/environment';
import { decide } from '../helpers/categories';
import { createCompany, createMember, createOwnVacancy, createUser, offerTerms } from '../helpers/factories';
import { FSP_MOCK_CREDENTIALS, startFspMock, type FspMock } from '../helpers/fsp-mock';
import { startStorage, type TestStorage } from '../helpers/storage';

const ROOT = new URL('../../', import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, ROOT));
const REDIS_DATABASE = 12;
const SPACE = 'erasure-space@r1/q:none/d:none/mean/l2/4/t512/sections-v1';

const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

let database: TestDatabase;
let storage: TestStorage;
let s3: ObjectStore;
let mock: FspMock;
let redis: Redis;
let taxonomyVersionId: string;

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});
const log = createLogger({}, () => undefined);
const meta = { requestId: 'erasure-test', ip: '127.0.0.1', userAgent: 'vitest', sessionHash: 'a'.repeat(64) };
const letters: MailMessage[] = [];
const mailer: Mailer = {
	send(message) {
		letters.push(message);
		return Promise.resolve({ ok: true, value: { messageId: `m-${letters.length}` } });
	}
};

/** The bucket, with removals refused while `failing` is set: the storage is down for the purge. */
class FlakyStore implements ObjectStore {
	failing = false;
	deleteCalls = 0;
	readonly inner: ObjectStore;
	constructor(inner: ObjectStore) {
		this.inner = inner;
	}
	put(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string) {
		return this.inner.put(key, bytes, contentType);
	}
	get(key: string, signal?: AbortSignal) {
		return this.inner.get(key, signal);
	}
	exists(key: string) {
		return this.inner.exists(key);
	}
	delete(key: string): Promise<void> {
		this.deleteCalls += 1;
		if (this.failing) return Promise.reject(new StorageError('storage is down', { retryable: true }));
		return this.inner.delete(key);
	}
}
let store: FlakyStore;

/** The parse of a text file as `docparse` answers it: one block per paragraph, offsets in code points. */
const textParser: Docparse = {
	parse(request: ParseRequest) {
		const text = new TextDecoder().decode(request.bytes).normalize('NFC').replace(/\r\n/g, '\n');
		const blocks: { id: string; page: null; kind: 'paragraph'; column: null; start: number; end: number }[] = [];
		let offset = 0;
		for (const part of text.split('\n\n')) {
			const start = offset + (codePointLength(part) - codePointLength(part.trimStart()));
			const end = offset + codePointLength(part.trimEnd());
			if (end > start) {
				blocks.push({
					id: `d-b${String(blocks.length + 1).padStart(3, '0')}`,
					page: null,
					kind: 'paragraph',
					column: null,
					start,
					end
				});
			}
			offset += codePointLength(part) + 2;
		}
		return Promise.resolve({
			ok: true,
			value: {
				schemaVersion: 'docparse/v1',
				extractor: { name: 'docparse-text-test', version: '1' },
				input: {
					sha256: createHash('sha256').update(request.bytes).digest('hex'),
					sizeBytes: request.bytes.byteLength,
					detectedFormat: 'txt',
					pageCount: null
				},
				status: 'complete',
				text,
				blocks,
				flags: { ocrUsed: false, ocrPages: [], incompleteReasons: [], externalResourcesIgnored: false },
				stats: { durationMs: 1 }
			}
		});
	}
};

/** Section vectors of four dimensions from the text: enough for the space of the test. */
const embedder = {
	embed(request: EmbedRequest) {
		return Promise.resolve(
			ok({
				spaceId: request.spaceId,
				vectors: request.inputs.map((input) => {
					const v = [1, 0, 0, 0];
					for (let i = 0; i < input.text.length; i++) v[i % 4] = (v[i % 4] ?? 0) + input.text.charCodeAt(i) / 1000;
					const norm = Math.hypot(...v);
					return { id: input.id, vector: v.map((x) => x / norm) };
				}),
				latencyMs: 1
			})
		);
	}
};

const MODELS_OFF = {
	embed: () => Promise.resolve(fail('disabled', 'embed: off in the test', { reason: 'test' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: off in the test', { reason: 'test' }))
};

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
	const taxonomy = await loadProjectionTaxonomy(database.db);
	if (!taxonomy) throw new Error('the taxonomy was not published');
	taxonomyVersionId = taxonomy.versionId;
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
	storage = await startStorage();
	s3 = new S3ObjectStore(storage.settings);
	store = new FlakyStore(s3);
	mock = await startFspMock({ athletes: 200 });
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
	Object.assign(
		env,
		testEnvironment({ DATABASE_URL: database.url, REDIS_URL: `${inject('redisUrl')}/${REDIS_DATABASE}` })
	);
	pipeline = handlerRegistry([
		createResumeParseHandler({ store: () => store, parser: () => textParser }),
		createResumeExtractHandler({
			adapter: () => ({
				extract: () => Promise.resolve(fail('disabled', 'extract: off in the test', { reason: 'test' }))
			}),
			crypto: () => crypto,
			now: () => new Date()
		}),
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
		createEvidenceHandler(),
		createProfileEmbedHandler({ models: () => embedder, spaceId: () => SPACE, now: () => new Date() }),
		createMatchRefreshHandler(() => MODELS_OFF)
	]);
}, 240_000);

afterAll(async () => {
	await mock.stop();
	redis.destroy();
	await storage.container.stop();
	await database.drop();
});

const invitationDeps = (): InvitationDeps => ({
	db: database.db,
	crypto,
	now: () => new Date()
});

function authDeps(): AuthDeps {
	return { db: database.db, redis, crypto, mailer, appOrigin: 'http://localhost:57173', now: () => new Date() };
}

async function documentId(kind: 'pd_processing' | 'catalog_visibility' | 'fsp_import' | 'contact_disclosure') {
	const document = await currentDocument(database.db, kind, new Date());
	if (!document) throw new Error(`no current ${kind}`);
	return document.id;
}

const candidateSubject = (userId: string, candidateId: string): AccessSubject => ({
	userId,
	via: 'session',
	candidate: { id: candidateId, status: 'active' },
	membership: null,
	staff: { operator: false, admin: false, extraPermissions: [] }
});

async function account(email: string) {
	return createUser(database.db, {
		emailEnc: crypto.encrypt(email, 'users.email'),
		emailHmac: crypto.lookupHmac('email', email),
		emailVerifiedAt: new Date(),
		displayName: 'Тест'
	});
}

/** An adult candidate who registered an hour ago and signed the processing consent of the published text. */
async function candidateAccount(name: string) {
	const email = `${name}-${randomBytes(4).toString('hex')}@example.org`;
	const user = await account(email);
	const [row] = await database.db
		.insert(candidates)
		.values({
			userId: user.id,
			status: 'active',
			searchStatus: 'active',
			preferences: {},
			desiredRoleKeys: ['backend'],
			// Confirmed by a document: the birth year of the FSP record does not turn it into a conflict (domain 7.2).
			birthDate: '1997-04-17',
			birthDatePrecision: 'day',
			birthDateSource: 'operator_document',
			birthDateStatus: 'verified',
			birthDateVerifiedAt: new Date(),
			lastNameEnc: crypto.encrypt('Родионов', 'candidates.last_name'),
			firstNameEnc: crypto.encrypt('Степан', 'candidates.first_name'),
			phoneEnc: crypto.encrypt('+79990001122', 'candidates.phone')
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
	return { email, userId: user.id, candidateId: row.id, subject: candidateSubject(user.id, row.id) };
}

async function sessionOf(userId: string, authTime = new Date()): Promise<SessionRef> {
	const { session } = await createSession(
		redis,
		{ userId, authMethod: 'password', authTime, ip: null, ua: null },
		new Date()
	);
	return { hash: session.hash, userId, authTime };
}

async function employer(label: string) {
	const company = await createCompany(database.db, { displayName: `Компания ${label}` });
	const owner = await account(`owner-${label}-${randomBytes(3).toString('hex')}@example.org`);
	const member = await createMember(database.db, company.id, { userId: owner.id });
	const subject: AccessSubject = {
		userId: owner.id,
		via: 'session',
		candidate: null,
		membership: {
			memberId: member.id,
			companyId: company.id,
			role: 'owner',
			status: 'active',
			companyStatus: 'verified'
		},
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
	return { company, member, owner, subject };
}

/** Runs the queued jobs of the pipeline until none is left. */
async function drain() {
	await drainJobs(database.db, pipeline, [...pipeline.keys()], { since: new Date(0), log, label: 'erasure-test' });
}

/** One capture of `account.purge` as the worker does it: the result is written, or the failure is recorded. */
async function purgeOnce(
	handler: JobHandler<'account.purge'>,
	userId: string
): Promise<'succeeded' | 'queued' | 'failed'> {
	const claimed = (await claimJob(database.db, 'erasure-test', [
		'account.purge'
	])) as ClaimedJob<'account.purge'> | null;
	if (!claimed) throw new Error('no account.purge job is due');
	// Each test purges its own account: a job of another one left behind is a failure of that test.
	expect(claimed.payload.user_id).toBe(userId);
	try {
		const result = await handler.run({
			job: claimed,
			db: database.db,
			signal: new AbortController().signal,
			requestId: `job:${claimed.id}`,
			log
		});
		const outcome = await completeJob(database.db, claimed, result);
		if (outcome !== 'succeeded') throw new Error(`purge ended ${outcome}`);
		return outcome;
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		const outcome = await failJob(database.db, claimed, {
			code: error.code,
			retryable: error.retryable,
			message: error.message
		});
		if (outcome !== 'queued' && outcome !== 'failed') {
			throw new Error(`purge failure ended ${outcome}`, { cause: error });
		}
		return outcome;
	}
}

const purgeHandler = createAccountPurgeHandler(() => Promise.resolve({ db: database.db, redis, store }));

async function count(table: string, column: string, ids: readonly string[]): Promise<number> {
	const [row] = await database.sql.unsafe<{ n: number }[]>(
		`select count(*)::int as n from ${table} where ${column}::text = any($1::text[])`,
		[ids as string[]]
	);
	return row?.n ?? 0;
}

describe('erasure plan', () => {
	it('has a decision for every foreign key to an account or a profile', async () => {
		const keys = await foreignKeyColumns(database.db);
		expect(compareWithErasurePlan(keys)).toEqual({ undecided: [], stale: [] });
		// A new key to a person without a decision is named, a decision without its key too.
		const probe = compareWithErasurePlan([
			...keys.filter((key) => !(key.table === 'claims' && key.column === 'candidate_id')),
			{ table: 'erasure_probe', column: 'user_id', references: 'users' }
		]);
		expect(probe).toEqual({ undecided: ['erasure_probe.user_id'], stale: ['claims.candidate_id'] });
		expect(Object.keys(ERASURE_PLAN).length).toBeGreaterThan(40);
	});
});

describe('deleting a candidate with the whole pipeline behind the profile', () => {
	it('takes the profile out at once and the purge removes every row and object of the person', async () => {
		const { db } = database;
		const hero = await candidateAccount('hero');

		// Resume in the bucket, parsed and extracted by the rules.
		const uploaded = await uploadResume(
			{ db, store, now: () => new Date() },
			hero.subject,
			{
				bytes: new TextEncoder().encode(
					'Степан Родионов\n\nBackend-разработчик, ООО «Пример», 2020 — настоящее время\n\nGo, PostgreSQL, Kubernetes, Docker'
				),
				declaredName: 'resume.txt'
			},
			meta
		);
		// The survey and the declared grade with the snapshot of the hint (domain 12.2).
		const grades: GradeSources = {
			...gradeSources,
			releasedSpecializations: () => Promise.resolve(new Set(['backend']))
		};
		await submitSurvey(
			db,
			grades,
			hero.subject,
			{ direction: 'development', specialization: 'backend', declaredSkillKeys: ['go'], preferences: {} },
			meta
		);
		await declareGrade(db, grades, hero.subject, { specialization: 'backend', grade: 'middle' }, meta, new Date());
		// FSP achievements under the import consent, through the simulator.
		const fspId = await mock.heroId('Капитан, backend, МС');
		const [identity] = await db
			.insert(externalIdentities)
			.values({
				userId: hero.userId,
				issuer: mock.issuer,
				subject: fspId,
				linkedAt: new Date(),
				linkMethod: 'signup_via_provider'
			})
			.returning();
		if (!identity) throw new Error('identity not inserted');
		const [link] = await db
			.insert(athleteLinks)
			.values({
				userId: hero.userId,
				source: 'fsp',
				sourceAthleteId: fspId,
				basisIdentityId: identity.id,
				resolutionMethod: 'subject_equals_athlete_id',
				status: 'active',
				linkedAt: new Date()
			})
			.returning();
		if (!link) throw new Error('link not inserted');
		await db.insert(consentEvents).values({
			subjectCandidateId: hero.candidateId,
			kind: 'fsp_import',
			documentId: await documentId('fsp_import'),
			action: 'grant',
			signerKind: 'subject',
			signerUserId: hero.userId,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date(Date.now() - 60_000)
		});
		await db.transaction((tx) =>
			enqueueJob(tx, 'fsp.sync', { athlete_link_id: link.id }, { inputVersion: link.id, createdBy: { kind: 'system' } })
		);
		await grantCatalogVisibility(db, hero.subject, meta, {
			documentId: await documentId('catalog_visibility'),
			scopeFields: []
		});
		// Offers of two companies: one accepted with contacts, one left open (a company has one line per candidate).
		const company = await employer('hero');
		const second = await employer('second');
		const accepted = await createOwnVacancy(db, {
			companyId: company.company.id,
			memberId: company.member.id,
			taxonomyVersionId
		});
		const open = await createOwnVacancy(
			db,
			{ companyId: second.company.id, memberId: second.member.id, taxonomyVersionId },
			{ title: 'Go-разработчик платформы' }
		);
		await drain();

		const facts = await db.select().from(sourceFacts).where(eq(sourceFacts.candidateId, hero.candidateId));
		expect(new Set(facts.map((fact) => fact.source))).toEqual(new Set(['resume', 'fsp']));
		const receipts = await db
			.select({ handle: verificationReceipts.handle })
			.from(verificationReceipts)
			.where(
				inArray(
					verificationReceipts.factId,
					facts.map((fact) => fact.id)
				)
			);
		expect(receipts.length).toBeGreaterThan(0);
		const [published] = await db
			.select({ id: evidenceRuns.id })
			.from(evidenceRuns)
			.where(and(eq(evidenceRuns.candidateId, hero.candidateId), eq(evidenceRuns.status, 'published')));
		expect(published).toBeDefined();
		expect(await db.select().from(embeddings).where(eq(embeddings.ownerId, hero.candidateId))).not.toHaveLength(0);
		expect(await db.select().from(matchScores).where(eq(matchScores.candidateId, hero.candidateId))).not.toHaveLength(
			0
		);

		const sentAccepted = await createInvitation(invitationDeps(), company.subject, meta, {
			...offerTerms({ vacancyId: accepted.id, salaryMin: 260_000, salaryMax: 340_000, message: 'Приглашаем' }),
			candidateId: hero.candidateId
		});
		await respondToInvitation(invitationDeps(), hero.subject, meta, sentAccepted.invitationId, {
			termsId: sentAccepted.termsId,
			decision: 'accept',
			discloseFields: ['full_name', 'email'],
			disclosureDocumentId: await documentId('contact_disclosure')
		});
		const sentOpen = await createInvitation(invitationDeps(), second.subject, meta, {
			...offerTerms({ vacancyId: open.id, salaryMin: 260_000, salaryMax: 340_000, message: 'И ещё одна' }),
			candidateId: hero.candidateId
		});
		const [disclosure] = await db.select().from(disclosures).where(eq(disclosures.candidateId, hero.candidateId));
		if (!disclosure) throw new Error('the acceptance handed over no contacts');
		// A complaint about the accepted offer: the candidate's own account of what happened (domain 13.13).
		const complaint = await fileComplaint(invitationDeps(), hero.subject, meta, sentAccepted.invitationId, {
			reasonCode: 'terms_mismatch',
			text: 'На собеседовании назвали вилку вдвое ниже'
		});
		expect(await db.select().from(notifications).where(eq(notifications.userId, hero.userId))).not.toHaveLength(0);
		// A category confirmed by a test and an objection to its decision: both are the candidate's (domain 23.2).
		const { decision } = await decide(db, hero.candidateId, { specialization: 'backend', grade: 'middle' });
		const [objection] = await db
			.insert(assessmentObjections)
			.values({
				candidateId: hero.candidateId,
				decisionId: decision.id,
				reason: 'Не согласен с оценкой',
				openedAt: sql`now()`,
				dueAt: sql`now() + interval '30 days'`,
				status: 'open'
			})
			.returning({ id: assessmentObjections.id });
		if (!objection) throw new Error('objection not inserted');

		// What the purge must remove, read before it.
		const resumeFiles = await db
			.select({ id: files.id, key: files.storageKey })
			.from(files)
			.where(eq(files.ownerUserId, hero.userId));
		expect(resumeFiles.map((file) => file.id)).toContain(uploaded.fileId);
		for (const file of resumeFiles) expect(await s3.exists(file.key)).toBe(true);
		const extractionIds = (
			await db
				.select({ id: documentExtractions.id })
				.from(documentExtractions)
				.where(eq(documentExtractions.resumeDocumentId, uploaded.resumeDocumentId))
		).map((row) => row.id);
		expect(extractionIds).not.toHaveLength(0);
		const runIds = (
			await db.select({ id: evidenceRuns.id }).from(evidenceRuns).where(eq(evidenceRuns.candidateId, hero.candidateId))
		).map((row) => row.id);
		const invitationIds = [sentAccepted.invitationId, sentOpen.invitationId];
		const session = await sessionOf(hero.userId);
		const other = await sessionOf(hero.userId);
		await registerFailure(redis, { emailHmac: crypto.lookupHmac('email', hero.email), ip: '10.0.0.1' });
		// A waiting recalculation of the profile, which the deletion cancels.
		const waiting = await db.transaction((tx) =>
			enqueueJob(
				tx,
				'evidence.compute',
				{ candidate_id: hero.candidateId },
				{ inputVersion: 'x', createdBy: { kind: 'system' } }
			)
		);

		// The request: at once, before any purge.
		const result = await requestAccountDeletion(authDeps(), meta, session, { cause: 'account_deleted' });
		expect(result).toEqual({ ok: true, letterSent: true });
		expect(letters.at(-1)?.to).toBe(hero.email);
		const [user] = await db.select().from(users).where(eq(users.id, hero.userId));
		expect(user).toMatchObject({ status: 'deletion_pending' });
		const [profile] = await db.select().from(candidates).where(eq(candidates.id, hero.candidateId));
		expect(profile).toMatchObject({ status: 'deletion_pending', visibility: 'hidden' });
		expect(await processingAllowed(db, hero.candidateId, new Date())).toBe(false);
		const [revocation] = await db
			.select()
			.from(consentEvents)
			.where(
				and(
					eq(consentEvents.subjectCandidateId, hero.candidateId),
					eq(consentEvents.kind, 'pd_processing'),
					eq(consentEvents.action, 'revoke')
				)
			);
		expect(revocation).toMatchObject({ signerKind: 'subject', signerUserId: hero.userId });
		const states = await db
			.select({ id: invitations.id, status: invitations.status })
			.from(invitations)
			.where(inArray(invitations.id, invitationIds));
		expect(new Map(states.map((row) => [row.id, row.status]))).toEqual(
			new Map([
				[sentAccepted.invitationId, 'accepted'],
				[sentOpen.invitationId, 'withdrawn']
			])
		);
		const [cancelled] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, waiting.jobId));
		expect(cancelled?.status).toBe('cancelled');
		expect(await redis.exists(`session:${session.hash}`)).toBe(0);
		expect(await redis.exists(`session:${other.hash}`)).toBe(0);
		const [ledger] = await db.select().from(erasureLedger).where(eq(erasureLedger.userId, hero.userId));
		expect(ledger).toMatchObject({ purgedAt: null });
		const requested = await db
			.select({ details: auditEvents.details })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'account.deletion_requested'), eq(auditEvents.objectId, hero.userId)));
		expect(requested).toMatchObject([{ details: { cause: 'account_deleted' } }]);
		// A second request changes nothing.
		expect(
			await requestAccountDeletion(authDeps(), meta, await sessionOf(hero.userId), { cause: 'account_deleted' })
		).toEqual({ ok: false, refusal: { reason: 'already_requested' } });

		// The purge.
		expect(await purgeOnce(purgeHandler, hero.userId)).toBe('succeeded');

		const ids = [hero.userId, hero.candidateId];
		for (const { table, column } of erasedColumns()) {
			expect({ table, column, rows: await count(table, column, ids) }).toEqual({ table, column, rows: 0 });
		}
		// Rows reached through another row of the person.
		expect(
			await count(
				'verification_receipts',
				'fact_id',
				facts.map((fact) => fact.id)
			)
		).toBe(0);
		expect(await count('document_extractions', 'id', extractionIds)).toBe(0);
		expect(await count('fsp_level_assignments', 'run_id', runIds)).toBe(0);
		expect(await count('skill_inferences', 'run_id', runIds)).toBe(0);
		expect(await count('candidate_categories', 'decision_id', [decision.id])).toBe(0);
		expect(await count('assessment_objections', 'id', [objection.id])).toBe(0);
		expect(await count('invitation_complaints', 'id', [complaint.id])).toBe(0);
		expect(await count('invitation_terms', 'invitation_id', invitationIds)).toBe(0);
		expect(await count('invitation_responses', 'invitation_id', invitationIds)).toBe(0);
		expect(await count('hiring_processes', 'invitation_id', invitationIds)).toBe(0);
		expect(await count('embeddings', 'owner_id', [hero.candidateId])).toBe(0);
		expect(
			await db
				.select({ id: mlResults.id })
				.from(mlResults)
				.where(inArray(sql`${mlResults.inputRef} ->> 'id'`, [hero.candidateId, ...extractionIds]))
		).toEqual([]);
		expect(
			await count(
				'files',
				'id',
				resumeFiles.map((file) => file.id)
			)
		).toBe(0);
		for (const file of resumeFiles) expect(await s3.exists(file.key)).toBe(false);
		for (const { handle } of receipts) expect(await verifyReceipt(db, handle)).toBeNull();
		expect(await redis.exists(`login_fail:acct:${crypto.lookupHmac('email', hero.email)}`)).toBe(0);

		// What stays: the disclosure with the consent event it proves, the invitation tombstones, the tombstones.
		expect(await db.select().from(disclosures).where(eq(disclosures.candidateId, hero.candidateId))).toHaveLength(1);
		const kept = await db
			.select({ id: consentEvents.id })
			.from(consentEvents)
			.where(eq(consentEvents.subjectCandidateId, hero.candidateId));
		expect(kept).toEqual([{ id: disclosure.consentEventId }]);
		const tombstones = await db
			.select({
				status: invitations.status,
				currentTermsId: invitations.currentTermsId,
				acceptedTermsId: invitations.acceptedTermsId,
				purgedAt: invitations.purgedAt
			})
			.from(invitations)
			.where(inArray(invitations.id, invitationIds));
		expect(tombstones).toHaveLength(2);
		for (const row of tombstones) {
			expect(row).toMatchObject({ currentTermsId: null, acceptedTermsId: null });
			expect(row.purgedAt).not.toBeNull();
		}
		const [gone] = await db.select().from(users).where(eq(users.id, hero.userId));
		expect(gone).toMatchObject({ status: 'deleted', emailEnc: null, emailHmac: null, displayName: null });
		expect(gone?.deletedAt).not.toBeNull();
		const [shell] = await db.select().from(candidates).where(eq(candidates.id, hero.candidateId));
		expect(shell).toMatchObject({
			status: 'deleted',
			lastNameEnc: null,
			firstNameEnc: null,
			phoneEnc: null,
			birthDate: null,
			preferences: {},
			desiredRoleKeys: []
		});
		const [purgedLedger] = await db.select().from(erasureLedger).where(eq(erasureLedger.userId, hero.userId));
		expect(purgedLedger?.purgedAt).not.toBeNull();
		const journal = await db
			.select({ action: auditEvents.action, details: auditEvents.details })
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.subjectCandidateId, hero.candidateId),
					inArray(auditEvents.action, ['account.purged', 'facts.purged'])
				)
			);
		expect(journal.filter((event) => event.action === 'account.purged')).toHaveLength(1);
		const purgedFacts = journal
			.filter((event) => event.action === 'facts.purged')
			.map((event) => event.details as { source: string; count: number });
		expect(new Map(purgedFacts.map((event) => [event.source, event.count]))).toEqual(
			new Map([
				['resume', facts.filter((fact) => fact.source === 'resume').length],
				['fsp', facts.filter((fact) => fact.source === 'fsp').length]
			])
		);
		// The company keeps its own: the vacancies, the member, the notification of the answer.
		expect(await db.select().from(companyMembers).where(eq(companyMembers.id, company.member.id))).toHaveLength(1);
		// Claims and runs of other people are untouched by construction; the claims of the hero are gone.
		expect(await db.select().from(claims).where(eq(claims.candidateId, hero.candidateId))).toEqual([]);
		expect(await db.select().from(evidenceRuns).where(inArray(evidenceRuns.id, runIds))).toEqual([]);
		expect(
			await db.select().from(candidateCategories).where(eq(candidateCategories.candidateId, hero.candidateId))
		).toEqual([]);
		expect(await db.select().from(resumeDocuments).where(eq(resumeDocuments.candidateId, hero.candidateId))).toEqual(
			[]
		);
		expect(await db.select().from(hiringProcesses).where(eq(hiringProcesses.candidateId, hero.candidateId))).toEqual(
			[]
		);
		expect(await db.select().from(invitationTerms).where(inArray(invitationTerms.invitationId, invitationIds))).toEqual(
			[]
		);
		expect(
			await db.select().from(invitationResponses).where(inArray(invitationResponses.invitationId, invitationIds))
		).toEqual([]);
	});

	it('repeats the purge after the bucket failed, without losing a row or an object', async () => {
		const { db } = database;
		const person = await candidateAccount('flaky');
		const uploaded = await uploadResume(
			{ db, store, now: () => new Date() },
			person.subject,
			{ bytes: new TextEncoder().encode('Резюме: Go, PostgreSQL'), declaredName: 'cv.txt' },
			meta
		);
		const [file] = await db.select().from(files).where(eq(files.id, uploaded.fileId));
		if (!file) throw new Error('file not stored');
		expect(
			await requestAccountDeletion(authDeps(), meta, await sessionOf(person.userId), { cause: 'account_deleted' })
		).toMatchObject({ ok: true });

		store.failing = true;
		const calls = store.deleteCalls;
		expect(await purgeOnce(purgeHandler, person.userId)).toBe('queued');
		expect(store.deleteCalls).toBeGreaterThan(calls);
		const [job] = await db
			.select({ status: jobs.status, lastError: jobs.lastError, id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.type, 'account.purge'), sql`${jobs.payload} ->> 'user_id' = ${person.userId}`));
		expect(job).toMatchObject({ status: 'queued', lastError: { code: 'storage_unavailable', retryable: true } });
		// Nothing was removed: the rows and the object wait for the next attempt.
		expect(
			await db.select().from(resumeDocuments).where(eq(resumeDocuments.id, uploaded.resumeDocumentId))
		).toHaveLength(1);
		expect(await db.select().from(files).where(eq(files.id, file.id))).toHaveLength(1);
		expect(await s3.exists(file.storageKey)).toBe(true);
		const [waiting] = await db.select({ status: users.status }).from(users).where(eq(users.id, person.userId));
		expect(waiting?.status).toBe('deletion_pending');

		store.failing = false;
		await db
			.update(jobs)
			.set({ runAfter: new Date(Date.now() - 1000) })
			.where(eq(jobs.id, job?.id ?? ''));
		expect(await purgeOnce(purgeHandler, person.userId)).toBe('succeeded');
		expect(await db.select().from(resumeDocuments).where(eq(resumeDocuments.id, uploaded.resumeDocumentId))).toEqual(
			[]
		);
		expect(await db.select().from(files).where(eq(files.id, file.id))).toEqual([]);
		expect(await s3.exists(file.storageKey)).toBe(false);
		const [done] = await db.select({ status: users.status }).from(users).where(eq(users.id, person.userId));
		expect(done?.status).toBe('deleted');
	});
});

describe('deleting an employer account', () => {
	it('refuses the last owner of a company and changes nothing', async () => {
		const { db } = database;
		const company = await employer('alone');
		const result = await requestAccountDeletion(authDeps(), meta, await sessionOf(company.owner.id), {
			cause: 'account_deleted'
		});
		expect(result).toEqual({
			ok: false,
			refusal: { reason: 'last_owner', companyName: company.company.displayName }
		});
		const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, company.owner.id));
		expect(user?.status).toBe('active');
		const [member] = await db.select().from(companyMembers).where(eq(companyMembers.id, company.member.id));
		expect(member?.status).toBe('active');
		expect(
			await db
				.select()
				.from(jobs)
				.where(sql`${jobs.payload} ->> 'user_id' = ${company.owner.id}`)
		).toEqual([]);
	});

	it('ends the membership of a recruiter with the keys they created, then purges the account', async () => {
		const { db } = database;
		const company = await employer('team');
		const recruiterUser = await account(`recruiter-${randomBytes(3).toString('hex')}@example.org`);
		const recruiter = await createMember(db, company.company.id, { userId: recruiterUser.id, role: 'recruiter' });
		const [key] = await db
			.insert(apiKeys)
			.values({
				companyId: company.company.id,
				createdByMemberId: recruiter.id,
				name: 'ATS',
				prefix: randomBytes(4).toString('hex'),
				secretHash: randomBytes(32).toString('hex'),
				permissions: ['catalog.search']
			})
			.returning();
		if (!key) throw new Error('key not inserted');

		const result = await requestAccountDeletion(authDeps(), meta, await sessionOf(recruiterUser.id), {
			cause: 'account_deleted'
		});
		expect(result).toEqual({ ok: true, letterSent: true });
		const [member] = await db.select().from(companyMembers).where(eq(companyMembers.id, recruiter.id));
		expect(member).toMatchObject({ status: 'removed', removedBy: recruiterUser.id });
		const [revoked] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
		expect(revoked?.revokedAt).not.toBeNull();

		expect(await purgeOnce(purgeHandler, recruiterUser.id)).toBe('succeeded');
		const [user] = await db.select().from(users).where(eq(users.id, recruiterUser.id));
		expect(user).toMatchObject({ status: 'deleted', emailEnc: null, emailHmac: null });
		// The team keeps its record of the member: the tombstone id stays named.
		const [record] = await db.select().from(companyMembers).where(eq(companyMembers.id, recruiter.id));
		expect(record?.userId).toBe(recruiterUser.id);
		for (const { table, column } of erasedColumns()) {
			expect({ table, column, rows: await count(table, column, [recruiterUser.id]) }).toEqual({
				table,
				column,
				rows: 0
			});
		}
	});

	it('refuses an account with a staff role in force and a stale authentication', async () => {
		const { db } = database;
		const operator = await account(`operator-${randomBytes(3).toString('hex')}@example.org`);
		await db.insert(staffRoles).values({ userId: operator.id, role: 'operator', grantedAt: new Date() });
		expect(
			await requestAccountDeletion(authDeps(), meta, await sessionOf(operator.id), { cause: 'account_deleted' })
		).toEqual({ ok: false, refusal: { reason: 'staff_role' } });

		const person = await candidateAccount('stale');
		const stale = await sessionOf(person.userId, new Date(Date.now() - 11 * 60_000));
		expect(await requestAccountDeletion(authDeps(), meta, stale, { cause: 'account_deleted' })).toEqual({
			ok: false,
			refusal: { reason: 'stale_auth' }
		});
		const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, person.userId));
		expect(user?.status).toBe('active');
	});
});
