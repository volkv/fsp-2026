// A candidate aged 14–17 whose representative has not signed `pd_processing` has signed only their own consent
// (docs/domain.md, sections 6, 7.3): the profile is open, but nothing of theirs is processed. A resume is refused before
// it is stored — on the page and in the service — and so is an attempt of a platform test; the profile gets no vectors.
// A consent that lapses while a background job runs stops the job before the parser or the model and drops its result.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, ne } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Actor } from '$lib/server/access/actor';
import { startAttempt } from '$lib/server/assessments/attempts';
import { createProfileEmbedHandler } from '$lib/server/candidates/embed-job';
import {
	consentEvents,
	documentExtractions,
	embeddingSpaces,
	embeddings,
	files,
	jobs,
	legalRepresentatives,
	mlResults,
	representations,
	resumeDocuments,
	sourceFacts
} from '$lib/server/db/schema';
import type { Docparse } from '$lib/server/documents/docparse';
import type { EmbedModels } from '$lib/server/embeddings/vectors';
import { ApiError } from '$lib/server/errors/api-error';
import type { JobHandler } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES, type JobType } from '$lib/server/jobs/registry';
import type { RequestMeta } from '$lib/server/invitations/deps';
import { fail, ok } from '$lib/server/ml/result';
import { createResumeExtractHandler } from '$lib/server/resumes/extract-job';
import { createResumeParseHandler } from '$lib/server/resumes/parse-job';
import { uploadResume } from '$lib/server/resumes/upload';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createPublishedDocument, randomSha256 } from '../helpers/factories';

// The resume page reads `config()`: its environment points at this file's database once it exists.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const { closeDb } = await import('$lib/server/db');
const { testEnvironment } = await import('../helpers/environment');
const resumePage = await import('../../src/routes/(app)/me/resume/+page.server');

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const SPACE = 'test-space@r1/q:none/d:none/mean/l2/4/t512/sections-v1';
const DAY = 86_400_000;
const REPRESENTATIVE_REFUSAL = /Нужно согласие представителя/u;

const meta: RequestMeta = { requestId: 'test-request', ip: '127.0.0.1', userAgent: 'vitest' };
const now = () => new Date();
const log = createLogger({ service: 'test' });

let database: TestDatabase;
let pdDocumentId: string;

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl') }));
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	pdDocumentId = (
		await createPublishedDocument(database.db, 'pd_processing', { publishedAt: new Date(Date.now() - 10 * DAY) })
	).id;
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
		status: 'building'
	});
}, 180_000);

afterAll(async () => {
	await closeDb();
	await database.drop();
});

// --- Fixtures -----------------------------------------------------------------------------------------------------------

const yearsAgo = (years: number) => {
	const date = new Date();
	date.setUTCFullYear(date.getUTCFullYear() - years);
	date.setUTCMonth(0, 15);
	return date.toISOString().slice(0, 10);
};

async function sign(
	candidateId: string,
	signer: { userId: string } | { representationId: string },
	action: 'grant' | 'revoke' = 'grant',
	at: Date = new Date(Date.now() - DAY)
) {
	await database.db.insert(consentEvents).values({
		subjectCandidateId: candidateId,
		kind: 'pd_processing',
		documentId: pdDocumentId,
		action,
		...('userId' in signer
			? { signerKind: 'subject' as const, signerUserId: signer.userId }
			: { signerKind: 'representative' as const, representationId: signer.representationId }),
		method: 'separate_screen_button',
		evidence: {},
		occurredAt: at
	});
}

/** A candidate of 16 who signed their own `pd_processing`; the representative has not signed yet. */
async function teenager() {
	const candidate = await createCandidate(database.db, { birthDate: yearsAgo(16) });
	await sign(candidate.id, { userId: candidate.userId });
	return candidate;
}

/** The representative's authority is verified and they sign `pd_processing` too. */
async function representativeSigns(candidateId: string): Promise<string> {
	const { db } = database;
	const [representative] = await db
		.insert(legalRepresentatives)
		.values({ fullNameEnc: randomBytes(32), emailEnc: randomBytes(32), emailHmac: randomSha256() })
		.returning();
	if (!representative) throw new Error('representative not inserted');
	const [representation] = await db
		.insert(representations)
		.values({
			candidateId,
			representativeId: representative.id,
			relation: 'parent',
			status: 'authority_verified',
			invitedAt: new Date(Date.now() - 2 * DAY),
			contactConfirmedAt: new Date(Date.now() - 2 * DAY)
		})
		.returning();
	if (!representation) throw new Error('representation not inserted');
	await sign(candidateId, { representationId: representation.id });
	return representation.id;
}

function subjectOf(candidate: { id: string; userId: string }): AccessSubject {
	return {
		userId: candidate.userId,
		via: 'session',
		candidate: { id: candidate.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

/** A bucket in memory that records what was put. */
function memoryStore(): ObjectStore & { keys: string[] } {
	const objects = new Map<string, Uint8Array>();
	return {
		keys: [],
		put(key, bytes) {
			this.keys.push(key);
			objects.set(key, bytes);
			return Promise.resolve();
		},
		get(key) {
			const bytes = objects.get(key);
			return Promise.resolve(
				bytes === undefined
					? null
					: { body: new Blob([new Uint8Array(bytes)]).stream(), sizeBytes: bytes.byteLength, contentType: 'text/plain' }
			);
		},
		delete(key) {
			objects.delete(key);
			return Promise.resolve();
		},
		exists(key) {
			return Promise.resolve(objects.has(key));
		}
	};
}

const RESUME_TEXT = 'Иван Петров\nОпыт работы\nРазработчик Go, 2024 — настоящее время\nНавыки: Go, PostgreSQL';
const resumeBytes = () => new TextEncoder().encode(RESUME_TEXT);

async function rowsOf(candidateId: string) {
	const { db } = database;
	return {
		resumes: await db.select().from(resumeDocuments).where(eq(resumeDocuments.candidateId, candidateId)),
		facts: await db.select().from(sourceFacts).where(eq(sourceFacts.candidateId, candidateId))
	};
}

/** Claims the queued job of the input; jobs the other steps of a test enqueued are not run here and are dropped. */
async function claim<T extends JobType>(type: T, inputVersion: string): Promise<ClaimedJob<T>> {
	await database.db.delete(jobs).where(and(eq(jobs.status, 'queued'), ne(jobs.inputVersion, inputVersion)));
	const claimed = await claimJob(database.db, 'worker-test', [type]);
	if (claimed?.type !== type || claimed.inputVersion !== inputVersion) throw new Error(`no ${type} job to run`);
	return { ...claimed, type, payload: JOB_TYPES[type].payload.parse(claimed.payload) } as ClaimedJob<T>;
}

function run<T extends JobType>(handler: JobHandler<T>, job: ClaimedJob<T>) {
	return handler.run({
		job,
		db: database.db,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log: log.child({ job_id: job.id })
	});
}

// --- Tests --------------------------------------------------------------------------------------------------------------

describe('a resume of a candidate aged 14–17', () => {
	it('is refused before it is stored until the representative signs, and taken after', async () => {
		const person = await teenager();
		const store = memoryStore();
		const attempt = uploadResume(
			{ db: database.db, store, now },
			subjectOf(person),
			{ bytes: resumeBytes(), declaredName: 'Резюме.txt' },
			meta
		);
		await expect(attempt).rejects.toBeInstanceOf(ApiError);
		await expect(attempt).rejects.toThrow(REPRESENTATIVE_REFUSAL);
		await expect(attempt).rejects.toMatchObject({
			code: 'policy_violation',
			details: [expect.objectContaining({ code: 'representative_consent_required' })]
		});
		expect(store.keys).toEqual([]);
		expect((await rowsOf(person.id)).resumes).toEqual([]);
		expect(await database.db.select().from(files).where(eq(files.ownerUserId, person.userId))).toEqual([]);

		await representativeSigns(person.id);
		const uploaded = await uploadResume(
			{ db: database.db, store, now },
			subjectOf(person),
			{ bytes: resumeBytes(), declaredName: 'Резюме.txt' },
			meta
		);
		expect(store.keys).toHaveLength(1);
		expect((await rowsOf(person.id)).resumes.map((row) => row.id)).toEqual([uploaded.resumeDocumentId]);
	});

	it('is refused on the resume page with the reason instead of the upload form', async () => {
		const person = await teenager();
		const actor: Actor = {
			kind: 'session',
			userId: person.userId,
			sessionHash: randomSha256(),
			authTime: new Date(),
			authMethod: 'password',
			csrfToken: 'csrf'
		};
		const event = (request: Request) => ({
			url: new URL(request.url),
			params: {},
			request,
			locals: { requestId: 'req-page', actor },
			getClientAddress: () => '127.0.0.1',
			setHeaders: () => {},
			depends: () => {}
		});
		const page = (await resumePage.load(event(new Request('http://localhost/me/resume')) as never)) as {
			processingRefusal: string | null;
		};
		expect(page.processingRefusal).toMatch(REPRESENTATIVE_REFUSAL);

		const form = new FormData();
		form.set('file', new File([RESUME_TEXT], 'Резюме.txt', { type: 'text/plain' }));
		const upload = resumePage.actions.upload;
		if (!upload) throw new Error('the resume page has no upload action');
		const answer = (await upload(
			event(new Request('http://localhost/me/resume?/upload', { method: 'POST', body: form })) as never
		)) as { status: number; data: { problem: { message: string }; target: string } };
		expect(answer.status).toBe(422);
		expect(answer.data.target).toBe('upload');
		expect(answer.data.problem.message).toMatch(REPRESENTATIVE_REFUSAL);
		expect((await rowsOf(person.id)).resumes).toEqual([]);
	});

	it('is not parsed once the consent lapsed after the upload: the file never reaches the parser and the resume fails', async () => {
		const person = await teenager();
		const representationId = await representativeSigns(person.id);
		const store = memoryStore();
		const uploaded = await uploadResume(
			{ db: database.db, store, now },
			subjectOf(person),
			{ bytes: resumeBytes(), declaredName: 'Резюме.txt' },
			meta
		);
		await sign(person.id, { representationId }, 'revoke', new Date());

		let parsed = 0;
		const parser: Docparse = {
			parse: () => {
				parsed++;
				throw new Error('the parser must not be called');
			}
		};
		const handler = createResumeParseHandler({ store: () => store, parser: () => parser });
		const job = await claim('resume.parse', uploaded.resumeDocumentId);
		expect(await completeJob(database.db, job, await run(handler, job))).toBe('succeeded');
		expect(parsed).toBe(0);
		// The resume is not left pending: it fails with the reason the candidate is told.
		const [resume] = (await rowsOf(person.id)).resumes;
		expect(resume).toMatchObject({ parseStatus: 'failed', parseError: 'no_processing_consent' });
		expect(
			await database.db
				.select()
				.from(documentExtractions)
				.where(eq(documentExtractions.resumeDocumentId, uploaded.resumeDocumentId))
		).toEqual([]);
	});

	it('is not extracted without the consent, and a result is dropped when it lapses during the job', async () => {
		const { db } = database;
		const person = await teenager();
		const representationId = await representativeSigns(person.id);
		const uploaded = await uploadResume(
			{ db, store: memoryStore(), now },
			subjectOf(person),
			{ bytes: resumeBytes(), declaredName: 'Резюме.txt' },
			meta
		);
		await db.delete(jobs).where(eq(jobs.inputVersion, uploaded.resumeDocumentId));
		const lines = RESUME_TEXT.split('\n');
		let offset = 0;
		const blocks = lines.map((line, index) => {
			const block = { id: `b${index}`, kind: 'line', column: null, start: offset, end: offset + line.length };
			offset += line.length + 1;
			return block;
		});
		const [extraction] = await db
			.insert(documentExtractions)
			.values({
				resumeDocumentId: uploaded.resumeDocumentId,
				extractorName: 'test',
				extractorVersion: 'test-1',
				inputSha256: randomSha256(),
				status: 'complete',
				text: RESUME_TEXT,
				blocks,
				flags: { ocrUsed: false, ocrPages: [], incompleteReasons: [] }
			})
			.returning();
		if (!extraction) throw new Error('extraction not inserted');
		await db
			.update(resumeDocuments)
			.set({ parseStatus: 'parsed' })
			.where(eq(resumeDocuments.id, uploaded.resumeDocumentId));

		let extracted = 0;
		const handler = createResumeExtractHandler({
			adapter: () => ({
				extract: () => {
					extracted++;
					return Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' }));
				}
			}),
			now
		});
		const enqueue = async () => {
			await db.transaction((tx) =>
				enqueueJob(
					tx,
					'resume.extract',
					{ extraction_id: extraction.id },
					{ inputVersion: extraction.id, createdBy: { kind: 'system' } }
				)
			);
			return claim('resume.extract', extraction.id);
		};

		// In effect when the job reads the blocks, revoked before its result is written: nothing is written.
		const first = await enqueue();
		const result = await run(handler, first);
		expect(extracted).toBe(1);
		await sign(person.id, { representationId }, 'revoke', new Date());
		expect(await completeJob(db, first, result)).toBe('discarded_stale');
		expect((await rowsOf(person.id)).facts).toEqual([]);
		expect(await db.select().from(mlResults).where(eq(mlResults.jobId, first.id))).toEqual([]);

		// Revoked before the job runs: the blocks reach neither the model nor the rules.
		const second = await enqueue();
		expect(await completeJob(db, second, await run(handler, second))).toBe('discarded_stale');
		expect(extracted).toBe(1);
		expect((await rowsOf(person.id)).facts).toEqual([]);
	});
});

describe('other processing of a candidate aged 14–17 without the representative', () => {
	it('refuses to start an attempt of a platform test', async () => {
		const person = await teenager();
		await expect(
			startAttempt(database.db, subjectOf(person), randomSha256().slice(0, 12), now())
		).rejects.toMatchObject({
			code: 'policy_violation',
			details: [expect.objectContaining({ code: 'representative_consent_required' })]
		});
	});

	it('sends no profile text to the embedding model and keeps no vectors', async () => {
		const { db } = database;
		const person = await teenager();
		await db.insert(sourceFacts).values({
			candidateId: person.id,
			source: 'fsp',
			factType: 'competition_result',
			sourceRecordRef: `fsp:${randomSha256().slice(0, 12)}`,
			trustLevel: 'fsp_verified',
			ownershipBasis: 'operator_confirmed',
			payload: {
				result: { status: 'official', award: 'prize' },
				competition: { discipline: 'algorithmic', level: 'russian_championship', online: false }
			},
			payloadSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			status: 'active'
		});
		// Vectors computed earlier, when the consent was in effect, go away with it.
		await db.insert(embeddings).values({
			spaceId: SPACE,
			ownerType: 'candidate_section',
			ownerId: person.id,
			section: 'summary',
			inputSha256: randomSha256(),
			inputVersion: '0',
			vector: [1, 0, 0, 0]
		});
		const texts: string[] = [];
		const models: EmbedModels = {
			embed: (request) => {
				texts.push(...request.inputs.map((input) => input.text));
				return Promise.resolve(
					ok({
						spaceId: request.spaceId,
						vectors: request.inputs.map((input) => ({ id: input.id, vector: [1, 0, 0, 0] })),
						latencyMs: 1
					})
				);
			}
		};
		const handler = createProfileEmbedHandler({ models: () => models, spaceId: () => SPACE, now });
		const version = `embed-${person.id}`;
		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'profile.embed',
				{ candidate_id: person.id },
				{ inputVersion: version, createdBy: { kind: 'system' } }
			)
		);
		const job = await claim('profile.embed', version);
		expect(await completeJob(db, job, await run(handler, job))).toBe('succeeded');
		expect(texts).toEqual([]);
		expect(await db.select().from(embeddings).where(eq(embeddings.ownerId, person.id))).toEqual([]);
	});
});
