import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { startAttempt } from '$lib/server/assessments/attempts';
import { submitCode } from '$lib/server/assessments/code';
import { answerQuizItem } from '$lib/server/assessments/quiz';
import { readClientSignals, type ClientSignals } from '$lib/server/assessments/signals';
import { candidateAssessment } from '$lib/server/assessments/views';
import { formText } from '$lib/server/auth/http';
import { candidateRequest } from '$lib/server/candidates/http';
import { formFailure, pageError } from '$lib/server/http/page';
import { currentCandidateVocabulary, vocabularyLabels } from '$lib/server/candidates/vocabulary';
import { db } from '$lib/server/db';
import { ApiError } from '$lib/server/errors/api-error';
import type { Actions, PageServerLoad } from './$types';

const uuid = z.uuid();

function assessmentIdOf(event: RequestEvent): string {
	const parsed = uuid.safeParse(event.params.assessmentId);
	if (!parsed.success) error(404, { message: 'Задание не найдено', requestId: event.locals.requestId });
	return parsed.data;
}

/** An attempt of the form must be an identifier; anything else is a malformed request. */
function attemptIdOf(form: FormData): string {
	const parsed = uuid.safeParse(formText(form, 'attemptId'));
	if (!parsed.success) throw new ApiError('validation_failed', { message: 'Попытка не указана' });
	return parsed.data;
}

function signalsOf(form: FormData): ClientSignals | null {
	const signals = readClientSignals(typeof form.get('signals') === 'string' ? formText(form, 'signals') : null);
	if (signals === 'invalid') throw new ApiError('validation_failed', { message: 'Сигналы попытки в неверном формате' });
	return signals;
}

/** The assessment with its statement or current question, the attempt in progress and the attempt history. */
export const load: PageServerLoad = async (event) => {
	const { subject } = await candidateRequest(event);
	const assessmentId = assessmentIdOf(event);
	try {
		const [detail, vocabulary] = await Promise.all([
			candidateAssessment(db(), subject, assessmentId, new Date()),
			currentCandidateVocabulary(db())
		]);
		return { detail, skills: vocabularyLabels(vocabulary).skills };
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	start: async (event) => {
		const { subject } = await candidateRequest(event);
		const assessmentId = assessmentIdOf(event);
		try {
			await startAttempt(db(), subject, assessmentId, new Date());
		} catch (cause) {
			return formFailure(cause);
		}
		return { started: true };
	},

	submit: async (event) => {
		const { subject } = await candidateRequest(event);
		const form = await event.request.formData();
		let attemptId: string;
		try {
			attemptId = attemptIdOf(form);
			await submitCode(
				db(),
				subject,
				attemptId,
				{ language: formText(form, 'language'), source: formText(form, 'source'), signals: signalsOf(form) },
				new Date()
			);
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `/me/tests/attempts/${attemptId}`);
	},

	answer: async (event) => {
		const { subject } = await candidateRequest(event);
		const form = await event.request.formData();
		let attemptId: string;
		let finished: boolean;
		try {
			attemptId = attemptIdOf(form);
			({ finished } = await answerQuizItem(
				db(),
				subject,
				attemptId,
				{ itemId: formText(form, 'itemId'), optionId: formText(form, 'option'), signals: signalsOf(form) },
				new Date(),
				event.locals.requestId
			));
		} catch (cause) {
			return formFailure(cause);
		}
		if (finished) redirect(303, `/me/tests/attempts/${attemptId}`);
		return { answered: true };
	}
};
