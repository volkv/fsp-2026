// `rank` of the bridge: the product's path from a hiring need to its shortlist (docs/domain.md, sections 12.4, 12.7,
// 13.10; contracts 10) over a catalog of its own. A temporary database is created next to the application's one,
// migrated from this checkout, and gets the taxonomy release of the checkout. Every candidate is stored the way the
// product stores its evidence — the resume rows `resume.extract` inserts, the FSP facts and claims the synchronization
// drafts (without the FSP ID link and receipts, which do not enter a score), the answers of the survey — and its evidence
// is computed by the `evidence.compute` handler from the job queue. The decisions of a candidate's tests are written in
// their order where the engine writes a decision — a decided attempt marked synthetic, the practice item scored in the
// language it was solved in, and its row of `grade_decisions` with the sums of its blocks, under a release of the
// harness that opens the specialization — and each is brought to the category by the one owner of categories
// (`applyGradeDecisions`), so a candidate holds a category, with its confirmed stack, exactly when the product would
// give one. Every need is a text parsed by the product's rules (`parseNeedText` with the model off); its categories are
// the ones a new shortlist takes by default (`defaultCategories`). A ranking admits for a need the candidates holding
// one of them (`categories`), exactly the set it names (`given`: the sorting of one set fixed before the run), or —
// the experiment without a test — those whose grade hint is one of them (`grade_hint`); they are ranked by
// `rankForNeed`, the ranking of a shortlist, and the candidates without any category are answered apart («категория не
// подтверждена»). When a ranking asks for semantic similarity, the catalog gets vectors the way the stand does — the
// space of `EMBED_SPACE_ID` registered and built by the `embedding.reindex` handler with the configured embedder — and
// the text of the need orders the almost equal; without it the ranking runs in the FTS-only mode. Vectors exist only for
// candidates whose processing consent is in effect, so every candidate of such a catalog is an adult who gave it. The
// database is dropped when the command ends, whatever the outcome.
import { createHash, randomBytes } from 'node:crypto';
import { and, countDistinct, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { z } from 'zod';
import {
	CATALOG,
	blockDefinition,
	GRADE_KEYS,
	gradeDefinition,
	PRACTICE_LANGUAGE_KEYS,
	practiceWritesCode,
	SPECIALIZATION_KEYS,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { GRADE_POLICY } from '$lib/server/assessments/contract/policy';
import { PROCEDURE } from '$lib/server/assessments/contract/procedure';
import { GRADE_DECISIONS } from '$lib/server/categories/decisions';
import { candidatePreferencesSchema } from '$lib/server/candidates/preferences';
import { applyGradeDecisions } from '$lib/server/categories/publish';
import { activeCategories, categoryPredicate } from '$lib/server/categories/read';
import type { EmbedConfig } from '$lib/server/config';
import type { Database, Transaction } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import {
	bankReleases,
	candidateCategories,
	candidates,
	candidateSurveys,
	claims,
	consentEvents,
	embeddings,
	evidenceRuns,
	experienceEntries,
	gradeDecisions,
	gradeDeclarations,
	legalDocuments,
	mlResults,
	pdOperators,
	searchSettings,
	sourceFacts,
	testAttempts,
	testItems,
	users
} from '$lib/server/db/schema';
import { createEmbeddingReindexHandler } from '$lib/server/embeddings/reindex';
import { createEvidenceHandler } from '$lib/server/evidence/job';
import { computeGradeHint } from '$lib/server/grades/declarations';
import { declaredWithoutCategory } from '$lib/server/grades/current';
import { ensureEmbeddingSpace } from '$lib/server/embeddings/space';
import type { EmbedModels } from '$lib/server/embeddings/vectors';
import { factClaims, loadProjectionTaxonomy, type ProjectionTaxonomy } from '$lib/server/fsp/projection';
import { uuidv7 } from '$lib/server/ids';
import { JobFailure } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { canonicalJson } from '$lib/server/json/canonical';
import { rankForNeed, type RankedForNeed } from '$lib/server/matching/rank';
import { loadActiveMatchRuleset } from '$lib/server/matching/ruleset';
import type { NeedSpec } from '$lib/server/matching/score';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { GRADE_DECISION_RESULTS } from '$lib/server/matching/test-results';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import { fail } from '$lib/server/ml/result';
import { parseNeedText } from '$lib/server/needs/parse';
import { memoryTextParseCache } from '$lib/server/vacancies/text-extract';
import { compositeSpecializations } from '$lib/server/needs/recommend';
import { defaultCategories } from '$lib/server/shortlists/service';
import { openSpecializations } from '$lib/server/assessments/bank-store';
import { RESUME_SCHEMA_VERSION } from '$lib/server/resumes/extract-job';
import { recordEvidenceChange } from '$lib/server/resumes/revision';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
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
 * A decision of a test of the harness (contracts 10.1): the specialization and grade tested, the outcome, the sums of its
 * blocks and the language the practice program was written in. The confirmed stack follows from the grade and that
 * language (`confirmedStack`), not from the scores of the attempt; the blocks are the strength of the result the ranking
 * reads. A practice that is code the candidate writes names its language on a confirmation; a practice that is not
 * (QA: test cases a harness runs) names none — no language is the candidate's there.
 */
const testResultSchema = z
	.strictObject({
		specialization: z.enum(SPECIALIZATION_KEYS),
		grade: z.enum(GRADE_KEYS),
		outcome: z.enum(['confirmed', 'not_confirmed', 'undetermined']),
		practice_language: z.enum(PRACTICE_LANGUAGE_KEYS).optional(),
		blocks: z
			.array(
				z.strictObject({
					block: z.string().min(1),
					items: z.int().min(1),
					score: z.int().nonnegative(),
					cut: z.int().nonnegative()
				})
			)
			.optional()
	})
	.superRefine((result, context) => {
		const writesCode = practiceWritesCode(gradeDefinition(result.specialization, result.grade));
		if (!writesCode && result.practice_language !== undefined) {
			context.addIssue({
				code: 'custom',
				path: ['practice_language'],
				message: `the practice of ${result.specialization} × ${result.grade} is not code the candidate writes`
			});
		}
		if (writesCode && result.outcome === 'confirmed' && result.practice_language === undefined) {
			context.addIssue({
				code: 'custom',
				path: ['practice_language'],
				message: 'a confirmation of a practice program names its language'
			});
		}
	});

export const rankRequestSchema = z.strictObject({
	command: z.literal('rank'),
	/** «Now» of the catalog: the evidence calculation, recency of results and the dates of test decisions. */
	as_of: isoDate,
	candidates: z
		.array(
			z
				.strictObject({
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
					/** What the candidate answered in the survey (`candidates.preferences`); absent — nothing. */
					preferences: candidatePreferencesSchema.optional(),
					/**
					 * The decisions of the candidate's tests on the grade, oldest first (contracts 10.1, `test_result`): a
					 * confirmed one gives the category; none — no test, no category.
					 */
					test_results: z.array(testResultSchema),
					/**
					 * Grades the candidate declared in the survey of a specialization without taking its test (domain 12.2):
					 * no category, and the group «грейд не подтверждён» of a shortlist of the declared category, as in the
					 * product. One per specialization; a specialization of `test_results` has the declaration its test was
					 * taken on.
					 */
					declared: z
						.array(z.strictObject({ specialization: z.enum(SPECIALIZATION_KEYS), grade: z.enum(GRADE_KEYS) }))
						.default([])
				})
				.superRefine((candidate, context) => {
					const tested = new Set(candidate.test_results.map((result) => result.specialization));
					const seen = new Set<string>();
					for (const [index, declaration] of candidate.declared.entries()) {
						if (seen.has(declaration.specialization) || tested.has(declaration.specialization)) {
							context.addIssue({
								code: 'custom',
								path: ['declared', index, 'specialization'],
								message: seen.has(declaration.specialization)
									? 'one declaration per specialization'
									: 'a tested specialization has the declaration of its test'
							});
						}
						seen.add(declaration.specialization);
					}
				})
		)
		.min(1),
	/**
	 * Specializations whose test the catalog has released, besides those of the decisions of the request: what a need
	 * may be read into and shortlisted from.
	 */
	open_specializations: z.array(z.enum(SPECIALIZATION_KEYS)).default([]),
	/** Hiring needs as an employer writes them: the text is parsed by the product's rules. */
	needs: z.array(z.strictObject({ id: z.string().min(1), text: z.string().min(1).max(5000) })).min(1),
	rankings: z
		.array(
			z
				.strictObject({
					name: z.string().min(1),
					candidates: z.array(z.string().min(1)).min(1),
					/** Semantic similarity in the space of the configured embedder; `false` — the FTS-only mode. */
					semantic: z.boolean(),
					/**
					 * Who a need's shortlist ranks: `categories` — the candidates holding a category the shortlist takes, as the
					 * product admits them; `given` — exactly the candidates `per_need` names; `grade_hint` — the experiment
					 * without a test (contracts 10.1, `resume_only`): the candidates whose grade hint of a specialization of the
					 * shortlist is one of its grades, marked unconfirmed.
					 */
					admission: z.enum(['categories', 'given', 'grade_hint']),
					/** Need id → the candidates of the ranking the need considers; absent — all of them. */
					per_need: z.record(z.string(), z.array(z.string().min(1))).optional()
				})
				.refine((ranking) => ranking.admission !== 'given' || ranking.per_need !== undefined, {
					message: 'a ranking of given sets names the set of every need'
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
	/** The configured model adapter: the embedder of a ranking with semantic similarity. */
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

export interface TopEntry {
	id: string;
	score: number;
	components: Record<string, number | null>;
	reasons: unknown[];
	gaps: string[];
	to_verify: string[];
}

export interface RankAnswer {
	/**
	 * Ranking → need id → the candidate ids of the request holding a category of the need's shortlist, best first; a
	 * need with no category (no open specialization, no skill a test confirms) has none.
	 */
	rankings: Record<string, Record<string, string[]>>;
	/** Ranking → need id → the candidates of the ranking without any category, apart and unranked (domain 12.7). */
	unconfirmed: Record<string, Record<string, string[]>>;
	/**
	 * Ranking → need id → the group «грейд не подтверждён» of a ranking admitting by categories, in the order the shortlist
	 * shows it after every candidate of `rankings` (domain 13.10): no category of the shortlist's specializations and a
	 * declaration — the grade of the candidate's last test there, or declared without a test (`declared`) — naming one of
	 * its categories. Not of the confirmed pool.
	 */
	declared: Record<string, Record<string, string[]>>;
	/**
	 * Ranking → need id → the first ten with their score, the contribution of every component and what the product says
	 * of them: the reasons with their sources, the required skills with no basis, the skills resting on words alone.
	 */
	top: Record<string, Record<string, TopEntry[]>>;
	/** Ranking → need id → the first ten of the group «грейд не подтверждён» (`declared`), explained the same way. */
	declared_top: Record<string, Record<string, TopEntry[]>>;
	/** Candidate id → the categories in force after its decisions, with the skills each confirms. */
	categories: Record<string, { specialization: string; grade: string; confirmed_skill_keys: string[] }[]>;
	/** Ranking → needs whose almost equal the semantic similarity could order, and the reasons it could not. */
	semantic: Record<string, ComponentUsage>;
	/** Need id → what the rules read of its text and the categories of its shortlist. */
	needs: Record<
		string,
		{
			specialization: string | null;
			grade: string | null;
			skill_keys: string[];
			nice_skill_keys: string[];
			categories: string[];
		}
	>;
	models: { match_ruleset: string; embedding_space: string };
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

/** Models switched off: the FTS-only mode and the need parsed by the rules. */
const MODELS_OFF: MatchingModels & Pick<ModelAdapter, 'extract' | 'extractModelKey'> = {
	embed: () => Promise.resolve(fail('disabled', 'embed: switched off', { reason: 'switched_off' })),
	rerank: () => Promise.resolve(fail('disabled', 'rerank: switched off', { reason: 'switched_off' })),
	extract: () => Promise.resolve(fail('disabled', 'extract: switched off', { reason: 'switched_off' })),
	extractModelKey: () => Promise.resolve(null)
};

const SYSTEM = { kind: 'system' } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
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

type TestResult = Candidate['test_results'][number];

/** A deterministic id of a decision of a candidate's test: a repeated run applies the same decisions. */
function decisionId(requestId: string, index: number): string {
	const hex = createHash('sha256').update(`eval-decision:${requestId}:${index}`, 'utf8').digest('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The release of the harness's tests in a specialization: its decisions are synthetic, not drawn from a bank. */
const evalRelease = (specialization: SpecializationKey) => `eval-${specialization}`;

/**
 * Releases a test of every specialization of the catalog the request tests, so that the product sees them open
 * (`specializationOpen`) exactly as after a released bank. The release has no families: the harness never serves items,
 * it writes decisions.
 */
async function releaseHarnessTests(db: Database, specializations: ReadonlySet<SpecializationKey>, now: Date) {
	const zero = '0'.repeat(64);
	for (const specialization of specializations) {
		await db.insert(bankReleases).values({
			id: evalRelease(specialization),
			specialization,
			catalogVersion: CATALOG.version,
			procedureVersion: PROCEDURE.version,
			contentSha256: zero,
			sharedSha256: zero,
			manifest: { families: [] },
			status: 'released',
			releasedAt: now
		});
	}
}

/**
 * The decision a test result of the harness stands for, written where the engine writes one (domain 10.7): a decided
 * attempt marked synthetic (`seeded`, 23.3), the practice item it was solved by — scored, in its language, which is what
 * the confirmed stack reads (`decisionRecords`) — and its row of `grade_decisions` with the sums of its blocks, the
 * strength the ranking reads. Not a step of a confident result.
 */
interface Survey {
	id: string;
	specialization: SpecializationKey;
}

/**
 * A declaration of a grade in the survey of its specialization (domain 12.2) — the one a test was taken on, or one of
 * a candidate who has not taken the test — a new survey version when the specialization changes, as the product makes
 * one. The declared stack of the survey is the stack of the grade's defining blocks: the bridge has no answers of the
 * survey, and no score reads that stack.
 */
async function recordDeclaration(
	tx: Transaction,
	candidateId: string,
	result: { specialization: SpecializationKey; grade: GradeKey },
	declaredAt: Date,
	taxonomyVersionId: string,
	surveys: Survey[]
): Promise<void> {
	let survey = surveys.at(-1);
	if (survey?.specialization !== result.specialization) {
		const direction = CATALOG.specializations.find((s) => s.key === result.specialization)?.direction;
		const stack = [
			...new Set(
				gradeDefinition(result.specialization, result.grade).defining.flatMap(
					(block) => blockDefinition(block).skillKeys
				)
			)
		].slice(0, 10);
		if (!direction || stack.length === 0) throw new Error(`no survey of ${result.specialization} × ${result.grade}`);
		const [inserted] = await tx
			.insert(candidateSurveys)
			.values({
				candidateId,
				version: surveys.length + 1,
				catalogVersion: CATALOG.version,
				taxonomyVersionId,
				direction,
				specialization: result.specialization,
				declaredSkillKeys: stack,
				preferences: {},
				createdAt: declaredAt
			})
			.returning({ id: candidateSurveys.id });
		if (!inserted) throw new Error('survey was not inserted');
		survey = { id: inserted.id, specialization: result.specialization };
		surveys.push(survey);
	}
	await tx.insert(gradeDeclarations).values({
		candidateId,
		surveyId: survey.id,
		specialization: result.specialization,
		grade: result.grade,
		hint: { suggested: null },
		declaredAt
	});
}

async function recordDecision(
	tx: Transaction,
	candidateId: string,
	id: string,
	result: TestResult,
	decidedAt: Date
): Promise<void> {
	const blocks = result.blocks ?? [];
	const confirmed = result.outcome === 'confirmed';
	const definition = gradeDefinition(result.specialization, result.grade);
	const [attempt] = await tx
		.insert(testAttempts)
		.values({
			candidateId,
			purpose: 'grade',
			specialization: result.specialization,
			grade: result.grade,
			catalogVersion: CATALOG.version,
			bankReleaseId: evalRelease(result.specialization),
			procedureVersion: PROCEDURE.version,
			policyVersion: GRADE_POLICY.version,
			form: 'A',
			seed: createHash('sha256').update(`eval-attempt:${id}`).digest('hex').slice(0, 32),
			status: 'decided',
			startedAt: decidedAt,
			deadlineAt: decidedAt,
			endedAt: decidedAt,
			seeded: true
		})
		.returning({ id: testAttempts.id });
	if (!attempt) throw new Error('attempt was not inserted');
	// The practice the decision was reached with: a program in its language, or (QA) cases a harness runs. A decision
	// short of a confirmation that names no language has no practice to show.
	const writesCode = practiceWritesCode(definition);
	if (confirmed || result.practice_language !== undefined) {
		await tx.insert(testItems).values({
			attemptId: attempt.id,
			seq: definition.practice.position,
			block: definition.practice.block,
			format: writesCode ? 'practice_code' : (blockDefinition(definition.practice.block).formats[0] as string),
			practice: true,
			familyKey: 'eval-practice',
			familyVersion: 1,
			classId: 'eval-practice',
			instanceSeed: id,
			instance: {},
			angoff: 0.5,
			servedAt: decidedAt,
			answeredAt: decidedAt,
			score: confirmed ? 1 : 0,
			scoreDetail: result.practice_language === undefined ? {} : { language: result.practice_language },
			status: 'scored'
		});
	}
	const sum = (pick: (block: (typeof blocks)[number]) => number) => blocks.reduce((total, b) => total + pick(b), 0);
	await tx.insert(gradeDecisions).values({
		id,
		attemptId: attempt.id,
		candidateId,
		specialization: result.specialization,
		grade: result.grade,
		outcome: result.outcome,
		reason: confirmed ? 'sprt_upper' : result.outcome === 'not_confirmed' ? 'sprt_lower' : 'band_after_extension',
		confident: false,
		llr: 0,
		scoreSum: sum((b) => b.score),
		cutSum: sum((b) => b.cut),
		items: sum((b) => b.items),
		extensionUsed: false,
		practice: confirmed ? { score: 1, gateMinScore: definition.practice.gateMinScore, passed: true } : null,
		blocks: blocks.map((b) => ({
			...b,
			verdict: b.score > b.cut ? 'above' : b.score === b.cut ? 'at' : 'below',
			defining: definition.defining.includes(b.block),
			passed: definition.defining.includes(b.block) && b.score >= b.cut
		})),
		procedureVersion: PROCEDURE.version,
		bankReleaseId: evalRelease(result.specialization),
		status: 'valid',
		decidedAt
	});
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

/** The candidates of `ids` holding a category in force — of one of the pairs, or (`null`) any. */
async function holdersOf(
	db: Database,
	ids: readonly string[],
	pairs: readonly { specialization: SpecializationKey; grade: GradeKey }[] | null
): Promise<Set<string>> {
	if (ids.length === 0 || pairs?.length === 0) return new Set();
	const holds =
		pairs === null
			? categoryPredicate(sql`c.id`)
			: sql`(${sql.join(
					pairs.map((pair) =>
						categoryPredicate(sql`c.id`, { specializations: [pair.specialization], grades: [pair.grade] })
					),
					sql` or `
				)})`;
	const list = sql`array[${sql.join(
		ids.map((id) => sql`${id}::uuid`),
		sql`, `
	)}]`;
	const rows = await db.execute<{ id: string }>(
		sql`select c.id::text as id from unnest(${list}) as c(id) where ${holds}`
	);
	return new Set(rows.map((row) => row.id));
}

/** The candidates of `ids` of the group «грейд не подтверждён» of the pairs, by the product's own condition. */
async function declaredOf(
	db: Database,
	ids: readonly string[],
	pairs: readonly { specialization: SpecializationKey; grade: GradeKey }[]
): Promise<Set<string>> {
	if (ids.length === 0 || pairs.length === 0) return new Set();
	const list = sql`array[${sql.join(
		ids.map((id) => sql`${id}::uuid`),
		sql`, `
	)}]`;
	const rows = await db.execute<{ id: string }>(
		sql`select c.id::text as id from unnest(${list}) as c(id) where ${declaredWithoutCategory(sql`c.id`, pairs)}`
	);
	return new Set(rows.map((row) => row.id));
}

/**
 * The candidates a need's shortlist ranks, of those it considers: holders of one of its categories; all of them, for
 * a given set; or — the experiment without a test — those whose grade hint of a specialization of the shortlist is one
 * of its grades (the hint of a candidate and specialization is computed once, `hints`).
 */
async function admit(
	db: Database,
	admission: RankRequest['rankings'][number]['admission'],
	considered: readonly string[],
	pairs: readonly { specialization: SpecializationKey; grade: GradeKey }[],
	hints: Map<string, GradeKey | null>,
	now: Date
): Promise<string[]> {
	if (admission === 'given') return [...considered];
	if (admission === 'categories') {
		const holders = await holdersOf(db, considered, pairs);
		return considered.filter((id) => holders.has(id));
	}
	// A candidate whose evidence was never computed has no hint to give: nothing of the resume to read.
	const read =
		considered.length === 0
			? []
			: await db
					.selectDistinct({ id: evidenceRuns.candidateId })
					.from(evidenceRuns)
					.where(and(inArray(evidenceRuns.candidateId, [...considered]), eq(evidenceRuns.status, 'published')));
	const withEvidence = new Set(read.map((row) => row.id));
	const admitted = [];
	for (const id of considered.filter((candidate) => withEvidence.has(candidate))) {
		for (const specialization of new Set(pairs.map((pair) => pair.specialization))) {
			const key = `${id}:${specialization}`;
			if (!hints.has(key)) hints.set(key, (await computeGradeHint(db, id, specialization, now)).suggested);
			const hint = hints.get(key);
			if (pairs.some((pair) => pair.specialization === specialization && pair.grade === hint)) {
				admitted.push(id);
				break;
			}
		}
	}
	return admitted;
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

		const idOf = new Map<string, string>();
		await releaseHarnessTests(
			db,
			new Set([
				...request.open_specializations,
				// A declaration is made in the survey of a specialization whose test is out, as a test is taken in one.
				...request.candidates.flatMap((c) => [...c.test_results, ...c.declared].map((entry) => entry.specialization))
			]),
			now
		);
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
						preferences: candidate.preferences ?? {},
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
				// Declarations without a test first, then decisions a day apart, the last one a day before «now», each
				// applied as the engine applies it and declared an hour before it.
				const results = candidate.test_results;
				const surveys: Survey[] = [];
				for (const [index, declaration] of candidate.declared.entries()) {
					const declaredAt = new Date(now.getTime() - (results.length + candidate.declared.length - index) * DAY_MS);
					await recordDeclaration(tx, row.id, declaration, declaredAt, published.taxonomyVersionId, surveys);
				}
				for (const [index, result] of results.entries()) {
					const decidedAt = new Date(now.getTime() - (results.length - index) * DAY_MS);
					const declaredAt = new Date(decidedAt.getTime() - 60 * 60 * 1000);
					await recordDeclaration(tx, row.id, result, declaredAt, published.taxonomyVersionId, surveys);
					await recordDecision(tx, row.id, decisionId(candidate.id, index), result, decidedAt);
					await applyGradeDecisions(
						tx,
						row.id,
						result.specialization,
						{ requestId: 'eval-rank', actor: SYSTEM },
						GRADE_DECISIONS
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

		// Each need as the employer writes it, read by the rules, with the categories its shortlist takes.
		const parseCache = memoryTextParseCache();
		const needs: RankAnswer['needs'] = {};
		const specs = new Map<string, { spec: NeedSpec; text: string }>();
		for (const need of request.needs) {
			const { form } = await parseNeedText(
				{ db, models: MODELS_OFF, parseCache },
				{ id: uuidv7(), companyId: 'eval' },
				need.text
			);
			const categories = defaultCategories(form, await openSpecializations(db));
			needs[need.id] = {
				specialization: form.specialization ?? null,
				grade: form.grade ? `${form.grade.min}–${form.grade.max}` : null,
				skill_keys: form.skill_keys,
				nice_skill_keys: form.nice_skill_keys,
				categories: categories.map((c) => `${c.specialization}:${c.grade}`)
			};
			specs.set(need.id, {
				text: need.text,
				spec: {
					requiredSkillKeys: form.skill_keys,
					niceSkillKeys: form.nice_skill_keys,
					workFormat: form.work_format ?? null,
					regionCode: form.region_code ?? null,
					fspRelevant: form.fsp_relevant !== false,
					categories,
					compositeSpecializations: compositeSpecializations(form)
				}
			});
		}
		const catalogSeconds = (performance.now() - started) / 1000;
		const embeddingStarted = performance.now();
		const space = semanticRankings && embed !== null ? await buildSpace(db, embed, now) : null;
		const embeddingSeconds = (performance.now() - embeddingStarted) / 1000;

		const requestIdOf = new Map([...idOf].map(([requestId, id]) => [id, requestId]));
		const explained = (entry: RankedForNeed): TopEntry => ({
			id: requestIdOf.get(entry.snapshot.id) as string,
			score: entry.result.score,
			components: Object.fromEntries(
				Object.entries(entry.result.components).map(([key, component]) => [
					key,
					component.applicable ? component.contribution : null
				])
			),
			reasons: entry.result.reasons,
			gaps: entry.result.gaps,
			to_verify: entry.result.toVerify
		});
		const hints = new Map<string, GradeKey | null>();
		const rankings: RankAnswer['rankings'] = {};
		const unconfirmed: RankAnswer['unconfirmed'] = {};
		const declared: RankAnswer['declared'] = {};
		const top: RankAnswer['top'] = {};
		const declaredTop: RankAnswer['declared_top'] = {};
		const semantic: RankAnswer['semantic'] = {};
		const rankingStarted = performance.now();
		for (const ranking of request.rankings) {
			await activateSpace(db, ranking.semantic && space !== null ? space.spaceId : null);
			const ids = ranking.candidates.map((id) => {
				const stored = idOf.get(id);
				if (stored === undefined) throw new Error(`ranking ${ranking.name} names an unknown candidate ${id}`);
				return stored;
			});
			const categorized = await holdersOf(db, ids, null);
			const byNeed: Record<string, string[]> = {};
			const apart: Record<string, string[]> = {};
			const groupOf: Record<string, string[]> = {};
			const topOf: RankAnswer['top'][string] = {};
			const groupTopOf: RankAnswer['declared_top'][string] = {};
			const semanticUsage: ComponentUsage = { used: 0, unavailable: {} };
			const storedOf = (id: string) => {
				const stored = idOf.get(id);
				if (stored === undefined || !ids.includes(stored)) {
					throw new Error(`ranking ${ranking.name} considers ${id}, which it does not rank`);
				}
				return stored;
			};
			for (const need of request.needs) {
				const { spec, text } = specs.get(need.id) ?? {};
				if (!spec || text === undefined) throw new Error(`need ${need.id} was not read`);
				const considered = ranking.per_need === undefined ? ids : (ranking.per_need[need.id] ?? []).map(storedOf);
				apart[need.id] = considered.filter((id) => !categorized.has(id)).map((id) => requestIdOf.get(id) as string);
				const admitted = await admit(db, ranking.admission, considered, spec.categories, hints, now);
				// A shortlist admitting by categories shows its group «грейд не подтверждён» after them.
				const group =
					ranking.admission === 'categories'
						? [...(await declaredOf(db, considered, spec.categories))].filter((id) => !admitted.includes(id))
						: [];
				const result = await rankForNeed(
					db,
					ranking.semantic ? deps.models : MODELS_OFF,
					spec,
					[...admitted, ...group],
					{
						ruleset,
						testResults: GRADE_DECISION_RESULTS,
						now,
						semanticText: ranking.semantic ? text : null,
						priority: 'background'
					}
				);
				if (result.ranked.length !== admitted.length + group.length) {
					throw new Error(
						`need ${need.id}: ${result.ranked.length} of ${admitted.length + group.length} candidates ranked`
					);
				}
				// Of a ranking by categories the admitted hold one of them and the group follows them; a given set or the
				// experiment by the hint is ranked whole, as it was admitted.
				const shown = result.ranked.slice(0, admitted.length);
				const tail = result.ranked.slice(admitted.length);
				const grouped = new Set(group);
				if (shown.some((entry) => grouped.has(entry.snapshot.id))) {
					throw new Error(`need ${need.id}: the group «грейд не подтверждён» is not after every admitted candidate`);
				}
				byNeed[need.id] = shown.map((entry) => requestIdOf.get(entry.snapshot.id) as string);
				groupOf[need.id] = tail.map((entry) => requestIdOf.get(entry.snapshot.id) as string);
				topOf[need.id] = shown.slice(0, 10).map(explained);
				groupTopOf[need.id] = tail.slice(0, 10).map(explained);
				// A need of one candidate has nothing to order: `no_query`.
				if (result.semantic.reason === null) semanticUsage.used++;
				else {
					const reason = result.semantic.reason;
					semanticUsage.unavailable[reason] = (semanticUsage.unavailable[reason] ?? 0) + 1;
				}
			}
			rankings[ranking.name] = byNeed;
			unconfirmed[ranking.name] = apart;
			declared[ranking.name] = groupOf;
			top[ranking.name] = topOf;
			declaredTop[ranking.name] = groupTopOf;
			semantic[ranking.name] = semanticUsage;
		}
		const tested = request.candidates.filter((c) => c.test_results.length > 0).map((c) => idOf.get(c.id) as string);
		const inForce = await activeCategories(db, tested);
		const categories: RankAnswer['categories'] = Object.fromEntries(
			tested.map((id) => [
				requestIdOf.get(id) as string,
				(inForce.get(id) ?? []).map((category) => ({
					specialization: category.specialization,
					grade: category.grade,
					confirmed_skill_keys: category.confirmedSkillKeys
				}))
			])
		);
		return {
			rankings,
			unconfirmed,
			declared,
			top,
			declared_top: declaredTop,
			categories,
			semantic,
			needs,
			models: { match_ruleset: String(ruleset.version), embedding_space: space?.spaceId ?? 'none' },
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
