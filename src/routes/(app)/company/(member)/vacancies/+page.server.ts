import { fail } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import { db } from '$lib/server/db';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { listOwnVacancies, listVacancyClaims } from '$lib/server/employer/vacancies';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { formFailure } from '$lib/server/http/page';
import { claimRequesterOf, withdrawVacancyClaim } from '$lib/server/vacancies/claims';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const database = db();
	const now = new Date();
	const [vacancies, claims, vocabulary] = await Promise.all([
		listOwnVacancies(database, membership.companyId, now),
		listVacancyClaims(database, membership.companyId),
		currentVocabulary(database)
	]);
	return { vacancies, claims, labels: labelsOf(vocabulary) };
};

export const actions: Actions = {
	/** The company takes back its open «this is our vacancy» claim (domain 13.3). */
	withdrawClaim: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		const claimId = formText(form, 'claim_id');
		try {
			await withdrawVacancyClaim(
				{ db: db(), now: () => new Date() },
				claimRequesterOf(subject, meta.requestId),
				formText(form, 'vacancy_id'),
				claimId
			);
			return { claimId, withdrawn: true, problem: null };
		} catch (cause) {
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, claimId, withdrawn: false });
		}
	}
};
