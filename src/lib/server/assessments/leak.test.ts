import { describe, expect, it } from 'vitest';
import type { ComputedAnswer } from './contract/bank';
import { LEAK_DETECTOR, familyFindings, foreignInstance, normalUpperTail, type LiveResponse } from './leak';

/** A deterministic generator of [0, 1): the same draws on every run. */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const clip = (p: number) => Math.min(0.98, Math.max(0.02, p));

/**
 * `attempts` attempts of candidates with shifts spread around the borderline; each has five other computed families
 * and the watched family `w`, answered right with the model chance plus `leak` (a leaked family is easier than it is).
 */
function cohort(attempts: number, leak: number, seed = 1): LiveResponse[] {
	const random = lcg(seed);
	const at = new Date('2026-10-10T12:00:00Z');
	const responses: LiveResponse[] = [];
	for (let a = 0; a < attempts; a += 1) {
		const shift = -0.15 + 0.3 * random();
		const items = [
			...['f1', 'f2', 'f3', 'f4', 'f5'].map((familyKey) => ({ familyKey, angoff: 0.6, bonus: 0 })),
			{ familyKey: 'w', angoff: 0.55, bonus: leak }
		];
		for (const item of items) {
			responses.push({
				attemptId: `a${a}`,
				familyKey: item.familyKey,
				angoff: item.angoff,
				correct: random() < clip(item.angoff + shift + item.bonus),
				answeredAt: at
			});
		}
	}
	return responses;
}

const watched = (responses: LiveResponse[], params = LEAK_DETECTOR) => {
	const finding = familyFindings(responses, params).find((f) => f.familyKey === 'w');
	if (!finding) throw new Error('no finding of the watched family');
	return finding;
};

describe('the normal tail', () => {
	it('matches the table of the standard normal', () => {
		expect(normalUpperTail(0)).toBeCloseTo(0.5, 7);
		expect(normalUpperTail(1.959964)).toBeCloseTo(0.025, 6);
		expect(normalUpperTail(3.090232)).toBeCloseTo(0.001, 6);
		expect(normalUpperTail(-1.644854)).toBeCloseTo(0.95, 6);
	});
});

describe('the solve rate of a family', () => {
	it('raises no signal on a family solved as the model expects', () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			expect(watched(cohort(400, 0, seed)).signal).toBe(false);
		}
	});

	it('rings rarely on honest cohorts of 100 answers: at most 2 % of runs have any false signal among six families', () => {
		let rang = 0;
		for (let seed = 1; seed <= 1000; seed += 1) {
			if (familyFindings(cohort(100, 0, seed)).some((f) => f.signal)) rang += 1;
		}
		expect(rang).toBeLessThanOrEqual(20);
	});

	it('raises no signal on few answers, however anomalous', () => {
		// Twenty answers, all right, where about a half was expected: a tail far below α, yet no test.
		const finding = watched(cohort(20, 0.6));
		expect(finding.n).toBe(20);
		expect(finding.observedRate).toBeGreaterThan(0.9);
		expect(finding.pValue).toBeNull();
		expect(finding.signal).toBe(false);
	});

	it('raises the signal on a family solved far better than its candidates solve the rest', () => {
		const finding = watched(cohort(120, 0.35));
		expect(finding.signal).toBe(true);
		expect((finding.observedRate ?? 0) - (finding.expectedRate ?? 1)).toBeGreaterThanOrEqual(LEAK_DETECTOR.minExcess);
		expect(finding.pValue).not.toBeNull();
		expect(finding.pValue ?? 1).toBeLessThanOrEqual(finding.bar);
		// The other families are not touched by the leak of one.
		expect(
			familyFindings(cohort(120, 0.35))
				.filter((f) => f.signal)
				.map((f) => f.familyKey)
		).toEqual(['w']);
	});

	it('expects more of a stronger cohort: a strong cohort on an ordinary family is no signal', () => {
		const strong = cohort(400, 0).map((r) => ({ ...r, correct: r.correct || r.attemptId.endsWith('1') }));
		expect(watched(strong).signal).toBe(false);
	});

	it('skips answers of attempts too short to measure the candidate on', () => {
		const short = cohort(100, 0.35).filter((r) => r.familyKey === 'w' || r.familyKey === 'f1');
		const finding = watched(short);
		expect(finding.n).toBe(0);
		expect(finding.skipped).toBe(100);
		expect(finding.signal).toBe(false);
	});
});

describe('the answer of another instance', () => {
	const exact = (value: string): ComputedAnswer => ({ kind: 'exact', value });

	it('names the one other instance whose right answer it is', () => {
		const others = [
			{ id: 'x', answer: exact('17') },
			{ id: 'y', answer: exact('42') }
		];
		expect(foreignInstance('42', others)?.id).toBe('y');
		expect(foreignInstance('5', others)).toBeNull();
	});

	it('names none for an answer several instances share or a line number', () => {
		expect(
			foreignInstance('42', [
				{ id: 'x', answer: exact('42') },
				{ id: 'y', answer: exact('42') }
			])
		).toBeNull();
		expect(foreignInstance('7', [{ id: 'x', answer: { kind: 'line_no', value: 7 } }])).toBeNull();
	});
});
