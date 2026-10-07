// Timeouts of coroutines: `withTimeout` cancels its block and its children, runs their `finally` and throws
// `TimeoutCancellationException` (silently cancelling a `launch` that does not catch it), `withTimeoutOrNull` gives null
// (even when the block catches the cancellation and returns a fallback), a timeout cancels the `async` started inside
// its block but not the one started outside, a lazy `async` starts at `await`, and a failure under `awaitAll` escapes
// `withTimeoutOrNull`. The mechanism is the essential class; names, values and moments are surface. Every program runs
// in a single-threaded `runBlocking`; its timers differ by at least 100 ms.
import {
	instanceRng,
	levelAndClass,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { SECTIONS, Timeline, traceBuilt, type TraceProgram } from '../../_lib/coroutine-trace.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const MAIN = ['import kotlinx.coroutines.*', '', 'fun main() = runBlocking {'];
/** A moment after every timer of a program. */
const END = 10_000;

/** Whether the moments of distinct timers keep 100 ms from each other. */
const spread = (moments: readonly number[]): boolean => {
	const sorted = [...moments].sort((a, b) => a - b);
	return sorted.every((m, i) => i === 0 || m - (sorted[i - 1] as number) >= 100);
};

// A: withTimeout, its children and `finally`; or a timeout inside a launch nobody catches.

interface Loader {
	name: string;
	at: number;
	fin: boolean;
}

const loaderLine = (l: Loader): string =>
	l.fin
		? `launch { try { delay(${l.at}); println("${l.name} loaded") } finally { println("${l.name} closed") } }`
		: `launch { delay(${l.at}); println("${l.name} loaded") }`;

function timeoutCaught(rng: Rng): TraceProgram {
	const two = rng.bool();
	let limit: number;
	let bodyAt: number;
	let loaderMoments: number[];
	if (two) {
		const m = rng.shuffle([100, 200, 300, 400]);
		[limit, bodyAt] = m as [number, number];
		loaderMoments = m.slice(2);
	} else {
		for (;;) {
			const m = rng.sample([100, 200, 300, 400, 500], 3);
			if (m.reduce((a, b) => a + b, 0) <= 1000) {
				[limit, bodyAt] = m as [number, number];
				loaderMoments = m.slice(2);
				break;
			}
		}
	}
	const names = rng.sample(SECTIONS, loaderMoments.length);
	const loaders: Loader[] = names.map((name, i) => ({ name, at: loaderMoments[i] as number, fin: rng.bool(0.7) }));
	const late = loaders.filter((l) => l.at > limit);
	if (late.length > 0 && !late.some((l) => l.fin)) rng.pick(late).fin = true;
	const work = rng.pick(['sync', 'render', 'parse', 'save']);
	const lines = [
		...MAIN,
		'    try {',
		`        withTimeout(${limit}) {`,
		...loaders.map((l) => `            ${loaderLine(l)}`),
		'            try {',
		`                delay(${bodyAt})`,
		`                println("${work} done")`,
		'            } finally {',
		`                println("${work} finally")`,
		'            }',
		'        }',
		'        println("in time")',
		'    } catch (e: TimeoutCancellationException) {',
		'        println("timed out")',
		'    }',
		'    println("done")',
		'}'
	];
	const run = (b: { returnsNull?: boolean; noFinally?: boolean; bodyOnly?: boolean }): string[] => {
		const tl = new Timeline();
		const finish = b.bodyOnly ? bodyAt : Math.max(bodyAt, ...loaders.map((l) => l.at));
		const complete = (l: Loader): void => {
			tl.add(l.at, `${l.name} loaded`, ...(l.fin ? [`${l.name} closed`] : []));
		};
		if (finish < limit) {
			for (const l of loaders) complete(l);
			tl.add(bodyAt, `${work} done`, `${work} finally`);
			tl.add(finish, 'in time');
		} else {
			for (const l of loaders) {
				if (l.at < limit) complete(l);
				else if (l.fin && !b.noFinally) tl.add(limit, `${l.name} closed`);
			}
			if (bodyAt < limit) tl.add(bodyAt, `${work} done`, `${work} finally`);
			else if (!b.noFinally) tl.add(limit, `${work} finally`);
			tl.add(limit, b.returnsNull ? 'in time' : 'timed out');
		}
		tl.add(END, 'done');
		return tl.lines();
	};
	const truth = run({});
	return {
		lines,
		answer: truth,
		wrong: {
			'timeout-returns-null': run({ returnsNull: true }),
			'no-finally-on-timeout': run({ noFinally: true }),
			'timeout-ignores-children': bodyAt < limit ? run({ bodyOnly: true }) : null
		}
	};
}

function timeoutInLaunch(rng: Rng): TraceProgram {
	let plan: { first: number; second: number; limit: number; sibling: number };
	for (;;) {
		const candidate = {
			first: rng.pick([100, 200]),
			second: rng.pick([100, 200, 300]),
			limit: rng.pick([200, 300, 400, 500]),
			sibling: rng.pick([100, 200, 300, 400, 500])
		};
		const moments = [candidate.first, candidate.first + candidate.second, candidate.limit, candidate.sibling];
		if (spread(moments) && Math.max(...moments) <= 1000) {
			plan = candidate;
			break;
		}
	}
	const [task, other] = rng.sample(SECTIONS, 2) as [string, string];
	const job = rng.pick(['job', 'upload', 'sync']);
	const lines = [
		...MAIN,
		`    val ${job} = launch {`,
		`        withTimeout(${plan.limit}) {`,
		`            delay(${plan.first})`,
		`            println("${task} step 1")`,
		`            delay(${plan.second})`,
		`            println("${task} step 2")`,
		'        }',
		`        println("${task} saved")`,
		'    }',
		`    launch { delay(${plan.sibling}); println("${other} loaded") }`,
		`    ${job}.join()`,
		`    println("cancelled: \${${job}.isCancelled}")`,
		'}'
	];
	const second = plan.first + plan.second;
	const run = (b: { returnsNull?: boolean; failure?: boolean }): string[] => {
		const tl = new Timeline();
		if (plan.first < plan.limit) tl.add(plan.first, `${task} step 1`);
		if (b.failure && plan.limit < second) {
			// The timeout taken for a failure: the program crashes at the timeout, the sibling never prints.
			if (plan.sibling < plan.limit) tl.add(plan.sibling, `${other} loaded`);
			return tl.lines();
		}
		tl.add(plan.sibling, `${other} loaded`);
		if (second < plan.limit) tl.add(second, `${task} step 2`, `${task} saved`, 'cancelled: false');
		else if (b.returnsNull) tl.add(plan.limit, `${task} saved`, 'cancelled: false');
		else tl.add(plan.limit, 'cancelled: true');
		return tl.lines();
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'timeout-returns-null': run({ returnsNull: true }),
			'timeout-is-failure': run({ failure: true })
		}
	};
}

// B: withTimeoutOrNull in a retry loop.

function orNullRetry(rng: Rng): TraceProgram {
	const block = rng.pick(['plain', 'fallback', 'finally'] as const);
	let plan: { base: number; step: number; costs: number[] };
	for (;;) {
		const base = rng.pick([100, 200, 300]);
		const step = rng.pick([0, 100, 200]);
		const costs = Array.from({ length: rng.int(3, 4) }, () => rng.pick([100, 200, 300, 400, 500]));
		let elapsed = 0;
		let ok = true;
		let success = false;
		for (const [i, cost] of costs.entries()) {
			const limit = base + step * i;
			if (Math.abs(cost - limit) < 100) ok = false;
			elapsed += Math.min(cost, limit);
			if (cost < limit) {
				success = i > 0 || rng.bool(0.2);
				break;
			}
		}
		if (ok && elapsed <= 1000 && success) {
			plan = { base, step, costs };
			break;
		}
	}
	const v = rng.pick(['page', 'feed', 'profile', 'avatar', 'cart', 'news']);
	const word = rng.pick(['attempt', 'try', 'round']);
	const blockLines =
		block === 'plain'
			? [`            delay(costs[attempt])`, `            "${v} in \${costs[attempt]} ms"`]
			: block === 'fallback'
				? [
						'            try {',
						'                delay(costs[attempt])',
						`                "${v} in \${costs[attempt]} ms"`,
						'            } catch (e: Exception) {',
						'                "cached"',
						'            }'
					]
				: [
						'            try {',
						'                delay(costs[attempt])',
						`                "${v} in \${costs[attempt]} ms"`,
						'            } finally {',
						'                println("request $attempt closed")',
						'            }'
					];
	const lines = [
		...MAIN,
		`    val costs = listOf(${plan.costs.map((c) => `${c}L`).join(', ')})`,
		'    var attempt = 0',
		`    var ${v}: String? = null`,
		`    while (${v} == null && attempt < costs.size) {`,
		`        ${v} = withTimeoutOrNull(${plan.base}L${plan.step ? ` + ${plan.step} * attempt` : ''}) {`,
		...blockLines,
		'        }',
		`        println("${word} $attempt: $${v}")`,
		'        attempt++',
		'    }',
		`    println("result: $${v}")`,
		'}'
	];
	const run = (b: { keepsFallback?: boolean; throws?: boolean; noFinally?: boolean }): string[] => {
		const out: string[] = [];
		let result: string | null = null;
		for (let i = 0; i < plan.costs.length && result === null; i += 1) {
			const cost = plan.costs[i] as number;
			const limit = plan.base + plan.step * i;
			if (cost < limit) {
				if (block === 'finally') out.push(`request ${i} closed`);
				result = `${v} in ${cost} ms`;
			} else {
				if (b.throws) return out;
				if (block === 'finally' && !b.noFinally) out.push(`request ${i} closed`);
				result = block === 'fallback' && b.keepsFallback ? 'cached' : null;
			}
			out.push(`${word} ${i}: ${result}`);
		}
		out.push(`result: ${result}`);
		return out;
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'ornull-keeps-fallback': block === 'fallback' ? run({ keepsFallback: true }) : null,
			'ornull-throws': run({ throws: true }),
			'no-finally-on-timeout': block === 'finally' ? run({ noFinally: true }) : null
		}
	};
}

// Anchor: async inside or outside the timeout, eager or lazy.

function asyncTimeout(rng: Rng): TraceProgram {
	const lazy = rng.bool();
	const inside = rng.bool();
	const [na, nb] = rng.sample(SECTIONS, 2) as [string, string];
	const [x, y] = [rng.int(1, 9), rng.int(10, 40)];
	let plan: { ta: number; tb: number; limit: number; wait: number };
	const timing = (p: typeof plan, isLazy: boolean) => {
		const doneA = p.ta;
		const startB = isLazy ? doneA : 0;
		const doneB = startB + p.tb;
		const all = isLazy ? doneB : Math.max(doneA, doneB);
		const ok = all < p.limit;
		const stop = ok ? all : p.limit;
		return { doneA, startB, doneB, ok, stop, end: stop + p.wait };
	};
	for (;;) {
		const candidate = {
			ta: rng.pick([100, 200, 300]),
			tb: rng.pick([100, 200, 300]),
			limit: rng.pick([200, 300, 400, 500]),
			wait: rng.pick([200, 300, 400])
		};
		const t = timing(candidate, lazy);
		const startedB = !lazy || t.startB < candidate.limit;
		const moments = [t.doneA, ...(startedB ? [t.doneB] : []), ...(t.ok ? [] : [candidate.limit]), t.end];
		const outsideDone = [t.doneA, ...(startedB ? [t.doneB] : [])].every((m) => m < t.end);
		if (spread(moments) && t.end <= 1000 && outsideDone && (lazy || candidate.ta !== candidate.tb)) {
			plan = candidate;
			break;
		}
	}
	const start = lazy ? '(start = CoroutineStart.LAZY)' : '';
	const asyncs = [
		`val ${na} = async${start} { delay(${plan.ta}); println("${na} ready"); ${x} }`,
		`val ${nb} = async${start} { delay(${plan.tb}); println("${nb} ready"); ${y} }`
	];
	const lines = [
		...MAIN,
		...(inside ? [] : asyncs.map((l) => `    ${l}`)),
		...(inside
			? [
					`    val total = withTimeoutOrNull(${plan.limit}) {`,
					...asyncs.map((l) => `        ${l}`),
					`        ${na}.await() + ${nb}.await()`,
					'    }'
				]
			: [`    val total = withTimeoutOrNull(${plan.limit}) { ${na}.await() + ${nb}.await() }`]),
		'    println("total: $total")',
		`    delay(${plan.wait})`,
		'    println("done")',
		...(lazy && !inside ? ['    coroutineContext.cancelChildren()'] : []),
		'}'
	];
	const run = (b: { eager?: boolean; cancelsOutside?: boolean; sparesInside?: boolean }): string[] => {
		const isLazy = lazy && !b.eager;
		const t = timing(plan, isLazy);
		const keeps = (inside && !b.sparesInside) || (!inside && b.cancelsOutside) ? false : true;
		const tl = new Timeline();
		const ready = (at: number, name: string, started: boolean): void => {
			if (started && (at < t.stop || (at === t.stop && t.ok) || (keeps && !t.ok))) tl.add(at, `${name} ready`);
		};
		ready(t.doneA, na, true);
		ready(t.doneB, nb, !isLazy || t.startB < plan.limit);
		tl.add(t.stop, `total: ${t.ok ? x + y : 'null'}`);
		tl.add(t.end, 'done');
		return tl.lines();
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'lazy-is-eager': lazy ? run({ eager: true }) : null,
			'timeout-cancels-outside': inside ? null : run({ cancelsOutside: true }),
			'timeout-spares-inside': inside ? run({ sparesInside: true }) : null
		}
	};
}

// X: awaitAll under withTimeoutOrNull.

type Part = { name: string; at: number; kind: 'ready' | 'fail' | 'fin'; value: number };

function awaitAllTimeout(rng: Rng): TraceProgram {
	const failing = rng.bool(0.75);
	const moments = rng.shuffle([100, 200, 300, 400]);
	const limit = moments[3] as number;
	const names = rng.sample(SECTIONS, 3);
	const kinds = rng.shuffle<Part['kind']>(
		failing ? ['ready', 'fail', 'fin'] : ['ready', rng.pick(['ready', 'fin'] as const), 'fin']
	);
	const parts: Part[] = names.map((name, i) => ({
		name,
		at: moments[i] as number,
		kind: kinds[i] as Part['kind'],
		value: rng.int(1, 9)
	}));
	const partLine = (p: Part): string =>
		p.kind === 'ready'
			? `async { delay(${p.at}); println("${p.name} ready"); ${p.value} }`
			: p.kind === 'fail'
				? `async<Int> { delay(${p.at}); throw IllegalStateException("${p.name} failed") }`
				: `async { try { delay(${p.at}); ${p.value} } finally { println("${p.name} closed") } }`;
	const lines = [
		...MAIN,
		'    val result = try {',
		`        withTimeoutOrNull(${limit}) {`,
		'            val parts = listOf(',
		...parts.map((p, i) => `                ${partLine(p)}${i < parts.length - 1 ? ',' : ''}`),
		'            )',
		'            parts.awaitAll().sum()',
		'        }',
		'    } catch (e: IllegalStateException) {',
		'        "error: ${e.message}"',
		'    }',
		'    println("result: $result")',
		'}'
	];
	const fail = parts.find((p) => p.kind === 'fail');
	const run = (b: { catchesAll?: boolean; waitsAll?: boolean; noFinally?: boolean }): string[] => {
		const tl = new Timeline();
		const okParts = parts.filter((p) => p.kind !== 'fail');
		const finish = (p: Part): void => {
			if (p.kind === 'ready') tl.add(p.at, `${p.name} ready`);
			else if (p.kind === 'fin') tl.add(p.at, `${p.name} closed`);
		};
		const cancelAt = (at: number): void => {
			for (const p of parts) {
				if (p.at < at) finish(p);
				else if (p.kind === 'fin' && !b.noFinally) tl.add(at, `${p.name} closed`);
			}
		};
		const allDone = Math.max(...parts.map((p) => p.at));
		if (fail && fail.at < limit) {
			if (b.waitsAll && allDone < limit) {
				for (const p of parts) finish(p);
				tl.add(allDone, `result: ${b.catchesAll ? 'null' : `error: ${fail.name} failed`}`);
				return tl.lines();
			}
			if (b.waitsAll) {
				cancelAt(limit);
				tl.add(limit, 'result: null');
				return tl.lines();
			}
			cancelAt(fail.at);
			tl.add(fail.at, `result: ${b.catchesAll ? 'null' : `error: ${fail.name} failed`}`);
			return tl.lines();
		}
		if (!fail && allDone < limit) {
			for (const p of parts) finish(p);
			tl.add(allDone, `result: ${okParts.reduce((s, p) => s + p.value, 0)}`);
			return tl.lines();
		}
		cancelAt(limit);
		tl.add(limit, 'result: null');
		return tl.lines();
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'ornull-catches-all': fail ? run({ catchesAll: true }) : null,
			'awaitall-waits-all': fail ? run({ waitsAll: true }) : null,
			'no-finally-on-timeout': run({ noFinally: true })
		}
	};
}

const CLASSES: Readonly<Record<string, (rng: Rng) => TraceProgram>> = {
	'timeout-finally': (rng) => (rng.bool(0.6) ? timeoutCaught(rng) : timeoutInLaunch(rng)),
	'or-null-retry': orNullRetry,
	'async-timeout': asyncTimeout,
	'await-all': awaitAllTimeout
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
