import { candidateRequest } from '$lib/server/candidates/http';
import { pageError } from '$lib/server/http/page';
import { recommendedVacancies } from '$lib/server/candidates/vacancies';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { db } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/** The search of the address (`?q=&role=&grade=&format=&cursor=`): the filters of `GET /api/v1/me/matches`. */
function searchOf(url: URL) {
	const params = url.searchParams;
	const text = params.get('q')?.trim() ?? '';
	const role = params.get('role')?.trim() ?? '';
	const grade = params.get('grade')?.trim() ?? '';
	return {
		text,
		roleKey: role === '' ? null : role,
		gradeKey: grade === '' ? null : grade,
		workFormats: [...new Set(params.getAll('format').filter((format) => format !== ''))],
		cursor: params.get('cursor') ?? null
	};
}

/**
 * Vacancies ranked by the candidate's match; a vacancy leads to its page with the application (domain 13.5). The search
 * narrows the list by words, role, grade and work format; the match stays the same.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	try {
		const search = searchOf(event.url);
		const executor = db();
		const [page, vocabulary] = await Promise.all([
			recommendedVacancies({ db: executor }, subject, {
				...(search.cursor === null ? {} : { cursor: search.cursor }),
				...(search.text === '' ? {} : { text: search.text }),
				...(search.roleKey === null ? {} : { roleKeys: [search.roleKey] }),
				...(search.gradeKey === null ? {} : { gradeKeys: [search.gradeKey] }),
				...(search.workFormats.length === 0 ? {} : { workFormats: search.workFormats })
			}),
			currentCandidateVocabulary(executor)
		]);
		return {
			page,
			labels: vocabularyLabels(vocabulary),
			search
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
