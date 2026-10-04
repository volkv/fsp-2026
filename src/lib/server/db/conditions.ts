// Conditions of two invariants read by many queries, each written once. Every function takes the columns of the rows
// it speaks of — the Drizzle tables, or the columns of a raw query's alias (`runAt('r')`, `candidateAt('c')`) — so the
// same text serves the query builder and raw SQL.
//
// The run in force (docs/domain.md, 12.1, 17.3): the published categorization run while its input is at or above the
// candidate's `evidence_floor_revision`. A withdrawal raises the floor in its own transaction, so from that moment the
// run shows nothing even before it is blocked. `publishedRun` alone is the state of the run — which run a
// recalculation supersedes, a withdrawal blocks, the reconciliation counts as processed; what a card, the catalog,
// a match or an aggregate shows is `runInForce`.
//
// Listed in the catalog (domain 7.4): an active profile the candidate put in the catalog and that is not «not
// looking». It is the part of `canShow` SQL can decide before the pure function decides the rest; `canShow` holds the
// same condition for one candidate.
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

type Column = AnyColumn | SQL;

export interface RunColumns {
	status: Column;
	inputRevision: Column;
}

export interface CandidateColumns {
	status: Column;
	visibility: Column;
	searchStatus: Column;
	evidenceFloorRevision: Column;
}

const at = (alias: string, column: string): SQL => sql`${sql.identifier(alias)}.${sql.identifier(column)}`;

/** The columns of `categorization_runs` under the alias of a raw query. */
export function runAt(alias: string): RunColumns {
	return { status: at(alias, 'status'), inputRevision: at(alias, 'input_revision') };
}

/** The columns of `candidates` under the alias of a raw query. */
export function candidateAt(alias: string): CandidateColumns {
	return {
		status: at(alias, 'status'),
		visibility: at(alias, 'visibility'),
		searchStatus: at(alias, 'search_status'),
		evidenceFloorRevision: at(alias, 'evidence_floor_revision')
	};
}

/** The run is the published one of its candidate: at most one is (`categorization_runs_published`). */
export function publishedRun(run: Pick<RunColumns, 'status'>): SQL<boolean> {
	return sql<boolean>`(${run.status} = 'published')`;
}

/** The run is in force: published and at or above the evidence floor of its candidate. */
export function runInForce(run: RunColumns, candidate: Pick<CandidateColumns, 'evidenceFloorRevision'>): SQL<boolean> {
	return sql<boolean>`(${run.status} = 'published' and ${run.inputRevision} >= ${candidate.evidenceFloorRevision})`;
}

/** The candidate is listed in the catalog; who of the viewers sees them is decided by `canShow`. */
export function listedInCatalog(
	candidate: Pick<CandidateColumns, 'status' | 'visibility' | 'searchStatus'>
): SQL<boolean> {
	return sql<boolean>`(${candidate.status} = 'active' and ${candidate.visibility} = 'catalog' and ${candidate.searchStatus} <> 'not_looking')`;
}
