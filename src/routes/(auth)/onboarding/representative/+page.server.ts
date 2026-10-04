import { fail, redirect } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { formText, requestMeta, requireSession } from '$lib/server/auth/http';
import { inviteRepresentative, onboardingState } from '$lib/server/auth/onboarding';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const session = requireSession(event);
	const state = await onboardingState(await authDeps(), session.userId);
	const candidate = state.candidate;
	if (!candidate?.minor || candidate.status !== 'active' || candidate.representative !== null) {
		redirect(303, '/onboarding');
	}
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		const session = requireSession(event);
		const form = await event.request.formData();
		const values = {
			fullName: formText(form, 'fullName'),
			email: formText(form, 'email'),
			relation: formText(form, 'relation')
		};
		const result = await inviteRepresentative(await authDeps(), requestMeta(event), session, values);
		if (!result.ok) {
			if (result.reason === 'not_applicable') redirect(303, '/onboarding');
			return fail(400, { values, errors: result.errors });
		}
		redirect(303, `/onboarding?representative=${result.letterSent ? 'sent' : 'not_sent'}`);
	}
};
