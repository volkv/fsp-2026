// Building an instance of a computed Data Science / ML item: a scenario is drawn until every misconception that
// applies to it gives an answer a candidate holding it cannot round into the right one; the gates prove the answer with
// an independent Python program reading the scenario's parameters as JSON.
import { sameAnswer } from './answers.ts';
import { farApart } from './ds.ts';
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type ComputedAnswer,
	type FamilyDescriptor,
	type GenerateInput
} from './family.ts';
import type { Rng } from './rng.ts';

export interface ComputedScenario {
	markdown: string;
	code: { language: string; source: string } | null;
	answer: ComputedAnswer;
	/** Parameters of the scenario for the family's Python reference (its standard input, one JSON line). */
	input: unknown;
	/** The answer of each misconception that applies to the scenario; a misconception not named does not apply. */
	wrong: Readonly<Record<string, ComputedAnswer>>;
}

/** Whether a wrong answer is clearly not the right one: real answers by `farApart`, others by the gates' comparison. */
function clearlyWrong(right: ComputedAnswer, wrong: ComputedAnswer): boolean {
	if (right.kind === 'float_eps' && wrong.kind === 'float_eps')
		return farApart(right.value, wrong.value, Math.round(-Math.log10(right.eps)));
	return !sameAnswer(right, wrong);
}

/**
 * Draws scenarios from the instance's random stream until one has every misconception it names clearly wrong; the
 * Python reference `referenceSource` reads the scenario's `input` from standard input and prints the answer.
 */
export function buildComputed(
	descriptor: FamilyDescriptor,
	input: GenerateInput,
	referenceSource: string,
	draw: (rng: Rng) => ComputedScenario | null,
	tries = 400
): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let attempt = 0; attempt < tries; attempt += 1) {
		const scenario = draw(rng);
		if (scenario === null) continue;
		const wrong = scenario.wrong;
		for (const id of Object.keys(wrong))
			if (!descriptor.wrongSolutions.some((w) => w.id === id))
				throw new Error(`${descriptor.key}: the scenario names an undeclared wrong solution ${id}`);
		if (Object.values(wrong).some((answer) => !clearlyWrong(scenario.answer, answer))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: scenario.markdown, code: scenario.code },
			answer: scenario.answer
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: referenceSource, stdin: JSON.stringify(scenario.input) }),
			wrong: () =>
				Object.fromEntries(
					descriptor.wrongSolutions.map((w) => {
						const answer = wrong[w.id];
						return [w.id, answer === undefined ? null : { kind: 'answer' as const, answer }];
					})
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after ${tries} tries`);
}
