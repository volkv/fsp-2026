// Closures and scope in JavaScript: what a function made in a loop, a factory or a block sees when it is called, and
// what a name holds before its declaration (hoisting of var and function declarations, the temporal dead zone of let).
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { ARG_NAMES, LIST_NAMES } from '../../_lib/names.ts';
import { nodeOutputProbe } from '../../_lib/node.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Op = '+' | '-' | '*';
const apply = (x: number, op: Op, y: number): number => (op === '+' ? x + y : op === '-' ? x - y : x * y);

interface Program {
	lines: string[];
	answer: (string | number)[];
	/** Answers of the wrong solutions that apply to the class; a missing one does not apply. */
	wrong: Record<string, (string | number)[]>;
}

const LOOP_VARS = ['i', 'k', 'n', 'j', 'idx', 'pos'] as const;
const COUNTER_FACTORIES = ['makeCounter', 'createCounter', 'counterFrom', 'makeTally', 'createTally'] as const;
const COUNTER_PAIRS = [
	['left', 'right'],
	['cart', 'wish'],
	['red', 'blue'],
	['home', 'away'],
	['draft', 'final']
] as const;
const RATE_NAMES = ['rate', 'limit', 'level', 'scale', 'factor'] as const;
const FUNC_NAMES = ['charge', 'convert', 'adjust', 'measure', 'process'] as const;
const VAR_NAMES = ['total', 'count', 'score', 'amount'] as const;
const LET_NAMES = ['quota', 'budget', 'ceiling', 'reserve'] as const;
const DECL_NAMES = ['double', 'widen', 'boost', 'enlarge'] as const;
const EXPR_NAMES = ['shift', 'bump', 'grow', 'nudge'] as const;

/**
 * A counting loop: values the loop variable takes, the value it holds when the loop ends and the bound in the
 * condition (with a step of 2 the bound may lie between the last value and the value after the loop).
 */
function countingLoop(rng: Rng): {
	header: (kw: string, v: string) => string;
	values: number[];
	last: number;
	after: number;
	bound: number;
} {
	const step = rng.int(1, 2);
	const start = rng.int(0, 6);
	const count = rng.int(3, 4);
	const values = Array.from({ length: count }, (_, i) => start + i * step);
	const last = values[values.length - 1] ?? start;
	const bound = step === 1 ? last + 1 : last + rng.int(1, 2);
	const after = last + step;
	const header = (kw: string, v: string): string =>
		`for (${kw} ${v} = ${start}; ${v} < ${bound}; ${step === 1 ? `${v}++` : `${v} += ${step}`}) {`;
	return { header, values, last, after, bound };
}

function internProgram(rng: Rng, classId: string): Program {
	const list = rng.pick(LIST_NAMES);
	const v = rng.pick(LOOP_VARS);
	const x = rng.pick(ARG_NAMES);
	const op = rng.pick<Op>(['+', '-', '*']);
	const arg = rng.int(2, 12);
	const loop = countingLoop(rng);
	const each = loop.values.map((value) => apply(arg, op, value));
	const same = (value: number): number[] => loop.values.map(() => apply(arg, op, value));
	const callAll = [`for (const f of ${list}) {`, `  console.log(f(${arg}));`, '}'];
	// The bound is a separate misconception only where it differs from the value after the loop.
	const boundWrong = (tail: number[]): Record<string, number[]> =>
		loop.bound === loop.after ? {} : { 'loop-bound': [...same(loop.bound), ...tail] };
	if (classId === 'var-loop') {
		return {
			lines: [
				`const ${list} = [];`,
				loop.header('var', v),
				`  ${list}.push((${x}) => ${x} ${op} ${v});`,
				'}',
				...callAll
			],
			answer: same(loop.after),
			wrong: { 'capture-by-value': each, 'last-iteration': same(loop.last), ...boundWrong([]) }
		};
	}
	if (classId === 'let-loop') {
		return {
			lines: [
				`const ${list} = [];`,
				loop.header('let', v),
				`  ${list}.push((${x}) => ${x} ${op} ${v});`,
				'}',
				...callAll
			],
			answer: each,
			wrong: { 'per-iteration-ignored': same(loop.after) }
		};
	}
	if (classId === 'iife') {
		const p = v === 'j' ? 'm' : 'j';
		return {
			lines: [
				`var ${list} = [];`,
				loop.header('var', v),
				`  ${list}.push(`,
				`    (function (${p}) {`,
				`      return (${x}) => ${x} ${op} ${p};`,
				`    })(${v})`,
				'  );',
				'}',
				...callAll,
				`console.log(${v});`
			],
			answer: [...each, loop.after],
			wrong: {
				'per-iteration-ignored': [...same(loop.after), loop.after],
				'last-iteration': [...each, loop.last],
				...(loop.bound === loop.after ? {} : { 'loop-bound': [...each, loop.bound] })
			}
		};
	}
	// counter-factory: every call of the factory has its own count.
	const make = rng.pick(COUNTER_FACTORIES);
	const [a, b] = rng.pick(COUNTER_PAIRS);
	const starts = { [a]: rng.int(1, 9), [b]: rng.int(10, 30) } as Record<string, number>;
	const steps = { [a]: rng.int(2, 5), [b]: rng.int(2, 5) } as Record<string, number>;
	// Five calls: each counter at least twice, the first call is always the first counter.
	const calls = [a, ...rng.shuffle([a, b, b, rng.pick([a, b])])];
	const state = { ...starts };
	const answer: number[] = [];
	let shared = starts[b] ?? 0;
	const sharedAnswer: number[] = [];
	const restart: number[] = [];
	for (const name of calls) {
		const step = steps[name] ?? 0;
		state[name] = (state[name] ?? 0) + step;
		answer.push(state[name] ?? 0);
		shared += step;
		sharedAnswer.push(shared);
		restart.push((starts[name] ?? 0) + step);
	}
	return {
		lines: [
			`function ${make}(start, step) {`,
			'  let count = start;',
			'  return () => {',
			'    count += step;',
			'    return count;',
			'  };',
			'}',
			`const ${a} = ${make}(${starts[a]}, ${steps[a]});`,
			`const ${b} = ${make}(${starts[b]}, ${steps[b]});`,
			...calls.map((name) => `console.log(${name}());`)
		],
		answer,
		wrong: { 'shared-factory-state': sharedAnswer, 'restart-on-call': restart }
	};
}

function juniorProgram(rng: Rng, classId: string): Program {
	if (classId === 'tdz-shadow') {
		// A block shadows the outer name with let; a try block reads the name before its own let; the function body
		// itself updates the outer name, so the second call sees the change.
		const name = rng.pick(RATE_NAMES);
		const fn = rng.pick(FUNC_NAMES);
		const x = rng.pick(ARG_NAMES);
		const start = rng.int(2, 30);
		const d = rng.int(40, 60);
		const args = rng.sample([2, 3, 4, 5, 6, 7, 8, 9], 2);
		const block = ['  {', `    let ${name} = ${x} + ${d};`, `    console.log(${name});`, '  }'];
		const read = [`  console.log(${name} * ${x});`];
		const tdz = [
			'  try {',
			`    console.log(${name} + ${x});`,
			`    let ${name} = ${x};`,
			'  } catch (e) {',
			'    console.log(e.name);',
			'  }'
		];
		const order = rng.shuffle(['block', 'read', 'tdz'] as const);
		const parts = { block, read, tdz };
		// Every model runs the same function body with its own reading of the three segments.
		const run = (model: 'right' | 'no-tdz' | 'tdz-undefined' | 'block-leak'): (string | number)[] => {
			let outer = start;
			const out: (string | number)[] = [];
			for (const arg of args) {
				for (const part of order) {
					if (part === 'block') {
						out.push(arg + d);
						if (model === 'block-leak') outer = arg + d;
					} else if (part === 'read') out.push(outer * arg);
					else if (model === 'no-tdz') out.push(outer + arg);
					else if (model === 'tdz-undefined') out.push('NaN');
					else out.push('ReferenceError');
				}
				outer += arg;
			}
			out.push(outer);
			return out;
		};
		return {
			lines: [
				`let ${name} = ${start};`,
				`function ${fn}(${x}) {`,
				...order.flatMap((part) => parts[part]),
				`  ${name} += ${x};`,
				'}',
				...args.map((arg) => `${fn}(${arg});`),
				`console.log(${name});`
			],
			answer: run('right'),
			wrong: { 'no-tdz': run('no-tdz'), 'tdz-undefined': run('tdz-undefined'), 'block-leak': run('block-leak') }
		};
	}
	if (classId === 'hoisting') {
		const varName = rng.pick(VAR_NAMES);
		const letName = rng.pick(LET_NAMES);
		const decl = rng.pick(DECL_NAMES);
		const expr = rng.pick(EXPR_NAMES);
		const [t, l, k, m, e] = [rng.int(10, 40), rng.int(50, 90), rng.int(2, 9), rng.int(2, 9), rng.int(1, 9)];
		const [a, b] = [rng.int(2, 12), rng.int(2, 12)];
		type Probe = {
			code: string;
			right: string | number;
			varTdz: string | number;
			withValue: string | number;
			noDecl: string | number;
			letVar: string | number;
		};
		const early: Probe[] = [
			{
				code: varName,
				right: 'undefined',
				varTdz: 'ReferenceError',
				withValue: t,
				noDecl: 'undefined',
				letVar: 'undefined'
			},
			{ code: `${decl}(${a})`, right: a * k, varTdz: a * k, withValue: a * k, noDecl: 'ReferenceError', letVar: a * k },
			{
				code: `${expr}(${b})`,
				right: 'TypeError',
				varTdz: 'ReferenceError',
				withValue: b * m + e,
				noDecl: 'TypeError',
				letVar: 'TypeError'
			},
			{
				code: letName,
				right: 'ReferenceError',
				varTdz: 'ReferenceError',
				withValue: 'ReferenceError',
				noDecl: 'ReferenceError',
				letVar: 'undefined'
			}
		];
		const shown = rng.shuffle(early);
		const last = t + (b * m + e) + l;
		const pick = (key: keyof Omit<Probe, 'code'>): (string | number)[] => [...shown.map((p) => p[key]), last];
		return {
			lines: [
				'function show(read) {',
				'  try {',
				'    console.log(read());',
				'  } catch (e) {',
				'    console.log(e.name);',
				'  }',
				'}',
				...shown.map((p) => `show(() => ${p.code});`),
				`var ${varName} = ${t};`,
				`let ${letName} = ${l};`,
				`var ${expr} = function (x) {`,
				`  return x * ${m} + ${e};`,
				'};',
				`function ${decl}(x) {`,
				`  return x * ${k};`,
				'}',
				`show(() => ${varName} + ${expr}(${b}) + ${letName});`
			],
			answer: pick('right'),
			wrong: {
				'var-tdz': pick('varTdz'),
				'hoist-with-value': pick('withValue'),
				'declaration-not-hoisted': pick('noDecl'),
				'let-like-var': pick('letVar')
			}
		};
	}
	if (classId === 'counters') {
		// Two counters of one factory, an alias of the first, and a module-level bonus read at call time.
		const make = rng.pick(COUNTER_FACTORIES);
		const [s1, s2] = [rng.int(1, 9), rng.int(10, 30)];
		const [b1, b2] = [rng.int(1, 4), rng.int(5, 9)];
		const p = Array.from({ length: 5 }, () => rng.int(1, 9));
		const [p1, p2, p3, p4, p5] = p as [number, number, number, number, number];
		const bonus = rng.pick(['bonus', 'extra', 'tip']);
		const [first, second] = rng.pick(COUNTER_PAIRS);
		const alias = rng.pick(['same', 'again', 'other']);
		const c1 = s1 + p1 + b1;
		const c2 = s2 + p2 + b1;
		const answer = [c1, c2, c1 + p3 + b2, c2 + p4 + b2, c1 + p3 + b2 + p5 + b2];
		const sh1 = s2 + p1 + b1;
		const sh2 = sh1 + p2 + b1;
		const sh3 = sh2 + p3 + b2;
		const sh4 = sh3 + p4 + b2;
		const aliasCopy = s1 + p3 + b2;
		return {
			lines: [
				`let ${bonus} = ${b1};`,
				`function ${make}(start) {`,
				'  let count = start;',
				'  return (step) => {',
				`    count += step + ${bonus};`,
				'    return count;',
				'  };',
				'}',
				`const ${first} = ${make}(${s1});`,
				`const ${second} = ${make}(${s2});`,
				`const ${alias} = ${first};`,
				`console.log(${first}(${p1}));`,
				`console.log(${second}(${p2}));`,
				`${bonus} = ${b2};`,
				`console.log(${alias}(${p3}));`,
				`console.log(${second}(${p4}));`,
				`console.log(${first}(${p5}));`
			],
			answer,
			wrong: {
				'shared-factory-state': [sh1, sh2, sh3, sh4, sh4 + p5 + b2],
				'alias-copies': [c1, c2, aliasCopy, c2 + p4 + b2, c1 + p5 + b2],
				'capture-by-value': [c1, c2, c1 + p3 + b1, c2 + p4 + b1, c1 + p3 + b1 + p5 + b1]
			}
		};
	}
	// loops-mixed: functions from a var loop and a let loop, the var rebound after both loops.
	const [fs, gs] = rng.sample(LIST_NAMES, 2) as [string, string];
	const [v, w] = rng.sample(LOOP_VARS, 2) as [string, string];
	const [a, n1] = [rng.int(0, 5), rng.int(2, 3)];
	const [c, n2] = [rng.int(1, 9), rng.int(2, 3)];
	const k = rng.int(2, 9);
	const rebound = rng.int(20, 40);
	const first = Array.from({ length: n1 }, (_, i) => a + i);
	const second = Array.from({ length: n2 }, (_, i) => c + i);
	const end1 = a + n1;
	const end2 = c + n2;
	return {
		lines: [
			`const ${fs} = [];`,
			`for (var ${v} = ${a}; ${v} < ${end1}; ${v}++) {`,
			`  ${fs}.push(() => ${v} * ${k});`,
			'}',
			`const ${gs} = [];`,
			`for (let ${w} = ${c}; ${w} < ${end2}; ${w}++) {`,
			`  ${gs}.push(() => ${w} + ${v});`,
			'}',
			`${v} = ${rebound};`,
			`for (const f of [...${fs}, ...${gs}]) {`,
			'  console.log(f());',
			'}'
		],
		answer: [...first.map(() => rebound * k), ...second.map((value) => value + rebound)],
		wrong: {
			'capture-by-value': [...first.map((value) => value * k), ...second.map((value) => value + end1)],
			'frozen-at-loop-end': [...first.map(() => end1 * k), ...second.map((value) => value + end1)],
			'per-iteration-ignored': [...first.map(() => rebound * k), ...second.map(() => end2 + rebound)]
		}
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const program = input.grade === 'intern' ? internProgram(rng, input.classId) : juniorProgram(rng, input.classId);
	const source = program.lines.join('\n');
	const toAnswer = (values: (string | number)[]) => ({ kind: 'sequence' as const, value: values.map(String) });
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Что напечатает программа на JavaScript (Node.js 24, обычный скрипт)? Введите вывод построчно, как он появится в консоли.',
			code: { language: 'javascript', source }
		},
		answer: toAnswer(program.answer)
	});
	return {
		instance,
		reference: () => nodeOutputProbe(source, 'javascript'),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const values = program.wrong[id];
					return [id, values === undefined ? null : { kind: 'answer' as const, answer: toAnswer(values) }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
