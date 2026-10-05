import { formText } from '$lib/server/auth/http';
import { myApplications, withdrawApplication } from '$lib/server/applications/service';
import { candidateRequest } from '$lib/server/candidates/http';
import { contactPageDeps } from '$lib/server/contact/page';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/** The candidate's own applications with their statuses (domain 13.5): sent, viewed, an offer, a refusal, withdrawn. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	try {
		return { applications: await myApplications(contactPageDeps(), subject), sent: event.url.searchParams.has('sent') };
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	withdraw: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			await withdrawApplication(contactPageDeps(), subject, meta, formText(form, 'applicationId'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { withdrawn: true };
	}
};
