// Categorization runs with independent axes, FSP level facet and disputes (domain 12.1–12.3).
import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	date,
	index,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	text,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { enumCheck, id, sha256Check, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { users } from './identity';
import { jobs } from './jobs';
import { categorizationRulesets, taxonomyVersions } from './taxonomy';

const RUN_ORIGINS = ['automatic', 'manual_override'] as const;
const RUN_OUTCOMES = ['complete', 'partial', 'insufficient_data'] as const;
const RUN_STATUSES = ['computed', 'published', 'superseded', 'blocked', 'discarded_stale'] as const;

export const categorizationRuns = pgTable(
	'categorization_runs',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		inputRevision: bigint({ mode: 'number' }).notNull(),
		inputSnapshotSha256: text().notNull(),
		inputRefs: jsonb().notNull(),
		taxonomyVersionId: uuid()
			.notNull()
			.references(() => taxonomyVersions.id),
		rulesetId: uuid()
			.notNull()
			.references(() => categorizationRulesets.id),
		asOf: ts().notNull(),
		computedAt: ts().notNull(),
		jobId: uuid().references((): AnyPgColumn => jobs.id),
		origin: text({ enum: RUN_ORIGINS }).notNull(),
		overrideBy: uuid().references(() => users.id),
		overrideReason: text(),
		outcome: text({ enum: RUN_OUTCOMES }).notNull(),
		missing: jsonb().notNull(),
		experienceSummary: jsonb().notNull(),
		status: text({ enum: RUN_STATUSES }).notNull(),
		...timestamps()
	},
	(t) => [
		enumCheck('categorization_runs', 'origin', t.origin, RUN_ORIGINS),
		enumCheck('categorization_runs', 'outcome', t.outcome, RUN_OUTCOMES),
		enumCheck('categorization_runs', 'status', t.status, RUN_STATUSES),
		sha256Check('categorization_runs', 'input_snapshot_sha256', t.inputSnapshotSha256),
		check(
			'categorization_runs_override',
			sql`(${t.origin} = 'manual_override') = (${t.overrideBy} is not null and ${t.overrideReason} is not null)`
		),
		check('categorization_runs_input_revision', sql`${t.inputRevision} >= 0`),
		// At most one published run per candidate; the previous one becomes superseded.
		uniqueIndex('categorization_runs_published')
			.on(t.candidateId)
			.where(sql`${t.status} = 'published'`),
		index('categorization_runs_candidate').on(t.candidateId, t.computedAt)
	]
);

const ASSIGNMENT_RANKS = ['primary', 'secondary'] as const;
const AXIS_STATUSES = ['established', 'insufficient_data'] as const;

export const categoryAssignments = pgTable(
	'category_assignments',
	{
		id: id(),
		runId: uuid()
			.notNull()
			.references(() => categorizationRuns.id),
		rank: text({ enum: ASSIGNMENT_RANKS }).notNull(),
		roleStatus: text({ enum: AXIS_STATUSES }).notNull(),
		roleKey: text(),
		gradeStatus: text({ enum: AXIS_STATUSES }).notNull(),
		gradeMin: text(),
		gradeMax: text(),
		gradeConfidence: numeric({ precision: 3, scale: 2 }),
		stackStatus: text({ enum: AXIS_STATUSES }).notNull(),
		stackSkillKeys: text()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		score: numeric(),
		explanation: jsonb().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('category_assignments', 'rank', t.rank, ASSIGNMENT_RANKS),
		enumCheck('category_assignments', 'role_status', t.roleStatus, AXIS_STATUSES),
		enumCheck('category_assignments', 'grade_status', t.gradeStatus, AXIS_STATUSES),
		enumCheck('category_assignments', 'stack_status', t.stackStatus, AXIS_STATUSES),
		// Each axis is set by its own evidence; an unknown axis does not cancel the known ones (domain 12.2).
		check(
			'category_assignments_role_axis',
			sql`case when ${t.roleStatus} = 'established'
				then ${t.roleKey} is not null
				else ${t.roleKey} is null and ${t.score} is null end`
		),
		check(
			'category_assignments_grade_axis',
			sql`case when ${t.gradeStatus} = 'established'
				then ${t.gradeMin} is not null and ${t.gradeMax} is not null and ${t.gradeConfidence} is not null
					and ${t.gradeConfidence} >= 0 and ${t.gradeConfidence} <= 1
				else ${t.gradeMin} is null and ${t.gradeMax} is null and ${t.gradeConfidence} is null end`
		),
		check(
			'category_assignments_stack_axis',
			sql`case when ${t.stackStatus} = 'established'
				then cardinality(${t.stackSkillKeys}) between 1 and 3
				else cardinality(${t.stackSkillKeys}) = 0 end`
		),
		check(
			'category_assignments_some_axis',
			sql`'established' in (${t.roleStatus}, ${t.gradeStatus}, ${t.stackStatus})`
		),
		check('category_assignments_secondary_role', sql`${t.rank} = 'primary' or ${t.roleStatus} = 'established'`),
		uniqueIndex('category_assignments_one_primary')
			.on(t.runId)
			.where(sql`${t.rank} = 'primary'`),
		index('category_assignments_run').on(t.runId)
	]
);

const FSP_LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;

export const fspLevelAssignments = pgTable(
	'fsp_level_assignments',
	{
		runId: uuid()
			.notNull()
			.references(() => categorizationRuns.id),
		discipline: text().notNull(),
		level: text({ enum: FSP_LEVELS }).notNull(),
		basisFactIds: uuid().array().notNull(),
		lastResultOn: date({ mode: 'string' })
	},
	(t) => [
		primaryKey({ name: 'fsp_level_assignments_pk', columns: [t.runId, t.discipline] }),
		enumCheck('fsp_level_assignments', 'level', t.level, FSP_LEVELS),
		check('fsp_level_assignments_basis', sql`cardinality(${t.basisFactIds}) >= 1`)
	]
);

const DISPUTE_STATUSES = ['open', 'in_review', 'resolved_upheld', 'resolved_changed', 'withdrawn'] as const;

export const categoryDisputes = pgTable(
	'category_disputes',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		runId: uuid()
			.notNull()
			.references(() => categorizationRuns.id),
		reason: text().notNull(),
		openedAt: ts().notNull(),
		dueAt: ts().notNull(),
		assigneeId: uuid().references(() => users.id),
		status: text({ enum: DISPUTE_STATUSES }).notNull(),
		resolution: text(),
		resultingRunId: uuid().references(() => categorizationRuns.id),
		resolvedAt: ts(),
		notifiedAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('category_disputes', 'status', t.status, DISPUTE_STATUSES),
		// Part 4 of article 16 of 152-FZ: an answer within 30 days.
		check('category_disputes_due', sql`${t.dueAt} = ${t.openedAt} + interval '30 days'`),
		check('category_disputes_assignee', sql`${t.status} <> 'in_review' or ${t.assigneeId} is not null`),
		check(
			'category_disputes_resolution',
			sql`(${t.status} in ('resolved_upheld', 'resolved_changed')) = (${t.resolution} is not null and ${t.resolvedAt} is not null)`
		),
		index('category_disputes_candidate').on(t.candidateId),
		index('category_disputes_open_due')
			.on(t.dueAt)
			.where(sql`${t.status} in ('open', 'in_review')`)
	]
);
