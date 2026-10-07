// How an exception travels through structured concurrency: a failed child of `coroutineScope` cancels its siblings and
// the scope rethrows; `async` keeps the exception for `await`, yet its parent is cancelled all the same; a child of
// `supervisorScope` fails alone and goes to its `CoroutineExceptionHandler`; a handler or a `try` around `launch` inside
// `coroutineScope` catches nothing; `launch(SupervisorJob())` leaves the scope; a thrown `CancellationException` is not
// a failure. The way the exception goes is the essential class; names, messages, moments and the order of launches are
// surface. Every program runs in a single-threaded `runBlocking`, and its moments differ by at least 100 ms.
import {
	instanceRng,
	levelAndClass,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { FAILURES, SECTIONS, Timeline, traceBuilt, type TraceProgram } from '../../_lib/coroutine-trace.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const MOMENTS = [100, 200, 300, 400];
/** A moment after every event of a program: the prints that come when everything else is done. */
const END = 10_000;
const SHOWN = ['screen shown', 'ui ready', 'layout drawn', 'requests sent'];
const FALLBACKS = ['placeholder', 'cached', 'empty', 'default'];

/** A child that loads a section: prints when loaded and, with `finally`, when it ends in any way. */
interface Loader {
	name: string;
	at: number;
	fin: boolean;
}

const loaderLine = (l: Loader): string =>
	l.fin
		? `launch { try { delay(${l.at}); println("${l.name} loaded") } finally { println("${l.name} closed") } }`
		: `launch { delay(${l.at}); println("${l.name} loaded") }`;

const failLine = (at: number, message: string, prefix = 'launch'): string =>
	`${prefix} { delay(${at}); throw IllegalStateException("${message}") }`;

const HANDLER = 'val handler = CoroutineExceptionHandler { _, e -> println("handler: ${e.message}") }';

/** A loader that runs to its end. */
function complete(tl: Timeline, l: Loader): void {
	tl.add(l.at, `${l.name} loaded`, ...(l.fin ? [`${l.name} closed`] : []));
}

/**
 * The loaders at a failure of their scope at `at`: those done before it ran to the end, the others are cancelled —
 * their `finally` prints at the failure, in the order of launch (unless the belief skips `finally`).
 */
function cancelAt(tl: Timeline, loaders: readonly Loader[], at: number, noFinally = false): void {
	for (const l of loaders) {
		if (l.at < at) complete(tl, l);
		else if (l.fin && !noFinally) tl.add(at, `${l.name} closed`);
	}
}

/** Loaders with distinct names; `fin` has at least one loader with `finally` among those after `after`. */
function loaders(rng: Rng, names: readonly string[], moments: readonly number[], after: number): Loader[] {
	const list = names.map((name, i) => ({ name, at: moments[i] as number, fin: rng.bool(0.6) }));
	const late = list.filter((l) => l.at > after);
	if (late.length > 0 && !late.some((l) => l.fin)) rng.pick(late).fin = true;
	return list;
}

const program = (body: string[]): string[] => [
	'import kotlinx.coroutines.*',
	'',
	'fun main() = runBlocking {',
	...body,
	'}'
];

/** `try { <scope> { body } } catch (e: <type>) { println("error: ...") }` around a scope, then `done`. */
function tryScope(scope: string, body: string[], head: string[] = [], type = 'IllegalStateException'): string[] {
	return program([
		...head.map((l) => `    ${l}`),
		'    try {',
		`        ${scope} {`,
		...body.map((l) => `            ${l}`),
		'        }',
		`    } catch (e: ${type}) {`,
		'        println("error: ${e.message}")',
		'    }',
		'    println("done")'
	]);
}

// Middle.

/** A failed child of `coroutineScope` cancels its siblings; the scope rethrows after their `finally`. */
function siblingCancel(rng: Rng): TraceProgram {
	const names = rng.sample(SECTIONS, 4);
	const failAt = rng.pick([200, 300]);
	const message = rng.pick(FAILURES);
	const shown = rng.pick(SHOWN);
	const ls = loaders(rng, names.slice(0, 3), rng.shuffle(MOMENTS.filter((m) => m !== failAt)), failAt);
	const order: (Loader | 'fail')[] = rng.shuffle<Loader | 'fail'>([...ls, 'fail']);
	const launched = order.filter((c): c is Loader => c !== 'fail');
	const lines = tryScope('coroutineScope', [
		...order.map((c) => (c === 'fail' ? failLine(failAt, message) : loaderLine(c))),
		`println("${shown}")`
	]);
	const run = (b: { noCancel?: boolean; noFinally?: boolean; local?: boolean }): string[] => {
		const tl = new Timeline().add(0, shown);
		if (b.noCancel || b.local) for (const l of launched) complete(tl, l);
		else cancelAt(tl, launched, failAt, b.noFinally);
		if (!b.local) tl.add(b.noCancel ? END : failAt, `error: ${message}`);
		tl.add(END, 'done');
		return tl.lines();
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'no-sibling-cancel': run({ noCancel: true }),
			'finally-skipped': run({ noFinally: true }),
			'try-catches-launch': null
		}
	};
}

/** `await` rethrows the exception of `async`, the catch runs, but the parent is cancelled all the same. */
function asyncAwait(rng: Rng): TraceProgram {
	const [name, ...rest] = rng.sample(SECTIONS, 3) as [string, string, string];
	const [failAt, ...siblingMoments] = rng.sample(MOMENTS, 3) as [number, number, number];
	const message = rng.pick(FAILURES);
	const fallback = rng.pick(FALLBACKS);
	const v = rng.pick(['value', 'shown', 'image', 'text']);
	const ls = loaders(rng, rest, siblingMoments, failAt);
	const order: (Loader | 'async')[] = rng.shuffle<Loader | 'async'>([...ls, 'async']);
	const launched = order.filter((c): c is Loader => c !== 'async');
	const lines = tryScope('coroutineScope', [
		...order.map((c) =>
			c === 'async' ? `val ${name} = ${failLine(failAt, message, 'async<String>')}` : loaderLine(c)
		),
		`val ${v} = try { ${name}.await() } catch (e: IllegalStateException) { "${fallback}" }`,
		`println("${name}: $${v}")`,
		'delay(100)',
		`println("${name} refreshed")`
	]);
	const run = (b: { saves?: boolean; skipAfterCatch?: boolean; noFinally?: boolean }): string[] => {
		const tl = new Timeline();
		if (b.saves) {
			for (const l of launched) complete(tl, l);
			tl.add(failAt, `${name}: ${fallback}`).add(failAt + 100, `${name} refreshed`);
		} else {
			cancelAt(tl, launched, failAt, b.noFinally);
			if (!b.skipAfterCatch) tl.add(failAt, `${name}: ${fallback}`);
			tl.add(failAt, `error: ${message}`);
		}
		tl.add(END, 'done');
		return tl.lines();
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'await-catch-saves': run({ saves: true }),
			'code-after-catch-skipped': run({ skipAfterCatch: true }),
			'finally-skipped': run({ noFinally: true })
		}
	};
}

/** A failed child of `supervisorScope` goes to its handler alone; its siblings go on. */
function supervisorHandler(rng: Rng): TraceProgram {
	const twoFailures = rng.bool(0.4);
	const names = rng.sample(SECTIONS, twoFailures ? 2 : 3);
	const moments = rng.shuffle(MOMENTS);
	const failures = rng.sample(FAILURES, twoFailures ? 2 : 1).map((message, i) => ({
		at: moments[i] as number,
		message
	}));
	const ls = loaders(rng, names, moments.slice(failures.length), Math.min(...failures.map((f) => f.at)));
	const shown = rng.pick(SHOWN);
	const order = rng.shuffle<Loader | { at: number; message: string }>([...ls, ...failures]);
	const lines = program([
		`    ${HANDLER}`,
		'    supervisorScope {',
		...order.map((c) => `        ${'name' in c ? loaderLine(c) : failLine(c.at, c.message, 'launch(handler)')}`),
		`        println("${shown}")`,
		'    }',
		'    println("done")'
	]);
	const launched = order.filter((c): c is Loader => 'name' in c);
	const run = (b: { cancels?: boolean }): string[] => {
		const tl = new Timeline().add(0, shown);
		const first = Math.min(...failures.map((f) => f.at));
		if (b.cancels) {
			cancelAt(tl, launched, first);
			tl.add(first, `handler: ${failures.find((f) => f.at === first)?.message ?? ''}`);
		} else {
			for (const c of order) {
				if ('name' in c) complete(tl, c);
				else tl.add(c.at, `handler: ${c.message}`);
			}
		}
		tl.add(END, 'done');
		return tl.lines();
	};
	return { lines, answer: run({}), wrong: { 'supervisor-cancels': run({ cancels: true }) } };
}

/** A `try` around `launch` (and a handler on a child of `coroutineScope`) catches nothing: the scope fails. */
function tryAroundLaunch(rng: Rng): TraceProgram {
	const names = rng.sample(SECTIONS, 3);
	const failAt = rng.pick([200, 300]);
	const message = rng.pick(FAILURES);
	const withHandler = rng.bool();
	const shown = rng.pick(SHOWN);
	const ls = loaders(rng, names, rng.shuffle(MOMENTS.filter((m) => m !== failAt)), failAt);
	const lines = tryScope(
		'coroutineScope',
		[
			'try {',
			`    ${failLine(failAt, message, withHandler ? 'launch(handler)' : 'launch')}`,
			'} catch (e: IllegalStateException) {',
			'    println("caught at launch: ${e.message}")',
			'}',
			`println("${shown}")`,
			...ls.map(loaderLine)
		],
		withHandler ? [HANDLER] : []
	);
	const run = (b: { local?: string; noCancel?: boolean; noFinally?: boolean }): string[] => {
		const tl = new Timeline().add(0, shown);
		if (b.local !== undefined) {
			for (const l of ls) complete(tl, l);
			tl.add(failAt, b.local);
		} else if (b.noCancel) {
			for (const l of ls) complete(tl, l);
			tl.add(END, `error: ${message}`);
		} else {
			cancelAt(tl, ls, failAt, b.noFinally);
			tl.add(failAt, `error: ${message}`);
		}
		tl.add(END, 'done');
		return tl.lines();
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'try-catches-launch': run({ local: `caught at launch: ${message}` }),
			'handler-catches-child': withHandler ? run({ local: `handler: ${message}` }) : null,
			'no-sibling-cancel': run({ noCancel: true }),
			'finally-skipped': run({ noFinally: true })
		}
	};
}

// Senior.

/**
 * A group in `supervisorScope` (or `coroutineScope`) runs its children in a nested `coroutineScope`: a failed child
 * cancels only the nested siblings, and the group fails as one child of the outer scope.
 */
function nestedScopes(rng: Rng): TraceProgram {
	const supervisor = rng.bool();
	const [group, i1, i2, outerName] = rng.sample(SECTIONS, 4) as [string, string, string, string];
	const failAt = rng.pick([200, 300]);
	const message = rng.pick(FAILURES);
	const shown = rng.pick(SHOWN);
	const moments = rng.shuffle(MOMENTS.filter((m) => m !== failAt));
	const inner = loaders(rng, [i1, i2], moments.slice(0, 2), failAt);
	const outer: Loader = { name: outerName, at: moments[2] as number, fin: rng.bool(0.7) };
	const innerOrder = rng.shuffle<Loader | 'fail'>([...inner, 'fail']);
	const innerLaunched = innerOrder.filter((c): c is Loader => c !== 'fail');
	const groupLines = [
		'launch(handler) {',
		'    coroutineScope {',
		...innerOrder.map((c) => `        ${c === 'fail' ? failLine(failAt, message) : loaderLine(c)}`),
		'    }',
		`    println("${group} ready")`,
		'}'
	];
	const outerFirst = rng.bool();
	const lines = tryScope(
		supervisor ? 'supervisorScope' : 'coroutineScope',
		[
			...(outerFirst ? [loaderLine(outer)] : []),
			...groupLines,
			...(outerFirst ? [] : [loaderLine(outer)]),
			`println("${shown}")`
		],
		[HANDLER]
	);
	const run = (b: {
		grandchildren?: boolean;
		cancels?: boolean;
		handlerCatches?: boolean;
		noFinally?: boolean;
	}): string[] => {
		const tl = new Timeline().add(0, shown);
		if (b.grandchildren) {
			for (const l of innerLaunched) complete(tl, l);
			tl.add(failAt, `handler: ${message}`);
			tl.add(Math.max(failAt, ...inner.map((l) => l.at)), `${group} ready`);
			complete(tl, outer);
			tl.add(END, 'done');
			return tl.lines();
		}
		cancelAt(tl, innerLaunched, failAt, b.noFinally);
		const outerCancelled = (!supervisor && !b.handlerCatches) || b.cancels;
		if (outerCancelled) cancelAt(tl, [outer], failAt, b.noFinally);
		else complete(tl, outer);
		if (supervisor || b.handlerCatches) tl.add(failAt, `handler: ${message}`);
		else tl.add(failAt, `error: ${message}`);
		tl.add(END, 'done');
		return tl.lines();
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'supervisor-protects-grandchildren': supervisor ? run({ grandchildren: true }) : null,
			'supervisor-cancels': supervisor ? run({ cancels: true }) : null,
			'handler-catches-child': supervisor ? null : run({ handlerCatches: true }),
			'finally-skipped': run({ noFinally: true })
		}
	};
}

/**
 * `async` in `supervisorScope`: its failure cancels nobody and waits for `await`; an `async` nobody awaits loses its
 * exception, even with a handler; a `launch` with a handler reports to it.
 */
function supervisorAsync(rng: Rng): TraceProgram {
	const lost = rng.bool(0.6);
	const [n1, n2, n3] = rng.sample(SECTIONS, 3) as [string, string, string];
	const moments = rng.sample(MOMENTS, lost ? 4 : 3);
	const [t2, t3, t4, t1] = moments as [number, number, number, number | undefined];
	const [m1, m2, m4] = rng.sample(FAILURES, 3) as [string, string, string];
	const decls: { at: number; line: string; kind: 'lost' | 'fail' | 'ok' | 'launch' }[] = [
		...(lost && t1 !== undefined
			? [{ at: t1, line: `val ${n1} = ${failLine(t1, m1, 'async(handler)')}`, kind: 'lost' as const }]
			: []),
		{ at: t2, line: `val ${n2} = ${failLine(t2, m2, 'async<String>')}`, kind: 'fail' },
		{ at: t3, line: `val ${n3} = async { delay(${t3}); "${n3} data" }`, kind: 'ok' },
		{ at: t4, line: failLine(t4, m4, 'launch(handler)'), kind: 'launch' }
	];
	const order = rng.shuffle(decls);
	const failFirst = rng.bool();
	const failPrint = `println(try { ${n2}.await() } catch (e: IllegalStateException) { "fallback: \${e.message}" })`;
	const okPrint = `println(${n3}.await())`;
	const lines = program([
		`    ${HANDLER}`,
		'    supervisorScope {',
		...order.map((d) => `        ${d.line}`),
		`        ${failFirst ? failPrint : okPrint}`,
		`        ${failFirst ? okPrint : failPrint}`,
		'    }',
		'    println("done")'
	]);
	const all = [t2, t3, t4, ...(t1 === undefined ? [] : [t1])];
	const run = (b: { handlerOnAsync?: boolean; startsAtAwait?: boolean; cancels?: boolean }): string[] => {
		const tl = new Timeline();
		const failLineText = `fallback: ${m2}`;
		const okLineText = `${n3} data`;
		const firstAt = failFirst ? t2 : t3;
		const secondAt = failFirst ? t3 : t2;
		if (b.cancels) {
			const firstFailure = Math.min(t2, t4, ...(t1 === undefined ? [] : [t1]));
			if (t4 === firstFailure) tl.add(t4, `handler: ${m4}`);
			if (firstAt < firstFailure) tl.add(firstAt, failFirst ? failLineText : okLineText);
			if (firstAt < firstFailure && secondAt < firstFailure)
				tl.add(Math.max(firstAt, secondAt), failFirst ? okLineText : failLineText);
			return tl.lines();
		}
		tl.add(t4, `handler: ${m4}`);
		if (b.handlerOnAsync && t1 !== undefined) tl.add(t1, `handler: ${m1}`);
		const p1 = firstAt;
		const p2 = b.startsAtAwait ? p1 + secondAt : Math.max(p1, secondAt);
		tl.add(p1, failFirst ? failLineText : okLineText);
		tl.add(p2, failFirst ? okLineText : failLineText);
		tl.add(Math.max(p2, ...all) + 1, 'done');
		return tl.lines();
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'handler-on-async': lost ? run({ handlerOnAsync: true }) : null,
			'async-starts-at-await': run({ startsAtAwait: true }),
			'supervisor-cancels': run({ cancels: true })
		}
	};
}

/**
 * `launch(SupervisorJob() + handler)` (or `Job()`) is not a child of the scope: its failure goes to the handler and
 * cancels nobody, and the scope does not wait for it; a handler on an ordinary child of `coroutineScope` is ignored.
 */
function detachedJob(rng: Rng): TraceProgram {
	const job = rng.pick(['SupervisorJob()', 'Job()']);
	const second = rng.bool(0.5);
	const names = rng.sample(SECTIONS, second ? 2 : 3);
	const [m1, m2] = rng.sample(FAILURES, 2) as [string, string];
	const syncName = rng.pick(['sync', 'upload', 'prefetch', 'warmup']);
	const finished = `${syncName} finished`;
	let detachedAt: number;
	let secondAt = 0;
	let rest: number[];
	if (second) {
		const sorted = rng.sample(MOMENTS, 2).sort((a, b) => a - b);
		detachedAt = sorted[0] as number;
		secondAt = sorted[1] as number;
		rest = rng.shuffle(MOMENTS.filter((m) => m !== detachedAt && m !== secondAt));
	} else {
		detachedAt = rng.pick(MOMENTS);
		rest = rng.shuffle(MOMENTS.filter((m) => m !== detachedAt));
	}
	const ls = loaders(rng, names, rest, second ? secondAt : detachedAt);
	const children = rng.shuffle<Loader | 'second'>([...ls, ...(second ? ['second' as const] : [])]);
	const launched = children.filter((c): c is Loader => c !== 'second');
	const lines = tryScope(
		'coroutineScope',
		[
			`val ${syncName} = ${failLine(detachedAt, m1, `launch(${job} + handler)`)}`,
			...children.map((c) => (c === 'second' ? failLine(secondAt, m2, 'launch(handler)') : loaderLine(c))),
			`${syncName}.join()`,
			`println("${finished}")`
		],
		[HANDLER]
	);
	const run = (b: { inherits?: boolean; handlerCatches?: boolean; noFinally?: boolean }): string[] => {
		const tl = new Timeline();
		if (b.inherits) {
			// The detached child is taken for an ordinary one: its failure cancels the scope first.
			cancelAt(tl, launched, detachedAt, b.noFinally);
			tl.add(detachedAt, `error: ${m1}`);
			tl.add(END, 'done');
			return tl.lines();
		}
		tl.add(detachedAt, `handler: ${m1}`, finished);
		if (second && !b.handlerCatches) {
			cancelAt(tl, launched, secondAt, b.noFinally);
			tl.add(secondAt, `error: ${m2}`);
		} else {
			for (const l of launched) complete(tl, l);
			if (second) tl.add(secondAt, `handler: ${m2}`);
		}
		tl.add(END, 'done');
		return tl.lines();
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'supervisor-job-inherits': run({ inherits: true }),
			'handler-catches-child': second ? run({ handlerCatches: true }) : null,
			'finally-skipped': second ? run({ noFinally: true }) : null
		}
	};
}

/** A thrown `CancellationException` ends only its own coroutine: no sibling is cancelled, the scope does not fail. */
function cancellationException(rng: Rng): TraceProgram {
	const failing = rng.bool(0.75);
	const [cName, ...names] = rng.sample(SECTIONS, 3) as [string, string, string];
	const message = rng.pick(FAILURES);
	const stopText = `${cName} ${rng.pick(['stopped', 'closed', 'skipped'])}`;
	let stopAt: number;
	let failAt = 0;
	let rest: number[];
	if (failing) {
		const sorted = rng.sample([100, 200, 300], 2).sort((a, b) => a - b);
		stopAt = sorted[0] as number;
		failAt = sorted[1] as number;
		rest = rng.shuffle(MOMENTS.filter((m) => m !== stopAt && m !== failAt));
	} else {
		stopAt = rng.pick([100, 200, 300]);
		rest = rng.sample(
			MOMENTS.filter((m) => m !== stopAt),
			2
		);
	}
	const ls = loaders(rng, names, rest, failing ? failAt : stopAt);
	const children = rng.shuffle<Loader | 'fail'>([...ls, ...(failing ? ['fail' as const] : [])]);
	const launched = children.filter((c): c is Loader => c !== 'fail');
	const lines = tryScope(
		'coroutineScope',
		[
			`launch { delay(${stopAt}); throw CancellationException("${stopText}") }`,
			...children.map((c) => (c === 'fail' ? failLine(failAt, message) : loaderLine(c)))
		],
		[],
		'Exception'
	);
	const run = (b: { isFailure?: boolean; noCancel?: boolean; noFinally?: boolean }): string[] => {
		const tl = new Timeline();
		if (b.isFailure) {
			cancelAt(tl, launched, stopAt, b.noFinally);
			tl.add(stopAt, `error: ${stopText}`);
		} else if (failing && !b.noCancel) {
			cancelAt(tl, launched, failAt, b.noFinally);
			tl.add(failAt, `error: ${message}`);
		} else {
			for (const l of launched) complete(tl, l);
			if (failing) tl.add(END, `error: ${message}`);
		}
		tl.add(END, 'done');
		return tl.lines();
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'cancellation-is-failure': run({ isFailure: true }),
			'no-sibling-cancel': failing ? run({ noCancel: true }) : null,
			'finally-skipped': failing ? run({ noFinally: true }) : null
		}
	};
}

const CLASSES: Readonly<Record<string, (rng: Rng) => TraceProgram>> = {
	'sibling-cancel': siblingCancel,
	'async-await': asyncAwait,
	'supervisor-handler': supervisorHandler,
	'try-around-launch': tryAroundLaunch,
	'nested-scopes': nestedScopes,
	'supervisor-async': supervisorAsync,
	'detached-job': detachedJob,
	'cancellation-exception': cancellationException
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const make = CLASSES[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no program for class ${input.classId}`);
	return traceBuilt(descriptor, input, make(instanceRng(descriptor, input)));
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
