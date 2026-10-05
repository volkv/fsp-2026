// The freshness of a confirmed profile (docs/domain.md, 13.10, 13.12): the moment of the last confirmed action of the
// candidate besides a grade decision — a valid result of a block test or a submitted solution of a call. Opening or
// receiving a call refreshes nothing. The ranking takes the latest of these and of the assignment of the categories.
import { and, eq, inArray, max } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { blockConfirmations, challengeDeliveries, challengeSolutions } from '$lib/server/db/schema';

/** The latest confirmed action of each candidate asked for; a candidate without one is absent. */
export async function lastConfirmedActions(
	executor: Executor,
	candidateIds: readonly string[]
): Promise<Map<string, Date>> {
	const result = new Map<string, Date>();
	const ids = [...new Set(candidateIds)];
	if (ids.length === 0) return result;
	const take = (candidateId: string, at: Date | null) => {
		if (at === null) return;
		const known = result.get(candidateId);
		if (known === undefined || at > known) result.set(candidateId, at);
	};
	const blocks = await executor
		.select({ candidateId: blockConfirmations.candidateId, at: max(blockConfirmations.decidedAt) })
		.from(blockConfirmations)
		.where(and(inArray(blockConfirmations.candidateId, ids), eq(blockConfirmations.status, 'valid')))
		.groupBy(blockConfirmations.candidateId);
	for (const row of blocks) take(row.candidateId, row.at);
	const solutions = await executor
		.select({ candidateId: challengeDeliveries.candidateId, at: max(challengeSolutions.submittedAt) })
		.from(challengeSolutions)
		.innerJoin(challengeDeliveries, eq(challengeDeliveries.id, challengeSolutions.deliveryId))
		.where(and(inArray(challengeDeliveries.candidateId, ids), eq(challengeSolutions.status, 'submitted')))
		.groupBy(challengeDeliveries.candidateId);
	for (const row of solutions) take(row.candidateId, row.at);
	return result;
}
