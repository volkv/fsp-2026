// «С ФСП» (docs/domain.md, sections 12.7, 13.9, 13.10): a candidate has an FSP result when they hold an official
// competition result in force — the facts the FSP record of the ranking counts. A preliminary or annulled result is
// not a result yet, a qualification of ЕВСК is not a competition result, and a team's result is not the own result of
// a reserve or a trainer, who did not compete. The filter «только с ФСП» of the catalog and of a shortlist, the label
// of a candidate, the count of a category and the funnel's «участник ФСП» all read this one definition.
import { inArray, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { candidates } from '$lib/server/db/schema';
import { NOT_COMPETING } from '$lib/server/evidence/fsp-level';

/**
 * SQL condition over a row of `source_facts` named `fact` in the caller's query: an official FSP competition result in
 * force that is the candidate's own.
 */
export function officialFspResult(fact: SQL): SQL<boolean> {
	return sql<boolean>`(${fact}.source = 'fsp' and ${fact}.fact_type = 'competition_result'
		and ${fact}.status = 'active' and ${fact}.payload->'result'->>'status' = 'official'
		and coalesce(${fact}.payload->'result'->'team'->>'role', '') not in (${sql.join(
			[...NOT_COMPETING].map((role) => sql`${role}`),
			sql`, `
		)}))`;
}

/** SQL condition «the candidate has an FSP result» over the candidate id of the caller's query. */
export function hasFspResult(candidateId: SQL): SQL<boolean> {
	return sql<boolean>`exists (select 1 from source_facts fsp_result
		where fsp_result.candidate_id = ${candidateId} and ${officialFspResult(sql`fsp_result`)})`;
}

/** Of the candidate ids, those with an FSP result. */
export async function candidatesWithFsp(executor: Executor, candidateIds: readonly string[]): Promise<Set<string>> {
	if (candidateIds.length === 0) return new Set();
	const rows = await executor
		.select({ id: candidates.id })
		.from(candidates)
		.where(sql`${inArray(candidates.id, [...new Set(candidateIds)])} and ${hasFspResult(sql`${candidates.id}`)}`);
	return new Set(rows.map((row) => row.id));
}
