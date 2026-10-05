// Scoring of candidates for one vacancy, shared by the catalog search (interactive) and by `match.refresh` (background):
// `matchScore` of every pair with the semantic component from exact vector search, then the reranker over the first
// ones by that score as one more component, so both paths rank and explain the same way.
import type { Executor } from '$lib/server/db';
import type { CallOptions } from '$lib/server/ml/adapter';
import { candidateDocuments, vacancyDocuments, type SearchDocument } from './documents';
import { loadCandidateSnapshots, loadGradeOrdinals, type CandidateSnapshot, type VacancySnapshot } from './evidence';
import type { MatchRuleset } from './ruleset';
import { matchScore, type MatchResult, type RerankerSignal } from './score';
import {
	candidateSimilarities,
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
