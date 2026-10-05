// The trajectory report of a release (docs/domain.md, 10.6, «Требование к движку теста — отчёт траекторий выпуска»): the
// answer model of the procedure (`trajectoryAcceptance.model`) run over the real release — the choice of family-levels,
// the generation of instances, clusters scored by their rubrics on the scale of 1/20, the practice gate, the defining
// blocks, the extension and the truncation — on form A, then the retake on form B with the classes of the first attempt
// seen. The contract's `simulateTrajectories` runs the same model over the plans of the catalog with model Angoff
// estimates; this one runs it over the families of a release, with their own estimates, groups and mutants.
//
// The model, named with the report («симуляция, предположения названы»): a candidate is a shift d of the true share from
// the cut; a computed item succeeds with chance p̄ + d (clipped to [0.02, 0.98]); a program's groups and its step share a
// latent chance q ~ Beta(mean p̄ + d, intra-cluster correlation ρ of the model), each group passes with chance q; QA
// cases are valid on the reference and each non-equivalent mutant is killed with chance q.
//
// Plain erasable TypeScript without `$lib`.
import type { TrajectoryReport } from './contract/validate.ts';
import type { FamilyDescriptor, ItemInstance } from './contract/bank.ts';
import { GRADE_KEYS, gradeDefinition, type GradeKey, type SpecializationKey } from './contract/catalog.ts';
import {
	PROCEDURE,
	exhaustedDecision,
	maxLength,
	nextStep,
	seededRandom,
	type ClusterResult,
	type DecisionOutcome,
	type GradeDecision,
	type ProcedureParams
} from './contract/procedure.ts';
import { sha256Hex, type LoadedFamily } from './families.ts';
import { mutantRubricScore, shareDown, withChangeStep } from './score.ts';
import { chooseForSlot, seenKey, slotsOf, type AttemptForm } from './select.ts';

/** Shifts the report carries: the two the acceptance reads and the cut itself. */
export const REPORT_SHIFTS = [-0.15, 0, 0.15] as const;
/** Runs per point: the contract asks for at least 1000. */
export const REPORT_RUNS = 1000;

/** A reproducible generator from a string label (the contract's sfc32, seeded by SHA-256 of the label). */
export function labelRandom(label: string): () => number {
	const hex = sha256Hex(label);
	return seededRandom([0, 8, 16, 24].map((i) => parseInt(hex.slice(i, i + 8), 16)) as [number, number, number, number]);
}

function normal(random: () => number): number {
	return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

/** Gamma(shape, 1) by Marsaglia and Tsang; shapes under 1 by the boost u^(1/shape). */
function gamma(shape: number, random: () => number): number {
	if (shape < 1) return gamma(shape + 1, random) * random() ** (1 / shape);
	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	for (;;) {
		let x: number;
		let v: number;
		do {
			x = normal(random);
			v = 1 + c * x;
		} while (v <= 0);
		v = v ** 3;
		const u = random();
		if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
	}
}

/** A latent share with mean `mean` and intra-cluster correlation `rho`: Beta(mean·k, (1 − mean)·k), k = 1/ρ − 1. */
export function latentShare(mean: number, rho: number, random: () => number): number {
	const k = 1 / rho - 1;
	const x = gamma(mean * k, random);
	return x / (x + gamma((1 - mean) * k, random));
}

const clip = (p: number): number => Math.min(0.98, Math.max(0.02, p));

const passedOf = (count: number, chance: number, random: () => number): number => {
	let passed = 0;
	for (let i = 0; i < count; i += 1) if (random() < chance) passed += 1;
	return passed;
};

/** The score a machine candidate with shift `shift` gets on a served cluster, on the scale of 1/20. */
export function simulatedScore(
	instance: ItemInstance,
	family: FamilyDescriptor,
	angoff: number,
	shift: number,
	rho: number,
	random: () => number
): number {
	const chance = clip(angoff + shift);
	if (!instance.practice && !instance.qa) return random() < chance ? 1 : 0;
	const q = latentShare(chance, rho, random);
	let task: number;
	if (instance.practice) {
		const groups = instance.practice.groups.length;
		task = shareDown(passedOf(groups, q, random), groups);
	} else {
		if (family.rubric.kind !== 'mutants' || !instance.qa) throw new Error(`family ${family.key} has no mutant rubric`);
		const counted = instance.qa.mutants.filter((m) => !m.equivalent).length;
		task = mutantRubricScore(family.rubric, passedOf(counted, q, random) / counted);
	}
	const step = instance.changeStep;
	if (!step) return task;
	let stepScore: number;
	if (step.groups.length > 0) stepScore = shareDown(passedOf(step.groups.length, q, random), step.groups.length);
	else if (step.qa && family.rubric.kind === 'mutants') {
		const counted = step.qa.mutants.filter((m) => !m.equivalent).length;
		stepScore = mutantRubricScore(family.rubric, passedOf(counted, q, random) / counted);
	} else stepScore = random() < q ? 1 : 0;
	return withChangeStep(task, stepScore, step.weight);
}

export interface SimulatedAttempt {
	decision: GradeDecision;
	/** `seenKey`s of the classes served. */
	served: string[];
}

/** Scores a served cluster: a model of a candidate in the simulation, the deterministic verdict in the seed. */
export type ClusterScorer = (instance: ItemInstance, family: FamilyDescriptor, angoff: number, seq: number) => number;

/**
 * One grade attempt along the real path: slot by slot, choose, generate, score, ask the procedure. A slot nothing can
 * serve ends the attempt with «не определено» (`bank_exhausted`).
 */
export function runAttempt(input: {
	families: readonly LoadedFamily[];
	specialization: SpecializationKey;
	grade: GradeKey;
	form: AttemptForm;
	seen: ReadonlySet<string>;
	attemptSeed: string;
	score: ClusterScorer;
	params?: ProcedureParams;
}): SimulatedAttempt {
	const params = input.params ?? PROCEDURE;
	const { grade } = input;
	const rule = gradeDefinition(input.specialization, grade);
	const descriptors = input.families.map((f) => f.descriptor);
	const modules = new Map(input.families.map((f) => [f.descriptor.key, f.module]));
	const slots = slotsOf(input.specialization, grade, params);
	const used = new Set<string>();
	const served: string[] = [];
	const clusters: ClusterResult[] = [];
	for (let seq = 1; seq <= maxLength(params, grade); seq += 1) {
		const slot = slots[seq - 1];
		if (!slot) throw new Error(`no slot ${seq} for ${input.specialization} ${grade}`);
		const choice = chooseForSlot({
			families: descriptors,
			grade,
			slot,
			want: { kind: 'grade', form: input.form },
			usedFamilies: used,
			seen: new Set([...input.seen, ...served]),
			attemptSeed: input.attemptSeed,
			seq
		});
		if (!choice) return { decision: exhaustedDecision(params, rule, clusters), served };
		const module = modules.get(choice.family.key);
		if (!module) throw new Error(`family ${choice.family.key} has no generator`);
		const instance = module.generate({ seed: choice.seed, grade, classId: choice.classId });
		used.add(choice.family.key);
		served.push(seenKey(choice.family.key, grade, choice.classId));
		const angoff = choice.level.angoff.mean;
		clusters.push({
			block: slot.block,
			angoff,
			score: input.score(instance, choice.family, angoff, seq),
			practice: slot.practice
		});
		const step = nextStep(params, rule, clusters);
		if (step.kind === 'decided') return { decision: step.decision, served };
	}
	throw new Error('the procedure did not decide on the longest trajectory');
}

interface Shares {
	confirmed: number;
	undetermined: number;
	notConfirmed: number;
}

const tally = (outcomes: readonly DecisionOutcome[]): Shares => ({
	confirmed: outcomes.filter((o) => o === 'confirmed').length / outcomes.length,
	undetermined: outcomes.filter((o) => o === 'undetermined').length / outcomes.length,
	notConfirmed: outcomes.filter((o) => o === 'not_confirmed').length / outcomes.length
});

const agreement = (a: Shares, b: Shares): number =>
	a.confirmed * b.confirmed + a.undetermined * b.undetermined + a.notConfirmed * b.notConfirmed;

/**
 * The trajectory report of a release (`TrajectoryReport` of the contract), every grade, A then the retake on B. The runs
 * draw from `seed`, not from the id of the release: the same content under the same procedure gives the same report
 * whatever number the release gets, so a report made once is reused for that content (`scripts/release-bank.ts`).
 */
export function trajectoryReport(
	{ releaseId, seed }: { releaseId: string; seed: string },
	families: readonly LoadedFamily[],
	specialization: SpecializationKey,
	options: { runs?: number; shifts?: readonly number[]; params?: ProcedureParams } = {}
): TrajectoryReport {
	const params = options.params ?? PROCEDURE;
	const runs = options.runs ?? REPORT_RUNS;
	const shifts = options.shifts ?? REPORT_SHIFTS;
	const { rho, practiceGroups } = params.trajectoryAcceptance.model;
	const shiftsOfConsistency = params.trajectoryAcceptance.consistencyMin.map((c) => c.shift);
	const grades = GRADE_KEYS.map((grade) => {
		const points = [];
		const consistency = [];
		for (const shift of [...new Set([...shifts, ...shiftsOfConsistency])].sort((a, b) => a - b)) {
			const first: DecisionOutcome[] = [];
			const retake: DecisionOutcome[] = [];
			for (let run = 0; run < runs; run += 1) {
				const label = `${seed}:${grade}:${shift}:${run}`;
				const random = labelRandom(label);
				const score: ClusterScorer = (instance, family, angoff) =>
					simulatedScore(instance, family, angoff, shift, rho, random);
				const a = runAttempt({
					families,
					specialization,
					grade,
					form: 'A',
					seen: new Set(),
					attemptSeed: `${label}:A`,
					score,
					params
				});
				const b = runAttempt({
					families,
					specialization,
					grade,
					form: 'B',
					seen: new Set(a.served),
					attemptSeed: `${label}:B`,
					score,
					params
				});
				first.push(a.decision.outcome);
				retake.push(b.decision.outcome);
			}
			const sharesA = tally(first);
			if (shifts.includes(shift)) points.push({ shift, runs, ...sharesA });
			if (shiftsOfConsistency.includes(shift)) consistency.push({ shift, value: agreement(sharesA, tally(retake)) });
		}
		return { grade, points, consistency };
	});
	return { releaseId, procedureVersion: params.version, model: { rho, practiceGroups }, grades };
}
