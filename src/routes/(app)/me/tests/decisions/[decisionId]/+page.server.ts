import { error, fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { can } from '$lib/server/access/permissions';
import { judgementNote } from '$lib/server/assessments/explain';
import { gradeTitle } from '$lib/server/assessments/titles';
import { decisionView } from '$lib/server/assessments/views';
import { formText } from '$lib/server/auth/http';
import { candidateRequest, type CandidateRequest } from '$lib/server/candidates/http';
import {
	OBJECTION_CLOSED_TEXTS,
	OBJECTION_DECISIONS,
	OBJECTION_REASON_MAX_LENGTH,
	candidateObjections,
	objectionWindow,
	openObjection,
	withdrawObjection,
	type ObjectionWindow
} from '$lib/server/categories/objections';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

function decisionIdOf(event: RequestEvent): string {
	const decisionId = z.uuid().safeParse(event.params.decisionId);
	if (!decisionId.success) error(404, { message: 'Решение не найдено', requestId: event.locals.requestId });
	return decisionId.data;
}

/** Whether the form of a new objection is shown: one open objection per decision, within the term of the rule. */
type Intake = { state: 'active' } | { state: 'open'; until: string } | { state: 'closed'; text: string };

function intake(active: boolean, term: ObjectionWindow): Intake {
	if (active) return { state: 'active' };
	if (term.open) return { state: 'open', until: term.until.toISOString() };
	return { state: 'closed', text: OBJECTION_CLOSED_TEXTS[term.reason] };
}

/**
 * The decision on a grade with its explanation by blocks (ч. 3 ст. 16 152-ФЗ), what the policy offers next and the
 * objections to it (ч. 4 ст. 16): the ones filed, and whether a new one is taken now.
 */
export const load: PageServerLoad = async (event) => {
	const { subject, candidateId } = await candidateRequest(event);
	const decisionId = decisionIdOf(event);
	try {
		const executor = db();
		const now = new Date();
		const view = await decisionView(executor, subject, decisionId, now);
		const [objected, objections] = await Promise.all([
			OBJECTION_DECISIONS.find(executor, decisionId),
			candidateObjections(executor, candidateId)
		]);
		if (!objected) throw new Error(`decision ${decisionId} read by its view is missing for objections`);
		const own = objections.filter((objection) => objection.decisionId === decisionId);
		const term = objectionWindow(objected, now);
		const active = own.some((objection) => objection.status === 'open' || objection.status === 'in_review');
		return {
			decision: {
				...view,
				judgementNote: judgementNote(view.judgement),
				next: view.next.map((option) => ({
					grade: option.grade,
					title: gradeTitle(option.grade),
					available: option.available,
					reason: option.available ? null : option.reason,
					availableFrom: option.available ? null : (option.availableFrom ?? null)
				}))
			},
			objections: own.map((objection) => ({
				id: objection.id,
				status: objection.status,
				reason: objection.reason,
				outcome: objection.outcome,
				resolution: objection.resolution,
				openedAt: objection.openedAt.toISOString(),
				dueAt: objection.dueAt.toISOString()
			})),
			intake: intake(active, term),
			reasonMaxLength: OBJECTION_REASON_MAX_LENGTH
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

/** Objecting and withdrawing are the candidate's own writes: `candidate.self.write` (domain 12.5). */
async function writer(event: RequestEvent): Promise<CandidateRequest> {
	const request = await candidateRequest(event);
	const access = can(request.subject, 'candidate.self.write', { candidateId: request.candidateId });
	if (!access.allowed) error(403, { message: 'Недостаточно прав', requestId: event.locals.requestId });
	return request;
}

export const actions: Actions = {
	object: async (event) => {
		const { candidateId, userId, meta } = await writer(event);
		const decisionId = decisionIdOf(event);
		const form = await event.request.formData();
		const reason = formText(form, 'reason');
		try {
			await openObjection(db(), OBJECTION_DECISIONS, {
				candidateId,
				userId,
				decisionId,
				reason,
				requestId: meta.requestId,
				now: new Date()
			});
		} catch (cause) {
			// The text typed stays in the form next to the refusal.
			const failure = formFailure(cause);
			return fail(failure.status, { ...failure.data, reason });
		}
		return { objectionOpened: true };
	},
	withdraw: async (event) => {
		const { candidateId, userId, meta } = await writer(event);
		const form = await event.request.formData();
		try {
			await withdrawObjection(db(), {
				objectionId: formText(form, 'objectionId'),
				candidateId,
				userId,
				requestId: meta.requestId
			});
		} catch (cause) {
			return formFailure(cause);
		}
		return { objectionWithdrawn: true };
	}
};
