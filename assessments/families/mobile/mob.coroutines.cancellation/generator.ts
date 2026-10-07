// Cancellation of coroutines in a single-threaded `runBlocking`: `cancel` only marks a job, the coroutine stops at its
// next suspension point (`delay`, `yield`, `ensureActive`), `finally` runs, a cancelled parent cancels its children.
// Junior: cancel and finally, the states of a job, the points of cancellation, a parent with children. Middle: a
// cancellation swallowed by `catch (e: Exception)`, suspending in `finally` with and without `NonCancellable`,
// `invokeOnCompletion`, a coroutine cancelled before it started and a child started by a cancelled coroutine. The
// mechanism is the essential class; names, delays and loop sizes are surface.
import { type Built, type GenerateInput, type ItemInstance, readDescriptor } from '../../_lib/family.ts';
import { coroutineTrace, type Beliefs, type CoProgram, type Stmt } from '../../_lib/coroutines.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

/** Distinct deadlines of a program differ by at least this much: the order survives a loaded machine. */
const SAFE_GAP = 200;

const TASKS = ['upload', 'sync', 'download', 'poll', 'prefetch', 'backup', 'export', 'indexer', 'loader', 'tracker'];
const MAIN = ['screen open', 'user left', 'back pressed', 'screen closed', 'ui ready', 'dialog shown', 'menu', 'done'];

const BELIEFS: Record<string, Beliefs> = {
	'cancel-sync': { cancelSync: true },
	'no-finally': { noFinally: true },
	'cancel-noop': { cancelNoop: true },
	'completed-on-cancel': { completedOnCancel: true },
	'runs-before-cancel': { runsBeforeCancel: true },
	'cancel-throws-at-once': { cancelThrowsAtOnce: true },
	'children-survive': { childrenSurvive: true },
	'parent-first': { parentFirst: true },
	'catch-misses-cancel': { catchMissesCancel: true },
	'cancelled-delay-waits': { cancelledDelayWaits: true },
	'finally-delay-ok': { finallyDelayOk: true },
	'handler-after-joiners': { handlerAfterJoiners: true },
	'child-of-cancelled-runs': { childOfCancelledRuns: true }
};

const say = (text: string): Stmt => ({ k: 'say', text });
const delay = (ms: number): Stmt => ({ k: 'delay', ms });
const launch = (name: string | null, body: Stmt[]): Stmt => ({ k: 'launch', name, start: 'default', body });
const tryFinally = (body: Stmt[], fin: Stmt[]): Stmt => ({ k: 'try', body, catch: null, finally: fin });
const ms = (rng: Rng, min: number, max: number): number => 100 * rng.int(min / 100, max / 100);

function cast(rng: Rng, tasks: number): { t: string[]; m: string[] } {
	return { t: rng.sample(TASKS, tasks), m: rng.sample(MAIN, 5) };
}

/** Junior A: `cancel` marks the job, the coroutine stops at its delay and runs `finally`; main goes on at once. */
function cancelFinally(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 1);
	const w = t[0] as string;
	const period = ms(rng, 200, 400);
	const loop: Stmt = { k: 'repeat', times: rng.int(3, 4), v: 'i', body: [delay(period), say(`${w} $i`)] };
	const main: Stmt[] = [
		say(m[0] as string),
		launch(w, [tryFinally([loop], [say(`${w} cleanup`)])]),
		delay(ms(rng, 100, 700)),
		say(m[1] as string)
	];
	if (rng.bool()) main.push({ k: 'cancel', job: w }, say(m[2] as string), { k: 'join', job: w }, say(m[3] as string));
	else main.push({ k: 'cancelAndJoin', job: w }, say(m[3] as string));
	return { funs: [], main };
}

/** Junior B: isActive, isCancelled and isCompleted of a job at different moments around `cancel` and `join`. */
function jobStates(rng: Rng): CoProgram {
	const { t } = cast(rng, 2);
	const [w, v] = t as [string, string];
	const work = ms(rng, 100, 300);
	const state = (job: string, stage: string): Stmt => ({ k: 'sayState', text: `${job} ${stage}:`, job });
	const main: Stmt[] = [launch(w, [say(`${w} start`), delay(work), say(`${w} done`)])];
	const other = rng.bool();
	if (other) main.push(launch(v, [delay(ms(rng, 100, 300)), say(`${v} done`)]));
	const moment = rng.pick(['before-start', 'while-waiting', 'after-end']);
	if (moment === 'before-start') {
		if (rng.bool()) main.push(state(w, 'launched'));
		main.push({ k: 'cancel', job: w }, state(w, 'cancelled'));
	} else {
		main.push(state(w, 'launched'));
		main.push(moment === 'while-waiting' ? { k: 'yield' } : delay(work + 100), state(w, 'waited'));
		main.push({ k: 'cancel', job: w }, state(w, 'cancelled'));
	}
	main.push({ k: 'join', job: w }, state(w, 'joined'));
	if (other) {
		// A job that has completed stays not cancelled after cancel().
		main.push({ k: 'join', job: v }, { k: 'cancel', job: v }, state(v, 'cancelled'));
	}
	return { funs: [], main };
}

/** Anchor: a coroutine that cancels itself goes on until its next point of cancellation. */
function cancelPoints(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 1);
	const w = t[0] as string;
	const times = rng.int(3, 5);
	const stopAt = rng.int(0, times - 2);
	const check = rng.pick<Stmt | null>([{ k: 'ensureActive' }, { k: 'yield' }, delay(100), null]);
	const step = say(`${w} step $i`);
	const stop: Stmt = { k: 'if', v: 'i', eq: stopAt, body: [{ k: 'cancel', job: null }] };
	const iteration: Stmt[] = rng.bool() ? [stop, step] : [step, stop];
	if (check) {
		if (rng.bool()) iteration.unshift(check);
		else iteration.push(check);
	}
	const body: Stmt[] = [{ k: 'repeat', times, v: 'i', body: iteration }, say(`${w} loop end`)];
	if (!check || rng.bool()) body.push(rng.bool() ? { k: 'yield' } : delay(100), say(`${w} after`));
	const main: Stmt[] = [
		say(m[0] as string),
		launch(w, rng.bool() ? [tryFinally(body, [say(`${w} finally`)])] : body),
		say(m[1] as string),
		{ k: 'join', job: w },
		{ k: 'sayState', text: `${w}:`, job: w }
	];
	return { funs: [], main };
}

/** X: cancelling a parent cancels its children first, then the parent; a sibling outside goes on. */
function parentChildren(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 4);
	const [p, c1, c2, s] = t as [string, string, string, string];
	const child = (name: string): Stmt =>
		launch(null, [tryFinally([delay(ms(rng, 100, 500)), say(`${name} done`)], [say(`${name} finally`)])]);
	const kids = rng.bool() ? [child(c1), child(c2)] : [child(c1)];
	const parentBody = [...kids, tryFinally([delay(ms(rng, 300, 600)), say(`${p} done`)], [say(`${p} finally`)])];
	const main: Stmt[] = [
		say(m[0] as string),
		launch(p, parentBody),
		launch(s, [delay(ms(rng, 100, 600)), say(`${s} done`)]),
		delay(ms(rng, 100, 400)),
		{ k: 'cancel', job: p },
		say(m[1] as string),
		{ k: 'join', job: p },
		say(m[2] as string)
	];
	return { funs: [], main };
}

/** Middle A: `catch (e: Exception)` swallows the cancellation: the loop goes on, every later delay throws at once. */
function swallowed(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 1);
	const w = t[0] as string;
	const variant = rng.pick(['swallow', 'swallow-check', 'rethrow']);
	const handler: Stmt = {
		k: 'try',
		body: [delay(ms(rng, 200, 400)), say(`${w} $i`)],
		catch: {
			type: variant === 'rethrow' ? 'CancellationException' : 'Exception',
			body: [say(`${w} caught $i`)],
			rethrow: variant === 'rethrow'
		},
		finally: null
	};
	const iteration: Stmt[] = [handler];
	if (variant === 'swallow-check') iteration.push({ k: 'ensureActive' });
	iteration.push(say(`${w} next $i`));
	const loop: Stmt = { k: 'repeat', times: rng.int(3, 4), v: 'i', body: iteration };
	const body = rng.bool() ? [tryFinally([loop], [say(`${w} finally`)])] : [loop, say(`${w} end`)];
	const main: Stmt[] = [say(m[0] as string), launch(w, body), delay(ms(rng, 100, 700)), say(m[1] as string)];
	if (rng.bool()) main.push({ k: 'cancel', job: w }, say(m[2] as string), { k: 'join', job: w });
	else main.push({ k: 'cancelAndJoin', job: w });
	main.push({ k: 'sayState', text: `${w}:`, job: w });
	return { funs: [], main };
}

/** Middle B: a suspending call in `finally` of a cancelled coroutine throws, unless it runs in NonCancellable. */
function nonCancellable(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 2);
	const [w, ticker] = t as [string, string];
	const save = ms(rng, 100, 300);
	const protectedSave = rng.bool(0.6);
	const finallyBody: Stmt[] = [say(`${w} saving`)];
	if (protectedSave)
		finallyBody.push({ k: 'withContext', ctx: 'NonCancellable', body: [delay(save), say(`${w} saved`)] });
	else finallyBody.push(delay(save), say(`${w} saved`));
	finallyBody.push(say(`${w} closed`));
	const loop: Stmt = { k: 'repeat', times: rng.int(3, 4), v: 'i', body: [delay(ms(rng, 200, 400)), say(`${w} $i`)] };
	const main: Stmt[] = [say(m[0] as string), launch(w, [tryFinally([loop], finallyBody)])];
	if (rng.bool()) main.push(launch(ticker, [delay(ms(rng, 100, 900)), say(`${ticker} done`)]));
	main.push(delay(ms(rng, 100, 700)));
	if (rng.bool()) main.push({ k: 'cancel', job: w }, say(m[1] as string), { k: 'join', job: w });
	else main.push({ k: 'cancelAndJoin', job: w });
	main.push(say(m[2] as string));
	return { funs: [], main };
}

/** Middle anchor: `invokeOnCompletion` runs when the job completes, before its joiners go on, with the cause. */
function completionHandlers(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 3);
	const [a, b, c] = t as [string, string, string];
	const handler = (job: string): Stmt => ({ k: 'onDone', job, ok: `${job} ok`, cancelled: `${job} cancelled` });
	const main: Stmt[] = [
		launch(a, [tryFinally([delay(ms(rng, 200, 500)), say(`${a} done`)], [say(`${a} finally`)])]),
		handler(a),
		launch(b, [delay(ms(rng, 100, 300)), say(`${b} done`)]),
		handler(b),
		delay(ms(rng, 100, 400))
	];
	if (rng.bool()) main.push({ k: 'cancel', job: a }, say(m[0] as string));
	main.push({ k: 'join', job: a }, say(m[1] as string));
	if (rng.bool()) {
		// Cancelled before it ran: the handler still sees the completion, the body never runs.
		main.push(launch(c, [say(`${c} run`)]), { k: 'cancel', job: c }, handler(c), say(m[2] as string), {
			k: 'join',
			job: c
		});
	}
	main.push(handler(b), say(m[3] as string));
	return { funs: [], main };
}

/** Middle X: a coroutine cancelled before it ran never runs its body; a child started by a cancelled one never runs. */
function cancelBeforeStart(rng: Rng): CoProgram {
	const { t, m } = cast(rng, 3);
	const [a, b, c] = t as [string, string, string];
	const main: Stmt[] = [
		say(m[0] as string),
		launch(a, [tryFinally([say(`${a} start`), delay(ms(rng, 200, 400)), say(`${a} done`)], [say(`${a} finally`)])])
	];
	if (rng.bool()) main.push({ k: 'yield' });
	main.push({ k: 'cancel', job: a }, say(m[1] as string));
	main.push(
		launch(b, [
			tryFinally([delay(ms(rng, 300, 500))], [say(`${b} finally`), launch(null, [say(`${c} run`)]), say(`${b} end`)])
		])
	);
	main.push(delay(ms(rng, 100, 200)), { k: 'cancel', job: b }, { k: 'join', job: b }, say(m[2] as string));
	main.push({ k: 'sayState', text: `${a}:`, job: a });
	return { funs: [], main };
}

/** The program of each class and the wrong solutions of which one must apply (the instance tests its mechanism). */
const CLASSES: Record<string, { make: (rng: Rng) => CoProgram; requires: readonly string[] }> = {
	'cancel-finally': { make: cancelFinally, requires: ['cancel-noop'] },
	'job-states': { make: jobStates, requires: ['completed-on-cancel', 'runs-before-cancel'] },
	'cancel-points': { make: cancelPoints, requires: ['cancel-throws-at-once', 'cancel-noop'] },
	'parent-children': { make: parentChildren, requires: ['children-survive'] },
	swallowed: { make: swallowed, requires: ['catch-misses-cancel'] },
	'non-cancellable': { make: nonCancellable, requires: ['finally-delay-ok', 'no-finally'] },
	'completion-handlers': { make: completionHandlers, requires: ['handler-after-joiners'] },
	'cancel-before-start': { make: cancelBeforeStart, requires: ['runs-before-cancel'] }
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
