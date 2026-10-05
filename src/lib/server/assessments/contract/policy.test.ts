import { describe, expect, it } from 'vitest';
import type { GradeKey } from './catalog';
import {
	GRADE_POLICY,
	PolicyError,
	categoryAfterDecision,
	gradeOptions,
	type GradeOption,
	type PolicyAttempt,
	type PolicyInput
} from './policy';

const day = (n: number): Date => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000);

const decided = (
	grade: GradeKey,
	at: number,
	outcome: 'confirmed' | 'not_confirmed' | 'undetermined'
): PolicyAttempt => ({
	grade,
	startedAt: day(at),
	endedAt: day(at),
	state: { decided: outcome }
});

function options(input: Partial<PolicyInput> & { now: Date }): Record<GradeKey, GradeOption> {
	const list = gradeOptions({ policy: GRADE_POLICY, declaredGrade: null, category: null, attempts: [], ...input });
	return Object.fromEntries(list.map((option) => [option.grade, option])) as Record<GradeKey, GradeOption>;
}

describe('grade options', () => {
	it('offers only the declared grade before any attempt', () => {
		const o = options({ now: day(0), declaredGrade: 'middle' });
		expect(o.middle).toEqual({ grade: 'middle', available: true, kind: 'declared' });
		expect(o.junior).toEqual({ grade: 'junior', available: false, reason: 'lower_requires_failure' });
		expect(o.senior).toEqual({ grade: 'senior', available: false, reason: 'above_declared' });
		expect(options({ now: day(0) }).middle).toEqual({ grade: 'middle', available: false, reason: 'not_declared' });
	});

	it('opens the grade below at once after a first failure and the same grade after the retake interval', () => {
		const o = options({ now: day(1), declaredGrade: 'middle', attempts: [decided('middle', 0, 'not_confirmed')] });
		expect(o.junior).toEqual({ grade: 'junior', available: true, kind: 'lower_after_failure' });
		expect(o.middle).toEqual({ grade: 'middle', available: false, reason: 'retake_interval', availableFrom: day(14) });
		expect(o.intern).toEqual({ grade: 'intern', available: false, reason: 'lower_requires_failure' });
		const later = options({ now: day(14), declaredGrade: 'middle', attempts: [decided('middle', 0, 'undetermined')] });
		expect(later.middle).toEqual({ grade: 'middle', available: true, kind: 'declared' });
	});

	it('limits a grade to two attempts within the window of forms', () => {
		const attempts = [decided('middle', 0, 'not_confirmed'), decided('middle', 20, 'not_confirmed')];
		const o = options({ now: day(40), declaredGrade: 'middle', attempts });
		expect(o.middle).toEqual({ grade: 'middle', available: false, reason: 'attempt_limit', availableFrom: day(180) });
	});

	it('does not count an attempt annulled for a technical reason', () => {
		const attempts: PolicyAttempt[] = [{ grade: 'junior', startedAt: day(0), endedAt: day(0), state: 'annulled_free' }];
		expect(options({ now: day(0), declaredGrade: 'junior', attempts }).junior).toMatchObject({ available: true });
	});

	it('keeps everything closed while an attempt runs', () => {
		const attempts: PolicyAttempt[] = [{ grade: 'junior', startedAt: day(0), endedAt: null, state: 'in_progress' }];
		expect(options({ now: day(0), declaredGrade: 'junior', attempts }).junior).toEqual({
			grade: 'junior',
			available: false,
			reason: 'attempt_in_progress'
		});
	});

	it('offers only the next grade above a confirmed one: at once after a confident result, else after the interval', () => {
		const confident = options({
			now: day(5),
			category: { grade: 'junior', assignedAt: day(0), confidentUpgradeUntil: day(30) }
		});
		expect(confident.middle).toEqual({ grade: 'middle', available: true, kind: 'upgrade_confident' });
		expect(confident.junior).toEqual({ grade: 'junior', available: false, reason: 'already_confirmed' });
		expect(confident.intern).toEqual({ grade: 'intern', available: false, reason: 'below_confirmed' });
		expect(confident.senior).toEqual({ grade: 'senior', available: false, reason: 'above_next_grade' });

		const plain = options({
			now: day(5),
			category: { grade: 'junior', assignedAt: day(0), confidentUpgradeUntil: null }
		});
		expect(plain.middle).toEqual({
			grade: 'middle',
			available: false,
			reason: 'grade_change_interval',
			availableFrom: day(90)
		});
		const after = options({
			now: day(90),
			category: { grade: 'junior', assignedAt: day(0), confidentUpgradeUntil: null }
		});
		expect(after.middle).toEqual({ grade: 'middle', available: true, kind: 'upgrade_interval' });
	});

	it('applies the retake interval to a failed upgrade without touching the confirmed grade', () => {
		const o = options({
			now: day(95),
			category: { grade: 'junior', assignedAt: day(0), confidentUpgradeUntil: null },
			attempts: [decided('middle', 92, 'not_confirmed')]
		});
		expect(o.middle).toEqual({ grade: 'middle', available: false, reason: 'retake_interval', availableFrom: day(106) });
	});
});

describe('category after a decision', () => {
	it('assigns, supersedes by the next grade and keeps on a failure', () => {
		expect(
			categoryAfterDecision(null, { grade: 'junior', outcome: 'confirmed', confident: true }, day(0), GRADE_POLICY)
		).toEqual({
			action: 'assign',
			grade: 'junior',
			confidentUpgradeUntil: day(30)
		});
		const current = { grade: 'junior' as const, assignedAt: day(0), confidentUpgradeUntil: null };
		expect(
			categoryAfterDecision(current, { grade: 'middle', outcome: 'confirmed', confident: false }, day(90), GRADE_POLICY)
		).toEqual({
			action: 'supersede',
			from: 'junior',
			grade: 'middle',
			confidentUpgradeUntil: null
		});
		expect(
			categoryAfterDecision(
				current,
				{ grade: 'middle', outcome: 'not_confirmed', confident: false },
				day(90),
				GRADE_POLICY
			)
		).toEqual({
			action: 'keep'
		});
	});

	it('gives no upgrade token at the top grade and refuses a confirmation the policy would not start', () => {
		expect(
			categoryAfterDecision(null, { grade: 'senior', outcome: 'confirmed', confident: true }, day(0), GRADE_POLICY)
		).toEqual({
			action: 'assign',
			grade: 'senior',
			confidentUpgradeUntil: null
		});
		const current = { grade: 'junior' as const, assignedAt: day(0), confidentUpgradeUntil: null };
		expect(() =>
			categoryAfterDecision(current, { grade: 'senior', outcome: 'confirmed', confident: false }, day(90), GRADE_POLICY)
		).toThrow(PolicyError);
	});
});
