// Practice: a per-client rate limiter over a log of requests, by the algorithm the class sets (fixed window, sliding
// log, token bucket, sliding window counter); Senior requests carry a cost. The step «измени своё решение» adds a global limit on top.
// The period of the limit and the words of the verdicts are the instance's own (`Spec`): they are given only in the
// statement, never in the input, and every hidden test tells the period from any other the family draws, so a
// program written for another instance of the class fails here.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type HiddenTestGroup,
	readDescriptor,
	type GenerateInput,
	type ItemInstance,
	type WrongProbe
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
	global: number | null;
	requests: Request[];
}

/** The constants of the instance's specification, stated in the text only. */
interface Spec {
	/** The period of the limit, ms: about a quarter apart, each divisible by 4 for the example of the sliding counter. */
	period: number;
	/** The words printed for an allowed and a denied request. */
	verdicts: readonly [string, string];
}

const PERIODS = [96, 120, 152, 192, 240, 300, 380, 480, 600, 760, 960] as const;
const VERDICTS: readonly (readonly [string, string])[] = [
	['allow', 'deny'],
	['ok', 'limited'],
	['pass', 'drop'],
	['200', '429'],
	['accept', 'reject'],
	['yes', 'no']
];

function drawSpec(rng: Rng): Spec {
	return { period: rng.pick(PERIODS), verdicts: rng.pick(VERDICTS) };
}

type Variant =
	'right' | 'denied-counts' | 'window-edge' | 'shared-limit' | 'continuous-refill' | 'own-spent-on-global-deny';

interface Limiter {
	allows(t: number, cost: number): boolean;
	take(t: number, cost: number): void;
}

function limiter(kind: string, limit: number, period: number, edge = false, continuous = false): Limiter {
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
	if (continuous) {
		// The usual lazy bucket: tokens grow with time since the last request, a token per P ms, in P-ths of a token.
		let last: number | null = null;
		let parts = limit * period;
		return {
			allows(t, cost) {
				parts = Math.min(limit * period, parts + t - (last ?? t));
				last = t;
				return parts >= cost * period;
			},
			take(_t, cost) {
				parts -= cost * period;
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

/**
 * The decisions of the gateway with the period `period`, one character a request (`+` allowed, `-` denied); a variant
 * other than `right` reproduces a wrong solution.
 */
function simulate(kind: string, input: Input, period: number, variant: Variant = 'right'): string {
	const edge = variant === 'window-edge';
	const continuous = variant === 'continuous-refill';
	const clients = new Map<string, Limiter>();
	const global = input.global === null ? null : limiter(kind, input.global, period, edge, continuous);
	const out: string[] = [];
	for (const r of input.requests) {
		const key = variant === 'shared-limit' ? '*' : r.client;
		let own = clients.get(key);
		if (!own) {
			own = limiter(kind, input.limit, period, edge, continuous);
			clients.set(key, own);
		}
		const a = own.allows(r.t, r.cost);
		const b = global ? global.allows(r.t, r.cost) : true;
		// The wrong revision of the step spends the client's limit when the client's rule allows, before the global one.
		if ((a && b) || variant === 'denied-counts' || (variant === 'own-spent-on-global-deny' && a)) own.take(r.t, r.cost);
		if (a && b) global?.take(r.t, r.cost);
		out.push(a && b ? '+' : '-');
	}
	return out.join('');
}

/** The expected output of decisions in the words of the instance. */
function printed(decisions: string, spec: Spec): string {
	return decisions.replace(/[+-]/g, (d) => `${d === '+' ? spec.verdicts[0] : spec.verdicts[1]}\n`);
}

function render(input: Input, senior: boolean): string {
	const head = [input.requests.length, input.limit, ...(input.global === null ? [] : [input.global])].join(' ');
	return `${[head, ...input.requests.map((r) => (senior ? `${r.t} ${r.client} ${r.cost}` : `${r.t} ${r.client}`))].join('\n')}\n`;
}

type GroupId = 'basic' | 'boundary' | 'burst' | 'clients' | 'scale';

/**
 * Senior: the groups a partly right solution passes — every cost is 1 and no decision rests on the exact edge of the
 * rule. They still cross windows: on a log inside one window every algorithm gives the same answers.
 */
const PLAIN: ReadonlySet<GroupId> = new Set(['basic', 'clients']);

function makeInput(
	rng: Rng,
	kind: string,
	group: GroupId,
	senior: boolean,
	withGlobal: boolean,
	period: number
): Input {
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
		// A step inside the period now and then: on steps of whole periods alone a period that divides P answers the same.
		if (group === 'boundary') t += rng.pick([0, 0, period, period, period - 1, 1, rng.int(2, period - 2)]);
		else if (group === 'burst') t += rng.bool(0.7) ? 0 : rng.int(1, period * 2);
		else t += rng.int(0, Math.floor(period / 2));
		requests.push({ t, client: rng.pick(people), cost: senior && !PLAIN.has(group) ? rng.int(1, 3) : 1 });
	}
	if (kind === 'token-bucket' && rng.bool(0.5)) {
		// A client that empties its bucket half a period after its first request and comes back just after the first
		// refill: the grid gives a token, a bucket refilled continuously from the last request does not.
		const t0 = rng.pick(requests).t;
		const half = t0 + Math.floor(period / 2);
		const client = `${rng.pick(PERSON_NAMES)}${rng.int(100, 999)}`;
		requests.push({ t: t0, client, cost: 1 });
		for (let i = 0; i < limit; i += 1) requests.push({ t: half, client, cost: 1 });
		requests.push({ t: t0 + period + rng.int(0, Math.floor(period / 4)), client, cost: 1 });
		requests.sort((a, b) => a.t - b.t);
	}
	const global = withGlobal ? limit + rng.int(1, limit) : null;
	return { limit, global, requests };
}

/**
 * Whether counting denied requests changes any decision: in a fixed window of unit requests a denied request comes
 * only after the window is full, so it changes nothing — that one has no such mistake to catch. A token bucket that
 * takes the cost of a denied request goes below zero and refuses the next ones longer.
 */
function deniedCountsApplies(kind: string, senior: boolean): boolean {
	return kind !== 'fixed-window' || senior;
}

/**
 * Whether spending a client's limit on a request the global limit denies changes any decision: in a fixed window of
 * unit requests the global window is full until it ends, and the client's window ends with it, so it changes nothing.
 */
function ownSpentApplies(kind: string, senior: boolean): boolean {
	return kind !== 'fixed-window' || senior;
}

/**
 * Whether a decision rests on the exact edge of the rule. A token bucket refilled from the start of its period instead
 * of the end differs on almost any log, so for it the edge is a request exactly at a refill moment of its client.
 */
function onEdge(kind: string, input: Input, period: number, expected: string): boolean {
	if (kind !== 'token-bucket') return simulate(kind, input, period, 'window-edge') !== expected;
	const first = new Map<string, number>();
	return input.requests.some((r) => {
		const t0 = first.get(r.client);
		if (t0 === undefined) first.set(r.client, r.t);
		return t0 !== undefined && r.t > t0 && (r.t - t0) % period === 0;
	});
}

/** Hidden tests of the class; every test tells the class from the other algorithms and the period from the others. */
function groups(
	rng: Rng,
	kind: string,
	others: readonly string[],
	senior: boolean,
	withGlobal: boolean,
	spec: Spec
): HiddenTestGroup[] {
	const { period } = spec;
	const otherPeriods = PERIODS.filter((p) => p !== period);
	const ids: GroupId[] = ['basic', 'boundary', 'burst', 'clients', 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 2 : 4;
		const tests: { stdin: string; expected: string }[] = [];
		let lazyCaught = false;
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 2000) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${kind}`);
			const input = makeInput(rng, kind, id, senior, withGlobal, period);
			const expected = simulate(kind, input, period);
			if (others.some((other) => simulate(other, input, period) === expected)) continue;
			if (otherPeriods.some((p) => simulate(kind, input, p) === expected)) continue;
			if (withGlobal && simulate(kind, { ...input, global: null }, period) === expected) continue;
			if (senior && PLAIN.has(id) && onEdge(kind, input, period, expected)) continue;
			// The usual lazy bucket instead of the grid of refills fails some test of every group of the task: it scores at
			// most the step's weight, under the gate. In the step the global bucket is mostly empty, so there it often
			// answers as the grid.
			const lazy =
				!withGlobal && kind === 'token-bucket' && simulate(kind, input, period, 'continuous-refill') !== expected;
			if (!withGlobal && kind === 'token-bucket' && !lazyCaught && !lazy && tests.length === count - 1) continue;
			// Each group exposes its own mistake on every test: the edge of the period, a denied request in a burst, one
			// limit for many clients.
			if (!withGlobal && id === 'boundary' && simulate(kind, input, period, 'window-edge') === expected) continue;
			if (!withGlobal && id === 'clients' && simulate(kind, input, period, 'shared-limit') === expected) continue;
			// The step: a global limit that denies what a client's allows — many clients, or Senior's costs at scale.
			if (
				withGlobal &&
				id === (senior ? 'scale' : 'clients') &&
				ownSpentApplies(kind, senior) &&
				simulate(kind, input, period, 'own-spent-on-global-deny') === expected
			)
				continue;
			if (
				!withGlobal &&
				id === 'burst' &&
				deniedCountsApplies(kind, senior) &&
				simulate(kind, input, period, 'denied-counts') === expected
			)
				continue;
			lazyCaught ||= lazy;
			tests.push({ stdin: render(input, senior), expected: printed(expected, spec) });
		}
		return { id, tests };
	});
}

const RULE: Record<string, (senior: boolean, period: number) => string> = {
	'fixed-window': (senior) =>
		`Время делится на окна [k·P, (k+1)·P) мс, k = 0, 1, 2, … Запрос клиента в момент t разрешается, если ${senior ? 'сумма стоимостей разрешённых запросов этого клиента в окне, содержащем t, вместе со стоимостью запроса не больше L' : 'в окне, содержащем t, у этого клиента меньше L разрешённых запросов'}.`,
	'sliding-log': (senior) =>
		`Запрос клиента в момент t разрешается, если ${senior ? 'сумма стоимостей его разрешённых запросов с моментами в полуинтервале (t − P, t] вместе со стоимостью запроса не больше L' : 'у этого клиента меньше L разрешённых запросов с моментами в полуинтервале (t − P, t]'}.`,
	'token-bucket': (senior) =>
		`У каждого клиента — ведро ёмкостью L токенов, при первом запросе клиента в момент t₀ ведро полное. В моменты t₀ + P, t₀ + 2P, … в ведро добавляется один токен, если оно не полное. Запрос ${senior ? 'со стоимостью c разрешается, если в ведре не меньше c токенов, и забирает c токенов' : 'разрешается, если в ведре есть токен, и забирает один токен'}. Запросы в момент пополнения видят уже пополненное ведро.`,
	'sliding-counter': (senior, period) => {
		// The worked example: L = 5, four allowed in the previous window, one in the current; a request a quarter of the
		// period into the window reaches the limit exactly, one millisecond earlier it passes it.
		const e = period / 4;
		const t = period + e;
		return [
			`Время делится на окна [k·P, (k+1)·P) мс, k = 0, 1, 2, … Для каждого клиента храните номер текущего окна k, cur — ${senior ? 'сумму стоимостей его разрешённых запросов' : 'число его разрешённых запросов'} в окне k и prev — то же в окне k − 1. Запрос${senior ? ' со стоимостью c' : ''} в момент t обрабатывается так (всё в целых числах):`,
			'',
			'1. `k = t div P`, `e = t mod P` — сколько миллисекунд прошло от начала окна.',
			'2. Если k больше номера окна клиента: `prev = cur`, если новое окно — следующее за прежним (k = прежнее + 1), иначе `prev = 0`; затем `cur = 0`. До первого запроса клиента окно — 0, prev = cur = 0.',
			`3. Запрос разрешается, если \`prev·(P − e) + (cur + ${senior ? 'c' : '1'})·P ≤ L·P\` (равенство разрешает): прошлое окно входит с долей (P − e)/P — той, что ещё попадает в последние P мс. Разрешённый запрос увеличивает cur на ${senior ? 'c' : '1'}.`,
			'',
			`Пример: P = ${period}, L = 5, у клиента в окне [0, ${period}) разрешено на prev = 4, в окне [${period}, ${2 * period}) — на cur = 1. Запрос${senior ? ' со стоимостью c = 1' : ''} в момент t = ${t}: e = ${e}, 4·(${period} − ${e}) + (1 + 1)·${period} = ${4 * (period - e)} + ${2 * period} = ${5 * period} ≤ ${5 * period} — разрешён. Тот же запрос в момент t = ${t - 1}: e = ${e - 1}, 4·${period - e + 1} + ${2 * period} = ${5 * period + 4} > ${5 * period} — отклонён.`
		].join('\n');
	}
};

function statement(kind: string, senior: boolean, spec: Spec): string {
	const [allow, deny] = spec.verdicts;
	return [
		'Шлюз API ограничивает частоту запросов каждого клиента. Напишите программу, которая по журналу запросов решает, какие из них шлюз пропустит.',
		'',
		`Период лимита этого шлюза — **P = ${spec.period} мс**; во входе его нет.`,
		'',
		'## Вход',
		'',
		'В первой строке — `N L`: число запросов (1 ≤ N ≤ 2000) и лимит (1 ≤ L ≤ 100).',
		senior
			? 'Далее `N` строк `t клиент c`: момент запроса в мс (0 ≤ t ≤ 10⁹, моменты не убывают), имя клиента (латинские буквы и цифры) и стоимость запроса (1 ≤ c ≤ L).'
			: 'Далее `N` строк `t клиент`: момент запроса в мс (0 ≤ t ≤ 10⁹, моменты не убывают) и имя клиента (латинские буквы и цифры).',
		'Запросы с одинаковым моментом обрабатываются в порядке строк.',
		'',
		'## Правило',
		'',
		RULE[kind]?.(senior, spec.period) ?? '',
		'Отклонённый запрос лимит не расходует. Лимиты разных клиентов независимы.',
		'',
		'## Выход',
		'',
		`\`N\` строк, по порядку запросов: \`${allow}\`, если шлюз пропускает запрос, и \`${deny}\`, если отклоняет.`,
		'',
		senior
			? 'Скрытые тесты — пять групп разной сложности. Две простые — обычные данные и много клиентов вперемешку: все стоимости в них равны 1 и ни одно решение не зависит от точного равенства на границе правила. Три полные, со стоимостями: запросы точно на границах периода, пачки одновременных запросов, большой объём. Группа засчитывается, если пройдены все её тесты.'
			: 'Скрытые тесты — пять групп: обычные данные, запросы точно на границах периода, пачки одновременных запросов, много клиентов вперемешку, большой объём. Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

function changeStatement(kind: string, senior: boolean): string {
	return [
		'**Новое условие.** Поверх лимита каждого клиента шлюз держит общий лимит `G` на всех клиентов вместе — по тому же правилу и с тем же периодом P, что и лимит клиента, с `G` вместо `L`' +
			(kind === 'token-bucket'
				? ' (общее ведро ёмкостью `G`, отсчёт пополнений — от самого первого запроса в журнале).'
				: kind === 'sliding-counter'
					? ' (общие cur и prev по разрешённым запросам всех клиентов).'
					: '.'),
		`Запрос разрешается, только если его разрешают и лимит клиента, и общий лимит${senior ? ' (с той же стоимостью)' : ''}; разрешённый запрос расходует оба, отклонённый — ни один.`,
		'Первая строка входа теперь `N L G` (1 ≤ G ≤ 1000). Измените решение и отправьте его снова; формат вывода прежний.'
	].join('\n');
}

/** The reference program in Python; a variant other than `right` is a wrong solution. */
function referenceSource(kind: string, senior: boolean, withGlobal: boolean, spec: Spec, variant: Variant): string {
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
		'token-bucket':
			variant === 'continuous-refill'
				? [
						'class Limiter:',
						'    def __init__(self, limit, period):',
						'        self.limit, self.period, self.last, self.parts = limit, period, None, limit * period',
						'    def allows(self, t, cost):',
						'        self.parts = min(self.limit * self.period, self.parts + t - (t if self.last is None else self.last))',
						'        self.last = t',
						'        return self.parts >= cost * self.period',
						'    def take(self, t, cost):',
						'        self.parts -= cost * self.period'
					]
				: [
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
	const takeOwn =
		variant === 'denied-counts'
			? '    own.take(t, cost)'
			: variant === 'own-spent-on-global-deny'
				? '    if a:\n        own.take(t, cost)'
				: '    if ok:\n        own.take(t, cost)';
	const [allow, deny] = spec.verdicts;
	return [
		'import sys',
		'',
		...(body[kind] ?? []),
		'',
		`PERIOD = ${spec.period}`,
		'data = sys.stdin.read().split()',
		'n, limit = int(data[0]), int(data[1])',
		withGlobal ? 'glob = Limiter(int(data[2]), PERIOD)' : 'glob = None',
		`pos = ${withGlobal ? 3 : 2}`,
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
		'        own = clients[client] = Limiter(limit, PERIOD)',
		'    a = own.allows(t, cost)',
		'    b = glob.allows(t, cost) if glob is not None else True',
		'    ok = a and b',
		takeOwn,
		'    if ok and glob is not None:',
		'        glob.take(t, cost)',
		`    out.append('${allow}' if ok else '${deny}')`,
		"print('\\n'.join(out))"
	]
		.filter((line, i, all) => line !== '' || all[i - 1] !== '')
		.join('\n');
}

const WRONG_IDS: readonly Variant[] = ['denied-counts', 'window-edge', 'shared-limit', 'continuous-refill'];
/** Wrong revisions of the step: programs with the global limit, met by the step's tests. */
const STEP_WRONG_IDS: readonly Variant[] = ['own-spent-on-global-deny'];

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	const kind = input.classId;
	const spec = drawSpec(rng);
	const others = level.classes.map((c) => c.id).filter((id) => id !== kind);
	const main = groups(rng, kind, others, senior, false, spec);
	const step = groups(rng, kind, others, senior, true, spec);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(kind, senior, spec), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: main, checker: { kind: 'tokens' } },
		changeStep: { markdown: changeStatement(kind, senior), weight: CHANGE_WEIGHT, answer: null, groups: step, qa: null }
	});
	return {
		instance,
		reference: () => ({
			kind: 'practice',
			source: referenceSource(kind, senior, false, spec, 'right'),
			changeSource: referenceSource(kind, senior, true, spec, 'right')
		}),
		wrong: () => {
			const probes: Record<string, WrongProbe | null> = {};
			for (const id of WRONG_IDS)
				probes[id] =
					(id === 'denied-counts' && !deniedCountsApplies(kind, senior)) ||
					(id === 'continuous-refill' && kind !== 'token-bucket')
						? null
						: { kind: 'program', source: referenceSource(kind, senior, false, spec, id) };
			for (const id of STEP_WRONG_IDS)
				probes[id] = ownSpentApplies(kind, senior)
					? { kind: 'program', source: referenceSource(kind, senior, true, spec, id) }
					: null;
			return probes;
		}
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
