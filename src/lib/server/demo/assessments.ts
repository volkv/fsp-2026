// The candidate's path through the test of a declared grade, taken the way the candidate takes it (docs/domain.md,
// sections 12.2, 12.3, 23.3): the survey of a specialization, the declared grade with its hint, then the attempts of the
// plan. Each attempt goes the real path — the grade policy admits it, items are chosen from the release in force, the
// procedure decides, the owner of the category writes the category — with the scores of the seeded verdict instead of
// the sandbox. The plan names the outcome the scenario needs; the true share is drawn from the range of that outcome
// and an attempt whose decision differs is rolled back and drawn again (rejection sampling), so the stand gets the same
// decisions on every seed while every decision is still the procedure's own.
import { and, asc, eq } from 'drizzle-orm';
import { CATALOG, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { runSeededAttempt } from '$lib/server/assessments/seed-attempt';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { gradeDecisions, testAttempts } from '$lib/server/db/schema';
import { declareGrade } from '$lib/server/grades/declarations';
import { currentDeclaration } from '$lib/server/grades/policy';
import { gradeSources } from '$lib/server/grades/sources';
import { latestSurvey, submitSurvey } from '$lib/server/grades/surveys';
import { metaOf, subjectOf, type SeedContext } from './accounts';
import type { SeededCandidate } from './candidates';
import type { TestOutcome } from './data';
import { Random, type AssessmentPlan, type CandidatePlan } from './generate';

/** The range of the true share each outcome is drawn from. */
const SHARES: Readonly<Record<TestOutcome, readonly [number, number]>> = {
	confident: [0.92, 1],
	confirmed: [0.6, 0.76],
	not_confirmed: [0.1, 0.4],
	undetermined: [0.35, 0.85]
};

/** Draws of one attempt before the seed gives up: «не определено» is rare at any share. */
const TRIALS: Readonly<Record<TestOutcome, number>> = {
	confident: 60,
	confirmed: 120,
	not_confirmed: 60,
	undetermined: 600
};

class DrawRejected extends Error {
	override name = 'DrawRejected';
}

export type AssessmentState = 'none' | 'closed' | 'taken';

function outcomeOf(decision: { outcome: string; confident: boolean }): TestOutcome {
	if (decision.outcome === 'confirmed') return decision.confident ? 'confident' : 'confirmed';
	if (decision.outcome === 'not_confirmed' || decision.outcome === 'undetermined') return decision.outcome;
	throw new Error(`unknown decision outcome ${decision.outcome}`);
}

async function surveyAndDeclaration(
	ctx: SeedContext,
	candidate: SeededCandidate,
	plan: CandidatePlan,
	test: AssessmentPlan
) {
	const { db } = ctx.services;
	const meta = metaOf(ctx, candidate.userId);
	const definition = CATALOG.specializations.find((s) => s.key === test.specialization);
	if (!definition) throw new Error(`specialization ${test.specialization} is not in the catalog`);
	// The survey of the specialization the candidate is about to be tested in: a second specialization is a new survey.
	if ((await latestSurvey(db, candidate.candidateId))?.specialization !== test.specialization) {
		await submitSurvey(
			db,
			gradeSources,
			await subjectOf(ctx, candidate.userId),
			{
				direction: definition.direction,
				specialization: test.specialization,
				declaredSkillKeys: test.skills,
				preferences: plan.preferences
			},
			meta
		);
	}
	if (!(await currentDeclaration(db, candidate.candidateId, test.specialization))) {
		await declareGrade(
			db,
			gradeSources,
			await subjectOf(ctx, candidate.userId),
			{ specialization: test.specialization, grade: test.declared },
			meta,
			ctx.now()
		);
	}
}

/**
 * The survey, the declaration and the attempts of each test of the plan, specialization by specialization in the order
 * planned; every step checks what is done, so a stopped seed continues. A state per test: `closed` — the specialization
 * has no released bank: the candidate takes no survey of it. No test — `none`.
 */
export async function ensureAssessments(
	ctx: SeedContext,
	candidate: SeededCandidate,
	plan: CandidatePlan,
	open: ReadonlySet<SpecializationKey>
): Promise<{ specialization: SpecializationKey | null; state: AssessmentState }[]> {
	if (plan.assessments.length === 0) return [{ specialization: null, state: 'none' }];
	const { db } = ctx.services;
	const states: { specialization: SpecializationKey; state: AssessmentState }[] = [];
	// The ordinal of an attempt among all the candidate's planned attempts: the draws of each one are its own.
	let ordinal = 0;
	for (const test of plan.assessments) {
		const first = ordinal;
		ordinal += test.attempts.length;
		if (!open.has(test.specialization)) {
			states.push({ specialization: test.specialization, state: 'closed' });
			continue;
		}
		const taken = await db
			.select({ id: testAttempts.id })
			.from(testAttempts)
			.where(
				and(eq(testAttempts.candidateId, candidate.candidateId), eq(testAttempts.specialization, test.specialization))
			)
			.orderBy(asc(testAttempts.startedAt));
		if (taken.length < test.attempts.length) {
			await surveyAndDeclaration(ctx, candidate, plan, test);
			for (const [index, attempt] of test.attempts.entries()) {
				if (index < taken.length) continue;
				await attemptWithOutcome(ctx, candidate, test.specialization, attempt.grade, attempt.outcome, first + index);
			}
		}
		states.push({ specialization: test.specialization, state: 'taken' });
	}
	return states;
}

async function attemptWithOutcome(
	ctx: SeedContext,
	candidate: SeededCandidate,
	specialization: SpecializationKey,
	grade: AssessmentPlan['declared'],
	outcome: TestOutcome,
	index: number
): Promise<string> {
	const [low, high] = SHARES[outcome];
	for (let trial = 0; trial < TRIALS[outcome]; trial += 1) {
		const label = `${ctx.batch}:${candidate.key}:test:${index}:${trial}`;
		const trueShare = low + (high - low) * new Random(label).next();
		try {
			return await ctx.services.db.transaction(async (tx) => {
				const { attemptId, outcome: ended } = await runSeededAttempt(
					tx,
					{ standing: OWNER_STANDING },
					{
						candidateId: candidate.candidateId,
						specialization,
						grade,
						trueShare,
						candidateSeed: label,
						now: ctx.now(),
						requestId: ctx.meta.requestId
					}
				);
				if (ended.kind !== 'decided') throw new Error(`seeded attempt ${attemptId} of ${candidate.key} expired`);
				const [decision] = await tx
					.select({ outcome: gradeDecisions.outcome, confident: gradeDecisions.confident })
					.from(gradeDecisions)
					.where(eq(gradeDecisions.id, ended.decisionId));
				if (!decision) throw new Error(`decision ${ended.decisionId} is missing`);
				if (outcomeOf(decision) !== outcome) throw new DrawRejected();
				ctx.services.log.info('demo seed: seeded attempt', {
					candidate: candidate.key,
					grade,
					outcome,
					draws: trial + 1
				});
				return attemptId;
			});
		} catch (error) {
			if (error instanceof DrawRejected) continue;
			throw error;
		}
	}
	throw new Error(
		`${candidate.key}: the test ${specialization} ${grade} gave no «${outcome}» in ${TRIALS[outcome]} draws`
	);
}
