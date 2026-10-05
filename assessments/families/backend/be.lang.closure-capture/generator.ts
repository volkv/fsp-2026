// Closures: what a function made in a loop, a comprehension or a factory sees when it is called later.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { ARG_NAMES, FUNC_NAMES, LIST_NAMES, VAR_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Op = '+' | '-' | '*';
const apply = (x: number, op: Op, y: number): number => (op === '+' ? x + y : op === '-' ? x - y : x * y);
const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i);

interface Program {
	lines: string[];
	answer: number[];
	/** Answers of the wrong solutions that apply to the class; a missing one does not apply. */
	wrong: Record<string, number[] | null>;
}

function internProgram(rng: Rng, classId: string): Program {
	const [fs, v, x] = [rng.pick(LIST_NAMES), rng.pick(VAR_NAMES), rng.pick(ARG_NAMES)];
	const op = rng.pick<Op>(['+', '-', '*']);
	const start = rng.int(1, 6);
	const count = rng.int(3, 4);
	const arg = rng.int(2, 9);
	const values = range(start, count);
	const last = values[values.length - 1] ?? 0;
	const each = values.map((value) => apply(arg, op, value));
	const allLast = values.map(() => apply(arg, op, last));
	const call = [`for f in ${fs}:`, `    print(f(${arg}))`];
	if (classId === 'loop-late') {
		return {
			lines: [
				`${fs} = []`,
				`for ${v} in range(${start}, ${start + count}):`,
				`    ${fs}.append(lambda ${x}: ${x} ${op} ${v})`,
				...call
			],
			answer: allLast,
			wrong: { 'capture-by-value': each, 'scope-leak': null, 'default-at-call': null, 'shared-factory-state': null }
		};
	}
	if (classId === 'default-arg') {
		return {
			lines: [
				`${fs} = []`,
				`for ${v} in range(${start}, ${start + count}):`,
				`    ${fs}.append(lambda ${x}, ${v}=${v}: ${x} ${op} ${v})`,
				...call
			],
			answer: each,
			wrong: { 'capture-by-value': null, 'scope-leak': null, 'default-at-call': allLast, 'shared-factory-state': null }
		};
	}
	if (classId === 'call-time') {
		// The same lambda is called inside the loop and again after the name is rebound past the loop.
		const k = rng.int(20, 40);
		const rebound = values.map(() => apply(arg, op, k));
		return {
			lines: [
				`${fs} = []`,
				`for ${v} in range(${start}, ${start + count}):`,
				`    f = lambda ${x}: ${x} ${op} ${v}`,
				`    ${fs}.append(f)`,
				`    print(f(${arg}))`,
				`${v} = ${k}`,
				...call
			],
			answer: [...each, ...rebound],
			wrong: { 'capture-by-value': [...each, ...each], 'frozen-at-loop-end': [...each, ...allLast] }
		};
	}
	const make = rng.pick(FUNC_NAMES);
	return {
		lines: [
			`def ${make}(${v}):`,
			`    return lambda ${x}: ${x} ${op} ${v}`,
			'',
			`${fs} = [${make}(${v}) for ${v} in range(${start}, ${start + count})]`,
			...call
		],
		answer: each,
		wrong: { 'capture-by-value': null, 'scope-leak': null, 'default-at-call': null, 'shared-factory-state': allLast }
	};
}

function juniorProgram(rng: Rng, classId: string): Program {
	const [fs, gs] = rng.sample(LIST_NAMES, 2) as [string, string];
	const [v, w] = rng.sample(VAR_NAMES, 2) as [string, string];
	const x = rng.pick(ARG_NAMES);
	if (classId === 'nonlocal') {
		const make = rng.pick(FUNC_NAMES);
		const [s1, s2] = [rng.int(1, 9), rng.int(10, 30)];
		const steps = Array.from({ length: 5 }, () => rng.int(1, 9));
		const [p1, p2, p3, p4, p5] = steps as [number, number, number, number, number];
		const [a, b, c] = ['first', 'second', 'alias'];
		const answer = [s1 + p1, s2 + p2, s1 + p1 + p3, s1 + p1 + p3 + p4, s2 + p2 + p5];
		let shared = s2;
		const sharedAnswer = steps.map((step) => (shared += step));
		return {
			lines: [
				`def ${make}(start):`,
				'    total = start',
				`    def add(${x}):`,
				'        nonlocal total',
				`        total += ${x}`,
				'        return total',
				'    return add',
				'',
				`${a} = ${make}(${s1})`,
				`${b} = ${make}(${s2})`,
				`print(${a}(${p1}))`,
				`print(${b}(${p2}))`,
				`print(${a}(${p3}))`,
				`${c} = ${a}`,
				`print(${c}(${p4}))`,
				`print(${b}(${p5}))`
			],
			answer,
			wrong: {
				'capture-by-value': [s1 + p1, s2 + p2, s1 + p3, s1 + p4, s2 + p5],
				'scope-leak': null,
				'default-at-call': null,
				'shared-factory-state': sharedAnswer
			}
		};
	}
	if (classId === 'unbound-local') {
		const [makeA, makeB, makeC] = rng.sample(FUNC_NAMES, 3) as [string, string, string];
		const [s1, s2, s3] = [rng.int(1, 9), rng.int(10, 30), rng.int(2, 9)];
		const [p1, p2, p3] = [rng.int(1, 9), rng.int(1, 9), rng.int(1, 9)];
		const [mul, d] = [rng.int(2, 4), rng.int(3, 9)];
		const error = -1;
		return {
			lines: [
				`def ${makeA}(start):`,
				'    total = start',
				`    def add(${x}):`,
				'        nonlocal total',
				`        total += ${x}`,
				'        return total',
				'    return add',
				'',
				`def ${makeB}(start):`,
				'    total = start',
				`    def add(${x}):`,
				`        total = total + ${x}`,
				'        return total',
				'    return add',
				'',
				`def ${makeC}(start):`,
				'    total = start',
				'    def peek():',
				`        return total * ${mul}`,
				`    total += ${d}`,
				'    return peek',
				'',
				`${fs} = ${makeA}(${s1})`,
				`${gs} = ${makeB}(${s2})`,
				`print(${fs}(${p1}))`,
				'try:',
				`    print(${gs}(${p2}))`,
				'except UnboundLocalError:',
				`    print(${error})`,
				`print(${fs}(${p3}))`,
				`print(${makeC}(${s3})())`
			],
			answer: [s1 + p1, error, s1 + p1 + p3, (s3 + d) * mul],
			wrong: {
				'capture-by-value': [s1 + p1, error, s1 + p1 + p3, s3 * mul],
				'assign-reads-outer': [s1 + p1, s2 + p2, s1 + p1 + p3, (s3 + d) * mul]
			}
		};
	}
	const [op1, op2] = [rng.pick<Op>(['+', '-', '*']), rng.pick<Op>(['+', '-', '*'])];
	const [n1, n2] = [rng.int(2, 3), rng.int(2, 3)];
	const a = rng.int(0, 4);
	const c = rng.int(5, 9);
	const k = rng.int(20, 40);
	const m = rng.int(50, 70);
	const arg = rng.int(2, 6);
	const firstValues = range(a, n1);
	const secondValues = range(c, n2);
	const lastFirst = firstValues[firstValues.length - 1] ?? 0;
	const firstEach = firstValues.map((value) => apply(arg, op1, value));
	const firstLast = firstValues.map(() => apply(arg, op1, lastFirst));
	const firstRebound = firstValues.map(() => apply(arg, op1, k));
	const secondEach = secondValues.map((value) => apply(arg, op2, value));
	const secondRebound = secondValues.map(() => apply(arg, op2, m));
	const tail = [
		`${v} = ${k}`,
		`${gs} = []`,
		`for ${w} in range(${c}, ${c + n2}):`,
		`    ${gs}.append(lambda ${x}: ${x} ${op2} ${w})`,
		`${w} = ${m}`,
		`for f in ${fs} + ${gs}:`,
		`    print(f(${arg}))`
	];
	if (classId === 'scopes-late') {
		return {
			lines: [`${fs} = [lambda ${x}: ${x} ${op1} ${v} for ${v} in range(${a}, ${a + n1})]`, ...tail],
			answer: [...firstLast, ...secondRebound],
			wrong: {
				'capture-by-value': [...firstEach, ...secondEach],
				'scope-leak': [...firstRebound, ...secondRebound],
				'default-at-call': null,
				'shared-factory-state': null
			}
		};
	}
	return {
		lines: [`${fs} = [lambda ${x}, ${v}=${v}: ${x} ${op1} ${v} for ${v} in range(${a}, ${a + n1})]`, ...tail],
		answer: [...firstEach, ...secondRebound],
		wrong: {
			'capture-by-value': [...firstEach, ...secondEach],
			'scope-leak': null,
			'default-at-call': [...firstRebound, ...secondRebound],
			'shared-factory-state': null
		}
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const program = input.grade === 'intern' ? internProgram(rng, input.classId) : juniorProgram(rng, input.classId);
	const source = program.lines.join('\n');
	const toAnswer = (values: number[]) => ({ kind: 'sequence' as const, value: values.map(String) });
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown: 'Что напечатает программа на Python 3? Введите вывод построчно, как он появится на экране.',
			code: { language: 'python3', source }
		},
		answer: toAnswer(program.answer)
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source, stdin: '' }),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const values = program.wrong[id] ?? null;
					return [id, values === null ? null : { kind: 'answer' as const, answer: toAnswer(values) }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
