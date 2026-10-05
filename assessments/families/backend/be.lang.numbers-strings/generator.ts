// Numbers and strings of Python where other languages differ: floor division and modulo with negative operands,
// round half to even, int() of floats and strings, split() against split(' ') and string slices.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Rules {
	truncatingDivision: boolean;
	halfUp: boolean;
	intFloors: boolean;
	splitCollapses: boolean;
	stopInclusive: boolean;
	stripSubstring: boolean;
	countOverlapping: boolean;
}

const RIGHT: Rules = {
	truncatingDivision: false,
	halfUp: false,
	intFloors: false,
	splitCollapses: false,
	stopInclusive: false,
	stripSubstring: false,
	countOverlapping: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'truncating-division': { truncatingDivision: true },
	'half-up': { halfUp: true },
	'int-floors': { intFloors: true },
	'split-collapses': { splitCollapses: true },
	'stop-inclusive': { stopInclusive: true },
	'strip-substring': { stripSubstring: true },
	'count-overlapping': { countOverlapping: true }
};

const REQUIRED: Record<string, string[]> = {
	'intern/floor-mod': ['truncating-division'],
	'intern/round-int': ['half-up', 'int-floors'],
	'intern/split-slice': ['split-collapses', 'stop-inclusive'],
	'intern/str-methods': ['strip-substring', 'count-overlapping']
};

interface Program {
	lines: string[];
	run: (rules: Rules) => string[];
}

/** One printed expression: its Python text and its value under a set of rules. */
interface Expr {
	text: string;
	value: (rules: Rules) => string;
}

function floorDiv(a: number, b: number, rules: Rules): number {
	return rules.truncatingDivision ? Math.trunc(a / b) : Math.floor(a / b);
}

function mod(a: number, b: number, rules: Rules): number {
	const r = a - b * floorDiv(a, b, rules);
	return r === 0 ? 0 : r;
}

function floorMod(rng: Rng): Program {
	const operand = () => rng.int(7, 47);
	const divisor = () => rng.int(3, 9);
	// Each operand pair is drawn so that the division is not exact: floor and truncation differ on negatives.
	const pair = (): [number, number] => {
		for (;;) {
			const a = operand();
			const b = divisor();
			if (a % b !== 0) return [a, b];
		}
	};
	const templates: (() => Expr)[] = [
		() => {
			const [a, b] = pair();
			return { text: `-${a} // ${b}`, value: (r) => String(floorDiv(-a, b, r)) };
		},
		() => {
			const [a, b] = pair();
			return { text: `-${a} % ${b}`, value: (r) => String(mod(-a, b, r)) };
		},
		() => {
			const [a, b] = pair();
			return { text: `${a} % -${b}`, value: (r) => String(mod(a, -b, r)) };
		},
		() => {
			const [a, b] = pair();
			return { text: `${a} // -${b}`, value: (r) => String(floorDiv(a, -b, r)) };
		},
		() => {
			const [a, b] = pair();
			return { text: `int(-${a} / ${b})`, value: () => String(Math.trunc(-a / b)) };
		},
		() => {
			const [a, b] = pair();
			return {
				text: `divmod(-${a}, ${b})`,
				value: (r) => `(${floorDiv(-a, b, r)}, ${mod(-a, b, r)})`
			};
		},
		() => {
			const [a, b] = pair();
			return { text: `${a} // ${b}, ${a} % ${b}`, value: () => `${Math.floor(a / b)} ${a % b}` };
		}
	];
	const exprs = rng.sample(templates, 5).map((make) => make());
	return {
		lines: exprs.map((e) => `print(${e.text})`),
		run: (rules) => exprs.map((e) => e.value(rules))
	};
}

/** round() of a number with one decimal digit, as Python does it for the values the programs use. */
function roundTenths(tenths: number, rules: Rules): number {
	const whole = Math.trunc(tenths / 10);
	const frac = Math.abs(tenths % 10);
	if (frac !== 5) return Math.round(tenths / 10);
	const away = whole + Math.sign(tenths);
	if (rules.halfUp) return away;
	return whole % 2 === 0 ? whole : away;
}

const decimal = (tenths: number) =>
	`${tenths < 0 ? '-' : ''}${Math.floor(Math.abs(tenths) / 10)}.${Math.abs(tenths) % 10}`;

function roundInt(rng: Rng): Program {
	const half = (even: boolean) => {
		const base = rng.int(1, 9) * 2 + (even ? 0 : 1);
		return (base * 10 + 5) * (rng.bool() ? 1 : -1);
	};
	const notHalf = () => {
		const d = rng.pick([1, 2, 3, 4, 6, 7, 8, 9]);
		return (rng.int(1, 19) * 10 + d) * (rng.bool() ? 1 : -1);
	};
	const intOfFloat = (rules: Rules, tenths: number) =>
		rules.intFloors ? Math.floor(tenths / 10) : Math.trunc(tenths / 10);
	const templates: (() => Expr)[] = [
		() => {
			const t = half(true);
			return { text: `round(${decimal(t)})`, value: (r) => String(roundTenths(t, r)) };
		},
		() => {
			const t = half(false);
			return { text: `round(${decimal(t)})`, value: (r) => String(roundTenths(t, r)) };
		},
		() => {
			const t = notHalf();
			return { text: `round(${decimal(t)})`, value: (r) => String(roundTenths(t, r)) };
		},
		() => {
			const t = -Math.abs(notHalf());
			return { text: `int(${decimal(t)})`, value: (r) => String(intOfFloat(r, t)) };
		},
		() => {
			const t = Math.abs(notHalf());
			return { text: `int(${decimal(t)})`, value: (r) => String(intOfFloat(r, t)) };
		},
		() => {
			const n = rng.int(10, 99) * (rng.bool() ? 1 : -1);
			const pad = ' '.repeat(rng.int(1, 2));
			return { text: `int('${pad}${n}${pad}') + 1`, value: () => String(n + 1) };
		},
		() => {
			const [x, y] = [half(true), half(false)];
			return {
				text: `round(${decimal(x)}) + round(${decimal(y)})`,
				value: (r) => String(roundTenths(x, r) + roundTenths(y, r))
			};
		}
	];
	// The first two templates (a half with an even and an odd whole part) and a negative int() always appear.
	const fixed = [templates[0], templates[1], templates[3]] as (() => Expr)[];
	const rest = rng.sample([templates[2], templates[4], templates[5], templates[6]] as (() => Expr)[], 3);
	const exprs = rng.shuffle([...fixed, ...rest]).map((make) => make());
	return {
		lines: exprs.map((e) => `print(${e.text})`),
		run: (rules) => exprs.map((e) => e.value(rules))
	};
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'kappa', 'theta', 'zeta', 'lambda'] as const;

function strSlice(s: string, start: number | null, stop: number | null, step: number, rules: Rules): string {
	const n = s.length;
	const norm = (i: number) => (i < 0 ? n + i : i);
	const out: string[] = [];
	if (step > 0) {
		const from = Math.min(Math.max(start === null ? 0 : norm(start), 0), n);
		let to = Math.min(Math.max(stop === null ? n : norm(stop), 0), n);
		if (rules.stopInclusive && stop !== null) to = Math.min(to + 1, n);
		for (let i = from; i < to; i += step) out.push(s[i] ?? '');
	} else {
		const from = Math.min(Math.max(start === null ? n - 1 : norm(start), -1), n - 1);
		let to = stop === null ? -1 : Math.min(Math.max(norm(stop), -1), n - 1);
		if (rules.stopInclusive && stop !== null) to = Math.max(to - 1, -1);
		for (let i = from; i > to; i += step) out.push(s[i] ?? '');
	}
	return out.join('');
}

function splitSlice(rng: Rng): Program {
	const name = rng.pick(['line', 'text', 'raw', 'header']);
	const words = rng.sample(WORDS, rng.int(3, 4));
	// Separators: at least one run of two or more spaces; leading or trailing spaces sometimes.
	const gaps = words.slice(1).map(() => rng.int(1, 3));
	if (!gaps.some((g) => g > 1)) gaps[rng.int(0, gaps.length - 1)] = 2;
	const lead = ' '.repeat(rng.pick([0, 0, 1, 2]));
	const trail = ' '.repeat(rng.pick([0, 1]));
	const s = lead + words.map((w, i) => (i === 0 ? w : ' '.repeat(gaps[i - 1] ?? 1) + w)).join('') + trail;
	const word = rng.pick(words);
	const k = rng.int(2, 3);
	const sliceForms: { text: string; start: number | null; stop: number | null; step: number }[] = [
		{ text: `[1:-1]`, start: 1, stop: -1, step: 1 },
		{ text: `[-${k}:]`, start: -k, stop: null, step: 1 },
		{ text: `[:${k}]`, start: null, stop: k, step: 1 },
		{ text: `[::-2]`, start: null, stop: null, step: -2 },
		{ text: `[${k}:0:-1]`, start: k, stop: 0, step: -1 }
	];
	const forms = rng.sample(sliceForms, 2);
	const pyList = (items: string[]) => `[${items.map((x) => `'${x}'`).join(', ')}]`;
	return {
		lines: [
			`${name} = '${s}'`,
			`print(${name}.split())`,
			`print(${name}.split(' '))`,
			`print(len(${name}.strip().split(' ')))`,
			`w = '${word}'`,
			`print(${forms.map((f) => `w${f.text}`).join(', ')})`
		],
		run: (rules) => {
			const collapsed = s.split(' ').filter(Boolean);
			const bySpace = rules.splitCollapses ? collapsed : s.split(' ');
			const stripped = rules.splitCollapses ? collapsed : s.trim().split(' ');
			return [
				pyList(collapsed),
				pyList(bySpace),
				String(stripped.length),
				forms.map((f) => strSlice(word, f.start, f.stop, f.step, rules)).join(' ')
			];
		}
	};
}

/** str.strip(chars) as Python does it: every character of the set, from the ends; or the misconception's substring. */
function strip(s: string, chars: string, left: boolean, right: boolean, rules: Rules): string {
	if (rules.stripSubstring) {
		let out = s;
		if (left && out.startsWith(chars)) out = out.slice(chars.length);
		if (right && out.endsWith(chars)) out = out.slice(0, out.length - chars.length);
		return out;
	}
	let from = 0;
	let to = s.length;
	while (left && from < to && chars.includes(s.charAt(from))) from += 1;
	while (right && to > from && chars.includes(s.charAt(to - 1))) to -= 1;
	return s.slice(from, to);
}

function count(text: string, pattern: string, rules: Rules): number {
	let n = 0;
	for (
		let i = text.indexOf(pattern);
		i >= 0;
		i = text.indexOf(pattern, i + (rules.countOverlapping ? 1 : pattern.length))
	)
		n += 1;
	return n;
}

function strMethods(rng: Rng): Program {
	const word = rng.pick(WORDS);
	const symbols = rng.sample(['*', '-', '.', '#', '='], rng.int(2, 3));
	const chars = symbols.join('');
	const pad = (len: number) => Array.from({ length: len }, () => rng.pick(symbols)).join('');
	const padded = pad(rng.int(2, 4)) + word + pad(rng.int(2, 4));
	const [u, v] = rng.sample(['a', 'b', 'x', 'o', 'z'], 2) as [string, string];
	const pattern = u + v + u;
	const text = rng.pick(['', 'q', 'w']) + (u + v).repeat(rng.int(2, 4)) + u + rng.pick(['', 'k', u + v]);
	return {
		lines: [
			`s = '${padded}'`,
			`print(s.strip('${chars}'))`,
			`print(s.rstrip('${chars}'))`,
			`print('${text}'.count('${pattern}'))`
		],
		run: (rules) => [
			strip(padded, chars, true, true, rules),
			strip(padded, chars, false, true, rules),
			String(count(text, pattern, rules))
		]
	};
}

const PROGRAMS: Record<string, (rng: Rng) => Program> = {
	'intern/floor-mod': floorMod,
	'intern/round-int': roundInt,
	'intern/split-slice': splitSlice,
	'intern/str-methods': strMethods
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const slot = `${input.grade}/${input.classId}`;
	const make = PROGRAMS[slot];
	if (!make) throw new Error(`${descriptor.key}: no program for ${slot}`);
	const required = REQUIRED[slot] ?? [];
	const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
	// Programs are drawn until every misconception the class is about changes the output.
	for (let tries = 0; tries < 200; tries += 1) {
		const program = make(rng);
		const answer = program.run(RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = program.run({ ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const source = program.lines.join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: 'Что напечатает программа на Python 3? Введите вывод построчно, как он появится на экране.',
				code: { language: 'python3', source }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source, stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no program for ${slot} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
