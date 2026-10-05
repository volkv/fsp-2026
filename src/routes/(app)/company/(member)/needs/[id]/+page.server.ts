import { formText } from '$lib/server/auth/http';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { configuredNeedDeps, needFormFromPost, needFormOptions } from '$lib/server/needs/page';
import { getNeed, needCategories, updateNeed } from '$lib/server/needs/service';
import type { Actions, PageServerLoad } from './$types';

/**
 * One need: the text with the fields the parse suggested and the words each rests on, the form the employer confirms,
 * and the recommended categories with the numbers of candidates the company sees.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	const deps = configuredNeedDeps();
	try {
		const need = await getNeed(deps, subject, event.params.id);
		const { categories } = await needCategories(deps, subject, need.id);
		return {
			need,
			categories,
			options: await needFormOptions(),
			created: event.url.searchParams.has('created')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	save: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		const status = formText(form, 'status');
		try {
			await updateNeed(configuredNeedDeps(), subject, meta, event.params.id, {
				form: await needFormFromPost(form),
				...(status === 'active' ? { status: 'active' as const } : {})
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { saved: status === 'active' ? 'active' : 'form' };
	},

	close: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		try {
			await updateNeed(configuredNeedDeps(), subject, meta, event.params.id, { status: 'closed' });
		} catch (cause) {
			return formFailure(cause);
		}
		return { saved: 'closed' };
	}
};
