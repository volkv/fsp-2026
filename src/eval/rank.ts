// `rank` of the bridge: the product's category path for vacancies (docs/domain.md, sections 12.4, 12.7, 13.4) over a
// catalog of its own. A temporary database is created next to the application's one, migrated from this checkout, and
// gets the taxonomy release of the checkout. Every candidate is stored the way the product stores its evidence — the
// resume rows `resume.extract` inserts, the FSP facts and claims the synchronization drafts (without the FSP ID link and
// receipts, which do not enter a score) — and its evidence is computed by the `evidence.compute` handler from the job
// queue. A test result of the harness becomes a grade decision applied by the one owner of categories
// (`applyGradeDecisions`), so a candidate holds a category exactly when the product would give one. Each ranking then
// takes, for every vacancy, the categories it admits, the candidates of the ranking holding one of them, and
// `scoreCandidatesForVacancy` over those, with the reranker of the configured model adapter or with it switched off;
// the candidates without any category are answered apart («категория не подтверждена»). When a ranking asks for
// semantic similarity, the catalog gets vectors the way the stand does — the space of `EMBED_SPACE_ID` registered and
// built by the `embedding.reindex` handler with the configured embedder — and each ranking runs with that space active
// or with none (the FTS-only mode). Vectors exist only for candidates whose processing consent is in effect, so every
// candidate of such a catalog is an adult who gave it. The database is dropped when the command ends, whatever the
// outcome.
import { createHash, randomBytes } from 'node:crypto';
import { and, countDistinct, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { z } from 'zod';
import { CATALOG, GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import { admitCandidates, admittedCategories } from '$lib/server/categories/admission';
import { MemoryDecisions, type DecisionRecord } from '$lib/server/categories/decisions';
import { applyGradeDecisions } from '$lib/server/categories/publish';
import type { EmbedConfig } from '$lib/server/config';
import type { Database, Transaction } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import {
	candidateCategories,
	candidates,
	claims,
	consentEvents,
	embeddings,
	evidenceRuns,
	experienceEntries,
	legalDocuments,
	mlResults,
	pdOperators,
	searchSettings,
	sourceFacts,
	users,
	vacancies
} from '$lib/server/db/schema';
import { createEmbeddingReindexHandler } from '$lib/server/embeddings/reindex';
import { createEvidenceHandler } from '$lib/server/evidence/job';
import { ensureEmbeddingSpace } from '$lib/server/embeddings/space';
import type { EmbedModels } from '$lib/server/embeddings/vectors';
import { factClaims, loadProjectionTaxonomy, type ProjectionTaxonomy } from '$lib/server/fsp/projection';
import { uuidv7 } from '$lib/server/ids';
import { JobFailure } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { canonicalJson } from '$lib/server/json/canonical';
import { loadGradeOrdinals, loadVacancySnapshot } from '$lib/server/matching/evidence';
import { scoreCandidatesForVacancy } from '$lib/server/matching/rank';
import { loadActiveMatchRuleset } from '$lib/server/matching/ruleset';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { fail } from '$lib/server/ml/result';
import { RESUME_SCHEMA_VERSION } from '$lib/server/resumes/extract-job';
import { recordEvidenceChange } from '$lib/server/resumes/revision';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { checkVacancyText } from '$lib/server/vacancies/text-check';
import { fspPageSchema, pageFacts } from './evidence';

const isoDate = z.iso.date().transform((value) => new Date(`${value}T00:00:00Z`));
const record = z.record(z.string(), z.unknown());

const quoteSchema = z.strictObject({
	extraction_id: z.string(),
	block_id: z.string(),
	start: z.int().nonnegative(),
	end: z.int().nonnegative(),
	text: z.string()
});
const pointSchema = z.strictObject({ date: z.iso.date(), precision: z.enum(['month', 'year']) }).nullable();

/** The rows `resume.extract` inserts for one document (`evidence` of an extracted document). */
const evidenceSchema = z.strictObject({
	fact: z.strictObject({
		id: z.uuid(),
		sourceRecordRef: z.string().min(1),
		payload: record,
		payloadSha256: z.string().regex(/^[0-9a-f]{64}$/)
	}),
	claims: z.array(
		z.strictObject({
			id: z.uuid(),
			claimType: z.enum([
				'skill_mention',
				'experience_period',
				'role_title',
				'organization',
				'education',
				'team_role',
				'responsibility_marker',
				'language_level',
				'achievement_mention'
			]),
			experienceEntryId: z.uuid().nullable(),
			rawText: z.string(),
			polarity: z.enum(['asserted', 'negated', 'uncertain']),
			skillKey: z.string().nullable(),
			normalization: record.nullable(),
			value: record.nullable(),
			quote: quoteSchema
		})
	),
	entries: z.array(
		z.strictObject({
			id: z.uuid(),
			positionTitle: z.string().nullable(),
			roleKey: z.string().nullable(),
			organizationName: z.string().nullable(),
			period: z.strictObject({
				from: pointSchema,
				to: pointSchema,
				isCurrent: z.boolean(),
				status: z.enum(['valid', 'missing', 'invalid'])
			}),
			appliedSkillKeys: z.array(z.string()),
			quotes: z.array(quoteSchema).min(1)
		})
	)
});

/**
 * A test result of the harness (contracts 11.1): the specialization and grade tested and the outcome. The confirmed
 * stack follows from the grade (`confirmedStack`), not from the scores of the attempt.
 */
const testResultSchema = z.strictObject({
	specialization: z.enum(SPECIALIZATION_KEYS),
	grade: z.enum(GRADE_KEYS),
	outcome: z.enum(['confirmed', 'not_confirmed', 'undetermined'])
});

export const rankRequestSchema = z.strictObject({
	command: z.literal('rank'),
	/** «Now» of the catalog: the evidence calculation, recency of results and the dates of test decisions. */
	as_of: isoDate,
	candidates: z
		.array(
			z.strictObject({
				id: z.string().min(1),
				resume: z
					.strictObject({
						evidence: evidenceSchema,
						mode: z.enum(['rules_only', 'model']),
						/** Rules version or model id that produced the rows. */
						producer: z.string().min(1)
					})
					.nullable(),
				/** FSP achievements in the source's wire format. */
				fsp: fspPageSchema.nullable(),
				/**
				 * The decision of the candidate's test on the grade (contracts 11.1, `test_result`): a confirmed one gives the
				 * category; `null` — no test, no category.
				 */
				test_result: testResultSchema.nullable()
			})
		)
		.min(1),
	vacancies: z
		.array(
			z.strictObject({
				id: z.string().min(1),
				title: z.string().min(1),
				description: z.string().min(1),
				role_key: z.string().min(1),
				grade_min: z.string().min(1),
				grade_max: z.string().min(1),
				required_skill_keys: z.array(z.string().min(1)).min(1),
				nice_skill_keys: z.array(z.string().min(1))
			})
		)
		.min(1),
	rankings: z
		.array(
			z.strictObject({
				name: z.string().min(1),
				candidates: z.array(z.string().min(1)).min(1),
				reranker: z.boolean(),
				/** Semantic similarity in the space of the configured embedder; `false` — the FTS-only mode. */
				semantic: z.boolean()
			})
		)
		.min(1)
});

export type RankRequest = z.output<typeof rankRequestSchema>;

export interface RankDeps {
	/** The application's database: the temporary one is created on the same server. */
	databaseUrl: string;
	migrationsDir: string;
	taxonomyDir: string;
	/** The configured model adapter: the reranker of a ranking with `reranker: true` and the embedder of the catalog. */
	models: MatchingModels;
	/** The configured embedder (`EMBED_*`); `null` — none, and a ranking with `semantic: true` is refused. */
	embed: CatalogEmbedder | null;
}

/** The embedder of the stand, for a catalog: the model adapter checks a space against the catalog's own spaces. */
export interface CatalogEmbedder {
	config: Pick<EmbedConfig, 'model' | 'spaceId' | 'batchSize'>;
	models: (catalog: Database) => EmbedModels;
}

/** Vacancies of a ranking a model component was computed for, and the reasons it was not for the others. */
export interface ComponentUsage {
	used: number;
	unavailable: Record<string, number>;
}

export interface RankAnswer {
	/**
	 * Ranking → vacancy id → the candidate ids of the request holding a category the vacancy admits, best first; a
	 * vacancy no category admits (no role of a specialization, a grade no test confirms) has none.
	 */
	rankings: Record<string, Record<string, string[]>>;
	/** Ranking → vacancy id → the candidates of the ranking without any category, apart and unranked (domain 12.7). */
	unconfirmed: Record<string, Record<string, string[]>>;
	/** Ranking → vacancy id → the first ten with their score and the value of every component (`null` — unknown). */
	top: Record<string, Record<string, { id: string; score: number; components: Record<string, number | null> }[]>>;
	/** Ranking → vacancies the reranker scored, and the reasons it did not. */
	reranker: Record<string, ComponentUsage>;
	/** Ranking → vacancies with the semantic component, and the reasons `scoreCandidatesForVacancy` gives otherwise. */
	semantic: Record<string, ComponentUsage>;
	models: { match_ruleset: string; reranker: string; embedding_space: string };
	catalog: {
		candidates: number;
		/** Candidates with an evidence run published, and evidence jobs discarded as stale. */
		evidence: number;
		stale_jobs: number;
		/** Test results applied, and the categories in force they left. */
		test_results: number;
		categories: number;
		fsp_facts: number;
		/** Candidates and vacancies with vectors in the built space; `null` — the catalog has no space. */
		embedded: { candidates: number; vacancies: number } | null;
	};
	seconds: { catalog: number; embedding: number; ranking: number };
}

/** Models switched off: the ranking without the reranker; the semantic component reads stored vectors only. */
const MODELS_OFF: MatchingModels = {
	embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' }))
};

const SYSTEM = { kind: 'system' } as const;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function withTemporaryDatabase<T>(
	deps: RankDeps,
	work: (db: Database, client: postgres.Sql) => Promise<T>
): Promise<T> {
	const name = `eval_rank_${randomBytes(6).toString('hex')}`;
	const admin = postgres(deps.databaseUrl, { max: 1, onnotice: () => {} });
	try {
		await admin.unsafe(`create database ${name}`);
		try {
			const url = new URL(deps.databaseUrl);
			url.pathname = `/${name}`;
			const client = postgres(url.toString(), { max: 4, onnotice: () => {} });
			try {
				const db = drizzle({ client, schema, casing: 'snake_case' });
				await migrate(db, { migrationsFolder: deps.migrationsDir });
				return await work(db, client);
			} finally {
				await client.end({ timeout: 5 });
			}
		} finally {
			await admin.unsafe(`drop database if exists ${name} with (force)`);
		}
	} finally {
		await admin.end({ timeout: 5 });
	}
}

/**
 * The id of a candidate of the catalog: a UUID v7 whose time is the candidate's place in the request and whose other
 * bits come from its request id. The product breaks ties of equal scores by id — by creation time in a live catalog —
 * so the order of the request stands for it, and a repeated run ties the same way.
 */
function catalogId(index: number, requestId: string): string {
	const bytes = createHash('sha256').update(requestId, 'utf8').digest().subarray(0, 16);
	bytes.writeUIntBE(Date.UTC(2026, 0, 1) + index, 0, 6);
	bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
	bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Runs `worker` over the items with at most `limit` at a time, keeping their order. */
async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			for (let index = next++; index < items.length; index = next++) {
				results[index] = await worker(items[index] as T);
			}
		})
	);
	return results;
}

type Candidate = RankRequest['candidates'][number];
type Evidence = z.output<typeof evidenceSchema>;

/**
 * The resume rows of one document for one candidate, as `resume.extract` inserts them (with its `ml_results` row).
 * The same document stands behind several candidates of the catalog, so its row ids are drawn anew for each.
 */
async function insertResume(
	tx: Transaction,
	candidateId: string,
	resume: NonNullable<Candidate['resume']>,
	taxonomyVersionId: string,
	now: Date
): Promise<void> {
	const evidence: Evidence = resume.evidence;
	const factId = uuidv7();
	const entryIds = new Map(evidence.entries.map((entry) => [entry.id, uuidv7()]));
	const claimIds = new Map(evidence.claims.map((claim) => [claim.id, uuidv7()]));
	const mlResultId = uuidv7();
	await tx.insert(mlResults).values({
		id: mlResultId,
		operation: 'extract',
		inputRef: { type: 'document_extraction', id: evidence.fact.payload['extraction_id'] ?? null },
		inputSha256: sha256(canonicalJson(evidence)),
		inputVersion: '1',
		schemaVersion: RESUME_SCHEMA_VERSION,
		taxonomyVersionId,
		model: resume.mode === 'model' ? { modelId: resume.producer } : null,
		rulesVersion: resume.mode === 'rules_only' ? resume.producer : null,
		processingMode: resume.mode,
		evidenceRefs: {
			fact_id: factId,
			claims: [...claimIds.values()],
			experience_entries: [...entryIds.values()]
		}
	});
	await tx.insert(sourceFacts).values({
		id: factId,
		candidateId,
		source: 'resume',
		factType: 'resume_document',
		sourceRecordRef: evidence.fact.sourceRecordRef,
		trustLevel: 'claimed',
		ownershipBasis: 'self_upload',
		payload: evidence.fact.payload,
		payloadSha256: evidence.fact.payloadSha256,
		observedAt: now,
		lastVerifiedAt: now,
		status: 'active'
	});
	if (evidence.entries.length > 0) {
		await tx.insert(experienceEntries).values(
			evidence.entries.map((entry) => ({
				id: entryIds.get(entry.id) as string,
				candidateId,
				factId,
				positionTitle: entry.positionTitle,
				roleKey: entry.roleKey,
				organizationName: entry.organizationName,
				periodFrom: entry.period.from?.date ?? null,
				periodTo: entry.period.to?.date ?? null,
				periodFromPrecision: entry.period.from?.precision ?? null,
				periodToPrecision: entry.period.to?.precision ?? null,
				isCurrent: entry.period.isCurrent,
				appliedSkillKeys: entry.appliedSkillKeys,
				quotes: entry.quotes,
				periodStatus: entry.period.status,
				status: 'active' as const
			}))
		);
	}
	if (evidence.claims.length > 0) {
		await tx.insert(claims).values(
			evidence.claims.map((claim) => {
				const entryId = claim.experienceEntryId === null ? null : entryIds.get(claim.experienceEntryId);
				if (entryId === undefined) throw new Error(`claim ${claim.id} refers to an entry the document has not`);
				return {
					id: claimIds.get(claim.id) as string,
					candidateId,
					factId,
					claimType: claim.claimType,
					experienceEntryId: entryId,
					rawText: claim.rawText,
					polarity: claim.polarity,
					skillKey: claim.skillKey,
					normalization: claim.normalization,
					value: claim.value,
					quote: claim.quote,
					extractor: resume.mode === 'model' ? ('model' as const) : ('rules' as const),
					mlResultId,
					status: 'active' as const
				};
			})
		);
	}
}

/** The FSP facts and claims of the page, as the synchronization inserts new records. Returns the facts stored. */
async function insertFsp(
	tx: Transaction,
	candidateId: string,
	page: NonNullable<Candidate['fsp']>,
	projection: ProjectionTaxonomy,
	now: Date
): Promise<number> {
	const drafts = pageFacts(page);
	for (const fact of drafts) {
		const [row] = await tx
			.insert(sourceFacts)
			.values({
				candidateId,
				source: 'fsp',
				factType: fact.factType,
				sourceRecordRef: fact.sourceRecordRef,
				eventKey: fact.eventKey,
				trustLevel: 'fsp_verified',
				// The record is the person's by an operator's confirmation here, not by an FSP ID link with its consent.
				ownershipBasis: 'operator_confirmed',
				payload: fact.payload,
				payloadSha256: fact.payloadSha256,
				sourceVersion: page.sourceVersion,
				observedAt: now,
				lastVerifiedAt: now,
				occurredOn: fact.occurredOn,
				status: fact.status
			})
			.returning({ id: sourceFacts.id });
		if (!row) throw new Error('fsp fact was not inserted');
		const drafted = factClaims(fact, page.athlete.birthYear, projection);
		if (drafted.length > 0) {
			await tx.insert(claims).values(
				drafted.map((claim) => ({
					candidateId,
					factId: row.id,
					claimType: claim.claimType,
					rawText: claim.rawText,
					polarity: 'asserted' as const,
					skillKey: claim.skillKey,
					value: claim.value,
					extractor: 'source_mapping' as const,
					status: 'active' as const
				}))
			);
		}
	}
	return drafts.length;
}

type TestResult = NonNullable<Candidate['test_result']>;

/** A deterministic id of the decision of a candidate's test: a repeated run applies the same decision. */
function decisionId(requestId: string): string {
	const hex = createHash('sha256').update(`eval-decision:${requestId}`, 'utf8').digest('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The release the decisions of the harness name: they are not drawn from a bank. */
const EVAL_RELEASE = 'eval-test-results';

/**
 * The grade decision a test result of the harness stands for, as the engine of the test would record it (domain
 * 10.7): not a step of a confident result, with the practice solved in the first language of the specialization when
 * the result is confirmed.
 */
function decisionOf(requestId: string, result: TestResult, decidedAt: Date): DecisionRecord {
	const specialization = CATALOG.specializations.find((s) => s.key === result.specialization);
	if (!specialization) throw new Error(`catalog ${CATALOG.version} has no specialization ${result.specialization}`);
	const confirmed = result.outcome === 'confirmed';
	const language = specialization.practiceLanguages[0];
	if (confirmed && !language) throw new Error(`specialization ${result.specialization} has no practice language`);
	return {
		id: decisionId(requestId),
		specialization: result.specialization,
		grade: result.grade,
		outcome: result.outcome,
		confident: false,
		viaConfidentUpgrade: false,
		decidedAt,
		valid: true,
		bankReleaseId: EVAL_RELEASE,
		catalogVersion: CATALOG.version,
		practiceLanguage: confirmed ? (language ?? null) : null,
		invalidReason: null
	};
}

/** Runs `evidence.compute` jobs until the queue has none, four at a time. */
async function computeEvidenceAll(db: Database, asOf: Date): Promise<{ succeeded: number; stale: number }> {
	const handler = createEvidenceHandler(() => asOf);
	const log = createLogger({}, (_level, line) => process.stderr.write(`${line}\n`));
	const counts = { succeeded: 0, stale: 0 };
	const lane = async (worker: string) => {
		for (;;) {
			const claimed = await claimJob(db, worker, ['evidence.compute']);
			if (claimed === null) return;
			if (claimed.type !== 'evidence.compute') throw new Error(`captured a ${claimed.type} job`);
			const job = {
				...claimed,
				type: 'evidence.compute' as const,
				payload: JOB_TYPES['evidence.compute'].payload.parse(claimed.payload)
			};
			let result;
			try {
				result = await handler.run({
					job,
					db,
					signal: new AbortController().signal,
					requestId: `job:${job.id}`,
					log
				});
			} catch (error) {
				if (error instanceof JobFailure) {
					throw new Error(`evidence calculation failed: ${error.code} ${error.message}`, { cause: error });
				}
				throw error;
			}
			const outcome = await completeJob(db, job, result);
			if (outcome === 'lease_lost') throw new Error(`evidence job ${job.id} lost its lease`);
			counts[outcome === 'succeeded' ? 'succeeded' : 'stale']++;
		}
	};
	await Promise.all(['eval-1', 'eval-2', 'eval-3', 'eval-4'].map(lane));
	return counts;
}

/** Adults of the catalog: a birth date the age rules read as 18+ at any «now» of a dataset. */
const ADULT_BIRTH_DATE = '1990-01-01';

/**
 * The processing consent document the candidates of a catalog with vectors grant, published a day before «now»: the
 * reindex gives vectors only to candidates whose `pd_processing` is in effect.
 */
async function publishProcessingDocument(db: Database, now: Date): Promise<string> {
	const published = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const operator = {
		legalName: 'Оценка качества',
		inn: '0000000000',
		ogrn: '0000000000000',
		address: 'временная база оценки',
		contactEmail: 'eval@example.com',
		validFrom: published.toISOString().slice(0, 10)
	};
	const [row] = await db.insert(pdOperators).values(operator).returning({ id: pdOperators.id });
	if (!row) throw new Error('pd operator was not inserted');
	const body = 'Согласие на обработку персональных данных в каталоге оценки качества.';
	const [document] = await db
		.insert(legalDocuments)
		.values({
			kind: 'pd_processing',
			version: 1,
			title: 'Согласие на обработку персональных данных',
			body,
			bodySha256: sha256(body),
			pdOperatorId: row.id,
			operatorSnapshot: operator,
			processorsSnapshot: [],
			purposes: ['evaluation'],
			dataCategories: ['profile'],
			operations: ['processing'],
			form: 'electronic_separate_screen',
			available: true,
			requiresReconsent: false,
			publishedAt: published
		})
		.returning({ id: legalDocuments.id });
	if (!document) throw new Error('processing consent document was not inserted');
	return document.id;
}

interface BuiltSpace {
	spaceId: string;
	candidates: number;
	vacancies: number;
}

/** Registers the space of the configured embedder and runs the `embedding.reindex` job it enqueues: every vector of
 * the catalog, then the switch to the space. */
async function buildSpace(db: Database, embed: CatalogEmbedder, asOf: Date): Promise<BuiltSpace> {
	const { config } = embed;
	const ensured = await ensureEmbeddingSpace(db, { model: config.model, spaceId: config.spaceId });
	if (ensured.status === 'not_configured') throw new Error('the embedding space was not registered');
	const models = embed.models(db);
	const handler = createEmbeddingReindexHandler({
		models: () => models,
		pageSize: () => config.batchSize * 4,
		now: () => asOf
	});
	const log = createLogger({}, (_level, line) => process.stderr.write(`${line}\n`));
	const claimed = await claimJob(db, 'eval-embed', ['embedding.reindex']);
	if (claimed?.type !== 'embedding.reindex') throw new Error('embedding.reindex was not enqueued');
	const job = {
		...claimed,
		type: 'embedding.reindex' as const,
		payload: JOB_TYPES['embedding.reindex'].payload.parse(claimed.payload)
	};
	let result;
	try {
		result = await handler.run({ job, db, signal: new AbortController().signal, requestId: `job:${job.id}`, log });
	} catch (error) {
		if (error instanceof JobFailure) {
			throw new Error(`embedding reindex failed: ${error.code} ${error.message}`, { cause: error });
		}
		throw error;
	}
	const outcome = await completeJob(db, job, result);
	if (outcome !== 'succeeded') throw new Error(`embedding reindex ended ${outcome}`);
	const [settings] = await db.select({ active: searchSettings.activeEmbeddingSpaceId }).from(searchSettings);
	if (settings?.active !== ensured.spaceId) throw new Error(`embedding space ${ensured.spaceId} was not activated`);
	const owners = async (ownerType: 'candidate_section' | 'vacancy') => {
		const [row] = await db
			.select({ n: countDistinct(embeddings.ownerId) })
			.from(embeddings)
			.where(and(eq(embeddings.spaceId, ensured.spaceId), eq(embeddings.ownerType, ownerType)));
		return row?.n ?? 0;
	};
	return {
		spaceId: ensured.spaceId,
		candidates: await owners('candidate_section'),
		vacancies: await owners('vacancy')
	};
}

/** The space search reads: the built one for a ranking with semantic similarity, none (FTS-only) otherwise. */
async function activateSpace(db: Database, spaceId: string | null): Promise<void> {
	await db.update(searchSettings).set({ activeEmbeddingSpaceId: spaceId });
}

export async function rankCandidates(request: RankRequest, deps: RankDeps): Promise<RankAnswer> {
	const now = request.as_of;
	const semanticRankings = request.rankings.some((ranking) => ranking.semantic);
	const embed = deps.embed;
	if (semanticRankings && embed === null) {
		throw new Error('a ranking asks for semantic similarity and no embedder is configured (EMBED_*)');
	}
	return withTemporaryDatabase(deps, async (db, client) => {
		const started = performance.now();
		const consentDocumentId = semanticRankings ? await publishProcessingDocument(db, now) : null;
		const published = await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(deps.taxonomyDir)));
		const projection = await loadProjectionTaxonomy(db);
		if (!projection) throw new Error('the taxonomy release was not published');
		const ruleset = await loadActiveMatchRuleset(db);
		const ordinals = (await loadGradeOrdinals(db, [published.taxonomyVersionId])).get(published.taxonomyVersionId);
		if (!ordinals) throw new Error('grade ordinals of the release were not loaded');

		const idOf = new Map<string, string>();
		const decisions = new MemoryDecisions();
		let facts = 0;
		let testResults = 0;
		const indexOf = new Map(request.candidates.map((candidate, index) => [candidate.id, index]));
		if (indexOf.size !== request.candidates.length) throw new Error('candidate ids of the request repeat');
		await pool(request.candidates, 4, async (candidate) => {
			const candidateId = await db.transaction(async (tx) => {
				const [user] = await tx
					.insert(users)
					.values({
						status: 'active',
						// A catalog of the evaluation: no person, no address; the columns hold the candidate's id.
						emailEnc: Buffer.from(candidate.id),
						emailHmac: `eval:${candidate.id}`,
						emailVerifiedAt: now
					})
					.returning({ id: users.id });
				if (!user) throw new Error('user was not inserted');
				const [row] = await tx
					.insert(candidates)
					.values({
						id: catalogId(indexOf.get(candidate.id) as number, candidate.id),
						userId: user.id,
						status: 'active',
						searchStatus: 'active',
						preferences: {},
						...(consentDocumentId === null
							? {}
							: {
									birthDate: ADULT_BIRTH_DATE,
									birthDatePrecision: 'day' as const,
									birthDateSource: 'self_declared' as const,
									birthDateStatus: 'unverified' as const
								})
					})
					.returning({ id: candidates.id });
				if (!row) throw new Error('candidate was not inserted');
				if (consentDocumentId !== null) {
					await tx.insert(consentEvents).values({
						subjectCandidateId: row.id,
						kind: 'pd_processing',
						documentId: consentDocumentId,
						action: 'grant',
						signerKind: 'subject',
						signerUserId: user.id,
						method: 'separate_screen_button',
						evidence: { granted_by: 'evaluation catalog' },
						occurredAt: new Date(now.getTime() - 60 * 60 * 1000)
					});
				}
				if (candidate.resume !== null || candidate.fsp !== null) {
					if (candidate.resume !== null) {
						await insertResume(tx, row.id, candidate.resume, published.taxonomyVersionId, now);
					}
					if (candidate.fsp !== null) {
						const added = await insertFsp(tx, row.id, candidate.fsp, projection, now);
						facts += added;
					}
					await recordEvidenceChange(tx, {
						candidateId: row.id,
						withdrawal: false,
						reason: 'evaluation_catalog',
						requestId: 'eval-rank',
						actor: SYSTEM,
						createdBy: SYSTEM
					});
				}
				if (candidate.test_result !== null) {
					const decision = decisionOf(candidate.id, candidate.test_result, now);
					decisions.record(row.id, decision);
					await applyGradeDecisions(
						tx,
						row.id,
						decision.specialization,
						{ requestId: 'eval-rank', actor: SYSTEM },
						decisions
					);
					testResults++;
				}
				return row.id;
			});
			idOf.set(candidate.id, candidateId);
		});
		const evidence = await computeEvidenceAll(db, now);
		const [held] = await db
			.select({ n: countDistinct(candidateCategories.id) })
			.from(candidateCategories)
			.where(eq(candidateCategories.status, 'active'));
		const [runs] = await db
			.select({ n: countDistinct(evidenceRuns.candidateId) })
			.from(evidenceRuns)
			.where(eq(evidenceRuns.status, 'published'));

		const vacancyIds = new Map<string, string>();
		for (const vacancy of request.vacancies) {
			const [row] = await db
				.insert(vacancies)
				.values({
					origin: 'external',
					externalOrg: { name: 'Оценка качества', source_org_ids: [] },
					title: vacancy.title,
					description: vacancy.description,
					taxonomyVersionId: published.taxonomyVersionId,
					roleKey: vacancy.role_key,
					gradeMin: vacancy.grade_min,
					gradeMax: vacancy.grade_max,
					gradeBasis: 'stated',
					requiredSkillKeys: vacancy.required_skill_keys,
					niceSkillKeys: vacancy.nice_skill_keys,
					textCheck: checkVacancyText({ title: vacancy.title, description: vacancy.description }),
					status: 'active'
				})
				.returning({ id: vacancies.id });
			if (!row) throw new Error('vacancy was not inserted');
			vacancyIds.set(vacancy.id, row.id);
		}
		const catalogSeconds = (performance.now() - started) / 1000;
		const embeddingStarted = performance.now();
		const space = semanticRankings && embed !== null ? await buildSpace(db, embed, now) : null;
		const embeddingSeconds = (performance.now() - embeddingStarted) / 1000;

		const requestIdOf = new Map([...idOf].map(([requestId, id]) => [id, requestId]));
		const rankings: RankAnswer['rankings'] = {};
		const unconfirmed: RankAnswer['unconfirmed'] = {};
		const top: RankAnswer['top'] = {};
		const reranker: RankAnswer['reranker'] = {};
		const semantic: RankAnswer['semantic'] = {};
		let rerankerModel: string | null = null;
		const rankingStarted = performance.now();
		for (const ranking of request.rankings) {
			await activateSpace(db, ranking.semantic && space !== null ? space.spaceId : null);
			const ids = ranking.candidates.map((id) => {
				const stored = idOf.get(id);
				if (stored === undefined) throw new Error(`ranking ${ranking.name} names an unknown candidate ${id}`);
				return stored;
			});
			const byVacancy: Record<string, string[]> = {};
			const apart: Record<string, string[]> = {};
			const topOf: RankAnswer['top'][string] = {};
			const usage: ComponentUsage = { used: 0, unavailable: {} };
			const semanticUsage: ComponentUsage = { used: 0, unavailable: {} };
			for (const vacancy of request.vacancies) {
				const snapshot = await loadVacancySnapshot(db, vacancyIds.get(vacancy.id) as string);
				if (!snapshot) throw new Error(`vacancy ${vacancy.id} is not readable`);
				const admission = await admitCandidates(db, ids, admittedCategories(snapshot, ordinals));
				apart[vacancy.id] = admission.unconfirmed.map((id) => requestIdOf.get(id) as string);
				const scoring = await scoreCandidatesForVacancy(
					db,
					ranking.reranker ? deps.models : MODELS_OFF,
					snapshot,
					admission.admitted,
					{ ruleset, priority: 'background' }
				);
				if (scoring.ranked.length !== admission.admitted.length) {
					throw new Error(
						`vacancy ${vacancy.id}: ${scoring.ranked.length} of ${admission.admitted.length} candidates ranked`
					);
				}
				byVacancy[vacancy.id] = scoring.ranked.map((entry) => requestIdOf.get(entry.snapshot.id) as string);
				topOf[vacancy.id] = scoring.ranked.slice(0, 10).map((entry) => ({
					id: requestIdOf.get(entry.snapshot.id) as string,
					score: entry.result.score,
					components: Object.fromEntries(
						Object.entries(entry.result.components).map(([key, component]) => [key, component.value])
					)
				}));
				if (scoring.reranker.status === 'used') {
					usage.used++;
					const scored = scoring.ranked.find((entry) => entry.result.components.reranker.status === 'computed');
					rerankerModel ??= scored?.result.components.reranker.details.model_id ?? null;
				} else {
					const reason = scoring.reranker.reason ?? 'unknown';
					usage.unavailable[reason] = (usage.unavailable[reason] ?? 0) + 1;
				}
				if (scoring.semantic.reason === null) semanticUsage.used++;
				else {
					const reason = scoring.semantic.reason;
					semanticUsage.unavailable[reason] = (semanticUsage.unavailable[reason] ?? 0) + 1;
				}
			}
			rankings[ranking.name] = byVacancy;
			unconfirmed[ranking.name] = apart;
			top[ranking.name] = topOf;
			reranker[ranking.name] = usage;
			semantic[ranking.name] = semanticUsage;
		}
		return {
			rankings,
			unconfirmed,
			top,
			reranker,
			semantic,
			models: {
				match_ruleset: String(ruleset.version),
				reranker: rerankerModel ?? 'none',
				embedding_space: space?.spaceId ?? 'none'
			},
			catalog: {
				candidates: request.candidates.length,
				evidence: runs?.n ?? 0,
				stale_jobs: evidence.stale,
				test_results: testResults,
				categories: held?.n ?? 0,
				fsp_facts: facts,
				embedded: space === null ? null : { candidates: space.candidates, vacancies: space.vacancies }
			},
			seconds: {
				catalog: Math.round(catalogSeconds * 10) / 10,
				embedding: Math.round(embeddingSeconds * 10) / 10,
				ranking: Math.round(((performance.now() - rankingStarted) / 1000) * 10) / 10
			}
		};
	});
}
