// Hiring needs, offers with immutable terms versions, responses and hiring processes (domain 13.5–13.10).
import { sql } from 'drizzle-orm';
import { check, date, index, integer, jsonb, pgTable, text, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { enumCheck, fullSalary, id, salaryChecks, salaryColumns, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { companies, companyMembers } from './companies';
import { consentEvents } from './consent';
import { users } from './identity';
import { productPolicies } from './policies';
import { vacancies } from './vacancies';

const NEED_STATUSES = ['draft', 'active', 'closed'] as const;

/**
 * A hiring need of a company (domain 13.10): free text, its form confirmed by the employer and the parse of the text
 * that suggested the form, each field with its quote. The way to an offer goes through it; a vacancy is not needed.
 */
export const hiringNeeds = pgTable(
	'hiring_needs',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		createdByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		text: text(),
		form: jsonb().notNull(),
		parse: jsonb(),
		textCheck: jsonb().notNull(),
		status: text({ enum: NEED_STATUSES }).notNull(),
		...timestamps()
	},
	(t) => [
		enumCheck('hiring_needs', 'status', t.status, NEED_STATUSES),
		check('hiring_needs_text_length', sql`char_length(${t.text}) between 1 and 5000`),
		check('hiring_needs_parse_with_text', sql`${t.parse} is null or ${t.text} is not null`),
		index('hiring_needs_company').on(t.companyId, t.status)
	]
);

const INVITATION_STATUSES = ['sent', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn'] as const;

/**
 * The line of offers of a company to a candidate (domain 13.5): one row per pair for all time; a new offer after a
 * closed one is a new version of the same row. `current_terms_id` references the terms table that references back;
 * the constraint is deferred to commit (migration 0002). `purged_at` marks the tombstone left after account purge:
 * only id, company, status stay (domain 19.2).
 */
export const invitations = pgTable(
	'invitations',
	{
		id: id(),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		sentByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		status: text({ enum: INVITATION_STATUSES }).notNull(),
		currentTermsId: uuid().references((): AnyPgColumn => invitationTerms.id),
		acceptedTermsId: uuid().references((): AnyPgColumn => invitationTerms.id),
		/** The need the offer was sent from (domain 13.10). */
		needId: uuid().references(() => hiringNeeds.id),
		policyId: uuid()
			.notNull()
			.references(() => productPolicies.id),
		reopenCount: integer().notNull().default(0),
		sentAt: ts().notNull(),
		viewedAt: ts(),
		closedAt: ts(),
		purgedAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('invitations', 'status', t.status, INVITATION_STATUSES),
		unique('invitations_company_candidate').on(t.companyId, t.candidateId),
		check('invitations_terms', sql`${t.purgedAt} is not null or ${t.currentTermsId} is not null`),
		check(
			'invitations_purged',
			sql`${t.purgedAt} is null or (${t.currentTermsId} is null and ${t.acceptedTermsId} is null)`
		),
		check(
			'invitations_accepted_terms',
			sql`${t.status} <> 'accepted' or ${t.purgedAt} is not null or ${t.acceptedTermsId} is not null`
		),
		check('invitations_reopen_count', sql`${t.reopenCount} >= 0`),
		index('invitations_candidate').on(t.candidateId),
		index('invitations_company').on(t.companyId, t.status)
	]
);

/**
 * Append-only: every terms change is a new version (domain 13.5). The range is in roubles per month with the tax base
 * the employer chose; the vacancy is optional and, when named, is copied into the version as it was at that moment.
 */
export const invitationTerms = pgTable(
	'invitation_terms',
	{
		id: id(),
		invitationId: uuid()
			.notNull()
			.references(() => invitations.id),
		version: integer().notNull(),
		title: text().notNull(),
		description: text().notNull(),
		vacancyId: uuid().references(() => vacancies.id),
		vacancySnapshot: jsonb(),
		/** `{specialization, grade}` of the candidate's category at the version; `null` — no confirmed category. */
		category: jsonb(),
		...salaryColumns(),
		workFormat: text().notNull(),
		contactMethod: jsonb().notNull(),
		whyYou: jsonb().notNull(),
		message: text(),
		textCheck: jsonb().notNull(),
		responseDueAt: ts().notNull(),
		changes: jsonb(),
		createdByMemberId: uuid()
			.notNull()
			.references(() => companyMembers.id),
		createdAt: ts().notNull().defaultNow()
	},
	(t) => [
		...salaryChecks('invitation_terms', t),
		check('invitation_terms_full_salary', fullSalary(t)),
		check('invitation_terms_salary_rub', sql`${t.salaryCurrency} = 'RUB' and ${t.salaryPeriod} = 'month'`),
		check('invitation_terms_title_length', sql`char_length(${t.title}) between 1 and 120`),
		check('invitation_terms_description_length', sql`char_length(${t.description}) between 50 and 5000`),
		check('invitation_terms_message_length', sql`char_length(${t.message}) between 1 and 2000`),
		check('invitation_terms_vacancy_snapshot', sql`(${t.vacancyId} is null) = (${t.vacancySnapshot} is null)`),
		check(
			'invitation_terms_why_you',
			sql`jsonb_typeof(${t.whyYou}) = 'array' and jsonb_array_length(${t.whyYou}) between 1 and 5`
		),
		check('invitation_terms_version_positive', sql`${t.version} >= 1`),
		check('invitation_terms_changes', sql`(${t.version} > 1) = (${t.changes} is not null)`),
		check('invitation_terms_due_after_creation', sql`${t.responseDueAt} > ${t.createdAt}`),
		unique('invitation_terms_invitation_version').on(t.invitationId, t.version),
		index('invitation_terms_vacancy')
			.on(t.vacancyId)
			.where(sql`${t.vacancyId} is not null`)
	]
);

const RESPONSE_DECISIONS = ['accept', 'decline'] as const;

export const invitationResponses = pgTable(
	'invitation_responses',
	{
		id: id(),
		invitationId: uuid()
			.notNull()
			.references(() => invitations.id),
		termsId: uuid()
			.notNull()
			.unique('invitation_responses_terms')
			.references(() => invitationTerms.id),
		decision: text({ enum: RESPONSE_DECISIONS }).notNull(),
		reasonCode: text(),
		reasonText: text(),
		consentEventId: uuid().references(() => consentEvents.id),
		respondedAt: ts().notNull()
	},
	(t) => [
		enumCheck('invitation_responses', 'decision', t.decision, RESPONSE_DECISIONS),
		check(
			'invitation_responses_decline_only_fields',
			sql`${t.decision} = 'decline' or (${t.reasonCode} is null and ${t.reasonText} is null)`
		),
		check('invitation_responses_consent_on_accept', sql`${t.decision} = 'accept' or ${t.consentEventId} is null`),
		index('invitation_responses_invitation').on(t.invitationId)
	]
);

export const hiringProcesses = pgTable(
	'hiring_processes',
	{
		id: id(),
		invitationId: uuid()
			.notNull()
			.unique('hiring_processes_invitation')
			.references(() => invitations.id),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		openedAt: ts().notNull(),
		outcomeDueAt: ts().notNull(),
		policyId: uuid()
			.notNull()
			.references(() => productPolicies.id),
		...timestamps()
	},
	(t) => [
		check('hiring_processes_due_after_open', sql`${t.outcomeDueAt} > ${t.openedAt}`),
		index('hiring_processes_candidate').on(t.candidateId),
		index('hiring_processes_company').on(t.companyId)
	]
);

const REPORT_PARTIES = ['company', 'candidate'] as const;
const REPORT_KINDS = ['stage', 'outcome'] as const;
const REPORT_STAGES = ['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'] as const;
const REPORT_OUTCOMES = ['hired', 'not_hired', 'candidate_withdrew', 'company_stopped', 'no_contact'] as const;

/** Append-only reports of each party; a correction supersedes the party's own previous report (domain 13.7). */
export const hiringReports = pgTable(
	'hiring_reports',
	{
		id: id(),
		processId: uuid()
			.notNull()
			.references(() => hiringProcesses.id),
		party: text({ enum: REPORT_PARTIES }).notNull(),
		reportedByUserId: uuid()
			.notNull()
			.references(() => users.id),
		kind: text({ enum: REPORT_KINDS }).notNull(),
		stage: text({ enum: REPORT_STAGES }),
		outcome: text({ enum: REPORT_OUTCOMES }),
		startDate: date({ mode: 'string' }),
		reasonCode: text(),
		supersedesReportId: uuid().references((): AnyPgColumn => hiringReports.id),
		reportedAt: ts().notNull()
	},
	(t) => [
		enumCheck('hiring_reports', 'party', t.party, REPORT_PARTIES),
		enumCheck('hiring_reports', 'kind', t.kind, REPORT_KINDS),
		enumCheck('hiring_reports', 'stage', t.stage, REPORT_STAGES),
		enumCheck('hiring_reports', 'outcome', t.outcome, REPORT_OUTCOMES),
		check(
			'hiring_reports_kind_fields',
			sql`case ${t.kind}
				when 'stage' then ${t.stage} is not null and ${t.outcome} is null
				else ${t.outcome} is not null and ${t.stage} is null end`
		),
		check('hiring_reports_start_date', sql`${t.startDate} is null or ${t.outcome} = 'hired'`),
		unique('hiring_reports_supersedes').on(t.supersedesReportId),
		index('hiring_reports_process').on(t.processId)
	]
);
