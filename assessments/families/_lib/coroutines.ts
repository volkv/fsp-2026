// Kotlin coroutines in a single-threaded `runBlocking`: a small program tree that renders to Kotlin and runs on a model
// of the event loop of kotlinx.coroutines (1.8). The generators of the `mob.coroutines.*` families build a tree, render
// the shown program from it and compute the answer by running it here; the gate proves the answer with the real JVM.
//
// The model. `runBlocking` owns one FIFO queue of dispatched tasks and a heap of delayed tasks ordered by deadline and
// then by the order of the `delay` calls. A step moves every delayed task that is due to the tail of the queue and runs
// the head. `launch`/`async` dispatch their start to the tail (UNDISPATCHED runs the body at once up to its first
// suspension, LAZY waits for `start`/`join`/`await`); `yield` dispatches the coroutine itself to the tail; a delay is
// resumed directly by its delayed task. A job completes when its body and all its children are done: the completion
// walks the job's list in the order of registration — joiners are dispatched, `invokeOnCompletion` handlers run at
// once, a parent waiting for its children goes on to the next one. Cancelling a job cancels its children (in the order
// of creation, depth first) and then dispatches the exception to its own suspended continuation; a dispatched task of
// a cancelled coroutine throws when it runs; a coroutine cancelled before its start never runs its body. Code inside
// `withContext(NonCancellable)` is never cancelled; `withContext(Dispatchers.*)` runs its block on another thread and
// dispatches the caller back when the block is done.
//
// Timing. Delays are real on the JVM, so the model refuses programs whose order would hang on the speed of the
// machine: two pending deadlines closer than 100 ms, a deadline closer than 100 ms to the end of a `Thread.sleep`, a
// tie of deadlines where the first task dispatches anything before the second runs, a program longer than one second
// of model time, a print on another thread before its first delay.
//
// Misconceptions are switches of the same model (`Beliefs`): a wrong solution is the output of the program run under
// a wrong belief.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type FamilyDescriptor,
	type GenerateInput
} from './family.ts';
import { kotlinOutputProbe, kotlinProgram } from './kotlin.ts';
import type { Rng } from './rng.ts';

export type Start = 'default' | 'lazy' | 'undispatched';

/** The value a coroutine block ends with: a number literal or a call of a declared suspend function. */
export type Result = { literal: number } | { call: string };

export type Context = 'NonCancellable' | 'Dispatchers.IO';

export type Stmt =
	/** `println("text")`; `$name` in the text is a loop variable or a `val` of the program. */
	| { k: 'say'; text: string }
	/** `println("text ${job.await()}")`. */
	| { k: 'sayAwait'; text: string; job: string }
	/** `println("text ${job.isActive} ${job.isCancelled} ${job.isCompleted}")`. */
	| { k: 'sayState'; text: string; job: string }
	| { k: 'delay'; ms: number }
	/** `Thread.sleep(ms)`: blocks the thread. */
	| { k: 'sleep'; ms: number }
	| { k: 'yield' }
	| { k: 'ensureActive' }
	/** `launch` or, with a result, `async`; `name` is the `val` holding the job. */
	| { k: 'launch'; name: string | null; start: Start; body: Stmt[]; result?: Result }
	| { k: 'start'; job: string }
	| { k: 'join'; job: string }
	| { k: 'joinAll'; jobs: string[] }
	/** `job.cancel()`, or `cancel()` of the coroutine itself when `job` is null. */
	| { k: 'cancel'; job: string | null }
	| { k: 'cancelAndJoin'; job: string }
	| { k: 'scope'; body: Stmt[] }
	/** `withContext(ctx) { ... }`, optionally `val name = withContext(ctx) { ...; result }`. */
	| { k: 'withContext'; ctx: Context; body: Stmt[]; into?: { name: string; result: Result } }
	| {
			k: 'try';
			body: Stmt[];
			catch: { type: 'Exception' | 'CancellationException'; body: Stmt[]; rethrow: boolean } | null;
			finally: Stmt[] | null;
	  }
	| { k: 'repeat'; times: number; v: string; body: Stmt[] }
	/** `if (v == eq) { body }` on a loop variable. */
	| { k: 'if'; v: string; eq: number; body: Stmt[] }
	/** `job.invokeOnCompletion { println(if (it == null) "ok" else "cancelled") }`. */
	| { k: 'onDone'; job: string; ok: string; cancelled: string }
	/** `fn()` or `val into = fn()` — a declared suspend function. */
	| { k: 'call'; fn: string; into?: string };

/** `suspend fun name(): Int { body; return returns }`. */
export interface SuspendFun {
	name: string;
	body: Stmt[];
	returns: number;
}

export interface CoProgram {
	funs: SuspendFun[];
	main: Stmt[];
}

/** Wrong beliefs about coroutines; each switches one rule of the model. */
export interface Beliefs {
	/** `launch`/`async` run their body at once, up to the first suspension (as UNDISPATCHED). */
	eagerLaunch?: boolean;
	/** `async` runs its body only when awaited. */
	lazyAsync?: boolean;
	/** `CoroutineStart.LAZY` starts like the default (when the parent suspends). */
	lazyAsDefault?: boolean;
	/** `CoroutineStart.UNDISPATCHED` is the same as the default. */
	undispatchedAsDefault?: boolean;
	/** `start()` runs a lazy coroutine at once, up to its first suspension. */
	startAtOnce?: boolean;
	/** `coroutineScope` does not wait for its children. */
	scopeNoWait?: boolean;
	/** `join` waits for the body of the job only, not for its children. */
	joinNoChildren?: boolean;
	/** A resumed joiner runs before everything already queued. */
	joinerFirst?: boolean;
	/** `join`/`await` of a completed job still suspends and lets the queue run. */
	joinAlwaysSuspends?: boolean;
	/** `delay(ms)` wakes at `ms` from the start of the program, not from the moment of the call. */
	absoluteDelays?: boolean;
	/** `delay` blocks the thread like `Thread.sleep`. */
	delayBlocks?: boolean;
	/** `Thread.sleep` suspends like `delay`. */
	sleepAsDelay?: boolean;
	/** `withContext(Dispatchers.*)` blocks the thread of `runBlocking` for its whole block. */
	withContextBlocks?: boolean;
	/** `cancel()` does nothing: the coroutine runs to its end. */
	cancelNoop?: boolean;
	/** `delay` in a cancelled coroutine that swallowed the cancellation waits as usual. */
	cancelledDelayWaits?: boolean;
	/** `cancel()` stops a suspended coroutine at once: its `finally` runs inside the call to `cancel()`. */
	cancelSync?: boolean;
	/** A cancelled coroutine skips its `finally` blocks. */
	noFinally?: boolean;
	/** `delay` inside `finally` of a cancelled coroutine works as usual. */
	finallyDelayOk?: boolean;
	/** `catch (e: Exception)` does not catch the cancellation. */
	catchMissesCancel?: boolean;
	/** Cancelling a parent leaves its children running. */
	childrenSurvive?: boolean;
	/** A cancelled parent runs its own `finally` before its children. */
	parentFirst?: boolean;
	/** A coroutine cancelled before it started still runs its body up to the first suspension. */
	runsBeforeCancel?: boolean;
	/** `cancel()` completes the job at once: `isCompleted` is true right after it. */
	completedOnCancel?: boolean;
	/** Cancelling the running coroutine itself throws at once, without waiting for a suspension point. */
	cancelThrowsAtOnce?: boolean;
	/** `invokeOnCompletion` runs after the joiners resume, not when the job completes. */
	handlerAfterJoiners?: boolean;
	/** A coroutine started inside a cancelled one runs normally. */
	childOfCancelledRuns?: boolean;
}

/** A program the model refuses: its output would depend on the speed of the machine, or it hangs. */
export class UnsafeProgram extends Error {}

/** The least gap between two distinct deadlines a family may ask for (the rule of the bank). */
const MIN_GAP = 100;
const MAX_MS = 1000;

/** The cancellation thrown inside a coroutine of the model (`CancellationException` of the program). */
class CancelSignal extends Error {}

type Op =
	| { op: 'delay'; ms: number }
	| { op: 'yield' }
	| { op: 'join'; job: Job }
	| { op: 'scope'; job: Job }
	| { op: 'off'; job: Job };

type Entry =
	| { kind: 'joiner'; co: Coroutine; token: number }
	| { kind: 'handler'; ok: string; cancelled: string }
	| { kind: 'parentWait'; parent: Job };

interface Job {
	kind: 'root' | 'coroutine' | 'scope' | 'off';
	parent: Job | null;
	children: Job[];
	cancelled: boolean;
	bodyDone: boolean;
	completed: boolean;
	lazyPending: boolean;
	list: Entry[];
	/** The coroutine whose frame this job is (for a scope — the caller inside it). */
	owner: Coroutine | null;
	value: number;
	/** A scope or another-thread block: the caller to resume when the job completes. */
	caller: Coroutine | null;
	/** The coroutine of a lazy job, started by `start`, `join` or `await`. */
	startCo: Coroutine | null;
}

interface Frame {
	/** `null` — `NonCancellable`. */
	job: Job | null;
	/** The frame runs on another thread (`withContext(Dispatchers.*)`). */
	off: boolean;
	/** A wrong belief runs the frame blocking the thread of `runBlocking`. */
	blocking?: boolean;
}

interface Coroutine {
	frames: Frame[];
	gen: Generator<Op, void, number | undefined> | null;
	/** What the coroutine waits for; `registered` waits are resumed with the cancellation when it comes. */
	wait: { kind: 'registered' | 'queued' | 'running' | 'scope' | 'done'; token: number; job?: Job };
	token: number;
	finallyDepth: number;
}

type Task =
	| { kind: 'start'; co: Coroutine; job: Job }
	| { kind: 'resume'; co: Coroutine; token: number; value?: number; ex?: boolean; cancellable: boolean }
	| { kind: 'delayed'; co: Coroutine; token: number }
	| { kind: 'print'; text: string };

interface Delayed {
	at: number;
	/** When `delay` was called: deadlines tie safely only for calls of the same moment. */
	calledAt: number;
	seq: number;
	co: Coroutine;
	token: number;
	off: boolean;
}

/** Substitutes `$name` and `${name}` of a Kotlin string template from the environment. */
function template(text: string, env: ReadonlyMap<string, number>): string {
	return text.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a: string | undefined, b: string | undefined) => {
		const name = (a ?? b) as string;
		const value = env.get(name);
		if (value === undefined) throw new Error(`template: unknown ${name}`);
		return String(value);
	});
}

class Sim {
	readonly out: string[] = [];
	readonly beliefs: Beliefs;
	readonly program: CoProgram;
	now = 0;
	queue: Task[] = [];
	delayed: Delayed[] = [];
	seq = 0;
	readonly jobs = new Map<string, Job>();
	/** Tasks due at the same deadline that are still in the queue: none may be passed by a dispatch. */
	tiedPending = 0;
	/** The least gap between distinct deadlines; `null` — the timing is not checked (a wrong belief, never run). */
	readonly gap: number | null;

	constructor(program: CoProgram, beliefs: Beliefs, gap: number | null) {
		if (gap !== null && gap < MIN_GAP) throw new Error(`a gap of ${gap} ms is below ${MIN_GAP} ms`);
		this.program = program;
		this.beliefs = beliefs;
		this.gap = gap;
	}

	newJob(kind: Job['kind'], parent: Job | null): Job {
		const job: Job = {
			kind,
			parent,
			children: [],
			cancelled: false,
			bodyDone: false,
			completed: false,
			lazyPending: false,
			list: [],
			owner: null,
			value: 0,
			caller: null,
			startCo: null
		};
		if (parent) {
			parent.children.push(job);
			// A child of a cancelled job is cancelled from the start.
			if (parent.cancelled && !this.beliefs.childOfCancelledRuns) job.cancelled = true;
		}
		return job;
	}

	newCo(job: Job | null, off: boolean): Coroutine {
		return {
			frames: [{ job, off }],
			gen: null,
			wait: { kind: 'queued', token: 0 },
			token: 0,
			finallyDepth: 0
		};
	}

	enqueue(task: Task, front = false): void {
		if (this.tiedPending > 0) throw new UnsafeProgram('a dispatch between two tasks due at the same deadline');
		if (front) this.queue.unshift(task);
		else this.queue.push(task);
	}

	top(co: Coroutine): Frame {
		return co.frames[co.frames.length - 1] as Frame;
	}

	/** The coroutine is cancelled where it runs now (`NonCancellable` hides the cancellation). */
	isCancelled(co: Coroutine): boolean {
		const frame = this.top(co);
		return frame.job !== null && frame.job.cancelled;
	}

	run(): string[] {
		const root = this.newJob('root', null);
		const co = this.newCo(root, false);
		root.owner = co;
		co.gen = this.body(co, this.program.main, null, root);
		this.enqueue({ kind: 'start', co, job: root });
		for (let steps = 0; ; steps += 1) {
			if (steps > 100000) throw new UnsafeProgram('too many steps');
			this.moveDue();
			const task = this.queue.shift();
			if (task) {
				if (task.kind === 'delayed' && this.tiedPending > 0) this.tiedPending -= 1;
				else if (this.tiedPending > 0) throw new UnsafeProgram('a task between two tasks due at the same deadline');
				this.runTask(task);
				continue;
			}
			const next = this.nextDelayed();
			if (!next) break;
			this.advanceTo(next.at, false);
		}
		if (!root.completed) throw new UnsafeProgram('the program hangs: runBlocking never completes');
		if (this.gap !== null && this.now > MAX_MS) throw new UnsafeProgram(`the program runs ${this.now} ms`);
		return this.out;
	}

	nextDelayed(): Delayed | undefined {
		let best: Delayed | undefined;
		for (const d of this.delayed) if (!best || d.at < best.at || (d.at === best.at && d.seq < best.seq)) best = d;
		return best;
	}

	/** Model time jumps to `at`: no other pending deadline may be closer than the minimal gap (a tie is checked later). */
	advanceTo(at: number, bySleep: boolean): void {
		const gap = this.gap;
		if (gap === null) {
			this.now = at;
			return;
		}
		for (const d of this.delayed) {
			const distance = Math.abs(d.at - at);
			if (distance < gap && (bySleep || distance !== 0))
				throw new UnsafeProgram(`deadlines ${d.at} and ${at} are closer than ${gap} ms`);
		}
		this.now = at;
	}

	moveDue(): void {
		const due = this.delayed.filter((d) => d.at <= this.now).sort((a, b) => a.at - b.at || a.seq - b.seq);
		if (due.length === 0) return;
		this.delayed = this.delayed.filter((d) => d.at > this.now);
		const atNow = due.filter((d) => d.at === this.now);
		if (this.gap !== null && atNow.length > 1 && atNow.some((d) => d.off))
			throw new UnsafeProgram('another thread and runBlocking resume at the same deadline');
		// Another thread resumes its block at once; nothing else happens at that moment.
		for (const d of due) if (d.off) this.resumeOff(d);
		const onLoop = due.filter((d) => !d.off);
		for (const d of onLoop) this.queue.push({ kind: 'delayed', co: d.co, token: d.token });
		const tied = onLoop.filter((d) => d.at === this.now);
		if (this.gap === null) return;
		if (tied.some((d) => d.calledAt !== tied[0]?.calledAt))
			throw new UnsafeProgram('a tie of deadlines set at different moments');
		if (tied.length > 1) this.tiedPending = tied.length;
	}

	resumeOff(d: Delayed): void {
		if (d.token !== d.co.token) return;
		this.step(d.co, { value: undefined });
	}

	runTask(task: Task): void {
		if (task.kind === 'print') {
			this.out.push(task.text);
			return;
		}
		const co = task.co;
		if (task.kind === 'start') {
			if (task.job.cancelled && !this.beliefs.runsBeforeCancel) {
				// Cancelled before it ran: the body never starts.
				co.wait = { kind: 'done', token: co.token };
				this.finishBody(task.job, true, 0);
				return;
			}
			this.step(co, { value: undefined });
			return;
		}
		if (task.token !== co.token) return;
		if (task.kind === 'delayed') {
			this.step(co, { value: undefined });
			return;
		}
		if (task.ex || (task.cancellable && this.isCancelled(co))) this.step(co, { ex: true });
		else this.step(co, { value: task.value });
	}

	/** Runs a coroutine until it suspends or ends. */
	step(co: Coroutine, input: { value?: number; ex?: boolean }): void {
		const gen = co.gen;
		if (!gen) throw new Error('a coroutine without a body');
		co.wait = { kind: 'running', token: co.token };
		let result: IteratorResult<Op, void>;
		try {
			result = input.ex ? gen.throw(new CancelSignal()) : gen.next(input.value);
		} catch (error) {
			if (error instanceof CancelSignal) {
				co.wait = { kind: 'done', token: co.token };
				return;
			}
			throw error;
		}
		if (result.done) {
			co.wait = { kind: 'done', token: co.token };
			return;
		}
		this.suspend(co, result.value);
	}

	suspend(co: Coroutine, op: Op): void {
		co.token += 1;
		const token = co.token;
		const frame = this.top(co);
		if (op.op === 'delay') {
			if (this.gap !== null && this.now + op.ms > MAX_MS) throw new UnsafeProgram('a delay past one second');
			const at = this.beliefs.absoluteDelays ? Math.max(this.now, op.ms) : this.now + op.ms;
			this.delayed.push({ at, calledAt: this.now, seq: this.seq++, co, token, off: frame.off });
			co.wait = { kind: 'registered', token };
		} else if (op.op === 'yield') {
			co.wait = { kind: 'queued', token };
			this.enqueue({ kind: 'resume', co, token, cancellable: true });
		} else if (op.op === 'join') {
			op.job.list.push({ kind: 'joiner', co, token });
			co.wait = { kind: 'registered', token, job: op.job };
		} else {
			// A scope or a block on another thread resumes the caller when its job completes.
			co.wait = { kind: 'scope', token, job: op.job };
		}
	}

	/** Sets a job cancelled: its children first, then its own suspended continuation. */
	cancel(job: Job): void {
		if (job.completed) return;
		if (job.lazyPending) {
			job.cancelled = true;
			job.lazyPending = false;
			this.finishBody(job, true, 0);
			return;
		}
		if (job.cancelled) return;
		if (job.kind === 'off') throw new UnsafeProgram('a cancellation of a block on another thread');
		job.cancelled = true;
		const own = (): void => {
			const co = job.owner;
			if (!co || this.top(co).job !== job || co.wait.kind !== 'registered') return;
			const waitJob = co.wait.job;
			if (waitJob) waitJob.list = waitJob.list.filter((e) => !(e.kind === 'joiner' && e.co === co));
			// A cancelled delay leaves the heap of delayed tasks.
			this.delayed = this.delayed.filter((d) => d.co !== co);
			co.token += 1;
			if (this.beliefs.cancelSync) this.step(co, { ex: true });
			else this.enqueue({ kind: 'resume', co, token: co.token, ex: true, cancellable: true });
		};
		if (this.beliefs.parentFirst) own();
		if (!this.beliefs.childrenSurvive) for (const child of [...job.children]) this.cancel(child);
		if (!this.beliefs.parentFirst) own();
	}

	/** The body of a job is done (normally or by an exception): the job completes when its children do. */
	finishBody(job: Job, failed: boolean, value: number): void {
		job.bodyDone = true;
		job.value = value;
		if (failed) job.cancelled = true;
		if (this.beliefs.joinNoChildren) this.notifyJoiners(job);
		this.waitChildren(job);
	}

	waitChildren(job: Job): void {
		const child = job.children.find((c) => !c.completed);
		if (child) child.list.push({ kind: 'parentWait', parent: job });
		else this.complete(job);
	}

	notifyJoiners(job: Job): void {
		const joiners = job.list.filter((e) => e.kind === 'joiner');
		job.list = job.list.filter((e) => e.kind !== 'joiner');
		for (const e of joiners)
			this.enqueue({ kind: 'resume', co: e.co, token: e.token, cancellable: true }, this.beliefs.joinerFirst);
	}

	complete(job: Job): void {
		job.completed = true;
		if (job.parent) job.parent.children = job.parent.children.filter((c) => c !== job);
		const list = job.list;
		job.list = [];
		const late: Entry[] = [];
		const front: Task[] = [];
		for (const e of list) {
			if (e.kind === 'joiner') {
				const task: Task = { kind: 'resume', co: e.co, token: e.token, cancellable: true };
				if (this.beliefs.joinerFirst) front.push(task);
				else this.enqueue(task);
			} else if (e.kind === 'handler') {
				if (this.beliefs.handlerAfterJoiners) late.push(e);
				else this.out.push(job.cancelled ? e.cancelled : e.ok);
			} else this.waitChildren(e.parent);
		}
		for (const task of front.reverse()) this.enqueue(task, true);
		for (const e of late)
			if (e.kind === 'handler') this.enqueue({ kind: 'print', text: job.cancelled ? e.cancelled : e.ok });
		if (job.caller) {
			const caller = job.caller;
			this.enqueue({
				kind: 'resume',
				co: caller,
				token: caller.token,
				value: job.value,
				ex: job.cancelled,
				cancellable: true
			});
		}
	}

	jobOf(name: string): Job {
		const job = this.jobs.get(name);
		if (!job) throw new Error(`no job ${name}`);
		return job;
	}

	/** Starts a coroutine: `launch`/`async` from `co`. */
	launch(co: Coroutine, s: Extract<Stmt, { k: 'launch' }>, env: Map<string, number>): void {
		const parent = this.top(co).job;
		if (!parent) throw new Error('launch inside NonCancellable');
		const job = this.newJob('coroutine', parent);
		if (s.name) this.jobs.set(s.name, job);
		const child = this.newCo(job, false);
		job.owner = child;
		child.gen = this.body(child, s.body, s.result ?? null, job, new Map(env));
		let start = s.start;
		if (start === 'lazy' && this.beliefs.lazyAsDefault) start = 'default';
		if (start === 'undispatched' && this.beliefs.undispatchedAsDefault) start = 'default';
		if (start === 'default' && s.result && this.beliefs.lazyAsync) start = 'lazy';
		if (start === 'default' && this.beliefs.eagerLaunch) start = 'undispatched';
		if (start === 'lazy') {
			job.lazyPending = true;
			job.startCo = child;
		} else if (start === 'undispatched') {
			if (job.cancelled && !this.beliefs.runsBeforeCancel) {
				this.finishBody(job, true, 0);
			} else this.step(child, { value: undefined });
		} else this.enqueue({ kind: 'start', co: child, job });
	}

	startLazy(job: Job): void {
		if (!job.lazyPending) return;
		job.lazyPending = false;
		const co = job.startCo as Coroutine;
		this.enqueue({ kind: 'start', co, job });
	}

	/** The body of a coroutine as a generator; finishing it finishes the job. */
	*body(
		co: Coroutine,
		stmts: Stmt[],
		result: Result | null,
		job: Job,
		env: Map<string, number> = new Map()
	): Generator<Op, void, number | undefined> {
		let failed = false;
		let value = 0;
		try {
			yield* this.exec(co, stmts, env);
			if (result) value = yield* this.result(co, result, env);
		} catch (error) {
			if (!(error instanceof CancelSignal)) throw error;
			failed = true;
		}
		this.finishBody(job, failed, value);
	}

	*result(co: Coroutine, result: Result, env: Map<string, number>): Generator<Op, number, number | undefined> {
		if ('literal' in result) return result.literal;
		const fn = this.program.funs.find((f) => f.name === result.call);
		if (!fn) throw new Error(`no function ${result.call}`);
		yield* this.exec(co, fn.body, new Map(env));
		return fn.returns;
	}

	checkCancelled(co: Coroutine): void {
		if (this.isCancelled(co)) throw new CancelSignal();
	}

	*joinJob(co: Coroutine, job: Job): Generator<Op, void, number | undefined> {
		this.startLazy(job);
		const done = this.beliefs.joinNoChildren ? job.bodyDone : job.completed;
		if (done && !this.beliefs.joinAlwaysSuspends) {
			this.checkCancelled(co);
			return;
		}
		if (done) {
			yield { op: 'yield' };
			return;
		}
		yield { op: 'join', job };
	}

	*exec(co: Coroutine, stmts: Stmt[], env: Map<string, number>): Generator<Op, void, number | undefined> {
		for (const s of stmts) yield* this.execOne(co, s, env);
	}

	*execOne(co: Coroutine, s: Stmt, env: Map<string, number>): Generator<Op, void, number | undefined> {
		const b = this.beliefs;
		switch (s.k) {
			case 'say':
				this.out.push(template(s.text, env));
				return;
			case 'sayAwait': {
				const job = this.jobOf(s.job);
				yield* this.joinJob(co, job);
				if (job.cancelled) throw new Error('await of a cancelled deferred');
				this.out.push(`${template(s.text, env)} ${job.value}`);
				return;
			}
			case 'sayState': {
				const job = this.jobOf(s.job);
				const completed = job.completed || (b.completedOnCancel === true && job.cancelled);
				const active = !job.completed && !job.cancelled && !job.lazyPending;
				this.out.push(`${template(s.text, env)} ${active} ${job.cancelled} ${completed}`);
				return;
			}
			case 'delay':
				if (b.delayBlocks || this.top(co).blocking === true) {
					this.checkCancelled(co);
					this.sleep(s.ms);
					return;
				}
				if (this.isCancelled(co) && !(b.finallyDelayOk && co.finallyDepth > 0) && !b.cancelledDelayWaits)
					throw new CancelSignal();
				yield { op: 'delay', ms: s.ms };
				return;
			case 'sleep':
				if ((this.top(co).off || b.sleepAsDelay) && this.top(co).blocking !== true) {
					yield { op: 'delay', ms: s.ms };
					return;
				}
				this.sleep(s.ms);
				return;
			case 'yield':
				this.checkCancelled(co);
				yield { op: 'yield' };
				return;
			case 'ensureActive':
				this.checkCancelled(co);
				return;
			case 'launch':
				this.launch(co, s, env);
				return;
			case 'start': {
				const job = this.jobOf(s.job);
				if (b.startAtOnce && job.lazyPending) {
					job.lazyPending = false;
					this.step(job.startCo as Coroutine, { value: undefined });
				} else this.startLazy(job);
				return;
			}
			case 'join':
				yield* this.joinJob(co, this.jobOf(s.job));
				return;
			case 'joinAll':
				for (const name of s.jobs) yield* this.joinJob(co, this.jobOf(name));
				return;
			case 'cancel': {
				if (s.job === null) {
					const job = this.top(co).job;
					if (!job) throw new Error('cancel inside NonCancellable');
					if (b.cancelNoop) return;
					this.cancel(job);
					if (b.cancelThrowsAtOnce) throw new CancelSignal();
					return;
				}
				if (!b.cancelNoop) this.cancel(this.jobOf(s.job));
				return;
			}
			case 'cancelAndJoin': {
				const job = this.jobOf(s.job);
				if (!b.cancelNoop) this.cancel(job);
				yield* this.joinJob(co, job);
				return;
			}
			case 'scope': {
				const parent = this.top(co).job;
				if (!parent) throw new Error('coroutineScope inside NonCancellable');
				const scope = this.newJob('scope', parent);
				scope.owner = co;
				co.frames.push({ job: scope, off: this.top(co).off });
				try {
					try {
						yield* this.exec(co, s.body, env);
					} catch (error) {
						if (!(error instanceof CancelSignal)) throw error;
						this.cancel(scope);
					}
					scope.bodyDone = true;
					const pending = scope.children.find((c) => !c.completed);
					if (!pending) {
						this.complete(scope);
						if (scope.cancelled) throw new CancelSignal();
						return;
					}
					pending.list.push({ kind: 'parentWait', parent: scope });
					// The wrong belief goes on at once; the scope then completes on its own.
					if (b.scopeNoWait) return;
					scope.caller = co;
					yield { op: 'scope', job: scope };
				} finally {
					co.frames.pop();
				}
				return;
			}
			case 'withContext': {
				if (s.ctx === 'NonCancellable') {
					co.frames.push({ job: null, off: this.top(co).off });
					try {
						yield* this.exec(co, s.body, env);
						if (s.into) env.set(s.into.name, yield* this.result(co, s.into.result, env));
					} finally {
						co.frames.pop();
					}
					return;
				}
				if (this.top(co).off) throw new Error('nested withContext on another thread');
				if (b.withContextBlocks) {
					// The whole block runs on the thread of runBlocking, blocking it.
					co.frames.push({ job: this.top(co).job, off: false, blocking: true });
					try {
						yield* this.exec(co, s.body, env);
						if (s.into) env.set(s.into.name, yield* this.result(co, s.into.result, env));
					} finally {
						co.frames.pop();
					}
					return;
				}
				const parent = this.top(co).job;
				const job = this.newJob('off', parent);
				job.caller = co;
				const off = this.newCo(job, true);
				job.owner = off;
				const printsBefore = this.out.length;
				const into = s.into;
				off.gen = this.offBody(off, job, s.body, into, env);
				off.frames = [{ job, off: true }];
				this.step(off, { value: undefined });
				if (this.out.length !== printsBefore)
					throw new UnsafeProgram('a print on another thread before its first delay');
				const value = yield { op: 'off', job };
				if (into) env.set(into.name, value ?? 0);
				return;
			}
			case 'try': {
				let thrown = false;
				try {
					yield* this.exec(co, s.body, env);
				} catch (error) {
					if (!(error instanceof CancelSignal)) throw error;
					thrown = true;
					const caught = s.catch !== null && !(s.catch.type === 'Exception' && b.catchMissesCancel === true);
					if (!caught || !s.catch) {
						if (s.finally && !b.noFinally) yield* this.inFinally(co, s.finally, env);
						throw error;
					}
					try {
						yield* this.exec(co, s.catch.body, env);
						if (s.catch.rethrow) throw error;
					} catch (inner) {
						if (s.finally && !(b.noFinally && inner instanceof CancelSignal)) yield* this.inFinally(co, s.finally, env);
						throw inner;
					}
				}
				if (s.finally && !(thrown && b.noFinally)) yield* this.inFinally(co, s.finally, env);
				return;
			}
			case 'repeat':
				for (let i = 0; i < s.times; i += 1) {
					env.set(s.v, i);
					yield* this.exec(co, s.body, env);
				}
				env.delete(s.v);
				return;
			case 'if':
				if (env.get(s.v) === s.eq) yield* this.exec(co, s.body, env);
				return;
			case 'onDone': {
				const job = this.jobOf(s.job);
				if (job.completed) this.out.push(job.cancelled ? s.cancelled : s.ok);
				else job.list.push({ kind: 'handler', ok: s.ok, cancelled: s.cancelled });
				return;
			}
			case 'call': {
				const value = yield* this.result(co, { call: s.fn }, env);
				if (s.into) env.set(s.into, value);
				return;
			}
		}
	}

	/** The block of `withContext(Dispatchers.*)` on another thread; its job completes with the block. */
	*offBody(
		off: Coroutine,
		job: Job,
		body: Stmt[],
		into: { name: string; result: Result } | undefined,
		env: Map<string, number>
	): Generator<Op, void, number | undefined> {
		let value = 0;
		yield* this.exec(off, body, env);
		if (into) value = yield* this.result(off, into.result, env);
		this.finishBody(job, false, value);
	}

	*inFinally(co: Coroutine, stmts: Stmt[], env: Map<string, number>): Generator<Op, void, number | undefined> {
		co.finallyDepth += 1;
		try {
			yield* this.exec(co, stmts, env);
		} finally {
			co.finallyDepth -= 1;
		}
	}

	sleep(ms: number): void {
		this.advanceTo(this.now + ms, true);
	}
}

/**
 * The output of the program on the model, under the given wrong beliefs; throws `UnsafeProgram` for a racy program.
 * `gap` — the least gap between distinct deadlines (100 ms by the rule of the bank; a family may ask for more to keep
 * its programs safe on a loaded machine); `null` — the timing is not checked: the output of a wrong belief is never
 * run on the JVM, its ties go by deadline and then by the order of the calls.
 */
export function runCoroutines(program: CoProgram, beliefs: Beliefs = {}, gap: number | null = MIN_GAP): string[] {
	return new Sim(program, beliefs, gap).run();
}

// Rendering.

const IND = '    ';

function resultExpr(result: Result): string {
	return 'literal' in result ? String(result.literal) : `${result.call}()`;
}

function simple(s: Stmt): string | null {
	switch (s.k) {
		case 'say':
			return `println("${s.text}")`;
		case 'sayAwait':
			return `println("${s.text} \${${s.job}.await()}")`;
		case 'sayState':
			return `println("${s.text} \${${s.job}.isActive} \${${s.job}.isCancelled} \${${s.job}.isCompleted}")`;
		case 'delay':
			return `delay(${s.ms})`;
		case 'sleep':
			return `Thread.sleep(${s.ms})`;
		case 'yield':
			return 'yield()';
		case 'ensureActive':
			return 'ensureActive()';
		case 'start':
			return `${s.job}.start()`;
		case 'join':
			return `${s.job}.join()`;
		case 'joinAll':
			return `joinAll(${s.jobs.join(', ')})`;
		case 'cancel':
			return s.job === null ? 'cancel()' : `${s.job}.cancel()`;
		case 'cancelAndJoin':
			return `${s.job}.cancelAndJoin()`;
		case 'onDone':
			return `${s.job}.invokeOnCompletion { println(if (it == null) "${s.ok}" else "${s.cancelled}") }`;
		case 'call':
			return s.into ? `val ${s.into} = ${s.fn}()` : `${s.fn}()`;
		default:
			return null;
	}
}

const START_ARG: Record<Start, string> = {
	default: '',
	lazy: '(start = CoroutineStart.LAZY)',
	undispatched: '(start = CoroutineStart.UNDISPATCHED)'
};

/** Joins simple statements into one line when they fit. */
function oneLine(stmts: Stmt[], tail: string | null, inlineMax = 3): string | null {
	if (stmts.length + (tail ? 1 : 0) > inlineMax) return null;
	const parts: string[] = [];
	for (const s of stmts) {
		const line = simple(s);
		if (line === null || s.k === 'onDone' || s.k === 'call') return null;
		parts.push(line);
	}
	if (tail) parts.push(tail);
	return parts.length === 0 ? null : parts.join('; ');
}

function renderBlock(head: string, stmts: Stmt[], tail: string | null, indent: string, inlineMax: number): string[] {
	const line = inlineMax > 0 ? oneLine(stmts, tail, inlineMax) : null;
	if (line !== null && indent.length + head.length + line.length + 6 <= 100) return [`${indent}${head} { ${line} }`];
	return [
		`${indent}${head} {`,
		...renderStmts(stmts, indent + IND, inlineMax),
		...(tail ? [`${indent}${IND}${tail}`] : []),
		`${indent}}`
	];
}

/** Names of jobs the program refers to; a job nobody refers to is launched without a `val`. */
let referenced: ReadonlySet<string> = new Set();

function collectReferences(stmts: readonly Stmt[], into: Set<string>): void {
	for (const s of stmts) {
		if ('job' in s && typeof s.job === 'string') into.add(s.job);
		if (s.k === 'joinAll') for (const j of s.jobs) into.add(j);
		if (s.k === 'launch' || s.k === 'scope' || s.k === 'withContext' || s.k === 'repeat' || s.k === 'if')
			collectReferences(s.body, into);
		if (s.k === 'try') {
			collectReferences(s.body, into);
			collectReferences(s.catch?.body ?? [], into);
			collectReferences(s.finally ?? [], into);
		}
	}
}

function renderStmts(stmts: Stmt[], indent: string, inlineMax: number): string[] {
	const lines: string[] = [];
	for (const s of stmts) {
		const line = simple(s);
		if (line !== null) {
			lines.push(indent + line);
			continue;
		}
		switch (s.k) {
			case 'launch': {
				const builder = `${s.result ? 'async' : 'launch'}${START_ARG[s.start]}`;
				const head = s.name && referenced.has(s.name) ? `val ${s.name} = ${builder}` : builder;
				lines.push(...renderBlock(head, s.body, s.result ? resultExpr(s.result) : null, indent, inlineMax));
				break;
			}
			case 'scope':
				lines.push(...renderBlock('coroutineScope', s.body, null, indent, inlineMax));
				break;
			case 'withContext': {
				const head = s.into ? `val ${s.into.name} = withContext(${s.ctx})` : `withContext(${s.ctx})`;
				lines.push(...renderBlock(head, s.body, s.into ? resultExpr(s.into.result) : null, indent, inlineMax));
				break;
			}
			case 'try': {
				const body = inlineMax > 0 ? oneLine(s.body, null, inlineMax) : null;
				const fin = s.finally && inlineMax > 0 ? oneLine(s.finally, null, inlineMax) : null;
				const inline = `${indent}try { ${body ?? ''} } finally { ${fin ?? ''} }`;
				if (s.catch === null && body !== null && fin !== null && inline.length <= 100) {
					lines.push(inline);
					break;
				}
				if (s.catch === null && s.finally && body !== null && s.body.length === 1) {
					lines.push(
						`${indent}try { ${body} } finally {`,
						...renderStmts(s.finally, indent + IND, inlineMax),
						`${indent}}`
					);
					break;
				}
				lines.push(`${indent}try {`, ...renderStmts(s.body, indent + IND, inlineMax));
				if (s.catch) {
					lines.push(`${indent}} catch (e: ${s.catch.type}) {`, ...renderStmts(s.catch.body, indent + IND, inlineMax));
					if (s.catch.rethrow) lines.push(`${indent}${IND}throw e`);
				}
				if (s.finally) lines.push(`${indent}} finally {`, ...renderStmts(s.finally, indent + IND, inlineMax));
				lines.push(`${indent}}`);
				break;
			}
			case 'repeat':
				lines.push(
					`${indent}repeat(${s.times}) { ${s.v} ->`,
					...renderStmts(s.body, indent + IND, inlineMax),
					`${indent}}`
				);
				break;
			case 'if': {
				const inner = oneLine(s.body, null, inlineMax);
				if (inner !== null && s.body.length === 1) lines.push(`${indent}if (${s.v} == ${s.eq}) ${inner}`);
				else
					lines.push(
						`${indent}if (${s.v} == ${s.eq}) {`,
						...renderStmts(s.body, indent + IND, inlineMax),
						`${indent}}`
					);
				break;
			}
			default:
				throw new Error(`render: ${s.k}`);
		}
	}
	return lines;
}

/** Statements whose value is `Unit`: the last statement of `main = runBlocking { ... }` must be one of them. */
const UNIT_LAST = new Set<Stmt['k']>([
	'say',
	'sayAwait',
	'sayState',
	'delay',
	'sleep',
	'yield',
	'ensureActive',
	'join',
	'joinAll',
	'cancel',
	'cancelAndJoin',
	'repeat'
]);

/** A block whose value is used (`coroutineScope`, `withContext`) must not end with an `if` without `else`. */
function checkBlocks(stmts: Stmt[]): void {
	for (const s of stmts) {
		if (s.k === 'scope' || s.k === 'withContext') {
			if (s.body.at(-1)?.k === 'if') throw new Error(`${s.k} ends with an if`);
			checkBlocks(s.body);
		} else if (s.k === 'launch' || s.k === 'repeat' || s.k === 'if') checkBlocks(s.body);
		else if (s.k === 'try') {
			checkBlocks(s.body);
			if (s.catch) checkBlocks(s.catch.body);
			if (s.finally) checkBlocks(s.finally);
		}
	}
}

/** The whole `Main.kt` of a program. */
export function renderCoroutines(program: CoProgram, inlineMax = 3): string {
	const last = program.main.at(-1);
	if (!last || !UNIT_LAST.has(last.k)) throw new Error('the last statement of main must be of type Unit');
	checkBlocks(program.main);
	const names = new Set<string>();
	collectReferences(program.main, names);
	for (const fn of program.funs) collectReferences(fn.body, names);
	referenced = names;
	const lines = ['import kotlinx.coroutines.*', ''];
	for (const fn of program.funs) {
		const inline = oneLine(fn.body, `return ${fn.returns}`, inlineMax);
		const head = `suspend fun ${fn.name}(): Int`;
		if (inline !== null && head.length + inline.length + 5 <= 100) lines.push(`${head} { ${inline} }`);
		else lines.push(`${head} {`, ...renderStmts(fn.body, IND, inlineMax), `${IND}return ${fn.returns}`, '}');
	}
	if (program.funs.length > 0) lines.push('');
	lines.push('fun main() = runBlocking {', ...renderStmts(program.main, IND, inlineMax), '}');
	return lines.join('\n');
}

// Instances.

/** What a class of a family builds: a program, or `null` when the draw does not fit (another draw is taken). */
export type ProgramMaker = (rng: Rng) => CoProgram | null;

const TRACE_STATEMENT =
	'Что напечатает программа на Kotlin (kotlinx.coroutines)? Введите вывод построчно, как он появится на экране.';
const TIMED_STATEMENT =
	'Что напечатает программа на Kotlin (kotlinx.coroutines)? Задержки настоящие, всё остальное выполняется мгновенно. ' +
	'Введите вывод построчно, как он появится на экране.';

function hasTiming(stmts: readonly Stmt[]): boolean {
	return stmts.some((s) => {
		if (s.k === 'delay' || s.k === 'sleep') return true;
		if (s.k === 'launch' || s.k === 'scope' || s.k === 'withContext' || s.k === 'repeat' || s.k === 'if')
			return hasTiming(s.body);
		if (s.k === 'try') return hasTiming(s.body) || hasTiming(s.catch?.body ?? []) || hasTiming(s.finally ?? []);
		return false;
	});
}

/**
 * A trace instance of a coroutine program: draws programs until one runs safely on the model within the line limits,
 * computes the answer on the model and every wrong solution as the output under its belief (a belief that gives the
 * right output, hangs or races on the instance does not apply to it); the JVM proves the answer.
 */
export function coroutineTrace(
	descriptor: FamilyDescriptor,
	input: GenerateInput,
	make: ProgramMaker,
	beliefs: Readonly<Record<string, Beliefs>>,
	options: {
		lines: readonly [number, number];
		/** Most statements a block shows on one line (`launch { a; b }`). */
		inlineMax?: number;
		/** The least gap between distinct deadlines. */
		gap?: number;
		/** Wrong solutions of which at least one must apply: the instance tests the mechanism of its class. */
		requires?: readonly string[];
	}
): Built {
	const { lines, inlineMax = 3, gap = MIN_GAP, requires = [] } = options;
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let attempt = 0; attempt < 1000; attempt += 1) {
		const program = make(rng);
		if (program === null) continue;
		const source = renderCoroutines(program, inlineMax);
		const count = source.split('\n').length;
		if (count < lines[0] || count > lines[1]) continue;
		let answer: string[];
		try {
			answer = runCoroutines(program, {}, gap);
		} catch (error) {
			if (error instanceof UnsafeProgram) continue;
			throw error;
		}
		if (answer.length === 0 || answer.some((line) => line.trim() === '')) continue;
		const wrong: Record<string, string[] | null> = {};
		for (const w of descriptor.wrongSolutions) {
			const belief = beliefs[w.id];
			if (!belief) throw new Error(`${descriptor.key}: no belief for the wrong solution ${w.id}`);
			let lines: string[] | null;
			try {
				lines = runCoroutines(program, belief, null);
			} catch (error) {
				if (!(error instanceof UnsafeProgram)) throw error;
				lines = null;
			}
			wrong[w.id] = lines === null || lines.join('\n') === answer.join('\n') ? null : lines;
		}
		if (requires.length > 0 && requires.every((id) => wrong[id] === null)) continue;
		const run = kotlinProgram(source);
		const toAnswer = (value: string[]) => ({ kind: 'sequence' as const, value });
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown:
					hasTiming(program.main) || program.funs.some((f) => hasTiming(f.body)) ? TIMED_STATEMENT : TRACE_STATEMENT,
				code: { language: 'kotlin', source }
			},
			answer: toAnswer(answer)
		});
		return {
			instance,
			reference: () => kotlinOutputProbe(run),
			wrong: () =>
				Object.fromEntries(
					descriptor.wrongSolutions.map(({ id }) => {
						const value = wrong[id] ?? null;
						return [id, value === null ? null : { kind: 'answer' as const, answer: toAnswer(value) }];
					})
				)
		};
	}
	throw new Error(`${descriptor.key}@${input.grade}/${input.classId}: no program fits on seed ${input.seed}`);
}
