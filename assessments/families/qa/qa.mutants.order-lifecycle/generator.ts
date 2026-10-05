// QA practice: the candidate reads a state machine — states, the allowed transitions, a limit on how many times an
// event is accepted and (Senior) events that are ignored without an error — and writes 5–8 test cases: a sequence of
// events and the expected result (the final state, or `error k` at the first event that is not allowed). A strong set
// walks every transition, tries an event that is not allowed, reaches the limit and goes one past it. The mutants
// change one place of the machine: a transition leads elsewhere, is lost or appears where it must not, the limit moves,
// the program goes on after an error or counts from zero. Then the step «измени своё решение»: the machine gets a new
// transition, and the candidate adapts the set to it.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type QaCase,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { coverIndices, QA_BUDGET, QA_TASK_TEXT, qaBuilt, type QaPrograms, qaHarnessOf } from '../../_lib/qa.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const STEP_WEIGHT = descriptor.changeStep?.weight ?? 0;
/** The longest sequence of events of a case: the whole input domain stays small enough to compare exhaustively. */
const MAX_EVENTS = 5;

interface Transition {
	from: string;
	event: string;
	to: string;
}

interface Machine {
	states: readonly string[];
	initial: string;
	events: readonly string[];
	transitions: readonly Transition[];
	/** `state event` pairs that change nothing and are not an error. */
	ignored: readonly string[];
	/** The event accepted at most `limit` times in a sequence; the next one is not allowed. */
	guard: { event: string; limit: number };
	/** Mutants only: go on after an event that is not allowed; number the events from zero. */
	goOn: boolean;
	zeroBased: boolean;
}

interface Domain {
	title: string;
	subject: string;
	states: string[];
	initial: string;
	events: string[];
	base: Transition[];
	/** Transitions that some instances have and others get with the change step. */
	optional: Transition[];
	ignorable: string[];
	guardEvent: string;
	limits: number[];
}

const t = (from: string, event: string, to: string): Transition => ({ from, event, to });
const key = (state: string, event: string): string => `${state} ${event}`;

const DOMAINS: Record<string, Domain> = {
	order: {
		title: 'Жизненный цикл заказа',
		subject: 'заказ',
		states: ['created', 'paid', 'shipped', 'delivered', 'cancelled', 'returned'],
		initial: 'created',
		events: ['pay', 'ship', 'deliver', 'cancel', 'return'],
		base: [
			t('created', 'pay', 'paid'),
			t('created', 'cancel', 'cancelled'),
			t('paid', 'ship', 'shipped'),
			t('paid', 'cancel', 'cancelled'),
			t('shipped', 'ship', 'shipped'),
			t('shipped', 'deliver', 'delivered'),
			t('delivered', 'return', 'returned')
		],
		optional: [
			t('shipped', 'cancel', 'returned'),
			t('delivered', 'cancel', 'returned'),
			t('returned', 'ship', 'shipped')
		],
		ignorable: [key('paid', 'pay'), key('delivered', 'deliver'), key('cancelled', 'cancel')],
		guardEvent: 'ship',
		limits: [2, 3]
	},
	ticket: {
		title: 'Обработка заявки в поддержку',
		subject: 'заявка',
		states: ['new', 'assigned', 'in_progress', 'resolved', 'closed'],
		initial: 'new',
		events: ['assign', 'start', 'resolve', 'reopen', 'close'],
		base: [
			t('new', 'assign', 'assigned'),
			t('assigned', 'assign', 'assigned'),
			t('assigned', 'start', 'in_progress'),
			t('in_progress', 'resolve', 'resolved'),
			t('resolved', 'reopen', 'in_progress'),
			t('resolved', 'close', 'closed')
		],
		optional: [
			t('in_progress', 'assign', 'assigned'),
			t('closed', 'reopen', 'in_progress'),
			t('new', 'close', 'closed')
		],
		ignorable: [key('in_progress', 'start'), key('closed', 'close'), key('resolved', 'resolve')],
		guardEvent: 'assign',
		limits: [2, 3]
	},
	document: {
		title: 'Согласование документа',
		subject: 'документ',
		states: ['draft', 'review', 'approved', 'rejected', 'published'],
		initial: 'draft',
		events: ['submit', 'approve', 'reject', 'edit', 'publish'],
		base: [
			t('draft', 'edit', 'draft'),
			t('draft', 'submit', 'review'),
			t('review', 'approve', 'approved'),
			t('review', 'reject', 'rejected'),
			t('rejected', 'edit', 'draft'),
			t('approved', 'publish', 'published'),
			t('approved', 'edit', 'draft')
		],
		optional: [t('published', 'edit', 'draft'), t('rejected', 'submit', 'review'), t('review', 'edit', 'draft')],
		ignorable: [key('review', 'submit'), key('published', 'publish'), key('approved', 'approve')],
		guardEvent: 'edit',
		limits: [2, 3]
	},
	subscription: {
		title: 'Жизненный цикл подписки',
		subject: 'подписка',
		states: ['trial', 'active', 'paused', 'cancelled', 'expired'],
		initial: 'trial',
		events: ['pay', 'pause', 'resume', 'cancel', 'expire'],
		base: [
			t('trial', 'pay', 'active'),
			t('trial', 'expire', 'expired'),
			t('active', 'pay', 'active'),
			t('active', 'pause', 'paused'),
			t('paused', 'resume', 'active'),
			t('active', 'cancel', 'cancelled'),
			t('paused', 'cancel', 'cancelled')
		],
		optional: [t('expired', 'pay', 'active'), t('cancelled', 'pay', 'active'), t('paused', 'expire', 'expired')],
		ignorable: [key('paused', 'pause'), key('active', 'resume'), key('cancelled', 'cancel')],
		guardEvent: 'pay',
		limits: [2, 3]
	}
};

/**
 * The machine as a function of a sequence of event numbers (indices in `m.events`): the number of the final state, or
 * `states + k` for `error k`. Tables by numbers, not by names: the generator runs every mutant on every sequence.
 */
function compile(m: Machine): (events: Uint8Array) => number {
	const S = m.states.length;
	const E = m.events.length;
	const state = (name: string): number => m.states.indexOf(name);
	const table = new Int16Array(S * E).fill(-1);
	for (const x of m.transitions) table[state(x.from) * E + m.events.indexOf(x.event)] = state(x.to);
	const ignored = new Uint8Array(S * E);
	for (const pair of m.ignored) {
		const [from = '', event = ''] = pair.split(' ');
		ignored[state(from) * E + m.events.indexOf(event)] = 1;
	}
	const guard = m.events.indexOf(m.guard.event);
	const initial = state(m.initial);
	return (events) => {
		let current = initial;
		let accepted = 0;
		for (let i = 0; i < events.length; i += 1) {
			const event = events[i] as number;
			const cell = current * E + event;
			if (ignored[cell] === 1) continue;
			const to = table[cell] as number;
			if (to < 0 || (event === guard && accepted >= m.guard.limit)) {
				if (m.goOn) continue;
				return S + (m.zeroBased ? i : i + 1);
			}
			if (event === guard) accepted += 1;
			current = to;
		}
		return current;
	};
}

/** The printed result of a code of `compile`. */
const resultText = (m: Machine, code: number): string =>
	code < m.states.length ? (m.states[code] as string) : `error ${code - m.states.length}`;

interface Mutant {
	id: string;
	operator: string;
	machine: Machine;
}

const arrow = (x: Transition): string => `\`${x.from}\` + \`${x.event}\` → \`${x.to}\``;

/** One-place mutants of a machine; which transitions are lost or added and where they lead come from the seed. */
function mutantsOf(rng: Rng, m: Machine): Mutant[] {
	const out: Mutant[] = [];
	const known = new Set([...m.transitions.map((x) => key(x.from, x.event)), ...m.ignored]);
	m.transitions.forEach((x, i) => {
		const to = rng.pick(m.states.filter((s) => s !== x.to));
		out.push({
			id: `t${i + 1}`,
			operator: `переход ${arrow(x)} ведёт в \`${to}\``,
			machine: { ...m, transitions: m.transitions.map((y, j) => (j === i ? { ...y, to } : y)) }
		});
	});
	for (const [n, i] of rng.sample([...m.transitions.keys()], 2).entries()) {
		const x = m.transitions[i] as Transition;
		out.push({
			id: `r${n + 1}`,
			operator: `переход ${arrow(x)} потерян`,
			machine: { ...m, transitions: m.transitions.filter((_, j) => j !== i) }
		});
	}
	const missing = m.states.flatMap((s) => m.events.filter((e) => !known.has(key(s, e))).map((e) => [s, e] as const));
	for (const [n, [from, event]] of rng.sample(missing, 2).entries()) {
		const x = t(from, event, rng.pick(m.states));
		out.push({
			id: `e${n + 1}`,
			operator: `лишний переход ${arrow(x)}`,
			machine: { ...m, transitions: [...m.transitions, x] }
		});
	}
	const g = m.guard;
	out.push({
		id: 'glo',
		operator: `\`${g.event}\` принимается не больше ${g.limit - 1} раз`,
		machine: { ...m, guard: { ...g, limit: g.limit - 1 } }
	});
	out.push({
		id: 'ghi',
		operator: `\`${g.event}\` принимается не больше ${g.limit + 1} раз`,
		machine: { ...m, guard: { ...g, limit: g.limit + 1 } }
	});
	m.ignored.forEach((pair, i) => {
		out.push({
			id: `i${i + 1}`,
			operator: `\`${pair.replace(' ', '` + `')}\` — ошибка вместо игнорирования`,
			machine: { ...m, ignored: m.ignored.filter((_, j) => j !== i) }
		});
	});
	if (m.ignored.length > 0) {
		const [from, event] = rng.pick(missing);
		out.push({
			id: 'j',
			operator: `\`${from}\` + \`${event}\` игнорируется вместо ошибки`,
			machine: { ...m, ignored: [...m.ignored, key(from, event)] }
		});
	}
	out.push({ id: 'c', operator: 'после недопустимого события обработка продолжается', machine: { ...m, goOn: true } });
	out.push({ id: 'z', operator: 'номер недопустимого события считается с нуля', machine: { ...m, zeroBased: true } });
	return out;
}

/** Every sequence of 1 to `MAX_EVENTS` events, shorter first (the order of the Python domain). */
function sequences(events: readonly string[]): string[][] {
	const out: string[][] = [];
	let layer: string[][] = [[]];
	for (let n = 1; n <= MAX_EVENTS; n += 1) {
		layer = layer.flatMap((p) => events.map((e) => [...p, e]));
		out.push(...layer);
	}
	return out;
}

function pyMachine(m: Machine): string {
	const table = Object.fromEntries(m.transitions.map((x) => [key(x.from, x.event), x.to]));
	return `${JSON.stringify(m.initial)}, ${JSON.stringify(table)}, ${JSON.stringify(m.ignored)}, ${JSON.stringify(m.guard.event)}, ${m.guard.limit}, ${m.goOn ? 'True' : 'False'}, ${m.zeroBased ? 'True' : 'False'}`;
}

function programs(m: Machine, list: readonly Mutant[]): QaPrograms {
	return {
		io: [
			`EVENTS = ${JSON.stringify(m.events)}`,
			`MAX_EVENTS = ${MAX_EVENTS}`,
			'',
			'def parse(text):',
			'    events = tuple(text.split())',
			'    if not 1 <= len(events) <= MAX_EVENTS or any(e not in EVENTS for e in events):',
			'        return None',
			'    return events',
			'',
			'def expect(text):',
			'    value = " ".join(text.split())',
			'    return value or None',
			'',
			'def run(events, state, table, ignored, guard, limit, go_on, zero_based):',
			'    accepted = 0',
			'    for i, event in enumerate(events):',
			'        pair = state + " " + event',
			'        if pair in ignored:',
			'            continue',
			'        to = table.get(pair)',
			'        if to is None or (event == guard and accepted >= limit):',
			'            if go_on:',
			'                continue',
			'            return "error " + str(i if zero_based else i + 1)',
			'        if event == guard:',
			'            accepted += 1',
			'        state = to',
			'    return state'
		].join('\n'),
		reference: `def reference(*events):\n    return run(events, ${pyMachine(m)})`,
		mutants: list.map((x) => ({
			id: x.id,
			source: `def mutant_${x.id}(*events):\n    return run(events, ${pyMachine(x.machine)})`
		})),
		domain: [
			'import itertools',
			'DOMAIN = [p for n in range(1, MAX_EVENTS + 1) for p in itertools.product(EVENTS, repeat=n)]'
		].join('\n')
	};
}

function specification(d: Domain, m: Machine, order: readonly number[]): string {
	return [
		`Программа «${d.title}» читает одну строку — от 1 до ${MAX_EVENTS} событий через пробел; события: ${m.events.map((e) => `\`${e}\``).join(', ')}. Начальное состояние — \`${m.initial}\`; события обрабатываются по порядку.`,
		'',
		'Допустимые переходы (состояние + событие → новое состояние):',
		'',
		...order.flatMap((i) => {
			const x = m.transitions[i];
			return x ? [`- ${arrow(x)}`] : [];
		}),
		'',
		`Событие \`${m.guard.event}\` принимается не больше ${m.guard.limit} раз за всю строку: следующее такое событие недопустимо, даже если переход есть.`,
		...(m.ignored.length > 0
			? [
					'',
					'Эти события в этих состояниях игнорируются: состояние не меняется, ошибки нет, обработка идёт дальше:',
					'',
					...m.ignored.map((pair) => `- \`${pair.replace(' ', '` + `')}\``)
				]
			: []),
		'',
		`Любое другое событие в текущем состоянии недопустимо: программа печатает \`error k\`, где k — номер этого события в строке (с 1), и дальше события не обрабатывает. Если все события обработаны, программа печатает итоговое состояние (${d.subject}).`
	].join('\n');
}

interface Part {
	machine: Machine;
	list: Mutant[];
	equivalent: Set<string>;
	live: string[];
	points: string[][];
	expected: string[];
	kills: Set<string>[];
	cover: number[];
}

function solvePart(rng: Rng, machine: Machine, points: string[][], encoded: readonly Uint8Array[]): Part | null {
	const list = mutantsOf(rng, machine);
	const reference = compile(machine);
	const codes = encoded.map(reference);
	const expected = codes.map((code) => resultText(machine, code));
	const runs = list.map((x) => ({ id: x.id, run: compile(x.machine) }));
	const kills = encoded.map((p, i) => {
		const set = new Set<string>();
		for (const x of runs) if (x.run(p) !== codes[i]) set.add(x.id);
		return set;
	});
	const killed = new Set(kills.flatMap((k) => [...k]));
	const live = list.filter((x) => killed.has(x.id)).map((x) => x.id);
	// The limit has to be reachable and passable within a case, or the set cannot show it.
	if (!live.includes('glo') || !live.includes('ghi') || live.length < 6) return null;
	const cover = coverIndices(kills, live);
	if (!cover || cover.length > QA_BUDGET.max) return null;
	return {
		machine,
		list,
		equivalent: new Set(list.filter((x) => !killed.has(x.id)).map((x) => x.id)),
		live,
		points,
		expected,
		kills,
		cover
	};
}

const casesOf = (part: Part, indices: readonly number[]): QaCase[] =>
	indices.map((i) => ({ input: (part.points[i] ?? []).join(' '), expected: part.expected[i] as string }));

function withMinimum(rng: Rng, part: Part, indices: readonly number[]): number[] {
	const out = [...indices];
	while (out.length < QA_BUDGET.min) out.push(rng.int(0, part.points.length - 1));
	return out;
}

/** The greedy cover of a weak tester: only the sequences `allowed` admits, cut to the budget. */
function weakSet(rng: Rng, part: Part, allowed: (i: number) => boolean): number[] {
	const pool = part.points.flatMap((_, i) => (allowed(i) ? [i] : []));
	const ids = part.live.filter((id) => pool.some((i) => part.kills[i]?.has(id)));
	const cover = coverIndices(
		pool.map((i) => part.kills[i] ?? new Set<string>()),
		ids
	);
	const chosen = (cover ?? []).map((k) => pool[k] as number).slice(0, QA_BUDGET.max);
	while (chosen.length < QA_BUDGET.min) chosen.push(rng.pick(pool));
	return chosen;
}

const killsAll = (part: Part, indices: readonly number[]): boolean => {
	const hit = new Set(indices.flatMap((i) => [...(part.kills[i] ?? [])]));
	return part.live.every((id) => hit.has(id));
};

const toPrograms = (x: { machine: Machine; list: readonly Mutant[] }): QaPrograms => programs(x.machine, x.list);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const domain = DOMAINS[input.classId];
	if (!domain) throw new Error(`${descriptor.key}: no machine for class ${input.classId}`);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	const points = sequences(domain.events);
	const encoded = points.map((p) => Uint8Array.from(p, (e) => domain.events.indexOf(e)));
	for (let tries = 0; tries < 60; tries += 1) {
		const optional = rng.shuffle(domain.optional);
		const present = optional.slice(0, senior ? 2 : 1);
		const added = optional[present.length] as Transition;
		const machine: Machine = {
			states: domain.states,
			initial: domain.initial,
			events: domain.events,
			transitions: [...domain.base, ...present],
			ignored: senior ? rng.sample(domain.ignorable, 2) : [],
			guard: { event: domain.guardEvent, limit: rng.pick(domain.limits) },
			goOn: false,
			zeroBased: false
		};
		const changed: Machine = { ...machine, transitions: [...machine.transitions, added] };
		const task = solvePart(rng, machine, points, encoded);
		if (!task) continue;
		const step = solvePart(rng, changed, points, encoded);
		if (!step) continue;
		const ok = (i: number): boolean => !(task.expected[i] ?? '').startsWith('error');
		const happy = weakSet(rng, task, ok);
		const guardCount = (i: number): number => (task.points[i] ?? []).filter((e) => e === machine.guard.event).length;
		const guardUntested = weakSet(rng, task, (i) => guardCount(i) < machine.guard.limit);
		if (killsAll(task, happy) || killsAll(task, guardUntested)) continue;
		const cases = casesOf(task, withMinimum(rng, task, task.cover));
		const stepCases = casesOf(step, withMinimum(rng, step, step.cover));
		const wrongExpected = cases.map((c, i) =>
			i === 0 ? { ...c, expected: c.expected === machine.initial ? (machine.states[1] ?? 'x') : machine.initial } : c
		);
		const exhaustive = casesOf(
			task,
			Array.from({ length: QA_BUDGET.max + rng.int(4, 12) }, () => rng.int(0, points.length - 1))
		);
		const order = rng.shuffle([...machine.transitions.keys()]);
		const stepOrder = [...order, machine.transitions.length];
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: QA_TASK_TEXT, code: null },
			answer: null,
			qa: {
				budget: QA_BUDGET,
				specification: specification(domain, machine, order),
				mutants: task.list.map((x) => ({ id: x.id, operator: x.operator, equivalent: task.equivalent.has(x.id) }))
			},
			changeStep: {
				markdown: [
					`Требования изменились: появился новый допустимый переход ${arrow(added)}. Остальные правила прежние.`,
					'',
					'Измените свой набор тест-кейсов под новую спецификацию — от 5 до 8 кейсов: он запускается на программе с новым',
					'переходом и на её мутантах так же, как первый набор.'
				].join('\n'),
				weight: STEP_WEIGHT,
				answer: null,
				groups: [],
				qa: {
					specification: specification(domain, changed, stepOrder),
					mutants: step.list.map((x) => ({ id: x.id, operator: x.operator, equivalent: step.equivalent.has(x.id) }))
				}
			}
		});
		return qaBuilt(
			instance,
			toPrograms,
			{ source: { machine: task.machine, list: task.list }, cases },
			{ source: { machine: step.machine, list: step.list }, cases: stepCases },
			{
				'happy-path': casesOf(task, happy),
				'limit-untested': casesOf(task, guardUntested),
				'wrong-expected': wrongExpected,
				exhaustive
			}
		);
	}
	throw new Error(`${descriptor.key}: no machine for ${input.grade}/${input.classId} after 60 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}

/** The harness the engine runs for an instance and a part. */
export const harness = qaHarnessOf(descriptor.key, build);
