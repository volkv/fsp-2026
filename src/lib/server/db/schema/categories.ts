// Categories confirmed by a test and objections to test results (domain 12.4, 12.5). A category is written by the
// category module only, from a grade decision; `decision_id` refers to `grade_decisions`.
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '../../assessments/contract/catalog';
import { enumCheck, id, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { users } from './identity';

export const CATEGORY_STATUSES = ['active', 'superseded', 'revoked'] as const;
export const CATEGORY_REVOKE_REASONS = ['decision_annulled', 'objection_annulled', 'objection_rescored'] as const;

export const candidateCategories = pgTable(
	'candidate_categories',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		specialization: text({ enum: SPECIALIZATION_KEYS }).notNull(),
		grade: text({ enum: GRADE_KEYS }).notNull(),
		catalogVersion: text().notNull(),
		decisionId: uuid().notNull(),
		bankReleaseId: text().notNull(),
		confirmedBlocks: text().array().notNull(),
		confirmedSkillKeys: text().array().notNull(),
		confidentUpgradeUntil: ts(),
		status: text({ enum: CATEGORY_STATUSES }).notNull(),
		assignedAt: ts().notNull(),
		endedAt: ts(),
		revokeReason: text({ enum: CATEGORY_REVOKE_REASONS }),
		...timestamps()
	},
	(t) => [
		enumCheck('candidate_categories', 'specialization', t.specialization, SPECIALIZATION_KEYS),
		enumCheck('candidate_categories', 'grade', t.grade, GRADE_KEYS),
		enumCheck('candidate_categories', 'status', t.status, CATEGORY_STATUSES),
		enumCheck('candidate_categories', 'revoke_reason', t.revokeReason, CATEGORY_REVOKE_REASONS),
		check('candidate_categories_ended', sql`(${t.status} = 'active') = (${t.endedAt} is null)`),
		check('candidate_categories_revoke_reason', sql`(${t.status} = 'revoked') = (${t.revokeReason} is not null)`),
		// One category in force per specialization; categories of different specializations coexist (domain 12.4).
		uniqueIndex('candidate_categories_active')
			.on(t.candidateId, t.specialization)
			.where(sql`${t.status} = 'active'`),
		index('candidate_categories_decision').on(t.decisionId),
		index('candidate_categories_filter')
			.on(t.specialization, t.grade)
			.where(sql`${t.status} = 'active'`)
	]
);

export const OBJECTION_STATUSES = ['open', 'in_review', 'resolved', 'withdrawn'] as const;
export const OBJECTION_OUTCOMES = ['upheld', 'annulled', 'rescored'] as const;

export const assessmentObjections = pgTable(
	'assessment_objections',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		decisionId: uuid().notNull(),
		reason: text().notNull(),
		/** Clusters (`test_items.id`) the candidate disagrees with. */
		items: uuid().array(),
		openedAt: ts().notNull(),
		dueAt: ts().notNull(),
		assigneeId: uuid().references(() => users.id),
		status: text({ enum: OBJECTION_STATUSES }).notNull(),
		outcome: text({ enum: OBJECTION_OUTCOMES }),
		resolution: text(),
		resultingDecisionId: uuid(),
		resolvedAt: ts(),
		notifiedAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('assessment_objections', 'status', t.status, OBJECTION_STATUSES),
		enumCheck('assessment_objections', 'outcome', t.outcome, OBJECTION_OUTCOMES),
		check('assessment_objections_reason_length', sql`char_length(${t.reason}) between 1 and 2000`),
		// Part 4 of article 16 of 152-FZ: an answer within 30 days.
		check('assessment_objections_due', sql`${t.dueAt} = ${t.openedAt} + interval '30 days'`),
		check('assessment_objections_assignee', sql`${t.status} <> 'in_review' or ${t.assigneeId} is not null`),
		check(
			'assessment_objections_resolution',
			sql`(${t.status} = 'resolved') = (${t.outcome} is not null and ${t.resolution} is not null and ${t.resolvedAt} is not null)`
		),
		check(
			'assessment_objections_resulting_decision',
			sql`(${t.resultingDecisionId} is not null) = (${t.outcome} is not distinct from 'rescored')`
		),
		uniqueIndex('assessment_objections_open')
			.on(t.decisionId)
			.where(sql`${t.status} in ('open', 'in_review')`),
		index('assessment_objections_candidate').on(t.candidateId),
		index('assessment_objections_open_due')
			.on(t.dueAt)
			.where(sql`${t.status} in ('open', 'in_review')`)
	]
);
