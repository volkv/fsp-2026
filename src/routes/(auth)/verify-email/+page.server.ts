import { fail } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { emailTokenUsable } from '$lib/server/auth/email-tokens';
import { formText, requestMeta } from '$lib/server/auth/http';
import { verifyEmail } from '$lib/server/auth/verification';
import type { Actions, PageServerLoad } from './$types';

/**
 * The link of the letter opens a page with a button: mail scanners follow links, and a GET that used the token up
 * would confirm the address without the person.
 */
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token') ?? '';
	const deps = await authDeps();
	return { token, usable: token !== '' && (await emailTokenUsable(deps.db, 'verify_email', token, deps.now())) };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const result = await verifyEmail(await authDeps(), requestMeta(event), formText(form, 'token'));
		if (!result.ok) return fail(400, { verified: false });
		return { verified: true };
	}
};
