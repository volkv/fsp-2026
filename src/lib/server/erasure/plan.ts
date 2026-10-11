// What the purge of an account does with every row that names the person (docs/domain.md, section 19.2): each foreign
// key to `users` or `candidates` has a decision, and a new key without one fails its invariant test instead of leaving
// the person's rows behind unnoticed. Rows reached through another row of the person (a claim through its fact, the
// terms through their invitation) go with that row; the purge names them in `purge.ts`.

/** How the purge treats the rows a foreign key column ties to the purged person. */
export type ErasureDecision =
	/** Removed by the purge: no row names the purged person afterwards. */
	| { kind: 'erased' }
	/** Stays, with the reason and the rule that ends it. */
	| { kind: 'kept'; why: string };

const erased: ErasureDecision = { kind: 'erased' };
const kept = (why: string): ErasureDecision => ({ kind: 'kept', why });

/** Another person's act the row records (an operator's decision, who granted a role): the tombstone id stays named. */
const actOfAnother = kept('names who acted on someone else’s row; the tombstone id is all that stays');

export const ERASURE_PLAN: Readonly<Record<string, ErasureDecision>> = {
	// The account itself.
	'candidates.user_id': kept('the profile becomes a tombstone: disclosures and the journal refer to it'),
	'password_credentials.user_id': erased,
	'email_tokens.user_id': erased,
	'external_identities.user_id': erased,
	'athlete_links.user_id': erased,
	'notification_channels.user_id': erased,
	'notification_preferences.user_id': erased,
	'notifications.user_id': erased,
	'telegram_link_tokens.user_id': erased,
	'files.owner_user_id': kept('evidence of a company’s verification is the company’s, with its own retention period'),
	'document_acceptances.user_id': kept('an agreement accepted on behalf of a company stays with the company'),
	'consent_events.signer_user_id': kept(
		'only the events a disclosure refers to stay (domain 6.5), until its retention'
	),
	'staff_roles.user_id': kept(
		'an account with a staff role in force is not deleted; revoked grants are access history'
	),
	'company_members.user_id': kept('the membership is ended at the request; the team’s records name the member'),
	'hiring_reports.reported_by_user_id': kept('a company member’s report on the company’s process'),

	// Acts of the person on someone else's rows.
	'candidates.birth_date_verified_by': actOfAnother,
	'test_attempts.annulled_by': actOfAnother,
	'authority_checks.checked_by': actOfAnother,
	'assessment_objections.assignee_id': actOfAnother,
	'company_members.invited_by': actOfAnother,
	'company_members.removed_by': actOfAnother,
	'company_verifications.decided_by': actOfAnother,
	'competition_partnerships.granted_by': actOfAnother,
	'staff_roles.granted_by': actOfAnother,
	'staff_roles.revoked_by': actOfAnother,

	// The candidate profile and everything derived from it.
	'candidate_company_blocks.candidate_id': erased,
	'external_profiles.candidate_id': erased,
	'source_facts.candidate_id': erased,
	'claims.candidate_id': erased,
	'experience_entries.candidate_id': erased,
	'skill_inferences.candidate_id': erased,
	'evidence_runs.candidate_id': erased,
	'candidate_categories.candidate_id': erased,
	'assessment_objections.candidate_id': erased,
	'candidate_surveys.candidate_id': erased,
	'grade_declarations.candidate_id': erased,
	'match_scores.candidate_id': erased,
	'resume_documents.candidate_id': erased,
	'test_attempts.candidate_id': erased,
	'grade_decisions.candidate_id': erased,
	'hiring_processes.candidate_id': erased,
	// The employer's feedback on an interview against the confirmed grade (domain 13.7): about the person, so it goes.
	'interview_feedback.candidate_id': erased,
	'shortlist_marks.candidate_id': erased,
	'representations.candidate_id': kept('a representation with an authority document inside its retention period'),
	'consent_events.subject_candidate_id': kept('the events a disclosure refers to (domain 6.5), until its retention'),
	'disclosures.candidate_id': kept('proof of a lawful transfer (domain 6.5), until `disclosure_retention_months`'),
	'invitations.candidate_id': kept('a tombstone of id, company and status: disclosures refer to it'),
	// The candidate's own profile fields and the confirmations of the categories (domain 12.9, 23.2).
	'profile_experience_entries.candidate_id': erased,
	'profile_suggestions.candidate_id': erased,
	'category_attestations.candidate_id': erased,
	// Calls, requests of a confirmation, results of block tests, applications (domain 13.11, 13.12, 23.2).
	'challenge_deliveries.candidate_id': erased,
	'confirmation_requests.candidate_id': erased,
	'block_confirmations.candidate_id': erased,
	'applications.candidate_id': kept('a tombstone of id, company, vacancy and status: a disclosure by it refers to it'),
	// Complaints about offers (domain 13.14): the candidate's account of what happened goes; a decided complaint stays as
	// a tombstone for the trust facts of the company.
	'invitation_complaints.candidate_id': kept(
		'a decided complaint is a tombstone of company, reason, status and decision: the trust facts of the company count it'
	),
	'invitation_complaints.decided_by': actOfAnother,
	// Quarantine of a bank family by staff (domain 10.5): who put it there and who lifted it.
	'bank_family_quarantines.quarantined_by': actOfAnother,
	'bank_family_quarantines.lifted_by': actOfAnother
};

/** A single-column foreign key of the schema. */
export interface ReferenceColumn {
	table: string;
	column: string;
	references: string;
}

/** The person's tables: a foreign key to one of them needs a decision. */
const PERSON_TABLES: ReadonlySet<string> = new Set(['users', 'candidates']);

export interface ErasurePlanMismatch {
	/** `table.column` keys to a person's table without a decision. */
	undecided: string[];
	/** Decisions the schema has no such key for. */
	stale: string[];
}

/** Compares the plan with the foreign keys of the database. */
export function compareWithErasurePlan(keys: readonly ReferenceColumn[]): ErasurePlanMismatch {
	const present = new Set(
		keys.filter((key) => PERSON_TABLES.has(key.references)).map((key) => `${key.table}.${key.column}`)
	);
	return {
		undecided: [...present].filter((key) => !Object.hasOwn(ERASURE_PLAN, key)).sort(),
		stale: Object.keys(ERASURE_PLAN)
			.filter((key) => !present.has(key))
			.sort()
	};
}

/** The keys whose rows the purge removes: after it, none of them names the purged person. */
export function erasedColumns(): { table: string; column: string }[] {
	return Object.entries(ERASURE_PLAN)
		.filter(([, decision]) => decision.kind === 'erased')
		.map(([key]) => {
			const [table, column] = key.split('.');
			if (table === undefined || column === undefined) throw new Error(`erasure plan key ${key} is not table.column`);
			return { table, column };
		});
}
