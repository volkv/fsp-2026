// The adaptive quiz of an attempt (docs/domain.md, 10.1 and 10.4): every answer is a `quiz_step` artifact, and the
// question on screen is not stored — it follows from the answers so far (`adaptive.ts`), so a page reload shows the
// same question and an answer to any other question is refused. The last answer scores the attempt at once.
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Database, Executor } from '$lib/server/db';
import { assessmentArtifacts, assessmentAttempts } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { estimateAbility, nextQuizItem, quizLevel, type AbilityEstimate, type AnsweredStep } from './adaptive';
import { expireOverdue, lockOwnStartedAttempt, ownCandidateId } from './attempts';
import type { QuizItem } from './bank';
import { assessmentPolicy, retentionUntil } from './policy';
import { appendArtifacts, recordAutomaticScore, type ScoredLevel } from './scoring';
import { appendSignal, type ClientSignals } from './signals';
import { loadVersion, type QuizVersion } from './versions';

/** `quiz_step` artifact content (domain 10.4). */
export const quizStepSchema = z.looseObject({
	item_id: z.string(),
	item_version: z.int(),
	presented_at: z.iso.datetime(),
	answer: z.string(),
	correct: z.boolean(),
	ability_estimate_after: z.strictObject({ ability: z.number(), standard_error: z.number() })
});
export type QuizStep = z.infer<typeof quizStepSchema>;

export interface QuizState {
	steps: (QuizStep & { answeredAt: Date })[];
	estimate: AbilityEstimate;
	/** The question to answer now; `null` — the quiz is over. */
	current: QuizItem | null;
	/** When the current question appeared: the previous answer, or the start of the attempt. */
	presentedAt: Date;
}

const round = (value: number) => Number(value.toFixed(3));

export async function quizState(
	executor: Executor,
	attempt: { id: string; startedAt: Date },
	version: QuizVersion
): Promise<QuizState> {
	const rows = await executor
		.select({ content: assessmentArtifacts.content, createdAt: assessmentArtifacts.createdAt })
		.from(assessmentArtifacts)
		.where(and(eq(assessmentArtifacts.attemptId, attempt.id), eq(assessmentArtifacts.kind, 'quiz_step')))
		.orderBy(asc(assessmentArtifacts.seq));
	const steps = rows.map((row) => ({ ...quizStepSchema.parse(row.content), answeredAt: row.createdAt }));
	const { rule, items } = version.itemBank;
	const answered: AnsweredStep[] = steps.map((step) => ({ itemId: step.item_id, correct: step.correct }));
	const estimate = estimateAbility(rule, items, answered);
	return {
		steps,
		estimate,
		current: nextQuizItem(rule, items, answered, estimate, attempt.id),
		presentedAt: steps.at(-1)?.answeredAt ?? attempt.startedAt
	};
}

/** The level of a finished quiz: the band of the ability estimate; a reached level also gives its grade. */
export function quizScoredLevel(version: QuizVersion, estimate: AbilityEstimate): ScoredLevel & { confidence: number } {
	const result = quizLevel(version.levelScale, estimate);
	return {
		level: result.level,
		confidence: result.confidence,
		confirmed: result.cut
			? { level: result.cut.level, levelStrength: result.cut.levelStrength, gradeKey: result.cut.gradeKey }
			: null
	};
}

export interface QuizAnswer {
	itemId: string;
	optionId: string;
	signals: ClientSignals | null;
}

export async function answerQuizItem(
	database: Database,
	subject: AccessSubject,
	attemptId: string,
	answer: QuizAnswer,
	now: Date,
	requestId: string
): Promise<{ finished: boolean }> {
	const candidateId = ownCandidateId(subject, 'write');
	await expireOverdue(database, candidateId, now);
	return database.transaction(async (tx) => {
		const attempt = await lockOwnStartedAttempt(tx, candidateId, attemptId, now);
		const version = await loadVersion(tx, attempt.versionId);
		if (version?.kind !== 'quiz') throw new ApiError('not_found');
		const state = await quizState(tx, attempt, version);
		const item = state.current;
		if (!item) throw new Error(`quiz attempt ${attempt.id} is started but has no question left`);
		if (item.id !== answer.itemId) {
			throw new ApiError('conflict', {
				message: 'Этот вопрос уже не текущий: обнови страницу',
				details: [{ code: 'stale_question', message: 'Этот вопрос уже не текущий' }]
			});
		}
		if (!item.options.some((option) => option.id === answer.optionId)) {
			throw new ApiError('validation_failed', {
				message: 'Выбери один из вариантов ответа',
				details: [{ path: 'option', code: 'invalid', message: 'Выбери один из вариантов ответа' }]
			});
		}
		const correct = answer.optionId === item.correct;
		const { rule, items } = version.itemBank;
		const answered: AnsweredStep[] = [
			...state.steps.map((step) => ({ itemId: step.item_id, correct: step.correct })),
			{ itemId: item.id, correct }
		];
		const estimate = estimateAbility(rule, items, answered);
		const policy = await assessmentPolicy(tx, now);
		await appendArtifacts(
			tx,
			attempt.id,
			[
				{
					kind: 'quiz_step',
					content: {
						item_id: item.id,
						item_version: item.version,
						presented_at: state.presentedAt.toISOString(),
						answer: answer.optionId,
						correct,
						ability_estimate_after: { ability: round(estimate.ability), standard_error: round(estimate.standardError) }
					}
				}
			],
			now,
			retentionUntil(policy, now)
		);
		const finished = nextQuizItem(rule, items, answered, estimate, attempt.id) === null;
		await tx
			.update(assessmentAttempts)
			.set({
				integritySignals: appendSignal(attempt.integritySignals, {
					at: now.toISOString(),
					stage: 'quiz_step',
					itemId: item.id,
					responseMs: Math.max(0, now.getTime() - state.presentedAt.getTime()),
					client: answer.signals
				}),
				...(finished ? { status: 'submitted' as const, submittedAt: now } : {})
			})
			.where(eq(assessmentAttempts.id, attempt.id));
		if (finished) {
			const level = quizScoredLevel(version, estimate);
			await recordAutomaticScore(tx, {
				attempt: { id: attempt.id, candidateId },
				version,
				score: answered.filter((step) => step.correct).length,
				maxScore: answered.length,
				level,
				language: null,
				details: {
					confidence: level.confidence,
					ability: round(estimate.ability),
					standard_error: round(estimate.standardError)
				},
				now,
				requestId,
				createdBy: { kind: 'user', id: subject.userId ?? undefined }
			});
		}
		return { finished };
	});
}
