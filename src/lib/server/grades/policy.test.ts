import { describe, expect, it } from 'vitest';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import {
	categoryChange,
	GRADE_POLICY,
	gradeOptions,
	type CategoryDecision
} from '$lib/server/assessments/contract/policy';
import type { DecisionReason } from '$lib/server/assessments/contract/procedure';
import { ApiError } from '$lib/server/errors/api-error';
import { blockedTestError, canStartAttempt, gradeOffers, policyInputOf } from './policy';
import type { SourceAttempt, SourceCategory } from './sources';
import { nextStep } from './standing';
import { optionText } from './texts';

const day = (n: number): Date => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000);

function decided(
	grade: GradeKey,
	at: number,
	outcome: 'confirmed' | 'not_confirmed' | 'undetermined',
	specialization: SpecializationKey = 'backend',
	reason: DecisionReason = outcome === 'confirmed' ? 'sprt_upper' : 'sprt_lower'
): SourceAttempt {
	return { specialization, grade, startedAt: day(at), endedAt: day(at), state: { decided: outcome, reason } };
}

const decision = (grade: GradeKey, at: number, outcome: CategoryDecision['outcome']): CategoryDecision => ({
	id: `${grade}-${String(at)}`,
	grade,
	outcome,
	confident: false,
	viaConfidentUpgrade: false,
	decidedAt: day(at),
	valid: true
});

function category(grade: GradeKey, assignedAt: number, confidentUntil: number | null): SourceCategory {
	return {
		specialization: 'backend',
		grade,
		assignedAt: day(assignedAt),
		confidentUpgradeUntil: confidentUntil === null ? null : day(confidentUntil),
		confirmedBlocks: []
	};
}

function input(state: {
	now: number;
	declared?: GradeKey | null;
	categories?: SourceCategory[];
	attempts?: SourceAttempt[];
	intervalsLifted?: boolean;
}) {
	return policyInputOf({
		now: day(state.now),
		specialization: 'backend',
		declaredGrade: state.declared ?? null,
		categories: state.categories ?? [],
		attempts: state.attempts ?? [],
		intervalsLifted: state.intervalsLifted ?? false
	});
}

describe('may the candidate start a test of a grade now', () => {
	it('without a declaration opens nothing', () => {
		expect(canStartAttempt(input({ now: 0 }), 'junior')).toEqual({
			allowed: false,
			reason: 'not_declared',
			availableFrom: null
		});
	});

	it('opens the declared grade only: not above it, and not below it before a failure', () => {
		const state = input({ now: 0, declared: 'middle' });
		expect(canStartAttempt(state, 'middle')).toEqual({ allowed: true, kind: 'declared' });
		expect(canStartAttempt(state, 'senior')).toMatchObject({ allowed: false, reason: 'above_declared' });
		expect(canStartAttempt(state, 'junior')).toMatchObject({ allowed: false, reason: 'lower_requires_failure' });
	});

	it('after the first failure opens the grade below at once and the same grade after the retake interval', () => {
		for (const outcome of ['not_confirmed', 'undetermined'] as const) {
			const attempts = [decided('middle', 0, outcome)];
			expect(canStartAttempt(input({ now: 0, declared: 'middle', attempts }), 'junior')).toEqual({
				allowed: true,
				kind: 'lower_after_failure'
			});
			expect(canStartAttempt(input({ now: 1, declared: 'middle', attempts }), 'middle')).toEqual({
				allowed: false,
				reason: 'retake_interval',
				availableFrom: day(GRADE_POLICY.retakeIntervalDays)
			});
			expect(
				canStartAttempt(input({ now: GRADE_POLICY.retakeIntervalDays, declared: 'middle', attempts }), 'middle')
			).toEqual({ allowed: true, kind: 'declared' });
		}
	});

	it('gives no category for a failure: the policy keeps the candidate without one', () => {
		expect(categoryChange([], [decision('middle', 0, 'not_confirmed')], GRADE_POLICY)).toEqual({ action: 'keep' });
	});

	it('with a category opens only the next grade, after the interval of a grade change', () => {
		const categories = [category('junior', 0, null)];
		const state = input({ now: 10, declared: 'senior', categories });
		expect(canStartAttempt(state, 'intern')).toMatchObject({ allowed: false, reason: 'below_confirmed' });
		expect(canStartAttempt(state, 'junior')).toMatchObject({ allowed: false, reason: 'already_confirmed' });
		expect(canStartAttempt(state, 'senior')).toMatchObject({ allowed: false, reason: 'above_next_grade' });
		expect(canStartAttempt(state, 'middle')).toEqual({
			allowed: false,
			reason: 'grade_change_interval',
			availableFrom: day(GRADE_POLICY.gradeChangeIntervalDays)
		});
		expect(canStartAttempt(input({ now: GRADE_POLICY.gradeChangeIntervalDays, categories }), 'middle')).toEqual({
			allowed: true,
			kind: 'upgrade_interval'
		});
	});

	it('with a confident category opens the next grade at once while the right lasts', () => {
		const categories = [category('junior', 0, GRADE_POLICY.confidentUpgradeValidDays)];
		expect(canStartAttempt(input({ now: 1, categories }), 'middle')).toEqual({
			allowed: true,
			kind: 'upgrade_confident'
		});
		expect(
			canStartAttempt(input({ now: GRADE_POLICY.confidentUpgradeValidDays + 1, categories }), 'middle')
		).toMatchObject({ allowed: false, reason: 'grade_change_interval' });
	});

	it('a failure above a category does not lower it: the confirmed grade stays closed, the retake waits', () => {
		const categories = [category('junior', 0, null)];
		const attempts = [decided('middle', 100, 'not_confirmed')];
		const state = input({ now: 101, categories, attempts });
		expect(canStartAttempt(state, 'junior')).toMatchObject({ allowed: false, reason: 'already_confirmed' });
		expect(canStartAttempt(state, 'intern')).toMatchObject({ allowed: false, reason: 'below_confirmed' });
		expect(canStartAttempt(state, 'middle')).toEqual({
			allowed: false,
			reason: 'retake_interval',
			availableFrom: day(100 + GRADE_POLICY.retakeIntervalDays)
		});
		// The retake of a started upgrade follows the retake interval, not the interval of a grade change.
		expect(
			canStartAttempt(input({ now: 100 + GRADE_POLICY.retakeIntervalDays, categories, attempts }), 'middle')
		).toEqual({ allowed: true, kind: 'upgrade_retake' });
		const confirmedJunior = [decision('junior', 0, 'confirmed')];
		expect(
			categoryChange(confirmedJunior, [...confirmedJunior, decision('middle', 100, 'not_confirmed')], GRADE_POLICY)
		).toEqual({ action: 'keep' });
	});

	it('says in advance, on the test below, when the failed grade is retaken — whatever the test below gives', () => {
		const attempts = [decided('middle', 0, 'not_confirmed')];
		expect(gradeOptions(input({ now: 1, declared: 'middle', attempts })).find((o) => o.grade === 'junior')).toEqual({
			grade: 'junior',
			available: true,
			kind: 'lower_after_failure',
			failedRetake: { grade: 'middle', availableFrom: day(GRADE_POLICY.retakeIntervalDays) }
		});
		const lower = gradeOptions(input({ now: 1, declared: 'middle', attempts })).find((o) => o.grade === 'junior');
		if (!lower) throw new Error('no junior option');
		expect(optionText(lower)).toMatch(/Повтор грейда «Средний» откроется .* при любом результате этого теста$/);
		// A failure on the test below does not move the retake of the failed grade.
		const below = [...attempts, decided('junior', 1, 'not_confirmed')];
		expect(
			canStartAttempt(input({ now: GRADE_POLICY.retakeIntervalDays, declared: 'middle', attempts: below }), 'middle')
		).toEqual({
			allowed: true,
			kind: 'declared'
		});
	});

	it('does not count a system end: the bank ran out — as if the attempt was never taken', () => {
		const attempts = [decided('middle', 0, 'undetermined', 'backend', 'bank_exhausted')];
		const state = input({ now: 1, declared: 'middle', attempts });
		expect(canStartAttempt(state, 'middle')).toEqual({ allowed: true, kind: 'declared' });
		expect(canStartAttempt(state, 'junior')).toMatchObject({ allowed: false, reason: 'lower_requires_failure' });
	});

	it('opens a closed test on the latest date of all its reasons', () => {
		// Two counted failures: the retake opens on day 34, the limit of attempts on day 180 — the later one rules.
		const attempts = [decided('middle', 0, 'not_confirmed'), decided('middle', 20, 'not_confirmed')];
		expect(canStartAttempt(input({ now: 40, declared: 'middle', attempts }), 'middle')).toEqual({
			allowed: false,
			reason: 'attempt_limit',
			availableFrom: day(GRADE_POLICY.formWindowDays)
		});
	});

	it('reads attempts of the specialization only, but an attempt running anywhere closes every test', () => {
		const other = [decided('middle', 0, 'not_confirmed', 'frontend')];
		expect(canStartAttempt(input({ now: 1, declared: 'middle', attempts: other }), 'middle')).toEqual({
			allowed: true,
			kind: 'declared'
		});
		const running: SourceAttempt = {
			specialization: 'frontend',
			grade: 'junior',
			startedAt: day(0),
			endedAt: null,
			state: 'in_progress'
		};
		expect(canStartAttempt(input({ now: 0, declared: 'middle', attempts: [running] }), 'middle')).toMatchObject({
			allowed: false,
			reason: 'attempt_in_progress'
		});
	});

	it('answers as the automaton of the contract does, grade by grade', () => {
		const state = input({ now: 3, declared: 'middle', attempts: [decided('middle', 0, 'not_confirmed')] });
		for (const option of gradeOptions(state)) {
			const verdict = canStartAttempt(state, option.grade);
			expect(verdict.allowed).toBe(option.available);
		}
	});

	it('in a demo session retakes at once what waits 14 days outside it', () => {
		const attempts = [decided('middle', 0, 'not_confirmed')];
		expect(canStartAttempt(input({ now: 1, declared: 'middle', attempts }), 'middle')).toEqual({
			allowed: false,
			reason: 'retake_interval',
			availableFrom: day(GRADE_POLICY.retakeIntervalDays)
		});
		expect(canStartAttempt(input({ now: 1, declared: 'middle', attempts, intervalsLifted: true }), 'middle')).toEqual({
			allowed: true,
			kind: 'demo_session'
		});
	});

	it('in a demo session changes a confirmed grade at once; the order of grades stays closed', () => {
		const categories = [category('junior', 0, null)];
		const attempts = [decided('junior', 0, 'confirmed')];
		const live = gradeOffers(input({ now: 1, declared: 'junior', categories, attempts }));
		const demo = gradeOffers(input({ now: 1, declared: 'junior', categories, attempts, intervalsLifted: true }));
		expect(live.find((o) => o.grade === 'middle')).toEqual({
			grade: 'middle',
			available: false,
			reason: 'grade_change_interval',
			availableFrom: day(GRADE_POLICY.gradeChangeIntervalDays)
		});
		expect(demo).toEqual([
			{ grade: 'intern', available: false, reason: 'below_confirmed' },
			{ grade: 'junior', available: false, reason: 'already_confirmed' },
			{ grade: 'middle', available: true, kind: 'demo_session' },
			{ grade: 'senior', available: false, reason: 'above_next_grade' }
		]);
	});

	it('in a demo session keeps the declared grade, the attempt limit and one attempt at a time', () => {
		const lifted = (state: Parameters<typeof input>[0], grade: GradeKey) =>
			canStartAttempt(input({ ...state, intervalsLifted: true }), grade);
		expect(lifted({ now: 0, declared: 'junior' }, 'middle')).toMatchObject({
			allowed: false,
			reason: 'above_declared'
		});
		// Two counted attempts at Middle: the retake interval is lifted, the limit of the window of forms is not.
		const twice = [decided('middle', 0, 'not_confirmed'), decided('middle', 1, 'not_confirmed')];
		expect(lifted({ now: 2, declared: 'middle', attempts: twice }, 'middle')).toEqual({
			allowed: false,
			reason: 'attempt_limit',
			availableFrom: day(GRADE_POLICY.formWindowDays)
		});
		const running: SourceAttempt = { ...decided('junior', 0, 'confirmed'), endedAt: null, state: 'in_progress' };
		expect(lifted({ now: 0, declared: 'junior', attempts: [running] }, 'junior')).toMatchObject({
			allowed: false,
			reason: 'attempt_in_progress'
		});
		expect(lifted({ now: 0 }, 'junior')).toMatchObject({ allowed: false, reason: 'not_declared' });
	});

	it('refuses a closed test with 409 and the code of the reason', () => {
		const error = blockedTestError({ allowed: false, reason: 'retake_interval', availableFrom: day(14) });
		expect(error).toBeInstanceOf(ApiError);
		expect(error.status).toBe(409);
		expect(error.details).toEqual([
			{ code: 'retake_interval', message: expect.stringContaining('Откроется') as unknown }
		]);
	});
});

describe('the step to a category', () => {
	const optionsOf = (state: Parameters<typeof input>[0]) => gradeOffers(input(state));

	it('starts with the survey, then the declaration', () => {
		expect(nextStep({ specialization: null, declaredGrade: null, category: null, options: [] })).toEqual({
			kind: 'survey'
		});
		expect(
			nextStep({ specialization: 'backend', declaredGrade: null, category: null, options: optionsOf({ now: 0 }) })
		).toEqual({ kind: 'declare', specialization: 'backend' });
	});

	it('leads to the test of the declared grade, then to the grade below after a failure', () => {
		expect(
			nextStep({
				specialization: 'backend',
				declaredGrade: 'middle',
				category: null,
				options: optionsOf({ now: 0, declared: 'middle' })
			})
		).toEqual({ kind: 'test', grade: 'middle', option: 'declared' });
		expect(
			nextStep({
				specialization: 'backend',
				declaredGrade: 'middle',
				category: null,
				options: optionsOf({ now: 1, declared: 'middle', attempts: [decided('middle', 0, 'not_confirmed')] })
			})
		).toEqual({ kind: 'test', grade: 'junior', option: 'lower_after_failure' });
	});

	it('in a demo session leads where the policy leads, not to the top grade it also opens', () => {
		expect(
			nextStep({
				specialization: 'backend',
				declaredGrade: 'junior',
				category: null,
				options: optionsOf({ now: 0, declared: 'junior', intervalsLifted: true })
			})
		).toEqual({ kind: 'test', grade: 'junior', option: 'declared' });
		const categories = [category('junior', 0, null)];
		expect(
			nextStep({
				specialization: 'backend',
				declaredGrade: 'junior',
				category: categories[0] ?? null,
				options: optionsOf({ now: 1, declared: 'junior', categories, intervalsLifted: true })
			})
		).toEqual({ kind: 'test', grade: 'middle', option: 'demo_session' });
	});

	it('waits with the day the next test opens, and is done at the top grade', () => {
		const categories = [category('junior', 0, null)];
		expect(
			nextStep({
				specialization: 'backend',
				declaredGrade: 'junior',
				category: { grade: 'junior' },
				options: optionsOf({ now: 5, declared: 'junior', categories })
			})
		).toEqual({
			kind: 'wait',
			grade: 'middle',
			reason: 'grade_change_interval',
			availableFrom: day(GRADE_POLICY.gradeChangeIntervalDays)
		});
		expect(
			nextStep({
				specialization: 'backend',
				declaredGrade: 'senior',
				category: { grade: 'senior' },
				options: optionsOf({ now: 5, declared: 'senior', categories: [category('senior', 0, null)] })
			})
		).toEqual({ kind: 'done' });
	});
});
