// Lazy sequences in Kotlin: what a chain of `map`, `filter` and `onEach` with printing steps prints on a sequence and on
// a list, where `take` and `first` stop the computation, what `generateSequence` and `sequence { yield }` compute and
// when, that every terminal operation traverses a sequence again, which intermediate operations need the whole upstream
// (`sorted`) and which stay element by element (`distinct`, `windowed`). The model pulls elements through generators
// exactly as the Kotlin iterators pull them. The mechanism that decides the order of the lines is the essential class;
// values, names and constants are surface.
import {
	instanceRng,
	levelAndClass,
	readDescriptor,
	type Built,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { traceBuilt, type TraceProgram } from '../../_lib/kotlin-items.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

/** How a run treats the chain: as Kotlin does, or as a misconception does. */
type Mode = 'lazy' | 'eager' | 'no-stop' | 'extra-pull';

/** A step of a chain. A named `map`/`filter` calls a printing function of the program; an unnamed one is silent. */
type Stage =
	| { kind: 'map'; name: string | null; expr: (v: string) => string; f: (x: number) => number }
	| { kind: 'filter'; name: string | null; expr: (v: string) => string; p: (x: number) => boolean }
	| { kind: 'onEach'; name: string }
	| { kind: 'take'; n: number }
	| { kind: 'takeWhile'; bound: number }
	| { kind: 'distinct' }
	| { kind: 'sorted'; descending: boolean };

const MAP_NAMES = ['load', 'parse', 'price', 'scale', 'fetch', 'convert'];
const FILTER_NAMES = ['valid', 'keep', 'accept', 'match', 'allow'];
const EACH_NAMES = ['seen', 'log', 'emit', 'show'];
const LIST_NAMES = ['orders', 'ids', 'prices', 'scores', 'sizes', 'counts'];

function mapStage(rng: Rng, name: string | null, collide = false): Stage {
	if (collide) {
		const k = rng.int(3, 5);
		return { kind: 'map', name, expr: (v) => `${v} % ${k}`, f: (x) => x % k };
	}
	if (rng.bool()) {
		const k = rng.int(2, 5);
		return { kind: 'map', name, expr: (v) => `${v} * ${k}`, f: (x) => x * k };
	}
	const k = rng.int(1, 9);
	return { kind: 'map', name, expr: (v) => `${v} + ${k}`, f: (x) => x + k };
}

function filterStage(rng: Rng, name: string | null, values: readonly number[]): Stage {
	const choice = rng.int(0, 2);
	if (choice === 0) return { kind: 'filter', name, expr: (v) => `${v} % 2 == 0`, p: (x) => x % 2 === 0 };
	if (choice === 1) return { kind: 'filter', name, expr: (v) => `${v} % 3 != 0`, p: (x) => x % 3 !== 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const t = sorted[Math.floor(sorted.length / 2)] ?? 10;
	return { kind: 'filter', name, expr: (v) => `${v} > ${t}`, p: (x) => x > t };
}

/** The printing functions of the named steps, declared before `main`. */
function helpers(stages: readonly Stage[]): string[] {
	return stages.flatMap((s) => {
		if ((s.kind !== 'map' && s.kind !== 'filter') || s.name === null) return [];
		const type = s.kind === 'map' ? 'Int' : 'Boolean';
		return [`fun ${s.name}(x: Int): ${type} {`, `    println("${s.name} $x")`, `    return ${s.expr('x')}`, '}', ''];
	});
}

/** The Kotlin text of a step of the chain. */
function stageLine(stage: Stage): string {
	switch (stage.kind) {
		case 'map':
			return stage.name === null ? `.map { ${stage.expr('it')} }` : `.map { ${stage.name}(it) }`;
		case 'filter':
			return stage.name === null ? `.filter { ${stage.expr('it')} }` : `.filter { ${stage.name}(it) }`;
		case 'onEach':
			return `.onEach { println("${stage.name} $it") }`;
		case 'take':
			return `.take(${stage.n})`;
		case 'takeWhile':
			return `.takeWhile { it < ${stage.bound} }`;
		case 'distinct':
			return '.distinct()';
		case 'sorted':
			return stage.descending ? '.sortedDescending()' : '.sorted()';
	}
}

/** A Kotlin list as `toString` prints it. */
const listText = (xs: readonly number[]): string => `[${xs.join(', ')}]`;

/** The pull of one step, as the iterator of the Kotlin sequence pulls. */
function* lazyStage(up: Iterator<number>, stage: Stage, out: string[], mode: Mode): Generator<number> {
	const pull = (): IteratorResult<number> => up.next();
	switch (stage.kind) {
		case 'map':
			for (let r = pull(); !r.done; r = pull()) {
				if (stage.name !== null) out.push(`${stage.name} ${r.value}`);
				yield stage.f(r.value);
			}
			return;
		case 'filter':
			for (let r = pull(); !r.done; r = pull()) {
				if (stage.name !== null) out.push(`${stage.name} ${r.value}`);
				if (stage.p(r.value)) yield r.value;
			}
			return;
		case 'onEach':
			for (let r = pull(); !r.done; r = pull()) {
				out.push(`${stage.name} ${r.value}`);
				yield r.value;
			}
			return;
		case 'take': {
			// `take` asks the upstream no more once it has given n elements; the misconceptions ask on.
			const limit = mode === 'no-stop' ? Infinity : mode === 'extra-pull' ? stage.n + 1 : stage.n;
			let pulled = 0;
			for (let r = pull(); !r.done; r = pull()) {
				pulled += 1;
				if (pulled <= stage.n) yield r.value;
				if (pulled >= limit) return;
			}
			return;
		}
		case 'takeWhile':
			for (let r = pull(); !r.done; r = pull()) {
				if (!(r.value < stage.bound)) return;
				yield r.value;
			}
			return;
		case 'distinct': {
			const seen = new Set<number>();
			for (let r = pull(); !r.done; r = pull()) {
				if (seen.has(r.value)) continue;
				seen.add(r.value);
				yield r.value;
			}
			return;
		}
		case 'sorted': {
			const all: number[] = [];
			for (let r = pull(); !r.done; r = pull()) all.push(r.value);
			all.sort((a, b) => (stage.descending ? b - a : a - b));
			yield* all;
			return;
		}
	}
}

/** The source of a chain: a list, `generateSequence` or a `sequence { }` builder. */
type Source =
	| { kind: 'list'; values: number[] }
	| { kind: 'generate'; seed: number; name: string; expr: string; f: (x: number) => number }
	| { kind: 'builder'; steps: BuilderStep[]; done: string };

interface BuilderStep {
	print: string;
	yields: number[];
}

const GUARD = 60;

function* sourceOf(source: Source, out: string[]): Generator<number> {
	if (source.kind === 'list') {
		yield* source.values;
		return;
	}
	if (source.kind === 'generate') {
		// The seed is the first element; the function runs only when the next element is asked for.
		let x = source.seed;
		yield x;
		for (let i = 0; i < GUARD; i += 1) {
			out.push(`${source.name} ${x}`);
			x = source.f(x);
			yield x;
		}
		throw new Error('generateSequence runs away');
	}
	for (const step of source.steps) {
		out.push(step.print);
		yield* step.yields;
	}
	out.push(source.done);
}

/** A terminal operation. */
type Terminal =
	| { kind: 'toList' }
	| { kind: 'first' }
	| { kind: 'firstWith'; equals: number }
	| { kind: 'firstAbove'; bound: number }
	| { kind: 'count' }
	| { kind: 'sum' }
	| { kind: 'any'; atLeast: number };

function terminalCall(t: Terminal): string {
	switch (t.kind) {
		case 'toList':
			return 'toList()';
		case 'first':
			return 'first()';
		case 'firstWith':
			return `first { it == ${t.equals} }`;
		case 'firstAbove':
			return `first { it > ${t.bound} }`;
		case 'count':
			return 'count()';
		case 'sum':
			return 'sum()';
		case 'any':
			return `any { it >= ${t.atLeast} }`;
	}
}

/** The word a printed result starts with (`toList` prints the list alone). */
function resultWord(t: Terminal): string | null {
	switch (t.kind) {
		case 'toList':
			return null;
		case 'first':
		case 'firstWith':
		case 'firstAbove':
			return 'first';
		default:
			return t.kind;
	}
}

/** The Kotlin statement printing the value of `expr`, the result of a terminal operation. */
function printResult(t: Terminal, expr: string, inline: boolean): string {
	const word = resultWord(t);
	if (word === null) return `println(${expr})`;
	return inline ? `println("${word} \${${expr}}")` : `println("${word} $${expr}")`;
}

const resultText = (t: Terminal, value: string): string => {
	const word = resultWord(t);
	return word === null ? value : `${word} ${value}`;
};

/** Runs a terminal operation over an iterator and gives the printed result. */
function terminate(it: Iterator<number>, t: Terminal, mode: Mode): string {
	const all = (): number[] => {
		const xs: number[] = [];
		for (let r = it.next(); !r.done; r = it.next()) xs.push(r.value);
		return xs;
	};
	switch (t.kind) {
		case 'toList':
			return resultText(t, listText(all()));
		case 'count':
			return resultText(t, String(all().length));
		case 'sum':
			return resultText(t, String(all().reduce((a, b) => a + b, 0)));
		default: {
			const p =
				t.kind === 'first'
					? () => true
					: t.kind === 'firstWith'
						? (x: number) => x === t.equals
						: t.kind === 'firstAbove'
							? (x: number) => x > t.bound
							: (x: number) => x >= t.atLeast;
			let found: number | null = null;
			let extra = mode === 'extra-pull' ? 1 : 0;
			for (let r = it.next(); !r.done; r = it.next()) {
				if (found === null) {
					if (!p(r.value)) continue;
					found = r.value;
					if (mode === 'no-stop' || extra > 0) continue;
					break;
				}
				if (mode === 'no-stop') continue;
				extra -= 1;
				if (extra <= 0) break;
			}
			if (t.kind === 'any') return resultText(t, String(found !== null));
			if (found === null) throw new Error('the chain finds nothing');
			return resultText(t, String(found));
		}
	}
}

/** Applies the steps to a whole list, step by step, as a list (or the eager misconception) does. */
function eagerStages(values: readonly number[], stages: readonly Stage[], out: string[]): number[] {
	let xs = [...values];
	for (const stage of stages) {
		switch (stage.kind) {
			case 'map':
				xs = xs.map((x) => {
					if (stage.name !== null) out.push(`${stage.name} ${x}`);
					return stage.f(x);
				});
				break;
			case 'filter':
				xs = xs.filter((x) => {
					if (stage.name !== null) out.push(`${stage.name} ${x}`);
					return stage.p(x);
				});
				break;
			case 'onEach':
				for (const x of xs) out.push(`${stage.name} ${x}`);
				break;
			case 'take':
				xs = xs.slice(0, stage.n);
				break;
			case 'takeWhile': {
				const stop = xs.findIndex((x) => !(x < stage.bound));
				if (stop !== -1) xs = xs.slice(0, stop);
				break;
			}
			case 'distinct':
				xs = [...new Set(xs)];
				break;
			case 'sorted':
				xs.sort((a, b) => (stage.descending ? b - a : a - b));
				break;
		}
	}
	return xs;
}

/** The eager misconception on `generateSequence`: the elements up to where the chain stops are generated first. */
function generatedPrefix(source: Source & { kind: 'generate' }, stages: readonly Stage[], out: string[]): number[] {
	const limit = stages.find((s) => s.kind === 'take' || s.kind === 'takeWhile');
	const before = limit ? stages.slice(0, stages.indexOf(limit)) : [];
	const through = (x: number): number => before.reduce((v, s) => (s.kind === 'map' ? s.f(v) : v), x);
	const values = [source.seed];
	const more = (): boolean => {
		const last = values[values.length - 1] as number;
		if (limit?.kind === 'take') return values.length < limit.n;
		if (limit?.kind === 'takeWhile') return through(last) < limit.bound;
		throw new Error('a generated source without take or takeWhile');
	};
	while (more()) {
		const last = values[values.length - 1] as number;
		out.push(`${source.name} ${last}`);
		values.push(source.f(last));
		if (values.length > GUARD) throw new Error('generateSequence runs away');
	}
	return values;
}

/** The lines one chain and one terminal operation print, under a mode; `eager` steps run before `marker` is printed. */
function runChain(
	source: Source,
	stages: readonly Stage[],
	terminal: Terminal,
	mode: Mode,
	marker: string | null
): string[] {
	const out: string[] = [];
	if (mode === 'eager') {
		let values: number[];
		if (source.kind === 'list') values = source.values;
		else if (source.kind === 'builder') {
			values = [];
			for (const step of source.steps) {
				out.push(step.print);
				values.push(...step.yields);
			}
			out.push(source.done);
		} else values = generatedPrefix(source, stages, out);
		const xs = eagerStages(values, stages, out);
		if (marker !== null) out.push(marker);
		out.push(terminate(xs[Symbol.iterator](), terminal, 'lazy'));
		return out;
	}
	if (marker !== null) out.push(marker);
	let it: Iterator<number> = sourceOf(source, out);
	for (const stage of stages) it = lazyStage(it, stage, out, mode);
	out.push(terminate(it, terminal, mode));
	return out;
}

function values(rng: Rng, count: number, max = 20): number[] {
	return rng.sample(
		Array.from({ length: max }, (_, i) => i + 1),
		count
	);
}

function names(rng: Rng): { map: string; map2: string; filter: string; each: string } {
	const [map, map2] = rng.sample(MAP_NAMES, 2) as [string, string];
	return { map, map2, filter: rng.pick(FILTER_NAMES), each: rng.pick(EACH_NAMES) };
}

const isSequence = (source: Source): boolean => source.kind !== 'list';

/**
 * A program with one chain: the printing functions, the chain bound to a value, `built` printed after the definition
 * (a list computes there, a sequence does not), the terminal operation and its result.
 */
function chainProgram(
	rng: Rng,
	source: Source,
	headText: string,
	stages: readonly Stage[],
	terminal: Terminal,
	wrongModes: Readonly<Record<string, Mode | null>>
): TraceProgram {
	const list = rng.pick(LIST_NAMES);
	const chain = rng.pick(['chain', 'pipeline', 'query', 'flow']);
	const result = rng.pick(['result', 'picked', 'shown', 'first']);
	const marker = rng.pick(['built', 'ready', 'defined']);
	const asSequence = source.kind === 'list' && headText.endsWith('.asSequence()');
	const lines = [
		...helpers(stages),
		'fun main() {',
		...(source.kind === 'list' ? [`    val ${list} = listOf(${source.values.join(', ')})`] : []),
		`    val ${chain} = ${source.kind === 'list' ? list : ''}${headText}`,
		...stages.map((s) => `        ${stageLine(s)}`),
		`    println("${marker}")`,
		`    val ${result} = ${chain}.${terminalCall(terminal)}`,
		`    ${printResult(terminal, result, false)}`,
		'}'
	];
	const lazy = isSequence(source) || asSequence;
	const run = (mode: Mode): string[] => runChain(source, stages, terminal, mode, marker);
	const wrong: Record<string, string[] | null> = {};
	for (const [id, mode] of Object.entries(wrongModes)) wrong[id] = mode === null ? null : run(mode);
	return { lines, answer: run(lazy ? 'lazy' : 'eager'), wrong };
}

// Junior.

/** A sequence runs element by element, and only when a terminal operation asks. */
function elementwise(rng: Rng): TraceProgram {
	const xs = values(rng, rng.int(4, 5));
	const n = names(rng);
	const map = mapStage(rng, n.map);
	const stages: Stage[] = rng.bool()
		? [
				map,
				filterStage(
					rng,
					n.filter,
					xs.map((x) => (map.kind === 'map' ? map.f(x) : x))
				)
			]
		: [filterStage(rng, n.filter, xs), map];
	if (rng.bool()) stages.push({ kind: 'onEach', name: n.each });
	return chainProgram(
		rng,
		{ kind: 'list', values: xs },
		'.asSequence()',
		stages,
		{ kind: 'toList' },
		{
			'eager-order': 'eager'
		}
	);
}

/** `first`, `first { }` or `take(n)` stops a sequence: later elements are never computed. */
function shortCircuit(rng: Rng): TraceProgram {
	for (;;) {
		const xs = values(rng, 5);
		const n = names(rng);
		const map = mapStage(rng, n.map);
		const mapped = xs.map((x) => (map.kind === 'map' ? map.f(x) : x));
		const stages: Stage[] = [map, filterStage(rng, n.filter, mapped)];
		const pick = rng.int(0, 2);
		let terminal: Terminal;
		if (pick === 0) terminal = { kind: 'first' };
		else if (pick === 1) {
			stages.push({ kind: 'take', n: rng.int(1, 2) });
			terminal = { kind: 'toList' };
		} else {
			stages.splice(1, 1, { kind: 'onEach', name: n.each });
			terminal = { kind: 'firstWith', equals: mapped[rng.int(1, 3)] as number };
		}
		const source: Source = { kind: 'list', values: xs };
		const passed = eagerStages(xs, stages, []);
		if (passed.length === 0) continue;
		if (terminal.kind === 'first' && passed.length < 2) continue;
		if (pick === 1 && eagerStages(xs, stages.slice(0, 2), []).length <= (stages[2] as { n: number }).n) continue;
		const program = chainProgram(rng, source, '.asSequence()', stages, terminal, {
			'eager-order': 'eager',
			'no-short-circuit': 'no-stop',
			'extra-pull': 'extra-pull'
		});
		if (program.answer.join() === program.wrong['no-short-circuit']?.join()) continue;
		return program;
	}
}

/** The same chain on a list: every operation runs over the whole list at once, at the definition. */
function listEager(rng: Rng): TraceProgram {
	for (;;) {
		const xs = values(rng, 4);
		const n = names(rng);
		const map = mapStage(rng, n.map);
		const stages: Stage[] = [
			map,
			filterStage(
				rng,
				n.filter,
				xs.map((x) => (map.kind === 'map' ? map.f(x) : x))
			)
		];
		const terminal: Terminal = rng.bool() ? { kind: 'first' } : { kind: 'toList' };
		if (terminal.kind === 'toList' && rng.bool()) stages.push({ kind: 'take', n: rng.int(1, 2) });
		if (eagerStages(xs, stages, []).length === 0) continue;
		return chainProgram(rng, { kind: 'list', values: xs }, '', stages, terminal, { 'lazy-list': 'lazy' });
	}
}

/** `generateSequence`: the next element is computed only when the chain asks for it. */
function generated(rng: Rng): TraceProgram {
	const n = names(rng);
	const seed = rng.int(1, 5);
	const doubling = rng.bool();
	const step = rng.int(2, 6);
	const f = doubling ? (x: number) => x * 2 : (x: number) => x + step;
	const name = rng.pick(['next', 'step', 'grow']);
	const source: Source = { kind: 'generate', seed, name, expr: doubling ? 'it * 2' : `it + ${step}`, f };
	const map = mapStage(rng, n.map);
	const stages: Stage[] = [map];
	if (rng.bool()) stages.push({ kind: 'take', n: rng.int(2, 4) });
	else {
		let x = seed;
		for (let i = rng.int(2, 4); i > 0; i -= 1) x = f(x);
		stages.push({ kind: 'takeWhile', bound: map.kind === 'map' ? map.f(x) : x });
	}
	return chainProgram(
		rng,
		source,
		`generateSequence(${seed}) { println("${name} $it"); ${source.expr} }`,
		stages,
		{ kind: 'toList' },
		{
			'eager-order': 'eager',
			'extra-pull': stages.some((s) => s.kind === 'take') ? 'extra-pull' : null
		}
	);
}

// Middle.

/** A sequence is a recipe, not a result: every terminal operation runs the chain again (or fails after constrainOnce). */
function reiterate(rng: Rng): TraceProgram {
	for (;;) {
		const xs = values(rng, 4);
		const n = names(rng);
		const map = mapStage(rng, n.map);
		const mapped = xs.map((x) => (map.kind === 'map' ? map.f(x) : x));
		const filter = filterStage(rng, null, mapped);
		const stages: Stage[] = [map, filter];
		const passed = eagerStages(mapped, [filter], []);
		if (passed.length < 2 || passed[0] === mapped[mapped.length - 1]) continue;
		const pool: Terminal[] = [
			{ kind: 'count' },
			{ kind: 'sum' },
			{ kind: 'first' },
			{ kind: 'toList' },
			{ kind: 'any', atLeast: passed[0] as number }
		];
		const terminals = rng.sample(pool, rng.int(2, 3));
		if (!terminals.some((t) => t.kind === 'first' || t.kind === 'any')) continue;
		const once = rng.bool(0.35);
		const name = rng.pick(['visible', 'pending', 'active', 'ready']);
		const list = rng.pick(LIST_NAMES);
		const marker = rng.pick(['used', 'again', 'once']);
		const source: Source = { kind: 'list', values: xs };
		const lines = [
			...helpers(stages),
			'fun main() {',
			`    val ${list} = listOf(${xs.join(', ')})`,
			`    val ${name} = ${list}.asSequence()`,
			...stages.map((s) => `        ${stageLine(s)}`),
			...(once ? ['        .constrainOnce()'] : []),
			...terminals.map((t, i) => {
				const body = printResult(t, `${name}.${terminalCall(t)}`, true);
				return once && i > 0
					? `    try { ${body} } catch (e: IllegalStateException) { println("${marker}") }`
					: `    ${body}`;
			}),
			'}'
		];
		const run = (mode: Mode, cached: boolean): string[] =>
			terminals.flatMap((t, i) => {
				if (once && i > 0 && !cached) return [marker];
				const out = runChain(source, stages, t, mode, null);
				// The cached misconception: the side effects happen once, later operations only read results.
				return cached && i > 0 ? out.slice(-1) : out;
			});
		return {
			lines,
			answer: run('lazy', false),
			wrong: { 'cached-sequence': run('lazy', true), 'no-short-circuit': run('no-stop', false) }
		};
	}
}

/** `sorted` needs the whole upstream before the first element goes on; `distinct` stays element by element. */
function statefulStage(rng: Rng): TraceProgram {
	for (;;) {
		const xs = values(rng, 5, 30);
		const n = names(rng);
		const op = rng.int(0, 2);
		const first = mapStage(rng, n.map, op === 2);
		const mid: Stage = op === 2 ? { kind: 'distinct' } : { kind: 'sorted', descending: op === 1 };
		const stages: Stage[] = [first, mid, mapStage(rng, n.map2)];
		const terminal: Terminal = op !== 2 && rng.bool() ? { kind: 'first' } : { kind: 'toList' };
		if (terminal.kind === 'toList') stages.push({ kind: 'take', n: 2 });
		const firstOut = xs.map((x) => (first.kind === 'map' ? first.f(x) : x));
		const distinct = [...new Set(firstOut)];
		if (op === 2) {
			// distinct must drop a value before the chain stops, so that its laziness shows.
			if (distinct.length < 3 || distinct.length === firstOut.length) continue;
			const stop = firstOut.indexOf(distinct[1] as number);
			const dup = firstOut.findIndex((x, i) => firstOut.indexOf(x) !== i);
			if (dup > stop || stop >= firstOut.length - 1) continue;
		} else if (distinct.length !== firstOut.length) continue;
		const source: Source = { kind: 'list', values: xs };
		const program = chainProgram(rng, source, '.asSequence()', stages, terminal, {
			'eager-order': 'eager',
			'no-short-circuit': 'no-stop'
		});
		if (op === 2) {
			// The barrier misconception: distinct reads the whole upstream first, as sorted does.
			const out: string[] = [program.answer[0] as string];
			const pre: number[] = [];
			for (const x of xs) {
				out.push(`${n.map} ${x}`);
				pre.push(first.kind === 'map' ? first.f(x) : x);
			}
			let it: Iterator<number> = [...new Set(pre)][Symbol.iterator]();
			for (const stage of stages.slice(2)) it = lazyStage(it, stage, out, 'lazy');
			out.push(terminate(it, terminal, 'lazy'));
			program.wrong['distinct-barrier'] = out;
		}
		return program;
	}
}

/** `sequence { yield }`: the builder runs only as far as the consumer asks, and stops at the last element taken. */
function builder(rng: Rng): TraceProgram {
	const n = names(rng);
	const word = rng.pick(['page', 'chunk', 'batch']);
	const vals = values(rng, 6, 40);
	const steps: BuilderStep[] = [
		{ print: `${word} 1`, yields: vals.slice(0, 1) },
		{ print: `${word} 2`, yields: vals.slice(1, 3) },
		{ print: `${word} 3`, yields: vals.slice(3, 4) }
	];
	if (rng.bool()) steps.push({ print: `${word} 4`, yields: vals.slice(4, 6) });
	const done = rng.pick(['done', 'end', 'last']);
	const source: Source = { kind: 'builder', steps, done };
	const total = steps.reduce((k, s) => k + s.yields.length, 0);
	const map = mapStage(rng, n.map);
	const stages: Stage[] = [map];
	const pick = rng.int(0, 2);
	let terminal: Terminal;
	if (pick === 0) {
		stages.push({ kind: 'take', n: rng.int(2, total) });
		terminal = { kind: 'toList' };
	} else if (pick === 1) {
		const mapped = steps.flatMap((s) => s.yields).map((x) => (map.kind === 'map' ? map.f(x) : x));
		terminal = { kind: 'firstWith', equals: mapped[rng.int(1, total - 1)] as number };
	} else terminal = { kind: 'toList' };
	const name = rng.pick(['feed', 'pages', 'inbox', 'stream']);
	const result = rng.pick(['result', 'shown', 'picked']);
	const marker = rng.pick(['start', 'ready', 'open']);
	const lines = [
		...helpers(stages),
		'fun main() {',
		`    val ${name} = sequence {`,
		...steps.flatMap((s) => [
			`        println("${s.print}")`,
			s.yields.length === 1 ? `        yield(${s.yields[0]})` : `        yieldAll(listOf(${s.yields.join(', ')}))`
		]),
		`        println("${done}")`,
		'    }',
		`    println("${marker}")`,
		`    val ${result} = ${name}`,
		...stages.map((s) => `        ${stageLine(s)}`),
		`        .${terminalCall(terminal)}`,
		`    ${printResult(terminal, result, false)}`,
		'}'
	];
	const run = (mode: Mode): string[] => runChain(source, stages, terminal, mode, marker);
	// The eager builder: the whole block runs at the first request, then the elements go on one by one.
	const eagerBuilder = (() => {
		const out = [marker, ...steps.map((s) => s.print), done];
		let it: Iterator<number> = steps.flatMap((s) => s.yields)[Symbol.iterator]();
		for (const stage of stages) it = lazyStage(it, stage, out, 'lazy');
		out.push(terminate(it, terminal, 'lazy'));
		return out;
	})();
	return {
		lines,
		answer: run('lazy'),
		wrong: { 'builder-eager': eagerBuilder, 'no-short-circuit': pick === 2 ? null : run('no-stop') }
	};
}

/** `windowed` on a sequence reads only as many elements as the next window needs. */
function windowed(rng: Rng): TraceProgram {
	for (;;) {
		const xs = values(rng, rng.int(6, 7));
		const size = rng.int(2, 3);
		const step = rng.int(1, size === 2 ? 3 : 2);
		const read = rng.pick(['read', 'sample', 'tick']);
		const fn = rng.pick(['window', 'frame', 'chunk']);
		const windows: number[][] = [];
		for (let i = 0; i + size <= xs.length; i += step) windows.push(xs.slice(i, i + size));
		if (windows.length < 3) continue;
		const sums = windows.map((w) => w.reduce((a, b) => a + b, 0));
		const target = rng.int(1, windows.length - 2);
		const bound = (sums[target] as number) - 1;
		if (sums.slice(0, target).some((s) => s > bound)) continue;
		const marker = rng.pick(['built', 'ready', 'defined']);
		const run = (mode: 'lazy' | 'all-first' | 'no-stop'): string[] => {
			const out: string[] = [marker];
			if (mode === 'all-first') for (const x of xs) out.push(`${read} ${x}`);
			let at = 0;
			let found: number | null = null;
			for (const [i, w] of windows.entries()) {
				// A window is given when its last element is read; with step > size the skipped elements are read too.
				if (mode !== 'all-first') while (at <= i * step + size - 1) out.push(`${read} ${xs[at++]}`);
				out.push(`${fn} ${listText(w)}`);
				if (found === null && (sums[i] as number) > bound) {
					found = sums[i] as number;
					if (mode !== 'no-stop') break;
				}
			}
			if (mode === 'no-stop') while (at < xs.length) out.push(`${read} ${xs[at++]}`);
			out.push(`first ${found}`);
			return out;
		};
		const list = rng.pick(LIST_NAMES);
		const chain = rng.pick(['peaks', 'bursts', 'spikes']);
		const result = rng.pick(['result', 'peak', 'hit']);
		const lines = [
			`fun ${fn}(w: List<Int>): Int {`,
			`    println("${fn} $w")`,
			'    return w.sum()',
			'}',
			'',
			'fun main() {',
			`    val ${list} = listOf(${xs.join(', ')})`,
			`    val ${chain} = ${list}.asSequence()`,
			`        .onEach { println("${read} $it") }`,
			`        .windowed(${size}, ${step})`,
			`        .map { ${fn}(it) }`,
			`    println("${marker}")`,
			`    val ${result} = ${chain}.first { it > ${bound} }`,
			`    println("first $${result}")`,
			'}'
		];
		return {
			lines,
			answer: run('lazy'),
			wrong: { 'windowed-reads-all': run('all-first'), 'no-short-circuit': run('no-stop') }
		};
	}
}

const PROGRAMS: Readonly<Record<string, (rng: Rng) => TraceProgram>> = {
	elementwise,
	'short-circuit': shortCircuit,
	'list-eager': listEager,
	generate: generated,
	reiterate,
	'stateful-stage': statefulStage,
	builder,
	windowed
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const make = PROGRAMS[input.classId];
	if (!make) throw new Error(`no program for ${input.classId}`);
	return traceBuilt(descriptor, input, make(instanceRng(descriptor, input)));
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
