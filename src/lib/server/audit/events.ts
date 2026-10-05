// Catalog of journal events (docs/domain.md, section 18.2). `details` carries codes and identifiers only:
// no resume text, contacts, free-text messages or profile field values (section 18.1).
import { z } from 'zod';
import { ANNUL_REASONS } from '$lib/server/db/schema';

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
		'hiring.reported',
		'match.viewed',
		'need.created',
		'need.updated'
	],
	aggregator: [
		'vacancies.import_completed',
		'vacancy_source.enabled',
		'vacancy_source.disabled',
		'vacancy.posting_moved',
		'vacancy.hidden',
		'vacancy_claim.submitted',
		'vacancy_claim.withdrawn',
		'vacancy_claim.decided'
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
		'assessment.artifact_viewed'
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
	demo: ['demo.reset', 'demo.seeded', 'demo.session_opened', 'demo.session_purged']
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

/** Required keys of events whose details the model names; other events take any code details. */
const SPECIFIC_DETAILS: Partial<Record<AuditAction, z.ZodType>> = {
	'auth.registered': withKeys({ method: z.enum(['password', 'fsp_id']) }),
	'auth.login': withKeys({ method: z.enum(['password', 'fsp_id']) }),
	'operator.case_access': withKeys({
		case_type: z.enum(['objection', 'moderation', 'authority', 'assessment', 'age']),
		case_id: token
	}),
	// A month of the journal removed by `retention.sweep` after the retention period (domain 18.1).
	'audit.partition_dropped': withKeys({ partition: token, range_from: z.iso.date(), range_to: z.iso.date() }),
	'catalog.searched': withKeys({ result_count: z.int().nonnegative() }),
	'card.viewed': withKeys({ pseudonym: token, projection }),
	'invitation.terms_revised': withKeys({ salary_lowered: z.boolean() }),
	'hiring.reported': withKeys({ party: z.enum(['company', 'candidate']), kind: z.enum(['stage', 'outcome']) }),
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
	'vacancies.import_completed': withKeys({ source: token, completeness: z.enum(['complete', 'partial']) }),
	// The administrator switched a source on; its out-of-turn full import is the job of the same transaction.
	'vacancy_source.enabled': withKeys({ source: token, import_job_id: token }),
	// A source switched off by the administrator, or after a refusal by rights or terms (contracts 7.2) met by an import
	// run or a check.
	'vacancy_source.disabled': z.union([
		withKeys({ source: token, reason: z.literal('administrator') }),
		withKeys({
			source: token,
			reason: z.literal('source_forbidden'),
			via: z.enum(['import', 'freshness_check'])
		})
	]),
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
	// The demonstration stand was emptied except the reference data (domain 19.2), or filled by the demo seed.
	'demo.reset': withKeys({
		tables_cleared: z.int().nonnegative(),
		rows_kept: z.int().nonnegative(),
		files_removed: z.int().nonnegative()
	}),
	'demo.seeded': withKeys({ batch: token, candidates: z.int().nonnegative(), vacancies: z.int().nonnegative() }),
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
