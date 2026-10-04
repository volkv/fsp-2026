// Registry of legal document kinds, consent scopes and product policy kinds (domain 6.2, 6.3, 13.8, 20).
// Imported by the database schema through a relative path, so this module has no SvelteKit aliases.
import { z } from 'zod';

/** Personal-data consents: recorded as `consent_events`. */
export const CONSENT_KINDS = [
	'pd_processing',
	'catalog_visibility',
	'partner_pool',
	'telegram_notifications',
	'fsp_import',
	'contact_disclosure',
	'public_distribution',
	'automated_decision_written',
	'demo_resume_upload'
] as const;

/** Agreements that are not personal-data consents: recorded as `document_acceptances`. */
export const ACCEPTANCE_DOCUMENT_KINDS = ['user_agreement', 'employer_terms', 'minor_employment_terms'] as const;

export const DOCUMENT_KINDS = [...CONSENT_KINDS, ...ACCEPTANCE_DOCUMENT_KINDS] as const;

export type ConsentKind = (typeof CONSENT_KINDS)[number];
export type AcceptanceDocumentKind = (typeof ACCEPTANCE_DOCUMENT_KINDS)[number];
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Values of `scope_fields` of `catalog_visibility`: what an adult candidate adds to the catalog card (domain 6.3). */
export const CATALOG_SCOPE_FIELDS = ['fsp_achievements_exact', 'external_profiles'] as const;
export type CatalogScopeField = (typeof CATALOG_SCOPE_FIELDS)[number];

/** Values of `scope_fields` of `contact_disclosure` and of `disclosures.fields` (domain 6.5, 13.6). */
export const DISCLOSURE_FIELDS = ['full_name', 'email', 'phone', 'resume'] as const;
export type DisclosureField = (typeof DISCLOSURE_FIELDS)[number];

/** Blocks an adult may choose for the public page (`public_distribution.scope_fields`, domain 14). */
export const PUBLIC_SCOPE_FIELDS = [
	'full_name',
	'email',
	'phone',
	'city',
	'categories',
	'desired_roles',
	'fsp_levels',
	'skills',
	'fsp_achievements',
	'external_profiles'
] as const;
export type PublicScopeField = (typeof PUBLIC_SCOPE_FIELDS)[number];

/** Fields a candidate cannot leave out when accepting an invitation (domain 13.6). */
export const REQUIRED_DISCLOSURE_FIELDS = ['full_name', 'email'] as const satisfies readonly DisclosureField[];

/**
 * Who signs a document of the kind:
 * - `subject_with_representative` — the candidate, and for ages 14–17 also a verified representative;
 * - `adult_subject` — only the candidate who is 18 or older;
 * - `user` — any user (user agreement);
 * - `company_member` / `company_owner` — on behalf of a company.
 */
export type SignerRule = 'subject_with_representative' | 'adult_subject' | 'user' | 'company_member' | 'company_owner';

/** What a consent event of the kind is scoped to (`consent_events.scope_*`). */
export type ConsentScope = 'none' | 'invitation' | 'competition';

export interface DocumentKindSpec {
	record: 'consent' | 'acceptance';
	signer: SignerRule;
	scope: ConsentScope;
	/** Allowed `scope_fields` values; `null` — the kind takes no `scope_fields`. */
	scopeFields: readonly string[] | null;
	/** Required by the registration path of the respective role. */
	requiredAtOnboarding: boolean;
	/** Form of the document (`legal_documents.form`) the kind is issued with. */
	form: 'electronic_separate_screen' | 'electronic_signature';
	/** Whether the product offers a screen for the kind; `false` — the kind exists in the registry only. */
	availableByDefault: boolean;
}

export const DOCUMENT_KIND_SPECS: Readonly<Record<DocumentKind, DocumentKindSpec>> = {
	user_agreement: {
		record: 'acceptance',
		signer: 'user',
		scope: 'none',
		scopeFields: null,
		requiredAtOnboarding: true,
		form: 'electronic_separate_screen',
		availableByDefault: true
	},
	pd_processing: {
		record: 'consent',
		signer: 'subject_with_representative',
		scope: 'none',
		scopeFields: null,
		requiredAtOnboarding: true,
		form: 'electronic_separate_screen',
		availableByDefault: true
	},
	catalog_visibility: {
		record: 'consent',
		signer: 'subject_with_representative',
		scope: 'none',
		scopeFields: CATALOG_SCOPE_FIELDS,
		requiredAtOnboarding: false,
		form: 'electronic_separate_screen',
		availableByDefault: true
	},
	partner_pool: {
		record: 'consent',
		signer: 'adult_subject',
		scope: 'competition',
		scopeFields: null,
		requiredAtOnboarding: false,
		form: 'electronic_separate_screen',
		availableByDefault: true
	},
	telegram_notifications: {
		record: 'consent',
		signer: 'subject_with_representative',
		scope: 'none',
		scopeFields: null,
		requiredAtOnboarding: false,
		form: 'electronic_separate_screen',
		availableByDefault: true
	},
	fsp_import: {
		record: 'consent',
		signer: 'subject_with_representative',
		scope: 'none',
		scopeFields: null,
		requiredAtOnboarding: false,
		form: 'electronic_separate_screen',
		availableByDefault: true
	},
	contact_disclosure: {
		record: 'consent',
		signer: 'subject_with_representative',
		scope: 'invitation',
		scopeFields: DISCLOSURE_FIELDS,
		requiredAtOnboarding: false,
		form: 'electronic_separate_screen',
		availableByDefault: true
	},
	public_distribution: {
		record: 'consent',
		signer: 'adult_subject',
		scope: 'none',
		scopeFields: PUBLIC_SCOPE_FIELDS,
		requiredAtOnboarding: false,
		form: 'electronic_separate_screen',
		availableByDefault: false
	},
	automated_decision_written: {
		record: 'consent',
		signer: 'adult_subject',
		scope: 'none',
		scopeFields: null,
		requiredAtOnboarding: false,
		form: 'electronic_signature',
		availableByDefault: false
	},
	// A visitor of the demonstration stand uploads a resume of their own into a demo session (domain 19.3): a separate
	// consent with its own purpose and term, offered only on the demo screen.
	demo_resume_upload: {
		record: 'consent',
		signer: 'adult_subject',
		scope: 'none',
		scopeFields: null,
		requiredAtOnboarding: false,
		form: 'electronic_separate_screen',
		availableByDefault: true
	},
	employer_terms: {
		record: 'acceptance',
		signer: 'company_member',
		scope: 'none',
		scopeFields: null,
		requiredAtOnboarding: true,
		form: 'electronic_separate_screen',
		availableByDefault: true
	},
	minor_employment_terms: {
		record: 'acceptance',
		signer: 'company_owner',
		scope: 'none',
		scopeFields: null,
		requiredAtOnboarding: false,
		form: 'electronic_separate_screen',
		availableByDefault: true
	}
};

// --- Product policies (domain 13.8) ---

/** Ways a representative's authority may be checked (`authority_checks.method`, `minor_policy.authority_methods`). */
export const REPRESENTATIVE_AUTHORITY_METHODS = ['document_upload', 'document_presented', 'in_person', 'esia'] as const;

export const HIRING_STAGES = ['interview_scheduled', 'interview_done', 'offer_made', 'offer_accepted'] as const;

const positiveInt = z.int().positive();
const nonNegativeInt = z.int().nonnegative();
const reasonCodes = z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1);

export const POLICY_KINDS = [
	'invitation_policy',
	'hiring_policy',
	'notification_policy',
	'minor_policy',
	'catalog_policy',
	'market_policy',
	'sourcing_policy',
	'assessment_policy',
	'retention_policy',
	'matching_policy'
] as const;

export type PolicyKind = (typeof POLICY_KINDS)[number];

const retentionTerms = {
	audit_retention_months: positiveInt,
	disclosure_retention_months: positiveInt,
	inactive_candidate_purge_days: positiveInt
};

const demoTerms = {
	/** A demo session with the clones of the scenario cast is removed this many hours after it was opened. */
	demo_session_hours: positiveInt,
	/** A visitor's own resume uploaded into a demo session is removed this many hours after the upload. */
	demo_own_resume_hours: positiveInt
};

/** Parameters of each policy kind. Every value is a product decision that the brief may change (domain 20). */
export const POLICY_PARAMS = {
	invitation_policy: z.strictObject({
		response_window_hours: positiveInt,
		decline_reason_codes: reasonCodes,
		reason_required: z.boolean(),
		max_open_per_company_per_day: positiveInt,
		reopen_cooldown_days: nonNegativeInt,
		max_reopens: nonNegativeInt
	}),
	hiring_policy: z.strictObject({
		outcome_due_days: positiveInt,
		reminder_intervals_days: z.array(positiveInt),
		max_reminders: nonNegativeInt,
		stages: z.array(z.enum(HIRING_STAGES)).min(1),
		outcome_reason_codes: reasonCodes
	}),
	notification_policy: z.strictObject({
		/** Hours before `response_due_at` when the candidate is reminded about an open invitation. */
		response_due_reminder_hours: z.array(positiveInt)
	}),
	minor_policy: z.strictObject({
		enabled: z.boolean(),
		authority_methods: z.array(z.enum(REPRESENTATIVE_AUTHORITY_METHODS)).min(1)
	}),
	catalog_policy: z.strictObject({
		/** Counts below this value are shown as «< N» (domain 7.4). */
		small_count_threshold: positiveInt
	}),
	market_policy: z.strictObject({
		window_days: positiveInt,
		min_sample: positiveInt
	}),
	sourcing_policy: z.strictObject({
		stale_after_days: positiveInt
	}),
	assessment_policy: z.strictObject({
		max_attempts: positiveInt,
		retake_interval_days: nonNegativeInt,
		artifact_retention_days: positiveInt
	}),
	// Version 1 had no terms of the demonstration stand; from version 2 both are stated (domain 19.3). Version 3 states
	// the notice before the removal for inactivity and the retention of FSP batch files (domain 19.2, contracts 1.7).
	retention_policy: z.union([
		z.strictObject(retentionTerms),
		z.strictObject({ ...retentionTerms, ...demoTerms }),
		z.strictObject({
			...retentionTerms,
			...demoTerms,
			/** Days between the notice of the removal for inactivity and the removal (`candidates.purge_after`). */
			inactivity_notice_days: positiveInt,
			/** Days a source file of an FSP results batch is kept after its upload (`files.retention_until`). */
			fsp_batch_retention_days: positiveInt
		})
	]),
	matching_policy: z.strictObject({
		/**
		 * Pairs scoring at least this much are stored in `match_scores` (domain 13.4); the rest are computed when read.
		 * Not above the pool threshold of the match rule set: the pool is counted from the stored pairs too.
		 */
		store_threshold: z.number().min(0).max(1)
	})
} as const satisfies Record<PolicyKind, z.ZodType>;

export type PolicyParams<K extends PolicyKind> = z.infer<(typeof POLICY_PARAMS)[K]>;

/** Validates stored or submitted policy parameters of the given kind. */
export function parsePolicyParams<K extends PolicyKind>(kind: K, params: unknown): PolicyParams<K> {
	return POLICY_PARAMS[kind].parse(params) as PolicyParams<K>;
}
