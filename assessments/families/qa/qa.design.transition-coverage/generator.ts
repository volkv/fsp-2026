// State-transition testing of a state machine: transition and transition-pair (1-switch) coverage of a test set whose
// tests stop at an invalid event, the invalid state × event pairs negative tests need, and at the senior level the
// shortest event sequences that cover every transition — without a reset, with a reset that costs a step, and as the
// fewest separate tests — and the cheapest set of new tests that completes the 1-switch coverage of a given set.
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

interface Transition {
	from: number;
	event: string;
	to: number;
}

interface Params {
	subject: string;
	states: string[];
	events: string[];
	/** In the order of the table, numbered from 1. */
	transitions: Transition[];
	tests: string[][];
	/** The cost of `reset` in steps, for the class with a reset. */
	resetCost: number | null;
}

interface Rules {
	loops: boolean;
	start: boolean;
	unreachable: boolean;
	deadEnd: boolean;
	continueAfterInvalid: boolean;
	failedCountsNothing: boolean;
	greedy: boolean;
}

const RIGHT: Rules = {
	loops: true,
	start: false,
	unreachable: false,
	deadEnd: true,
	continueAfterInvalid: false,
	failedCountsNothing: false,
	greedy: false
};

const DOMAINS: { subject: string; states: string[]; events: string[] }[] = [
	{
		subject: 'заказа',
		states: ['создан', 'оплачен', 'собран', 'отправлен', 'доставлен', 'отменён'],
		events: ['pay', 'pack', 'ship', 'deliver', 'cancel', 'edit', 'refund']
	},
	{
		subject: 'кредитной заявки',
		states: ['черновик', 'подана', 'на_проверке', 'одобрена', 'отклонена', 'выдана'],
		events: ['submit', 'check', 'approve', 'reject', 'issue', 'revise', 'withdraw']
	},
	{
		subject: 'обращения в поддержку',
		states: ['новое', 'в_работе', 'ждёт_клиента', 'решено', 'закрыто', 'эскалировано'],
		events: ['take', 'ask', 'answer', 'solve', 'close', 'reopen', 'escalate']
	},
	{
		subject: 'подписки',
		states: ['пробная', 'активна', 'приостановлена', 'просрочена', 'отменена', 'архив'],
		events: ['pay', 'pause', 'resume', 'expire', 'cancel', 'renew', 'archive']
	}
];

/** Transitions a rule set counts. */
const counted = (p: Params, rules: Rules): number[] =>
	p.transitions.map((_, k) => k).filter((k) => rules.loops || p.transitions[k]?.from !== p.transitions[k]?.to);

function step(p: Params, state: number, event: string): number | null {
	const k = p.transitions.findIndex((t) => t.from === state && t.event === event);
	return k < 0 ? null : k;
}

/** The transitions a test passes, in order, under a rule set. */
function run(p: Params, test: readonly string[], rules: Rules): number[] {
	const path: number[] = [];
	let state = 0;
	for (const event of test) {
		const k = step(p, state, event);
		if (k === null) {
			if (rules.continueAfterInvalid) continue;
			return rules.failedCountsNothing ? [] : path;
		}
		path.push(k);
		state = p.transitions[k]?.to ?? 0;
	}
	return path;
}

function reachable(p: Params): Set<number> {
	const seen = new Set([0]);
	const queue = [0];
	while (queue.length > 0) {
		const s = queue.shift() ?? 0;
		for (const t of p.transitions) {
			if (t.from === s && !seen.has(t.to)) {
				seen.add(t.to);
				queue.push(t.to);
			}
		}
	}
	return seen;
}

/** The pairs of consecutive transitions a rule set counts, as `a>b`. */
function allPairs(p: Params, rules: Rules): string[] {
	const use = counted(p, rules);
	const pairs: string[] = [];
	for (const a of use)
		for (const b of use) if (p.transitions[a]?.to === p.transitions[b]?.from) pairs.push(`${a}>${b}`);
	return pairs;
}

/** The pairs the tests pass, as `a>b` (and `start>k` under the misconception that counts the start). */
function passedPairs(p: Params, rules: Rules): Set<string> {
	const use = new Set(counted(p, rules));
	const seen = new Set<string>();
	for (const test of p.tests) {
		const path = run(p, test, rules).filter((k) => use.has(k));
		// A misconception that drops loops joins the transitions around them.
		for (let i = 0; i + 1 < path.length; i += 1) {
			const a = path[i] ?? 0;
			const b = path[i + 1] ?? 0;
			if (p.transitions[a]?.to === p.transitions[b]?.from) seen.add(`${a}>${b}`);
		}
		if (rules.start && path.length > 0) seen.add(`start>${path[0]}`);
	}
	return seen;
}

/** `<all pairs> <pairs the tests pass>` of 1-switch coverage. */
function switchCoverage(p: Params, rules: Rules): string {
	let total = allPairs(p, rules).length;
	if (rules.start) total += counted(p, rules).filter((k) => p.transitions[k]?.from === 0).length;
	return `${total} ${passedPairs(p, rules).size}`;
}

/**
 * The pairs the tests miss and the cheapest set of new tests that passes all of them: the fewest tests, then the fewest
 * events. Dijkstra over (last transition, passed missing pairs); a new test starts with no last transition.
 */
function completeSwitch(p: Params, rules: Rules): { missing: number; tests: number; events: number } | null {
	const use = counted(p, rules);
	const seen = passedPairs(p, rules);
	const missing = allPairs(p, rules).filter((pair) => !seen.has(pair));
	if (missing.length === 0 || missing.length > 12) return null;
	const bitOf = new Map(missing.map((pair, i) => [pair, 1 << i]));
	const full = (1 << missing.length) - 1;
	const lasts = p.transitions.length + 1;
	const big = 1024;
	const best = new Map<number, number>();
	const queue = new Heap();
	queue.push(big, 0);
	best.set(0, big);
	while (queue.size > 0) {
		const [cost, node] = queue.pop();
		if (best.get(node) !== cost) continue;
		const last = (node % lasts) - 1;
		const mask = Math.floor(node / lasts);
		if (mask === full) return { missing: missing.length, tests: Math.floor(cost / big), events: cost % big };
		const state = last < 0 ? 0 : (p.transitions[last]?.to ?? 0);
		const moves: [number, number][] = [];
		for (const k of use) {
			if (p.transitions[k]?.from !== state) continue;
			const passed = last < 0 ? 0 : (bitOf.get(`${last}>${k}`) ?? 0);
			moves.push([k + 1 + lasts * (mask | passed), 1]);
		}
		if (last >= 0) moves.push([lasts * mask, big]);
		for (const [next, add] of moves) {
			const nc = cost + add;
			if (nc < (best.get(next) ?? Infinity)) {
				best.set(next, nc);
				queue.push(nc, next);
			}
		}
	}
	return null;
}

/**
 * The greedy completion: within the current test, to the nearest missing pair (ties by the order of pairs), a new
 * test when no missing pair is reachable.
 */
function greedySwitch(p: Params, rules: Rules): { missing: number; tests: number; events: number } | null {
	const use = counted(p, rules);
	const seen = passedPairs(p, rules);
	const missing = allPairs(p, rules).filter((pair) => !seen.has(pair));
	if (missing.length === 0) return null;
	const left = new Set(missing);
	const order = (pair: string): number => missing.indexOf(pair);
	const from = (last: number): number => (last < 0 ? 0 : (p.transitions[last]?.to ?? 0));
	let tests = 1;
	let events = 0;
	let last = -1;
	while (left.size > 0) {
		// Breadth-first over the last transition; the path to each is kept.
		const paths = new Map<number, number[]>([[last, []]]);
		let frontier = [last];
		let found: number[] | null = null;
		while (frontier.length > 0 && !found) {
			const candidates: { path: number[]; pair: string }[] = [];
			const next: number[] = [];
			for (const l of frontier) {
				for (const k of use) {
					if (p.transitions[k]?.from !== from(l)) continue;
					const path = [...(paths.get(l) ?? []), k];
					if (l >= 0 && left.has(`${l}>${k}`)) candidates.push({ path, pair: `${l}>${k}` });
					if (!paths.has(k)) {
						paths.set(k, path);
						next.push(k);
					}
				}
			}
			if (candidates.length > 0) found = candidates.sort((a, b) => order(a.pair) - order(b.pair))[0]?.path ?? null;
			frontier = next;
		}
		if (!found) {
			if (last < 0) return null;
			tests += 1;
			last = -1;
			continue;
		}
		for (const k of found) {
			if (last >= 0) left.delete(`${last}>${k}`);
			last = k;
			events += 1;
		}
	}
	return { missing: missing.length, tests, events };
}

interface Walk {
	/** The cost of the service event `reset` in steps; null — there is no reset. */
	reset: number | null;
	/** A new test from the initial state: the search minimises tests first, then events. */
	restart: boolean;
	/** The walk must end in the initial state. */
	closed: boolean;
}

/** What a walk costs: steps (events and resets at their cost) or tests, and the tie-breaker. */
interface Cost {
	main: number;
	tie: number;
}

/**
 * The cheapest walk from the initial state that passes every transition of `need`: Dijkstra over (state, passed
 * transitions). Without restarts the cost is steps, ties broken by fewer resets; with restarts it is tests, ties broken
 * by fewer events.
 */
function cheapest(p: Params, need: readonly number[], walk: Walk): Cost | null {
	const bitOf = new Map(need.map((k, i) => [k, 1 << i]));
	const full = (1 << need.length) - 1;
	const states = p.states.length;
	const big = 1024;
	const best = new Map<number, number>();
	const queue = new Heap();
	const first = walk.restart ? big : 0;
	queue.push(first, 0);
	best.set(0, first);
	while (queue.size > 0) {
		const [cost, node] = queue.pop();
		if (best.get(node) !== cost) continue;
		const s = node % states;
		const mask = Math.floor(node / states);
		if (mask === full && (!walk.closed || s === 0)) return { main: Math.floor(cost / big), tie: cost % big };
		const moves: [number, number][] = [];
		p.transitions.forEach((t, k) => {
			if (t.from === s) moves.push([t.to + states * (mask | (bitOf.get(k) ?? 0)), walk.restart ? 1 : big]);
		});
		if (walk.reset !== null && s !== 0) moves.push([states * mask, walk.reset * big + 1]);
		if (walk.restart && s !== 0) moves.push([states * mask, big]);
		for (const [next, add] of moves) {
			const nc = cost + add;
			if (nc < (best.get(next) ?? Infinity)) {
				best.set(next, nc);
				queue.push(nc, next);
			}
		}
	}
	return null;
}

/** A binary min-heap of (cost, node). */
class Heap {
	readonly #items: [number, number][] = [];

	get size(): number {
		return this.#items.length;
	}

	push(cost: number, node: number): void {
		const items = this.#items;
		items.push([cost, node]);
		for (let i = items.length - 1; i > 0;) {
			const up = (i - 1) >> 1;
			if ((items[up]?.[0] ?? 0) <= cost) break;
			[items[i], items[up]] = [items[up] as [number, number], items[i] as [number, number]];
			i = up;
		}
	}

	pop(): [number, number] {
		const items = this.#items;
		const top = items[0] as [number, number];
		const last = items.pop() as [number, number];
		if (items.length > 0) {
			items[0] = last;
			for (let i = 0; ;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < items.length && (items[l]?.[0] ?? 0) < (items[m]?.[0] ?? 0)) m = l;
				if (r < items.length && (items[r]?.[0] ?? 0) < (items[m]?.[0] ?? 0)) m = r;
				if (m === i) break;
				[items[i], items[m]] = [items[m] as [number, number], items[i] as [number, number]];
				i = m;
			}
		}
		return top;
	}
}

/** Shortest event path between two states, breadth-first. */
function distance(p: Params, from: number, to: number): number | null {
	const seen = new Map([[from, 0]]);
	const queue = [from];
	while (queue.length > 0) {
		const s = queue.shift() ?? 0;
		if (s === to) return seen.get(s) ?? 0;
		for (const t of p.transitions) {
			if (t.from === s && !seen.has(t.to)) {
				seen.set(t.to, (seen.get(s) ?? 0) + 1);
				queue.push(t.to);
			}
		}
	}
	return null;
}

/**
 * The greedy walk: to the nearest transition not yet passed (ties by the table), resetting or restarting when stuck.
 * Its events, resets (or new tests) and the state where it ends; null when it gets stuck.
 */
function greedyWalk(
	p: Params,
	need: readonly number[],
	walk: Walk
): { events: number; breaks: number; end: number } | null {
	const left = new Set(need);
	let events = 0;
	let breaks = 0;
	let state = 0;
	while (left.size > 0) {
		const seen = new Map<number, string[]>([[state, []]]);
		let frontier = [state];
		let found: { path: string[]; k: number } | null = null;
		while (frontier.length > 0) {
			const candidates: { path: string[]; k: number }[] = [];
			for (const s of frontier) {
				p.transitions.forEach((t, k) => {
					if (t.from === s && left.has(k)) candidates.push({ path: [...(seen.get(s) ?? []), t.event], k });
				});
			}
			if (candidates.length > 0) {
				found = candidates.sort((a, b) => a.k - b.k)[0] ?? null;
				break;
			}
			const next: number[] = [];
			for (const s of frontier) {
				for (const t of p.transitions) {
					if (t.from === s && !seen.has(t.to)) {
						seen.set(t.to, [...(seen.get(s) ?? []), t.event]);
						next.push(t.to);
					}
				}
			}
			frontier = next;
		}
		if (!found) {
			if (state === 0 || (walk.reset === null && !walk.restart)) return null;
			breaks += 1;
			state = 0;
			continue;
		}
		for (const event of found.path) {
			const k = step(p, state, event) ?? 0;
			left.delete(k);
			events += 1;
			state = p.transitions[k]?.to ?? 0;
		}
	}
	return { events, breaks, end: state };
}

const WALKS: Record<string, Walk[]> = {
	tour: [
		{ reset: null, restart: false, closed: false },
		{ reset: null, restart: false, closed: true }
	],
	'min-tests': [{ reset: null, restart: true, closed: false }]
};

function solve(p: Params, classId: string, rules: Rules): string | null {
	const need = counted(p, rules);
	switch (classId) {
		case 'switch1':
		case 'loops':
			return switchCoverage(p, rules);
		case 'switch1-tests': {
			const c = rules.greedy ? greedySwitch(p, rules) : completeSwitch(p, rules);
			return c ? `${c.missing} ${c.tests} ${c.events}` : null;
		}
		case 'negative': {
			const live = reachable(p);
			const checked = p.states
				.map((_, s) => s)
				.filter((s) => rules.unreachable || live.has(s))
				.filter((s) => rules.deadEnd || p.transitions.some((t) => t.from === s));
			const invalid = checked.reduce((sum, s) => sum + p.events.filter((e) => step(p, s, e) === null).length, 0);
			const lost = p.states.filter((_, s) => !live.has(s));
			return `${invalid} | ${lost.length ? lost.join(' ') : '-'}`;
		}
		case 'uncovered': {
			const passed = new Set(p.tests.flatMap((test) => run(p, test, rules)));
			const left = p.transitions.map((_, k) => k).filter((k) => !passed.has(k));
			return left.length ? left.map((k) => String(k + 1)).join(' ') : '-';
		}
		case 'tour':
		case 'tour-reset':
		case 'min-tests': {
			const walks = WALKS[classId] ?? [{ reset: p.resetCost, restart: false, closed: false }];
			const parts: string[] = [];
			for (const walk of walks) {
				if (rules.greedy) {
					const g = greedyWalk(p, need, walk);
					if (!g) return null;
					if (walk.restart) parts.push(`${g.breaks + 1} ${g.events}`);
					else if (walk.reset !== null) parts.push(`${g.events + g.breaks * walk.reset} ${g.breaks}`);
					else {
						const back = walk.closed ? distance(p, g.end, 0) : 0;
						if (back === null) return null;
						parts.push(String(g.events + back));
					}
					continue;
				}
				const c = cheapest(p, need, walk);
				if (!c) return null;
				parts.push(walk.reset === null && !walk.restart ? String(c.main) : `${c.main} ${c.tie}`);
			}
			return parts.join(' ');
		}
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

interface Shape {
	states: [number, number];
	transitions: [number, number];
	loops: [number, number];
	deadEnds: [number, number];
	unreachable: number;
	/** Every state but the initial one gets an edge back to an earlier state: one walk can pass every transition. */
	backEdges?: boolean;
}

const SHAPES: Record<string, Shape> = {
	switch1: { states: [4, 5], transitions: [7, 10], loops: [0, 0], deadEnds: [0, 1], unreachable: 0 },
	negative: { states: [5, 6], transitions: [6, 9], loops: [0, 1], deadEnds: [1, 1], unreachable: 1 },
	uncovered: { states: [4, 5], transitions: [7, 10], loops: [0, 1], deadEnds: [0, 1], unreachable: 0 },
	loops: { states: [4, 5], transitions: [8, 11], loops: [2, 3], deadEnds: [0, 1], unreachable: 0 },
	tour: { states: [4, 6], transitions: [8, 14], loops: [1, 3], deadEnds: [0, 0], unreachable: 0, backEdges: true },
	'tour-reset': { states: [4, 5], transitions: [7, 10], loops: [0, 1], deadEnds: [1, 2], unreachable: 0 },
	'switch1-tests': { states: [4, 5], transitions: [7, 10], loops: [1, 2], deadEnds: [0, 1], unreachable: 0 },
	'min-tests': { states: [4, 5], transitions: [7, 10], loops: [0, 1], deadEnds: [1, 2], unreachable: 0 }
};

function machine(rng: Rng, shape: Shape): Params {
	const domain = rng.pick(DOMAINS);
	const n = rng.int(...shape.states);
	const states = [domain.states[0] ?? '', ...rng.sample(domain.states.slice(1), n - 1)];
	const events = rng.sample(domain.events, rng.int(4, 5));
	const unreachable = new Set(rng.sample(states.map((_, s) => s).slice(1), shape.unreachable));
	const deadEnds = new Set(
		rng.sample(
			states.map((_, s) => s).filter((s) => s !== 0 && !unreachable.has(s)),
			rng.int(...shape.deadEnds)
		)
	);
	const transitions: Transition[] = [];
	const has = (from: number, event: string): boolean => transitions.some((t) => t.from === from && t.event === event);
	const add = (from: number, to: number): boolean => {
		const free = events.filter((e) => !has(from, e));
		if (free.length === 0) return false;
		transitions.push({ from, event: rng.pick(free), to });
		return true;
	};
	const live = states.map((_, s) => s).filter((s) => !unreachable.has(s));
	const sources = (s: number): boolean => !deadEnds.has(s);
	// A spanning tree from the initial state over the live states, then loops and random edges.
	const order = [0, ...rng.shuffle(live.filter((s) => s !== 0))];
	for (let i = 1; i < order.length; i += 1) {
		const from = rng.pick(order.slice(0, i).filter(sources));
		add(from, order[i] ?? 0);
	}
	if (shape.backEdges) for (let i = 1; i < order.length; i += 1) add(order[i] ?? 0, rng.pick(order.slice(0, i)));
	const loops = rng.int(...shape.loops);
	for (let i = 0; i < loops; i += 1) {
		const at = rng.pick(live.filter(sources));
		add(at, at);
	}
	for (const s of unreachable) {
		add(s, rng.pick(live));
		if (rng.bool()) add(rng.pick([...unreachable]), s === 0 ? 0 : s);
	}
	const target = rng.int(...shape.transitions);
	for (let guard = 0; transitions.length < target && guard < 100; guard += 1) {
		const from = rng.pick(live.filter(sources));
		const to = rng.pick(live.filter((s) => s !== from));
		add(from, to);
	}
	transitions.sort((a, b) => a.from - b.from || events.indexOf(a.event) - events.indexOf(b.event));
	return { subject: domain.subject, states, events, transitions, tests: [], resetCost: null };
}

/** A random valid walk from the initial state, `length` events long or until a dead end. */
function randomWalk(rng: Rng, p: Params, length: number): string[] {
	const out: string[] = [];
	let state = 0;
	for (let i = 0; i < length; i += 1) {
		const options = p.transitions.filter((t) => t.from === state);
		if (options.length === 0) break;
		const t = rng.pick(options);
		out.push(t.event);
		state = t.to;
	}
	return out;
}

/** A walk that breaks on an invalid event, with events after it that a misconception would still apply. */
function brokenWalk(rng: Rng, p: Params): string[] {
	const head = randomWalk(rng, p, rng.int(1, 3));
	let state = 0;
	for (const event of head) state = p.transitions[step(p, state, event) ?? 0]?.to ?? 0;
	const invalid = p.events.filter((e) => step(p, state, e) === null);
	if (invalid.length === 0) return head;
	const tail: string[] = [];
	for (let i = 0; i < rng.int(2, 3); i += 1) {
		const options = p.transitions.filter((t) => t.from === state);
		if (options.length === 0) break;
		const t = rng.pick(options);
		tail.push(t.event);
		state = t.to;
	}
	return [...head, rng.pick(invalid), ...tail];
}

function scenario(rng: Rng, classId: string): Params {
	const shape = SHAPES[classId];
	if (!shape) throw new Error(`${descriptor.key}: unknown class ${classId}`);
	const p = machine(rng, shape);
	if (classId === 'tour-reset') p.resetCost = rng.int(1, 3);
	switch (classId) {
		case 'switch1':
		case 'loops':
			p.tests = Array.from({ length: rng.int(3, 4) }, () => randomWalk(rng, p, rng.int(3, 6)));
			break;
		case 'uncovered':
		case 'switch1-tests': {
			const long = classId === 'switch1-tests';
			const tests = Array.from({ length: rng.int(2, 3) }, () =>
				randomWalk(rng, p, long ? rng.int(5, 8) : rng.int(3, 6))
			);
			tests.push(brokenWalk(rng, p));
			if (rng.bool()) tests.push(brokenWalk(rng, p));
			p.tests = rng.shuffle(tests);
			break;
		}
	}
	return p;
}

function suits(p: Params, classId: string, answer: string): boolean {
	const live = reachable(p);
	const deadEnds = p.states.filter((_, s) => live.has(s) && !p.transitions.some((t) => t.from === s)).length;
	const shape = SHAPES[classId];
	if (!shape) return false;
	if (live.size !== p.states.length - shape.unreachable) return false;
	if (deadEnds < shape.deadEnds[0]) return false;
	const loops = p.transitions.filter((t) => t.from === t.to).length;
	if (loops < shape.loops[0]) return false;
	if (p.tests.some((t) => t.length === 0)) return false;
	if (classId === 'uncovered') return answer !== '-';
	if (classId === 'switch1-tests') {
		// A handful of missing pairs: the completion is planned by hand.
		const [missing = 0, tests = 0] = answer.split(' ').map(Number);
		return missing >= 4 && missing <= 7 && tests <= 3;
	}
	return true;
}

function describe(p: Params, classId: string): string {
	const widths = [
		4,
		Math.max(4, ...p.states.map((s) => s.length)) + 2,
		Math.max(9, ...p.events.map((e) => e.length + 2))
	];
	const row = (cells: string[]): string =>
		cells
			.map((cell, c) => cell.padEnd(widths[c] ?? 0))
			.join('')
			.trimEnd();
	const out = [
		`Жизненный цикл ${p.subject} задан конечным автоматом. Начальное состояние — \`${p.states[0] ?? ''}\`. Состояния: ${p.states.map((s) => `\`${s}\``).join(', ')}. События системы: ${p.events.map((e) => `\`${e}\``).join(', ')}.`,
		'',
		'Переходы (номер, из какого состояния, событие, в какое состояние):',
		'',
		'```',
		...p.transitions.map((t, k) => row([String(k + 1), p.states[t.from] ?? '', t.event, p.states[t.to] ?? ''])),
		'```',
		'',
		'Событие, для которого в текущем состоянии нет перехода в таблице, недопустимо. Переход из состояния в него же (петля) — такой же переход, как остальные.'
	];
	if (p.tests.length > 0) {
		out.push(
			'',
			'Тест — последовательность событий, которые подаются по очереди, начиная с начального состояния. Если событие недопустимо, тест падает на нём, и следующие его события не подаются; переходы, пройденные до падения, считаются пройденными. Тесты:',
			'',
			...p.tests.map((t, k) => `${k + 1}. ${t.map((e) => `\`${e}\``).join(', ')}`)
		);
	}
	out.push('');
	const pairs =
		'Пара переходов (1-switch) — два перехода, идущих подряд: первый приводит в состояние, из которого выходит второй (в том числе петля, за которой идёт та же петля, — это пара петли с самой собой); начало теста переходом не считается. Тест проходит пару, если выполняет эти два перехода друг за другом.';
	switch (classId) {
		case 'switch1':
		case 'loops':
			out.push(
				pairs,
				'',
				'Введите через пробел два числа: сколько всего пар переходов есть в автомате и сколько разных пар проходят тесты вместе. Например: `24 9`.'
			);
			break;
		case 'switch1-tests':
			out.push(
				pairs,
				'',
				'Набор нужно дополнить новыми тестами так, чтобы старые и новые тесты вместе прошли каждую пару переходов автомата. В новых тестах все события допустимы, каждый новый тест начинается в начальном состоянии; пара засчитывается, только если оба её перехода выполнены подряд в одном тесте. Найдите, сколько пар не проходит данный набор, наименьшее число новых тестов и — среди дополнений с этим числом тестов — наименьшее общее число событий в новых тестах.',
				'',
				'Введите через пробел три числа: число непройденных пар, число новых тестов и общее число событий в них. Например: `6 2 11`.'
			);
			break;
		case 'negative':
			out.push(
				'Для негативных тестов нужно подать каждое недопустимое событие в каждом состоянии, в которое можно попасть из начального (само начальное состояние тоже входит в их число). Введите число таких пар «состояние × событие», затем знак `|` и состояния, недостижимые из начального, в порядке списка состояний (если таких нет — `-`). Например: `17 | архив`.'
			);
			break;
		case 'uncovered':
			out.push(
				'Введите через пробел по возрастанию номера переходов, которые не прошёл ни один тест. Например: `2 5 9`.'
			);
			break;
		case 'tour':
			out.push(
				'Сквозной тест — одна последовательность допустимых событий из начального состояния, которая проходит каждый переход таблицы хотя бы раз. Найдите длину (число событий) самого короткого сквозного теста и самого короткого сквозного теста, который к тому же заканчивается в начальном состоянии.',
				'',
				'Введите через пробел две длины: без условия возврата и с ним. Например: `11 13`.'
			);
			break;
		case 'tour-reset':
			out.push(
				`Кроме событий таблицы, в любом состоянии можно подать служебное событие \`reset\`: оно возвращает автомат в начальное состояние и стоит ${p.resetCost ?? 1} ${p.resetCost === 1 ? 'шаг' : 'шага'}; каждое событие таблицы стоит один шаг. Нужна одна последовательность из начального состояния (события таблицы допустимы, \`reset\` — сколько угодно раз), которая проходит каждый переход таблицы хотя бы раз. Найдите наименьшую её стоимость в шагах, а среди самых дешёвых — наименьшее число \`reset\`.`,
				'',
				'Введите через пробел два числа: стоимость и число `reset`. Например: `14 2`.'
			);
			break;
		case 'min-tests':
			out.push(
				'Нужен набор тестов, которые вместе проходят каждый переход таблицы хотя бы раз; все события в тестах допустимы, каждый тест начинается в начальном состоянии. Найдите наименьшее число тестов, а среди наборов с этим числом тестов — наименьшее общее число событий во всех тестах.',
				'',
				'Введите через пробел два числа: число тестов и общее число событий. Например: `3 14`.'
			);
			break;
	}
	return out.join('\n');
}

const PYTHON_REFERENCE = `import heapq
import json
from collections import deque

p = json.loads(input())
cls = p["classId"]
states = p["states"]
trans = [(t["from"], t["event"], t["to"]) for t in p["transitions"]]
go = {(f, e): (k, to) for k, (f, e, to) in enumerate(trans)}


def run(test):
    path, s = [], 0
    for e in test:
        if (s, e) not in go:
            break
        k, s = go[(s, e)]
        path.append(k)
    return path


def reach():
    seen, q = {0}, deque([0])
    while q:
        s = q.popleft()
        for f, e, to in trans:
            if f == s and to not in seen:
                seen.add(to)
                q.append(to)
    return seen


full = (1 << len(trans)) - 1
out = None
if cls in ("switch1", "loops", "switch1-tests"):
    pairs = [(a, b) for a in range(len(trans)) for b in range(len(trans)) if trans[a][2] == trans[b][0]]
    seen = set()
    for t in p["tests"]:
        path = run(t)
        seen |= set(zip(path, path[1:]))
    if cls != "switch1-tests":
        out = f"{len(pairs)} {len(seen)}"
    else:
        # Dijkstra over (last transition, passed missing pairs); cost (new tests, events).
        missing = [pair for pair in pairs if pair not in seen]
        index = {pair: i for i, pair in enumerate(missing)}
        need = (1 << len(missing)) - 1
        best = {(None, 0): (1, 0)}
        heap = [(1, 0, -1, 0)]
        while heap:
            tests, events, last, m = heapq.heappop(heap)
            key = (None if last < 0 else last, m)
            if best.get(key) != (tests, events):
                continue
            if m == need:
                out = f"{len(missing)} {tests} {events}"
                break
            s = 0 if last < 0 else trans[last][2]
            options = []
            for k, (f, e, to) in enumerate(trans):
                if f == s:
                    nm = m | (1 << index[(last, k)] if last >= 0 and (last, k) in index else 0)
                    options.append((k, nm, tests, events + 1))
            if last >= 0:
                options.append((-1, m, tests + 1, events))
            for nl, nm, t2, e2 in options:
                nk = (None if nl < 0 else nl, nm)
                if nk not in best or (t2, e2) < best[nk]:
                    best[nk] = (t2, e2)
                    heapq.heappush(heap, (t2, e2, nl, nm))
elif cls == "negative":
    live = reach()
    count = sum(1 for s in live for e in p["events"] if (s, e) not in go)
    out = f"{count} | " + (" ".join(states[s] for s in range(len(states)) if s not in live) or "-")
elif cls == "uncovered":
    passed = set()
    for t in p["tests"]:
        passed |= set(run(t))
    out = " ".join(str(k + 1) for k in range(len(trans)) if k not in passed) or "-"
elif cls in ("tour", "tour-reset"):

    def search(reset, closed):
        # Dijkstra over (state, passed transitions); cost (steps, resets).
        best = {(0, 0): (0, 0)}
        heap = [(0, 0, 0, 0)]
        while heap:
            steps, resets, s, m = heapq.heappop(heap)
            if best[(s, m)] != (steps, resets):
                continue
            if m == full and (not closed or s == 0):
                return steps, resets
            options = [(to, m | 1 << k, steps + 1, resets) for k, (f, e, to) in enumerate(trans) if f == s]
            if reset is not None and s != 0:
                options.append((0, m, steps + reset, resets + 1))
            for to, nm, st, rs in options:
                if (st, rs) < best.get((to, nm), (float("inf"), 0)):
                    best[(to, nm)] = (st, rs)
                    heapq.heappush(heap, (st, rs, to, nm))

    if cls == "tour":
        out = f"{search(None, False)[0]} {search(None, True)[0]}"
    else:
        out = "%d %d" % search(p["resetCost"], False)
elif cls == "min-tests":
    best = {(0, 0): (1, 0)}
    heap = [(1, 0, 0, 0)]
    while heap:
        tests, events, s, m = heapq.heappop(heap)
        if best.get((s, m)) != (tests, events):
            continue
        if m == full:
            out = f"{tests} {events}"
            break
        options = [(to, m | 1 << k, tests, events + 1) for k, (f, e, to) in enumerate(trans) if f == s]
        options.append((0, m, tests + 1, events))
        for to, nm, t2, e2 in options:
            if (to, nm) not in best or (t2, e2) < best[(to, nm)]:
                best[(to, nm)] = (t2, e2)
                heapq.heappush(heap, (t2, e2, to, nm))
print(out)
`;

const WRONG: Record<string, Partial<Rules>> = {
	'forget-loops': { loops: false },
	'include-start': { start: true },
	'include-unreachable': { unreachable: true },
	'skip-dead-end': { deadEnd: false },
	'continue-after-invalid': { continueAfterInvalid: true },
	'failed-test-counts-nothing': { failedCountsNothing: true },
	greedy: { greedy: true }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	'middle/switch1': ['include-start'],
	'middle/negative': ['include-unreachable', 'skip-dead-end'],
	'middle/uncovered': ['continue-after-invalid', 'failed-test-counts-nothing'],
	'middle/loops': ['forget-loops'],
	'senior/tour': ['greedy', 'forget-loops'],
	'senior/tour-reset': ['greedy'],
	'senior/switch1-tests': ['forget-loops', 'continue-after-invalid', 'greedy'],
	'senior/min-tests': ['greedy']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { grade, classId } = input;
	// Machines are drawn until the question is well posed and every misconception the class must
	// expose changes the answer.
	for (let tries = 0; tries < 2000; tries += 1) {
		const p = scenario(rng, classId);
		const answer = solve(p, classId, RIGHT);
		if (answer === null || !suits(p, classId, answer)) continue;
		const wrong: Record<string, string | null> = {};
		for (const [id, change] of Object.entries(WRONG)) {
			const value = solve(p, classId, { ...RIGHT, ...change });
			wrong[id] = value === null || value === answer ? null : value;
		}
		if ((REQUIRED[`${grade}/${classId}`] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, classId), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({
			classId,
			states: p.states,
			events: p.events,
			transitions: p.transitions,
			tests: p.tests,
			resetCost: p.resetCost
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${grade}/${classId} after 2000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
