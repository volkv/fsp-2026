// Practice: a log of user events is split into sessions of each user by the rule the class sets (a pause, an aligned
// window, a pause with a cap on the length, a pause with a day boundary); from Junior up a logout closes the session
// and the answer is the top K by the total length. Parametric hidden tests in five groups.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type HiddenTestGroup,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const LANGUAGES = ['python3', 'go', 'java21', 'javascript', 'typescript', 'cpp17'] as const;

const descriptor = readDescriptor(import.meta.url);

interface Event {
	t: number;
	user: string;
	action: string;
}
/** `p` is G for the pause classes and W for the window; `q` is L of the capped class and the day of the daily one; `k`
 * is 0 on Intern. */
interface Input {
	p: number;
	q: number;
	k: number;
	events: Event[];
}

/** The wrong solutions and, for the boundary tests, each edge of the rule shifted alone. */
type Variant = 'right' | (typeof WRONG_IDS)[number] | 'gap-edge' | 'cap-edge' | 'day-edge';

interface UserState {
	sessions: number;
	start: number;
	last: number | null;
	best: number;
	total: number;
	closedBest: number;
	closedTotal: number;
}

/** The expected output of the class; a variant other than `right` reproduces a wrong solution. */
function solve(kind: string, input: Input, variant: Variant = 'right'): string {
	const gapEdge = variant === 'boundary' || variant === 'gap-edge';
	const capEdge = variant === 'boundary' || variant === 'cap-edge';
	const dayEdge = variant === 'boundary' || variant === 'day-edge';
	const unclosed = variant === 'unclosed-last';
	const junior = input.k > 0;
	const users = new Map<string, UserState>();
	let previous = 0;
	for (const e of input.events) {
		let s = users.get(e.user);
		if (!s) {
			s = { sessions: 0, start: e.t, last: null, best: 0, total: 0, closedBest: 0, closedTotal: 0 };
			users.set(e.user, s);
		}
		const pause = e.t - (variant === 'global-gap' ? previous : (s.last ?? 0));
		const window = (t: number, width: number, edge: boolean): number => Math.floor((edge ? t - 1 : t) / width);
		let fresh = s.last === null;
		if (kind === 'window') {
			fresh ||=
				variant === 'sliding-window'
					? e.t - s.start >= input.p
					: window(e.t, input.p, variant === 'boundary') !== window(s.start, input.p, variant === 'boundary');
		} else {
			fresh ||= gapEdge ? pause >= input.p : pause > input.p;
			if (kind === 'gap-capped') fresh ||= capEdge ? e.t - s.start >= input.q : e.t - s.start > input.q;
			if (kind === 'gap-daily' && variant !== 'ignores-day')
				fresh ||= window(e.t, input.q, dayEdge) !== window(s.start, input.q, dayEdge);
		}
		if (fresh && s.last !== null) {
			// The session closed by a pause, as a solution that counts a session only when it closes sees it.
			s.closedTotal += s.last - s.start;
			s.closedBest = Math.max(s.closedBest, s.last - s.start);
		}
		if (fresh) {
			s.sessions += 1;
			s.start = e.t;
		} else s.total += e.t - (s.last ?? 0);
		s.best = Math.max(s.best, e.t - s.start);
		s.last = junior && e.action === 'logout' && variant !== 'ignores-logout' ? null : e.t;
		previous = e.t;
	}
	const rows = [...users.entries()];
	if (!junior) {
		return `${rows
			.sort(([a], [b]) => byName(a, b))
			.map(([user, s]) => `${user} ${s.sessions} ${unclosed ? s.closedBest : s.best}`)
			.join('\n')}\n`;
	}
	const total = (s: UserState): number => (unclosed ? s.closedTotal : s.total);
	rows.sort(([a, x], [b, y]) => total(y) - total(x) || (variant === 'no-tie-break' ? 0 : byName(a, b)));
	return `${rows
		.slice(0, input.k)
		.map(([user, s]) => `${user} ${total(s)} ${s.sessions}`)
		.join('\n')}\n`;
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function render(kind: string, input: Input): string {
	const head = [input.events.length, ...(input.k > 0 ? [input.k] : []), input.p];
	if (kind === 'gap-capped' || kind === 'gap-daily') head.push(input.q);
	return `${[head.join(' '), ...input.events.map((e) => `${e.t} ${e.user} ${e.action}`)].join('\n')}\n`;
}

type GroupId = 'basic' | 'boundary' | 'burst' | 'interleave' | 'scale';

const ACTIONS = ['view', 'click', 'search', 'cart', 'login'] as const;

function people(rng: Rng, count: number): string[] {
	const pool = new Set<string>(rng.sample(PERSON_NAMES, Math.min(count, PERSON_NAMES.length)));
	while (pool.size < count) pool.add(`${rng.pick(PERSON_NAMES)}${rng.int(1, 999)}`);
	return [...pool];
}

/** The next moment of a user: the pause menu of the group puts pauses on and around the edges of the rule. */
function step(rng: Rng, kind: string, group: GroupId, input: Input, last: number, start: number): number {
	const p = input.p;
	if (group === 'boundary') {
		if (kind === 'window') return (Math.floor(last / p) + 1) * p - rng.pick([1, 0, 0]) + rng.pick([0, 0, p]);
		if (kind === 'gap-daily') {
			// The next day boundary when it is within a pause, else a pause on the edge of G.
			const boundary = (Math.floor(last / input.q) + 1) * input.q;
			if (boundary - last <= p && rng.bool(0.7)) return boundary - rng.pick([1, 0, 0]);
		}
		const cap = start + input.q - last;
		const options = [p, p, p + 1, p - 1, rng.int(0, p)];
		if (kind === 'gap-capped' && cap >= 0 && cap <= p) options.push(cap, cap, cap + 1);
		return last + rng.pick(options);
	}
	if (group === 'burst') return last + (rng.bool(0.6) ? 0 : rng.int(1, rng.bool(0.8) ? p : 3 * p));
	return last + (rng.bool(0.75) ? rng.int(0, p) : rng.int(p + 1, 4 * p));
}

/**
 * Intern: the groups of one user, where the capped class never meets its cap — a solution that keeps the state of one
 * user and checks only the pause passes them. The window and the daily classes keep their whole rule there: on such
 * logs the daily class without its day boundary would answer as the capped one, which reads the same header.
 */
const PLAIN: ReadonlySet<GroupId> = new Set(['basic', 'burst']);

function makeInput(rng: Rng, kind: string, group: GroupId, junior: boolean): Input {
	const plain = !junior && PLAIN.has(group);
	const p =
		kind === 'window' ? rng.pick([60, 100, 120, 300, 600, 900, 3600]) : rng.pick([30, 45, 60, 90, 120, 300, 600, 900]);
	const q =
		kind === 'gap-capped' ? p * rng.int(2, 4) + rng.int(0, p - 1) : kind === 'gap-daily' ? p * rng.int(4, 10) : 0;
	const userCount = plain
		? 1
		: group === 'scale'
			? rng.int(100, 180)
			: group === 'interleave'
				? rng.int(6, 10)
				: rng.int(3, 6);
	const perUser = group === 'scale' ? rng.int(14, 20) : plain ? rng.int(5, 10) : rng.int(3, 7);
	const input: Input = { p, q, k: 0, events: [] };
	const logout = (): string => (junior && rng.bool(0.2) ? 'logout' : rng.pick(ACTIONS));
	const timelines = people(rng, userCount).map((user) => {
		// One user of the daily class starts just before a day boundary, so the session meets it.
		const offset =
			plain && kind === 'gap-daily'
				? q * rng.int(1, 3) - rng.int(1, p)
				: group === 'burst'
					? rng.int(0, 3) * p
					: rng.int(0, 5 * p);
		return { user, events: timeline(rng, kind, group, input, user, offset, perUser, logout) };
	});
	if (group === 'basic' && !plain) {
		// A user with a single event: the longest session of the user is 0.
		timelines.push({ user: 'solo', events: [{ t: rng.int(0, 5 * p), user: 'solo', action: rng.pick(ACTIONS) }] });
	}
	if (group === 'burst' && junior) {
		// Two users with the same activity shifted by whole windows, the later name first: they tie on the total.
		const [first, second] = [`z${rng.pick(PERSON_NAMES)}`, `a${rng.pick(PERSON_NAMES)}`];
		const shape = timeline(rng, kind, 'basic', input, first, rng.int(0, 2) * p, rng.int(4, 7), logout);
		const shift = p * rng.int(1, 3);
		timelines.push(
			{ user: first, events: shape },
			{ user: second, events: shape.map((e) => ({ ...e, t: e.t + shift, user: second })) }
		);
	}
	const keyed = timelines.flatMap((line) => line.events.map((e) => ({ e, order: rng.next() })));
	keyed.sort((a, b) => a.e.t - b.e.t || a.order - b.order);
	input.events = keyed.map((x) => x.e);
	if (junior) {
		const users = timelines.length;
		input.k = group === 'burst' ? users + rng.int(0, 5) : rng.int(Math.max(1, users - 3), users + 2);
		if (group === 'scale') input.k = rng.int(10, 30);
	}
	return input;
}

function timeline(
	rng: Rng,
	kind: string,
	group: GroupId,
	input: Input,
	user: string,
	offset: number,
	count: number,
	action: () => string
): Event[] {
	const events: Event[] = [];
	let t = offset;
	let start = offset;
	for (let i = 0; i < count; i += 1) {
		if (i > 0) {
			const next = step(rng, kind, group, input, t, start);
			if (next - t > input.p || next - start > input.q) start = next;
			t = next;
		}
		events.push({ t, user, action: action() });
	}
	return events;
}

/** The wrong solutions a group must expose on every test, by class. */
function traps(kind: string, group: GroupId, junior: boolean): Variant[] {
	switch (group) {
		case 'basic':
			return kind === 'gap-daily' ? ['unclosed-last', 'ignores-day'] : ['unclosed-last'];
		case 'boundary':
			return kind === 'gap-capped'
				? ['gap-edge', 'cap-edge']
				: kind === 'gap-daily'
					? ['gap-edge', 'day-edge']
					: ['boundary'];
		case 'burst':
			return junior ? ['no-tie-break'] : ['unclosed-last'];
		case 'interleave': {
			const own: Variant[] = kind === 'window' ? ['sliding-window'] : ['global-gap'];
			return junior ? [...own, 'ignores-logout'] : own;
		}
		case 'scale':
			return [];
	}
}

/** Hidden tests of the class; every test tells the class from the other rules of the level. */
function groups(rng: Rng, kind: string, others: readonly string[], junior: boolean): HiddenTestGroup[] {
	const ids: GroupId[] = ['basic', 'boundary', 'burst', 'interleave', 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 2 : 4;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${kind}`);
			const input = makeInput(rng, kind, id, junior);
			const expected = solve(kind, input);
			// Classes with two numbers of the rule read a longer header: their tests already break the others' programs.
			const comparable = others.filter((other) => PARAMS[other]?.length === PARAMS[kind]?.length);
			if (comparable.some((other) => solve(other, input) === expected)) continue;
			if (traps(kind, id, junior).some((v) => solve(kind, input, v) === expected)) continue;
			if (!junior && PLAIN.has(id) && kind === 'gap-capped' && solve('gap', input) !== expected) continue;
			tests.push({ stdin: render(kind, input), expected });
		}
		return { id, tests };
	});
}

const RULE: Record<string, string> = {
	gap: 'Событие начинает новую сессию пользователя, если это его первое событие или пауза от предыдущего события **этого же пользователя** больше `G` (пауза ровно `G` сессию не прерывает).',
	window:
		'Время делится на окна `[k·W, (k+1)·W)`, k = 0, 1, 2, … Событие начинает новую сессию пользователя, если это его первое событие или оно попало в другое окно, чем первое событие текущей сессии этого пользователя.',
	'gap-capped':
		'Событие начинает новую сессию пользователя, если это его первое событие, или пауза от предыдущего события **этого же пользователя** больше `G`, или с этим событием длительность текущей сессии стала бы больше `L` (то есть `t − начало сессии > L`). Пауза ровно `G` и длительность ровно `L` сессию не прерывают.',
	'gap-daily':
		'Время делится на сутки `[k·D, (k+1)·D)`, k = 0, 1, 2, … Событие начинает новую сессию пользователя, если это его первое событие, или пауза от предыдущего события **этого же пользователя** больше `G` (пауза ровно `G` сессию не прерывает), или оно попало в другие сутки, чем первое событие текущей сессии: сессия не переходит через границу суток.'
};

const HEAD: Record<string, (junior: boolean) => string> = {
	gap: (junior) =>
		`\`N${junior ? ' K' : ''} G\`: число событий (1 ≤ N ≤ 10 000)${junior ? ', K (1 ≤ K ≤ 1000)' : ''} и предельная пауза в секундах (1 ≤ G ≤ 10⁶).`,
	window: (junior) =>
		`\`N${junior ? ' K' : ''} W\`: число событий (1 ≤ N ≤ 10 000)${junior ? ', K (1 ≤ K ≤ 1000)' : ''} и длина окна в секундах (1 ≤ W ≤ 10⁶).`,
	'gap-capped': (junior) =>
		`\`N${junior ? ' K' : ''} G L\`: число событий (1 ≤ N ≤ 10 000)${junior ? ', K (1 ≤ K ≤ 1000)' : ''}, предельная пауза и предельная длительность сессии в секундах (1 ≤ G ≤ L ≤ 10⁶).`,
	'gap-daily': (junior) =>
		`\`N${junior ? ' K' : ''} G D\`: число событий (1 ≤ N ≤ 10 000)${junior ? ', K (1 ≤ K ≤ 1000)' : ''}, предельная пауза и длина суток в секундах (1 ≤ G ≤ D ≤ 10⁶).`
};

function statement(kind: string, junior: boolean): string {
	return [
		'Сервис аналитики получает журнал действий пользователей и делит его на сессии. Напишите программу, которая читает журнал со стандартного ввода и печатает сводку по сессиям.',
		'',
		'## Вход',
		'',
		`В первой строке — ${HEAD[kind]?.(junior) ?? ''}`,
		'Далее `N` строк `t пользователь действие`: момент в секундах (0 ≤ t ≤ 10⁹), имя пользователя и действие (латинские буквы и цифры без пробелов). Моменты не убывают; события с одинаковым моментом идут в порядке строк.',
		'',
		'## Правило',
		'',
		RULE[kind] ?? '',
		...(junior
			? [
					'Событие с действием `logout` принадлежит текущей сессии и закрывает её: следующее событие этого пользователя начинает новую сессию, какой бы ни была пауза.'
				]
			: ['Действие на деление на сессии не влияет.']),
		'Каждое событие принадлежит ровно одной сессии; сессии разных пользователей независимы. Длительность сессии — разность моментов её последнего и первого события (у сессии из одного события — 0).',
		'',
		'## Выход',
		'',
		junior
			? 'Для каждого пользователя посчитайте суммарную длительность его сессий и число сессий. Выведите K пользователей с наибольшей суммарной длительностью строками `<пользователь> <суммарная длительность> <число сессий>`: по убыванию суммарной длительности, при равенстве — по имени в лексикографическом порядке. Если пользователей меньше K — выведите всех.'
			: 'Для каждого пользователя из журнала выведите строку `<пользователь> <число сессий> <наибольшая длительность сессии>`. Строки — по имени пользователя в лексикографическом порядке.',
		'',
		junior
			? 'Скрытые тесты — пять групп: обычные данные, паузы и моменты точно на границах правила, пачки событий в один момент, много пользователей вперемешку, большой объём. Группа засчитывается, если пройдены все её тесты.'
			: `Скрытые тесты — пять групп. Две простые — журнал одного пользователя: обычные данные и пачки событий в один момент${kind === 'gap-capped' ? '; предел длительности L в них не срабатывает' : ''}. Три полные: паузы и моменты точно на границах правила, много пользователей вперемешку, большой объём. Группа засчитывается, если пройдены все её тесты.`
	].join('\n');
}

/** The reference program of a class in Python; a variant other than `right` is a wrong solution. */
function referenceSource(kind: string, junior: boolean, variant: Variant): string {
	// The state of a user: Intern — sessions, last moment, start, longest; Junior — total, sessions, last moment
	// (None when a logout closed the session), start.
	const [sessions, last, start] = junior ? ['s[1]', 's[2]', 's[3]'] : ['s[0]', 's[1]', 's[2]'];
	const gapOp = variant === 'boundary' ? '>=' : '>';
	const pause = variant === 'global-gap' ? 't - prev' : `t - ${last}`;
	const edge = (x: string): string => (variant === 'boundary' ? `(${x} - 1)` : x);
	const split: Record<string, string> = {
		gap: `${pause} ${gapOp} gap`,
		window: variant === 'sliding-window' ? `t - ${start} >= width` : `${edge('t')} // width != ${edge(start)} // width`,
		'gap-capped': `${pause} ${gapOp} gap or t - ${start} ${gapOp} cap`,
		'gap-daily':
			variant === 'ignores-day'
				? `${pause} > gap`
				: `${pause} ${gapOp} gap or ${edge('t')} // day != ${edge(start)} // day`
	};
	const head = [...(junior ? ['n', 'k'] : ['n']), ...(PARAMS[kind] ?? [])];
	const unclosed = variant === 'unclosed-last';
	// The longest (Intern) or the total (Junior) counted when the session ends: by the next event, or at the end.
	const account = junior
		? unclosed
			? ['        if s[2] is not None:', '            s[0] += s[2] - s[3]']
			: []
		: unclosed
			? ['        if s[1] is not None:', '            s[3] = max(s[3], s[1] - s[2])']
			: [];
	const base = head.length;
	const close = junior && variant !== 'ignores-logout' ? "None if action == 'logout' else t" : 't';
	const sort = variant === 'no-tie-break' ? '-r[1][0]' : '(-r[1][0], r[0])';
	return [
		'import sys',
		'',
		'data = sys.stdin.read().split()',
		`${head.join(', ')} = ${head.map((_, i) => `int(data[${i}])`).join(', ')}`,
		'users = {}',
		...(variant === 'global-gap' ? ['prev = 0'] : []),
		'for i in range(n):',
		junior
			? `    t, user, action = int(data[${base} + 3 * i]), data[${base + 1} + 3 * i], data[${base + 2} + 3 * i]`
			: `    t, user = int(data[${base} + 3 * i]), data[${base + 1} + 3 * i]`,
		`    s = users.setdefault(user, ${junior ? '[0, 0, None, t]' : '[0, None, t, 0]'})`,
		`    if ${last} is None or ${split[kind] ?? ''}:`,
		...account,
		`        ${sessions} += 1`,
		`        ${start} = t`,
		...(unclosed ? [] : junior ? ['    else:', `        s[0] += t - ${last}`] : ['    s[3] = max(s[3], t - s[2])']),
		`    ${last} = ${close}`,
		...(variant === 'global-gap' ? ['    prev = t'] : []),
		...(junior
			? [
					`rows = sorted(users.items(), key=lambda r: ${sort})`,
					'for user, s in rows[:k]:',
					'    print(user, s[0], s[1])'
				]
			: ['for user in sorted(users):', '    print(user, users[user][0], users[user][3])'])
	].join('\n');
}

const PARAMS: Record<string, string[]> = {
	gap: ['gap'],
	window: ['width'],
	'gap-capped': ['gap', 'cap'],
	'gap-daily': ['gap', 'day']
};

const WRONG_IDS = [
	'boundary',
	'global-gap',
	'sliding-window',
	'ignores-logout',
	'no-tie-break',
	'unclosed-last',
	'ignores-day'
] as const;

function applies(id: (typeof WRONG_IDS)[number], kind: string, junior: boolean): boolean {
	switch (id) {
		case 'boundary':
			return true;
		case 'global-gap':
			return kind !== 'window';
		case 'sliding-window':
			return kind === 'window';
		case 'ignores-logout':
		case 'no-tie-break':
			return junior;
		case 'unclosed-last':
			return true;
		case 'ignores-day':
			return kind === 'gap-daily';
	}
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const kind = input.classId;
	const others = level.classes.map((c) => c.id).filter((id) => id !== kind);
	const hidden = groups(rng, kind, others, junior);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(kind, junior), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: hidden, checker: { kind: 'tokens' } }
	});
	return {
		instance,
		reference: () => ({ kind: 'practice', source: referenceSource(kind, junior, 'right'), changeSource: null }),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, kind, junior) ? { kind: 'program' as const, source: referenceSource(kind, junior, id) } : null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
