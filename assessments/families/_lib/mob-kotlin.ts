// Output traces of short Kotlin programs (block `mob.kotlin`): the generator models the program and computes its output
// and the output of every misconception; the gate proves the output with the Kotlin compiler and the JVM of the
// sandbox image (`kotlin.ts`).
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type FamilyDescriptor,
	type GenerateInput
} from './family.ts';
import { kotlinOutputProbe, kotlinProgram } from './kotlin.ts';
import type { Rng } from './rng.ts';

/** A shown program, its output line by line and the output of each misconception that applies to it. */
export interface TraceProgram {
	lines: string[];
	answer: string[];
	/** Output under each wrong solution of the descriptor; a missing or `null` one does not apply to the class. */
	wrong: Record<string, string[] | null>;
}

const STATEMENT = 'Что напечатает программа на Kotlin? Введите вывод построчно, как он появится на экране.';

/** A Kotlin list as `println` prints it: `[a, b, c]`. */
export const ktList = (items: readonly (string | number)[]): string => `[${items.join(', ')}]`;

/** A Kotlin map as `println` prints it, in the order of its entries: `{k=v, …}`. */
export const ktMap = (entries: readonly (readonly [string | number, string | number])[]): string =>
	`{${entries.map(([k, v]) => `${k}=${v}`).join(', ')}}`;

/** Kotlin `Int` division: the quotient is truncated toward zero. */
export const ktDiv = (a: number, b: number): number => Math.trunc(a / b);

/** Kotlin `Int` remainder: the sign follows the dividend. */
export const ktRem = (a: number, b: number): number => a - ktDiv(a, b) * b;

/**
 * The instance of a trace family and its gate material: the reference is the output of the program on the JVM; a
 * misconception whose output equals the right one on this instance does not apply to it.
 */
export function traceBuild(
	descriptor: FamilyDescriptor,
	input: GenerateInput,
	program: (rng: Rng, grade: string, classId: string) => TraceProgram
): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const p = program(rng, input.grade, input.classId);
	if (p.answer.length === 0 || p.answer.some((line) => line.trim() === ''))
		throw new Error(`${descriptor.key}: an empty line of output`);
	const source = p.lines.join('\n');
	const run = kotlinProgram(source);
	const toAnswer = (lines: string[]) => ({ kind: 'sequence' as const, value: lines });
	const same = (lines: string[]): boolean => lines.join('\n') === p.answer.join('\n');
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: STATEMENT, code: { language: 'kotlin', source } },
		answer: toAnswer(p.answer)
	});
	return {
		instance,
		reference: () => kotlinOutputProbe(run),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const lines = p.wrong[id] ?? null;
					return [id, lines === null || same(lines) ? null : { kind: 'answer' as const, answer: toAnswer(lines) }];
				})
			)
	};
}
