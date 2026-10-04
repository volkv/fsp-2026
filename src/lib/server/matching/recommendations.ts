// The candidate's side of matching (docs/domain.md, section 13.4; contracts 5.5 `GET /api/v1/me/matches`): own vacancies
// of verified companies and external vacancies ranked by the same `matchScore`, with the same explanation — what fits,
// what it rests on, what is unknown, what to improve. The candidate sees their own evidence, fact ids included. A clone
// of a demo session sees the vacancies of its session and those outside sessions.
import { and, inArray, sql, type SQL } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { vacancies } from '$lib/server/db/schema';
import { demoSessionOfUser } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import { vacancyDocuments } from './documents';
import { loadCandidateSnapshots, loadGradeOrdinals, matchableVacancyFor, vacancySnapshot } from './evidence';
import { paginate, queryFingerprint, type Page, type PageRequest } from './page';
import { loadActiveMatchRuleset } from './ruleset';
import { matchScore, type MatchResult } from './score';
import type { MatchingDeps } from './deps';
import { loadActiveSpace, pairKey, pairSimilarities, semanticSignal } from './semantic';

export interface VacancyRecommendationQuery extends PageRequest {
	text?: string;
	origin?: 'own' | 'external';
	roleKeys?: string[];
	workFormats?: string[];
}

export interface VacancyRecommendation {
	vacancyId: string;
	origin: 'own' | 'external';
	title: string;
	/** Company of an own vacancy; an external one names its organization in its postings. */
	companyId: string | null;
	status: string;
	match: MatchResult;
	relevance: { fts: number | null };
}

export interface VacancyRecommendations extends Page<VacancyRecommendation> {
	mode: { searchMode: 'hybrid' | 'fts_only'; embeddingSpaceId: string | null; semanticReason: string | null };
}

/**
 * The reranker scores a vacancy against a batch of candidates; for one candidate against many vacancies it would take
 * a call per vacancy, so the candidate side ranks without it and says so.
 */
const NOT_RERANKED = 'pair_not_reranked';

export async function recommendVacancies(
	deps: Pick<MatchingDeps, 'db'>,
	subject: AccessSubject,
	query: VacancyRecommendationQuery
): Promise<VacancyRecommendations> {
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined) throw new ApiError('forbidden');
	const decision = can(subject, 'match.read', { vacancyCompanyId: null, candidateId, show: null });
	if (!decision.allowed) throw new ApiError(decision.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	const { db: executor } = deps;
	const { limit, cursor, ...rest } = query;
	const text = rest.text?.trim() ? rest.text.trim() : null;

	// Vacancies of demo companies are seen from their own demo session only, and a clone does not see the vacancies of
	// the originals of the scenario companies (domain 19.3).
	const conditions: SQL[] = [matchableVacancyFor(await demoSessionOfUser(executor, subject.userId))];
	if (rest.origin) conditions.push(sql`${vacancies.origin} = ${rest.origin}`);
	if (rest.roleKeys?.length) conditions.push(inArray(vacancies.roleKey, rest.roleKeys));
	if (rest.workFormats?.length) conditions.push(inArray(vacancies.workFormat, rest.workFormats));
	const rows = await executor
		.select()
		.from(vacancies)
		.where(and(...conditions));

	const documents = await vacancyDocuments(
		executor,
		rows.map((row) => row.id),
		text
	);
	const selected = text === null ? rows : rows.filter((row) => documents.get(row.id)?.matched === true);

	const snapshot = (await loadCandidateSnapshots(executor, [candidateId])).get(candidateId);
	if (!snapshot) throw new ApiError('not_found');
	const ruleset = await loadActiveMatchRuleset(executor);
	const ordinals = await loadGradeOrdinals(
		executor,
		selected.map((row) => row.taxonomyVersionId)
	);
	const space = await loadActiveSpace(executor);
	const similarities =
		space === null
			? new Map<string, number>()
			: await pairSimilarities(
					executor,
					space,
					selected.map((row) => row.id),
					[candidateId]
				);

	const ranked = selected.map((row): VacancyRecommendation => {
		const vacancy = vacancySnapshot(row);
		const gradeOrdinals = ordinals.get(vacancy.taxonomyVersionId);
		if (!gradeOrdinals) throw new Error('grade ordinals were not loaded');
		return {
			vacancyId: vacancy.id,
			origin: vacancy.origin,
			title: vacancy.title,
			companyId: vacancy.companyId,
			status: vacancy.status,
			match: matchScore({
				vacancy,
				candidate: snapshot,
				params: ruleset.params,
				gradeOrdinals,
				semantic: semanticSignal(space, similarities.get(pairKey(vacancy.id, candidateId)), 'pair_vector_missing'),
				reranker: { status: 'unavailable', reason: NOT_RERANKED }
			}),
			relevance: { fts: documents.get(vacancy.id)?.rank ?? null }
		};
	});
	ranked.sort((a, b) => b.match.score - a.match.score || (a.vacancyId < b.vacancyId ? -1 : 1));

	const page = paginate(
		ranked,
		{ ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) },
		queryFingerprint({ ...rest, candidateId })
	);
	return {
		...page,
		mode: {
			searchMode: space !== null && similarities.size > 0 ? 'hybrid' : 'fts_only',
			embeddingSpaceId: space?.id ?? null,
			semanticReason: space === null ? 'no_active_space' : similarities.size > 0 ? null : 'pair_vector_missing'
		}
	};
}
