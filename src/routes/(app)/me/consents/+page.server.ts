import { fail } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { requestMeta, requireSession } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import { grantProfileConsent } from '$lib/server/auth/onboarding';
import { fspImportConsentState, processingConsentState, revokeFspImportConsent } from '$lib/server/candidates/consents';
import { candidateRequest } from '$lib/server/candidates/http';
import { representativeOverview, resendConsentLetter } from '$lib/server/consent/representative';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import { invitationDeps } from '$lib/server/invitations/deps';
import { resendDisclosureLetter } from '$lib/server/invitations/disclosure';
import { candidateInvitationList } from '$lib/server/candidates/invitations';
import type { Actions, PageServerLoad } from './$types';

/**
 * «Согласия»: the ground of processing the profile and who signed it. An adult whose own consent is not in force —
 * signed during minority, or a new text requires consenting again — signs it here. A candidate aged 14–17 sees the
 * side of the legal representative for every consent, asks for the letter again, and sees the invitations whose
 * acceptance waits for the representative. Here the import of FSP achievements is revoked; revoking the processing
 * consent deletes the profile, so it leads to the deletion of the account (domain 19.1).
 */
export const load: PageServerLoad = async (event) => {
	const { subject, candidateId } = await candidateRequest(event);
	try {
		const database = db();
		const now = new Date();
		const processing = await processingConsentState(database, candidateId, now);
		const minor = processing.regime === 'minor';
		const waiting = minor
			? (await candidateInvitationList(invitationDeps(), subject)).filter((item) => item.awaitingRepresentative)
			: [];
		return {
			regime: processing.regime,
			processing: {
				ownSigned: processing.ownSigned,
				effective: processing.effective,
				document: processing.document
			},
			fsp: await fspImportConsentState(database, candidateId, now),
			representative: minor ? await representativeOverview(database, candidateId, now) : null,
			waiting: waiting.map((item) => ({
				id: item.id,
				companyName: item.companyName,
				vacancyTitle: item.vacancyTitle,
				responseDueAt: item.responseDueAt
			}))
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

const LETTER_REFUSALS = {
	not_applicable: 'Письмо сейчас не нужно: полномочия представителя не подтверждены или запрос уже не действует.',
	too_soon: 'Письмо только что отправлено — повторить можно через несколько минут.',
	not_sent: 'Письмо не удалось отправить: почтовый сервер недоступен. Повторите позже.'
} as const;

export const actions: Actions = {
	/** The candidate signs the processing consent again: after 18, or when a new text requires it. */
	renew: async (event) => {
		await candidateRequest(event);
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
						: 'Ваше согласие уже действует'
			});
		}
		return { renewed: true };
	},

	/** The candidate revokes the import of FSP achievements: the facts leave the profile at once. */
	revokeFsp: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			const withdrawn = await revokeFspImportConsent(db(), subject, meta, formText(form, 'reason'));
			return { fspRevoked: withdrawn };
		} catch (cause) {
			return formFailure(cause);
		}
	},

	/** The letter with the consents to the verified representative, again. */
	resend: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const result = await resendConsentLetter(await authDeps(), meta, subject);
		if (!result.ok) return fail(409, { message: LETTER_REFUSALS[result.reason] });
		return { resent: true };
	},

	/** The letter about an acceptance that waits for the representative, again. */
	resendDisclosure: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			const result = await resendDisclosureLetter(await authDeps(), meta, subject, formText(form, 'invitationId'));
			if (!result.ok) return fail(409, { message: LETTER_REFUSALS[result.reason] });
		} catch (cause) {
			return formFailure(cause);
		}
		return { resent: true };
	}
};
