// A timeline of coroutines with delays in a single-threaded `runBlocking`: every line is printed at the moment its
// coroutine reaches it, so the order of the output is the order of the moments. Junior: several coroutines and steps
// of delays, `async` in parallel against sequential calls, loops of delays, `join`. Middle: `withContext` to another
// dispatcher, `coroutineScope` and `joinAll` against a `launch` nobody waits for, a blocking `Thread.sleep`, `async`
// started at different moments. The deadlines of the model differ by at least 100 ms, and a program lasts at most a
// second. The mechanism is the essential class; names, delays and values are surface.
import { type Built, type GenerateInput, type ItemInstance, readDescriptor } from '../../_lib/family.ts';
import { coroutineTrace, type Beliefs, type CoProgram, type Stmt, type SuspendFun } from '../../_lib/coroutines.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

/** Distinct deadlines of a program differ by at least this much: the order survives a loaded machine. */
const SAFE_GAP = 200;

const TASKS = [
	'feed',
	'profile',
	'cart',
	'chat',
	'avatar',
	'orders',
	'banner',
	'search',
	'news',
	'photos',
	'inbox',
	'promo'
];
const MAIN = [
	'screen open',
	'ui ready',
	'render',
	'toolbar',
	'layout',
	'spinner',
	'menu',
	'show list',
	'header',
	'footer'
];
const STEPS = ['request', 'response', 'parsed', 'cached', 'shown'];

const BELIEFS: Record<string, Beliefs> = {
	'delay-blocks': { delayBlocks: true },
	'eager-launch': { eagerLaunch: true },
	'absolute-delays': { absoluteDelays: true },
	'async-on-await': { lazyAsync: true },
	'with-context-blocks': { withContextBlocks: true },
	'scope-no-wait': { scopeNoWait: true },
	'sleep-as-delay': { sleepAsDelay: true }
};

const say = (text: string): Stmt => ({ k: 'say', text });
const delay = (ms: number): Stmt => ({ k: 'delay', ms });
const launch = (name: string | null, body: Stmt[]): Stmt => ({ k: 'launch', name, start: 'default', body });
const ms = (rng: Rng, min: number, max: number): number => 100 * rng.int(min / 100, max / 100);
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function cast(rng: Rng, tasks: number): { t: string[]; m: string[] } {
	return { t: rng.sample(TASKS, tasks), m: rng.sample(MAIN, 5) };
}

/** A coroutine of steps: optionally a first line, then `delay` and a line per step. */
function steps(rng: Rng, task: string, count: number, min = 100, max = 400): Stmt[] {
	const body: Stmt[] = rng.bool(0.4) ? [say(`${task} start`)] : [];
	for (let i = 0; i < count; i += 1) body.push(delay(ms(rng, min, max)), say(`${task} ${STEPS[i]}`));
	return body;
}

/** Junior A: several coroutines run their steps of delays side by side; main goes on at once. */
function parallelSteps(rng: Rng): CoProgram {
	const n = rng.int(2, 3);
	const { t, m } = cast(rng, n);
	const main: Stmt[] = [say(m[0] as string)];
	for (const task of t) main.push(launch(task, steps(rng, task, n === 2 ? 2 : rng.int(1, 2))));
	main.push(say(m[1] as string), delay(ms(rng, 100, 500)), say(m[2] as string));
	if (rng.bool()) main.push({ k: 'join', job: rng.pick(t) }, say(m[3] as string));
	return { funs: [], main };
}

/** Junior B: `async` calls run side by side, a direct call of a suspend function holds main until it returns. */
function asyncParallel(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 2);
	const [a, b] = t as [string, string];
	const values = rng.sample([2, 3, 4, 5, 6, 7, 8, 9, 12, 15], 2);
	const fun = (task: string, value: number): SuspendFun => ({
		name: `load${capital(task)}`,
		body: [delay(ms(rng, 100, 500)), say(`${task} loaded`)],
		returns: value
	});
	const funs = [fun(a, values[0] as number), fun(b, values[1] as number)];
	const async = (task: string): Stmt => ({
		k: 'launch',
		name: task,
		start: 'default',
		body: [],
		result: { call: `load${capital(task)}` }
	});
	const variant = rng.int(0, 2);
	const main: Stmt[] = [say(m[0] as string)];
	if (variant === 0) {
		main.push(async(a), async(b), say(m[1] as string));
		const [x, y] = rng.shuffle([a, b]) as [string, string];
		main.push({ k: 'sayAwait', text: `${x} =`, job: x }, { k: 'sayAwait', text: `${y} =`, job: y });
	} else if (variant === 1) {
		main.push(async(a), { k: 'call', fn: `load${capital(b)}`, into: b }, say(`${b} = $${b}`));
		main.push({ k: 'sayAwait', text: `${a} =`, job: a });
	} else {
		main.push({ k: 'call', fn: `load${capital(a)}`, into: a }, async(b), say(`${a} = $${a}`));
		main.push({ k: 'sayAwait', text: `${b} =`, job: b });
	}
	main.push(say(m[2] as string));
	return { funs, main };
}

/** Anchor: two loops of delays with different periods interleave by their moments. */
function loopTickers(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 2);
	const loop = (task: string): Stmt => {
		const body: Stmt[] = [];
		if (rng.bool(0.3)) body.push(say(`${task} start`));
		body.push({ k: 'repeat', times: rng.int(2, 3), v: 'i', body: [delay(ms(rng, 100, 300)), say(`${task} $i`)] });
		return launch(task, body);
	};
	const main: Stmt[] = [say(m[0] as string), loop(t[0] as string), loop(t[1] as string), say(m[1] as string)];
	main.push(delay(ms(rng, 100, 500)), say(m[2] as string));
	return { funs: [], main };
}

/** X: main waits with its own delay and with `join`; the coroutines go on meanwhile. */
function joinTiming(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 2);
	const [a, b] = t as [string, string];
	const main: Stmt[] = [
		say(m[0] as string),
		launch(a, [delay(ms(rng, 100, 500)), say(`${a} done`)]),
		launch(b, [delay(ms(rng, 100, 300)), say(`${b} ${STEPS[0]}`), delay(ms(rng, 100, 400)), say(`${b} done`)]),
		delay(ms(rng, 100, 400)),
		say(m[1] as string)
	];
	const first = rng.pick([a, b]);
	main.push({ k: 'join', job: first }, say(m[2] as string));
	if (rng.bool()) main.push({ k: 'join', job: first === a ? b : a }, say(m[3] as string));
	return { funs: [], main };
}

/** Middle A: `withContext(Dispatchers.IO)` suspends main until the block is done; coroutines on runBlocking go on. */
function withContextIo(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 3);
	const [ticker, data, other] = t as [string, string, string];
	const block: Stmt[] = rng.bool() ? [{ k: 'sleep', ms: ms(rng, 200, 500) }] : [delay(ms(rng, 200, 500))];
	const main: Stmt[] = [
		say(m[0] as string),
		launch(ticker, [
			{ k: 'repeat', times: rng.int(2, 4), v: 'i', body: [delay(ms(rng, 100, 200)), say(`${ticker} $i`)] }
		])
	];
	if (rng.bool()) main.push(launch(other, [say(`${other} start`), delay(ms(rng, 300, 700)), say(`${other} done`)]));
	main.push(
		say(m[1] as string),
		{ k: 'withContext', ctx: 'Dispatchers.IO', body: block, into: { name: data, result: { literal: rng.int(2, 99) } } },
		say(`${data} = $${data}`)
	);
	if (rng.bool()) main.push(delay(ms(rng, 100, 300)), say(m[2] as string));
	else main.push({ k: 'join', job: ticker }, say(m[2] as string));
	return { funs: [], main };
}

/** Middle B: `coroutineScope` and `joinAll` wait for their coroutines; a plain `launch` is not waited for. */
function scopeVsLaunch(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 4);
	const [a, b, c, d] = t as [string, string, string, string];
	const worker = (task: string): Stmt[] =>
		rng.bool(0.3)
			? [say(`${task} start`), delay(ms(rng, 100, 400)), say(`${task} done`)]
			: [delay(ms(rng, 100, 400)), say(`${task} done`)];
	const main: Stmt[] = [say(m[0] as string)];
	if (rng.bool()) {
		main.push(launch(c, worker(c)));
		main.push({ k: 'scope', body: [launch(null, worker(a)), launch(null, worker(b)), say(m[1] as string)] });
	} else {
		main.push(launch(a, worker(a)), launch(b, worker(b)), launch(c, worker(c)), say(m[1] as string));
		main.push({ k: 'joinAll', jobs: rng.bool() ? [a, b] : [b, a] });
	}
	main.push(say(m[2] as string), launch(d, worker(d)), say(m[3] as string));
	if (rng.bool()) main.push(delay(ms(rng, 100, 400)), say(m[4] as string));
	return { funs: [], main };
}

/** Middle anchor: `Thread.sleep` blocks the only thread; delays that expire meanwhile resume after it, in order. */
function threadSleep(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 3);
	const [a, b, s] = t as [string, string, string];
	const sleeper: Stmt[] = [];
	if (rng.bool()) sleeper.push(delay(ms(rng, 100, 200)));
	sleeper.push(say(`${s} busy`), { k: 'sleep', ms: ms(rng, 200, 400) }, say(`${s} free`));
	const workers: Stmt[] = [
		launch(a, [delay(ms(rng, 100, 300)), say(`${a} done`)]),
		launch(b, [
			say(`${b} start`),
			delay(ms(rng, 100, 300)),
			say(`${b} ${STEPS[0]}`),
			delay(ms(rng, 100, 300)),
			say(`${b} done`)
		])
	];
	const main: Stmt[] = [say(m[0] as string), ...rng.shuffle(workers)];
	if (rng.bool()) {
		main.push(launch(s, sleeper), say(m[1] as string));
	} else {
		// Main itself blocks, before or after its first suspension.
		if (rng.bool()) main.push(delay(100), say(m[1] as string));
		main.push({ k: 'sleep', ms: ms(rng, 200, 400) }, say(m[2] as string));
	}
	main.push(delay(ms(rng, 100, 300)), say(m[3] as string), { k: 'join', job: b }, say(m[4] as string));
	return { funs: [], main };
}

/** Middle X: `async` started at different moments and awaited in another order, next to a ticking coroutine. */
function awaitChain(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 3);
	const [a, b, ticker] = t as [string, string, string];
	const values = rng.sample([2, 3, 4, 5, 6, 7, 8, 9, 12, 15], 2);
	const deferred = (task: string, value: number, first: boolean): Stmt => ({
		k: 'launch',
		name: task,
		start: 'default',
		body: [...(first ? [say(`${task} start`)] : []), delay(ms(rng, 100, 500)), say(`${task} ready`)],
		result: { literal: value }
	});
	const main: Stmt[] = [say(m[0] as string), deferred(a, values[0] as number, rng.bool())];
	if (rng.bool())
		main.push(
			launch(ticker, [
				{ k: 'repeat', times: rng.int(2, 3), v: 'i', body: [delay(ms(rng, 100, 300)), say(`${ticker} $i`)] }
			])
		);
	main.push(delay(ms(rng, 100, 400)), say(m[1] as string), deferred(b, values[1] as number, rng.bool()));
	if (rng.bool()) main.push(say(m[2] as string));
	const order = rng.bool() ? [b, a] : [a, b];
	for (const task of order) main.push({ k: 'sayAwait', text: `${task} =`, job: task });
	main.push(say(m[3] as string));
	return { funs: [], main };
}

/** The program of each class and the wrong solutions of which one must apply (the instance tests its mechanism). */
const CLASSES: Record<string, { make: (rng: Rng) => CoProgram; requires: readonly string[] }> = {
	'parallel-steps': { make: parallelSteps, requires: ['delay-blocks'] },
	'async-parallel': { make: asyncParallel, requires: ['async-on-await', 'delay-blocks'] },
	'loop-tickers': { make: loopTickers, requires: ['delay-blocks'] },
	'join-timing': { make: joinTiming, requires: ['delay-blocks'] },
	'with-context': { make: withContextIo, requires: ['with-context-blocks'] },
	'scope-vs-launch': { make: scopeVsLaunch, requires: ['scope-no-wait', 'delay-blocks'] },
	'thread-sleep': { make: threadSleep, requires: ['sleep-as-delay'] },
	'await-chain': { make: awaitChain, requires: ['async-on-await'] }
};

export function build(input: GenerateInput): Built {
	const cls = CLASSES[input.classId];
	if (!cls) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	const { make, requires } = cls;
	return input.grade === 'junior'
		? coroutineTrace(descriptor, input, make, BELIEFS, { lines: [10, 22], gap: SAFE_GAP, requires })
		: coroutineTrace(descriptor, input, make, BELIEFS, { lines: [15, 30], inlineMax: 2, gap: SAFE_GAP, requires });
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
