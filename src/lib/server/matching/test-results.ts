// The result of a test by blocks, as the ranking of a shortlist reads it (docs/domain.md, sections 10.6, 13.10): for the
// grade decision a category in force stands on, the sums of every block in twentieths of a point. The decisions are
// the engine's (`grade_decisions.blocks`, read only here and only these columns); the ranking reads them through this
// port, so that the evaluation and the tests can give results they hold in memory.
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '$lib/server/db';
import { gradeDecisions } from '$lib/server/db/schema';

/** One block of a decision: items served and the sums of scores and cuts in twentieths (`BlockSummary`, 10.6). */
export interface TestBlockResult {
	block: string;
	items: number;
	score: number;
	cut: number;
}

/** Blocks of the decisions asked for; a decision absent from the map has no readable result. */
export type TestResults = Map<string, readonly TestBlockResult[]>;

export interface TestResultReader {
	resultsOf(executor: Executor, decisionIds: readonly string[]): Promise<TestResults>;
}

const blockSchema = z.looseObject({
	block: z.string().min(1),
	items: z.int().min(1),
	score: z.int().nonnegative(),
	cut: z.int().nonnegative()
});

/**
 * The reader of the engine's decisions: the blocks a decision recorded (`grade_decisions.blocks`, `BlockSummary` of the
 * procedure). A decision whose blocks are malformed is a data error and names the decision.
 */
export const GRADE_DECISION_RESULTS: TestResultReader = {
	async resultsOf(executor, decisionIds) {
		const results: TestResults = new Map();
		const ids = [...new Set(decisionIds)];
		if (ids.length === 0) return results;
		const rows = await executor
			.select({ id: gradeDecisions.id, blocks: gradeDecisions.blocks })
			.from(gradeDecisions)
			.where(inArray(gradeDecisions.id, ids));
		for (const row of rows) {
			const parsed = z.array(blockSchema).safeParse(row.blocks);
			if (!parsed.success) throw new Error(`blocks of decision ${row.id} are malformed: ${parsed.error.message}`);
			results.set(
				row.id,
				parsed.data.map(({ block, items, score, cut }) => ({ block, items, score, cut }))
			);
		}
		return results;
	}
};
