import { fail, redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/http/form';
import { db } from '$lib/server/db';
import { labelsOf, vocabularyOf } from '$lib/server/employer/vocabulary';
import { formFailure, pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import { decideModeration, vacancyModerationCase, type ModerationChoice } from '$lib/server/operator/vacancies';
import { MODERATION_REASON_MAX } from '$lib/server/vacancies/own';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	const database = db();
	try {
		const moderationCase = await vacancyModerationCase(database, subject, event.params.id, new Date());
		return {
			moderationCase,
			labels: labelsOf(await vocabularyOf(database, moderationCase.vacancy.taxonomyVersionId)),
			reasonMax: MODERATION_REASON_MAX,
			decided: event.url.searchParams.get('decided')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

async function decide(event: RequestEvent, decision: ModerationChoice) {
	const { subject, meta } = await operatorRequest(event);
	const form = await event.request.formData();
	const reason = formText(form, 'reason');
	const revision = Number(formText(form, 'revision'));
	try {
		await decideModeration(db(), subject, meta, event.params.id, decision, reason, revision);
	} catch (cause) {
		const failure = formFailure(cause);
		return fail(failure.status, { ...failure.data, reason });
	}
	redirect(303, `${event.url.pathname}?decided=${decision}`);
}

export const actions: Actions = {
	publish: (event) => decide(event, 'publish'),
	return: (event) => decide(event, 'return'),
	reject: (event) => decide(event, 'reject')
};
