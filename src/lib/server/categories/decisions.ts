// Grade decisions as the category owner reads them (docs/domain.md 12.3, 12.4). The decisions are written by the engine
// of the test into `grade_decisions`; the category of a specialization is whatever `resolveCategory` gives over all of
// them, so the owner reads them all at once through `GradeDecisionReader`; the engine reads its table for it
// (`decisionRecords`).
import type { PracticeLanguageKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { decisionRecords } from '$lib/server/assessments/decision-records';
import type { CategoryDecision } from '$lib/server/assessments/contract/policy';
import type { Executor } from '$lib/server/db';
import type { CATEGORY_REVOKE_REASONS } from '$lib/server/db/schema';

export type CategoryRevokeReason = (typeof CATEGORY_REVOKE_REASONS)[number];

/** One decision of a specialization: what the policy needs, and what a category standing on it records. */
export interface DecisionRecord extends CategoryDecision {
	specialization: SpecializationKey;
	bankReleaseId: string;
	catalogVersion: string;
	/**
	 * The language the candidate wrote the practice program in (`confirmedStack`); `null` — not confirmed, or a practice
	 * the candidate wrote no program for (QA test cases).
	 */
	practiceLanguage: PracticeLanguageKey | null;
	/** Why the decision stopped counting (`valid = false`): the reason a category standing on it is revoked. */
	invalidReason: CategoryRevokeReason | null;
}

export interface GradeDecisionReader {
	/** All decisions of the candidate in the specialization, valid or not. */
	decisionsOf(executor: Executor, candidateId: string, specialization: SpecializationKey): Promise<DecisionRecord[]>;
}

/** The reader of `grade_decisions`. */
export const GRADE_DECISIONS: GradeDecisionReader = { decisionsOf: decisionRecords };

/**
 * Decisions kept in memory, for a run that has no engine of the test behind it: the quality evaluation gives each
 * candidate the decision of its labelled test result and applies it through the same owner of categories.
 */
export class MemoryDecisions implements GradeDecisionReader {
	readonly #byCandidate = new Map<string, DecisionRecord[]>();

	record(candidateId: string, decision: DecisionRecord): void {
		const list = this.#byCandidate.get(candidateId) ?? [];
		if (list.some((known) => known.id === decision.id)) throw new Error(`decision ${decision.id} is recorded twice`);
		list.push(decision);
		this.#byCandidate.set(candidateId, list);
	}

	/** Marks a recorded decision as no longer counting, for the given reason. */
	invalidate(candidateId: string, decisionId: string, reason: CategoryRevokeReason): DecisionRecord {
		const decision = this.#byCandidate.get(candidateId)?.find((known) => known.id === decisionId);
		if (!decision) throw new Error(`decision ${decisionId} of candidate ${candidateId} is not recorded`);
		decision.valid = false;
		decision.invalidReason = reason;
		return decision;
	}

	decisionsOf(_executor: Executor, candidateId: string, specialization: SpecializationKey): Promise<DecisionRecord[]> {
		const list = this.#byCandidate.get(candidateId) ?? [];
		return Promise.resolve(list.filter((d) => d.specialization === specialization).map((d) => ({ ...d })));
	}
}
