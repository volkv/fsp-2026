import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { candidateRequest } from '$lib/server/candidates/http';
import { pageError } from '$lib/server/http/page';
import { candidateCatalog } from '$lib/server/assessments/views';
import { db } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/** Platform tests: practical tasks and quizzes with their coverage, limits, attempts and best results. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	try {
		const now = new Date();
		const [entries, vocabulary] = await Promise.all([
			candidateCatalog(db(), subject, now),
			currentCandidateVocabulary(db())
		]);
		return { entries, skills: vocabularyLabels(vocabulary).skills };
	} catch (cause) {
		pageError(event, cause);
	}
};
