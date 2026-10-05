// The order of output of an asyncio program: `create_task` does not run a task at once, `sleep(0)` yields, `gather`
// returns in the order of its arguments, queues and events wake waiters through the loop; a level up, cancellation in
// different states of a task, the order a lock wakes its waiters, and `shield` against propagating cancellation.
//
// The generator models the event loop of CPython 3.12–3.13 (a FIFO of ready callbacks; a finished future schedules its
// callbacks, a woken task runs on its own turn) for the constructs it emits; the gate runs every shown program with
// real Python and compares the output.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

// The model: instructions of coroutines and a FIFO event loop.

interface Coro {
	instrs: Instr[];
	/** `try` over the instructions [from, to) with an optional `except CancelledError` (print, raise) and `finally`. */
	handler: {
		from: number;
		to: number;
		except: string | null;
		final: string | null;
		/** `except CancelledError: ... return <swallow>` — the coroutine ends normally with this value. */
		swallow?: string;
	} | null;
}

type Instr =
	| { op: 'print'; text: string }
	| { op: 'sleep' }
	/** `v = create_task(coro)`; `bind` passes tasks of the creator to the new coroutine: [its name, creator's name]. */
	| { op: 'create'; v: string; coro: Coro; bind?: [string, string][] }
	/** `x = await t`; with `label`: `print(label, await t)` inside `try/except CancelledError: print(label, ...)`. */
	| { op: 'await'; v: string; into: string | null; label: string | null }
	| { op: 'gather'; items: (Coro | string)[]; into: string | null }
	| { op: 'shield'; v: string; into: string }
	| { op: 'printVar'; prefix: string; v: string }
	| { op: 'printList'; v: string }
	| { op: 'cancel'; vs: string[] }
	| { op: 'set'; e: string }
	| { op: 'wait'; e: string }
	| { op: 'put'; q: string; item: string }
	| { op: 'get'; q: string; into: string }
	| { op: 'acquire'; l: string }
	| { op: 'release'; l: string }
	| { op: 'return'; value: string | null }
	/** `x = value`: what `return` of an inlined `await coro()` leaves in the caller. */
	| { op: 'assign'; into: string; value: string }
	/** `print('cancelled', *[t.cancelled() for t in (...)])`. */
	| { op: 'printCancelled'; vs: string[] };

type Value = string | null | string[] | Task;

interface Fut {
	kind: 'future' | 'task';
	role: 'plain' | 'gather' | 'shield' | 'task';
	done: boolean;
	cancelled: boolean;
	result: Value;
	callbacks: Callback[];
	/** The inner task of a shield's outer future. */
	inner: Task | null;
}

interface Task extends Fut {
	kind: 'task';
	coro: Coro;
	pc: number;
	env: Map<string, Value>;
	started: boolean;
	scheduled: boolean;
	mustCancel: boolean;
	cancelAtAwait: boolean;
	waiter: Fut | null;
	pending: { instr: Instr; fut: Fut | null; yielded: boolean } | null;
}

interface Gather {
	children: Task[];
	finished: Task[];
	outer: Fut;
}

type Callback =
	| { k: 'step'; task: Task }
	| { k: 'wake'; task: Task; fut: Fut }
	| { k: 'throw'; task: Task }
	| { k: 'gather'; g: Gather; child: Task }
	| { k: 'shield'; outer: Fut; inner: Task };

interface Rules {
	eager: boolean;
	lazy: boolean;
	gatherCompletion: boolean;
	getYields: boolean;
	setSwitches: boolean;
	unstartedRuns: boolean;
	cancelImmediate: boolean;
	barging: boolean;
	releaseSwitches: boolean;
	shieldCancelsInner: boolean;
	noPropagation: boolean;
	swallowStillCancelled: boolean;
}

const RIGHT: Rules = {
	eager: false,
	lazy: false,
	gatherCompletion: false,
	getYields: false,
	setSwitches: false,
	unstartedRuns: false,
	cancelImmediate: false,
	barging: false,
	releaseSwitches: false,
	shieldCancelsInner: false,
	noPropagation: false,
	swallowStillCancelled: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'eager-create': { eager: true },
	'lazy-tasks': { lazy: true },
	'gather-completion-order': { gatherCompletion: true },
	'get-always-yields': { getYields: true },
	'set-switches': { setSwitches: true },
	'unstarted-runs': { unstartedRuns: true },
	'cancel-immediate': { cancelImmediate: true },
	'lock-barging': { barging: true },
	'release-switches': { releaseSwitches: true },
	'shield-cancels-inner': { shieldCancelsInner: true },
	'no-propagation': { noPropagation: true },
	'await-coro-as-task': {},
	'swallow-still-cancelled': { swallowStillCancelled: true }
};

/** A construct the model does not cover was reached: the scenario is drawn again. */
class Unsupported extends Error {}

const pyStr = (v: Value): string =>
	v === null
		? 'None'
		: Array.isArray(v)
			? `[${v.map((x) => `'${x}'`).join(', ')}]`
			: typeof v === 'string'
				? v
				: '<task>';

class Loop {
	readonly out: string[] = [];
	readonly tasks: Task[] = [];
	readonly #ready: Callback[] = [];
	readonly #rules: Rules;
	readonly #events = new Map<string, { set: boolean; waiters: Fut[] }>();
	readonly #queues = new Map<string, { items: string[]; getters: Fut[] }>();
	readonly #locks = new Map<string, { locked: boolean; owner: Task | null; waiters: Fut[] }>();
	#ticks = 0;

	constructor(rules: Rules) {
		this.#rules = rules;
	}

	run(main: Coro): void {
		const task = this.#newTask(main);
		this.#ready.push({ k: 'step', task });
		task.scheduled = true;
		while (this.#ready.length) {
			if ((this.#ticks += 1) > 5000) throw new Unsupported('runaway loop');
			const cb = this.#ready.shift() as Callback;
			this.#call(cb);
			if (task.done) break;
		}
		if (!task.done) throw new Unsupported('main never finished');
	}

	get allDone(): boolean {
		return this.tasks.every((t) => t.done);
	}

	#future(role: Fut['role']): Fut {
		return { kind: 'future', role, done: false, cancelled: false, result: null, callbacks: [], inner: null };
	}

	#newTask(coro: Coro): Task {
		const task: Task = {
			kind: 'task',
			role: 'task',
			done: false,
			cancelled: false,
			result: null,
			callbacks: [],
			inner: null,
			coro,
			pc: 0,
			env: new Map(),
			started: false,
			scheduled: false,
			mustCancel: false,
			cancelAtAwait: false,
			waiter: null,
			pending: null
		};
		this.tasks.push(task);
		return task;
	}

	#call(cb: Callback): void {
		switch (cb.k) {
			case 'step':
				this.#step(cb.task, false);
				return;
			case 'wake':
				this.#step(cb.task, cb.fut.cancelled);
				return;
			case 'throw':
				this.#step(cb.task, true);
				return;
			case 'gather': {
				const g = cb.g;
				g.finished.push(cb.child);
				if (cb.child.cancelled) throw new Unsupported('a gathered task was cancelled');
				if (g.finished.length === g.children.length && !g.outer.done) {
					const order = this.#rules.gatherCompletion ? g.finished : g.children;
					this.#resolve(
						g.outer,
						order.map((t) => pyStr(t.result)),
						false
					);
				}
				return;
			}
			case 'shield':
				if (cb.outer.cancelled) return;
				if (cb.inner.cancelled) this.#cancelFuture(cb.outer);
				else this.#resolve(cb.outer, cb.inner.result, false);
		}
	}

	#schedule(callbacks: readonly Callback[], sync: boolean): void {
		if (sync) for (const cb of callbacks) this.#call(cb);
		else this.#ready.push(...callbacks);
	}

	#resolve(f: Fut, value: Value, sync: boolean): void {
		f.done = true;
		f.result = value;
		const callbacks = f.callbacks;
		f.callbacks = [];
		this.#schedule(callbacks, sync);
	}

	#cancelFuture(f: Fut): boolean {
		if (f.done) return false;
		f.done = true;
		f.cancelled = true;
		const callbacks = f.callbacks;
		f.callbacks = [];
		this.#schedule(callbacks, false);
		return true;
	}

	#complete(task: Task, value: Value, cancelled: boolean): void {
		task.done = true;
		task.cancelled = cancelled;
		task.result = cancelled ? null : value;
		task.pending = null;
		for (const lock of this.#locks.values())
			if (lock.owner === task) throw new Unsupported('a task ended holding a lock');
		const callbacks = task.callbacks;
		task.callbacks = [];
		this.#schedule(callbacks, false);
	}

	/** Removes every scheduled callback that would step the task, and its callback on what it waits for. */
	#detach(task: Task): void {
		for (let i = this.#ready.length - 1; i >= 0; i -= 1) {
			const cb = this.#ready[i];
			if (cb && (cb.k === 'step' || cb.k === 'wake' || cb.k === 'throw') && cb.task === task) this.#ready.splice(i, 1);
		}
		if (task.waiter) task.waiter.callbacks = task.waiter.callbacks.filter((cb) => !('task' in cb && cb.task === task));
	}

	cancel(task: Task): boolean {
		if (task.done) return false;
		if (this.#rules.cancelImmediate && task.started) {
			this.#detach(task);
			this.#step(task, true);
			return true;
		}
		const w = task.waiter;
		if (w) {
			if (w.kind === 'task') {
				if (this.#rules.noPropagation) {
					this.#detach(task);
					this.#ready.push({ k: 'throw', task });
					task.waiter = null;
					return true;
				}
				if (this.cancel(w as Task)) return true;
			} else {
				if (w.role === 'gather') throw new Unsupported('cancel of a gather');
				if (w.role === 'shield' && this.#rules.shieldCancelsInner && w.inner) this.cancel(w.inner);
				if (this.#cancelFuture(w)) return true;
			}
		}
		if (!task.started && this.#rules.unstartedRuns) {
			task.cancelAtAwait = true;
			return true;
		}
		task.mustCancel = true;
		return true;
	}

	#step(task: Task, thrown: boolean): void {
		if (task.done) return;
		let exc = thrown;
		if (task.mustCancel) {
			exc = true;
			task.mustCancel = false;
		}
		task.waiter = null;
		if (exc) {
			if (!task.started) {
				// A coroutine that never ran gets the exception before its first line: nothing of it runs.
				task.started = true;
				this.#complete(task, null, true);
				return;
			}
			if (this.#deliver(task) === 'finished') return;
		} else if (task.pending) {
			const p = task.pending;
			task.pending = null;
			const r = this.#resume(task, p);
			if (r === 'suspend') {
				if (task.cancelAtAwait) this.#cancelAtAwait(task);
				return;
			}
			task.pc += 1;
		}
		task.started = true;
		this.#run(task);
	}

	/** Raises CancelledError at the instruction the task waits on; `continue` when a local `except` caught it. */
	#deliver(task: Task): 'continue' | 'finished' {
		const p = task.pending;
		task.pending = null;
		if (p) this.#cleanup(p);
		const at = task.coro.instrs[task.pc];
		if (at?.op === 'await' && at.label !== null) {
			this.out.push(`${at.label} was cancelled`);
			task.pc += 1;
			return 'continue';
		}
		this.#unwind(task);
		return 'finished';
	}

	#cancelAtAwait(task: Task): void {
		task.cancelAtAwait = false;
		this.#detach(task);
		if (this.#deliver(task) === 'continue') this.#run(task);
	}

	#cleanup(p: NonNullable<Task['pending']>): void {
		const i = p.instr;
		if (i.op === 'wait' && p.fut) {
			const ev = this.#events.get(i.e);
			if (ev) ev.waiters = ev.waiters.filter((f) => f !== p.fut);
		} else if (i.op === 'get' && p.fut) {
			if (p.fut.done && !p.fut.cancelled) throw new Unsupported('cancel of a woken getter');
			const q = this.#queues.get(i.q);
			if (q) q.getters = q.getters.filter((f) => f !== p.fut);
		} else if (i.op === 'acquire' || i.op === 'gather') {
			throw new Unsupported(`cancel while in ${i.op}`);
		}
	}

	#unwind(task: Task): void {
		const h = task.coro.handler;
		if (h && task.pc >= h.from && task.pc < h.to) {
			if (h.except !== null) this.out.push(h.except);
			if (h.final !== null) this.out.push(h.final);
			if (h.swallow !== undefined) {
				if (this.#rules.swallowStillCancelled) this.#complete(task, null, true);
				else this.#complete(task, h.swallow, false);
				return;
			}
		}
		this.#complete(task, null, true);
	}

	#run(task: Task): void {
		const { instrs, handler } = task.coro;
		for (;;) {
			if (handler && task.pc === handler.to && handler.final !== null) this.out.push(handler.final);
			const ins = instrs[task.pc];
			if (!ins) {
				this.#complete(task, null, false);
				return;
			}
			const r = this.#exec(task, ins);
			if (r === 'next') {
				task.pc += 1;
				continue;
			}
			if (r === 'raise') {
				if (this.#deliver(task) === 'finished') return;
				continue;
			}
			if (r === 'suspend' && task.cancelAtAwait) {
				this.#cancelAtAwait(task);
				return;
			}
			return;
		}
	}

	#suspend(task: Task, instr: Instr, fut: Fut | null, yielded = false): 'suspend' {
		task.pending = { instr, fut, yielded };
		if (fut) {
			fut.callbacks.push({ k: 'wake', task, fut });
			task.waiter = fut;
		} else {
			this.#ready.push({ k: 'step', task });
		}
		return 'suspend';
	}

	#start(child: Task): void {
		if (child.scheduled || child.started) return;
		child.scheduled = true;
		if (this.#rules.eager) this.#step(child, false);
		else this.#ready.push({ k: 'step', task: child });
	}

	#task(task: Task, v: string): Task {
		const t = task.env.get(v);
		if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error(`no task ${v}`);
		return t;
	}

	#exec(task: Task, ins: Instr): 'next' | 'suspend' | 'raise' | 'done' {
		switch (ins.op) {
			case 'print':
				this.out.push(ins.text);
				return 'next';
			case 'sleep':
				return this.#suspend(task, ins, null);
			case 'create': {
				const child = this.#newTask(ins.coro);
				for (const [name, from] of ins.bind ?? []) child.env.set(name, task.env.get(from) ?? null);
				task.env.set(ins.v, child);
				if (!this.#rules.lazy) this.#start(child);
				return 'next';
			}
			case 'await': {
				const t = this.#task(task, ins.v);
				if (this.#rules.lazy) this.#start(t);
				if (!t.done) return this.#suspend(task, ins, t);
				if (t.cancelled) return 'raise';
				this.#took(task, ins, t.result);
				return 'next';
			}
			case 'gather': {
				const children = ins.items.map((item) => {
					if (typeof item === 'string') {
						const t = this.#task(task, item);
						if (this.#rules.lazy) this.#start(t);
						return t;
					}
					const child = this.#newTask(item);
					this.#start(child);
					return child;
				});
				const g: Gather = { children, finished: [], outer: this.#future('gather') };
				const done = children.filter((c) => c.done);
				for (const c of children) if (!c.done) c.callbacks.push({ k: 'gather', g, child: c });
				for (const c of done) this.#call({ k: 'gather', g, child: c });
				if (g.outer.done) {
					this.#took(task, ins, g.outer.result);
					return 'next';
				}
				return this.#suspend(task, ins, g.outer);
			}
			case 'shield': {
				const inner = this.#task(task, ins.v);
				if (inner.done) {
					if (inner.cancelled) return 'raise';
					this.#took(task, ins, inner.result);
					return 'next';
				}
				const outer = this.#future('shield');
				outer.inner = inner;
				inner.callbacks.push({ k: 'shield', outer, inner });
				return this.#suspend(task, ins, outer);
			}
			case 'printVar':
				this.out.push(`${ins.prefix} ${pyStr(task.env.get(ins.v) ?? null)}`);
				return 'next';
			case 'printList':
				this.out.push(pyStr(task.env.get(ins.v) ?? null));
				return 'next';
			case 'cancel': {
				const results = ins.vs.map((v) => (this.cancel(this.#task(task, v)) ? 'True' : 'False'));
				this.out.push(['cancel', ...results].join(' '));
				return 'next';
			}
			case 'set': {
				const ev = this.#event(ins.e);
				if (!ev.set) {
					ev.set = true;
					for (const f of [...ev.waiters]) if (!f.done) this.#resolve(f, 'True', this.#rules.setSwitches);
				}
				return 'next';
			}
			case 'wait': {
				const ev = this.#event(ins.e);
				if (ev.set) return 'next';
				const f = this.#future('plain');
				ev.waiters.push(f);
				return this.#suspend(task, ins, f);
			}
			case 'put': {
				const q = this.#queue(ins.q);
				q.items.push(ins.item);
				this.#wakeNext(q.getters, false);
				return 'next';
			}
			case 'get':
				if (this.#rules.getYields) return this.#suspend(task, ins, null, true);
				return this.#get(task, ins);
			case 'acquire': {
				const lock = this.#lock(ins.l);
				const free = !lock.locked && (this.#rules.barging || lock.waiters.every((w) => w.cancelled));
				if (free) {
					lock.locked = true;
					lock.owner = task;
					return 'next';
				}
				const f = this.#future('plain');
				lock.waiters.push(f);
				return this.#suspend(task, ins, f);
			}
			case 'release': {
				const lock = this.#lock(ins.l);
				lock.locked = false;
				lock.owner = null;
				const first = lock.waiters[0];
				if (first && !first.done) this.#resolve(first, 'True', this.#rules.releaseSwitches);
				return 'next';
			}
			case 'assign':
				task.env.set(ins.into, ins.value);
				return 'next';
			case 'printCancelled':
				this.out.push(
					['cancelled', ...ins.vs.map((v) => (this.#task(task, v).cancelled ? 'True' : 'False'))].join(' ')
				);
				return 'next';
			case 'return': {
				const h = task.coro.handler;
				if (h && h.final !== null && task.pc >= h.from && task.pc < h.to) this.out.push(h.final);
				this.#complete(task, ins.value, false);
				return 'done';
			}
		}
	}

	#took(task: Task, ins: Instr, value: Value): void {
		if (ins.op === 'await' && ins.label !== null) this.out.push(`${ins.label} ${pyStr(value)}`);
		else if ((ins.op === 'await' || ins.op === 'gather' || ins.op === 'shield') && ins.into !== null)
			task.env.set(ins.into, value);
	}

	#resume(task: Task, p: NonNullable<Task['pending']>): 'next' | 'suspend' {
		const ins = p.instr;
		switch (ins.op) {
			case 'sleep':
			case 'wait':
				if (ins.op === 'wait' && p.fut) {
					const ev = this.#event(ins.e);
					ev.waiters = ev.waiters.filter((f) => f !== p.fut);
				}
				return 'next';
			case 'await':
			case 'gather':
			case 'shield':
				this.#took(task, ins, p.fut?.result ?? null);
				return 'next';
			case 'get': {
				const r = this.#get(task, ins);
				return r === 'suspend' ? 'suspend' : 'next';
			}
			case 'acquire': {
				const lock = this.#lock(ins.l);
				lock.waiters = lock.waiters.filter((f) => f !== p.fut);
				if (this.#rules.barging && lock.locked) {
					const f = this.#future('plain');
					lock.waiters.unshift(f);
					return this.#suspend(task, ins, f);
				}
				lock.locked = true;
				lock.owner = task;
				return 'next';
			}
			default:
				throw new Error(`nothing to resume at ${ins.op}`);
		}
	}

	#get(task: Task, ins: Extract<Instr, { op: 'get' }>): 'next' | 'suspend' {
		const q = this.#queue(ins.q);
		const item = q.items.shift();
		if (item === undefined) {
			const f = this.#future('plain');
			q.getters.push(f);
			return this.#suspend(task, ins, f);
		}
		task.env.set(ins.into, item);
		return 'next';
	}

	#wakeNext(waiters: Fut[], sync: boolean): void {
		while (waiters.length) {
			const f = waiters.shift() as Fut;
			if (!f.done) {
				this.#resolve(f, null, sync);
				return;
			}
		}
	}

	#event(name: string) {
		let ev = this.#events.get(name);
		if (!ev) this.#events.set(name, (ev = { set: false, waiters: [] }));
		return ev;
	}

	#queue(name: string) {
		let q = this.#queues.get(name);
		if (!q) this.#queues.set(name, (q = { items: [], getters: [] }));
		return q;
	}

	#lock(name: string) {
		let l = this.#locks.get(name);
		if (!l) this.#locks.set(name, (l = { locked: false, owner: null, waiters: [] }));
		return l;
	}
}

/** The output of the program under the rules, or `null` when the model does not cover what happens. */
function execute(main: Coro, rules: Rules): string[] | null {
	const loop = new Loop(rules);
	try {
		loop.run(main);
	} catch (error) {
		if (error instanceof Unsupported) return null;
		throw error;
	}
	// asyncio.run cancels tasks left after main: the scenarios never leave any.
	return loop.allDone ? loop.out : null;
}

// Programs: Python source and the model's instructions, built side by side.

const NAMES = ['red', 'blue', 'gold', 'gray', 'pink', 'teal', 'lime', 'navy'] as const;

interface Program {
	source: string;
	main: Coro;
	/** The program as a misconception reads it, for misconceptions about what the code means rather than the loop. */
	variants?: Record<string, Coro>;
}

const plainCoro = (instrs: Instr[]): Coro => ({ instrs, handler: null });

function worker(name: string, steps: number): Coro {
	const instrs: Instr[] = [{ op: 'print', text: `${name} start` }];
	for (let i = 0; i < steps; i += 1) instrs.push({ op: 'sleep' }, { op: 'print', text: `${name} step ${i}` });
	instrs.push({ op: 'return', value: `${name}${steps}` });
	return plainCoro(instrs);
}

const WORKER_SOURCE = [
	'async def worker(name, steps):',
	"    print(f'{name} start')",
	'    for i in range(steps):',
	'        await asyncio.sleep(0)',
	"        print(f'{name} step {i}')",
	"    return f'{name}{steps}'"
];

/** Random filler of main: prints and yields between the essential lines. */
function filler(rng: Rng, counter: { n: number }, lines: string[], instrs: Instr[], chance = 0.5): void {
	if (!rng.bool(chance)) return;
	if (rng.bool()) {
		counter.n += 1;
		lines.push(`    print('main ${counter.n}')`);
		instrs.push({ op: 'print', text: `main ${counter.n}` });
	} else {
		lines.push('    await asyncio.sleep(0)');
		instrs.push({ op: 'sleep' });
	}
}

const program = (helpers: string[][], mainLines: string[], instrs: Instr[]): Program => ({
	source: [
		'import asyncio',
		'',
		'',
		...helpers.flatMap((h) => [...h, '', '']),
		'async def main():',
		...mainLines,
		'',
		'',
		'asyncio.run(main())'
	].join('\n'),
	main: plainCoro(instrs)
});

function createTaskProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, rng.int(2, 3));
	const steps = names.map(() => rng.int(0, 3));
	const lines: string[] = [];
	const instrs: Instr[] = [];
	const counter = { n: 0 };
	names.forEach((name, i) => {
		lines.push(`    t${i + 1} = asyncio.create_task(worker('${name}', ${steps[i]}))`);
		instrs.push({ op: 'create', v: `t${i + 1}`, coro: worker(name, steps[i] ?? 0) });
		filler(rng, counter, lines, instrs, 0.7);
	});
	for (const i of rng.shuffle(names.map((_, k) => k))) {
		lines.push(`    r = await t${i + 1}`, "    print('main got', r)");
		instrs.push(
			{ op: 'await', v: `t${i + 1}`, into: 'r', label: null },
			{ op: 'printVar', prefix: 'main got', v: 'r' }
		);
		filler(rng, counter, lines, instrs, 0.4);
	}
	return program([WORKER_SOURCE], lines, instrs);
}

function gatherProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, 5);
	const lines: string[] = [];
	const instrs: Instr[] = [];
	const counter = { n: 0 };
	const background = rng.bool(0.6);
	if (background) {
		const s = rng.int(1, 4);
		lines.push(`    bg = asyncio.create_task(worker('${names[4]}', ${s}))`);
		instrs.push({ op: 'create', v: 'bg', coro: worker(names[4] ?? 'bg', s) });
		filler(rng, counter, lines, instrs, 0.6);
	}
	const count = rng.int(2, 3);
	const pre = rng.bool(0.4) ? rng.int(0, count - 1) : -1;
	const args: string[] = [];
	const items: (Coro | string)[] = [];
	for (let i = 0; i < count; i += 1) {
		const name = names[i] ?? `w${i}`;
		const s = rng.int(0, 3);
		if (i === pre) {
			lines.push(`    early = asyncio.create_task(worker('${name}', ${s}))`);
			instrs.push({ op: 'create', v: 'early', coro: worker(name, s) });
			filler(rng, counter, lines, instrs, 0.5);
			args.push('early');
			items.push('early');
		} else {
			args.push(`worker('${name}', ${s})`);
			items.push(worker(name, s));
		}
	}
	lines.push(`    results = await asyncio.gather(${args.join(', ')})`, '    print(results)');
	instrs.push({ op: 'gather', items, into: 'results' }, { op: 'printList', v: 'results' });
	if (background) {
		lines.push('    r = await bg', "    print('main got', r)");
		instrs.push({ op: 'await', v: 'bg', into: 'r', label: null }, { op: 'printVar', prefix: 'main got', v: 'r' });
	}
	return program([WORKER_SOURCE], lines, instrs);
}

function queueProgram(rng: Rng): Program {
	const items = rng
		.sample(
			Array.from({ length: 90 }, (_, i) => 10 + i),
			rng.int(3, 4)
		)
		.map(String);
	const signalAt = rng.int(0, items.length - 1);
	const pauses = items.map((_, i) => i).filter(() => rng.bool(0.5));
	const tuple = pauses.length === 0 ? '()' : pauses.length === 1 ? `(${pauses[0]},)` : `(${pauses.join(', ')})`;
	const producer: Instr[] = [];
	items.forEach((item, i) => {
		producer.push({ op: 'put', q: 'q', item }, { op: 'print', text: `put ${item}` });
		if (i === signalAt) producer.push({ op: 'set', e: 'ready' }, { op: 'print', text: 'ready set' });
		if (pauses.includes(i)) producer.push({ op: 'sleep' });
	});
	producer.push({ op: 'print', text: 'producer done' });
	const consumer: Instr[] = [
		{ op: 'print', text: 'consumer waits' },
		{ op: 'wait', e: 'ready' },
		{ op: 'print', text: 'consumer ready' }
	];
	items.forEach(() => consumer.push({ op: 'get', q: 'q', into: 'item' }, { op: 'printVar', prefix: 'got', v: 'item' }));
	const helpers = [
		[
			'async def producer(q, ready, items, signal_at, pauses):',
			'    for i, item in enumerate(items):',
			'        q.put_nowait(item)',
			"        print(f'put {item}')",
			'        if i == signal_at:',
			'            ready.set()',
			"            print('ready set')",
			'        if i in pauses:',
			'            await asyncio.sleep(0)',
			"    print('producer done')"
		],
		[
			'async def consumer(q, ready, count):',
			"    print('consumer waits')",
			'    await ready.wait()',
			"    print('consumer ready')",
			'    for _ in range(count):',
			'        item = await q.get()',
			"        print(f'got {item}')"
		]
	];
	const lines = ['    q = asyncio.Queue()', '    ready = asyncio.Event()'];
	const instrs: Instr[] = [];
	const create = {
		c: () => {
			lines.push(`    c = asyncio.create_task(consumer(q, ready, ${items.length}))`);
			instrs.push({ op: 'create', v: 'c', coro: plainCoro(consumer) });
		},
		p: () => {
			lines.push(`    p = asyncio.create_task(producer(q, ready, [${items.join(', ')}], ${signalAt}, ${tuple}))`);
			instrs.push({ op: 'create', v: 'p', coro: plainCoro(producer) });
		}
	};
	const counter = { n: 0 };
	for (const key of rng.shuffle(['c', 'p'] as const)) {
		create[key]();
		filler(rng, counter, lines, instrs, 0.4);
	}
	if (rng.bool()) {
		lines.push('    await asyncio.gather(c, p)');
		instrs.push({ op: 'gather', items: ['c', 'p'], into: null });
	} else {
		for (const v of rng.shuffle(['c', 'p'])) {
			lines.push(`    await ${v}`);
			instrs.push({ op: 'await', v, into: null, label: null });
		}
	}
	lines.push("    print('main done')");
	instrs.push({ op: 'print', text: 'main done' });
	return program(helpers, lines, instrs);
}

function job(name: string, steps: number): Coro {
	const instrs: Instr[] = [{ op: 'print', text: `${name} start` }];
	for (let i = 0; i < steps; i += 1) instrs.push({ op: 'sleep' }, { op: 'print', text: `${name} step ${i}` });
	instrs.push({ op: 'return', value: `done ${steps}` });
	return { instrs, handler: { from: 1, to: instrs.length, except: `${name} cancelled`, final: `${name} cleanup` } };
}

const JOB_SOURCE = [
	'async def job(name, steps):',
	"    print(f'{name} start')",
	'    try:',
	'        for i in range(steps):',
	'            await asyncio.sleep(0)',
	"            print(f'{name} step {i}')",
	"        return f'done {steps}'",
	'    except asyncio.CancelledError:',
	"        print(f'{name} cancelled')",
	'        raise',
	'    finally:',
	"        print(f'{name} cleanup')"
];

/** `for label, t in ((...), ...): try: print(label, await t) except CancelledError: print(label, 'was cancelled')`. */
function collect(pairs: [string, string][], lines: string[], instrs: Instr[]): void {
	lines.push(
		`    for label, t in (${pairs.map(([label, v]) => `('${label}', ${v})`).join(', ')}):`,
		'        try:',
		'            print(label, await t)',
		'        except asyncio.CancelledError:',
		"            print(label, 'was cancelled')"
	);
	for (const [label, v] of pairs) instrs.push({ op: 'await', v, into: null, label });
}

function cancelProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, rng.int(3, 4));
	const vars = names.map((_, i) => String.fromCharCode(97 + i));
	const lines: string[] = [];
	const instrs: Instr[] = [];
	const created: string[] = [];
	const cancelled = new Set<string>();
	const cancelSome = (): void => {
		const open = created.filter((v) => !cancelled.has(v));
		if (open.length === 0) return;
		const chosen = rng.sample(open, Math.min(open.length, rng.int(1, 2)));
		for (const v of chosen) cancelled.add(v);
		lines.push(`    print('cancel', ${chosen.map((v) => `${v}.cancel()`).join(', ')})`);
		instrs.push({ op: 'cancel', vs: chosen });
	};
	names.forEach((name, i) => {
		const v = vars[i] ?? 'x';
		const s = rng.int(0, 3);
		lines.push(`    ${v} = asyncio.create_task(job('${name}', ${s}))`);
		instrs.push({ op: 'create', v, coro: job(name, s) });
		created.push(v);
		if (rng.bool(0.5)) {
			lines.push('    await asyncio.sleep(0)');
			instrs.push({ op: 'sleep' });
		}
		if (rng.bool(0.4)) cancelSome();
	});
	for (let k = rng.int(1, 2); k > 0; k -= 1) {
		if (rng.bool(0.6)) {
			lines.push('    await asyncio.sleep(0)');
			instrs.push({ op: 'sleep' });
		}
		cancelSome();
	}
	collect(
		names.map((name, i) => [name, vars[i] ?? 'x']),
		lines,
		instrs
	);
	return program([JOB_SOURCE], lines, instrs);
}

function lockProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, 5);
	const worker = (name: string, work: number): Coro => {
		const instrs: Instr[] = [
			{ op: 'print', text: `${name} wants` },
			{ op: 'acquire', l: 'lock' },
			{ op: 'print', text: `${name} in` }
		];
		for (let i = 0; i < work; i += 1) instrs.push({ op: 'sleep' });
		instrs.push({ op: 'print', text: `${name} out` }, { op: 'release', l: 'lock' });
		return plainCoro(instrs);
	};
	const helper = [
		'async def worker(name, lock, work):',
		"    print(f'{name} wants')",
		'    async with lock:',
		"        print(f'{name} in')",
		'        for _ in range(work):',
		'            await asyncio.sleep(0)',
		"        print(f'{name} out')"
	];
	const first = rng.int(2, 3);
	const pairs = names.slice(0, first).map((name) => [name, rng.int(0, 2)] as const);
	const lines = [
		'    lock = asyncio.Lock()',
		`    tasks = [asyncio.create_task(worker(name, lock, work)) for name, work in (${pairs
			.map(([n, w]) => `('${n}', ${w})`)
			.join(', ')})]`
	];
	const instrs: Instr[] = pairs.map(([n, w], i) => ({ op: 'create', v: `w${i}`, coro: worker(n, w) }));
	const all = pairs.map((_, i) => `w${i}`);
	const late = rng.int(1, 2);
	for (let k = 0; k < late; k += 1) {
		for (let s = rng.int(0, 3); s > 0; s -= 1) {
			lines.push('    await asyncio.sleep(0)');
			instrs.push({ op: 'sleep' });
		}
		const name = names[first + k] ?? 'late';
		const work = rng.int(0, 2);
		lines.push(`    tasks.append(asyncio.create_task(worker('${name}', lock, ${work})))`);
		instrs.push({ op: 'create', v: `l${k}`, coro: worker(name, work) });
		all.push(`l${k}`);
	}
	lines.push('    await asyncio.gather(*tasks)', "    print('main done')");
	instrs.push({ op: 'gather', items: all, into: null }, { op: 'print', text: 'main done' });
	return program([helper], lines, instrs);
}

function shieldProgram(rng: Rng): Program {
	const [n1, n2] = rng.sample(NAMES, 2) as [string, string];
	const [c1, c2] = rng.shuffle(['first', 'second']) as [string, string];
	const shieldedFirst = rng.bool();
	const shortJob = (name: string, steps: number): Coro => {
		const instrs: Instr[] = [];
		for (let i = 0; i < steps; i += 1) instrs.push({ op: 'sleep' }, { op: 'print', text: `${name} step ${i}` });
		instrs.push({ op: 'return', value: `${name} result` });
		return { instrs, handler: { from: 0, to: instrs.length, except: `${name} cancelled`, final: null } };
	};
	const caller = (name: string, inner: string, shielded: boolean): Coro => ({
		instrs: [
			{ op: 'print', text: `${name} waits` },
			shielded ? { op: 'shield', v: inner, into: 'result' } : { op: 'await', v: inner, into: 'result', label: null },
			{ op: 'printVar', prefix: `${name} got`, v: 'result' },
			{ op: 'return', value: null }
		],
		handler: { from: 1, to: 2, except: `${name} cancelled`, final: null }
	});
	const helpers = [
		[
			'async def job(name, steps):',
			'    try:',
			'        for i in range(steps):',
			'            await asyncio.sleep(0)',
			"            print(f'{name} step {i}')",
			"        return f'{name} result'",
			'    except asyncio.CancelledError:',
			"        print(f'{name} cancelled')",
			'        raise'
		],
		[
			'async def caller(name, inner, shielded):',
			"    print(f'{name} waits')",
			'    try:',
			'        if shielded:',
			'            result = await asyncio.shield(inner)',
			'        else:',
			'            result = await inner',
			'    except asyncio.CancelledError:',
			"        print(f'{name} cancelled')",
			'        raise',
			"    print(f'{name} got {result}')"
		]
	];
	const s1 = rng.int(1, 3);
	const s2 = rng.int(1, 3);
	const lines = [
		`    j1 = asyncio.create_task(job('${n1}', ${s1}))`,
		`    j2 = asyncio.create_task(job('${n2}', ${s2}))`,
		`    k1 = asyncio.create_task(caller('${c1}', j1, ${shieldedFirst ? 'True' : 'False'}))`,
		`    k2 = asyncio.create_task(caller('${c2}', j2, ${shieldedFirst ? 'False' : 'True'}))`
	];
	const instrs: Instr[] = [
		{ op: 'create', v: 'j1', coro: shortJob(n1, s1) },
		{ op: 'create', v: 'j2', coro: shortJob(n2, s2) }
	];
	instrs.push(
		{ op: 'create', v: 'k1', coro: caller(c1, 'inner', shieldedFirst), bind: [['inner', 'j1']] },
		{ op: 'create', v: 'k2', coro: caller(c2, 'inner', !shieldedFirst), bind: [['inner', 'j2']] }
	);
	for (let s = rng.int(0, 2); s > 0; s -= 1) {
		lines.push('    await asyncio.sleep(0)');
		instrs.push({ op: 'sleep' });
	}
	const order = rng.shuffle(['k1', 'k2']);
	lines.push(`    print('cancel', ${order.map((v) => `${v}.cancel()`).join(', ')})`);
	instrs.push({ op: 'cancel', vs: order });
	collect(
		[
			[c1, 'k1'],
			[c2, 'k2'],
			[n1, 'j1'],
			[n2, 'j2']
		],
		lines,
		instrs
	);
	return program(helpers, lines, instrs);
}

function directProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, 3);
	const lines: string[] = [];
	const instrs: Instr[] = [];
	const asTask: Instr[] = [];
	const counter = { n: 0 };
	const tasks = rng.int(1, 2);
	const both = (ins: Instr): void => {
		instrs.push(ins);
		asTask.push(ins);
	};
	for (let i = 0; i < tasks; i += 1) {
		const name = names[i] ?? 'x';
		const s = rng.int(0, 3);
		lines.push(`    t${i + 1} = asyncio.create_task(worker('${name}', ${s}))`);
		both({ op: 'create', v: `t${i + 1}`, coro: worker(name, s) });
		const before = instrs.length;
		filler(rng, counter, lines, instrs, 0.5);
		asTask.push(...instrs.slice(before));
	}
	const direct = names[2] ?? 'z';
	const steps = rng.int(1, 3);
	lines.push(`    r = await worker('${direct}', ${steps})`, "    print('main got', r)");
	// Awaiting a coroutine runs its body in main itself; its return leaves the value in r.
	instrs.push(...worker(direct, steps).instrs.slice(0, -1), { op: 'assign', into: 'r', value: `${direct}${steps}` });
	asTask.push(
		{ op: 'create', v: 'direct', coro: worker(direct, steps) },
		{ op: 'await', v: 'direct', into: 'r', label: null }
	);
	both({ op: 'printVar', prefix: 'main got', v: 'r' });
	for (const i of rng.shuffle(Array.from({ length: tasks }, (_, k) => k))) {
		lines.push(`    r = await t${i + 1}`, "    print('main got', r)");
		both({ op: 'await', v: `t${i + 1}`, into: 'r', label: null });
		both({ op: 'printVar', prefix: 'main got', v: 'r' });
	}
	return { ...program([WORKER_SOURCE], lines, instrs), variants: { 'await-coro-as-task': plainCoro(asTask) } };
}

function quietJob(name: string, steps: number): Coro {
	const instrs: Instr[] = [{ op: 'print', text: `${name} start` }];
	for (let i = 0; i < steps; i += 1) instrs.push({ op: 'sleep' }, { op: 'print', text: `${name} step ${i}` });
	instrs.push({ op: 'return', value: `done ${steps}` });
	return { instrs, handler: { from: 1, to: instrs.length, except: `${name} stops`, final: null, swallow: 'stopped' } };
}

const QUIET_SOURCE = [
	'async def quiet_job(name, steps):',
	"    print(f'{name} start')",
	'    try:',
	'        for i in range(steps):',
	'            await asyncio.sleep(0)',
	"            print(f'{name} step {i}')",
	"        return f'done {steps}'",
	'    except asyncio.CancelledError:',
	"        print(f'{name} stops')",
	"        return 'stopped'"
];

function swallowProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, rng.int(3, 4));
	const vars = names.map((_, i) => String.fromCharCode(97 + i));
	const quiet = names.map(() => rng.bool(0.6));
	const lines: string[] = [];
	const instrs: Instr[] = [];
	const created: string[] = [];
	const cancelled = new Set<string>();
	const cancelSome = (): void => {
		const open = created.filter((v) => !cancelled.has(v));
		if (open.length === 0) return;
		const chosen = rng.sample(open, Math.min(open.length, rng.int(1, 2)));
		for (const v of chosen) cancelled.add(v);
		lines.push(`    print('cancel', ${chosen.map((v) => `${v}.cancel()`).join(', ')})`);
		instrs.push({ op: 'cancel', vs: chosen });
	};
	names.forEach((name, i) => {
		const v = vars[i] ?? 'x';
		const s = rng.int(1, 3);
		const silent = quiet[i] ?? false;
		lines.push(`    ${v} = asyncio.create_task(${silent ? 'quiet_job' : 'job'}('${name}', ${s}))`);
		instrs.push({ op: 'create', v, coro: silent ? quietJob(name, s) : job(name, s) });
		created.push(v);
		if (rng.bool(0.6)) {
			lines.push('    await asyncio.sleep(0)');
			instrs.push({ op: 'sleep' });
		}
		if (rng.bool(0.4)) cancelSome();
	});
	if (rng.bool(0.6)) {
		lines.push('    await asyncio.sleep(0)');
		instrs.push({ op: 'sleep' });
	}
	cancelSome();
	collect(
		names.map((name, i) => [name, vars[i] ?? 'x']),
		lines,
		instrs
	);
	lines.push(`    print('cancelled', *[t.cancelled() for t in (${vars.join(', ')})])`);
	instrs.push({ op: 'printCancelled', vs: vars });
	return program([JOB_SOURCE, QUIET_SOURCE], lines, instrs);
}

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/create-task': ['eager-create', 'lazy-tasks'],
	'middle/gather-results': ['gather-completion-order', 'eager-create'],
	'middle/queue-event': ['set-switches', 'get-always-yields'],
	'senior/cancel-states': ['unstarted-runs', 'cancel-immediate'],
	'senior/lock-fairness': ['lock-barging', 'release-switches'],
	'senior/shield': ['shield-cancels-inner', 'no-propagation'],
	'middle/await-direct': ['await-coro-as-task', 'eager-create'],
	'senior/cancel-swallow': ['swallow-still-cancelled']
};

const GENERATORS: Record<string, (rng: Rng) => Program> = {
	'create-task': createTaskProgram,
	'gather-results': gatherProgram,
	'queue-event': queueProgram,
	'cancel-states': cancelProgram,
	'lock-fairness': lockProgram,
	shield: shieldProgram,
	'await-direct': directProgram,
	'cancel-swallow': swallowProgram
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const generate = GENERATORS[input.classId];
	if (!generate) throw new Error(`${descriptor.key}: no generator for ${input.classId}`);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const p = generate(rng);
		const answer = execute(p.main, RIGHT);
		if (answer === null || answer.length > 24) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const variant = p.variants?.[id];
				const value = variant ? execute(variant, RIGHT) : execute(p.main, { ...RIGHT, ...change });
				const same = value === null || (value.length === answer.length && value.every((line, i) => line === answer[i]));
				return [id, same ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: 'Что напечатает программа на Python 3? Введите вывод построчно, как он появится на экране.',
				code: { language: 'python3', source: p.source }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: p.source, stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no program for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
