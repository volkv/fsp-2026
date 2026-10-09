// The match of one candidate against vacancies (docs/domain.md, section 13.4): the one path the candidate side reads —
// the vacancies for the candidate, the page of a vacancy, the snapshot an application keeps, and the candidate's
// recomputation of `match_scores`. The semantic component is the similarity of the pair's vectors in the active space
// (unavailable only without a valid vector); the reranker scores a vacancy against a batch of candidates, and for one
// candidate against many vacancies it would take a call per vacancy, so the candidate side scores without it.
import type { Executor } from '$lib/server/db';
import { loadGradeOrdinals, type CandidateSnapshot, type VacancySnapshot } from './evidence';
import type { MatchRulesetParams } from './params';
import { matchScore, type MatchResult } from './score';
import { loadActiveSpace, pairKey, pairSimilarities, semanticSignal, type ActiveSpace } from './semantic';

const NOT_RERANKED = 'pair_not_reranked';

export interface CandidateSideMatches {
	/** The match of each vacancy, by its id. */
	results: Map<string, MatchResult>;
	space: ActiveSpace | null;
	/** Pairs that had a valid vector in the active space. */
	vectorPairs: number;
}

export async function candidateSideMatches(
	executor: Executor,
	candidate: CandidateSnapshot,
	params: MatchRulesetParams,
	vacancyList: readonly VacancySnapshot[]
): Promise<CandidateSideMatches> {
	const ordinals = await loadGradeOrdinals(
		executor,
		vacancyList.map((vacancy) => vacancy.taxonomyVersionId)
	);
	const space = await loadActiveSpace(executor);
	const similarities =
		space === null
			? new Map<string, number>()
			: await pairSimilarities(
					executor,
					space,
					vacancyList.map((vacancy) => vacancy.id),
					[candidate.id]
				);
	const results = new Map<string, MatchResult>();
	for (const vacancy of vacancyList) {
		const gradeOrdinals = ordinals.get(vacancy.taxonomyVersionId);
		if (!gradeOrdinals) throw new Error('grade ordinals were not loaded');
		results.set(
			vacancy.id,
			matchScore({
				vacancy,
				candidate,
				params,
				gradeOrdinals,
				semantic: semanticSignal(space, similarities.get(pairKey(vacancy.id, candidate.id)), 'pair_vector_missing'),
				reranker: { status: 'unavailable', reason: NOT_RERANKED }
			})
		);
	}
	return { results, space, vectorPairs: similarities.size };
}
