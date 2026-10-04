import { fail } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { emailTokenUsable } from '$lib/server/auth/email-tokens';
import { formText, requestMeta } from '$lib/server/auth/http';
import { confirmRepresentativeContact } from '$lib/server/auth/onboarding';
import type { Actions, PageServerLoad } from './$types';

/** The legal representative confirms the address from the letter (domain 6.4: `invited → contact_confirmed`). */
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token') ?? '';
	const deps = await authDeps();
	return {
		token,
		usable: token !== '' && (await emailTokenUsable(deps.db, 'representative_invite', token, deps.now()))
	};
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const result = await confirmRepresentativeContact(await authDeps(), requestMeta(event), formText(form, 'token'));
		if (!result.ok) return fail(400, { confirmed: false });
		return { confirmed: true };
	}
};
