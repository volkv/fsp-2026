import { error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { can } from '$lib/server/access/permissions';
import { ownAttemptAnnulment } from '$lib/server/assessments/annul';
import { answerItem, type AnswerPayload } from '$lib/server/assessments/engine';
import { readClientSignals } from '$lib/server/assessments/signals';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { parseStatement } from '$lib/server/assessments/statement';
import { attemptState } from '$lib/server/assessments/views';
import { candidateRequest, type CandidateRequest } from '$lib/server/candidates/http';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import type { Actions, PageServerLoad } from './$types';

const attemptIdOf = (event: RequestEvent): string => {
	const parsed = z.uuid().safeParse(event.params.attemptId);
	if (!parsed.success) error(404, { message: 'Попытка не найдена', requestId: event.locals.requestId });
	return parsed.data;
};

/**
 * One attempt as its candidate takes it: the current cluster with its statement and the form of its answer, the
 * clusters answered so far with the candidate's own answers, the deadline, and — for an annulled one — why.
 */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	const attemptId = attemptIdOf(event);
	try {
		const [attempt, annulment] = await Promise.all([
			attemptState(db(), subject, attemptId, new Date()),
			ownAttemptAnnulment(db(), subject, attemptId)
		]);
		return {
			attempt: {
				...attempt,
				items: attempt.items.map((item) => ({
					...item,
					blocks: parseStatement(item.statement.markdown),
					stepBlocks: item.changeStep ? parseStatement(item.changeStep.markdown) : null
				}))
			},
			annulment
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

async function writer(event: RequestEvent): Promise<CandidateRequest> {
	const request = await candidateRequest(event);
	const access = can(request.subject, 'candidate.self.write', { candidateId: request.candidateId });
	if (!access.allowed) error(403, { message: 'Недостаточно прав', requestId: event.locals.requestId });
	return request;
}

const text = (form: FormData, name: string): string => {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
};

/** The filled rows of QA test cases. */
function casesOf(form: FormData): { input: string; expected: string }[] {
	const inputs = form.getAll('case_input').map(String);
	const expected = form.getAll('case_expected').map(String);
	return inputs
		.map((input, i) => ({ input, expected: expected[i] ?? '' }))
		.filter((c) => c.input.trim() !== '' || c.expected.trim() !== '');
}

/** The answer of the form by its mode; the engine checks it against the cluster. */
function payloadOf(form: FormData): AnswerPayload | null {
	switch (text(form, 'mode')) {
		case 'answer':
			return { kind: 'answer', answer: text(form, 'answer') };
		case 'code':
			return { kind: 'code', language: text(form, 'language'), source: text(form, 'source') };
		case 'step_code':
			return { kind: 'change_step_code', language: text(form, 'language'), source: text(form, 'source') };
		case 'cases':
			return { kind: 'cases', cases: casesOf(form) };
		case 'step_cases':
			return { kind: 'change_step_cases', cases: casesOf(form) };
		default:
			return null;
	}
}

export const actions: Actions = {
	answer: async (event) => {
		const { subject, meta } = await writer(event);
		const attemptId = attemptIdOf(event);
		const form = await event.request.formData();
		const seq = Number(text(form, 'seq'));
		const payload = payloadOf(form);
		const signals = readClientSignals(text(form, 'signals') || null);
		if (!Number.isInteger(seq) || seq < 1 || payload === null || signals === 'invalid') {
			error(400, { message: 'Форма ответа повреждена: обновите страницу', requestId: meta.requestId });
		}
		try {
			const result = await answerItem(
				db(),
				{ standing: OWNER_STANDING },
				subject,
				{ attemptId, seq, payload, signals },
				{ now: new Date(), requestId: meta.requestId }
			);
			const outcome = result.outcome.kind === 'pending' ? result.outcome.next : result.outcome;
			return { answered: seq, decisionId: outcome.kind === 'decided' ? outcome.decisionId : null };
		} catch (cause) {
			return formFailure(cause);
		}
	}
};
