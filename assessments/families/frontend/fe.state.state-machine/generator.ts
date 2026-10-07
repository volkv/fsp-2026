// State machines of an interface (data loading, a form wizard, a payment, an editor session, an upload, a session
// timeout): guards, context, entry and exit actions, eventless and delayed transitions, nested and parallel states.
// Given a sequence of events, the candidate gives the state after each event and the final context. The generator
// models the machine and the misconceptions as variants of the model; the gate checks the answer with an independent
// interpreter in Python that reads the same machine as JSON.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

/** A number, the payload `n` of the event or the name of a context variable. */
type Num = number | string;
type ActOp = '=' | '+=' | '-=' | '*=';
type CondOp = '<' | '<=' | '>' | '>=' | '==' | '!=';

interface Act {
	v: string;
	op: ActOp;
	x: Num;
}

interface Cond {
	/** A context variable or the payload `n`. */
	v: string;
	op: CondOp;
	x: Num;
}

interface Tr {
	/** `null` — an eventless transition. */
	event: string | null;
	cond: Cond | null;
	/** `null` — an internal transition: only its actions run. */
	target: string | null;
	actions: Act[];
}

interface St {
	name: string;
	parent: string | null;
	/** The initial child of a compound state. */
	initial: string | null;
	region: number;
	entry: Act[];
	exit: Act[];
	on: Tr[];
	always: Tr[];
	after: { ms: number; target: string; actions: Act[] } | null;
}

interface Machine {
	states: St[];
	/** The initial state of every region (one region unless the machine is parallel). */
	initial: string[];
	context: Record<string, number>;
	/** The order of the context variables in the answer. */
	report: string[];
	/** Whether the answer ends with the state at `endAt` (machines with delayed transitions). */
	endAt: number | null;
}

interface Ev {
	name: string;
	n: number | null;
	at: number;
}

// ---------------------------------------------------------------------------------------------------------------
// The model.

/** The misconceptions as variants of the model; all false is the stated semantics. */
interface Flags {
	noGuards: boolean;
	globalEvents: boolean;
	selfInternal: boolean;
	internalReenters: boolean;
	entryBeforeActions: boolean;
	noAlways: boolean;
	noBubble: boolean;
	parentFirst: boolean;
	reenterParent: boolean;
	sequentialRegions: boolean;
	firstRegionOnly: boolean;
	timerNotRestarted: boolean;
	timerNotCancelled: boolean;
}

const RIGHT: Flags = {
	noGuards: false,
	globalEvents: false,
	selfInternal: false,
	internalReenters: false,
	entryBeforeActions: false,
	noAlways: false,
	noBubble: false,
	parentFirst: false,
	reenterParent: false,
	sequentialRegions: false,
	firstRegionOnly: false,
	timerNotRestarted: false,
	timerNotCancelled: false
};

const WRONG_FLAGS: Record<string, Partial<Flags>> = {
	'no-guards': { noGuards: true },
	'global-events': { globalEvents: true },
	'self-internal': { selfInternal: true },
	'internal-reenters': { internalReenters: true },
	'entry-before-actions': { entryBeforeActions: true },
	'no-always': { noAlways: true },
	'no-bubble': { noBubble: true },
	'parent-first': { parentFirst: true },
	'reenter-parent': { reenterParent: true },
	'sequential-regions': { sequentialRegions: true },
	'first-region-only': { firstRegionOnly: true },
	'timer-not-restarted': { timerNotRestarted: true },
	'timer-not-cancelled': { timerNotCancelled: true }
};

interface Selected {
	region: number;
	source: string;
	tr: Tr;
}

interface Timer {
	state: string;
	due: number;
	seq: number;
}

/** A run that a misconception sends into a loop or past the stated machine; it gives no answer of its own. */
class Diverged extends Error {}

class Model {
	readonly #m: Machine;
	readonly #f: Flags;
	readonly #byName = new Map<string, St>();
	readonly ctx: Record<string, number>;
	readonly leaves: string[];
	/** The moments the timers fired at. */
	readonly fired: number[] = [];
	#timers: Timer[] = [];
	#seq = 0;
	#now = 0;

	constructor(m: Machine, f: Flags) {
		this.#m = m;
		this.#f = f;
		for (const s of m.states) this.#byName.set(s.name, s);
		this.ctx = { ...m.context };
		this.leaves = [...m.initial];
	}

	#st(name: string): St {
		const s = this.#byName.get(name);
		if (!s) throw new Error(`unknown state ${name}`);
		return s;
	}

	/** The state and its ancestors, innermost first. */
	#chain(name: string): string[] {
		const out: string[] = [];
		for (let s: St | undefined = this.#st(name); s; s = s.parent ? this.#st(s.parent) : undefined) out.push(s.name);
		return out;
	}

	#num(x: Num, n: number | null, ctx: Record<string, number>): number {
		if (typeof x === 'number') return x;
		if (x !== 'n') {
			const v = ctx[x];
			if (v === undefined) throw new Error(`unknown variable ${x}`);
			return v;
		}
		if (n === null) throw new Error('payload of an event without one');
		return n;
	}

	#holds(c: Cond | null, n: number | null, ctx: Record<string, number>): boolean {
		if (c === null || this.#f.noGuards) return true;
		const left = this.#num(c.v, n, ctx);
		const right = this.#num(c.x, n, ctx);
		switch (c.op) {
			case '<':
				return left < right;
			case '<=':
				return left <= right;
			case '>':
				return left > right;
			case '>=':
				return left >= right;
			case '==':
				return left === right;
			case '!=':
				return left !== right;
		}
	}

	#run(acts: readonly Act[], n: number | null): void {
		for (const a of acts) {
			const x = this.#num(a.x, n, this.ctx);
			const now = this.ctx[a.v] ?? 0;
			this.ctx[a.v] = a.op === '=' ? x : a.op === '+=' ? now + x : a.op === '-=' ? now - x : now * x;
		}
	}

	#select(region: number, ev: Ev, ctx: Record<string, number>): Selected | null {
		const leaf = this.leaves[region] ?? '';
		let sources = this.#chain(leaf);
		if (this.#f.noBubble) sources = sources.slice(0, 1);
		if (this.#f.parentFirst) sources = [...sources].reverse();
		for (const source of sources) {
			const tr = this.#st(source).on.find((t) => t.event === ev.name && this.#holds(t.cond, ev.n, ctx));
			if (tr) return { region, source, tr };
		}
		if (this.#f.globalEvents) {
			for (const s of this.#m.states) {
				if (s.region !== region) continue;
				const tr = s.on.find((t) => t.event === ev.name && this.#holds(t.cond, ev.n, ctx));
				if (tr) return { region, source: s.name, tr };
			}
		}
		return null;
	}

	/** The states a transition exits (innermost first) and enters (outermost first). */
	#plan(leaf: string, source: string, target: string | null): { exit: string[]; enter: string[] } {
		if (target === null) {
			if (!this.#f.internalReenters) return { exit: [], enter: [] };
			target = source;
		}
		if (target === source && this.#f.selfInternal) return { exit: [], enter: [] };
		const sourceParent = this.#st(source).parent;
		const targetChain = this.#chain(target);
		// The domain: the parent the source shares with the target, unless the transition leaves it.
		const domain =
			!this.#f.reenterParent && sourceParent !== null && targetChain.includes(sourceParent) ? sourceParent : null;
		const exit: string[] = [];
		for (const s of this.#chain(leaf)) {
			if (s === domain) break;
			exit.push(s);
		}
		const enter: string[] = [];
		for (const s of targetChain) {
			if (s === domain) break;
			enter.unshift(s);
		}
		for (let s = this.#st(target); s.initial !== null; s = this.#st(s.initial)) enter.push(s.initial);
		return { exit, enter };
	}

	#exitStates(states: readonly string[], n: number | null, keep: ReadonlySet<string>): void {
		for (const s of states) {
			this.#run(this.#st(s).exit, n);
			if (!this.#f.timerNotCancelled && !keep.has(s)) this.#timers = this.#timers.filter((t) => t.state !== s);
		}
	}

	#enterStates(states: readonly string[], n: number | null, keep: ReadonlySet<string>): void {
		for (const s of states) {
			const st = this.#st(s);
			this.#run(st.entry, n);
			if (st.after && !keep.has(s)) {
				this.#timers = this.#timers.filter((t) => t.state !== s);
				this.#timers.push({ state: s, due: this.#now + st.after.ms, seq: this.#seq++ });
			}
		}
	}

	/** Executes the selected transitions of one microstep: all exits, all actions, all entries, in region order. */
	#execute(selected: readonly Selected[], n: number | null): void {
		const plans = selected.map((s) => {
			const leaf = this.leaves[s.region] ?? '';
			const plan = this.#plan(leaf, s.source, s.tr.target);
			// A state exited and entered again by one transition keeps its timer only by the misconception.
			const keep = new Set(
				this.#f.timerNotRestarted ? plan.exit.filter((x) => plan.enter.includes(x)) : ([] as string[])
			);
			return { s, plan, keep };
		});
		for (const { plan, keep } of plans) this.#exitStates(plan.exit, n, keep);
		const actions = (): void => {
			for (const { s } of plans) this.#run(s.tr.actions, n);
		};
		if (!this.#f.entryBeforeActions) actions();
		for (const { plan, keep } of plans) this.#enterStates(plan.enter, n, keep);
		if (this.#f.entryBeforeActions) actions();
		for (const { s, plan } of plans) {
			const deepest = plan.enter[plan.enter.length - 1];
			if (deepest !== undefined) this.leaves[s.region] = deepest;
		}
	}

	#settle(): void {
		for (let region = 0; region < this.leaves.length; region += 1) {
			for (let step = 0; ; step += 1) {
				if (step > 20) throw new Diverged('eventless loop');
				const leaf = this.leaves[region] ?? '';
				const tr = this.#st(leaf).always.find((t) => this.#holds(t.cond, null, this.ctx));
				if (!tr) break;
				this.#execute([{ region, source: leaf, tr }], null);
			}
		}
	}

	start(): void {
		for (let region = 0; region < this.leaves.length; region += 1) {
			const enter = [this.leaves[region] ?? ''];
			for (let s = this.#st(enter[0] ?? ''); s.initial !== null; s = this.#st(s.initial)) enter.push(s.initial);
			this.#enterStates(enter, null, new Set());
			this.leaves[region] = enter[enter.length - 1] ?? '';
		}
		if (!this.#f.noAlways) this.#settle();
	}

	/** Fires the timers due before `until` (or at it: a timer goes before an event of the same moment). */
	advance(until: number): void {
		for (let fired = 0; ; fired += 1) {
			if (fired > 50) throw new Diverged('timer loop');
			const due = [...this.#timers].sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
			if (!due || due.due > until) break;
			this.#timers = this.#timers.filter((t) => t !== due);
			this.#now = due.due;
			this.fired.push(due.due);
			const st = this.#st(due.state);
			if (!st.after) continue;
			const leaf = this.leaves[st.region] ?? '';
			const active = this.#chain(leaf).includes(st.name);
			const tr: Tr = { event: null, cond: null, target: st.after.target, actions: st.after.actions };
			if (this.#f.noAlways) this.#settle();
			this.#execute([{ region: st.region, source: active ? st.name : leaf, tr }], null);
			if (!this.#f.noAlways) this.#settle();
		}
		this.#now = until;
	}

	handle(ev: Ev): void {
		this.advance(ev.at);
		// The misconception checks eventless transitions only when the next event comes.
		if (this.#f.noAlways) this.#settle();
		const regions = this.leaves.map((_, r) => r);
		if (this.#f.sequentialRegions) {
			for (const r of regions) {
				const s = this.#select(r, ev, this.ctx);
				if (s) this.#execute([s], ev.n);
			}
		} else {
			const snapshot = { ...this.ctx };
			let selected = regions.map((r) => this.#select(r, ev, snapshot)).filter((s): s is Selected => s !== null);
			if (this.#f.firstRegionOnly) selected = selected.slice(0, 1);
			this.#execute(selected, ev.n);
		}
		if (!this.#f.noAlways) this.#settle();
	}

	configuration(): string {
		return this.leaves.join('+');
	}
}

/** The answer: the configuration after each event, then the configuration at `endAt`, then the context. */
function answerOf(m: Machine, events: readonly Ev[], f: Flags): string | null {
	try {
		const model = new Model(m, f);
		model.start();
		const tokens: string[] = [];
		for (const ev of events) {
			model.handle(ev);
			tokens.push(model.configuration());
		}
		if (m.endAt !== null) {
			model.advance(m.endAt);
			tokens.push(model.configuration());
		}
		for (const v of m.report) tokens.push(String(model.ctx[v] ?? 0));
		return tokens.join(' ');
	} catch (error) {
		if (error instanceof Diverged) return null;
		throw error;
	}
}

/** Whether a timer of the right model fires at the very moment of an event: such scenarios are drawn again. */
function hasTie(m: Machine, events: readonly Ev[]): boolean {
	const times = new Set(events.map((e) => e.at));
	if (m.endAt !== null) times.add(m.endAt);
	const model = new Model(m, RIGHT);
	model.start();
	for (const ev of events) model.handle(ev);
	if (m.endAt !== null) model.advance(m.endAt);
	return model.fired.some((t) => times.has(t));
}

// ---------------------------------------------------------------------------------------------------------------
// Machines of the classes.

const st = (name: string, extra: Partial<St> = {}): St => ({
	name,
	parent: null,
	initial: null,
	region: 0,
	entry: [],
	exit: [],
	on: [],
	always: [],
	after: null,
	...extra
});
const on = (event: string, target: string | null, cond: Cond | null = null, actions: Act[] = []): Tr => ({
	event,
	cond,
	target,
	actions
});
const act = (v: string, op: ActOp, x: Num): Act => ({ v, op, x });
const cond = (v: string, op: CondOp, x: Num): Cond => ({ v, op, x });

interface Drawn {
	machine: Machine;
	events: Ev[];
	/** Events that carry a payload. */
	payload: ReadonlySet<string>;
}

/** A random walk over events: mostly ones the current state handles, some it ignores. */
function walk(
	rng: Rng,
	m: Machine,
	alphabet: readonly string[],
	count: number,
	payload: (name: string) => number | null,
	times: (i: number) => number
): Ev[] {
	const events: Ev[] = [];
	const model = new Model(m, RIGHT);
	model.start();
	const byName = new Map(m.states.map((s) => [s.name, s]));
	for (let i = 0; i < count; i += 1) {
		const handled = new Set<string>();
		for (const leaf of model.leaves) {
			for (let s = byName.get(leaf); s; s = s.parent ? byName.get(s.parent) : undefined) {
				for (const t of s.on) if (t.event !== null) handled.add(t.event);
			}
		}
		const pool = rng.bool(0.75) && handled.size > 0 ? [...handled].sort() : [...alphabet];
		const name = rng.pick(pool);
		const ev = { name, n: payload(name), at: times(i) };
		events.push(ev);
		model.handle(ev);
	}
	return events;
}

const seq = (i: number): number => i;

function guardsMachine(rng: Rng): Drawn {
	const maxAttempts = rng.int(2, 3);
	const limit = rng.int(4, 7);
	const m: Machine = {
		states: [
			st('idle', { on: [on('FETCH', 'loading')] }),
			st('loading', {
				entry: [act('attempts', '+=', 1)],
				on: [
					on('RESOLVE', 'success', cond('n', '>', 0), [act('items', '=', 'n')]),
					on('RESOLVE', 'empty'),
					on('REJECT', 'retrying', cond('attempts', '<', maxAttempts)),
					on('REJECT', 'failure')
				]
			}),
			st('retrying', { on: [on('RETRY', 'loading')] }),
			st('success', {
				on: [
					on('REFRESH', 'loading', cond('items', '<', limit), [act('attempts', '=', 0)]),
					on('CLEAR', 'idle', null, [act('items', '=', 0)])
				]
			}),
			st('empty', { on: [on('FETCH', 'loading', null, [act('attempts', '=', 0)])] }),
			st('failure', { on: [on('RESET', 'idle', null, [act('attempts', '=', 0)])] })
		],
		initial: ['idle'],
		context: { attempts: 0, items: 0 },
		report: ['attempts', 'items'],
		endAt: null
	};
	const alphabet = ['FETCH', 'RESOLVE', 'REJECT', 'RETRY', 'REFRESH', 'CLEAR', 'RESET'];
	const events = walk(rng, m, alphabet, rng.int(8, 10), (e) => (e === 'RESOLVE' ? rng.int(0, 9) : null), seq);
	return { machine: m, events, payload: new Set(['RESOLVE']) };
}

function wizardMachine(rng: Rng): Drawn {
	const maxErrors = rng.int(1, 3);
	const steps = rng.pick([
		['contact', 'address', 'payment'],
		['account', 'profile', 'plan'],
		['cart', 'delivery', 'billing']
	]);
	const [s1, s2, s3] = steps as [string, string, string];
	const step = (name: string, index: number, prev: string | null, next: string): St =>
		st(name, {
			entry: [act('visits', '+=', 1)],
			exit: [act('saved', '=', index)],
			on: [
				on('NEXT', next),
				...(prev ? [on('BACK', prev)] : []),
				on('INVALID', name, null, [act('errors', '+=', 1)]),
				on('TYPE', null, null, [act('edits', '+=', 1)])
			]
		});
	const m: Machine = {
		states: [
			step(s1, 1, null, s2),
			step(s2, 2, s1, s3),
			step(s3, 3, s2, 'review'),
			st('review', {
				entry: [act('visits', '+=', 1)],
				on: [
					on('SUBMIT', 'done', cond('errors', '<', maxErrors)),
					on('SUBMIT', s1, null, [act('visits', '=', 0), act('errors', '=', 0)]),
					on('BACK', s3)
				]
			}),
			st('done')
		],
		initial: [s1],
		context: { visits: 0, errors: 0, edits: 0, saved: 0 },
		report: ['visits', 'errors', 'edits', 'saved'],
		endAt: null
	};
	const alphabet = ['NEXT', 'BACK', 'INVALID', 'TYPE', 'SUBMIT'];
	const events = walk(rng, m, alphabet, rng.int(10, 13), () => null, seq);
	return { machine: m, events, payload: new Set() };
}

function paymentMachine(rng: Rng): Drawn {
	const limit = rng.pick([500, 1000, 2000]);
	const m: Machine = {
		states: [
			st('idle', {
				on: [
					on('PAY', 'processing', cond('n', '<=', limit), [act('paid', '=', 'n'), act('balance', '=', 'n')]),
					on('PAY', null, null, [act('declines', '+=', 1)])
				]
			}),
			st('processing', {
				on: [
					on('CONFIRM', 'succeeded'),
					on('CHALLENGE', 'verifying'),
					on('DECLINE', 'idle', null, [act('declines', '+=', 1)]),
					on('CANCEL', 'idle', null, [act('paid', '=', 0), act('balance', '=', 0)])
				]
			}),
			st('verifying', {
				on: [
					on('CONFIRM', 'succeeded'),
					on('DECLINE', 'idle', null, [act('declines', '+=', 1)]),
					on('CANCEL', 'idle', null, [act('paid', '=', 0), act('balance', '=', 0)])
				]
			}),
			st('succeeded', {
				on: [
					on('REFUND', null, cond('n', '<=', 'balance'), [act('balance', '-=', 'n'), act('refunded', '+=', 'n')]),
					on('CLOSE', 'closed')
				]
			}),
			st('closed')
		],
		initial: ['idle'],
		context: { paid: 0, balance: 0, refunded: 0, declines: 0 },
		report: ['paid', 'refunded', 'declines'],
		endAt: null
	};
	const alphabet = ['PAY', 'CONFIRM', 'CHALLENGE', 'DECLINE', 'CANCEL', 'REFUND', 'CLOSE'];
	const amount = (e: string): number | null =>
		e === 'PAY' ? rng.int(1, Math.round((limit * 1.5) / 50)) * 50 : e === 'REFUND' ? rng.int(1, 12) * 50 : null;
	const events = walk(rng, m, alphabet, rng.int(9, 11), amount, seq);
	return { machine: m, events, payload: new Set(['PAY', 'REFUND']) };
}

function alwaysMachine(rng: Rng): Drawn {
	const pass = rng.int(8, 14);
	const maxAttempts = rng.int(2, 3);
	const m: Machine = {
		states: [
			st('draft', {
				on: [
					on('ANSWER', null, null, [act('score', '+=', 'n')]),
					on('SUBMIT', 'checking', null, [act('attempts', '+=', 1)])
				]
			}),
			st('checking', {
				always: [
					{ event: null, cond: cond('score', '>=', pass), target: 'passed', actions: [] },
					{ event: null, cond: cond('attempts', '>=', maxAttempts), target: 'locked', actions: [] },
					{ event: null, cond: null, target: 'draft', actions: [act('score', '=', 0)] }
				]
			}),
			st('passed', { on: [on('RESET', 'draft', null, [act('score', '=', 0), act('attempts', '=', 0)])] }),
			st('locked', { on: [on('UNLOCK', 'draft', null, [act('attempts', '=', 0)])] })
		],
		initial: ['draft'],
		context: { score: 0, attempts: 0 },
		report: ['score', 'attempts'],
		endAt: null
	};
	const alphabet = ['ANSWER', 'SUBMIT', 'RESET', 'UNLOCK'];
	const events = walk(rng, m, alphabet, rng.int(9, 11), (e) => (e === 'ANSWER' ? rng.int(1, 6) : null), seq);
	return { machine: m, events, payload: new Set(['ANSWER']) };
}

function nestedMachine(rng: Rng): Drawn {
	const m: Machine = {
		states: [
			st('signedOut', { on: [on('LOGIN', 'session')] }),
			st('session', {
				initial: 'viewing',
				entry: [act('sessions', '+=', 1)],
				exit: [act('drafts', '=', 0)],
				on: [on('LOGOUT', 'signedOut'), on('TIMEOUT', 'locked'), on('SAVE', null, null, [act('autosaves', '+=', 1)])]
			}),
			st('viewing', { parent: 'session', on: [on('EDIT', 'editing')] }),
			st('editing', {
				parent: 'session',
				entry: [act('drafts', '+=', 1)],
				on: [
					on('TYPE', null, null, [act('drafts', '+=', 1)]),
					on('SAVE', 'saving', cond('drafts', '>', rng.int(1, 2))),
					on('CANCEL', 'viewing')
				]
			}),
			st('saving', {
				parent: 'session',
				on: [on('DONE', 'viewing', null, [act('saves', '+=', 1)]), on('FAIL', 'editing')]
			}),
			st('locked', { on: [on('UNLOCK', 'session')] })
		],
		initial: ['signedOut'],
		context: { sessions: 0, drafts: 0, saves: 0, autosaves: 0 },
		report: ['sessions', 'drafts', 'saves', 'autosaves'],
		endAt: null
	};
	const alphabet = ['LOGIN', 'LOGOUT', 'TIMEOUT', 'UNLOCK', 'EDIT', 'TYPE', 'SAVE', 'CANCEL', 'DONE', 'FAIL'];
	const events = walk(rng, m, alphabet, rng.int(10, 12), () => null, seq);
	return { machine: m, events, payload: new Set() };
}

function parallelMachine(rng: Rng): Drawn {
	const maxPauses = rng.int(1, 2);
	const size = rng.int(3, 6) * 10;
	const m: Machine = {
		states: [
			st('idle', { on: [on('START', 'uploading')] }),
			st('uploading', {
				on: [
					on('CHUNK', null, null, [act('sent', '+=', 'n')]),
					on('OFFLINE', 'paused', null, [act('pauses', '+=', 1)]),
					on('FINISH', 'done', cond('sent', '>=', size))
				]
			}),
			st('paused', { on: [on('ONLINE', 'uploading', null, [act('retries', '+=', 1)])] }),
			st('done'),
			st('online', {
				region: 1,
				on: [on('OFFLINE', 'offline', cond('pauses', '<', maxPauses)), on('OFFLINE', 'unstable')]
			}),
			st('offline', { region: 1, on: [on('ONLINE', 'online')] }),
			st('unstable', {
				region: 1,
				on: [on('ONLINE', 'online', cond('retries', '>=', maxPauses), [act('pauses', '=', 0)])]
			})
		],
		initial: ['idle', 'online'],
		context: { sent: 0, pauses: 0, retries: 0 },
		report: ['sent', 'pauses', 'retries'],
		endAt: null
	};
	const alphabet = ['START', 'CHUNK', 'OFFLINE', 'ONLINE', 'FINISH'];
	const events = walk(rng, m, alphabet, rng.int(10, 12), (e) => (e === 'CHUNK' ? rng.int(1, 3) * 10 : null), seq);
	return { machine: m, events, payload: new Set(['CHUNK']) };
}

/** Event moments: growing gaps drawn so that timers and events interleave. */
function timeline(rng: Rng, count: number, gaps: readonly number[]): number[] {
	const out: number[] = [];
	let t = 0;
	for (let i = 0; i < count; i += 1) {
		t += rng.pick(gaps);
		out.push(t);
	}
	return out;
}

function delayedMachine(rng: Rng): Drawn {
	const idleMs = rng.pick([3000, 4000, 5000]);
	const warnMs = rng.pick([1000, 2000]);
	const m: Machine = {
		states: [
			st('active', {
				after: { ms: idleMs, target: 'warning', actions: [] },
				on: [on('ACTIVITY', 'active', null, [act('touches', '+=', 1)]), on('PING', null, null, [act('pings', '+=', 1)])]
			}),
			st('warning', {
				entry: [act('warnings', '+=', 1)],
				after: { ms: warnMs, target: 'expired', actions: [] },
				on: [on('ACTIVITY', 'active', null, [act('touches', '+=', 1)]), on('PING', null)]
			}),
			st('expired', { on: [on('LOGIN', 'active', null, [act('logins', '+=', 1)])] })
		],
		initial: ['active'],
		context: { touches: 0, pings: 0, warnings: 0, logins: 0 },
		report: ['touches', 'pings', 'warnings', 'logins'],
		endAt: null
	};
	const count = rng.int(7, 9);
	const times = timeline(rng, count, [500, 700, 900, 1100, 1300, 1600, 1900]);
	const events = walk(
		rng,
		m,
		['ACTIVITY', 'PING', 'LOGIN'],
		count,
		() => null,
		(i) => times[i] ?? 0
	);
	const last = times[times.length - 1] ?? 0;
	m.endAt = last + rng.pick([1500, 2500, 3500]);
	return { machine: m, events, payload: new Set() };
}

function nestedDelayedMachine(rng: Rng): Drawn {
	const totalMs = rng.pick([6000, 7000, 8000]);
	const stepMs = rng.pick([2000, 2500]);
	const m: Machine = {
		states: [
			st('checkout', {
				initial: 'cart',
				entry: [act('starts', '+=', 1)],
				after: { ms: totalMs, target: 'expired', actions: [] },
				on: [on('ABORT', 'browsing')]
			}),
			st('cart', { parent: 'checkout', on: [on('NEXT', 'shipping')] }),
			st('shipping', {
				parent: 'checkout',
				entry: [act('forms', '+=', 1)],
				after: { ms: stepMs, target: 'cart', actions: [act('resets', '+=', 1)] },
				on: [on('NEXT', 'payment'), on('BACK', 'cart'), on('EDIT', 'shipping')]
			}),
			st('payment', { parent: 'checkout', on: [on('PAY', 'paid'), on('BACK', 'shipping')] }),
			st('expired', { on: [on('RESTART', 'checkout')] }),
			st('browsing', { on: [on('RESTART', 'checkout')] }),
			st('paid')
		],
		initial: ['checkout'],
		context: { starts: 0, forms: 0, resets: 0 },
		report: ['starts', 'forms', 'resets'],
		endAt: null
	};
	const count = rng.int(7, 9);
	const times = timeline(rng, count, [400, 600, 800, 1100, 1400, 1700]);
	const alphabet = ['NEXT', 'BACK', 'EDIT', 'PAY', 'ABORT', 'RESTART'];
	const events = walk(
		rng,
		m,
		alphabet,
		count,
		() => null,
		(i) => times[i] ?? 0
	);
	const last = times[times.length - 1] ?? 0;
	m.endAt = last + rng.pick([1000, 2000, 3000]);
	return { machine: m, events, payload: new Set() };
}

const MACHINES: Record<string, (rng: Rng) => Drawn> = {
	'middle/guards': guardsMachine,
	'middle/entry-exit': wizardMachine,
	'middle/ignored-events': paymentMachine,
	'middle/eventless': alwaysMachine,
	'senior/nested': nestedMachine,
	'senior/parallel': parallelMachine,
	'senior/delayed': delayedMachine,
	'senior/nested-delayed': nestedDelayedMachine
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/guards': ['no-guards'],
	'middle/entry-exit': ['self-internal', 'internal-reenters', 'entry-before-actions'],
	'middle/ignored-events': ['global-events'],
	'middle/eventless': ['no-always'],
	'senior/nested': ['no-bubble', 'reenter-parent'],
	'senior/parallel': ['sequential-regions', 'first-region-only'],
	'senior/delayed': ['timer-not-restarted', 'timer-not-cancelled'],
	'senior/nested-delayed': ['reenter-parent', 'timer-not-cancelled']
};

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const numText = (x: Num): string => String(x);
const actText = (a: Act): string => `\`${a.v} ${a.op} ${numText(a.x)}\``;
const condText = (c: Cond): string => `\`${c.v} ${c.op} ${numText(c.x)}\``;

function trText(t: Tr, payload: ReadonlySet<string>): string {
	const head = t.event === null ? 'сразу' : `\`${t.event}${payload.has(t.event) ? '(n)' : ''}\``;
	const guard = t.cond ? ` если ${condText(t.cond)}` : '';
	const target = t.target === null ? ' — без смены состояния' : ` → **${t.target}**`;
	const actions = t.actions.length ? `; действия: ${t.actions.map(actText).join(', ')}` : '';
	return `${head}${guard}${target}${actions}`;
}

function stateText(s: St, m: Machine, payload: ReadonlySet<string>, parallel: boolean): string[] {
	const notes: string[] = [];
	if (m.initial.includes(s.name)) notes.push('начальное');
	if (s.parent) notes.push(`вложено в **${s.parent}**`);
	if (s.initial) notes.push(`начальное вложенное — **${s.initial}**`);
	if (parallel) notes.push(`регион ${s.region + 1}`);
	const head = `**${s.name}**${notes.length ? ` (${notes.join(', ')})` : ''}`;
	const lines = [`${head}:`, ''];
	if (s.entry.length) lines.push(`- при входе: ${s.entry.map(actText).join(', ')}`);
	if (s.exit.length) lines.push(`- при выходе: ${s.exit.map(actText).join(', ')}`);
	for (const t of s.always) lines.push(`- ${trText(t, payload)}`);
	if (s.after) {
		const actions = s.after.actions.length ? `; действия: ${s.after.actions.map(actText).join(', ')}` : '';
		lines.push(`- через ${s.after.ms} мс → **${s.after.target}**${actions}`);
	}
	for (const t of s.on) lines.push(`- ${trText(t, payload)}`);
	if (!s.always.length && !s.after && !s.on.length) lines.push('- переходов нет');
	lines.push('');
	return lines;
}

function rules(key: string): string[] {
	const common = [
		'- Переходы состояния по одному событию проверяются сверху вниз; срабатывает первый, чьё условие выполнено. ' +
			'Условие проверяется по контексту до действий перехода; `n` — число, переданное с событием.',
		'- Событие, для которого перехода с выполненным условием нет, игнорируется: состояние и контекст не меняются.',
		'- Переход в другое состояние: сначала действия при выходе из старого состояния, затем действия перехода, ' +
			'затем действия при входе в новое. Переход «→ то же состояние» — внешний: выход и вход выполняются заново. ' +
			'Переход «без смены состояния» выполняет только свои действия.'
	];
	const extra: Record<string, string[]> = {
		'middle/eventless': [
			'- Переходы «сразу» (без события) проверяются сразу после входа в состояние, сверху вниз; срабатывает первый ' +
				'выполненный. Ответ «после события» — состояние, в котором машина остановилась.'
		],
		'senior/nested': [
			'- Переход с выполненным условием сначала ищется у вложенного состояния, затем — у его родителя. Переход между вложенными ' +
				'состояниями одного родителя родителя не покидает: его выход и вход не выполняются.',
			'- Выход: сначала из вложенного, затем из родителя; вход: сначала в родителя, затем во вложенное. Вход в ' +
				'родителя ведёт в его начальное вложенное состояние.'
		],
		'senior/parallel': [
			'- Машина состоит из двух параллельных регионов, каждое событие получают оба. Сначала каждый регион выбирает ' +
				'свой переход по контексту до события; затем выполняются выходы (регион 1, потом регион 2), действия ' +
				'переходов (в том же порядке) и входы (в том же порядке).'
		],
		'senior/delayed': [
			'- «Через N мс» — таймер: запускается при входе в состояние, отменяется при выходе из него (внешний переход в ' +
				'то же состояние отменяет его и запускает заново). Переход без смены состояния таймер не трогает.',
			'- События приходят в указанные моменты (мс от старта); таймеры отсчитываются от момента входа.'
		],
		'senior/nested-delayed': [
			'- Переход с выполненным условием сначала ищется у вложенного состояния, затем — у его родителя. Переход между вложенными ' +
				'состояниями одного родителя родителя не покидает. Вход в родителя ведёт в его начальное вложенное состояние.',
			'- «Через N мс» — таймер: запускается при входе в состояние, отменяется при выходе из него (внешний переход в ' +
				'то же состояние отменяет его и запускает заново). Таймер родителя идёт, пока машина внутри родителя.',
			'- События приходят в указанные моменты (мс от старта); таймеры отсчитываются от момента входа.'
		]
	};
	return [...common, ...(extra[key] ?? [])];
}

function describe(key: string, d: Drawn): string {
	const m = d.machine;
	const parallel = m.initial.length > 1;
	const timed = m.endAt !== null;
	const events = d.events.map((e) => {
		const text = `\`${e.name}${e.n === null ? '' : `(${e.n})`}\``;
		return timed ? `${e.at} мс: ${text}` : text;
	});
	const ctx = Object.entries(m.context)
		.map(([k, v]) => `\`${k} = ${v}\``)
		.join(', ');
	const configuration = parallel
		? 'состояния обоих регионов через `+`, сначала регион 1 (например, `idle+online`)'
		: 'имя состояния' + (key.includes('nested') ? ' (для вложенного — имя вложенного состояния)' : '');
	const answer = [
		`Введите через пробел: после каждого события по порядку — ${configuration};`,
		timed ? ` затем то же в момент ${m.endAt ?? 0} мс;` : '',
		` затем значения ${m.report.map((v) => `\`${v}\``).join(', ')} в конце${timed ? ` (в момент ${m.endAt ?? 0} мс)` : ''}.`
	].join('');
	return [
		'Конечный автомат интерфейса задан так:',
		'',
		...m.states.flatMap((s) => stateText(s, m, d.payload, parallel)),
		'',
		`Контекст в начале: ${ctx}.`,
		'',
		'Правила:',
		'',
		...rules(key),
		'',
		`События по порядку: ${events.join(timed ? '; ' : ', ')}.`,
		'',
		answer
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference in Python: an interpreter of the machine as JSON.

const PYTHON_REFERENCE = `import json
import sys

data = json.loads(sys.stdin.read())
machine = data["machine"]
events = data["events"]
states = {s["name"]: s for s in machine["states"]}
ctx = dict(machine["context"])


def ancestors(name):
    out = []
    while name is not None:
        out.append(name)
        name = states[name]["parent"]
    return out


def value(x, n, scope):
    if isinstance(x, str):
        return n if x == "n" else scope[x]
    return x


def check(c, n, snapshot):
    if c is None:
        return True
    left = value(c["v"], n, snapshot)
    right = value(c["x"], n, snapshot)
    return {
        "<": left < right,
        "<=": left <= right,
        ">": left > right,
        ">=": left >= right,
        "==": left == right,
        "!=": left != right,
    }[c["op"]]


def perform(actions, n):
    for a in actions:
        x = value(a["x"], n, ctx)
        if a["op"] == "=":
            ctx[a["v"]] = x
        elif a["op"] == "+=":
            ctx[a["v"]] += x
        elif a["op"] == "-=":
            ctx[a["v"]] -= x
        else:
            ctx[a["v"]] *= x


leaves = list(machine["initial"])
timers = {}  # state -> (due, order)
order = [0]
clock = [0]


def start_timer(name):
    after = states[name]["after"]
    if after is not None:
        timers[name] = (clock[0] + after["ms"], order[0])
        order[0] += 1


def descend(name):
    path = [name]
    while states[path[-1]]["initial"] is not None:
        path.append(states[path[-1]]["initial"])
    return path


def microstep(chosen, n):
    plans = []
    for region, source, target, actions in chosen:
        if target is None:
            plans.append((region, [], [], actions))
            continue
        shared = states[source]["parent"]
        top = shared if shared is not None and shared in ancestors(target) else None
        leaving = []
        for s in ancestors(leaves[region]):
            if s == top:
                break
            leaving.append(s)
        entering = []
        for s in ancestors(target):
            if s == top:
                break
            entering.insert(0, s)
        entering += descend(target)[1:]
        plans.append((region, leaving, entering, actions))
    for _, leaving, _, _ in plans:
        for s in leaving:
            perform(states[s]["exit"], n)
            timers.pop(s, None)
    for _, _, _, actions in plans:
        perform(actions, n)
    for region, _, entering, _ in plans:
        for s in entering:
            perform(states[s]["entry"], n)
            start_timer(s)
        if entering:
            leaves[region] = entering[-1]


def eventless():
    for region in range(len(leaves)):
        while True:
            options = [t for t in states[leaves[region]]["always"] if check(t["cond"], None, ctx)]
            if not options:
                break
            t = options[0]
            microstep([(region, leaves[region], t["target"], t["actions"])], None)


def run_timers(until):
    while timers:
        name = min(timers, key=lambda s: timers[s])
        due = timers[name][0]
        if due > until:
            break
        del timers[name]
        clock[0] = due
        after = states[name]["after"]
        microstep([(states[name]["region"], name, after["target"], after["actions"])], None)
        eventless()
    clock[0] = until


for region, name in enumerate(machine["initial"]):
    path = descend(name)
    for s in path:
        perform(states[s]["entry"], None)
        start_timer(s)
    leaves[region] = path[-1]
eventless()

out = []
for e in events:
    run_timers(e["at"])
    snapshot = dict(ctx)
    chosen = []
    for region in range(len(leaves)):
        found = None
        for s in ancestors(leaves[region]):
            for t in states[s]["on"]:
                if t["event"] == e["name"] and check(t["cond"], e["n"], snapshot):
                    found = (region, s, t["target"], t["actions"])
                    break
            if found:
                break
        if found:
            chosen.append(found)
    microstep(chosen, e["n"])
    eventless()
    out.append("+".join(leaves))
if machine["endAt"] is not None:
    run_timers(machine["endAt"])
    out.append("+".join(leaves))
out += [str(ctx[v]) for v in machine["report"]]
print(" ".join(out))
`;

// ---------------------------------------------------------------------------------------------------------------

interface Evaluated {
	drawn: Drawn;
	answer: string;
	wrong: Record<string, string | null>;
}

function evaluate(d: Drawn): Evaluated | null {
	const answer = answerOf(d.machine, d.events, RIGHT);
	if (answer === null || hasTie(d.machine, d.events)) return null;
	const wrong: Record<string, string | null> = {};
	for (const [id, change] of Object.entries(WRONG_FLAGS)) {
		const value = answerOf(d.machine, d.events, { ...RIGHT, ...change });
		wrong[id] = value === null || value === answer ? null : value;
	}
	return { drawn: d, answer, wrong };
}

function draw(rng: Rng, key: string): Evaluated {
	const make = MACHINES[key];
	if (!make) throw new Error(`${descriptor.key}: no machine for ${key}`);
	const required = REQUIRED[key] ?? [];
	const fits = (x: Evaluated | null): x is Evaluated => x !== null && required.every((id) => x.wrong[id] !== null);
	let last: Evaluated | null = null;
	for (let tries = 0; tries < 200; tries += 1) {
		const x = evaluate(make(rng));
		if (x) last = x;
		if (fits(x)) return x;
	}
	for (let tries = 0; tries < 200; tries += 1) {
		const x = evaluate(make(new Rng(`${descriptor.key}|fallback|${key}|${tries}`)));
		if (x) last = x;
		if (fits(x)) return x;
	}
	if (!last) throw new Error(`${descriptor.key}: no machine for ${key}`);
	return last;
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const key = `${input.grade}/${input.classId}`;
	const { drawn, answer, wrong } = draw(rng, key);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(key, drawn), code: null },
		answer: { kind: 'tokens', value: answer }
	});
	return {
		instance,
		reference: () => ({
			kind: 'output',
			source: PYTHON_REFERENCE,
			stdin: JSON.stringify({ machine: drawn.machine, events: drawn.events })
		}),
		wrong: () =>
			Object.fromEntries(
				descriptor.wrongSolutions.map(({ id }) => {
					const value = wrong[id] ?? null;
					return [id, value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }];
				})
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
