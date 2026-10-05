// The order of output of asyncio programs built on synchronization primitives: Semaphore, Queue with maxsize, Event
// with clear, Condition with notify and wait_for, Queue.join with task_done, and the cancellation of a producer that
// waits on put.
//
// The generator models the event loop of CPython 3.12–3.13 for the constructs it emits (a FIFO of ready callbacks; a
// finished future schedules its callbacks; a woken task runs on its own turn). Cancelling a task that waits on a
// Semaphore or a Condition behaves differently in 3.12 and 3.13, so the scenarios never do it. The gate runs every
// shown program with real Python and compares the output.
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

interface Coro {
	instrs: Instr[];
	/** `try` over [from, to) with `except CancelledError: print(except); raise`. */
	handler: { from: number; to: number; except: string } | null;
}

type Instr =
	| { op: 'print'; text: string }
	| { op: 'sleep' }
	| { op: 'create'; v: string; coro: Coro }
	| { op: 'gather'; vs: string[] }
	/** `print(label, await t)` inside `try/except CancelledError: print(label, 'was cancelled')`, or a plain await. */
	| { op: 'await'; v: string; label: string | null }
	| { op: 'cancel'; vs: string[] }
	| { op: 'semAcquire'; s: string }
	| { op: 'semRelease'; s: string }
	| { op: 'lockAcquire'; l: string }
	| { op: 'lockRelease'; l: string }
	| { op: 'condWait'; c: string }
	/** `await cond.wait_for(lambda: state[v] >= atLeast)`. */
	| { op: 'condWaitFor'; c: string; v: string; atLeast: number }
	| { op: 'notify'; c: string; n: number | 'all' }
	| { op: 'add'; v: string; d: number }
	| { op: 'printState'; prefix: string; v: string }
	| { op: 'eventSet'; e: string }
	| { op: 'eventClear'; e: string }
	| { op: 'eventWait'; e: string }
	| { op: 'put'; q: string; item: string }
	| { op: 'putNowait'; q: string; item: string }
	/** `item = await q.get()`; the item is printed by `printItem`. */
	| { op: 'get'; q: string }
	| { op: 'printItem'; prefix: string; suffix: string }
	| { op: 'taskDone'; q: string }
	| { op: 'join'; q: string }
	| { op: 'printSize'; q: string }
	| { op: 'return'; value: string | null };

interface Fut {
	done: boolean;
	cancelled: boolean;
	result: string | null;
	callbacks: Callback[];
	task: Task | null;
	/** The outer future of gather: its cancellation is not modelled. */
	gather: boolean;
}

interface Task extends Fut {
	task: Task;
	coro: Coro;
	pc: number;
	item: string | null;
	started: boolean;
	mustCancel: boolean;
	waiter: Fut | null;
	pending: { instr: Instr; fut: Fut | null; phase: string } | null;
}

interface Gather {
	outer: Fut;
	all: Task[];
	finished: number;
}

type Callback = { k: 'step'; task: Task } | { k: 'wake'; task: Task; fut: Fut } | { k: 'gather'; g: Gather };

interface Rules {
	semBarging: boolean;
	putNeverBlocks: boolean;
	wakeSwitches: boolean;
	clearCancels: boolean;
	setSwitches: boolean;
	notifyAll: boolean;
	puttersNewest: boolean;
	cancelledPutEnqueued: boolean;
	waitForOnce: boolean;
	joinOnEmpty: boolean;
}

const RIGHT: Rules = {
	semBarging: false,
	putNeverBlocks: false,
	wakeSwitches: false,
	clearCancels: false,
	setSwitches: false,
	notifyAll: false,
	puttersNewest: false,
	cancelledPutEnqueued: false,
	waitForOnce: false,
	joinOnEmpty: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'sem-barging': { semBarging: true },
	'put-never-blocks': { putNeverBlocks: true },
	'wake-switches': { wakeSwitches: true },
	'clear-cancels-wakeup': { clearCancels: true },
	'set-switches': { setSwitches: true },
	'notify-wakes-all': { notifyAll: true },
	'putters-newest-first': { puttersNewest: true },
	'cancelled-put-enqueued': { cancelledPutEnqueued: true },
	'wait-for-no-recheck': { waitForOnce: true },
	'join-on-empty': { joinOnEmpty: true }
};

/** A construct the model does not cover was reached: the scenario is drawn again. */
class Unsupported extends Error {}

interface Queue {
	maxsize: number;
	items: string[];
	getters: Fut[];
	putters: Fut[];
	unfinished: number;
}

class Loop {
	readonly out: string[] = [];
	readonly tasks: Task[] = [];
	readonly #ready: Callback[] = [];
	readonly #rules: Rules;
	readonly #state = new Map<string, number>();
	readonly #events = new Map<string, { set: boolean; waiters: Fut[] }>();
	readonly #locks = new Map<string, { locked: boolean; waiters: Fut[] }>();
	readonly #sems = new Map<string, { value: number; waiters: Fut[] }>();
	readonly #conds = new Map<string, Fut[]>();
	readonly #queues = new Map<string, Queue>();
	#ticks = 0;

	constructor(rules: Rules, sems: Record<string, number>, queues: Record<string, number>) {
		this.#rules = rules;
		for (const [name, value] of Object.entries(sems)) this.#sems.set(name, { value, waiters: [] });
		for (const [name, maxsize] of Object.entries(queues))
			this.#queues.set(name, { maxsize, items: [], getters: [], putters: [], unfinished: 0 });
	}

	run(main: Coro): void {
		const task = this.#newTask(main);
		this.#ready.push({ k: 'step', task });
		while (this.#ready.length) {
			if ((this.#ticks += 1) > 5000) throw new Unsupported('runaway loop');
			this.#call(this.#ready.shift() as Callback);
			if (task.done) break;
		}
		if (!task.done) throw new Unsupported('main never finished');
	}

	get allDone(): boolean {
		return this.tasks.every((t) => t.done);
	}

	#future(): Fut {
		return { done: false, cancelled: false, result: null, callbacks: [], task: null, gather: false };
	}

	#newTask(coro: Coro): Task {
		const task = {
			done: false,
			cancelled: false,
			result: null,
			callbacks: [],
			gather: false,
			coro,
			pc: 0,
			item: null,
			started: false,
			mustCancel: false,
			waiter: null,
			pending: null
		} as unknown as Task;
		task.task = task;
		this.tasks.push(task);
		return task;
	}

	#call(cb: Callback): void {
		if (cb.k === 'step') this.#step(cb.task, false);
		else if (cb.k === 'wake') this.#step(cb.task, cb.fut.cancelled);
		else {
			// gather's own callback: the outer future finishes on the callback of the last child.
			cb.g.finished += 1;
			if (cb.g.all.some((t) => t.done && t.cancelled)) throw new Unsupported('a gathered task was cancelled');
			if (cb.g.finished === cb.g.all.length && !cb.g.outer.done) this.#resolve(cb.g.outer, null, false);
		}
	}

	#resolve(f: Fut, value: string | null, sync: boolean): void {
		f.done = true;
		f.result = value;
		const callbacks = f.callbacks;
		f.callbacks = [];
		if (sync) for (const cb of callbacks) this.#call(cb);
		else this.#ready.push(...callbacks);
	}

	#cancelFuture(f: Fut): boolean {
		if (f.done) return false;
		f.done = true;
		f.cancelled = true;
		const callbacks = f.callbacks;
		f.callbacks = [];
		this.#ready.push(...callbacks);
		return true;
	}

	#complete(task: Task, value: string | null, cancelled: boolean): void {
		task.done = true;
		task.cancelled = cancelled;
		task.result = cancelled ? null : value;
		task.pending = null;
		const callbacks = task.callbacks;
		task.callbacks = [];
		this.#ready.push(...callbacks);
	}

	cancel(task: Task): boolean {
		if (task.done) return false;
		const w = task.waiter;
		if (w) {
			if (w.gather) throw new Unsupported('cancel of a gather');
			const on = task.pending?.instr.op;
			if (on !== 'put' && on !== 'get' && on !== 'eventWait' && on !== 'sleep' && on !== 'await')
				throw new Unsupported(`cancel while in ${on ?? '?'}`);
			if (w.task && w.task !== task) {
				if (this.cancel(w.task)) return true;
			} else if (this.#cancelFuture(w)) return true;
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
				task.started = true;
				this.#complete(task, null, true);
				return;
			}
			if (this.#deliver(task) === 'finished') return;
		} else if (task.pending) {
			const p = task.pending;
			task.pending = null;
			if (this.#resume(task, p) === 'suspend') return;
			task.pc += 1;
		}
		task.started = true;
		this.#run(task);
	}

	#deliver(task: Task): 'continue' | 'finished' {
		const p = task.pending;
		task.pending = null;
		if (p) this.#cleanup(task, p);
		const at = task.coro.instrs[task.pc];
		if (at?.op === 'await' && at.label !== null) {
			this.out.push(`${at.label} was cancelled`);
			task.pc += 1;
			return 'continue';
		}
		const h = task.coro.handler;
		if (h && task.pc >= h.from && task.pc < h.to) this.out.push(h.except);
		this.#complete(task, null, true);
		return 'finished';
	}

	#cleanup(task: Task, p: NonNullable<Task['pending']>): void {
		const ins = p.instr;
		if (ins.op === 'eventWait' && p.fut) {
			const ev = this.#event(ins.e);
			ev.waiters = ev.waiters.filter((f) => f !== p.fut);
		} else if ((ins.op === 'put' || ins.op === 'get') && p.fut) {
			const q = this.#queue(ins.q);
			const own = ins.op === 'put' ? q.putters : q.getters;
			const at = own.indexOf(p.fut);
			if (at >= 0) own.splice(at, 1);
			const woken = p.fut.done && !p.fut.cancelled;
			p.fut.cancelled = p.fut.cancelled || !p.fut.done;
			p.fut.done = true;
			if (ins.op === 'put') {
				if (woken && !this.#full(q)) this.#wakeNext(q.putters);
				if (this.#rules.cancelledPutEnqueued) this.#putNowait(q, ins.item);
			} else if (woken && q.items.length > 0) this.#wakeNext(q.getters);
		}
	}

	#run(task: Task): void {
		for (;;) {
			const ins = task.coro.instrs[task.pc];
			if (!ins) {
				this.#complete(task, null, false);
				return;
			}
			const r = this.#exec(task, ins);
			if (r === 'next') task.pc += 1;
			else if (r === 'raise') {
				if (this.#deliver(task) === 'finished') return;
			} else return;
		}
	}

	#suspend(task: Task, instr: Instr, fut: Fut | null, phase: string): 'suspend' {
		task.pending = { instr, fut, phase };
		if (fut) {
			fut.callbacks.push({ k: 'wake', task, fut });
			task.waiter = fut;
		} else this.#ready.push({ k: 'step', task });
		return 'suspend';
	}

	#task(name: string, env: Map<string, Task>): Task {
		const t = env.get(name);
		if (!t) throw new Error(`no task ${name}`);
		return t;
	}

	readonly #env = new Map<string, Task>();

	#exec(task: Task, ins: Instr): 'next' | 'suspend' | 'raise' | 'done' {
		switch (ins.op) {
			case 'print':
				this.out.push(ins.text);
				return 'next';
			case 'sleep':
				return this.#suspend(task, ins, null, 'sleep');
			case 'create': {
				const child = this.#newTask(ins.coro);
				this.#env.set(ins.v, child);
				this.#ready.push({ k: 'step', task: child });
				return 'next';
			}
			case 'gather': {
				const all = ins.vs.map((v) => this.#task(v, this.#env));
				const outer = this.#future();
				outer.gather = true;
				const g: Gather = { outer, all, finished: 0 };
				for (const t of all) if (!t.done) t.callbacks.push({ k: 'gather', g });
				for (const t of all) if (t.done) this.#call({ k: 'gather', g });
				if (outer.done) return 'next';
				return this.#suspend(task, ins, outer, 'gather');
			}
			case 'await': {
				const t = this.#task(ins.v, this.#env);
				if (!t.done) return this.#suspend(task, ins, t, 'await');
				if (t.cancelled) return 'raise';
				if (ins.label !== null) this.out.push(`${ins.label} ${t.result ?? 'None'}`);
				return 'next';
			}
			case 'cancel': {
				const results = ins.vs.map((v) => (this.cancel(this.#task(v, this.#env)) ? 'True' : 'False'));
				this.out.push(['cancel', ...results].join(' '));
				return 'next';
			}
			case 'semAcquire': {
				const s = this.#sem(ins.s);
				const free = this.#rules.semBarging ? s.value > 0 : s.value > 0 && s.waiters.every((w) => w.cancelled);
				if (free) {
					s.value -= 1;
					return 'next';
				}
				const f = this.#future();
				s.waiters.push(f);
				return this.#suspend(task, ins, f, 'wait');
			}
			case 'semRelease': {
				const s = this.#sem(ins.s);
				s.value += 1;
				this.#semWake(s);
				return 'next';
			}
			case 'lockAcquire':
				return this.#lockAcquire(task, ins, ins.l, 'lock');
			case 'lockRelease':
				this.#lockRelease(ins.l);
				return 'next';
			case 'condWait':
				return this.#condWait(task, ins, ins.c);
			case 'condWaitFor':
				if ((this.#state.get(ins.v) ?? 0) >= ins.atLeast) return 'next';
				return this.#condWait(task, ins, ins.c);
			case 'notify': {
				const waiters = this.#cond(ins.c);
				const n = ins.n === 'all' || this.#rules.notifyAll ? waiters.length : ins.n;
				let woken = 0;
				for (const f of waiters) {
					if (woken >= n) break;
					if (!f.done) {
						woken += 1;
						this.#resolve(f, null, false);
					}
				}
				return 'next';
			}
			case 'add':
				this.#state.set(ins.v, (this.#state.get(ins.v) ?? 0) + ins.d);
				return 'next';
			case 'printState':
				this.out.push(`${ins.prefix} ${this.#state.get(ins.v) ?? 0}`);
				return 'next';
			case 'eventSet': {
				const ev = this.#event(ins.e);
				if (!ev.set) {
					ev.set = true;
					for (const f of [...ev.waiters]) if (!f.done) this.#resolve(f, 'True', this.#rules.setSwitches);
				}
				return 'next';
			}
			case 'eventClear':
				this.#event(ins.e).set = false;
				return 'next';
			case 'eventWait':
				return this.#eventWait(task, ins, ins.e);
			case 'put':
				return this.#put(task, ins);
			case 'putNowait':
				this.#putNowait(this.#queue(ins.q), ins.item);
				return 'next';
			case 'get':
				return this.#get(task, ins);
			case 'printItem':
				this.out.push(`${ins.prefix}${task.item ?? 'None'}${ins.suffix}`);
				return 'next';
			case 'taskDone': {
				const q = this.#queue(ins.q);
				q.unfinished -= 1;
				if (q.unfinished === 0 && !this.#rules.joinOnEmpty) this.#setEvent(`${ins.q}#finished`);
				return 'next';
			}
			case 'join': {
				const q = this.#queue(ins.q);
				if (this.#rules.joinOnEmpty ? q.items.length === 0 : q.unfinished === 0) return 'next';
				return this.#eventWait(task, ins, `${ins.q}#${this.#rules.joinOnEmpty ? 'empty' : 'finished'}`);
			}
			case 'printSize':
				this.out.push(`left ${this.#queue(ins.q).items.length}`);
				return 'next';
			case 'return':
				this.#complete(task, ins.value, false);
				return 'done';
		}
	}

	#resume(task: Task, p: NonNullable<Task['pending']>): 'next' | 'suspend' {
		const ins = p.instr;
		switch (p.phase) {
			case 'sleep':
			case 'gather':
				return 'next';
			case 'await': {
				if (ins.op === 'await' && ins.label !== null) this.out.push(`${ins.label} ${p.fut?.result ?? 'None'}`);
				return 'next';
			}
			case 'wait': {
				const s = this.#sem(ins.op === 'semAcquire' ? ins.s : '');
				s.waiters = s.waiters.filter((f) => f !== p.fut);
				if (this.#rules.semBarging) {
					if (s.value > 0) {
						s.value -= 1;
						return 'next';
					}
					const f = this.#future();
					s.waiters.unshift(f);
					return this.#suspend(task, ins, f, 'wait');
				}
				if (s.value > 0) this.#semWake(s);
				// 3.12 wakes one more waiter here, 3.13 as many as the value allows: keep out of the difference.
				if (s.value > 0 && s.waiters.some((f) => !f.done)) throw new Unsupported('several free slots and waiters');
				return 'next';
			}
			case 'lock':
			case 'reacquire': {
				const name = this.#lockName(ins);
				const lock = this.#lock(name);
				lock.waiters = lock.waiters.filter((f) => f !== p.fut);
				lock.locked = true;
				return p.phase === 'lock' ? 'next' : this.#afterReacquire(task, ins);
			}
			case 'notified': {
				const c = ins.op === 'condWait' || ins.op === 'condWaitFor' ? ins.c : '';
				const waiters = this.#cond(c);
				const at = waiters.indexOf(p.fut as Fut);
				if (at >= 0) waiters.splice(at, 1);
				const r = this.#lockAcquire(task, ins, c, 'reacquire');
				return r === 'suspend' ? 'suspend' : this.#afterReacquire(task, ins);
			}
			case 'event': {
				const name =
					ins.op === 'eventWait'
						? ins.e
						: ins.op === 'join'
							? `${ins.q}#${this.#rules.joinOnEmpty ? 'empty' : 'finished'}`
							: '';
				const ev = this.#event(name);
				ev.waiters = ev.waiters.filter((f) => f !== p.fut);
				if (this.#rules.clearCancels && ins.op === 'eventWait' && !ev.set)
					return this.#eventWait(task, ins, name) === 'suspend' ? 'suspend' : 'next';
				return 'next';
			}
			case 'put':
				return this.#put(task, ins as Extract<Instr, { op: 'put' }>) === 'suspend' ? 'suspend' : 'next';
			case 'get':
				return this.#get(task, ins as Extract<Instr, { op: 'get' }>) === 'suspend' ? 'suspend' : 'next';
			default:
				throw new Error(`nothing to resume at ${p.phase}`);
		}
	}

	#lockName(ins: Instr): string {
		if (ins.op === 'lockAcquire') return ins.l;
		if (ins.op === 'condWait' || ins.op === 'condWaitFor') return ins.c;
		throw new Error(`no lock in ${ins.op}`);
	}

	#afterReacquire(task: Task, ins: Instr): 'next' | 'suspend' {
		if (ins.op !== 'condWaitFor' || this.#rules.waitForOnce) return 'next';
		if ((this.#state.get(ins.v) ?? 0) >= ins.atLeast) return 'next';
		return this.#condWait(task, ins, ins.c);
	}

	#lockAcquire(task: Task, ins: Instr, name: string, phase: string): 'next' | 'suspend' {
		const lock = this.#lock(name);
		if (!lock.locked && lock.waiters.every((w) => w.cancelled)) {
			lock.locked = true;
			return 'next';
		}
		const f = this.#future();
		lock.waiters.push(f);
		return this.#suspend(task, ins, f, phase);
	}

	#lockRelease(name: string): void {
		const lock = this.#lock(name);
		lock.locked = false;
		const first = lock.waiters[0];
		if (first && !first.done) this.#resolve(first, 'True', false);
	}

	#condWait(task: Task, ins: Instr, c: string): 'suspend' {
		this.#lockRelease(c);
		const f = this.#future();
		this.#cond(c).push(f);
		return this.#suspend(task, ins, f, 'notified');
	}

	#semWake(s: { value: number; waiters: Fut[] }): void {
		for (const f of s.waiters) {
			if (!f.done) {
				if (!this.#rules.semBarging) s.value -= 1;
				this.#resolve(f, 'True', false);
				return;
			}
		}
	}

	#setEvent(name: string): void {
		const ev = this.#event(name);
		if (ev.set) return;
		ev.set = true;
		for (const f of [...ev.waiters]) if (!f.done) this.#resolve(f, 'True', false);
	}

	#eventWait(task: Task, ins: Instr, name: string): 'next' | 'suspend' {
		const ev = this.#event(name);
		if (ev.set) return 'next';
		const f = this.#future();
		ev.waiters.push(f);
		return this.#suspend(task, ins, f, 'event');
	}

	#full(q: Queue): boolean {
		return q.maxsize > 0 && q.items.length >= q.maxsize && !this.#rules.putNeverBlocks;
	}

	#put(task: Task, ins: Extract<Instr, { op: 'put' }>): 'next' | 'suspend' {
		const q = this.#queue(ins.q);
		if (this.#full(q)) {
			const f = this.#future();
			q.putters.push(f);
			return this.#suspend(task, ins, f, 'put');
		}
		this.#putNowait(q, ins.item);
		return 'next';
	}

	#putNowait(q: Queue, item: string): void {
		q.items.push(item);
		q.unfinished += 1;
		const name = [...this.#queues].find(([, v]) => v === q)?.[0] ?? '';
		this.#event(`${name}#finished`).set = false;
		this.#event(`${name}#empty`).set = false;
		this.#wakeNext(q.getters);
	}

	#get(task: Task, ins: Extract<Instr, { op: 'get' }>): 'next' | 'suspend' {
		const q = this.#queue(ins.q);
		const item = q.items.shift();
		if (item === undefined) {
			const f = this.#future();
			q.getters.push(f);
			return this.#suspend(task, ins, f, 'get');
		}
		task.item = item;
		if (q.items.length === 0 && this.#rules.joinOnEmpty) this.#setEvent(`${ins.q}#empty`);
		this.#wakeNext(q.putters, this.#rules.puttersNewest);
		return 'next';
	}

	#wakeNext(waiters: Fut[], newest = false): void {
		while (waiters.length) {
			const f = (newest ? waiters.pop() : waiters.shift()) as Fut;
			if (!f.done) {
				this.#resolve(f, null, this.#rules.wakeSwitches);
				return;
			}
		}
	}

	#event(name: string) {
		let ev = this.#events.get(name);
		if (!ev) this.#events.set(name, (ev = { set: false, waiters: [] }));
		return ev;
	}

	#lock(name: string) {
		let l = this.#locks.get(name);
		if (!l) this.#locks.set(name, (l = { locked: false, waiters: [] }));
		return l;
	}

	#sem(name: string) {
		const s = this.#sems.get(name);
		if (!s) throw new Error(`no semaphore ${name}`);
		return s;
	}

	#cond(name: string): Fut[] {
		let c = this.#conds.get(name);
		if (!c) this.#conds.set(name, (c = []));
		return c;
	}

	#queue(name: string): Queue {
		const q = this.#queues.get(name);
		if (!q) throw new Error(`no queue ${name}`);
		return q;
	}
}

interface Program {
	source: string;
	main: Coro;
	sems: Record<string, number>;
	queues: Record<string, number>;
}

function execute(p: Program, rules: Rules): string[] | null {
	const loop = new Loop(rules, p.sems, p.queues);
	try {
		loop.run(p.main);
	} catch (error) {
		if (error instanceof Unsupported) return null;
		throw error;
	}
	return loop.allDone ? loop.out : null;
}

// Programs: Python source and the model's instructions side by side.

const NAMES = ['red', 'blue', 'gold', 'gray', 'pink', 'teal', 'lime', 'navy'] as const;
const plain = (instrs: Instr[]): Coro => ({ instrs, handler: null });
const sleeps = (n: number): Instr[] => Array.from({ length: n }, (): Instr => ({ op: 'sleep' }));

function source(helpers: string[][], main: string[]): string {
	return [
		'import asyncio',
		'',
		'',
		...helpers.flatMap((h) => [...h, '', '']),
		'async def main():',
		...main,
		'',
		'',
		'asyncio.run(main())'
	].join('\n');
}

function semaphoreProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, 6);
	const slots = rng.int(2, 3);
	const worker = (name: string, work: number): Coro =>
		plain([
			{ op: 'print', text: `${name} waits` },
			{ op: 'semAcquire', s: 'sem' },
			{ op: 'print', text: `${name} in` },
			...sleeps(work),
			{ op: 'print', text: `${name} out` },
			{ op: 'semRelease', s: 'sem' }
		]);
	const first = rng.int(slots + 1, slots + 2);
	const pairs = names.slice(0, first).map((n) => [n, rng.int(0, 2)] as const);
	const lines = [
		`    sem = asyncio.Semaphore(${slots})`,
		`    tasks = [asyncio.create_task(worker(name, sem, work)) for name, work in (${pairs.map(([n, w]) => `('${n}', ${w})`).join(', ')})]`
	];
	const instrs: Instr[] = pairs.map(([n, w], i) => ({ op: 'create', v: `w${i}`, coro: worker(n, w) }));
	const all = pairs.map((_, i) => `w${i}`);
	for (let k = 0; k < rng.int(1, 2); k += 1) {
		const s = rng.int(0, 3);
		lines.push(...Array.from({ length: s }, () => '    await asyncio.sleep(0)'));
		instrs.push(...sleeps(s));
		const name = names[first + k] ?? 'late';
		const work = rng.int(0, 2);
		lines.push(`    tasks.append(asyncio.create_task(worker('${name}', sem, ${work})))`);
		instrs.push({ op: 'create', v: `l${k}`, coro: worker(name, work) });
		all.push(`l${k}`);
	}
	lines.push('    await asyncio.gather(*tasks)', "    print('main done')");
	instrs.push({ op: 'gather', vs: all }, { op: 'print', text: 'main done' });
	const helper = [
		'async def worker(name, sem, work):',
		"    print(f'{name} waits')",
		'    async with sem:',
		"        print(f'{name} in')",
		'        for _ in range(work):',
		'            await asyncio.sleep(0)',
		"        print(f'{name} out')"
	];
	return { source: source([helper], lines), main: plain(instrs), sems: { sem: slots }, queues: {} };
}

const tuple = (xs: number[]): string =>
	xs.length === 0 ? '()' : xs.length === 1 ? `(${xs[0]},)` : `(${xs.join(', ')})`;

const PRODUCER_SOURCE = [
	'async def producer(name, q, items):',
	'    for item in items:',
	'        await q.put(item)',
	"        print(f'{name} put {item}')",
	"    print(f'{name} done')"
];

const CONSUMER_SOURCE = [
	'async def consumer(q, count, pauses):',
	'    for i in range(count):',
	'        item = await q.get()',
	"        print(f'got {item}')",
	'        if i in pauses:',
	'            await asyncio.sleep(0)'
];

function producer(name: string, items: string[]): Coro {
	return plain([
		...items.flatMap((item): Instr[] => [
			{ op: 'put', q: 'q', item },
			{ op: 'print', text: `${name} put ${item}` }
		]),
		{ op: 'print', text: `${name} done` }
	]);
}

function consumer(count: number, pauses: number[]): Coro {
	const instrs: Instr[] = [];
	for (let i = 0; i < count; i += 1) {
		instrs.push({ op: 'get', q: 'q' }, { op: 'printItem', prefix: 'got ', suffix: '' });
		if (pauses.includes(i)) instrs.push({ op: 'sleep' });
	}
	return plain(instrs);
}

function queueProgram(rng: Rng, producers: number): Program {
	const names = rng.sample(['p1', 'p2', 'p3'], producers).sort();
	const values = rng.sample(
		Array.from({ length: 90 }, (_, i) => String(10 + i)),
		9
	);
	let at = 0;
	const lists = names.map(() => values.slice(at, (at += rng.int(2, producers > 1 ? 3 : 4))));
	const total = lists.reduce((n, l) => n + l.length, 0);
	const maxsize = rng.int(1, 2);
	const pauses = Array.from({ length: total }, (_, i) => i).filter(() => rng.bool(0.4));
	const lines = [`    q = asyncio.Queue(maxsize=${maxsize})`];
	const instrs: Instr[] = [];
	const created: string[] = [];
	const order = rng.shuffle(['c', ...names]);
	for (const who of order) {
		if (who === 'c') {
			lines.push(`    c = asyncio.create_task(consumer(q, ${total}, ${tuple(pauses)}))`);
			instrs.push({ op: 'create', v: 'c', coro: consumer(total, pauses) });
		} else {
			const items = lists[names.indexOf(who)] ?? [];
			lines.push(`    ${who} = asyncio.create_task(producer('${who}', q, [${items.join(', ')}]))`);
			instrs.push({ op: 'create', v: who, coro: producer(who, items) });
		}
		created.push(who);
		if (rng.bool(0.4)) {
			lines.push('    await asyncio.sleep(0)');
			instrs.push({ op: 'sleep' });
		}
	}
	lines.push(`    await asyncio.gather(${created.join(', ')})`, "    print('main done')");
	instrs.push({ op: 'gather', vs: created }, { op: 'print', text: 'main done' });
	return {
		source: source([PRODUCER_SOURCE, CONSUMER_SOURCE], lines),
		main: plain(instrs),
		sems: {},
		queues: { q: maxsize }
	};
}

function eventProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, 4);
	const waiter = (name: string): Coro =>
		plain([
			{ op: 'print', text: `${name} waits` },
			{ op: 'eventWait', e: 'ev' },
			{ op: 'print', text: `${name} woke` }
		]);
	const helper = [
		'async def waiter(name, ev):',
		"    print(f'{name} waits')",
		'    await ev.wait()',
		"    print(f'{name} woke')"
	];
	const lines = ['    ev = asyncio.Event()'];
	const instrs: Instr[] = [];
	const created: string[] = [];
	const create = (i: number): void => {
		const name = names[i] ?? 'x';
		lines.push(`    t${i} = asyncio.create_task(waiter('${name}', ev))`);
		instrs.push({ op: 'create', v: `t${i}`, coro: waiter(name) });
		created.push(`t${i}`);
	};
	const pause = (n: number): void => {
		lines.push(...Array.from({ length: n }, () => '    await asyncio.sleep(0)'));
		instrs.push(...sleeps(n));
	};
	const first = rng.int(2, 3);
	for (let i = 0; i < first; i += 1) create(i);
	pause(rng.int(0, 1));
	lines.push('    ev.set()', "    print('set')");
	instrs.push({ op: 'eventSet', e: 'ev' }, { op: 'print', text: 'set' });
	pause(rng.int(0, 1));
	lines.push('    ev.clear()', "    print('clear')");
	instrs.push({ op: 'eventClear', e: 'ev' }, { op: 'print', text: 'clear' });
	for (let i = first; i < 4; i += 1) if (rng.bool(0.6)) create(i);
	pause(rng.int(1, 2));
	lines.push('    ev.set()', "    print('set again')");
	instrs.push({ op: 'eventSet', e: 'ev' }, { op: 'print', text: 'set again' });
	lines.push(`    await asyncio.gather(${created.join(', ')})`, "    print('main done')");
	instrs.push({ op: 'gather', vs: created }, { op: 'print', text: 'main done' });
	return { source: source([helper], lines), main: plain(instrs), sems: {}, queues: {} };
}

function conditionProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, rng.int(3, 4));
	const waiter = (name: string): Coro =>
		plain([
			{ op: 'lockAcquire', l: 'cond' },
			{ op: 'print', text: `${name} waits` },
			{ op: 'condWait', c: 'cond' },
			{ op: 'print', text: `${name} notified` },
			{ op: 'lockRelease', l: 'cond' }
		]);
	const helper = [
		'async def consumer(name, cond):',
		'    async with cond:',
		"        print(f'{name} waits')",
		'        await cond.wait()',
		"        print(f'{name} notified')"
	];
	const lines = ['    cond = asyncio.Condition()'];
	const instrs: Instr[] = [];
	names.forEach((name, i) => {
		lines.push(`    t${i} = asyncio.create_task(consumer('${name}', cond))`);
		instrs.push({ op: 'create', v: `t${i}`, coro: waiter(name) });
	});
	const batches: number[] = [];
	let left = names.length;
	while (left > 0) {
		const n = Math.min(left, rng.int(1, 2));
		batches.push(n);
		left -= n;
	}
	for (const n of batches) {
		const s = rng.int(1, 2);
		lines.push(...Array.from({ length: s }, () => '    await asyncio.sleep(0)'));
		instrs.push(...sleeps(s));
		lines.push('    async with cond:', `        cond.notify(${n})`, `        print('notify ${n}')`);
		instrs.push(
			{ op: 'lockAcquire', l: 'cond' },
			{ op: 'notify', c: 'cond', n },
			{ op: 'print', text: `notify ${n}` },
			{ op: 'lockRelease', l: 'cond' }
		);
	}
	const vars = names.map((_, i) => `t${i}`);
	lines.push(`    await asyncio.gather(${vars.join(', ')})`, "    print('main done')");
	instrs.push({ op: 'gather', vs: vars }, { op: 'print', text: 'main done' });
	return { source: source([helper], lines), main: plain(instrs), sems: {}, queues: {} };
}

/** `for label, t in ((...), ...): try: print(label, await t) except CancelledError: print(label, 'was cancelled')`. */
function collect(pairs: [string, string][], lines: string[], instrs: Instr[]): void {
	lines.push(
		`    for label, t in (${pairs.map(([label, v]) => `('${label}', ${v})`).join(', ')}):`,
		'        try:',
		'            print(label, await t)',
		'        except asyncio.CancelledError:',
		"            print(label, 'was cancelled')"
	);
	for (const [label, v] of pairs) instrs.push({ op: 'await', v, label });
}

function cancelPutProgram(rng: Rng): Program {
	const values = rng.sample(
		Array.from({ length: 90 }, (_, i) => String(10 + i)),
		5
	);
	const items = values.slice(0, rng.int(4, 5));
	const maxsize = rng.int(1, 2);
	const gets = rng.int(1, 2);
	const pauses = [0, 1].filter(() => rng.bool(0.5));
	const guarded: Instr[] = items.flatMap((item): Instr[] => [
		{ op: 'put', q: 'q', item },
		{ op: 'print', text: `p put ${item}` }
	]);
	const producerCoro: Coro = {
		instrs: [...guarded, { op: 'print', text: 'p done' }],
		handler: { from: 0, to: guarded.length + 1, except: 'p cancelled' }
	};
	const helpers = [
		[
			'async def producer(q, items):',
			'    try:',
			'        for item in items:',
			'            await q.put(item)',
			"            print(f'p put {item}')",
			"        print('p done')",
			'    except asyncio.CancelledError:',
			"        print('p cancelled')",
			'        raise'
		],
		CONSUMER_SOURCE
	];
	const lines = [
		`    q = asyncio.Queue(maxsize=${maxsize})`,
		`    p = asyncio.create_task(producer(q, [${items.join(', ')}]))`
	];
	const instrs: Instr[] = [{ op: 'create', v: 'p', coro: producerCoro }];
	const consumerFirst = rng.bool();
	const createConsumer = (): void => {
		lines.push(`    c = asyncio.create_task(consumer(q, ${gets}, ${tuple(pauses)}))`);
		instrs.push({ op: 'create', v: 'c', coro: consumer(gets, pauses) });
	};
	if (consumerFirst) createConsumer();
	const s = rng.int(1, 3);
	lines.push(...Array.from({ length: s }, () => '    await asyncio.sleep(0)'));
	instrs.push(...sleeps(s));
	if (!consumerFirst) createConsumer();
	if (rng.bool()) {
		lines.push('    await asyncio.sleep(0)');
		instrs.push({ op: 'sleep' });
	}
	lines.push("    print('cancel', p.cancel())");
	instrs.push({ op: 'cancel', vs: ['p'] });
	collect(
		[
			['producer', 'p'],
			['consumer', 'c']
		],
		lines,
		instrs
	);
	lines.push("    print('left', q.qsize())");
	instrs.push({ op: 'printSize', q: 'q' });
	return { source: source(helpers, lines), main: plain(instrs), sems: {}, queues: { q: maxsize } };
}

function waitForProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, rng.int(2, 3));
	const needs = names.map(() => rng.int(2, 9));
	const total = needs.reduce((a, b) => a + b, 0);
	const batches: number[] = [];
	let sum = 0;
	while (sum < total) {
		const n = rng.int(2, 7);
		batches.push(n);
		sum += n;
	}
	const consumerCoro = (name: string, need: number): Coro =>
		plain([
			{ op: 'lockAcquire', l: 'cond' },
			{ op: 'print', text: `${name} waits for ${need}` },
			{ op: 'condWaitFor', c: 'cond', v: 'stock', atLeast: need },
			{ op: 'add', v: 'stock', d: -need },
			{ op: 'print', text: `${name} took ${need}` },
			{ op: 'lockRelease', l: 'cond' }
		]);
	const producerCoro = plain(
		batches.flatMap((n): Instr[] => [
			{ op: 'lockAcquire', l: 'cond' },
			{ op: 'add', v: 'stock', d: n },
			{ op: 'print', text: `added ${n}` },
			{ op: 'notify', c: 'cond', n: 'all' },
			{ op: 'lockRelease', l: 'cond' },
			{ op: 'sleep' }
		])
	);
	const helpers = [
		[
			'async def consumer(name, cond, state, need):',
			'    async with cond:',
			"        print(f'{name} waits for {need}')",
			"        await cond.wait_for(lambda: state['stock'] >= need)",
			"        state['stock'] -= need",
			"        print(f'{name} took {need}')"
		],
		[
			'async def producer(cond, state, batches):',
			'    for n in batches:',
			'        async with cond:',
			"            state['stock'] += n",
			"            print(f'added {n}')",
			'            cond.notify_all()',
			'        await asyncio.sleep(0)'
		]
	];
	const lines = ['    cond = asyncio.Condition()', "    state = {'stock': 0}"];
	const instrs: Instr[] = [];
	const vars: string[] = [];
	const producerAt = rng.int(0, names.length);
	names.forEach((name, i) => {
		if (i === producerAt) {
			lines.push(`    p = asyncio.create_task(producer(cond, state, [${batches.join(', ')}]))`);
			instrs.push({ op: 'create', v: 'p', coro: producerCoro });
			vars.push('p');
		}
		lines.push(`    t${i} = asyncio.create_task(consumer('${name}', cond, state, ${needs[i]}))`);
		instrs.push({ op: 'create', v: `t${i}`, coro: consumerCoro(name, needs[i] ?? 0) });
		vars.push(`t${i}`);
	});
	if (producerAt === names.length) {
		lines.push(`    p = asyncio.create_task(producer(cond, state, [${batches.join(', ')}]))`);
		instrs.push({ op: 'create', v: 'p', coro: producerCoro });
		vars.push('p');
	}
	lines.push(`    await asyncio.gather(${vars.join(', ')})`, "    print('stock', state['stock'])");
	instrs.push({ op: 'gather', vs: vars }, { op: 'printState', prefix: 'stock', v: 'stock' });
	return { source: source(helpers, lines), main: plain(instrs), sems: {}, queues: {} };
}

function joinProgram(rng: Rng): Program {
	const names = rng.sample(NAMES, 2);
	const items = rng.sample(
		Array.from({ length: 90 }, (_, i) => String(10 + i)),
		rng.int(3, 5)
	);
	const counts = [rng.int(1, items.length - 1)];
	counts.push(items.length - (counts[0] ?? 0));
	const works = names.map(() => rng.int(0, 2));
	const workerCoro = (name: string, count: number, work: number): Coro =>
		plain(
			Array.from({ length: count }, (): Instr[] => [
				{ op: 'get', q: 'q' },
				{ op: 'printItem', prefix: `${name} got `, suffix: '' },
				...sleeps(work),
				{ op: 'taskDone', q: 'q' },
				{ op: 'printItem', prefix: `${name} done `, suffix: '' }
			]).flat()
		);
	const helper = [
		'async def worker(name, q, count, work):',
		'    for _ in range(count):',
		'        item = await q.get()',
		"        print(f'{name} got {item}')",
		'        for _ in range(work):',
		'            await asyncio.sleep(0)',
		'        q.task_done()',
		"        print(f'{name} done {item}')"
	];
	const lines = ['    q = asyncio.Queue()', `    for item in [${items.join(', ')}]:`, '        q.put_nowait(item)'];
	const instrs: Instr[] = items.map((item) => ({ op: 'putNowait', q: 'q', item }));
	names.forEach((name, i) => {
		lines.push(`    w${i} = asyncio.create_task(worker('${name}', q, ${counts[i]}, ${works[i]}))`);
		instrs.push({ op: 'create', v: `w${i}`, coro: workerCoro(name, counts[i] ?? 0, works[i] ?? 0) });
	});
	if (rng.bool()) {
		lines.push('    await asyncio.sleep(0)');
		instrs.push({ op: 'sleep' });
	}
	lines.push('    await q.join()', "    print('joined')", '    await asyncio.gather(w0, w1)', "    print('main done')");
	instrs.push(
		{ op: 'join', q: 'q' },
		{ op: 'print', text: 'joined' },
		{ op: 'gather', vs: ['w0', 'w1'] },
		{ op: 'print', text: 'main done' }
	);
	return { source: source([helper], lines), main: plain(instrs), sems: {}, queues: { q: 0 } };
}

const GENERATORS: Record<string, (rng: Rng) => Program> = {
	'middle/semaphore': semaphoreProgram,
	'middle/bounded-queue': (rng) => queueProgram(rng, 1),
	'middle/event-clear': eventProgram,
	'middle/condition-notify': conditionProgram,
	'senior/multi-producer': (rng) => queueProgram(rng, rng.int(2, 3)),
	'senior/cancel-blocked-put': cancelPutProgram,
	'senior/condition-wait-for': waitForProgram,
	'senior/queue-join': joinProgram
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/semaphore': ['sem-barging'],
	'middle/bounded-queue': ['put-never-blocks', 'wake-switches'],
	'middle/event-clear': ['clear-cancels-wakeup', 'set-switches'],
	'middle/condition-notify': ['notify-wakes-all'],
	'senior/multi-producer': ['putters-newest-first', 'put-never-blocks'],
	'senior/cancel-blocked-put': ['cancelled-put-enqueued'],
	'senior/condition-wait-for': ['wait-for-no-recheck'],
	'senior/queue-join': ['join-on-empty']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const key = `${input.grade}/${input.classId}`;
	const make = GENERATORS[key];
	if (!make) throw new Error(`${descriptor.key}: no generator for ${key}`);
	const required = REQUIRED[key] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const p = make(rng);
		const answer = execute(p, RIGHT);
		if (answer === null || answer.length > 26) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = execute(p, { ...RIGHT, ...change });
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
	throw new Error(`${descriptor.key}: no program for ${key} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
