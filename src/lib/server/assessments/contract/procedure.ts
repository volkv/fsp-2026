// The one procedure that decides a grade (docs/domain.md, section 10.6): a truncated sequential probability ratio test
// over the Angoff estimates of the items actually served, with an indifference zone, one extension, a forced decision
// at the end, the outcome «не определено» when the band is still crossed, the practice gate and the defining blocks.
//
// Exact arithmetic. Angoff estimates and cluster scores are multiples of 1/20 (`SCALE`) and are summed as integers; the
// log-likelihood ratio of a cluster is rounded to millionths (`LLR_UNIT`) before summing, so a sum does not depend on
// the order of the clusters and a boundary is crossed or not the same way in the engine, the replay of a review and the
// exact operating characteristic. Every boundary comparison is inclusive: «≥» confirms, «≤» rejects.
//
// The practice cluster is a gate, not a summand: it never enters the ratio or the score sums, and a practice under the
// gate ends the attempt at once. Dependent answers are one cluster: a task with its step «измени своё решение», the
// groups of hidden tests of a program — one rubric score.
//
// Pure functions over plain data: the engine calls `nextStep` after every scored cluster and records what it returns.
// Plain erasable TypeScript without `$lib`.
import type { GradeDefinition, GradeKey } from './catalog.ts';

/** Angoff estimates and cluster scores are in twentieths. */
export const SCALE = 20;
/** A log-likelihood ratio is summed in millionths. */
export const LLR_UNIT = 1_000_000;

export interface GradeLengths {
	/** No decision before this many items (clusters other than the practice). */
	nMin: number;
	/** The main part ends here with a decision or the extension. */
	nMax: number;
	/** Items of the one extension. */
	extension: number;
}

export interface OperatingAcceptance {
	/** Upper bound on P(подтверждено) when the true share is the cut minus 0.15. */
	falseConfirmMax: Readonly<Record<GradeKey, number>>;
	/** Lower bound on P(подтверждено) when the true share is the cut plus 0.15. */
	trueConfirmMin: Readonly<Record<GradeKey, number>>;
	/** Upper bound on P(не определено) at any true share. */
	undeterminedMax: number;
}

/** The model of answers the acceptance of whole trajectories is computed under (domain 10.6, «модель ответов»). */
export interface TrajectoryModel {
	/** Angoff estimate of every computed item. */
	itemAngoff: number;
	/** Angoff estimate of the practice cluster: the practice is designed to be passed by the borderline candidate. */
	practiceAngoff: number;
	/** Hidden test groups of a practice program. */
	practiceGroups: number;
	/** Intra-cluster correlation of the groups of one program (and its change step): q ~ Beta, groups ~ Bernoulli(q). */
	rho: number;
	/** Weight of the step «измени своё решение» in the practice score from Middle up. */
	changeStepWeight: number;
}

export interface ProcedureParams {
	version: string;
	/** Half-width of the indifference zone around the Angoff estimate of every item, in logits. */
	delta: number;
	/** Wald's error rates of the boundaries; nominal — the real ones are in `indifferenceErrorsMax`. */
	alpha: number;
	beta: number;
	/**
	 * Forced decision bands in fortieths of a point per item: at `nMax` the difference S − C decides when
	 * `2·(S₂₀ − C₂₀) ≥ atMax·n` (or ≤ −atMax·n); after the extension — with `final`.
	 */
	bands: { atMax: number; final: number };
	/** A confirmed result is confident when S₂₀ − C₂₀ ≥ confidentMargin·n (twentieths per item: 3 = 0.15). */
	confidentMargin: number;
	/** Margin of a block's verdict «выше / ниже порога» in the explanation, in twentieths of a point (10 = 0.5). */
	blockVerdictMargin: number;
	/** A defining block is judged on at least this many items; the plan serves them first. */
	definingMinItems: number;
	/**
	 * A defining block fails when S₂₀ − C₂₀ < −definingFailMargin·k over its k items (twentieths per item: 6 — the block's
	 * share more than 0.30 under its cut). A failed defining block forbids a confirmation.
	 */
	definingFailMargin: number;
	grades: Readonly<Record<GradeKey, GradeLengths>>;
	/** Exact characteristic with homogeneous binary items, no practice or block rule: the frozen acceptance. */
	homogeneousAcceptance: OperatingAcceptance & {
		cuts: readonly number[];
		/** Real error rates at the ends of the indifference zone (share = p0: confirmed; share = p1: not confirmed). */
		indifferenceErrorsMax: Readonly<Record<GradeKey, { atP0Confirmed: number; atP1NotConfirmed: number }>>;
		/**
		 * Angoff bias: the true borderline share is the raters' estimate plus `bias` (positive — the items are easier than
		 * rated, the test is lenient); the false and true confirmation are measured at the true borderline ∓ 0.15.
		 */
		biasSensitivity: readonly { bias: number; falseConfirmMax: number; trueConfirmMin: number }[];
		/** Decision consistency of two attempts at a given distance from the cut. */
		consistencyMin: readonly { shift: number; min: number }[];
	};
	/** Acceptance of whole trajectories under `model`: practice gate, defining blocks, real plans of the catalog. */
	trajectoryAcceptance: OperatingAcceptance & {
		model: TrajectoryModel;
		/** P(подтверждено) of a candidate at the cut + 0.15 whose one defining block is at the cut − 0.40. */
		weakDefiningBlockConfirmMax: number;
		consistencyMin: readonly { shift: number; min: number }[];
	};
}

export const PROCEDURE: ProcedureParams = {
	version: 'sprt-2',
	delta: 0.45,
	alpha: 0.1,
	beta: 0.1,
	bands: { atMax: 2, final: 1 },
	confidentMargin: 3,
	blockVerdictMargin: 10,
	definingMinItems: 3,
	definingFailMargin: 6,
	grades: {
		intern: { nMin: 6, nMax: 11, extension: 4 },
		junior: { nMin: 6, nMax: 11, extension: 6 },
		middle: { nMin: 6, nMax: 11, extension: 6 },
		senior: { nMin: 6, nMax: 11, extension: 6 }
	},
	homogeneousAcceptance: {
		cuts: [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8],
		falseConfirmMax: { intern: 0.15, junior: 0.14, middle: 0.14, senior: 0.14 },
		trueConfirmMin: { intern: 0.82, junior: 0.83, middle: 0.83, senior: 0.83 },
		undeterminedMax: 0.13,
		indifferenceErrorsMax: {
			intern: { atP0Confirmed: 0.26, atP1NotConfirmed: 0.25 },
			junior: { atP0Confirmed: 0.24, atP1NotConfirmed: 0.24 },
			middle: { atP0Confirmed: 0.24, atP1NotConfirmed: 0.24 },
			senior: { atP0Confirmed: 0.24, atP1NotConfirmed: 0.24 }
		},
		biasSensitivity: [
			{ bias: -0.1, falseConfirmMax: 0.04, trueConfirmMin: 0.55 },
			{ bias: -0.05, falseConfirmMax: 0.08, trueConfirmMin: 0.7 },
			{ bias: 0.05, falseConfirmMax: 0.25, trueConfirmMin: 0.9 },
			{ bias: 0.1, falseConfirmMax: 0.38, trueConfirmMin: 0.95 }
		],
		consistencyMin: [
			{ shift: -0.15, min: 0.65 },
			{ shift: 0, min: 0.39 },
			{ shift: 0.15, min: 0.69 }
		]
	},
	trajectoryAcceptance: {
		model: { itemAngoff: 0.6, practiceAngoff: 0.8, practiceGroups: 5, rho: 0.5, changeStepWeight: 0.3 },
		falseConfirmMax: { intern: 0.1, junior: 0.1, middle: 0.1, senior: 0.1 },
		trueConfirmMin: { intern: 0.75, junior: 0.75, middle: 0.75, senior: 0.75 },
		undeterminedMax: 0.12,
		weakDefiningBlockConfirmMax: 0.3,
		consistencyMin: [
			{ shift: -0.15, min: 0.78 },
			{ shift: 0.15, min: 0.62 }
		]
	}
};

/** Items of the longest trajectory (the practice not counted). */
export function maxItems(params: ProcedureParams, grade: GradeKey): number {
	const lengths = params.grades[grade];
	return lengths.nMax + lengths.extension;
}

/** Slots of the longest trajectory: the items and the one practice cluster. */
export function maxLength(params: ProcedureParams, grade: GradeKey): number {
	return maxItems(params, grade) + 1;
}

/** One scored cluster of an attempt, in the order served. */
export interface ClusterResult {
	block: string;
	/** Angoff estimate of the family-level, a multiple of 1/20 in (0, 1). */
	angoff: number;
	/** Rubric score of the cluster, a multiple of 1/20 in [0, 1] (rubrics round down); an unanswered cluster scores 0. */
	score: number;
	practice: boolean;
}

export type DecisionOutcome = 'confirmed' | 'not_confirmed' | 'undetermined';

export type DecisionReason =
	/** The sequential test crossed its upper boundary. */
	| 'sprt_upper'
	/** The sequential test crossed its lower boundary. */
	| 'sprt_lower'
	/** The main part ended with the score on or above / on or under its band. */
	| 'forced_upper_at_max'
	| 'forced_lower_at_max'
	/** The extension ended with the score on or above / on or under its band. */
	| 'forced_upper_final'
	| 'forced_lower_final'
	/** The extension ended inside its band. */
	| 'band_after_extension'
	/** The practice cluster scored under the gate: the attempt ends at once. */
	| 'practice_gate_failed'
	/** Everything pointed to a confirmation, but a defining block failed. */
	| 'defining_block_failed'
	/** The bank had no eligible family-level for the next slot (a system end, not the candidate's attempt). */
	| 'bank_exhausted'
	/** A review re-scored the clusters, and the trajectory as served no longer reaches a decision. */
	| 'rescored_incomplete';

/** Decision reasons of a system end: such an attempt is not counted by the grade policy. */
export const SYSTEM_DECISION_REASONS: readonly DecisionReason[] = ['bank_exhausted', 'rescored_incomplete'];

export interface BlockSummary {
	block: string;
	items: number;
	/** Sums in twentieths of a point. */
	score: number;
	cut: number;
	verdict: 'above' | 'at' | 'below';
	defining: boolean;
	/** For a defining block: judged on enough items and not failed. Other blocks are never «passed». */
	passed: boolean;
}

export interface GradeDecision {
	procedureVersion: string;
	grade: GradeKey;
	outcome: DecisionOutcome;
	reason: DecisionReason;
	/** Confirmed with S − C ≥ 0.15 per item: the test of the next grade is offered (domain 12.3). */
	confident: boolean;
	/** Log-likelihood ratio of the items in millionths. */
	llr: number;
	/** Sum of item scores S and of their Angoff estimates C, in twentieths. */
	scoreSum: number;
	cutSum: number;
	/** Items used (the practice not counted). */
	items: number;
	extensionUsed: boolean;
	practice: { score: number; gateMinScore: number; passed: boolean } | null;
	blocks: BlockSummary[];
}

export type ProcedureStep =
	| { kind: 'continue' }
	/** The main part ended inside its band: serve the extension slots. */
	| { kind: 'extend' }
	| { kind: 'decided'; decision: GradeDecision };

export class ProcedureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProcedureError';
	}
}

/** A share that must be a multiple of 1/20, as an integer number of twentieths. */
export function twentieths(value: number, what: string): number {
	const scaled = Math.round(value * SCALE);
	if (Math.abs(value * SCALE - scaled) > 1e-9) throw new ProcedureError(`${what} ${value} is not a multiple of 1/20`);
	return scaled;
}

const logit = (p: number): number => Math.log(p / (1 - p));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** The two hypotheses of an item with Angoff estimate `angoff`: the borderline minus and plus `delta` logits. */
export function hypotheses(angoff: number, delta: number): { p0: number; p1: number } {
	if (!(angoff > 0 && angoff < 1)) throw new ProcedureError(`Angoff estimate ${angoff} is outside (0, 1)`);
	return { p0: sigmoid(logit(angoff) - delta), p1: sigmoid(logit(angoff) + delta) };
}

/**
 * The log-likelihood ratio contribution of an item in millionths: s·ln(p1/p0) + (1 − s)·ln((1 − p1)/(1 − p0)) for its
 * Angoff estimate a and score s, both in twentieths. A partial rubric score enters as a quasi-likelihood of a fractional
 * outcome; its Angoff estimate is then the expected score of the borderline candidate (extended Angoff).
 */
export function itemLlr(angoff20: number, score20: number, delta: number): number {
	if (!(Number.isInteger(angoff20) && angoff20 > 0 && angoff20 < SCALE))
		throw new ProcedureError(`Angoff ${angoff20}/20`);
	if (!(Number.isInteger(score20) && score20 >= 0 && score20 <= SCALE)) throw new ProcedureError(`score ${score20}/20`);
	const { p0, p1 } = hypotheses(angoff20 / SCALE, delta);
	const s = score20 / SCALE;
	return Math.round(LLR_UNIT * (s * Math.log(p1 / p0) + (1 - s) * Math.log((1 - p1) / (1 - p0))));
}

/** Wald's boundaries in millionths: A = ln((1 − β)/α), B = ln(β/(1 − α)), rounded. */
export function boundaries(params: Pick<ProcedureParams, 'alpha' | 'beta'>): { upper: number; lower: number } {
	return {
		upper: Math.round(LLR_UNIT * Math.log((1 - params.beta) / params.alpha)),
		lower: Math.round(LLR_UNIT * Math.log(params.beta / (1 - params.alpha)))
	};
}

/** The rule of a grade the procedure needs from the catalog. */
export type DecisionRule = Pick<GradeDefinition, 'grade' | 'defining'> & {
	practice: Pick<GradeDefinition['practice'], 'gateMinScore' | 'position'>;
};

interface Tally {
	items: { block: string; angoff: number; score: number }[];
	practice: { block: string; score: number; slot: number } | null;
	llr: number;
	difference: number;
}

function tally(params: ProcedureParams, clusters: readonly ClusterResult[]): Tally {
	const result: Tally = { items: [], practice: null, llr: 0, difference: 0 };
	clusters.forEach((cluster, i) => {
		const score = twentieths(cluster.score, `score of cluster ${i + 1}`);
		if (cluster.practice) {
			if (result.practice) throw new ProcedureError('more than one practice cluster');
			if (score < 0 || score > SCALE) throw new ProcedureError(`practice score ${cluster.score}`);
			result.practice = { block: cluster.block, score, slot: i + 1 };
			return;
		}
		const angoff = twentieths(cluster.angoff, `Angoff of cluster ${i + 1}`);
		result.llr += itemLlr(angoff, score, params.delta);
		result.difference += score - angoff;
		result.items.push({ block: cluster.block, angoff, score });
	});
	return result;
}

function blockSummaries(
	params: ProcedureParams,
	rule: DecisionRule,
	t: Tally,
	confirmed: boolean
): { blocks: BlockSummary[]; definingFailed: boolean; definingCovered: boolean } {
	const byBlock = new Map<string, { items: number; score: number; cut: number }>();
	for (const item of t.items) {
		const entry = byBlock.get(item.block) ?? { items: 0, score: 0, cut: 0 };
		entry.items += 1;
		entry.score += item.score;
		entry.cut += item.angoff;
		byBlock.set(item.block, entry);
	}
	let definingFailed = false;
	let definingCovered = true;
	for (const code of rule.defining) {
		const entry = byBlock.get(code);
		if (!entry || entry.items < params.definingMinItems) definingCovered = false;
		else if (entry.score - entry.cut < -params.definingFailMargin * entry.items) definingFailed = true;
	}
	const blocks = [...byBlock.entries()].map(([block, { items, score, cut }]): BlockSummary => {
		const difference = score - cut;
		const defining = rule.defining.includes(block);
		const failed = defining && difference < -params.definingFailMargin * items;
		return {
			block,
			items,
			score,
			cut,
			verdict:
				difference >= params.blockVerdictMargin ? 'above' : difference <= -params.blockVerdictMargin ? 'below' : 'at',
			defining,
			passed: confirmed && defining && items >= params.definingMinItems && !failed
		};
	});
	return { blocks, definingFailed, definingCovered };
}

function decide(
	params: ProcedureParams,
	rule: DecisionRule,
	t: Tally,
	outcome: DecisionOutcome,
	reason: DecisionReason
): GradeDecision {
	const gate = twentieths(rule.practice.gateMinScore, 'practice gate');
	let finalOutcome = outcome;
	let finalReason = reason;
	let summary = blockSummaries(params, rule, t, outcome === 'confirmed');
	if (outcome === 'confirmed' && summary.definingFailed) {
		finalOutcome = 'not_confirmed';
		finalReason = 'defining_block_failed';
		summary = blockSummaries(params, rule, t, false);
	}
	const n = t.items.length;
	const scoreSum = t.items.reduce((sum, item) => sum + item.score, 0);
	const cutSum = t.items.reduce((sum, item) => sum + item.angoff, 0);
	return {
		procedureVersion: params.version,
		grade: rule.grade,
		outcome: finalOutcome,
		reason: finalReason,
		confident: finalOutcome === 'confirmed' && n > 0 && t.difference >= params.confidentMargin * n,
		llr: t.llr,
		scoreSum,
		cutSum,
		items: n,
		extensionUsed: n > params.grades[rule.grade].nMax,
		practice: t.practice
			? { score: t.practice.score / SCALE, gateMinScore: rule.practice.gateMinScore, passed: t.practice.score >= gate }
			: null,
		blocks: summary.blocks
	};
}

/**
 * What happens after the clusters scored so far, served in the order of the plan. `decided` is final. The practice sits
 * at its slot position (not after the minimum); the defining blocks are covered by the minimum length.
 */
export function nextStep(
	params: ProcedureParams,
	rule: DecisionRule,
	clusters: readonly ClusterResult[]
): ProcedureStep {
	const { nMin, nMax, extension } = params.grades[rule.grade];
	const t = tally(params, clusters);
	const n = t.items.length;
	if (n > nMax + extension) throw new ProcedureError(`${n} items exceed the longest trajectory ${nMax + extension}`);
	if (t.practice && t.practice.slot !== rule.practice.position) {
		throw new ProcedureError(`practice at slot ${t.practice.slot}, the plan puts it at ${rule.practice.position}`);
	}
	if (!t.practice && clusters.length >= rule.practice.position) {
		throw new ProcedureError(`no practice at slot ${rule.practice.position}`);
	}
	const gate = twentieths(rule.practice.gateMinScore, 'practice gate');
	if (t.practice && t.practice.score < gate) {
		return { kind: 'decided', decision: decide(params, rule, t, 'not_confirmed', 'practice_gate_failed') };
	}
	if (n < nMin) return { kind: 'continue' };
	if (!t.practice) throw new ProcedureError('no practice cluster before the minimum length');
	if (!blockSummaries(params, rule, t, false).definingCovered) {
		throw new ProcedureError(`defining blocks have fewer than ${params.definingMinItems} items at the minimum length`);
	}
	const { upper, lower } = boundaries(params);
	const decided = (outcome: DecisionOutcome, reason: DecisionReason): ProcedureStep => ({
		kind: 'decided',
		decision: decide(params, rule, t, outcome, reason)
	});
	if (t.llr >= upper) return decided('confirmed', 'sprt_upper');
	if (t.llr <= lower) return decided('not_confirmed', 'sprt_lower');
	const doubled = 2 * t.difference;
	if (n === nMax) {
		if (doubled >= params.bands.atMax * n) return decided('confirmed', 'forced_upper_at_max');
		if (doubled <= -params.bands.atMax * n) return decided('not_confirmed', 'forced_lower_at_max');
		return { kind: 'extend' };
	}
	if (n === nMax + extension) {
		if (doubled >= params.bands.final * n) return decided('confirmed', 'forced_upper_final');
		if (doubled <= -params.bands.final * n) return decided('not_confirmed', 'forced_lower_final');
		return decided('undetermined', 'band_after_extension');
	}
	return { kind: 'continue' };
}

/** The decision when the bank cannot serve the next slot: «не определено», a system end. */
export function exhaustedDecision(
	params: ProcedureParams,
	rule: DecisionRule,
	clusters: readonly ClusterResult[]
): GradeDecision {
	return decide(params, rule, tally(params, clusters), 'undetermined', 'bank_exhausted');
}

/**
 * The decision of a review (domain 12.5): the procedure replayed over the served clusters with corrected scores, in the
 * order served. The first prefix that decides gives the decision (the procedure would have stopped there); a trajectory
 * that no longer reaches a decision at its served length ends «не определено» (`rescored_incomplete`, a system end):
 * slots are never added after the fact.
 */
export function redecide(
	params: ProcedureParams,
	rule: DecisionRule,
	clusters: readonly ClusterResult[]
): GradeDecision {
	for (let k = 1; k <= clusters.length; k += 1) {
		const step = nextStep(params, rule, clusters.slice(0, k));
		if (step.kind === 'decided') return step.decision;
	}
	return decide(params, rule, tally(params, clusters), 'undetermined', 'rescored_incomplete');
}

export interface OperatingPoint {
	confirmed: number;
	undetermined: number;
	notConfirmed: number;
	expectedLength: number;
}

/**
 * The exact operating characteristic of the sequential rule for homogeneous binary items with Angoff estimate `cut` (a
 * multiple of 1/20) and a candidate whose chance on every item is `share`: dynamic programming over (n, S) with the same
 * integer arithmetic as `nextStep`. The practice gate and the defining blocks are not modelled here — `simulateTrajectories`
 * does that.
 */
export function operatingPoint(params: ProcedureParams, grade: GradeKey, cut: number, share: number): OperatingPoint {
	const { nMin, nMax, extension } = params.grades[grade];
	const cut20 = twentieths(cut, 'cut');
	const success = itemLlr(cut20, SCALE, params.delta);
	const failure = itemLlr(cut20, 0, params.delta);
	const { upper, lower } = boundaries(params);
	let alive = new Map<number, number>([[0, 1]]);
	const point: OperatingPoint = { confirmed: 0, undetermined: 0, notConfirmed: 0, expectedLength: 0 };
	for (let n = 1; n <= nMax + extension; n += 1) {
		const next = new Map<number, number>();
		for (const [s, probability] of alive) {
			next.set(s + 1, (next.get(s + 1) ?? 0) + probability * share);
			next.set(s, (next.get(s) ?? 0) + probability * (1 - share));
		}
		alive = new Map();
		for (const [s, probability] of next) {
			const llr = s * success + (n - s) * failure;
			const doubled = 2 * (s * SCALE - cut20 * n);
			let outcome: DecisionOutcome | null = null;
			if (n >= nMin && llr >= upper) outcome = 'confirmed';
			else if (n >= nMin && llr <= lower) outcome = 'not_confirmed';
			else if (n === nMax) {
				if (doubled >= params.bands.atMax * n) outcome = 'confirmed';
				else if (doubled <= -params.bands.atMax * n) outcome = 'not_confirmed';
			} else if (n === nMax + extension) {
				const band = params.bands.final * n;
				outcome = doubled >= band ? 'confirmed' : doubled <= -band ? 'not_confirmed' : 'undetermined';
			}
			if (outcome === null) {
				alive.set(s, probability);
				continue;
			}
			point.expectedLength += probability * n;
			if (outcome === 'confirmed') point.confirmed += probability;
			else if (outcome === 'not_confirmed') point.notConfirmed += probability;
			else point.undetermined += probability;
		}
	}
	return point;
}

/**
 * Decision consistency of two independent attempts on parallel forms for one candidate: the chance both give the same
 * outcome (P_conf² + P_und² + P_not²).
 */
export function decisionConsistency(point: OperatingPoint): number {
	return point.confirmed ** 2 + point.undetermined ** 2 + point.notConfirmed ** 2;
}

/** A small reproducible generator of uniform numbers (sfc32) from four 32-bit words. */
export function seededRandom(seed: readonly [number, number, number, number]): () => number {
	let [a, b, c, d] = seed.map((x) => x >>> 0) as [number, number, number, number];
	return () => {
		const t = (((a + b) >>> 0) + d) >>> 0;
		d = (d + 1) >>> 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) >>> 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) >>> 0;
		return t / 4294967296;
	};
}

/** Gamma(shape, 1) by Marsaglia–Tsang (with the boost for shape < 1). */
function gamma(random: () => number, shape: number): number {
	if (shape < 1) return gamma(random, shape + 1) * random() ** (1 / shape);
	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	for (;;) {
		let x: number;
		let v: number;
		do {
			// Box–Muller normal.
			x = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
			v = 1 + c * x;
		} while (v <= 0);
		v = v ** 3;
		const u = random();
		if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
	}
}

const clip = (p: number): number => Math.min(0.98, Math.max(0.02, p));

export interface SimulatedPoint extends OperatingPoint {
	shift: number;
	runs: number;
}

/**
 * Monte Carlo of whole trajectories of one grade definition under `model`: the plan's slots in order, items with chance
 * `itemAngoff + shift` (one defining block may be shifted further by `definingBlockShift`), the practice cluster scored as
 * the share of `practiceGroups` groups passed with a common latent chance q ~ Beta(mean `practiceAngoff + shift`, ICC
 * `rho`) and, from Middle up, the change step weighted in; every step decided by `nextStep` itself.
 */
export function simulateTrajectories(
	params: ProcedureParams,
	definition: GradeDefinition,
	slots: readonly { block: string; practice: boolean }[],
	model: TrajectoryModel,
	shift: number,
	runs: number,
	options: { seed: readonly [number, number, number, number]; definingBlockShift?: number }
): SimulatedPoint {
	const random = seededRandom(options.seed);
	const weakBlock = definition.defining[0];
	const sum = (1 - model.rho) / model.rho;
	const point: SimulatedPoint = { shift, runs, confirmed: 0, undetermined: 0, notConfirmed: 0, expectedLength: 0 };
	for (let run = 0; run < runs; run += 1) {
		const clusters: ClusterResult[] = [];
		let decision: GradeDecision | null = null;
		for (const slot of slots) {
			if (slot.practice) {
				const mean = clip(model.practiceAngoff + shift);
				const x = gamma(random, mean * sum);
				const q = x / (x + gamma(random, (1 - mean) * sum));
				let passed = 0;
				for (let g = 0; g < model.practiceGroups; g += 1) if (random() < q) passed += 1;
				let score20 = Math.floor((SCALE * passed) / model.practiceGroups);
				if (definition.practice.changeStep) {
					const w20 = Math.round(model.changeStepWeight * SCALE);
					const step20 = random() < q ? SCALE : 0;
					score20 = Math.floor(((SCALE - w20) * score20 + w20 * step20) / SCALE);
				}
				clusters.push({ block: slot.block, angoff: model.practiceAngoff, score: score20 / SCALE, practice: true });
			} else {
				const extra =
					options.definingBlockShift !== undefined && slot.block === weakBlock ? options.definingBlockShift : 0;
				const success = random() < clip(model.itemAngoff + shift + extra);
				clusters.push({ block: slot.block, angoff: model.itemAngoff, score: success ? 1 : 0, practice: false });
			}
			const step = nextStep(params, definition, clusters);
			if (step.kind === 'decided') {
				decision = step.decision;
				break;
			}
		}
		if (!decision) throw new ProcedureError('a simulated trajectory ran past the plan without a decision');
		point.expectedLength += decision.items / runs;
		if (decision.outcome === 'confirmed') point.confirmed += 1 / runs;
		else if (decision.outcome === 'not_confirmed') point.notConfirmed += 1 / runs;
		else point.undetermined += 1 / runs;
	}
	return point;
}
