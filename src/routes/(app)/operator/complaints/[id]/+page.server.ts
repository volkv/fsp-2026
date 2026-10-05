import { formText } from '$lib/server/auth/http';
import { complaintCase, decideComplaint } from '$lib/server/complaints/service';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import type { Actions, PageServerLoad } from './$types';

const deps = () => ({ db: db(), now: () => new Date() });

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	try {
		return { complaint: await complaintCase(deps(), subject, meta, event.params.id) };
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	decide: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		const form = await event.request.formData();
		try {
			await decideComplaint(deps(), { subject, meta }, event.params.id, {
				decision: formText(form, 'decision'),
				resolution: formText(form, 'resolution')
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { decided: true };
	}
};
