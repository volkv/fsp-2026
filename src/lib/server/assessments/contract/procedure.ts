// The one procedure that decides a grade (docs/domain.md, section 23.5): a truncated sequential probability ratio test
// over the Angoff estimates of the items actually served, with an indifference zone, one extension, a forced decision
// at the end, the outcome «не определено» when the band is still crossed, and the practice gate. Dependent answers are
// one cluster: a task with its step «измени своё решение», a group of hidden tests — one summand with a rubric score.
//
// Pure functions over plain data: the engine calls `nextStep` after every scored cluster and records what it returns.
// Plain erasable TypeScript without `$lib`.
import type { GradeKey } from './catalog.ts';

export interface GradeLengths {
	/** No decision before this many clusters; the practice slot is not after it. */
	nMin: number;
	/** The main part ends here with a decision or the extension. */
	nMax: number;
	/** Clusters of the one extension. */
	extension: number;
}

export interface OperatingAcceptance {
	/** Distance of the true score from the cut, in shares, at which the curve is checked. */
	shift: number;
	/** Upper bound on P(confirmed) when the true share is the cut minus `shift`. */
	falseConfirmMax: Readonly<Record<GradeKey, number>>;
	/** Lower bound on P(confirmed) when the true share is the cut plus `shift`. */
	trueConfirmMin: number;
	/** Upper bound on P(не определено) at any true share. */
	undeterminedMax: number;
}

export interface ProcedureParams {
	version: string;
	/** Half-width of the indifference zone around the Angoff estimate of every item, in logits. */
	delta: number;
	/** Nominal error rates of the sequential test: false confirmation and false rejection. */
	alpha: number;
	beta: number;
	/** Forced decision: |S − C| ≥ band × n decides; `atMax` ends the main part, `final` ends the extension. */
	bands: { atMax: number; final: number };
	/** A confirmed result is confident when the mean score exceeds the mean cut by this much. */
	confidentMargin: number;
	/** Margin, in score points, of a block's verdict «выше порога» / «ниже порога» in the explanation. */
	blockVerdictMargin: number;
	/** A passed block needs this many answered clusters (domain 23.6, the confirmed stack). */
	blockMinItems: number;
	grades: Readonly<Record<GradeKey, GradeLengths>>;
	/** Exact operating characteristic with homogeneous items: the frozen acceptance of these parameters. */
	homogeneousAcceptance: OperatingAcceptance & { cuts: readonly number[] };
	/** Acceptance of the engine's simulation of whole trajectories: clusters, the practice gate, real blueprints. */
	trajectoryAcceptance: OperatingAcceptance & { consistencyMin: number };
}

export const PROCEDURE: ProcedureParams = {
	version: 'sprt-1',
	delta: 0.45,
	alpha: 0.1,
	beta: 0.1,
	bands: { atMax: 0.05, final: 0.025 },
	confidentMargin: 0.15,
	blockVerdictMargin: 0.5,
	blockMinItems: 2,
	grades: {
		intern: { nMin: 6, nMax: 12, extension: 4 },
		junior: { nMin: 6, nMax: 14, extension: 4 },
		middle: { nMin: 6, nMax: 14, extension: 4 },
		senior: { nMin: 6, nMax: 14, extension: 4 }
	},
	homogeneousAcceptance: {
		shift: 0.15,
		cuts: [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8],
		falseConfirmMax: { intern: 0.16, junior: 0.13, middle: 0.13, senior: 0.13 },
		trueConfirmMin: 0.82,
		undeterminedMax: 0.16
	},
	trajectoryAcceptance: {
		shift: 0.15,
		falseConfirmMax: { intern: 0.16, junior: 0.13, middle: 0.13, senior: 0.13 },
		trueConfirmMin: 0.75,
		undeterminedMax: 0.2,
		consistencyMin: 0.6
	}
};

/** The longest trajectory of a grade: the main part and the extension. */
export function maxLength(params: ProcedureParams, grade: GradeKey): number {
	const lengths = params.grades[grade];
	return lengths.nMax + lengths.extension;
}

/** One scored cluster of an attempt, in the order served. */
export interface ClusterResult {
	block: string;
	/** Angoff estimate of the family-level: the expected score of the borderline candidate of the grade, in (0, 1). */
	angoff: number;
	/** Rubric score of the cluster in [0, 1]; an unanswered cluster scores 0. */
	score: number;
	practice: boolean;
}

export type DecisionOutcome = 'confirmed' | 'not_confirmed' | 'undetermined';

export type DecisionReason =
	/** The sequential test crossed its upper boundary. */
	| 'sprt_upper'
	/** The sequential test crossed its lower boundary. */
	| 'sprt_lower'
	/** The main part ended with the score above the band. */
	| 'forced_upper_at_max'
	| 'forced_lower_at_max'
	/** The extension ended with the score above or below its band. */
	| 'forced_upper_final'
	| 'forced_lower_final'
	/** The extension ended inside its band. */
	| 'band_after_extension'
	/** The bank had no eligible family-level for the next slot. */
	| 'bank_exhausted'
	/** Everything else confirmed, but the practice cluster scored under the gate. */
	| 'practice_gate_failed';

export interface BlockSummary {
	block: string;
	items: number;
	score: number;
	cut: number;
	verdict: 'above' | 'at' | 'below';
	/** Counts for the confirmed stack: the attempt is confirmed, enough items and the score not under the cut. */
	passed: boolean;
}

export interface GradeDecision {
	procedureVersion: string;
	grade: GradeKey;
	outcome: DecisionOutcome;
	reason: DecisionReason;
	/** Confirmed with the mean score above the mean cut by `confidentMargin`: the test of the next grade is offered. */
	confident: boolean;
	/** Log-likelihood ratio of the sequential test at the end. */
	llr: number;
	/** Sum of cluster scores S and sum of Angoff estimates C over the clusters used. */
	scoreSum: number;
	cutSum: number;
	clusters: number;
	extensionUsed: boolean;
	practice: { score: number; gateMinScore: number; passed: boolean };
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

const logit = (p: number): number => Math.log(p / (1 - p));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** The two hypotheses of an item with Angoff estimate `angoff`: the borderline minus and plus `delta` logits. */
export function hypotheses(angoff: number, delta: number): { p0: number; p1: number } {
	if (!(angoff > 0 && angoff < 1)) throw new ProcedureError(`Angoff estimate ${angoff} is outside (0, 1)`);
	return { p0: sigmoid(logit(angoff) - delta), p1: sigmoid(logit(angoff) + delta) };
}

/**
 * The log-likelihood ratio contribution of a cluster. A rubric score s in [0, 1] enters as a fractional Bernoulli
 * outcome: s·ln(p1/p0) + (1 − s)·ln((1 − p1)/(1 − p0)); a binary item is the case s ∈ {0, 1}.
 */
export function clusterLlr(cluster: ClusterResult, delta: number): number {
	if (!(cluster.score >= 0 && cluster.score <= 1)) throw new ProcedureError(`score ${cluster.score} is outside [0, 1]`);
	const { p0, p1 } = hypotheses(cluster.angoff, delta);
	return cluster.score * Math.log(p1 / p0) + (1 - cluster.score) * Math.log((1 - p1) / (1 - p0));
}

/** Wald's boundaries: A = ln((1 − β)/α), B = ln(β/(1 − α)). */
export function boundaries(params: Pick<ProcedureParams, 'alpha' | 'beta'>): { upper: number; lower: number } {
	return { upper: Math.log((1 - params.beta) / params.alpha), lower: Math.log(params.beta / (1 - params.alpha)) };
}

function blockSummaries(
	clusters: readonly ClusterResult[],
	confirmed: boolean,
	params: ProcedureParams
): BlockSummary[] {
	const byBlock = new Map<string, { items: number; score: number; cut: number }>();
	for (const cluster of clusters) {
		const entry = byBlock.get(cluster.block) ?? { items: 0, score: 0, cut: 0 };
		entry.items += 1;
		entry.score += cluster.score;
		entry.cut += cluster.angoff;
		byBlock.set(cluster.block, entry);
	}
	return [...byBlock.entries()].map(([block, { items, score, cut }]) => {
		const difference = score - cut;
		const verdict =
			difference >= params.blockVerdictMargin ? 'above' : difference <= -params.blockVerdictMargin ? 'below' : 'at';
		return { block, items, score, cut, verdict, passed: confirmed && items >= params.blockMinItems && difference >= 0 };
	});
}

function decide(
	params: ProcedureParams,
	grade: GradeKey,
	gateMinScore: number,
	clusters: readonly ClusterResult[],
	llr: number,
	outcome: DecisionOutcome,
	reason: DecisionReason
): GradeDecision {
	const practiceCluster = clusters.find((c) => c.practice);
	const practiceScore = practiceCluster?.score ?? 0;
	const practicePassed = practiceCluster !== undefined && practiceScore >= gateMinScore;
	let finalOutcome = outcome;
	let finalReason = reason;
	if (outcome === 'confirmed' && !practicePassed) {
		finalOutcome = 'not_confirmed';
		finalReason = 'practice_gate_failed';
	}
	const scoreSum = clusters.reduce((sum, c) => sum + c.score, 0);
	const cutSum = clusters.reduce((sum, c) => sum + c.angoff, 0);
	const n = clusters.length;
	const confirmed = finalOutcome === 'confirmed';
	return {
		procedureVersion: params.version,
		grade,
		outcome: finalOutcome,
		reason: finalReason,
		confident: confirmed && n > 0 && (scoreSum - cutSum) / n >= params.confidentMargin,
		llr,
		scoreSum,
		cutSum,
		clusters: n,
		extensionUsed: n > params.grades[grade].nMax,
		practice: { score: practiceScore, gateMinScore, passed: practicePassed },
		blocks: blockSummaries(clusters, confirmed, params)
	};
}

/**
 * What happens after the clusters scored so far. The engine serves the slots of the blueprint in order and calls this
 * after each one; `decided` is final. The practice cluster must be among the first `nMin` clusters.
 */
export function nextStep(
	params: ProcedureParams,
	grade: GradeKey,
	gateMinScore: number,
	clusters: readonly ClusterResult[]
): ProcedureStep {
	const { nMin, nMax, extension } = params.grades[grade];
	const n = clusters.length;
	if (n > nMax + extension) throw new ProcedureError(`${n} clusters exceed the longest trajectory ${nMax + extension}`);
	if (n >= nMin && !clusters.slice(0, nMin).some((c) => c.practice)) {
		throw new ProcedureError(`no practice cluster among the first ${nMin}`);
	}
	if (clusters.filter((c) => c.practice).length > 1) throw new ProcedureError('more than one practice cluster');
	const llr = clusters.reduce((sum, c) => sum + clusterLlr(c, params.delta), 0);
	if (n < nMin) return { kind: 'continue' };
	const { upper, lower } = boundaries(params);
	if (llr >= upper)
		return { kind: 'decided', decision: decide(params, grade, gateMinScore, clusters, llr, 'confirmed', 'sprt_upper') };
	if (llr <= lower) {
		return {
			kind: 'decided',
			decision: decide(params, grade, gateMinScore, clusters, llr, 'not_confirmed', 'sprt_lower')
		};
	}
	const difference = clusters.reduce((sum, c) => sum + c.score - c.angoff, 0);
	if (n === nMax) {
		const band = params.bands.atMax * n;
		if (difference >= band) {
			return {
				kind: 'decided',
				decision: decide(params, grade, gateMinScore, clusters, llr, 'confirmed', 'forced_upper_at_max')
			};
		}
		if (difference <= -band) {
			return {
				kind: 'decided',
				decision: decide(params, grade, gateMinScore, clusters, llr, 'not_confirmed', 'forced_lower_at_max')
			};
		}
		return { kind: 'extend' };
	}
	if (n === nMax + extension) {
		const band = params.bands.final * n;
		if (difference >= band) {
			return {
				kind: 'decided',
				decision: decide(params, grade, gateMinScore, clusters, llr, 'confirmed', 'forced_upper_final')
			};
		}
		if (difference <= -band) {
			return {
				kind: 'decided',
				decision: decide(params, grade, gateMinScore, clusters, llr, 'not_confirmed', 'forced_lower_final')
			};
		}
		return {
			kind: 'decided',
			decision: decide(params, grade, gateMinScore, clusters, llr, 'undetermined', 'band_after_extension')
		};
	}
	return { kind: 'continue' };
}

/** The decision when the bank cannot serve the next slot: «не определено», never a guess either way. */
export function exhaustedDecision(
	params: ProcedureParams,
	grade: GradeKey,
	gateMinScore: number,
	clusters: readonly ClusterResult[]
): GradeDecision {
	const llr = clusters.reduce((sum, c) => sum + clusterLlr(c, params.delta), 0);
	return decide(params, grade, gateMinScore, clusters, llr, 'undetermined', 'bank_exhausted');
}

export interface OperatingPoint {
	confirmed: number;
	undetermined: number;
	notConfirmed: number;
	expectedLength: number;
}

/**
 * The exact operating characteristic of the procedure for homogeneous binary items with Angoff estimate `cut` and a
 * candidate whose true chance on every item is `share`: dynamic programming over (n, S), no simulation noise. The
 * practice gate is not modelled here (the engine's trajectory simulation does that); every cluster is an item.
 */
export function operatingPoint(params: ProcedureParams, grade: GradeKey, cut: number, share: number): OperatingPoint {
	const { nMin, nMax, extension } = params.grades[grade];
	const { p0, p1 } = hypotheses(cut, params.delta);
	const success = Math.log(p1 / p0);
	const failure = Math.log((1 - p1) / (1 - p0));
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
			const difference = s - cut * n;
			let outcome: DecisionOutcome | null = null;
			if (n >= nMin && llr >= upper) outcome = 'confirmed';
			else if (n >= nMin && llr <= lower) outcome = 'not_confirmed';
			else if (n === nMax) {
				const band = params.bands.atMax * n;
				if (difference >= band) outcome = 'confirmed';
				else if (difference <= -band) outcome = 'not_confirmed';
			} else if (n === nMax + extension) {
				const band = params.bands.final * n;
				outcome = difference >= band ? 'confirmed' : difference <= -band ? 'not_confirmed' : 'undetermined';
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
 * outcome (P_conf² + P_und² + P_not²). The engine's acceptance averages it over its simulated population.
 */
export function decisionConsistency(point: OperatingPoint): number {
	return point.confirmed ** 2 + point.undetermined ** 2 + point.notConfirmed ** 2;
}
