// Rate limits through the eyes of a tester: the algorithm is stated (fixed window, sliding window, token bucket or two
// limits together), the requests come at given moments; the tester predicts which requests get 429, the Retry-After of
// the first refusal and X-RateLimit-Remaining in a given response.
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

interface Limit {
	algo: 'fixed' | 'sliding' | 'bucket';
	/** Requests per window, or the capacity of the bucket. */
	limit: number;
	/** The window, or the time one token takes to refill, ms. */
	span: number;
}

interface Params {
	limits: Limit[];
	/** Moments of the requests, ms, ascending and distinct. */
	times: number[];
	/** The 1-based number of the request whose Remaining is asked. */
	ask: number;
}

interface Rules {
	rejectedCounted: boolean;
	fixedAsSliding: boolean;
	slidingAsFixed: boolean;
	inclusiveBoundary: boolean;
	retryFullPeriod: boolean;
	remainingBefore: boolean;
	bucketNoCap: boolean;
	bucketDiscrete: boolean;
	retryMin: boolean;
}

const RIGHT: Rules = {
	rejectedCounted: false,
	fixedAsSliding: false,
	slidingAsFixed: false,
	inclusiveBoundary: false,
	retryFullPeriod: false,
	remainingBefore: false,
	bucketNoCap: false,
	bucketDiscrete: false,
	retryMin: false
};

interface Outcome {
	rejected: number[];
	/** Retry-After of each request, seconds; 0 for an accepted one. */
	retry: number[];
	/** X-RateLimit-Remaining of each request; 0 for a refused one. */
	remaining: number[];
}

interface Decision {
	allow: boolean;
	retryMs: number;
	remaining: number;
	commit: () => void;
}

function run(p: Params, rules: Rules): Outcome {
	const logs: number[][] = p.limits.map(() => []);
	const buckets = p.limits.map((l) => ({ credit: l.limit * l.span, tokens: l.limit, last: 0 }));
	const out: Outcome = { rejected: [], retry: [], remaining: [] };
	p.times.forEach((t, index) => {
		const decisions = p.limits.map((l, i): Decision => {
			const log = logs[i] ?? [];
			const algo =
				l.algo === 'fixed' && rules.fixedAsSliding
					? 'sliding'
					: l.algo === 'sliding' && rules.slidingAsFixed
						? 'fixed'
						: l.algo;
			const used = (n: number): number => l.limit - n - (rules.remainingBefore ? 0 : 1);
			if (algo === 'fixed') {
				const window = Math.floor(t / l.span);
				const count = log.filter((s) => Math.floor(s / l.span) === window).length;
				return {
					allow: count < l.limit,
					retryMs: rules.retryFullPeriod ? l.span : (window + 1) * l.span - t,
					remaining: used(count),
					commit: () => log.push(t)
				};
			}
			if (algo === 'sliding') {
				const inside = log.filter((s) => (rules.inclusiveBoundary ? s >= t - l.span : s > t - l.span));
				const leaves = inside[inside.length - l.limit];
				return {
					allow: inside.length < l.limit,
					retryMs: rules.retryFullPeriod ? l.span : (leaves ?? t) + l.span - t,
					remaining: used(inside.length),
					commit: () => log.push(t)
				};
			}
			const b = buckets[i] ?? { credit: 0, tokens: 0, last: 0 };
			if (rules.bucketDiscrete) {
				const tokens = Math.min(l.limit, b.tokens + Math.floor(t / l.span) - Math.floor(b.last / l.span));
				b.tokens = tokens;
				b.last = t;
				return {
					allow: tokens >= 1,
					retryMs: rules.retryFullPeriod ? l.span : (Math.floor(t / l.span) + 1) * l.span - t,
					remaining: rules.remainingBefore ? tokens : tokens - 1,
					commit: () => {
						b.tokens -= 1;
					}
				};
			}
			const raw = b.credit + (t - b.last);
			const credit = rules.bucketNoCap ? raw : Math.min(l.limit * l.span, raw);
			b.credit = credit;
			b.last = t;
			return {
				allow: credit >= l.span,
				retryMs: rules.retryFullPeriod ? l.span : l.span - credit,
				remaining: Math.floor((rules.remainingBefore ? credit : credit - l.span) / l.span),
				commit: () => {
					b.credit -= l.span;
				}
			};
		});
		const allow = decisions.every((d) => d.allow);
		if (allow) {
			for (const d of decisions) d.commit();
			out.retry.push(0);
			out.remaining.push(Math.min(...decisions.map((d) => d.remaining)));
			return;
		}
		if (rules.rejectedCounted) p.limits.forEach((l, i) => l.algo !== 'bucket' && logs[i]?.push(t));
		const waits = decisions.filter((d) => !d.allow).map((d) => Math.ceil(d.retryMs / 1000));
		out.rejected.push(index + 1);
		out.retry.push(rules.retryMin ? Math.min(...waits) : Math.max(...waits));
		out.remaining.push(0);
	});
	return out;
}

function answerOf(p: Params, rules: Rules): string {
	const o = run(p, rules);
	const first = o.rejected[0];
	return `${o.rejected.length ? o.rejected.join(' ') : '-'} | ${first === undefined ? '-' : (o.retry[first - 1] ?? 0)} | ${o.remaining[p.ask - 1] ?? 0}`;
}

interface Shape {
	limits: (rng: Rng) => Limit[];
	times: (rng: Rng, limits: readonly Limit[]) => number[];
}

const ms = (seconds: number): number => Math.round(seconds * 1000);

/** `count` moments from `start` with gaps of 100 ms steps in [lo, hi] steps. */
function burst(rng: Rng, start: number, count: number, lo: number, hi: number): number[] {
	const out: number[] = [];
	let t = start;
	for (let i = 0; i < count; i += 1) {
		out.push(t);
		t += rng.int(lo, hi) * 100;
	}
	return out;
}

const SHAPES: Record<string, Shape> = {
	'middle/fixed-window': {
		limits: (rng) => [{ algo: 'fixed', limit: rng.int(3, 5), span: ms(rng.pick([10, 20, 30])) }],
		times: (rng, [l]) => {
			const span = l?.span ?? 10000;
			const edge = span * rng.int(1, 2);
			const before = burst(rng, edge - rng.int(15, 40) * 100, rng.int(2, 4), 2, 8);
			const after = burst(rng, edge + rng.int(0, 10) * 100, rng.int(3, 5), 2, 8);
			const early = burst(rng, rng.int(0, 20) * 100, rng.int(1, 3), 5, 30);
			return [...early, ...before, ...after];
		}
	},
	'middle/sliding-log': {
		limits: (rng) => [{ algo: 'sliding', limit: rng.int(3, 4), span: ms(rng.pick([10, 15, 20])) }],
		times: (rng, [l]) => {
			const span = l?.span ?? 10000;
			const first = burst(rng, rng.int(0, 20) * 100, (l?.limit ?? 3) + rng.int(0, 1), 3, 15);
			const echo = (first[rng.int(0, 1)] ?? 0) + span;
			const middle = burst(rng, (first.at(-1) ?? 0) + rng.int(5, 30) * 100, rng.int(1, 3), 5, 20);
			return [...first, ...middle, echo, ...burst(rng, echo + rng.int(2, 10) * 100, rng.int(1, 3), 3, 15)];
		}
	},
	'middle/token-bucket': {
		limits: (rng) => [{ algo: 'bucket', limit: rng.int(3, 5), span: rng.pick([2000, 2500, 4000, 5000]) }],
		times: (rng, [l]) => {
			const cap = (l?.limit ?? 3) * (l?.span ?? 2000);
			const first = burst(rng, rng.int(0, 10) * 100, (l?.limit ?? 3) + rng.int(0, 2), 2, 6);
			const idle = (first.at(-1) ?? 0) + cap + rng.int(10, 60) * 100;
			return [...first, ...burst(rng, idle, (l?.limit ?? 3) + rng.int(1, 2), 2, 8)];
		}
	},
	'middle/remaining-headers': {
		limits: (rng) => [{ algo: 'fixed', limit: rng.int(3, 6), span: ms(rng.pick([10, 20, 30])) }],
		times: (rng, [l]) => {
			const span = l?.span ?? 10000;
			const edge = span * rng.int(1, 2);
			return [
				...burst(rng, edge - rng.int(20, 50) * 100, rng.int(2, 6), 2, 8),
				...burst(rng, edge + rng.int(0, 20) * 100, rng.int(3, 7), 2, 10),
				...burst(rng, edge + span + rng.int(0, 30) * 100, rng.int(1, 4), 3, 15)
			];
		}
	},
	'senior/two-limits': {
		limits: (rng) => {
			const shortLimit = rng.int(2, 3);
			const shortSpan = ms(rng.pick([5, 10]));
			const longLimit = rng.int(5, 6);
			// The long window spans the early requests, one per short window, and the short window that fills it.
			const longSpan = Math.max((longLimit - shortLimit + 2) * shortSpan, ms(rng.pick([30, 40, 60])));
			return [
				{ algo: 'fixed', limit: shortLimit, span: shortSpan },
				{ algo: 'sliding', limit: longLimit, span: longSpan }
			];
		},
		times: (rng, [short, long]) => {
			const span = short?.span ?? 5000;
			const early = (long?.limit ?? 5) - (short?.limit ?? 2) + rng.int(-1, 0);
			const times: number[] = [];
			for (let j = 0; j < early; j += 1) times.push(j * span + rng.int(0, span / 100 - 5) * 100);
			const fill = early * span + rng.int(0, 10) * 100;
			const crowd = burst(rng, fill, (short?.limit ?? 2) + rng.int(1, 2), 2, 8);
			return [...times, ...crowd, ...burst(rng, (crowd.at(-1) ?? 0) + rng.int(10, 60) * 100, rng.int(2, 4), 10, 80)];
		}
	},
	'senior/bucket-retry': {
		limits: (rng) => [{ algo: 'bucket', limit: rng.int(2, 4), span: rng.pick([1500, 2500, 3500]) }],
		times: (rng, [l]) => [
			...burst(rng, rng.int(0, 10) * 100, (l?.limit ?? 2) + rng.int(1, 2), 1, 5),
			...burst(rng, rng.int(100, 160) * 100, rng.int(5, 7), 3, 14)
		]
	},
	'senior/sliding-retry': {
		limits: (rng) => [{ algo: 'sliding', limit: rng.int(3, 5), span: ms(rng.pick([10, 15, 20])) }],
		times: (rng, [l]) => {
			const span = l?.span ?? 10000;
			const start = Math.floor(span / 2) + rng.int(0, 30) * 100;
			return [
				...burst(rng, start, (l?.limit ?? 3) + rng.int(1, 2), 5, 25),
				...burst(rng, start + span + rng.int(-20, 20) * 100, rng.int(3, 5), 3, 20)
			];
		}
	}
};

/**
 * A token bucket and a quota per fixed window. The quota is fitted to the feed: the first window holds exactly the
 * requests the bucket lets through before it first runs dry, so that request is refused by both limits; the last burst
 * opens the next window soon after, when the bucket has refilled only partly.
 */
function bucketAndQuota(rng: Rng): Omit<Params, 'ask'> {
	const bucket: Limit = { algo: 'bucket', limit: rng.int(3, 4), span: rng.pick([2000, 2500, 3000]) };
	const first = burst(rng, rng.int(0, 10) * 100, bucket.limit - rng.int(0, 1), 2, 6);
	const idle = (first.at(-1) ?? 0) + bucket.limit * bucket.span + rng.int(10, 30) * 100;
	const second = burst(rng, idle, bucket.limit + rng.int(1, 2), 2, 6);
	const span = [20, 30, 40].map(ms).find((w) => w >= (second.at(-1) ?? 0) + 2000) ?? ms(50);
	const third = burst(rng, span + rng.int(1, 20) * 100, rng.int(3, 5), 2, 6);
	const times = [...first, ...second, ...third];
	const dry = run({ limits: [bucket], times, ask: 1 }, RIGHT).rejected[0] ?? 1;
	return { limits: [bucket, { algo: 'fixed', limit: dry - 1, span }], times };
}

function scenario(rng: Rng, grade: string, classId: string): Omit<Params, 'ask'> {
	if (classId === 'bucket-and-quota') return bucketAndQuota(rng);
	const shape = SHAPES[`${grade}/${classId}`];
	if (!shape) throw new Error(`${descriptor.key}: no shape for ${grade}/${classId}`);
	const limits = shape.limits(rng);
	const times = [...new Set(shape.times(rng, limits).filter((t) => t >= 0))].sort((a, b) => a - b);
	return { limits, times };
}

const seconds = (value: number): string => (value / 1000).toFixed(1);
const plain = (value: number): string => String(value / 1000);

/** A Russian noun form for a count: `[one, few, many]`. */
function plural(n: number, forms: readonly [string, string, string]): string {
	const tail = n % 100;
	if (tail >= 11 && tail <= 14) return forms[2];
	if (n % 10 === 1) return forms[0];
	if (n % 10 >= 2 && n % 10 <= 4) return forms[1];
	return forms[2];
}

function limitText(l: Limit): string {
	if (l.algo === 'fixed')
		return `фиксированное окно: время делится на окна [0; ${plain(l.span)}), [${plain(l.span)}; ${plain(2 * l.span)}) и так далее по ${plain(l.span)} с; в каждом окне принимаются первые ${l.limit} ${plural(l.limit, ['запрос', 'запроса', 'запросов'])}, остальные получают \`429\`. Retry-After — сколько секунд осталось до конца текущего окна.`;
	if (l.algo === 'sliding')
		return `скользящее окно: запрос в момент t принимается, если за промежуток (t − ${plain(l.span)}; t] принято меньше ${l.limit} ${plural(l.limit, ['запроса', 'запросов', 'запросов'])}; запрос, принятый ровно ${plain(l.span)} с назад, в промежуток уже не входит. Retry-After — через сколько секунд запрос был бы принят: когда из промежутка выйдет самый старый из принятых в нём запросов.`;
	return `корзина токенов: ёмкость ${l.limit} ${plural(l.limit, ['токен', 'токена', 'токенов'])}, в момент 0 корзина полная; токены пополняются непрерывно — один токен за ${plain(l.span)} с — и сверх ёмкости не копятся. Запрос принимается, если в корзине есть целый токен, и забирает его. Retry-After — через сколько секунд в корзине накопится целый токен.`;
}

function describe(p: Params): string {
	const two = p.limits.length > 1;
	return [
		'Тестировщик проверяет ограничение частоты запросов к `POST /api/v1/search` для одного клиента и заранее записывает ожидаемые ответы.',
		'',
		two ? '## Лимиты' : '## Лимит',
		'',
		...p.limits.map((l) => `- ${limitText(l)}`),
		...(two
			? [
					'',
					'Запрос принимается, только если его принимают оба лимита. Принятый запрос учитывается в обоих лимитах, отклонённый — ни в одном.'
				]
			: []),
		'',
		'## Заголовки',
		'',
		'- Отклонённые запросы (`429`) лимит не расходуют: их не считают в окнах, токенов они не забирают.',
		`- \`Retry-After\` есть только в ответе \`429\`: число секунд, округлённое вверх до целого${two ? '; если запрос отклонили оба лимита — наибольшее из их значений' : ''}.`,
		`- \`X-RateLimit-Remaining\` в принятом ответе — сколько ещё запросов можно сделать прямо сейчас, уже с учётом этого запроса: для окна — лимит минус число принятых в окне, для корзины — число целых токенов после списания${two ? '; при двух лимитах — наименьшее из двух' : ''}. В ответе \`429\` — \`0\`.`,
		'',
		'## Запросы',
		'',
		'Номер и момент запроса в секундах от начала отсчёта:',
		'',
		'```',
		...p.times.map((t, i) => `${String(i + 1).padStart(2)}  ${seconds(t)}`),
		'```',
		'',
		`Введите через пробел номера запросов, получивших \`429\`, по возрастанию, затем знак \`|\`, значение \`Retry-After\` в ответе на первый из них, затем знак \`|\` и значение \`X-RateLimit-Remaining\` в ответе на запрос номер ${p.ask}. Например: \`4 5 9 | 3 | 1\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
limits = p["limits"]
accepted = [[] for _ in limits]
credit = [l["limit"] * l["span"] for l in limits]
last = [0 for _ in limits]
refused, retry, remaining = [], {}, {}

for n, t in enumerate(p["times"], start=1):
    oks, waits, rests = [], [], []
    for i, l in enumerate(limits):
        L, S = l["limit"], l["span"]
        if l["algo"] == "fixed":
            w = t // S
            c = sum(1 for s in accepted[i] if s // S == w)
            oks.append(c < L)
            waits.append((w + 1) * S - t)
            rests.append(L - c - 1)
        elif l["algo"] == "sliding":
            inside = sorted(s for s in accepted[i] if t - S < s <= t)
            oks.append(len(inside) < L)
            waits.append(inside[len(inside) - L] + S - t if len(inside) >= L else 0)
            rests.append(L - len(inside) - 1)
        else:
            credit[i] = min(L * S, credit[i] + t - last[i])
            last[i] = t
            oks.append(credit[i] >= S)
            waits.append(S - credit[i])
            rests.append((credit[i] - S) // S)
    if all(oks):
        for i, l in enumerate(limits):
            if l["algo"] == "bucket":
                credit[i] -= l["span"]
            else:
                accepted[i].append(t)
        remaining[n] = min(rests)
    else:
        refused.append(n)
        retry[n] = max(-(-w // 1000) for w, ok in zip(waits, oks) if not ok)
        remaining[n] = 0
print(" ".join(map(str, refused)) or "-", "|", retry[refused[0]] if refused else "-", "|", remaining[p["ask"]])
`;

const WRONG: Record<string, Partial<Rules>> = {
	'rejected-counted': { rejectedCounted: true },
	'fixed-as-sliding': { fixedAsSliding: true },
	'sliding-as-fixed': { slidingAsFixed: true },
	'inclusive-boundary': { inclusiveBoundary: true },
	'retry-full-period': { retryFullPeriod: true },
	'remaining-before': { remainingBefore: true },
	'bucket-no-cap': { bucketNoCap: true },
	'bucket-discrete': { bucketDiscrete: true },
	'retry-min': { retryMin: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/fixed-window': ['fixed-as-sliding', 'retry-full-period'],
	'middle/sliding-log': ['inclusive-boundary', 'rejected-counted'],
	'middle/token-bucket': ['bucket-no-cap'],
	'middle/remaining-headers': ['remaining-before', 'fixed-as-sliding'],
	'senior/two-limits': ['rejected-counted', 'retry-min'],
	'senior/bucket-retry': ['retry-full-period', 'bucket-discrete'],
	'senior/sliding-retry': ['sliding-as-fixed', 'retry-full-period'],
	'senior/bucket-and-quota': ['bucket-no-cap', 'retry-min']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Feeds are drawn until every misconception the class is about changes the answer.
	for (let tries = 0; tries < 500; tries += 1) {
		const draft = scenario(rng, input.grade, input.classId);
		const right = run({ ...draft, ask: 1 }, RIGHT);
		const accepted = draft.times.map((_, i) => i + 1).filter((n) => !right.rejected.includes(n) && n > 1);
		if (right.rejected.length === 0 || accepted.length === 0) continue;
		if (draft.limits.some((l) => l.limit < 2)) continue;
		const p: Params = { ...draft, ask: rng.pick(accepted) };
		const answer = answerOf(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
