// Platform tests as an evidence source: tasks, versions, attempts, scores and artifacts (domain 10).
import { sql } from 'drizzle-orm';
import {
	check,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	unique,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { enumCheck, id, sha256Check, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { files } from './documents';
import { users } from './identity';

const ASSESSMENT_KINDS = ['code_task', 'quiz', 'open_answer'] as const;

export const assessments = pgTable(
	'assessments',
	{
		id: id(),
		kind: text({ enum: ASSESSMENT_KINDS }).notNull(),
		title: text().notNull(),
		skillKeys: text().array().notNull(),
		...timestamps()
	},
	(t) => [
		enumCheck('assessments', 'kind', t.kind, ASSESSMENT_KINDS),
		check('assessments_skill_keys', sql`cardinality(${t.skillKeys}) >= 1`)
	]
);

const VERSION_STATUSES = ['draft', 'published', 'retired', 'defective'] as const;

export const assessmentVersions = pgTable(
	'assessment_versions',
	{
		id: id(),
		assessmentId: uuid()
			.notNull()
			.references(() => assessments.id),
		version: integer().notNull(),
		contentSha256: text().notNull(),
		scorer: jsonb().notNull(),
		levelScale: jsonb().notNull(),
		coverage: jsonb().notNull(),
		itemBank: jsonb(),
		status: text({ enum: VERSION_STATUSES }).notNull(),
		...timestamps()
	},
	(t) => [
		enumCheck('assessment_versions', 'status', t.status, VERSION_STATUSES),
		sha256Check('assessment_versions', 'content_sha256', t.contentSha256),
		check('assessment_versions_version_positive', sql`${t.version} >= 1`),
		unique('assessment_versions_assessment_version').on(t.assessmentId, t.version)
	]
);

const ATTEMPT_STATUSES = ['started', 'submitted', 'scored', 'expired', 'annulled'] as const;
const ANNUL_REASONS = ['plagiarism', 'technical_failure', 'version_defect', 'candidate_request'] as const;

export const assessmentAttempts = pgTable(
	'assessment_attempts',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		versionId: uuid()
			.notNull()
			.references(() => assessmentVersions.id),
		startedAt: ts().notNull(),
		submittedAt: ts(),
		deadlineAt: ts().notNull(),
		status: text({ enum: ATTEMPT_STATUSES }).notNull(),
		integritySignals: jsonb(),
		annulledBy: uuid().references(() => users.id),
		annulledAt: ts(),
		annulReason: text({ enum: ANNUL_REASONS }),
		...timestamps()
	},
	(t) => [
		enumCheck('assessment_attempts', 'status', t.status, ATTEMPT_STATUSES),
		enumCheck('assessment_attempts', 'annul_reason', t.annulReason, ANNUL_REASONS),
		check(
			'assessment_attempts_annulment',
			sql`(${t.status} = 'annulled') = (${t.annulledAt} is not null and ${t.annulReason} is not null)`
		),
		check(
			'assessment_attempts_submitted',
			sql`${t.status} not in ('submitted', 'scored') or ${t.submittedAt} is not null`
		),
		index('assessment_attempts_candidate').on(t.candidateId)
	]
);

const SCORED_BY = ['automatic', 'human_review'] as const;

/** Append-only: a review adds a score that supersedes the previous one (domain 10.3). */
export const assessmentScores = pgTable(
	'assessment_scores',
	{
		id: id(),
		attemptId: uuid()
			.notNull()
			.references(() => assessmentAttempts.id),
		score: numeric().notNull(),
		maxScore: numeric().notNull(),
		level: text().notNull(),
		scoredBy: text({ enum: SCORED_BY }).notNull(),
		scorerVersion: text().notNull(),
		supersedesScoreId: uuid().references((): AnyPgColumn => assessmentScores.id),
		reviewReason: text(),
		reviewerId: uuid().references(() => users.id),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('assessment_scores', 'scored_by', t.scoredBy, SCORED_BY),
		check('assessment_scores_range', sql`${t.maxScore} > 0 and ${t.score} >= 0 and ${t.score} <= ${t.maxScore}`),
		check('assessment_scores_review_reason', sql`${t.supersedesScoreId} is null or ${t.reviewReason} is not null`),
		check('assessment_scores_human_reviewer', sql`${t.scoredBy} <> 'human_review' or ${t.reviewerId} is not null`),
		unique('assessment_scores_supersedes').on(t.supersedesScoreId),
		index('assessment_scores_attempt').on(t.attemptId)
	]
);

const ARTIFACT_KINDS = ['answer', 'code_submission', 'run_result', 'quiz_step'] as const;

/**
 * Append-only artifacts of an attempt (domain 10.4). After `retention_until` the retention role may clear
 * `content` and `file_id`; hashes and the row stay (trigger in migration 0002).
 */
export const assessmentArtifacts = pgTable(
	'assessment_artifacts',
	{
		id: id(),
		attemptId: uuid()
			.notNull()
			.references(() => assessmentAttempts.id),
		seq: integer().notNull(),
		kind: text({ enum: ARTIFACT_KINDS }).notNull(),
		content: jsonb(),
		fileId: uuid().references((): AnyPgColumn => files.id),
		sha256: text().notNull(),
		createdAt: ts().notNull().defaultNow(),
		retentionUntil: date({ mode: 'string' }).notNull()
	},
	(t) => [
		enumCheck('assessment_artifacts', 'kind', t.kind, ARTIFACT_KINDS),
		sha256Check('assessment_artifacts', 'sha256', t.sha256),
		check('assessment_artifacts_seq_positive', sql`${t.seq} >= 1`),
		unique('assessment_artifacts_attempt_seq').on(t.attemptId, t.seq)
	]
);
