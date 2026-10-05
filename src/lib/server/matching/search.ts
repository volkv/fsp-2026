// Catalog search for a company (docs/domain.md, sections 7.4, 12.4, 12.7, 13.4, 14, 16; contracts 5.4–5.5): filters by
// the category in force (specialization, grade, confirmed stack), FSP level, format and region, the facet «категория не
// подтверждена»; full-text search plus exact vector search; with a vacancy of the company, ranking by `matchScore` with
// the reranker as one component. A candidate without a category is found only without category filters and is marked;
// at equal relevance or score the candidates with a category come first (domain 12.7). Every candidate passes `canShow`
// in the catalog context of the vacancy, so a minor appears only for a suitable vacancy of the viewer.
import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { categoryPredicate } from '$lib/server/categories/read';
import type { Executor } from '$lib/server/db';
import { candidateAt, listedInCatalog, runAt, runInForce } from '$lib/server/db/conditions';
import { vacancies } from '$lib/server/db/schema';
import { demoScope } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import { canShow, type ShowExtra } from '$lib/server/visibility/can-show';
import type { MatchingDeps } from './deps';
import { candidateDocuments } from './documents';
import { vacancySnapshot, type VacancySnapshot } from './evidence';
import { paginate, queryFingerprint, type Page, type PageRequest } from './page';
import { scoreCandidatesForVacancy } from './rank';
import { loadActiveMatchRuleset } from './ruleset';
import type { ExplanationMatch, MatchComponent, MatchComponents, MatchExplanation } from './score';
import { candidateSimilarities, embedQuery, loadActiveSpace, type ActiveSpace, type MatchingModels } from './semantic';
import { textList } from './sql';
import { loadCatalogViewer, loadVisibilityFacts, loadVisibilityPolicy, type CatalogViewer } from './visibility';

const FSP_LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;

export interface CandidateSearchFilters {
	/** A category in force of any of these specializations. */
	specializations?: SpecializationKey[];
	/** A category in force of any of these grades — of one of `specializations`, when both are given. */
	grades?: GradeKey[];
	/** All of these skills are in the confirmed stack of one category in force (domain 12.4). */
	confirmedSkillKeys?: string[];
	fspLevel?: { discipline: string; minLevel: (typeof FSP_LEVELS)[number] };
	/** Any of these work formats among the candidate's preferences. */
	workFormats?: string[];
	regionCodes?: string[];
	/** The facet «категория не подтверждена»: only candidates without a category in force (domain 12.7). */
	uncategorized?: boolean;
}

export interface CandidateSearchQuery extends PageRequest {
	/** A vacancy of the viewer's company: ranking by the match with it, and the context of `canShow`. */
	vacancyId?: string;
	text?: string;
	filters?: CandidateSearchFilters;
}

export interface SearchMode {
	/** `fts_only` — no semantic component was used, with the reason (contracts 5.4). */
	searchMode: 'hybrid' | 'fts_only';
	embeddingSpaceId: string | null;
	semanticReason: string | null;
	/** The reranker is used only to rank candidates for a vacancy. */
	reranker: { status: 'used' | 'unavailable' | 'not_applicable'; reason: string | null };
}

/** An explanation as a company sees it: fact ids are internal and are replaced by receipts in the card. */
export type CompanyExplanationMatch =
	Exclude<ExplanationMatch, { kind: 'skill' }> | Omit<Extract<ExplanationMatch, { kind: 'skill' }>, 'fact_ids'>;

export interface CompanyMatch {
	score: number;
	coverage: number;
	components: MatchComponents;
	explanation: Omit<MatchExplanation, 'matches'> & { matches: CompanyExplanationMatch[] };
}

export interface CandidateSearchItem {
	/** Server-side key to build the card with `projectCandidate`; never sent to the company. */
	candidateId: string;
	pseudonym: string;
	projection: 'catalog';
	extras: ShowExtra[];
	/** With a vacancy: the match decomposition; without one: `null`. */
	match: CompanyMatch | null;
	relevance: { fts: number | null; semantic: number | null };
	/** The candidate has a category in force; without one the card is marked «категория не подтверждена» (12.7). */
	categoryConfirmed: boolean;
}

export interface CandidateSearchResult extends Page<CandidateSearchItem> {
	mode: SearchMode;
}

/** Nearest candidates by meaning added to the full-text matches of a query. */
const SEMANTIC_NEIGHBORS = 50;

/** The explanation a company sees: fact ids are internal and are replaced by receipts in the card. */
export function companyExplanation(explanation: MatchExplanation): CompanyMatch['explanation'] {
	return {
		...explanation,
		matches: explanation.matches.map((match) => {
			if (match.kind !== 'skill') return match;
			return {
				kind: match.kind,
				requirement: match.requirement,
				skill_key: match.skill_key,
				band: match.band,
				attestation: match.attestation,
				badge_trust: match.badge_trust
			};
		})
	};
}

function validationError(path: string, message: string): ApiError {
	return new ApiError('validation_failed', { details: [{ path, code: 'invalid', message }] });
}

/**
 * A candidate passing the filters SQL can decide, with what their ranking is computed from: the profile revision, the
 * evidence floor and the run in force (`null` — none), and whether a category is in force.
 */
interface Listed {
	id: string;
	categoryConfirmed: boolean;
	revision: number;
	floor: number;
	runId: string | null;
}

/** Candidates passing the filters that SQL can decide; `canShow` decides the rest. */
async function prefilter(
	executor: Executor,
	viewer: { companyId: string; demoSessionId: string | null },
	filters: CandidateSearchFilters
): Promise<Listed[]> {
	const { companyId } = viewer;
	const conditions: SQL[] = [
		demoScope({ demoSessionId: sql`c.demo_session_id`, demoOriginal: sql`c.demo_original` }, viewer.demoSessionId),
		listedInCatalog(candidateAt('c')),
		sql`not exists (select 1 from candidate_company_blocks b where b.candidate_id = c.id and b.company_id = ${companyId})`
	];
	const nonEmpty = <T extends string>(path: string, values: readonly T[] | undefined) => {
		if (values?.length === 0) throw validationError(path, 'Пустой список');
		return values;
	};
	const specializations = nonEmpty('filters.specializations', filters.specializations);
	const grades = nonEmpty('filters.grades', filters.grades);
	const confirmedSkillKeys = nonEmpty('filters.confirmedSkillKeys', filters.confirmedSkillKeys);
	const byCategory = specializations !== undefined || grades !== undefined || confirmedSkillKeys !== undefined;
	if (byCategory) {
		// One category in force meets every category filter at once; without a category, never in this result (12.7).
		conditions.push(
			categoryPredicate(sql`c.id`, {
				...(specializations ? { specializations } : {}),
				...(grades ? { grades } : {}),
				...(confirmedSkillKeys ? { confirmedSkillKeys } : {})
			})
		);
	}
	if (filters.fspLevel) {
		if (!FSP_LEVELS.includes(filters.fspLevel.minLevel)) throw validationError('filters.fspLevel.minLevel', 'L1–L5');
		conditions.push(sql`exists (select 1 from fsp_level_assignments f where f.run_id = r.id
			and f.discipline = ${filters.fspLevel.discipline} and f.level >= ${filters.fspLevel.minLevel})`);
	}
	const formats = nonEmpty('filters.workFormats', filters.workFormats);
	if (formats) {
		conditions.push(sql`exists (select 1 from jsonb_array_elements_text(
			case when jsonb_typeof(c.preferences->'work_formats') = 'array' then c.preferences->'work_formats' else '[]'::jsonb end
		) wf(value) where wf.value in ${textList(formats)})`);
	}
	const regions = nonEmpty('filters.regionCodes', filters.regionCodes);
	if (regions) conditions.push(sql`c.preferences->>'region_code' in ${textList(regions)}`);
	if (filters.uncategorized) {
		if (byCategory) {
			throw validationError('filters.uncategorized', 'Фасет «без категории» не сочетается с фильтрами категории');
		}
		conditions.push(sql`not ${categoryPredicate(sql`c.id`)}`);
	}

	const rows = await executor.execute<{
		id: string;
		category_confirmed: boolean;
		revision: string;
		floor: string;
		run_id: string | null;
	}>(sql`
		select c.id::text as id, ${categoryPredicate(sql`c.id`)} as category_confirmed,
			c.profile_revision::text as revision, c.evidence_floor_revision::text as floor, r.id::text as run_id
		from candidates c
		left join evidence_runs r on r.candidate_id = c.id and ${runInForce(runAt('r'), candidateAt('c'))}
		where ${sql.join(conditions, sql` and `)}
	`);
	return rows.map((row) => ({
		id: row.id,
		categoryConfirmed: row.category_confirmed,
		revision: Number(row.revision),
		floor: Number(row.floor),
		runId: row.run_id
	}));
}

/** An own vacancy of the viewer's company that is not closed; anything else is «not found» for this viewer. */
export async function companyVacancy(
	executor: Executor,
	vacancyId: string,
	companyId: string
): Promise<VacancySnapshot> {
	const [row] = await executor
		.select()
		.from(vacancies)
		.where(
			and(
				eq(vacancies.id, vacancyId),
				eq(vacancies.origin, 'own'),
				eq(vacancies.companyId, companyId),
				ne(vacancies.status, 'closed')
			)
		);
	if (!row) throw new ApiError('not_found');
	return vacancySnapshot(row);
}

/** Who searches and for which vacancy: read once per request. */
interface SearchContext {
	now: Date;
	viewer: CatalogViewer;
	companyId: string;
	vacancy: VacancySnapshot | null;
}

async function searchContext(
	deps: MatchingDeps,
	subject: AccessSubject,
	vacancyId: string | undefined
): Promise<SearchContext> {
	const decision = can(subject, 'catalog.search', null);
	if (!decision.allowed) throw new ApiError(decision.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	const now = deps.now();
	const viewer = await loadCatalogViewer(deps.db, subject, now);
	if (!viewer) throw new ApiError('forbidden');
	const companyId = viewer.viewer.companyId;
	const vacancy = vacancyId === undefined ? null : await companyVacancy(deps.db, vacancyId, companyId);
	return { now, viewer, companyId, vacancy };
}

interface Visible {
	extras: ShowExtra[];
	categoryConfirmed: boolean;
}

/** Of the listed candidates, those the viewer sees: the same `canShow` as the card, in the catalog context of the vacancy. */
async function visibleOf(
	executor: Executor,
	context: SearchContext,
	listed: readonly Listed[]
): Promise<Map<string, Visible>> {
	const { now, viewer, vacancy } = context;
	const facts = await loadVisibilityFacts(
		executor,
		listed.map((row) => row.id),
		{
			now,
			policy: await loadVisibilityPolicy(executor, now),
			viewerCompanyId: context.companyId,
			viewerCompany: viewer.company,
			...(vacancy
				? {
						vacancy: {
							id: vacancy.id,
							companyId: vacancy.companyId,
							origin: vacancy.origin,
							status: vacancy.status,
							minAge: vacancy.minAge
						}
					}
				: {})
		}
	);
	const showContext = vacancy ? { kind: 'catalog' as const, vacancyId: vacancy.id } : { kind: 'catalog' as const };
	const visible = new Map<string, Visible>();
	for (const row of listed) {
		const fact = facts.get(row.id);
		if (!fact) continue;
		const show = canShow(fact, viewer.viewer, showContext);
		if (show.allowed && show.projection === 'catalog') {
			visible.set(row.id, { extras: show.extras, categoryConfirmed: row.categoryConfirmed });
		}
	}
	return visible;
}

/** A place in a ranking: what the query and the vacancy made of the candidate, whoever looks. */
interface RankedEntry {
	candidateId: string;
	fts: number | null;
	semantic: number | null;
	match: CompanyMatch | null;
}

interface Ranking {
	entries: RankedEntry[];
	mode: SearchMode;
}

/**
 * Ranks the visible candidates: with a vacancy, `matchScore` of every pair (a query narrows the list by words, the match
 * ranks it); without one, the query by words and by meaning, the nearest candidates by meaning joining the word
 * matches. The heavy part of a search — documents, vectors, the reranker — is here, and only here.
 */
async function computeRanking(
	deps: MatchingDeps,
	vacancy: VacancySnapshot | null,
	text: string | null,
	visible: ReadonlyMap<string, Visible>,
	signal: AbortSignal | undefined
): Promise<Ranking> {
	const visibleIds = [...visible.keys()];
	const { db: executor } = deps;
	// Full-text search over catalog documents built from evidence active right now. Without a query there is nothing
	// to match or rank by words: no documents are built, and the reranker reads only those of its window.
	const documents = text === null ? null : await candidateDocuments(executor, visibleIds, text);
	const ftsMatched = (id: string) => documents?.get(id)?.matched === true;
	const fts = (id: string) => documents?.get(id)?.rank ?? null;

	if (vacancy) {
		const scoring = await scoreCandidatesForVacancy(
			executor,
			deps.models,
			vacancy,
			text === null ? visibleIds : visibleIds.filter(ftsMatched),
			{
				ruleset: await loadActiveMatchRuleset(executor),
				...(documents ? { documents } : {}),
				priority: 'interactive',
				...(signal ? { signal } : {})
			}
		);
		return {
			entries: scoring.ranked.map(({ snapshot, result }) => ({
				candidateId: snapshot.id,
				fts: fts(snapshot.id),
				semantic: scoring.similarities.get(snapshot.id) ?? null,
				match: {
					score: result.score,
					coverage: result.coverage,
					components: result.components,
					explanation: companyExplanation(result.explanation)
				}
			})),
			mode: {
				searchMode: scoring.semantic.space ? 'hybrid' : 'fts_only',
				embeddingSpaceId: scoring.semantic.space?.id ?? null,
				semanticReason: scoring.semantic.reason,
				reranker: scoring.reranker
			}
		};
	}

	let similarities = new Map<string, number>();
	let semanticReason: string | null = 'no_query';
	let usedSpace: ActiveSpace | null = null;
	let candidateIds = visibleIds;
	if (text !== null) {
		const embedding = await embedQuery(deps.models, await loadActiveSpace(executor), text, signal);
		if (embedding.status === 'unavailable') semanticReason = embedding.reason;
		else {
			similarities = await candidateSimilarities(executor, embedding.space, embedding.vector, visibleIds);
			semanticReason = null;
			usedSpace = embedding.space;
		}
		const neighbors = [...similarities.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, SEMANTIC_NEIGHBORS)
			.map(([id]) => id);
		const selected = new Set([...visibleIds.filter(ftsMatched), ...neighbors]);
		candidateIds = visibleIds.filter((id) => selected.has(id));
	}
	// Relevance of the query; without a query, the stable order of the catalog.
	const ranked = candidateIds.map((id) => {
		const entry: RankedEntry = { candidateId: id, fts: fts(id), semantic: similarities.get(id) ?? null, match: null };
		const parts = [entry.fts, entry.semantic].filter((v): v is number => v !== null);
		return { entry, order: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0 };
	});
	// At equal relevance a candidate with a category in force comes first (domain 12.7).
	const confirmed = (id: string) => (visible.get(id)?.categoryConfirmed ? 1 : 0);
	ranked.sort(
		(a, b) =>
			b.order - a.order ||
			confirmed(b.entry.candidateId) - confirmed(a.entry.candidateId) ||
			(a.entry.candidateId < b.entry.candidateId ? -1 : 1)
	);
	return {
		entries: ranked.map((r) => r.entry),
		mode: {
			searchMode: usedSpace ? 'hybrid' : 'fts_only',
			embeddingSpaceId: usedSpace?.id ?? null,
			semanticReason,
			reranker: { status: 'not_applicable', reason: null }
		}
	};
}

// --- The ranking cache -----------------------------------------------------------------------------------------------
//
// A ranking is a function of the visible candidates at their revisions, evidence floors and runs in force, of their
// vectors and the vacancy's in the active space, of the vacancy at its revision, the query, the match rule set in force
// and of what the reranker answers right now. The key is made of exactly these, so a change of any of them is a new key
// and nothing is invalidated by hand; visibility itself is decided afresh on every request, and the key carries the set
// it produced. The key also names the company and the demo session of the viewer: a ranking is never served across
// them. Rankings are kept per model adapter: the process has one, and a ranking made with other models is not theirs.
//
// A missing model component is kept only when its reason does not pass by itself: a reranker switched off or not
// configured is in the key, and the first request after it is back makes a new ranking. A reranker whose breaker is
// open is in the key too, and that ranking is kept briefly: the cooldown ends by itself. A switched-off embedder is not
// in the key — nothing tells its state without a query to embed — so a ranking without it is kept briefly. A ranking
// with a model call that failed is not kept: the next request tries the model again, and the adapter's breaker stops
// asking a runtime that keeps failing.

const RANKING_TTL_MS = 120_000;
/** Lifetime of a ranking made without a model that can come back while its key holds. */
const RANKING_DEGRADED_TTL_MS = 10_000;
/**
 * Bound on the estimated heap of all kept rankings of one model adapter; the least recently used go first, one larger
 * than the bound is not kept. A ranking of 10 000 candidates for a vacancy is estimated at about 47 MB.
 */
const RANKING_CACHE_BYTES = 64 * 1024 * 1024;
/**
 * Heap bytes of a kept ranking per character of its JSON: measured 1.2–1.35 on rankings for a vacancy (explanations
 * and components are most of it), taken with a margin.
 */
const HEAP_PER_JSON_CHAR = 1.5;
/** The ranking itself, its mode and its place in the cache, whatever its entries. */
const RANKING_OVERHEAD_BYTES = 1_024;

/**
 * Entries of a ranking serialized to estimate its weight. The entries of one ranking are alike — the same vacancy, the
 * same components, explanations of the same requirements — so a sample spread over the order stands for all of them,
 * and a large ranking is weighed without serializing each of its entries.
 */
const WEIGHT_SAMPLE = 32;

/** Estimated heap bytes of a kept ranking. */
export function rankingWeight(ranking: Ranking): number {
	const { entries } = ranking;
	const step = Math.max(1, entries.length / WEIGHT_SAMPLE);
	const sample = entries.filter((_, index) => Math.floor(index / step) !== Math.floor((index - 1) / step));
	if (sample.length === 0) return RANKING_OVERHEAD_BYTES;
	const chars = sample.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);
	return RANKING_OVERHEAD_BYTES + Math.ceil((chars / sample.length) * entries.length * HEAP_PER_JSON_CHAR);
}

/**
 * What the reranker answers right now, read without calling its runtime: the adapter decides whether the operation is
 * on and whether its breaker is open before it answers a request without documents. `unknown` — the state cannot be
 * read (the mode store); a ranking made then is not kept.
 */
type RerankerState = 'on' | 'disabled' | 'cooling_down' | 'unknown';

async function rerankerState(models: MatchingModels, signal: AbortSignal | undefined): Promise<RerankerState> {
	const answer = await models.rerank(
		{ query: 'state', documents: [], topN: 1 },
		{ priority: 'interactive', ...(signal ? { signal } : {}) }
	);
	if (answer.ok) return 'on';
	if (answer.error.code === 'disabled') return 'disabled';
	return answer.error.details?.cause === 'cooling_down' ? 'cooling_down' : 'unknown';
}

/** Reasons of a missing semantic component that the key accounts for: the same key gives the same reason. */
const STRUCTURAL_SEMANTIC_REASONS = new Set(['no_query', 'no_active_space', 'vacancy_vector_missing']);

/** How long a ranking made in this mode is kept under its key; `null` — it is not kept. */
function lifetime(mode: SearchMode, reranker: RerankerState | null): number | null {
	let ttl = RANKING_TTL_MS;
	if (mode.semanticReason !== null && !STRUCTURAL_SEMANTIC_REASONS.has(mode.semanticReason)) {
		if (mode.semanticReason !== 'disabled') return null;
		ttl = RANKING_DEGRADED_TTL_MS;
	}
	if (mode.reranker.status === 'unavailable' && mode.reranker.reason !== 'no_candidates') {
		if (reranker === 'cooling_down') ttl = RANKING_DEGRADED_TTL_MS;
		else if (reranker !== 'disabled') return null;
	}
	return ttl;
}

export class RankingCache {
	readonly #budget: number;
	readonly #rankings = new Map<string, { ranking: Ranking; weight: number; expiresAt: number }>();
	#bytes = 0;

	constructor(budgetBytes = RANKING_CACHE_BYTES) {
		this.#budget = budgetBytes;
	}

	/** Estimated heap bytes of the kept rankings. */
	get bytes(): number {
		return this.#bytes;
	}

	get size(): number {
		return this.#rankings.size;
	}

	get(key: string, now: number): Ranking | null {
		const kept = this.#rankings.get(key);
		if (!kept) return null;
		this.#rankings.delete(key);
		if (kept.expiresAt <= now) {
			this.#bytes -= kept.weight;
			return null;
		}
		this.#rankings.set(key, kept);
		return kept.ranking;
	}

	set(key: string, ranking: Ranking, now: number, ttlMs: number): void {
		for (const [kept, entry] of this.#rankings) {
			if (kept === key || entry.expiresAt <= now) this.#drop(kept, entry.weight);
		}
		const weight = rankingWeight(ranking);
		if (weight > this.#budget) return;
		this.#rankings.set(key, { ranking, weight, expiresAt: now + ttlMs });
		this.#bytes += weight;
		for (const [oldest, kept] of this.#rankings) {
			if (this.#bytes <= this.#budget) break;
			this.#drop(oldest, kept.weight);
		}
	}

	#drop(key: string, weight: number): void {
		this.#rankings.delete(key);
		this.#bytes -= weight;
	}
}

const rankingCaches = new WeakMap<MatchingModels, RankingCache>();

function rankingCacheOf(models: MatchingModels): RankingCache {
	let cache = rankingCaches.get(models);
	if (!cache) {
		cache = new RankingCache();
		rankingCaches.set(models, cache);
	}
	return cache;
}

/** The vectors a ranking reads: every candidate section vector of the visible candidates and the vacancy vector. */
async function vectorsStamp(
	executor: Executor,
	space: ActiveSpace,
	visibleIds: readonly string[],
	vacancyId: string | null
): Promise<string> {
	const [row] = await executor.execute<{ stamp: string }>(sql`
		select md5(coalesce(string_agg(concat_ws(':', e.owner_type, e.owner_id, e.section, e.input_version,
			e.input_sha256), ',' order by e.owner_type, e.owner_id, e.section), '')) as stamp
		from embeddings e
		where e.space_id = ${space.id}
			and ((e.owner_type = 'candidate_section' and e.owner_id in ${textList(visibleIds)})
				${vacancyId === null ? sql`` : sql`or (e.owner_type = 'vacancy' and e.owner_id = ${vacancyId})`})
	`);
	if (!row) throw new Error('vectors stamp was not read');
	return row.stamp;
}

async function rankingKey(
	executor: Executor,
	context: SearchContext,
	text: string | null,
	listed: readonly Listed[],
	visible: ReadonlyMap<string, Visible>,
	reranker: RerankerState | null
): Promise<string> {
	const { vacancy } = context;
	const space = await loadActiveSpace(executor);
	const visibleIds = [...visible.keys()];
	return queryFingerprint({
		companyId: context.companyId,
		demoSessionId: context.viewer.viewer.demoSessionId,
		vacancy: vacancy && { id: vacancy.id, revision: vacancy.revision, taxonomyVersionId: vacancy.taxonomyVersionId },
		matchRulesetId: vacancy && (await loadActiveMatchRuleset(executor)).id,
		reranker,
		text,
		space: space && { id: space.id, vectors: await vectorsStamp(executor, space, visibleIds, vacancy?.id ?? null) },
		candidates: listed
			.filter((row) => visible.has(row.id))
			.map((row) => [row.id, row.revision, row.floor, row.runId])
			.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1))
	});
}

/**
 * The whole ranked list of visible candidates for the query. Visibility is decided on every request; the ranking of the
 * visible set is computed once per key and served from the cache while the key holds.
 */
async function rankCandidates(
	deps: MatchingDeps,
	subject: AccessSubject,
	query: Omit<CandidateSearchQuery, 'limit' | 'cursor'>,
	signal?: AbortSignal
): Promise<{ ranked: CandidateSearchItem[]; mode: SearchMode }> {
	const { db: executor } = deps;
	const context = await searchContext(deps, subject, query.vacancyId);
	const text = query.text?.trim() ? query.text.trim() : null;
	const listed = await prefilter(executor, context.viewer.viewer, query.filters ?? {});
	const visible = await visibleOf(executor, context, listed);
	const visibleIds = [...visible.keys()];

	// Without a vacancy and a query the order is the catalog's own: there is nothing to compute or to keep.
	const keyed = (context.vacancy !== null || text !== null) && visibleIds.length > 0;
	const cache = rankingCacheOf(deps.models);
	// Only a ranking for a vacancy asks the reranker.
	const reranker = keyed && context.vacancy !== null ? await rerankerState(deps.models, signal) : null;
	const key = keyed ? await rankingKey(executor, context, text, listed, visible, reranker) : null;
	const at = context.now.getTime();
	let ranking = key === null ? null : cache.get(key, at);
	if (!ranking) {
		ranking = await computeRanking(deps, context.vacancy, text, visible, signal);
		const ttl = key === null ? null : lifetime(ranking.mode, reranker);
		if (key !== null && ttl !== null) cache.set(key, ranking, at, ttl);
	}

	return {
		ranked: ranking.entries.map((entry) => {
			const shown = visible.get(entry.candidateId);
			if (!shown) throw new Error('a ranked candidate is not visible');
			return {
				candidateId: entry.candidateId,
				pseudonym: deps.pseudonym(entry.candidateId, context.companyId),
				projection: 'catalog',
				extras: shown.extras,
				match: entry.match,
				relevance: { fts: entry.fts, semantic: entry.semantic },
				categoryConfirmed: shown.categoryConfirmed
			};
		}),
		mode: ranking.mode
	};
}

/** One page of the catalog search. */
export async function searchCandidates(
	deps: MatchingDeps,
	subject: AccessSubject,
	query: CandidateSearchQuery,
	signal?: AbortSignal
): Promise<CandidateSearchResult> {
	const { limit, cursor, ...rest } = query;
	const { ranked, mode } = await rankCandidates(deps, subject, rest, signal);
	const page = paginate(
		ranked,
		{ ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) },
		queryFingerprint(rest)
	);
	return { ...page, mode };
}

export type ComparisonCell =
	| { kind: 'skill'; status: 'confirmed' | 'derived' | 'claimed' | 'missing' | 'unavailable'; band: string | null }
	| { kind: 'grade' | 'salary'; status: string; value: number | null; detail: string | null };

export interface CandidateComparison {
	vacancyId: string;
	/** The same requirements for every candidate: required and nice skills of the vacancy, grade, salary. */
	requirements: (
		{ kind: 'skill'; requirement: 'required' | 'nice'; skillKey: string } | { kind: 'grade' } | { kind: 'salary' }
	)[];
	/**
	 * Per candidate: cells in the order of the requirements, and the role and trust components of the pair, which
	 * compare the candidates as a whole rather than one requirement.
	 */
	candidates: {
		pseudonym: string;
		score: number;
		coverage: number;
		cells: ComparisonCell[];
		role: MatchComponent<'role'>;
		trust: MatchComponent<'trust'>;
	}[];
	mode: SearchMode;
}

/**
 * Compares chosen candidates by the requirements of one vacancy (CONCEPT 4): one row of cells per candidate, in the
 * order of the requirements. Pseudonyms the viewer cannot see are absent, exactly as in the search: visibility is the
 * search's own. Only the chosen candidates are scored, so the reranker reads every one of them and their scores compare
 * with each other; on the search page a candidate outside the reranker window has no reranker component.
 */
export async function compareCandidates(
	deps: MatchingDeps,
	subject: AccessSubject,
	vacancyId: string,
	pseudonyms: readonly string[],
	signal?: AbortSignal
): Promise<CandidateComparison> {
	if (pseudonyms.length === 0 || pseudonyms.length > 10) throw validationError('pseudonyms', 'От 1 до 10 кандидатов');
	const { db: executor } = deps;
	const context = await searchContext(deps, subject, vacancyId);
	const { vacancy, companyId } = context;
	if (!vacancy) throw new Error('a comparison is always made for a vacancy');
	const wanted = new Set(pseudonyms);
	const listed = (await prefilter(executor, context.viewer.viewer, {})).filter((row) =>
		wanted.has(deps.pseudonym(row.id, companyId))
	);
	const visible = await visibleOf(executor, context, listed);
	const scoring = await scoreCandidatesForVacancy(executor, deps.models, vacancy, [...visible.keys()], {
		ruleset: await loadActiveMatchRuleset(executor),
		priority: 'interactive',
		...(signal ? { signal } : {})
	});
	const mode: SearchMode = {
		searchMode: scoring.semantic.space ? 'hybrid' : 'fts_only',
		embeddingSpaceId: scoring.semantic.space?.id ?? null,
		semanticReason: scoring.semantic.reason,
		reranker: scoring.reranker
	};
	const requirements: CandidateComparison['requirements'] = [
		...vacancy.requiredSkillKeys.map((skillKey) => ({
			kind: 'skill' as const,
			requirement: 'required' as const,
			skillKey
		})),
		...vacancy.niceSkillKeys.map((skillKey) => ({ kind: 'skill' as const, requirement: 'nice' as const, skillKey })),
		{ kind: 'grade' },
		{ kind: 'salary' }
	];
	return {
		vacancyId,
		requirements,
		candidates: scoring.ranked.map(({ snapshot, result }) => {
			const match: CompanyMatch = {
				score: result.score,
				coverage: result.coverage,
				components: result.components,
				explanation: companyExplanation(result.explanation)
			};
			return {
				pseudonym: deps.pseudonym(snapshot.id, companyId),
				score: match.score,
				coverage: match.coverage,
				cells: cellsOf(requirements, match),
				role: match.components.role,
				trust: match.components.trust
			};
		}),
		mode
	};
}

function cellsOf(requirements: CandidateComparison['requirements'], match: CompanyMatch): ComparisonCell[] {
	return requirements.map((requirement): ComparisonCell => {
		if (requirement.kind === 'grade') {
			const grade = match.components.grade;
			return {
				kind: 'grade',
				status: grade.status,
				value: grade.value,
				detail: grade.details.position ?? grade.details.reason ?? null
			};
		}
		if (requirement.kind === 'salary') {
			const salary = match.components.salary;
			return {
				kind: 'salary',
				status: salary.status,
				value: salary.value,
				detail: salary.details.comparison ?? salary.details.reason ?? null
			};
		}
		const component = match.components[requirement.requirement];
		if (component.status === 'unavailable') return { kind: 'skill', status: 'unavailable', band: null };
		const coverage = component.details.skills?.find((skill) => skill.skill_key === requirement.skillKey);
		if (!coverage?.attestation) return { kind: 'skill', status: 'missing', band: null };
		return {
			kind: 'skill',
			status: coverage.attestation === 'direct' ? 'confirmed' : coverage.attestation,
			band: coverage.band
		};
	});
}
