// Platform quizzes taken by demo candidates (docs/domain.md, section 10): the attempt is started and answered through
// the assessments module, one question at a time as the adaptive quiz presents them, and scored by it. A synthetic
// candidate answers a question correctly with the probability the quiz's own model gives for the candidate's ability,
// so the levels come out as the model would measure such a person. The quiz is dated back to half an hour before the
// seed, after the person joined the stand and consented to the processing (`SeedContext.joinedAt`), and the answers
// follow a minute or two apart, as a person answers, all of them before the seed.
import { and, eq } from 'drizzle-orm';
import { correctProbability } from '$lib/server/assessments/adaptive';
import { startAttempt } from '$lib/server/assessments/attempts';
import { answerQuizItem, quizState } from '$lib/server/assessments/quiz';
import { loadVersion } from '$lib/server/assessments/versions';
import { assessmentAttempts, assessments, assessmentVersions } from '$lib/server/db/schema';
import { subjectOf, type SeedContext } from './accounts';
import type { SeededCandidate } from './candidates';
import { Random } from './generate';

/** Skills with a quiz in the bank (`assessments/quiz/`); a published quiz of the skill is looked up by it. */
export type QuizSkill =
	| 'go'
	| 'python'
	| 'javascript'
	| 'typescript'
	| 'sql'
	| 'java'
	| 'kotlin'
	| 'csharp'
	| 'cpp'
	| 'php'
	| 'docker'
	| 'linux';

export interface QuizPlan {
	skill: QuizSkill;
	/** Ability on the quiz's scale (0 — an average middle). */
	ability: number;
}

const MINUTE = 60_000;

/** The published quiz of a skill. */
async function quizOf(ctx: SeedContext, skill: QuizSkill): Promise<string> {
	const rows = await ctx.services.db
		.selectDistinct({ id: assessments.id, skills: assessments.skillKeys })
		.from(assessments)
		.innerJoin(assessmentVersions, eq(assessmentVersions.assessmentId, assessments.id))
		.where(and(eq(assessments.kind, 'quiz'), eq(assessmentVersions.status, 'published')));
	const quiz = rows.find((row) => row.skills.length === 1 && row.skills[0] === skill);
	if (!quiz) throw new Error(`no published quiz of ${skill} (scripts/seed-assessments.ts)`);
	return quiz.id;
}

/** The candidate takes the quiz once; a candidate who already has an attempt of it is left as is. */
export async function takeQuiz(ctx: SeedContext, candidate: SeededCandidate, plan: QuizPlan): Promise<void> {
	const { db } = ctx.services;
	const assessmentId = await quizOf(ctx, plan.skill);
	const [existing] = await db
		.select({ id: assessmentAttempts.id })
		.from(assessmentAttempts)
		.innerJoin(assessmentVersions, eq(assessmentVersions.id, assessmentAttempts.versionId))
		.where(
			and(eq(assessmentAttempts.candidateId, candidate.candidateId), eq(assessmentVersions.assessmentId, assessmentId))
		)
		.limit(1);
	if (existing) return;

	const subject = await subjectOf(ctx, candidate.userId);
	const rnd = new Random(`${ctx.batch}:quiz:${candidate.key}:${plan.skill}`);
	const now = ctx.now().getTime();
	const joined = ctx.joinedAt.getTime();
	// Half an hour before the seed, or a quarter of the time since joining when the stand is younger than that.
	let at = new Date(Math.max(now - 30 * MINUTE, joined + Math.min(MINUTE, (now - joined) / 4)));
	const { attemptId } = await startAttempt(db, subject, assessmentId, at);
	const [attempt] = await db
		.select({
			id: assessmentAttempts.id,
			startedAt: assessmentAttempts.startedAt,
			versionId: assessmentAttempts.versionId
		})
		.from(assessmentAttempts)
		.where(eq(assessmentAttempts.id, attemptId));
	if (!attempt) throw new Error(`quiz attempt ${attemptId} is missing`);
	const version = await loadVersion(db, attempt.versionId);
	if (version?.kind !== 'quiz') throw new Error(`attempt ${attemptId} is not a quiz`);
	// The longest quiz ends before the seed: a pause is never longer than its share of the time left.
	const pauseLimit = (now - at.getTime()) / (version.itemBank.rule.stop.maxItems + 1);

	for (let finished = false; !finished;) {
		const state = await quizState(db, attempt, version);
		const item = state.current;
		if (!item) throw new Error(`quiz attempt ${attemptId} has no question and is not finished`);
		const correct = rnd.chance(correctProbability(version.itemBank.rule, item, plan.ability));
		const wrong = item.options.filter((option) => option.id !== item.correct);
		const optionId = correct || wrong.length === 0 ? item.correct : rnd.pick(wrong).id;
		at = new Date(at.getTime() + Math.min(rnd.int(50, 150) * 1000, pauseLimit));
		({ finished } = await answerQuizItem(
			db,
			subject,
			attemptId,
			{ itemId: item.id, optionId, signals: null },
			at,
			ctx.meta.requestId
		));
	}
}
