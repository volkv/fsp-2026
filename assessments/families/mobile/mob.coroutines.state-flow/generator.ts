// Hot flows of a screen's state: what a collector of `MutableStateFlow` sees (the latest value only, never an equal one,
// the current value on subscription), what `MutableSharedFlow` keeps for a late subscriber and when its `tryEmit`
// fails, and when `stateIn` starts its upstream. The mechanism that decides the output is the essential class; values,
// names and moments are surface. Every program runs in a single-threaded `runBlocking`: the order comes from `yield`
// or from delays whose moments differ by at least 100 ms.
import {
	instanceRng,
	levelAndClass,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { Timeline, traceBuilt, type TraceProgram } from '../../_lib/coroutine-trace.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const HEAD = ['import kotlinx.coroutines.*', 'import kotlinx.coroutines.flow.*', ''];

// Conflation with `yield`.

/** A value of the state: a number, or a data class with two fields. */
type StateValue = number | { loading: boolean; items: number };

const sameValue = (a: StateValue, b: StateValue): boolean =>
	typeof a === 'number' || typeof b === 'number' ? a === b : a.loading === b.loading && a.items === b.items;

const show = (v: StateValue): string =>
	typeof v === 'number' ? String(v) : `UiState(loading=${v.loading}, items=${v.items})`;

/** A step of the main coroutine: an assignment or `yield()`. */
type Step = { kind: 'set'; value: StateValue; code: string } | { kind: 'yield' };

function conflation(rng: Rng): TraceProgram {
	const data = rng.bool();
	const flowName = rng.pick(data ? ['state', 'uiState', 'screen'] : ['badge', 'unread', 'counter']);
	const label = rng.pick(['ui', 'render', 'view']);
	const initial: StateValue = data ? { loading: true, items: 0 } : rng.int(0, 3);
	let cur = initial;
	/** The values set so far, for a step that goes back to an earlier one. */
	const steps: Step[] = [];
	const setTo = (value: StateValue): void => {
		let code: string;
		if (typeof value === 'number') code = `${flowName}.value = ${value}`;
		else if (typeof cur !== 'number' && cur.loading === value.loading && rng.bool(0.6))
			code = `${flowName}.value = ${flowName}.value.copy(items = ${value.items})`;
		else if (typeof cur !== 'number' && cur.items === value.items && rng.bool(0.6))
			code = `${flowName}.update { it.copy(loading = ${value.loading}) }`;
		else code = `${flowName}.value = UiState(${value.loading}, ${value.items})`;
		steps.push({ kind: 'set', value, code });
		cur = value;
	};
	const fresh = (): StateValue => {
		if (typeof cur === 'number') return cur + rng.int(1, 4);
		return rng.bool()
			? { loading: cur.loading, items: cur.items + rng.int(1, 3) }
			: { loading: !cur.loading, items: cur.items };
	};
	const pre: Step[] = [];
	if (rng.bool(0.5)) {
		setTo(fresh());
		pre.push(...steps.splice(0));
	}
	// Assignments between the launch and the first `yield`: the collector starts after them.
	for (let i = rng.int(0, 2); i > 0; i -= 1) setTo(fresh());
	steps.push({ kind: 'yield' });
	const rounds = rng.int(3, 4);
	const patterns = rng.shuffle([
		'equal',
		'burst',
		'back',
		'single',
		...(rounds > 3 ? [rng.pick(['burst', 'single'])] : [])
	]);
	for (const pattern of patterns.slice(0, rounds)) {
		const before = cur;
		if (pattern === 'equal') setTo(typeof cur === 'number' ? cur : { ...cur });
		else if (pattern === 'burst') {
			setTo(fresh());
			setTo(fresh());
		} else if (pattern === 'back') {
			setTo(fresh());
			setTo(before);
		} else setTo(fresh());
		steps.push({ kind: 'yield' });
	}
	const lines = [
		...HEAD,
		...(data ? ['data class UiState(val loading: Boolean, val items: Int)', ''] : []),
		'fun main() = runBlocking {',
		`    val ${flowName} = MutableStateFlow(${typeof initial === 'number' ? initial : 'UiState(true, 0)'})`,
		...pre.map((s) => `    ${s.kind === 'set' ? s.code : 'yield()'}`),
		`    val ${label} = launch { ${flowName}.collect { println("${label}: $it") } }`,
		...steps.map((s) => `    ${s.kind === 'set' ? s.code : 'yield()'}`),
		`    ${label}.cancel()`,
		`    println("last: \${${flowName}.value}")`,
		'}'
	];
	const run = (b: { everyChange?: boolean; equalToo?: boolean; noInitial?: boolean }): string[] => {
		const out: string[] = [];
		let value = initial;
		let last: StateValue | null = null;
		let started = false;
		let changes: StateValue[] = [];
		let assigned = false;
		for (const step of pre) if (step.kind === 'set') value = step.value;
		for (const step of steps) {
			if (step.kind === 'set') {
				if (!sameValue(step.value, value)) changes.push(step.value);
				value = step.value;
				assigned = true;
				continue;
			}
			if (!started) {
				started = true;
				if (!b.noInitial) out.push(`${label}: ${show(value)}`);
				last = value;
			} else if (b.everyChange) {
				for (const c of changes) out.push(`${label}: ${show(c)}`);
				if (changes.length > 0) last = value;
			} else if (b.equalToo ? assigned : last !== null && !sameValue(value, last)) {
				out.push(`${label}: ${show(value)}`);
				last = value;
			}
			changes = [];
			assigned = false;
		}
		out.push(`last: ${show(value)}`);
		return out;
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'no-conflation': run({ everyChange: true }),
			'emits-equal': run({ equalToo: true }),
			'no-initial': run({ noInitial: true })
		}
	};
}

// SharedFlow: replay, extra buffer and tryEmit.

const EVENTS = ['saved', 'deleted', 'synced', 'liked', 'sent', 'moved', 'shared', 'pinned', 'muted', 'copied'];

function sharedBuffer(rng: Rng): TraceProgram {
	const replay = rng.int(0, 2);
	const extra = rng.int(0, 2);
	const capacity = replay + extra;
	const preCount = rng.int(2, 3);
	const preTry = rng.bool(0.4);
	const tries = rng.int(Math.max(2, Math.min(4, capacity + 1)), 4);
	const late = rng.bool(0.6);
	const words = rng.sample(EVENTS, preCount + tries);
	const pre = words.slice(0, preCount);
	const later = words.slice(preCount);
	const name = rng.pick(['events', 'toasts', 'messages']);
	const first = rng.pick(['toast', 'snackbar', 'banner']);
	const second = rng.pick(['late', 'dialog', 'badge']);
	const lines = [
		...HEAD,
		'fun main() = runBlocking {',
		`    val ${name} = MutableSharedFlow<String>(replay = ${replay}, extraBufferCapacity = ${extra})`,
		...pre.map((w) => (preTry ? `    println("${w}: \${${name}.tryEmit("${w}")}")` : `    ${name}.emit("${w}")`)),
		`    val ${first} = launch { ${name}.collect { println("${first}: $it") } }`,
		'    yield()',
		...later.map((w) => `    println("${w}: \${${name}.tryEmit("${w}")}")`),
		'    yield()',
		...(late ? [`    val ${second} = launch { ${name}.collect { println("${second}: $it") } }`, '    yield()'] : []),
		`    ${first}.cancel()`,
		...(late ? [`    ${second}.cancel()`] : []),
		'}'
	];
	const run = (b: { always?: boolean; replayAll?: boolean; extraOnly?: boolean }): string[] => {
		const out: string[] = [];
		if (preTry) for (const w of pre) out.push(`${w}: true`);
		const kept = (values: readonly string[]): string[] =>
			b.replayAll ? [...values] : values.slice(values.length - Math.min(replay, values.length));
		for (const w of kept(pre)) out.push(`${first}: ${w}`);
		const room = b.always ? Infinity : b.extraOnly ? extra : capacity;
		const sent = later.filter((_, i) => i < room);
		for (const w of later) out.push(`${w}: ${sent.includes(w)}`);
		for (const w of sent) out.push(`${first}: ${w}`);
		if (late) for (const w of kept([...pre, ...sent])) out.push(`${second}: ${w}`);
		return out;
	};
	return {
		lines,
		answer: run({}),
		wrong: {
			'try-emit-always': run({ always: true }),
			'replay-all': run({ replayAll: true }),
			'capacity-extra-only': run({ extraOnly: true })
		}
	};
}

// A slow collector of StateFlow: conflation in time.

interface SlowSchedule {
	initial: number;
	sets: { at: number; delay: number; value: number }[];
	finalDelay: number;
	end: number;
	work: number;
}

/** Prints of the collector by the model: `mode` switches the belief about what it reads when it wakes. */
function slowPrints(s: SlowSchedule, mode: 'latest' | 'queue' | 'first'): { at: number; value: number }[] {
	const prints: { at: number; value: number }[] = [{ at: 0, value: s.initial }];
	if (mode === 'queue') {
		let free = s.work;
		let prev = s.initial;
		for (const set of s.sets) {
			if (set.value === prev) continue;
			prev = set.value;
			const at = Math.max(free, set.at);
			if (at >= s.end) break;
			prints.push({ at, value: set.value });
			free = at + s.work;
		}
		return prints;
	}
	let last = s.initial;
	let wake = s.work;
	const valueAt = (t: number): number => {
		let v = s.initial;
		for (const set of s.sets) if (set.at <= t) v = set.value;
		return v;
	};
	while (wake < s.end) {
		const now = valueAt(wake);
		if (now !== last) {
			const changed =
				mode === 'first'
					? (s.sets.find((x) => x.at > wake - s.work && x.at <= wake && x.value !== last)?.value ?? now)
					: now;
			prints.push({ at: wake, value: changed });
			last = changed;
			wake += s.work;
			continue;
		}
		const next = s.sets.find((x) => x.at > wake && x.value !== last);
		if (!next || next.at >= s.end) break;
		prints.push({ at: next.at, value: next.value });
		last = next.value;
		wake = next.at + s.work;
	}
	return prints;
}

/** Wake moments of the collector in the true model, to keep them at least 100 ms from every other moment. */
function slowMoments(s: SlowSchedule): number[] {
	const moments: number[] = [];
	const prints = slowPrints(s, 'latest');
	for (const p of prints) moments.push(p.at + s.work);
	return moments.filter((m) => m <= s.end + 100);
}

function slowCollector(rng: Rng): TraceProgram {
	let s: SlowSchedule;
	for (;;) {
		const work = rng.pick([200, 300]);
		const count = rng.int(3, 4);
		let at = 0;
		let value = rng.pick([0, 5, 10]);
		const initial = value;
		const sets: SlowSchedule['sets'] = [];
		for (let i = 0; i < count; i += 1) {
			const delay = rng.pick([100, 100, 200]);
			at += delay;
			value = rng.bool(0.15) && i > 0 ? value : value + rng.int(1, 4) * 5;
			sets.push({ at, delay, value });
		}
		const finalDelay = rng.pick([100, 200, 300]);
		const end = at + finalDelay;
		s = { initial, sets, finalDelay, end, work };
		const fixed = [...sets.map((x) => x.at), end];
		const wakes = slowMoments(s);
		const clash = wakes.some((w) => fixed.some((f) => Math.abs(f - w) < 100));
		if (!clash && end <= 900) break;
	}
	const name = rng.pick(['progress', 'percent', 'loaded']);
	const label = rng.pick(['shown', 'drawn', 'bar']);
	const lines = [
		...HEAD,
		'fun main() = runBlocking {',
		`    val ${name} = MutableStateFlow(${s.initial})`,
		'    val ui = launch {',
		`        ${name}.collect {`,
		`            println("${label} $it")`,
		`            delay(${s.work})`,
		'        }',
		'    }',
		...s.sets.flatMap((x) => [`    delay(${x.delay})`, `    ${name}.value = ${x.value}`]),
		`    delay(${s.finalDelay})`,
		'    ui.cancel()',
		`    println("final \${${name}.value}")`,
		'}'
	];
	const final = s.sets[s.sets.length - 1]?.value ?? s.initial;
	const run = (mode: 'latest' | 'queue' | 'first', noInitial = false): string[] => {
		const tl = new Timeline();
		slowPrints(s, mode)
			.slice(noInitial ? 1 : 0)
			.forEach((p) => tl.add(p.at, `${label} ${p.value}`));
		tl.add(s.end, `final ${final}`);
		return tl.lines();
	};
	return {
		lines,
		answer: run('latest'),
		wrong: {
			'no-conflation': run('queue'),
			'keeps-first': run('first'),
			'no-initial': run('latest', true)
		}
	};
}

// stateIn: when the upstream starts.

interface StateInPlan {
	/** The initial value of `stateIn`; below every threshold, so `first` never matches it. */
	initial: number;
	values: number[];
	gaps: number[];
	/** The delay of `main` before it reads the value and calls `first`. */
	before: number;
	threshold: number;
	/** The delay after `first` returns, before the last read. */
	after: number;
}

/** The emissions of the upstream started at `start`: the first at once, the next after the gaps. */
const emissions = (p: StateInPlan, start: number): { at: number; value: number }[] => {
	let at = start;
	return p.values.map((value, i) => {
		if (i > 0) at += p.gaps[i - 1] as number;
		return { at, value };
	});
};

/**
 * What the program prints when the upstream starts at `start` (`Eagerly`: 0, when `main` first suspends; `Lazily`: at
 * the first subscriber, the call of `first`); `sync` — the belief that the upstream runs inside `stateIn` itself.
 * `null` — `first` never matches.
 */
function stateInRun(
	p: StateInPlan,
	start: number,
	sync: boolean
): { lines: string[]; hitAt: number; lastAt: number } | null {
	const ems = emissions(p, start);
	const valueAt = (t: number): number => ems.filter((e) => e.at <= t).at(-1)?.value ?? p.initial;
	const tl = new Timeline();
	if (sync) tl.add(0, 'subscribed');
	tl.add(0, `now: ${sync ? valueAt(0) : p.initial}`);
	if (!sync && start === 0) tl.add(0, 'subscribed');
	const current = start < p.before ? valueAt(p.before) : p.initial;
	tl.add(p.before, `later: ${current}`);
	if (start === p.before) tl.add(p.before, 'subscribed');
	const hit =
		current > p.threshold
			? { at: p.before, value: current }
			: ems.find((e) => e.value > p.threshold && (e.at > p.before || (e.at === p.before && start === p.before)));
	if (!hit) return null;
	const lastAt = hit.at + p.after;
	tl.add(hit.at, `first: ${hit.value}`);
	tl.add(lastAt, `last: ${valueAt(lastAt)}`);
	return { lines: tl.lines(), hitAt: hit.at, lastAt };
}

function stateInStart(rng: Rng): TraceProgram {
	const eager = rng.bool();
	let plan: StateInPlan;
	let truth: { lines: string[]; hitAt: number; lastAt: number };
	for (;;) {
		const count = rng.int(2, 3);
		const values = rng.sample([70, 80, 90, 100, 110, 120, 130, 140, 150, 160], count);
		const candidate: StateInPlan = {
			initial: rng.pick([0, 1, 10, 50]),
			values,
			gaps: Array.from({ length: count - 1 }, () => rng.pick([200, 300])),
			before: rng.pick([100, 200, 300]),
			threshold: rng.pick(values) - 5,
			after: rng.pick([100, 200])
		};
		const start = eager ? 0 : candidate.before;
		const run = stateInRun(candidate, start, false);
		if (!run) continue;
		// Timers of `main` keep 100 ms from every emission that a delay of the upstream makes.
		const timed = emissions(candidate, start).filter((e) => e.at > start);
		const clash = timed.some((e) => [candidate.before, run.lastAt].some((m) => Math.abs(m - e.at) < 100));
		if (clash || run.lastAt > 1000) continue;
		plan = candidate;
		truth = run;
		break;
	}
	const name = rng.pick(['prices', 'rates', 'quotes']);
	const ui = rng.pick(['ui', 'price', 'shown']);
	const lines = [
		...HEAD,
		'fun main() = runBlocking {',
		`    val ${name} = flow {`,
		'        println("subscribed")',
		...plan.values.flatMap((v, i) => [...(i > 0 ? [`        delay(${plan.gaps[i - 1]})`] : []), `        emit(${v})`]),
		'    }',
		`    val ${ui} = ${name}.stateIn(this, SharingStarted.${eager ? 'Eagerly' : 'Lazily'}, ${plan.initial})`,
		`    println("now: \${${ui}.value}")`,
		`    delay(${plan.before})`,
		`    println("later: \${${ui}.value}")`,
		`    println("first: \${${ui}.first { it > ${plan.threshold} }}")`,
		`    delay(${plan.after})`,
		`    println("last: \${${ui}.value}")`,
		'    coroutineContext.cancelChildren()',
		'}'
	];
	return {
		lines,
		answer: truth.lines,
		wrong: {
			'lazily-eager': eager ? null : (stateInRun(plan, 0, false)?.lines ?? null),
			'eager-immediate': eager ? (stateInRun(plan, 0, true)?.lines ?? null) : null
		}
	};
}

const CLASSES: Readonly<Record<string, (rng: Rng) => TraceProgram>> = {
	conflation,
	'shared-buffer': sharedBuffer,
	'slow-collector': slowCollector,
	'state-in': stateInStart
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const make = CLASSES[input.classId];
	if (!make) throw new Error(`${descriptor.key}: no program for class ${input.classId}`);
	return traceBuilt(descriptor, input, make(instanceRng(descriptor, input)));
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
