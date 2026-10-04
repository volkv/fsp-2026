import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { authDeps } from '$lib/server/auth/context';
import { fspIdConfigured } from '$lib/server/auth/fsp-id';
import { formText, requestMeta, requireSession, setSessionCookie } from '$lib/server/auth/http';
import { reauthenticate } from '$lib/server/auth/login';
import { safeReturnTo } from '$lib/server/auth/redirect';
import { passwordCredentials } from '$lib/server/db/schema';
import type { Actions, PageServerLoad } from './$types';

/** A fresh authentication for a sensitive operation (domain 3.4): the password again, or FSP ID with a new login. */
export const load: PageServerLoad = async (event) => {
	const session = requireSession(event);
	const deps = await authDeps();
	const [credential] = await deps.db
		.select({ userId: passwordCredentials.userId })
		.from(passwordCredentials)
		.where(eq(passwordCredentials.userId, session.userId));
	return {
		hasPassword: credential !== undefined,
		fspEnabled: fspIdConfigured(),
		returnTo: safeReturnTo(event.url.searchParams.get('returnTo')) ?? '/account'
	};
};

export const actions: Actions = {
	default: async (event) => {
		const session = requireSession(event);
		const form = await event.request.formData();
		const returnTo = safeReturnTo(formText(form, 'returnTo')) ?? '/account';
		const result = await reauthenticate(await authDeps(), requestMeta(event), session, formText(form, 'password'));
		if (!result.ok) {
			const message = {
				invalid_credentials: 'Неверный пароль',
				locked: 'Слишком много неудачных попыток: вход по паролю временно закрыт',
				no_password: 'У учётной записи нет пароля: подтвердите вход через ФСП ID'
			}[result.reason];
			return fail(400, { message });
		}
		setSessionCookie(event.cookies, result.sessionId);
		redirect(303, returnTo);
	}
};
