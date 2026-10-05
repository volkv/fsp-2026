// The block test of an employer's request (docs/domain.md, 13.11): four clusters of one block at the grade of the
// request, each of a different family of the release, reserve classes `X` only, no practice. The verdict is
// `confirmed` when all four are scored and S₂₀ ≥ C₂₀. It is not a decision on a grade: the category never changes,
// whatever the outcome. At most one block test of a block × grade pair within the window of forms.
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Executor, Transaction } from '$lib/server/db';
import { blockConfirmations, confirmationRequests, testAttempts, testItems } from '$lib/server/db/schema';
import { completeRequest } from '$lib/server/confirmations/complete';
import { syncBlockFact } from '$lib/server/confirmations/fact';
import { ADDITIONAL_TESTS, blockTestPairs, type FamilyDescriptor } from './contract/bank';
import { GRADE_KEYS, type GradeKey, type SpecializationKey } from './contract/catalog';
import { GRADE_POLICY } from './contract/policy';
import { twentieths } from './contract/procedure';
import { chooseForSlot, isPracticeFormat } from './select';

/** The slots of a block test: `ADDITIONAL_TESTS.blockTest.clusters` clusters of the block, none of them practice. */
export function blockTestSlots(block: string): { position: number; block: string; practice: false }[] {
	return Array.from({ length: ADDITIONAL_TESTS.blockTest.clusters }, (_, i) => ({
		position: i + 1,
		block,
		practice: false as const
	}));
}

/** Whether a block test of the pair exists: a non-practice block with a quota of at least three at the grade. */
export function blockTestAllowed(specialization: SpecializationKey, block: string, grade: GradeKey): boolean {
	return blockTestPairs(specialization).some((pair) => pair.block === block && pair.grade === grade);
}

/**
 * Whether the release serves the whole block test to this candidate: four different families with an unseen reserve
 * class each. Checked before the attempt starts, so it never runs out half way.
 */
export function blockTestServable(
	families: readonly FamilyDescriptor[],
	grade: GradeKey,
	block: string,
	seen: ReadonlySet<string>,
	attemptSeed: string
): boolean {
	const used = new Set<string>();
	for (const slot of blockTestSlots(block)) {
		const choice = chooseForSlot({
			families,
			grade,
			slot,
			want: { kind: 'reserve' },
			usedFamilies: used,
			seen,
			attemptSeed,
			seq: slot.position
		});
		if (!choice) return false;
		used.add(choice.family.key);
	}
	return true;
}

/** The time of a block test: the slowest family-level of the block at the grade, per cluster, times 1.5 (domain 10.7). */
export function blockTestDurationMs(families: readonly FamilyDescriptor[], grade: GradeKey, block: string): number {
	let norm = 0;
	for (const family of families) {
		if (family.block !== block || isPracticeFormat(family.format)) continue;
		const level = family.levels.find((l) => l.grade === grade);
		if (level) norm = Math.max(norm, level.timeNormSec);
	}
	return Math.round(norm * ADDITIONAL_TESTS.blockTest.clusters * 1.5 * 1000);
}

export interface BlockVerdict {
	verdict: 'confirmed' | 'not_confirmed';
	scoreSum: number;
	cutSum: number;
}

/** The verdict over the scored clusters of a block test, sums in twentieths. */
export function blockVerdict(items: readonly { score: number; angoff: number }[]): BlockVerdict {
	if (items.length !== ADDITIONAL_TESTS.blockTest.clusters) {
		throw new Error(
			`a block test is decided over ${ADDITIONAL_TESTS.blockTest.clusters} clusters, not ${items.length}`
		);
	}
	const scoreSum = items.reduce((sum, item, i) => sum + twentieths(item.score, `score of cluster ${i + 1}`), 0);
	const cutSum = items.reduce((sum, item, i) => sum + twentieths(item.angoff, `Angoff of cluster ${i + 1}`), 0);
	return { verdict: scoreSum >= cutSum ? 'confirmed' : 'not_confirmed', scoreSum, cutSum };
}

/** Grades at or above `grade`: a result there covers a request at `grade` (domain 13.11). */
export function gradesFrom(grade: GradeKey): GradeKey[] {
	return GRADE_KEYS.slice(GRADE_KEYS.indexOf(grade));
}

/**
 * The block tests of the pair the candidate started within the window of forms, free annulments aside: a second one is
 * not served until the earliest leaves the window. Returns the start of the earliest counted one, or `null`.
 */
export async function blockTestInWindow(
	executor: Executor,
	candidateId: string,
	pair: { block: string; grade: GradeKey },
	now: Date
): Promise<Date | null> {
	const since = new Date(now.getTime() - GRADE_POLICY.formWindowDays * 86_400_000);
	const rows = await executor
		.select({ startedAt: testAttempts.startedAt, status: testAttempts.status, reason: testAttempts.annulReason })
		.from(testAttempts)
		.innerJoin(confirmationRequests, eq(confirmationRequests.id, testAttempts.confirmationRequestId))
		.where(
			and(
				eq(testAttempts.candidateId, candidateId),
				eq(testAttempts.purpose, 'vacancy_block'),
				eq(confirmationRequests.block, pair.block),
				eq(confirmationRequests.grade, pair.grade),
				gt(testAttempts.startedAt, since)
			)
		);
	const counted = rows.filter(
		(r) => !(r.status === 'annulled' && r.reason !== null && GRADE_POLICY.freeRetakeAnnulReasons.includes(r.reason))
	);
	if (counted.length === 0) return null;
	return new Date(Math.min(...counted.map((r) => r.startedAt.getTime())));
}

/**
 * Records the result of a block test whose four clusters are scored: the result row, the attempt `decided`, the request
 * of the attempt completed by it. Returns the id of the result.
 */
export async function recordBlockResult(
	tx: Transaction,
	attempt: typeof testAttempts.$inferSelect,
	context: { now: Date; requestId: string }
): Promise<string> {
	if (attempt.confirmationRequestId === null) throw new Error(`block test ${attempt.id} names no request`);
	const items = await tx
		.select({ score: testItems.score, angoff: testItems.angoff })
		.from(testItems)
		.where(eq(testItems.attemptId, attempt.id));
	const scored = items.map((item) => {
		if (item.score === null) throw new Error(`a cluster of block test ${attempt.id} is not scored`);
		return { score: item.score, angoff: item.angoff };
	});
	const verdict = blockVerdict(scored);
	const [request] = await tx
		.select({ block: confirmationRequests.block })
		.from(confirmationRequests)
		.where(eq(confirmationRequests.id, attempt.confirmationRequestId));
	if (!request) throw new Error(`request of block test ${attempt.id} is missing`);
	const [row] = await tx
		.insert(blockConfirmations)
		.values({
			candidateId: attempt.candidateId,
			attemptId: attempt.id,
			specialization: attempt.specialization as SpecializationKey,
			block: request.block,
			grade: attempt.grade as GradeKey,
			verdict: verdict.verdict,
			scoreSum: verdict.scoreSum,
			cutSum: verdict.cutSum,
			bankReleaseId: attempt.bankReleaseId,
			status: 'valid',
			visibility: 'requester',
			decidedAt: context.now
		})
		.returning({ id: blockConfirmations.id });
	if (!row) throw new Error('block confirmation was not inserted');
	await tx.update(testAttempts).set({ status: 'decided', endedAt: context.now }).where(eq(testAttempts.id, attempt.id));
	await completeRequest(tx, attempt.confirmationRequestId, row.id, {
		now: context.now,
		requestId: context.requestId,
		verdict: verdict.verdict
	});
	return row.id;
}

/** An annulled attempt takes its block result with it (domain 13.11): the result is `annulled`, so is its fact. */
export async function annulBlockResults(tx: Transaction, attemptIds: readonly string[]): Promise<void> {
	if (attemptIds.length === 0) return;
	const annulled = await tx
		.update(blockConfirmations)
		.set({ status: 'annulled' })
		.where(and(inArray(blockConfirmations.attemptId, [...attemptIds]), eq(blockConfirmations.status, 'valid')))
		.returning({ id: blockConfirmations.id });
	for (const result of annulled) await syncBlockFact(tx, result.id, { kind: 'system' });
}
