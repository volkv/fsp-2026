// Which match components carry weight in the score (docs/domain.md, section 13.4), one rule for the score and for its
// shares shown to a company and to a candidate. A computed component always does. A component that is not computed drops
// out and the rest are renormalized — except the components of the evidence itself when the candidate's evidence could
// not be read: they stay in the score at the rule set's `unavailableEvidenceValue`.

/**
 * Components that measure the evidence itself: whenever the vacancy asks for them, a candidate whose run was read has
 * them computed. Role and grade are not among them — a read candidate may have neither established.
 */
const EVIDENCE_COMPONENTS = ['required', 'nice', 'trust'] as const;

/** Reasons the candidate's evidence could not be read: no published categorization run, or one below the floor. */
const EVIDENCE_REASONS = ['no_published_run', 'run_below_evidence_floor'] as const;

export type EvidenceUnavailableReason = (typeof EVIDENCE_REASONS)[number];

const evidenceComponents: ReadonlySet<string> = new Set(EVIDENCE_COMPONENTS);
const evidenceReasons: ReadonlySet<string> = new Set(EVIDENCE_REASONS);

interface ComponentState {
	status: 'computed' | 'unknown' | 'unavailable' | 'not_comparable';
	details: { reason?: string };
}

/** An evidence component left without a value because the candidate's evidence could not be read: scored anyway. */
export function scoredWithoutValue(key: string, component: ComponentState): boolean {
	return (
		component.status === 'unavailable' &&
		evidenceComponents.has(key) &&
		evidenceReasons.has(component.details.reason ?? '')
	);
}

/** The component's weight is in the score: it is computed, or scored without a value (`scoredWithoutValue`). */
export function inScore(key: string, component: ComponentState): boolean {
	return component.status === 'computed' || scoredWithoutValue(key, component);
}
