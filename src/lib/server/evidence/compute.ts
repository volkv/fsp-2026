// The evidence calculation (docs/domain.md 9.3, 9.5, 12.6): a pure, deterministic function of a profile snapshot, a
// taxonomy version, a rule set and `as_of`. It infers skills from the contributions of facts and claims, the FSP level
// by discipline and the length of experience. It assigns no category: a category comes only from a test (domain 12.4).
import { buildInferences, collectEvidence, propagateToParents } from './inferences';
import { summarizeExperience } from './experience';
import { fspLevels } from './fsp-level';
import type { ClaimInput, EvidenceResult, EvidenceSnapshot, RulesContext } from './types';

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Computes the evidence of one profile snapshot. Deterministic: the same snapshot, taxonomy version, rule set and
 * `as_of` give the same result; it calls no model and reads no clock.
 */
export function computeEvidence(snapshot: EvidenceSnapshot, rules: RulesContext, asOf: Date): EvidenceResult {
	const evidence = collectEvidence(snapshot, rules, asOf);
	const claimsByFact = new Map<string, ClaimInput[]>();
	for (const claim of snapshot.claims)
		claimsByFact.set(claim.factId, [...(claimsByFact.get(claim.factId) ?? []), claim]);
	return {
		experienceSummary: summarizeExperience(snapshot.experience, asOf),
		inferences: buildInferences(propagateToParents(evidence.skills, rules), rules),
		fspLevels: fspLevels(snapshot.facts, claimsByFact, rules),
		unused: [...evidence.unused].sort(
			(a, b) => byKey(a.fact_id, b.fact_id) || byKey(a.claim_id ?? '', b.claim_id ?? '') || byKey(a.code, b.code)
		)
	};
}
