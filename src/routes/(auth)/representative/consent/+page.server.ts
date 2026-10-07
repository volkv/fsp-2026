import { fail } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { requestMeta } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import {
	REPRESENTATIVE_CONSENT_KINDS,
	representativeConsentForm,
	revokeConsentsByRepresentative,
	signConsentsByRepresentative,
	type RepresentativeConsentKind
} from '$lib/server/consent/representative';
import type { Actions, PageServerLoad } from './$types';

/**
 * The legal representative whose authority the operator verified signs and revokes the consents of the ward by the
 * link of the letter (domain 6.3, 6.4, 19.1): each text on its own, the processing consent required; a revocation is
 * confirmed after its consequences are shown.
 */
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token') ?? '';
	const deps = await authDeps();
	return {
		token,
		form: token === '' ? null : await representativeConsentForm(deps.db, deps.crypto, token, deps.now())
	};
};

const INVALID_LINK =
	'Ссылка недействительна: она устарела или уже использована. Новое письмо можно запросить по адресу почты.';

const SIGN_REFUSALS = {
	invalid_link: INVALID_LINK,
	nothing_chosen: 'Отметьте согласия, которые подписываете.',
	processing_required: 'Без согласия на обработку персональных данных профиль не ведётся: отметьте его.',
	document_changed: 'Текст согласия обновился — прочитайте новую редакцию и подпишите снова.'
} as const;

const REVOKE_REFUSALS = {
	invalid_link: INVALID_LINK,
	nothing_chosen: 'Отметьте согласия, которые отзываете.',
	not_signed: 'Отмеченные согласия уже не действуют с вашей стороны: отзывать нечего.',
	deletion_refused: 'Профиль нельзя удалить по ссылке: обратитесь к оператору ФСП.'
} as const;

function chosenKinds(form: FormData, name: string): RepresentativeConsentKind[] {
	const marked = form.getAll(name);
	return REPRESENTATIVE_CONSENT_KINDS.filter((kind) => marked.includes(kind));
}

export const actions: Actions = {
	sign: async (event) => {
		const form = await event.request.formData();
		const chosen: Partial<Record<RepresentativeConsentKind, string>> = {};
		for (const kind of chosenKinds(form, 'consent')) chosen[kind] = formText(form, `document_${kind}`);
		const deps = await authDeps();
		const result = await signConsentsByRepresentative(deps, requestMeta(event), formText(form, 'token'), chosen);
		if (!result.ok) {
			return fail(result.reason === 'invalid_link' ? 400 : 409, { message: SIGN_REFUSALS[result.reason] });
		}
		return { signed: result.signed, letterSent: result.letterSent };
	},
	/**
	 * The first post names the consents and shows what their revocation does; the second, with `confirmed`, revokes.
	 * The link is used only by the second.
	 */
	revoke: async (event) => {
		const form = await event.request.formData();
		const kinds = chosenKinds(form, 'revoke');
		if (kinds.length === 0) return fail(409, { message: REVOKE_REFUSALS.nothing_chosen });
		if (formText(form, 'confirmed') !== 'yes') return { confirm: kinds };
		const deps = await authDeps();
		const result = await revokeConsentsByRepresentative(deps, requestMeta(event), formText(form, 'token'), kinds);
		if (!result.ok) {
			return fail(result.reason === 'invalid_link' ? 400 : 409, { message: REVOKE_REFUSALS[result.reason] });
		}
		return { revoked: result.revoked, profileDeleted: result.profileDeleted, letterSent: result.letterSent };
	}
};
