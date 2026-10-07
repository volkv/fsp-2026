import { redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/http/form';
import { candidateRequest } from '$lib/server/candidates/http';
import {
	acceptRequest,
	candidateConfirmations,
	declineRequest,
	setResultVisibility
} from '$lib/server/confirmations/requests';
import { catalogNames, contactPageDeps } from '$lib/server/contact/page';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/**
 * Requests of a confirmation from companies and the results of the candidate's block tests (domain 13.11): a request is
 * taken of the candidate's will — four clusters of the block, and the category never changes; the candidate decides who
 * sees a result.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	try {
		return { ...(await candidateConfirmations(contactPageDeps(), subject)), names: catalogNames(), now: new Date() };
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	accept: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		let attemptId: string | null;
		try {
			const accepted = await acceptRequest(contactPageDeps(), subject, meta, formText(form, 'requestId'));
			attemptId = accepted.kind === 'started' ? accepted.attemptId : null;
		} catch (cause) {
			return formFailure(cause);
		}
		if (attemptId !== null) redirect(303, `/me/tests/attempts/${attemptId}`);
		return { shared: true };
	},
	decline: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			await declineRequest(contactPageDeps(), subject, meta, formText(form, 'requestId'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { declined: true };
	},
	visibility: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const visibility = formText(form, 'visibility') === 'all_companies' ? 'all_companies' : 'requester';
		try {
			await setResultVisibility(contactPageDeps(), subject, meta, formText(form, 'confirmationId'), visibility);
		} catch (cause) {
			return formFailure(cause);
		}
		return { visibility };
	}
};
