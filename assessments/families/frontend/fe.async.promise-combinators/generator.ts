// Promise combinators against timers of different lengths: which handlers run, with which values and in which order.
// `Promise.all` rejects at the first rejection while the other promises go on, `allSettled` and `all` keep the order of
// their arguments, `race` takes the first settled and `any` the first fulfilled (or an `AggregateError` with the
// reasons in the order of the arguments); a level up, nested combinators, `finally` that passes the result through or
// overrides it, and late settlements after a combinator has settled.
//
// The generator models the promise machinery of ECMAScript job by job (reaction jobs, resolve-thenable jobs, the
// combinators and `finally` as the specification writes them) and timers as Node runs them; the gate runs every shown
// program with Node and compares the output. Every timer is set while the script itself runs, with delays at least
// 20 ms apart, so the order of the timers never depends on the load of the machine.
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
// Values and promises of the model.

interface ErrorValue {
	t: 'error';
	message: string;
	/** The reasons of an `AggregateError`; `null` for a plain `Error`. */
	errors: Value[] | null;
}

interface SettledValue {
	t: 'settled';
	ok: boolean;
	value: Value;
}

type Value = string | undefined | Value[] | ErrorValue | SettledValue | Prom;

/** An exception thrown by a handler of the shown program, carrying the thrown value. */
class Thrown extends Error {
	readonly value: Value;
	constructor(value: Value) {
		super('a thrown value');
		this.value = value;
	}
}

/** A construct or an outcome the scenarios must not produce (an unhandled rejection): the program is drawn again. */
class Unsupported extends Error {}

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
	/** Every reaction ever attached: a misconception that lets a promise settle twice replays them. */
	readonly attached: [Reaction, Reaction][] = [];
	/** The timer that settles a leaf promise (`delay`, `fail`, the timeout of `withTimeout`). */
	timer: Timer | null = null;
}

interface Timer {
	at: number;
	seq: number;
	cancelled: boolean;
	run: () => void;
}

const errorValue = (message: string): ErrorValue => ({ t: 'error', message, errors: null });

/** `show(x)` of the shown programs. */
function show(x: Value): string {
	if (Array.isArray(x)) return `[${x.map(show).join(' ')}]`;
	if (x instanceof Prom) throw new Error('a promise is never shown');
	if (typeof x === 'object') {
		if (x.t === 'error') return x.errors ? `AggregateError[${x.errors.map(show).join(' ')}]` : `Error(${x.message})`;
		return `${x.ok ? 'fulfilled' : 'rejected'}(${show(x.value)})`;
	}
	return String(x);
}

// ---------------------------------------------------------------------------------------------------------------
// Misconceptions as rules of the machinery.

interface Rules {
	/** `Promise.all` rejects only after every input has settled. */
	allWaitsAll: boolean;
	/** A settled combinator cancels its pending inputs: their timers never fire. */
	cancelOnSettle: boolean;
	/** `all` and `allSettled` list the results in the order the inputs settled. */
	completionOrder: boolean;
	/** `race` waits for the first fulfilment, as `any` does. */
	raceSkipsRejections: boolean;
	/** `any` takes the first settled input, even a rejection, as `race` does. */
	anyFirstSettled: boolean;
	/** `AggregateError.errors` lists the reasons in the order of the rejections. */
	aggregateCompletionOrder: boolean;
	/** A handler of an already settled promise runs at once, inside `then`. */
	handlersSync: boolean;
	/** A value (or the value of a promise) returned from `finally` replaces the result. */
	finallyReplaces: boolean;
	/** `finally` does not wait for the promise its callback returns. */
	finallyNoWait: boolean;
	/** An exception in `finally` is ignored: the original result passes. */
	finallyThrowIgnored: boolean;
	/** A combinator settles again on every later settlement of its inputs. */
	lateResettle: boolean;
}

const RIGHT: Rules = {
	allWaitsAll: false,
	cancelOnSettle: false,
	completionOrder: false,
	raceSkipsRejections: false,
	anyFirstSettled: false,
	aggregateCompletionOrder: false,
	handlersSync: false,
	finallyReplaces: false,
	finallyNoWait: false,
	finallyThrowIgnored: false,
	lateResettle: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'all-waits-all': { allWaitsAll: true },
	'cancel-on-settle': { cancelOnSettle: true },
	'completion-order': { completionOrder: true },
	'race-skips-rejections': { raceSkipsRejections: true },
	'any-first-settled': { anyFirstSettled: true },
	'aggregate-completion-order': { aggregateCompletionOrder: true },
	'handlers-sync': { handlersSync: true },
	'finally-replaces': { finallyReplaces: true },
	'finally-no-wait': { finallyNoWait: true },
	'finally-throw-ignored': { finallyThrowIgnored: true },
	'late-resettle': { lateResettle: true }
};

type Op = 'all' | 'allSettled' | 'race' | 'any';

class Engine {
	readonly out: string[] = [];
	readonly #rules: Rules;
	readonly #strict: boolean;
	readonly #jobs: (() => void)[] = [];
	readonly #timers: Timer[] = [];
	readonly #unhandled: Prom[] = [];
	#seq = 0;
	#steps = 0;

	/** `strict` — the true machinery: an unhandled rejection would end the Node process, so it rejects the program. */
	constructor(rules: Rules, strict: boolean) {
		this.#rules = rules;
		this.#strict = strict;
	}

	log(line: string): void {
		this.out.push(line);
	}

	#enqueue(job: () => void): void {
		this.#jobs.push(job);
	}

	/** Runs the script's jobs, then the timers in order of their moments, draining the jobs after each. */
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
			next.run();
			this.#drain();
		}
	}

	#drain(): void {
		while (this.#jobs.length > 0) {
			if ((this.#steps += 1) > 20_000) throw new Unsupported('runaway jobs');
			(this.#jobs.shift() as () => void)();
		}
		if (this.#strict && this.#unhandled.some((p) => !p.handled)) throw new Unsupported('unhandled rejection');
		this.#unhandled.length = 0;
	}

	setTimeout(ms: number, run: () => void): Timer {
		const timer: Timer = { at: ms, seq: (this.#seq += 1), cancelled: false, run };
		this.#timers.push(timer);
		return timer;
	}

	/** The resolving functions of a promise; `multi` — a misconception lets them settle it again. */
	resolvers(p: Prom, multi = false): Capability {
		let already = false;
		return {
			promise: p,
			resolve: (x) => {
				if (already && !multi) return;
				already = true;
				this.#resolvePromise(p, x, multi);
			},
			reject: (reason) => {
				if (already && !multi) return;
				already = true;
				this.#settle(p, 'rejected', reason, multi);
			}
		};
	}

	capability(multi = false): Capability {
		return this.resolvers(new Prom(), multi);
	}

	#resolvePromise(p: Prom, x: Value, multi: boolean): void {
		if (x instanceof Prom) {
			// NewPromiseResolveThenableJob: the resolution's `then` is called on a job of its own.
			this.#enqueue(() => {
				const r = this.resolvers(p, multi);
				this.then(x, r.resolve as Handler, r.reject as Handler);
			});
			return;
		}
		this.#settle(p, 'fulfilled', x, multi);
	}

	#settle(p: Prom, state: 'fulfilled' | 'rejected', value: Value, multi: boolean): void {
		if (p.state !== 'pending') {
			if (!multi) return;
			p.state = state;
			p.value = value;
			for (const [f, r] of p.attached) {
				const reaction = state === 'fulfilled' ? f : r;
				this.#enqueue(() => {
					this.#job(reaction, value);
				});
			}
			return;
		}
		p.state = state;
		p.value = value;
		const reactions = state === 'fulfilled' ? p.fulfillReactions : p.rejectReactions;
		p.fulfillReactions = [];
		p.rejectReactions = [];
		if (state === 'rejected' && !p.handled) this.#unhandled.push(p);
		for (const reaction of reactions) {
			this.#enqueue(() => {
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
		const f: Reaction = { cap, kind: 'fulfill', handler: onFulfilled };
		const r: Reaction = { cap, kind: 'reject', handler: onRejected };
		p.attached.push([f, r]);
		p.handled = true;
		if (p.state === 'pending') {
			p.fulfillReactions.push(f);
			p.rejectReactions.push(r);
			return;
		}
		const reaction = p.state === 'fulfilled' ? f : r;
		const value = p.value;
		if (this.#rules.handlersSync) this.#job(reaction, value);
		else
			this.#enqueue(() => {
				this.#job(reaction, value);
			});
	}

	then(p: Prom, onFulfilled: Handler | null, onRejected: Handler | null): Prom {
		const cap = this.capability();
		this.performThen(p, onFulfilled, onRejected, cap);
		return cap.promise;
	}

	/** `Promise.resolve(x)`: a promise is returned as it is. */
	promiseResolve(x: Value): Prom {
		if (x instanceof Prom) return x;
		const cap = this.capability();
		cap.resolve(x);
		return cap.promise;
	}

	promiseReject(reason: Value): Prom {
		const cap = this.capability();
		cap.reject(reason);
		return cap.promise;
	}

	/** A leaf: a promise settled by a timer, logging when it fires. */
	leaf(ms: number, ok: boolean, value: string, line: string): Prom {
		const cap = this.capability();
		cap.promise.timer = this.setTimeout(ms, () => {
			cap.promise.timer = null;
			this.log(line);
			if (ok) cap.resolve(value);
			else cap.reject(errorValue(value));
		});
		return cap.promise;
	}

	combinator(op: Op, items: readonly Value[]): Prom {
		const rules = this.#rules;
		const effective: Op =
			op === 'race' && rules.raceSkipsRejections ? 'any' : op === 'any' && rules.anyFirstSettled ? 'race' : op;
		const cap = this.capability(rules.lateResettle);
		const inputs = items.map((item) => this.promiseResolve(item));
		const settled = { done: false };
		const wrap =
			(fn: (v: Value) => void) =>
			(v: Value): void => {
				if (rules.cancelOnSettle && !settled.done) {
					settled.done = true;
					for (const input of inputs) if (input.timer) input.timer.cancelled = true;
				}
				fn(v);
			};
		const resolve = wrap(cap.resolve);
		const reject = wrap(cap.reject);
		const values: Value[] = [];
		const completion: number[] = [];
		const rejections: number[] = [];
		let remaining = 1;
		const ordered = (list: Value[], order: number[], byCompletion: boolean): Value[] =>
			byCompletion ? order.map((i) => list[i]) : list;
		const finish = (): void => {
			if (effective === 'all') {
				if (rules.allWaitsAll && rejections.length > 0) reject(values[rejections[0] ?? 0]);
				else resolve(ordered(values, completion, rules.completionOrder));
			} else if (effective === 'allSettled') resolve(ordered(values, completion, rules.completionOrder));
			else if (effective === 'any') {
				const errors = ordered(values, rejections, rules.aggregateCompletionOrder);
				reject({ t: 'error', message: 'All promises were rejected', errors });
			}
		};
		inputs.forEach((input, i) => {
			values.push(undefined);
			remaining += 1;
			let called = false;
			const once =
				(fn: (x: Value) => void): Handler =>
				(x) => {
					if (called) return undefined;
					called = true;
					fn(x);
					return undefined;
				};
			let onFulfilled: Handler;
			let onRejected: Handler;
			switch (effective) {
				case 'all':
					onFulfilled = once((x) => {
						values[i] = x;
						completion.push(i);
						if ((remaining -= 1) === 0) finish();
					});
					onRejected = rules.allWaitsAll
						? once((x) => {
								values[i] = x;
								rejections.push(i);
								if ((remaining -= 1) === 0) finish();
							})
						: (x) => {
								reject(x);
								return undefined;
							};
					break;
				case 'allSettled':
					onFulfilled = once((x) => {
						values[i] = { t: 'settled', ok: true, value: x };
						completion.push(i);
						if ((remaining -= 1) === 0) finish();
					});
					onRejected = once((x) => {
						values[i] = { t: 'settled', ok: false, value: x };
						completion.push(i);
						if ((remaining -= 1) === 0) finish();
					});
					break;
				case 'race':
					onFulfilled = (x) => {
						resolve(x);
						return undefined;
					};
					onRejected = (x) => {
						reject(x);
						return undefined;
					};
					break;
				case 'any':
					onFulfilled = (x) => {
						resolve(x);
						return undefined;
					};
					onRejected = once((x) => {
						values[i] = x;
						rejections.push(i);
						if ((remaining -= 1) === 0) finish();
					});
			}
			this.then(input, onFulfilled, onRejected);
		});
		if ((remaining -= 1) === 0) finish();
		return cap.promise;
	}

	/** `p.finally(callback)` as the specification writes it; `callback` returns its value or throws `Thrown`. */
	finally(p: Prom, callback: () => Value): Prom {
		const rules = this.#rules;
		const call = (): Value => {
			try {
				return callback();
			} catch (error) {
				if (error instanceof Thrown && rules.finallyThrowIgnored) return undefined;
				throw error;
			}
		};
		const thenFinally: Handler = (value) => {
			const result = call();
			if (rules.finallyNoWait) return rules.finallyReplaces && result !== undefined ? result : value;
			const promise = this.promiseResolve(result);
			return this.then(promise, (x) => (rules.finallyReplaces && x !== undefined ? x : value), null);
		};
		const catchFinally: Handler = (reason) => {
			const result = call();
			if (rules.finallyNoWait) {
				if (rules.finallyReplaces && result !== undefined) return result;
				throw new Thrown(reason);
			}
			const promise = this.promiseResolve(result);
			return this.then(
				promise,
				(x) => {
					if (rules.finallyReplaces && x !== undefined) return x;
					throw new Thrown(reason);
				},
				null
			);
		};
		return this.then(p, thenFinally, catchFinally);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Programs: the JavaScript source and the model's actions, built side by side.

const HELPERS = [
	'function delay(ms, value) {',
	'  return new Promise((resolve) => {',
	'    setTimeout(() => {',
	"      console.log('resolve', value);",
	'      resolve(value);',
	'    }, ms);',
	'  });',
	'}',
	'',
	'function fail(ms, reason) {',
	'  return new Promise((resolve, reject) => {',
	'    setTimeout(() => {',
	"      console.log('reject', reason);",
	'      reject(new Error(reason));',
	'    }, ms);',
	'  });',
	'}',
	'',
	'function show(x) {',
	"  if (Array.isArray(x)) return `[${x.map(show).join(' ')}]`;",
	"  if (x instanceof AggregateError) return `AggregateError[${x.errors.map(show).join(' ')}]`;",
	'  if (x instanceof Error) return `Error(${x.message})`;',
	"  if (typeof x === 'object') return `${x.status}(${show(x.status === 'fulfilled' ? x.value : x.reason)})`;",
	'  return String(x);',
	'}',
	'',
	'const report = (label) => [',
	"  (v) => console.log(label, 'ok', show(v)),",
	"  (e) => console.log(label, 'failed', show(e)),",
	'];'
];

const WITH_TIMEOUT = [
	'function withTimeout(promise, ms) {',
	'  const timer = new Promise((resolve, reject) => {',
	'    setTimeout(() => {',
	"      console.log('timeout', ms);",
	'      reject(new Error(`timeout ${ms}`));',
	'    }, ms);',
	'  });',
	'  return Promise.race([promise, timer]);',
	'}'
];

interface Leaf {
	name: string;
	ms: number;
	ok: boolean;
}

/** An item of a combinator's array. */
type Item =
	| { k: 'ref'; name: string }
	| { k: 'plain'; value: string }
	| { k: 'resolved'; value: string }
	| { k: 'rejected'; reason: string }
	| { k: 'combo'; op: Op; items: Item[] };

/** What a `finally` callback does after it logs. */
type FinallyBody =
	{ k: 'none' } | { k: 'value'; value: string } | { k: 'promise'; name: string } | { k: 'throw'; reason: string };

type Stmt =
	| { k: 'leaf'; leaf: Leaf }
	| { k: 'const'; name: string; item: Item }
	| { k: 'report'; item: Item; label: string }
	| { k: 'timeout'; name: string; ms: number; label: string }
	| { k: 'catch'; name: string }
	| { k: 'finally'; name: string; body: FinallyBody }
	| { k: 'sync' };

interface Program {
	stmts: Stmt[];
	withTimeout: boolean;
}

function renderItem(item: Item): string {
	switch (item.k) {
		case 'ref':
			return item.name;
		case 'plain':
			return `'${item.value}'`;
		case 'resolved':
			return `Promise.resolve('${item.value}')`;
		case 'rejected':
			return `Promise.reject(new Error('${item.reason}'))`;
		case 'combo':
			return `Promise.${item.op}([${item.items.map(renderItem).join(', ')}])`;
	}
}

function renderStmt(s: Stmt): string[] {
	switch (s.k) {
		case 'leaf':
			return [`const ${s.leaf.name} = ${s.leaf.ok ? 'delay' : 'fail'}(${s.leaf.ms}, '${s.leaf.name}');`];
		case 'const':
			return [`const ${s.name} = ${renderItem(s.item)};`];
		case 'report':
			return [`${renderItem(s.item)}.then(...report('${s.label}'));`];
		case 'timeout':
			return [`withTimeout(${s.name}, ${s.ms}).then(...report('${s.label}'));`];
		case 'catch':
			return [`${s.name}.catch((e) => console.log('${s.name} caught', show(e)));`];
		case 'finally': {
			const body = s.body;
			const tail =
				body.k === 'none'
					? []
					: body.k === 'value'
						? [`  return '${body.value}';`]
						: body.k === 'promise'
							? [`  return ${body.name};`]
							: [`  throw new Error('${body.reason}');`];
			return [
				s.name,
				'  .finally(() => {',
				`    console.log('finally ${s.name}');`,
				...tail.map((line) => `  ${line}`),
				'  })',
				`  .then(...report('${s.name}'));`
			];
		}
		case 'sync':
			return ["console.log('sync end');"];
	}
}

function render(p: Program): string {
	const lines = [...HELPERS, ''];
	if (p.withTimeout) lines.push(...WITH_TIMEOUT, '');
	const leaves = p.stmts.filter((s) => s.k === 'leaf');
	const rest = p.stmts.filter((s) => s.k !== 'leaf');
	for (const s of leaves) lines.push(...renderStmt(s));
	lines.push('');
	for (const s of rest) lines.push(...renderStmt(s));
	return lines.join('\n');
}

/** The output of the program under the rules, or `null` when the program leaves a rejection unhandled. */
function execute(p: Program, rules: Rules, strict: boolean): string[] | null {
	const engine = new Engine(rules, strict);
	const env = new Map<string, Prom>();
	const get = (name: string): Prom => {
		const value = env.get(name);
		if (!value) throw new Error(`no promise ${name}`);
		return value;
	};
	const evaluate = (item: Item): Value => {
		switch (item.k) {
			case 'ref':
				return get(item.name);
			case 'plain':
				return item.value;
			case 'resolved':
				return engine.promiseResolve(item.value);
			case 'rejected':
				return engine.promiseReject(errorValue(item.reason));
			case 'combo':
				return engine.combinator(item.op, item.items.map(evaluate));
		}
	};
	const report = (label: string): [Handler, Handler] => [
		(v) => {
			engine.log(`${label} ok ${show(v)}`);
			return undefined;
		},
		(e) => {
			engine.log(`${label} failed ${show(e)}`);
			return undefined;
		}
	];
	const script = (): void => {
		const ordered = [...p.stmts.filter((s) => s.k === 'leaf'), ...p.stmts.filter((s) => s.k !== 'leaf')];
		for (const s of ordered) {
			switch (s.k) {
				case 'leaf':
					env.set(
						s.leaf.name,
						engine.leaf(s.leaf.ms, s.leaf.ok, s.leaf.name, `${s.leaf.ok ? 'resolve' : 'reject'} ${s.leaf.name}`)
					);
					break;
				case 'const':
					env.set(s.name, engine.promiseResolve(evaluate(s.item)));
					break;
				case 'report': {
					const target = engine.promiseResolve(evaluate(s.item));
					engine.then(target, ...report(s.label));
					break;
				}
				case 'timeout': {
					const timer = engine.leaf(s.ms, false, `timeout ${s.ms}`, `timeout ${s.ms}`);
					const raced = engine.combinator('race', [get(s.name), timer]);
					engine.then(raced, ...report(s.label));
					break;
				}
				case 'catch':
					engine.then(get(s.name), null, (e) => {
						engine.log(`${s.name} caught ${show(e)}`);
						return undefined;
					});
					break;
				case 'finally': {
					const body = s.body;
					const chained = engine.finally(get(s.name), () => {
						engine.log(`finally ${s.name}`);
						if (body.k === 'value') return body.value;
						if (body.k === 'promise') return get(body.name);
						if (body.k === 'throw') throw new Thrown(errorValue(body.reason));
						return undefined;
					});
					engine.then(chained, ...report(s.name));
					break;
				}
				case 'sync':
					engine.log('sync end');
			}
		}
	};
	try {
		engine.run(script);
	} catch (error) {
		if (error instanceof Unsupported) return null;
		throw error;
	}
	return engine.out;
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios of the classes.

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const DELAYS = Array.from({ length: 12 }, (_, i) => 20 * (i + 1));

/** Leaves with distinct delays; `fails` of them reject. */
function leaves(rng: Rng, count: number, fails: number, names: readonly string[] = LETTERS): Leaf[] {
	const delays = rng.sample(DELAYS, count);
	const failing = new Set(
		rng.sample(
			Array.from({ length: count }, (_, i) => i),
			fails
		)
	);
	return delays.map((ms, i) => ({ name: names[i] ?? `p${i}`, ms, ok: !failing.has(i) }));
}

const refs = (list: readonly Leaf[]): Item[] => list.map((l) => ({ k: 'ref', name: l.name }));
const leafStmts = (list: readonly Leaf[]): Stmt[] => list.map((leaf) => ({ k: 'leaf', leaf }));
const combo = (op: Op, items: Item[]): Item => ({ k: 'combo', op, items });

/** A random subset of `size` with at least `failing` rejecting leaves, in random order. */
function subset(rng: Rng, list: readonly Leaf[], size: number, failing = 1): Leaf[] {
	for (let tries = 0; tries < 20; tries += 1) {
		const chosen = rng.sample(list, Math.min(size, list.length));
		if (chosen.filter((l) => !l.ok).length >= Math.min(failing, list.filter((l) => !l.ok).length)) return chosen;
	}
	const fails = list.filter((l) => !l.ok).slice(0, failing);
	const rest = rng.sample(
		list.filter((l) => !fails.includes(l)),
		Math.max(0, Math.min(size, list.length) - fails.length)
	);
	return rng.shuffle([...fails, ...rest]);
}

function allSettledProgram(rng: Rng): Program {
	const list = leaves(rng, rng.int(4, 5), rng.int(1, 2));
	const forAll = subset(rng, list, rng.int(3, list.length));
	const forSettled = subset(rng, list, rng.int(3, list.length));
	for (const leaf of list) if (!forAll.includes(leaf) && !forSettled.includes(leaf)) forSettled.push(leaf);
	const reports: Stmt[] = rng.shuffle([
		{ k: 'report', item: combo('all', refs(forAll)), label: 'all' },
		{ k: 'report', item: combo('allSettled', refs(forSettled)), label: 'settled' }
	]);
	return { stmts: [...leafStmts(list), ...reports], withTimeout: false };
}

function raceAnyProgram(rng: Rng): Program {
	const list = leaves(rng, rng.int(4, 5), 2);
	const reports: Stmt[] = [
		{ k: 'report', item: combo('race', refs(subset(rng, list, 3))), label: 'race' },
		{ k: 'report', item: combo('any', refs(subset(rng, list, 3))), label: 'any' }
	];
	if (rng.bool(0.5)) {
		const fails = rng.shuffle(list.filter((l) => !l.ok));
		reports.push({ k: 'report', item: combo('any', refs(fails)), label: 'any of failing' });
	}
	const used = new Set(reports.flatMap((r) => (r.k === 'report' && r.item.k === 'combo' ? r.item.items : [])));
	for (const leaf of list) {
		if (![...used].some((i) => i.k === 'ref' && i.name === leaf.name)) {
			const target = reports[0];
			if (target?.k === 'report' && target.item.k === 'combo') target.item.items.push({ k: 'ref', name: leaf.name });
		}
	}
	return { stmts: [...leafStmts(list), ...rng.shuffle(reports)], withTimeout: false };
}

const IMMEDIATE_NAMES = ['x', 'y', 'z', 'w', 'v'] as const;

function plainValuesProgram(rng: Rng): Program {
	const list = leaves(rng, 3, rng.int(0, 1));
	const names = [...IMMEDIATE_NAMES];
	let n = 0;
	const immediate = (): Item => {
		const name = names[n++] ?? `i${n}`;
		const kind = rng.pick(['plain', 'plain', 'resolved', 'rejected'] as const);
		return kind === 'plain'
			? { k: 'plain', value: name }
			: kind === 'resolved'
				? { k: 'resolved', value: name }
				: { k: 'rejected', reason: name };
	};
	const ops = rng.sample(['all', 'race', 'any', 'allSettled'] as const, rng.int(2, 3));
	const reports: Stmt[] = ops.map((op) => {
		const items = [...refs(rng.sample(list, rng.int(1, 2))), immediate()];
		if (rng.bool(0.3)) items.push(immediate());
		return { k: 'report', item: combo(op, rng.shuffle(items)), label: op };
	});
	if (rng.bool(0.35)) {
		const op = rng.pick(['all', 'any', 'allSettled'] as const);
		reports.push({ k: 'report', item: combo(op, []), label: `${op} of none` });
	}
	for (const leaf of list) {
		const used = reports.some((r) => r.k === 'report' && JSON.stringify(r.item).includes(`"name":"${leaf.name}"`));
		const first = reports[0];
		if (!used && first?.k === 'report' && first.item.k === 'combo')
			first.item.items.push({ k: 'ref', name: leaf.name });
	}
	return { stmts: [...leafStmts(list), ...rng.shuffle(reports), { k: 'sync' }], withTimeout: false };
}

function timeoutProgram(rng: Rng): Program {
	const count = rng.int(2, 3);
	const delays = rng.sample(DELAYS, count * 2);
	const list: Leaf[] = Array.from({ length: count }, (_, i) => ({
		name: LETTERS[i] ?? `p${i}`,
		ms: delays[i] ?? 20,
		ok: rng.bool(0.75)
	}));
	const stmts: Stmt[] = list.map((leaf, i) => ({
		k: 'timeout',
		name: leaf.name,
		ms: delays[count + i] ?? 40,
		label: `${leaf.name} in ${delays[count + i] ?? 40}`
	}));
	if (rng.bool(0.6)) {
		const leaf = rng.pick(list);
		stmts.push(
			leaf.ok ? { k: 'report', item: { k: 'ref', name: leaf.name }, label: leaf.name } : { k: 'catch', name: leaf.name }
		);
	}
	return { stmts: [...leafStmts(list), ...rng.shuffle(stmts)], withTimeout: true };
}

function nestedProgram(rng: Rng): Program {
	const list = leaves(rng, rng.int(5, 6), rng.int(2, 3));
	const [op1, op2] = rng.sample(['all', 'race', 'any', 'allSettled'] as const, 2) as [Op, Op];
	const outerOp = rng.pick(['all', 'race', 'any', 'allSettled'] as const);
	const shuffled = rng.shuffle(list);
	const k = rng.int(2, 3);
	const g = shuffled.slice(0, k);
	const h = shuffled.slice(k, k + 2);
	const rest = shuffled.slice(k + 2);
	const stmts: Stmt[] = [
		{ k: 'const', name: 'g', item: combo(op1, refs(g)) },
		{ k: 'const', name: 'h', item: combo(op2, refs(h)) }
	];
	const outer: Item[] = rng.shuffle<Item>([{ k: 'ref', name: 'g' }, { k: 'ref', name: 'h' }, ...refs(rest)]);
	const reports: Stmt[] = [{ k: 'report', item: combo(outerOp, outer), label: outerOp }];
	if (rng.bool(0.6)) reports.push({ k: 'report', item: { k: 'ref', name: rng.pick(['g', 'h']) }, label: 'inner' });
	if (rng.bool(0.4))
		reports.push({
			k: 'report',
			item: combo(rng.pick(['race', 'any'] as const), rng.shuffle<Item>([{ k: 'ref', name: 'g' }, ...refs(rest)])),
			label: 'second'
		});
	return { stmts: [...leafStmts(list), ...stmts, ...rng.shuffle(reports)], withTimeout: false };
}

function finallyProgram(rng: Rng): Program {
	const count = rng.int(3, 4);
	const all = leaves(rng, count + 2, 0, [...LETTERS.slice(0, count), 'flush', 'broken']);
	const sources = all.slice(0, count).map((l) => ({ ...l, ok: rng.bool(0.6) }));
	const flush = all[count] as Leaf;
	const broken = { ...(all[count + 1] as Leaf), ok: false };
	const bodies: FinallyBody[] = rng.shuffle<FinallyBody>([
		{ k: 'value', value: 'z' },
		{ k: 'promise', name: 'flush' },
		...(rng.bool(0.5) ? [{ k: 'throw', reason: 'cleanup' } as const] : [{ k: 'promise', name: 'broken' } as const]),
		{ k: 'none' }
	]);
	const stmts: Stmt[] = sources.map((leaf, i) => ({ k: 'finally', name: leaf.name, body: bodies[i] ?? { k: 'none' } }));
	const usesBroken = stmts.some((s) => s.k === 'finally' && s.body.k === 'promise' && s.body.name === 'broken');
	if (usesBroken && rng.bool(0.5)) stmts.push({ k: 'catch', name: 'broken' });
	const list = [...sources, flush, ...(usesBroken ? [broken] : [])];
	return { stmts: [...leafStmts(list), ...rng.shuffle(stmts)], withTimeout: false };
}

function lateProgram(rng: Rng): Program {
	const list = leaves(rng, 5, rng.int(2, 3));
	const ops = rng.sample(['all', 'race', 'any'] as const, rng.int(2, 3));
	const reports: Stmt[] = ops.map((op) => ({ k: 'report', item: combo(op, refs(subset(rng, list, 3))), label: op }));
	for (const leaf of rng.sample(list, rng.int(1, 2))) {
		reports.push(
			leaf.ok ? { k: 'report', item: { k: 'ref', name: leaf.name }, label: leaf.name } : { k: 'catch', name: leaf.name }
		);
	}
	for (const leaf of list) {
		const used = reports.some((r) => JSON.stringify(r).includes(`"name":"${leaf.name}"`));
		if (!used)
			reports.push(
				leaf.ok
					? { k: 'report', item: { k: 'ref', name: leaf.name }, label: leaf.name }
					: { k: 'catch', name: leaf.name }
			);
	}
	return { stmts: [...leafStmts(list), ...rng.shuffle(reports)], withTimeout: false };
}

function aggregateProgram(rng: Rng): Program {
	const list = leaves(rng, rng.int(5, 6), 0).map((l, i) => ({ ...l, ok: i === 0 }));
	const shuffled = rng.shuffle(list);
	const okLeaf = list[0] as Leaf;
	const others = shuffled.filter((l) => l !== okLeaf);
	const g = rng.shuffle([okLeaf, others[0] as Leaf]);
	const h = others.slice(1, 3);
	const rest = others.slice(3);
	const stmts: Stmt[] = [
		{ k: 'const', name: 'g', item: combo('all', refs(g)) },
		{ k: 'const', name: 'h', item: combo(rng.pick(['race', 'any'] as const), refs(h)) }
	];
	const outer = rng.shuffle<Item>([{ k: 'ref', name: 'g' }, { k: 'ref', name: 'h' }, ...refs(rest)]);
	const reports: Stmt[] = [
		{ k: 'report', item: combo('any', outer), label: 'any' },
		{ k: 'report', item: combo('allSettled', rng.shuffle(outer)), label: 'settled' }
	];
	return { stmts: [...leafStmts(list), ...stmts, ...rng.shuffle(reports)], withTimeout: false };
}

const GENERATORS: Record<string, (rng: Rng) => Program> = {
	'all-settled': allSettledProgram,
	'race-any': raceAnyProgram,
	'plain-values': plainValuesProgram,
	'timeout-race': timeoutProgram,
	nested: nestedProgram,
	finally: finallyProgram,
	'late-settle': lateProgram,
	aggregate: aggregateProgram
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/all-settled': ['all-waits-all', 'completion-order'],
	'middle/race-any': ['race-skips-rejections', 'any-first-settled'],
	'middle/plain-values': ['handlers-sync', 'completion-order'],
	'middle/timeout-race': ['cancel-on-settle', 'race-skips-rejections'],
	'senior/nested': ['cancel-on-settle', 'completion-order'],
	'senior/finally': ['finally-replaces', 'finally-no-wait'],
	'senior/late-settle': ['late-resettle', 'cancel-on-settle'],
	'senior/aggregate': ['aggregate-completion-order', 'any-first-settled']
};

const STATEMENT = [
	'Что напечатает программа? Её запускают в Node.js 24; `setTimeout` и промисы ведут себя так же, как в браузере.',
	'Задержки таймеров отличаются не меньше чем на 20 мс, а сама программа выполняется мгновенно, поэтому таймеры',
	'срабатывают строго в порядке своих задержек.',
	'',
	'Введите вывод построчно, как он появится на экране.'
].join('\n');

interface Candidate {
	program: Program;
	source: string;
	answer: string[];
	wrong: Record<string, string[] | null>;
}

function candidate(p: Program): Candidate | null {
	const answer = execute(p, RIGHT, true);
	if (answer === null) return null;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = execute(p, { ...RIGHT, ...change }, false);
			const same = value === null || (value.length === answer.length && value.every((line, i) => line === answer[i]));
			return [id, same ? null : value];
		})
	);
	return { program: p, source: render(p), answer, wrong };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const draw = GENERATORS[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no generator for ${input.classId}`);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Programs are drawn until every misconception the class is about changes the output; the best draw stands in
	// when none does (it still carries at least one wrong answer the gate checks).
	let best: { c: Candidate; applicable: number } | null = null;
	for (let tries = 0; tries < 400; tries += 1) {
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
