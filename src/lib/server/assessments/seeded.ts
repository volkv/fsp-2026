// The deterministic verdict of seeded attempts (docs/domain.md, 23.3): the seed of the demo takes the real path of the
// product — the choice of items from the release, the procedure, the policy, the owner of the category — but runs
// nothing in the sandbox. The score of a cluster is a function of (the candidate's seed, the candidate's true share,
// the slot): a Bernoulli outcome with the true share; a program — the share of its groups passed, each with the true
// share, rounded down to 1/20; QA — the rubric level of the share of mutants killed; the step «измени своё решение» — the same for its own
// groups or answer. Artifacts of such attempts say `seeded: true` and carry no code.
import type { FamilyDescriptor, ItemInstance } from './contract/bank.ts';
import { mutantRubricScore, shareDown, withChangeStep } from './score.ts';
import { seededIndex } from './select.ts';

const RESOLUTION = 1_000_000;

/** A uniform number in [0, 1) from the candidate's seed and a label. */
const uniform = (seed: string, label: string): number => seededIndex(seed, label, RESOLUTION) / RESOLUTION;

/** The share of `count` Bernoulli outcomes with the true share, rounded down to 1/20. */
function share(seed: string, label: string, count: number, trueShare: number): number {
	let passed = 0;
	for (let i = 0; i < count; i += 1) if (uniform(seed, `${label}:${i}`) < trueShare) passed += 1;
	return shareDown(passed, count);
}

function killRatio(
	seed: string,
	label: string,
	mutants: readonly { equivalent: boolean }[],
	trueShare: number
): number {
	const counted = mutants.filter((m) => !m.equivalent).length;
	let killed = 0;
	for (let i = 0; i < counted; i += 1) if (uniform(seed, `${label}:${i}`) < trueShare) killed += 1;
	return killed / counted;
}

function stepScore(
	seed: string,
	label: string,
	instance: ItemInstance,
	family: FamilyDescriptor,
	trueShare: number
): number | null {
	const step = instance.changeStep;
	if (!step) return null;
	if (step.groups.length > 0) return share(seed, `${label}:step`, step.groups.length, trueShare);
	if (step.qa && family.rubric.kind === 'mutants')
		return mutantRubricScore(family.rubric, killRatio(seed, `${label}:step`, step.qa.mutants, trueShare));
	return uniform(seed, `${label}:step`) < trueShare ? 1 : 0;
}

/** The seeded score of the cluster of slot `seq`: same inputs, same score. */
export function seededClusterScore(input: {
	candidateSeed: string;
	trueShare: number;
	seq: number;
	instance: ItemInstance;
	family: FamilyDescriptor;
}): number {
	const { candidateSeed: seed, trueShare, seq, instance, family } = input;
	if (!(trueShare >= 0 && trueShare <= 1)) throw new Error(`true share ${trueShare} is outside [0, 1]`);
	const label = `slot:${seq}`;
	let task: number;
	if (instance.practice) task = share(seed, label, instance.practice.groups.length, trueShare);
	else if (instance.qa) {
		if (family.rubric.kind !== 'mutants') throw new Error(`family ${family.key} has no mutant rubric`);
		task = mutantRubricScore(family.rubric, killRatio(seed, label, instance.qa.mutants, trueShare));
	} else task = uniform(seed, label) < trueShare ? 1 : 0;
	const step = stepScore(seed, label, instance, family, trueShare);
	return step === null || !instance.changeStep ? task : withChangeStep(task, step, instance.changeStep.weight);
}
