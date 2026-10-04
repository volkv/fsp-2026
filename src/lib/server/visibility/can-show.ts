// `canShow(candidate, viewer, context)` — the only decision whether a viewer sees a candidate and in which
// projection (docs/domain.md, section 7.4). A pure function over facts the caller has read at `now`.
import type { CatalogScopeField } from '$lib/server/consent/kinds';
import { inDemoScope } from '$lib/server/demo/scope';
import { ageBand, isMinorBand, type AgeBand, type BirthDateInfo } from './age';

/** `demoSessionId` — the demo session of the viewer's account (domain 19.3); `null` — outside every session. */
export type Viewer =
	| { kind: 'anonymous' }
	| { kind: 'user'; userId: string }
	| {
			kind: 'member';
			userId: string;
			memberId: string;
			companyId: string;
			via: 'session' | 'api_key';
			demoSessionId: string | null;
	  }
	| { kind: 'staff'; userId: string; role: 'operator' | 'admin'; demoSessionId: string | null };

export type CaseType = 'dispute' | 'moderation' | 'authority' | 'assessment';

export type ViewContext =
	| { kind: 'self' }
	| { kind: 'catalog'; vacancyId?: string }
	| { kind: 'invitation'; invitationId: string }
	| { kind: 'partner_pool'; partnershipId: string }
	| { kind: 'public' }
	| { kind: 'case'; caseType: CaseType; caseId: string };

export type Projection = 'self' | 'catalog' | 'recipient' | 'public' | 'operator';
export type ShowExtra = CatalogScopeField | 'partner_competition_result';

export type DenyReason =
	| 'candidate_inactive'
	| 'no_processing_consent'
	| 'age_unknown'
	| 'age_ineligible'
	| 'not_member'
	| 'company_not_verified'
	| 'blocked_by_candidate'
	| 'no_catalog_consent'
	| 'hidden_by_candidate'
	| 'minor_requires_vacancy'
	| 'vacancy_not_eligible'
	| 'representative_not_verified'
	| 'no_disclosure_consent'
	| 'not_partner'
	| 'not_in_pool'
	| 'no_case_access'
	| 'not_visible';

export type ShowDecision =
	| { allowed: true; projection: Projection; extras: ShowExtra[]; policyVersion: string }
	| { allowed: false; reason: DenyReason };

/** Current state read by the caller; each part is present when the context needs it. */
export interface VisibilityFacts {
	now: Date;
	/** Versions of the product policies applied, recorded with the decision. */
	policyVersion: string;
	/** `minor_policy.enabled`: when false, ages 14–17 are treated as ineligible (domain 7.3). */
	minorsEnabled: boolean;
	/** `legal_documents.available` of `public_distribution`. */
	publicDistributionAvailable: boolean;
	candidate: {
		id: string;
		userId: string;
		status: 'onboarding' | 'active' | 'ineligible_age' | 'deletion_pending' | 'deleted';
		birth: BirthDateInfo;
		visibility: 'hidden' | 'catalog';
		searchStatus: 'active' | 'open_to_offers' | 'not_looking';
		blockedCompanyIds: readonly string[];
		/** The demo session the profile belongs to (domain 19.3); `null` — outside every session. */
		demoSessionId: string | null;
		/** A hero of the demo scenario whose clones the sessions hold: not shown inside a session (domain 19.3). */
		demoOriginal: boolean;
	};
	/** `effectiveConsent` at `now` of each kind (domain 6.3); `null` — no effective consent. */
	consents: {
		pdProcessing: boolean;
		catalogVisibility: { scopeFields: readonly CatalogScopeField[] } | null;
		publicDistribution: boolean;
	};
	/** A representative in `authority_verified` at `now`. */
	representativeVerified: boolean;
	/** Company of a member viewer. */
	viewerCompany?: {
		membershipActive: boolean;
		companyVerified: boolean;
		/** The actor holds `candidate.card.read` (a session member or an API key with that permission). */
		hasCardReadPermission: boolean;
		minorTermsAccepted: boolean;
	};
	/** The vacancy of a catalog or invitation context. */
	vacancy?: { id: string; companyId: string | null; origin: 'own' | 'external'; status: string; minAge: number | null };
	invitation?: {
		id: string;
		companyId: string;
		candidateId: string;
		vacancyId: string;
		status: 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
		/** `effectiveConsent(contact_disclosure)` scoped to this invitation. */
		disclosureConsentActive: boolean;
	};
	partnership?: {
		id: string;
		companyId: string;
		active: boolean;
		/** Result of this competition satisfying `pool_rule`, `partner_pool` consent listing this company (domain 5.5). */
		candidateInPool: boolean;
	};
	/** Staff right for the case type and the case concerns this candidate. */
	caseAccess?: boolean;
}

const deny = (reason: DenyReason): ShowDecision => ({ allowed: false, reason });

function allow(facts: VisibilityFacts, projection: Projection, extras: ShowExtra[] = []): ShowDecision {
	return { allowed: true, projection, extras, policyVersion: facts.policyVersion };
}

/** Age band with the minor policy applied: without minors, 14–17 fall into the ineligible regime. */
function effectiveBand(facts: VisibilityFacts): AgeBand {
	const value = ageBand(facts.candidate.birth, facts.now);
	return isMinorBand(value) && !facts.minorsEnabled ? 'under_14' : value;
}

function catalogDecision(
	facts: VisibilityFacts,
	viewer: Extract<Viewer, { kind: 'member' }>,
	vacancyId: string | undefined,
	band: AgeBand
): ShowDecision {
	const { candidate, consents } = facts;
	if (candidate.visibility !== 'catalog' || candidate.searchStatus === 'not_looking')
		return deny('hidden_by_candidate');
	if (!consents.catalogVisibility) return deny('no_catalog_consent');
	if (isMinorBand(band)) {
		if (vacancyId === undefined) return deny('minor_requires_vacancy');
		const vacancy = facts.vacancy;
		if (
			vacancy?.id !== vacancyId ||
			vacancy.origin !== 'own' ||
			vacancy.companyId !== viewer.companyId ||
			vacancy.status !== 'published' ||
			vacancy.minAge === null ||
			vacancy.minAge > band ||
			facts.viewerCompany?.minorTermsAccepted !== true
		) {
			return deny('vacancy_not_eligible');
		}
		if (!facts.representativeVerified) return deny('representative_not_verified');
		// Minors never get extras: `scope_fields` is refused for them (domain 6.3).
		return allow(facts, 'catalog');
	}
	return allow(facts, 'catalog', [...consents.catalogVisibility.scopeFields]);
}

export function canShow(facts: VisibilityFacts, viewer: Viewer, context: ViewContext): ShowDecision {
	const { candidate } = facts;

	// 1. The candidate sees themself in any state.
	if (context.kind === 'self') {
		return viewer.kind === 'user' && viewer.userId === candidate.userId ? allow(facts, 'self') : deny('not_visible');
	}
	// Demo sessions (domain 19.3): a profile of a session is seen from inside that session only, and a viewer inside a
	// session sees profiles of that session and outside sessions, the originals of the scenario heroes excepted.
	// Anonymous visitors are outside every session.
	const viewerSession = viewer.kind === 'member' || viewer.kind === 'staff' ? viewer.demoSessionId : null;
	if (!inDemoScope(candidate, viewerSession)) return deny('not_visible');
	// 2. Staff sees a candidate only within a case concerning them.
	if (context.kind === 'case') {
		return viewer.kind === 'staff' && facts.caseAccess === true ? allow(facts, 'operator') : deny('no_case_access');
	}
	// 3–5. Profile state, processing consent and age.
	if (candidate.status !== 'active') return deny('candidate_inactive');
	if (!facts.consents.pdProcessing) return deny('no_processing_consent');
	const band = effectiveBand(facts);
	if (band === 'unknown') return deny('age_unknown');
	if (band === 'under_14') return deny('age_ineligible');

	// 6. Public page.
	if (context.kind === 'public') {
		return band === 'adult' && facts.publicDistributionAvailable && facts.consents.publicDistribution
			? allow(facts, 'public')
			: deny('not_visible');
	}

	// 7. Every other context is a member of a verified company not blocked by the candidate.
	if (viewer.kind !== 'member') return deny('not_member');
	const company = facts.viewerCompany;
	if (!company?.membershipActive || !company.hasCardReadPermission) return deny('not_member');
	if (!company.companyVerified) return deny('company_not_verified');
	if (candidate.blockedCompanyIds.includes(viewer.companyId)) return deny('blocked_by_candidate');

	switch (context.kind) {
		// 8. Within an invitation: the recipient projection after acceptance with a disclosure consent;
		// otherwise the catalog rules in the context of the invitation vacancy.
		case 'invitation': {
			const invitation = facts.invitation;
			if (
				invitation?.id !== context.invitationId ||
				invitation.companyId !== viewer.companyId ||
				invitation.candidateId !== candidate.id
			) {
				return deny('not_visible');
			}
			if (invitation.status === 'accepted' && invitation.disclosureConsentActive) return allow(facts, 'recipient');
			return catalogDecision(facts, viewer, invitation.vacancyId, band);
		}
		// 9. Catalog.
		case 'catalog':
			return catalogDecision(facts, viewer, context.vacancyId, band);
		// 10. Pool of a competition partner: an independent basis, the visibility setting does not apply.
		case 'partner_pool': {
			const partnership = facts.partnership;
			if (
				partnership?.id !== context.partnershipId ||
				partnership.companyId !== viewer.companyId ||
				!partnership.active
			) {
				return deny('not_partner');
			}
			if (band !== 'adult' || !partnership.candidateInPool) return deny('not_in_pool');
			return allow(facts, 'catalog', [
				...(facts.consents.catalogVisibility?.scopeFields ?? []),
				'partner_competition_result'
			]);
		}
	}
}

/**
 * Whether any verified company could find the candidate in the catalog: rule 9 without company conditions,
 * adults only. Used for anonymous counters such as the pool size of an external vacancy (domain 7.4, 13.3). Which
 * demo sessions a counter spans is the caller's choice (`demo/scope.ts`).
 */
export function catalogVisibleToAnyVerifiedCompany(
	facts: Pick<VisibilityFacts, 'now' | 'candidate' | 'consents'>
): boolean {
	const { candidate, consents } = facts;
	return (
		candidate.status === 'active' &&
		consents.pdProcessing &&
		consents.catalogVisibility !== null &&
		candidate.visibility === 'catalog' &&
		candidate.searchStatus !== 'not_looking' &&
		ageBand(candidate.birth, facts.now) === 'adult'
	);
}
