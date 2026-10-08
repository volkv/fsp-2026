// Kotlin flows: a cold `flow` runs its builder anew for every `collect`, and every element passes the whole chain of
// operators before the next one is produced. Junior: collecting twice, the order of prints from `onEach`, `map`,
// `filter` and `collect`, `take` stopping the builder (its `finally` and `onCompletion` run), `transform` and
// `flatMapConcat`. Middle: `catch` and `onCompletion` with an exception, `zip` and `combine` (with delays that keep the
// order deterministic), `buffer` running the producer next to a slow collector (a bounded buffer makes the send wait),
// `take` inside `flatMapConcat`.
// Sequential chains are run by a model of the operators below; the timed classes (`buffer`, `combine`) by a timeline
// of their emissions whose moments differ by at least 100 ms.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type GenerateInput,
	type ItemInstance,
	readDescriptor
} from '../../_lib/family.ts';
import { kotlinOutputProbe, kotlinProgram } from '../../_lib/kotlin.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const SOURCES = ['orders', 'prices', 'events', 'messages', 'scores', 'clicks', 'pages', 'items'];
const MAIN = ['screen open', 'ui ready', 'render', 'layout', 'header', 'footer', 'menu'];

type Arith = { op: '*' | '+'; k: number };
type Pred = { kind: 'even' | 'odd' | 'gt'; k: number };

type FOp =
	| { k: 'map'; f: Arith; print: string | null }
	| { k: 'filter'; p: Pred; print: string | null }
	| { k: 'onEach'; print: string }
	| { k: 'take'; n: number }
	/** `transform { if (p(it)) emit(it); emit(f(it)) }`. */
	| { k: 'transform'; p: Pred; f: Arith }
	/** `flatMapConcat { v -> flow { [println("open $v")]; try { emit(v); emit(f(v)) } finally { println("close $v") } } }`. */
	| { k: 'flat'; open: string | null; f: Arith; close: string | null }
	/** `map { if (it == at) error("bad $it") else f(it) }`. */
	| { k: 'mapThrow'; at: number; f: Arith }
	/** `catch { println("print ${it.message}"); emit(fallback) }`. */
	| { k: 'catch'; print: string; fallback: number | null }
	/** `onCompletion { println(if (it == null) "ok" else "failed") }`. */
	| { k: 'done'; ok: string; failed: string };

/** `flow { [println(start)]; [try {] for (v in listOf(...)) { [println("emit $v")]; emit(v) } [} finally { println(closed) }] }`. */
interface Source {
	name: string;
	values: number[];
	start: string | null;
	emit: string | null;
	closed: string | null;
}

interface Pipeline {
	ops: FOp[];
	label: string;
	/** The collector throws `error("bad $it")` on this value. */
	throwAt: number | null;
}

type Line = { say: string } | { run: Pipeline; guarded: boolean };

interface FlowProgram {
	source: Source;
	lines: Line[];
}

/** Wrong beliefs about flows. */
interface Beliefs {
	/** Operators work like collection functions: each stage over all elements before the next. */
	stageByStage?: boolean;
	/** The builder runs once; a second `collect` gets the values without running it. */
	hotFlow?: boolean;
	/** The builder runs where the flow is declared, before anything collects it. */
	eagerBuilder?: boolean;
	/** `take` lets the builder run to its end and only drops the rest. */
	takeRunsAll?: boolean;
	/** The `finally` of a builder stopped by `take` does not run. */
	takeNoFinally?: boolean;
	/** `take(n)` stops only when element n + 1 arrives. */
	takeWaitsNext?: boolean;
	/** `catch` also catches what the collector throws. */
	catchDownstream?: boolean;
	/** An exception only skips its element: `catch` handles it and the flow goes on. */
	errorSkipsElement?: boolean;
	/** `onCompletion` runs only when the flow completes without an exception. */
	completionOnlyOnSuccess?: boolean;
	/** `take` after `flatMapConcat` counts the outer elements. */
	takeCountsOuter?: boolean;
}

class NotApplicable extends Error {}

class FlowError extends Error {}

class Abort extends Error {
	readonly owner: object;
	constructor(owner: object) {
		super('abort');
		this.owner = owner;
	}
}

const arith = (f: Arith, v: number): number => (f.op === '*' ? v * f.k : v + f.k);
const test = (p: Pred, v: number): boolean =>
	p.kind === 'even' ? v % 2 === 0 : p.kind === 'odd' ? v % 2 !== 0 : v > p.k;
const arithKt = (f: Arith, x: string): string => `${x} ${f.op} ${f.k}`;
const predKt = (p: Pred, x: string): string =>
	p.kind === 'even' ? `${x} % 2 == 0` : p.kind === 'odd' ? `${x} % 2 != 0` : `${x} > ${p.k}`;

type Sink = (v: number) => void;

/** Runs one collection of a pipeline on the model of the operators. */
class FlowRun {
	readonly out: string[];
	readonly b: Beliefs;
	readonly sourcePrints: boolean;
	catchHandler: ((error: FlowError) => void) | null = null;

	constructor(out: string[], b: Beliefs, sourcePrints: boolean) {
		this.out = out;
		this.b = b;
		this.sourcePrints = sourcePrints;
	}

	source(src: Source, sink: Sink): void {
		if (src.start && this.sourcePrints) this.out.push(src.start);
		let aborted = false;
		try {
			for (const v of src.values) {
				if (src.emit && this.sourcePrints) this.out.push(`${src.emit} ${v}`);
				sink(v);
			}
		} catch (error) {
			aborted = error instanceof Abort;
			throw error;
		} finally {
			if (src.closed && this.sourcePrints && !(aborted && this.b.takeNoFinally)) this.out.push(src.closed);
		}
	}

	chain(src: Source, ops: readonly FOp[], sink: Sink): void {
		if (ops.length === 0) {
			this.source(src, sink);
			return;
		}
		const op = ops[ops.length - 1] as FOp;
		const up = (s: Sink): void => {
			this.chain(src, ops.slice(0, -1), s);
		};
		this.apply(op, up, sink);
	}

	apply(op: FOp, up: (s: Sink) => void, down: Sink): void {
		const out = this.out;
		switch (op.k) {
			case 'map':
				up((v) => {
					if (op.print) out.push(`${op.print} ${v}`);
					down(arith(op.f, v));
				});
				return;
			case 'mapThrow':
				up((v) => {
					if (v === op.at) {
						const error = new FlowError(`bad ${v}`);
						if (this.b.errorSkipsElement && this.catchHandler) {
							this.catchHandler(error);
							return;
						}
						throw error;
					}
					down(arith(op.f, v));
				});
				return;
			case 'filter':
				up((v) => {
					if (op.print) out.push(`${op.print} ${v}`);
					if (test(op.p, v)) down(v);
				});
				return;
			case 'onEach':
				up((v) => {
					out.push(`${op.print} ${v}`);
					down(v);
				});
				return;
			case 'take': {
				const owner = {};
				let count = 0;
				try {
					up((v) => {
						count += 1;
						if (this.b.takeRunsAll) {
							if (count <= op.n) down(v);
							return;
						}
						if (this.b.takeWaitsNext) {
							if (count > op.n) throw new Abort(owner);
							down(v);
							return;
						}
						down(v);
						if (count >= op.n) throw new Abort(owner);
					});
				} catch (error) {
					if (error instanceof Abort && error.owner === owner) return;
					throw error;
				}
				return;
			}
			case 'transform':
				up((v) => {
					if (test(op.p, v)) down(v);
					down(arith(op.f, v));
				});
				return;
			case 'flat':
				up((v) => {
					if (op.open) out.push(`${op.open} ${v}`);
					try {
						down(v);
						down(arith(op.f, v));
					} finally {
						if (op.close) out.push(`${op.close} ${v}`);
					}
				});
				return;
			case 'catch': {
				const fromDown = new Set<unknown>();
				const handle = (error: FlowError): void => {
					out.push(`${op.print} ${error.message}`);
					if (op.fallback !== null) down(op.fallback);
				};
				const saved = this.catchHandler;
				this.catchHandler = handle;
				try {
					up((v) => {
						try {
							down(v);
						} catch (error) {
							fromDown.add(error);
							throw error;
						}
					});
				} catch (error) {
					if (error instanceof FlowError && (!fromDown.has(error) || this.b.catchDownstream)) {
						this.catchHandler = saved;
						handle(error);
						return;
					}
					throw error;
				} finally {
					this.catchHandler = saved;
				}
				return;
			}
			case 'done':
				try {
					up(down);
				} catch (error) {
					// Any exception is the cause, the abort of a `take` further down included.
					if (!this.b.completionOnlyOnSuccess) out.push(op.failed);
					throw error;
				}
				out.push(op.ok);
				return;
		}
	}
}

/** Operators as collection functions over the whole list, stage by stage (a wrong belief). */
function stageByStage(src: Source, ops: readonly FOp[], p: Pipeline, out: string[], sourcePrints: boolean): void {
	if (src.closed && sourcePrints) throw new NotApplicable('a builder with finally');
	if (src.start && sourcePrints) out.push(src.start);
	let values = [...src.values];
	if (src.emit && sourcePrints) for (const v of values) out.push(`${src.emit} ${v}`);
	for (const op of ops) {
		if (op.k === 'map') {
			if (op.print) for (const v of values) out.push(`${op.print} ${v}`);
			values = values.map((v) => arith(op.f, v));
		} else if (op.k === 'filter') {
			if (op.print) for (const v of values) out.push(`${op.print} ${v}`);
			values = values.filter((v) => test(op.p, v));
		} else if (op.k === 'onEach') for (const v of values) out.push(`${op.print} ${v}`);
		else if (op.k === 'take') values = values.slice(0, op.n);
		else if (op.k === 'transform') values = values.flatMap((v) => [...(test(op.p, v) ? [v] : []), arith(op.f, v)]);
		else if (op.k === 'flat') {
			if (op.close) throw new NotApplicable('an inner flow with finally');
			if (op.open) for (const v of values) out.push(`${op.open} ${v}`);
			values = values.flatMap((v) => [v, arith(op.f, v)]);
		} else throw new NotApplicable(`stage by stage ${op.k}`);
	}
	if (p.throwAt !== null) throw new NotApplicable('a throwing collector');
	for (const v of values) out.push(`${p.label} ${v}`);
}

/** The output of a sequential flow program under the given beliefs. */
function runFlowProgram(program: FlowProgram, b: Beliefs): string[] {
	const out: string[] = [];
	const { source } = program;
	let collected = 0;
	const eager = b.eagerBuilder === true;
	if (eager) {
		if (source.closed) throw new NotApplicable('an eager builder with finally');
		if (source.start) out.push(source.start);
		if (source.emit) for (const v of source.values) out.push(`${source.emit} ${v}`);
	}
	for (const line of program.lines) {
		if ('say' in line) {
			out.push(line.say);
			continue;
		}
		const p = line.run;
		const sourcePrints = !eager && !(b.hotFlow && collected > 0);
		collected += 1;
		let ops = p.ops;
		if (b.takeCountsOuter) {
			const flat = ops.findIndex((o) => o.k === 'flat');
			const take = ops.findIndex((o) => o.k === 'take');
			if (flat < 0 || take < flat) throw new NotApplicable('no take after flatMapConcat');
			ops = [...ops.slice(0, flat), ops[take] as FOp, ...ops.slice(flat, take), ...ops.slice(take + 1)];
		}
		try {
			if (b.stageByStage) stageByStage(source, ops, p, out, sourcePrints);
			else {
				const run = new FlowRun(out, b, sourcePrints);
				run.chain(source, ops, (v) => {
					if (p.throwAt === v) throw new FlowError(`bad ${v}`);
					out.push(`${p.label} ${v}`);
				});
			}
		} catch (error) {
			if (error instanceof FlowError && line.guarded) {
				out.push(`error ${error.message}`);
				continue;
			}
			throw error;
		}
	}
	return out;
}

// Rendering.

const IND = '    ';

function renderSource(src: Source): string[] {
	if (!src.start && !src.emit && !src.closed) return [`${IND}val ${src.name} = flowOf(${src.values.join(', ')})`];
	const loop = [
		`for (v in listOf(${src.values.join(', ')})) {`,
		...(src.emit ? [`${IND}println("${src.emit} $v")`] : []),
		`${IND}emit(v)`,
		'}'
	];
	const body = src.closed
		? ['try {', ...loop.map((l) => IND + l), '} finally {', `${IND}println("${src.closed}")`, '}']
		: loop;
	return [
		`${IND}val ${src.name} = flow {`,
		...(src.start ? [`${IND}${IND}println("${src.start}")`] : []),
		...body.map((l) => IND + IND + l),
		`${IND}}`
	];
}

function renderOp(op: FOp): string {
	switch (op.k) {
		case 'map':
			return op.print
				? `.map { println("${op.print} $it"); ${arithKt(op.f, 'it')} }`
				: `.map { ${arithKt(op.f, 'it')} }`;
		case 'mapThrow':
			return `.map { if (it == ${op.at}) error("bad $it") else ${arithKt(op.f, 'it')} }`;
		case 'filter':
			return op.print
				? `.filter { println("${op.print} $it"); ${predKt(op.p, 'it')} }`
				: `.filter { ${predKt(op.p, 'it')} }`;
		case 'onEach':
			return `.onEach { println("${op.print} $it") }`;
		case 'take':
			return `.take(${op.n})`;
		case 'transform':
			return `.transform { if (${predKt(op.p, 'it')}) emit(it); emit(${arithKt(op.f, 'it')}) }`;
		case 'flat': {
			const open = op.open ? `println("${op.open} $v"); ` : '';
			const emits = `emit(v); emit(${arithKt(op.f, 'v')})`;
			const body = op.close ? `try { ${emits} } finally { println("${op.close} $v") }` : emits;
			return `.flatMapConcat { v -> flow { ${open}${body} } }`;
		}
		case 'catch':
			return `.catch { println("${op.print} \${it.message}")${op.fallback === null ? '' : `; emit(${op.fallback})`} }`;
		case 'done':
			return `.onCompletion { println(if (it == null) "${op.ok}" else "${op.failed}") }`;
	}
}

function renderPipeline(src: string, p: Pipeline, indent: string): string[] {
	const collect =
		p.throwAt === null
			? `.collect { println("${p.label} $it") }`
			: `.collect { if (it == ${p.throwAt}) error("bad $it"); println("${p.label} $it") }`;
	if (p.ops.length === 0) return [`${indent}${src}${collect}`];
	return [`${indent}${src}`, ...[...p.ops.map(renderOp), collect].map((l) => indent + IND + l)];
}

function renderFlowProgram(program: FlowProgram): string {
	const lines = ['import kotlinx.coroutines.*', 'import kotlinx.coroutines.flow.*', '', 'fun main() = runBlocking {'];
	lines.push(...renderSource(program.source));
	for (const line of program.lines) {
		if ('say' in line) lines.push(`${IND}println("${line.say}")`);
		else if (line.guarded)
			lines.push(
				`${IND}try {`,
				...renderPipeline(program.source.name, line.run, IND + IND),
				`${IND}} catch (e: IllegalStateException) {`,
				`${IND}${IND}println("error \${e.message}")`,
				`${IND}}`
			);
		else lines.push(...renderPipeline(program.source.name, line.run, IND));
	}
	lines.push('}');
	return lines.join('\n');
}

// Timed flows.

/**
 * Distinct moments of the producer and the collector of a `buffer` program differ by at least this much (the bank's
 * rule); lines of one coroutine keep the order of its code whatever their moments.
 */
const MIN_GAP = 100;
/** Moments of the two flows of `combine` keep a wider gap: the order survives a loaded machine. */
const COMBINE_GAP = 200;

/** One printed line at a moment of the model; `order` is the order of the code that prints it. */
interface Event {
	at: number;
	order: number;
	text: string;
	/** The coroutine that prints it: lines of one coroutine at one moment keep the order of its code. */
	actor: 'producer' | 'collector';
	/** The element the line is about. */
	element: number;
}

/**
 * The lines in order of their moments. Two lines may share a moment only within one coroutine or as an element's
 * emission followed by its receipt; moments of different coroutines closer than the minimal gap make the draw unusable.
 */
function timeline(events: readonly Event[]): string[] | null {
	const sorted = [...events].sort((a, b) => a.at - b.at || a.order - b.order);
	for (let i = 0; i < sorted.length; i += 1) {
		for (let j = i + 1; j < sorted.length; j += 1) {
			const a = sorted[i] as Event;
			const b = sorted[j] as Event;
			const gap = b.at - a.at;
			if (a.actor !== b.actor && gap > 0 && gap < MIN_GAP) return null;
			const causal = a.actor === b.actor || (a.actor === 'producer' && a.element === b.element);
			if (gap === 0 && !causal) return null;
		}
	}
	return sorted.map((e) => e.text);
}

interface TimedProgram {
	source: string;
	answer: string[];
	wrong: Record<string, string[] | null>;
}

const ENVIRONMENT =
	'Что напечатает программа на Kotlin 2.4 (JVM 21, kotlinx.coroutines; `runBlocking` на одном потоке)?';
const ENTER = 'Введите вывод построчно, как он появится на экране.';

const HEAD = ['import kotlinx.coroutines.*', 'import kotlinx.coroutines.flow.*', '', 'fun main() = runBlocking {'];

/** The longest `buffer` run (ms): the draw keeps the program short. */
const BUFFER_RUN = 2400;

/**
 * The moments of a `buffer(capacity)` program: the producer prints `emit` after its delay and then sends; the send
 * suspends while the buffer holds `capacity` elements the collector has not taken, and the next delay starts when the
 * send returns. The collector takes an element when it is sent (or waiting to be sent) and the collector is free.
 * `null` — the run is longer than `BUFFER_RUN` or its moments are too close to read (`timeline`). The timing depends
 * only on the count, the two delays and the capacity, not on the values and labels.
 */
function bufferTimeline(
	values: readonly number[],
	timing: { produce: number; consume: number; capacity: number },
	text: { got: string; saved: string; done: string }
): string[] | null {
	const { produce, consume, capacity } = timing;
	const events: Event[] = [];
	const taken: number[] = [];
	let start = 0;
	let free = 0;
	values.forEach((v, i) => {
		const emitted = start + produce;
		events.push({ at: emitted, order: 0, text: `emit ${v}`, actor: 'producer', element: i });
		const at = Math.max(emitted, free);
		taken.push(at);
		events.push({ at, order: 0, text: `${text.got} ${v}`, actor: 'collector', element: i });
		free = at + consume;
		events.push({ at: free, order: 0, text: `${text.saved} ${v}`, actor: 'collector', element: i });
		// The send returns once the element `capacity` places back has been taken.
		start = Math.max(emitted, i - capacity >= 0 ? (taken[i - capacity] as number) : 0);
	});
	events.push({ at: free, order: 0, text: text.done, actor: 'collector', element: values.length });
	if (free > BUFFER_RUN) return null;
	// Code order: element by element, the emission before its receipt.
	let order = 0;
	for (const e of [...events].sort((a, b) => a.element - b.element || (a.actor === 'producer' ? -1 : 1)))
		e.order = order++;
	return timeline(events);
}

/**
 * `buffer()` holds every element of these programs; with `buffer(1)` and `buffer(0)` (a rendezvous) the send waits for
 * the collector to take an element.
 */
const UNBOUNDED = 64;

/**
 * The counts, delays (ms) and capacities of `buffer` programs whose timeline is readable and differs from the run
 * without a buffer; a bounded capacity only where it changes the timeline of `buffer()`.
 */
const BUFFER_TIMINGS: readonly { count: number; produce: number; consume: number; capacity: number }[] = [
	2, 3, 4
].flatMap((count) =>
	[100, 200, 300, 400, 500, 600].flatMap((produce) =>
		[100, 200, 300, 400, 500, 600, 700, 800].flatMap((consume) =>
			[UNBOUNDED, 1, 0]
				.map((capacity) => ({ count, produce, consume, capacity }))
				.filter((t) => {
					const values = Array.from({ length: t.count }, (_, i) => i + 1);
					const labels = { got: 'got', saved: 'saved', done: 'done' };
					const lines = bufferTimeline(values, t, labels);
					if (lines === null) return false;
					const sequential = [...values.flatMap((v) => [`emit ${v}`, `got ${v}`, `saved ${v}`]), 'done'];
					if (lines.join('\n') === sequential.join('\n')) return false;
					if (t.capacity === UNBOUNDED) return true;
					return lines.join('\n') !== bufferTimeline(values, { ...t, capacity: UNBOUNDED }, labels)?.join('\n');
				})
		)
	)
);

/** Middle anchor: `buffer` runs the producer in its own coroutine next to a slow collector. */
function bufferProgram(rng: Rng): TimedProgram | null {
	const name = rng.pick(SOURCES);
	const [got, saved] = rng.pick<[string, string]>([
		['got', 'saved'],
		['show', 'shown'],
		['take', 'stored']
	]);
	// A third of the programs bound the buffer; the count is drawn before the delays, so long runs are not rare.
	const bounded = rng.bool(1 / 3);
	const pool = BUFFER_TIMINGS.filter((t) => (t.capacity !== UNBOUNDED) === bounded);
	const count = rng.pick([...new Set(pool.map((t) => t.count))]);
	const timing = rng.pick(pool.filter((t) => t.count === count));
	const values = rng.sample([1, 2, 3, 4, 5, 6, 7, 8, 9], timing.count);
	const done = rng.pick(MAIN);
	const answer = bufferTimeline(values, timing, { got, saved, done });
	if (answer === null) return null;
	const sequential = [...values.flatMap((v) => [`emit ${v}`, `${got} ${v}`, `${saved} ${v}`]), done];
	const allFirst = [
		...values.map((v) => `emit ${v}`),
		...values.flatMap((v) => [`${got} ${v}`, `${saved} ${v}`]),
		done
	];
	const source = [
		...HEAD,
		`${IND}val ${name} = flow {`,
		`${IND}${IND}for (v in listOf(${values.join(', ')})) {`,
		`${IND}${IND}${IND}delay(${timing.produce})`,
		`${IND}${IND}${IND}println("emit $v")`,
		`${IND}${IND}${IND}emit(v)`,
		`${IND}${IND}}`,
		`${IND}}`,
		`${IND}${name}.buffer(${timing.capacity === UNBOUNDED ? '' : timing.capacity}).collect {`,
		`${IND}${IND}println("${got} $it")`,
		`${IND}${IND}delay(${timing.consume})`,
		`${IND}${IND}println("${saved} $it")`,
		`${IND}}`,
		`${IND}println("${done}")`,
		'}'
	].join('\n');
	return { source, answer, wrong: { 'buffer-ignored': sequential, 'buffer-collects-all': allFirst } };
}

/** Middle B: `zip` pairs elements by index and ends with the shorter flow; `combine` pairs the latest values. */
function zipCombineProgram(rng: Rng): TimedProgram | null {
	const [left, right, first, second] = rng.sample(
		['codes', 'prices', 'counts', 'levels', 'tags', 'names', 'sizes'],
		4
	) as [string, string, string, string];
	const [zipped, done] = rng.sample(MAIN, 2) as [string, string];
	// zip without delays.
	const lc = rng.int(2, 4);
	const rc = lc === 2 ? 3 : rng.pick([lc - 1, lc + 1]);
	const zl = rng.sample([1, 2, 3, 4, 5, 6, 7, 8, 9], lc);
	const zr = rng.sample(['a', 'b', 'c', 'd', 'e', 'x', 'y', 'z'], rc);
	const n = Math.min(lc, rc);
	const zipAnswer = Array.from({ length: n }, (_, i) => `${zl[i]}${zr[i]}`);
	const zipPads = Array.from(
		{ length: Math.max(lc, rc) },
		(_, i) => `${zl[Math.min(i, lc - 1)]}${zr[Math.min(i, rc - 1)]}`
	);
	// combine with delays: every new value of either flow pairs with the latest of the other.
	const cl = rng.sample([1, 2, 3, 4, 5, 6, 7, 8, 9], rng.int(2, 3));
	const cr = rng.sample(['a', 'b', 'c', 'd', 'e', 'x', 'y', 'z'], 2);
	// Moments by construction: a random merge of the two flows, 100 ms between moments of one flow and at least
	// the gap of combine between moments of different flows, the spare time of the second spread at random.
	const sides = rng.shuffle([...cl.map(() => 'l' as const), ...cr.map(() => 'r' as const)]);
	const steps = sides.map((side, i): number => (i > 0 && sides[i - 1] === side ? 100 : COMBINE_GAP));
	for (let spare = 1000 - steps.reduce((a, b) => a + b, 0); spare >= 100; spare -= 100)
		if (rng.bool(0.6)) {
			const k = rng.int(0, steps.length - 1);
			steps[k] = (steps[k] as number) + 100;
		}
	const moments: { at: number; side: 'l' | 'r'; i: number }[] = [];
	let now = 0;
	const seen = { l: 0, r: 0 };
	sides.forEach((side, k) => {
		now += steps[k] as number;
		moments.push({ at: now, side, i: seen[side]++ });
	});
	const delaysOf = (side: 'l' | 'r'): number[] => {
		const ats = moments.filter((m) => m.side === side).map((m) => m.at);
		return ats.map((at, i) => at - (i === 0 ? 0 : (ats[i - 1] as number)));
	};
	const ld = delaysOf('l');
	const rd = delaysOf('r');
	let l = -1;
	let r = -1;
	const combineAnswer: string[] = [];
	for (const e of moments) {
		if (e.side === 'l') l = e.i;
		else r = e.i;
		if (l >= 0 && r >= 0) combineAnswer.push(`${cl[l]}${cr[r]}`);
	}
	const combineAsZip = Array.from({ length: Math.min(cl.length, cr.length) }, (_, i) => `${cl[i]}${cr[i]}`);
	const flowLines = (name: string, items: string[], delays: number[]): string[] => [
		`${IND}val ${name} = flow {`,
		...items.flatMap((item, i) => [`${IND}${IND}delay(${delays[i]})`, `${IND}${IND}emit(${item})`]),
		`${IND}}`
	];
	const source = [
		...HEAD,
		`${IND}val ${left} = flowOf(${zl.join(', ')})`,
		`${IND}val ${right} = flowOf(${zr.map((x) => `"${x}"`).join(', ')})`,
		`${IND}${left}.zip(${right}) { n, s -> "$n$s" }.collect { println(it) }`,
		`${IND}println("${zipped}")`,
		...flowLines(first, cl.map(String), ld),
		...flowLines(
			second,
			cr.map((x) => `"${x}"`),
			rd
		),
		`${IND}${first}.combine(${second}) { n, s -> "$n$s" }.collect { println(it) }`,
		`${IND}println("${done}")`,
		'}'
	].join('\n');
	const answer = [...zipAnswer, zipped, ...combineAnswer, done];
	return {
		source,
		answer,
		wrong: {
			'zip-pads': [...zipPads, zipped, ...combineAnswer, done],
			'combine-as-zip': [...zipAnswer, zipped, ...combineAsZip, done]
		}
	};
}

// Sequential classes.

function arithOf(rng: Rng): Arith {
	return rng.bool() ? { op: '*', k: rng.int(2, 9) * (rng.bool(0.3) ? 10 : 1) } : { op: '+', k: rng.int(1, 20) };
}

function predOf(rng: Rng): Pred {
	return rng.pick<Pred>([
		{ kind: 'even', k: 0 },
		{ kind: 'odd', k: 0 },
		{ kind: 'gt', k: rng.int(2, 6) }
	]);
}

function valuesOf(rng: Rng, count: number): number[] {
	return rng.sample([1, 2, 3, 4, 5, 6, 7, 8, 9], count);
}

function source(rng: Rng, opts: { start?: boolean; emit?: boolean; closed?: boolean; count: number }): Source {
	const name = rng.pick(SOURCES);
	return {
		name,
		values: valuesOf(rng, opts.count),
		start: opts.start ? `${name} start` : null,
		emit: opts.emit ? 'emit' : null,
		closed: opts.closed ? `${name} closed` : null
	};
}

/** Junior A: a cold flow runs its builder again for every collect, element by element with the collector. */
function coldRecollect(rng: Rng): FlowProgram {
	const src = source(rng, { start: rng.bool(), emit: true, count: rng.int(2, 3) });
	const [m0, m1, m2] = rng.sample(MAIN, 3) as [string, string, string];
	const second: FOp[] = rng.bool()
		? [{ k: 'map', f: arithOf(rng), print: null }]
		: [{ k: 'filter', p: predOf(rng), print: null }];
	const lines: Line[] = [
		{ say: m0 },
		{ run: { ops: [], label: 'got', throwAt: null }, guarded: false },
		{ say: m1 },
		{ run: { ops: second, label: 'next', throwAt: null }, guarded: false },
		{ say: m2 }
	];
	return { source: src, lines };
}

const PRINTS = ['see', 'check', 'step', 'peek'];

/** Junior B: each element passes onEach, map and filter before the next element is produced. */
function operatorChain(rng: Rng): FlowProgram {
	const src = source(rng, { count: rng.int(3, 4), emit: rng.bool(0.3) });
	const [pa, pb] = rng.sample(PRINTS, 2) as [string, string];
	const f = arithOf(rng);
	const filterFirst = rng.bool();
	// The filter passes some of the values it sees and drops others.
	const seen = filterFirst ? src.values : src.values.map((v) => arith(f, v));
	const preds = [predOf(rng), predOf(rng), predOf(rng), { kind: 'odd', k: 0 } as Pred, { kind: 'even', k: 0 } as Pred];
	const p = preds.find((q) => seen.some((v) => test(q, v)) && seen.some((v) => !test(q, v))) ?? null;
	if (p === null) return operatorChain(rng);
	const filter: FOp = { k: 'filter', p, print: rng.bool() ? pb : null };
	const map: FOp = { k: 'map', f, print: rng.bool() ? 'map' : null };
	const ops: FOp[] = filterFirst
		? [{ k: 'onEach', print: pa }, filter, map]
		: [map, { k: 'onEach', print: pa }, filter];
	const m0 = rng.pick(MAIN);
	return { source: src, lines: [{ run: { ops, label: 'got', throwAt: null }, guarded: false }, { say: m0 }] };
}

/** Anchor: take stops the builder after the n-th element; its finally and onCompletion run. */
function takeCompletion(rng: Rng): FlowProgram {
	const count = rng.int(4, 5);
	const src = source(rng, { emit: true, closed: true, count });
	const n = rng.int(1, count - 2);
	const ops: FOp[] = [];
	if (rng.bool()) ops.push({ k: 'map', f: arithOf(rng), print: null });
	ops.push({ k: 'take', n });
	if (rng.bool()) ops.push({ k: 'done', ok: 'completed', failed: 'failed' });
	const m0 = rng.pick(MAIN);
	return { source: src, lines: [{ run: { ops, label: 'got', throwAt: null }, guarded: false }, { say: m0 }] };
}

/** X: transform and flatMapConcat emit several elements per element, each passing downstream before the next. */
function transformFlat(rng: Rng): FlowProgram {
	const src = source(rng, { emit: true, count: 3 });
	const p = predOf(rng);
	const splits = src.values.some((v) => test(p, v)) && src.values.some((v) => !test(p, v));
	const ops: FOp[] =
		rng.bool() && splits
			? [{ k: 'transform', p, f: arithOf(rng) }]
			: [{ k: 'flat', open: rng.bool() ? 'open' : null, f: arithOf(rng), close: null }];
	if (rng.bool()) ops.push({ k: 'onEach', print: rng.pick(PRINTS) });
	const m0 = rng.pick(MAIN);
	return { source: src, lines: [{ run: { ops, label: 'got', throwAt: null }, guarded: false }, { say: m0 }] };
}

/** Middle A: catch handles exceptions from upstream only; onCompletion sees the exception that passes it. */
function catchCompletion(rng: Rng): FlowProgram {
	const src = source(rng, { emit: rng.bool(), count: rng.int(3, 4) });
	const values = src.values;
	const failing = values[rng.int(1, values.length - 1)] as number;
	const f = arithOf(rng);
	const catcher: FOp = { k: 'catch', print: 'caught', fallback: rng.bool() ? -1 : null };
	const before: FOp = { k: 'done', ok: 'upstream done', failed: 'upstream failed' };
	const after: FOp = { k: 'done', ok: 'all done', failed: 'all failed' };
	const fromCollector = rng.bool(0.4);
	const ops: FOp[] = [];
	if (fromCollector) ops.push({ k: 'map', f, print: null });
	else ops.push({ k: 'mapThrow', at: failing, f });
	if (rng.bool()) ops.push(before);
	ops.push(catcher);
	if (rng.bool() || ops.length === 2) ops.push(after);
	const throwAt = fromCollector ? arith(f, failing) : null;
	const m0 = rng.pick(MAIN);
	return { source: src, lines: [{ run: { ops, label: 'got', throwAt }, guarded: true }, { say: m0 }] };
}

/** Middle X: take after flatMapConcat counts the inner elements and stops inside an inner flow. */
function flatTake(rng: Rng): FlowProgram {
	const src = source(rng, { emit: rng.bool(), closed: rng.bool(), count: 3 });
	const n = rng.pick([1, 3, 5]);
	const ops: FOp[] = [
		{ k: 'flat', open: rng.bool() ? 'open' : null, f: arithOf(rng), close: 'close' },
		{ k: 'take', n },
		{ k: 'done', ok: 'completed', failed: 'failed' }
	];
	const m0 = rng.pick(MAIN);
	return { source: src, lines: [{ run: { ops, label: 'got', throwAt: null }, guarded: false }, { say: m0 }] };
}

/** The program of each sequential class and the wrong solutions of which one must apply (the instance tests its mechanism). */
const SEQUENTIAL: Record<string, { make: (rng: Rng) => FlowProgram; requires: readonly string[] }> = {
	'cold-recollect': { make: coldRecollect, requires: ['hot-flow'] },
	'operator-chain': { make: operatorChain, requires: ['stage-by-stage'] },
	'take-completion': { make: takeCompletion, requires: ['take-runs-all'] },
	'transform-flat': { make: transformFlat, requires: ['stage-by-stage'] },
	'catch-completion': {
		make: catchCompletion,
		requires: ['catch-downstream', 'error-skips-element', 'completion-only-on-success']
	},
	'flat-take': { make: flatTake, requires: ['take-counts-outer'] }
};

const TIMED: Record<string, (rng: Rng) => TimedProgram | null> = {
	buffer: bufferProgram,
	'zip-combine': zipCombineProgram
};

const BELIEFS: Record<string, Beliefs> = {
	'stage-by-stage': { stageByStage: true },
	'hot-flow': { hotFlow: true },
	'eager-builder': { eagerBuilder: true },
	'take-runs-all': { takeRunsAll: true },
	'take-no-finally': { takeNoFinally: true },
	'take-waits-next': { takeWaitsNext: true },
	'catch-downstream': { catchDownstream: true },
	'error-skips-element': { errorSkipsElement: true },
	'completion-only-on-success': { completionOnlyOnSuccess: true },
	'take-counts-outer': { takeCountsOuter: true }
};

/** The timed classes answer their own wrong solutions; these ids belong to them. */
const TIMED_WRONG = new Set(['buffer-ignored', 'buffer-collects-all', 'zip-pads', 'combine-as-zip']);

function sequentialProgram(
	rng: Rng,
	cls: { make: (rng: Rng) => FlowProgram; requires: readonly string[] },
	lines: readonly [number, number]
): TimedProgram | null {
	const program = cls.make(rng);
	const source = renderFlowProgram(program);
	const count = source.split('\n').length;
	if (count < lines[0] || count > lines[1]) return null;
	const answer = runFlowProgram(program, {});
	const wrong: Record<string, string[] | null> = {};
	for (const [id, belief] of Object.entries(BELIEFS)) {
		try {
			wrong[id] = runFlowProgram(program, belief);
		} catch (error) {
			if (!(error instanceof NotApplicable || error instanceof FlowError)) throw error;
			wrong[id] = null;
		}
	}
	const applies = (id: string): boolean => {
		const lines = wrong[id];
		return lines !== null && lines !== undefined && lines.join('\n') !== answer.join('\n');
	};
	if (!cls.requires.some(applies)) return null;
	return { source, answer, wrong };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const lines: readonly [number, number] = input.grade === 'junior' ? [10, 22] : [15, 30];
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const sequential = SEQUENTIAL[input.classId];
		const timed = TIMED[input.classId];
		const drawn = sequential ? sequentialProgram(rng, sequential, lines) : timed ? timed(rng) : null;
		if (!sequential && !timed) throw new Error(`${descriptor.key}: no class ${input.classId}`);
		if (drawn === null) continue;
		const count = drawn.source.split('\n').length;
		if (count < lines[0] || count > lines[1]) continue;
		if (drawn.answer.length === 0 || drawn.answer.some((l) => l.trim() === '')) continue;
		const program = kotlinProgram(drawn.source);
		const toAnswer = (value: string[]) => ({ kind: 'sequence' as const, value });
		const same = (value: string[]): boolean => value.join('\n') === drawn.answer.join('\n');
		const timedClass = timed !== undefined;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: timedClass
					? `${ENVIRONMENT} Считайте, что задержки выдерживаются точно, а всё остальное выполняется мгновенно. ${ENTER}`
					: `${ENVIRONMENT} ${ENTER}`,
				code: { language: 'kotlin', source: drawn.source }
			},
			answer: toAnswer(drawn.answer)
		});
		return {
			instance,
			reference: () => kotlinOutputProbe(program),
			wrong: () =>
				Object.fromEntries(
					descriptor.wrongSolutions.map(({ id }) => {
						const value = TIMED_WRONG.has(id) === timedClass ? (drawn.wrong[id] ?? null) : null;
						return [id, value === null || same(value) ? null : { kind: 'answer' as const, answer: toAnswer(value) }];
					})
				)
		};
	}
	throw new Error(`${descriptor.key}@${input.grade}/${input.classId}: no program fits on seed ${input.seed}`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
