// Adaptive quiz (docs/domain.md, section 10.1, `item_bank`): the next question and the stop are chosen from the answers
// so far. The model is item response theory with three parameters, two of them fixed: one discrimination for all
// items and guessing equal to 1 / number of options; only the difficulty is per item, set by the author.
//
// Why this and not a staircase: a staircase moves one step up or down and ends with a level but no measure of how sure
// it is. The posterior over the ability scale gives both the estimate and its spread, so the quiz stops when the
// estimate is precise enough, and the result carries a confidence — the probability that the ability lies within the
// band of the level it was given. Difficulties are expert settings, not calibrated on answers; the coverage says so.
import { createHash } from 'node:crypto';
import type { LevelScale, QuizItem, QuizRule } from './bank';

type AbilityScale = Extract<LevelScale, { type: 'ability' }>;

export interface AnsweredStep {
	itemId: string;
	correct: boolean;
}

export interface AbilityEstimate {
	/** Mean of the posterior (expected a posteriori). */
	ability: number;
	/** Standard deviation of the posterior. */
	standardError: number;
	grid: number[];
	/** Posterior weights over `grid`, summing to 1. */
	weights: number[];
}

export interface QuizLevel {
	level: string;
	/** `null` — the ability is below the first level: no level is confirmed. */
	cut: AbilityScale['cuts'][number] | null;
	/** Posterior probability that the ability lies within the band of `level`. */
	confidence: number;
}

function guessing(item: QuizItem): number {
	return 1 / item.options.length;
}

/** Probability of a correct answer at ability `theta`. */
export function correctProbability(rule: QuizRule, item: QuizItem, theta: number): number {
	const c = guessing(item);
	return c + (1 - c) / (1 + Math.exp(-rule.discrimination * (theta - item.difficulty)));
}

/** Fisher information of the item at `theta` under the three-parameter model. */
export function itemInformation(rule: QuizRule, item: QuizItem, theta: number): number {
	const c = guessing(item);
	const p = correctProbability(rule, item, theta);
	const ratio = (p - c) / (1 - c);
	return rule.discrimination ** 2 * ratio ** 2 * ((1 - p) / p);
}

function gridOf(rule: QuizRule): number[] {
	const { from, to, step } = rule.grid;
	const count = Math.round((to - from) / step);
	return Array.from({ length: count + 1 }, (_, index) => from + index * step);
}

function itemById(items: readonly QuizItem[], id: string): QuizItem {
	const item = items.find((candidate) => candidate.id === id);
	if (!item) throw new Error(`quiz item ${id} is not in the bank of the version`);
	return item;
}

export function estimateAbility(
	rule: QuizRule,
	items: readonly QuizItem[],
	steps: readonly AnsweredStep[]
): AbilityEstimate {
	const grid = gridOf(rule);
	const { mean, sd } = rule.prior;
	// Log-likelihood keeps long answer sequences away from underflow.
	const logWeights = grid.map((theta) => -(((theta - mean) / sd) ** 2) / 2);
	for (const step of steps) {
		const item = itemById(items, step.itemId);
		grid.forEach((theta, index) => {
			const p = correctProbability(rule, item, theta);
			logWeights[index] = (logWeights[index] ?? 0) + Math.log(step.correct ? p : 1 - p);
		});
	}
	const top = Math.max(...logWeights);
	const raw = logWeights.map((value) => Math.exp(value - top));
	const total = raw.reduce((sum, value) => sum + value, 0);
	const weights = raw.map((value) => value / total);
	const ability = grid.reduce((sum, theta, index) => sum + theta * (weights[index] ?? 0), 0);
	const variance = grid.reduce((sum, theta, index) => sum + (theta - ability) ** 2 * (weights[index] ?? 0), 0);
	return { ability, standardError: Math.sqrt(variance), grid, weights };
}

/** The quiz is over: the answers reached the maximum, the bank ran out, or the estimate is precise enough. */
export function quizFinished(
	rule: QuizRule,
	items: readonly QuizItem[],
	steps: readonly AnsweredStep[],
	estimate: AbilityEstimate
): boolean {
	if (steps.length >= rule.stop.maxItems || steps.length >= items.length) return true;
	return steps.length >= rule.stop.minItems && estimate.standardError <= rule.stop.maxStandardError;
}

/**
 * The most informative unanswered item at the current estimate. Equal information is broken by a hash of the attempt
 * and the item, so two attempts do not walk the bank in the same order while one attempt is reproducible.
 */
export function nextQuizItem(
	rule: QuizRule,
	items: readonly QuizItem[],
	steps: readonly AnsweredStep[],
	estimate: AbilityEstimate,
	seed: string
): QuizItem | null {
	if (quizFinished(rule, items, steps, estimate)) return null;
	const answered = new Set(steps.map((step) => step.itemId));
	const tieBreak = (item: QuizItem) => createHash('sha256').update(`${seed}:${item.id}`).digest('hex');
	const ranked = items
		.filter((item) => !answered.has(item.id))
		.map((item) => ({
			item,
			information: Number(itemInformation(rule, item, estimate.ability).toFixed(9)),
			order: tieBreak(item)
		}))
		.sort((a, b) => b.information - a.information || (a.order < b.order ? -1 : 1));
	return ranked[0]?.item ?? null;
}

/** The highest level whose cut the estimate reaches, with the posterior mass of its band as the confidence. */
export function quizLevel(scale: AbilityScale, estimate: AbilityEstimate): QuizLevel {
	const cuts = [...scale.cuts].sort((a, b) => a.minAbility - b.minAbility);
	let index = -1;
	cuts.forEach((cut, position) => {
		if (estimate.ability >= cut.minAbility) index = position;
	});
	const lower = index === -1 ? -Infinity : (cuts[index]?.minAbility ?? -Infinity);
	const upper = cuts[index + 1]?.minAbility ?? Infinity;
	const confidence = estimate.grid.reduce(
		(sum, theta, position) => (theta >= lower && theta < upper ? sum + (estimate.weights[position] ?? 0) : sum),
		0
	);
	const cut = index === -1 ? null : (cuts[index] ?? null);
	return { level: cut?.level ?? scale.below, cut, confidence: Number(confidence.toFixed(3)) };
}
