import { error, type RequestEvent } from '@sveltejs/kit';
import { can } from '$lib/server/access/permissions';
import { formText } from '$lib/server/auth/http';
import { candidateDemand } from '$lib/server/candidates/demand';
import { candidateRequest, type CandidateRequest } from '$lib/server/candidates/http';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { candidateObjections, withdrawObjection } from '$lib/server/categories/objections';
import { categoryHistory } from '$lib/server/categories/read';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/** The categories confirmed by tests with their history, the objections to test results, and the market of the category. */
export const load: PageServerLoad = async (event) => {
	const { subject, candidateId } = await candidateRequest(event);
	try {
		const executor = db();
		const [categories, objections, demand, vocabulary] = await Promise.all([
			categoryHistory(executor, candidateId),
			candidateObjections(executor, candidateId),
			candidateDemand(executor, subject, new Date()),
			currentCandidateVocabulary(executor)
		]);
		return { categories, objections, demand, labels: vocabularyLabels(vocabulary) };
	} catch (cause) {
		pageError(event, cause);
	}
};

/** Withdrawing an objection is the candidate's own write: `candidate.self.write` (domain 12.5). */
async function writer(event: RequestEvent): Promise<CandidateRequest> {
	const request = await candidateRequest(event);
	const access = can(request.subject, 'candidate.self.write', { candidateId: request.candidateId });
	if (!access.allowed) error(403, { message: 'Недостаточно прав', requestId: event.locals.requestId });
	return request;
}

export const actions: Actions = {
	withdraw: async (event) => {
		const { candidateId, userId, meta } = await writer(event);
		const form = await event.request.formData();
		try {
			await withdrawObjection(db(), {
				objectionId: formText(form, 'objectionId'),
				candidateId,
				userId,
				requestId: meta.requestId
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { objectionWithdrawn: true };
	}
};
