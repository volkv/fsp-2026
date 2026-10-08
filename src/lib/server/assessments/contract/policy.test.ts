import { describe, expect, it } from 'vitest';
import type { GradeKey } from './catalog';
import type { DecisionReason } from './procedure';
import {
	GRADE_POLICY,
	attemptCounts,
	categoryChange,
	gradeOptions,
	resolveCategory,
	type CategoryDecision,
	type GradeOption,
	type PolicyAttempt,
	type PolicyInput
} from './policy';

const day = (n: number): Date => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000);

const decided = (
	grade: GradeKey,
	at: number,
	outcome: 'confirmed' | 'not_confirmed' | 'undetermined',
	reason: DecisionReason = outcome === 'confirmed' ? 'sprt_upper' : 'sprt_lower'
): PolicyAttempt => ({ grade, startedAt: day(at), endedAt: day(at), state: { decided: outcome, reason } });

function options(input: Partial<PolicyInput> & { now: Date }): Record<GradeKey, GradeOption> {
	const list = gradeOptions({ policy: GRADE_POLICY, declaredGrade: null, category: null, attempts: [], ...input });
	return Object.fromEntries(list.map((option) => [option.grade, option])) as Record<GradeKey, GradeOption>;
}

const decision = (
	id: string,
	grade: GradeKey,
	at: number,
	extra: Partial<CategoryDecision> = {}
): CategoryDecision => ({
	id,
	grade,
	outcome: 'confirmed',
	confident: false,
	viaConfidentUpgrade: false,
	decidedAt: day(at),
	valid: true,
	...extra
});

describe('grade options', () => {
	it('offers only the declared grade before any attempt', () => {
		const o = options({ now: day(0), declaredGrade: 'middle' });
		expect(o.middle).toEqual({ grade: 'middle', available: true, kind: 'declared' });
		expect(o.junior).toEqual({ grade: 'junior', available: false, reason: 'lower_requires_failure' });
		expect(o.senior).toEqual({ grade: 'senior', available: false, reason: 'above_declared' });
		expect(options({ now: day(0) }).middle).toEqual({ grade: 'middle', available: false, reason: 'not_declared' });
	});

	it('opens the grade below at once and tells in advance when the failed grade can be retaken', () => {
		const o = options({ now: day(1), declaredGrade: 'middle', attempts: [decided('middle', 0, 'not_confirmed')] });
		expect(o.junior).toEqual({
			grade: 'junior',
			available: true,
			kind: 'lower_after_failure',
			failedRetake: { grade: 'middle', availableFrom: day(14) }
		});
		expect(o.middle).toEqual({ grade: 'middle', available: false, reason: 'retake_interval', availableFrom: day(14) });
	});

	it('keeps the 14-day retake of the failed grade after the grade below is confirmed — not 90 days', () => {
		const attempts = [decided('middle', 0, 'not_confirmed'), decided('junior', 1, 'confirmed')];
		const category = { grade: 'junior' as const, assignedAt: day(1), confidentUpgradeUntil: null };
		expect(options({ now: day(10), category, attempts }).middle).toEqual({
			grade: 'middle',
			available: false,
			reason: 'retake_interval',
			availableFrom: day(14)
		});
		expect(options({ now: day(14), category, attempts }).middle).toEqual({
			grade: 'middle',
			available: true,
			kind: 'upgrade_retake'
		});
	});

	it('keeps the retake of an upgrade begun on a confident token after the token is spent', () => {
		const attempts = [decided('junior', 0, 'confirmed'), decided('middle', 1, 'not_confirmed')];
		const category = { grade: 'junior' as const, assignedAt: day(0), confidentUpgradeUntil: null };
		expect(options({ now: day(15), category, attempts }).middle).toEqual({
			grade: 'middle',
			available: true,
			kind: 'upgrade_retake'
		});
	});

	it('does not count a system end and counts an annulment for a counted reason as a failure with its interval', () => {
		const exhausted = decided('middle', 0, 'undetermined', 'bank_exhausted');
		expect(attemptCounts(exhausted)).toBe(false);
		expect(options({ now: day(0), declaredGrade: 'middle', attempts: [exhausted] }).middle).toMatchObject({
			available: true
		});
		const annulled: PolicyAttempt = { grade: 'middle', startedAt: day(0), endedAt: day(3), state: 'annulled_counted' };
		expect(options({ now: day(5), declaredGrade: 'middle', attempts: [annulled] }).middle).toEqual({
			grade: 'middle',
			available: false,
			reason: 'retake_interval',
			availableFrom: day(17)
		});
		const free: PolicyAttempt = { grade: 'junior', startedAt: day(0), endedAt: day(0), state: 'annulled_free' };
		expect(options({ now: day(0), declaredGrade: 'junior', attempts: [free] }).junior).toMatchObject({
			available: true
		});
	});

	it('limits a grade to two attempts within the window counted from their starts', () => {
		const attempts = [decided('middle', 0, 'not_confirmed'), decided('middle', 20, 'not_confirmed')];
		expect(options({ now: day(40), declaredGrade: 'middle', attempts }).middle).toEqual({
			grade: 'middle',
			available: false,
			reason: 'attempt_limit',
			availableFrom: day(180)
		});
	});

	it('gives the latest date of all the reasons that close an option', () => {
		// Before day 90 only the upgrade interval closes Middle; later two failures close it by the retake (day 106) and the
		// limit (day 270): the later date and its reason are given.
		const category = { grade: 'junior' as const, assignedAt: day(0), confidentUpgradeUntil: null };
		const attempts = [decided('junior', 0, 'confirmed')];
		expect(options({ now: day(5), category, attempts }).middle).toEqual({
			grade: 'middle',
			available: false,
			reason: 'grade_change_interval',
			availableFrom: day(90)
		});
		const late = options({
			now: day(95),
			category,
			attempts: [...attempts, decided('middle', 90, 'not_confirmed'), decided('middle', 92, 'not_confirmed')]
		});
		expect(late.middle).toEqual({
			grade: 'middle',
			available: false,
			reason: 'attempt_limit',
			availableFrom: day(270)
		});
	});

	it('keeps everything closed while an attempt runs', () => {
		const attempts: PolicyAttempt[] = [{ grade: 'junior', startedAt: day(0), endedAt: null, state: 'in_progress' }];
		expect(options({ now: day(0), declaredGrade: 'junior', attempts }).junior).toEqual({
			grade: 'junior',
			available: false,
			reason: 'attempt_in_progress'
		});
	});

	it('offers only the next grade above a confirmed one: at once on a confident token, else after 90 days', () => {
		const confident = options({
			now: day(5),
			category: { grade: 'junior', assignedAt: day(0), confidentUpgradeUntil: day(30) }
		});
		expect(confident.middle).toEqual({ grade: 'middle', available: true, kind: 'upgrade_confident' });
		expect(confident.junior).toEqual({ grade: 'junior', available: false, reason: 'already_confirmed' });
		expect(confident.intern).toEqual({ grade: 'intern', available: false, reason: 'below_confirmed' });
		expect(confident.senior).toEqual({ grade: 'senior', available: false, reason: 'above_next_grade' });
		const after = options({
			now: day(90),
			category: { grade: 'junior', assignedAt: day(0), confidentUpgradeUntil: null }
		});
		expect(after.middle).toEqual({ grade: 'middle', available: true, kind: 'upgrade_interval' });
	});
});

describe('category', () => {
	it('gives a confident result one token, and the step taken on it gives none: no chain past 90 days', () => {
		const junior = decision('j', 'junior', 0, { confident: true });
		expect(resolveCategory([junior], GRADE_POLICY)).toEqual({
			decisionId: 'j',
			grade: 'junior',
			assignedAt: day(0),
			confidentUpgradeUntil: day(30)
		});
		const middle = decision('m', 'middle', 2, { confident: true, viaConfidentUpgrade: true });
		expect(resolveCategory([junior, middle], GRADE_POLICY)).toEqual({
			decisionId: 'm',
			grade: 'middle',
			assignedAt: day(2),
			confidentUpgradeUntil: null
		});
	});

	it('gives no token to the retake of a failed upgrade sooner than 90 days: Junior to Senior takes the interval', () => {
		// Junior confident, the Middle attempt on the token fails, the Middle retake 14 days later is confident too.
		const junior = decision('j', 'junior', 0, { confident: true });
		const failedUpgrade = decision('f', 'middle', 1, { outcome: 'not_confirmed', viaConfidentUpgrade: true });
		const retake = decision('m', 'middle', 15, { confident: true });
		const category = resolveCategory([junior, failedUpgrade, retake], GRADE_POLICY);
		expect(category).toEqual({ decisionId: 'm', grade: 'middle', assignedAt: day(15), confidentUpgradeUntil: null });
		const o = options({ now: day(16), category });
		expect(o.senior).toEqual({
			grade: 'senior',
			available: false,
			reason: 'grade_change_interval',
			availableFrom: day(105)
		});
		// The same step after the interval is a regular one: its confident result gives the token.
		const late = decision('m', 'middle', 95, { confident: true });
		expect(resolveCategory([junior, late], GRADE_POLICY)?.confidentUpgradeUntil).toEqual(day(125));
	});

	it('spends the token once an attempt on it was made, whatever its result', () => {
		const junior = decision('j', 'junior', 0, { confident: true });
		const failedUpgrade = decision('m', 'middle', 1, { outcome: 'not_confirmed', viaConfidentUpgrade: true });
		expect(resolveCategory([junior, failedUpgrade], GRADE_POLICY)?.confidentUpgradeUntil).toBeNull();
	});

	it('closes over chains of annulments: the category is what the valid decisions support', () => {
		const junior = decision('j', 'junior', 0);
		const middle = decision('m', 'middle', 100);
		const senior = decision('s', 'senior', 200);
		const middleAnnulled = { ...middle, valid: false };
		expect(resolveCategory([junior, middleAnnulled, senior], GRADE_POLICY)?.grade).toBe('senior');
		const both = [junior, middleAnnulled, { ...senior, valid: false }];
		expect(resolveCategory(both, GRADE_POLICY)).toMatchObject({ grade: 'junior', assignedAt: day(0) });
		expect(categoryChange([junior, middleAnnulled, senior], both, GRADE_POLICY)).toEqual({
			action: 'restore',
			from: 'senior',
			grade: 'junior'
		});
		expect(categoryChange([junior], [{ ...junior, valid: false }], GRADE_POLICY)).toEqual({
			action: 'revoke',
			from: 'junior'
		});
	});

	it('applies a decision that arrives after a parallel annulment instead of throwing', () => {
		const junior = decision('j', 'junior', 0);
		const middle = decision('m', 'middle', 100);
		// Middle was annulled while a Senior attempt ran; the Senior confirmation still applies.
		const before = [junior, { ...middle, valid: false }];
		expect(categoryChange(before, [...before, decision('s', 'senior', 120)], GRADE_POLICY)).toEqual({
			action: 'supersede',
			from: 'junior',
			grade: 'senior'
		});
		expect(
			categoryChange(
				[junior, middle],
				[junior, middle, decision('x', 'junior', 130, { outcome: 'not_confirmed' })],
				GRADE_POLICY
			)
		).toEqual({ action: 'keep' });
	});
});
