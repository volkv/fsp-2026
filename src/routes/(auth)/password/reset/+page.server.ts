import { fail } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { emailTokenUsable } from '$lib/server/auth/email-tokens';
import { clearSessionCookie, requestMeta } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import { resetPassword } from '$lib/server/auth/recovery';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token') ?? '';
	const deps = await authDeps();
	return { token, usable: token !== '' && (await emailTokenUsable(deps.db, 'reset_password', token, deps.now())) };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		if (formText(form, 'password') !== formText(form, 'repeat')) return fail(400, { message: 'Пароли не совпадают' });
		const result = await resetPassword(
			await authDeps(),
			requestMeta(event),
			formText(form, 'token'),
			formText(form, 'password')
		);
		if (!result.ok) {
			return fail(400, {
				message:
					result.reason === 'weak'
						? result.problems.join('. ')
						: 'Ссылка недействительна: она устарела или уже использована. Запросите новую.'
			});
		}
		// Every session of the account has ended, this browser's included.
		clearSessionCookie(event.cookies);
		return { reset: true };
	}
};
