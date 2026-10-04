import { redirect } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import { acceptMemberInvite } from '$lib/server/companies/members';
import { companyDeps, employerRequest } from '$lib/server/employer/http';
import { formFailure } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

/**
 * The link of a team invitation. Opening it changes nothing — mail scanners follow links; the person accepts with the
 * button, signed in under the address the letter was sent to.
 */
export const load: PageServerLoad = async (event) => {
	await employerRequest(event);
	return { token: event.url.searchParams.get('token') ?? '' };
};

export const actions: Actions = {
	accept: async (event) => {
		const { subject, meta } = await employerRequest(event);
		const form = await event.request.formData();
		try {
			await acceptMemberInvite(companyDeps(), { subject, meta }, formText(form, 'token'));
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, '/company/vacancies');
	}
};
