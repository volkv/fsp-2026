import { error } from '@sveltejs/kit';
import { formText } from '$lib/server/auth/http';
import { db } from '$lib/server/db';
import { employerRequest, membershipOf, type EmployerRequest } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { getOwnVacancy } from '$lib/server/employer/vacancies';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { ApiError } from '$lib/server/errors/api-error';
import { getHiringProcess, reportHiring, type HiringReportInput } from '$lib/server/hiring/process';
import { OUTCOMES, type Outcome, type Stage } from '$lib/server/hiring/state';
import { HIRING_STAGES } from '$lib/server/consent/kinds';
import { invitationDeps } from '$lib/server/invitations/deps';
import { recipientContacts } from '$lib/server/invitations/disclosure';
import { currentPolicy } from '$lib/server/invitations/policies';
import { getInvitation } from '$lib/server/invitations/read';
import { reviseInvitation, withdrawInvitation } from '$lib/server/invitations/send';
import type { Actions, PageServerLoad } from './$types';

/** The disclosed contacts of an accepted invitation; `null` — the candidate's disclosure consent is not in effect. */
async function contactsOf(request: EmployerRequest, invitationId: string) {
	const { subject, meta, sessionHash } = request;
	try {
		return await recipientContacts(invitationDeps(), subject, { ...meta, sessionHash }, invitationId);
	} catch (cause) {
		// After acceptance the contacts close again when the candidate revokes the disclosure (domain 6.5).
		if (cause instanceof ApiError && cause.code === 'not_found') return null;
		throw cause;
	}
}

export const load: PageServerLoad = async (event) => {
	const request = await employerRequest(event);
	const { subject } = request;
	const membership = membershipOf(event, subject);
	const deps = invitationDeps();
	const now = new Date();
	try {
		const invitation = await getInvitation(deps, subject, event.params.id);
		const accepted = invitation.acceptedTermsId !== null;
		const [vacancy, vocabulary, policy, process, contacts] = await Promise.all([
			getOwnVacancy(db(), membership.companyId, invitation.vacancyId, now),
			currentVocabulary(db()),
			currentPolicy(db(), 'invitation_policy', now),
			invitation.hiringProcessId === null ? null : getHiringProcess(deps, subject, invitation.hiringProcessId),
			accepted && invitation.status === 'accepted' ? contactsOf(request, invitation.id) : null
		]);
		return {
			invitation,
			vacancy: { id: vacancy.id, title: vacancy.title, status: vacancy.status, salary: vacancy.salary },
			labels: labelsOf(vocabulary),
			responseWindowHours: policy?.params.response_window_hours ?? null,
			process,
			contacts,
			stages: [...HIRING_STAGES],
			outcomes: [...OUTCOMES],
			sent: event.url.searchParams.has('sent')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

const amount = (value: string) => Number(value.replace(/\s/gu, ''));

const isStage = (value: string): value is Stage => (HIRING_STAGES as readonly string[]).includes(value);
const isOutcome = (value: string): value is Outcome => (OUTCOMES as readonly string[]).includes(value);

/** The report of the company side from the form; a value outside the vocabularies is a malformed post. */
function reportInput(form: FormData, requestId: string): HiringReportInput {
	const kind = formText(form, 'kind');
	if (kind === 'stage') {
		const stage = formText(form, 'stage');
		if (!isStage(stage)) error(400, { message: 'Неизвестный этап', requestId });
		return { party: 'company', kind, stage };
	}
	if (kind === 'outcome') {
		const outcome = formText(form, 'outcome');
		if (!isOutcome(outcome)) error(400, { message: 'Неизвестный исход', requestId });
		const startDate = formText(form, 'startDate');
		return { party: 'company', kind, outcome, ...(startDate === '' ? {} : { startDate }) };
	}
	error(400, { message: 'Неизвестный вид сообщения', requestId });
}

export const actions: Actions = {
	revise: async (event) => {
		const { subject, meta, sessionHash } = await employerRequest(event);
		const form = await event.request.formData();
		try {
			const revised = await reviseInvitation(invitationDeps(), subject, { ...meta, sessionHash }, event.params.id, {
				salaryMin: amount(formText(form, 'salaryMin')),
				salaryMax: amount(formText(form, 'salaryMax')),
				message: formText(form, 'message')
			});
			return { revised: { version: revised.version, lowered: revised.changes.salary_lowered } };
		} catch (cause) {
			return formFailure(cause);
		}
	},

	withdraw: async (event) => {
		const { subject, meta, sessionHash } = await employerRequest(event);
		try {
			await withdrawInvitation(invitationDeps(), subject, { ...meta, sessionHash }, event.params.id);
		} catch (cause) {
			return formFailure(cause);
		}
		return { withdrawn: true };
	},

	report: async (event) => {
		const { subject, meta, sessionHash } = await employerRequest(event);
		const form = await event.request.formData();
		const input = reportInput(form, event.locals.requestId);
		try {
			await reportHiring(invitationDeps(), subject, { ...meta, sessionHash }, formText(form, 'processId'), input);
		} catch (cause) {
			return formFailure(cause);
		}
		return { reported: input.kind };
	}
};
