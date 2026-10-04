// Stored matches (docs/domain.md, section 13.4): `match_scores` keeps the significant pairs — the score at or above
// `matching_policy.store_threshold` — and the pair of every invitation, with the decomposition as codes and numbers. Explanations are never stored: every
// screen builds them with `matchScore` when it reads, so a pair without a row is explained the same way. A refresh
// writes only the rows whose result changed and removes the rows that stopped being significant or current; a row an
// invitation refers to («why invited», domain 13.5) is kept.
import { and, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { parsePolicyParams } from '$lib/server/consent/kinds';
import type { Executor, Transaction } from '$lib/server/db';
import { candidates, matchScores, productPolicies } from '$lib/server/db/schema';
import { loadCandidateSnapshots, loadGradeOrdinals, type VacancySnapshot } from './evidence';
import { COMPONENT_KEYS, COMPONENT_STATUS_CODES, type ComponentKey, type ComponentStatus } from './params';
import { loadActiveMatchRuleset, type MatchRuleset } from './ruleset';
import { matchScore, qualifiesForPool, type MatchComponents, type MatchResult } from './score';
import { loadActiveSpace, pairKey, pairSimilarities, semanticSignal } from './semantic';

/** Rows per insert statement. */
const BATCH = 500;

export interface MatchStoragePolicy {
	id: string;
	version: number;
	storeThreshold: number;
}

export class MatchStorageError extends Error {
	readonly code: 'policy_missing' | 'threshold_above_pool';

	constructor(code: MatchStorageError['code'], message: string) {
		super(message);
		this.name = 'MatchStorageError';
		this.code = code;
	}
}

/**
 * `matching_policy` in force, checked against the rule set: a threshold above the pool threshold would leave pool
 * pairs unstored, and the refresh of a candidate compares the pool before and after by the stored pairs.
 */
export async function loadMatchStoragePolicy(
	executor: Executor,
	ruleset: MatchRuleset,
	now: Date
): Promise<MatchStoragePolicy> {
	const [row] = await executor
		.select({ id: productPolicies.id, version: productPolicies.version, params: productPolicies.params })
		.from(productPolicies)
		.where(and(eq(productPolicies.kind, 'matching_policy'), lte(productPolicies.effectiveFrom, now)))
		.orderBy(desc(productPolicies.effectiveFrom), desc(productPolicies.version))
		.limit(1);
	if (!row) throw new MatchStorageError('policy_missing', 'no matching_policy is in force');
	const storeThreshold = parsePolicyParams('matching_policy', row.params).store_threshold;
	if (storeThreshold > ruleset.params.poolThreshold) {
		throw new MatchStorageError(
			'threshold_above_pool',
			`matching_policy v${row.version} stores from ${storeThreshold}, above the pool threshold ` +
				`${ruleset.params.poolThreshold} of match rule set v${ruleset.version}`
		);
	}
	return { id: row.id, version: row.version, storeThreshold };
}

type ValueColumn = `${ComponentKey}Value`;

const valueColumn = (key: ComponentKey): ValueColumn => `${key}Value`;

export type StoredDecomposition = { componentStatuses: string } & Record<ValueColumn, number | null>;

/** The decomposition as it is stored: status letters in the order of `COMPONENT_KEYS` and a value per component. */
export function encodeComponents(components: MatchComponents): StoredDecomposition {
	const values = Object.fromEntries(COMPONENT_KEYS.map((key) => [valueColumn(key), components[key].value])) as Record<
		ValueColumn,
		number | null
	>;
	return {
		componentStatuses: COMPONENT_KEYS.map((key) => COMPONENT_STATUS_CODES[components[key].status]).join(''),
		...values
	};
}

const STATUS_OF_CODE = new Map(
	(Object.entries(COMPONENT_STATUS_CODES) as [ComponentStatus, string][]).map(([status, code]) => [code, status])
);

/** Status of one component in `match_scores.component_statuses`. */
export function storedStatus(componentStatuses: string, key: ComponentKey): ComponentStatus {
	const status = STATUS_OF_CODE.get(componentStatuses.charAt(COMPONENT_KEYS.indexOf(key)));
	if (status === undefined) throw new Error('stored match decomposition is malformed');
	return status;
}

/** Status and value of one component of a stored decomposition. */
export function storedComponent(
	stored: StoredDecomposition,
	key: ComponentKey
): { status: ComponentStatus; value: number | null } {
	return { status: storedStatus(stored.componentStatuses, key), value: stored[valueColumn(key)] };
}

/** Columns a refresh rewrites when the result of the same snapshot changed. */
const RESULT_COLUMNS = [
	'embeddingSpaceId',
	'rerankerModelId',
	'score',
	'componentStatuses',
	...COMPONENT_KEYS.map(valueColumn)
] as const satisfies readonly (keyof typeof matchScores.$inferInsert)[];

/** The database name of a column (the schema is mapped with the snake_case casing). */
const snake = (field: string) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** One computed pair with the snapshot it was computed from. */
export interface ComputedPair {
	vacancyId: string;
	vacancyRevision: number;
	candidateId: string;
	candidateRevision: number;
	categorizationRunId: string | null;
	result: MatchResult;
	/** Space of the semantic component when it was computed. */
	spaceId: string | null;
}

export function isSignificant(result: Pick<MatchResult, 'score'>, policy: MatchStoragePolicy): boolean {
	return result.score >= policy.storeThreshold;
}

/**
 * How a refresh treats a row of the same snapshot: the vacancy side computes the reranker over its window and replaces
 * a row whose result differs; the candidate side ranks without the reranker and leaves an existing row as it is.
 */
export type WriteMode = 'replace_changed' | 'keep_existing';

/**
 * Writes the significant pairs whose candidate evidence floor is still at or below the revision they were computed
 * from: a withdrawal committed before the write makes the row invalid from birth. An unchanged row is not touched.
 * Returns the pairs kept and the rows actually written.
 */
export async function writePairs(
	tx: Transaction,
	pairs: readonly ComputedPair[],
	ruleset: MatchRuleset,
	/** The refresh job that computed the pairs; `null` — computed by a request (`storeInvitedPair`). */
	jobId: string | null,
	mode: WriteMode
): Promise<{ kept: ComputedPair[]; written: number }> {
	if (pairs.length === 0) return { kept: [], written: 0 };
	const floors = new Map(
		(
			await tx
				.select({ id: candidates.id, floor: candidates.evidenceFloorRevision })
				.from(candidates)
				.where(inArray(candidates.id, [...new Set(pairs.map((p) => p.candidateId))]))
		).map((row) => [row.id, row.floor])
	);
	const kept = pairs.filter((pair) => pair.candidateRevision >= (floors.get(pair.candidateId) ?? Infinity));
	const now = new Date();
	const rows = kept.map((pair) => ({
		vacancyId: pair.vacancyId,
		vacancyRevision: pair.vacancyRevision,
		candidateId: pair.candidateId,
		candidateRevision: pair.candidateRevision,
		categorizationRunId: pair.categorizationRunId,
		matchRulesetId: ruleset.id,
		embeddingSpaceId: pair.spaceId,
		rerankerModelId:
			pair.result.components.reranker.status === 'computed'
				? (pair.result.components.reranker.details.model_id ?? null)
				: null,
		score: pair.result.score.toFixed(3),
		...encodeComponents(pair.result.components),
		computedAt: now,
		jobId
	}));
	const target = [
		matchScores.vacancyId,
		matchScores.vacancyRevision,
		matchScores.candidateId,
		matchScores.candidateRevision,
		matchScores.categorizationRunId,
		matchScores.matchRulesetId
	];
	let written = 0;
	for (let start = 0; start < rows.length; start += BATCH) {
		const insert = tx.insert(matchScores).values(rows.slice(start, start + BATCH));
		const returned =
			mode === 'keep_existing'
				? await insert.onConflictDoNothing({ target }).returning({ id: matchScores.id })
				: await insert
						.onConflictDoUpdate({
							target,
							set: Object.fromEntries(
								[...RESULT_COLUMNS, 'computedAt', 'jobId'].map((field) => [field, sql.raw(`excluded.${snake(field)}`)])
							),
							setWhere: sql`(${sql.join(
								RESULT_COLUMNS.map((field) => matchScores[field]),
								sql`, `
							)}) is distinct from (${sql.raw(RESULT_COLUMNS.map((field) => `excluded.${snake(field)}`).join(', '))})`
						})
						.returning({ id: matchScores.id });
		written += returned.length;
	}
	return { kept, written };
}

/**
 * The row of the pair at the current snapshot of the vacancy and the candidate, stored whatever its score: an invitation
 * refers to it («why invited», domain 13.5), and the reference keeps it from being removed. A row of that snapshot
 * already stored by a refresh is used as it is; otherwise the pair is computed the way the candidate side computes it —
 * with the semantic component and without the reranker — and written.
 */
export async function storeInvitedPair(
	tx: Transaction,
	vacancy: VacancySnapshot,
	candidateId: string
): Promise<string> {
	const ruleset = await loadActiveMatchRuleset(tx);
	const candidate = (await loadCandidateSnapshots(tx, [candidateId])).get(candidateId);
	if (!candidate) throw new Error(`candidate ${candidateId} does not exist`);
	const runId = candidate.evidence.status === 'available' ? candidate.evidence.runId : null;
	const stored = async () => {
		const [row] = await tx
			.select({ id: matchScores.id })
			.from(matchScores)
			.where(
				and(
					eq(matchScores.vacancyId, vacancy.id),
					eq(matchScores.vacancyRevision, vacancy.revision),
					eq(matchScores.candidateId, candidateId),
					eq(matchScores.candidateRevision, candidate.revision),
					sql`${matchScores.categorizationRunId} is not distinct from ${runId}::uuid`,
					eq(matchScores.matchRulesetId, ruleset.id)
				)
			);
		return row?.id;
	};
	const existing = await stored();
	if (existing !== undefined) return existing;

	const gradeOrdinals = (await loadGradeOrdinals(tx, [vacancy.taxonomyVersionId])).get(vacancy.taxonomyVersionId);
	if (!gradeOrdinals) throw new Error('grade ordinals were not loaded');
	const space = await loadActiveSpace(tx);
	const similarity =
		space === null
			? undefined
			: (await pairSimilarities(tx, space, [vacancy.id], [candidateId])).get(pairKey(vacancy.id, candidateId));
	const result = matchScore({
		vacancy,
		candidate,
		params: ruleset.params,
		gradeOrdinals,
		semantic: semanticSignal(space, similarity, 'pair_vector_missing'),
		reranker: { status: 'unavailable', reason: 'pair_not_reranked' }
	});
	const { kept } = await writePairs(
		tx,
		[
			{
				vacancyId: vacancy.id,
				vacancyRevision: vacancy.revision,
				candidateId,
				candidateRevision: candidate.revision,
				categorizationRunId: runId,
				result,
				spaceId: result.components.semantic.status === 'computed' ? (space?.id ?? null) : null
			}
		],
		ruleset,
		null,
		'keep_existing'
	);
	if (kept.length === 0) throw new Error(`the evidence floor of candidate ${candidateId} moved past its snapshot`);
	// Written now, or by a refresh that committed the same snapshot in between.
	const written = await stored();
	if (written === undefined) throw new Error(`the match of candidate ${candidateId} was not stored`);
	return written;
}

/** A row no invitation refers to. */
const unreferenced = sql`not exists (select 1 from invitations i where i.match_score_id = ${matchScores.id})`;

async function deleteRows(tx: Transaction, condition: SQL): Promise<number> {
	const deleted = await tx.delete(matchScores).where(and(condition, unreferenced)).returning({ id: matchScores.id });
	return deleted.length;
}

/** Removes every row of a vacancy nobody is matched with any more (closed, hidden, replaced). */
export async function clearVacancy(tx: Transaction, vacancyId: string): Promise<number> {
	return deleteRows(tx, eq(matchScores.vacancyId, vacancyId));
}

/**
 * Removes the rows of the vacancy that are not among `kept`: other revisions, other rule sets, pairs below the
 * threshold now, candidates that left the catalog.
 */
export async function pruneVacancy(
	tx: Transaction,
	vacancyId: string,
	kept: readonly ComputedPair[],
	ruleset: MatchRuleset
): Promise<number> {
	const keys = JSON.stringify(
		kept.map((pair) => ({
			vacancy_revision: pair.vacancyRevision,
			candidate_id: pair.candidateId,
			candidate_revision: pair.candidateRevision,
			run_id: pair.categorizationRunId
		}))
	);
	return deleteRows(
		tx,
		sql`${matchScores.vacancyId} = ${vacancyId} and not (${matchScores.matchRulesetId} = ${ruleset.id} and exists (
			select 1 from jsonb_to_recordset(${keys}::jsonb) as k(vacancy_revision bigint, candidate_id uuid,
				candidate_revision bigint, run_id uuid)
			where k.vacancy_revision = ${matchScores.vacancyRevision} and k.candidate_id = ${matchScores.candidateId}
				and k.candidate_revision = ${matchScores.candidateRevision}
				and k.run_id is not distinct from ${matchScores.categorizationRunId}))`
	);
}

/**
 * Removes the rows of the candidate that are not current: another snapshot of the candidate or another rule set, and,
 * among the vacancies the refresh computed, pairs that are not among `kept`. Rows of vacancies the refresh did not
 * compute (a draft of a company) stay with the current snapshot until their vacancy is refreshed.
 */
export async function pruneCandidate(
	tx: Transaction,
	snapshot: { candidateId: string; revision: number; categorizationRunId: string | null },
	computedVacancyIds: readonly string[],
	kept: readonly ComputedPair[],
	ruleset: MatchRuleset
): Promise<number> {
	const current = sql`${matchScores.candidateRevision} = ${snapshot.revision}
		and ${matchScores.categorizationRunId} is not distinct from ${snapshot.categorizationRunId}::uuid
		and ${matchScores.matchRulesetId} = ${ruleset.id}`;
	const keys = JSON.stringify(
		kept.map((pair) => ({ vacancy_id: pair.vacancyId, vacancy_revision: pair.vacancyRevision }))
	);
	const computed = JSON.stringify(computedVacancyIds);
	return deleteRows(
		tx,
		sql`${matchScores.candidateId} = ${snapshot.candidateId} and (not (${current})
			or (${matchScores.vacancyId} in (select jsonb_array_elements_text(${computed}::jsonb)::uuid)
				and not exists (
					select 1 from jsonb_to_recordset(${keys}::jsonb) as k(vacancy_id uuid, vacancy_revision bigint)
					where k.vacancy_id = ${matchScores.vacancyId} and k.vacancy_revision = ${matchScores.vacancyRevision})))`
	);
}

/**
 * Whether the stored pairs of the candidate count for the pools of the vacancies, by the latest row of each vacancy.
 * A pair without a row is below the store threshold and so below the pool threshold.
 */
export async function storedPoolMembership(
	executor: Executor,
	candidateId: string,
	vacancyIds: readonly string[],
	ruleset: MatchRuleset
): Promise<Map<string, boolean>> {
	if (vacancyIds.length === 0) return new Map();
	const rows = await executor
		.selectDistinctOn([matchScores.vacancyId], {
			vacancyId: matchScores.vacancyId,
			score: matchScores.score,
			componentStatuses: matchScores.componentStatuses,
			trustValue: matchScores.trustValue
		})
		.from(matchScores)
		.where(
			and(
				eq(matchScores.candidateId, candidateId),
				eq(matchScores.matchRulesetId, ruleset.id),
				inArray(matchScores.vacancyId, [...vacancyIds])
			)
		)
		.orderBy(matchScores.vacancyId, desc(matchScores.computedAt));
	return new Map(
		rows.map((row) => [
			row.vacancyId,
			qualifiesForPool(
				Number(row.score),
				{ status: storedStatus(row.componentStatuses, 'trust'), value: row.trustValue },
				ruleset.params
			)
		])
	);
}
