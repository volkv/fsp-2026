// Signals: a small reactive library shown in full (signals, lazy cached computed values, effects, batch) and a scenario
// of its use; the candidate predicts the output — which computed values recompute and which effects run, and when.
// The library of the class is either the scheduled pull library (lazy computed values, effects queued and run after
// the change has spread) or the eager push library (every change runs its subscribers at once). The generator models
// both libraries and the misconceptions as variants of the models; the gate runs the shown program with Node.
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
import { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Value = number | boolean;
type Op = '+' | '-' | '*';

/** The body of a computed value or of a writing effect: reads of named signals and computed values. */
type Expr =
	| { kind: 'bin'; op: Op; a: string; b: string | number }
	| { kind: 'clamp'; fn: 'min' | 'max'; a: string; bound: number }
	| { kind: 'cond'; flag: string; then: string; otherwise: string };

/** What a logging effect prints after its label: a read of a node, or a branch on a flag. */
type Term = { kind: 'ref'; ref: string } | { kind: 'cond'; flag: string; then: string; otherwise: string };

interface EffectDef {
	label: string;
	/** A logging effect prints its label and the terms. */
	terms: Term[];
	/** A writing effect computes `expr`, writes it into the signal `target`, then prints its label and the value. */
	write: { target: string; expr: Expr } | null;
}

interface SetOp {
	target: string;
	value: Value;
}

type Action = ({ kind: 'set' } & SetOp) | { kind: 'read'; target: string } | { kind: 'batch'; sets: SetOp[] };

interface Scenario {
	lib: 'pull' | 'push';
	signals: { name: string; init: Value }[];
	computeds: { name: string; expr: Expr }[];
	effects: EffectDef[];
	actions: Action[];
}

// ---------------------------------------------------------------------------------------------------------------
// The shown libraries.

const PULL_LIBRARY = `// A small reactive library.
let current = null; // the computation that is reading right now
let batchDepth = 0;
let flushing = false;
let nextId = 0;
const pending = new Set(); // effects waiting to run

function subscribe(subs) {
  if (current !== null) {
    subs.add(current);
    current.deps.add(subs);
  }
}

function track(node, fn) {
  for (const subs of node.deps) subs.delete(node);
  node.deps.clear();
  const prev = current;
  current = node;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

function flush() {
  if (batchDepth > 0 || flushing) return;
  flushing = true;
  while (pending.size > 0) {
    const next = [...pending].sort((x, y) => x.id - y.id)[0];
    pending.delete(next);
    next.run();
  }
  flushing = false;
}

function signal(value) {
  const subs = new Set();
  return {
    get() {
      subscribe(subs);
      return value;
    },
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const sub of [...subs]) sub.notify();
      flush();
    },
  };
}

function computed(fn) {
  const subs = new Set();
  let value;
  let dirty = true;
  const node = {
    deps: new Set(),
    notify() {
      if (dirty) return;
      dirty = true;
      for (const sub of [...subs]) sub.notify();
    },
  };
  return {
    get() {
      subscribe(subs);
      if (dirty) {
        value = track(node, fn);
        dirty = false;
      }
      return value;
    },
  };
}

function effect(fn) {
  const node = {
    id: nextId++,
    deps: new Set(),
    notify() {
      pending.add(node);
    },
    run() {
      track(node, fn);
    },
  };
  node.run();
}

function batch(fn) {
  batchDepth++;
  try {
    fn();
  } finally {
    batchDepth--;
    flush();
  }
}`;

const PUSH_LIBRARY = `// A small reactive library: a change is pushed to its subscribers at once.
let current = null; // the computation that is reading right now

function signal(value) {
  const subs = new Set();
  return {
    get() {
      if (current !== null) subs.add(current);
      return value;
    },
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const run of [...subs]) run();
    },
  };
}

function effect(fn) {
  const run = () => {
    const prev = current;
    current = run;
    try {
      fn();
    } finally {
      current = prev;
    }
  };
  run();
}

function computed(fn) {
  const inner = signal(undefined);
  effect(() => inner.set(fn()));
  return { get: inner.get };
}`;

// ---------------------------------------------------------------------------------------------------------------
// Rendering a scenario as JavaScript.

const read = (name: string): string => `${name}.get()`;

function renderExpr(e: Expr): string {
	switch (e.kind) {
		case 'bin':
			return `${read(e.a)} ${e.op} ${typeof e.b === 'number' ? String(e.b) : read(e.b)}`;
		case 'clamp':
			return `Math.${e.fn}(${read(e.a)}, ${e.bound})`;
		case 'cond':
			return `${read(e.flag)} ? ${read(e.then)} : ${read(e.otherwise)}`;
	}
}

function renderTerm(t: Term): string {
	return t.kind === 'ref' ? read(t.ref) : `${read(t.flag)} ? ${read(t.then)} : ${read(t.otherwise)}`;
}

function renderSet(s: SetOp): string {
	return `${s.target}.set(${String(s.value)});`;
}

function renderScenario(s: Scenario): string {
	const lines: string[] = [s.lib === 'pull' ? PULL_LIBRARY : PUSH_LIBRARY, '', '// Usage.'];
	for (const sig of s.signals) lines.push(`const ${sig.name} = signal(${String(sig.init)});`);
	for (const c of s.computeds) {
		lines.push(
			`const ${c.name} = computed(() => {`,
			`  console.log('calc ${c.name}');`,
			`  return ${renderExpr(c.expr)};`,
			'});'
		);
	}
	for (const e of s.effects) {
		if (e.write) {
			lines.push(
				'effect(() => {',
				`  const next = ${renderExpr(e.write.expr)};`,
				`  ${e.write.target}.set(next);`,
				`  console.log('${e.label}', next);`,
				'});'
			);
		} else {
			lines.push(`effect(() => console.log('${e.label}', ${e.terms.map(renderTerm).join(', ')}));`);
		}
	}
	lines.push('');
	for (const a of s.actions) {
		if (a.kind === 'set') lines.push(renderSet(a));
		else if (a.kind === 'read') lines.push(`console.log('${a.target} =', ${read(a.target)});`);
		else lines.push('batch(() => {', ...a.sets.map((x) => `  ${renderSet(x)}`), '});');
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Models. A read callback returns the value of a node; the expression is evaluated in the order JavaScript does.

function evalExpr(e: Expr, get: (name: string) => Value): Value {
	switch (e.kind) {
		case 'bin': {
			const x = Number(get(e.a));
			const y = typeof e.b === 'number' ? e.b : Number(get(e.b));
			return e.op === '+' ? x + y : e.op === '-' ? x - y : x * y;
		}
		case 'clamp': {
			const x = Number(get(e.a));
			return e.fn === 'min' ? Math.min(x, e.bound) : Math.max(x, e.bound);
		}
		case 'cond':
			return get(e.flag) ? get(e.then) : get(e.otherwise);
	}
}

function evalTerm(t: Term, get: (name: string) => Value): Value {
	return t.kind === 'ref' ? get(t.ref) : get(t.flag) ? get(t.then) : get(t.otherwise);
}

/** The variants of the pull library a misconception imagines; all false is the shown library. */
interface PullFlags {
	/** A computed value recomputes when created and at once when a source changes. */
	eager: boolean;
	/** Every read of a computed value recomputes it. */
	noCache: boolean;
	/** Writing the same value notifies the subscribers. */
	sameValueNotifies: boolean;
	/** `batch` does not defer the effects. */
	noBatch: boolean;
	/** An effect runs at once on every notification instead of waiting in the queue. */
	immediateEffects: boolean;
	/** A queued effect is skipped when every value it read last time is the same. */
	equalSkips: boolean;
	/** The dependencies are those of the first run and never change. */
	staticDeps: boolean;
	/** The dependencies of earlier runs are kept: a branch not taken any more still notifies. */
	stickyDeps: boolean;
	/** A write inside a running effect runs the effects it queues at once, nested. */
	nestedFlush: boolean;
}

const PULL_RIGHT: PullFlags = {
	eager: false,
	noCache: false,
	sameValueNotifies: false,
	noBatch: false,
	immediateEffects: false,
	equalSkips: false,
	staticDeps: false,
	stickyDeps: false,
	nestedFlush: false
};

type Subs = Set<PullSub>;

interface PullTracker {
	deps: Set<Subs>;
	/** Ran at least once (the static-dependencies misconception stops tracking after that). */
	frozen: boolean;
}

interface PullSignal {
	kind: 'signal';
	value: Value;
	subs: Subs;
}

interface PullComputed extends PullTracker {
	kind: 'computed';
	name: string;
	expr: Expr;
	value: Value;
	dirty: boolean;
	subs: Subs;
}

interface PullEffect extends PullTracker {
	kind: 'effect';
	id: number;
	def: EffectDef;
	/** The values the last run read, for the equal-skips misconception. */
	seen: [PullSignal | PullComputed, Value][];
}

type PullSub = PullComputed | PullEffect;

class PullModel {
	readonly out: string[] = [];
	readonly #f: PullFlags;
	readonly #nodes = new Map<string, PullSignal | PullComputed>();
	readonly #pending = new Set<PullEffect>();
	#current: PullSub | null = null;
	#batchDepth = 0;
	#flushing = false;
	#nextId = 0;

	constructor(flags: PullFlags) {
		this.#f = flags;
	}

	#node(name: string): PullSignal | PullComputed {
		const node = this.#nodes.get(name);
		if (!node) throw new Error(`unknown node ${name}`);
		return node;
	}

	#subscribe(subs: Subs): void {
		const c = this.#current;
		if (c === null || (this.#f.staticDeps && c.frozen)) return;
		subs.add(c);
		c.deps.add(subs);
	}

	#track<T>(node: PullSub, fn: () => T): T {
		if (!this.#f.stickyDeps && !(this.#f.staticDeps && node.frozen)) {
			for (const subs of node.deps) subs.delete(node);
			node.deps.clear();
		}
		const prev = this.#current;
		this.#current = node;
		try {
			return fn();
		} finally {
			this.#current = prev;
			node.frozen = true;
		}
	}

	#recompute(c: PullComputed): void {
		c.value = this.#track(c, () => {
			this.out.push(`calc ${c.name}`);
			return evalExpr(c.expr, (n) => this.get(n));
		});
		c.dirty = false;
	}

	/** The value of a computed value without subscribing the reader. */
	#peek(node: PullSignal | PullComputed): Value {
		if (node.kind === 'computed' && (node.dirty || this.#f.noCache)) this.#recompute(node);
		return node.value;
	}

	get(name: string): Value {
		const node = this.#node(name);
		this.#subscribe(node.subs);
		const value = this.#peek(node);
		const c = this.#current;
		if (c?.kind === 'effect') c.seen.push([node, value]);
		return value;
	}

	#flush(): void {
		if (this.#batchDepth > 0 || (this.#flushing && !this.#f.nestedFlush)) return;
		const was = this.#flushing;
		this.#flushing = true;
		while (this.#pending.size > 0) {
			const next = [...this.#pending].sort((x, y) => x.id - y.id)[0];
			if (!next) break;
			this.#pending.delete(next);
			this.#runEffect(next, true);
		}
		this.#flushing = was;
	}

	#notify(sub: PullSub): void {
		if (sub.kind === 'computed') {
			if (this.#f.eager) {
				this.#recompute(sub);
			} else {
				if (sub.dirty) return;
				sub.dirty = true;
			}
			for (const next of [...sub.subs]) this.#notify(next);
			return;
		}
		if (this.#f.immediateEffects && this.#batchDepth === 0) this.#runEffect(sub, false);
		else this.#pending.add(sub);
	}

	set(target: string, value: Value): void {
		const node = this.#node(target);
		if (node.kind !== 'signal') throw new Error(`${target} is not a signal`);
		if (!this.#f.sameValueNotifies && Object.is(value, node.value)) return;
		node.value = value;
		for (const sub of [...node.subs]) this.#notify(sub);
		this.#flush();
	}

	#runEffect(node: PullEffect, queued: boolean): void {
		if (
			this.#f.equalSkips &&
			queued &&
			node.seen.length > 0 &&
			node.seen.every(([source, value]) => Object.is(this.#peek(source), value))
		)
			return;
		node.seen = [];
		this.#track(node, () => {
			const get = (n: string): Value => this.get(n);
			const { def } = node;
			if (def.write) {
				const next = evalExpr(def.write.expr, get);
				this.set(def.write.target, next);
				this.out.push(`${def.label} ${String(next)}`);
			} else {
				const values = def.terms.map((t) => String(evalTerm(t, get)));
				this.out.push([def.label, ...values].join(' '));
			}
		});
	}

	signal(name: string, init: Value): void {
		this.#nodes.set(name, { kind: 'signal', value: init, subs: new Set() });
	}

	computed(name: string, expr: Expr): void {
		const c: PullComputed = {
			kind: 'computed',
			name,
			expr,
			value: 0,
			dirty: true,
			subs: new Set(),
			deps: new Set(),
			frozen: false
		};
		this.#nodes.set(name, c);
		if (this.#f.eager) this.#recompute(c);
	}

	effect(def: EffectDef): void {
		const node: PullEffect = { kind: 'effect', id: this.#nextId++, def, deps: new Set(), frozen: false, seen: [] };
		this.#runEffect(node, false);
	}

	batch(sets: readonly SetOp[]): void {
		if (!this.#f.noBatch) this.#batchDepth += 1;
		for (const s of sets) this.set(s.target, s.value);
		if (!this.#f.noBatch) this.#batchDepth -= 1;
		this.#flush();
	}
}

/** The push library; `retrack` — the misconception that it drops the dependencies of earlier runs. */
interface PushFlags {
	sameValueNotifies: boolean;
	retrack: boolean;
}

interface Runner {
	deps: Set<Set<Runner>>;
	run: () => void;
}

class PushModel {
	readonly out: string[] = [];
	readonly #f: PushFlags;
	readonly #signals = new Map<string, { value: Value | undefined; subs: Set<Runner> }>();
	#current: Runner | null = null;

	constructor(flags: PushFlags) {
		this.#f = flags;
	}

	#signal(name: string): { value: Value | undefined; subs: Set<Runner> } {
		const s = this.#signals.get(name);
		if (!s) throw new Error(`unknown node ${name}`);
		return s;
	}

	get(name: string): Value {
		const s = this.#signal(name);
		if (this.#current !== null) {
			s.subs.add(this.#current);
			this.#current.deps.add(s.subs);
		}
		if (s.value === undefined) throw new Error(`${name} read before it has a value`);
		return s.value;
	}

	set(name: string, value: Value): void {
		const s = this.#signal(name);
		if (!this.#f.sameValueNotifies && Object.is(value, s.value)) return;
		s.value = value;
		for (const runner of [...s.subs]) runner.run();
	}

	#effect(body: () => void): void {
		const runner: Runner = {
			deps: new Set(),
			run: () => {
				if (this.#f.retrack) {
					for (const subs of runner.deps) subs.delete(runner);
					runner.deps.clear();
				}
				const prev = this.#current;
				this.#current = runner;
				try {
					body();
				} finally {
					this.#current = prev;
				}
			}
		};
		runner.run();
	}

	signal(name: string, init: Value): void {
		this.#signals.set(name, { value: init, subs: new Set() });
	}

	computed(name: string, expr: Expr): void {
		this.#signals.set(name, { value: undefined, subs: new Set() });
		this.#effect(() => {
			this.out.push(`calc ${name}`);
			this.set(
				name,
				evalExpr(expr, (n) => this.get(n))
			);
		});
	}

	effect(def: EffectDef): void {
		this.#effect(() => {
			const values = def.terms.map((t) => String(evalTerm(t, (n) => this.get(n))));
			this.out.push([def.label, ...values].join(' '));
		});
	}

	batch(): void {
		throw new Error('the push library has no batch');
	}
}

/**
 * The misconception that the push library is glitch-free: a change recomputes the computed values it reaches in
 * topological order, each once, and only then runs each reached effect once. Dependencies accumulate as in the
 * shown library.
 */
class GlitchFreeModel {
	readonly out: string[] = [];
	readonly #values = new Map<string, Value>();
	readonly #computeds: { name: string; expr: Expr; deps: Set<string> }[] = [];
	readonly #effects: { def: EffectDef; deps: Set<string> }[] = [];

	#reader(deps: Set<string>): (name: string) => Value {
		return (name) => {
			deps.add(name);
			const v = this.#values.get(name);
			if (v === undefined) throw new Error(`unknown node ${name}`);
			return v;
		};
	}

	#runComputed(c: { name: string; expr: Expr; deps: Set<string> }): void {
		this.out.push(`calc ${c.name}`);
		this.#values.set(c.name, evalExpr(c.expr, this.#reader(c.deps)));
	}

	#runEffect(e: { def: EffectDef; deps: Set<string> }): void {
		const values = e.def.terms.map((t) => String(evalTerm(t, this.#reader(e.deps))));
		this.out.push([e.def.label, ...values].join(' '));
	}

	signal(name: string, init: Value): void {
		this.#values.set(name, init);
	}

	computed(name: string, expr: Expr): void {
		const c = { name, expr, deps: new Set<string>() };
		this.#computeds.push(c);
		this.#runComputed(c);
	}

	effect(def: EffectDef): void {
		const e = { def, deps: new Set<string>() };
		this.#effects.push(e);
		this.#runEffect(e);
	}

	get(name: string): Value {
		const v = this.#values.get(name);
		if (v === undefined) throw new Error(`unknown node ${name}`);
		return v;
	}

	set(name: string, value: Value): void {
		if (Object.is(this.#values.get(name), value)) return;
		this.#values.set(name, value);
		const changed = new Set([name]);
		for (const c of this.#computeds) {
			if (![...c.deps].some((d) => changed.has(d))) continue;
			const before = this.#values.get(c.name);
			this.#runComputed(c);
			if (!Object.is(before, this.#values.get(c.name))) changed.add(c.name);
		}
		for (const e of this.#effects) if ([...e.deps].some((d) => changed.has(d))) this.#runEffect(e);
	}

	batch(): void {
		throw new Error('the push library has no batch');
	}
}

interface Model {
	out: string[];
	signal(name: string, init: Value): void;
	computed(name: string, expr: Expr): void;
	effect(def: EffectDef): void;
	get(name: string): Value;
	set(name: string, value: Value): void;
	batch(sets: readonly SetOp[]): void;
}

function run(s: Scenario, model: Model): string[] {
	for (const sig of s.signals) model.signal(sig.name, sig.init);
	for (const c of s.computeds) model.computed(c.name, c.expr);
	for (const e of s.effects) model.effect(e);
	for (const a of s.actions) {
		if (a.kind === 'set') model.set(a.target, a.value);
		else if (a.kind === 'read') model.out.push(`${a.target} = ${String(model.get(a.target))}`);
		else model.batch(a.sets);
	}
	return model.out;
}

/** The misconceptions of the descriptor as models; a model of the other library does not apply. */
const WRONG_MODELS: Record<string, { lib: 'pull' | 'push'; make: () => Model }> = {
	'eager-computed': { lib: 'pull', make: () => new PullModel({ ...PULL_RIGHT, eager: true }) },
	'no-cache': { lib: 'pull', make: () => new PullModel({ ...PULL_RIGHT, noCache: true }) },
	'same-value-notifies': { lib: 'pull', make: () => new PullModel({ ...PULL_RIGHT, sameValueNotifies: true }) },
	'no-batch': { lib: 'pull', make: () => new PullModel({ ...PULL_RIGHT, noBatch: true }) },
	'glitch-in-pull': { lib: 'pull', make: () => new PullModel({ ...PULL_RIGHT, immediateEffects: true }) },
	'equal-skips': { lib: 'pull', make: () => new PullModel({ ...PULL_RIGHT, equalSkips: true }) },
	'static-deps': { lib: 'pull', make: () => new PullModel({ ...PULL_RIGHT, staticDeps: true }) },
	'sticky-deps': { lib: 'pull', make: () => new PullModel({ ...PULL_RIGHT, stickyDeps: true }) },
	'nested-flush': { lib: 'pull', make: () => new PullModel({ ...PULL_RIGHT, nestedFlush: true }) },
	'same-value-in-push': {
		lib: 'push',
		make: () => new PushModel({ sameValueNotifies: true, retrack: false })
	},
	'glitch-free-push': { lib: 'push', make: () => new GlitchFreeModel() },
	'cleanup-in-push': { lib: 'push', make: () => new PushModel({ sameValueNotifies: false, retrack: true }) }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/lazy-cache': ['eager-computed', 'no-cache', 'same-value-notifies'],
	'middle/batch': ['no-batch', 'equal-skips'],
	'middle/diamond': ['glitch-in-pull'],
	'middle/push-glitch': ['glitch-free-push', 'same-value-in-push'],
	'senior/dynamic-deps': ['static-deps', 'sticky-deps'],
	'senior/effect-writes': ['nested-flush', 'no-batch'],
	'senior/diamond-branch': ['glitch-in-pull', 'no-batch', 'sticky-deps'],
	'senior/push-branch': ['cleanup-in-push', 'glitch-free-push']
};

// ---------------------------------------------------------------------------------------------------------------
// Scenarios of the classes.

const SIGNAL_NAMES = ['price', 'qty', 'rate', 'base', 'step', 'fee', 'width', 'height', 'bonus', 'count'] as const;
const FLAG_NAMES = ['vip', 'compact', 'manual', 'archived', 'expanded', 'useBonus'] as const;
const COMPUTED_NAMES = [
	'total',
	'sum',
	'scaled',
	'capped',
	'area',
	'margin',
	'grand',
	'net',
	'picked',
	'span'
] as const;
const LABELS = ['view', 'badge', 'header', 'footer', 'panel', 'status', 'chart', 'summary'] as const;

/** Names and current values of the signals while a scenario is drawn. */
class Draft {
	readonly rng: Rng;
	readonly values = new Map<string, Value>();
	readonly #signals: string[];
	readonly #flags: string[];
	readonly #computeds: string[];
	readonly #labels: string[];

	constructor(rng: Rng) {
		this.rng = rng;
		this.#signals = rng.shuffle(SIGNAL_NAMES);
		this.#flags = rng.shuffle(FLAG_NAMES);
		this.#computeds = rng.shuffle(COMPUTED_NAMES);
		this.#labels = rng.shuffle(LABELS);
	}

	#take(pool: string[]): string {
		const name = pool.shift();
		if (name === undefined) throw new Error('name pool exhausted');
		return name;
	}

	signal(init: Value): { name: string; init: Value } {
		const name = this.#take(typeof init === 'boolean' ? this.#flags : this.#signals);
		this.values.set(name, init);
		return { name, init };
	}

	computedName(): string {
		return this.#take(this.#computeds);
	}

	label(): string {
		return this.#take(this.#labels);
	}

	/** A write of a new value (different from the current one) into a numeric signal. */
	change(target: string, min = 1, max = 12): SetOp {
		const now = this.values.get(target);
		let value = this.rng.int(min, max);
		if (value === now) value = value === max ? min : value + 1;
		this.values.set(target, value);
		return { target, value };
	}

	/** A write of the value the signal already holds. */
	same(target: string): SetOp {
		const value = this.values.get(target);
		if (value === undefined) throw new Error(`unknown signal ${target}`);
		return { target, value };
	}

	toggle(target: string): SetOp {
		const value = !this.values.get(target);
		this.values.set(target, value);
		return { target, value };
	}

	/** A write inside a batch that is undone later in the same batch. */
	restore(target: string): SetOp[] {
		const before = this.same(target);
		const away = this.change(target);
		this.values.set(target, before.value);
		return [away, before];
	}
}

const set = (s: SetOp): Action => ({ kind: 'set', ...s });
const ref = (name: string): Term => ({ kind: 'ref', ref: name });
const distinctInts = (rng: Rng, count: number, min: number, max: number): number[] =>
	rng.sample(
		Array.from({ length: max - min + 1 }, (_, i) => min + i),
		count
	);

function lazyCache(d: Draft): Scenario {
	const { rng } = d;
	const [ia, ib] = distinctInts(rng, 2, 1, 9) as [number, number];
	const a = d.signal(ia);
	const b = d.signal(ib);
	const first = d.computedName();
	const second = d.computedName();
	const computeds = [
		{ name: first, expr: { kind: 'bin', op: rng.pick<Op>(['+', '*']), a: a.name, b: b.name } as Expr },
		{
			name: second,
			expr: rng.bool()
				? ({ kind: 'bin', op: '*', a: first, b: rng.int(2, 5) } as Expr)
				: ({ kind: 'clamp', fn: 'min', a: first, bound: rng.int(8, 20) } as Expr)
		}
	];
	const extra = rng.bool();
	if (extra) computeds.push({ name: d.computedName(), expr: { kind: 'bin', op: '-', a: b.name, b: a.name } });
	const effectTerms = rng.pick([[ref(a.name), ref(first)], [ref(first)], [ref(b.name), ref(first)]]);
	const reads: Action[] = [
		{ kind: 'read', target: second },
		{ kind: 'read', target: second }
	];
	const rest = rng.shuffle(['same', 'a', 'b'] as const);
	const actions: Action[] = [...reads];
	for (const step of rest) {
		if (step === 'same') actions.push(set(d.same(rng.pick([a.name, b.name]))));
		else actions.push(set(d.change(step === 'a' ? a.name : b.name)));
		if (rng.bool(0.6)) actions.push({ kind: 'read', target: second });
	}
	const last = computeds[2];
	if (last && rng.bool()) actions.push({ kind: 'read', target: last.name });
	return {
		lib: 'pull',
		signals: [a, b],
		computeds,
		effects: [{ label: d.label(), terms: effectTerms, write: null }],
		actions
	};
}

function batchScenario(d: Draft): Scenario {
	const { rng } = d;
	const [ia, ib] = distinctInts(rng, 2, 1, 9) as [number, number];
	const a = d.signal(ia);
	const b = d.signal(ib);
	const sum = d.computedName();
	const effects: EffectDef[] = [{ label: d.label(), terms: [ref(a.name), ref(sum)], write: null }];
	if (rng.bool()) effects.push({ label: d.label(), terms: [ref(b.name)], write: null });
	const steps = rng.shuffle(['both', 'restore', 'single'] as const);
	const actions: Action[] = [];
	for (const step of steps) {
		if (step === 'both') {
			const sets = [d.change(a.name), d.change(b.name)];
			actions.push({ kind: 'batch', sets: rng.bool() ? sets : sets.reverse() });
		} else if (step === 'restore') {
			const back = d.restore(a.name);
			actions.push({ kind: 'batch', sets: rng.bool() ? back : [...back, d.change(b.name)] });
		} else actions.push(set(d.change(rng.pick([a.name, b.name]))));
	}
	if (rng.bool()) actions.push({ kind: 'read', target: sum });
	return {
		lib: 'pull',
		signals: [a, b],
		computeds: [{ name: sum, expr: { kind: 'bin', op: rng.pick<Op>(['+', '*']), a: a.name, b: b.name } }],
		effects,
		actions
	};
}

/** Two computed values from one signal joined again: by a third computed value or in one effect. */
function diamondShape(d: Draft): {
	a: { name: string; init: Value };
	computeds: { name: string; expr: Expr }[];
	joined: Term[];
	left: string;
} {
	const { rng } = d;
	const a = d.signal(rng.int(1, 9));
	const left = d.computedName();
	const right = d.computedName();
	const computeds: { name: string; expr: Expr }[] = [
		{ name: left, expr: { kind: 'bin', op: '*', a: a.name, b: rng.int(2, 5) } },
		{ name: right, expr: { kind: 'bin', op: '+', a: a.name, b: rng.int(1, 9) } }
	];
	let joined: Term[] = [ref(left), ref(right)];
	if (rng.bool()) {
		const join = d.computedName();
		computeds.push({ name: join, expr: { kind: 'bin', op: rng.pick<Op>(['+', '-']), a: left, b: right } });
		joined = [ref(join)];
	}
	return { a, computeds, joined, left };
}

function diamond(d: Draft): Scenario {
	const { rng } = d;
	const shape = diamondShape(d);
	const b = d.signal(rng.int(1, 9));
	const effects: EffectDef[] = [{ label: d.label(), terms: shape.joined, write: null }];
	if (rng.bool()) effects.push({ label: d.label(), terms: [ref(b.name), ref(shape.left)], write: null });
	const actions: Action[] = [set(d.change(shape.a.name))];
	for (const step of rng.shuffle(['a', 'b', 'read'] as const)) {
		if (step === 'a') actions.push(set(d.change(shape.a.name)));
		else if (step === 'b') actions.push(set(d.change(b.name)));
		else actions.push({ kind: 'read', target: shape.left });
	}
	return { lib: 'pull', signals: [shape.a, b], computeds: shape.computeds, effects, actions };
}

function pushGlitch(d: Draft): Scenario {
	const { rng } = d;
	const shape = diamondShape(d);
	const b = d.signal(rng.int(1, 9));
	const effects: EffectDef[] = [{ label: d.label(), terms: shape.joined, write: null }];
	if (rng.bool()) effects.push({ label: d.label(), terms: [ref(b.name)], write: null });
	const actions: Action[] = [set(d.change(shape.a.name))];
	for (const step of rng.shuffle(['a', 'same', 'b'] as const)) {
		if (step === 'a') actions.push(set(d.change(shape.a.name)));
		else if (step === 'same') actions.push(set(d.same(rng.pick([shape.a.name, b.name]))));
		else actions.push(set(d.change(b.name)));
	}
	if (rng.bool()) actions.push({ kind: 'read', target: shape.left });
	return { lib: 'push', signals: [shape.a, b], computeds: shape.computeds, effects, actions };
}

/** A flag and two numbers; a branch on the flag reads one of them. */
function branchShape(d: Draft): { flag: string; on: string; off: string; signals: { name: string; init: Value }[] } {
	const { rng } = d;
	const flag = d.signal(rng.bool());
	const [ia, ib] = distinctInts(rng, 2, 1, 9) as [number, number];
	const a = d.signal(ia);
	const b = d.signal(ib);
	return { flag: flag.name, on: a.name, off: b.name, signals: [flag, a, b] };
}

function dynamicDeps(d: Draft): Scenario {
	const { rng } = d;
	const br = branchShape(d);
	const pick = d.computedName();
	const scaled = d.computedName();
	const computeds: { name: string; expr: Expr }[] = [
		{ name: pick, expr: { kind: 'cond', flag: br.flag, then: br.on, otherwise: br.off } },
		{ name: scaled, expr: { kind: 'bin', op: '*', a: pick, b: rng.int(2, 5) } }
	];
	const effects: EffectDef[] = [{ label: d.label(), terms: [ref(scaled)], write: null }];
	const direct = rng.bool();
	if (direct)
		effects.push({
			label: d.label(),
			terms: [{ kind: 'cond', flag: br.flag, then: br.off, otherwise: br.on }],
			write: null
		});
	const taken = (): string => (d.values.get(br.flag) ? br.on : br.off);
	const idle = (): string => (d.values.get(br.flag) ? br.off : br.on);
	const actions: Action[] = [set(d.change(taken()))];
	actions.push(set(d.toggle(br.flag)));
	// The branch left behind is written, then the branch taken now; a batch switches back and writes both.
	actions.push(set(d.change(idle())), set(d.change(taken())));
	const sets = rng.shuffle([d.toggle(br.flag), d.change(rng.pick([br.on, br.off]))]);
	actions.push({ kind: 'batch', sets });
	actions.push(set(d.change(idle())));
	if (rng.bool()) actions.push({ kind: 'read', target: pick });
	return { lib: 'pull', signals: br.signals, computeds, effects, actions };
}

function effectWrites(d: Draft): Scenario {
	const { rng } = d;
	const [ia, ib] = distinctInts(rng, 2, 1, 9) as [number, number];
	const a = d.signal(ia);
	const b = d.signal(ib);
	const mirror = d.signal(0);
	const cap = rng.int(6, 10);
	const clamp = rng.bool();
	const expr: Expr = clamp
		? { kind: 'clamp', fn: 'min', a: a.name, bound: cap }
		: { kind: 'bin', op: '*', a: a.name, b: 2 };
	const join = d.computedName();
	const computeds: { name: string; expr: Expr }[] = [
		{ name: join, expr: { kind: 'bin', op: rng.pick<Op>(['+', '-']), a: mirror.name, b: b.name } }
	];
	const effects: EffectDef[] = [
		{ label: d.label(), terms: [], write: { target: mirror.name, expr } },
		{ label: d.label(), terms: rng.bool() ? [ref(join)] : [ref(mirror.name), ref(join)], write: null }
	];
	if (rng.bool()) effects.push({ label: d.label(), terms: [ref(a.name)], write: null });
	const actions: Action[] = [set(d.change(a.name, 1, cap - 1))];
	const steps = rng.shuffle(['batch', 'b', 'over'] as const);
	for (const step of steps) {
		if (step === 'batch') {
			const sets = [d.change(a.name, 1, cap - 1), d.change(b.name)];
			actions.push({ kind: 'batch', sets: rng.bool() ? sets : sets.reverse() });
		} else if (step === 'b') actions.push(set(d.change(b.name)));
		else {
			// Two writes past the cap: with a clamp the second one leaves the mirror as it is.
			actions.push(set(d.change(a.name, cap + 1, cap + 3)), set(d.change(a.name, cap + 4, cap + 6)));
		}
	}
	return { lib: 'pull', signals: [a, b, mirror], computeds, effects, actions };
}

function diamondBranch(d: Draft): Scenario {
	const { rng } = d;
	const br = branchShape(d);
	const scaled = d.computedName();
	const pick = d.computedName();
	const join = d.computedName();
	const computeds: { name: string; expr: Expr }[] = [
		{ name: scaled, expr: { kind: 'bin', op: '*', a: br.on, b: rng.int(2, 5) } },
		{ name: pick, expr: { kind: 'cond', flag: br.flag, then: br.on, otherwise: br.off } },
		{ name: join, expr: { kind: 'bin', op: rng.pick<Op>(['+', '-']), a: scaled, b: pick } }
	];
	const effects: EffectDef[] = [{ label: d.label(), terms: [ref(join)], write: null }];
	if (rng.bool()) effects.push({ label: d.label(), terms: [ref(br.flag), ref(pick)], write: null });
	const actions: Action[] = [];
	// Start on the branch that closes the diamond.
	if (!d.values.get(br.flag)) actions.push(set(d.toggle(br.flag)));
	actions.push(set(d.change(br.on)));
	actions.push({ kind: 'batch', sets: rng.shuffle([d.toggle(br.flag), d.change(br.off)]) });
	actions.push(set(d.change(br.on)));
	if (rng.bool()) actions.push({ kind: 'read', target: pick });
	return { lib: 'pull', signals: br.signals, computeds, effects, actions };
}

function pushBranch(d: Draft): Scenario {
	const { rng } = d;
	const br = branchShape(d);
	const scaled = d.computedName();
	const pick = d.computedName();
	const computeds: { name: string; expr: Expr }[] = [
		{ name: scaled, expr: { kind: 'bin', op: '*', a: br.on, b: rng.int(2, 5) } },
		{ name: pick, expr: { kind: 'cond', flag: br.flag, then: br.on, otherwise: br.off } }
	];
	const effects: EffectDef[] = [{ label: d.label(), terms: [ref(scaled), ref(pick)], write: null }];
	if (rng.bool())
		effects.push({
			label: d.label(),
			terms: [{ kind: 'cond', flag: br.flag, then: br.off, otherwise: br.on }],
			write: null
		});
	const actions: Action[] = [];
	if (!d.values.get(br.flag)) actions.push(set(d.toggle(br.flag)));
	actions.push(set(d.change(br.on)), set(d.toggle(br.flag)));
	// After the switch the branch left behind is written as well as the one taken now.
	for (const step of rng.shuffle(['on', 'off'] as const)) actions.push(set(d.change(step === 'on' ? br.on : br.off)));
	return { lib: 'push', signals: br.signals, computeds, effects, actions };
}

const SCENARIOS: Record<string, (d: Draft) => Scenario> = {
	'middle/lazy-cache': lazyCache,
	'middle/batch': batchScenario,
	'middle/diamond': diamond,
	'middle/push-glitch': pushGlitch,
	'senior/dynamic-deps': dynamicDeps,
	'senior/effect-writes': effectWrites,
	'senior/diamond-branch': diamondBranch,
	'senior/push-branch': pushBranch
};

interface Drawn {
	scenario: Scenario;
	answer: string[];
	wrong: Record<string, string[] | null>;
}

function evaluate(s: Scenario): Drawn {
	const answer = run(
		s,
		s.lib === 'pull' ? new PullModel(PULL_RIGHT) : new PushModel({ sameValueNotifies: false, retrack: false })
	);
	const wrong: Record<string, string[] | null> = {};
	for (const [id, m] of Object.entries(WRONG_MODELS)) {
		if (m.lib !== s.lib) {
			wrong[id] = null;
			continue;
		}
		const out = run(s, m.make());
		const same = out.length === answer.length && out.every((line, i) => line === answer[i]);
		wrong[id] = same ? null : out;
	}
	return { scenario: s, answer, wrong };
}

/** Draws scenarios until every required misconception of the class changes the answer; a fixed stream backs it up. */
function draw(rng: Rng, key: string): Drawn {
	const make = SCENARIOS[key];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${key}`);
	const required = REQUIRED[key] ?? [];
	const fits = (x: Drawn): boolean => required.every((id) => x.wrong[id] !== null);
	let last: Drawn | null = null;
	for (let tries = 0; tries < 100; tries += 1) {
		last = evaluate(make(new Draft(rng)));
		if (fits(last)) return last;
	}
	for (let tries = 0; tries < 100; tries += 1) {
		last = evaluate(make(new Draft(new Rng(`${descriptor.key}|fallback|${key}|${tries}`))));
		if (fits(last)) return last;
	}
	if (!last) throw new Error('unreachable');
	return last;
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { scenario, answer, wrong } = draw(rng, `${input.grade}/${input.classId}`);
	const source = renderScenario(scenario);
	const toAnswer = (lines: string[]) => ({ kind: 'sequence' as const, value: lines });
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Ниже — небольшая реактивная библиотека (сигналы, вычисляемые значения, эффекты) целиком и сценарий её ' +
				'использования. Что напечатает программа на JavaScript (Node.js)? Введите вывод построчно, как он появится ' +
				'на экране.',
			code: { language: 'javascript', source }
		},
		answer: toAnswer(answer)
	});
	return {
		instance,
		reference: () => nodeOutputProbe(source, 'javascript'),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const lines = wrong[id] ?? null;
					return [id, lines === null ? null : { kind: 'answer' as const, answer: toAnswer(lines) }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
