// Chains of `then`, `catch` and `finally`: a value passes through `finally` untouched, an error skips every `then` up
// to the nearest `catch`, a `catch` that returns a value puts the chain back on the success path, `then(onOk, onErr)`
// does not catch what its own `onOk` throws; a level up, two chains interleave turn by turn, and returning a promise from
// a handler, `finally` and a skipped `then` each cost their own microtask turns.
//
// The generator models the ECMAScript promise jobs (PromiseReactionJob, NewPromiseResolveThenableJob,
// Promise.prototype.finally through `then` of a resolved promise) for the constructs it emits; the gate runs every shown
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
// The shown program.

type Expr =
	| { k: 'str'; v: string }
	| { k: 'var'; name: string }
	| { k: 'message'; name: string }
	| { k: 'cat'; a: Expr; b: Expr }
	| { k: 'resolve'; arg: Expr | null }
	| { k: 'reject'; message: string }
	| { k: 'then'; target: Expr; ok: Arrow; err: Arrow | null }
	| { k: 'catch'; target: Expr; handler: Arrow }
	| { k: 'finally'; target: Expr; handler: Arrow };

interface Arrow {
	param: string | null;
	body: Stmt[];
}

type Stmt =
	| { k: 'log'; label: string; arg: Expr | null }
	| { k: 'expr'; e: Expr }
	| { k: 'return'; e: Expr }
	| { k: 'throw'; message: Expr };

const quote = (s: string): string => `'${s}'`;

type Link = { method: 'then'; ok: Arrow; err: Arrow | null } | { method: 'catch' | 'finally'; handler: Arrow };

function chainOf(e: Expr): { head: Expr; links: Link[] } {
	const links: Link[] = [];
	let head = e;
	for (;;) {
		if (head.k === 'then') links.unshift({ method: 'then', ok: head.ok, err: head.err });
		else if (head.k === 'catch' || head.k === 'finally') links.unshift({ method: head.k, handler: head.handler });
		else break;
		head = head.target;
	}
	return { head, links };
}

function printExpr(e: Expr, indent: string): string {
	switch (e.k) {
		case 'str':
			return quote(e.v);
		case 'var':
			return e.name;
		case 'message':
			return `${e.name}.message`;
		case 'cat':
			return `${printExpr(e.a, indent)} + ${printExpr(e.b, indent)}`;
		case 'resolve':
			return `Promise.resolve(${e.arg ? printExpr(e.arg, indent) : ''})`;
		case 'reject':
			return `Promise.reject(new Error(${quote(e.message)}))`;
		case 'then':
		case 'catch':
		case 'finally': {
			const { head, links } = chainOf(e);
			const inner = `${indent}  `;
			const parts = links.map((l) =>
				l.method === 'then'
					? `.then(${printArrow(l.ok, inner)}${l.err ? `, ${printArrow(l.err, inner)}` : ''})`
					: `.${l.method}(${printArrow(l.handler, inner)})`
			);
			return `${printExpr(head, indent)}\n${parts.map((p) => `${inner}${p}`).join('\n')}`;
		}
	}
}

function printArrow(a: Arrow, indent: string): string {
	const head = `(${a.param ?? ''}) =>`;
	const only = a.body.length === 1 ? a.body[0] : undefined;
	if (only?.k === 'log') return `${head} ${printStmt(only, '').trimEnd().replace(/;$/, '')}`;
	if (only?.k === 'return') return `${head} ${printExpr(only.e, indent)}`;
	return `${head} {\n${a.body.map((s) => printStmt(s, `${indent}  `)).join('')}${indent}}`;
}

function printStmt(s: Stmt, indent: string): string {
	switch (s.k) {
		case 'log':
			return `${indent}console.log(${quote(s.label)}${s.arg ? `, ${printExpr(s.arg, indent)}` : ''});\n`;
		case 'expr':
			return `${indent}${printExpr(s.e, indent)};\n`;
		case 'return':
			return `${indent}return ${printExpr(s.e, indent)};\n`;
		case 'throw':
			return `${indent}throw new Error(${printExpr(s.message, indent)});\n`;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The model: promises and jobs as ECMAScript defines them.

/** An outcome the model does not cover (an object in the output, an unhandled rejection): the program is drawn again. */
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

type Value = string | undefined | ErrorValue | Prom;

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

/** `user` — the reaction of a method call in the program (`then`, `catch`, `finally`), not an internal one. */
interface Reaction {
	ok: Handler | null;
	err: Handler | null;
	cap: Capability | null;
	user: 'then' | 'catch' | 'finally' | null;
}

/** A JavaScript exception thrown by a handler. */
class Thrown extends Error {
	readonly v: Value;
	constructor(v: Value) {
		super('thrown');
		this.v = v;
	}
}

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

/** The misconceptions as switches of the model; all off is JavaScript. */
interface Rules {
	finallyReceivesValue: boolean;
	finallyOverrides: boolean;
	throwRunsThen: boolean;
	catchStopsChain: boolean;
	catchKeepsRejected: boolean;
	onErrCatchesOnOk: boolean;
	returnedPromiseFree: boolean;
	chainRunsThrough: boolean;
	finallyFree: boolean;
	skipFree: boolean;
}

const RIGHT: Rules = {
	finallyReceivesValue: false,
	finallyOverrides: false,
	throwRunsThen: false,
	catchStopsChain: false,
	catchKeepsRejected: false,
	onErrCatchesOnOk: false,
	returnedPromiseFree: false,
	chainRunsThrough: false,
	finallyFree: false,
	skipFree: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'finally-receives-value': { finallyReceivesValue: true },
	'finally-overrides': { finallyOverrides: true },
	'throw-runs-then': { throwRunsThen: true },
	'catch-stops-chain': { catchStopsChain: true },
	'catch-keeps-rejected': { catchKeepsRejected: true },
	'onerr-catches-onok': { onErrCatchesOnOk: true },
	'returned-promise-free': { returnedPromiseFree: true },
	'chain-runs-through': { chainRunsThrough: true },
	'finally-free': { finallyFree: true },
	'skip-free': { skipFree: true }
};

const MAX_JOBS = 2000;

const isPromise = (v: Value): v is Prom => typeof v === 'object' && v.k === 'promise';
const isError = (v: Value): v is ErrorValue => typeof v === 'object' && v.k === 'error';

function show(v: Value): string {
	if (v === undefined) return 'undefined';
	if (typeof v === 'string') return v;
	throw new Unsupported('logs an object');
}

function native(f: (v: Value) => void): Handler {
	return (v) => {
		f(v);
		return { ok: true, v: undefined };
	};
}

class Machine {
	readonly out: string[] = [];
	readonly #rules: Rules;
	readonly #jobs: (() => void)[] = [];
	readonly #promises: Prom[] = [];
	readonly #global = new Env(null);
	#steps = 0;

	constructor(rules: Rules) {
		this.#rules = rules;
	}

	/** The output; `strict` — a rejection nobody handles is outside the model (Node would end the process). */
	run(main: readonly Stmt[], strict: boolean): string[] {
		this.#block(main, this.#global);
		for (let job = this.#jobs.shift(); job; job = this.#jobs.shift()) {
			if ((this.#steps += 1) > MAX_JOBS) throw new Unsupported('runaway jobs');
			job();
		}
		if (strict && this.#promises.some((p) => p.state === 'rejected' && !p.handled))
			throw new Unsupported('unhandled rejection');
		return this.out;
	}

	#newPromise(): Prom {
		const p: Prom = { k: 'promise', state: 'pending', value: undefined, reactions: [], handled: false };
		this.#promises.push(p);
		return p;
	}

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
				this.#jobs.push(() => {
					const fresh = this.#resolvers(p);
					this.#then(v, native(fresh.resolve), native(fresh.reject), null, null);
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
		for (const r of reactions) this.#react(r, state, v, this.#rules.chainRunsThrough && r.user !== null);
	}

	/** Queues the reaction job; some misconceptions run it at once. */
	#react(r: Reaction, state: 'fulfilled' | 'rejected', v: Value, now: boolean): void {
		const handler = state === 'fulfilled' ? r.ok : r.err;
		const skipping = handler === null && !(this.#rules.throwRunsThen && r.user === 'then' && state === 'rejected');
		const job = (): void => {
			this.#reactionJob(r, state, v);
		};
		if (now || (this.#rules.skipFree && skipping && r.user !== null)) job();
		else this.#jobs.push(job);
	}

	#reactionJob(r: Reaction, state: 'fulfilled' | 'rejected', v: Value): void {
		const rules = this.#rules;
		let handler = state === 'fulfilled' ? r.ok : r.err;
		let arg = v;
		if (handler === null && rules.throwRunsThen && r.user === 'then' && state === 'rejected') {
			handler = r.ok;
			arg = undefined;
		}
		let c: Completion = handler ? handler(arg) : { ok: state === 'fulfilled', v };
		if (!c.ok && rules.onErrCatchesOnOk && r.user === 'then' && state === 'fulfilled' && r.err) c = r.err(c.v);
		if (!r.cap) return;
		if (r.user === 'catch' && handler !== null && c.ok) {
			if (rules.catchStopsChain) return;
			if (rules.catchKeepsRejected) {
				r.cap.reject(v);
				return;
			}
		}
		if (c.ok && isPromise(c.v) && rules.returnedPromiseFree && r.user !== null && r.user !== 'finally') {
			this.#then(c.v, native(r.cap.resolve), native(r.cap.reject), null, null);
			return;
		}
		(c.ok ? r.cap.resolve : r.cap.reject)(c.v);
	}

	#then(p: Prom, ok: Handler | null, err: Handler | null, cap: Capability | null, user: Reaction['user']): void {
		p.handled = true;
		const r: Reaction = { ok, err, cap, user };
		if (p.state === 'pending') p.reactions.push(r);
		else this.#react(r, p.state, p.value, false);
	}

	#promiseResolve(v: Value): Prom {
		if (isPromise(v)) return v;
		const p = this.#newPromise();
		this.#settle(p, 'fulfilled', v);
		return p;
	}

	#handler(a: Arrow, env: Env): Handler {
		return (v) => {
			const scope = new Env(env);
			if (a.param) scope.set(a.param, v);
			try {
				return { ok: true, v: this.#block(a.body, scope) };
			} catch (e) {
				if (e instanceof Thrown) return { ok: false, v: e.v };
				throw e;
			}
		};
	}

	/** Promise.prototype.finally: the callback without arguments, then `then` of the promise of its result. */
	#finally(target: Prom, a: Arrow, env: Env): Prom {
		const cap = this.#resolvers(this.#newPromise());
		const callback = this.#handler(a, env);
		const rules = this.#rules;
		const wrap =
			(fulfilled: boolean): Handler =>
			(v) => {
				const c = callback(rules.finallyReceivesValue ? v : undefined);
				if (!c.ok) return c;
				const passed: Completion =
					rules.finallyOverrides && fulfilled && c.v !== undefined ? { ok: true, v: c.v } : { ok: fulfilled, v };
				if (rules.finallyFree) return passed;
				const inner = this.#resolvers(this.#newPromise());
				this.#then(this.#promiseResolve(c.v), () => passed, null, inner, null);
				return { ok: true, v: inner.promise };
			};
		this.#then(target, wrap(true), wrap(false), cap, 'finally');
		return cap.promise;
	}

	/** Runs statements synchronously; the value of a `return`, if any. */
	#block(stmts: readonly Stmt[], env: Env): Value {
		for (const s of stmts) {
			switch (s.k) {
				case 'log': {
					const v = s.arg ? this.#eval(s.arg, env) : undefined;
					this.out.push(s.arg ? `${s.label} ${show(v)}` : s.label);
					break;
				}
				case 'expr':
					this.#eval(s.e, env);
					break;
				case 'return':
					return this.#eval(s.e, env);
				case 'throw':
					throw new Thrown({ k: 'error', message: show(this.#eval(s.message, env)) });
			}
		}
		return undefined;
	}

	#eval(e: Expr, env: Env): Value {
		switch (e.k) {
			case 'str':
				return e.v;
			case 'var':
				return env.get(e.name);
			case 'message': {
				const v = env.get(e.name);
				if (!isError(v)) throw new Unsupported('message of a non-error');
				return v.message;
			}
			case 'cat':
				return `${show(this.#eval(e.a, env))}${show(this.#eval(e.b, env))}`;
			case 'resolve':
				return this.#promiseResolve(e.arg ? this.#eval(e.arg, env) : undefined);
			case 'reject': {
				const p = this.#newPromise();
				this.#settle(p, 'rejected', { k: 'error', message: e.message });
				return p;
			}
			case 'then':
			case 'catch':
			case 'finally': {
				const target = this.#eval(e.target, env);
				if (!isPromise(target)) throw new Error(`${e.k} on a non-promise`);
				if (e.k === 'finally') return this.#finally(target, e.handler, env);
				const cap = this.#resolvers(this.#newPromise());
				if (e.k === 'then')
					this.#then(target, this.#handler(e.ok, env), e.err ? this.#handler(e.err, env) : null, cap, 'then');
				else this.#then(target, null, this.#handler(e.handler, env), cap, 'catch');
				return cap.promise;
			}
		}
	}
}

function execute(main: readonly Stmt[], rules: Rules): string[] | null {
	try {
		return new Machine(rules).run(main, rules === RIGHT);
	} catch (e) {
		if (e instanceof Unsupported) return null;
		throw e;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Programs of the classes.

const WORDS = ['cart', 'user', 'order', 'page', 'token', 'item', 'draft', 'photo', 'report', 'city'] as const;
const SUFFIXES = ['!', '+1', '/ok', ':v2', '#', '*'] as const;
const ERRORS = ['timeout', 'denied', 'offline', 'empty', 'broken', 'expired'] as const;
const LABELS = ['step', 'got', 'value', 'next', 'then', 'data', 'res', 'ok'] as const;

const v = (): Expr => ({ k: 'var', name: 'v' });
const str = (s: string): Expr => ({ k: 'str', v: s });
const log = (label: string, arg: Expr | null = null): Stmt => ({ k: 'log', label, arg });
const arrow = (param: string | null, ...body: Stmt[]): Arrow => ({ param, body });

/** One link of a chain, applied to the expression so far. */
type Step = (target: Expr) => Expr;

class Steps {
	readonly #rng: Rng;
	readonly #labels: string[];
	constructor(rng: Rng) {
		this.#rng = rng;
		this.#labels = rng.shuffle(LABELS);
	}
	label(): string {
		return this.#labels.shift() ?? 'more';
	}
	/** `.then((v) => v + 'x')` or with a log. */
	transform(): Step {
		const suffix = this.#rng.pick(SUFFIXES);
		const add: Expr = { k: 'cat', a: v(), b: str(suffix) };
		if (this.#rng.bool(0.5))
			return (t) => ({ k: 'then', target: t, ok: arrow('v', { k: 'return', e: add }), err: null });
		const label = this.label();
		return (t) => ({
			k: 'then',
			target: t,
			ok: arrow('v', log(label, v()), { k: 'return', e: add }),
			err: null
		});
	}
	/** `.then((v) => console.log(label, v))`: the next link gets undefined. */
	logOnly(): Step {
		const label = this.label();
		return (t) => ({ k: 'then', target: t, ok: arrow('v', log(label, v())), err: null });
	}
	/** `.then((v) => { throw new Error(v) })` or with a fixed message. */
	throwing(): Step {
		const message: Expr = this.#rng.bool() ? v() : str(this.#rng.pick(ERRORS));
		const before = this.#rng.bool(0.5) ? [log(this.label(), v())] : [];
		return (t) => ({ k: 'then', target: t, ok: arrow('v', ...before, { k: 'throw', message }), err: null });
	}
	/** `.catch((e) => ...)`, returning a value or only logging. */
	catching(label: string, returns: boolean): Step {
		const body: Stmt[] = [log(label, { k: 'message', name: 'e' })];
		if (returns) body.push({ k: 'return', e: str(this.#rng.pick(WORDS)) });
		return (t) => ({ k: 'catch', target: t, handler: arrow('e', ...body) });
	}
	finallyLog(label: string, withParam: boolean): Step {
		return (t) => ({
			k: 'finally',
			target: t,
			handler: arrow(withParam ? 'x' : null, log(label, withParam ? { k: 'var', name: 'x' } : null))
		});
	}
	finallyReturn(): Step {
		const word = this.#rng.pick(WORDS);
		return (t) => ({ k: 'finally', target: t, handler: arrow(null, { k: 'return', e: str(word) }) });
	}
	/** The end of a chain: the result and the error, so nothing is left unhandled. */
	end(label: string): Step[] {
		return [
			(t) => ({ k: 'then', target: t, ok: arrow('v', log(label, v())), err: null }),
			(t) => ({ k: 'catch', target: t, handler: arrow('e', log('error', { k: 'message', name: 'e' })) })
		];
	}
}

function chainExpr(head: Expr, steps: readonly Step[]): Expr {
	return steps.reduce((e, s) => s(e), head);
}

const start = (rng: Rng): Expr => ({ k: 'resolve', arg: str(rng.pick(WORDS)) });

/** Intern A: an error skips the `then` links up to the nearest `catch`. */
function skipToCatch(rng: Rng): Stmt[] {
	const s = new Steps(rng);
	const steps: Step[] = [];
	for (let i = rng.int(0, 1); i > 0; i -= 1) steps.push(s.transform());
	steps.push(s.throwing());
	for (let i = rng.int(1, 2); i > 0; i -= 1) steps.push(rng.bool() ? s.transform() : s.logOnly());
	steps.push(s.catching('caught', rng.bool()));
	steps.push(s.transform());
	steps.push(...s.end('result'));
	return [{ k: 'expr', e: chainExpr(start(rng), steps) }, log('sync')];
}

/** Intern B: `finally` sees no value and cannot change it. */
function finallyValue(rng: Rng): Stmt[] {
	const s = new Steps(rng);
	const steps: Step[] = [s.transform(), s.finallyLog('finally', true), s.finallyReturn()];
	if (rng.bool()) steps.push(s.transform());
	steps.push(...s.end('result'));
	const shuffled = [steps[0] as Step, ...rng.shuffle(steps.slice(1, 3)), ...steps.slice(3)];
	return [{ k: 'expr', e: chainExpr(start(rng), shuffled) }];
}

/** Anchor: a `catch` that returns a value puts the chain back on the success path; a second error meets a second catch. */
function catchRecovers(rng: Rng): Stmt[] {
	const s = new Steps(rng);
	const head: Expr = rng.bool() ? { k: 'reject', message: rng.pick(ERRORS) } : start(rng);
	const steps: Step[] = [];
	// A rejected head leaves room for a skipped link before the first catch; a throwing link takes that room otherwise.
	if (head.k !== 'reject') steps.push(s.throwing());
	else if (rng.bool()) steps.push(s.transform());
	// The recovery is always followed by a second error: it skips a link and meets the second catch.
	steps.push(s.catching('first', true), s.transform(), s.throwing(), s.transform(), s.catching('second', true));
	steps.push(...s.end('result'));
	return [{ k: 'expr', e: chainExpr(head, steps) }];
}

/** Intern X: `then(onOk, onErr)` does not catch what its own `onOk` throws; on a rejection only `onErr` runs. */
function thenTwoArgs(rng: Rng): Stmt[] {
	const s = new Steps(rng);
	const message = rng.pick(ERRORS);
	const onErr = arrow('e', log('handled', { k: 'message', name: 'e' }), { k: 'return', e: str(rng.pick(WORDS)) });
	const throwing = arrow('v', log(s.label(), v()), { k: 'throw', message: str(message) });
	const steps: Step[] = [];
	if (rng.bool()) steps.push(s.transform());
	steps.push((t) => ({ k: 'then', target: t, ok: throwing, err: onErr }));
	if (rng.bool()) steps.push(s.transform());
	steps.push(s.catching('caught', true));
	steps.push((t) => ({
		k: 'then',
		target: t,
		ok: arrow('v', log('again', v())),
		err: arrow('e', log('missed', { k: 'message', name: 'e' }))
	}));
	steps.push(...s.end('result'));
	return [{ k: 'expr', e: chainExpr(start(rng), steps) }];
}

/** A chain of ticks: one log per microtask turn. */
function ticks(count: number, label: string): Stmt {
	const steps: Step[] = Array.from({ length: count }, (_, i) => (t: Expr) => ({
		k: 'then' as const,
		target: t,
		ok: arrow(null, log(`${label} ${i + 1}`)),
		err: null
	}));
	return { k: 'expr', e: chainExpr({ k: 'resolve', arg: null }, steps) };
}

/** Junior A: a handler that returns a promise holds its chain back by two turns. */
function returnPromiseTicks(rng: Rng): Stmt[] {
	const word = rng.pick(WORDS);
	const steps: Step[] = [
		(t) => ({ k: 'then', target: t, ok: arrow('v', log('a', v()), { k: 'return', e: v() }), err: null }),
		(t) => ({
			k: 'then',
			target: t,
			ok: arrow('v', { k: 'return', e: { k: 'resolve', arg: { k: 'cat', a: v(), b: str(rng.pick(SUFFIXES)) } } }),
			err: null
		}),
		(t) => ({ k: 'then', target: t, ok: arrow('v', log('b', v())), err: null })
	];
	if (rng.bool()) steps.shift();
	return rng.shuffle([
		{ k: 'expr' as const, e: chainExpr({ k: 'resolve', arg: str(word) }, steps) },
		ticks(rng.int(4, 5), 'tick')
	]);
}

/** Junior B: `finally` costs more turns than `then`. */
function finallyTicks(rng: Rng): Stmt[] {
	const s = new Steps(rng);
	const steps: Step[] = [
		s.finallyLog('finally', false),
		(t) => ({ k: 'then', target: t, ok: arrow('v', log('after', v())), err: null })
	];
	if (rng.bool())
		steps.unshift((t) => ({
			k: 'then',
			target: t,
			ok: arrow('v', log('before', v()), { k: 'return', e: v() }),
			err: null
		}));
	if (rng.bool(0.4)) steps.splice(steps.length - 1, 0, s.finallyReturn());
	return rng.shuffle([{ k: 'expr' as const, e: chainExpr(start(rng), steps) }, ticks(rng.int(4, 6), 'tick')]);
}

/** Anchor junior: a rejection passes every skipped `then` one turn at a time. */
function rejectSkips(rng: Rng): Stmt[] {
	const s = new Steps(rng);
	const steps: Step[] = [];
	for (let i = rng.int(1, 3); i > 0; i -= 1) steps.push(rng.bool() ? s.transform() : s.logOnly());
	steps.push(s.catching('caught', rng.bool()));
	if (rng.bool()) steps.push((t) => ({ k: 'then', target: t, ok: arrow('v', log('after', v())), err: null }));
	const head: Expr = { k: 'reject', message: rng.pick(ERRORS) };
	return rng.shuffle([{ k: 'expr' as const, e: chainExpr(head, steps) }, ticks(rng.int(3, 5), 'tick')]);
}

/** Junior X: `then(onOk, onErr)` whose `onOk` throws, against a chain of ticks. */
function twoArgsTicks(rng: Rng): Stmt[] {
	const s = new Steps(rng);
	const steps: Step[] = [
		(t) => ({
			k: 'then',
			target: t,
			ok: arrow('v', log('ok', v()), { k: 'throw', message: str(rng.pick(ERRORS)) }),
			err: arrow('e', log('same', { k: 'message', name: 'e' }))
		})
	];
	if (rng.bool()) steps.push(s.transform());
	steps.push(s.catching('caught', false));
	return rng.shuffle([{ k: 'expr' as const, e: chainExpr(start(rng), steps) }, ticks(rng.int(3, 5), 'tick')]);
}

const GENERATORS: Record<string, (rng: Rng) => Stmt[]> = {
	'skip-to-catch': skipToCatch,
	'finally-value': finallyValue,
	'catch-recovers': catchRecovers,
	'then-two-args': thenTwoArgs,
	'return-promise-ticks': returnPromiseTicks,
	'finally-ticks': finallyTicks,
	'reject-skips': rejectSkips,
	'two-args-ticks': twoArgsTicks
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/skip-to-catch': ['throw-runs-then', 'catch-stops-chain'],
	'intern/finally-value': ['finally-receives-value', 'finally-overrides'],
	'intern/catch-recovers': ['catch-stops-chain', 'catch-keeps-rejected'],
	'intern/then-two-args': ['onerr-catches-onok'],
	'junior/return-promise-ticks': ['returned-promise-free', 'chain-runs-through'],
	'junior/finally-ticks': ['finally-free'],
	'junior/reject-skips': ['skip-free'],
	'junior/two-args-ticks': ['onerr-catches-onok', 'skip-free']
};

const MAX_LINES = 14;
const TRIES = 300;

interface Drawn {
	source: string;
	answer: string[];
	wrong: Record<string, string[] | null>;
}

function draw(main: Stmt[], required: readonly string[]): Drawn | null {
	const answer = execute(main, RIGHT);
	if (answer === null || answer.length > MAX_LINES) return null;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = execute(main, { ...RIGHT, ...change });
			const same = value === null || (value.length === answer.length && value.every((x, i) => x === answer[i]));
			return [id, same ? null : value];
		})
	);
	if (required.some((id) => wrong[id] === null)) return null;
	return { source: main.map((s) => printStmt(s, '')).join(''), answer, wrong };
}

/** A fixed program of the class, used when no drawn program fits: every required misconception changes its output. */
function fallback(classId: string): Stmt[] {
	const thenDo =
		(...body: Stmt[]): Step =>
		(t) => ({ k: 'then', target: t, ok: arrow('v', ...body), err: null });
	const catchDo =
		(...body: Stmt[]): Step =>
		(t) => ({ k: 'catch', target: t, handler: arrow('e', ...body) });
	const message: Expr = { k: 'message', name: 'e' };
	const tail: Step[] = [thenDo(log('result', v())), catchDo(log('error', message))];
	const expr = (head: Expr, ...steps: Step[]): Stmt => ({ k: 'expr', e: chainExpr(head, steps) });
	const cart: Expr = { k: 'resolve', arg: str('cart') };
	switch (classId) {
		case 'skip-to-catch':
			return [
				expr(
					cart,
					thenDo(log('step', v()), { k: 'throw', message: v() }),
					thenDo(log('skipped', v())),
					catchDo(log('caught', message), { k: 'return', e: str('user') }),
					...tail
				)
			];
		case 'finally-value':
			return [
				expr(
					cart,
					(t) => ({ k: 'finally', target: t, handler: arrow('x', log('finally', { k: 'var', name: 'x' })) }),
					(t) => ({ k: 'finally', target: t, handler: arrow(null, { k: 'return', e: str('user') }) }),
					...tail
				)
			];
		case 'catch-recovers':
			return [
				expr(
					{ k: 'reject', message: 'timeout' },
					catchDo(log('first', message), { k: 'return', e: str('user') }),
					thenDo(log('step', v()), { k: 'throw', message: v() }),
					thenDo(log('skipped', v())),
					catchDo(log('second', message), { k: 'return', e: str('page') }),
					...tail
				)
			];
		case 'then-two-args':
			return [
				expr(
					cart,
					(t) => ({
						k: 'then',
						target: t,
						ok: arrow('v', { k: 'throw', message: str('broken') }),
						err: arrow('e', log('handled', message), { k: 'return', e: str('page') })
					}),
					catchDo(log('caught', message), { k: 'return', e: str('user') }),
					...tail
				)
			];
		case 'return-promise-ticks':
			return [
				expr(
					cart,
					(t) => ({ k: 'then', target: t, ok: arrow('v', { k: 'return', e: { k: 'resolve', arg: v() } }), err: null }),
					thenDo(log('b', v()))
				),
				ticks(4, 'tick')
			];
		case 'finally-ticks':
			return [
				expr(
					cart,
					(t) => ({ k: 'finally', target: t, handler: arrow(null, log('finally')) }),
					thenDo(log('after', v()))
				),
				ticks(4, 'tick')
			];
		case 'reject-skips':
			return [
				expr(
					{ k: 'reject', message: 'offline' },
					thenDo(log('step', v())),
					thenDo(log('then', v())),
					catchDo(log('caught', message))
				),
				ticks(4, 'tick')
			];
		default:
			// two-args-ticks.
			return [
				expr(
					cart,
					(t) => ({
						k: 'then',
						target: t,
						ok: arrow('v', log('ok', v()), { k: 'throw', message: str('broken') }),
						err: arrow('e', log('same', message))
					}),
					thenDo(log('next', v())),
					catchDo(log('caught', message))
				),
				ticks(3, 'tick')
			];
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
