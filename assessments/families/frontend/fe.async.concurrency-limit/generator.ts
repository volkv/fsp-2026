// Loading N resources of known durations: `await` in a loop against `Promise.all` and an unawaited `forEach`, a pool
// of K workers against batches of K; a level up, a pool that retries failed loads at the end of its queue, a scheduler
// with priorities and arrival moments, a pool that fails fast (with or without `AbortController`) and a pool with a
// per-host limit. The answer is the moment the code finishes and the order the loads complete.
//
// The generator simulates the shown code on a timeline (every load takes exactly its duration, the rest takes no
// time); the gate checks every answer against an independent event-queue simulation in Python. The data are drawn so
// that no two events of the right simulation fall on the same moment: the order never hinges on a tie.
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

/** A load: its resource, its duration; for retries, the outcome of every attempt in order. */
interface Task {
	name: string;
	ms: number;
	/** Retries: durations and outcomes of the attempts; Priority: arrival and priority; Hosts: host. */
	attempts?: { ms: number; ok: boolean }[];
	arrival?: number;
	priority?: number;
	host?: string;
	fails?: boolean;
}

type Phase = { kind: 'seq' | 'all' | 'each'; tasks: Task[] };

interface Params {
	kind: string;
	k: number;
	tasks: Task[];
	phases: Phase[];
	maxAttempts: number;
	/** Retries: the pause before attempt n + 1 is `backoff · n` ms. */
	backoff: number;
	abort: boolean;
}

/** One finished (or stopped) load. */
interface Finish {
	name: string;
	at: number;
}

/** A misconception of the shown code: a rule of the simulation. */
interface Rules {
	seqAsParallel: boolean;
	eachWaits: boolean;
	codeOrder: boolean;
	poolAsBatches: boolean;
	batchesAsPool: boolean;
	staticSplit: boolean;
	retryAtEnd: boolean;
	noBackoff: boolean;
	attemptsAsRetries: boolean;
	fifo: boolean;
	allAtStart: boolean;
	rejectStopsWorkers: boolean;
	abortLetsFinish: boolean;
	rejectAtEnd: boolean;
	ignoreHostLimit: boolean;
	headOfLine: boolean;
}

const RIGHT: Rules = {
	seqAsParallel: false,
	eachWaits: false,
	codeOrder: false,
	poolAsBatches: false,
	batchesAsPool: false,
	staticSplit: false,
	retryAtEnd: false,
	noBackoff: false,
	attemptsAsRetries: false,
	fifo: false,
	allAtStart: false,
	rejectStopsWorkers: false,
	abortLetsFinish: false,
	rejectAtEnd: false,
	ignoreHostLimit: false,
	headOfLine: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'seq-as-parallel': { seqAsParallel: true },
	'each-waits': { eachWaits: true },
	'code-order': { codeOrder: true },
	'pool-as-batches': { poolAsBatches: true },
	'batches-as-pool': { batchesAsPool: true },
	'static-split': { staticSplit: true },
	'retry-at-end': { retryAtEnd: true },
	'no-backoff': { noBackoff: true },
	'attempts-as-retries': { attemptsAsRetries: true },
	fifo: { fifo: true },
	'all-at-start': { allAtStart: true },
	'reject-stops-workers': { rejectStopsWorkers: true },
	'abort-lets-finish': { abortLetsFinish: true },
	'reject-at-end': { rejectAtEnd: true },
	'ignore-host-limit': { ignoreHostLimit: true },
	'head-of-line': { headOfLine: true }
};

/** The result of a simulation: the answer, and whether two events of it fell on the same moment. */
interface Outcome {
	answer: string;
	tie: boolean;
}

const hasTie = (moments: readonly number[]): boolean => new Set(moments).size !== moments.length;
const byTime = (list: readonly Finish[]): Finish[] => [...list].sort((a, b) => a.at - b.at);

// ---------------------------------------------------------------------------------------------------------------
// Simulations of the shown code.

/** Middle A: phases of a function — `for…of` with `await`, `await Promise.all(map)`, `forEach(async …)`. */
function phases(p: Params, r: Rules): Outcome {
	let t = 0;
	const finished: Finish[] = [];
	for (const phase of p.phases) {
		const kind =
			phase.kind === 'seq' && r.seqAsParallel ? 'all' : phase.kind === 'each' && r.eachWaits ? 'seq' : phase.kind;
		if (kind === 'seq') {
			for (const task of phase.tasks) {
				t += task.ms;
				finished.push({ name: task.name, at: t });
			}
		} else {
			for (const task of phase.tasks) finished.push({ name: task.name, at: t + task.ms });
			if (kind === 'all') t += Math.max(...phase.tasks.map((x) => x.ms));
		}
	}
	const order = r.codeOrder
		? p.phases.flatMap((ph) => ph.tasks.map((x) => x.name))
		: byTime(finished).map((f) => f.name);
	return { answer: [t, ...order].join(' '), tie: hasTie(finished.map((f) => f.at)) };
}

/** A pool of `k` workers over a shared queue: a worker that finishes takes the next item at once. */
function poolRun(tasks: readonly Task[], k: number, r: Rules): { total: number; finished: Finish[] } {
	if (r.poolAsBatches) return batchRun(tasks, k);
	if (r.staticSplit) {
		const finished: Finish[] = [];
		for (let w = 0; w < k; w += 1) {
			let t = 0;
			for (let i = w; i < tasks.length; i += k) {
				const task = tasks[i] as Task;
				t += task.ms;
				finished.push({ name: task.name, at: t });
			}
		}
		return { total: Math.max(...finished.map((f) => f.at)), finished };
	}
	const free = Array.from({ length: k }, () => 0);
	const finished: Finish[] = [];
	for (const task of tasks) {
		// The earliest free worker takes the next item; with distinct moments there is exactly one.
		let w = 0;
		for (let i = 1; i < free.length; i += 1) if ((free[i] ?? 0) < (free[w] ?? 0)) w = i;
		const end = (free[w] ?? 0) + task.ms;
		free[w] = end;
		finished.push({ name: task.name, at: end });
	}
	return { total: Math.max(...finished.map((f) => f.at)), finished };
}

/** Batches of `k`: `await Promise.all` of each slice in turn. */
function batchRun(tasks: readonly Task[], k: number): { total: number; finished: Finish[] } {
	let t = 0;
	const finished: Finish[] = [];
	for (let i = 0; i < tasks.length; i += k) {
		const batch = tasks.slice(i, i + k);
		for (const task of batch) finished.push({ name: task.name, at: t + task.ms });
		t += Math.max(...batch.map((x) => x.ms));
	}
	return { total: t, finished };
}

function pool(p: Params, r: Rules): Outcome {
	const run = poolRun(p.tasks, p.k, r);
	const order = r.codeOrder ? p.tasks.map((x) => x.name) : byTime(run.finished).map((f) => f.name);
	return { answer: [run.total, ...order].join(' '), tie: hasTie(run.finished.map((f) => f.at)) };
}

function batches(p: Params, r: Rules): Outcome {
	const run = r.batchesAsPool ? poolRun(p.tasks, p.k, RIGHT) : batchRun(p.tasks, p.k);
	const order = r.codeOrder ? p.tasks.map((x) => x.name) : byTime(run.finished).map((f) => f.name);
	return { answer: [run.total, ...order].join(' '), tie: hasTie(run.finished.map((f) => f.at)) };
}

function poolVsBatches(p: Params, r: Rules): Outcome {
	const a = poolRun(p.tasks, p.k, r);
	const b = r.batchesAsPool ? poolRun(p.tasks, p.k, RIGHT) : batchRun(p.tasks, p.k);
	return { answer: `${a.total} ${b.total}`, tie: hasTie(a.finished.map((f) => f.at)) };
}

/**
 * Senior A: a pool whose worker retries a failed load itself: it sleeps `backoff · attempt` ms and tries again, holding
 * its slot all the while; after `maxAttempts` failed attempts the resource goes to `failed`.
 */
function retries(p: Params, r: Rules): Outcome {
	const limit = r.attemptsAsRetries ? p.maxAttempts + 1 : p.maxAttempts;
	const attemptOf = (task: Task, n: number): { ms: number; ok: boolean } => {
		const list = task.attempts ?? [{ ms: task.ms, ok: true }];
		return list[Math.min(n, list.length) - 1] ?? { ms: task.ms, ok: true };
	};
	const done: Finish[] = [];
	const failed: Finish[] = [];
	if (r.retryAtEnd) {
		// The misconception: a failed attempt goes to the end of the queue at once and the worker takes the next item.
		const queue = p.tasks.map((task) => ({ task, n: 1 }));
		const free = Array.from({ length: p.k }, () => 0);
		while (queue.length > 0) {
			const { task, n } = queue.shift() as { task: Task; n: number };
			let w = 0;
			for (let i = 1; i < free.length; i += 1) if ((free[i] ?? 0) < (free[w] ?? 0)) w = i;
			const end = (free[w] ?? 0) + attemptOf(task, n).ms;
			free[w] = end;
			if (attemptOf(task, n).ok) done.push({ name: task.name, at: end });
			else if (n < limit) queue.push({ task, n: n + 1 });
			else failed.push({ name: task.name, at: end });
		}
	} else {
		const free = Array.from({ length: p.k }, () => 0);
		for (const task of p.tasks) {
			let w = 0;
			for (let i = 1; i < free.length; i += 1) if ((free[i] ?? 0) < (free[w] ?? 0)) w = i;
			let t = free[w] ?? 0;
			for (let n = 1; ; n += 1) {
				const attempt = attemptOf(task, n);
				t += attempt.ms;
				if (attempt.ok) {
					done.push({ name: task.name, at: t });
					break;
				}
				if (n >= limit) {
					failed.push({ name: task.name, at: t });
					break;
				}
				if (!r.noBackoff) t += p.backoff * n;
			}
			free[w] = t;
		}
	}
	const ends = [...done, ...failed].map((f) => f.at);
	const total = Math.max(...ends);
	const names = (list: readonly Finish[]): string[] => byTime(list).map((f) => f.name);
	return { answer: [total, ...names(done), '-', ...names(failed)].join(' '), tie: hasTie(ends) };
}

/**
 * Senior B: a scheduler with `k` slots; a task joins the queue at its arrival; a free slot takes the queued task with
 * the smallest priority number (ties — the earlier arrival).
 */
function priority(p: Params, r: Rules): Outcome {
	const pending = r.allAtStart
		? []
		: p.tasks
				.map((task, i) => ({ task, i }))
				.sort((a, b) => (a.task.arrival ?? 0) - (b.task.arrival ?? 0) || a.i - b.i);
	const queue: Task[] = r.allAtStart ? [...p.tasks] : [];
	const running: { task: Task; end: number }[] = [];
	const finished: Finish[] = [];
	const arrivals = new Set(p.tasks.map((x) => x.arrival ?? 0));
	let t = 0;
	const pump = (): void => {
		while (running.length < p.k && queue.length > 0) {
			let best = 0;
			if (!r.fifo) {
				for (let i = 1; i < queue.length; i += 1) {
					if (((queue[i] as Task).priority ?? 0) < ((queue[best] as Task).priority ?? 0)) best = i;
				}
			}
			const task = queue.splice(best, 1)[0] as Task;
			running.push({ task, end: t + task.ms });
		}
	};
	pump();
	while (running.length > 0 || pending.length > 0) {
		running.sort((a, b) => a.end - b.end);
		const nextEnd = running[0]?.end ?? Number.POSITIVE_INFINITY;
		const next = pending[0];
		if (next && (next.task.arrival ?? 0) < nextEnd) {
			// Every arrival is its own timer: the task is added and the slots are filled before the next one.
			pending.shift();
			t = next.task.arrival ?? 0;
			queue.push(next.task);
		} else {
			const cur = running.shift() as { task: Task; end: number };
			t = cur.end;
			finished.push({ name: cur.task.name, at: t });
		}
		pump();
	}
	const order = r.codeOrder ? p.tasks.map((x) => x.name) : finished.map((f) => f.name);
	const ends = finished.map((f) => f.at);
	return { answer: [t, ...order].join(' '), tie: hasTie(ends) || ends.some((e) => arrivals.has(e)) };
}

/**
 * Senior anchor: a pool that fails fast. The first failure rejects the `Promise.all` at once. Without an abort the
 * other workers go on taking items; with an `AbortController` the failing worker aborts the signal: running loads
 * reject at that moment and no worker takes another item.
 */
function failFast(p: Params, r: Rules): Outcome {
	const queue = [...p.tasks];
	const running: { task: Task; end: number }[] = [];
	const done: string[] = [];
	const moments: number[] = [];
	let rejectedAt: number | null = null;
	let aborted = false;
	let end = 0;
	const take = (at: number): void => {
		if (aborted || queue.length === 0) return;
		if (r.rejectStopsWorkers && rejectedAt !== null) return;
		const task = queue.shift() as Task;
		// Every scheduled end counts for ties, even of a load an abort cuts short.
		moments.push(at + task.ms);
		running.push({ task, end: at + task.ms });
	};
	for (let w = 0; w < p.k; w += 1) take(0);
	while (running.length > 0) {
		running.sort((a, b) => a.end - b.end);
		const cur = running.shift() as { task: Task; end: number };
		end = cur.end;
		if (cur.task.fails) {
			rejectedAt ??= cur.end;
			if (p.abort && !r.abortLetsFinish) {
				aborted = true;
				// Every running load rejects with AbortError now; those workers stop too.
				running.length = 0;
			} else if (p.abort) aborted = true;
			continue;
		}
		done.push(cur.task.name);
		take(cur.end);
	}
	const reject = r.rejectAtEnd ? end : (rejectedAt ?? end);
	return { answer: [reject, ...done, end].join(' '), tie: hasTie(moments) };
}

/** Senior X: a pool of `k` with at most one load per host: a free slot takes the first queued item whose host is idle. */
function hosts(p: Params, r: Rules): Outcome {
	const queue = [...p.tasks];
	const running: { task: Task; end: number }[] = [];
	const finished: Finish[] = [];
	const moments: number[] = [];
	const pump = (at: number): void => {
		for (;;) {
			if (running.length >= p.k) return;
			const busy = new Set(running.map((x) => x.task.host));
			const i = r.ignoreHostLimit
				? 0
				: r.headOfLine
					? busy.has(queue[0]?.host)
						? -1
						: 0
					: queue.findIndex((x) => !busy.has(x.host));
			if (i < 0 || queue.length === 0) return;
			const task = queue.splice(i, 1)[0] as Task;
			running.push({ task, end: at + task.ms });
		}
	};
	pump(0);
	let t = 0;
	while (running.length > 0) {
		running.sort((a, b) => a.end - b.end);
		const cur = running.shift() as { task: Task; end: number };
		t = cur.end;
		moments.push(t);
		finished.push({ name: cur.task.name, at: t });
		pump(t);
	}
	const order = r.codeOrder ? p.tasks.map((x) => x.name) : finished.map((f) => f.name);
	return { answer: [t, ...order].join(' '), tie: hasTie(moments) };
}

const SIMULATIONS: Record<string, (p: Params, r: Rules) => Outcome> = {
	phases,
	pool,
	batches,
	'pool-vs-batches': poolVsBatches,
	retries,
	priority,
	'fail-fast': failFast,
	hosts
};

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const msPick = (rng: Rng, min = 3, max = 25): number => rng.int(min, max) * 10;

function plainTasks(rng: Rng, count: number): Task[] {
	return Array.from({ length: count }, (_, i) => ({ name: NAMES[i] ?? `t${i}`, ms: msPick(rng) }));
}

function scenario(rng: Rng, classId: string): Params {
	const base: Params = { kind: classId, k: 1, tasks: [], phases: [], maxAttempts: 1, backoff: 0, abort: false };
	switch (classId) {
		case 'phases': {
			const counts = [rng.int(2, 3), rng.int(2, 3), rng.int(2, 3)];
			const tasks = plainTasks(
				rng,
				counts.reduce((s, c) => s + c, 0)
			);
			const kinds = rng.shuffle(['seq', 'all', 'each'] as const);
			let i = 0;
			const phasesList: Phase[] = kinds.map((kind, n) => {
				const slice = tasks.slice(i, i + (counts[n] ?? 2));
				i += counts[n] ?? 2;
				return { kind, tasks: slice };
			});
			return { ...base, tasks, phases: phasesList };
		}
		case 'pool':
		case 'batches':
		case 'pool-vs-batches':
			return { ...base, k: rng.int(2, 3), tasks: plainTasks(rng, rng.int(6, 7)) };
		case 'retries': {
			const maxAttempts = rng.int(2, 3);
			const tasks = plainTasks(rng, rng.int(5, 6)).map((task) => {
				const fails = rng.pick([0, 0, 1, 1, 2, 3]);
				const attempts = Array.from({ length: fails + 1 }, (_, i) => ({ ms: msPick(rng, 2, 15), ok: i === fails }));
				return { ...task, ms: attempts[0]?.ms ?? task.ms, attempts };
			});
			return { ...base, k: rng.int(2, 3), tasks, maxAttempts, backoff: rng.int(2, 6) * 10 };
		}
		case 'priority': {
			const count = rng.int(6, 7);
			const later = rng.sample(
				Array.from({ length: 30 }, (_, i) => i * 10 + 15),
				count - 2
			);
			const tasks = plainTasks(rng, count).map((task, i) => ({
				...task,
				arrival: i < 2 ? 0 : (later[i - 2] ?? 15),
				priority: rng.int(1, 3)
			}));
			return { ...base, k: 2, tasks };
		}
		case 'fail-fast': {
			const tasks = plainTasks(rng, rng.int(6, 7));
			for (const i of rng.sample([1, 2, 3, 4], rng.int(1, 2))) {
				const task = tasks[i];
				if (task) task.fails = true;
			}
			return { ...base, k: rng.int(2, 3), tasks, abort: rng.bool() };
		}
		default: {
			const hostNames = rng.sample(['cdn', 'api', 'img', 'auth'], rng.int(2, 3));
			const tasks = plainTasks(rng, rng.int(6, 7)).map((task) => ({ ...task, host: rng.pick(hostNames) }));
			return { ...base, k: rng.int(2, 3), tasks };
		}
	}
}

/** The simulation of a class by its id. */
const SIMULATION_OF: Record<string, string> = {
	'loop-forms': 'phases',
	pool: 'pool',
	batches: 'batches',
	'pool-vs-batches': 'pool-vs-batches',
	retry: 'retries',
	priority: 'priority',
	'fail-fast': 'fail-fast',
	'per-host': 'hosts'
};

/** The misconceptions every instance of a class must expose; a fail-fast pool depends on whether it aborts. */
const REQUIRED: Record<string, (p: Params) => string[]> = {
	'middle/loop-forms': () => ['seq-as-parallel', 'each-waits'],
	'middle/pool': () => ['pool-as-batches', 'static-split'],
	'middle/batches': () => ['batches-as-pool', 'code-order'],
	'middle/pool-vs-batches': () => ['pool-as-batches', 'batches-as-pool'],
	'senior/retry': () => ['retry-at-end', 'no-backoff'],
	'senior/priority': () => ['fifo', 'all-at-start'],
	'senior/fail-fast': (p) => (p.abort ? ['abort-lets-finish'] : ['reject-stops-workers', 'reject-at-end']),
	'senior/per-host': () => ['ignore-host-limit', 'head-of-line']
};

/** Fixed scenarios for a seed whose draws never fit (never reached in the gate's seeds, kept for totality). */
function fixedScenario(rng: Rng, classId: string): Params {
	const names = rng.shuffle([...NAMES]);
	const t = (i: number, ms: number, extra: Partial<Task> = {}): Task => ({ name: names[i] ?? `t${i}`, ms, ...extra });
	const base: Params = {
		kind: SIMULATION_OF[classId] ?? classId,
		k: 2,
		tasks: [],
		phases: [],
		maxAttempts: 2,
		backoff: 30,
		abort: false
	};
	switch (classId) {
		case 'loop-forms':
			return {
				...base,
				tasks: [t(0, 70), t(1, 40), t(2, 130), t(3, 50), t(4, 90), t(5, 20)],
				phases: [
					{ kind: 'seq', tasks: [t(0, 70), t(1, 40)] },
					{ kind: 'each', tasks: [t(2, 130), t(3, 50)] },
					{ kind: 'all', tasks: [t(4, 90), t(5, 20)] }
				]
			};
		case 'retry':
			return {
				...base,
				tasks: [
					t(0, 60, {
						attempts: [
							{ ms: 60, ok: false },
							{ ms: 30, ok: true }
						]
					}),
					t(1, 110, { attempts: [{ ms: 110, ok: true }] }),
					t(2, 40, {
						attempts: [
							{ ms: 40, ok: false },
							{ ms: 90, ok: false },
							{ ms: 20, ok: true }
						]
					}),
					t(3, 70, { attempts: [{ ms: 70, ok: true }] }),
					t(4, 150, { attempts: [{ ms: 150, ok: true }] })
				]
			};
		case 'priority':
			return {
				...base,
				tasks: [
					t(0, 100, { arrival: 0, priority: 3 }),
					t(1, 60, { arrival: 0, priority: 2 }),
					t(2, 80, { arrival: 25, priority: 1 }),
					t(3, 30, { arrival: 45, priority: 3 }),
					t(4, 50, { arrival: 75, priority: 1 }),
					t(5, 90, { arrival: 115, priority: 2 })
				]
			};
		case 'fail-fast':
			return {
				...base,
				abort: rng.bool(),
				tasks: [t(0, 50), t(1, 120), t(2, 80, { fails: true }), t(3, 40), t(4, 90), t(5, 30)]
			};
		case 'per-host':
			return {
				...base,
				tasks: [
					t(0, 50, { host: 'api' }),
					t(1, 80, { host: 'api' }),
					t(2, 120, { host: 'cdn' }),
					t(3, 30, { host: 'img' }),
					t(4, 70, { host: 'api' }),
					t(5, 40, { host: 'cdn' })
				]
			};
		default:
			return { ...base, tasks: [t(0, 70), t(1, 40), t(2, 130), t(3, 50), t(4, 90), t(5, 20), t(6, 160)] };
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const LOAD_NOTE =
	'Считаем, что `load(url)` выполняется ровно указанное время, а весь остальной код — мгновенно; время отсчитывается в миллисекундах от вызова функции.';

function taskTable(p: Params, extra: 'none' | 'attempts' | 'priority' | 'host'): string {
	const head =
		extra === 'attempts'
			? '| Ресурс | Попытки по порядку |\n|---|---|'
			: extra === 'priority'
				? '| Ресурс | Длительность, мс | Появляется, мс | Приоритет |\n|---|---|---|---|'
				: extra === 'host'
					? '| Ресурс | Хост | Длительность, мс |\n|---|---|---|'
					: '| Ресурс | Длительность, мс |\n|---|---|';
	const rows = p.tasks.map((x) =>
		extra === 'attempts'
			? `| \`${x.name}\` | ${(x.attempts ?? []).map((a) => `${a.ms} мс, ${a.ok ? 'успех' : 'ошибка'}`).join('; ')} |`
			: extra === 'priority'
				? `| \`${x.name}\` | ${x.ms} | ${x.arrival ?? 0} | ${x.priority ?? 0} |`
				: extra === 'host'
					? `| \`${x.name}\` | ${x.host ?? ''} | ${x.ms} |`
					: `| \`${x.name}\`${x.fails ? ' (ошибка)' : ''} | ${x.ms} |`
	);
	return [head, ...rows].join('\n');
}

const list = (tasks: readonly Task[]): string => `[${tasks.map((x) => `'${x.name}'`).join(', ')}]`;

const POOL_CODE = [
	'async function pool(urls, k) {',
	'  const queue = [...urls];',
	'  const done = [];',
	'  async function worker() {',
	'    while (queue.length > 0) {',
	'      const url = queue.shift();',
	'      await load(url);',
	'      done.push(url);',
	'    }',
	'  }',
	'  await Promise.all(Array.from({ length: k }, worker));',
	'  return done;',
	'}'
];

const BATCH_CODE = [
	'async function batches(urls, k) {',
	'  const done = [];',
	'  for (let i = 0; i < urls.length; i += k) {',
	'    const batch = urls.slice(i, i + k);',
	'    await Promise.all(',
	'      batch.map(async (url) => {',
	'        await load(url);',
	'        done.push(url);',
	'      })',
	'    );',
	'  }',
	'  return done;',
	'}'
];

const ORDER_RULE =
	'Введите через пробел: момент в миллисекундах, когда завершится промис функции, затем имена ресурсов в порядке завершения их загрузки (все, включая завершившиеся позже функции).';

function describe(p: Params, classId: string): string {
	const code = (lines: string[]): string => ['```js', ...lines, '```'].join('\n');
	switch (classId) {
		case 'loop-forms': {
			const body = p.phases.flatMap((ph) => {
				if (ph.kind === 'seq') return [`  for (const url of ${list(ph.tasks)}) await load(url);`];
				if (ph.kind === 'all') return [`  await Promise.all(${list(ph.tasks)}.map(load));`];
				return [`  ${list(ph.tasks)}.forEach(async (url) => {`, '    await load(url);', '  });'];
			});
			return [
				'Функция загружает ресурсы тремя способами:',
				'',
				code(['async function run() {', ...body, '}']),
				'',
				`Длительности загрузок:\n\n${taskTable(p, 'none')}`,
				'',
				LOAD_NOTE,
				'',
				`${ORDER_RULE} Например: \`230 b a c\`.`
			].join('\n');
		}
		case 'pool':
			return [
				`Пул из ${p.k} воркеров загружает ресурсы \`pool(${list(p.tasks)}, ${p.k})\`:`,
				'',
				code(POOL_CODE),
				'',
				taskTable(p, 'none'),
				'',
				LOAD_NOTE,
				'',
				'Введите через пробел: момент, когда завершится `pool`, и содержимое `done` по порядку. Например: `230 b a c`.'
			].join('\n');
		case 'batches':
			return [
				`Ресурсы загружаются пачками по ${p.k}: \`batches(${list(p.tasks)}, ${p.k})\`.`,
				'',
				code(BATCH_CODE),
				'',
				taskTable(p, 'none'),
				'',
				LOAD_NOTE,
				'',
				'Введите через пробел: момент, когда завершится `batches`, и содержимое `done` по порядку. Например: `230 b a c`.'
			].join('\n');
		case 'pool-vs-batches':
			return [
				`Одни и те же ресурсы \`${list(p.tasks)}\` загружают двумя способами с лимитом ${p.k}: пулом воркеров и пачками.`,
				'',
				code([...POOL_CODE, '', ...BATCH_CODE]),
				'',
				taskTable(p, 'none'),
				'',
				LOAD_NOTE,
				'',
				`Введите через пробел два числа: за сколько миллисекунд завершится \`pool(urls, ${p.k})\` и за сколько — \`batches(urls, ${p.k})\`. Например: \`230 310\`.`
			].join('\n');
		case 'retry':
			return [
				`Пул из ${p.k} воркеров с повтором упавших загрузок: \`maxAttempts = ${p.maxAttempts}\` (попыток всего, включая первую), пауза перед повтором — \`${p.backoff} · attempt\` мс.`,
				'',
				code([
					'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
					'',
					'async function poolWithRetry(urls, k, maxAttempts, backoff) {',
					'  const queue = [...urls];',
					'  const done = [];',
					'  const failed = [];',
					'  async function worker() {',
					'    while (queue.length > 0) {',
					'      const url = queue.shift();',
					'      for (let attempt = 1; ; attempt++) {',
					'        try {',
					'          await load(url, attempt);',
					'          done.push(url);',
					'          break;',
					'        } catch {',
					'          if (attempt === maxAttempts) {',
					'            failed.push(url);',
					'            break;',
					'          }',
					'          await sleep(backoff * attempt);',
					'        }',
					'      }',
					'    }',
					'  }',
					'  await Promise.all(Array.from({ length: k }, worker));',
					'  return { done, failed };',
					'}'
				]),
				'',
				`Вызов: \`poolWithRetry(${list(p.tasks)}, ${p.k}, ${p.maxAttempts}, ${p.backoff})\`. Попытки загрузки каждого ресурса по порядку (попытки сверх \`maxAttempts\` не выполняются):`,
				'',
				taskTable(p, 'attempts'),
				'',
				'Считаем, что попытка `load` длится ровно указанное время и затем выполняется или отклоняется, `sleep` — ровно свою паузу, а весь остальной код — мгновенно.',
				'',
				'Введите через пробел: момент завершения функции, содержимое `done` по порядку, знак `-` и содержимое `failed` по порядку (если `failed` пуст — ничего после `-`). Например: `310 b a c - d`.'
			].join('\n');
		case 'priority':
			return [
				`Планировщик загрузок с ${p.k} слотами и приоритетами (меньше число — важнее):`,
				'',
				code([
					'class Scheduler {',
					'  constructor(slots) {',
					'    this.slots = slots;',
					'    this.active = 0;',
					'    this.queue = [];',
					'    this.done = [];',
					'  }',
					'  add(task) {',
					'    this.queue.push(task);',
					'    this.pump();',
					'  }',
					'  pump() {',
					'    while (this.active < this.slots && this.queue.length > 0) {',
					'      let best = 0;',
					'      for (let i = 1; i < this.queue.length; i++) {',
					'        if (this.queue[i].priority < this.queue[best].priority) best = i;',
					'      }',
					'      const [task] = this.queue.splice(best, 1);',
					'      this.active++;',
					'      load(task.url).then(() => {',
					'        this.active--;',
					'        this.done.push(task.url);',
					'        this.pump();',
					'      });',
					'    }',
					'  }',
					'}',
					'',
					`const s = new Scheduler(${p.k});`,
					'for (const task of tasks) setTimeout(() => s.add(task), task.at);'
				]),
				'',
				'Задачи `tasks` (поле `at` — момент появления):',
				'',
				taskTable(p, 'priority'),
				'',
				'Считаем, что `load` выполняется ровно указанное время, а весь остальной код — мгновенно; задачи с одинаковым `at` добавляются в порядке таблицы.',
				'',
				'Введите через пробел: момент, когда завершится последняя загрузка, и содержимое `s.done` по порядку. Например: `310 b a c`.'
			].join('\n');
		case 'fail-fast':
			return [
				`Пул из ${p.k} воркеров должен прерваться на первой ошибке${p.abort ? ' и отменить остальные загрузки' : ''}:`,
				'',
				code(
					p.abort
						? [
								'async function loadAllOrFail(urls, k) {',
								'  const controller = new AbortController();',
								'  const queue = [...urls];',
								'  const done = [];',
								'  async function worker() {',
								'    while (queue.length > 0 && !controller.signal.aborted) {',
								'      const url = queue.shift();',
								'      try {',
								'        await load(url, controller.signal);',
								'      } catch (error) {',
								'        controller.abort();',
								'        throw error;',
								'      }',
								'      done.push(url);',
								'    }',
								'  }',
								'  await Promise.all(Array.from({ length: k }, worker));',
								'  return done;',
								'}'
							]
						: [
								'async function loadAllOrFail(urls, k) {',
								'  const queue = [...urls];',
								'  const done = [];',
								'  async function worker() {',
								'    while (queue.length > 0) {',
								'      const url = queue.shift();',
								'      await load(url);',
								'      done.push(url);',
								'    }',
								'  }',
								'  await Promise.all(Array.from({ length: k }, worker));',
								'  return done;',
								'}'
							]
				),
				'',
				`Вызов: \`loadAllOrFail(${list(p.tasks)}, ${p.k})\`. Загрузки, помеченные «ошибка», отклоняются по истечении своей длительности.`,
				'',
				taskTable(p, 'none'),
				'',
				`Считаем, что \`load\` длится ровно указанное время, а весь остальной код — мгновенно.${p.abort ? ' `load` слушает переданный сигнал: при отмене незавершённая загрузка сразу отклоняется с `AbortError`.' : ''}`,
				'',
				'Введите через пробел: момент, когда отклонится промис `loadAllOrFail`, затем ресурсы в порядке, в каком они попали в `done` (в том числе после отклонения), затем момент, когда закончится или будет отменена последняя загрузка. Например: `90 b a 160`.'
			].join('\n');
		default:
			return [
				`Пул из ${p.k} слотов, но к одному хосту одновременно идёт не больше одного запроса:`,
				'',
				code([
					'async function loadByHost(items, k) {',
					'  const queue = [...items];',
					'  const busy = new Set();',
					'  const done = [];',
					'  let active = 0;',
					'  return new Promise((resolve) => {',
					'    function pump() {',
					'      if (queue.length === 0 && active === 0) return resolve(done);',
					'      while (active < k) {',
					'        const i = queue.findIndex((item) => !busy.has(item.host));',
					'        if (i === -1) return;',
					'        const [item] = queue.splice(i, 1);',
					'        busy.add(item.host);',
					'        active++;',
					'        load(item.url).then(() => {',
					'          busy.delete(item.host);',
					'          active--;',
					'          done.push(item.url);',
					'          pump();',
					'        });',
					'      }',
					'    }',
					'    pump();',
					'  });',
					'}'
				]),
				'',
				`Очередь \`items\` в порядке таблицы, \`k = ${p.k}\`:`,
				'',
				taskTable(p, 'host'),
				'',
				'Считаем, что `load` выполняется ровно указанное время, а весь остальной код — мгновенно.',
				'',
				'Введите через пробел: момент завершения `loadByHost` и содержимое `done` по порядку. Например: `310 b a c`.'
			].join('\n');
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference: an event queue in Python over the same data.

const PYTHON_REFERENCE = `import heapq
import json

p = json.loads(input())
kind = p["kind"]
tasks = p["tasks"]


def run_phases():
    clock = 0
    events = []
    for ph in p["phases"]:
        if ph["kind"] == "seq":
            for x in ph["tasks"]:
                clock += x["ms"]
                events.append((clock, x["name"]))
        else:
            for x in ph["tasks"]:
                events.append((clock + x["ms"], x["name"]))
            if ph["kind"] == "all":
                clock = max(clock + x["ms"] for x in ph["tasks"])
    return [str(clock)] + [name for _, name in sorted(events)]


def run_pool(k):
    heap = []
    waiting = list(tasks)
    order = []
    for w in range(k):
        if waiting:
            x = waiting.pop(0)
            heapq.heappush(heap, (x["ms"], w, x["name"]))
    end = 0
    while heap:
        end, w, name = heapq.heappop(heap)
        order.append(name)
        if waiting:
            x = waiting.pop(0)
            heapq.heappush(heap, (end + x["ms"], w, x["name"]))
    return end, order


def run_batches(k):
    clock = 0
    order = []
    for i in range(0, len(tasks), k):
        chunk = tasks[i:i + k]
        order += [x["name"] for x in sorted(chunk, key=lambda x: x["ms"])]
        clock += max(x["ms"] for x in chunk)
    return clock, order


def run_retry():
    k = p["k"]
    limit = p["maxAttempts"]
    waiting = list(tasks)
    heap = [(0, w) for w in range(k)]
    done = []
    failed = []
    finish = 0
    while waiting:
        now, w = heapq.heappop(heap)
        x = waiting.pop(0)
        n = 1
        while True:
            a = x["attempts"][min(n, len(x["attempts"])) - 1]
            now += a["ms"]
            if a["ok"]:
                done.append((now, x["name"]))
                break
            if n == limit:
                failed.append((now, x["name"]))
                break
            now += p["backoff"] * n
            n += 1
        finish = max(finish, now)
        heapq.heappush(heap, (now, w))
    return [str(finish)] + [n for _, n in sorted(done)] + ["-"] + [n for _, n in sorted(failed)]


def run_priority():
    k = p["k"]
    arrivals = sorted(range(len(tasks)), key=lambda i: (tasks[i]["arrival"], i))
    ready = []
    heap = []
    done = []
    clock = 0
    counter = 0
    while arrivals or heap:
        if arrivals and (not heap or tasks[arrivals[0]]["arrival"] < heap[0][0]):
            x = tasks[arrivals.pop(0)]
            clock = x["arrival"]
            ready.append(x)
        else:
            clock, _, name = heapq.heappop(heap)
            done.append(name)
        while len(heap) < k and ready:
            best = min(range(len(ready)), key=lambda j: (ready[j]["priority"], j))
            x = ready.pop(best)
            counter += 1
            heapq.heappush(heap, (clock + x["ms"], counter, x["name"]))
    return [str(clock)] + done


def run_fail_fast():
    k = p["k"]
    waiting = list(tasks)
    heap = []
    done = []
    rejected = None
    stopped = False
    end = 0
    for w in range(k):
        if waiting:
            x = waiting.pop(0)
            heapq.heappush(heap, (x["ms"], w, x))
    while heap:
        end, w, x = heapq.heappop(heap)
        if x.get("fails"):
            if rejected is None:
                rejected = end
            if p["abort"]:
                stopped = True
                heap = []
            continue
        done.append(x["name"])
        if waiting and not stopped:
            y = waiting.pop(0)
            heapq.heappush(heap, (end + y["ms"], w, y))
    return [str(rejected if rejected is not None else end)] + done + [str(end)]


def run_hosts():
    k = p["k"]
    waiting = list(tasks)
    heap = []
    done = []
    clock = 0

    def fill(now):
        while len(heap) < k:
            busy = {h for _, _, h, _ in heap}
            pick = next((j for j, x in enumerate(waiting) if x["host"] not in busy), None)
            if pick is None:
                return
            x = waiting.pop(pick)
            heapq.heappush(heap, (now + x["ms"], x["name"], x["host"], x))

    fill(0)
    while heap:
        clock, name, _, _ = heapq.heappop(heap)
        done.append(name)
        fill(clock)
    return [str(clock)] + done


if kind == "phases":
    out = run_phases()
elif kind == "pool":
    total, order = run_pool(p["k"])
    out = [str(total)] + order
elif kind == "batches":
    total, order = run_batches(p["k"])
    out = [str(total)] + order
elif kind == "pool-vs-batches":
    out = [str(run_pool(p["k"])[0]), str(run_batches(p["k"])[0])]
elif kind == "retries":
    out = run_retry()
elif kind == "priority":
    out = run_priority()
elif kind == "fail-fast":
    out = run_fail_fast()
else:
    out = run_hosts()
print(" ".join(out))
`;

interface Candidate {
	p: Params;
	answer: string;
	wrong: Record<string, string | null>;
}

function candidate(p: Params, simulate: (p: Params, r: Rules) => Outcome): Candidate | null {
	const right = simulate(p, RIGHT);
	if (right.tie) return null;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = simulate(p, { ...RIGHT, ...change }).answer;
			return [id, value === right.answer ? null : value];
		})
	);
	return { p, answer: right.answer, wrong };
}

/** A fail-fast pool completes at least two loads, so the answer is more than the moment of the failure. */
function substantial(c: Candidate, classId: string): boolean {
	return classId !== 'fail-fast' || c.answer.split(' ').length >= 4;
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const kind = SIMULATION_OF[input.classId];
	const simulate = kind === undefined ? undefined : SIMULATIONS[kind];
	if (kind === undefined || simulate === undefined)
		throw new Error(`${descriptor.key}: no simulation for ${input.classId}`);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? (() => []);
	let chosen: Candidate | null = null;
	for (let tries = 0; tries < 300 && chosen === null; tries += 1) {
		const c = candidate({ ...scenario(rng, kind), kind }, simulate);
		if (c && required(c.p).every((id) => c.wrong[id] !== null) && substantial(c, input.classId)) chosen = c;
	}
	chosen ??= candidate(fixedScenario(rng, input.classId), simulate);
	if (chosen === null) throw new Error(`${descriptor.key}: the fixed scenario of ${input.classId} has a tie`);
	const c = chosen;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(c.p, input.classId), code: null },
		answer: { kind: 'tokens', value: c.answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(c.p) }),
		wrong: () =>
			Object.fromEntries(
				Object.entries(c.wrong).map(([id, value]) => [
					id,
					value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
