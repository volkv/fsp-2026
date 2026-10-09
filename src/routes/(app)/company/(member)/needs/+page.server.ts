import { redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/http/form';
import { config } from '$lib/server/config';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { rateLimitedError } from '$lib/server/http/rate-limit';
import { modelModes } from '$lib/server/ml';
import { extractRoute } from '$lib/server/ml/disclosure';
import { configuredNeedDeps, needFormFromPost, needFormOptions } from '$lib/server/needs/page';
import { createNeed, listNeeds } from '$lib/server/needs/service';
import type { Actions, PageServerLoad } from './$types';

/** Needs of the company and a new one: who the company looks for, as text, as the form, or both (domain 13.10). */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	try {
		const needs = await listNeeds(configuredNeedDeps(), subject);
		return {
			needs,
			options: await needFormOptions(),
			extractRoute: await extractRoute(config().models.extract, modelModes())
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	create: async (event) => {
		// Over the limit of parses the hook lets the post through, for the form to say so in its own words.
		if (event.locals.rateLimited) return formFailure(rateLimitedError(event.locals.rateLimited));
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		let needId: string;
		try {
			const text = formText(form, 'text');
			const filled = await needFormFromPost(form);
			// The form counts as given when the employer filled anything in it; otherwise the text alone is parsed.
			const given = Object.keys(filled).some(
				(key) => !Array.isArray(filled[key]) || (filled[key] as unknown[]).length > 0
			);
			const need = await createNeed(
				configuredNeedDeps(),
				subject,
				meta,
				{ text, ...(given ? { form: filled } : {}) },
				event.request.signal
			);
			needId = need.id;
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `/company/needs/${needId}?created=1`);
	}
};
