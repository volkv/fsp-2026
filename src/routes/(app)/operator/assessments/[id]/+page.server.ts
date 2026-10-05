import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { OPERATOR_ANNUL_REASONS, annulAttempt, type AnnulOutcome } from '$lib/server/assessments/annul';
import type { BlockSummary } from '$lib/server/assessments/contract/procedure';
import { explainDecision } from '$lib/server/assessments/explain';
import { attemptForReview } from '$lib/server/assessments/review';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { formText } from '$lib/server/auth/http';
import { invalid } from '$lib/server/companies/context';
import { db } from '$lib/server/db';
import { formFailure, pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import type { Actions, PageServerLoad } from './$types';

/**
 * One attempt in full for the operator (domain 12.5): the decisions, every served cluster with its instance whole — the
 * statement, the key, the hidden tests and the mutants — the candidate's answers and runs, the scores with their
 * detail, the Angoff estimates, the release and the signals.
 */
export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	const attemptId = z.uuid().safeParse(event.params.id);
	if (!attemptId.success) error(404, { message: 'Попытка не найдена', requestId: event.locals.requestId });
	try {
		const review = await attemptForReview(db(), subject, attemptId.data, meta.requestId);
		const { attempt } = review;
		return {
			attempt: {
				id: attempt.id,
				title: review.title,
				specialization: attempt.specialization,
				grade: attempt.grade,
				form: attempt.form,
				status: attempt.status,
				bankReleaseId: attempt.bankReleaseId,
				procedureVersion: attempt.procedureVersion,
				seeded: attempt.seeded,
				startedAt: attempt.startedAt,
				deadlineAt: attempt.deadlineAt,
				endedAt: attempt.endedAt,
				annulledAt: attempt.annulledAt,
				annulReason: attempt.annulReason
			},
			decisions: review.decisions.map((decision) => ({
				id: decision.id,
				status: decision.status,
				decidedAt: decision.decidedAt,
				llr: decision.llr,
				explanation: explainDecision({
					specialization: attempt.specialization as Parameters<typeof explainDecision>[0]['specialization'],
					grade: attempt.grade as Parameters<typeof explainDecision>[0]['grade'],
					outcome: decision.outcome,
					reason: decision.reason,
					confident: decision.confident,
					scoreSum: decision.scoreSum,
					cutSum: decision.cutSum,
					items: decision.items,
					extensionUsed: decision.extensionUsed,
					practice: decision.practice as { score: number; gateMinScore: number; passed: boolean } | null,
					blocks: decision.blocks as BlockSummary[]
				})
			})),
			items: review.items.map(({ item, instance, artifacts }) => ({
				seq: item.seq,
				block: item.block,
				format: item.format,
				family: `${item.familyKey} v${item.familyVersion}`,
				classId: item.classId,
				angoff: item.angoff,
				status: item.status,
				score: item.score,
				scoreDetail: item.scoreDetail,
				instance,
				artifacts: artifacts.map((a) => ({ seq: a.seq, kind: a.kind, content: a.content, createdAt: a.createdAt }))
			})),
			facts: review.facts,
			cleared: review.cleared,
			signals: review.signals.entries,
			reasons: OPERATOR_ANNUL_REASONS,
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
		const reason = OPERATOR_ANNUL_REASONS.find((value) => value === formText(form, 'reason'));
		let outcome: AnnulOutcome;
		try {
			if (reason === undefined) {
				throw invalid([{ path: 'reason', code: 'required', message: 'Выберите причину аннулирования' }]);
			}
			outcome = await annulAttempt(db(), OWNER_STANDING, subject, meta, event.params.id, reason, new Date());
		} catch (cause) {
			return formFailure(cause);
		}
		redirect(303, `${event.url.pathname}?done=${outcome.annulled ? 'annulled' : 'already'}`);
	}
};
