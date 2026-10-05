import { describe, expect, it } from 'vitest';
import { GRADE_KEYS } from './catalog';
import {
	PROCEDURE,
	ProcedureError,
	boundaries,
	clusterLlr,
	decisionConsistency,
	exhaustedDecision,
	nextStep,
	operatingPoint,
	type ClusterResult
} from './procedure';

const item = (score: number, angoff = 0.6, block = 'be.db'): ClusterResult => ({
	block,
	angoff,
	score,
	practice: false
});
const practice = (score: number, angoff = 0.6): ClusterResult => ({ block: 'be.code', angoff, score, practice: true });

/** A trajectory of `n` clusters with the practice cluster fourth. */
function trajectory(scores: readonly number[], practiceScore: number): ClusterResult[] {
	const clusters = scores.map((score) => item(score));
	clusters.splice(3, 0, practice(practiceScore));
	return clusters;
}

describe('operating characteristic (exact, homogeneous items)', () => {
	const acceptance = PROCEDURE.homogeneousAcceptance;

	it.each(GRADE_KEYS)('meets the frozen acceptance for %s', (grade) => {
		for (const cut of acceptance.cuts) {
			const low = operatingPoint(PROCEDURE, grade, cut, cut - acceptance.shift);
			const high = operatingPoint(PROCEDURE, grade, cut, Math.min(0.99, cut + acceptance.shift));
			expect(low.confirmed, `${grade} cut ${cut}: false confirmation`).toBeLessThanOrEqual(
				acceptance.falseConfirmMax[grade]
			);
			expect(high.confirmed, `${grade} cut ${cut}: true confirmation`).toBeGreaterThanOrEqual(
				acceptance.trueConfirmMin
			);
			for (let share = 0.05; share < 1; share += 0.01) {
				const point = operatingPoint(PROCEDURE, grade, cut, share);
				expect(point.undetermined, `${grade} cut ${cut} share ${share.toFixed(2)}`).toBeLessThanOrEqual(
					acceptance.undeterminedMax
				);
				expect(point.confirmed + point.undetermined + point.notConfirmed).toBeCloseTo(1, 9);
			}
		}
	});

	it('confirms the borderline candidate about half of the time and decides by the longest trajectory', () => {
		for (const grade of GRADE_KEYS) {
			const borderline = operatingPoint(PROCEDURE, grade, 0.6, 0.6);
			expect(borderline.confirmed).toBeGreaterThan(0.3);
			expect(borderline.confirmed).toBeLessThan(0.65);
			const { nMax, extension } = PROCEDURE.grades[grade];
			expect(borderline.expectedLength).toBeLessThanOrEqual(nMax + extension);
		}
	});

	it('gives repeated attempts of a clear candidate the same outcome', () => {
		expect(decisionConsistency(operatingPoint(PROCEDURE, 'middle', 0.6, 0.85))).toBeGreaterThan(0.9);
		expect(decisionConsistency(operatingPoint(PROCEDURE, 'middle', 0.6, 0.3))).toBeGreaterThan(0.9);
	});
});

describe('nextStep', () => {
	it('waits for the minimum length', () => {
		expect(nextStep(PROCEDURE, 'middle', 0.6, trajectory([1, 1, 1, 1], 1))).toEqual({ kind: 'continue' });
	});

	it('confirms on the upper boundary with the practice passed, and reports blocks and confidence', () => {
		// Six right answers at a cut of 0.6 stay just under the boundary; the seventh crosses it.
		expect(nextStep(PROCEDURE, 'middle', 0.6, trajectory([1, 1, 1, 1, 1], 1))).toEqual({ kind: 'continue' });
		const step = nextStep(PROCEDURE, 'middle', 0.6, trajectory([1, 1, 1, 1, 1, 1], 1));
		if (step.kind !== 'decided') throw new Error(step.kind);
		const { upper } = boundaries(PROCEDURE);
		expect(step.decision).toMatchObject({ outcome: 'confirmed', reason: 'sprt_upper', confident: true, clusters: 7 });
		expect(step.decision.llr).toBeGreaterThanOrEqual(upper);
		expect(step.decision.blocks).toEqual([
			{ block: 'be.db', items: 6, score: 6, cut: expect.closeTo(3.6, 9) as number, verdict: 'above', passed: true },
			{ block: 'be.code', items: 1, score: 1, cut: 0.6, verdict: 'at', passed: false }
		]);
	});

	it('turns a confirmation into a failure when the practice cluster is under the gate', () => {
		const step = nextStep(PROCEDURE, 'middle', 0.6, trajectory([1, 1, 1, 1, 1, 1, 1], 0.5));
		if (step.kind !== 'decided') throw new Error(step.kind);
		expect(step.decision).toMatchObject({
			outcome: 'not_confirmed',
			reason: 'practice_gate_failed',
			practice: { score: 0.5, gateMinScore: 0.6, passed: false }
		});
		expect(step.decision.blocks.every((b) => !b.passed)).toBe(true);
	});

	it('rejects on the lower boundary', () => {
		const step = nextStep(PROCEDURE, 'junior', 0.5, trajectory([0, 0, 0, 0, 0], 0));
		expect(step).toMatchObject({ kind: 'decided', decision: { outcome: 'not_confirmed', reason: 'sprt_lower' } });
	});

	it('extends inside the band at the end of the main part and ends undetermined inside the final band', () => {
		const { nMax, extension } = PROCEDURE.grades.senior;
		// Scores equal to the cut keep the ratio near zero: neither boundary nor band is ever crossed.
		const even = Array.from({ length: nMax - 1 }, () => 0.6);
		expect(nextStep(PROCEDURE, 'senior', 0.6, trajectory(even, 0.6))).toEqual({ kind: 'extend' });
		const longer = Array.from({ length: nMax + extension - 1 }, () => 0.6);
		expect(nextStep(PROCEDURE, 'senior', 0.6, trajectory(longer, 0.6))).toMatchObject({
			kind: 'decided',
			decision: { outcome: 'undetermined', reason: 'band_after_extension', extensionUsed: true }
		});
	});

	it('scores a fractional cluster between its binary extremes', () => {
		const delta = PROCEDURE.delta;
		const half = clusterLlr(item(0.5), delta);
		expect(half).toBeGreaterThan(clusterLlr(item(0), delta));
		expect(half).toBeLessThan(clusterLlr(item(1), delta));
	});

	it('ends undetermined when the bank is exhausted', () => {
		expect(exhaustedDecision(PROCEDURE, 'intern', 0.5, trajectory([1, 1], 1))).toMatchObject({
			outcome: 'undetermined',
			reason: 'bank_exhausted'
		});
	});

	it('refuses trajectories that break the blueprint', () => {
		const noPractice = Array.from({ length: 6 }, () => item(1));
		expect(() => nextStep(PROCEDURE, 'middle', 0.6, noPractice)).toThrow(ProcedureError);
		const twoPractices = [...trajectory([1, 1, 1, 1], 1), practice(1)];
		expect(() => nextStep(PROCEDURE, 'middle', 0.6, twoPractices)).toThrow(ProcedureError);
		const tooLong = trajectory(
			Array.from({ length: 18 }, () => 1),
			1
		);
		expect(() => nextStep(PROCEDURE, 'middle', 0.6, tooLong)).toThrow(ProcedureError);
		expect(() => nextStep(PROCEDURE, 'middle', 0.6, trajectory([1, 1, 1, 1, 1, 1.5], 1))).toThrow(ProcedureError);
	});
});
