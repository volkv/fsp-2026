// The online watch of leaks of the bank (docs/domain.md, 10.5): two signals for a person, neither decides anything.
//
// The solve rate of a family. A family whose way of solving got out (a published generator, a shared write-up of its
// classes) is solved better than the candidates who meet it solve the rest of their test. The expectation of a live
// answer follows the model of the release's trajectory simulation (`simulate.ts`): a candidate is a shift d from the
// borderline, a computed item is right with chance clip(Angoff + d) — here d is measured on the candidate's own other
// computed items of the same attempt, so a stronger cohort raises the expectation and raises no alarm. The test is on
// the residuals «right (1 or 0) minus the expected chance» of the family's answers in the window: their mean against
// zero, one-sided, a t statistic with the residuals' own variance (its tail by the normal approximation of Student's
// t) — the shift is measured on a few items and is noisy, and the empirical variance carries that noise, where a test
// that took the chances as known would ring on honest candidates. A signal needs enough answers, an excess of the solve
// rate worth a person's look, and a tail below α split over the families tested (Bonferroni). Measured on synthetic
// honest cohorts (`leak.test.ts`): about 1 % of runs ring falsely at 40–100 answers a family, none at 400 — the normal
// approximation is loose on small skewed samples, hence α = 0.005. The signal never quarantines a family by itself.
//
// The answer of another instance. A wrong answer that is the right answer of exactly one stored instance of the same
// family and grade served to another candidate is written into the journal of the attempt (`signals.ts`).
import type { ComputedAnswer } from './contract/bank.ts';
import { answerMatches, type CandidateAnswer } from './score.ts';

export const LEAK_DETECTOR = {
	version: 'leak-1',
	/** Answers of the last this many days count. */
	windowDays: 30,
	/** Fewer answers of a family in the window — no test at all: on small numbers an excess is noise. */
	minResponses: 40,
	/** An answer counts only if its attempt has this many other computed items to measure the candidate's shift on. */
	minOtherItems: 4,
	/** Observed minus expected solve rate below this is not worth a person's look, whatever the tail. */
	minExcess: 0.15,
	/** Family-wise error over the families of a specialization tested in the window (nominal; measured above). */
	alpha: 0.005,
	/** The chance of a right answer is clipped as in the simulation of trajectories. */
	clip: [0.02, 0.98] as const,
	/** The newest answers of a family taken into the test: the window of a family that is served a lot. */
	maxResponses: 2000
} as const;

export type LeakParams = typeof LEAK_DETECTOR;

/** One scored computed item of a live attempt. */
export interface LiveResponse {
	attemptId: string;
	familyKey: string;
	/** The Angoff estimate of the family-level served. */
	angoff: number;
	correct: boolean;
	/** For ordering: the newest answers are taken first. */
	answeredAt: Date;
}

export interface FamilyFinding {
	familyKey: string;
	/** Answers tested: those whose attempt has enough other items. */
	n: number;
	/** Answers of the family in the window without enough other items in their attempt. */
	skipped: number;
	observed: number;
	expected: number;
	/** Observed and expected solve rates; `null` — nothing tested. */
	observedRate: number | null;
	expectedRate: number | null;
	/** One-sided tail of the mean residual; `null` — fewer than `minResponses`, not tested. */
	pValue: number | null;
	/** α / m: the bar of the tail for this specialization. */
	bar: number;
	signal: boolean;
}

const clipChance = (p: number, params: LeakParams): number => Math.min(params.clip[1], Math.max(params.clip[0], p));

/** P(Z ≥ z) of the standard normal (erfc with fractional error below 1.2e-7, Numerical Recipes `erfcc`). */
export function normalUpperTail(z: number): number {
	const x = Math.abs(z) / Math.SQRT2;
	const t = 1 / (1 + 0.5 * x);
	const poly =
		-1.26551223 +
		t *
			(1.00002368 +
				t *
					(0.37409196 +
						t *
							(0.09678418 +
								t *
									(-0.18628806 +
										t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
	const erfc = t * Math.exp(-x * x + poly);
	return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/**
 * The one-sided tail of the mean of residuals above zero: t = mean·√n / s, its Student tail with n − 1 degrees of
 * freedom by the normal approximation z = t·(1 − 1/(4ν)) / √(1 + t²/(2ν)).
 */
function residualTail(residuals: readonly number[]): number {
	const n = residuals.length;
	const mean = residuals.reduce((sum, r) => sum + r, 0) / n;
	const variance = residuals.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (n - 1);
	if (variance === 0) return mean > 0 ? 0 : 1;
	const t = (mean * Math.sqrt(n)) / Math.sqrt(variance);
	const df = n - 1;
	return normalUpperTail((t * (1 - 1 / (4 * df))) / Math.sqrt(1 + (t * t) / (2 * df)));
}

/**
 * Each family's live answers against the expectation of the candidates who gave them, and which of them make a signal.
 * Families are returned by decreasing excess of the solve rate.
 */
export function familyFindings(
	responses: readonly LiveResponse[],
	params: LeakParams = LEAK_DETECTOR
): FamilyFinding[] {
	const byAttempt = new Map<string, LiveResponse[]>();
	for (const response of responses) {
		const list = byAttempt.get(response.attemptId) ?? [];
		list.push(response);
		byAttempt.set(response.attemptId, list);
	}
	const byFamily = new Map<string, { tested: { correct: boolean; chance: number; at: number }[]; skipped: number }>();
	for (const items of byAttempt.values()) {
		const right = items.reduce((sum, item) => sum + (item.correct ? 1 : 0), 0);
		const angoff = items.reduce((sum, item) => sum + item.angoff, 0);
		for (const item of items) {
			const entry = byFamily.get(item.familyKey) ?? { tested: [], skipped: 0 };
			byFamily.set(item.familyKey, entry);
			const others = items.length - 1;
			if (others < params.minOtherItems) {
				entry.skipped += 1;
				continue;
			}
			const shift = (right - (item.correct ? 1 : 0)) / others - (angoff - item.angoff) / others;
			entry.tested.push({
				correct: item.correct,
				chance: clipChance(item.angoff + shift, params),
				at: item.answeredAt.getTime()
			});
		}
	}
	const drafts = [...byFamily].map(([familyKey, { tested, skipped }]) => {
		const kept = [...tested].sort((a, b) => b.at - a.at).slice(0, params.maxResponses);
		const observed = kept.filter((t) => t.correct).length;
		const expected = kept.reduce((sum, t) => sum + t.chance, 0);
		const n = kept.length;
		return {
			familyKey,
			n,
			skipped: skipped + (tested.length - n),
			observed,
			expected,
			observedRate: n === 0 ? null : observed / n,
			expectedRate: n === 0 ? null : expected / n,
			residuals: kept.map((t) => (t.correct ? 1 : 0) - t.chance)
		};
	});
	const testable = drafts.filter((d) => d.n >= params.minResponses);
	const bar = params.alpha / Math.max(1, testable.length);
	return drafts
		.map(({ residuals, ...draft }): FamilyFinding => {
			const pValue = draft.n >= params.minResponses ? residualTail(residuals) : null;
			const excess =
				draft.observedRate === null || draft.expectedRate === null ? null : draft.observedRate - draft.expectedRate;
			return {
				...draft,
				pValue,
				bar,
				signal: pValue !== null && excess !== null && excess >= params.minExcess && pValue <= bar
			};
		})
		.sort((a, b) => excessOf(b) - excessOf(a) || (a.familyKey < b.familyKey ? -1 : 1));
}

const excessOf = (f: FamilyFinding): number =>
	f.observedRate === null || f.expectedRate === null ? -Infinity : f.observedRate - f.expectedRate;

/** How many stored instances of other candidates a wrong answer is compared with: the newest served. */
export const FOREIGN_COMPARED = 50;

/** Answer kinds too small to tell instances apart: a line number of a short program repeats from instance to instance. */
const FOREIGN_SKIPPED_KINDS: readonly ComputedAnswer['kind'][] = ['line_no'];

/**
 * The instance whose right answer a wrong answer is: exactly one of `others` accepts it — an answer that several
 * instances share is a common answer, not another's. `null` — none, or the kind of answer cannot tell.
 */
export function foreignInstance<T extends { answer: ComputedAnswer }>(
	given: CandidateAnswer,
	others: readonly T[]
): T | null {
	const matched = others.filter(
		(other) => !FOREIGN_SKIPPED_KINDS.includes(other.answer.kind) && answerMatches(other.answer, given)
	);
	return matched.length === 1 ? (matched[0] ?? null) : null;
}
