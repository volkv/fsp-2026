import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { ANNUL_REASONS, annulAttempt, type AnnulOutcome } from '$lib/server/assessments/annul';
import { attemptForReview } from '$lib/server/assessments/review';
import { parseStatement } from '$lib/server/assessments/statement';
import { formText } from '$lib/server/auth/http';
import { invalid } from '$lib/server/companies/context';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import type { Actions, PageServerLoad } from './$types';

/** One attempt in full for the operator: the version, the code or the answers, every test, the scores and the facts. */
export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	const attemptId = z.uuid().safeParse(event.params.id);
	if (!attemptId.success) error(404, { message: 'Попытка не найдена', requestId: event.locals.requestId });
	try {
		const review = await attemptForReview(db(), subject, attemptId.data, meta.requestId);
		const { version } = review;
		return {
			attempt: {
				id: review.attempt.id,
				status: review.attempt.status,
				startedAt: review.attempt.startedAt,
				submittedAt: review.attempt.submittedAt,
				deadlineAt: review.attempt.deadlineAt,
				annulledAt: review.attempt.annulledAt,
				annulReason: review.attempt.annulReason
			},
			version: {
				title: version.title,
				kind: version.kind,
				version: version.version,
				status: version.status,
				contentSha256: version.contentSha256,
				statement: version.kind === 'code_task' ? parseStatement(version.itemBank.statement) : null
			},
			scores: review.scores.map((score) => ({
				id: score.id,
				score: Number(score.score),
				maxScore: Number(score.maxScore),
				level: score.level,
				scoredBy: score.scoredBy,
				scorerVersion: score.scorerVersion,
				createdAt: score.createdAt,
				current: score.id === review.current?.id
			})),
			facts: review.facts,
			code: review.code,
			quiz: review.quiz,
			cleared: review.cleared,
			signals: review.signals.entries,
			reasons: ANNUL_REASONS,
			done: event.url.searchParams.get('done')
		};
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	annul: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		const form = await event.request.formData();
		const reason = ANNUL_REASONS.find((value) => value === formText(form, 'reason'));
		let outcome: AnnulOutcome;
		try {
			if (reason === undefined) {
				throw invalid([{ path: 'reason', code: 'required', message: 'Выберите причину аннулирования' }]);
			}
			outcome = await annulAttempt(db(), subject, meta, event.params.id, reason, new Date());
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `${event.url.pathname}?done=${outcome.annulled ? 'annulled' : 'already'}`);
	}
};
