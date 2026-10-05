// A category for a test, the way the product gives one: grade decisions of a test, brought to the category by the one
// owner of categories (`applyGradeDecisions`). The decisions are written where the engine of the test writes them — a
// decided attempt of a retired test release and its row of `grade_decisions` — without serving any item.
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { CATALOG, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { GRADE_POLICY } from '$lib/server/assessments/contract/policy';
import { PROCEDURE, type DecisionOutcome } from '$lib/server/assessments/contract/procedure';
import { GRADE_DECISIONS, type CategoryRevokeReason, type DecisionRecord } from '$lib/server/categories/decisions';
import { applyGradeDecisions, type AppliedCategory, type Journal } from '$lib/server/categories/publish';
import type { Database, Transaction } from '$lib/server/db';
import { bankReleases, gradeDecisions, testAttempts } from '$lib/server/db/schema';

/** The release the decisions of the helper name: retired, so it opens no specialization. */
const TEST_RELEASE = 'test-release';

const journal: Journal = { requestId: 'test', actor: { kind: 'system' } };

export interface TestDecisionInput {
	specialization: SpecializationKey;
	grade: GradeKey;
	outcome?: DecisionOutcome;
	confident?: boolean;
	/** The attempt started on the right of a confident result. */
	viaConfidentUpgrade?: boolean;
	decidedAt?: Date;
	/** The blocks of the decision as the engine records them (`BlockSummary`); none by default. */
	blocks?: { block: string; items: number; score: number; cut: number }[];
}

/**
 * A decision of the test, confirmed unless said otherwise. It is written without served clusters, so no practice program
 * stands behind it and no practice language is confirmed (`decisionRecords` reads it so).
 */
function testDecision(input: TestDecisionInput): DecisionRecord {
	const outcome = input.outcome ?? 'confirmed';
	return {
		id: randomUUID(),
		specialization: input.specialization,
		grade: input.grade,
		outcome,
		confident: input.confident ?? false,
		viaConfidentUpgrade: input.viaConfidentUpgrade ?? false,
		decidedAt: input.decidedAt ?? new Date(),
		valid: true,
		bankReleaseId: TEST_RELEASE,
		catalogVersion: CATALOG.version,
		practiceLanguage: null,
		invalidReason: null
	};
}

async function ensureRelease(tx: Transaction): Promise<void> {
	const zero = '0'.repeat(64);
	await tx
		.insert(bankReleases)
		.values({
			id: TEST_RELEASE,
			specialization: 'backend',
			catalogVersion: CATALOG.version,
			procedureVersion: PROCEDURE.version,
			contentSha256: zero,
			sharedSha256: zero,
			manifest: { families: [] },
			status: 'retired',
			releasedAt: new Date(0),
			retiredAt: new Date(0)
		})
		.onConflictDoNothing();
}

/** Records a decision where the engine records one, without bringing the category to it. */
export async function recordDecisionIn(
	tx: Transaction,
	candidateId: string,
	input: TestDecisionInput
): Promise<DecisionRecord> {
	const decision = testDecision(input);
	await ensureRelease(tx);
	const [attempt] = await tx
		.insert(testAttempts)
		.values({
			candidateId,
			purpose: 'grade',
			specialization: decision.specialization,
			grade: decision.grade,
			catalogVersion: CATALOG.version,
			bankReleaseId: TEST_RELEASE,
			procedureVersion: PROCEDURE.version,
			policyVersion: GRADE_POLICY.version,
			form: 'A',
			viaConfidentUpgrade: decision.viaConfidentUpgrade,
			seed: randomBytes(16).toString('hex'),
			status: 'decided',
			startedAt: decision.decidedAt,
			deadlineAt: decision.decidedAt,
			endedAt: decision.decidedAt
		})
		.returning({ id: testAttempts.id });
	if (!attempt) throw new Error('attempt not inserted');
	await tx.insert(gradeDecisions).values({
		id: decision.id,
		attemptId: attempt.id,
		candidateId,
		specialization: decision.specialization,
		grade: decision.grade,
		outcome: decision.outcome,
		reason: decision.outcome === 'confirmed' ? 'sprt_upper' : 'sprt_lower',
		confident: decision.confident,
		llr: decision.outcome === 'confirmed' ? 2_200_000 : -2_200_000,
		scoreSum: decision.outcome === 'confirmed' ? 140 : 20,
		cutSum: 84,
		items: 7,
		extensionUsed: false,
		practice: { score: 1, gateMinScore: 0.4, passed: true },
		blocks: input.blocks ?? [],
		procedureVersion: PROCEDURE.version,
		bankReleaseId: TEST_RELEASE,
		status: 'valid',
		decidedAt: decision.decidedAt
	});
	return decision;
}

/** Records a decision in its own transaction, without bringing the category to it. */
export function recordDecision(db: Database, candidateId: string, input: TestDecisionInput): Promise<DecisionRecord> {
	return db.transaction((tx) => recordDecisionIn(tx, candidateId, input));
}

/** Records a decision and applies it inside the given transaction, as the engine does in the one of the decision. */
export async function decideIn(
	tx: Transaction,
	candidateId: string,
	input: TestDecisionInput
): Promise<{ decision: DecisionRecord; applied: AppliedCategory }> {
	const decision = await recordDecisionIn(tx, candidateId, input);
	const applied = await applyGradeDecisions(tx, candidateId, input.specialization, journal, GRADE_DECISIONS);
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

/**
 * A decision stops counting — annulled (its attempt annulled: `objection_upheld` for an objection, `plagiarism`
 * otherwise), or replaced by a review — without bringing the category to the rest.
 */
export async function invalidateIn(
	tx: Transaction,
	decisionId: string,
	reason: CategoryRevokeReason
): Promise<SpecializationKey> {
	const [decision] = await tx
		.update(gradeDecisions)
		.set({ status: reason === 'objection_rescored' ? 'superseded' : 'annulled' })
		.where(eq(gradeDecisions.id, decisionId))
		.returning();
	if (!decision) throw new Error(`decision ${decisionId} is not recorded`);
	if (reason !== 'objection_rescored') {
		await tx
			.update(testAttempts)
			.set({
				status: 'annulled',
				annulledAt: new Date(),
				annulReason: reason === 'objection_annulled' ? 'objection_upheld' : 'plagiarism'
			})
			.where(eq(testAttempts.id, decision.attemptId));
	}
	return decision.specialization as SpecializationKey;
}

/** A decision stops counting and the category is brought to the rest. */
export function invalidate(
	db: Database,
	candidateId: string,
	decisionId: string,
	reason: CategoryRevokeReason
): Promise<AppliedCategory> {
	return db.transaction(async (tx) => {
		const specialization = await invalidateIn(tx, decisionId, reason);
		return applyGradeDecisions(tx, candidateId, specialization, journal, GRADE_DECISIONS);
	});
}
