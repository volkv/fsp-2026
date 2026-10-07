// Null safety in Kotlin: what a loop over nullable values prints through safe calls, the elvis operator, `let`,
// `takeIf`, safe casts and `!!`. The mechanism that decides each line is the essential class; the values, names and
// constants are surface.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { kotlinOutputProbe, kotlinProgram } from '../../_lib/kotlin.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const WORDS = ['room', 'flow', 'view', 'intent', 'bundle', 'state', 'screen', 'adapter', 'fragment', 'layout', 'theme'];
const LIST_NAMES = ['items', 'values', 'inputs', 'titles', 'tags', 'labels'];
const VAR_NAMES = ['s', 'v', 'x', 'text', 'item'];

/** A value of a list of `String?`: `null` or a string literal. */
type Value = string | null;

const literal = (v: Value): string => (v === null ? 'null' : JSON.stringify(v));

interface Program {
	lines: string[];
	answer: string[];
	/** Answers of the wrong solutions that apply to the class; a missing or `null` one does not apply. */
	wrong: Record<string, string[] | null>;
}

/** The fallback of an elvis: never zero, never the length of a word, and a sum with a small constant never zero. */
const fallback = (rng: Rng): number => (rng.bool() ? rng.int(10, 99) : -rng.int(10, 19));

/** Four to five values with at least one `null` and one empty string, in random order. */
function values(rng: Rng, count: number): Value[] {
	const words = rng.sample(WORDS, count - 2);
	return rng.shuffle<Value>([null, '', ...words]);
}

/** A `for` loop over a list literal printing one expression per element. */
function loop(list: string, v: string, type: string, items: readonly string[], body: string[]): string[] {
	return [
		'fun main() {',
		`    val ${list} = listOf<${type}>(${items.join(', ')})`,
		`    for (${v} in ${list}) {`,
		...body.map((line) => `        ${line}`),
		'    }',
		'}'
	];
}

function internProgram(rng: Rng, classId: string): Program {
	const list = rng.pick(LIST_NAMES);
	const v = rng.pick(VAR_NAMES);
	const items = values(rng, rng.int(4, 5));
	const d = fallback(rng);
	const lengthOr = (otherwise: number, emptyIsNull = false): string[] =>
		items.map((s) => String(s === null || (emptyIsNull && s === '') ? otherwise : s.length));
	if (classId === 'elvis') {
		return {
			lines: loop(list, v, 'String?', items.map(literal), [`println(${v}?.length ?: ${d})`]),
			answer: lengthOr(d),
			wrong: { 'empty-is-null': lengthOr(d, true), 'elvis-precedence': null, 'assert-gives-zero': null }
		};
	}
	if (classId === 'elvis-precedence') {
		const k = rng.int(2, 9);
		return {
			lines: loop(list, v, 'String?', items.map(literal), [`println(${v}?.length ?: ${d} + ${k})`]),
			answer: lengthOr(d + k),
			wrong: {
				'empty-is-null': lengthOr(d + k, true),
				'elvis-precedence': items.map((s) => String((s === null ? d : s.length) + k)),
				'assert-gives-zero': null
			}
		};
	}
	if (classId === 'let-elvis') {
		const m = rng.int(2, 5);
		return {
			lines: loop(list, v, 'String?', items.map(literal), [`println(${v}?.let { it.length * ${m} } ?: ${d})`]),
			answer: items.map((s) => String(s === null ? d : s.length * m)),
			wrong: {
				'empty-is-null': items.map((s) => String(s === null || s === '' ? d : s.length * m)),
				'elvis-precedence': null,
				'assert-gives-zero': null
			}
		};
	}
	// not-null-assert: `!!` throws on null; the loop catches it and goes on.
	const marker = rng.pick(['npe', 'oops', 'null!', 'fail']);
	return {
		lines: loop(list, v, 'String?', items.map(literal), [
			'try {',
			`    println(${v}!!.length + ${d})`,
			'} catch (e: NullPointerException) {',
			`    println("${marker}")`,
			'}'
		]),
		answer: items.map((s) => (s === null ? marker : String(s.length + d))),
		wrong: {
			'empty-is-null': items.map((s) => (s === null || s === '' ? marker : String(s.length + d))),
			'elvis-precedence': null,
			'assert-gives-zero': items.map((s) => String((s === null ? 0 : s.length) + d))
		}
	};
}

function juniorProgram(rng: Rng, classId: string): Program {
	const list = rng.pick(LIST_NAMES);
	const v = rng.pick(VAR_NAMES);
	const d = fallback(rng);
	if (classId === 'let-null-result') {
		// The block of `let` returns null for short strings: the elvis takes over although the value is not null.
		const items = values(rng, 5);
		const limit = rng.int(3, 5);
		const m = rng.int(2, 4);
		return {
			lines: loop(list, v, 'String?', items.map(literal), [
				`val r = ${v}?.let { if (it.length > ${limit}) it.length * ${m} else null } ?: ${d}`,
				'println(r)'
			]),
			answer: items.map((s) => String(s !== null && s.length > limit ? s.length * m : d)),
			wrong: {
				'elvis-only-on-receiver': items.map((s) =>
					s === null ? String(d) : s.length > limit ? String(s.length * m) : 'null'
				),
				'take-if-inverted': null,
				'cast-converts': null,
				'to-int-trims': null
			}
		};
	}
	if (classId === 'take-if') {
		const items = values(rng, 5);
		const limit = rng.int(3, 5);
		const unless = rng.bool();
		const fn = unless ? 'takeUnless' : 'takeIf';
		const keep = (s: string, inverted: boolean): boolean => s.length >= limit !== (unless !== inverted);
		const run = (inverted: boolean): string[] =>
			items.map((s) => String(s !== null && keep(s, inverted) ? s.length : d));
		return {
			lines: loop(list, v, 'String?', items.map(literal), [
				`println(${v}?.${fn} { it.length >= ${limit} }?.length ?: ${d})`
			]),
			answer: run(false),
			wrong: {
				'elvis-only-on-receiver': items.map((s) =>
					s === null ? String(d) : keep(s, false) ? String(s.length) : 'null'
				),
				'take-if-inverted': run(true),
				'cast-converts': null,
				'to-int-trims': null
			}
		};
	}
	if (classId === 'safe-cast') {
		// A list of `Any?`: `as? String` gives null for numbers instead of converting them.
		const words = rng.sample(WORDS, 2);
		const numbers = [rng.int(10, 999), rng.int(1000, 99999)];
		const items = rng.shuffle<string | number | null>([null, '', ...words, ...numbers]);
		const m = rng.int(2, 4);
		const render = (x: string | number | null): string => (typeof x === 'number' ? String(x) : literal(x));
		return {
			lines: loop(list, v, 'Any?', items.map(render), [`println((${v} as? String)?.length?.times(${m}) ?: ${d})`]),
			answer: items.map((x) => String(typeof x === 'string' ? x.length * m : d)),
			wrong: {
				'elvis-only-on-receiver': null,
				'take-if-inverted': null,
				'cast-converts': items.map((x) => String(x === null ? d : String(x).length * m)),
				'to-int-trims': null
			}
		};
	}
	// to-int-or-null: parsing fails on spaces and letters and gives null, the elvis takes over.
	const n1 = rng.int(1, 999);
	const n2 = rng.int(1, 99);
	const n3 = rng.int(1, 9);
	const raw: (string | null)[] = rng.shuffle([
		String(n1),
		` ${n2}`,
		`-${n3}`,
		`${rng.pick(['x', 'a', 'n'])}${rng.int(1, 9)}`,
		`00${rng.int(1, 9)}`,
		null
	]);
	const parse = (s: string | null, trims: boolean): number | null => {
		if (s === null) return null;
		const t = trims ? s.trim() : s;
		return /^-?\d+$/.test(t) ? Number.parseInt(t, 10) : null;
	};
	const total = (trims: boolean): string[] => {
		let sum = 0;
		return raw.map((s) => {
			sum += parse(s, trims) ?? d;
			return String(sum);
		});
	};
	return {
		lines: [
			'fun main() {',
			`    val ${list} = listOf<String?>(${raw.map(literal).join(', ')})`,
			'    var total = 0',
			`    for (${v} in ${list}) {`,
			`        total += ${v}?.toIntOrNull() ?: ${d}`,
			'        println(total)',
			'    }',
			'}'
		],
		answer: total(false),
		wrong: {
			'elvis-only-on-receiver': (() => {
				// Elvis only for a null string: an unparsable string adds nothing (null is skipped).
				let sum = 0;
				return raw.map((s) => {
					sum += s === null ? d : (parse(s, false) ?? 0);
					return String(sum);
				});
			})(),
			'take-if-inverted': null,
			'cast-converts': null,
			'to-int-trims': total(true)
		}
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const program = input.grade === 'intern' ? internProgram(rng, input.classId) : juniorProgram(rng, input.classId);
	const source = program.lines.join('\n');
	const run = kotlinProgram(source);
	const toAnswer = (lines: string[]) => ({ kind: 'sequence' as const, value: lines });
	const same = (lines: string[]): boolean => lines.join('\n') === program.answer.join('\n');
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown: 'Что напечатает программа на Kotlin? Введите вывод построчно, как он появится на экране.',
			code: { language: 'kotlin', source }
		},
		answer: toAnswer(program.answer)
	});
	return {
		instance,
		reference: () => kotlinOutputProbe(run),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					// A misconception that gives the right output on this instance does not apply to it.
					const lines = program.wrong[id] ?? null;
					return [id, lines === null || same(lines) ? null : { kind: 'answer' as const, answer: toAnswer(lines) }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
