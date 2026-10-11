// Catalog of journal events (docs/domain.md, section 18.2). `details` carries codes and identifiers only:
// no resume text, contacts, free-text messages or profile field values (section 18.1).
import { z } from 'zod';
import {
	ANNUL_REASONS,
	INTERVIEW_FEEDBACK_OUTCOMES,
	INTERVIEW_LEVELS,
	QUARANTINE_REASONS
} from '$lib/server/db/schema';

/** A code or an identifier: no spaces, so free text does not fit. */
const token = z.string().regex(/^[A-Za-z0-9_.:@/+-]{1,128}$/, 'must be a code or an identifier');
const scalar = z.union([token, z.number(), z.boolean(), z.null()]);
const value = z.union([
	scalar,
	z.array(scalar).max(100),
	z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.union([scalar, z.array(scalar).max(100)]))
]);
const codeDetails = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), value);

const withKeys = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

const count = z.int().nonnegative();

const projection = z.enum(['self', 'catalog', 'recipient', 'public', 'operator']);

/**
 * How the operator checked the document of a birth date (domain 7.2): shown at a meeting or a video call, or brought in
 * person. A copy is not kept: the decision is valid without it, as the check of a representative's authority is.
 */
export const AGE_CHECK_METHODS = ['document_presented', 'in_person'] as const;
/** The document the birth date was checked by; its number and requisites are never recorded. */
export const AGE_DOCUMENT_KINDS = [
	'passport',
	'birth_certificate',
	'international_passport',
	'foreign_identity_document'
] as const;

const EXTERNAL_PLATFORM = z.enum(['codeforces', 'github']);
const SOURCE_FAILURE = z.enum(['timeout', 'network', 'rate_limited', 'server_error', 'protocol_error']);

const GROUPS = {
	auth: [
		'auth.registered',
		'auth.login',
		'auth.logout',
		'auth.lockout',
		'auth.password_changed',
		'auth.password_reset',
		'auth.email_verified',
		'session.revoked_all'
	],
	identities: ['identity.linked', 'identity.unlinked', 'identity.link_refused'],
	access: [
		'staff.role_granted',
		'staff.role_revoked',
		'api_key.created',
		'api_key.revoked',
		'operator.case_access',
		'audit.read',
		'audit.partition_dropped'
	],
	companies: [
		'company.created',
		'company.updated',
		'company.submitted',
		'company.verified',
		'company.rejected',
		'company.info_requested',
		'company.suspended',
		'company.reinstated',
		'member.invited',
		'member.joined',
		'member.role_changed',
		'member.removed'
	],
	consents: [
		'consent.granted',
		'consent.revoked',
		'consent.lapsed',
		'representation.invited',
		'representation.contact_confirmed',
		'representation.authority_checked',
		'representation.letter_sent',
		'representation.ended',
		'age.verified',
		'age.conflict'
	],
	personalData: [
		'catalog.searched',
		'card.viewed',
		'card.viewed_recipient',
		'contacts.disclosed',
		'file.downloaded',
		'data.exported',
		'account.deletion_requested',
		'account.purged',
		'facts.purged'
	],
	hiring: [
		'vacancy.published',
		'vacancy.blocked_text_check',
		'vacancy.moderation_decided',
		'vacancy.moderation_cleared',
		'vacancy.closed',
		'invitation.sent',
		'invitation.terms_revised',
		'invitation.reopened',
		'invitation.withdrawn',
		'invitation.responded',
		'invitation.message_sent',
		'hiring.reported',
		'hiring.interview_feedback_left',
		'hiring.interview_feedback_revised',
		'match.viewed',
		'need.created',
		'need.updated',
		'shortlist.created',
		'shortlist.revised',
		'shortlist.marked',
		'shortlist.unmarked',
		'shortlist.evaluated'
	],
	partners: ['partnership.opened', 'partnership.ended', 'partner_pool.viewed'],
	notifications: ['notification.channel_linked', 'notification.channel_unlinked'],
	grades: ['survey.submitted', 'grade.declared'],
	categories: [
		'evidence.blocked',
		'category.assigned',
		'category.superseded',
		'category.revoked',
		'objection.opened',
		'objection.assigned',
		'objection.resolved',
		'assessment.score_revised',
		'assessment.annulled',
		'assessment.artifact_viewed',
		'bank.family_quarantined',
		'bank.family_restored'
	],
	receipts: ['receipt.verified'],
	profile: [
		'profile.updated',
		'profile.suggestion_decided',
		'profile.experience_changed',
		'company_block.added',
		'company_block.removed',
		'profile.pdf_issued',
		'attestation.verified',
		'attestation.holder_checked'
	],
	integrations: [
		'fsp.sync_completed',
		'fsp.webhook_rejected',
		'telegram.webhook_rejected',
		'fsp.withdrawals_skipped_incomplete',
		'fsp.grant_mismatch',
		'fsp.batch_imported',
		'external_profile.challenge_issued',
		'external_profile.verified',
		'external_profile.verification_failed',
		'external_profile.unlinked',
		'external_profile.synced',
		'external_profile.sync_failed'
	],
	models: ['ml.mode_changed'],
	demo: [
		'demo.reset',
		'demo.reset_skipped',
		'demo.seeded',
		'demo.session_opened',
		'demo.session_purged',
		'demo.clock_advanced'
	],
	// Requests of a confirmation, calls of companies and the candidate's own applications (domain 13.11, 13.12, 18.2).
	contact: [
		'confirmation.requested',
		'confirmation.answered',
		'confirmation.completed',
		'confirmation.expired',
		'confirmation.visibility_changed',
		'challenge.published',
		'challenge.updated',
		'challenge.closed',
		'challenge.delivered',
		'challenge.solution_submitted',
		'challenge.solution_withdrawn',
		'challenge.solution_dismissed',
		'challenge.invited_from_solution',
		'application.submitted',
		'application.withdrawn',
		'application.decided'
	],
	// Complaints of candidates about offers and outgoing events of companies (domain 13.14, 5.7).
	complaints: ['complaint.filed', 'complaint.decided'],
	companyEvents: [
		'event_subscription.created',
		'event_subscription.updated',
		'event_subscription.secret_rotated',
		'event_subscription.deleted',
		'event_subscription.redelivered'
	]
} as const;

export type AuditAction = (typeof GROUPS)[keyof typeof GROUPS][number];

export const AUDIT_ACTIONS: readonly AuditAction[] = Object.values(GROUPS).flat();

/** A batch of FSP results loaded by the operator (contracts 1.7): its source file and counts, or why it was refused. */
export const FSP_BATCH_IMPORTED_DETAILS = {
	imported: withKeys({
		file_id: token,
		variant: z.enum(['file', 'pdf-protocols']),
		format: z.enum(['csv', 'xlsx', 'pdf', 'docx', 'odt', 'rtf']),
		profile: token,
		complete: z.boolean(),
		incomplete_reason: token.nullable(),
		rows_read: count,
		rows_valid: count,
		row_issues: count,
		competitions: count,
		athletes: count,
		rows: withKeys({ matched: count, without_fsp_id: count, not_linked: count, no_consent: count }),
		facts: withKeys({
			inserted: count,
			unchanged: count,
			superseded: count,
			annulled: count,
			withdrawn: count,
			skipped_withdrawals: count,
			claims: count,
			receipts: count
		})
	}),
	refused: withKeys({ file_id: token, refused: z.enum(['row_issues', 'taxonomy_missing']) })
};

/** The employer's feedback on an interview against the confirmed grade (domain 13.7): codes, never the comment. */
const interviewFeedbackDetails = withKeys({
	level: z.enum(INTERVIEW_LEVELS),
	outcome: z.enum(INTERVIEW_FEEDBACK_OUTCOMES)
});

/** Required keys of events whose details the model names; other events take any code details. */
const SPECIFIC_DETAILS: Partial<Record<AuditAction, z.ZodType>> = {
	'auth.registered': withKeys({ method: z.enum(['password', 'fsp_id', 'demo_newcomer']) }),
	'auth.login': withKeys({ method: z.enum(['password', 'fsp_id']) }),
	'operator.case_access': withKeys({
		case_type: z.enum(['objection', 'moderation', 'authority', 'assessment', 'age', 'complaint']),
		case_id: token
	}),
	// A month of the journal removed by `retention.sweep` after the retention period (domain 18.1).
	'audit.partition_dropped': withKeys({ partition: token, range_from: z.iso.date(), range_to: z.iso.date() }),
	'catalog.searched': withKeys({ result_count: z.int().nonnegative() }),
	'card.viewed': withKeys({ pseudonym: token, projection }),
	'invitation.terms_revised': withKeys({ salary_lowered: z.boolean() }),
	'hiring.reported': withKeys({ party: z.enum(['company', 'candidate']), kind: z.enum(['stage', 'outcome']) }),
	'hiring.interview_feedback_left': interviewFeedbackDetails,
	'hiring.interview_feedback_revised': interviewFeedbackDetails,
	'match.viewed': withKeys({ pseudonym: token, vacancy_id: token }),
	'facts.purged': withKeys({ count: z.int().nonnegative(), source: token }),
	// A one-time link to the legal representative (domain 6.4): what it asks for; a failed send names the mail error.
	'representation.letter_sent': withKeys({ kind: z.enum(['consents', 'disclosure']) }),
	// The operator resolved a conflict of the birth date by a document (domain 7.2): how the document was checked, which
	// one, whether it confirmed the declared date and the regime of age that follows; never the date itself.
	'age.verified': withKeys({
		method: z.enum(AGE_CHECK_METHODS),
		document_kind: z.enum(AGE_DOCUMENT_KINDS),
		matches_declared: z.boolean(),
		regime: z.enum(['adult', 'minor'])
	}),
	// An attempt annulled (domain 10.7): the reason and where the attempt was; the category is the owner's own event.
	'assessment.annulled': withKeys({
		reason: z.enum(ANNUL_REASONS),
		previous_status: z.enum(['decided', 'expired', 'in_progress'])
	}),
	// A family of the bank taken out of serving or put back by the administrator (domain 10.5); the note stays with the
	// quarantine, not in the journal.
	'bank.family_quarantined': withKeys({ release_id: token, reason: z.enum(QUARANTINE_REASONS), quarantine_id: token }),
	'bank.family_restored': withKeys({ reason: z.enum(QUARANTINE_REASONS), quarantine_id: token }),
	// A review of an objection re-scored clusters and replaced a decision (domain 12.5).
	'assessment.score_revised': withKeys({
		superseded_decision_id: token,
		decision_id: token,
		rescored_items: count
	}),
	// The operator's decision on a vacancy the text check sent to moderation, and the rules that blocked it (domain 13.1);
	// the reason stays with the vacancy, not in the journal.
	'vacancy.moderation_decided': withKeys({
		decision: z.enum(['published', 'returned', 'rejected']),
		status: z.enum(['published', 'paused', 'draft', 'closed']),
		rules: z.array(token)
	}),
	// The employer's edit cleared the text of a vacancy in moderation: where it went.
	'vacancy.moderation_cleared': withKeys({ status: z.enum(['published', 'paused', 'draft']) }),
	'telegram.webhook_rejected': withKeys({ reason: z.enum(['secret_missing', 'secret_mismatch']) }),
	'partner_pool.viewed': withKeys({ competition_ref: token, card_count: z.int().nonnegative() }),
	'receipt.verified': withKeys({
		handle: token,
		result: z.enum(['valid', 'superseded', 'annulled', 'not_valid', 'not_found'])
	}),
	// Names of the changed fields only, never their values (section 18.1).
	'profile.updated': withKeys({ fields: z.array(token).min(1) }),
	'profile.suggestion_decided': withKeys({
		field: z.enum(['full_name', 'phone', 'email', 'telegram', 'soft_skill']),
		decision: z.enum(['accepted', 'rejected'])
	}),
	'profile.experience_changed': withKeys({ change: z.enum(['added', 'updated', 'removed']) }),
	'company_block.added': withKeys({ company_id: token }),
	'company_block.removed': withKeys({ company_id: token }),
	'profile.pdf_issued': withKeys({ attestations: z.array(token), issued: z.int().nonnegative() }),
	'attestation.verified': withKeys({
		handle: token,
		result: z.enum(['valid', 'superseded', 'annulled', 'not_found'])
	}),
	'attestation.holder_checked': withKeys({ handle: token, result: z.enum(['matches', 'differs', 'not_found']) }),
	'fsp.sync_completed': withKeys({ fact_count: z.int().nonnegative(), complete: z.boolean() }),
	'fsp.withdrawals_skipped_incomplete': withKeys({ missing_count: z.int().nonnegative() }),
	'fsp.batch_imported': z.union([FSP_BATCH_IMPORTED_DETAILS.imported, FSP_BATCH_IMPORTED_DETAILS.refused]),
	// Linking a public profile by a one-time code (domain 9.4): the platform and what the check found; no handle.
	'external_profile.challenge_issued': withKeys({ platform: EXTERNAL_PLATFORM }),
	'external_profile.verified': withKeys({
		platform: EXTERNAL_PLATFORM,
		result: z.enum(['ok', 'source_unavailable', 'not_found']),
		reason: SOURCE_FAILURE.nullable()
	}),
	'external_profile.verification_failed': withKeys({
		platform: EXTERNAL_PLATFORM,
		result: z.enum([
			'code_not_found',
			'handle_not_found',
			'handle_taken',
			'expired',
			'attempts_exhausted',
			'source_unavailable'
		])
	}),
	'external_profile.unlinked': withKeys({ platform: EXTERNAL_PLATFORM, was_verified: z.boolean(), withdrawn: count }),
	'external_profile.synced': withKeys({
		platform: EXTERNAL_PLATFORM,
		result: z.enum(['ok', 'not_found']),
		inserted: count,
		superseded: count,
		withdrawn: count
	}),
	'external_profile.sync_failed': withKeys({ platform: EXTERNAL_PLATFORM, reason: SOURCE_FAILURE }),
	// The demonstration stand was emptied except the reference data (domain 19.2), or filled by the demo seed. `trigger`
	// — the job of a night, the start of the application with a batch not seeded yet, or the command line;
	// `previous_seed_ms` — how long the seed the emptied journal recorded took (`null` — it recorded none).
	'demo.reset': withKeys({
		trigger: z.enum(['nightly', 'startup', 'manual']),
		tables_cleared: z.int().nonnegative(),
		rows_kept: z.int().nonnegative(),
		files_removed: z.int().nonnegative(),
		previous_seed_ms: z.int().nonnegative().nullable()
	}),
	// The job of the night `date` found `DEMO_NIGHTLY_RESET` off when it ran and reset nothing.
	'demo.reset_skipped': withKeys({ date: z.iso.date(), reason: z.enum(['nightly_reset_off']) }),
	// With what the seed did with the tests (domain 23.3): open specializations, candidates and needs left without a
	// released bank, candidates of roles no test checks.
	'demo.seeded': withKeys({
		batch: token,
		candidates: z.int().nonnegative(),
		vacancies: z.int().nonnegative(),
		tests_open: z.array(token),
		tests_closed: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), count),
		tests_untested: count,
		tests_closed_needs: count,
		tests_closed_scenes: z.array(token)
	}),
	// A demo session was opened for a visitor with the clones of the cast, or removed with all its rows (domain 19.3).
	'demo.session_opened': withKeys({
		seed_batch: token,
		rows_copied: count,
		files_copied: count,
		expires_at: z.iso.datetime()
	}),
	'demo.session_purged': withKeys({
		rows_removed: count,
		files_removed: count,
		jobs_cancelled: count,
		references_detached: count
	}),
	// The result of a block test closed the request (domain 13.11).
	'confirmation.completed': withKeys({ verdict: z.enum(['confirmed', 'not_confirmed']), confirmation_id: token }),
	// A run of the delivery of one call (domain 13.12): how many candidates got it and how many were reminded.
	'challenge.delivered': withKeys({ delivered: count, reminded: count, expired: count }),
	'application.decided': withKeys({ decision: z.enum(['viewed', 'invited', 'rejected']) }),
	// «Промотать неделю» of a demo session: the new shift of the session's clock in seconds.
	'demo.clock_advanced': withKeys({ clock_offset_seconds: count }),
	'complaint.filed': withKeys({ company_id: token, reason_code: token }),
	'complaint.decided': withKeys({
		company_id: token,
		decision: z.enum(['no_action', 'warning', 'suspension'])
	}),
	'ml.mode_changed': withKeys({
		operation: z.enum(['extract', 'embed', 'rerank']),
		from: z.enum(['on', 'off']),
		to: z.enum(['on', 'off'])
	})
};

/** Validates event details; a violation is a programming error and throws. */
export function parseAuditDetails(
	action: AuditAction,
	details: Record<string, unknown> | null
): Record<string, unknown> | null {
	const schema = SPECIFIC_DETAILS[action];
	if (details === null) {
		if (schema) throw new Error(`audit event ${action} requires details`);
		return null;
	}
	schema?.parse(details);
	return codeDetails.parse(details);
}
