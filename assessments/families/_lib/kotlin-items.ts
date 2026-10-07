// Items of the Kotlin families of `mob.kotlin` that share a build: a trace (the shown program, the output its model
// predicts, the outputs of the misconceptions) and a module with one defect line (units with their specification in
// KDoc, the checks of that specification, the defect, the fix and the distractor edits that leave the defect in place).
import { makeInstance, type Built, type FamilyDescriptor, type GenerateInput, type ItemInstance } from './family.ts';
import { kotlinDefectProbe, kotlinDefectRuns, kotlinOutputProbe, kotlinProgram } from './kotlin.ts';
import type { Rng } from './rng.ts';

/** A trace program: its lines, the output of the model and the outputs of the misconceptions. */
export interface TraceProgram {
	lines: string[];
	answer: string[];
	/** Outputs of the wrong solutions that apply to the class; a missing or `null` one does not apply. */
	wrong: Record<string, string[] | null>;
}

const TRACE_STATEMENT = 'Что напечатает программа на Kotlin? Введите вывод построчно, как он появится на экране.';

/** A trace instance proved by the JVM; a misconception that gives the right output on the instance does not apply to it. */
export function traceBuilt(descriptor: FamilyDescriptor, input: GenerateInput, program: TraceProgram): Built {
	if (program.answer.some((line) => line.trim() === '')) throw new Error('an empty line of output');
	const source = program.lines.join('\n');
	const run = kotlinProgram(source);
	const toAnswer = (lines: string[]) => ({ kind: 'sequence' as const, value: lines });
	const same = (lines: string[]): boolean => lines.join('\n') === program.answer.join('\n');
	const instance: ItemInstance = makeInstance(descriptor, input, {
		statement: { markdown: TRACE_STATEMENT, code: { language: 'kotlin', source } },
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

/** A plausible edit of a line (0-based within its unit) that leaves the defect in place. */
export interface LineEdit {
	line: number;
	text: string;
}

/**
 * A function or a class of a defect module: its lines with the KDoc specification, the shared declarations it needs, the
 * checks of its specification (Kotlin statements of `main`, each failing by an exception) and its possible defects.
 */
export interface KtUnit {
	name: string;
	lines: string[];
	/** Names of the shared declarations of the family the unit uses. */
	needs?: readonly string[];
	checks: string[];
	defects: { kind: string; line: number; text: string; neighbour: LineEdit }[];
	/** A plausible edit of this unit when it is correct: the misconception «the defect is here». */
	decoy: LineEdit;
}

export interface DefectModule {
	source: string;
	check: string;
	/** The defect line, 1-based. */
	line: number;
	fix: string;
	neighbour: { line: number; replacement: string };
	other: { line: number; replacement: string };
}

/**
 * A module of `contextCount + 1` units in random order behind a header of random length, one of them with a defect of
 * the kind. `types` are the shared declarations (one line each) the units name in `needs`.
 */
export function composeDefect(
	rng: Rng,
	library: readonly KtUnit[],
	kind: string,
	contextCount: number,
	types: Readonly<Record<string, string>>,
	header: { titles: readonly string[]; constants: readonly string[] }
): DefectModule {
	const candidates = library.flatMap((unit) =>
		unit.defects.filter((d) => d.kind === kind).map((defect) => ({ unit, defect }))
	);
	const { unit: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((u) => u !== buggy),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	const needed = [...new Set(order.flatMap((u) => u.needs ?? []))];
	const declarations = rng.shuffle(
		needed.map((name) => {
			const text = types[name];
			if (text === undefined) throw new Error(`unknown declaration ${name}`);
			return text;
		})
	);
	const constants = rng.sample(header.constants, rng.int(0, Math.min(3, header.constants.length)));
	const lines: string[] = [
		`// ${rng.pick(header.titles)}.`,
		...(declarations.length ? ['', ...declarations] : []),
		...(constants.length ? ['', ...constants] : []),
		''
	];
	let answer = 0;
	let neighbour = { line: 0, replacement: '' };
	let other = { line: 0, replacement: '' };
	for (const unit of order) {
		const offset = lines.length;
		unit.lines.forEach((text, i) => lines.push(unit === buggy && i === defect.line ? defect.text : text));
		if (unit === buggy) {
			answer = offset + defect.line + 1;
			neighbour = { line: offset + defect.neighbour.line + 1, replacement: defect.neighbour.text };
		} else if (other.line === 0) {
			other = { line: offset + unit.decoy.line + 1, replacement: unit.decoy.text };
		}
		lines.push('');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	const fix = buggy.lines[defect.line];
	if (fix === undefined) throw new Error(`${buggy.name}: no line ${defect.line}`);
	const check = [
		'fun main() {',
		...order.flatMap((unit) => ['    run {', ...unit.checks.map((c) => `        ${c}`), '    }']),
		'    println("ok")',
		'}'
	].join('\n');
	return { source: lines.join('\n'), check, line: answer, fix, neighbour, other };
}

/**
 * A defect instance proved by the JVM: the module with the checks fails, with the defect line fixed it passes, and the
 * distractor edits do not repair it. The wrong solutions `neighbour-line` and `other-unit` name the distractor lines.
 */
export function defectBuilt(
	descriptor: FamilyDescriptor,
	input: GenerateInput,
	module: DefectModule,
	markdown: string
): Built {
	const runs = kotlinDefectRuns({
		source: module.source,
		check: module.check,
		line: module.line,
		fix: module.fix,
		distractors: [module.neighbour, module.other]
	});
	const instance = makeInstance(descriptor, input, {
		statement: { markdown, code: { language: 'kotlin', source: module.source } },
		answer: { kind: 'line_no', value: module.line }
	});
	return {
		instance,
		reference: () => kotlinDefectProbe(runs),
		wrong: () => ({
			'neighbour-line': { kind: 'answer', answer: { kind: 'line_no', value: module.neighbour.line } },
			'other-unit': { kind: 'answer', answer: { kind: 'line_no', value: module.other.line } }
		})
	};
}
