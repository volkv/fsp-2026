// What the grade policy reads from the modules that own it (docs/domain.md, sections 10.5, 10.7, 12.4, 23.1): the
// specializations with a released bank and the attempts of the test engine, the active categories of the category
// owner, whether the candidate belongs to a demo session. The grade module never reads those tables itself: it receives these readers, and the services and pages of
// the candidate pass the instance below.
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type { PolicyAttempt, PolicyCategory } from '$lib/server/assessments/contract/policy';
import { attemptRecords } from '$lib/server/assessments/attempt-records';
import { releasedSpecializations } from '$lib/server/assessments/bank-store';
import { activeCategories } from '$lib/server/categories/read';
import type { Executor } from '$lib/server/db';
import { candidateInDemoSession } from '$lib/server/demo/grade-policy';

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
	/** Whether the candidate belongs to a demo session: there the order and the intervals of the policy close nothing. */
	inDemoSession(executor: Executor, candidateId: string): Promise<boolean>;
}

/**
 * The readers of this build: the categories from their owner (`categories/read.ts`), the released banks and the
 * attempts from the test engine (`assessments/bank-store.ts`, `assessments/attempt-records.ts`).
 */
export const gradeSources: GradeSources = {
	releasedSpecializations,
	activeCategories: async (executor, candidateId) =>
		(await activeCategories(executor, [candidateId])).get(candidateId) ?? [],
	policyAttempts: attemptRecords,
	inDemoSession: candidateInDemoSession
};
