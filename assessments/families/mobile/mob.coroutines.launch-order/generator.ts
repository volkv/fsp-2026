// The order of coroutines in a single-threaded `runBlocking` without timing: what `launch` and `async` do before the
// parent suspends, how `yield`, `join`, `await` and `coroutineScope` hand the thread over, and (Middle) the lazy and
// undispatched starts, the children a `join` waits for and a `join` of a finished job. The mechanism that orders the
// lines is the essential class; the names of the screens and tasks and the shape of the bodies are surface.
import { type Built, type GenerateInput, type ItemInstance, readDescriptor } from '../../_lib/family.ts';
import { coroutineTrace, type Beliefs, type CoProgram, type Stmt } from '../../_lib/coroutines.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

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
	'bind views',
	'spinner',
	'menu',
	'show list',
	'header'
];

const BELIEFS: Record<string, Beliefs> = {
	'eager-launch': { eagerLaunch: true },
	'async-on-await': { lazyAsync: true },
	'scope-no-wait': { scopeNoWait: true },
	'joiner-first': { joinerFirst: true },
	'lazy-as-default': { lazyAsDefault: true },
	'start-at-once': { startAtOnce: true },
	'undispatched-as-default': { undispatchedAsDefault: true },
	'join-ignores-children': { joinNoChildren: true },
	'join-always-suspends': { joinAlwaysSuspends: true }
};

const say = (text: string): Stmt => ({ k: 'say', text });
const yieldS: Stmt = { k: 'yield' };
const launch = (name: string | null, body: Stmt[], start: 'default' | 'lazy' | 'undispatched' = 'default'): Stmt => ({
	k: 'launch',
	name,
	start,
	body
});
const asyncS = (name: string, body: Stmt[], value: number, start: 'default' | 'lazy' = 'default'): Stmt => ({
	k: 'launch',
	name,
	start,
	body,
	result: { literal: value }
});

/** Names of the tasks and the lines of main, drawn once per program. */
function cast(rng: Rng, tasks: number): { t: string[]; m: string[] } {
	return { t: rng.sample(TASKS, tasks), m: rng.sample(MAIN, 5) };
}

/** A body of two or three lines: start, optionally a `yield` and the second part. */
function twoPart(rng: Rng, task: string, yieldProbability = 0.6): Stmt[] {
	return rng.bool(yieldProbability) ? [say(`${task} start`), yieldS, say(`${task} done`)] : [say(`${task} start`)];
}

/** Junior: launch is queued until main suspends; yield and join hand over the thread. */
function launchQueue(rng: Rng): CoProgram {
	const n = rng.int(2, 3);
	const { t, m } = cast(rng, n);
	const main: Stmt[] = [say(m[0] as string)];
	t.forEach((task, i) => {
		main.push(launch(task, twoPart(rng, task)));
		if (i === 0 || rng.bool()) main.push(say(m[i + 1] as string));
	});
	if (rng.bool()) {
		main.push(yieldS, say(m[4] as string), { k: 'join', job: t[n - 1] as string }, say(m[3] as string));
	} else {
		const target = rng.pick(t);
		main.push({ k: 'join', job: target }, say(m[4] as string));
		if (target !== t[n - 1]) main.push({ k: 'join', job: t[n - 1] as string }, say(m[3] as string));
	}
	return { funs: [], main };
}

/** Junior: async bodies run when main first suspends, in the order they were started, not in the order of await. */
function asyncAwait(rng: Rng): CoProgram {
	const n = rng.int(2, 3);
	const { t, m } = cast(rng, n);
	const values = rng.sample([2, 3, 4, 5, 6, 7, 8, 9, 12, 15], n);
	const main: Stmt[] = [say(m[0] as string)];
	t.forEach((task, i) => {
		const body = rng.bool(0.5) ? [say(`${task} load`), yieldS, say(`${task} parse`)] : [say(`${task} load`)];
		main.push(asyncS(task, body, values[i] as number));
	});
	main.push(say(m[1] as string));
	let order = rng.shuffle(t);
	if (order[0] === t[0]) order = [...order.slice(1), order[0] as string];
	for (const task of order) main.push({ k: 'sayAwait', text: `${task} =`, job: task });
	return { funs: [], main };
}

/** Anchor: coroutineScope waits for its children; a coroutine launched before it runs first. */
function scopeWaits(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 3);
	const [outer, c1, c2] = t as [string, string, string];
	const children: Stmt[] = [launch(null, twoPart(rng, c1, 0.7))];
	if (rng.bool()) children.push(launch(null, twoPart(rng, c2, 0.5)));
	const scopeBody = rng.bool() ? [...children, say(`${m[1]}`)] : [say(`${m[1]}`), ...children];
	if (scopeBody.at(-1)?.k !== 'say') scopeBody.push(say(m[2] as string));
	const main: Stmt[] = [
		say(m[0] as string),
		launch(outer, [say(`${outer} start`), yieldS, say(`${outer} done`)]),
		{ k: 'scope', body: scopeBody },
		say(m[3] as string)
	];
	if (rng.bool()) main.push({ k: 'join', job: outer }, say(m[4] as string));
	return { funs: [], main };
}

/** X: coroutines join each other; a finished job resumes its joiners in the order they started to wait. */
function joinChain(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 3);
	const [a, b, c] = t as [string, string, string];
	const main: Stmt[] = [
		say(m[0] as string),
		launch(a, [say(`${a} start`), yieldS, say(`${a} done`)]),
		launch(b, [say(`${b} wait`), { k: 'join', job: a }, say(`${b} done`)])
	];
	if (rng.bool()) main.push(launch(c, [say(`${c} wait`), { k: 'join', job: rng.pick([a, b]) }, say(`${c} done`)]));
	main.push(say(m[1] as string));
	const target = rng.pick([a, b]);
	main.push({ k: 'join', job: target }, say(m[2] as string));
	if (target === a) main.push({ k: 'join', job: b }, say(m[3] as string));
	return { funs: [], main };
}

/** Middle A: LAZY waits for start/join/await; start() only queues it; a default launch is queued at once. */
function lazyStart(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 3);
	const [l, d, v] = t as [string, string, string];
	const lazyBody = rng.bool() ? [say(`${l} start`), yieldS, say(`${l} done`)] : [say(`${l} run`)];
	const decls: Stmt[] = rng.shuffle([
		launch(l, lazyBody, 'lazy'),
		launch(d, rng.bool() ? [say(`${d} start`), yieldS, say(`${d} done`)] : [say(`${d} run`)]),
		asyncS(v, [say(`${v} compute`)], rng.int(2, 19), 'lazy')
	]);
	const main: Stmt[] = [say(m[0] as string), ...decls, say(m[1] as string)];
	const startFirst = rng.bool();
	if (startFirst) main.push({ k: 'start', job: l }, say(m[2] as string), { k: 'sayAwait', text: `${v} =`, job: v });
	else main.push({ k: 'sayAwait', text: `${v} =`, job: v }, { k: 'start', job: l }, say(m[2] as string));
	main.push({ k: 'join', job: l }, say(m[3] as string));
	if (rng.bool()) main.splice(main.length - 2, 0, yieldS, say(m[4] as string));
	return { funs: [], main };
}

/** Middle B: UNDISPATCHED runs the body at once up to the first suspension, then the rest goes through the queue. */
function undispatched(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 3);
	const [u, d, w] = t as [string, string, string];
	const firstSuspension: Stmt = rng.bool() ? yieldS : { k: 'join', job: d };
	const uBody = [say(`${u} start`), firstSuspension, say(`${u} done`)];
	const main: Stmt[] = [say(m[0] as string), launch(d, [say(`${d} start`), yieldS, say(`${d} done`)])];
	main.push(launch(u, uBody, 'undispatched'), say(m[1] as string));
	if (rng.bool()) {
		// An undispatched child inside a default coroutine runs within that coroutine's turn.
		main.push(
			launch(w, [
				say(`${w} start`),
				launch(null, [say(`${w} child`), yieldS, say(`${w} child done`)], 'undispatched'),
				say(`${w} done`)
			])
		);
	}
	main.push({ k: 'join', job: u }, say(m[2] as string));
	return { funs: [], main };
}

/** Middle anchor: join waits for the children of a job too; children are queued behind the coroutines already there. */
function nestedChildren(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 4);
	const [p, c1, c2, q] = t as [string, string, string, string];
	const kids: Stmt[] = [
		launch(null, rng.bool() ? [say(`${c1} start`), yieldS, say(`${c1} done`)] : [say(`${c1} run`)])
	];
	if (rng.bool()) kids.push(launch(null, [say(`${c2} run`)]));
	const pBody = rng.bool() ? [say(`${p} start`), ...kids, say(`${p} end`)] : [...kids, say(`${p} end`)];
	const qBody = rng.bool()
		? [say(`${q} wait`), { k: 'join', job: p } as Stmt, say(`${q} done`)]
		: [say(`${q} start`), yieldS, say(`${q} done`)];
	const main: Stmt[] = [say(m[0] as string), launch(p, pBody), launch(q, qBody), say(m[1] as string)];
	main.push({ k: 'join', job: p }, say(m[2] as string), { k: 'join', job: q }, say(m[3] as string));
	return { funs: [], main };
}

/** Middle X: join/await of a finished job does not suspend, so nothing queued runs in between. */
function completedJoin(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 3);
	const [a, b, c] = t as [string, string, string];
	const value = rng.int(2, 19);
	const main: Stmt[] = [
		say(m[0] as string),
		launch(a, [say(`${a} run`)]),
		asyncS(b, rng.bool() ? [say(`${b} load`)] : [say(`${b} load`), yieldS, say(`${b} parse`)], value)
	];
	main.push(rng.bool() ? yieldS : { k: 'join', job: a });
	main.push(launch(c, [say(`${c} run`)]), say(m[1] as string));
	const checks: Stmt[] = rng.shuffle([
		{ k: 'join', job: a },
		{ k: 'sayAwait', text: `${b} =`, job: b }
	]);
	main.push(checks[0] as Stmt, say(m[2] as string), checks[1] as Stmt, say(m[3] as string), { k: 'join', job: c });
	main.push(say(m[4] as string));
	return { funs: [], main };
}

/** The program of each class and the wrong solutions of which one must apply (the instance tests its mechanism). */
const CLASSES: Record<string, { make: (rng: Rng) => CoProgram; requires: readonly string[] }> = {
	'launch-queue': { make: launchQueue, requires: ['eager-launch'] },
	'async-await': { make: asyncAwait, requires: ['async-on-await'] },
	'scope-waits': { make: scopeWaits, requires: ['scope-no-wait'] },
	'join-chain': { make: joinChain, requires: ['eager-launch'] },
	'lazy-start': { make: lazyStart, requires: ['lazy-as-default', 'start-at-once'] },
	undispatched: { make: undispatched, requires: ['undispatched-as-default'] },
	'nested-children': { make: nestedChildren, requires: ['join-ignores-children'] },
	'completed-join': { make: completedJoin, requires: ['join-always-suspends'] }
};

export function build(input: GenerateInput): Built {
	const cls = CLASSES[input.classId];
	if (!cls) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	const { make, requires } = cls;
	return coroutineTrace(descriptor, input, make, BELIEFS, {
		lines: input.grade === 'junior' ? [10, 22] : [15, 30],
		requires
	});
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
