// Versioned taxonomy and rule sets (domain 11). Rows of a version other than `draft` are immutable (migration 0002).
import { sql } from 'drizzle-orm';
import {
	type AnyPgColumn,
	check,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	text,
	unique,
	uuid
} from 'drizzle-orm/pg-core';
import { enumCheck, id, salaryUnitChecks, salaryUnitColumns, timestamps, ts } from './_columns';
import { vacancyPostings } from './vacancies';

const TAXONOMY_STATUSES = ['draft', 'published', 'retired'] as const;

export const taxonomyVersions = pgTable(
	'taxonomy_versions',
	{
		id: id(),
		label: text().notNull().unique('taxonomy_versions_label'),
		status: text({ enum: TAXONOMY_STATUSES }).notNull(),
		publishedAt: ts(),
		sources: jsonb().notNull(),
		...timestamps()
	},
	(t) => [
		enumCheck('taxonomy_versions', 'status', t.status, TAXONOMY_STATUSES),
		check('taxonomy_versions_published_at', sql`(${t.status} = 'draft') = (${t.publishedAt} is null)`)
	]
);

const taxonomyVersionId = () =>
	uuid()
		.notNull()
		.references(() => taxonomyVersions.id);

export const roles = pgTable(
	'roles',
	{
		taxonomyVersionId: taxonomyVersionId(),
		key: text().notNull(),
		family: text().notNull(),
		nameRu: text().notNull(),
		coreSkillGroups: jsonb().notNull(),
		typicalSkills: text().array().notNull(),
		// Codes of the role in external classifiers, main code first; an empty array — the classifier has no such role.
		hhRoleId: text().array().notNull(),
		habrSpec: text().array().notNull(),
		profStandard: text().array().notNull()
	},
	(t) => [primaryKey({ name: 'roles_pk', columns: [t.taxonomyVersionId, t.key] })]
);

const SKILL_KINDS = [
	'language',
	'framework',
	'library',
	'runtime',
	'platform',
	'database',
	'tool',
	'practice',
	'domain'
] as const;

export const skills = pgTable(
	'skills',
	{
		taxonomyVersionId: taxonomyVersionId(),
		key: text().notNull(),
		kind: text({ enum: SKILL_KINDS }).notNull(),
		parentKey: text(),
		name: text().notNull(),
		hhId: text(),
		habrId: text(),
		soTag: text()
	},
	(t) => [
		primaryKey({ name: 'skills_pk', columns: [t.taxonomyVersionId, t.key] }),
		enumCheck('skills', 'kind', t.kind, SKILL_KINDS),
		check('skills_parent_not_self', sql`${t.parentKey} is distinct from ${t.key}`)
	]
);

export const skillAliases = pgTable(
	'skill_aliases',
	{
		taxonomyVersionId: taxonomyVersionId(),
		aliasNormalized: text().notNull(),
		skillKey: text().notNull()
	},
	(t) => [primaryKey({ name: 'skill_aliases_pk', columns: [t.taxonomyVersionId, t.aliasNormalized] })]
);

export const grades = pgTable(
	'grades',
	{
		taxonomyVersionId: taxonomyVersionId(),
		key: text().notNull(),
		ordinal: integer().notNull(),
		name: text().notNull()
	},
	(t) => [
		primaryKey({ name: 'grades_pk', columns: [t.taxonomyVersionId, t.key] }),
		unique('grades_version_ordinal').on(t.taxonomyVersionId, t.ordinal)
	]
);

export const workFormats = pgTable(
	'work_formats',
	{
		taxonomyVersionId: taxonomyVersionId(),
		dimension: text().notNull(),
		key: text().notNull(),
		name: text().notNull()
	},
	(t) => [primaryKey({ name: 'work_formats_pk', columns: [t.taxonomyVersionId, t.dimension, t.key] })]
);

const PROJECTION_TARGET_KINDS = ['skill', 'role', 'marker'] as const;
const PROJECTION_ATTESTATIONS = ['direct', 'derived'] as const;
const PROJECTION_APPLIES_TO = ['individual', 'team', 'any'] as const;

export const fspProjectionRules = pgTable(
	'fsp_projection_rules',
	{
		id: id(),
		taxonomyVersionId: taxonomyVersionId(),
		discipline: text().notNull(),
		targetKind: text({ enum: PROJECTION_TARGET_KINDS }).notNull(),
		targetKey: text().notNull(),
		weight: numeric({ precision: 4, scale: 3 }).notNull(),
		attestation: text({ enum: PROJECTION_ATTESTATIONS }).notNull(),
		requiresSpecialization: text(),
		appliesTo: text({ enum: PROJECTION_APPLIES_TO }).notNull()
	},
	(t) => [
		enumCheck('fsp_projection_rules', 'target_kind', t.targetKind, PROJECTION_TARGET_KINDS),
		enumCheck('fsp_projection_rules', 'attestation', t.attestation, PROJECTION_ATTESTATIONS),
		enumCheck('fsp_projection_rules', 'applies_to', t.appliesTo, PROJECTION_APPLIES_TO),
		check('fsp_projection_rules_weight_range', sql`${t.weight} >= 0 and ${t.weight} <= 1`),
		// A team result never confirms a skill directly (domain 9.3, 11).
		check('fsp_projection_rules_team_not_direct', sql`${t.attestation} = 'derived' or ${t.appliesTo} = 'individual'`),
		unique('fsp_projection_rules_target')
			.on(t.taxonomyVersionId, t.discipline, t.targetKind, t.targetKey, t.requiresSpecialization, t.appliesTo)
			.nullsNotDistinct()
	]
);

export const fspStrengthParams = pgTable(
	'fsp_strength_params',
	{
		taxonomyVersionId: uuid()
			.primaryKey()
			.references(() => taxonomyVersions.id),
		evskNorm: jsonb().notNull(),
		rankStrength: jsonb().notNull(),
		formatFactors: jsonb().notNull(),
		unknownRoleFactor: numeric({ precision: 4, scale: 3 }).notNull(),
		recencyHalfLifeYears: numeric({ precision: 5, scale: 2 }).notNull()
	},
	(t) => [
		check('fsp_strength_params_unknown_role_factor', sql`${t.unknownRoleFactor} >= 0 and ${t.unknownRoleFactor} <= 1`),
		check('fsp_strength_params_half_life', sql`${t.recencyHalfLifeYears} > 0`)
	]
);

const FSP_LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;

export const fspLevelRules = pgTable(
	'fsp_level_rules',
	{
		taxonomyVersionId: taxonomyVersionId(),
		level: text({ enum: FSP_LEVELS }).notNull(),
		criteria: jsonb().notNull()
	},
	(t) => [
		primaryKey({ name: 'fsp_level_rules_pk', columns: [t.taxonomyVersionId, t.level] }),
		enumCheck('fsp_level_rules', 'level', t.level, FSP_LEVELS)
	]
);

/** Rule sets are immutable from insertion: a change is a new version (migration 0002). */
export const categorizationRulesets = pgTable(
	'categorization_rulesets',
	{
		id: id(),
		version: integer().notNull().unique('categorization_rulesets_version'),
		taxonomyVersionId: taxonomyVersionId(),
		params: jsonb().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [check('categorization_rulesets_version_positive', sql`${t.version} >= 1`)]
);

export const matchRulesets = pgTable(
	'match_rulesets',
	{
		id: id(),
		version: integer().notNull().unique('match_rulesets_version'),
		taxonomyVersionId: taxonomyVersionId(),
		params: jsonb().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [check('match_rulesets_version_positive', sql`${t.version} >= 1`)]
);

export const receiptTemplates = pgTable(
	'receipt_templates',
	{
		taxonomyVersionId: taxonomyVersionId(),
		source: text().notNull(),
		factType: text().notNull(),
		asserts: jsonb().notNull(),
		/** `{ all, team, individual, byRole }` (`receiptLimitsSchema` of taxonomy/datasets.ts, domain 9.6). */
		doesNotAssert: jsonb().notNull()
	},
	(t) => [primaryKey({ name: 'receipt_templates_pk', columns: [t.taxonomyVersionId, t.source, t.factType] })]
);

export const salaryReferences = pgTable(
	'salary_references',
	{
		id: id(),
		taxonomyVersionId: taxonomyVersionId(),
		source: text().notNull(),
		collectedAt: ts().notNull(),
		roleKey: text().notNull(),
		gradeKey: text(),
		skillKey: text(),
		median: integer(),
		p25: integer(),
		p75: integer(),
		sampleSize: integer().notNull(),
		...salaryUnitColumns(),
		geography: text().notNull(),
		method: text().notNull()
	},
	(t) => [
		...salaryUnitChecks('salary_references', t),
		check('salary_references_sample_size', sql`${t.sampleSize} >= 0`),
		check(
			'salary_references_quantiles',
			sql`(${t.p25} is null or ${t.median} is null or ${t.p25} <= ${t.median})
				and (${t.median} is null or ${t.p75} is null or ${t.median} <= ${t.p75})`
		)
	]
);

const UNKNOWN_SKILL_REVIEW_STATUSES = ['pending', 'added', 'rejected'] as const;

/**
 * Queue of skill mentions the dictionary does not know yet (domain 9.2, 11). `last_seen_at` — when a vacancy text last
 * brought the spelling (`null` — before it was kept); `last_posting_id` — the external posting it came from, `null` when
 * the text was an own vacancy's or the posting is gone.
 */
export const unknownSkillMentions = pgTable(
	'unknown_skill_mentions',
	{
		rawNormalized: text().primaryKey(),
		count: integer().notNull().default(1),
		firstSeenAt: ts().notNull().defaultNow(),
		lastSeenAt: ts(),
		lastPostingId: uuid().references((): AnyPgColumn => vacancyPostings.id, { onDelete: 'set null' }),
		reviewStatus: text({ enum: UNKNOWN_SKILL_REVIEW_STATUSES }).notNull().default('pending'),
		...timestamps()
	},
	(t) => [
		enumCheck('unknown_skill_mentions', 'review_status', t.reviewStatus, UNKNOWN_SKILL_REVIEW_STATUSES),
		check('unknown_skill_mentions_count_positive', sql`${t.count} >= 1`)
	]
);
