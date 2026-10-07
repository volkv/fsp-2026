// Async iteration: an async generator runs only when its consumer asks for the next value, `for await…of` over an
// array waits for each element in the array's order, an early `break` calls `return()` and waits for the generator's
// `finally`, `EventTarget` calls its listeners synchronously in the middle of async code; a level up, the exact order
// of jobs between a generator and an independent chain of `then`, the queue of `next()` and `return()` calls, an
// `await` inside the generator's `finally`, and an exception thrown out of the loop body.
//
// The generator models the shown program job by job: a small interpreter of the program's syntax tree runs async
// functions and async generators as the specification writes them (`yield` awaits its operand, the request queue of
// an async generator, AsyncIteratorClose, the async-from-sync iterator), on the same promise machinery as the
// combinators family. The gate runs every shown program with Node and compares the output. Every timer is set while
// the script itself runs, with delays at least 20 ms apart.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { nodeOutputProbe } from '../../_lib/node.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

// ---------------------------------------------------------------------------------------------------------------
// Values.

interface IterResult {
	t: 'iter';
	value: Value;
	done: boolean;
}

interface ErrorValue {
	t: 'error';
	message: string;
}

interface EventObject {
	t: 'event';
	detail: Value;
}

interface ObjectValue {
	t: 'object';
	entries: Map<string, Value>;
}

interface BusValue {
	t: 'bus';
}

type Value =
	| string
	| number
	| null
	| undefined
	| Value[]
	| IterResult
	| ErrorValue
	| EventObject
	| ObjectValue
	| BusValue
	| Prom
	| AsyncGen;

/** A JavaScript exception of the shown program, carrying the thrown value. */
class Thrown extends Error {
	readonly value: Value;
	constructor(value: Value) {
		super('a thrown value');
		this.value = value;
	}
}

/** A construct or an outcome the scenarios must not produce: the program is drawn again. */
class Unsupported extends Error {}

const iterResult = (value: Value, done: boolean): IterResult => ({ t: 'iter', value, done });

/** `console.log` of one argument. */
function format(x: Value): string {
	if (x === undefined) return 'undefined';
	if (x === null) return 'null';
	if (typeof x === 'string') return x;
	if (typeof x === 'number') return String(x);
	if (Array.isArray(x)) return x.map(format).join(',');
	if (x instanceof Prom) return 'Promise';
	if (x instanceof AsyncGen) return 'Object [AsyncGenerator] {}';
	return `[${x.t}]`;
}

// ---------------------------------------------------------------------------------------------------------------
// Misconceptions as rules of the machinery.

interface Rules {
	/** The body of an async generator starts when the generator function is called. */
	eagerGenerator: boolean;
	/** After a `yield` the generator runs on to the next one without waiting for the next request. */
	pushAhead: boolean;
	/** A timer promise made ahead starts its timer only when something first waits for it. */
	timersOnAwait: boolean;
	/** `return()` closes the generator without running its `finally`. */
	returnSkipsFinally: boolean;
	/** The loop goes on after `break` without waiting for `return()` of the generator. */
	afterLoopFirst: boolean;
	/** `for await` over an array yields the elements in the order they settle. */
	resolutionOrder: boolean;
	/** `for await` over an array does not wait on a plain value. */
	plainNoWait: boolean;
	/** `dispatchEvent` calls the listeners later, as a microtask, not inside the call. */
	dispatchAsync: boolean;
	/** `dispatchEvent` waits for async listeners to finish. */
	listenerAwaited: boolean;
	/** The `once` option is ignored. */
	onceIgnored: boolean;
	/** `yield` hands its operand over without awaiting it. */
	yieldNoAwait: boolean;
	/** An independent `then` chain runs all its links in one go. */
	chainFirst: boolean;
	/** `return()` settles at once, ahead of the requests queued before it. */
	returnImmediate: boolean;
	/** An `await` in the generator's `finally` does not hold up its closing. */
	finallyAwaitIgnored: boolean;
	/** An exception thrown in the loop body leaves the generator open. */
	throwSkipsClose: boolean;
	/** An exception thrown in the loop body reaches the `catch` before the generator is closed. */
	catchBeforeClose: boolean;
}

const RIGHT: Rules = {
	eagerGenerator: false,
	pushAhead: false,
	timersOnAwait: false,
	returnSkipsFinally: false,
	afterLoopFirst: false,
	resolutionOrder: false,
	plainNoWait: false,
	dispatchAsync: false,
	listenerAwaited: false,
	onceIgnored: false,
	yieldNoAwait: false,
	chainFirst: false,
	returnImmediate: false,
	finallyAwaitIgnored: false,
	throwSkipsClose: false,
	catchBeforeClose: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'eager-generator': { eagerGenerator: true },
	'push-ahead': { pushAhead: true },
	'timers-on-await': { timersOnAwait: true },
	'return-skips-finally': { returnSkipsFinally: true },
	'after-loop-first': { afterLoopFirst: true },
	'resolution-order': { resolutionOrder: true },
	'plain-no-wait': { plainNoWait: true },
	'dispatch-async': { dispatchAsync: true },
	'listener-awaited': { listenerAwaited: true },
	'once-ignored': { onceIgnored: true },
	'yield-no-await': { yieldNoAwait: true },
	'chain-first': { chainFirst: true },
	'return-immediate': { returnImmediate: true },
	'finally-await-ignored': { finallyAwaitIgnored: true },
	'throw-skips-close': { throwSkipsClose: true },
	'catch-before-close': { catchBeforeClose: true }
};

// ---------------------------------------------------------------------------------------------------------------
// The promise machinery.

type Handler = (value: Value) => Value;

interface Capability {
	promise: Prom;
	resolve: (value: Value) => void;
	reject: (reason: Value) => void;
}

interface Reaction {
	cap: Capability | null;
	kind: 'fulfill' | 'reject';
	handler: Handler | null;
}

class Prom {
	state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
	value: Value = undefined;
	fulfillReactions: Reaction[] = [];
	rejectReactions: Reaction[] = [];
	handled = false;
	/** A timer promise made ahead whose timer starts on the first wait (a misconception only). */
	lazyTimer: (() => void) | null = null;
}

/** A request to an async generator: `next(v)` or `return(v)`, with the promise its caller got. */
interface Request {
	kind: 'next' | 'return';
	value: Value;
	cap: Capability;
}

type Cmd = { k: 'await'; v: Value } | { k: 'yield'; v: Value };
type Body = Generator<Cmd, Value, Value>;

class AsyncGen {
	state: 'start' | 'yield' | 'executing' | 'draining' | 'completed' = 'start';
	readonly queue: Request[] = [];
	readonly body: Body;
	/** Promises of requests a misconception made on its own; the caller's next `next()` gets them first. */
	readonly ahead: Prom[] = [];
	constructor(body: Body) {
		this.body = body;
	}
}

interface Timer {
	at: number;
	seq: number;
	cancelled: boolean;
	run: () => void;
}

class Engine {
	readonly out: string[] = [];
	readonly rules: Rules;
	readonly #strict: boolean;
	readonly #jobs: (() => void)[] = [];
	readonly #timers: Timer[] = [];
	readonly #unhandled: Prom[] = [];
	#seq = 0;
	#steps = 0;
	now = 0;

	constructor(rules: Rules, strict: boolean) {
		this.rules = rules;
		this.#strict = strict;
	}

	log(line: string): void {
		this.out.push(line);
	}

	enqueue(job: () => void): void {
		this.#jobs.push(job);
	}

	run(script: () => void): void {
		script();
		this.#drain();
		for (;;) {
			const next = this.#timers
				.filter((t) => !t.cancelled)
				.sort((a, b) => a.at - b.at || a.seq - b.seq)
				.at(0);
			if (!next) return;
			next.cancelled = true;
			this.now = next.at;
			next.run();
			this.#drain();
		}
	}

	#drain(): void {
		while (this.#jobs.length > 0) {
			if ((this.#steps += 1) > 50_000) throw new Unsupported('runaway jobs');
			(this.#jobs.shift() as () => void)();
		}
		if (this.#strict && this.#unhandled.some((p) => !p.handled)) throw new Unsupported('unhandled rejection');
		this.#unhandled.length = 0;
	}

	setTimeout(ms: number, run: () => void): void {
		this.#timers.push({ at: this.now + ms, seq: (this.#seq += 1), cancelled: false, run });
	}

	resolvers(p: Prom): Capability {
		let already = false;
		return {
			promise: p,
			resolve: (x) => {
				if (already) return;
				already = true;
				if (x instanceof Prom) {
					this.enqueue(() => {
						const r = this.resolvers(p);
						this.then(x, r.resolve as Handler, r.reject as Handler);
					});
					return;
				}
				this.#settle(p, 'fulfilled', x);
			},
			reject: (reason) => {
				if (already) return;
				already = true;
				this.#settle(p, 'rejected', reason);
			}
		};
	}

	capability(): Capability {
		return this.resolvers(new Prom());
	}

	#settle(p: Prom, state: 'fulfilled' | 'rejected', value: Value): void {
		if (p.state !== 'pending') return;
		p.state = state;
		p.value = value;
		const reactions = state === 'fulfilled' ? p.fulfillReactions : p.rejectReactions;
		p.fulfillReactions = [];
		p.rejectReactions = [];
		if (state === 'rejected' && !p.handled) this.#unhandled.push(p);
		for (const reaction of reactions) {
			this.enqueue(() => {
				this.#job(reaction, value);
			});
		}
	}

	#job(reaction: Reaction, arg: Value): void {
		let result: Value;
		let threw = false;
		if (!reaction.handler) {
			result = arg;
			threw = reaction.kind === 'reject';
		} else {
			try {
				result = reaction.handler(arg);
			} catch (error) {
				if (!(error instanceof Thrown)) throw error;
				threw = true;
				result = error.value;
			}
		}
		if (!reaction.cap) return;
		if (threw) reaction.cap.reject(result);
		else reaction.cap.resolve(result);
	}

	performThen(p: Prom, onFulfilled: Handler | null, onRejected: Handler | null, cap: Capability | null): void {
		if (p.lazyTimer) {
			const start = p.lazyTimer;
			p.lazyTimer = null;
			start();
		}
		const f: Reaction = { cap, kind: 'fulfill', handler: onFulfilled };
		const r: Reaction = { cap, kind: 'reject', handler: onRejected };
		p.handled = true;
		if (p.state === 'pending') {
			p.fulfillReactions.push(f);
			p.rejectReactions.push(r);
			return;
		}
		const reaction = p.state === 'fulfilled' ? f : r;
		const value = p.value;
		this.enqueue(() => {
			this.#job(reaction, value);
		});
	}

	then(p: Prom, onFulfilled: Handler | null, onRejected: Handler | null): Prom {
		const cap = this.capability();
		this.performThen(p, onFulfilled, onRejected, cap);
		return cap.promise;
	}

	promiseResolve(x: Value): Prom {
		if (x instanceof Prom) return x;
		const cap = this.capability();
		cap.resolve(x);
		return cap.promise;
	}

	/** A promise settled by a timer made while the script runs; the timer logs when it fires. */
	timerPromise(ms: number, ok: boolean, value: string): Prom {
		const cap = this.capability();
		const start = (): void => {
			this.setTimeout(ms, () => {
				this.log(`${ok ? 'ready' : 'failed'} ${value}`);
				if (ok) cap.resolve(value);
				else cap.reject({ t: 'error', message: value });
			});
		};
		if (this.rules.timersOnAwait) cap.promise.lazyTimer = start;
		else start();
		return cap.promise;
	}

	all(items: readonly Value[]): Prom {
		const cap = this.capability();
		const values: Value[] = items.map(() => undefined);
		let remaining = 1;
		items.forEach((item, i) => {
			remaining += 1;
			let called = false;
			this.then(
				this.promiseResolve(item),
				(x) => {
					if (called) return undefined;
					called = true;
					values[i] = x;
					if ((remaining -= 1) === 0) cap.resolve(values);
					return undefined;
				},
				(e) => {
					cap.reject(e);
					return undefined;
				}
			);
		});
		if ((remaining -= 1) === 0) cap.resolve(values);
		return cap.promise;
	}

	/** `await v` of a coroutine: resumes on a job after `v` settles. */
	awaitValue(v: Value, onFulfilled: (x: Value) => void, onRejected: (e: Value) => void): void {
		this.performThen(
			this.promiseResolve(v),
			(x) => {
				onFulfilled(x);
				return undefined;
			},
			(e) => {
				onRejected(e);
				return undefined;
			},
			null
		);
	}

	/** An async function: runs its body until the first `await`, returns its promise. */
	asyncCall(body: Body): Prom {
		const cap = this.capability();
		const step = (mode: 'next' | 'throw', arg: Value): void => {
			let r: IteratorResult<Cmd, Value>;
			try {
				r = mode === 'next' ? body.next(arg) : body.throw(new Thrown(arg));
			} catch (error) {
				if (!(error instanceof Thrown)) throw error;
				cap.reject(error.value);
				return;
			}
			if (r.done) {
				cap.resolve(r.value);
				return;
			}
			if (r.value.k !== 'await') throw new Error('yield in an async function');
			this.awaitValue(
				r.value.v,
				(x) => {
					step('next', x);
				},
				(e) => {
					step('throw', e);
				}
			);
		};
		step('next', undefined);
		return cap.promise;
	}

	// The async generator of the specification: a request queue, `yield` that awaits, `return()` that unwraps.

	makeGenerator(body: Body): AsyncGen {
		const g = new AsyncGen(body);
		if (this.rules.eagerGenerator) g.ahead.push(this.#request(g, 'next', undefined));
		return g;
	}

	#request(g: AsyncGen, kind: 'next' | 'return', value: Value): Prom {
		const cap = this.capability();
		if (g.state === 'completed' && kind === 'next') {
			cap.resolve(iterResult(undefined, true));
			return cap.promise;
		}
		g.queue.push({ kind, value, cap });
		if (kind === 'return' && (g.state === 'start' || g.state === 'completed')) {
			g.state = 'draining';
			this.#awaitReturn(g);
		} else if (g.state === 'start' || g.state === 'yield') this.#resume(g, { kind, value, cap });
		return cap.promise;
	}

	next(g: AsyncGen): Prom {
		const ahead = g.ahead.shift();
		if (ahead) return ahead;
		return this.#request(g, 'next', undefined);
	}

	return(g: AsyncGen, value: Value): Prom {
		g.ahead.length = 0;
		const promise = this.#request(g, 'return', value);
		if (this.rules.returnImmediate) {
			const cap = g.queue.find((q) => q.cap.promise === promise)?.cap;
			cap?.resolve(iterResult(value, true));
		}
		return promise;
	}

	#resume(g: AsyncGen, request: Request): void {
		const fresh = g.state === 'start';
		g.state = 'executing';
		if (fresh) this.#step(g, 'next', undefined);
		else this.#unwrap(g, request);
	}

	#unwrap(g: AsyncGen, request: Request): void {
		if (request.kind === 'next') {
			this.#step(g, 'next', request.value);
			return;
		}
		this.awaitValue(
			request.value,
			(x) => {
				if (this.rules.returnSkipsFinally) this.#finish(g, true, x);
				else this.#step(g, 'return', x);
			},
			(e) => {
				this.#step(g, 'throw', e);
			}
		);
	}

	#step(g: AsyncGen, mode: 'next' | 'throw' | 'return', v: Value): void {
		let r: IteratorResult<Cmd, Value>;
		try {
			r = mode === 'next' ? g.body.next(v) : mode === 'throw' ? g.body.throw(new Thrown(v)) : g.body.return(v);
		} catch (error) {
			if (!(error instanceof Thrown)) throw error;
			this.#finish(g, false, error.value);
			return;
		}
		if (r.done) {
			this.#finish(g, true, r.value);
			return;
		}
		const cmd = r.value;
		if (cmd.k === 'await') {
			this.awaitValue(
				cmd.v,
				(x) => {
					this.#step(g, 'next', x);
				},
				(e) => {
					this.#step(g, 'throw', e);
				}
			);
		} else if (this.rules.yieldNoAwait) this.#yield(g, cmd.v);
		else
			this.awaitValue(
				cmd.v,
				(x) => {
					this.#yield(g, x);
				},
				(e) => {
					this.#step(g, 'throw', e);
				}
			);
	}

	#yield(g: AsyncGen, value: Value): void {
		const request = g.queue.shift();
		if (!request) throw new Error('a yield without a request');
		request.cap.resolve(iterResult(value, false));
		const next = g.queue[0];
		if (next) this.#unwrap(g, next);
		else if (this.rules.pushAhead) {
			const cap = this.capability();
			const ahead = { kind: 'next' as const, value: undefined, cap };
			g.queue.push(ahead);
			g.ahead.push(cap.promise);
			this.#unwrap(g, ahead);
		} else g.state = 'yield';
	}

	#finish(g: AsyncGen, ok: boolean, value: Value): void {
		g.state = 'draining';
		const request = g.queue.shift();
		if (!request) throw new Error('a finished generator without a request');
		if (ok) request.cap.resolve(iterResult(value, true));
		else request.cap.reject(value);
		this.#drainQueue(g);
	}

	#drainQueue(g: AsyncGen): void {
		for (;;) {
			const next = g.queue[0];
			if (!next) {
				g.state = 'completed';
				g.ahead.length = 0;
				return;
			}
			if (next.kind === 'return') {
				this.#awaitReturn(g);
				return;
			}
			g.queue.shift();
			next.cap.resolve(iterResult(undefined, true));
		}
	}

	#awaitReturn(g: AsyncGen): void {
		const next = g.queue[0];
		if (!next) throw new Error('no return request');
		this.performThen(
			this.promiseResolve(next.value),
			(v) => {
				g.queue.shift();
				next.cap.resolve(iterResult(v, true));
				this.#drainQueue(g);
				return undefined;
			},
			(e) => {
				g.queue.shift();
				next.cap.reject(e);
				this.#drainQueue(g);
				return undefined;
			},
			null
		);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The syntax tree of the shown programs.

type Expr =
	| { k: 'lit'; v: string | number | null }
	| { k: 'var'; name: string }
	| { k: 'detail' }
	| { k: 'message' }
	| { k: 'member'; obj: string; key: Expr }
	| { k: 'call'; fn: string }
	| { k: 'array'; items: Expr[] }
	| { k: 'object'; entries: [string, Expr][] }
	| { k: 'resolve'; v: Expr }
	| { k: 'timer'; ms: number; value: string; ok: boolean }
	| { k: 'bus' };

type Stmt =
	| { k: 'log'; parts: Expr[] }
	| { k: 'const'; name: string; e: Expr }
	| { k: 'call'; fn: string; then: string | null }
	| { k: 'await'; e: Expr; into: string | null }
	| { k: 'yield'; e: Expr; awaited: boolean }
	| { k: 'forOf'; name: string; list: Expr; body: Stmt[] }
	| { k: 'forAwait'; name: string; iter: Expr; body: Stmt[] }
	| { k: 'ifEq'; name: string; v: string | number; then: Stmt }
	| { k: 'break' }
	| { k: 'return' }
	| { k: 'throw'; message: string }
	| { k: 'try'; body: Stmt[]; catchBody: Stmt[] | null; finallyBody: Stmt[] | null }
	| { k: 'dispatch'; event: string; detail: Expr }
	| { k: 'chain'; logs: string[] }
	| { k: 'showThen'; it: string; call: 'next' | 'return'; arg: string | null; label: string }
	| { k: 'allThen'; name: string };

interface Fn {
	name: string;
	kind: 'async' | 'asyncGen';
	body: Stmt[];
}

interface Listener {
	async: boolean;
	once: boolean;
	body: Stmt[];
}

interface Program {
	helpers: { delay: boolean; fail: boolean };
	consts: { name: string; e: Expr }[];
	listeners: Listener[];
	fns: Fn[];
	top: Stmt[];
}

// Rendering.

function quote(v: string | number | null): string {
	return typeof v === 'string' ? `'${v}'` : String(v);
}

function renderExpr(e: Expr): string {
	switch (e.k) {
		case 'lit':
			return quote(e.v);
		case 'var':
			return e.name;
		case 'detail':
			return 'e.detail';
		case 'message':
			return 'error.message';
		case 'member':
			return `${e.obj}[${renderExpr(e.key)}]`;
		case 'call':
			return `${e.fn}()`;
		case 'array':
			return `[${e.items.map(renderExpr).join(', ')}]`;
		case 'object':
			return `{ ${e.entries.map(([key, v]) => `${key}: ${renderExpr(v)}`).join(', ')} }`;
		case 'resolve':
			return `Promise.resolve(${renderExpr(e.v)})`;
		case 'timer':
			return `${e.ok ? 'delay' : 'fail'}(${e.ms}, '${e.value}')`;
		case 'bus':
			return 'new EventTarget()';
	}
}

const logLine = (parts: readonly Expr[]): string => `console.log(${parts.map(renderExpr).join(', ')});`;

function renderStmts(stmts: readonly Stmt[], indent: string): string[] {
	return stmts.flatMap((s) => renderStmt(s, indent));
}

function renderStmt(s: Stmt, ind: string): string[] {
	const inner = `${ind}  `;
	switch (s.k) {
		case 'log':
			return [`${ind}${logLine(s.parts)}`];
		case 'const':
			return [`${ind}const ${s.name} = ${renderExpr(s.e)};`];
		case 'call':
			return [`${ind}${s.fn}()${s.then === null ? '' : `.then(() => console.log('${s.then}'))`};`];
		case 'await':
			return [`${ind}${s.into === null ? '' : `const ${s.into} = `}await ${renderExpr(s.e)};`];
		case 'yield':
			return [`${ind}yield ${s.awaited ? 'await ' : ''}${renderExpr(s.e)};`];
		case 'forOf':
			return [`${ind}for (const ${s.name} of ${renderExpr(s.list)}) {`, ...renderStmts(s.body, inner), `${ind}}`];
		case 'forAwait':
			return [`${ind}for await (const ${s.name} of ${renderExpr(s.iter)}) {`, ...renderStmts(s.body, inner), `${ind}}`];
		case 'ifEq':
			return [`${ind}if (${s.name} === ${quote(s.v)}) ${renderStmt(s.then, '')[0] ?? ''}`];
		case 'break':
			return [`${ind}break;`];
		case 'return':
			return [`${ind}return;`];
		case 'throw':
			return [`${ind}throw new Error('${s.message}');`];
		case 'try':
			return [
				`${ind}try {`,
				...renderStmts(s.body, inner),
				...(s.catchBody ? [`${ind}} catch (error) {`, ...renderStmts(s.catchBody, inner)] : []),
				...(s.finallyBody ? [`${ind}} finally {`, ...renderStmts(s.finallyBody, inner)] : []),
				`${ind}}`
			];
		case 'dispatch':
			return [`${ind}bus.dispatchEvent(new CustomEvent('${s.event}', { detail: ${renderExpr(s.detail)} }));`];
		case 'chain':
			return [`${ind}Promise.resolve()`, ...s.logs.map((l) => `${ind}  .then(() => console.log('${l}'))`), `${ind};`]
				.map((line, i, all) => (i === all.length - 2 ? `${line};` : line))
				.filter((line) => line.trim() !== ';');
		case 'showThen':
			return [
				`${ind}${s.it}.${s.call}(${s.arg === null ? '' : quote(s.arg)}).then((r) => console.log('${s.label}', r.value, r.done));`
			];
		case 'allThen':
			return [
				`${ind}Promise.all(${s.name}).then(`,
				`${ind}  (all) => console.log('all', all.join(' ')),`,
				`${ind}  (error) => console.log('all failed', error.message)`,
				`${ind});`
			];
	}
}

const DELAY_HELPER = [
	'function delay(ms, value) {',
	'  return new Promise((resolve) => {',
	'    setTimeout(() => {',
	"      console.log('ready', value);",
	'      resolve(value);',
	'    }, ms);',
	'  });',
	'}'
];

const FAIL_HELPER = [
	'function fail(ms, reason) {',
	'  return new Promise((resolve, reject) => {',
	'    setTimeout(() => {',
	"      console.log('failed', reason);",
	'      reject(new Error(reason));',
	'    }, ms);',
	'  });',
	'}'
];

function render(p: Program): string {
	const lines: string[] = [];
	if (p.helpers.delay) lines.push(...DELAY_HELPER, '');
	if (p.helpers.fail) lines.push(...FAIL_HELPER, '');
	for (const c of p.consts) lines.push(`const ${c.name} = ${renderExpr(c.e)};`);
	if (p.consts.length) lines.push('');
	for (const l of p.listeners) {
		const options = l.once ? ', { once: true }' : '';
		if (!l.async && l.body.length === 1 && l.body[0]?.k === 'log') {
			lines.push(`bus.addEventListener('save', (e) => ${logLine(l.body[0].parts).slice(0, -1)}${options});`);
		} else {
			lines.push(
				`bus.addEventListener('save', ${l.async ? 'async ' : ''}(e) => {`,
				...renderStmts(l.body, '  '),
				`}${options});`
			);
		}
	}
	if (p.listeners.length) lines.push('');
	for (const fn of p.fns) {
		lines.push(
			`async function${fn.kind === 'asyncGen' ? '*' : ''} ${fn.name}() {`,
			...renderStmts(fn.body, '  '),
			'}',
			''
		);
	}
	lines.push(...renderStmts(p.top, ''));
	return lines.join('\n');
}

// Interpretation.

/** `break` and `return` of the shown program, unwinding the interpreter through its `finally` blocks. */
class BreakSignal extends Error {}
class ReturnSignal extends Error {}

class Scope {
	readonly #vars = new Map<string, Value>();
	readonly #parent: Scope | null;
	constructor(parent: Scope | null) {
		this.#parent = parent;
	}
	get(name: string): Value {
		if (this.#vars.has(name)) return this.#vars.get(name);
		if (this.#parent) return this.#parent.get(name);
		throw new Error(`unknown name ${name}`);
	}
	set(name: string, v: Value): void {
		this.#vars.set(name, v);
	}
}

/** An iterator `for await` drives: an async generator, or the async-from-sync iterator of an array. */
type AsyncIter = { k: 'gen'; g: AsyncGen } | { k: 'sync'; items: Value[]; index: number };

class Interpreter {
	readonly engine: Engine;
	readonly #program: Program;
	readonly #globals = new Scope(null);
	readonly #listeners: Listener[];

	constructor(engine: Engine, program: Program) {
		this.engine = engine;
		this.#program = program;
		this.#listeners = [...program.listeners];
	}

	run(): void {
		const p = this.#program;
		for (const c of p.consts) this.#globals.set(c.name, this.#eval(c.e, this.#globals));
		const top = this.#exec(p.top, this.#globals, false);
		const r = top.next();
		if (!r.done) throw new Error('the top level awaits');
	}

	#eval(e: Expr, scope: Scope): Value {
		const engine = this.engine;
		switch (e.k) {
			case 'lit':
				return e.v;
			case 'var':
				return scope.get(e.name);
			case 'detail': {
				const event = scope.get('e');
				if (
					typeof event !== 'object' ||
					event === null ||
					Array.isArray(event) ||
					!('t' in event) ||
					event.t !== 'event'
				)
					throw new Error('e is not an event');
				return event.detail;
			}
			case 'message': {
				const error = scope.get('error');
				if (
					typeof error !== 'object' ||
					error === null ||
					Array.isArray(error) ||
					!('t' in error) ||
					error.t !== 'error'
				)
					throw new Error('error is not an Error');
				return error.message;
			}
			case 'member': {
				const obj = scope.get(e.obj);
				const key = this.#eval(e.key, scope);
				if (Array.isArray(obj) && typeof key === 'number') return obj[key];
				if (typeof obj === 'object' && obj !== null && !Array.isArray(obj) && 't' in obj && obj.t === 'object')
					return obj.entries.get(format(key));
				throw new Error(`no member ${format(key)}`);
			}
			case 'call':
				return this.#call(e.fn);
			case 'array':
				return e.items.map((item) => this.#eval(item, scope));
			case 'object':
				return { t: 'object', entries: new Map(e.entries.map(([key, v]) => [key, this.#eval(v, scope)])) };
			case 'resolve':
				return engine.promiseResolve(this.#eval(e.v, scope));
			case 'timer':
				return engine.timerPromise(e.ms, e.ok, e.value);
			case 'bus':
				return { t: 'bus' };
		}
	}

	#call(name: string): Value {
		const fn = this.#program.fns.find((f) => f.name === name);
		if (!fn) throw new Error(`no function ${name}`);
		const scope = new Scope(this.#globals);
		if (fn.kind === 'async') return this.engine.asyncCall(this.#body(fn.body, scope, false));
		return this.engine.makeGenerator(this.#body(fn.body, scope, true));
	}

	*#body(stmts: readonly Stmt[], scope: Scope, generator: boolean): Body {
		try {
			yield* this.#exec(stmts, scope, generator);
		} catch (error) {
			if (error instanceof ReturnSignal) return undefined;
			throw error;
		}
		return undefined;
	}

	*#exec(stmts: readonly Stmt[], scope: Scope, generator: boolean, inFinally = false): Generator<Cmd, void, Value> {
		for (const s of stmts) yield* this.#stmt(s, scope, generator, inFinally);
	}

	*#stmt(s: Stmt, scope: Scope, generator: boolean, inFinally: boolean): Generator<Cmd, void, Value> {
		const engine = this.engine;
		switch (s.k) {
			case 'log':
				engine.log(s.parts.map((part) => format(this.#eval(part, scope))).join(' '));
				return;
			case 'const':
				scope.set(s.name, this.#eval(s.e, scope));
				return;
			case 'call': {
				const result = this.#call(s.fn);
				const label = s.then;
				if (label !== null && result instanceof Prom)
					engine.then(
						result,
						() => {
							engine.log(label);
							return undefined;
						},
						null
					);
				return;
			}
			case 'await': {
				const v = this.#eval(s.e, scope);
				const x = inFinally && engine.rules.finallyAwaitIgnored ? v : yield { k: 'await', v };
				if (s.into !== null) scope.set(s.into, x);
				return;
			}
			case 'yield': {
				if (!generator) throw new Error('yield outside a generator');
				let v = this.#eval(s.e, scope);
				if (s.awaited) v = yield { k: 'await', v };
				yield { k: 'yield', v };
				return;
			}
			case 'forOf': {
				const list = this.#eval(s.list, scope);
				if (!Array.isArray(list)) throw new Error('for…of over a non-array');
				try {
					for (const item of list) {
						const inner = new Scope(scope);
						inner.set(s.name, item);
						yield* this.#exec(s.body, inner, generator, inFinally);
					}
				} catch (error) {
					if (!(error instanceof BreakSignal)) throw error;
				}
				return;
			}
			case 'forAwait':
				yield* this.#forAwait(s, scope, generator, inFinally);
				return;
			case 'ifEq': {
				const v = scope.get(s.name);
				if (v === s.v) yield* this.#stmt(s.then, scope, generator, inFinally);
				return;
			}
			case 'break':
				throw new BreakSignal();
			case 'return':
				throw new ReturnSignal();
			case 'throw':
				throw new Thrown({ t: 'error', message: s.message });
			case 'try': {
				try {
					try {
						yield* this.#exec(s.body, scope, generator, inFinally);
					} catch (error) {
						if (!(error instanceof Thrown) || !s.catchBody) throw error;
						const inner = new Scope(scope);
						inner.set('error', error.value);
						yield* this.#exec(s.catchBody, inner, generator, inFinally);
					}
				} finally {
					if (s.finallyBody) yield* this.#exec(s.finallyBody, scope, generator, true);
				}
				return;
			}
			case 'dispatch': {
				const detail = this.#eval(s.detail, scope);
				const call = (): Prom[] => this.#dispatch(detail);
				if (engine.rules.dispatchAsync) {
					engine.enqueue(() => {
						call();
					});
					return;
				}
				const pending = call();
				if (engine.rules.listenerAwaited && pending.length > 0) yield { k: 'await', v: engine.all(pending) };
				return;
			}
			case 'chain': {
				if (engine.rules.chainFirst) {
					engine.enqueue(() => {
						for (const line of s.logs) engine.log(line);
					});
					return;
				}
				let p = engine.promiseResolve(undefined);
				for (const line of s.logs) {
					p = engine.then(
						p,
						() => {
							engine.log(line);
							return undefined;
						},
						null
					);
				}
				return;
			}
			case 'showThen': {
				const g = scope.get(s.it);
				if (!(g instanceof AsyncGen)) throw new Error(`${s.it} is not a generator`);
				const promise = s.call === 'next' ? engine.next(g) : engine.return(g, s.arg);
				engine.then(
					promise,
					(r) => {
						if (typeof r !== 'object' || r === null || Array.isArray(r) || !('t' in r) || r.t !== 'iter')
							throw new Error('not an iterator result');
						engine.log(`${s.label} ${format(r.value)} ${r.done ? 'true' : 'false'}`);
						return undefined;
					},
					null
				);
				return;
			}
			case 'allThen': {
				const list = scope.get(s.name);
				if (!Array.isArray(list)) throw new Error('Promise.all over a non-array');
				engine.then(
					engine.all(list),
					(all) => {
						engine.log(`all ${Array.isArray(all) ? all.map(format).join(' ') : ''}`);
						return undefined;
					},
					(error) => {
						engine.log(
							`all failed ${typeof error === 'object' && error !== null && 't' in error && error.t === 'error' ? error.message : ''}`
						);
						return undefined;
					}
				);
				return;
			}
		}
	}

	/** `dispatchEvent`: every listener registered now, in order, synchronously; the promises of async listeners. */
	#dispatch(detail: Value): Prom[] {
		const pending: Prom[] = [];
		for (const listener of [...this.#listeners]) {
			if (listener.once && !this.engine.rules.onceIgnored) this.#listeners.splice(this.#listeners.indexOf(listener), 1);
			const scope = new Scope(this.#globals);
			scope.set('e', { t: 'event', detail });
			if (listener.async) pending.push(this.engine.asyncCall(this.#body(listener.body, scope, false)));
			else {
				const r = this.#exec(listener.body, scope, false).next();
				if (!r.done) throw new Error('a synchronous listener awaits');
			}
		}
		return pending;
	}

	*#forAwait(
		s: Extract<Stmt, { k: 'forAwait' }>,
		scope: Scope,
		generator: boolean,
		inFinally: boolean
	): Generator<Cmd, void, Value> {
		const engine = this.engine;
		const source = this.#eval(s.iter, scope);
		let iter: AsyncIter;
		if (source instanceof AsyncGen) iter = { k: 'gen', g: source };
		else if (Array.isArray(source)) iter = { k: 'sync', items: source, index: 0 };
		else throw new Error('for await over a non-iterable');
		for (;;) {
			let result: IterResult;
			if (
				iter.k === 'sync' &&
				engine.rules.plainNoWait &&
				iter.index < iter.items.length &&
				!(iter.items[iter.index] instanceof Prom)
			) {
				result = iterResult(iter.items[iter.index], false);
				iter.index += 1;
			} else {
				const r = yield { k: 'await', v: this.#next(iter) };
				if (typeof r !== 'object' || r === null || Array.isArray(r) || !('t' in r) || r.t !== 'iter')
					throw new Error('next() gave no iterator result');
				result = r;
			}
			if (result.done) return;
			const inner = new Scope(scope);
			inner.set(s.name, result.value);
			try {
				yield* this.#exec(s.body, inner, generator, inFinally);
			} catch (error) {
				if (error instanceof BreakSignal) {
					yield* this.#close(iter, false);
					return;
				}
				if (error instanceof Thrown && engine.rules.throwSkipsClose) throw error;
				if (error instanceof Thrown && engine.rules.catchBeforeClose) {
					this.#closeLater(iter);
					throw error;
				}
				yield* this.#close(iter, error instanceof Thrown);
				throw error;
			}
		}
	}

	#next(iter: AsyncIter): Prom {
		const engine = this.engine;
		if (iter.k === 'gen') return engine.next(iter.g);
		// %AsyncFromSyncIteratorPrototype%.next: the value is awaited, then the iterator result is made.
		const done = iter.index >= iter.items.length;
		const value = done ? undefined : iter.items[iter.index];
		if (!done) iter.index += 1;
		const cap = engine.capability();
		engine.performThen(engine.promiseResolve(value), (v) => iterResult(v, done), null, cap);
		return cap.promise;
	}

	/** AsyncIteratorClose: `return()` is called and awaited; for a throw completion its outcome is ignored. */
	*#close(iter: AsyncIter, throwing: boolean): Generator<Cmd, void, Value> {
		const engine = this.engine;
		const ret = this.#returnOf(iter);
		if (engine.rules.afterLoopFirst) return;
		try {
			yield { k: 'await', v: ret };
		} catch (error) {
			if (!throwing) throw error;
		}
	}

	#closeLater(iter: AsyncIter): void {
		this.engine.then(this.#returnOf(iter), null, () => undefined);
	}

	#returnOf(iter: AsyncIter): Prom {
		const engine = this.engine;
		if (iter.k === 'gen') return engine.return(iter.g, undefined);
		const cap = engine.capability();
		cap.resolve(iterResult(undefined, true));
		return cap.promise;
	}
}

/** The output of the program under the rules, or `null` when the program leaves a rejection unhandled. */
function execute(p: Program, rules: Rules, strict: boolean): string[] | null {
	const engine = new Engine(rules, strict);
	try {
		engine.run(() => {
			new Interpreter(engine, p).run();
		});
	} catch (error) {
		if (error instanceof Unsupported) return null;
		throw error;
	}
	return engine.out;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios of the classes.

const DELAYS = Array.from({ length: 15 }, (_, i) => 20 * (i + 1));
const WORDS = ['red', 'blue', 'gold', 'gray', 'pink', 'teal', 'lime', 'navy', 'rust', 'mint'] as const;

const lit = (v: string | number | null): Expr => ({ k: 'lit', v });
const ref = (name: string): Expr => ({ k: 'var', name });
const log = (...parts: Expr[]): Stmt => ({ k: 'log', parts });
const say = (text: string, ...rest: Expr[]): Stmt => log(lit(text), ...rest);
const timer = (ms: number, value: string, ok = true): Expr => ({ k: 'timer', ms, value, ok });

function lazyPull(rng: Rng): Program {
	const count = rng.int(3, 4);
	const delays = rng.sample(DELAYS, count * 2);
	const pages = Array.from({ length: count }, (_, i) => `p${i + 1}`);
	const consts = [
		{ name: 'pages', e: { k: 'array', items: pages.map((page, i) => timer(delays[i] ?? 20, page)) } as Expr },
		{
			name: 'work',
			e: { k: 'object', entries: pages.map((page, i) => [page, timer(delays[count + i] ?? 40, `w${i + 1}`)]) } as Expr
		}
	];
	const feed: Fn = {
		name: 'feed',
		kind: 'asyncGen',
		body: [
			say('feed start'),
			{
				k: 'forOf',
				name: 'page',
				list: ref('pages'),
				body: [
					{ k: 'await', e: ref('page'), into: 'data' },
					say('feed got', ref('data')),
					{ k: 'yield', e: ref('data'), awaited: false }
				]
			},
			say('feed end')
		]
	};
	const main: Fn = {
		name: 'main',
		kind: 'async',
		body: [
			{ k: 'const', name: 'stream', e: { k: 'call', fn: 'feed' } },
			say('stream created'),
			{
				k: 'forAwait',
				name: 'data',
				iter: ref('stream'),
				body: [say('use', ref('data')), { k: 'await', e: { k: 'member', obj: 'work', key: ref('data') }, into: null }]
			},
			say('main end')
		]
	};
	return {
		helpers: { delay: true, fail: false },
		consts,
		listeners: [],
		fns: [feed, main],
		top: [{ k: 'call', fn: 'main', then: null }, say('sync end')]
	};
}

function earlyBreak(rng: Rng): Program {
	const values = rng.sample([1, 2, 3, 4, 5, 6, 7, 8, 9], rng.int(4, 5));
	const stopAt = values[rng.int(0, values.length - 2)] ?? 1;
	const viaReturn = rng.bool(0.35);
	const pause = rng.bool(0.5);
	const gen: Fn = {
		name: 'numbers',
		kind: 'asyncGen',
		body: [
			say('gen start'),
			{
				k: 'try',
				body: [
					{
						k: 'forOf',
						name: 'n',
						list: { k: 'array', items: values.map(lit) },
						body: [say('gen yield', ref('n')), { k: 'yield', e: ref('n'), awaited: false }]
					},
					say('gen done')
				],
				catchBody: null,
				finallyBody: [say('gen finally')]
			}
		]
	};
	const loopBody: Stmt[] = [
		say('main got', ref('n')),
		{ k: 'ifEq', name: 'n', v: stopAt, then: viaReturn ? { k: 'return' } : { k: 'break' } }
	];
	if (pause) loopBody.push({ k: 'await', e: ref('tick'), into: null });
	const main: Fn = {
		name: 'main',
		kind: 'async',
		body: [{ k: 'forAwait', name: 'n', iter: { k: 'call', fn: 'numbers' }, body: loopBody }, say('main after loop')]
	};
	return {
		helpers: { delay: pause, fail: false },
		consts: pause ? [{ name: 'tick', e: timer(rng.pick(DELAYS), 'tick') }] : [],
		listeners: [],
		fns: [gen, main],
		top: [{ k: 'call', fn: 'main', then: 'main resolved' }, say('sync end')]
	};
}

function arrayLoop(rng: Rng): Program {
	const count = rng.int(4, 5);
	const delays = rng.sample(DELAYS, count);
	const names = ['a', 'b', 'c', 'd', 'e'];
	const failing = rng.bool(0.4) ? rng.int(1, count - 1) : -1;
	let timers = 0;
	const items: Expr[] = names.slice(0, count).map((name, i) => {
		if (i === failing) return timer(delays[i] ?? 20, name, false);
		const kind = rng.pick(['timer', 'timer', 'plain', 'resolved'] as const);
		if (kind === 'timer' || (i === count - 1 && timers < 2)) {
			timers += 1;
			return timer(delays[i] ?? 20, name);
		}
		return kind === 'plain' ? lit(name) : { k: 'resolve', v: lit(name) };
	});
	const loop: Stmt = { k: 'forAwait', name: 'job', iter: ref('jobs'), body: [say('got', ref('job'))] };
	const body: Stmt[] =
		failing >= 0
			? [
					say('main start'),
					{
						k: 'try',
						body: [loop, say('loop done')],
						catchBody: [say('caught', { k: 'message' })],
						finallyBody: null
					},
					say('main end')
				]
			: [say('main start'), loop, say('main end')];
	return {
		helpers: { delay: true, fail: failing >= 0 },
		consts: [{ name: 'jobs', e: { k: 'array', items } }],
		listeners: [],
		fns: [{ name: 'main', kind: 'async', body }],
		top: [{ k: 'call', fn: 'main', then: null }, { k: 'allThen', name: 'jobs' }, say('sync end')]
	};
}

function eventTarget(rng: Rng): Program {
	const count = rng.int(2, 3);
	const delays = rng.sample(DELAYS, count + 1);
	const ticks = Array.from({ length: count }, (_, i) => timer(delays[i] ?? 20, `t${i + 1}`));
	const asyncWaits = rng.bool(0.5) ? ref('flush') : lit(null);
	const listeners: Listener[] = rng.shuffle([
		{ async: false, once: false, body: [say('A got', { k: 'detail' })] },
		{
			async: true,
			once: false,
			body: [say('B start', { k: 'detail' }), { k: 'await', e: asyncWaits, into: null }, say('B end', { k: 'detail' })]
		},
		{ async: false, once: true, body: [say('C got', { k: 'detail' })] }
	]);
	const gen: Fn = {
		name: 'ticks',
		kind: 'asyncGen',
		body: [
			{
				k: 'forOf',
				name: 't',
				list: ref('times'),
				body: [{ k: 'yield', e: ref('t'), awaited: false }]
			}
		]
	};
	const main: Fn = {
		name: 'main',
		kind: 'async',
		body: [
			{
				k: 'forAwait',
				name: 'n',
				iter: { k: 'call', fn: 'ticks' },
				body: [
					say('dispatch', ref('n')),
					{ k: 'dispatch', event: 'save', detail: ref('n') },
					say('after dispatch', ref('n'))
				]
			},
			say('main end')
		]
	};
	return {
		helpers: { delay: true, fail: false },
		consts: [
			{ name: 'bus', e: { k: 'bus' } },
			{ name: 'times', e: { k: 'array', items: ticks } },
			...(asyncWaits.k === 'var' ? [{ name: 'flush', e: timer(delays[count] ?? 40, 'flush') }] : [])
		],
		listeners,
		fns: [gen, main],
		top: [{ k: 'call', fn: 'main', then: null }, say('sync end')]
	};
}

function tickInterleave(rng: Rng): Program {
	const count = rng.int(3, 5);
	const values = rng.sample(WORDS, count);
	const body: Stmt[] = [];
	for (let i = 0; i < count; i += 1) {
		const v = values[i] ?? 'z';
		body.push(say(`gen ${i + 1}`));
		const kind = rng.pick(['plain', 'promise', 'awaited', 'pause'] as const);
		if (kind === 'plain') body.push({ k: 'yield', e: lit(v), awaited: false });
		else if (kind === 'promise') body.push({ k: 'yield', e: { k: 'resolve', v: lit(v) }, awaited: false });
		else if (kind === 'awaited') body.push({ k: 'yield', e: { k: 'resolve', v: lit(v) }, awaited: true });
		else body.push({ k: 'await', e: lit(null), into: null }, { k: 'yield', e: lit(v), awaited: false });
	}
	const main: Fn = {
		name: 'main',
		kind: 'async',
		body: [
			{ k: 'forAwait', name: 'v', iter: { k: 'call', fn: 'source' }, body: [say('got', ref('v'))] },
			say('main done')
		]
	};
	const chain: Stmt = { k: 'chain', logs: Array.from({ length: rng.int(4, 7) }, (_, i) => `tick ${i + 1}`) };
	const top: Stmt[] = rng.bool(0.5)
		? [{ k: 'call', fn: 'main', then: null }, chain, say('sync end')]
		: [chain, { k: 'call', fn: 'main', then: null }, say('sync end')];
	return {
		helpers: { delay: false, fail: false },
		consts: [],
		listeners: [],
		fns: [{ name: 'source', kind: 'asyncGen', body }, main],
		top
	};
}

function requestQueue(rng: Rng): Program {
	const words = rng.sample(WORDS, 5);
	const steps = words.slice(0, rng.int(2, 4));
	const stop = words[4] ?? 'stop';
	const inner: Stmt[] = [];
	steps.forEach((v, i) => {
		inner.push(say(`step ${i + 1}`));
		if (rng.bool(0.4)) inner.push({ k: 'await', e: lit(null), into: null });
		inner.push({ k: 'yield', e: lit(v), awaited: false });
	});
	inner.push(say('gen end'));
	const gen: Fn = {
		name: 'steps',
		kind: 'asyncGen',
		body: [say('gen start'), { k: 'try', body: inner, catchBody: null, finallyBody: [say('gen finally')] }]
	};
	const count = rng.int(4, 6);
	const returnAt = rng.int(1, count - 2);
	const calls: Stmt[] = [];
	let nexts = 0;
	for (let i = 0; i < count; i += 1) {
		if (i === returnAt) calls.push({ k: 'showThen', it: 'it', call: 'return', arg: stop, label: 'return' });
		else {
			nexts += 1;
			calls.push({ k: 'showThen', it: 'it', call: 'next', arg: null, label: `next ${nexts}` });
		}
	}
	return {
		helpers: { delay: false, fail: false },
		consts: [],
		listeners: [],
		fns: [gen],
		top: [{ k: 'const', name: 'it', e: { k: 'call', fn: 'steps' } }, ...calls, say('sync end')]
	};
}

function breakAsyncFinally(rng: Rng): Program {
	const delays = rng.sample(DELAYS, 3);
	const chunks = rng.sample(WORDS, rng.int(3, 5));
	const stopAt = chunks[rng.int(0, chunks.length - 2)] ?? 'red';
	const reader: Fn = {
		name: 'reader',
		kind: 'asyncGen',
		body: [
			{
				k: 'try',
				body: [
					{
						k: 'forOf',
						name: 'chunk',
						list: { k: 'array', items: chunks.map(lit) },
						body: [say('read', ref('chunk')), { k: 'yield', e: ref('chunk'), awaited: false }]
					}
				],
				catchBody: null,
				finallyBody: [say('cleanup start'), { k: 'await', e: ref('flush'), into: null }, say('cleanup end')]
			}
		]
	};
	const main: Fn = {
		name: 'main',
		kind: 'async',
		body: [
			{
				k: 'forAwait',
				name: 'chunk',
				iter: { k: 'call', fn: 'reader' },
				body: [
					say('use', ref('chunk')),
					{ k: 'ifEq', name: 'chunk', v: stopAt, then: { k: 'break' } },
					{ k: 'await', e: ref('pause'), into: null }
				]
			},
			say('after loop')
		]
	};
	return {
		helpers: { delay: true, fail: false },
		consts: [
			{ name: 'flush', e: timer(delays[0] ?? 20, 'flush') },
			{ name: 'pause', e: timer(delays[1] ?? 40, 'pause') },
			{ name: 'other', e: timer(delays[2] ?? 60, 'other') }
		],
		listeners: [],
		fns: [reader, main],
		top: [{ k: 'call', fn: 'main', then: 'main resolved' }, say('sync end')]
	};
}

function throwInLoop(rng: Rng): Program {
	const values = rng.sample([1, 2, 3, 4, 5, 6, 7, 8, 9], 4);
	const stopAt = values[rng.int(0, 2)] ?? 1;
	const finallyBody: Stmt[] = [say('source finally')];
	if (rng.bool(0.5)) finallyBody.push({ k: 'await', e: lit(null), into: null }, say('source closed'));
	const source: Fn = {
		name: 'source',
		kind: 'asyncGen',
		body: [
			{
				k: 'try',
				body: [
					{
						k: 'forOf',
						name: 'v',
						list: { k: 'array', items: values.map(lit) },
						body: [say('source yield', ref('v')), { k: 'yield', e: ref('v'), awaited: false }]
					}
				],
				catchBody: null,
				finallyBody
			}
		]
	};
	const main: Fn = {
		name: 'main',
		kind: 'async',
		body: [
			{
				k: 'try',
				body: [
					{
						k: 'forAwait',
						name: 'v',
						iter: { k: 'call', fn: 'source' },
						body: [
							say('got', ref('v')),
							{ k: 'ifEq', name: 'v', v: stopAt, then: { k: 'throw', message: 'bad value' } }
						]
					}
				],
				catchBody: [say('caught', { k: 'message' })],
				finallyBody: [say('main finally')]
			},
			say('main end')
		]
	};
	const chain: Stmt = { k: 'chain', logs: Array.from({ length: rng.int(3, 6) }, (_, i) => `tick ${i + 1}`) };
	return {
		helpers: { delay: false, fail: false },
		consts: [],
		listeners: [],
		fns: [source, main],
		top: [{ k: 'call', fn: 'main', then: null }, ...(rng.bool(0.6) ? [chain] : []), say('sync end')]
	};
}

const GENERATORS: Record<string, (rng: Rng) => Program> = {
	'lazy-pull': lazyPull,
	'early-break': earlyBreak,
	'array-loop': arrayLoop,
	'event-target': eventTarget,
	'tick-interleave': tickInterleave,
	'request-queue': requestQueue,
	'break-async-finally': breakAsyncFinally,
	'throw-in-loop': throwInLoop
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/lazy-pull': ['eager-generator', 'push-ahead', 'timers-on-await'],
	'middle/early-break': ['return-skips-finally', 'after-loop-first'],
	'middle/array-loop': ['resolution-order', 'timers-on-await'],
	'middle/event-target': ['dispatch-async', 'listener-awaited'],
	'senior/tick-interleave': ['yield-no-await', 'chain-first'],
	'senior/request-queue': ['return-immediate', 'return-skips-finally'],
	'senior/break-async-finally': ['finally-await-ignored', 'after-loop-first'],
	'senior/throw-in-loop': ['throw-skips-close', 'catch-before-close']
};

/**
 * Misconceptions about what the code means rather than how the machinery runs: the program as the misconception
 * reads it.
 */
function variants(p: Program): Record<string, Program> {
	const jobs = p.consts.find((c) => c.name === 'jobs');
	if (!jobs || jobs.e.k !== 'array') return {};
	// `for await` over the array as if it went in the order the elements settle: plain values first.
	const settleAt = (e: Expr): number => (e.k === 'timer' ? e.ms : 0);
	const sorted = [...jobs.e.items].map((e, i) => ({ e, i })).sort((a, b) => settleAt(a.e) - settleAt(b.e) || a.i - b.i);
	const reordered: Program = {
		...p,
		fns: p.fns.map((fn) => ({
			...fn,
			body: replaceIter(
				fn.body,
				sorted.map((x) => x.i)
			)
		}))
	};
	return { 'resolution-order': reordered };
}

/** The loop over `jobs` rewritten to visit the elements in the given order (by index). */
function replaceIter(stmts: readonly Stmt[], order: readonly number[]): Stmt[] {
	return stmts.map((s): Stmt => {
		if (s.k === 'forAwait' && s.iter.k === 'var' && s.iter.name === 'jobs') {
			return { ...s, iter: { k: 'array', items: order.map((i) => ({ k: 'member', obj: 'jobs', key: lit(i) })) } };
		}
		if (s.k === 'try') return { ...s, body: replaceIter(s.body, order) };
		return s;
	});
}

const STATEMENT = [
	'Что напечатает программа? Её запускают в Node.js 24; промисы, `setTimeout`, асинхронные генераторы и `EventTarget`',
	'ведут себя так же, как в браузере. Задержки таймеров отличаются не меньше чем на 20 мс, а сама программа выполняется',
	'мгновенно, поэтому таймеры срабатывают строго в порядке своих задержек.',
	'',
	'Введите вывод построчно, как он появится на экране.'
].join('\n');

interface Candidate {
	source: string;
	answer: string[];
	wrong: Record<string, string[] | null>;
}

function candidate(p: Program): Candidate | null {
	const answer = execute(p, RIGHT, true);
	if (answer === null) return null;
	const readings = variants(p);
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const reading = readings[id];
			const value = reading ? execute(reading, RIGHT, false) : execute(p, { ...RIGHT, ...change }, false);
			const same = value === null || (value.length === answer.length && value.every((line, i) => line === answer[i]));
			return [id, same ? null : value];
		})
	);
	return { source: render(p), answer, wrong };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const draw = GENERATORS[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no generator for ${input.classId}`);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Programs are drawn until every misconception the class is about changes the output; the best draw stands in
	// when none does (it still carries the wrong answers that apply).
	let best: { c: Candidate; applicable: number } | null = null;
	for (let tries = 0; tries < 300; tries += 1) {
		const c = candidate(draw(rng));
		if (c === null) continue;
		const applicable = required.filter((id) => c.wrong[id] !== null).length;
		if (best === null || applicable > best.applicable) best = { c, applicable };
		if (applicable === required.length) break;
	}
	if (best === null) throw new Error(`${descriptor.key}: no program for ${input.grade}/${input.classId}`);
	const c = best.c;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: STATEMENT, code: { language: 'javascript', source: c.source } },
		answer: { kind: 'sequence', value: c.answer }
	});
	return {
		instance,
		reference: () => nodeOutputProbe(c.source, 'javascript'),
		wrong: () =>
			Object.fromEntries(
				Object.entries(c.wrong).map(([id, value]) => [
					id,
					value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
