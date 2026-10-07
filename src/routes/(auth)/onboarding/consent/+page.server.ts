import { fail, redirect } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { currentDocument } from '$lib/server/auth/documents';
import { requestMeta, requireSession } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import { grantProfileConsent, onboardingState } from '$lib/server/auth/onboarding';
import type { Actions, PageServerLoad } from './$types';

/** The personal-data consent on its own screen (domain 6.2, `pd_processing`: ч. 1 ст. 9 152-ФЗ). */
export const load: PageServerLoad = async (event) => {
	const session = requireSession(event);
	const deps = await authDeps();
	const state = await onboardingState(deps, session.userId);
	if (state.candidate?.status !== 'onboarding') redirect(303, '/onboarding');
	const document = await currentDocument(deps.db, 'pd_processing', deps.now());
	return {
		minor: state.candidate.minor,
		document:
			document?.available === true
				? { id: document.id, title: document.title, version: document.version, body: document.body }
				: null
	};
};

export const actions: Actions = {
	default: async (event) => {
		const session = requireSession(event);
		const form = await event.request.formData();
		const result = await grantProfileConsent(
			await authDeps(),
			requestMeta(event),
			session,
			formText(form, 'documentId')
		);
		if (!result.ok) {
			return fail(409, {
				message:
					result.reason === 'document_changed'
						? 'Текст согласия обновился — прочитайте новую редакцию'
						: 'Согласие на этом шаге уже не требуется'
			});
		}
		redirect(303, '/onboarding');
	}
};
