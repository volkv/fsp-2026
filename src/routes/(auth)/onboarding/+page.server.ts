import { fail, redirect } from '@sveltejs/kit';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { authDeps } from '$lib/server/auth/context';
import { requireSession } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import { onboardingState, redeclareBirthDate } from '$lib/server/auth/onboarding';
import { resendVerification } from '$lib/server/auth/verification';
import type { Actions, PageServerLoad } from './$types';

/** Titles of the catalog by key, for the steps of the survey and the grade. */
function titles<K extends string>(entries: readonly { key: K; title: string }[]): Record<K, string> {
	const out = {} as Record<K, string>;
	for (const entry of entries) out[entry.key] = entry.title;
	return out;
}

export const load: PageServerLoad = async (event) => {
	const session = requireSession(event);
	const deps = await authDeps();
	const state = await onboardingState(deps, session.userId);
	if (state.complete && event.url.searchParams.size === 0) redirect(303, '/account');
	return {
		state,
		specializationTitles: titles(CATALOG.specializations),
		gradeTitles: titles(CATALOG.grades),
		today: deps.now().toISOString().slice(0, 10),
		letterFailed: event.url.searchParams.get('letter') === 'failed',
		representativeSent: event.url.searchParams.get('representative')
	};
};

export const actions: Actions = {
	resend: async (event) => {
		const session = requireSession(event);
		const result = await resendVerification(await authDeps(), session.userId);
		if (result.ok) return { resent: true };
		const message = {
			already_verified: 'Почта уже подтверждена',
			too_soon: 'Письмо только что отправлено. Повторить можно через минуту',
			not_sent: 'Почтовый сервер не принял письмо. Повторите через минуту'
		}[result.reason];
		return fail(result.reason === 'not_sent' ? 503 : 429, { message });
	},

	birthDate: async (event) => {
		const session = requireSession(event);
		const form = await event.request.formData();
		const result = await redeclareBirthDate(await authDeps(), session, formText(form, 'birthDate'));
		if (!result.ok) {
			return fail(400, {
				message: result.reason === 'invalid_date' ? 'Укажите настоящую дату рождения' : 'Этот шаг сейчас недоступен'
			});
		}
		redirect(303, '/onboarding');
	}
};
