import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { ownAttemptAnnulment } from '$lib/server/assessments/annul';
import { candidateAttempt } from '$lib/server/assessments/views';
import { candidateRequest } from '$lib/server/candidates/http';
import { pageError } from '$lib/server/http/page';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { db } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/**
 * One attempt as its candidate sees it: the code or the answers, the verdicts, the score and where it went, and — for
 * an annulled one — why and whether it still counts toward the limit.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	const attemptId = z.uuid().safeParse(event.params.attemptId);
	if (!attemptId.success) error(404, { message: 'Попытка не найдена', requestId: event.locals.requestId });
	try {
		const [attempt, annulment, vocabulary] = await Promise.all([
			candidateAttempt(db(), subject, attemptId.data, new Date()),
			ownAttemptAnnulment(db(), subject, attemptId.data),
			currentCandidateVocabulary(db())
		]);
		return { attempt, annulment, skills: vocabularyLabels(vocabulary).skills };
	} catch (cause) {
		pageError(event, cause);
	}
};
