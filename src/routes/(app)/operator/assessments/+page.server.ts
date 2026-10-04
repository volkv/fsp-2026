import { attemptsForReview, type ReviewFilter } from '$lib/server/assessments/review';
import { db } from '$lib/server/db';
import { pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	const filter: ReviewFilter = event.url.searchParams.get('filter') === 'all' ? 'all' : 'attention';
	try {
		return { filter, attempts: await attemptsForReview(db(), subject, filter, new Date()) };
	} catch (cause) {
		pageError(event, cause);
	}
};
