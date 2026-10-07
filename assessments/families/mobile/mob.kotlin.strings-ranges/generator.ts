// Strings, characters and ranges in Kotlin: `..`, `until`, `downTo` and `step`, `in`; `substring`, `take`, `drop`,
// `padStart` and string templates; integer division and remainder with negative numbers, `mod`; character codes against
// `digitToInt`, arithmetic on `Char`, `repeat`. The mechanism that decides the output is the essential class; names
// and values are surface.
import { type Built, type GenerateInput, type ItemInstance, readDescriptor } from '../../_lib/family.ts';
import { ktDiv, ktRem, type TraceProgram, traceBuild } from '../../_lib/mob-kotlin.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const WORDS = ['notifications', 'settings', 'favorites', 'messages', 'downloads', 'bookmarks', 'keyboard', 'calendar'];

const main = (body: string[]): string[] => ['fun main() {', ...body.map((l) => `    ${l}`), '}'];

/** The elements of `from..to step step` (or `downTo` for a negative step); `inclusive` — whether `to` may be reached. */
function progression(from: number, to: number, step: number, inclusive: boolean): number[] {
	const out: number[] = [];
	if (step > 0) for (let i = from; inclusive ? i <= to : i < to; i += step) out.push(i);
	else for (let i = from; inclusive ? i >= to : i > to; i += step) out.push(i);
	return out;
}

/** `..` and `downTo` include the end, `until` excludes it, `step` stops at the last element not past the end. */
function ranges(rng: Rng): TraceProgram {
	const a = rng.int(0, 5);
	const b = a + rng.int(3, 5);
	const s = rng.int(2, 4);
	const c = rng.int(12, 20);
	const d = c - s * rng.int(2, 4);
	const t = rng.int(2, 3);
	const e = rng.int(1, 5);
	const f = e + t * rng.int(2, 4);
	const [pages, tabs] = rng.pick([
		['pages', 'tabs'],
		['rows', 'slots'],
		['days', 'steps']
	]);
	const run = (dotsInclusive: boolean, untilInclusive: boolean): string[] => [
		progression(a, b, 1, dotsInclusive).join(' '),
		progression(a, b, 1, untilInclusive).join(' '),
		progression(c, d, -s, dotsInclusive).join(' '),
		String(progression(e, f, t, dotsInclusive).reduce((x, y) => x + y, 0)),
		String(untilInclusive)
	];
	return {
		lines: main([
			`val ${pages} = ${a}..${b}`,
			`val ${tabs} = ${a} until ${b}`,
			`println(${pages}.joinToString(" "))`,
			`println(${tabs}.joinToString(" "))`,
			`println((${c} downTo ${d} step ${s}).joinToString(" "))`,
			`println((${e}..${f} step ${t}).sum())`,
			`println(${b} in ${tabs})`
		]),
		answer: run(true, false),
		wrong: { 'range-exclusive': run(false, false), 'until-inclusive': run(true, true) }
	};
}

/** `substring(start, end)` excludes `end`; `take`, `drop`, `padStart`; `$name.length` is the name and the text. */
function substringTemplates(rng: Rng): TraceProgram {
	const word = rng.pick(WORDS);
	const i = rng.int(1, 3);
	const j = i + rng.int(2, 4);
	const p = rng.int(2, 4);
	const q = rng.int(word.length - 4, word.length - 2);
	const tail = word.slice(j);
	const w = tail.length + rng.int(2, 4);
	const pad = rng.pick(['*', '.', '0']);
	const name = rng.pick(['title', 'label', 'screen']);
	const run = (substringLength: boolean, templateMember: boolean): string[] => [
		substringLength ? word.slice(i, i + j) : word.slice(i, j),
		`${word.slice(0, p)}|${word.slice(q)}`,
		templateMember ? `${word.length}` : `${word}.length`,
		`${word.length - j} left`,
		pad.repeat(w - tail.length) + tail
	];
	return {
		lines: main([
			`val ${name} = "${word}"`,
			`println(${name}.substring(${i}, ${j}))`,
			`println(${name}.take(${p}) + "|" + ${name}.drop(${q}))`,
			`println("$${name}.length")`,
			`println("\${${name}.length - ${j}} left")`,
			`println(${name}.substring(${j}).padStart(${w}, '${pad}'))`
		]),
		answer: run(false, false),
		wrong: { 'substring-length': run(true, false), 'template-member': run(false, true) }
	};
}

/** `Int` division truncates toward zero, `%` takes the sign of the dividend, `mod` the sign of the divisor. */
function divMod(rng: Rng): TraceProgram {
	const b = rng.int(3, 7);
	const a = -(b * rng.int(2, 6) + rng.int(1, b - 1));
	const d = -rng.int(3, 7);
	const c = -d * rng.int(2, 6) + rng.int(1, -d - 1);
	const floorDiv = (x: number, y: number): number => Math.floor(x / y);
	const floorMod = (x: number, y: number): number => x - floorDiv(x, y) * y;
	const run = (floor: boolean, modIsRem: boolean): string[] => [
		String(floor ? floorDiv(a, b) : ktDiv(a, b)),
		String(floor ? floorMod(a, b) : ktRem(a, b)),
		String(modIsRem && !floor ? ktRem(a, b) : floorMod(a, b)),
		String(floor ? floorDiv(c, d) : ktDiv(c, d)),
		String(floor ? floorMod(c, d) : ktRem(c, d))
	];
	const [x, y] = rng.pick([
		['offset', 'page'],
		['delta', 'size'],
		['shift', 'width']
	]);
	return {
		lines: main([
			`val ${x} = ${a}`,
			`val ${y} = ${b}`,
			`println(${x} / ${y})`,
			`println(${x} % ${y})`,
			`println(${x}.mod(${y}))`,
			`println(${c} / ${d})`,
			`println(${c} % ${d})`
		]),
		answer: run(false, false),
		wrong: { 'floor-division': run(true, false), 'mod-equals-rem': run(false, true) }
	};
}

/** `Char.code` is the character code, `digitToInt` the digit; `Char + Int` is a `Char`, `Char - Char` an `Int`. */
function chars(rng: Rng): TraceProgram {
	const letter = rng.pick(['q', 'v', 'x', 'k', 'p']);
	const digit = rng.int(1, 9);
	const k = rng.int(2, 9);
	const base = rng.pick(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
	const n = rng.int(1, 6);
	const [hi, lo] = rng.pick([
		['m', 'f'],
		['t', 'k'],
		['z', 'r'],
		['j', 'c']
	]);
	const r = rng.int(3, 5);
	const shifted = String.fromCharCode(base.charCodeAt(0) + n);
	const run = (codeIsDigit: boolean, charIsInt: boolean, fromOne: boolean): string[] => [
		String(codeIsDigit ? digit : 48 + digit),
		String(digit * k),
		charIsInt ? String(base.charCodeAt(0) + n) : shifted,
		String(hi.charCodeAt(0) - lo.charCodeAt(0)),
		Array.from({ length: r }, (_, i) => String(fromOne ? i + 1 : i)).join('')
	];
	return {
		lines: main([
			`val tag = "${letter}${digit}"`,
			'val d = tag[1]',
			'println(d.code)',
			`println(d.digitToInt() * ${k})`,
			`println('${base}' + ${n})`,
			`println('${hi}' - '${lo}')`,
			'var ids = ""',
			`repeat(${r}) { ids += it }`,
			'println(ids)'
		]),
		answer: run(false, false, false),
		wrong: {
			'code-is-digit': run(true, false, false),
			'char-arith-int': run(false, true, false),
			'repeat-from-one': run(false, false, true)
		}
	};
}

function program(rng: Rng, _grade: string, classId: string): TraceProgram {
	if (classId === 'ranges') return ranges(rng);
	if (classId === 'substring-templates') return substringTemplates(rng);
	if (classId === 'div-mod') return divMod(rng);
	return chars(rng);
}

export function build(input: GenerateInput): Built {
	return traceBuild(descriptor, input, program);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
