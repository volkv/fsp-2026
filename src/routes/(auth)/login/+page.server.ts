import { fail, redirect } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { fspIdConfigured } from '$lib/server/auth/fsp-id';
import { formText, requestMeta, sessionOf, setSessionCookie } from '$lib/server/auth/http';
import { loginWithPassword, type LoginRefusal } from '$lib/server/auth/login';
import { safeReturnTo } from '$lib/server/auth/redirect';
import { config } from '$lib/server/config';
import { sessionOfBrowser } from '$lib/server/demo/visit';
import type { Actions, PageServerLoad } from './$types';

function minutes(seconds: number | null): number {
	return Math.max(1, Math.ceil((seconds ?? 60) / 60));
}

function refusalText(reason: LoginRefusal, retryAfterSeconds: number | null): string {
	switch (reason) {
		case 'invalid_credentials':
			return 'Неверная почта или пароль';
		case 'locked':
			return `Слишком много неудачных попыток: вход по паролю закрыт ещё на ${minutes(retryAfterSeconds)} мин. Можно восстановить пароль по почте или войти через ФСП ID`;
		case 'address_limited':
			return `Слишком много попыток входа с этого адреса. Повторите через ${minutes(retryAfterSeconds)} мин.`;
		case 'account_inactive':
			return 'Учётная запись недоступна: она приостановлена или удаляется';
		case 'demo_account':
			return 'Это учётка демо-сценария: демо-вход — через /demo, там для вас откроется своя копия героев';
	}
}

/** Refusals of a return from FSP ID, passed here as `?error=` by the callback. */
const FSP_ERRORS: Record<string, string> = {
	fsp_not_configured: 'Вход через ФСП ID на этом стенде не настроен',
	fsp_unavailable: 'ФСП ID сейчас недоступен. Повторите позже или войдите по почте',
	fsp_access_denied: 'Вход через ФСП ID отменён',
	fsp_state_invalid: 'Вход через ФСП ID устарел или начат в другом браузере. Начните заново',
	fsp_account_inactive: 'Учётная запись, привязанная к этому ФСП ID, недоступна',
	fsp_failed: 'Не удалось войти через ФСП ID. Начните заново',
	fsp_rate_limited: 'Слишком много попыток входа через ФСП ID с этого адреса. Повторите через несколько минут'
};

export const load: PageServerLoad = (event) => {
	const returnTo = safeReturnTo(event.url.searchParams.get('returnTo'));
	if (sessionOf(event)) redirect(303, returnTo ?? '/onboarding');
	const error = event.url.searchParams.get('error');
	return {
		returnTo,
		fspEnabled: fspIdConfigured(),
		notice: error === null ? null : (FSP_ERRORS[error] ?? FSP_ERRORS.fsp_failed)
	};
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const email = formText(form, 'email');
		const password = formText(form, 'password');
		const returnTo = safeReturnTo(formText(form, 'returnTo'));
		const deps = await authDeps();
		// On a demonstration stand an account registered within the browser's demo session is signed in to from it
		// (docs/domain.md, 19.3). A sign-in opens no session.
		const demoSession = config().demo === null ? null : await sessionOfBrowser(deps.db, event.cookies, deps.now());
		const result = await loginWithPassword(
			deps,
			requestMeta(event),
			{ email, password, demoSessionId: demoSession?.id ?? null },
			sessionOf(event)
		);
		if (!result.ok) {
			const status = result.reason === 'invalid_credentials' ? 400 : result.reason === 'demo_account' ? 403 : 429;
			return fail(status, { email, message: refusalText(result.reason, result.retryAfterSeconds) });
		}
		setSessionCookie(event.cookies, result.sessionId);
		redirect(303, returnTo ?? '/onboarding');
	}
};
