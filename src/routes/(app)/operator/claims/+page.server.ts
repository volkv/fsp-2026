import { fail } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import { claimQueue, decideClaim } from '$lib/server/operator/claims';
import { operatorRequest } from '$lib/server/operator/http';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	try {
		return { claims: await claimQueue(db(), subject) };
	} catch (cause) {
		pageError(event, cause);
	}
};

async function decide(event: Parameters<Actions[string]>[0], decision: 'approved' | 'rejected') {
	const { subject, meta } = await operatorRequest(event);
	const form = await event.request.formData();
	const claimId = formText(form, 'claimId');
	try {
		await decideClaim(db(), subject, meta, claimId, decision, formText(form, 'reason'));
	} catch (cause) {
		const failure = formFailure(cause);
		return fail(failure.status, { ...failure.data, claimId });
	}
	return { decided: decision, claimId };
}

export const actions: Actions = {
	approve: (event) => decide(event, 'approved'),
	reject: (event) => decide(event, 'rejected')
};
