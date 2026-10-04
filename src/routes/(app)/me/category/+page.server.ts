import { error, type RequestEvent } from '@sveltejs/kit';
import { can } from '$lib/server/access/permissions';
import { formText } from '$lib/server/auth/http';
import { openDispute, withdrawDispute } from '$lib/server/categorization/disputes';
import { candidateDemand } from '$lib/server/candidates/demand';
import { candidateRequest, type CandidateRequest } from '$lib/server/candidates/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { loadSelfCategory } from '$lib/server/candidates/profile';
import { db } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

/**
 * The published category by independent axes, what it rests on, what is missing, what the vacancies of the category
 * require, and the objections to it.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	try {
		const now = new Date();
		const [category, demand] = await Promise.all([
			loadSelfCategory(db(), subject, now),
			candidateDemand(db(), subject, now)
		]);
		return { category, demand };
	} catch (cause) {
		pageError(event, cause);
	}
};

/** Objections are the candidate's own writes: `candidate.self.write` (domain 12.3). */
async function writer(event: RequestEvent): Promise<CandidateRequest> {
	const request = await candidateRequest(event);
	const access = can(request.subject, 'candidate.self.write', { candidateId: request.candidateId });
	if (!access.allowed) error(403, { message: 'Недостаточно прав', requestId: event.locals.requestId });
	return request;
}

export const actions: Actions = {
	dispute: async (event) => {
		const { candidateId, userId, meta } = await writer(event);
		const form = await event.request.formData();
		try {
			await openDispute(db(), {
				candidateId,
				userId,
				runId: formText(form, 'runId'),
				reason: formText(form, 'reason'),
				requestId: meta.requestId
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { disputeOpened: true };
	},

	withdraw: async (event) => {
		const { candidateId, userId, meta } = await writer(event);
		const form = await event.request.formData();
		try {
			await withdrawDispute(db(), {
				disputeId: formText(form, 'disputeId'),
				candidateId,
				userId,
				requestId: meta.requestId
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { disputeWithdrawn: true };
	}
};
