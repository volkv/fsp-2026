// The order of output of a program with async functions: the body of an async function runs synchronously up to its
// first `await`; every `await` yields to the microtask queue, even for a ready value; a promise a timer resolves comes
// only after the microtasks; returning a promise from an async function costs more microtask turns than `return await`;
// a level up, `await` in a `for…of` loop, a nested async call without `await`, `try/catch` around a rejected `await`.
//
// The generator models the ECMAScript job queue (promise reactions, NewPromiseResolveThenableJob, Await with
// PerformPromiseThen on the awaited promise) and Node's timers for the constructs it emits; the gate runs every shown
// program with real Node and compares the output.
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
// The shown program: a small syntax tree printed as JavaScript.

type Expr =
	| { k: 'str'; v: string }
	| { k: 'num'; v: number }
	| { k: 'null' }
	| { k: 'var'; name: string }
	| { k: 'message'; name: string }
	| { k: 'resolve'; arg: Expr | null }
	| { k: 'reject'; message: string }
	| { k: 'call'; fn: string; args: Expr[] }
	| { k: 'sleep'; ms: number }
	| { k: 'await'; arg: Expr }
	| { k: 'then'; target: Expr; handler: Arrow }
	| { k: 'catch'; target: Expr; handler: Arrow };

interface Arrow {
	param: string | null;
	body: Stmt[];
}

type Stmt =
	| { k: 'log'; label: string; arg: Expr | null }
	| { k: 'expr'; e: Expr }
	| { k: 'const'; name: string; e: Expr }
	| { k: 'return'; e: Expr | null }
	| { k: 'throw'; message: Expr }
	| { k: 'try'; body: Stmt[]; param: string; handler: Stmt[] }
	| { k: 'forOf'; name: string; items: string[]; body: Stmt[] }
	| { k: 'timeout'; ms: number; body: Stmt[] };

interface FnDecl {
	name: string;
	async: boolean;
	params: string[];
	body: Stmt[];
}

interface Program {
	fns: FnDecl[];
	main: Stmt[];
}

const quote = (s: string): string => `'${s}'`;

function chainOf(e: Expr): { head: Expr; links: { method: 'then' | 'catch'; handler: Arrow }[] } {
	const links: { method: 'then' | 'catch'; handler: Arrow }[] = [];
	let head = e;
	while (head.k === 'then' || head.k === 'catch') {
		links.unshift({ method: head.k, handler: head.handler });
		head = head.target;
	}
	return { head, links };
}

function printExpr(e: Expr, indent: string): string {
	switch (e.k) {
		case 'str':
			return quote(e.v);
		case 'num':
			return String(e.v);
		case 'null':
			return 'null';
		case 'var':
			return e.name;
		case 'message':
			return `${e.name}.message`;
		case 'resolve':
			return `Promise.resolve(${e.arg ? printExpr(e.arg, indent) : ''})`;
		case 'reject':
			return `Promise.reject(new Error(${quote(e.message)}))`;
		case 'call':
			return `${e.fn}(${e.args.map((a) => printExpr(a, indent)).join(', ')})`;
		case 'sleep':
			return `sleep(${e.ms})`;
		case 'await':
			return `await ${printExpr(e.arg, indent)}`;
		case 'then':
		case 'catch': {
			const { head, links } = chainOf(e);
			const parts = links.map((l) => `.${l.method}(${printArrow(l.handler, `${indent}  `)})`);
			return links.length === 1
				? `${printExpr(head, indent)}${parts[0] ?? ''}`
				: `${printExpr(head, indent)}\n${parts.map((p) => `${indent}  ${p}`).join('\n')}`;
		}
	}
}

function printArrow(a: Arrow, indent: string): string {
	const head = `(${a.param ?? ''}) =>`;
	const only = a.body.length === 1 ? a.body[0] : undefined;
	if (only?.k === 'log') return `${head} ${printStmt(only, '').trimEnd().replace(/;$/, '')}`;
	if (only?.k === 'return' && only.e) return `${head} ${printExpr(only.e, indent)}`;
	return `${head} {\n${a.body.map((s) => printStmt(s, `${indent}  `)).join('')}${indent}}`;
}

function printStmt(s: Stmt, indent: string): string {
	const inner = `${indent}  `;
	switch (s.k) {
		case 'log':
			return `${indent}console.log(${quote(s.label)}${s.arg ? `, ${printExpr(s.arg, indent)}` : ''});\n`;
		case 'expr':
			return `${indent}${printExpr(s.e, indent)};\n`;
		case 'const':
			return `${indent}const ${s.name} = ${printExpr(s.e, indent)};\n`;
		case 'return':
			return `${indent}return${s.e ? ` ${printExpr(s.e, indent)}` : ''};\n`;
		case 'throw':
			return `${indent}throw new Error(${printExpr(s.message, indent)});\n`;
		case 'try':
			return (
				`${indent}try {\n${s.body.map((x) => printStmt(x, inner)).join('')}` +
				`${indent}} catch (${s.param}) {\n${s.handler.map((x) => printStmt(x, inner)).join('')}${indent}}\n`
			);
		case 'forOf':
			return `${indent}for (const ${s.name} of [${s.items.map(quote).join(', ')}]) {\n${s.body.map((x) => printStmt(x, inner)).join('')}${indent}}\n`;
		case 'timeout':
			return s.body.length === 1 && s.body[0]?.k === 'log'
				? `${indent}setTimeout(() => ${printStmt(s.body[0], '').trimEnd().replace(/;$/, '')}, ${s.ms});\n`
				: `${indent}setTimeout(() => {\n${s.body.map((x) => printStmt(x, inner)).join('')}${indent}}, ${s.ms});\n`;
	}
}

function usesSleep(p: Program): boolean {
	const inExpr = (e: Expr): boolean => {
		switch (e.k) {
			case 'sleep':
				return true;
			case 'await':
				return inExpr(e.arg);
			case 'resolve':
				return e.arg !== null && inExpr(e.arg);
			case 'call':
				return e.args.some(inExpr);
			case 'then':
			case 'catch':
				return inExpr(e.target) || e.handler.body.some(inStmt);
			default:
				return false;
		}
	};
	const inStmt = (s: Stmt): boolean => {
		switch (s.k) {
			case 'log':
				return s.arg !== null && inExpr(s.arg);
			case 'expr':
			case 'const':
				return inExpr(s.e);
			case 'return':
				return s.e !== null && inExpr(s.e);
			case 'throw':
				return false;
			case 'try':
				return s.body.some(inStmt) || s.handler.some(inStmt);
			case 'forOf':
			case 'timeout':
				return s.body.some(inStmt);
		}
	};
	return p.fns.some((f) => f.body.some(inStmt)) || p.main.some(inStmt);
}

function printProgram(p: Program): string {
	const parts: string[] = [];
	if (usesSleep(p)) parts.push('const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n');
	for (const f of p.fns) {
		parts.push(
			`${f.async ? 'async ' : ''}function ${f.name}(${f.params.join(', ')}) {\n${f.body.map((s) => printStmt(s, '  ')).join('')}}\n`
		);
	}
	parts.push(p.main.map((s) => printStmt(s, '')).join(''));
	return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The model: promises and jobs as ECMAScript defines them, Node's timers, an interpreter of the tree above.

/** A construct or an outcome the model does not cover (or that would make the run flaky): the program is drawn again. */
class Unsupported extends Error {}

interface ErrorValue {
	k: 'error';
	message: string;
}

interface Prom {
	k: 'promise';
	state: 'pending' | 'fulfilled' | 'rejected';
	value: Value;
	reactions: Reaction[];
	handled: boolean;
}

type Value = string | number | null | undefined | ErrorValue | Prom;

interface Completion {
	ok: boolean;
	v: Value;
}

type Handler = (v: Value) => Completion;

interface Capability {
	promise: Prom;
	resolve: (v: Value) => void;
	reject: (v: Value) => void;
}

interface Reaction {
	ok: Handler | null;
	err: Handler | null;
	cap: Capability | null;
}

/** A JavaScript exception inside the interpreter; `viaAwait` — it came out of an `await` of a rejected promise. */
class Thrown extends Error {
	readonly v: Value;
	readonly viaAwait: boolean;
	constructor(v: Value, viaAwait: boolean) {
		super('thrown');
		this.v = v;
		this.viaAwait = viaAwait;
	}
}

type Signal = { ret: Value } | null;
type Gen<T> = Generator<Value, T, Value>;

class Env {
	readonly #vars = new Map<string, Value>();
	readonly #parent: Env | null;
	constructor(parent: Env | null) {
		this.#parent = parent;
	}
	get(name: string): Value {
		if (this.#vars.has(name)) return this.#vars.get(name);
		if (this.#parent) return this.#parent.get(name);
		throw new Error(`unbound ${name}`);
	}
	set(name: string, v: Value): void {
		this.#vars.set(name, v);
	}
}

interface Ctx {
	async: boolean;
	/** The coroutine has been resumed after its first `await`. */
	resumed: boolean;
}

const SYNC: Ctx = { async: false, resumed: false };

/** The misconceptions as switches of the model; all off is JavaScript. */
interface Rules {
	bodyDeferred: boolean;
	awaitBlocks: boolean;
	resumeRunsThrough: boolean;
	timerAsMicro: boolean;
	returnPromiseFree: boolean;
	loopParallel: boolean;
	missingAwaitWaits: boolean;
	rejectSync: boolean;
	catchMissesAwait: boolean;
}

const RIGHT: Rules = {
	bodyDeferred: false,
	awaitBlocks: false,
	resumeRunsThrough: false,
	timerAsMicro: false,
	returnPromiseFree: false,
	loopParallel: false,
	missingAwaitWaits: false,
	rejectSync: false,
	catchMissesAwait: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'body-deferred': { bodyDeferred: true },
	'await-blocks': { awaitBlocks: true },
	'resume-runs-through': { resumeRunsThrough: true },
	'timer-as-micro': { timerAsMicro: true },
	'return-promise-free': { returnPromiseFree: true },
	'loop-parallel': { loopParallel: true },
	'missing-await-waits': { missingAwaitWaits: true },
	'reject-sync': { rejectSync: true },
	'catch-misses-await': { catchMissesAwait: true }
};

/**
 * Real timers keep the model's order only with room for a stalled process (a loaded machine can pause it for tens of
 * milliseconds anywhere): distinct due moments at least this far apart…
 */
const TIMER_MARGIN_MS = 40;
/** …and further when a timer set later must fire earlier: a pause before it is set pushes it back by the whole pause. */
const INVERTED_MARGIN_MS = 150;
const MAX_JOBS = 3000;

const isPromise = (v: Value): v is Prom => typeof v === 'object' && v !== null && v.k === 'promise';
const isError = (v: Value): v is ErrorValue => typeof v === 'object' && v !== null && v.k === 'error';

function show(v: Value): string {
	if (v === undefined) return 'undefined';
	if (v === null) return 'null';
	if (typeof v === 'string') return v;
	if (typeof v === 'number') return String(v);
	throw new Unsupported('logs an object');
}

function containsAwait(stmts: readonly Stmt[]): boolean {
	const e = (x: Expr): boolean =>
		x.k === 'await' ||
		(x.k === 'resolve' && x.arg !== null && e(x.arg)) ||
		(x.k === 'call' && x.args.some(e)) ||
		((x.k === 'then' || x.k === 'catch') && e(x.target));
	const s = (x: Stmt): boolean => {
		switch (x.k) {
			case 'log':
				return x.arg !== null && e(x.arg);
			case 'expr':
			case 'const':
				return e(x.e);
			case 'return':
				return x.e !== null && e(x.e);
			case 'throw':
				return e(x.message);
			case 'try':
				return x.body.some(s) || x.handler.some(s);
			case 'forOf':
				return x.body.some(s);
			case 'timeout':
				return false;
		}
	};
	return stmts.some(s);
}

class Machine {
	readonly out: string[] = [];
	readonly #rules: Rules;
	readonly #fns: Map<string, FnDecl>;
	readonly #global = new Env(null);
	readonly #jobs: (() => void)[] = [];
	readonly #timers: { due: number; delay: number; at: number; seq: number; run: () => void }[] = [];
	readonly #scheduled: { due: number; delay: number; at: number; seq: number }[] = [];
	readonly #promises: Prom[] = [];
	#now = 0;
	#seq = 0;
	#steps = 0;

	constructor(program: Program, rules: Rules) {
		this.#rules = rules;
		this.#fns = new Map(program.fns.map((f) => [f.name, f]));
	}

	run(main: readonly Stmt[]): string[] {
		this.#runSync(this.#block(main, this.#global, SYNC));
		this.#checkpoint();
		while (this.#timers.length > 0) {
			this.#timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
			const timer = this.#timers.shift();
			if (!timer) break;
			this.#now = timer.due;
			timer.run();
			this.#checkpoint();
		}
		return this.out;
	}

	/** Whether real timers keep the model's order whatever pauses a loaded machine makes (see the margins). */
	timersAreRobust(): boolean {
		// In firing order; timers due at once fire in the order they were set, which a pause cannot change when they
		// share the delay and the moment they were set at (Node keeps one list per delay).
		const all = [...this.#scheduled].sort((a, b) => a.due - b.due || a.seq - b.seq);
		return all.every((first, i) =>
			all.slice(i + 1).every((later) => {
				if (first.due === later.due) return first.delay === later.delay && first.at === later.at;
				const margin = first.seq > later.seq ? INVERTED_MARGIN_MS : TIMER_MARGIN_MS;
				return later.due - first.due >= margin;
			})
		);
	}

	#setTimeout(ms: number, run: () => void): void {
		// Node runs a zero delay as 1 ms.
		const delay = Math.max(1, ms);
		const timer = { due: this.#now + delay, delay, at: this.#now, seq: this.#seq++, run };
		this.#timers.push(timer);
		this.#scheduled.push(timer);
	}

	#enqueue(job: () => void): void {
		this.#jobs.push(job);
	}

	#checkpoint(): void {
		for (let job = this.#jobs.shift(); job; job = this.#jobs.shift()) {
			if ((this.#steps += 1) > MAX_JOBS) throw new Unsupported('runaway jobs');
			job();
		}
		if (this.#promises.some((p) => p.state === 'rejected' && !p.handled)) throw new Unsupported('unhandled rejection');
	}

	#newPromise(): Prom {
		const p: Prom = { k: 'promise', state: 'pending', value: undefined, reactions: [], handled: false };
		this.#promises.push(p);
		return p;
	}

	/** CreateResolvingFunctions: a pair with its own «already resolved» flag. */
	#resolvers(p: Prom): Capability {
		let done = false;
		return {
			promise: p,
			resolve: (v) => {
				if (done) return;
				done = true;
				if (!isPromise(v)) {
					this.#settle(p, 'fulfilled', v);
					return;
				}
				if (v === p) throw new Unsupported('self resolution');
				// NewPromiseResolveThenableJob.
				this.#enqueue(() => {
					const fresh = this.#resolvers(p);
					this.#then(v, native(fresh.resolve), native(fresh.reject), null);
				});
			},
			reject: (v) => {
				if (done) return;
				done = true;
				this.#settle(p, 'rejected', v);
			}
		};
	}

	#settle(p: Prom, state: 'fulfilled' | 'rejected', v: Value): void {
		p.state = state;
		p.value = v;
		const reactions = p.reactions;
		p.reactions = [];
		for (const r of reactions) this.#enqueueReaction(r, state, v);
	}

	#enqueueReaction(r: Reaction, state: 'fulfilled' | 'rejected', v: Value): void {
		this.#enqueue(() => {
			const handler = state === 'fulfilled' ? r.ok : r.err;
			const c: Completion = handler ? handler(v) : { ok: state === 'fulfilled', v };
			if (r.cap) (c.ok ? r.cap.resolve : r.cap.reject)(c.v);
		});
	}

	/** PerformPromiseThen. */
	#then(p: Prom, ok: Handler | null, err: Handler | null, cap: Capability | null): void {
		p.handled = true;
		const r: Reaction = { ok, err, cap };
		if (p.state === 'pending') p.reactions.push(r);
		else this.#enqueueReaction(r, p.state, p.value);
	}

	#promiseResolve(v: Value): Prom {
		if (isPromise(v)) return v;
		const p = this.#newPromise();
		this.#settle(p, 'fulfilled', v);
		return p;
	}

	/** An async function: its body runs at once up to the first `await`; every resumption is a job. */
	#callAsync(body: readonly Stmt[], env: Env): Prom {
		const cap = this.#resolvers(this.#newPromise());
		const ctx: Ctx = { async: true, resumed: false };
		const gen = this.#block(body, env, ctx);
		const advance = (input: Completion | null): void => {
			let next = input;
			for (;;) {
				let r: IteratorResult<Value, Signal>;
				try {
					r = next === null ? gen.next(undefined) : next.ok ? gen.next(next.v) : gen.throw(new Thrown(next.v, true));
				} catch (e) {
					if (e instanceof Thrown) {
						cap.reject(e.v);
						return;
					}
					throw e;
				}
				if (r.done) {
					this.#finish(cap, r.value === null ? undefined : r.value.ret);
					return;
				}
				const shortcut = this.#syncAwait(r.value, ctx);
				if (shortcut) {
					next = shortcut;
					continue;
				}
				const resume =
					(ok: boolean): Handler =>
					(v) => {
						ctx.resumed = true;
						advance({ ok, v });
						return { ok: true, v: undefined };
					};
				this.#then(this.#promiseResolve(r.value), resume(true), resume(false), null);
				return;
			}
		};
		if (this.#rules.bodyDeferred)
			this.#enqueue(() => {
				advance(null);
			});
		else advance(null);
		return cap.promise;
	}

	/** Misconceptions under which an `await` of a settled value goes on without yielding. */
	#syncAwait(v: Value, ctx: Ctx): Completion | null {
		const settled: Completion | null = !isPromise(v)
			? { ok: true, v }
			: v.state === 'pending'
				? null
				: { ok: v.state === 'fulfilled', v: v.value };
		if (settled === null) return null;
		const take =
			this.#rules.awaitBlocks ||
			(this.#rules.resumeRunsThrough && ctx.resumed) ||
			(this.#rules.rejectSync && !settled.ok);
		if (!take) return null;
		if (isPromise(v)) v.handled = true;
		return settled;
	}

	#finish(cap: Capability, v: Value): void {
		if (isPromise(v) && this.#rules.returnPromiseFree) this.#then(v, native(cap.resolve), native(cap.reject), null);
		else cap.resolve(v);
	}

	#runSync<T>(gen: Gen<T>): T {
		const r = gen.next(undefined);
		if (!r.done) throw new Error('await outside an async function');
		return r.value;
	}

	#handler(a: Arrow, env: Env): Handler {
		return (v) => {
			const scope = new Env(env);
			if (a.param) scope.set(a.param, v);
			try {
				const signal = this.#runSync(this.#block(a.body, scope, SYNC));
				return { ok: true, v: signal === null ? undefined : signal.ret };
			} catch (e) {
				if (e instanceof Thrown) return { ok: false, v: e.v };
				throw e;
			}
		};
	}

	*#block(stmts: readonly Stmt[], env: Env, ctx: Ctx): Gen<Signal> {
		for (const s of stmts) {
			const signal = yield* this.#exec(s, env, ctx);
			if (signal) return signal;
		}
		return null;
	}

	*#exec(s: Stmt, env: Env, ctx: Ctx): Gen<Signal> {
		switch (s.k) {
			case 'log': {
				const v = s.arg ? yield* this.#eval(s.arg, env, ctx) : undefined;
				this.out.push(s.arg ? `${s.label} ${show(v)}` : s.label);
				return null;
			}
			case 'expr': {
				const e = s.e;
				if (this.#rules.missingAwaitWaits && ctx.async && e.k === 'call' && this.#fns.get(e.fn)?.async) {
					yield* this.#eval({ k: 'await', arg: e }, env, ctx);
					return null;
				}
				yield* this.#eval(e, env, ctx);
				return null;
			}
			case 'const':
				env.set(s.name, yield* this.#eval(s.e, env, ctx));
				return null;
			case 'return':
				return { ret: s.e ? yield* this.#eval(s.e, env, ctx) : undefined };
			case 'throw': {
				const message = yield* this.#eval(s.message, env, ctx);
				throw new Thrown({ k: 'error', message: show(message) }, false);
			}
			case 'try':
				try {
					return yield* this.#block(s.body, new Env(env), ctx);
				} catch (e) {
					if (!(e instanceof Thrown) || (this.#rules.catchMissesAwait && e.viaAwait)) throw e;
					const scope = new Env(env);
					scope.set(s.param, e.v);
					return yield* this.#block(s.handler, scope, ctx);
				}
			case 'forOf': {
				if (this.#rules.loopParallel && ctx.async && containsAwait(s.body)) {
					for (const item of s.items) {
						const scope = new Env(env);
						scope.set(s.name, item);
						this.#callAsync(s.body, scope);
					}
					return null;
				}
				for (const item of s.items) {
					const scope = new Env(env);
					scope.set(s.name, item);
					const signal = yield* this.#block(s.body, scope, ctx);
					if (signal) return signal;
				}
				return null;
			}
			case 'timeout':
				this.#setTimeout(s.ms, () => {
					this.#runSync(this.#block(s.body, new Env(env), SYNC));
				});
				return null;
		}
	}

	*#eval(e: Expr, env: Env, ctx: Ctx): Gen<Value> {
		switch (e.k) {
			case 'str':
				return e.v;
			case 'num':
				return e.v;
			case 'null':
				return null;
			case 'var':
				return env.get(e.name);
			case 'message': {
				const v = env.get(e.name);
				if (!isError(v)) throw new Unsupported('message of a non-error');
				return v.message;
			}
			case 'resolve':
				return this.#promiseResolve(e.arg ? yield* this.#eval(e.arg, env, ctx) : undefined);
			case 'reject': {
				const p = this.#newPromise();
				this.#settle(p, 'rejected', { k: 'error', message: e.message });
				return p;
			}
			case 'call': {
				const fn = this.#fns.get(e.fn);
				if (!fn) throw new Error(`no function ${e.fn}`);
				const scope = new Env(this.#global);
				for (const [i, a] of e.args.entries()) scope.set(fn.params[i] ?? `_${i}`, yield* this.#eval(a, env, ctx));
				if (fn.async) return this.#callAsync(fn.body, scope);
				const signal = this.#runSync(this.#block(fn.body, scope, SYNC));
				return signal === null ? undefined : signal.ret;
			}
			case 'sleep': {
				const cap = this.#resolvers(this.#newPromise());
				const settle = (): void => {
					cap.resolve(undefined);
				};
				if (this.#rules.timerAsMicro) this.#enqueue(settle);
				else this.#setTimeout(e.ms, settle);
				return cap.promise;
			}
			case 'await': {
				if (!ctx.async) throw new Error('await outside an async function');
				const v = yield* this.#eval(e.arg, env, ctx);
				return yield v;
			}
			case 'then':
			case 'catch': {
				const target = yield* this.#eval(e.target, env, ctx);
				if (!isPromise(target)) throw new Error('then on a non-promise');
				const cap = this.#resolvers(this.#newPromise());
				const h = this.#handler(e.handler, env);
				this.#then(target, e.k === 'then' ? h : null, e.k === 'catch' ? h : null, cap);
				return cap.promise;
			}
		}
	}
}

function native(f: (v: Value) => void): Handler {
	return (v) => {
		f(v);
		return { ok: true, v: undefined };
	};
}

/** The output of the program under the rules; `null` — the model does not cover it or the run would be flaky. */
function execute(p: Program, rules: Rules, strict: boolean): string[] | null {
	try {
		const m = new Machine(p, rules);
		const out = m.run(p.main);
		if (strict && !m.timersAreRobust()) return null;
		return out;
	} catch (e) {
		if (e instanceof Unsupported) return null;
		throw e;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Programs of the classes.

const FN_NAMES = [
	'load',
	'save',
	'render',
	'sync',
	'parse',
	'notify',
	'upload',
	'fetchUser',
	'track',
	'init',
	'refresh',
	'validate',
	'submit',
	'poll',
	'prefetch',
	'hydrate'
] as const;
const MAIN_LABELS = ['start', 'end', 'ready', 'main', 'sync', 'boot', 'idle', 'after', 'tick', 'clicked'] as const;
const VALUES = ['ok', 'data', 'user', 'cfg', 'token', 'page', 'json', 'html'] as const;
const ITEMS = [
	['a.png', 'b.png', 'c.png'],
	['home', 'cart', 'profile'],
	['id1', 'id2', 'id3'],
	['ru', 'en', 'de'],
	['north', 'south', 'east']
] as const;
const ERRORS = ['timeout', 'denied', 'offline', 'not found', 'conflict'] as const;

const log = (label: string, arg: Expr | null = null): Stmt => ({ k: 'log', label, arg });
const awaitStmt = (arg: Expr): Stmt => ({ k: 'expr', e: { k: 'await', arg } });
const callExpr = (fn: string, ...args: Expr[]): Expr => ({ k: 'call', fn, args });
const callStmt = (fn: string, ...args: Expr[]): Stmt => ({ k: 'expr', e: callExpr(fn, ...args) });
const str = (v: string): Expr => ({ k: 'str', v });
const asyncFn = (name: string, body: Stmt[], params: string[] = []): FnDecl => ({ name, async: true, params, body });

/** A value that is ready at once: `await` of it takes one microtask turn either way. */
function readyValue(rng: Rng): Expr {
	switch (rng.int(0, 4)) {
		case 0:
			return { k: 'null' };
		case 1:
			return { k: 'num', v: rng.int(1, 9) };
		case 2:
			return str(rng.pick(VALUES));
		case 3:
			return { k: 'resolve', arg: null };
		default:
			return { k: 'resolve', arg: str(rng.pick(VALUES)) };
	}
}

/** `name 1`, then `awaits` times: await a ready value, log the next step (once, with the awaited value). */
function stepsBody(rng: Rng, name: string, awaits: number, awaited: () => Expr = () => readyValue(rng)): Stmt[] {
	const body: Stmt[] = [log(`${name} 1`)];
	let bound = false;
	for (let i = 1; i <= awaits; i += 1) {
		const e = awaited();
		if (!bound && e.k !== 'null' && e.k !== 'sleep' && rng.bool(0.3)) {
			bound = true;
			body.push({ k: 'const', name: 'v', e: { k: 'await', arg: e } });
			body.push(log(`${name} ${i + 1}`, { k: 'var', name: 'v' }));
		} else {
			body.push(awaitStmt(e));
			body.push(log(`${name} ${i + 1}`));
		}
	}
	return body;
}

/** Main: the calls in order with labelled logs scattered between them. */
function mainWith(rng: Rng, calls: Stmt[], logs: number): Stmt[] {
	const labels = rng.sample(MAIN_LABELS, logs);
	const slots = calls.length + 1;
	const at = labels.map(() => rng.int(0, slots - 1)).sort((a, b) => a - b);
	const main: Stmt[] = [];
	let next = 0;
	for (let slot = 0; slot < slots; slot += 1) {
		while (next < at.length && at[next] === slot) main.push(log(labels[next++] ?? 'main'));
		const call = calls[slot];
		if (call) main.push(call);
	}
	return main;
}

/** Intern A: two async functions started from synchronous code. */
function syncPrefix(rng: Rng): Program {
	const [f, g] = rng.sample(FN_NAMES, 2) as [string, string];
	const fns = [asyncFn(f, stepsBody(rng, f, rng.int(1, 2))), asyncFn(g, stepsBody(rng, g, rng.int(1, 3)))];
	return { fns, main: mainWith(rng, [callStmt(f), callStmt(g)], rng.int(2, 3)) };
}

/** Intern B: one function waits for a timer, the other awaits ready values. */
function awaitTimer(rng: Rng): Program {
	const [f, g] = rng.sample(FN_NAMES, 2) as [string, string];
	const ms = rng.pick([0, 150]);
	const fBody: Stmt[] = [log(`${f} 1`), awaitStmt({ k: 'sleep', ms }), log(`${f} 2`)];
	if (rng.bool()) fBody.push(awaitStmt(readyValue(rng)), log(`${f} 3`));
	const fns = [asyncFn(f, fBody), asyncFn(g, stepsBody(rng, g, rng.int(2, 3)))];
	const calls = rng.shuffle([callStmt(f), callStmt(g)]);
	if (rng.bool(0.6)) {
		const timer: Stmt = { k: 'timeout', ms: rng.pick([0, 150, 300]), body: [log('timeout')] };
		calls.splice(rng.int(0, calls.length), 0, timer);
	}
	return { fns, main: mainWith(rng, calls, rng.int(1, 2)) };
}

/** Anchor: two or three functions, each with several awaits, interleave turn by turn. */
function interleave(rng: Rng): Program {
	const names = rng.sample(FN_NAMES, rng.int(2, 3));
	const fns = names.map((n, i) => asyncFn(n, stepsBody(rng, n, i === 0 ? rng.int(2, 3) : rng.int(1, 3))));
	return {
		fns,
		main: mainWith(
			rng,
			rng.shuffle(names).map((n) => callStmt(n)),
			rng.int(1, 2)
		)
	};
}

/** A chain of ticks: `Promise.resolve().then(() => log('tick 1')).then(...)`, a microtask counter. */
function ticks(count: number, label: string): Stmt {
	let e: Expr = { k: 'resolve', arg: null };
	for (let i = 1; i <= count; i += 1)
		e = { k: 'then', target: e, handler: { param: null, body: [log(`${label} ${i}`)] } };
	return { k: 'expr', e };
}

const thenLog = (target: Expr, label: string): Stmt => ({
	k: 'expr',
	e: { k: 'then', target, handler: { param: 'v', body: [log(label, { k: 'var', name: 'v' })] } }
});

/**
 * Intern X: `.then` on the call of an async function: the callback gets the returned value one turn after the
 * function's last step, not after its synchronous part.
 */
function resultThen(rng: Rng): Program {
	const [f, g] = rng.sample(FN_NAMES, 2) as [string, string];
	const fBody: Stmt[] = [...stepsBody(rng, f, rng.int(1, 3)), { k: 'return', e: str(rng.pick(VALUES)) }];
	const fns = [asyncFn(f, fBody), asyncFn(g, stepsBody(rng, g, rng.int(1, 3)))];
	const calls = rng.shuffle([thenLog(callExpr(f), `${f} result`), callStmt(g)]);
	return { fns, main: mainWith(rng, calls, rng.int(1, 2)) };
}

/** Junior A: `await` inside `for…of` runs the iterations one after another while another function goes on. */
function loopAwait(rng: Rng): Program {
	const [f, g] = rng.sample(FN_NAMES, 2) as [string, string];
	const items = rng.pick(ITEMS).slice(0, rng.int(2, 3));
	const viaTimer = rng.bool(0.3);
	const body: Stmt[] = [log(`${f} start`, { k: 'var', name: 'x' })];
	body.push(awaitStmt(viaTimer ? { k: 'sleep', ms: 0 } : readyValue(rng)));
	if (rng.bool(0.4)) body.push(awaitStmt(readyValue(rng)));
	body.push(log(`${f} done`, { k: 'var', name: 'x' }));
	const fns = [
		asyncFn(f, [{ k: 'forOf', name: 'x', items, body }, log(`${f} all`)]),
		asyncFn(g, stepsBody(rng, g, rng.int(2, 4)))
	];
	return { fns, main: mainWith(rng, rng.shuffle([callStmt(f), callStmt(g)]), rng.int(1, 2)) };
}

/** Junior B: an async call without `await` inside another async function runs only up to its first `await`. */
function nestedNoAwait(rng: Rng): Program {
	const [outer, inner] = rng.sample(FN_NAMES, 2) as [string, string];
	const [e1, e2] = rng.sample(['click', 'scroll', 'send', 'open', 'close', 'focus'], 2) as [string, string];
	const innerBody: Stmt[] = [log(`${inner} start`, { k: 'var', name: 'e' }), awaitStmt(readyValue(rng))];
	if (rng.bool(0.5)) innerBody.push(awaitStmt(readyValue(rng)));
	innerBody.push(log(`${inner} end`, { k: 'var', name: 'e' }));
	const withAwait = rng.bool(0.6);
	const outerBody: Stmt[] = [log(`${outer} 1`), callStmt(inner, str(e1)), log(`${outer} 2`)];
	if (withAwait) outerBody.push(awaitStmt(callExpr(inner, str(e2))));
	else outerBody.push(awaitStmt(readyValue(rng)));
	outerBody.push(log(`${outer} 3`));
	const fns = [asyncFn(outer, outerBody), asyncFn(inner, innerBody, ['e'])];
	return { fns, main: mainWith(rng, [callStmt(outer)], rng.int(1, 2)) };
}

/** Anchor junior: `try/catch` around an `await` of a rejected promise, while another function goes on. */
function tryReject(rng: Rng): Program {
	const [f, failing, other] = rng.sample(FN_NAMES, 3) as [string, string, string];
	const message = rng.pick(ERRORS);
	const failsLater = rng.bool(0.4);
	const viaHelper = rng.bool(0.7);
	const failBody: Stmt[] = [
		...(failsLater ? [awaitStmt(readyValue(rng))] : []),
		{ k: 'throw', message: { k: 'var', name: 'reason' } }
	];
	const awaited: Expr = viaHelper ? callExpr(failing, str(message)) : { k: 'reject', message };
	const fBody: Stmt[] = [
		log(`${f} 1`),
		{
			k: 'try',
			body: [awaitStmt(awaited), log(`${f} 2`)],
			param: 'e',
			handler: [log('caught', { k: 'message', name: 'e' })]
		},
		log(`${f} 3`)
	];
	const fns = [asyncFn(f, fBody), asyncFn(other, stepsBody(rng, other, rng.int(2, 3)))];
	if (viaHelper) fns.push(asyncFn(failing, failBody, ['reason']));
	const run: Stmt = {
		k: 'expr',
		e: {
			k: 'catch',
			target: callExpr(f),
			handler: { param: 'e', body: [log('outer', { k: 'message', name: 'e' })] }
		}
	};
	return { fns, main: mainWith(rng, rng.shuffle([run, callStmt(other)]), rng.int(1, 2)) };
}

/** Junior X: a promise returned through two async functions, `return` against `return await`. */
function returnChain(rng: Rng): Program {
	const [a, b, c] = rng.sample(FN_NAMES, 3) as [string, string, string];
	const value = rng.pick(VALUES);
	const bBody: Stmt[] = [log(`${b} 1`)];
	if (rng.bool()) bBody.push(awaitStmt(readyValue(rng)));
	bBody.push({ k: 'return', e: str(value) });
	const aAwaits = rng.bool();
	const aBody: Stmt[] = [log(`${a} 1`), { k: 'return', e: aAwaits ? { k: 'await', arg: callExpr(b) } : callExpr(b) }];
	const cBody: Stmt[] = [log(`${c} 1`), { k: 'return', e: aAwaits ? callExpr(b) : { k: 'await', arg: callExpr(b) } }];
	const fns = [asyncFn(a, aBody), asyncFn(b, bBody), asyncFn(c, cBody)];
	const calls = rng.shuffle([thenLog(callExpr(a), a), thenLog(callExpr(c), c), ticks(rng.int(3, 5), 'tick')]);
	return { fns, main: mainWith(rng, calls, rng.int(0, 1)) };
}

const GENERATORS: Record<string, (rng: Rng) => Program> = {
	'sync-prefix': syncPrefix,
	'await-timer': awaitTimer,
	interleave,
	'result-then': resultThen,
	'loop-await': loopAwait,
	'nested-no-await': nestedNoAwait,
	'try-reject': tryReject,
	'return-chain': returnChain
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/sync-prefix': ['body-deferred', 'await-blocks'],
	'intern/await-timer': ['timer-as-micro', 'await-blocks'],
	'intern/interleave': ['await-blocks', 'resume-runs-through'],
	'intern/result-then': ['await-blocks', 'resume-runs-through'],
	'junior/loop-await': ['loop-parallel', 'await-blocks'],
	'junior/nested-no-await': ['missing-await-waits', 'body-deferred'],
	'junior/try-reject': ['catch-misses-await', 'await-blocks'],
	'junior/return-chain': ['return-promise-free', 'await-blocks']
};

const MAX_LINES = 16;
const TRIES = 300;

interface Drawn {
	source: string;
	answer: string[];
	wrong: Record<string, string[] | null>;
}

function draw(p: Program, required: readonly string[]): Drawn | null {
	const answer = execute(p, RIGHT, true);
	if (answer === null || answer.length > MAX_LINES) return null;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = execute(p, { ...RIGHT, ...change }, false);
			const same = value === null || (value.length === answer.length && value.every((l, i) => l === answer[i]));
			return [id, same ? null : value];
		})
	);
	if (required.some((id) => wrong[id] === null)) return null;
	return { source: printProgram(p), answer, wrong };
}

/** A fixed program of the class, used when no drawn program fits: every required misconception changes its output. */
function fallback(classId: string): Program {
	const twoSteps = (n: string): Stmt[] => [
		log(`${n} 1`),
		awaitStmt({ k: 'null' }),
		log(`${n} 2`),
		awaitStmt({ k: 'null' }),
		log(`${n} 3`)
	];
	switch (classId) {
		case 'sync-prefix':
		case 'interleave':
			return {
				fns: [asyncFn('load', twoSteps('load')), asyncFn('save', twoSteps('save'))],
				main: [log('start'), callStmt('load'), log('middle'), callStmt('save'), log('end')]
			};
		case 'await-timer':
			return {
				fns: [
					asyncFn('load', [log('load 1'), awaitStmt({ k: 'sleep', ms: 0 }), log('load 2')]),
					asyncFn('save', twoSteps('save'))
				],
				main: [callStmt('load'), callStmt('save'), log('end')]
			};
		case 'loop-await':
			return {
				fns: [
					asyncFn('upload', [
						{
							k: 'forOf',
							name: 'x',
							items: ['a', 'b'],
							body: [
								log('upload start', { k: 'var', name: 'x' }),
								awaitStmt({ k: 'null' }),
								log('upload done', { k: 'var', name: 'x' })
							]
						}
					]),
					asyncFn('poll', twoSteps('poll'))
				],
				main: [callStmt('upload'), callStmt('poll'), log('end')]
			};
		case 'nested-no-await':
			return {
				fns: [
					asyncFn('submit', [
						log('submit 1'),
						callStmt('track', str('click')),
						log('submit 2'),
						awaitStmt({ k: 'null' }),
						log('submit 3')
					]),
					asyncFn(
						'track',
						[
							log('track start', { k: 'var', name: 'e' }),
							awaitStmt({ k: 'null' }),
							log('track end', { k: 'var', name: 'e' })
						],
						['e']
					)
				],
				main: [callStmt('submit'), log('end')]
			};
		case 'try-reject':
			return {
				fns: [
					asyncFn('load', [
						log('load 1'),
						{
							k: 'try',
							body: [awaitStmt({ k: 'reject', message: 'timeout' }), log('load 2')],
							param: 'e',
							handler: [log('caught', { k: 'message', name: 'e' })]
						},
						log('load 3')
					]),
					asyncFn('poll', twoSteps('poll'))
				],
				main: [
					{
						k: 'expr',
						e: {
							k: 'catch',
							target: callExpr('load'),
							handler: { param: 'e', body: [log('outer', { k: 'message', name: 'e' })] }
						}
					},
					callStmt('poll'),
					log('end')
				]
			};
		case 'result-then':
			return {
				fns: [asyncFn('load', [...twoSteps('load'), { k: 'return', e: str('ok') }]), asyncFn('save', twoSteps('save'))],
				main: [thenLog(callExpr('load'), 'load result'), callStmt('save'), log('end')]
			};
		default:
			// return-chain.
			return {
				fns: [
					asyncFn('load', [{ k: 'return', e: { k: 'resolve', arg: str('a') } }]),
					asyncFn('save', [{ k: 'return', e: { k: 'await', arg: { k: 'resolve', arg: str('b') } } }])
				],
				main: [thenLog(callExpr('load'), 'load'), thenLog(callExpr('save'), 'save'), ticks(4, 'tick')]
			};
	}
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const generate = GENERATORS[input.classId];
	if (!generate) throw new Error(`${descriptor.key}: no generator for ${input.classId}`);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	let drawn: Drawn | null = null;
	for (let tries = 0; tries < TRIES && drawn === null; tries += 1) drawn = draw(generate(rng), required);
	drawn ??= draw(fallback(input.classId), required);
	if (drawn === null) throw new Error(`${descriptor.key}: the fallback of ${input.classId} does not fit`);
	const { source, answer, wrong } = drawn;
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Что напечатает программа на JavaScript (Node.js 24, файл запускается как обычный скрипт)? ' +
				'Введите вывод построчно, как он появится на экране.',
			code: { language: 'javascript', source }
		},
		answer: { kind: 'sequence', value: answer }
	});
	return {
		instance,
		reference: () => nodeOutputProbe(source, 'javascript'),
		wrong: () =>
			Object.fromEntries(
				Object.entries(wrong).map(([id, value]) => [
					id,
					value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
