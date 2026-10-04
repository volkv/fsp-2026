import { formText } from '$lib/server/auth/http';
import { candidateRequest } from '$lib/server/candidates/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { loadSelfSettings } from '$lib/server/candidates/profile';
import { SEARCH_STATUSES, setSearchStatus } from '$lib/server/candidates/settings';
import { recommendedVacancies } from '$lib/server/candidates/vacancies';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { db } from '$lib/server/db';
import { ApiError } from '$lib/server/errors/api-error';
import { shownPostings, vacancyPostingViews } from '$lib/server/vacancies/attribution';
import type { Actions, PageServerLoad } from './$types';

const ORIGINS = ['own', 'external'] as const;

/** The search of the address (`?q=&origin=&role=&format=&cursor=`): the filters of `GET /api/v1/me/matches`. */
function searchOf(url: URL) {
	const params = url.searchParams;
	const text = params.get('q')?.trim() ?? '';
	const originParam = params.get('origin') ?? '';
	const origin = ORIGINS.find((value) => value === originParam);
	if (originParam !== '' && origin === undefined) {
		throw new ApiError('validation_failed', {
			details: [{ path: 'origin', code: 'unknown', message: 'Неизвестное происхождение вакансии' }]
		});
	}
	const role = params.get('role')?.trim() ?? '';
	return {
		text,
		origin: origin ?? null,
		roleKey: role === '' ? null : role,
		workFormats: [...new Set(params.getAll('format').filter((format) => format !== ''))],
		cursor: params.get('cursor') ?? null
	};
}

/**
 * Vacancies ranked by the candidate's match, and the readiness to receive offers; there is no «apply». An external
 * vacancy comes with its postings: the source, its attribution, the link to the original and the last freshness check.
 * The search narrows the list by words, origin, role and work format; the match stays the same.
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
				...(search.origin === null ? {} : { origin: search.origin }),
				...(search.roleKey === null ? {} : { roleKeys: [search.roleKey] }),
				...(search.workFormats.length === 0 ? {} : { workFormats: search.workFormats })
			}),
			loadSelfSettings(executor, subject, new Date()),
			currentCandidateVocabulary(executor)
		]);
		const postingsOf = await vacancyPostingViews(
			executor,
			page.items.filter((item) => item.origin === 'external').map((item) => item.vacancyId)
		);
		const items = page.items.map((item) => ({
			...item,
			sources: shownPostings({ id: item.vacancyId, origin: item.origin }, postingsOf).map((posting) => ({
				sourceName: posting.sourceName,
				attribution: posting.attribution,
				url: posting.url,
				freshness: posting.freshness,
				lastCheckedAt: posting.lastCheckedAt
			}))
		}));
		return {
			page: { ...page, items },
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
