import { formText } from '$lib/server/http/form';
import { candidateRequest } from '$lib/server/candidates/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { loadSelfSettings } from '$lib/server/candidates/profile';
import { SEARCH_STATUSES, setSearchStatus } from '$lib/server/candidates/settings';
import { recommendedVacancies } from '$lib/server/candidates/vacancies';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { db } from '$lib/server/db';
import { ApiError } from '$lib/server/errors/api-error';
import type { Actions, PageServerLoad } from './$types';

/** The search of the address (`?q=&role=&format=&cursor=`): the filters of `GET /api/v1/me/matches`. */
function searchOf(url: URL) {
	const params = url.searchParams;
	const text = params.get('q')?.trim() ?? '';
	const role = params.get('role')?.trim() ?? '';
	return {
		text,
		roleKey: role === '' ? null : role,
		workFormats: [...new Set(params.getAll('format').filter((format) => format !== ''))],
		cursor: params.get('cursor') ?? null
	};
}

/**
 * Vacancies ranked by the candidate's match, and the readiness to receive offers; a vacancy leads to its page with the
 * application (domain 13.5). The search narrows the list by words, role and work format; the match stays the same.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	try {
		const search = searchOf(event.url);
		const executor = db();
		const [page, settings, vocabulary] = await Promise.all([
			recommendedVacancies({ db: executor }, subject, {
				...(search.cursor === null ? {} : { cursor: search.cursor }),
				...(search.text === '' ? {} : { text: search.text }),
				...(search.roleKey === null ? {} : { roleKeys: [search.roleKey] }),
				...(search.workFormats.length === 0 ? {} : { workFormats: search.workFormats })
			}),
			loadSelfSettings(executor, subject, new Date()),
			currentCandidateVocabulary(executor)
		]);
		return {
			page,
			searchStatus: settings.searchStatus,
			labels: vocabularyLabels(vocabulary),
			search
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	status: async (event) => {
		const { subject } = await candidateRequest(event);
		const form = await event.request.formData();
		const status = SEARCH_STATUSES.find((value) => value === formText(form, 'search_status'));
		try {
			if (!status) {
				throw new ApiError('validation_failed', {
					details: [{ path: 'search_status', code: 'unknown', message: 'Выберите статус поиска' }]
				});
			}
			await setSearchStatus(db(), subject, status);
		} catch (cause) {
			return formFailure(cause);
		}
		return { statusSaved: true };
	}
};
