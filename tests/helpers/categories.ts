// A category for a test, the way the product gives one: grade decisions of a test, brought to the category by the one
// owner of categories (`applyGradeDecisions`). The decisions are kept in memory here, as the engine of the test would
// record them in `grade_decisions`.
import { randomUUID } from 'node:crypto';
import { CATALOG, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type { DecisionOutcome } from '$lib/server/assessments/contract/procedure';
import { MemoryDecisions, type CategoryRevokeReason, type DecisionRecord } from '$lib/server/categories/decisions';
import { applyGradeDecisions, type AppliedCategory, type Journal } from '$lib/server/categories/publish';
import type { Database, Transaction } from '$lib/server/db';

/** The decisions of every test run in this process. */
export const testDecisions = new MemoryDecisions();

const journal: Journal = { requestId: 'test', actor: { kind: 'system' } };

export interface TestDecisionInput {
	specialization: SpecializationKey;
	grade: GradeKey;
	outcome?: DecisionOutcome;
	confident?: boolean;
	/** The attempt started on the right of a confident result. */
	viaConfidentUpgrade?: boolean;
	decidedAt?: Date;
}

/** A decision of the test, confirmed unless said otherwise, with the first practice language of the specialization. */
export function testDecision(input: TestDecisionInput): DecisionRecord {
	const outcome = input.outcome ?? 'confirmed';
	const language = CATALOG.specializations.find((s) => s.key === input.specialization)?.practiceLanguages[0];
	if (!language) throw new Error(`specialization ${input.specialization} has no practice language`);
	return {
		id: randomUUID(),
		specialization: input.specialization,
		grade: input.grade,
		outcome,
		confident: input.confident ?? false,
		viaConfidentUpgrade: input.viaConfidentUpgrade ?? false,
		decidedAt: input.decidedAt ?? new Date(),
		valid: true,
		bankReleaseId: 'test-release',
		catalogVersion: CATALOG.version,
		practiceLanguage: outcome === 'confirmed' ? language : null,
		invalidReason: null
	};
}

/** Records a decision and applies it inside the given transaction, as the engine does in the one of the decision. */
export async function decideIn(
	tx: Transaction,
	candidateId: string,
	input: TestDecisionInput
): Promise<{ decision: DecisionRecord; applied: AppliedCategory }> {
	const decision = testDecision(input);
	testDecisions.record(candidateId, decision);
	const applied = await applyGradeDecisions(tx, candidateId, input.specialization, journal, testDecisions);
	return { decision, applied };
}

/** Records a decision and applies it in its own transaction. */
export function decide(
	db: Database,
	candidateId: string,
	input: TestDecisionInput
): Promise<{ decision: DecisionRecord; applied: AppliedCategory }> {
	return db.transaction((tx) => decideIn(tx, candidateId, input));
}

/** A decision stops counting — annulled, or replaced by a review — and the category is brought to the rest. */
export function invalidate(
	db: Database,
	candidateId: string,
	decisionId: string,
	reason: CategoryRevokeReason
): Promise<AppliedCategory> {
	const decision = testDecisions.invalidate(candidateId, decisionId, reason);
	return db.transaction((tx) => applyGradeDecisions(tx, candidateId, decision.specialization, journal, testDecisions));
}
