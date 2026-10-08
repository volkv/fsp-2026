// Practice: a log of user events is split into sessions of each user by the rule the class sets (a pause, an aligned
// window, a pause with a cap on the length, a pause with a day boundary); from Junior up a logout closes the session
// and the answer is the top K by the total length. Parametric hidden tests in five groups.
// The constants of the rule and the order of the printed numbers are the instance's own (`Spec`): they are given only
// in the statement, never in the input, and every hidden test tells them from the other values the family draws, so a
// program written for another instance of the class fails here.
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
/**
 * `p` is G for the pause classes and W for the window; `q` is L of the capped class and the day of the daily one (both
 * the instance's constants, not read from the input); `swap` — the two numbers of a row in the other order; `k` is 0
 * on Intern.
 */
interface Input {
	p: number;
	q: number;
	swap: boolean;
	k: number;
	events: Event[];
}

/** The constants of the instance's specification, stated in the text only. */
interface Spec {
	p: number;
	q: number;
	swap: boolean;
}

/** The menus of the constants, seconds: about a quarter apart; no window is a multiple of another. */
/** Draws of a test that must fail every program of another class before one only has to fail it in its group. */
const STRICT_ATTEMPTS = 1000;

const GAPS = [30, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800] as const;
const WINDOWS = [90, 117, 150, 196, 250, 330, 430, 560, 730, 950] as const;
/** L = ⌊G·m/3⌋ — between G and 3G, never a multiple of G; D = G·m, no day a multiple of another. */
const CAP_THIRDS = [4, 5, 7, 8] as const;
const DAY_TIMES = [4, 5, 6, 7, 9] as const;

const capOf = (gap: number, thirds: number): number => Math.floor((gap * thirds) / 3);

function drawSpec(rng: Rng, kind: string): Spec {
	const p = kind === 'window' ? rng.pick(WINDOWS) : rng.pick(GAPS);
	const q = kind === 'gap-capped' ? capOf(p, rng.pick(CAP_THIRDS)) : kind === 'gap-daily' ? p * rng.pick(DAY_TIMES) : 0;
	return { p, q, swap: rng.bool() };
}

/** Every pair of constants of a class the family draws (in the instance's order of the row). */
function allSpecs(kind: string): Spec[] {
	const gaps = kind === 'window' ? WINDOWS : GAPS;
	return gaps.flatMap((p): Spec[] => {
		if (kind === 'gap-capped') return CAP_THIRDS.map((m) => ({ p, q: capOf(p, m), swap: false }));
		if (kind === 'gap-daily') return DAY_TIMES.map((m) => ({ p, q: p * m, swap: false }));
		return [{ p, q: 0, swap: false }];
	});
}

/** The specifications one constant or the order away from the instance's: a test must tell each of them apart. */
function neighbours(kind: string, spec: Spec): Spec[] {
	const list: Spec[] = [{ ...spec, swap: !spec.swap }];
	for (const p of kind === 'window' ? WINDOWS : GAPS) if (p !== spec.p) list.push({ ...spec, p });
	if (kind === 'gap-capped')
		for (const m of CAP_THIRDS) if (capOf(spec.p, m) !== spec.q) list.push({ ...spec, q: capOf(spec.p, m) });
	if (kind === 'gap-daily') for (const m of DAY_TIMES) if (spec.p * m !== spec.q) list.push({ ...spec, q: spec.p * m });
	return list;
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
		const row = (user: string, s: UserState): string => {
			const best = unclosed ? s.closedBest : s.best;
			return input.swap ? `${user} ${best} ${s.sessions}` : `${user} ${s.sessions} ${best}`;
		};
		return `${rows
			.sort(([a], [b]) => byName(a, b))
			.map(([user, s]) => row(user, s))
			.join('\n')}\n`;
	}
	const total = (s: UserState): number => (unclosed ? s.closedTotal : s.total);
	rows.sort(([a, x], [b, y]) => total(y) - total(x) || (variant === 'no-tie-break' ? 0 : byName(a, b)));
	return `${rows
		.slice(0, input.k)
		.map(([user, s]) => (input.swap ? `${user} ${s.sessions} ${total(s)}` : `${user} ${total(s)} ${s.sessions}`))
		.join('\n')}\n`;
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function render(input: Input): string {
	const head = [input.events.length, ...(input.k > 0 ? [input.k] : [])];
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
	// A pause classes' pause now and then near G, within a quarter of it: one just under G splits the log for any
	// smaller G and one just over for none of the larger, so a program with another G answers otherwise.
	if (kind !== 'window' && rng.bool(0.15)) return last + rng.int(Math.ceil(0.8 * p), Math.floor(1.25 * p));
	if (group === 'burst') return last + (rng.bool(0.6) ? 0 : rng.int(1, rng.bool(0.8) ? p : 3 * p));
	return last + (rng.bool(0.75) ? rng.int(0, p) : rng.int(p + 1, 4 * p));
}

/**
 * Intern: the groups of one user, where the capped class never meets its cap — a solution that keeps the state of one
 * user and checks only the pause passes them. The window and the daily classes keep their whole rule there: on such
 * logs the daily class without its day boundary would answer as the capped one, which reads the same header.
 */
const PLAIN: ReadonlySet<GroupId> = new Set(['basic', 'burst']);

function makeInput(rng: Rng, kind: string, group: GroupId, junior: boolean, spec: Spec): Input {
	const plain = !junior && PLAIN.has(group);
	const { p, q } = spec;
	const userCount = plain
		? 1
		: group === 'scale'
			? rng.int(100, 180)
			: group === 'interleave'
				? rng.int(6, 10)
				: rng.int(3, 6);
	const perUser = group === 'scale' ? rng.int(14, 20) : plain ? rng.int(5, 10) : rng.int(3, 7);
	const input: Input = { p, q, swap: spec.swap, k: 0, events: [] };
	const logout = (): string => (junior && rng.bool(0.2) ? 'logout' : rng.pick(ACTIONS));
	const timelines = people(rng, userCount).map((user) => {
		// One user of the daily class starts just before a day boundary, so the session meets it; now and then the
		// boundary of another length of the day the family draws, so a program with that length meets a boundary it
		// should not.
		const offset =
			plain && kind === 'gap-daily'
				? (rng.bool() ? q : p * rng.pick(DAY_TIMES)) * rng.int(1, 2) - rng.int(1, p)
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

/**
 * Hidden tests of the class; every test tells the class from the other rules of the level, and every group fails a
 * program with a neighbouring constant or the other order: each neighbour is told apart by some test of the group,
 * every test tells apart one not told yet. The capped class meets no cap in the plain groups, so there L is not felt.
 */
function groups(rng: Rng, kind: string, others: readonly string[], junior: boolean, spec: Spec): HiddenTestGroup[] {
	const ids: GroupId[] = ['basic', 'boundary', 'burst', 'interleave', 'scale'];
	// Every class reads the same input, so a program of another class, with any constants it may have, must fail every
	// test; the order of the row is the instance's — another order already fails. A rare instance whose short logs keep
	// meeting some of them after many draws settles for failing them in every group, as a neighbour. The pause classes nest: with the same
	// G, each answers as another wherever the second constant of either is not met, which a test cannot always avoid
	// (the plain groups of Intern are built so), so a pause class with the same G is not compared.
	const pauses = new Set(['gap', 'gap-capped', 'gap-daily']);
	const nested = (other: string): boolean => pauses.has(kind) && pauses.has(other);
	const rivals = others.flatMap((other) =>
		allSpecs(other)
			.filter((s) => !(nested(other) && s.p === spec.p))
			.map((s) => ({ kind: other, spec: { ...s, swap: spec.swap } }))
	);
	return ids.map((id) => {
		const count = id === 'scale' ? 2 : 4;
		const capless = !junior && PLAIN.has(id) && kind === 'gap-capped';
		const open = neighbours(kind, spec)
			.filter((n) => !capless || n.q === spec.q)
			.map((n) => ({ kind, spec: n }));
		let rivalsOpen = [...rivals];
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 2000)
				throw new Error(
					`${descriptor.key}: no distinguishing ${id} test for ${kind}${open.length > 0 ? ` (${JSON.stringify(spec)} not told from ${JSON.stringify(open.slice(0, 5))})` : ''}`
				);
			const input = makeInput(rng, kind, id, junior, spec);
			const expected = solve(kind, input);
			const strict = attempt < STRICT_ATTEMPTS;
			if (strict && rivals.some((r) => solve(r.kind, { ...input, ...r.spec }) === expected)) continue;
			if (traps(kind, id, junior).some((v) => solve(kind, input, v) === expected)) continue;
			if (capless && solve('gap', input) !== expected) continue;
			const pending = strict ? open : [...open, ...rivalsOpen];
			const told = pending.filter((n) => solve(n.kind, { ...input, ...n.spec }) !== expected);
			if (pending.length > 0 && told.length === 0) continue;
			if (tests.length === count - 1 && told.length < pending.length) continue;
			for (const n of told) if (open.includes(n)) open.splice(open.indexOf(n), 1);
			rivalsOpen = strict ? [] : rivalsOpen.filter((r) => !told.includes(r));
			tests.push({ stdin: render(input), expected });
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

/** The constants of the rule of the instance, as the statement gives them. */
function constants(kind: string, spec: Spec): string {
	const gap = `предельная пауза **G = ${spec.p} с**`;
	if (kind === 'window') return `длина окна **W = ${spec.p} с**`;
	if (kind === 'gap-capped') return `${gap}, предельная длительность сессии **L = ${spec.q} с**`;
	if (kind === 'gap-daily') return `${gap}, длина суток **D = ${spec.q} с**`;
	return gap;
}

function statement(kind: string, junior: boolean, spec: Spec): string {
	const row = junior
		? spec.swap
			? '`<пользователь> <число сессий> <суммарная длительность>`'
			: '`<пользователь> <суммарная длительность> <число сессий>`'
		: spec.swap
			? '`<пользователь> <наибольшая длительность сессии> <число сессий>`'
			: '`<пользователь> <число сессий> <наибольшая длительность сессии>`';
	return [
		'Сервис аналитики получает журнал действий пользователей и делит его на сессии. Напишите программу, которая читает журнал со стандартного ввода и печатает сводку по сессиям.',
		'',
		`Параметры правила этого сервиса: ${constants(kind, spec)}; во входе их нет.`,
		'',
		'## Вход',
		'',
		junior
			? 'В первой строке — `N K`: число событий (1 ≤ N ≤ 10 000) и K (1 ≤ K ≤ 1000).'
			: 'В первой строке — `N`: число событий (1 ≤ N ≤ 10 000).',
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
			? `Для каждого пользователя посчитайте суммарную длительность его сессий и число сессий. Выведите K пользователей с наибольшей суммарной длительностью строками ${row}: по убыванию суммарной длительности, при равенстве — по имени в лексикографическом порядке. Если пользователей меньше K — выведите всех.`
			: `Для каждого пользователя из журнала выведите строку ${row}. Строки — по имени пользователя в лексикографическом порядке.`,
		'',
		junior
			? 'Скрытые тесты — пять групп: обычные данные, паузы и моменты точно на границах правила, пачки событий в один момент, много пользователей вперемешку, большой объём. Группа засчитывается, если пройдены все её тесты.'
			: `Скрытые тесты — пять групп. Две простые — журнал одного пользователя: обычные данные и пачки событий в один момент${kind === 'gap-capped' ? '; предел длительности L в них не срабатывает' : ''}. Три полные: паузы и моменты точно на границах правила, много пользователей вперемешку, большой объём. Группа засчитывается, если пройдены все её тесты.`
	].join('\n');
}

/** The reference program of a class in Python; a variant other than `right` is a wrong solution. */
function referenceSource(kind: string, junior: boolean, spec: Spec, variant: Variant): string {
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
	const head = junior ? ['n', 'k'] : ['n'];
	const names = PARAMS[kind] ?? [];
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
		`${names.join(', ')} = ${[spec.p, spec.q].slice(0, names.length).join(', ')}`,
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
					spec.swap ? '    print(user, s[1], s[0])' : '    print(user, s[0], s[1])'
				]
			: [
					'for user in sorted(users):',
					spec.swap
						? '    print(user, users[user][3], users[user][0])'
						: '    print(user, users[user][0], users[user][3])'
				])
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
	const spec = drawSpec(rng, kind);
	const others = level.classes.map((c) => c.id).filter((id) => id !== kind);
	const hidden = groups(rng, kind, others, junior, spec);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(kind, junior, spec), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: hidden, checker: { kind: 'tokens' } }
	});
	return {
		instance,
		reference: () => ({ kind: 'practice', source: referenceSource(kind, junior, spec, 'right'), changeSource: null }),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, kind, junior)
						? { kind: 'program' as const, source: referenceSource(kind, junior, spec, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
