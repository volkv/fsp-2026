// The candidate's consents, resume and the deletion of the account through the public API (docs/contracts.md, section
// 5): the operations run as their routes run them, with the actor the hooks establish, over the same services as the
// cabinet pages. Covered: each operation for its owner and its refusals — without a session, by an API key, by a
// company member, on another candidate's rows; the upload of a resume as `multipart/form-data` with a file of another
// type refused; the reading of the resume with the quotes of its fields; the deletion after a fresh sign-in only, and
// its repetition.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Actor } from '$lib/server/access/actor';
import { runOperation, type Operation } from '$lib/server/api/operation';
import type { ApiServices } from '$lib/server/api/services';
import * as account from '$lib/server/api/v1/account';
import * as consents from '$lib/server/api/v1/consents';
import * as resumes from '$lib/server/api/v1/resumes';
import { registryNotConfigured } from '$lib/server/companies/registry';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	candidates,
	consentEvents,
	documentExtractions,
	erasureLedger,
	productPolicies,
	resumeDocuments,
	users
} from '$lib/server/db/schema';
import { JobFailure } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import type { MailMessage } from '$lib/server/mail/mailer';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import { fail } from '$lib/server/ml/result';
import type { Redis } from '$lib/server/redis';
import { createResumeExtractHandler } from '$lib/server/resumes/extract-job';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createPublishedDocument,
	createUser,
	randomSha256
} from '../helpers/factories';
import { memoryStore } from '../helpers/storage';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const DAY = 86_400_000;

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 8)
});

let database: TestDatabase;
let redis: Redis;
let services: ApiServices;
let documents: Record<'pd' | 'catalog' | 'telegram', string>;
const store = memoryStore();
const letters: MailMessage[] = [];

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	const { db } = database;
	documents = {
		pd: (await createPublishedDocument(db, 'pd_processing')).id,
		catalog: (await createPublishedDocument(db, 'catalog_visibility')).id,
		telegram: (await createPublishedDocument(db, 'telegram_notifications')).id
	};
	await db.insert(productPolicies).values({
		kind: 'minor_policy',
		version: 1,
		params: { enabled: false, authority_methods: ['in_person'] },
		effectiveFrom: new Date(Date.now() - DAY)
	});
	redis = createClient({ url: inject('redisUrl') });
	await redis.connect();
	services = {
		db,
		redis: () => Promise.resolve(redis),
		crypto,
		mailer: {
			send: (message) => {
				letters.push(message);
				return Promise.resolve({ ok: true, value: { messageId: `m-${letters.length}` } });
			}
		},
		store,
		registry: registryNotConfigured,
		models: {
			embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
			rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' })),
			extract: () => Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' })),
			extractModelKey: () => Promise.resolve(null)
		},
		receiptSigner: createReceiptSigner({ issuer: 'http://app.test', keyId: 'test-1', seed: Buffer.alloc(32, 9) }),
		appOrigin: 'http://app.test',
		testResults: GRADE_DECISION_RESULTS,
		now: () => new Date()
	};
}, 300_000);

afterAll(async () => {
	redis.destroy();
	await database.drop();
});

// --- Requests -------------------------------------------------------------------------------------------------------

interface Call {
	actor?: Actor;
	params?: Record<string, string>;
	/** A JSON body. */
	body?: unknown;
	/** A `multipart/form-data` body. */
	form?: FormData;
}

interface Answer {
	status: number;
	json: Record<string, unknown> & { error?: { code: string; details?: { path?: string; code: string }[] } };
	text: string;
}

let requests = 0;

/** Runs the operation the way its route does, after the hooks have set the request id and the actor. */
async function call(operation: Operation, input: Call = {}): Promise<Answer> {
	const path = operation.path.replace(/\{(\w+)\}/gu, (_, name: string) => {
		const value = input.params?.[name];
		if (value === undefined) throw new Error(`parameter ${name} of ${operation.id} is missing`);
		return value;
	});
	const url = new URL(`http://app.test/api/v1${path}`);
	const request = new Request(url, {
		method: operation.method,
		...(input.form !== undefined
			? { body: input.form }
			: input.body !== undefined
				? { body: JSON.stringify(input.body), headers: { 'content-type': 'application/json' } }
				: {})
	});
	const response = await runOperation(operation, services, {
		request,
		url,
		params: input.params ?? {},
		locals: { requestId: `self-${++requests}`, actor: input.actor ?? { kind: 'anonymous' } },
		getClientAddress: () => '127.0.0.1'
	});
	const text = await response.text();
	return {
		status: response.status,
		json: text.length === 0 ? {} : (JSON.parse(text) as Answer['json']),
		text
	};
}

function expectError(answer: Answer, status: number, code: string): void {
	expect(answer.status, answer.text).toBe(status);
	expect(answer.json.error?.code).toBe(code);
}

// --- Fixtures -------------------------------------------------------------------------------------------------------

const session = (userId: string, authTime = new Date()): Actor => ({
	kind: 'session',
	userId,
	sessionHash: randomSha256(),
	authTime,
	authMethod: 'password',
	csrfToken: 'csrf'
});

/** An adult candidate with `pd_processing` in effect unless said otherwise, and their session. */
async function candidate(options: { processingConsent?: boolean } = {}) {
	const email = `self-${randomBytes(4).toString('hex')}@example.org`;
	const user = await createUser(database.db, {
		emailEnc: crypto.encrypt(email, 'users.email'),
		emailHmac: crypto.lookupHmac('email', email)
	});
	const row = await createCandidate(database.db, { userId: user.id }, options);
	return { id: row.id, userId: user.id, actor: session(user.id) };
}

/** An owner of a verified company: a signed-in person without a candidate profile. */
async function member() {
	const company = await createCompany(database.db, { status: 'verified' });
	const owner = await createMember(database.db, company.id);
	if (!owner.userId) throw new Error('member without user');
	return { companyId: company.id, actor: session(owner.userId) };
}

/** What the hooks establish for a request with a valid API key of a company. */
const apiKeyActor = (companyId: string, userId: string): Actor => ({
	kind: 'api_key',
	apiKeyId: randomSha256().slice(0, 32),
	companyId,
	memberId: randomSha256().slice(0, 32),
	userId,
	permissions: ['candidate.card.read']
});

const PDF = new TextEncoder().encode(
	'%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'
);

function resumeForm(bytes: Uint8Array, name: string): FormData {
	const form = new FormData();
	form.set('file', new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }));
	return form;
}

// A parsed resume as `docparse` leaves it: the blocks of the text with code point offsets.
const RESUME_BLOCKS = [
	'Иванова Мария Сергеевна',
	'Телефон: +7 (912) 345-67-89 · Telegram: @maria_dev',
	'Опыт работы',
	'2021 — 2024',
	'Python-разработчик',
	'ООО «Пример»',
	'Навыки: Python, PostgreSQL, Docker'
];

const log = createLogger({ service: 'test' });

/** The parse of an uploaded resume as the worker records it, then `resume.extract` by the rules. */
async function parseAndExtract(resumeDocumentId: string): Promise<void> {
	const { db } = database;
	let offset = 0;
	const blocks = RESUME_BLOCKS.map((text, index) => {
		const block = {
			id: `p1-b${String(index + 1).padStart(3, '0')}`,
			page: 1,
			kind: index === 2 ? 'heading' : 'paragraph',
			column: null,
			start: offset,
			end: offset + Array.from(text).length
		};
		offset = block.end + 1;
		return block;
	});
	await db.update(resumeDocuments).set({ parseStatus: 'parsed' }).where(eq(resumeDocuments.id, resumeDocumentId));
	const [extraction] = await db
		.insert(documentExtractions)
		.values({
			resumeDocumentId,
			extractorName: 'docparse',
			extractorVersion: '1.0.0+test',
			inputSha256: randomSha256(),
			status: 'complete',
			text: RESUME_BLOCKS.join('\n'),
			blocks,
			flags: { ocrUsed: false, incompleteReasons: [] }
		})
		.returning();
	if (!extraction) throw new Error('extraction not inserted');
	await db.transaction((tx) =>
		enqueueJob(
			tx,
			'resume.extract',
			{ extraction_id: extraction.id },
			{ inputVersion: '1', createdBy: { kind: 'system' } }
		)
	);
	const claimed = await claimJob(db, 'worker-test', ['resume.extract']);
	if (claimed?.type !== 'resume.extract') throw new Error('no resume.extract job');
	const job = {
		...claimed,
		payload: JOB_TYPES['resume.extract'].payload.parse(claimed.payload)
	} as ClaimedJob<'resume.extract'>;
	const handler = createResumeExtractHandler({
		adapter: () => ({
			extract: () => Promise.resolve(fail('disabled', 'extract: off in the test', { reason: 'test' }))
		}),
		crypto: () => crypto,
		now: () => new Date()
	});
	try {
		const result = await handler.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: log.child({ job_id: job.id })
		});
		await completeJob(db, job, result);
	} catch (error) {
		if (error instanceof JobFailure) throw new Error(`the extraction failed: ${error.code}`, { cause: error });
		throw error;
	}
}

/** Uploads a resume through the API and reads it to its fields; the ids of the upload and its first claim and entry. */
async function readResume(owner: { actor: Actor }) {
	const uploaded = await call(resumes.uploadMyResume, { actor: owner.actor, form: resumeForm(PDF, 'cv.pdf') });
	expect(uploaded.status, uploaded.text).toBe(202);
	const resumeId = String(uploaded.json.resume_id);
	await parseAndExtract(resumeId);
	const current = await call(resumes.getMyCurrentResume, { actor: owner.actor });
	expect(current.status, current.text).toBe(200);
	const claims = current.json.claims as { id: string; quote: { block_id: string; text: string } }[];
	const experience = current.json.experience as { id: string }[];
	const [claim] = claims;
	const [entry] = experience;
	if (!claim || !entry) throw new Error('the rules extracted no claim or no experience entry');
	return { resumeId, claimId: claim.id, entryId: entry.id, current };
}

// --- Consents -------------------------------------------------------------------------------------------------------

describe('consents through the API', () => {
	it('shows each kind with the text in force, and only to the candidate themselves', async () => {
		const owner = await candidate();
		const answer = await call(consents.getMyConsents, { actor: owner.actor });
		expect(answer.status, answer.text).toBe(200);
		expect(answer.json).toMatchObject({
			age_regime: 'adult',
			pd_processing: { own_signed: true, effective: true, document: null },
			catalog_visibility: {
				subject_granted: false,
				effective: false,
				hidden_reason: 'hidden_by_candidate',
				document: { document_id: documents.catalog }
			},
			telegram_notifications: { subject_granted: false, document: { document_id: documents.telegram } },
			fsp_import: { subject_granted: false, facts: 0 },
			contact_disclosure: []
		});

		expectError(await call(consents.getMyConsents), 401, 'unauthenticated');
		const company = await member();
		expectError(await call(consents.getMyConsents, { actor: company.actor }), 403, 'forbidden');
		expectError(
			await call(consents.getMyConsents, { actor: apiKeyActor(company.companyId, owner.userId) }),
			403,
			'forbidden'
		);
	});

	it('grants the catalog by the exact text and revokes it once', async () => {
		const owner = await candidate();
		const granted = await call(consents.grantMyConsent, {
			actor: owner.actor,
			params: { kind: 'catalog_visibility' },
			body: { document_id: documents.catalog, scope_fields: ['external_profiles'] }
		});
		expect(granted.status, granted.text).toBe(204);
		const [row] = await database.db
			.select({ visibility: candidates.visibility })
			.from(candidates)
			.where(eq(candidates.id, owner.id));
		expect(row?.visibility).toBe('catalog');
		const after = await call(consents.getMyConsents, { actor: owner.actor });
		expect(after.json.catalog_visibility).toMatchObject({
			subject_granted: true,
			effective: true,
			scope_fields: ['external_profiles']
		});

		// A text that is not the one in force is not signed.
		expectError(
			await call(consents.grantMyConsent, {
				actor: owner.actor,
				params: { kind: 'catalog_visibility' },
				body: { document_id: documents.telegram }
			}),
			409,
			'conflict'
		);
		// A field of another kind is refused rather than ignored.
		const misplaced = await call(consents.grantMyConsent, {
			actor: owner.actor,
			params: { kind: 'telegram_notifications' },
			body: { document_id: documents.telegram, scope_fields: ['external_profiles'] }
		});
		expectError(misplaced, 400, 'validation_failed');
		expect(misplaced.json.error?.details?.[0]?.path).toBe('scope_fields');

		const revoked = await call(consents.revokeMyConsent, {
			actor: owner.actor,
			params: { kind: 'catalog_visibility' },
			body: { reason: 'Нашла работу' }
		});
		expect(revoked.status, revoked.text).toBe(200);
		expect(revoked.json).toEqual({ withdrawn_facts: null });
		expectError(
			await call(consents.revokeMyConsent, { actor: owner.actor, params: { kind: 'catalog_visibility' }, body: {} }),
			409,
			'conflict'
		);
		const events = await database.db
			.select({ action: consentEvents.action })
			.from(consentEvents)
			.where(and(eq(consentEvents.subjectCandidateId, owner.id), eq(consentEvents.kind, 'catalog_visibility')));
		expect(events.map((event) => event.action).sort()).toEqual(['grant', 'revoke']);
	});

	it('signs the processing consent again only when the own side is not in force', async () => {
		const owner = await candidate({ processingConsent: false });
		const before = await call(consents.getMyConsents, { actor: owner.actor });
		expect(before.json.pd_processing).toMatchObject({
			own_signed: false,
			effective: false,
			document: { document_id: documents.pd }
		});
		const signed = await call(consents.grantMyConsent, {
			actor: owner.actor,
			params: { kind: 'pd_processing' },
			body: { document_id: documents.pd }
		});
		expect(signed.status, signed.text).toBe(204);
		const again = await call(consents.grantMyConsent, {
			actor: owner.actor,
			params: { kind: 'pd_processing' },
			body: { document_id: documents.pd }
		});
		expectError(again, 409, 'conflict');
		expect(again.json.error?.details?.[0]?.code).toBe('not_applicable');
	});

	it('refuses grants and revocations without a session, by a company member and of the processing consent', async () => {
		const company = await member();
		expectError(
			await call(consents.grantMyConsent, {
				params: { kind: 'catalog_visibility' },
				body: { document_id: documents.catalog }
			}),
			401,
			'unauthenticated'
		);
		expectError(
			await call(consents.grantMyConsent, {
				actor: company.actor,
				params: { kind: 'catalog_visibility' },
				body: { document_id: documents.catalog }
			}),
			403,
			'forbidden'
		);
		expectError(
			await call(consents.revokeMyConsent, { actor: company.actor, params: { kind: 'fsp_import' }, body: {} }),
			403,
			'forbidden'
		);
		// The processing consent is revoked by deleting the profile, not here.
		const owner = await candidate();
		expectError(
			await call(consents.revokeMyConsent, { actor: owner.actor, params: { kind: 'pd_processing' }, body: {} }),
			400,
			'validation_failed'
		);
	});
});

// --- Resume ---------------------------------------------------------------------------------------------------------

describe('resume through the API', () => {
	it('takes a PDF as multipart, lists it pending, and refuses another type, a JSON body and an API key', async () => {
		const owner = await candidate();
		const keysBefore = store.keys().length;
		const uploaded = await call(resumes.uploadMyResume, { actor: owner.actor, form: resumeForm(PDF, 'cv.pdf') });
		expect(uploaded.status, uploaded.text).toBe(202);
		expect(uploaded.json).toMatchObject({ seq: 1, parse_status: 'pending' });
		expect(store.keys().length).toBe(keysBefore + 1);

		const listed = await call(resumes.listMyResumes, { actor: owner.actor });
		expect(listed.status, listed.text).toBe(200);
		expect(listed.json).toMatchObject({
			processing_refusal: null,
			items: [
				{ resume_id: uploaded.json.resume_id, is_current: true, parse_status: 'pending', declared_name: 'cv.pdf' }
			]
		});

		const executable = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...randomBytes(64)]);
		const wrongType = await call(resumes.uploadMyResume, {
			actor: owner.actor,
			form: resumeForm(executable, 'cv.pdf')
		});
		expectError(wrongType, 400, 'validation_failed');
		expect(wrongType.json.error?.details?.[0]?.path).toBe('file');
		expectError(
			await call(resumes.uploadMyResume, { actor: owner.actor, body: { file: 'cv.pdf' } }),
			400,
			'validation_failed'
		);
		expect(store.keys().length).toBe(keysBefore + 1);

		const company = await member();
		expectError(
			await call(resumes.uploadMyResume, {
				actor: apiKeyActor(company.companyId, owner.userId),
				form: resumeForm(PDF, 'cv.pdf')
			}),
			403,
			'forbidden'
		);
		expectError(await call(resumes.listMyResumes, { actor: company.actor }), 403, 'forbidden');
		expectError(await call(resumes.listMyResumes), 401, 'unauthenticated');
	});

	it('refuses a resume without the processing consent', async () => {
		const owner = await candidate({ processingConsent: false });
		expectError(
			await call(resumes.uploadMyResume, { actor: owner.actor, form: resumeForm(PDF, 'cv.pdf') }),
			422,
			'policy_violation'
		);
	});

	it('reads the current resume with a quote of every field from the text of its block', async () => {
		const owner = await candidate();
		expectError(await call(resumes.getMyCurrentResume, { actor: owner.actor }), 404, 'not_found');

		const { current } = await readResume(owner);
		const body = current.json as {
			in_progress: boolean;
			document: { blocks: { id: string; text: string }[] };
			claims: { quote: { block_id: string; start: number; end: number; text: string } }[];
			experience: { quotes: { block_id: string; text: string }[] }[];
			suggestions: { field: string; quote: { block_id: string; text: string } }[];
		};
		expect(body.in_progress).toBe(false);
		const blocks = new Map(body.document.blocks.map((block) => [block.id, block.text]));
		expect([...blocks.values()]).toEqual(RESUME_BLOCKS);
		const quotes = [
			...body.claims.map((claim) => claim.quote),
			...body.experience.flatMap((entry) => entry.quotes),
			...body.suggestions.map((suggestion) => suggestion.quote)
		];
		expect(quotes.length).toBeGreaterThan(2);
		for (const quote of quotes) expect(blocks.get(quote.block_id)).toContain(quote.text);
		expect(body.suggestions.map((suggestion) => suggestion.field)).toContain('phone');

		const company = await member();
		expectError(await call(resumes.getMyCurrentResume, { actor: company.actor }), 403, 'forbidden');
	});

	it('records the decisions of the candidate on their own claims and entries, and not on another candidate’s', async () => {
		const owner = await candidate();
		const other = await candidate();
		const { claimId, entryId } = await readResume(owner);

		for (const [operation, params] of [
			[resumes.reviewMyResumeClaim, { claim_id: claimId }],
			[resumes.reviewMyResumeExperience, { entry_id: entryId }]
		] as const) {
			expectError(
				await call(operation, { actor: other.actor, params, body: { decision: 'reject' } }),
				404,
				'not_found'
			);
			const decided = await call(operation, { actor: owner.actor, params, body: { decision: 'confirm' } });
			expect(decided.status, decided.text).toBe(204);
		}
		const correction = {
			position_title: 'Backend-разработчик',
			role_key: null,
			organization_name: 'ООО «Пример»',
			period_from: '2021-02',
			period_to: null,
			is_current: true
		};
		expectError(
			await call(resumes.correctMyResumeExperience, {
				actor: other.actor,
				params: { entry_id: entryId },
				body: correction
			}),
			404,
			'not_found'
		);
		const corrected = await call(resumes.correctMyResumeExperience, {
			actor: owner.actor,
			params: { entry_id: entryId },
			body: correction
		});
		expect(corrected.status, corrected.text).toBe(204);
		const invalid = await call(resumes.correctMyResumeExperience, {
			actor: owner.actor,
			params: { entry_id: entryId },
			body: { ...correction, period_to: '2024-01' }
		});
		expectError(invalid, 400, 'validation_failed');
		expect(invalid.json.error?.details?.[0]?.path).toBe('period_to');

		const current = await call(resumes.getMyCurrentResume, { actor: owner.actor });
		const claim = (current.json.claims as { id: string; review: string }[]).find((item) => item.id === claimId);
		const entry = (current.json.experience as { id: string; review: string; position_title: string }[]).find(
			(item) => item.id === entryId
		);
		expect(claim?.review).toBe('confirmed');
		expect(entry).toMatchObject({ review: 'edited', position_title: 'Backend-разработчик' });
	});

	it('deletes the own resume with its file, and answers 404 to another candidate and to a repeat', async () => {
		const owner = await candidate();
		const other = await candidate();
		const { resumeId } = await readResume(owner);
		expectError(
			await call(resumes.deleteMyResume, { actor: other.actor, params: { resume_id: resumeId } }),
			404,
			'not_found'
		);
		const deleted = await call(resumes.deleteMyResume, { actor: owner.actor, params: { resume_id: resumeId } });
		expect(deleted.status, deleted.text).toBe(204);
		expect(await database.db.select().from(resumeDocuments).where(eq(resumeDocuments.id, resumeId))).toEqual([]);
		expectError(
			await call(resumes.deleteMyResume, { actor: owner.actor, params: { resume_id: resumeId } }),
			404,
			'not_found'
		);
	});
});

// --- Deletion of the account ----------------------------------------------------------------------------------------

describe('deletion of the account through the API', () => {
	it('tells what goes and what blocks it: the last owner of a company', async () => {
		const owner = await candidate();
		const overview = await call(account.getMyAccountDeletion, { actor: owner.actor });
		expect(overview.status, overview.text).toBe(200);
		expect(overview.json).toMatchObject({
			candidate: true,
			companies_with_contacts: 0,
			blockers: [],
			fresh_auth: true
		});

		const company = await member();
		const blocked = await call(account.getMyAccountDeletion, { actor: company.actor });
		expect(blocked.json).toMatchObject({ candidate: false, blockers: [{ code: 'last_owner' }] });
		const refused = await call(account.requestMyAccountDeletion, { actor: company.actor, body: { confirm: true } });
		expectError(refused, 409, 'conflict');
		expect(refused.json.error?.details?.[0]?.code).toBe('last_owner');

		expectError(await call(account.getMyAccountDeletion), 401, 'unauthenticated');
	});

	it('asks for a fresh sign-in and the confirmation, then deletes once: a repeat changes nothing', async () => {
		const owner = await candidate();
		const stale = await call(account.requestMyAccountDeletion, {
			actor: session(owner.userId, new Date(Date.now() - 3600_000)),
			body: { confirm: true }
		});
		expectError(stale, 403, 'forbidden');
		expect(stale.json.error?.details?.[0]?.code).toBe('stale_auth');
		expectError(
			await call(account.requestMyAccountDeletion, { actor: owner.actor, body: { confirm: false } }),
			400,
			'validation_failed'
		);
		expectError(
			await call(account.requestMyAccountDeletion, {
				actor: apiKeyActor((await member()).companyId, owner.userId),
				body: { confirm: true }
			}),
			403,
			'forbidden'
		);

		const sent = letters.length;
		const deleted = await call(account.requestMyAccountDeletion, {
			actor: owner.actor,
			body: { confirm: true, cause: 'processing_revoked', reason: 'Больше не ищу работу' }
		});
		expect(deleted.status, deleted.text).toBe(202);
		expect(deleted.json).toEqual({ status: 'deletion_pending', letter_sent: true });
		expect(letters.length).toBe(sent + 1);
		const [user] = await database.db.select({ status: users.status }).from(users).where(eq(users.id, owner.userId));
		expect(user?.status).toBe('deletion_pending');
		const [revocation] = await database.db
			.select({ action: consentEvents.action, reason: consentEvents.reason })
			.from(consentEvents)
			.where(and(eq(consentEvents.subjectCandidateId, owner.id), eq(consentEvents.action, 'revoke')));
		expect(revocation).toEqual({ action: 'revoke', reason: 'Больше не ищу работу' });

		const repeat = await call(account.requestMyAccountDeletion, { actor: owner.actor, body: { confirm: true } });
		expectError(repeat, 409, 'conflict');
		expect(repeat.json.error?.details?.[0]?.code).toBe('already_requested');
		expect(letters.length).toBe(sent + 1);
		expect(await database.db.select().from(erasureLedger).where(eq(erasureLedger.userId, owner.userId))).toHaveLength(
			1
		);
		const requested = await database.db
			.select({ id: auditEvents.id })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'account.deletion_requested'), eq(auditEvents.objectId, owner.userId)));
		expect(requested).toHaveLength(1);
	});
});
