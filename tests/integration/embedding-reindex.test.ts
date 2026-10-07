// Registration of the configured embedding space and `embedding.reindex` (docs/domain.md, section 16.2): the space row
// from its definition, the reindex that computes every vector page by page and continues where it stopped, the switch
// that makes the new space active and retires the previous one with its vectors — first with a fake runtime, then with
// the embedder service of compose.yaml (llama.cpp with bge-m3), whose vectors must find candidates by meaning.
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	candidates,
	claims,
	embeddingSpaces,
	embeddings,
	jobs,
	searchSettings,
	sourceFacts
} from '$lib/server/db/schema';
import { BGE_M3_Q8 } from '$lib/server/embeddings/definitions';
import { createEmbeddingReindexHandler } from '$lib/server/embeddings/reindex';
import { ensureEmbeddingSpace, SpaceConfigurationError } from '$lib/server/embeddings/space';
import type { EmbedModels } from '$lib/server/embeddings/vectors';
import { JobFailure } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { candidateSimilarities, embedQuery, loadActiveSpace } from '$lib/server/matching/semantic';
import { ModelAdapter, type EmbedRequest } from '$lib/server/ml/adapter';
import { fail, ok, type ModelResult } from '$lib/server/ml/result';
import { databaseSpaceLookup } from '$lib/server/ml/spaces';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createCompany, createMember, createOwnVacancy, randomSha256 } from '../helpers/factories';
import { EMBEDDER_IMAGE } from '../helpers/images';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const COMPOSE_FILE = fileURLToPath(new URL('../../compose.yaml', import.meta.url));
/** The model file of the real runtime, kept between runs: the first run downloads 635 MB. */
const MODEL_CACHE = fileURLToPath(new URL('../../node_modules/.cache/embedder-models', import.meta.url));

const OLD = 'test-old@r1/q:none/d:none/mean/l2/4/t512/sections-v1';
const NEW = 'test-new@r1/q:none/d:none/mean/l2/4/t512/sections-v1';

let database: TestDatabase;
const log = createLogger({}, () => undefined);

class FakeEmbedder implements EmbedModels {
	texts: string[] = [];
	/** Runs before a call is answered; a thrown error or a returned failure fails the call. */
	before: ((request: EmbedRequest) => Promise<ReturnType<typeof fail> | null>) | null = null;

	async embed(
		request: EmbedRequest
	): Promise<ModelResult<{ spaceId: string; vectors: { id: string; vector: number[] }[]; latencyMs: number }>> {
		const failure = await this.before?.(request);
		if (failure) return failure;
		this.texts.push(...request.inputs.map((input) => input.text));
		return ok({
			spaceId: request.spaceId,
			vectors: request.inputs.map((input, i) => ({ id: input.id, vector: [1, i + 1, 0, 0] })),
			latencyMs: 1
		});
	}
}

async function space(id: string, status: 'building' | 'active') {
	await database.db.insert(embeddingSpaces).values({
		id,
		modelName: 'test-embedder',
		modelRevision: 'r1',
		dimension: 4,
		queryPrefix: '',
		documentPrefix: '',
		pooling: 'mean',
		normalization: 'l2',
		maxInputTokens: 512,
		chunkingVersion: 'sections-v1',
		status,
		...(status === 'active' ? { activatedAt: new Date() } : {})
	});
}

/** A candidate whose resume names these skills. */
async function candidateWith(
	skillKeys: readonly string[],
	status: 'active' | 'deleted' = 'active',
	setup: { birthDate?: string; processingConsent?: boolean } = {}
) {
	const candidate = await createCandidate(
		database.db,
		{ profileRevision: 1, ...(setup.birthDate === undefined ? {} : { birthDate: setup.birthDate }) },
		{ processingConsent: setup.processingConsent ?? true }
	);
	const [fact] = await database.db
		.insert(sourceFacts)
		.values({
			candidateId: candidate.id,
			source: 'resume',
			factType: 'resume_document',
			sourceRecordRef: `resume:${randomSha256().slice(0, 12)}`,
			trustLevel: 'claimed',
			ownershipBasis: 'self_upload',
			payload: {},
			payloadSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			status: 'active'
		})
		.returning();
	if (!fact) throw new Error('fact not inserted');
	for (const skillKey of skillKeys) {
		await database.db.insert(claims).values({
			candidateId: candidate.id,
			factId: fact.id,
			claimType: 'skill_mention',
			rawText: skillKey,
			polarity: 'asserted',
			skillKey,
			extractor: 'source_mapping',
			status: 'active'
		});
	}
	if (status === 'deleted') {
		await database.db.execute(sql`update candidates set status = 'deleted', last_name_enc = null, first_name_enc = null,
			middle_name_enc = null, phone_enc = null, birth_date = null, birth_date_precision = null,
			birth_date_source = null, birth_date_status = 'unknown' where id = ${candidate.id}`);
	}
	return candidate;
}

async function runReindex(models: EmbedModels, pageSize = 2) {
	const claimed = await claimJob(database.db, 'test-worker', ['embedding.reindex']);
	if (claimed?.type !== 'embedding.reindex') throw new Error('no embedding.reindex job to run');
	const job: ClaimedJob<'embedding.reindex'> = {
		...claimed,
		type: 'embedding.reindex',
		payload: JOB_TYPES['embedding.reindex'].payload.parse(claimed.payload)
	};
	const handler = createEmbeddingReindexHandler({
		models: () => models,
		pageSize: () => pageSize,
		now: () => new Date('2026-09-25T00:00:00Z')
	});
	const result = await handler.run({
		job,
		db: database.db,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log
	});
	return completeJob(database.db, job, result);
}

async function enqueueReindex(spaceId: string) {
	await database.db.transaction((tx) =>
		enqueueJob(tx, 'embedding.reindex', { space_id: spaceId }, { inputVersion: spaceId, createdBy: { kind: 'system' } })
	);
}

async function releaseFailedJob() {
	await database.db
		.update(jobs)
		.set({ status: 'queued', leaseOwner: null, leaseExpiresAt: null })
		.where(and(eq(jobs.type, 'embedding.reindex'), eq(jobs.status, 'running')));
}

const vectorCount = async (spaceId: string, ownerType?: 'candidate_section' | 'vacancy') =>
	(
		await database.db
			.select({ n: sql<number>`count(*)::int` })
			.from(embeddings)
			.where(and(eq(embeddings.spaceId, spaceId), ownerType ? eq(embeddings.ownerType, ownerType) : undefined))
	)[0]?.n;

async function spaceStatus(id: string) {
	const [row] = await database.db
		.select({ status: embeddingSpaces.status })
		.from(embeddingSpaces)
		.where(eq(embeddingSpaces.id, id));
	return row?.status;
}

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
}, 180_000);

afterAll(async () => {
	await database.drop();
});

describe('ensureEmbeddingSpace', () => {
	it('registers the configured space once and keeps one reindex waiting', async () => {
		const embed = { model: BGE_M3_Q8.modelName, spaceId: BGE_M3_Q8.id };
		expect(await ensureEmbeddingSpace(database.db, null)).toEqual({ status: 'not_configured' });
		expect(await ensureEmbeddingSpace(database.db, embed)).toEqual({
			status: 'registered',
			spaceId: BGE_M3_Q8.id,
			reindex: 'enqueued'
		});
		expect(await ensureEmbeddingSpace(database.db, embed)).toEqual({
			status: 'building',
			spaceId: BGE_M3_Q8.id,
			reindex: 'already_waiting'
		});
		const [row] = await database.db.select().from(embeddingSpaces).where(eq(embeddingSpaces.id, BGE_M3_Q8.id));
		expect(row).toMatchObject({ ...BGE_M3_Q8, status: 'building', activatedAt: null });
		const waiting = await database.db
			.select({ n: sql<number>`count(*)::int` })
			.from(jobs)
			.where(eq(jobs.dedupKey, `reindex:${BGE_M3_Q8.id}`));
		expect(waiting[0]?.n).toBe(1);
		// Search stays in the FTS-only mode until the reindex switches it.
		expect(await loadActiveSpace(database.db)).toBeNull();
		await database.db.delete(jobs).where(eq(jobs.dedupKey, `reindex:${BGE_M3_Q8.id}`));
	});

	it('refuses a space the product does not know, a model that does not produce it, and a row that differs', async () => {
		await expect(ensureEmbeddingSpace(database.db, { model: 'bge-m3', spaceId: 'bge-m3@other' })).rejects.toThrow(
			SpaceConfigurationError
		);
		await expect(ensureEmbeddingSpace(database.db, { model: 'another-model', spaceId: BGE_M3_Q8.id })).rejects.toThrow(
			/EMBED_MODEL must be bge-m3/
		);

		const other = await createTestDatabase();
		try {
			await other.db.insert(embeddingSpaces).values({ ...BGE_M3_Q8, maxInputTokens: 8192, status: 'building' });
			await expect(
				ensureEmbeddingSpace(other.db, { model: BGE_M3_Q8.modelName, spaceId: BGE_M3_Q8.id })
			).rejects.toThrow(/registered with other maxInputTokens/);
		} finally {
			await other.drop();
		}
	});
});

describe('embedding.reindex with a fake runtime', () => {
	beforeEach(async () => {
		await database.db.delete(jobs).where(inArray(jobs.status, ['queued', 'running']));
	});

	it('builds the new space page by page, continues after a failure, and switches search to it', async () => {
		await space(OLD, 'active');
		await database.db.update(searchSettings).set({ activeEmbeddingSpaceId: OLD });
		const go = await candidateWith(['go', 'kafka']);
		const ml = await candidateWith(['python', 'pytorch']);
		const front = await candidateWith(['react', 'typescript']);
		const gone = await candidateWith(['figma'], 'deleted');
		const empty = await candidateWith([]);
		const company = await createCompany(database.db);
		const member = await createMember(database.db, company.id);
		const taxonomy = await latestPublishedVersion(database.db);
		if (!taxonomy) throw new Error('no published taxonomy');
		const vacancy = await createOwnVacancy(database.db, {
			companyId: company.id,
			memberId: member.id,
			taxonomyVersionId: taxonomy.id
		});
		await database.db.insert(embeddings).values({
			ownerType: 'vacancy',
			ownerId: vacancy.id,
			inputSha256: randomSha256(),
			inputVersion: String(vacancy.revision),
			spaceId: OLD,
			vector: [1, 0, 0, 0]
		});

		await space(NEW, 'building');
		await enqueueReindex(NEW);
		// The runtime goes down after the first page of two candidates.
		const flaky = new FakeEmbedder();
		let calls = 0;
		flaky.before = () => Promise.resolve(++calls > 1 ? fail('unavailable', 'embed: connection refused') : null);
		const failure = await runReindex(flaky).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(JobFailure);
		expect(failure).toMatchObject({ code: 'embed_unavailable', retryable: true });
		const firstPage = await vectorCount(NEW, 'candidate_section');
		expect(firstPage).toBeGreaterThan(0);
		expect(await spaceStatus(NEW)).toBe('building');
		expect((await loadActiveSpace(database.db))?.id).toBe(OLD);

		await releaseFailedJob();
		const models = new FakeEmbedder();
		// A profile that changes while the model computes it keeps its own profile.embed; the reindex skips it.
		models.before = async (request) => {
			if (request.inputs.some((input) => input.id.startsWith(front.id))) {
				await database.db.update(candidates).set({ profileRevision: 2 }).where(eq(candidates.id, front.id));
			}
			return null;
		};
		expect(await runReindex(models)).toBe('succeeded');
		// The first page (two candidates) was written before the failure and is not computed again.
		expect(models.texts).not.toContain('Навыки: Apache Kafka, Go');
		expect(models.texts).not.toContain('Навыки: PyTorch, Python');
		expect(models.texts).toContain('Навыки: React, TypeScript');

		const owners = await database.db
			.selectDistinct({ ownerId: embeddings.ownerId })
			.from(embeddings)
			.where(and(eq(embeddings.spaceId, NEW), eq(embeddings.ownerType, 'candidate_section')));
		const embedded = new Set(owners.map((o) => o.ownerId));
		expect(embedded.has(go.id) && embedded.has(ml.id)).toBe(true);
		for (const absent of [front.id, gone.id, empty.id]) expect(embedded.has(absent)).toBe(false);
		expect(await vectorCount(NEW, 'vacancy')).toBeGreaterThanOrEqual(1);

		expect(await spaceStatus(NEW)).toBe('active');
		expect(await spaceStatus(OLD)).toBe('retired');
		expect(await vectorCount(OLD)).toBe(0);
		expect(await loadActiveSpace(database.db)).toEqual({ id: NEW, dimension: 4 });
		const refresh = await database.db
			.select({ n: sql<number>`count(*)::int` })
			.from(jobs)
			.where(and(eq(jobs.dedupKey, `match:vacancy:${vacancy.id}`), eq(jobs.status, 'queued')));
		expect(refresh[0]?.n).toBe(1);
	});

	it('fills the gaps of the active space without switching anything', async () => {
		const late = await candidateWith(['sql', 'tableau']);
		await enqueueReindex(NEW);
		const models = new FakeEmbedder();
		expect(await runReindex(models)).toBe('succeeded');
		// Only what was missing is computed: the late candidate and the profile that changed during the build.
		expect(models.texts.sort()).toEqual(['Навыки: React, TypeScript', 'Навыки: SQL, Tableau']);
		expect(await spaceStatus(NEW)).toBe('active');
		const [row] = await database.db
			.select({ inputVersion: embeddings.inputVersion })
			.from(embeddings)
			.where(and(eq(embeddings.spaceId, NEW), eq(embeddings.ownerId, late.id)));
		expect(row?.inputVersion).toBe('1');
		const refresh = await database.db
			.select({ n: sql<number>`count(*)::int` })
			.from(jobs)
			.where(eq(jobs.dedupKey, `match:candidate:${late.id}`));
		expect(refresh[0]?.n).toBe(1);
	});

	it('builds no vectors of a profile without the processing consent, a teenager without the representative included', async () => {
		const withoutConsent = await candidateWith(['rust'], 'active', { processingConsent: false });
		const teenager = await candidateWith(['swift'], 'active', { birthDate: '2010-03-01' });
		await enqueueReindex(NEW);
		const models = new FakeEmbedder();
		expect(await runReindex(models)).toBe('succeeded');
		expect(models.texts.join('\n')).not.toMatch(/Rust|Swift/u);
		const owners = await database.db
			.select({ ownerId: embeddings.ownerId })
			.from(embeddings)
			.where(and(eq(embeddings.spaceId, NEW), inArray(embeddings.ownerId, [withoutConsent.id, teenager.id])));
		expect(owners).toEqual([]);
	});

	it('discards the run of a space retired meanwhile', async () => {
		await enqueueReindex(OLD);
		const models = new FakeEmbedder();
		expect(await runReindex(models)).toBe('discarded_stale');
		expect(models.texts).toEqual([]);
	});
});

/** The embedder service of compose.yaml: its image, its start script and model, two threads. */
function composeEmbedder(): GenericContainer {
	const compose = readFileSync(COMPOSE_FILE, 'utf8');
	const service = /^ {2}embedder:\n([\s\S]*?)^\n/m.exec(compose)?.[1];
	const script = service && /^ {6}- \|\n([\s\S]*?)^ {4}environment:\n/m.exec(service)?.[1];
	const env = (name: string) => service && new RegExp(`^ {6}${name}: (\\S+)$`, 'm').exec(service)?.[1];
	const url = env('MODEL_URL');
	const sha = env('MODEL_SHA256');
	if (!script || !url || !sha) throw new Error('compose.yaml: the embedder service has changed its shape');
	mkdirSync(MODEL_CACHE, { recursive: true });
	const uid = process.getuid?.() ?? 0;
	const gid = process.getgid?.() ?? 0;
	return new GenericContainer(EMBEDDER_IMAGE)
		.withEntrypoint(['/bin/sh', '-eu', '-c'])
		.withCommand([script.replace(/^ {8}/gm, '').replaceAll('$$', '$')])
		.withEnvironment({ MODEL_URL: url, MODEL_SHA256: sha, THREADS: '2' })
		.withUser(`${uid}:${gid}`)
		.withBindMounts([{ source: MODEL_CACHE, target: '/models', mode: 'rw' }])
		.withTmpFs({ '/tmp': 'size=16m' })
		.withExposedPorts(8080)
		.withWaitStrategy(Wait.forHttp('/health', 8080).forStatusCode(200))
		.withStartupTimeout(600_000);
}

describe('embedding.reindex with the embedder service', () => {
	let runtime: StartedTestContainer;
	let adapter: ModelAdapter;

	beforeAll(async () => {
		runtime = await composeEmbedder().start();
		adapter = new ModelAdapter({
			models: {
				extract: null,
				rerank: null,
				embed: {
					baseUrl: `http://${runtime.getHost()}:${runtime.getMappedPort(8080)}/v1`,
					model: BGE_M3_Q8.modelName,
					apiKey: null,
					spaceId: BGE_M3_Q8.id,
					timeoutMs: 30_000,
					interactiveTimeoutMs: 5_000,
					batchSize: 8,
					breaker: { failures: 3, cooldownMs: 30_000 }
				}
			},
			modes: { current: () => Promise.resolve(ok('on')) },
			spaces: databaseSpaceLookup(() => database.db)
		});
	}, 660_000);

	afterAll(async () => {
		await runtime.stop();
	});

	it('computes unit vectors of 1024 dimensions that find candidates by meaning', async () => {
		await database.db.delete(jobs).where(inArray(jobs.status, ['queued', 'running']));
		const go = await candidateWith(['go', 'kafka', 'postgresql', 'docker', 'kubernetes']);
		const designer = await candidateWith(['figma', 'ui', 'ux']);
		const analyst = await candidateWith(['sql', 'excel', 'tableau']);
		const mobile = await candidateWith(['swift', 'ios']);
		await ensureEmbeddingSpace(database.db, { model: BGE_M3_Q8.modelName, spaceId: BGE_M3_Q8.id });
		expect(await runReindex(adapter, 8)).toBe('succeeded');

		const space = await loadActiveSpace(database.db);
		expect(space).toEqual({ id: BGE_M3_Q8.id, dimension: 1024 });
		expect(await spaceStatus(NEW)).toBe('retired');
		const norms = await database.db.execute<{ dims: number; norm: number }>(sql`
			select vector_dims(vector) as dims, sqrt(inner_product(vector::vector(1024), vector::vector(1024)))::float8 as norm
			from embeddings where space_id = ${BGE_M3_Q8.id}`);
		expect(norms.length).toBeGreaterThan(0);
		for (const row of norms) {
			expect(row.dims).toBe(1024);
			expect(row.norm).toBeCloseTo(1, 4);
		}

		const ids = [go.id, designer.id, analyst.id, mobile.id];
		const nearest = async (text: string) => {
			const query = await embedQuery(adapter, space, text);
			if (query.status !== 'computed') throw new Error(`query not embedded: ${query.reason}`);
			const similarities = await candidateSimilarities(database.db, query.space, query.vector, ids);
			return [...similarities.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
		};
		expect(await nearest('бэкенд-разработчик микросервисов на Go, очереди сообщений')).toBe(go.id);
		expect(await nearest('дизайнер интерфейсов в Figma')).toBe(designer.id);
		expect(await nearest('аналитик данных, отчёты и дашборды')).toBe(analyst.id);
		expect(await nearest('разработчик мобильных приложений для iPhone')).toBe(mobile.id);
	}, 300_000);
});
