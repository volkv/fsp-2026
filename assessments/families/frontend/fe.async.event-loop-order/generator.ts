// The order of output of a program with microtasks and timers: synchronous code first, then every microtask
// (`Promise.then`, `queueMicrotask`) in the order they were queued, then the timers by due moment; a level up,
// microtasks that queue microtasks, microtasks between two timers due at once, timers set from a microtask or a timer,
// equal delays in the order of scheduling rather than of the text.
//
// The generator models the job queue of ECMAScript and the timers of Node (a delay of 0 is 1 ms; timers due at the
// same moment fire in the order they were set; the microtask queue drains after every timer) for the constructs it
// emits; the gate runs every shown program with real Node and compares the output.
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

type Stmt =
	| { k: 'log'; label: string }
	| { k: 'micro'; body: Stmt[] }
	/** `Promise.resolve().then(...).then(...)`: one callback per link. */
	| { k: 'chain'; links: Stmt[][] }
	/** `id` — the position of the call in the text, in reading order. */
	| { k: 'timeout'; ms: number; body: Stmt[]; id: number };

function printCallback(body: readonly Stmt[], indent: string): string {
	const only = body.length === 1 ? body[0] : undefined;
	if (only?.k === 'log') return `() => ${printStmt(only, '').trimEnd().replace(/;$/, '')}`;
	return `() => {\n${body.map((s) => printStmt(s, `${indent}  `)).join('')}${indent}}`;
}

function printStmt(s: Stmt, indent: string): string {
	switch (s.k) {
		case 'log':
			return `${indent}console.log('${s.label}');\n`;
		case 'micro':
			return `${indent}queueMicrotask(${printCallback(s.body, indent)});\n`;
		case 'timeout':
			return `${indent}setTimeout(${printCallback(s.body, indent)}, ${s.ms});\n`;
		case 'chain': {
			if (s.links.length === 1) return `${indent}Promise.resolve().then(${printCallback(s.links[0] ?? [], indent)});\n`;
			const links = s.links.map((l) => `${indent}  .then(${printCallback(l, `${indent}  `)})`);
			return `${indent}Promise.resolve()\n${links.join('\n')};\n`;
		}
	}
}

/** Numbers the timers in reading order (the order of the text). */
function numberTimers(stmts: readonly Stmt[]): void {
	let next = 0;
	const visit = (list: readonly Stmt[]): void => {
		for (const s of list) {
			if (s.k === 'timeout') {
				s.id = next++;
				visit(s.body);
			} else if (s.k === 'micro') visit(s.body);
			else if (s.k === 'chain') s.links.forEach(visit);
		}
	};
	visit(stmts);
}

// ---------------------------------------------------------------------------------------------------------------
// The model.

/** A run the model does not cover reliably (timers due too close together): the program is drawn again. */
class Unsupported extends Error {}

/** The misconceptions as switches of the model; all off is JavaScript. */
interface Rules {
	syncCallbacks: boolean;
	singleQueue: boolean;
	timersInCodeOrder: boolean;
	thenFirst: boolean;
	chainRunsThrough: boolean;
	microNextTick: boolean;
	timerBatch: boolean;
	nestedFromStart: boolean;
	textOrder: boolean;
}

const RIGHT: Rules = {
	syncCallbacks: false,
	singleQueue: false,
	timersInCodeOrder: false,
	thenFirst: false,
	chainRunsThrough: false,
	microNextTick: false,
	timerBatch: false,
	nestedFromStart: false,
	textOrder: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'sync-callbacks': { syncCallbacks: true },
	'single-queue': { singleQueue: true },
	'timers-in-code-order': { timersInCodeOrder: true },
	'then-first': { thenFirst: true },
	'chain-runs-through': { chainRunsThrough: true },
	'micro-next-tick': { microNextTick: true },
	'timer-batch': { timerBatch: true },
	'nested-from-start': { nestedFromStart: true },
	'same-delay-text-order': { textOrder: true }
};

/**
 * Real timers keep the model's order only with room for a stalled process (a loaded machine can pause it for tens of
 * milliseconds anywhere): distinct due moments at least this far apart…
 */
const TIMER_MARGIN_MS = 40;
/** …and further when a timer set later must fire earlier: a pause before it is set pushes it back by the whole pause. */
const INVERTED_MARGIN_MS = 150;
const MAX_STEPS = 500;

interface Timer {
	due: number;
	delay: number;
	at: number;
	seq: number;
	id: number;
	run: () => void;
}

interface Job {
	promise: boolean;
	run: () => void;
}

class Machine {
	readonly out: string[] = [];
	readonly #rules: Rules;
	#jobs: Job[] = [];
	readonly #timers: Timer[] = [];
	readonly #scheduled: Timer[] = [];
	#now = 0;
	#seq = 0;
	#steps = 0;

	constructor(rules: Rules) {
		this.#rules = rules;
	}

	run(main: readonly Stmt[]): string[] {
		this.#block(main, false);
		this.#checkpoint();
		while (this.#timers.length > 0 || this.#jobs.length > 0) {
			const timer = this.#nextTimer();
			if (timer) {
				this.#now = Math.max(this.#now, timer.due);
				timer.run();
				const following = this.#peekTimer();
				if (this.#rules.timerBatch && following && following.due <= this.#now) continue;
			}
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

	#order(a: Timer, b: Timer): number {
		if (this.#rules.timersInCodeOrder) return a.seq - b.seq;
		return a.due - b.due || (this.#rules.textOrder ? a.id - b.id : a.seq - b.seq);
	}

	#peekTimer(): Timer | undefined {
		return [...this.#timers].sort((a, b) => this.#order(a, b))[0];
	}

	#nextTimer(): Timer | undefined {
		const timer = this.#peekTimer();
		if (timer) this.#timers.splice(this.#timers.indexOf(timer), 1);
		return timer;
	}

	#setTimeout(ms: number, id: number, run: () => void, nested: boolean): void {
		// Node runs a zero delay as 1 ms.
		const delay = Math.max(1, ms);
		const at = nested && this.#rules.nestedFromStart ? 0 : this.#now;
		const timer: Timer = { due: at + delay, delay, at: this.#now, seq: this.#seq++, id, run };
		this.#timers.push(timer);
		this.#scheduled.push(timer);
	}

	#enqueue(job: Job): void {
		if (this.#rules.syncCallbacks) job.run();
		else if (this.#rules.singleQueue) this.#setTimeout(0, -1, job.run, false);
		else this.#jobs.push(job);
	}

	#checkpoint(): void {
		const take = (): Job | undefined => {
			if (!this.#rules.thenFirst) return this.#jobs.shift();
			const i = this.#jobs.findIndex((j) => j.promise);
			return i === -1 ? this.#jobs.shift() : this.#jobs.splice(i, 1)[0];
		};
		if (this.#rules.microNextTick) {
			// Only the microtasks queued before the checkpoint began; the rest wait for the next one.
			const batch = this.#jobs;
			this.#jobs = [];
			for (const job of batch) this.#step(job);
			return;
		}
		for (let job = take(); job; job = take()) this.#step(job);
	}

	#step(job: Job): void {
		if ((this.#steps += 1) > MAX_STEPS) throw new Unsupported('runaway jobs');
		job.run();
	}

	#chain(links: readonly Stmt[][], from: number): void {
		const link = links[from];
		if (!link) return;
		this.#enqueue({
			promise: true,
			run: () => {
				this.#block(link, true);
				// The promise of this link is fulfilled: the reaction of the next link is queued.
				if (this.#rules.chainRunsThrough) this.#runChainNow(links, from + 1);
				else this.#chain(links, from + 1);
			}
		});
	}

	#runChainNow(links: readonly Stmt[][], from: number): void {
		for (let i = from; i < links.length; i += 1) this.#block(links[i] ?? [], true);
	}

	#block(stmts: readonly Stmt[], nested: boolean): void {
		for (const s of stmts) {
			switch (s.k) {
				case 'log':
					this.out.push(s.label);
					break;
				case 'micro':
					this.#enqueue({
						promise: false,
						run: () => {
							this.#block(s.body, true);
						}
					});
					break;
				case 'chain':
					this.#chain(s.links, 0);
					break;
				case 'timeout':
					this.#setTimeout(
						s.ms,
						s.id,
						() => {
							this.#block(s.body, true);
						},
						nested
					);
					break;
			}
		}
	}
}

function execute(main: readonly Stmt[], rules: Rules, strict: boolean): string[] | null {
	try {
		const m = new Machine(rules);
		const out = m.run(main);
		if (strict && !m.timersAreRobust()) return null;
		return out;
	} catch (e) {
		if (e instanceof Unsupported) return null;
		throw e;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Programs of the classes.

const LABELS = [
	'alpha',
	'bravo',
	'delta',
	'echo',
	'golf',
	'hotel',
	'kilo',
	'lima',
	'mike',
	'oscar',
	'papa',
	'romeo',
	'sierra',
	'tango',
	'victor',
	'zulu',
	'amber',
	'coral',
	'ivory',
	'olive'
] as const;

/** Distinct labels in drawing order. */
class Labels {
	readonly #pool: string[];
	constructor(rng: Rng) {
		this.#pool = rng.shuffle(LABELS);
	}
	next(): Stmt {
		const label = this.#pool.shift();
		if (!label) throw new Error('labels exhausted');
		return { k: 'log', label };
	}
}

const timeout = (ms: number, body: Stmt[]): Stmt => ({ k: 'timeout', ms, body, id: 0 });
const micro = (body: Stmt[]): Stmt => ({ k: 'micro', body });
const chain = (...links: Stmt[][]): Stmt => ({ k: 'chain', links });

/** A microtask of either kind with the given body. */
function anyMicro(rng: Rng, body: Stmt[]): Stmt {
	return rng.bool() ? micro(body) : chain(body);
}

/** Intern A: synchronous logs, microtasks and zero-delay timers in a shuffled order. */
function microVsTimer(rng: Rng): Stmt[] {
	const l = new Labels(rng);
	const stmts: Stmt[] = [];
	for (let i = rng.int(2, 3); i > 0; i -= 1) stmts.push(l.next());
	for (let i = rng.int(2, 3); i > 0; i -= 1) stmts.push(anyMicro(rng, [l.next()]));
	for (let i = rng.int(1, 2); i > 0; i -= 1) stmts.push(timeout(0, [l.next()]));
	return rng.shuffle(stmts);
}

/** Intern B: timers with different delays written out of order, a few synchronous logs. */
function timerDelays(rng: Rng): Stmt[] {
	const l = new Labels(rng);
	const delays = rng.sample([0, 150, 300, 450], rng.int(3, 4));
	const stmts: Stmt[] = delays.map((ms) => timeout(ms, [l.next()]));
	for (let i = rng.int(1, 2); i > 0; i -= 1) stmts.push(l.next());
	if (rng.bool(0.4)) stmts.push(anyMicro(rng, [l.next()]));
	return rng.shuffle(stmts);
}

/** Anchor intern: `queueMicrotask` and `then` share one queue in the order of queueing. */
function microFifo(rng: Rng): Stmt[] {
	const l = new Labels(rng);
	const stmts: Stmt[] = [];
	const count = rng.int(3, 4);
	for (let i = 0; i < count; i += 1) stmts.push(i % 2 === 0 ? micro([l.next()]) : chain([l.next()]));
	for (let i = rng.int(1, 2); i > 0; i -= 1) stmts.push(l.next());
	stmts.push(timeout(0, [l.next()]));
	return rng.shuffle(stmts);
}

/** Intern X: two chains of `then` advance one link per turn. */
function twoChains(rng: Rng): Stmt[] {
	const l = new Labels(rng);
	const links = (n: number): Stmt[][] => Array.from({ length: n }, () => [l.next()]);
	const stmts: Stmt[] = [chain(...links(rng.int(2, 3))), chain(...links(rng.int(2, 3)))];
	if (rng.bool(0.6)) stmts.push(micro([l.next()]));
	stmts.push(l.next());
	if (rng.bool(0.5)) stmts.push(timeout(0, [l.next()]));
	return rng.shuffle(stmts);
}

/** Junior A: microtasks queue microtasks; two timers due at once, the first queues a microtask. */
function microSpawnsMicro(rng: Rng): Stmt[] {
	const l = new Labels(rng);
	const ms = rng.pick([0, 50]);
	const first = timeout(ms, rng.shuffle([l.next(), anyMicro(rng, [l.next()])]));
	const second = timeout(ms, [l.next()]);
	const spawning = anyMicro(rng, [l.next(), anyMicro(rng, [l.next()])]);
	const stmts: Stmt[] = [l.next(), spawning, anyMicro(rng, [l.next()])];
	stmts.splice(rng.int(0, stmts.length), 0, first);
	stmts.splice(rng.int(stmts.indexOf(first) + 1, stmts.length), 0, second);
	if (rng.bool(0.5)) stmts.push(l.next());
	return stmts;
}

/** Junior B: a timer set inside a microtask and a timer set inside a timer, against timers set at the start. */
function nestedTimers(rng: Rng): Stmt[] {
	const l = new Labels(rng);
	const outer = rng.pick([50, 100, 200]);
	const inner = rng.pick([100, 150, 200]);
	const parent = timeout(
		outer,
		rng.shuffle([l.next(), timeout(inner, [l.next()]), ...(rng.bool() ? [anyMicro(rng, [l.next()])] : [])])
	);
	const fromMicro = anyMicro(rng, [l.next(), timeout(rng.pick([0, 50, 100]), [l.next()])]);
	const top = timeout(rng.pick([150, 200, 300, 400]), [l.next()]);
	const stmts = rng.shuffle([parent, fromMicro, top, l.next()]);
	if (rng.bool(0.4)) stmts.push(timeout(rng.pick([0, 50]), [l.next()]));
	return stmts;
}

/** Anchor junior: equal delays fire in the order the timers were set, not in the order of the text. */
function sameDelayOrder(rng: Rng): Stmt[] {
	const l = new Labels(rng);
	const ms = rng.pick([0, 50, 100]);
	const early = anyMicro(rng, rng.shuffle([l.next(), timeout(ms, [l.next()])]));
	const stmts: Stmt[] = [early];
	if (rng.bool(0.5)) stmts.push(chain([l.next()], [timeout(ms, [l.next()])]));
	stmts.push(timeout(ms, [l.next()]));
	if (rng.bool(0.5)) stmts.push(l.next());
	if (rng.bool(0.5)) stmts.push(timeout(ms + 200, [l.next()]));
	stmts.splice(rng.int(0, stmts.length), 0, l.next());
	return stmts;
}

/** Junior X: two chains, one of whose links queues a microtask and sets a timer. */
function chainsAndTasks(rng: Rng): Stmt[] {
	const l = new Labels(rng);
	const busy: Stmt[] = rng.shuffle([l.next(), micro([l.next()]), ...(rng.bool() ? [timeout(0, [l.next()])] : [])]);
	const a = chain([l.next()], busy, ...(rng.bool() ? [[l.next()]] : []));
	const b = chain(...Array.from({ length: rng.int(2, 3) }, () => [l.next()]));
	const stmts = rng.shuffle([a, b, l.next()]);
	if (rng.bool(0.5)) stmts.push(timeout(0, [l.next()]));
	return stmts;
}

const GENERATORS: Record<string, (rng: Rng) => Stmt[]> = {
	'micro-vs-timer': microVsTimer,
	'timer-delays': timerDelays,
	'micro-fifo': microFifo,
	'two-chains': twoChains,
	'micro-spawns-micro': microSpawnsMicro,
	'nested-timers': nestedTimers,
	'same-delay-order': sameDelayOrder,
	'chains-and-tasks': chainsAndTasks
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/micro-vs-timer': ['sync-callbacks', 'single-queue'],
	'intern/timer-delays': ['timers-in-code-order'],
	'intern/micro-fifo': ['then-first', 'sync-callbacks'],
	'intern/two-chains': ['chain-runs-through'],
	'junior/micro-spawns-micro': ['micro-next-tick', 'timer-batch'],
	'junior/nested-timers': ['nested-from-start', 'timers-in-code-order'],
	'junior/same-delay-order': ['same-delay-text-order'],
	'junior/chains-and-tasks': ['chain-runs-through', 'micro-next-tick']
};

const TRIES = 300;

interface Drawn {
	source: string;
	answer: string[];
	wrong: Record<string, string[] | null>;
}

function draw(main: Stmt[], required: readonly string[]): Drawn | null {
	numberTimers(main);
	const answer = execute(main, RIGHT, true);
	if (answer === null) return null;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = execute(main, { ...RIGHT, ...change }, false);
			const same = value === null || (value.length === answer.length && value.every((x, i) => x === answer[i]));
			return [id, same ? null : value];
		})
	);
	if (required.some((id) => wrong[id] === null)) return null;
	return { source: main.map((s) => printStmt(s, '')).join(''), answer, wrong };
}

/** A fixed program of the class, used when no drawn program fits: every required misconception changes its output. */
function fallback(classId: string): Stmt[] {
	const log = (label: string): Stmt => ({ k: 'log', label });
	switch (classId) {
		case 'micro-vs-timer':
			return [log('alpha'), timeout(0, [log('bravo')]), chain([log('delta')]), micro([log('echo')]), log('golf')];
		case 'timer-delays':
			return [timeout(300, [log('alpha')]), timeout(0, [log('bravo')]), log('delta'), timeout(150, [log('echo')])];
		case 'micro-fifo':
			return [
				micro([log('alpha')]),
				chain([log('bravo')]),
				log('delta'),
				micro([log('echo')]),
				timeout(0, [log('golf')])
			];
		case 'two-chains':
			return [chain([log('alpha')], [log('bravo')]), chain([log('delta')], [log('echo')]), log('golf')];
		case 'micro-spawns-micro':
			return [
				timeout(0, [log('alpha'), micro([log('bravo')])]),
				timeout(0, [log('delta')]),
				chain([log('echo'), micro([log('golf')])]),
				log('hotel')
			];
		case 'nested-timers':
			return [
				timeout(200, [log('alpha'), timeout(150, [log('bravo')])]),
				timeout(300, [log('delta')]),
				micro([log('echo')]),
				log('golf'),
				timeout(0, [log('kilo')])
			];
		case 'same-delay-order':
			return [micro([timeout(0, [log('alpha')])]), timeout(0, [log('bravo')]), log('delta')];
		default:
			// chains-and-tasks.
			return [
				chain([log('alpha')], [log('bravo'), micro([log('delta')])], [log('echo')]),
				chain([log('golf')], [log('hotel')], [log('kilo')]),
				timeout(0, [log('lima')])
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
