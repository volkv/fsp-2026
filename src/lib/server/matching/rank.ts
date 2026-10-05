// Scoring of candidates for one vacancy, shared by the catalog search (interactive) and by `match.refresh` (background):
// `matchScore` of every pair with the semantic component from exact vector search, then the reranker over the first
// ones by that score as one more component, so both paths rank and explain the same way.
import type { Executor } from '$lib/server/db';
import type { CallOptions } from '$lib/server/ml/adapter';
import { candidateDocuments, vacancyDocuments, type SearchDocument } from './documents';
import { loadCandidateSnapshots, loadGradeOrdinals, type CandidateSnapshot, type VacancySnapshot } from './evidence';
import type { MatchRuleset } from './ruleset';
import {
	matchScore,
	needScore,
	type MatchResult,
	type NeedCandidate,
	type NeedResult,
	type NeedSpec,
	type RerankerSignal
} from './score';
import {
	candidateSimilarities,
	embedQuery,
	loadActiveSpace,
	RERANK_WINDOW,
	rerank,
	rerankerSignal,
	semanticSignal,
	vacancyVector,
	type ActiveSpace,
	type MatchingModels,
	type RerankOutcome
} from './semantic';
import type { TestResultReader, TestResults } from './test-results';

export interface ScoredCandidate {
	snapshot: CandidateSnapshot;
	result: MatchResult;
}

export interface VacancyScoring {
	/** Candidates by score, highest first; ties by id. */
	ranked: ScoredCandidate[];
	similarities: Map<string, number>;
	semantic: { space: ActiveSpace | null; reason: string | null };
	reranker: { status: 'used' | 'unavailable'; reason: string | null };
}

export interface ScoringOptions extends CallOptions {
	ruleset: MatchRuleset;
	/** Documents already built for the search; loaded otherwise. */
	documents?: Map<string, SearchDocument>;
}

export async function scoreCandidatesForVacancy(
	executor: Executor,
	models: MatchingModels,
	vacancy: VacancySnapshot,
	candidateIds: readonly string[],
	options: ScoringOptions
): Promise<VacancyScoring> {
	const { ruleset } = options;
	const space = await loadActiveSpace(executor);
	let similarities = new Map<string, number>();
	let semantic: VacancyScoring['semantic'] = { space: null, reason: 'no_active_space' };
	if (space !== null) {
		const vector = await vacancyVector(executor, space, vacancy.id);
		if (vector === null) semantic = { space: null, reason: 'vacancy_vector_missing' };
		else {
			similarities = await candidateSimilarities(executor, space, vector, candidateIds);
			semantic = { space, reason: null };
		}
	}

	const snapshots = await loadCandidateSnapshots(executor, candidateIds);
	const ordinals = (await loadGradeOrdinals(executor, [vacancy.taxonomyVersionId])).get(vacancy.taxonomyVersionId);
	if (!ordinals) throw new Error('grade ordinals were not loaded');
	const score = (snapshot: CandidateSnapshot, reranker: RerankerSignal): ScoredCandidate => ({
		snapshot,
		result: matchScore({
			vacancy,
			candidate: snapshot,
			params: ruleset.params,
			gradeOrdinals: ordinals,
			semantic: semanticSignal(semantic.space, similarities.get(snapshot.id), 'candidate_vector_missing'),
			reranker
		})
	});
	// At an equal score a candidate with a category in force comes first (domain 12.7).
	const confirmed = (entry: ScoredCandidate) => (entry.snapshot.categories.length > 0 ? 1 : 0);
	const byScore = (list: ScoredCandidate[]) =>
		list.sort(
			(a, b) =>
				b.result.score - a.result.score || confirmed(b) - confirmed(a) || (a.snapshot.id < b.snapshot.id ? -1 : 1)
		);

	const present = [...snapshots.values()];
	const firstPass = byScore(present.map((s) => score(s, { status: 'unavailable', reason: 'not_ranked' })));
	const window = firstPass.slice(0, RERANK_WINDOW).map((entry) => entry.snapshot.id);
	let outcome: RerankOutcome | null = null;
	if (window.length > 0) {
		const documents = options.documents ?? (await candidateDocuments(executor, window, null));
		const vacancyText = (await vacancyDocuments(executor, [vacancy.id], null)).get(vacancy.id)?.body ?? vacancy.title;
		outcome = await rerank(
			models,
			vacancyText,
			window.map((id) => ({ id, text: documents.get(id)?.body ?? '' })),
			{
				...(options.priority ? { priority: options.priority } : {}),
				...(options.signal ? { signal: options.signal } : {})
			}
		);
	}
	const inWindow = new Set(window);
	const ranked = byScore(
		present.map((s) =>
			score(
				s,
				inWindow.has(s.id)
					? rerankerSignal(outcome, s.id, 'outside_rerank_window')
					: { status: 'unavailable', reason: 'outside_rerank_window' }
			)
		)
	);

	return {
		ranked,
		similarities,
		semantic,
		reranker:
			outcome === null
				? { status: 'unavailable', reason: 'no_candidates' }
				: outcome.status === 'computed'
					? { status: 'used', reason: null }
					: { status: 'unavailable', reason: outcome.reason }
	};
}

// --- Ranking for a hiring need and by the strength of the confirmed profile (domain 13.10) ---------------------------

export interface RankedForNeed {
	snapshot: CandidateSnapshot;
	result: NeedResult;
	/** Cosine similarity of the candidate to the text of the need; `null` — not measured. */
	semantic: number | null;
	/** The candidate stood among almost equal scores whose order the semantic similarity decided. */
	tieBrokenBySemantic: boolean;
	/** 1-based position. */
	position: number;
	/** The position the candidate would have without their FSP results, everybody else unchanged. */
	positionWithoutFsp: number;
}

export interface NeedRanking {
	ranked: RankedForNeed[];
	semantic: { space: ActiveSpace | null; reason: string | null };
}

export interface NeedRankingOptions extends CallOptions {
	ruleset: MatchRuleset;
	testResults: TestResultReader;
	now: Date;
	/** The text the semantic similarity is measured against; `null` — none, the order of almost equal is by strength. */
	semanticText: string | null;
}

/** What `needScore` reads of a candidate snapshot. */
export function needCandidateOf(snapshot: CandidateSnapshot, results: TestResults): NeedCandidate {
	const preferences = snapshot.preferences;
	return {
		evidence: snapshot.evidence,
		categories: snapshot.confirmed,
		preferences: {
			workFormats: preferences.work_formats ?? [],
			regionCode: preferences.region_code ?? null,
			relocation: preferences.relocation ?? null
		},
		tests: new Map(
			snapshot.confirmed.flatMap((c) => {
				const blocks = results.get(c.decisionId);
				return blocks ? [[c.decisionId, blocks] as const] : [];
			})
		)
	};
}

/**
 * Ranks the candidates for a need — or, with `need = null`, by the strength of the confirmed profile alone (the catalog
 * without a need): `needScore` of every candidate; those covering every required skill first, then by the number of
 * unconfirmed required skills, and inside each group the highest score first; scores closer than the rule set's
 * `nearTie` are almost equal, and their order is the semantic similarity to the text of the need, then the strength,
 * then the id. The semantic similarity never changes a score and never moves a candidate past one that scores clearly
 * higher or covers more.
 */
export async function rankForNeed(
	executor: Executor,
	models: MatchingModels,
	need: NeedSpec | null,
	candidateIds: readonly string[],
	options: NeedRankingOptions
): Promise<NeedRanking> {
	const { ruleset, now } = options;
	const snapshots = [...(await loadCandidateSnapshots(executor, candidateIds)).values()];
	const answer = await options.testResults.resultsOf(
		executor,
		snapshots.flatMap((s) => s.confirmed.map((c) => c.decisionId))
	);
	const params = ruleset.params.need;
	const scored = snapshots.map((snapshot) => {
		const candidate = needCandidateOf(snapshot, answer);
		const input = { need, candidate, params, skillBandValue: ruleset.params.skillBandValue, now };
		const result = needScore(input);
		return { snapshot, result, withoutFsp: needScore({ ...input, withoutFsp: true }) };
	});

	let similarities = new Map<string, number>();
	let semantic: NeedRanking['semantic'] = { space: null, reason: 'no_query' };
	if (options.semanticText !== null && scored.length > 1) {
		const embedding = await embedQuery(models, await loadActiveSpace(executor), options.semanticText, options.signal);
		if (embedding.status === 'unavailable') semantic = { space: null, reason: embedding.reason };
		else {
			similarities = await candidateSimilarities(
				executor,
				embedding.space,
				embedding.vector,
				scored.map((s) => s.snapshot.id)
			);
			semantic = { space: embedding.space, reason: null };
		}
	}

	const order = orderForNeed(
		scored.map((entry) => ({
			id: entry.snapshot.id,
			unconfirmed: entry.result.coverage.unconfirmed.length,
			score: entry.result.score,
			strength: entry.result.levels.strength,
			withoutFsp: {
				unconfirmed: entry.withoutFsp.coverage.unconfirmed.length,
				score: entry.withoutFsp.score
			}
		})),
		similarities,
		params.nearTie
	);
	const byId = new Map(scored.map((entry) => [entry.snapshot.id, entry]));
	const ranked = order.map((place): RankedForNeed => {
		const entry = byId.get(place.id);
		if (!entry) throw new Error('an ordered candidate was not scored');
		return {
			snapshot: entry.snapshot,
			result: entry.result,
			semantic: similarities.get(place.id) ?? null,
			tieBrokenBySemantic: place.tieBrokenBySemantic,
			position: place.position,
			positionWithoutFsp: place.positionWithoutFsp
		};
	});
	return { ranked, semantic };
}

export interface ScoredPlace {
	id: string;
	/** Required skills of the need not confirmed: the first key, fewer first. */
	unconfirmed: number;
	score: number;
	/** The strength level of the score: the next key among almost equal. */
	strength: number;
	/** The place the candidate would have without their FSP results: an FSP result may confirm a required skill too. */
	withoutFsp: { unconfirmed: number; score: number };
}

export interface OrderedPlace {
	id: string;
	position: number;
	positionWithoutFsp: number;
	tieBrokenBySemantic: boolean;
}

/**
 * The order of a ranking for a need: by the number of unconfirmed required skills, fewer first, then by score, highest
 * first. Inside one number, scores within `nearTie` of the first of a group are almost equal; inside the group the
 * semantic similarity decides (a candidate without one goes after those with one), then the strength, then the score,
 * then the id. A group is cut from the top and never spans two numbers, so the similarity never lifts a candidate above
 * one that covers more or scores `nearTie` or more higher. «Без ФСП — позиция N» is the place the coverage and the score
 * without FSP would take among the others' as they are.
 */
export function orderForNeed(
	places: readonly ScoredPlace[],
	similarities: ReadonlyMap<string, number>,
	nearTie: number
): OrderedPlace[] {
	const byId = (a: ScoredPlace, b: ScoredPlace) => (a.id < b.id ? -1 : 1);
	const ordered = [...places].sort((a, b) => a.unconfirmed - b.unconfirmed || b.score - a.score || byId(a, b));
	const result: OrderedPlace[] = [];
	for (let start = 0; start < ordered.length;) {
		const first = ordered[start];
		if (!first) break;
		let end = start + 1;
		while (end < ordered.length) {
			const next = ordered[end];
			if (!next || next.unconfirmed !== first.unconfirmed || first.score - next.score >= nearTie) break;
			end++;
		}
		const group = ordered.slice(start, end);
		const similarity = (place: ScoredPlace) => similarities.get(place.id) ?? -Infinity;
		const settled = [...group].sort(
			(a, b) => similarity(b) - similarity(a) || b.strength - a.strength || b.score - a.score || byId(a, b)
		);
		const measured = group.some((place) => similarities.has(place.id));
		const moved = settled.some((place, index) => place !== group[index]);
		for (const place of settled) {
			result.push({
				id: place.id,
				position: result.length + 1,
				positionWithoutFsp: 0,
				tieBrokenBySemantic: group.length > 1 && measured && moved
			});
		}
		start = end;
	}
	// One sortable key per place: the number of unconfirmed skills, then the score (in [0, 1]) descending.
	const key = (unconfirmed: number, score: number) => unconfirmed * 2 + (1 - score);
	const keys = places.map((place) => key(place.unconfirmed, place.score)).sort((a, b) => a - b);
	/** How many places come strictly before the key. */
	const before = (value: number) => {
		let low = 0;
		let high = keys.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((keys[middle] ?? Infinity) < value) low = middle + 1;
			else high = middle;
		}
		return low;
	};
	const scoredOf = new Map(places.map((place) => [place.id, place]));
	for (const place of result) {
		const scored = scoredOf.get(place.id);
		if (!scored) throw new Error('an ordered candidate was not scored');
		const own = key(scored.unconfirmed, scored.score);
		const without = key(scored.withoutFsp.unconfirmed, scored.withoutFsp.score);
		// Without FSP the place can only fall; its own key is before the key without FSP, so `before` counts it once: it
		// stands for the place itself.
		place.positionWithoutFsp = without <= own ? place.position : before(without);
	}
	return result;
}
