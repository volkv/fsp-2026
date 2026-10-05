// What the grade policy reads from the modules that own it (docs/domain.md, sections 10.5, 10.7, 12.4, 23.1): the
// specializations with a released bank and the attempts of the test engine, the active categories of the category
// owner. The grade module never reads those tables itself: it receives these readers, and the services and pages of
// the candidate pass the instance below.
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type { PolicyAttempt, PolicyCategory } from '$lib/server/assessments/contract/policy';
import { activeCategories } from '$lib/server/categories/read';
import type { Executor } from '$lib/server/db';

/** An attempt of the candidate as the policy sees it, with the specialization it was taken in. */
export interface SourceAttempt extends PolicyAttempt {
	specialization: SpecializationKey;
}

/** An active category of the candidate (`activeCategories`, domain 12.4) in the fields the policy and the screen read. */
export interface SourceCategory extends PolicyCategory {
	specialization: SpecializationKey;
	grade: GradeKey;
	/** Blocks passed by the decision that assigned the category. */
	confirmedBlocks: readonly string[];
}

export interface GradeSources {
	/** Specializations with a bank release in status `released` (domain 10.5). */
	releasedSpecializations(executor: Executor): Promise<ReadonlySet<SpecializationKey>>;
	/** Active categories of the candidate, one per specialization at most. */
	activeCategories(executor: Executor, candidateId: string): Promise<SourceCategory[]>;
	/**
	 * Attempts of the candidate that the policy counts: every attempt of purpose `grade`, and an attempt of any purpose
	 * while it is in progress (one attempt in progress per candidate, domain 10.7).
	 */
	policyAttempts(executor: Executor, candidateId: string): Promise<SourceAttempt[]>;
}

/**
 * The readers of this build. The categories come from their owner (`categories/read.ts`). The bank releases and the
 * attempts are written only by the test engine; until its tables are part of the schema there is no released bank and
 * no attempt to read, and the readers say exactly that.
 */
export const gradeSources: GradeSources = {
	releasedSpecializations: () => Promise.resolve(new Set()),
	activeCategories: async (executor, candidateId) =>
		(await activeCategories(executor, [candidateId])).get(candidateId) ?? [],
	policyAttempts: () => Promise.resolve([])
};
