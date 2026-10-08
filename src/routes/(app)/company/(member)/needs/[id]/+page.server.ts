import { redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/http/form';
import { isGradeKey, isSpecializationKey } from '$lib/server/categories/labels';
import { employerRequest, membershipOf } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { configuredNeedDeps, needFormFromPost, needFormOptions } from '$lib/server/needs/page';
import { getNeed, needCategories, updateNeed } from '$lib/server/needs/service';
import { needTestSpecOf } from '$lib/server/needs/test-spec';
import { currentVocabulary } from '$lib/server/employer/vocabulary';
import { configuredShortlistDeps } from '$lib/server/shortlists/page';
import { createShortlist, listShortlists } from '$lib/server/shortlists/service';
import type { Actions, PageServerLoad } from './$types';

/**
 * One need: the text with the fields the parse suggested and the words each rests on, the form the employer confirms,
 * the recommended categories with the numbers of candidates the company sees, and the shortlists of the need — a new
 * one is made of the categories the employer picks.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await employerRequest(event);
	membershipOf(event, subject);
	const deps = configuredNeedDeps();
	try {
		const need = await getNeed(deps, subject, event.params.id);
		const { categories, basis, closed } = await needCategories(deps, subject, need.id);
		return {
			need,
			testSpec: await needTestSpecOf(deps.db, need, await currentVocabulary(deps.db)),
			categories,
			basis,
			closed,
			shortlists: await listShortlists(configuredShortlistDeps(), subject, need.id),
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

	shortlist: async (event) => {
		const { subject, meta } = await employerRequest(event);
		membershipOf(event, subject);
		const form = await event.request.formData();
		const categories = form
			.getAll('category')
			.filter((value): value is string => typeof value === 'string')
			.map((value) => value.split(':'))
			.flatMap(([specialization, grade]) =>
				specialization && grade && isSpecializationKey(specialization) && isGradeKey(grade)
					? [{ specialization, grade }]
					: []
			);
		let shortlistId: string;
		try {
			const created = await createShortlist(
				configuredShortlistDeps(),
				subject,
				meta,
				event.params.id,
				categories.length > 0 ? { categories } : {}
			);
			shortlistId = created.id;
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `/company/shortlists/${shortlistId}`);
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
