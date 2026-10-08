// State transition testing: where a sequence of events leaves an object and which events it rejects (with
// self-loops, a terminal state and a counter guard), and which transitions of a diagram a set of test paths leaves
// uncovered (0-switch coverage, every path from the initial state, rejected events cover nothing).
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
	from: string;
	event: string;
	to: string;
}

interface Machine {
	plot: string;
	initial: string;
	transitions: readonly Transition[];
}

interface Params {
	machine: Machine;
	/** Intern: one sequence of events. Junior: test paths, each from the initial state. */
	paths: string[][];
	/** The counter guard of the login machine: this many failures in a row lock the account. */
	lockAfter: number | null;
}

interface Rules {
	invalidChanges: boolean;
	selfLoopRejected: boolean;
	counterTotal: boolean;
	noReset: boolean;
	eventCoverage: boolean;
	noLock: boolean;
}

const RIGHT: Rules = {
	invalidChanges: false,
	selfLoopRejected: false,
	counterTotal: false,
	noReset: false,
	eventCoverage: false,
	noLock: false
};

const t = (from: string, event: string, to: string): Transition => ({ from, event, to });

const ORDER: Machine = {
	plot: 'Заказ в интернет-магазине',
	initial: 'NEW',
	transitions: [
		t('NEW', 'pay', 'PAID'),
		t('NEW', 'edit', 'NEW'),
		t('NEW', 'cancel', 'CANCELLED'),
		t('PAID', 'edit', 'PAID'),
		t('PAID', 'ship', 'SHIPPED'),
		t('PAID', 'cancel', 'CANCELLED'),
		t('SHIPPED', 'deliver', 'DELIVERED'),
		t('SHIPPED', 'lose', 'LOST'),
		t('DELIVERED', 'return', 'RETURNED'),
		t('LOST', 'refund', 'CANCELLED')
	]
};

const DOCUMENT: Machine = {
	plot: 'Документ в системе согласования',
	initial: 'DRAFT',
	transitions: [
		t('DRAFT', 'edit', 'DRAFT'),
		t('DRAFT', 'submit', 'REVIEW'),
		t('DRAFT', 'delete', 'DELETED'),
		t('REVIEW', 'comment', 'REVIEW'),
		t('REVIEW', 'reject', 'DRAFT'),
		t('REVIEW', 'approve', 'APPROVED'),
		t('APPROVED', 'publish', 'PUBLISHED'),
		t('APPROVED', 'archive', 'ARCHIVED'),
		t('PUBLISHED', 'unpublish', 'APPROVED'),
		t('PUBLISHED', 'archive', 'ARCHIVED'),
		t('ARCHIVED', 'restore', 'DRAFT')
	]
};

const SUBSCRIPTION: Machine = {
	plot: 'Подписка в онлайн-сервисе',
	initial: 'TRIAL',
	transitions: [
		t('TRIAL', 'subscribe', 'ACTIVE'),
		t('TRIAL', 'expire', 'EXPIRED'),
		t('ACTIVE', 'renew', 'ACTIVE'),
		t('ACTIVE', 'pause', 'PAUSED'),
		t('ACTIVE', 'expire', 'EXPIRED'),
		t('ACTIVE', 'cancel', 'CANCELLED'),
		t('PAUSED', 'resume', 'ACTIVE'),
		t('PAUSED', 'cancel', 'CANCELLED'),
		t('PAUSED', 'expire', 'EXPIRED'),
		t('EXPIRED', 'subscribe', 'ACTIVE')
	]
};

const TICKET: Machine = {
	plot: 'Обращение в службу поддержки',
	initial: 'OPEN',
	transitions: [
		t('OPEN', 'assign', 'IN_PROGRESS'),
		t('OPEN', 'comment', 'OPEN'),
		t('OPEN', 'close', 'CLOSED'),
		t('IN_PROGRESS', 'comment', 'IN_PROGRESS'),
		t('IN_PROGRESS', 'ask', 'WAITING'),
		t('IN_PROGRESS', 'resolve', 'RESOLVED'),
		t('WAITING', 'reply', 'IN_PROGRESS'),
		t('WAITING', 'close', 'CLOSED'),
		t('RESOLVED', 'reopen', 'IN_PROGRESS'),
		t('RESOLVED', 'close', 'CLOSED')
	]
};

const LOGIN: Machine = {
	plot: 'Учётная запись в личном кабинете',
	initial: 'ACTIVE',
	transitions: [
		t('ACTIVE', 'login_ok', 'ACTIVE'),
		t('ACTIVE', 'login_fail', 'ACTIVE'),
		t('ACTIVE', 'block', 'BLOCKED'),
		t('LOCKED', 'unlock', 'ACTIVE'),
		t('LOCKED', 'block', 'BLOCKED'),
		t('BLOCKED', 'unblock', 'ACTIVE')
	]
};

const events = (m: Machine): string[] => [...new Set(m.transitions.map((x) => x.event))];

/** Where a misconception sends an object on a rejected event: the event's only target, if it has one. */
function forcedTarget(m: Machine, event: string): string | null {
	const targets = new Set(m.transitions.filter((x) => x.event === event).map((x) => x.to));
	const [only] = [...targets];
	return targets.size === 1 && only !== undefined ? only : null;
}

/** Intern: `<final state> <numbers of rejected events…>`. */
function trace(p: Params, rules: Rules): string {
	const m = p.machine;
	let state = m.initial;
	let fails = 0;
	const rejected: number[] = [];
	(p.paths[0] ?? []).forEach((event, i) => {
		const x = m.transitions.find((tr) => tr.from === state && tr.event === event);
		if (!x) {
			rejected.push(i + 1);
			if (rules.invalidChanges) {
				const target = forcedTarget(m, event);
				if (target !== null) {
					state = target;
					if (p.lockAfter !== null && target === 'ACTIVE') fails = 0;
				}
			}
			return;
		}
		if (p.lockAfter !== null) {
			if (event === 'login_fail') {
				fails += 1;
				if (fails >= p.lockAfter && !rules.noLock) {
					state = 'LOCKED';
					fails = 0;
				}
				return;
			}
			if (event === 'login_ok' && !rules.counterTotal) fails = 0;
			if (x.to !== state) fails = 0;
			state = x.to;
			return;
		}
		if (rules.selfLoopRejected && x.to === x.from) rejected.push(i + 1);
		state = x.to;
	});
	return [state, ...rejected].join(' ');
}

/** Junior: the numbers (1-based) of the transitions no path covers, ascending. */
function uncovered(p: Params, rules: Rules): string {
	const m = p.machine;
	const covered = new Set<number>();
	const firedEvents = new Set<string>();
	let state = m.initial;
	for (const path of p.paths) {
		if (!rules.noReset) state = m.initial;
		for (const event of path) {
			const index = m.transitions.findIndex((tr) => tr.from === state && tr.event === event);
			const x = m.transitions[index];
			if (!x) {
				if (rules.invalidChanges) state = forcedTarget(m, event) ?? state;
				continue;
			}
			if (!(rules.selfLoopRejected && x.from === x.to)) covered.add(index);
			firedEvents.add(event);
			state = x.to;
		}
	}
	const out = m.transitions.flatMap((x, i) => {
		return (rules.eventCoverage ? firedEvents.has(x.event) : covered.has(i)) ? [] : [i + 1];
	});
	return out.join(' ');
}

function solve(p: Params, grade: string, rules: Rules): string {
	return grade === 'intern' ? trace(p, rules) : uncovered(p, rules);
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

/** A walk of `length` events from `start`: mostly events valid in the current state, sometimes a rejected one. */
function walk(
	rng: Rng,
	m: Machine,
	start: string,
	length: number,
	invalidShare: number
): { path: string[]; end: string } {
	const all = events(m);
	const path: string[] = [];
	let state = start;
	for (let i = 0; i < length; i += 1) {
		const valid = m.transitions.filter((x) => x.from === state);
		if (valid.length === 0 || rng.bool(invalidShare)) {
			const invalid = all.filter((e) => !valid.some((x) => x.event === e));
			path.push(rng.pick(invalid));
			continue;
		}
		const x = rng.pick(valid);
		path.push(x.event);
		state = x.to;
	}
	return { path, end: state };
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	if (grade === 'intern') {
		if (classId === 'counter') {
			const lockAfter = rng.int(2, 4);
			const path: string[] = [];
			const length = rng.int(9, 12);
			for (let i = 0; i < length; i += 1) {
				path.push(
					rng.pick(['login_fail', 'login_fail', 'login_fail', 'login_ok', 'login_ok', 'unlock', 'block', 'unblock'])
				);
			}
			return { machine: LOGIN, paths: [path], lockAfter };
		}
		if (classId === 'terminal') {
			// A walk, the cancellation, then events that reach the terminal state.
			const { path, end } = walk(rng, SUBSCRIPTION, SUBSCRIPTION.initial, rng.int(4, 6), 0.3);
			if (end === 'ACTIVE' || end === 'PAUSED') path.push('cancel');
			const all = events(SUBSCRIPTION);
			for (let i = rng.int(2, 3); i > 0; i -= 1) path.push(rng.pick(all));
			return { machine: SUBSCRIPTION, paths: [path], lockAfter: null };
		}
		const machine = classId === 'order' ? ORDER : DOCUMENT;
		const { path } = walk(rng, machine, machine.initial, rng.int(7, 10), 0.3);
		return { machine, paths: [path], lockAfter: null };
	}
	const machine = rng.pick([ORDER, DOCUMENT, SUBSCRIPTION, TICKET]);
	const count = rng.int(2, 4);
	const invalidShare = classId === 'negative-steps' ? 0.3 : 0.1;
	const paths = Array.from(
		{ length: count },
		() => walk(rng, machine, machine.initial, rng.int(3, 6), invalidShare).path
	);
	return { machine, paths, lockAfter: null };
}

function describe(p: Params, grade: string): string {
	const m = p.machine;
	if (grade === 'intern' && p.lockAfter !== null) {
		return [
			`${m.plot}. Состояния: \`ACTIVE\` (начальное), \`LOCKED\`, \`BLOCKED\`. Правила:`,
			'',
			`- в \`ACTIVE\`: \`login_ok\` — успешный вход, счётчик неудачных попыток подряд обнуляется; \`login_fail\` — неудачный вход, счётчик увеличивается на 1, и когда он достигает ${p.lockAfter}, запись переходит в \`LOCKED\`, а счётчик обнуляется; \`block\` — переход в \`BLOCKED\`;`,
			'- в `LOCKED`: `unlock` — переход в `ACTIVE`; `block` — переход в `BLOCKED`;',
			'- в `BLOCKED`: `unblock` — переход в `ACTIVE`;',
			'- при любом переходе в другое состояние счётчик обнуляется;',
			'- любое другое событие в текущем состоянии недопустимо: система его отклоняет, состояние и счётчик не меняются.',
			'',
			`События приходят по порядку (счётчик в начале — 0):`,
			'',
			...(p.paths[0] ?? []).map((e, i) => `${i + 1}. \`${e}\``),
			'',
			'В каком состоянии окажется запись и какие события будут отклонены? Введите через пробел конечное состояние, затем номера отклонённых событий по возрастанию. Например: `LOCKED 3 8`.'
		].join('\n');
	}
	const states = [...new Set(m.transitions.flatMap((x) => [x.from, x.to]))];
	const transitions = m.transitions.map(
		(x, i) => `- ${grade === 'junior' ? `T${i + 1}: ` : ''}\`${x.from}\` → \`${x.to}\` по событию \`${x.event}\``
	);
	const head = [
		`${m.plot}. Состояния: ${states.map((s) => `\`${s}\``).join(', ')}; начальное — \`${m.initial}\`. Допустимые переходы:`,
		'',
		...transitions,
		'',
		'Любое другое событие в текущем состоянии недопустимо: система его отклоняет, состояние не меняется. Переход в то же состояние — тоже переход: событие принято.',
		''
	];
	if (grade === 'intern') {
		return [
			...head,
			'События приходят по порядку:',
			'',
			...(p.paths[0] ?? []).map((e, i) => `${i + 1}. \`${e}\``),
			'',
			'В каком состоянии окажется объект и какие события будут отклонены? Введите через пробел конечное состояние, затем номера отклонённых событий по возрастанию. Например: `PAID 3 8`.'
		].join('\n');
	}
	return [
		...head,
		'Тестировщик проверяет покрытие переходов (каждый допустимый переход выполнен хотя бы раз). Каждый тест-путь начинается с нового объекта в начальном состоянии; отклонённое событие не покрывает ни одного перехода.',
		'',
		...p.paths.map((path, i) => `- путь ${i + 1}: ${path.map((e) => `\`${e}\``).join(', ')}`),
		'',
		'Какие переходы остались непокрытыми? Введите их номера (без буквы T) через пробел по возрастанию. Например: `2 5 9`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
table = {}
for i, (src, event, dst) in enumerate(p["transitions"]):
    table[(src, event)] = (i, dst)

if p["grade"] == "intern":
    state = p["initial"]
    fails = 0
    rejected = []
    for n, event in enumerate(p["paths"][0], start=1):
        if (state, event) not in table:
            rejected.append(n)
            continue
        dst = table[(state, event)][1]
        if p["lockAfter"] is not None and event == "login_fail":
            fails += 1
            if fails == p["lockAfter"]:
                state, fails = "LOCKED", 0
            continue
        if p["lockAfter"] is not None and (event == "login_ok" or dst != state):
            fails = 0
        state = dst
    print(" ".join([state] + [str(n) for n in rejected]))
else:
    done = set()
    for path in p["paths"]:
        state = p["initial"]
        for event in path:
            if (state, event) in table:
                i, state = table[(state, event)]
                done.add(i)
    print(" ".join(str(i + 1) for i in range(len(p["transitions"])) if i not in done))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'invalid-changes': { invalidChanges: true },
	'self-loop-rejected': { selfLoopRejected: true },
	'counter-total': { counterTotal: true },
	'no-reset': { noReset: true },
	'event-coverage': { eventCoverage: true },
	'no-lock': { noLock: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/order': ['invalid-changes'],
	'intern/self-loops': ['self-loop-rejected', 'invalid-changes'],
	'intern/counter': ['counter-total', 'invalid-changes', 'no-lock'],
	'intern/terminal': ['invalid-changes', 'self-loop-rejected'],
	'junior/reset': ['no-reset'],
	'junior/same-event': ['event-coverage'],
	'junior/negative-steps': ['invalid-changes'],
	'junior/self-loops': ['self-loop-rejected', 'no-reset']
};

function fits(p: Params, grade: string, classId: string, answer: string): boolean {
	const parts = answer.split(' ').filter(Boolean);
	// The terminal class ends in the terminal state, with events rejected there.
	if (
		classId === 'terminal' &&
		(parts[0] !== 'CANCELLED' || Number(parts[parts.length - 1]) < (p.paths[0]?.length ?? 0) - 1)
	)
		return false;
	if (grade === 'intern') return parts.length >= 2;
	return parts.length >= 1 && parts.length <= p.machine.transitions.length - 3;
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = solve(p, input.grade, RIGHT);
		if (!fits(p, input.grade, input.classId, answer)) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				// The counter misconceptions are about the login machine only; self-loops of the login machine are counted
				// by its own rules.
				if ((id === 'counter-total' || id === 'no-lock') && p.lockAfter === null) return [id, null];
				if (id === 'self-loop-rejected' && p.lockAfter !== null) return [id, null];
				const value = solve(p, input.grade, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, input.grade), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({
			grade: input.grade,
			initial: p.machine.initial,
			transitions: p.machine.transitions.map((x) => [x.from, x.event, x.to]),
			paths: p.paths,
			lockAfter: p.lockAfter
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
