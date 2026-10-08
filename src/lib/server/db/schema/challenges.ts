// Calls of companies, their deliveries and solutions; requests of a missing confirmation and the results of block tests
// (docs/domain.md, sections 13.11, 13.12).
import { sql } from 'drizzle-orm';
import {
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
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '../../assessments/contract/catalog';
import { enumCheck, fullSalary, id, salaryChecks, salaryColumns, subsetOf, timestamps, ts } from './_columns';
import { bankReleases, testAttempts } from './assessments';
import { candidates } from './candidates';
import { companies, companyMembers } from './companies';
import { hiringNeeds, invitations } from './hiring';

export const CHALLENGE_ANSWER_KINDS = ['solution', 'approach'] as const;
export const CHALLENGE_STATUSES = ['draft', 'active', 'closed'] as const;

/**
 * A short task of a company with the range and the goal in view (domain 13.12). The delivery job offers it regularly to
 * candidates of its categories; `last_delivery_run_at` — the moment of the last run on the clock of the call (a call of
 * a demo session runs on the shifted clock of its session).
 */
export const companyChallenges = pgTable(
	'company_challenges',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		createdByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		title: text().notNull(),
		statement: text().notNull(),
		answerKind: text({ enum: CHALLENGE_ANSWER_KINDS }).notNull(),
		specialization: text({ enum: SPECIALIZATION_KEYS }).notNull(),
		grades: text().array().notNull(),
		...salaryColumns(),
		goal: text().notNull(),
		timeLimitMinutes: integer().notNull(),
		status: text({ enum: CHALLENGE_STATUSES }).notNull(),
		startsAt: ts(),
		endsAt: ts().notNull(),
		textCheck: jsonb().notNull(),
		lastDeliveryRunAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('company_challenges', 'answer_kind', t.answerKind, CHALLENGE_ANSWER_KINDS),
		enumCheck('company_challenges', 'status', t.status, CHALLENGE_STATUSES),
		enumCheck('company_challenges', 'specialization', t.specialization, SPECIALIZATION_KEYS),
		check(
			'company_challenges_grades',
			sql`cardinality(${t.grades}) between 1 and ${sql.raw(String(GRADE_KEYS.length))} and ${subsetOf(t.grades, GRADE_KEYS)}`
		),
		...salaryChecks('company_challenges', t),
		check('company_challenges_full_salary', fullSalary(t)),
		check('company_challenges_salary_rub', sql`${t.salaryCurrency} = 'RUB' and ${t.salaryPeriod} = 'month'`),
		check('company_challenges_title_length', sql`char_length(${t.title}) between 1 and 120`),
		check('company_challenges_statement_length', sql`char_length(${t.statement}) between 50 and 5000`),
		check('company_challenges_goal_length', sql`char_length(${t.goal}) between 1 and 500`),
		check('company_challenges_time_limit', sql`${t.timeLimitMinutes} between 5 and 30`),
		check('company_challenges_started', sql`${t.status} = 'draft' or ${t.startsAt} is not null`),
		check('company_challenges_period', sql`${t.startsAt} is null or ${t.endsAt} > ${t.startsAt}`),
		index('company_challenges_company').on(t.companyId, t.status),
		index('company_challenges_active')
			.on(t.specialization)
			.where(sql`${t.status} = 'active'`)
	]
);

export const CHALLENGE_DELIVERY_STATUSES = ['delivered', 'opened', 'solved', 'dismissed', 'expired'] as const;

/** A call offered to one candidate: once per pair for all time, one reminder at most (domain 13.12). */
export const challengeDeliveries = pgTable(
	'challenge_deliveries',
	{
		id: id(),
		challengeId: uuid()
			.notNull()
			.references(() => companyChallenges.id),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		/** The real moment of the delivery: what the candidate sees. */
		deliveredAt: ts().notNull(),
		/**
		 * The moment of the delivery on the clock of the call: `delivered_at` outside demo sessions, shifted by the clock
		 * of the session for a call of its company. The interval between calls and the reminder count it (domain 13.12).
		 */
		clockAt: ts().notNull(),
		openedAt: ts(),
		remindedAt: ts(),
		status: text({ enum: CHALLENGE_DELIVERY_STATUSES }).notNull(),
		...timestamps()
	},
	(t) => [
		enumCheck('challenge_deliveries', 'status', t.status, CHALLENGE_DELIVERY_STATUSES),
		unique('challenge_deliveries_pair').on(t.challengeId, t.candidateId),
		check('challenge_deliveries_opened', sql`${t.status} in ('delivered', 'expired') or ${t.openedAt} is not null`),
		check('challenge_deliveries_reminded', sql`${t.remindedAt} is null or ${t.remindedAt} >= ${t.deliveredAt}`),
		index('challenge_deliveries_candidate').on(t.candidateId, t.clockAt)
	]
);

export const CHALLENGE_SOLUTION_STATUSES = ['submitted', 'withdrawn'] as const;
export const CHALLENGE_COMPANY_DECISIONS = ['invited', 'dismissed'] as const;

/** A solution or an approach of a candidate to a delivered call; the candidate withdraws it at any time. */
export const challengeSolutions = pgTable(
	'challenge_solutions',
	{
		id: id(),
		deliveryId: uuid()
			.notNull()
			.unique('challenge_solutions_delivery')
			.references(() => challengeDeliveries.id),
		/** The text or code of the solution; cleared when the candidate withdraws it. */
		content: text(),
		submittedAt: ts().notNull(),
		status: text({ enum: CHALLENGE_SOLUTION_STATUSES }).notNull(),
		withdrawnAt: ts(),
		companyDecision: text({ enum: CHALLENGE_COMPANY_DECISIONS }),
		decidedAt: ts(),
		decidedByMemberId: uuid().references(() => companyMembers.id),
		...timestamps()
	},
	(t) => [
		enumCheck('challenge_solutions', 'status', t.status, CHALLENGE_SOLUTION_STATUSES),
		enumCheck('challenge_solutions', 'company_decision', t.companyDecision, CHALLENGE_COMPANY_DECISIONS),
		check(
			'challenge_solutions_content',
			sql`case ${t.status}
				when 'submitted' then char_length(${t.content}) between 1 and 20000 and ${t.withdrawnAt} is null
				else ${t.content} is null and ${t.withdrawnAt} is not null end`
		),
		check(
			'challenge_solutions_decision',
			sql`(${t.companyDecision} is null) = (${t.decidedAt} is null) and (${t.companyDecision} is null) = (${t.decidedByMemberId} is null)`
		)
	]
);

export const CONFIRMATION_REQUEST_STATUSES = ['requested', 'accepted', 'declined', 'completed', 'expired'] as const;

/**
 * An employer's request to confirm a block the candidate's category does not cover (domain 13.11). The attempt names its
 * request (`test_attempts.confirmation_request_id`); the request names only the result that closed it.
 */
export const confirmationRequests = pgTable(
	'confirmation_requests',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		requestedByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		invitationId: uuid().references(() => invitations.id),
		needId: uuid().references(() => hiringNeeds.id),
		specialization: text({ enum: SPECIALIZATION_KEYS }).notNull(),
		block: text().notNull(),
		grade: text({ enum: GRADE_KEYS }).notNull(),
		status: text({ enum: CONFIRMATION_REQUEST_STATUSES }).notNull(),
		confirmationId: uuid().references((): AnyPgColumn => blockConfirmations.id),
		answeredAt: ts(),
		expiresAt: ts().notNull(),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		enumCheck('confirmation_requests', 'status', t.status, CONFIRMATION_REQUEST_STATUSES),
		enumCheck('confirmation_requests', 'specialization', t.specialization, SPECIALIZATION_KEYS),
		enumCheck('confirmation_requests', 'grade', t.grade, GRADE_KEYS),
		check('confirmation_requests_completed', sql`(${t.status} = 'completed') = (${t.confirmationId} is not null)`),
		check(
			'confirmation_requests_answered',
			sql`${t.status} in ('requested', 'expired') or ${t.answeredAt} is not null`
		),
		check('confirmation_requests_expiry', sql`${t.expiresAt} > ${t.createdAt}`),
		// A repeated request of an open one returns it (domain 13.11).
		uniqueIndex('confirmation_requests_open')
			.on(t.companyId, t.candidateId, t.block, t.grade)
			.where(sql`${t.status} in ('requested', 'accepted')`),
		index('confirmation_requests_candidate').on(t.candidateId, t.status)
	]
);

export const BLOCK_VERDICTS = ['confirmed', 'not_confirmed'] as const;
export const BLOCK_CONFIRMATION_STATUSES = ['valid', 'annulled'] as const;
export const BLOCK_CONFIRMATION_VISIBILITIES = ['requester', 'all_companies'] as const;

/**
 * The result of a block test (domain 13.11): evidence of its own with validity, never a grade decision. Sums are in
 * twentieths over the four clusters, as in a grade decision.
 */
export const blockConfirmations = pgTable(
	'block_confirmations',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		attemptId: uuid()
			.notNull()
			.unique('block_confirmations_attempt')
			.references((): AnyPgColumn => testAttempts.id),
		specialization: text({ enum: SPECIALIZATION_KEYS }).notNull(),
		block: text().notNull(),
		grade: text({ enum: GRADE_KEYS }).notNull(),
		verdict: text({ enum: BLOCK_VERDICTS }).notNull(),
		scoreSum: integer().notNull(),
		cutSum: integer().notNull(),
		bankReleaseId: text()
			.notNull()
			.references(() => bankReleases.id),
		status: text({ enum: BLOCK_CONFIRMATION_STATUSES }).notNull(),
		visibility: text({ enum: BLOCK_CONFIRMATION_VISIBILITIES }).notNull(),
		decidedAt: ts().notNull()
	},
	(t) => [
		enumCheck('block_confirmations', 'specialization', t.specialization, SPECIALIZATION_KEYS),
		enumCheck('block_confirmations', 'grade', t.grade, GRADE_KEYS),
		enumCheck('block_confirmations', 'verdict', t.verdict, BLOCK_VERDICTS),
		enumCheck('block_confirmations', 'status', t.status, BLOCK_CONFIRMATION_STATUSES),
		enumCheck('block_confirmations', 'visibility', t.visibility, BLOCK_CONFIRMATION_VISIBILITIES),
		check('block_confirmations_sums', sql`${t.scoreSum} >= 0 and ${t.cutSum} > 0`),
		check('block_confirmations_verdict', sql`(${t.verdict} = 'confirmed') = (${t.scoreSum} >= ${t.cutSum})`),
		index('block_confirmations_candidate').on(t.candidateId, t.block)
	]
);
