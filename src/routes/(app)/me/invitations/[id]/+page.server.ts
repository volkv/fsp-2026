import { fail } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { formText } from '$lib/server/auth/http';
import { candidateRequest } from '$lib/server/candidates/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { candidateInvitationCard } from '$lib/server/candidates/invitations';
import { reportHiring, type HiringReportInput } from '$lib/server/hiring/process';
import { OUTCOMES } from '$lib/server/hiring/state';
import { HIRING_STAGES } from '$lib/server/consent/kinds';
import { invitationDeps } from '$lib/server/invitations/deps';
import {
	resendDisclosureLetter,
	revokeDisclosureConsent,
	sendDisclosureLetter
} from '$lib/server/invitations/disclosure';
import { markInvitationViewed, respondToInvitation } from '$lib/server/invitations/respond';
import type { Actions, PageServerLoad } from './$types';

/**
 * One invitation: company, vacancy, range and deadline, every version with its differences; the answer to the current
 * version — accept with the chosen disclosure fields or decline with a reason; after acceptance the hiring process.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	try {
		return { card: await candidateInvitationCard(invitationDeps(), subject, event.params.id) };
	} catch (cause) {
		pageError(event, cause);
	}
};

const optional = (value: string) => (value.trim() === '' ? undefined : value.trim());

const LETTER_REFUSALS = {
	not_applicable: 'Письмо сейчас не нужно: принятие больше не ждёт представителя.',
	too_soon: 'Письмо только что отправлено — повторить можно через несколько минут.',
	not_sent: 'Письмо не удалось отправить: почтовый сервер недоступен. Повтори позже.'
} as const;

export const actions: Actions = {
	/** The page was opened in the browser: `sent → viewed`. A preload of the link does not count as opening. */
	viewed: async (event) => {
		const { subject } = await candidateRequest(event);
		try {
			await markInvitationViewed(invitationDeps(), subject, event.params.id);
		} catch (cause) {
			return formFailure(cause);
		}
		return { viewed: true };
	},

	accept: async (event) => {
		const { subject, meta, userId } = await candidateRequest(event);
		const form = await event.request.formData();
		let awaiting: boolean;
		try {
			const result = await respondToInvitation(invitationDeps(), subject, meta, event.params.id, {
				termsId: formText(form, 'termsId'),
				decision: 'accept',
				discloseFields: form.getAll('disclose_fields').filter((value): value is string => typeof value === 'string'),
				disclosureDocumentId: formText(form, 'disclosureDocumentId')
			});
			awaiting = result.awaitingRepresentative;
		} catch (cause) {
			return formFailure(cause);
		}
		if (!awaiting) return { accepted: true };
		// Aged 14–17: the acceptance waits for the legal representative, who answers by the link of this letter.
		const letter = await sendDisclosureLetter(await authDeps(), meta, { kind: 'user', userId }, event.params.id);
		return { awaitingRepresentative: true, letterSent: letter.ok };
	},

	/** The letter about the acceptance that waits for the representative, again. */
	resendRepresentative: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		try {
			const result = await resendDisclosureLetter(await authDeps(), meta, subject, event.params.id);
			if (!result.ok)
				return fail(409, { problem: { message: LETTER_REFUSALS[result.reason], fields: {}, code: result.reason } });
		} catch (cause) {
			return formFailure(cause);
		}
		return { letterResent: true };
	},

	decline: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const reasonCode = optional(formText(form, 'reason_code'));
		const reasonText = optional(formText(form, 'reason_text'));
		try {
			await respondToInvitation(invitationDeps(), subject, meta, event.params.id, {
				termsId: formText(form, 'termsId'),
				decision: 'decline',
				...(reasonCode === undefined ? {} : { reasonCode }),
				...(reasonText === undefined ? {} : { reasonText })
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { declined: true };
	},

	revokeDisclosure: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		try {
			await revokeDisclosureConsent(
				invitationDeps(),
				subject,
				meta,
				event.params.id,
				optional(formText(form, 'reason'))
			);
		} catch (cause) {
			return formFailure(cause);
		}
		return { disclosureRevoked: true };
	},

	report: async (event) => {
		const { subject, meta } = await candidateRequest(event);
		const form = await event.request.formData();
		const kind = formText(form, 'kind');
		const stage = HIRING_STAGES.find((value) => value === formText(form, 'stage'));
		const outcome = OUTCOMES.find((value) => value === formText(form, 'outcome'));
		const startDate = optional(formText(form, 'start_date'));
		const reasonCode = optional(formText(form, 'reason_code'));
		const supersedes = optional(formText(form, 'supersedes'));
		const input: HiringReportInput =
			kind === 'stage'
				? { party: 'candidate', kind: 'stage', ...(stage === undefined ? {} : { stage }) }
				: {
						party: 'candidate',
						kind: 'outcome',
						...(outcome === undefined ? {} : { outcome }),
						...(startDate === undefined || outcome !== 'hired' ? {} : { startDate }),
						...(reasonCode === undefined ? {} : { reasonCode })
					};
		try {
			await reportHiring(invitationDeps(), subject, meta, formText(form, 'processId'), {
				...input,
				...(supersedes === undefined ? {} : { supersedesReportId: supersedes })
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { reported: true };
	}
};
