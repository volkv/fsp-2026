// The candidate's side of matching (docs/domain.md, section 13.4; contracts 5.5 `GET /api/v1/me/matches`): vacancies of
// the companies of the platform ranked by the same `matchScore`, with the same explanation — what fits,
// what it rests on, what is unknown, what to improve. The candidate sees their own evidence, fact ids included. A clone
// of a demo session sees the vacancies of its session and those outside sessions.
import { and, inArray, type SQL } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { vacancies } from '$lib/server/db/schema';
import { demoSessionOfUser } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import { vacancyDocuments } from './documents';
import { candidateSideMatches } from './candidate-side';
import { loadCandidateSnapshots, matchableVacancyFor, vacancySnapshot } from './evidence';
import { paginate, queryFingerprint, type Page, type PageRequest } from './page';
import { loadActiveMatchRuleset } from './ruleset';
import type { MatchResult } from './score';
import type { MatchingDeps } from './deps';

export interface VacancyRecommendationQuery extends PageRequest {
	text?: string;
	roleKeys?: string[];
	workFormats?: string[];
}

export interface VacancyRecommendation {
	vacancyId: string;
	title: string;
	companyId: string;
	status: string;
	match: MatchResult;
	relevance: { fts: number | null };
}

export interface VacancyRecommendations extends Page<VacancyRecommendation> {
	mode: { searchMode: 'hybrid' | 'fts_only'; embeddingSpaceId: string | null; semanticReason: string | null };
}

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
	const vacancyList = selected.map(vacancySnapshot);
	const { results, space, vectorPairs } = await candidateSideMatches(executor, snapshot, ruleset.params, vacancyList);

	const ranked = vacancyList.map((vacancy): VacancyRecommendation => {
		const match = results.get(vacancy.id);
		if (!match) throw new Error(`vacancy ${vacancy.id} was not scored`);
		return {
			vacancyId: vacancy.id,
			title: vacancy.title,
			companyId: vacancy.companyId,
			status: vacancy.status,
			match,
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
			searchMode: space !== null && vectorPairs > 0 ? 'hybrid' : 'fts_only',
			embeddingSpaceId: space?.id ?? null,
			semanticReason: space === null ? 'no_active_space' : vectorPairs > 0 ? null : 'pair_vector_missing'
		}
	};
}
