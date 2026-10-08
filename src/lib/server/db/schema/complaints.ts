// Complaints of candidates about offers (docs/domain.md, section 13.14): the candidate reports what went wrong with an
// offer, an FSP operator decides — no consequence, a warning to the company or its suspension.
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { enumCheck, id, timestamps, ts } from './_columns';
import { candidates } from './candidates';
import { companies } from './companies';
import { invitations, invitationTerms } from './hiring';
import { users } from './identity';

/** What the candidate complains about; the labels are in the interface and in the API description. */
export const COMPLAINT_REASONS = [
	'terms_mismatch',
	'no_real_job',
	'contact_harvesting',
	'payment_demanded',
	'discrimination',
	'other'
] as const;
export const COMPLAINT_STATUSES = ['open', 'decided'] as const;
export const COMPLAINT_DECISIONS = ['no_action', 'warning', 'suspension'] as const;

export const invitationComplaints = pgTable(
	'invitation_complaints',
	{
		id: id(),
		invitationId: uuid()
			.notNull()
			.references(() => invitations.id),
		companyId: uuid()
			.notNull()
			.references(() => companies.id),
		candidateId: uuid()
			.notNull()
			.references(() => candidates.id),
		/** The version of the terms that was current when the candidate complained; `NULL` only in a tombstone. */
		termsId: uuid().references(() => invitationTerms.id),
		reasonCode: text({ enum: COMPLAINT_REASONS }).notNull(),
		/** The candidate's account of what happened; the operator reads it, the company never does. `NULL` in a tombstone. */
		text: text(),
		status: text({ enum: COMPLAINT_STATUSES }).notNull(),
		decision: text({ enum: COMPLAINT_DECISIONS }),
		/** The operator's explanation to the candidate. */
		resolution: text(),
		decidedBy: uuid().references(() => users.id),
		decidedAt: ts(),
		/**
		 * The purge of the candidate's account left a tombstone of a decided complaint: company, reason, status and
		 * decision stay for the trust facts of the company, the texts and the terms go (domain 13.14, 19.2).
		 */
		purgedAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('invitation_complaints', 'reason_code', t.reasonCode, COMPLAINT_REASONS),
		enumCheck('invitation_complaints', 'status', t.status, COMPLAINT_STATUSES),
		enumCheck('invitation_complaints', 'decision', t.decision, COMPLAINT_DECISIONS),
		check('invitation_complaints_text_length', sql`char_length(${t.text}) between 10 and 2000`),
		check('invitation_complaints_resolution_length', sql`char_length(${t.resolution}) between 10 and 2000`),
		check(
			'invitation_complaints_decision_fields',
			sql`case ${t.status}
				when 'open' then ${t.decision} is null and ${t.resolution} is null and ${t.decidedBy} is null and ${t.decidedAt} is null
				else ${t.decision} is not null and (${t.resolution} is not null or ${t.purgedAt} is not null)
					and ${t.decidedAt} is not null end`
		),
		check(
			'invitation_complaints_tombstone',
			sql`case when ${t.purgedAt} is null then ${t.text} is not null and ${t.termsId} is not null
				else ${t.status} = 'decided' and ${t.text} is null and ${t.termsId} is null and ${t.resolution} is null end`
		),
		// One complaint of the candidate per offer: the line of offers of a company to a candidate is one row (13.5).
		unique('invitation_complaints_one_per_offer').on(t.invitationId, t.candidateId),
		index('invitation_complaints_queue').on(t.status, t.createdAt),
		index('invitation_complaints_company').on(t.companyId)
	]
);
