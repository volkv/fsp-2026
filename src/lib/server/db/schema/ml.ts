// Model call envelopes, embedding spaces and vectors, evaluation runs (domain 16).
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	unique,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { enumCheck, id, sha256Check, ts, vector } from './_columns';
import { files } from './documents';
import { jobs } from './jobs';
import { taxonomyVersions } from './taxonomy';

const ML_OPERATIONS = ['extract', 'embed', 'rerank', 'explain_text'] as const;
const PROCESSING_MODES = ['model', 'rules_only', 'partial', 'failed'] as const;

export const mlResults = pgTable(
	'ml_results',
	{
		id: id(),
		operation: text({ enum: ML_OPERATIONS }).notNull(),
		jobId: uuid().references((): AnyPgColumn => jobs.id),
		inputRef: jsonb().notNull(),
		inputSha256: text().notNull(),
		inputVersion: text().notNull(),
		schemaVersion: text().notNull(),
		taxonomyVersionId: uuid().references(() => taxonomyVersions.id),
		model: jsonb(),
		rulesVersion: text(),
		embeddingSpaceId: text().references((): AnyPgColumn => embeddingSpaces.id),
		processingMode: text({ enum: PROCESSING_MODES }).notNull(),
		failure: jsonb(),
		evidenceRefs: jsonb(),
		rejectedItems: jsonb(),
		/** The checked answer of the model to `extract`: the items with their quotes, as the adapter gave them (domain 16.1). */
		output: jsonb(),
		latencyMs: integer(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('ml_results', 'operation', t.operation, ML_OPERATIONS),
		enumCheck('ml_results', 'processing_mode', t.processingMode, PROCESSING_MODES),
		sha256Check('ml_results', 'input_sha256', t.inputSha256),
		// An unavailable model is never replaced by a made-up result (domain 16.1).
		check(
			'ml_results_model',
			sql`case ${t.processingMode}
			when 'model' then ${t.model} is not null
			when 'rules_only' then ${t.model} is null and ${t.rulesVersion} is not null
			when 'failed' then ${t.failure} is not null
			else true end`
		),
		check(
			'ml_results_output',
			sql`${t.output} is null or (${t.operation} = 'extract' and ${t.processingMode} = 'model')`
		),
		check('ml_results_embed_space', sql`${t.operation} <> 'embed' or ${t.embeddingSpaceId} is not null`),
		check('ml_results_latency', sql`${t.latencyMs} is null or ${t.latencyMs} >= 0`),
		unique('ml_results_job_operation').on(t.jobId, t.operation)
	]
);

const POOLINGS = ['mean', 'cls', 'last_token', 'provider_default'] as const;
const NORMALIZATIONS = ['l2', 'none'] as const;
const SPACE_STATUSES = ['building', 'active', 'retired'] as const;

/** Immutable description of a vector space; only `status` and `activated_at` change (migration 0002). */
export const embeddingSpaces = pgTable(
	'embedding_spaces',
	{
		id: text().primaryKey(),
		modelName: text().notNull(),
		modelRevision: text().notNull(),
		dimension: integer().notNull(),
		queryPrefix: text().notNull(),
		documentPrefix: text().notNull(),
		pooling: text({ enum: POOLINGS }).notNull(),
		normalization: text({ enum: NORMALIZATIONS }).notNull(),
		maxInputTokens: integer().notNull(),
		chunkingVersion: text().notNull(),
		status: text({ enum: SPACE_STATUSES }).notNull(),
		activatedAt: ts(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('embedding_spaces', 'pooling', t.pooling, POOLINGS),
		enumCheck('embedding_spaces', 'normalization', t.normalization, NORMALIZATIONS),
		enumCheck('embedding_spaces', 'status', t.status, SPACE_STATUSES),
		// pgvector stores up to 16 000 dimensions.
		check('embedding_spaces_dimension', sql`${t.dimension} between 1 and 16000`),
		check('embedding_spaces_max_input_tokens', sql`${t.maxInputTokens} >= 1`),
		check('embedding_spaces_activated_at', sql`${t.status} = 'building' or ${t.activatedAt} is not null`),
		// One active space per environment.
		uniqueIndex('embedding_spaces_single_active')
			.on(t.status)
			.where(sql`${t.status} = 'active'`)
	]
);

/** The single row of search settings: which embedding space the catalog uses (domain 16.2). */
export const searchSettings = pgTable(
	'search_settings',
	{
		singleton: boolean().primaryKey().default(true),
		activeEmbeddingSpaceId: text().references(() => embeddingSpaces.id),
		updatedAt: ts()
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(t) => [check('search_settings_singleton', sql`${t.singleton}`)]
);

const EMBEDDING_OWNER_TYPES = ['candidate_section', 'vacancy', 'skill'] as const;

/**
 * Vectors of every space share one dimensionless column; a trigger (migration 0002) checks the dimension against
 * the space. Search is exact (`space_id` filter plus a cast to the space dimension); no approximate index.
 */
export const embeddings = pgTable(
	'embeddings',
	{
		id: id(),
		ownerType: text({ enum: EMBEDDING_OWNER_TYPES }).notNull(),
		ownerId: text().notNull(),
		section: text(),
		inputSha256: text().notNull(),
		inputVersion: text().notNull(),
		spaceId: text()
			.notNull()
			.references(() => embeddingSpaces.id),
		vector: vector().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('embeddings', 'owner_type', t.ownerType, EMBEDDING_OWNER_TYPES),
		sha256Check('embeddings', 'input_sha256', t.inputSha256),
		check(
			'embeddings_section',
			sql`case ${t.ownerType}
				when 'candidate_section' then ${t.section} in ('experience', 'skills', 'summary')
				else ${t.section} is null end`
		),
		uniqueIndex('embeddings_owner_space').on(t.spaceId, t.ownerType, t.ownerId, sql`coalesce(${t.section}, '')`),
		index('embeddings_space').on(t.spaceId)
	]
);

const EVAL_PROVENANCES = ['synthetic', 'manual_labeled', 'customer'] as const;

export const evalRuns = pgTable(
	'eval_runs',
	{
		id: id(),
		productRevision: text().notNull(),
		datasetId: text().notNull(),
		datasetSize: integer().notNull(),
		datasetProvenance: text({ enum: EVAL_PROVENANCES }).notNull(),
		split: text().notNull(),
		versions: jsonb().notNull(),
		processingMode: text({ enum: PROCESSING_MODES }).notNull(),
		thresholds: jsonb().notNull(),
		metrics: jsonb().notNull(),
		reportFileId: uuid().references(() => files.id),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('eval_runs', 'dataset_provenance', t.datasetProvenance, EVAL_PROVENANCES),
		enumCheck('eval_runs', 'processing_mode', t.processingMode, PROCESSING_MODES),
		check('eval_runs_dataset_size', sql`${t.datasetSize} >= 0`)
	]
);
