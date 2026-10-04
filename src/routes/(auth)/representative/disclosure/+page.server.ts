import { fail } from '@sveltejs/kit';
import { formText, requestMeta } from '$lib/server/auth/http';
import { ApiError } from '$lib/server/errors/api-error';
import { invitationDeps } from '$lib/server/invitations/deps';
import {
	declineDisclosureByRepresentative,
	grantDisclosureByRepresentative,
	representativeDisclosureRequest
} from '$lib/server/invitations/disclosure';
import { Refusal } from '$lib/server/invitations/errors';
import type { Actions, PageServerLoad } from './$types';

/**
 * The legal representative answers on the disclosure of one invitation the ward accepted (domain 6.3, 6.4, 13.6):
 * the company, the vacancy, the range, the contacts and the text of the consent; «согласен» completes the acceptance,
 * «не согласен» declines it.
 */
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token') ?? '';
	return {
		token,
		request: token === '' ? null : await representativeDisclosureRequest(invitationDeps(), token)
	};
};

const REFUSALS: Record<string, string> = {
	invalid_link: 'Ссылка недействительна: она устарела или уже использована.',
	disclosure_document_changed: 'Текст согласия обновился — прочитайте новую редакцию и ответьте снова.',
	vacancy_closed: 'Вакансия закрыта: отвечать на приглашение больше не нужно.'
};

const CLOSED =
	'Ответ больше не нужен: приглашение изменилось, закрылось или истёк срок ответа, либо кандидат отменил принятие.';

function refused(cause: unknown) {
	if (cause instanceof Refusal) return fail(cause.status, { message: REFUSALS[cause.reason] ?? CLOSED });
	if (cause instanceof ApiError) return fail(cause.status, { message: cause.message });
	throw cause;
}

export const actions: Actions = {
	grant: async (event) => {
		const form = await event.request.formData();
		try {
			await grantDisclosureByRepresentative(invitationDeps(), requestMeta(event), {
				token: formText(form, 'token'),
				documentId: formText(form, 'documentId')
			});
		} catch (cause) {
			return refused(cause);
		}
		return { answered: 'grant' as const };
	},
	decline: async (event) => {
		const form = await event.request.formData();
		try {
			await declineDisclosureByRepresentative(invitationDeps(), requestMeta(event), {
				token: formText(form, 'token')
			});
		} catch (cause) {
			return refused(cause);
		}
		return { answered: 'decline' as const };
	}
};
