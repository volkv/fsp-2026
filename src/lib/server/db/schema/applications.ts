// A candidate's own application to a vacancy of a company of the platform (docs/domain.md, sections 6.5, 13.5): the
// secondary way to contact, with the match at the moment of applying and the disclosure of contacts to that company.
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { enumCheck, id, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { companies } from './companies';
import { invitations } from './hiring';
import { vacancies } from './vacancies';

export const APPLICATION_STATUSES = ['submitted', 'viewed', 'invited', 'rejected', 'withdrawn'] as const;

/**
 * One application of a candidate per vacancy. `match` is the match of the pair when the candidate applied; `invitation_id`
 * — the offer the company sent from it. After the purge of the account only id, company, vacancy and status stay
 * (`purged_at`): the disclosure made by the application refers to it (domain 19.2).
 */
export const applications = pgTable(
	'applications',
	{
		id: id(),
		candidateId: uuid()
			.notNull()
			.references((): AnyPgColumn => candidates.id),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		vacancyId: uuid()
			.notNull()
			.references(() => vacancies.id),
		message: text(),
		match: jsonb(),
		status: text({ enum: APPLICATION_STATUSES }).notNull(),
		invitationId: uuid().references((): AnyPgColumn => invitations.id),
		submittedAt: ts().notNull(),
		viewedAt: ts(),
		decidedAt: ts(),
		closedAt: ts(),
		purgedAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('applications', 'status', t.status, APPLICATION_STATUSES),
		unique('applications_candidate_vacancy').on(t.candidateId, t.vacancyId),
		check('applications_message_length', sql`char_length(${t.message}) between 1 and 2000`),
		check('applications_match', sql`${t.purgedAt} is not null or jsonb_typeof(${t.match}) = 'object'`),
		check('applications_purged', sql`${t.purgedAt} is null or (${t.message} is null and ${t.match} is null)`),
		check('applications_invited', sql`${t.status} <> 'invited' or ${t.invitationId} is not null`),
		check('applications_closed', sql`(${t.status} in ('rejected', 'withdrawn')) = (${t.closedAt} is not null)`),
		index('applications_company').on(t.companyId, t.status),
		index('applications_vacancy').on(t.vacancyId)
	]
);
