// Strings and numbers in JavaScript: slice against substring with negative and swapped arguments, binary floating
// point (a sum of tenths compared with ===, toFixed as the way to compare and as a string), Math.round on negative
// halves, parseInt with a radix, String#at, padStart and split with a limit.
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

/** One printed expression: its output and the outputs the misconceptions predict where they differ from it. */
interface Line {
	code: string;
	right: Out;
	wrong: Readonly<Record<string, Out>>;
}

interface Program {
	lines: string[];
	answer: Out[];
	/** Answers of the wrong solutions that apply to the class; a missing one does not apply. */
	wrong: Record<string, Out[]>;
}

/** A printed line; a misconception that predicts the same output there is dropped from the line. */
function line(code: string, right: Out, wrong: Readonly<Record<string, Out>> = {}): Line {
	return {
		code,
		right,
		wrong: Object.fromEntries(Object.entries(wrong).filter(([, v]) => String(v) !== String(right)))
	};
}

/**
 * The program printing the lines; a misconception applies when some line shows it. `required` misconceptions must
 * show on every instance of the class — the construction guarantees it, and a broken construction is an error.
 */
function printed(prelude: readonly string[], lines: readonly Line[], required: readonly string[]): Program {
	const ids = [...new Set(lines.flatMap((l) => Object.keys(l.wrong)))];
	for (const id of required) if (!ids.includes(id)) throw new Error(`the misconception ${id} does not show`);
	return {
		lines: [...prelude, ...lines.map((l) => `console.log(${l.code});`)],
		answer: lines.map((l) => l.right),
		wrong: Object.fromEntries(ids.map((id) => [id, lines.map((l) => l.wrong[id] ?? l.right)]))
	};
}

/** `[text]`: the shown programs print strings in brackets, so an empty string is a visible line. */
const bracketed = (expr: string): string => `\`[\${${expr}}]\``;
const br = (text: string): string => `[${text}]`;

const WORDS = ['javascript', 'framework', 'component', 'interface', 'prototype', 'rendering', 'selector', 'viewport'];

function sliceSubstring(rng: Rng): Program {
	const word = rng.pick(WORDS);
	const len = word.length;
	const name = rng.pick(['word', 'text', 'title', 'label']);
	const i = rng.int(1, 3);
	const j = rng.int(1, 3);
	const k = rng.int(2, 4);
	const m = rng.int(2, 5);
	const [q, p] = [rng.int(1, 3), rng.int(5, len - 1)];
	const [q2, p2] = [rng.int(0, 2), rng.int(4, len - 2)];
	// The misconceptions as functions of the same calls.
	const inclusive = (from: number, to: number): string => word.slice(from, to + 1);
	const lines = rng.shuffle([
		line(bracketed(`${name}.slice(${i}, -${j})`), br(word.slice(i, len - j)), {
			'end-inclusive': br(inclusive(i, len - j))
		}),
		line(bracketed(`${name}.substring(-${k}, ${m})`), br(word.substring(0, m)), {
			'substring-negative': br(word.slice(-k, m)),
			'end-inclusive': br(inclusive(0, m))
		}),
		line(bracketed(`${name}.substring(${p}, ${q})`), br(word.substring(q, p)), {
			'substring-no-swap': br(''),
			'end-inclusive': br(inclusive(q, p))
		}),
		line(bracketed(`${name}.slice(${p2}, ${q2})`), br(''), { 'slice-swaps': br(word.slice(q2, p2)) }),
		line(bracketed(`${name}.slice(-${k + 1})`), br(word.slice(-(k + 1))))
	]);
	return printed([`const ${name} = '${word}';`], lines, [
		'end-inclusive',
		'substring-negative',
		'substring-no-swap',
		'slice-swaps'
	]);
}

function floatRounding(rng: Rng): Program {
	// A sum of tenths that binary floating point does not hit exactly.
	let [i, j] = [1, 2];
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const [a, b] = [rng.int(1, 29), rng.int(1, 29)];
		if (String(a / 10 + b / 10) !== String((a + b) / 10)) {
			[i, j] = [a, b];
			break;
		}
	}
	const exact = (i + j) / 10;
	const n = rng.int(1, 9);
	const m = rng.int(1, 9);
	const [y, z] = [rng.int(11, 99) / 10, rng.int(1, 9)];
	const tenth = (x: number): string => (x / 10).toString();
	const sum = `${tenth(i)} + ${tenth(j)}`;
	const lines: Line[] = [
		line(`${sum} === ${exact}`, false, { 'exact-decimal': true }),
		line(`(${sum}).toFixed(1) === '${exact.toFixed(1)}'`, true),
		line(`Math.round(-${n}.5)`, -n, { 'round-half-away': -(n + 1) }),
		line(`Math.round(${m}.5)`, m + 1),
		line(`(${y}).toFixed(1) + ${z}`, `${y.toFixed(1)}${z}`, { 'tofixed-number': Math.round((y + z) * 10) / 10 })
	];
	return printed([], rng.shuffle(lines), ['exact-decimal', 'round-half-away', 'tofixed-number']);
}

function parseRadix(rng: Rng): Program {
	const hexValue = rng.int(26, 255);
	const hex = hexValue.toString(16);
	const okOctal = rng.int(1, 7);
	const badDigit = rng.int(8, 9);
	const binary = rng.int(4, 15).toString(2);
	const lines: Line[] = [
		line(`parseInt('${hex}', 16)`, hexValue),
		line(`parseInt('${okOctal}${badDigit}', 8)`, okOctal, { 'invalid-digit-nan': 'NaN' }),
		line(`parseInt('0x${hex}')`, hexValue),
		line(`parseInt('0x${hex}', 10)`, 0, { 'hex-prefix-any-radix': hexValue }),
		line(`parseInt('${binary}2', 2)`, Number.parseInt(binary, 2), { 'invalid-digit-nan': 'NaN' })
	];
	return printed([], rng.shuffle(lines), ['invalid-digit-nan', 'hex-prefix-any-radix']);
}

function stringMethods(rng: Rng): Program {
	const word = rng.pick(WORDS);
	const name = rng.pick(['word', 'text', 'title', 'label']);
	const k = rng.int(1, 4);
	const num = String(rng.int(1, 999));
	const width = rng.int(num.length + 2, 6);
	const code = rng.pick(['A17', 'B205', 'C3', 'D48']);
	const short = rng.int(1, code.length - 1);
	const parts = rng.sample(['red', 'green', 'blue', 'cyan', 'gray', 'pink', 'gold'], rng.int(4, 5));
	const limit = rng.int(2, parts.length - 1);
	const atK = word.at(-k) ?? '';
	const lines: Line[] = [
		line(`${name}.at(-${k})`, atK),
		line(`${name}[-${k}]`, 'undefined', { 'bracket-negative': atK }),
		line(`'${num}'.padStart(${width}, '0')`, num.padStart(width, '0'), {
			'padstart-count': `${'0'.repeat(width)}${num}`
		}),
		line(`'${code}'.padStart(${short}, '*')`, code, { 'padstart-truncates': code.slice(0, short) }),
		line(`'${parts.join(',')}'.split(',', ${limit}).join('|')`, parts.slice(0, limit).join('|'), {
			'split-limit-rest': [...parts.slice(0, limit - 1), parts.slice(limit - 1).join(',')].join('|')
		}),
		line(`${name}.indexOf('${word[2] ?? ''}', 3)`, word.indexOf(word[2] ?? '', 3))
	];
	return printed([`const ${name} = '${word}';`], rng.shuffle(lines), [
		'bracket-negative',
		'padstart-count',
		'padstart-truncates',
		'split-limit-rest'
	]);
}

const INTERN: Record<string, (rng: Rng) => Program> = {
	'slice-substring': sliceSubstring,
	'float-rounding': floatRounding,
	'parse-radix': parseRadix,
	'string-methods': stringMethods
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = INTERN[input.classId];
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
