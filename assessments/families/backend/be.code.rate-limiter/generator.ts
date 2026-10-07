// Practice: a per-client rate limiter over a log of requests, by the algorithm the class sets (fixed window, sliding
// log, token bucket, sliding window counter); Senior requests carry a cost. The step «измени своё решение» adds a global limit on top.
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
const CHANGE_WEIGHT = 0.3;

const descriptor = readDescriptor(import.meta.url);

interface Request {
	t: number;
	client: string;
	cost: number;
}
interface Input {
	limit: number;
	period: number;
	global: number | null;
	requests: Request[];
}

type Variant = 'right' | 'denied-counts' | 'window-edge' | 'shared-limit';

interface Limiter {
	allows(t: number, cost: number): boolean;
	take(t: number, cost: number): void;
}

function limiter(kind: string, limit: number, period: number, edge = false): Limiter {
	if (kind === 'fixed-window') {
		let window: number | null = null;
		let used = 0;
		return {
			allows(t, cost) {
				const w = Math.floor((edge ? t - 1 : t) / period);
				if (w !== window) {
					window = w;
					used = 0;
				}
				return used + cost <= limit;
			},
			take(_t, cost) {
				used += cost;
			}
		};
	}
	if (kind === 'sliding-counter') {
		// The count of the current window and the previous one, weighted by its share still within the last period.
		let window = 0;
		let prev = 0;
		let used = 0;
		return {
			allows(t, cost) {
				const w = Math.floor(t / period);
				if (w !== window) {
					prev = w === window + 1 ? used : 0;
					window = w;
					used = 0;
				}
				const load = prev * (period - (t % period)) + (used + cost) * period;
				return edge ? load < limit * period : load <= limit * period;
			},
			take(_t, cost) {
				used += cost;
			}
		};
	}
	if (kind === 'sliding-log') {
		const log: Request[] = [];
		let used = 0;
		return {
			allows(t, cost) {
				const stale = (first: number): boolean => (edge ? first < t - period : first <= t - period);
				while (log.length > 0 && stale(log[0]?.t ?? 0)) used -= log.shift()?.cost ?? 0;
				return used + cost <= limit;
			},
			take(t, cost) {
				log.push({ t, client: '', cost });
				used += cost;
			}
		};
	}
	let start: number | null = null;
	let tokens = limit;
	let ticks = 0;
	return {
		allows(t, cost) {
			start ??= t;
			const now = edge ? Math.ceil((t - start) / period) : Math.floor((t - start) / period);
			tokens = Math.min(limit, tokens + now - ticks);
			ticks = now;
			return tokens >= cost;
		},
		take(_t, cost) {
			tokens -= cost;
		}
	};
}

/** The decisions of the gateway; a variant other than `right` reproduces a wrong solution. */
function simulate(kind: string, input: Input, variant: Variant = 'right'): string {
	const edge = variant === 'window-edge';
	const clients = new Map<string, Limiter>();
	const global = input.global === null ? null : limiter(kind, input.global, input.period, edge);
	const out: string[] = [];
	for (const r of input.requests) {
		const key = variant === 'shared-limit' ? '*' : r.client;
		let own = clients.get(key);
		if (!own) {
			own = limiter(kind, input.limit, input.period, edge);
			clients.set(key, own);
		}
		const a = own.allows(r.t, r.cost);
		const b = global ? global.allows(r.t, r.cost) : true;
		if ((a && b) || variant === 'denied-counts') own.take(r.t, r.cost);
		if (a && b) global?.take(r.t, r.cost);
		out.push(a && b ? 'allow' : 'deny');
	}
	return `${out.join('\n')}\n`;
}

function render(input: Input, senior: boolean): string {
	const head = [
		input.requests.length,
		input.limit,
		input.period,
		...(input.global === null ? [] : [input.global])
	].join(' ');
	return `${[head, ...input.requests.map((r) => (senior ? `${r.t} ${r.client} ${r.cost}` : `${r.t} ${r.client}`))].join('\n')}\n`;
}

type GroupId = 'basic' | 'boundary' | 'burst' | 'clients' | 'scale';

/**
 * Senior: the groups a partly right solution passes — every cost is 1 and no decision rests on the exact edge of the
 * rule. They still cross windows: on a log inside one window every algorithm gives the same answers.
 */
const PLAIN: ReadonlySet<GroupId> = new Set(['basic', 'clients']);

function makeInput(rng: Rng, group: GroupId, senior: boolean, withGlobal: boolean): Input {
	const period = rng.pick([100, 200, 250, 500, 1000]);
	// Unit requests need a small limit to meet it.
	const limit = senior && !PLAIN.has(group) ? rng.int(4, 10) : rng.int(2, 5);
	const clientCount =
		group === 'scale' ? rng.int(20, senior ? 60 : 40) : group === 'clients' ? rng.int(4, 7) : rng.int(1, 4);
	const people: string[] = rng.sample(PERSON_NAMES, Math.min(clientCount, PERSON_NAMES.length));
	while (people.length < clientCount) people.push(`${rng.pick(PERSON_NAMES)}${people.length}`);
	const n = group === 'scale' ? rng.int(1200, 1700) : group === 'clients' ? rng.int(24, 36) : rng.int(12, 30);
	const requests: Request[] = [];
	let t = group === 'boundary' ? period * rng.int(0, 3) : rng.int(0, period * 3);
	for (let i = 0; i < n; i += 1) {
		if (group === 'boundary') t += rng.pick([0, 0, period, period, period - 1, 1]);
		else if (group === 'burst') t += rng.bool(0.7) ? 0 : rng.int(1, period * 2);
		else t += rng.int(0, Math.floor(period / 2));
		requests.push({ t, client: rng.pick(people), cost: senior && !PLAIN.has(group) ? rng.int(1, 3) : 1 });
	}
	const global = withGlobal ? limit + rng.int(1, limit) : null;
	return { limit, period, global, requests };
}

/**
 * Whether counting denied requests changes any decision: in a fixed window of unit requests a denied request comes
 * only after the window is full, so it changes nothing; a token bucket takes no token for a denied request by its
 * nature. Both have no such mistake to catch.
 */
function deniedCountsApplies(kind: string, senior: boolean): boolean {
	return kind === 'sliding-log' || kind === 'sliding-counter' || (kind === 'fixed-window' && senior);
}

/**
 * Whether a decision rests on the exact edge of the rule. A token bucket refilled from the start of its period instead
 * of the end differs on almost any log, so for it the edge is a request exactly at a refill moment of its client.
 */
function onEdge(kind: string, input: Input, expected: string): boolean {
	if (kind !== 'token-bucket') return simulate(kind, input, 'window-edge') !== expected;
	const first = new Map<string, number>();
	return input.requests.some((r) => {
		const t0 = first.get(r.client);
		if (t0 === undefined) first.set(r.client, r.t);
		return t0 !== undefined && r.t > t0 && (r.t - t0) % input.period === 0;
	});
}

/** Hidden tests of the class; every test tells the class from the other algorithms. */
function groups(
	rng: Rng,
	kind: string,
	others: readonly string[],
	senior: boolean,
	withGlobal: boolean
): HiddenTestGroup[] {
	const ids: GroupId[] = ['basic', 'boundary', 'burst', 'clients', 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 2 : 4;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${kind}`);
			const input = makeInput(rng, id, senior, withGlobal);
			const expected = simulate(kind, input);
			if (others.some((other) => simulate(other, input) === expected)) continue;
			if (withGlobal && simulate(kind, { ...input, global: null }) === expected) continue;
			if (senior && PLAIN.has(id) && onEdge(kind, input, expected)) continue;
			// Each group exposes its own mistake on every test: the edge of the period, a denied request in a burst, one
			// limit for many clients.
			if (!withGlobal && id === 'boundary' && simulate(kind, input, 'window-edge') === expected) continue;
			if (!withGlobal && id === 'clients' && simulate(kind, input, 'shared-limit') === expected) continue;
			if (
				!withGlobal &&
				id === 'burst' &&
				deniedCountsApplies(kind, senior) &&
				simulate(kind, input, 'denied-counts') === expected
			)
				continue;
			tests.push({ stdin: render(input, senior), expected });
		}
		return { id, tests };
	});
}

const RULE: Record<string, (senior: boolean) => string> = {
	'fixed-window': (senior) =>
		`Время делится на окна [k·P, (k+1)·P) мс, k = 0, 1, 2, … Запрос клиента в момент t разрешается, если ${senior ? 'сумма стоимостей разрешённых запросов этого клиента в окне, содержащем t, вместе со стоимостью запроса не больше L' : 'в окне, содержащем t, у этого клиента меньше L разрешённых запросов'}.`,
	'sliding-log': (senior) =>
		`Запрос клиента в момент t разрешается, если ${senior ? 'сумма стоимостей его разрешённых запросов с моментами в полуинтервале (t − P, t] вместе со стоимостью запроса не больше L' : 'у этого клиента меньше L разрешённых запросов с моментами в полуинтервале (t − P, t]'}.`,
	'token-bucket': (senior) =>
		`У каждого клиента — ведро ёмкостью L токенов, при первом запросе клиента в момент t₀ ведро полное. В моменты t₀ + P, t₀ + 2P, … в ведро добавляется один токен, если оно не полное. Запрос ${senior ? 'со стоимостью c разрешается, если в ведре не меньше c токенов, и забирает c токенов' : 'разрешается, если в ведре есть токен, и забирает один токен'}. Запросы в момент пополнения видят уже пополненное ведро.`,
	'sliding-counter': (senior) =>
		[
			`Время делится на окна [k·P, (k+1)·P) мс, k = 0, 1, 2, … Для каждого клиента храните номер текущего окна k, cur — ${senior ? 'сумму стоимостей его разрешённых запросов' : 'число его разрешённых запросов'} в окне k и prev — то же в окне k − 1. Запрос${senior ? ' со стоимостью c' : ''} в момент t обрабатывается так (всё в целых числах):`,
			'',
			'1. `k = t div P`, `e = t mod P` — сколько миллисекунд прошло от начала окна.',
			'2. Если k больше номера окна клиента: `prev = cur`, если новое окно — следующее за прежним (k = прежнее + 1), иначе `prev = 0`; затем `cur = 0`. До первого запроса клиента окно — 0, prev = cur = 0.',
			`3. Запрос разрешается, если \`prev·(P − e) + (cur + ${senior ? 'c' : '1'})·P ≤ L·P\` (равенство разрешает): прошлое окно входит с долей (P − e)/P — той, что ещё попадает в последние P мс. Разрешённый запрос увеличивает cur на ${senior ? 'c' : '1'}.`,
			'',
			`Пример: P = 1000, L = 5, у клиента в окне [0, 1000) разрешено на prev = 4, в окне [1000, 2000) — на cur = 1. Запрос${senior ? ' со стоимостью c = 1' : ''} в момент t = 1250: e = 250, 4·(1000 − 250) + (1 + 1)·1000 = 3000 + 2000 = 5000 ≤ 5000 — разрешён. Тот же запрос в момент t = 1249: e = 249, 4·751 + 2000 = 5004 > 5000 — отклонён.`
		].join('\n')
};

function statement(kind: string, senior: boolean): string {
	return [
		'Шлюз API ограничивает частоту запросов каждого клиента. Напишите программу, которая по журналу запросов решает, какие из них шлюз пропустит.',
		'',
		'## Вход',
		'',
		'В первой строке — `N L P`: число запросов (1 ≤ N ≤ 2000), лимит и период в миллисекундах (1 ≤ L ≤ 100, 1 ≤ P ≤ 10⁴).',
		senior
			? 'Далее `N` строк `t клиент c`: момент запроса в мс (0 ≤ t ≤ 10⁹, моменты не убывают), имя клиента (латинские буквы и цифры) и стоимость запроса (1 ≤ c ≤ L).'
			: 'Далее `N` строк `t клиент`: момент запроса в мс (0 ≤ t ≤ 10⁹, моменты не убывают) и имя клиента (латинские буквы и цифры).',
		'Запросы с одинаковым моментом обрабатываются в порядке строк.',
		'',
		'## Правило',
		'',
		RULE[kind]?.(senior) ?? '',
		'Отклонённый запрос лимит не расходует. Лимиты разных клиентов независимы.',
		'',
		'## Выход',
		'',
		'`N` строк: `allow` или `deny` для каждого запроса по порядку.',
		'',
		senior
			? 'Скрытые тесты — пять групп разной сложности. Две простые — обычные данные и много клиентов вперемешку: все стоимости в них равны 1 и ни одно решение не зависит от точного равенства на границе правила. Три полные, со стоимостями: запросы точно на границах периода, пачки одновременных запросов, большой объём. Группа засчитывается, если пройдены все её тесты.'
			: 'Скрытые тесты — пять групп: обычные данные, запросы точно на границах периода, пачки одновременных запросов, много клиентов вперемешку, большой объём. Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

function changeStatement(kind: string, senior: boolean): string {
	return [
		'**Новое условие.** Поверх лимита каждого клиента шлюз держит общий лимит `G` на всех клиентов вместе — по тому же правилу, что и лимит клиента, с `G` вместо `L`' +
			(kind === 'token-bucket'
				? ' (общее ведро ёмкостью `G`, отсчёт пополнений — от самого первого запроса в журнале).'
				: kind === 'sliding-counter'
					? ' (общие cur и prev по разрешённым запросам всех клиентов).'
					: '.'),
		`Запрос разрешается, только если его разрешают и лимит клиента, и общий лимит${senior ? ' (с той же стоимостью)' : ''}; разрешённый запрос расходует оба, отклонённый — ни один.`,
		'Первая строка входа теперь `N L P G` (1 ≤ G ≤ 1000). Измените решение и отправьте его снова; формат вывода прежний.'
	].join('\n');
}

/** The reference program in Python; a variant other than `right` is a wrong solution. */
function referenceSource(kind: string, senior: boolean, withGlobal: boolean, variant: Variant): string {
	const fixedWindow = variant === 'window-edge' ? '(t - 1) // self.period' : 't // self.period';
	const slidingDrop = variant === 'window-edge' ? '<' : '<=';
	const ticks =
		variant === 'window-edge' ? '(t - self.start + self.period - 1) // self.period' : '(t - self.start) // self.period';
	const body: Record<string, string[]> = {
		'fixed-window': [
			'class Limiter:',
			'    def __init__(self, limit, period):',
			'        self.limit, self.period, self.window, self.used = limit, period, None, 0',
			'    def allows(self, t, cost):',
			`        w = ${fixedWindow}`,
			'        if w != self.window:',
			'            self.window, self.used = w, 0',
			'        return self.used + cost <= self.limit',
			'    def take(self, t, cost):',
			'        self.used += cost'
		],
		'sliding-log': [
			'from collections import deque',
			'',
			'class Limiter:',
			'    def __init__(self, limit, period):',
			'        self.limit, self.period, self.log, self.used = limit, period, deque(), 0',
			'    def allows(self, t, cost):',
			`        while self.log and self.log[0][0] ${slidingDrop} t - self.period:`,
			'            self.used -= self.log.popleft()[1]',
			'        return self.used + cost <= self.limit',
			'    def take(self, t, cost):',
			'        self.log.append((t, cost))',
			'        self.used += cost'
		],
		'sliding-counter': [
			'class Limiter:',
			'    def __init__(self, limit, period):',
			'        self.limit, self.period, self.window, self.prev, self.used = limit, period, 0, 0, 0',
			'    def allows(self, t, cost):',
			'        w = t // self.period',
			'        if w != self.window:',
			'            self.prev = self.used if w == self.window + 1 else 0',
			'            self.window, self.used = w, 0',
			'        load = self.prev * (self.period - t % self.period) + (self.used + cost) * self.period',
			`        return load ${variant === 'window-edge' ? '<' : '<='} self.limit * self.period`,
			'    def take(self, t, cost):',
			'        self.used += cost'
		],
		'token-bucket': [
			'class Limiter:',
			'    def __init__(self, limit, period):',
			'        self.limit, self.period, self.start, self.tokens, self.ticks = limit, period, None, limit, 0',
			'    def allows(self, t, cost):',
			'        if self.start is None:',
			'            self.start = t',
			`        ticks = ${ticks}`,
			'        self.tokens = min(self.limit, self.tokens + ticks - self.ticks)',
			'        self.ticks = ticks',
			'        return self.tokens >= cost',
			'    def take(self, t, cost):',
			'        self.tokens -= cost'
		]
	};
	const takeOwn = variant === 'denied-counts' ? '    own.take(t, cost)' : '    if ok:\n        own.take(t, cost)';
	return [
		'import sys',
		'',
		...(body[kind] ?? []),
		'',
		'data = sys.stdin.read().split()',
		'n, limit, period = int(data[0]), int(data[1]), int(data[2])',
		withGlobal ? 'glob = Limiter(int(data[3]), period)' : 'glob = None',
		`pos = ${withGlobal ? 4 : 3}`,
		'clients = {}',
		'out = []',
		'for i in range(n):',
		senior
			? '    t, client, cost = int(data[pos]), data[pos + 1], int(data[pos + 2])'
			: '    t, client, cost = int(data[pos]), data[pos + 1], 1',
		`    pos += ${senior ? 3 : 2}`,
		variant === 'shared-limit' ? "    client = '*'" : '',
		'    own = clients.get(client)',
		'    if own is None:',
		'        own = clients[client] = Limiter(limit, period)',
		'    a = own.allows(t, cost)',
		'    b = glob.allows(t, cost) if glob is not None else True',
		'    ok = a and b',
		takeOwn,
		'    if ok and glob is not None:',
		'        glob.take(t, cost)',
		"    out.append('allow' if ok else 'deny')",
		"print('\\n'.join(out))"
	]
		.filter((line, i, all) => line !== '' || all[i - 1] !== '')
		.join('\n');
}

const WRONG_IDS: readonly Variant[] = ['denied-counts', 'window-edge', 'shared-limit'];

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	const kind = input.classId;
	const others = level.classes.map((c) => c.id).filter((id) => id !== kind);
	const main = groups(rng, kind, others, senior, false);
	const step = groups(rng, kind, others, senior, true);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(kind, senior), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: main, checker: { kind: 'tokens' } },
		changeStep: { markdown: changeStatement(kind, senior), weight: CHANGE_WEIGHT, answer: null, groups: step, qa: null }
	});
	return {
		instance,
		reference: () => ({
			kind: 'practice',
			source: referenceSource(kind, senior, false, 'right'),
			changeSource: referenceSource(kind, senior, true, 'right')
		}),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					id === 'denied-counts' && !deniedCountsApplies(kind, senior)
						? null
						: { kind: 'program' as const, source: referenceSource(kind, senior, false, id) }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
