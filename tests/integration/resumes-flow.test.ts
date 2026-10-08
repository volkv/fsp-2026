// Resumes end to end against the real parser image and object storage, with a fake model runtime: upload → `resume.parse`
// (docparse) → `resume.extract` (the model, or rules without it) → fact, claims with quotes and experience entries →
// a new profile revision with the recalculation enqueued. Also: a file without text, a replaced resume, a deleted one,
// and the candidate's review of what was extracted.
import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { ExtractConfig } from '$lib/server/config';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	candidates,
	claims,
	documentExtractions,
	experienceEntries,
	files,
	jobs,
	mlResults,
	resumeDocuments,
	sourceFacts
} from '$lib/server/db/schema';
import { JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES, type JobType } from '$lib/server/jobs/registry';
import type { RequestMeta } from '$lib/server/invitations/deps';
import { ModelAdapter } from '$lib/server/ml/adapter';
import { deleteResume } from '$lib/server/resumes/delete';
import { createResumeExtractHandler } from '$lib/server/resumes/extract-job';
import { createResumeParseHandler } from '$lib/server/resumes/parse-job';
import { readOwnResumes } from '$lib/server/resumes/read';
import { correctExperienceEntry, reviewResumeClaim } from '$lib/server/resumes/review';
import { uploadResume } from '$lib/server/resumes/upload';
import { S3ObjectStore, type ObjectStore } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { sliceByCodePoints } from '$lib/text/offsets';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { DOCPARSE_FIXTURES, startParser } from '../helpers/docparse';
import { createCandidate } from '../helpers/factories';
import { startStorage } from '../helpers/storage';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));

const meta: RequestMeta = { requestId: 'test-request', ip: '127.0.0.1', userAgent: 'vitest' };
const now = () => new Date();

let database: TestDatabase;
let storage: StartedTestContainer;
let parser: StartedTestContainer;
let store: ObjectStore;
let runtime: FakeRuntime;
let parseHandler: JobHandler<'resume.parse'>;

// --- A fake OpenAI-compatible runtime ----------------------------------------------------------------------------------

type Answer = (blocks: { id: string; text: string }[], res: ServerResponse) => void;

interface FakeRuntime {
	url: string;
	calls: number;
	answer(next: Answer): void;
	close(): Promise<void>;
}

async function startRuntime(): Promise<FakeRuntime> {
	let answer: Answer = (_, res) => {
		res.writeHead(500).end();
	};
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			fake.calls++;
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[] };
			// The blocks come as a JSON document between the markers of the user message.
			const user = (body.messages[1]?.content ?? '<document>\n{"blocks":[]}\n</document>').replace(
				/^<document>\n|\n<\/document>$/gu,
				''
			);
			answer((JSON.parse(user) as { blocks: { id: string; text: string }[] }).blocks, res);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const fake: FakeRuntime = {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		calls: 0,
		answer(next) {
			answer = next;
		},
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			})
	};
	return fake;
}

/** A `resume-extract/v3` answer: every array of the schema, empty unless given. */
function chat(res: ServerResponse, arrays: Record<string, unknown[]>) {
	const answer = {
		jobs: [],
		skills: [],
		responsibilities: [],
		education: [],
		languages: [],
		achievements: [],
		full_name: [],
		contacts: [],
		soft_skills: [],
		...arrays
	};
	res.writeHead(200, { 'content-type': 'application/json' }).end(
		JSON.stringify({
			model: 'extractor-7b',
			choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }]
		})
	);
}

function extractConfig(): ExtractConfig {
	return {
		baseUrl: `${runtime.url}/v1`,
		runtime: 'vllm',
		model: 'extractor-7b',
		apiKey: null,
		timeoutMs: 5_000,
		interactiveTimeoutMs: 2_000,
		maxConcurrency: 2,
		breaker: { failures: 3, cooldownMs: 30_000 }
	};
}

function adapter(extract: ExtractConfig | null): ModelAdapter {
	return new ModelAdapter({
		models: { extract, embed: null, rerank: null },
		modes: { current: () => Promise.resolve({ ok: true, value: 'on' }) },
		spaces: () => Promise.resolve(null)
	});
}

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});
const withModel = () =>
	createResumeExtractHandler({ adapter: () => adapter(extractConfig()), crypto: () => crypto, now });
const withoutModel = () => createResumeExtractHandler({ adapter: () => adapter(null), crypto: () => crypto, now });

// --- Services -----------------------------------------------------------------------------------------------------------

// --- Jobs ---------------------------------------------------------------------------------------------------------------

const log = createLogger({ service: 'test' });

async function claim<T extends JobType>(type: T): Promise<ClaimedJob<T>> {
	const claimed = await claimJob(database.db, 'worker-test', [type]);
	if (claimed?.type !== type) throw new Error(`no ${type} job to run`);
	return { ...claimed, type, payload: JOB_TYPES[type].payload.parse(claimed.payload) } as ClaimedJob<T>;
}

function run<T extends JobType>(handler: JobHandler<T>, job: ClaimedJob<T>): Promise<JobResult> {
	return handler.run({
		job,
		db: database.db,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log: log.child({ job_id: job.id })
	});
}

/** Runs the next job of the type as the worker does: a handled failure goes back through the queue. */
async function runNext<T extends JobType>(type: T, handler: JobHandler<T>) {
	const job = await claim(type);
	try {
		return await completeJob(database.db, job, await run(handler, job));
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		return failJob(database.db, job, { code: error.code, retryable: error.retryable, message: error.message });
	}
}

// --- Candidates and uploads ---------------------------------------------------------------------------------------------

function subjectOf(candidate: { id: string; userId: string }): AccessSubject {
	return {
		userId: candidate.userId,
		via: 'session',
		candidate: { id: candidate.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

const fixture = (name: string) => new Uint8Array(readFileSync(`${DOCPARSE_FIXTURES}/${name}`));

async function upload(candidate: { id: string; userId: string }, bytes: Uint8Array<ArrayBuffer>, name: string) {
	return uploadResume({ db: database.db, store, now }, subjectOf(candidate), { bytes, declaredName: name }, meta);
}

async function uploadAndParse(name: string) {
	const candidate = await createCandidate(database.db);
	const uploaded = await upload(candidate, fixture(name), name);
	expect(await runNext('resume.parse', parseHandler)).toBe('succeeded');
	return { candidate, uploaded };
}

async function revisionOf(candidateId: string) {
	const [row] = await database.db
		.select({ revision: candidates.profileRevision, floor: candidates.evidenceFloorRevision })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error('candidate is missing');
	return row;
}

async function queued(type: JobType, inputVersion?: string) {
	return database.db
		.select({ id: jobs.id, payload: jobs.payload, inputVersion: jobs.inputVersion })
		.from(jobs)
		.where(
			and(
				eq(jobs.type, type),
				eq(jobs.status, 'queued'),
				inputVersion === undefined ? undefined : eq(jobs.inputVersion, inputVersion)
			)
		);
}

/** Every stored quote is the text of its block at its code point offsets. */
async function expectQuotesInText(extractionId: string, quotes: unknown[]) {
	const [extraction] = await database.db
		.select()
		.from(documentExtractions)
		.where(eq(documentExtractions.id, extractionId));
	if (!extraction) throw new Error('extraction is missing');
	const blocks = new Map(
		(extraction.blocks as { id: string; start: number; end: number }[]).map((block) => [
			block.id,
			sliceByCodePoints(extraction.text, block)
		])
	);
	expect(quotes.length).toBeGreaterThan(0);
	for (const raw of quotes) {
		const quote = raw as { extraction_id: string; block_id: string; start: number; end: number; text: string };
		expect(quote.extraction_id).toBe(extractionId);
		const blockText = blocks.get(quote.block_id);
		expect(blockText, `block ${quote.block_id}`).toBeDefined();
		expect(sliceByCodePoints(blockText ?? '', quote)).toBe(quote.text);
	}
}

async function extractionOf(resumeDocumentId: string) {
	const [row] = await database.db
		.select()
		.from(documentExtractions)
		.where(eq(documentExtractions.resumeDocumentId, resumeDocumentId));
	if (!row) throw new Error('no extraction');
	return row;
}

beforeAll(async () => {
	const [storageStarted, parserStarted, created, fake] = await Promise.all([
		startStorage(),
		startParser(),
		createTestDatabase(),
		startRuntime()
	]);
	storage = storageStarted.container;
	parser = parserStarted.container;
	database = created;
	runtime = fake;
	store = new S3ObjectStore(storageStarted.settings);
	parseHandler = createResumeParseHandler({ store: () => store, parser: () => parserStarted.client });
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
}, 900_000);

afterAll(async () => {
	await Promise.all([database.drop(), storage.stop(), parser.stop(), runtime.close()]);
});

// --- Model answer for the hh export -------------------------------------------------------------------------------------

/** What an extraction model says about the hh export: mostly right, with a few items the checks must refuse. */
const hhAnswer: Answer = (blocks, res) => {
	const block = (predicate: (text: string) => boolean, nth = 0) => {
		const found = blocks.filter((b) => predicate(b.text))[nth];
		if (!found) throw new Error('fixture block not found');
		return found.id;
	};
	const title = block((t) => t === 'Ведущий Python-разработчик', 1);
	const languages = block((t) => t.startsWith('Знание языков'));
	chat(res, {
		jobs: [
			{
				role_titles: [{ raw_text: 'Ведущий Python-разработчик', block_id: title, quote: 'Ведущий Python-разработчик' }],
				organizations: [
					{
						raw_text: 'ООО «Пример Технолоджиз»',
						block_id: block((t) => t === 'ООО «Пример Технолоджиз»'),
						quote: 'ООО «Пример Технолоджиз»'
					}
				],
				periods: [
					{
						date_from: 'Март 2021',
						date_to: 'настоящее время',
						block_id: block((t) => t.startsWith('Март 2021')),
						quote: 'Март 2021 — настоящее время'
					}
				],
				skills: [{ raw_text: 'Python', polarity: 'asserted', block_id: title, quote: 'Python' }],
				responsibilities: [
					{
						raw_text: 'Наставничество',
						block_id: block((t) => t.includes('Наставничество')),
						quote: 'Наставничество для четырёх младших разработчиков'
					}
				]
			}
		],
		skills: [
			{ raw_text: 'PostgreSQL', polarity: 'asserted', block_id: block((t) => t === 'PostgreSQL'), quote: 'PostgreSQL' },
			// Refused: a skill the document does not contain, a quote that does not name the skill, an extra field.
			{ raw_text: 'Kotlin', polarity: 'asserted', block_id: block((t) => t === 'PostgreSQL'), quote: 'Kotlin' },
			{ raw_text: 'Django', polarity: 'asserted', block_id: block((t) => t === 'FastAPI'), quote: 'FastAPI' },
			{ raw_text: 'Redis', polarity: 'asserted', block_id: block((t) => t === 'Redis'), quote: 'Redis', gender: 'male' }
		],
		languages: [
			{ language: 'Английский', level: 'B2', block_id: languages, quote: 'Английский — B2' },
			// Refused: a native language tells origin, not a skill.
			{ language: 'Русский', level: 'native', block_id: languages, quote: 'Русский — Родной' }
		]
	});
};

// --- Tests --------------------------------------------------------------------------------------------------------------

describe('a PDF resume read by the model', () => {
	it('parses the file, stores claims whose quotes are the document text, and moves the profile revision', async () => {
		const { candidate, uploaded } = await uploadAndParse('hh-export.pdf');
		const [document] = await database.db
			.select({ parseStatus: resumeDocuments.parseStatus })
			.from(resumeDocuments)
			.where(eq(resumeDocuments.id, uploaded.resumeDocumentId));
		expect(document?.parseStatus).toBe('parsed');
		const extraction = await extractionOf(uploaded.resumeDocumentId);
		expect(extraction.text).toContain('Пример Технолоджиз');
		expect(await queued('resume.extract', extraction.id)).toHaveLength(1);

		runtime.answer(hhAnswer);
		const before = await revisionOf(candidate.id);
		const job = await claim('resume.extract');
		expect(await completeJob(database.db, job, await run(withModel(), job))).toBe('succeeded');

		const [envelope] = await database.db
			.select()
			.from(mlResults)
			.where(sql`${mlResults.inputRef} ->> 'id' = ${extraction.id}`);
		expect(envelope).toMatchObject({
			processingMode: 'model',
			schemaVersion: 'resume-extract/v3',
			rulesVersion: null,
			// The journal says where the text went.
			model: { model_id: 'extractor-7b', runtime: 'vllm' }
		});
		expect(envelope?.model).toMatchObject({ endpoint_profile: 'extract', model_id: 'extractor-7b' });
		const reasons = (envelope?.rejectedItems as { reason: string }[]).map((r) => r.reason).sort();
		expect(reasons).toEqual(['forbidden_field', 'forbidden_field', 'quote_not_found', 'quote_not_supporting']);

		const [fact] = await database.db
			.select()
			.from(sourceFacts)
			.where(eq(sourceFacts.sourceRecordRef, `resume:${uploaded.resumeDocumentId}`));
		expect(fact).toMatchObject({
			source: 'resume',
			factType: 'resume_document',
			trustLevel: 'claimed',
			status: 'active'
		});
		const stored = await database.db
			.select()
			.from(claims)
			.where(eq(claims.factId, fact?.id ?? ''));
		expect(stored.map((c) => c.rawText).sort()).toEqual(
			[
				'Python',
				'PostgreSQL',
				'Ведущий Python-разработчик',
				'Английский',
				'Английский',
				'Март 2021 — настоящее время',
				'Наставничество',
				'ООО «Пример Технолоджиз»'
			].sort()
		);
		expect(stored.every((c) => c.extractor === 'model' && c.mlResultId === envelope?.id)).toBe(true);
		expect(stored.find((c) => c.rawText === 'PostgreSQL')).toMatchObject({
			skillKey: 'postgresql',
			polarity: 'asserted'
		});
		expect(stored.find((c) => c.claimType === 'responsibility_marker')?.value).toEqual({ marker: 'mentoring' });
		// A language stated with its level is the skill the taxonomy names «<язык> язык», and keeps its level as a language.
		expect(stored.find((c) => c.claimType === 'skill_mention' && c.rawText === 'Английский')).toMatchObject({
			skillKey: 'english'
		});
		expect(stored.find((c) => c.claimType === 'language_level')?.value).toEqual({ level: 'B2' });
		await expectQuotesInText(
			extraction.id,
			stored.map((c) => c.quote)
		);

		const [entry] = await database.db
			.select()
			.from(experienceEntries)
			.where(eq(experienceEntries.factId, fact?.id ?? ''));
		expect(entry).toMatchObject({
			positionTitle: 'Ведущий Python-разработчик',
			roleKey: 'backend',
			organizationName: 'ООО «Пример Технолоджиз»',
			periodFrom: '2021-03-01',
			periodFromPrecision: 'month',
			periodTo: null,
			isCurrent: true,
			periodStatus: 'valid',
			appliedSkillKeys: ['python']
		});
		await expectQuotesInText(extraction.id, entry?.quotes as unknown[]);

		const after = await revisionOf(candidate.id);
		expect(after.revision).toBe(before.revision + 1);
		expect(after.floor).toBe(before.floor);
		expect(await queued('evidence.compute', String(after.revision))).toHaveLength(1);

		const view = await readOwnResumes(database.db, subjectOf(candidate));
		expect(view.current?.reading).toEqual({
			processingMode: 'model',
			model: { modelId: 'extractor-7b', runtime: 'vllm' },
			notice: null,
			failureCode: null
		});

		// A repeated delivery neither calls the model again nor writes twice.
		const calls = runtime.calls;
		const again = await run(withModel(), job);
		expect(runtime.calls).toBe(calls);
		expect(await database.db.transaction((tx) => again.isCurrent(tx))).toBe(false);
	});

	it('falls back to rules when the model keeps failing through the last attempt, and says so', async () => {
		const { candidate } = await uploadAndParse('hh-export.pdf');
		runtime.answer((_, res) => {
			res.writeHead(503).end();
		});
		const job = await claim('resume.extract');
		const first = await run(withModel(), job).then(
			() => null,
			(error: unknown) => error
		);
		expect(first).toBeInstanceOf(JobFailure);
		expect(first).toMatchObject({ code: 'model_unavailable', retryable: true });

		const last = await run(withModel(), { ...job, attempt: job.maxAttempts });
		expect(await completeJob(database.db, job, last)).toBe('succeeded');
		const view = await readOwnResumes(database.db, subjectOf(candidate));
		expect(view.current?.reading).toEqual({
			processingMode: 'rules_only',
			model: null,
			notice: 'Разбор выполнен без модели — проверьте поля',
			failureCode: 'unavailable'
		});
		expect(view.current?.claims.every((c) => c.extractor === 'rules')).toBe(true);
		expect(view.current?.experience.length).toBe(3);
	});
});

describe('a DOCX resume without the model', () => {
	it('finds skills by the taxonomy aliases with their quotes and builds the jobs by rules', async () => {
		const { candidate, uploaded } = await uploadAndParse('table.docx');
		expect(await runNext('resume.extract', withoutModel())).toBe('succeeded');
		const extraction = await extractionOf(uploaded.resumeDocumentId);
		const [envelope] = await database.db
			.select()
			.from(mlResults)
			.where(sql`${mlResults.inputRef} ->> 'id' = ${extraction.id}`);
		expect(envelope).toMatchObject({ processingMode: 'rules_only', model: null, rulesVersion: 'resume-rules/4' });
		expect(envelope?.failure).toMatchObject({ code: 'disabled', details: { reason: 'not_configured' } });

		const view = await readOwnResumes(database.db, subjectOf(candidate));
		const current = view.current;
		if (!current) throw new Error('no current resume');
		const skills = current.claims.filter((c) => c.claimType === 'skill_mention');
		const keys = new Set(skills.map((c) => c.skillKey));
		for (const key of ['typescript', 'react', 'playwright', 'figma']) expect(keys.has(key), key).toBe(true);
		expect(skills.every((c) => c.extractor === 'rules')).toBe(true);
		await expectQuotesInText(
			extraction.id,
			current.claims.map((c) => c.quote)
		);

		const titles = current.experience.map((e) => [e.positionTitle, e.roleKey, e.periodFrom, e.isCurrent]);
		expect(titles).toEqual(
			expect.arrayContaining([
				['Старший frontend-разработчик', 'frontend', '2022-01-01', true],
				['Frontend-разработчик', 'frontend', '2020-04-01', false],
				['Верстальщик', 'frontend', '2018-07-01', false]
			])
		);
		expect(current.reading?.notice).toBe('Разбор выполнен без модели — проверьте поля');
	});
});

describe('a file without text', () => {
	it('fails the resume with no_text at once, without retries or an extraction', async () => {
		const candidate = await createCandidate(database.db);
		const uploaded = await upload(candidate, new Uint8Array(new TextEncoder().encode('   \n\n\t ')), 'blank.txt');
		expect(await runNext('resume.parse', parseHandler)).toBe('succeeded');
		const [document] = await database.db
			.select({ parseStatus: resumeDocuments.parseStatus, parseError: resumeDocuments.parseError })
			.from(resumeDocuments)
			.where(eq(resumeDocuments.id, uploaded.resumeDocumentId));
		expect(document).toEqual({ parseStatus: 'failed', parseError: 'no_text' });
		const [file] = await database.db.select({ status: files.status }).from(files).where(eq(files.id, uploaded.fileId));
		expect(file?.status).toBe('rejected');
		const [job] = await database.db
			.select({ status: jobs.status, attempts: jobs.attempts })
			.from(jobs)
			.where(eq(jobs.id, uploaded.parseJobId));
		expect(job).toEqual({ status: 'succeeded', attempts: 1 });
		const extractions = await database.db
			.select()
			.from(documentExtractions)
			.where(eq(documentExtractions.resumeDocumentId, uploaded.resumeDocumentId));
		expect(extractions).toEqual([]);
		const view = await readOwnResumes(database.db, subjectOf(candidate));
		expect(view.uploads[0]).toMatchObject({
			parseError: 'no_text',
			failureMessage: 'В файле не найден текст: загрузите файл с текстовым слоем или более чёткий скан'
		});
		// The code is there exactly when the parse failed: the database refuses a failed resume without one.
		await expect(
			database.db
				.update(resumeDocuments)
				.set({ parseError: null })
				.where(eq(resumeDocuments.id, uploaded.resumeDocumentId))
		).rejects.toThrow();
	});
});

describe('a replaced resume', () => {
	it('archives the previous resume with its evidence and drops a late result for it', async () => {
		const { candidate, uploaded: first } = await uploadAndParse('table.docx');
		expect(await runNext('resume.extract', withoutModel())).toBe('succeeded');
		const firstFactRows = await database.db
			.select()
			.from(sourceFacts)
			.where(eq(sourceFacts.sourceRecordRef, `resume:${first.resumeDocumentId}`));
		const before = await revisionOf(candidate.id);

		const second = await upload(candidate, fixture('hh-export.pdf'), 'hh-export.pdf');
		expect(second.seq).toBe(first.seq + 1);
		const documents = await database.db
			.select({ id: resumeDocuments.id, isCurrent: resumeDocuments.isCurrent })
			.from(resumeDocuments)
			.where(eq(resumeDocuments.candidateId, candidate.id));
		expect(documents).toEqual(
			expect.arrayContaining([
				{ id: first.resumeDocumentId, isCurrent: false },
				{ id: second.resumeDocumentId, isCurrent: true }
			])
		);
		const [oldFact] = await database.db
			.select()
			.from(sourceFacts)
			.where(eq(sourceFacts.id, firstFactRows[0]?.id ?? ''));
		expect(oldFact).toMatchObject({ status: 'superseded', statusReason: 'resume_replaced' });
		const oldClaims = await database.db
			.select({ status: claims.status })
			.from(claims)
			.where(eq(claims.factId, oldFact?.id ?? ''));
		expect(new Set(oldClaims.map((c) => c.status))).toEqual(new Set(['invalidated']));
		const after = await revisionOf(candidate.id);
		expect(after.revision).toBe(before.revision + 1);
		expect(after.floor).toBe(after.revision);

		// The new resume is parsed; while its extraction runs, a third upload makes it stale.
		expect(await runNext('resume.parse', parseHandler)).toBe('succeeded');
		const job = await claim('resume.extract');
		const result = await run(withoutModel(), job);
		await upload(candidate, fixture('table.docx'), 'again.docx');
		expect(await completeJob(database.db, job, result)).toBe('discarded_stale');
		const secondFacts = await database.db
			.select()
			.from(sourceFacts)
			.where(eq(sourceFacts.sourceRecordRef, `resume:${second.resumeDocumentId}`));
		expect(secondFacts).toEqual([]);
		expect(await runNext('resume.parse', parseHandler)).toBe('succeeded');
		expect(await runNext('resume.extract', withoutModel())).toBe('succeeded');
	});
});

describe('the candidate reviews the extraction', () => {
	it('rejects a claim with its history kept and corrects an experience entry keeping its quotes', async () => {
		const { candidate } = await uploadAndParse('table.docx');
		expect(await runNext('resume.extract', withoutModel())).toBe('succeeded');
		const subject = subjectOf(candidate);
		const view = await readOwnResumes(database.db, subject);
		const entry = view.current?.experience.find((e) => e.positionTitle === 'Старший frontend-разработчик');
		if (!entry) throw new Error('no entry');
		const skill = view.current?.claims.find(
			(c) => c.claimType === 'skill_mention' && c.experienceEntryId === entry.id && c.skillKey !== null
		);
		const other = view.current?.claims.find((c) => c.experienceEntryId === null && c.claimType === 'skill_mention');
		if (!other) throw new Error('no skill claim');

		const before = await revisionOf(candidate.id);
		await reviewResumeClaim({ db: database.db, now }, subject, other.id, 'reject', meta);
		const [rejected] = await database.db.select().from(claims).where(eq(claims.id, other.id));
		expect(rejected).toMatchObject({ candidateReview: 'rejected', status: 'active', rawText: other.rawText });
		const afterReject = await revisionOf(candidate.id);
		expect(afterReject).toEqual({ revision: before.revision + 1, floor: before.revision + 1 });

		if (skill) {
			await reviewResumeClaim({ db: database.db, now }, subject, skill.id, 'reject', meta);
			const [updated] = await database.db.select().from(experienceEntries).where(eq(experienceEntries.id, entry.id));
			expect(updated?.appliedSkillKeys).not.toContain(skill.skillKey);
		}

		await correctExperienceEntry(
			{ db: database.db, now },
			subject,
			entry.id,
			{
				positionTitle: 'Ведущий frontend-разработчик',
				roleKey: 'frontend',
				organizationName: 'ООО «Интерфейс Пример»',
				periodFrom: '2021-11',
				periodTo: null,
				isCurrent: true
			},
			meta
		);
		const [corrected] = await database.db.select().from(experienceEntries).where(eq(experienceEntries.id, entry.id));
		expect(corrected).toMatchObject({
			positionTitle: 'Ведущий frontend-разработчик',
			periodFrom: '2021-11-01',
			periodStatus: 'valid',
			candidateReview: 'edited'
		});
		expect(corrected?.quotes).toEqual(entry.quotes);

		await expect(
			reviewResumeClaim(
				{ db: database.db, now },
				subjectOf(await createCandidate(database.db)),
				other.id,
				'confirm',
				meta
			)
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('a deleted resume', () => {
	it('removes the object and everything derived from it, and withdraws its evidence', async () => {
		const { candidate, uploaded } = await uploadAndParse('hh-export.pdf');
		runtime.answer(hhAnswer);
		expect(await runNext('resume.extract', withModel())).toBe('succeeded');
		const extraction = await extractionOf(uploaded.resumeDocumentId);
		const [fact] = await database.db
			.select()
			.from(sourceFacts)
			.where(eq(sourceFacts.sourceRecordRef, `resume:${uploaded.resumeDocumentId}`));
		if (!fact) throw new Error('no fact');
		const before = await revisionOf(candidate.id);
		const [file] = await database.db.select().from(files).where(eq(files.id, uploaded.fileId));
		if (!file) throw new Error('no file');

		await deleteResume({ db: database.db, store, now }, subjectOf(candidate), uploaded.resumeDocumentId, meta);

		expect(await store.exists(file.storageKey)).toBe(false);
		const left = await Promise.all([
			database.db.select().from(files).where(eq(files.id, uploaded.fileId)),
			database.db.select().from(resumeDocuments).where(eq(resumeDocuments.id, uploaded.resumeDocumentId)),
			database.db.select().from(documentExtractions).where(eq(documentExtractions.id, extraction.id)),
			database.db.select().from(sourceFacts).where(eq(sourceFacts.id, fact.id)),
			database.db.select().from(claims).where(eq(claims.factId, fact.id)),
			database.db.select().from(experienceEntries).where(eq(experienceEntries.factId, fact.id)),
			database.db
				.select()
				.from(mlResults)
				.where(inArray(sql`${mlResults.inputRef} ->> 'id'`, [extraction.id]))
		]);
		expect(left.map((rows) => rows.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
		const after = await revisionOf(candidate.id);
		expect(after).toEqual({ revision: before.revision + 1, floor: before.revision + 1 });
		// The recalculation waiting since the extraction takes this change too (one waiting job per key).
		const waiting = await queued('evidence.compute');
		expect(waiting.filter((j) => (j.payload as { candidate_id: string }).candidate_id === candidate.id)).toHaveLength(
			1
		);
	});
});
