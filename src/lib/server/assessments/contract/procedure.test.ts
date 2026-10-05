import { describe, expect, it } from 'vitest';
import { CATALOG, GRADE_KEYS, gradeDefinition, type GradeKey } from './catalog';
import { slotSequence } from './bank';
import {
	PROCEDURE,
	ProcedureError,
	boundaries,
	decisionConsistency,
	exhaustedDecision,
	hypotheses,
	itemLlr,
	nextStep,
	operatingPoint,
	redecide,
	simulateTrajectories,
	acceptanceCheckPasses,
	nextRunCount,
	trajectoryChecks,
	type AcceptanceCheck,
	type ClusterResult,
	type DecisionRule,
	type ProcedureParams
} from './procedure';

const H = PROCEDURE.homogeneousAcceptance;
const clamp = (s: number) => Math.min(0.99, Math.max(0.01, s));

/** A trajectory on the real plan of a definition: item scores in slot order, the practice at its slot. */
function trajectory(
	rule: { specialization: string; grade: GradeKey },
	scores: readonly number[],
	practice: number,
	angoff = 0.6
) {
	const definition = gradeDefinition(rule.specialization as 'backend', rule.grade);
	const slots = slotSequence(definition);
	const clusters: ClusterResult[] = [];
	let i = 0;
	for (const slot of slots) {
		if (slot.practice) {
			clusters.push({ block: slot.block, angoff: 0.8, score: practice, practice: true });
			continue;
		}
		const score = scores[i];
		if (score === undefined) break;
		clusters.push({ block: slot.block, angoff, score, practice: false });
		i += 1;
	}
	return { definition, clusters };
}

describe('exact operating characteristic (homogeneous binary items)', () => {
	it.each(GRADE_KEYS)('meets the frozen acceptance for %s', (grade) => {
		for (const cut of H.cuts) {
			expect(operatingPoint(PROCEDURE, grade, cut, cut - 0.15).confirmed, `${grade} ${cut} FC`).toBeLessThanOrEqual(
				H.falseConfirmMax[grade]
			);
			expect(
				operatingPoint(PROCEDURE, grade, cut, clamp(cut + 0.15)).confirmed,
				`${grade} ${cut} TC`
			).toBeGreaterThanOrEqual(H.trueConfirmMin[grade]);
			for (let share = 0.02; share < 0.99; share += 0.01) {
				const point = operatingPoint(PROCEDURE, grade, cut, share);
				expect(point.undetermined, `${grade} ${cut} ${share.toFixed(2)}`).toBeLessThanOrEqual(H.undeterminedMax);
				expect(point.confirmed + point.undetermined + point.notConfirmed).toBeCloseTo(1, 9);
			}
		}
	});

	it.each(GRADE_KEYS)('publishes the real errors at the ends of the indifference zone for %s', (grade) => {
		for (const cut of H.cuts) {
			const { p0, p1 } = hypotheses(cut, PROCEDURE.delta);
			expect(operatingPoint(PROCEDURE, grade, cut, p0).confirmed).toBeLessThanOrEqual(
				H.indifferenceErrorsMax[grade].atP0Confirmed
			);
			expect(operatingPoint(PROCEDURE, grade, cut, p1).notConfirmed).toBeLessThanOrEqual(
				H.indifferenceErrorsMax[grade].atP1NotConfirmed
			);
			// The nominal α = β = 0.10 is not what the truncated test delivers: the real rates are higher.
			expect(operatingPoint(PROCEDURE, grade, cut, p0).confirmed).toBeGreaterThan(PROCEDURE.alpha);
		}
	});

	it.each(GRADE_KEYS)('stays within the bounds when the Angoff estimates are biased (%s)', (grade) => {
		for (const { bias, falseConfirmMax, trueConfirmMin } of H.biasSensitivity) {
			for (const cut of H.cuts) {
				expect(operatingPoint(PROCEDURE, grade, cut, clamp(cut + bias - 0.15)).confirmed).toBeLessThanOrEqual(
					falseConfirmMax
				);
				expect(operatingPoint(PROCEDURE, grade, cut, clamp(cut + bias + 0.15)).confirmed).toBeGreaterThanOrEqual(
					trueConfirmMin
				);
			}
		}
	});

	it.each(GRADE_KEYS)('gives repeated attempts the published consistency at given distances (%s)', (grade) => {
		for (const { shift, min } of H.consistencyMin) {
			for (const cut of H.cuts) {
				expect(decisionConsistency(operatingPoint(PROCEDURE, grade, cut, clamp(cut + shift)))).toBeGreaterThanOrEqual(
					min
				);
			}
		}
	});

	it('equals the procedure itself: every binary trajectory of Intern enumerated through nextStep', () => {
		// The block rule never bites here, so the sequential part alone is compared.
		const params: ProcedureParams = { ...PROCEDURE, definingFailMargin: 20 };
		const definition = gradeDefinition('backend', 'intern');
		const n = params.grades.intern.nMax + params.grades.intern.extension;
		for (const share of [0.45, 0.6, 0.75]) {
			let confirmed = 0;
			let undetermined = 0;
			for (let mask = 0; mask < 2 ** n; mask += 1) {
				const scores = Array.from({ length: n }, (_, i) => (mask >> i) & 1);
				const { clusters } = trajectory(definition, scores, 1);
				let step = { kind: 'continue' } as ReturnType<typeof nextStep>;
				let used = 0;
				for (let k = 1; k <= clusters.length && step.kind !== 'decided'; k += 1) {
					step = nextStep(params, definition, clusters.slice(0, k));
					used = k;
				}
				if (step.kind !== 'decided') throw new Error('no decision');
				const items = clusters.slice(0, used).filter((c) => !c.practice);
				const ones = items.filter((c) => c.score === 1).length;
				// Probability of this prefix; the rest of the mask is summed out by counting each prefix once.
				const rest = n - items.length;
				if (mask >> items.length !== 0 && rest > 0) continue;
				const p = share ** ones * (1 - share) ** (items.length - ones);
				if (step.decision.outcome === 'confirmed') confirmed += p;
				if (step.decision.outcome === 'undetermined') undetermined += p;
			}
			const exact = operatingPoint(params, 'intern', 0.6, share);
			expect(confirmed).toBeCloseTo(exact.confirmed, 12);
			expect(undetermined).toBeCloseTo(exact.undetermined, 12);
		}
	}, 120_000);
});

describe('integer arithmetic of the bands', () => {
	it('decides exactly on the band (inclusive), whatever the order of the items', () => {
		// Far boundaries leave the decision to the band: at nMax = 14 it is 2·(S₂₀ − C₂₀) ≥ 2·14.
		const params: ProcedureParams = { ...PROCEDURE, alpha: 1e-6, beta: 1e-6, definingFailMargin: 20 };
		const definition = gradeDefinition('backend', 'junior');
		// Angoff 0.6 on 14 items: C₂₀ = 168; nine right answers and one at 0.1 give S₂₀ = 182 = C₂₀ + 14, on the band.
		const onBand = [1, 1, 1, 0, 1, 0, 1, 0, 1, 0.1, 1, 0, 1, 1];
		const reordered = [0, 1, 0.1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1];
		const under = [1, 1, 1, 0, 1, 0, 1, 0, 1, 0.05, 1, 0, 1, 1];
		const last = (scores: number[]) => {
			const { clusters } = trajectory(definition, scores, 1);
			return nextStep(params, definition, clusters);
		};
		expect(last(onBand)).toMatchObject({
			kind: 'decided',
			decision: { outcome: 'confirmed', reason: 'forced_upper_at_max', scoreSum: 182, cutSum: 168 }
		});
		expect(last(reordered)).toMatchObject({ kind: 'decided', decision: { outcome: 'confirmed', scoreSum: 182 } });
		expect(last(under)).toEqual({ kind: 'extend' });
	});

	it('rounds every item to millionths, so the ratio does not depend on the order', () => {
		const items = [12, 12, 12, 12, 12, 12].map((angoff, i) => itemLlr(angoff, i % 2 ? 20 : 0, PROCEDURE.delta));
		const forward = items.reduce((s, x) => s + x, 0);
		const backward = [...items].reverse().reduce((s, x) => s + x, 0);
		expect(Number.isInteger(forward)).toBe(true);
		expect(forward).toBe(backward);
	});

	it('refuses scores and estimates off the scale of twentieths', () => {
		const definition = gradeDefinition('backend', 'junior');
		const { clusters } = trajectory(definition, [1, 1, 1, 1, 1, 1], 1);
		const first = clusters[0];
		if (!first) throw new Error('no cluster');
		clusters[0] = { ...first, score: 0.333 };
		expect(() => nextStep(PROCEDURE, definition, clusters)).toThrow(ProcedureError);
		expect(() => itemLlr(12, 21, PROCEDURE.delta)).toThrow(ProcedureError);
	});
});

describe('nextStep', () => {
	const definition = gradeDefinition('backend', 'middle');

	it('waits for the minimum number of items', () => {
		expect(nextStep(PROCEDURE, definition, trajectory(definition, [1, 1, 1, 1, 1], 1).clusters)).toEqual({
			kind: 'continue'
		});
	});

	it('confirms on the upper boundary with the defining blocks seen and passed; the stack does not depend on length', () => {
		const { upper } = boundaries(PROCEDURE);
		const { clusters } = trajectory(definition, [1, 1, 1, 1, 1, 1, 1], 1);
		const step = nextStep(PROCEDURE, definition, clusters);
		if (step.kind !== 'decided') throw new Error(step.kind);
		expect(step.decision).toMatchObject({ outcome: 'confirmed', reason: 'sprt_upper', confident: true, items: 7 });
		expect(step.decision.llr).toBeGreaterThanOrEqual(upper);
		const defining = step.decision.blocks.filter((b) => b.defining);
		expect(defining.map((b) => [b.block, b.items, b.passed])).toEqual([
			['be.db', 3, true],
			['be.concurrency', 3, true]
		]);
		expect(step.decision.blocks.filter((b) => !b.defining).every((b) => !b.passed)).toBe(true);
	});

	it('ends the attempt at once when the practice is under the gate, and the practice never enters the sums', () => {
		const { clusters } = trajectory(definition, [1, 1, 1], 0.2);
		const step = nextStep(PROCEDURE, definition, clusters);
		expect(step).toMatchObject({
			kind: 'decided',
			decision: { outcome: 'not_confirmed', reason: 'practice_gate_failed', items: 3, scoreSum: 60, cutSum: 36 }
		});
		const passed = trajectory(definition, [1, 1, 1], 0.4).clusters;
		expect(nextStep(PROCEDURE, definition, passed)).toEqual({ kind: 'continue' });
	});

	it('refuses a confirmation when a defining block fails', () => {
		// be.db items are slots 1, 3, 6 of the plan; all three wrong, the rest right.
		const scores = [0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
		const { clusters } = trajectory(definition, scores, 1);
		let decision = null;
		for (let k = 1; k <= clusters.length && !decision; k += 1) {
			const step = nextStep(PROCEDURE, definition, clusters.slice(0, k));
			if (step.kind === 'decided') decision = step.decision;
		}
		expect(decision).toMatchObject({ outcome: 'not_confirmed', reason: 'defining_block_failed' });
	});

	it('rejects on the lower boundary', () => {
		const { clusters } = trajectory(definition, [0, 0, 0, 0, 0, 0], 1);
		expect(nextStep(PROCEDURE, definition, clusters)).toMatchObject({
			kind: 'decided',
			decision: { outcome: 'not_confirmed', reason: 'sprt_lower' }
		});
	});

	it('extends inside the band at the end of the main part; at the end only a margin above the cut is undetermined', () => {
		const { nMax, extension } = PROCEDURE.grades.senior;
		const senior = gradeDefinition('backend', 'senior');
		const even = (n: number) => Array.from({ length: n }, () => 0.6);
		const end = nMax + extension;
		const final = (scores: number[]) => nextStep(PROCEDURE, senior, trajectory(senior, scores, 1).clusters);
		expect(final(even(nMax))).toEqual({ kind: 'extend' });
		// 17 items at Angoff 0.6: C₂₀ = 204. The final band is 0 < 2·(S₂₀ − C₂₀) < 17.
		expect(final(even(end))).toMatchObject({
			kind: 'decided',
			decision: { outcome: 'not_confirmed', reason: 'forced_lower_final', extensionUsed: true }
		});
		expect(final([...even(end - 1), 0.85])).toMatchObject({
			kind: 'decided',
			decision: { outcome: 'undetermined', reason: 'band_after_extension', scoreSum: 209, cutSum: 204 }
		});
		expect(final([...even(end - 2), 1, 1])).toMatchObject({
			kind: 'decided',
			decision: { outcome: 'confirmed', reason: 'forced_upper_final', scoreSum: 220 }
		});
	});

	it('ends undetermined when the bank is exhausted', () => {
		const { clusters } = trajectory(definition, [1, 1], 1);
		expect(exhaustedDecision(PROCEDURE, definition, clusters)).toMatchObject({
			outcome: 'undetermined',
			reason: 'bank_exhausted'
		});
	});

	it('refuses trajectories that break the plan', () => {
		const rule: DecisionRule = definition;
		const noPractice = Array.from({ length: 6 }, (): ClusterResult => ({
			block: 'be.db',
			angoff: 0.6,
			score: 1,
			practice: false
		}));
		expect(() => nextStep(PROCEDURE, rule, noPractice)).toThrow(ProcedureError);
		const { clusters } = trajectory(definition, [1, 1, 1, 1], 1);
		const practice = clusters.find((c) => c.practice);
		if (!practice) throw new Error('no practice');
		expect(() => nextStep(PROCEDURE, rule, [...clusters, { ...practice }])).toThrow(ProcedureError);
		const uncovered = clusters.map((c) => (c.practice ? c : { ...c, block: 'be.api' }));
		const more = [
			...uncovered,
			...[1, 1].map((): ClusterResult => ({ block: 'be.api', angoff: 0.6, score: 1, practice: false }))
		];
		expect(() => nextStep(PROCEDURE, rule, more)).toThrow(ProcedureError);
	});
});

describe('redecide', () => {
	const definition = gradeDefinition('backend', 'middle');

	it('replays the procedure and stops where it would have stopped', () => {
		const { clusters } = trajectory(definition, [1, 1, 1, 1, 1, 1, 1], 1);
		expect(redecide(PROCEDURE, definition, clusters)).toMatchObject({
			outcome: 'confirmed',
			reason: 'sprt_upper',
			items: 7
		});
	});

	it('ends undetermined (a system end) when the corrected trajectory no longer decides at its length', () => {
		const { clusters } = trajectory(definition, [1, 1, 1, 1, 1, 1, 1], 1);
		const corrected = clusters.map((c, i) => (i === clusters.length - 1 ? { ...c, score: 0 } : c));
		expect(redecide(PROCEDURE, definition, corrected)).toMatchObject({
			outcome: 'undetermined',
			reason: 'rescored_incomplete'
		});
	});

	it('turns a confirmation into a gate failure when the practice is re-scored under the gate', () => {
		const { clusters } = trajectory(definition, [1, 1, 1, 1, 1, 1, 1], 1);
		const corrected = clusters.map((c) => (c.practice ? { ...c, score: 0.2 } : c));
		expect(redecide(PROCEDURE, definition, corrected)).toMatchObject({
			outcome: 'not_confirmed',
			reason: 'practice_gate_failed'
		});
	});
});

describe('whole trajectories under the answer model', () => {
	const T = PROCEDURE.trajectoryAcceptance;
	const plans = CATALOG.definitions.map((d) => [`${d.specialization} × ${d.grade}`, d] as const);

	/**
	 * Checks of one plan under one profile of Angoff estimates, settled by the contract's own schedule: recomputed at the
	 * next count while some check is within the Monte Carlo error of its bound.
	 */
	function settle(make: (runs: number) => AcceptanceCheck[]): AcceptanceCheck[] {
		let runs: number | null = T.runSchedule[0] ?? null;
		let checks: AcceptanceCheck[] = [];
		while (runs !== null) {
			checks = make(runs);
			runs = nextRunCount(PROCEDURE, runs, checks);
		}
		return checks;
	}

	const simulate = (
		definition: (typeof CATALOG.definitions)[number],
		profile: readonly number[],
		seed: number,
		runs: number,
		shift: number,
		definingBlockShift?: number
	) =>
		simulateTrajectories(PROCEDURE, definition, slotSequence(definition), T.model, shift, runs, {
			seed: [seed, Math.round(shift * 100) + 100, definingBlockShift === undefined ? 0 : 1, runs],
			profile,
			...(definingBlockShift === undefined ? {} : { definingBlockShift })
		});

	it.each(plans)(
		'%s meets the trajectory acceptance under every profile of Angoff estimates',
		(_, definition) => {
			T.model.itemAngoffProfiles.forEach((profile, i) => {
				const checks = settle((runs) => {
					const points = [-0.15, 0, 0.15].map((shift) => simulate(definition, profile, i + 1, runs, shift));
					const consistency = T.consistencyMin.map(({ shift }) => {
						const point = points.find((p) => p.shift === shift);
						if (!point) throw new Error(`no point at ${shift}`);
						return { shift, value: decisionConsistency(point) };
					});
					return trajectoryChecks(PROCEDURE, definition.grade, points, consistency);
				});
				for (const check of checks) {
					expect(acceptanceCheckPasses(check), `[${profile.join(', ')}] ${check.label} ${check.estimate}`).toBe(true);
				}
			});
		},
		120_000
	);

	it.each(plans)(
		'%s: a weak defining block keeps the confirmation within its bound under every profile',
		(_, definition) => {
			T.model.itemAngoffProfiles.forEach((profile, i) => {
				const [check] = settle((runs) => [
					{
						label: 'weak defining block',
						estimate: simulate(definition, profile, i + 1, runs, 0.15, -0.55).confirmed,
						bound: T.weakDefiningBlockConfirmMax,
						side: 'max',
						runs,
						spread: 1
					}
				]);
				if (!check) throw new Error('no check');
				expect(acceptanceCheckPasses(check), `[${profile.join(', ')}] ${check.label} ${check.estimate}`).toBe(true);
			});
		},
		120_000
	);
});
