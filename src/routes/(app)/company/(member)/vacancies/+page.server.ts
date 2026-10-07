import { db } from '$lib/server/db';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { listOwnVacancies } from '$lib/server/employer/vacancies';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	const membership = membershipOf(event, subject);
	const database = db();
	const now = new Date();
	const [vacancies, vocabulary] = await Promise.all([
		listOwnVacancies(database, membership.companyId, now),
		currentVocabulary(database)
	]);
	return { vacancies, labels: labelsOf(vocabulary) };
};
