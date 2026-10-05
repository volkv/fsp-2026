// The test on a declared grade (docs/domain.md, section 10): bank releases, attempts, served clusters, artifacts of an
// attempt and grade decisions.
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	unique,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { enumCheck, id, sha256Check, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { confirmationRequests } from './challenges';
import { files } from './documents';
import { users } from './identity';

const RELEASE_STATUSES = ['released', 'retired'] as const;

/** A released version of the bank of one specialization (domain 10.5); its content never changes. */
export const bankReleases = pgTable(
	'bank_releases',
	{
		/** `<specialization>@<catalog version>-<n>`. */
		id: text().primaryKey(),
		specialization: text().notNull(),
		catalogVersion: text().notNull(),
		procedureVersion: text().notNull(),
		contentSha256: text().notNull(),
		/** SHA-256 of the shared code of the generators (`_*` directories of the bank tree). */
		sharedSha256: text().notNull(),
		manifest: jsonb().notNull(),
		status: text({ enum: RELEASE_STATUSES }).notNull(),
		releasedAt: ts().notNull(),
		retiredAt: ts()
	},
	(t) => [
		enumCheck('bank_releases', 'status', t.status, RELEASE_STATUSES),
		sha256Check('bank_releases', 'content_sha256', t.contentSha256),
		sha256Check('bank_releases', 'shared_sha256', t.sharedSha256),
		check('bank_releases_retired', sql`(${t.status} = 'retired') = (${t.retiredAt} is not null)`),
		uniqueIndex('bank_releases_one_released')
			.on(t.specialization)
			.where(sql`${t.status} = 'released'`)
	]
);

export const ATTEMPT_PURPOSES = ['grade', 'vacancy_block', 'recheck'] as const;
export const ATTEMPT_STATUSES = ['in_progress', 'decided', 'expired', 'annulled'] as const;
export const ANNUL_REASONS = [
	'plagiarism',
	'candidate_request',
	'technical_failure',
	'version_defect',
	'objection_upheld'
] as const;
const FORMS = ['A', 'B'] as const;

export const testAttempts = pgTable(
	'test_attempts',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		purpose: text({ enum: ATTEMPT_PURPOSES }).notNull(),
		specialization: text().notNull(),
		grade: text().notNull(),
		catalogVersion: text().notNull(),
		bankReleaseId: text()
			.notNull()
			.references(() => bankReleases.id),
		procedureVersion: text().notNull(),
		policyVersion: integer().notNull(),
		/** `A` or `B` for a grade attempt; a block test and a recheck take reserve classes and have none. */
		form: text({ enum: FORMS }),
		/** Started on the one-step right of a confident result (domain 12.3). */
		viaConfidentUpgrade: boolean().notNull().default(false),
		/** 128 random bits in hex; the seeds of the instances derive from it. */
		seed: text().notNull(),
		status: text({ enum: ATTEMPT_STATUSES }).notNull(),
		startedAt: ts().notNull(),
		deadlineAt: ts().notNull(),
		endedAt: ts(),
		/** For `vacancy_block`: the employer's request (domain 13.11). */
		confirmationRequestId: uuid().references((): AnyPgColumn => confirmationRequests.id),
		integritySignals: jsonb(),
		/** A seeded attempt (domain 23.3): scores by the deterministic verdict, nothing run in the sandbox. */
		seeded: boolean().notNull().default(false),
		annulledBy: uuid().references(() => users.id),
		annulledAt: ts(),
		annulReason: text({ enum: ANNUL_REASONS }),
		...timestamps()
	},
	(t) => [
		enumCheck('test_attempts', 'purpose', t.purpose, ATTEMPT_PURPOSES),
		enumCheck('test_attempts', 'status', t.status, ATTEMPT_STATUSES),
		enumCheck('test_attempts', 'form', t.form, FORMS),
		enumCheck('test_attempts', 'annul_reason', t.annulReason, ANNUL_REASONS),
		check('test_attempts_form', sql`(${t.purpose} = 'grade') = (${t.form} is not null)`),
		check('test_attempts_seed_format', sql`${t.seed} ~ '^[0-9a-f]{32}$'`),
		check(
			'test_attempts_annulment',
			sql`(${t.status} = 'annulled') = (${t.annulledAt} is not null and ${t.annulReason} is not null)`
		),
		check('test_attempts_ended', sql`(${t.status} = 'in_progress') = (${t.endedAt} is null)`),
		check(
			'test_attempts_confirmation_request',
			sql`(${t.purpose} = 'vacancy_block') = (${t.confirmationRequestId} is not null)`
		),
		uniqueIndex('test_attempts_one_in_progress')
			.on(t.candidateId)
			.where(sql`${t.status} = 'in_progress'`),
		index('test_attempts_candidate').on(t.candidateId, t.specialization, t.grade)
	]
);

export const ITEM_STATUSES = ['served', 'answered', 'scored', 'awaiting_sandbox'] as const;

/** Served clusters of an attempt (domain 10.7): the instance whole, the candidate sees only its statement. */
export const testItems = pgTable(
	'test_items',
	{
		id: id(),
		attemptId: uuid()
			.notNull()
			.references(() => testAttempts.id),
		/** The slot of the blueprint, from 1. */
		seq: integer().notNull(),
		block: text().notNull(),
		format: text().notNull(),
		practice: boolean().notNull(),
		familyKey: text().notNull(),
		familyVersion: integer().notNull(),
		classId: text().notNull(),
		instanceSeed: text().notNull(),
		instance: jsonb().notNull(),
		angoff: numeric({ precision: 3, scale: 2, mode: 'number' }).notNull(),
		servedAt: ts().notNull(),
		answeredAt: ts(),
		score: numeric({ precision: 3, scale: 2, mode: 'number' }),
		scoreDetail: jsonb(),
		status: text({ enum: ITEM_STATUSES }).notNull()
	},
	(t) => [
		enumCheck('test_items', 'status', t.status, ITEM_STATUSES),
		unique('test_items_attempt_seq').on(t.attemptId, t.seq),
		check('test_items_seq_positive', sql`${t.seq} >= 1`),
		check('test_items_angoff_range', sql`${t.angoff} > 0 and ${t.angoff} < 1 and mod(${t.angoff} * 20, 1) = 0`),
		check(
			'test_items_score_range',
			sql`${t.score} is null or (${t.score} >= 0 and ${t.score} <= 1 and mod(${t.score} * 20, 1) = 0)`
		),
		check('test_items_scored', sql`(${t.status} = 'scored') = (${t.score} is not null)`)
	]
);

export const ARTIFACT_KINDS = ['answer', 'code_submission', 'run_result', 'qa_cases'] as const;

/**
 * Append-only artifacts of an attempt (domain 10.7). After `retention_until` the retention role may clear `content` and
 * `file_id`; the row, its hash and the score stay (trigger of the migration).
 */
export const testArtifacts = pgTable(
	'test_artifacts',
	{
		id: id(),
		attemptId: uuid()
			.notNull()
			.references(() => testAttempts.id),
		itemId: uuid()
			.notNull()
			.references(() => testItems.id),
		seq: integer().notNull(),
		kind: text({ enum: ARTIFACT_KINDS }).notNull(),
		content: jsonb(),
		fileId: uuid().references((): AnyPgColumn => files.id),
		sha256: text().notNull(),
		createdAt: ts().notNull().defaultNow(),
		retentionUntil: date({ mode: 'string' }).notNull()
	},
	(t) => [
		enumCheck('test_artifacts', 'kind', t.kind, ARTIFACT_KINDS),
		sha256Check('test_artifacts', 'sha256', t.sha256),
		check('test_artifacts_seq_positive', sql`${t.seq} >= 1`),
		unique('test_artifacts_attempt_seq').on(t.attemptId, t.seq),
		index('test_artifacts_item').on(t.itemId)
	]
);

export const DECISION_OUTCOMES = ['confirmed', 'not_confirmed', 'undetermined'] as const;
export const DECISION_REASONS = [
	'sprt_upper',
	'sprt_lower',
	'forced_upper_at_max',
	'forced_lower_at_max',
	'forced_upper_final',
	'forced_lower_final',
	'band_after_extension',
	'practice_gate_failed',
	'defining_block_failed',
	'bank_exhausted',
	'rescored_incomplete'
] as const;
const DECISION_STATUSES = ['valid', 'annulled', 'superseded'] as const;

/**
 * Append-only grade decisions (domain 10.7): only `status` changes, `valid → annulled | superseded`. Sums are in
 * twentieths of a point, the log-likelihood ratio in millionths (the exact arithmetic of the procedure).
 */
export const gradeDecisions = pgTable(
	'grade_decisions',
	{
		id: id(),
		attemptId: uuid()
			.notNull()
			.references(() => testAttempts.id),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		specialization: text().notNull(),
		grade: text().notNull(),
		outcome: text({ enum: DECISION_OUTCOMES }).notNull(),
		reason: text({ enum: DECISION_REASONS }).notNull(),
		confident: boolean().notNull(),
		llr: bigint({ mode: 'number' }).notNull(),
		scoreSum: integer().notNull(),
		cutSum: integer().notNull(),
		/** Items used, the practice not counted. */
		items: integer().notNull(),
		extensionUsed: boolean().notNull(),
		/** `null` — decided before the practice (the bank ran out). */
		practice: jsonb(),
		blocks: jsonb().notNull(),
		procedureVersion: text().notNull(),
		bankReleaseId: text()
			.notNull()
			.references(() => bankReleases.id),
		status: text({ enum: DECISION_STATUSES }).notNull(),
		supersedesDecisionId: uuid().references((): AnyPgColumn => gradeDecisions.id),
		decidedAt: ts().notNull()
	},
	(t) => [
		enumCheck('grade_decisions', 'outcome', t.outcome, DECISION_OUTCOMES),
		enumCheck('grade_decisions', 'reason', t.reason, DECISION_REASONS),
		enumCheck('grade_decisions', 'status', t.status, DECISION_STATUSES),
		check('grade_decisions_confident', sql`not ${t.confident} or ${t.outcome} = 'confirmed'`),
		uniqueIndex('grade_decisions_one_valid')
			.on(t.attemptId)
			.where(sql`${t.status} = 'valid'`),
		index('grade_decisions_candidate').on(t.candidateId, t.specialization)
	]
);
