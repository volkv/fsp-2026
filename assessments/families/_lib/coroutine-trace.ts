// The shared code of the Middle and Senior coroutine families of Mobile (`mob.coroutines.*`): a timeline of what a
// program prints in a single-threaded `runBlocking`, the pools of names from an Android app, and the build of a trace
// instance whose answer the JVM of the sandbox image confirms.
import { makeInstance, type Built, type FamilyDescriptor, type GenerateInput } from './family.ts';
import { kotlinOutputProbe, kotlinProgram } from './kotlin.ts';

/** Sections of a screen a coroutine loads. */
export const SECTIONS = [
	'profile',
	'feed',
	'avatar',
	'banner',
	'chat',
	'cart',
	'orders',
	'news',
	'stories',
	'settings',
	'badges',
	'weather',
	'catalog',
	'reviews'
] as const;

/** Messages of a failed load. */
export const FAILURES = [
	'offline',
	'timeout',
	'HTTP 500',
	'HTTP 404',
	'bad json',
	'no token',
	'HTTP 503',
	'reset'
] as const;

/**
 * What a program prints, ordered by the moment of the print and, at one moment, by the order of the calls that made
 * it. Moments are the virtual milliseconds of the delays; prints of one moment keep the order they were added in.
 */
export class Timeline {
	readonly #events: { at: number; seq: number; text: string }[] = [];

	add(at: number, ...texts: string[]): this {
		for (const text of texts) this.#events.push({ at, seq: this.#events.length, text });
		return this;
	}

	lines(): string[] {
		return [...this.#events].sort((a, b) => a.at - b.at || a.seq - b.seq).map((e) => e.text);
	}
}

/** A trace program: the shown lines, the printed lines and what each wrong solution prints instead. */
export interface TraceProgram {
	lines: string[];
	answer: string[];
	/** Answers of the wrong solutions that apply to the class; a missing or `null` one does not apply. */
	wrong: Readonly<Record<string, string[] | null>>;
}

const TRACE_STATEMENT =
	'Что напечатает программа на Kotlin (kotlinx.coroutines, обычный запуск на JVM)? Введите вывод построчно, ' +
	'как он появится на экране.';

/**
 * A trace instance of a coroutine program: the answer is what the model prints, the gate compares it with what the JVM
 * prints; a misconception that prints the right output on this instance does not apply to it.
 */
export function traceBuilt(
	descriptor: FamilyDescriptor,
	input: GenerateInput,
	program: TraceProgram,
	markdown: string = TRACE_STATEMENT
): Built {
	const source = program.lines.join('\n');
	const run = kotlinProgram(source);
	const toAnswer = (lines: string[]) => ({ kind: 'sequence' as const, value: lines });
	const same = (lines: string[]): boolean => lines.join('\n') === program.answer.join('\n');
	const instance = makeInstance(descriptor, input, {
		statement: { markdown, code: { language: 'kotlin', source } },
		answer: toAnswer(program.answer)
	});
	return {
		instance,
		reference: () => kotlinOutputProbe(run),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const lines = program.wrong[id] ?? null;
					return [id, lines === null || same(lines) ? null : { kind: 'answer' as const, answer: toAnswer(lines) }];
				})
			)
	};
}

/** Indents lines of Kotlin by `depth` levels of four spaces. */
export const indent = (depth: number, lines: readonly string[]): string[] =>
	lines.map((line) => (line === '' ? '' : `${'    '.repeat(depth)}${line}`));
