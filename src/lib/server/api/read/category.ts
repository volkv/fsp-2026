// The candidate's own category (docs/domain.md, sections 12.1–12.4): the published run with every axis, its full
// explanation and what is missing, used only while its evidence is still in force (`input_revision ≥
// evidence_floor_revision`), and the objection open against it.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { publishedRun, runInForce } from '$lib/server/db/conditions';
import {
	candidates,
	categorizationRuns,
	categoryAssignments,
	categoryDisputes,
	fspLevelAssignments
} from '$lib/server/db/schema';

export async function ownCategory(executor: Executor, candidateId: string) {
	const [candidate] = await executor
		.select({ id: candidates.id })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!candidate) throw new Error(`candidate ${candidateId} of the subject does not exist`);
	const [published] = await executor
		.select({ run: categorizationRuns, inForce: runInForce(categorizationRuns, candidates) })
		.from(categorizationRuns)
		.innerJoin(candidates, eq(candidates.id, categorizationRuns.candidateId))
		.where(and(eq(categorizationRuns.candidateId, candidateId), publishedRun(categorizationRuns)));
	const [dispute] = await executor
		.select({
			id: categoryDisputes.id,
			runId: categoryDisputes.runId,
			status: categoryDisputes.status,
			openedAt: categoryDisputes.openedAt,
			dueAt: categoryDisputes.dueAt
		})
		.from(categoryDisputes)
		.where(and(eq(categoryDisputes.candidateId, candidateId), inArray(categoryDisputes.status, ['open', 'in_review'])))
		.orderBy(desc(categoryDisputes.openedAt))
		.limit(1);
	if (!published) return { state: 'none' as const, run: null, assignments: [], levels: [], dispute: dispute ?? null };
	if (!published.inForce) {
		// Evidence behind the run was withdrawn: nothing of it is shown until the recalculation.
		return { state: 'recalculating' as const, run: null, assignments: [], levels: [], dispute: dispute ?? null };
	}
	const { run } = published;
	const assignments = await executor.select().from(categoryAssignments).where(eq(categoryAssignments.runId, run.id));
	const levels = await executor
		.select({
			discipline: fspLevelAssignments.discipline,
			level: fspLevelAssignments.level,
			lastResultOn: fspLevelAssignments.lastResultOn
		})
		.from(fspLevelAssignments)
		.where(eq(fspLevelAssignments.runId, run.id));
	return {
		state: 'available' as const,
		run,
		assignments: assignments.sort((a, b) => (a.rank === b.rank ? 0 : a.rank === 'primary' ? -1 : 1)),
		levels,
		dispute: dispute ?? null
	};
}
