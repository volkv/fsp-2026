// Model-based signals of matching (docs/domain.md, section 16; contracts 3.3–3.5): exact cosine search inside the active
// embedding space and the reranker as one explicit component. A switched-off or failing model gives an explicit
// `unavailable` with the reason, never a made-up value; search then runs in the FTS-only mode and says so.
import { eq, sql } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { embeddingSpaces, searchSettings } from '$lib/server/db/schema';
import type { CallOptions, EmbedRequest, EmbedResponse, RerankRequest, RerankResponse } from '$lib/server/ml/adapter';
import type { ModelResult } from '$lib/server/ml/result';
import type { RerankerSignal, SemanticSignal } from './score';
import { textList } from './sql';

/** The operations of the model adapter matching uses. */
export interface MatchingModels {
	embed(request: EmbedRequest, options?: CallOptions): Promise<ModelResult<EmbedResponse>>;
	rerank(request: RerankRequest, options?: CallOptions): Promise<ModelResult<RerankResponse>>;
}

export interface ActiveSpace {
	id: string;
	dimension: number;
}

/** The embedding space of the catalog: `search_settings.active_embedding_space_id` while that space is active. */
export async function loadActiveSpace(executor: Executor): Promise<ActiveSpace | null> {
	const [row] = await executor
		.select({ id: embeddingSpaces.id, dimension: embeddingSpaces.dimension, status: embeddingSpaces.status })
		.from(searchSettings)
		.innerJoin(embeddingSpaces, eq(embeddingSpaces.id, searchSettings.activeEmbeddingSpaceId));
	return row?.status === 'active' ? { id: row.id, dimension: row.dimension } : null;
}

/** A vector in the text form of pgvector; every value must be finite. */
export function vectorLiteral(vector: readonly number[]): string {
	for (const value of vector) if (!Number.isFinite(value)) throw new Error('vector has a non-finite value');
	return `[${vector.join(',')}]`;
}

/** `vector::vector(N)` for the dimension of the space; the dimension is an integer read from the database. */
function typed(space: ActiveSpace) {
	if (!Number.isInteger(space.dimension) || space.dimension < 1) throw new Error('bad space dimension');
	return sql.raw(`vector(${space.dimension})`);
}

/**
 * Highest cosine similarity between each candidate's valid section vectors and one query vector of the same space.
 * A vector counts only when built from a revision at or above the evidence floor: a vector of withdrawn evidence stops
 * counting in the transaction that raises the floor (domain 17.3). Candidates without a valid vector are absent.
 */
export async function candidateSimilarities(
	executor: Executor,
	space: ActiveSpace,
	query: readonly number[],
	candidateIds: readonly string[]
): Promise<Map<string, number>> {
	if (candidateIds.length === 0) return new Map();
	if (query.length !== space.dimension) throw new Error('query vector does not match the space dimension');
	const vectorType = typed(space);
	const rows = await executor.execute<{ candidate_id: string; similarity: number }>(sql`
		select e.owner_id as candidate_id,
			max(1 - (e.vector::${vectorType} <=> ${vectorLiteral(query)}::${vectorType}))::float8 as similarity
		from embeddings e
		join candidates c on c.id::text = e.owner_id
		where e.space_id = ${space.id}
			and e.owner_type = 'candidate_section'
			and e.input_version::bigint >= c.evidence_floor_revision
			and e.owner_id in ${textList(candidateIds)}
		group by e.owner_id
	`);
	return new Map(rows.map((row) => [row.candidate_id, row.similarity]));
}

/**
 * Cosine similarity of pairs «vacancy × candidate»: the highest over the candidate's valid section vectors against the
 * vacancy vector of its current revision. Pairs without both vectors are absent. The same value in both directions.
 */
export async function pairSimilarities(
	executor: Executor,
	space: ActiveSpace,
	vacancyIds: readonly string[],
	candidateIds: readonly string[]
): Promise<Map<string, number>> {
	if (vacancyIds.length === 0 || candidateIds.length === 0) return new Map();
	const vectorType = typed(space);
	const rows = await executor.execute<{ vacancy_id: string; candidate_id: string; similarity: number }>(sql`
		select v.owner_id as vacancy_id, e.owner_id as candidate_id,
			max(1 - (e.vector::${vectorType} <=> v.vector::${vectorType}))::float8 as similarity
		from embeddings v
		join vacancies va on va.id::text = v.owner_id and v.input_version = va.revision::text
		join embeddings e on e.space_id = v.space_id and e.owner_type = 'candidate_section'
		join candidates c on c.id::text = e.owner_id and e.input_version::bigint >= c.evidence_floor_revision
		where v.space_id = ${space.id}
			and v.owner_type = 'vacancy'
			and v.owner_id in ${textList(vacancyIds)}
			and e.owner_id in ${textList(candidateIds)}
		group by v.owner_id, e.owner_id
	`);
	return new Map(rows.map((row) => [pairKey(row.vacancy_id, row.candidate_id), row.similarity]));
}

export const pairKey = (vacancyId: string, candidateId: string) => `${vacancyId}:${candidateId}`;

/** The vector of the vacancy at its current revision in the active space, or `null`. */
export async function vacancyVector(
	executor: Executor,
	space: ActiveSpace,
	vacancyId: string
): Promise<number[] | null> {
	const rows = await executor.execute<{ vector: string }>(sql`
		select v.vector::text as vector
		from embeddings v
		join vacancies va on va.id::text = v.owner_id and v.input_version = va.revision::text
		where v.space_id = ${space.id} and v.owner_type = 'vacancy' and v.owner_id = ${vacancyId}
	`);
	const [row] = rows;
	return row ? row.vector.slice(1, -1).split(',').map(Number) : null;
}

export type QueryEmbedding =
	{ status: 'computed'; space: ActiveSpace; vector: number[] } | { status: 'unavailable'; reason: string };

/** Embeds a search query interactively in the active space; any failure is a reason for the FTS-only mode. */
export async function embedQuery(
	models: MatchingModels,
	space: ActiveSpace | null,
	text: string,
	signal?: AbortSignal
): Promise<QueryEmbedding> {
	if (space === null) return { status: 'unavailable', reason: 'no_active_space' };
	const response = await models.embed(
		{ spaceId: space.id, inputs: [{ id: 'query', kind: 'query', text }] },
		{ priority: 'interactive', ...(signal ? { signal } : {}) }
	);
	if (!response.ok) return { status: 'unavailable', reason: response.error.code };
	const [first] = response.value.vectors;
	if (!first) throw new Error('embed returned no vector for the query');
	return { status: 'computed', space, vector: first.vector };
}

export function semanticSignal(
	space: ActiveSpace | null,
	similarity: number | undefined,
	missing: string
): SemanticSignal {
	if (space === null) return { status: 'unavailable', reason: 'no_active_space' };
	if (similarity === undefined) return { status: 'unavailable', reason: missing };
	return { status: 'computed', cosine: similarity, spaceId: space.id };
}

/** Candidates of a vacancy passed to the reranker: the first ones by the score without it. */
export const RERANK_WINDOW = 50;

export type RerankOutcome =
	{ status: 'computed'; modelId: string; scores: Map<string, number> } | { status: 'unavailable'; reason: string };

/**
 * Reranks documents against the query. Documents the reranker did not score (beyond its `top_n`) are absent from the
 * scores; the caller marks them unavailable with a reason.
 */
export async function rerank(
	models: MatchingModels,
	query: string,
	documents: readonly { id: string; text: string }[],
	options: CallOptions
): Promise<RerankOutcome> {
	if (documents.length === 0) return { status: 'computed', modelId: '', scores: new Map() };
	const response = await models.rerank({ query, documents, topN: documents.length }, options);
	if (!response.ok) return { status: 'unavailable', reason: response.error.code };
	return {
		status: 'computed',
		modelId: response.value.model.modelId,
		scores: new Map(response.value.scores.map((s) => [s.id, s.score]))
	};
}

export function rerankerSignal(outcome: RerankOutcome | null, id: string, notRanked: string): RerankerSignal {
	if (outcome === null) return { status: 'unavailable', reason: notRanked };
	if (outcome.status === 'unavailable') return { status: 'unavailable', reason: outcome.reason };
	const score = outcome.scores.get(id);
	return score === undefined
		? { status: 'unavailable', reason: 'outside_rerank_top_n' }
		: { status: 'computed', score, modelId: outcome.modelId };
}
