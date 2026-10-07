// Type coercion in JavaScript: `+` with strings, loose against strict equality, Number/parseInt/parseFloat,
// truthiness, the default sort order, ToPrimitive of objects (valueOf against toString), `??` against `||` and
// destructuring defaults, relational comparison of strings and numbers.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { nodeOutputProbe } from '../../_lib/node.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Out = string | number | boolean;

/**
 * One printed expression: its output and the output each misconception predicts for it. A misconception listed on
 * a line always predicts another output there; that is what makes it apply to the instance.
 */
interface Line {
	code: string;
	right: Out;
	wrong?: Readonly<Record<string, Out>>;
}

interface Program {
	lines: string[];
	answer: Out[];
	/** Answers of the wrong solutions that apply to the class; a missing one does not apply. */
	wrong: Record<string, Out[]>;
}

/** A program of printed expressions after a prelude; a misconception applies where some line names it. */
function printed(prelude: readonly string[], lines: readonly Line[]): Program {
	const ids = [...new Set(lines.flatMap((line) => Object.keys(line.wrong ?? {})))];
	for (const line of lines) {
		for (const [id, value] of Object.entries(line.wrong ?? {})) {
			if (String(value) === String(line.right)) throw new Error(`${id} predicts the right output of ${line.code}`);
		}
	}
	return {
		lines: [...prelude, ...lines.map((line) => `console.log(${line.code});`)],
		answer: lines.map((line) => line.right),
		wrong: Object.fromEntries(ids.map((id) => [id, lines.map((line) => line.wrong?.[id] ?? line.right)]))
	};
}

const digits = (from: number, to: number, rng: Rng, count: number): number[] =>
	rng.sample(
		Array.from({ length: to - from + 1 }, (_, i) => from + i),
		count
	);

function plusStrings(rng: Rng): Program {
	const num = (): number => rng.int(1, 9);
	const [a, b, s] = [num(), num(), num()];
	const [n, m] = [rng.int(10, 60), rng.int(2, 9)];
	const [u, w] = [rng.int(10, 60), rng.int(1, 9)];
	const [c, d, e] = [num(), num(), num()];
	const core: Line[] = [
		{ code: `${a} + ${b} + '${s}'`, right: `${a + b}${s}`, wrong: { 'all-concat': `${a}${b}${s}` } },
		{ code: `'${n}' - ${m}`, right: n - m, wrong: { 'string-math-nan': 'NaN' } },
		{ code: `+'${u}' + ${w}`, right: u + w, wrong: { 'unary-plus-ignored': `${u}${w}` } }
	];
	const [p, q] = [num(), num()];
	const extras: Line[] = [
		{ code: `'${s}' + ${p} + ${q}`, right: `${s}${p}${q}`, wrong: { 'numbers-first': `${s}${p + q}` } },
		{ code: `'${c}' * '${d}'`, right: c * d, wrong: { 'string-math-nan': 'NaN' } },
		{ code: `true + ${e}`, right: e + 1, wrong: { 'bool-as-string': `true${e}` } },
		{ code: `null + ${d}`, right: d, wrong: { 'null-like-undefined': 'NaN' } },
		{ code: `undefined + ${c}`, right: 'NaN' }
	];
	return printed([], rng.shuffle([...core, ...rng.sample(extras, 2)]));
}

function equality(rng: Rng): Program {
	const n = rng.int(2, 99);
	const core: Line[] = [
		{ code: `'${n}' == ${n}`, right: true, wrong: { 'loose-is-strict': false } },
		{ code: 'null == 0', right: false, wrong: { 'null-zero': true } },
		{ code: 'NaN == NaN', right: false, wrong: { 'nan-equal': true } },
		{ code: `'${n}' == '${n}.0'`, right: false, wrong: { 'strings-numeric': true } }
	];
	const loose = (code: string, right: boolean): Line =>
		right ? { code, right, wrong: { 'loose-is-strict': false } } : { code, right };
	const k = rng.int(10, 99);
	const other = rng.bool() ? k : k + rng.int(1, 5);
	const t = rng.pick([1, 1, 2, 3, 5]);
	const extras: Line[] = [
		loose(`${k} == '${other}.0'`, k === other),
		{ code: `'${k}' === ${k}`, right: false },
		rng.bool() ? loose('null == undefined', true) : { code: 'null === undefined', right: false },
		t === 1 ? loose(`true == '${t}'`, true) : { code: `true == '${t}'`, right: false, wrong: { 'true-truthy': true } },
		rng.bool() ? loose("'' == 0", true) : { code: "'' == '0'", right: false },
		{ code: 'NaN != NaN', right: true, wrong: { 'nan-equal': false } },
		{ code: 'null >= 0', right: true },
		{ code: 'undefined == 0', right: false }
	];
	return printed([], rng.shuffle([...core, ...rng.sample(extras, 4)]));
}

function conversions(rng: Rng): Program {
	const [n, k] = [rng.int(10, 99), rng.int(2, 9)];
	const [i, f] = [rng.int(1, 20), rng.int(5, 9)];
	const [j, g] = [rng.int(1, 20), rng.int(1, 9)];
	const unit = rng.pick(['px', 'em', 'kg', 'ms']);
	const core: Line[] = [
		{ code: `Number('${n}${unit}')`, right: 'NaN', wrong: { 'number-like-parseint': n } },
		{ code: `parseInt('${k}${n}${unit}')`, right: k * 100 + n, wrong: { 'parse-strict': 'NaN' } },
		{ code: "Number('')", right: 0, wrong: { 'empty-is-nan': 'NaN' } },
		{ code: `parseInt('${i}.${f}')`, right: i, wrong: { 'parseint-rounds': i + 1 } }
	];
	const extras: Line[] = [
		{ code: `parseFloat('${j}.${g}${unit}')`, right: Number(`${j}.${g}`), wrong: { 'parse-strict': 'NaN' } },
		{ code: `Number(' ${k}${g} ')`, right: k * 10 + g },
		{ code: 'Number(null)', right: 0, wrong: { 'null-nan': 'NaN' } },
		{ code: 'Number(undefined)', right: 'NaN' },
		{ code: `Number('${j}e2')`, right: j * 100, wrong: { 'number-like-parseint': j } },
		{ code: `parseInt('${g}e2')`, right: g },
		{ code: `Number(true) + ${n}`, right: n + 1 }
	];
	return printed([], rng.shuffle([...core, ...rng.sample(extras, 2)]));
}

/** A literal and whether it is truthy. */
const FLAGS: readonly (readonly [string, boolean])[] = [
	["''", false],
	['0', false],
	["' '", true],
	['null', false],
	['undefined', false],
	['NaN', false],
	['{}', true],
	["'false'", true],
	['-1', true],
	['0.5', true]
];

function sortTruthiness(rng: Rng): Program {
	// One-digit numbers above the first digit of a two-digit one: the string order differs from the numeric one.
	const small = digits(3, 9, rng, 2);
	const big = [rng.int(10, 29), rng.int(10, 99), rng.int(100, 400)];
	const nums = rng.shuffle([...small, ...big]);
	const lexical = [...nums].sort((x, y) => (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0));
	const ascending = [...nums].sort((x, y) => x - y);
	const descending = [...ascending].reverse();
	const others = rng.sample(FLAGS, 5);
	const flags = rng.shuffle<readonly [string, boolean]>([["'0'", true], ['[]', true], ...others]);
	const truthy = flags.filter(([, value]) => value).length;
	const list = `[${nums.join(', ')}]`;
	return printed(
		[`const marks = [${flags.map(([code]) => code).join(', ')}];`],
		[
			{ code: `${list}.sort().join(' ')`, right: lexical.join(' '), wrong: { 'numeric-sort': ascending.join(' ') } },
			{
				code: 'marks.filter(Boolean).length',
				right: truthy,
				wrong: { 'zero-string-falsy': truthy - 1, 'empty-array-falsy': truthy - 1 }
			},
			{
				code: `${list}.sort((a, b) => b - a).join(' ')`,
				right: descending.join(' '),
				wrong: { 'comparator-direction': ascending.join(' ') }
			}
		]
	);
}

const LABELS = ['price', 'total', 'amount', 'balance', 'weight'] as const;

function toPrimitive(rng: Rng): Program {
	const name = rng.pick(LABELS);
	const label = rng.pick(['cost', 'sum', 'value', 'tag', 'unit']);
	const v = rng.int(10, 90);
	const [k, m] = [rng.int(1, 9), rng.int(2, 9)];
	const [n, p] = [rng.int(2, 9), rng.int(2, 9)];
	const [a, b, c] = [rng.int(1, 9), rng.int(1, 9), rng.int(1, 9)];
	const tmpl = (expr: string): string => `\`\${${expr}}\``;
	const core: Line[] = [
		{ code: `${name} + ${k}`, right: v + k, wrong: { 'plus-uses-tostring': `${label}${k}` } },
		{ code: tmpl(name), right: label, wrong: { 'template-uses-valueof': v } },
		{ code: `${name} + '!'`, right: `${v}!`, wrong: { 'plus-uses-tostring': `${label}!` } },
		{ code: `[${n}] + ${p}`, right: `${n}${p}`, wrong: { 'array-plus-numeric': n + p } },
		{ code: `[${n}] * ${m}`, right: n * m, wrong: { 'array-math-nan': 'NaN' } }
	];
	const extras: Line[] = [
		{ code: '[] + {}', right: '[object Object]' },
		{ code: `[${a}, ${b}] + [${c}]`, right: `${a},${b}${c}` },
		{ code: `String(${name})`, right: label, wrong: { 'template-uses-valueof': v } },
		{ code: `${name} * ${m}`, right: v * m },
		{ code: tmpl(`[${a}, ${b}]`), right: `${a},${b}` }
	];
	return printed(
		[
			`const ${name} = {`,
			'  valueOf() {',
			`    return ${v};`,
			'  },',
			'  toString() {',
			`    return '${label}';`,
			'  },',
			'};'
		],
		rng.shuffle([...core, ...rng.sample(extras, 2)])
	);
}

function nullishOr(rng: Rng): Program {
	const fn = rng.pick(['settings', 'options', 'configure', 'normalize']);
	const title = rng.pick(['none', 'draft', 'main', 'blank']);
	const [dl, dr, dd] = [rng.int(10, 99), rng.int(2, 9), rng.int(100, 900)];
	const [x, r] = [rng.int(10, 90), rng.int(10, 30)];
	const calls: { args: string; right: string; wrong: Record<string, Out> }[] = [
		{
			args: '{ limit: 0, retries: 0, delay: 0 }',
			right: `0/${title}/0/${dd}`,
			wrong: {
				'nullish-like-or': `0/${title}/${dr}/${dd}`,
				'or-like-nullish': `0/${title}/0/0`,
				'default-on-falsy': `${dl}/${title}/0/${dd}`
			}
		},
		{
			args: `{ limit: null, title: '', retries: null, delay: ${x} }`,
			right: `null//${dr}/${x}`,
			wrong: { 'default-on-null': `${dl}//${dr}/${x}`, 'default-on-falsy': `${dl}/${title}/${dr}/${x}` }
		},
		{
			args: `{ title: undefined, retries: ${r}, delay: '' }`,
			right: `${dl}/${title}/${r}/${dd}`,
			wrong: { 'or-like-nullish': `${dl}/${title}/${r}/` }
		}
	];
	return printed(
		[
			`function ${fn}(opts) {`,
			`  const { limit = ${dl}, title = '${title}' } = opts;`,
			`  const retries = opts.retries ?? ${dr};`,
			`  const delay = opts.delay || ${dd};`,
			'  return `${limit}/${title}/${retries}/${delay}`;',
			'}'
		],
		rng.shuffle(calls).map((call) => ({ code: `${fn}(${call.args})`, right: call.right, wrong: call.wrong }))
	);
}

function objectEquality(rng: Rng): Program {
	const n = rng.int(2, 99);
	const core: Line[] = [
		{ code: '[] == false', right: true, wrong: { 'array-truthy-equal': false } },
		{ code: 'null == false', right: false, wrong: { 'null-false': true } },
		rng.bool()
			? { code: `[${n}] === [${n}]`, right: false, wrong: { 'object-by-content': true } }
			: { code: `({ id: ${n} }) == ({ id: ${n} })`, right: false, wrong: { 'object-by-content': true } },
		rng.bool()
			? { code: 'Object.is(NaN, NaN)', right: true, wrong: { 'object-is-like-strict': false } }
			: { code: 'Object.is(0, -0)', right: false, wrong: { 'object-is-like-strict': true } }
	];
	const m = rng.bool() ? n : n + rng.int(1, 9);
	const [a, b] = [rng.int(1, 9), rng.int(1, 9)];
	const spaced = rng.bool();
	const extras: Line[] = [
		{ code: `[${n}] == ${m}`, right: n === m },
		{ code: `[${a}, ${b}] == '${a},${spaced ? ' ' : ''}${b}'`, right: !spaced },
		{ code: "({}) == '[object Object]'", right: true },
		{ code: '[0] == false', right: true, wrong: { 'array-truthy-equal': false } },
		{ code: "' ' == 0", right: true },
		{ code: `[${n}] == '${n}'`, right: true },
		{ code: `[] == ''`, right: true }
	];
	return printed([], rng.shuffle([...core, ...rng.sample(extras, 4)]));
}

const LOWER_WORDS = ['apple', 'banana', 'cherry', 'delta', 'echo', 'figma', 'grape', 'hotel', 'india', 'kilo', 'lemon'];
const UPPER_WORDS = ['Mango', 'Nova', 'Orbit', 'Pixel', 'Quartz', 'Radar', 'Sigma', 'Tango', 'Viper', 'Zebra'];

function sortCompare(rng: Rng): Program {
	const words = rng.shuffle([...rng.sample(LOWER_WORDS, 3), ...rng.sample(UPPER_WORDS, 2)]);
	const byCode = [...words].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
	const byLower = [...words].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
	const small = digits(3, 9, rng, 2);
	const nums = rng.shuffle([...small, rng.int(10, 29), rng.int(100, 299)]).map(String);
	// `undefined` goes to the end of any sort, and join prints it as an empty item.
	const shown = [...nums];
	shown.splice(rng.int(0, nums.length), 0, 'undefined');
	const lexical = `${[...nums].sort().join(',')},`;
	const numeric = `${[...nums].sort((x, y) => Number(x) - Number(y)).join(',')},`;
	// A two-digit string whose first digit is below a one-digit string: the string order and the numeric one differ.
	const one = rng.int(3, 9);
	const two = rng.int(10, one * 10 - 1);
	const one2 = rng.int(3, 9);
	const two2 = rng.int(10, one2 * 10 - 1);
	return printed(
		[`const words = [${words.map((w) => `'${w}'`).join(', ')}];`],
		[
			{
				code: "[...words].sort().join(' ')",
				right: byCode.join(' '),
				wrong: { 'case-insensitive-sort': byLower.join(' ') }
			},
			{ code: `[${shown.join(', ')}].sort().join(',')`, right: lexical, wrong: { 'numeric-sort': numeric } },
			{ code: `'${two}' < '${one}'`, right: true, wrong: { 'string-compare-numeric': false } },
			{ code: `'${two2}' < ${one2}`, right: false, wrong: { 'mixed-compare-string': true } }
		]
	);
}

const INTERN: Record<string, (rng: Rng) => Program> = {
	'plus-strings': plusStrings,
	equality,
	conversions,
	'sort-truthiness': sortTruthiness
};
const JUNIOR: Record<string, (rng: Rng) => Program> = {
	'to-primitive': toPrimitive,
	'nullish-or': nullishOr,
	'object-equality': objectEquality,
	'sort-compare': sortCompare
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = (input.grade === 'intern' ? INTERN : JUNIOR)[input.classId];
	if (!make) throw new Error(`${descriptor.key}@${input.grade} has no generator for ${input.classId}`);
	const program = make(rng);
	const source = program.lines.join('\n');
	const toAnswer = (values: Out[]) => ({ kind: 'sequence' as const, value: values.map(String) });
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
