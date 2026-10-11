import { error } from '@sveltejs/kit';
import { formText } from '$lib/server/http/form';
import { disclosingApplicationOfInvitation } from '$lib/server/applications/service';
import { db } from '$lib/server/db';
import { employerRequest, membershipOf, type EmployerRequest } from '$lib/server/employer/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { currentVocabulary, labelsOf } from '$lib/server/employer/vocabulary';
import { ApiError } from '$lib/server/errors/api-error';
import {
	companyInterviewFeedback,
	leaveInterviewFeedback,
	reviseInterviewFeedback,
	type InterviewFeedbackInput,
	type InterviewFeedbackOutcome,
	type InterviewLevel
} from '$lib/server/hiring/interview-feedback';
import { getHiringProcess, reportHiring, type HiringReportInput } from '$lib/server/hiring/process';
import { INTERVIEW_COMMENT_MAX, INTERVIEW_FEEDBACK_OUTCOMES, INTERVIEW_LEVELS } from '$lib/server/db/schema';
import { OUTCOMES, type Outcome, type Stage } from '$lib/server/hiring/state';
import { HIRING_STAGES } from '$lib/server/consent/kinds';
import { invitationDeps } from '$lib/server/invitations/deps';
import { recipientContacts } from '$lib/server/invitations/disclosure';
import { offerFormContext, offerFromForm, optionsOfPoints } from '$lib/server/invitations/offer-form';
import { getInvitation } from '$lib/server/invitations/read';
import { reviseInvitation, withdrawInvitation } from '$lib/server/invitations/send';
import { getConversation, markConversationRead, sendMessage } from '$lib/server/messages/conversation';
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
		const current = invitation.versions.find((version) => version.id === invitation.currentTermsId);
		if (!current) throw new Error(`invitation ${invitation.id} lost its current terms`);
		const vocabulary = await currentVocabulary(db());
		const [offer, process, interview, contacts, conversation, application] = await Promise.all([
			offerFormContext(db(), membership.companyId, vocabulary, now),
			invitation.hiringProcessId === null ? null : getHiringProcess(deps, subject, invitation.hiringProcessId),
			invitation.hiringProcessId === null ? null : companyInterviewFeedback(deps, subject, invitation.hiringProcessId),
			accepted && invitation.status === 'accepted' ? contactsOf(request, invitation.id) : null,
			getConversation(deps, subject, invitation.id),
			invitation.status === 'accepted' ? null : disclosingApplicationOfInvitation(db(), invitation.id, now)
		]);
		return {
			invitation,
			labels: labelsOf(vocabulary),
			offer,
			whyYouOptions: optionsOfPoints(current.whyYou),
			process,
			interview,
			interviewLevels: [...INTERVIEW_LEVELS],
			interviewOutcomes: [...INTERVIEW_FEEDBACK_OUTCOMES],
			interviewCommentMax: INTERVIEW_COMMENT_MAX,
			contacts,
			application,
			conversation,
			stages: [...HIRING_STAGES],
			outcomes: [...OUTCOMES],
			sent: event.url.searchParams.has('sent')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

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

const isLevel = (value: string): value is InterviewLevel => (INTERVIEW_LEVELS as readonly string[]).includes(value);
const isFeedbackOutcome = (value: string): value is InterviewFeedbackOutcome =>
	(INTERVIEW_FEEDBACK_OUTCOMES as readonly string[]).includes(value);
/** Selects of the block levels are named `block:<code>`; an empty one is a block left unjudged. */
const BLOCK_FIELD = 'block:';

/** The interview feedback from the form; a value outside the vocabularies is a malformed post. */
function feedbackInput(form: FormData, requestId: string): InterviewFeedbackInput {
	const level = formText(form, 'level');
	if (!isLevel(level)) error(400, { message: 'Неизвестный уровень', requestId });
	const outcome = formText(form, 'outcome');
	if (!isFeedbackOutcome(outcome)) error(400, { message: 'Неизвестный исход собеседования', requestId });
	const blockLevels: Record<string, InterviewLevel> = {};
	for (const [name, value] of form.entries()) {
		if (!name.startsWith(BLOCK_FIELD) || value === '') continue;
		if (typeof value !== 'string' || !isLevel(value)) error(400, { message: 'Неизвестный уровень блока', requestId });
		blockLevels[name.slice(BLOCK_FIELD.length)] = value;
	}
	const comment = formText(form, 'comment');
	return { level, outcome, blockLevels, comment: comment.trim() === '' ? null : comment };
}

export const actions: Actions = {
	revise: async (event) => {
		const { subject, meta, sessionHash } = await employerRequest(event);
		const form = await event.request.formData();
		try {
			const revised = await reviseInvitation(
				invitationDeps(),
				subject,
				{ ...meta, sessionHash },
				event.params.id,
				offerFromForm(form)
			);
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

	/** A message to the candidate in the conversation of the accepted invitation. */
	message: async (event) => {
		const { subject, meta, sessionHash } = await employerRequest(event);
		const form = await event.request.formData();
		try {
			await sendMessage(invitationDeps(), subject, { ...meta, sessionHash }, event.params.id, formText(form, 'text'));
		} catch (cause) {
			return formFailure(cause);
		}
		return { messageSent: true };
	},

	/** The conversation was opened in the browser: the candidate's messages are read. */
	readMessages: async (event) => {
		const { subject } = await employerRequest(event);
		try {
			await markConversationRead(invitationDeps(), subject, event.params.id);
		} catch (cause) {
			return formFailure(cause);
		}
		return { messagesRead: true };
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
	},

	/** The feedback on the interview against the confirmed grade: left once, corrected within the window. */
	interviewFeedback: async (event) => {
		const { subject, meta, sessionHash } = await employerRequest(event);
		const form = await event.request.formData();
		const input = feedbackInput(form, event.locals.requestId);
		const leave = formText(form, 'mode') === 'leave';
		try {
			await (leave ? leaveInterviewFeedback : reviseInterviewFeedback)(
				invitationDeps(),
				subject,
				{ ...meta, sessionHash },
				formText(form, 'processId'),
				input
			);
		} catch (cause) {
			return formFailure(cause);
		}
		return { interviewFeedback: leave ? 'left' : 'revised' };
	}
};
