import { fail } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import { db } from '$lib/server/db';
import {
	claimExternalVacancy,
	externalVacancyQuery,
	searchExternalVacancies
} from '$lib/server/employer/external-vacancies';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { claimRequesterOf, withdrawVacancyClaim } from '$lib/server/vacancies/claims';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/**
 * External vacancies collected from the sources: the search of the general catalog with the pool counter of each and
 * the «this is our vacancy» claim, which the company can take back while it is open. The address of the page is the
 * search.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const query = externalVacancyQuery(event.url);
	try {
		const database = db();
		const [page, vocabulary] = await Promise.all([
			searchExternalVacancies(database, { userId: subject.userId, companyId: membership.companyId }, query, new Date()),
			currentVocabulary(database)
		]);
		return {
			page,
			query,
			labels: labelsOf(vocabulary),
			filters: { roles: vocabulary.roles, formats: vocabulary.terms.work_format }
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	claim: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		const vacancyId = formText(form, 'vacancy_id');
		try {
			const claim = await claimExternalVacancy({ db: db(), now: () => new Date() }, subject, meta, vacancyId);
			return { vacancyId, claimed: { status: claim.status }, problem: null };
		} catch (cause) {
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, vacancyId, claimed: null });
		}
	},
	withdrawClaim: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		const vacancyId = formText(form, 'vacancy_id');
		try {
			const claim = await withdrawVacancyClaim(
				{ db: db(), now: () => new Date() },
				claimRequesterOf(subject, meta.requestId),
				vacancyId,
				formText(form, 'claim_id')
			);
			return { vacancyId, claimed: { status: claim.status }, problem: null };
		} catch (cause) {
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, vacancyId, claimed: null });
		}
	}
};
