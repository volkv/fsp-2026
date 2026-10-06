// The value of a PromQL expression over counters sampled in its range: `increase` and `rate` with a counter reset and
// without extrapolation, `sum by` and `sum without`, `topk`, a comparison that filters, and the division of two
// vectors matched by labels (`on`, `ignoring`, `group_left`). The answer is the set of result series with values.
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

type Labels = Record<string, string>;

interface Series {
	metric: string;
	labels: Labels;
	samples: number[];
}

/** A rational value: numerator and positive denominator. */
interface Q {
	n: number;
	d: number;
}

interface Params {
	classId: string;
	expr: string;
	series: Series[];
	/** Comparison threshold: an integer (middle) or thousandths of a ratio (senior); topk's k. */
	threshold: number;
	k: number;
}

interface Rules {
	noReset: boolean;
	resetAsZero: boolean;
	ignoreMatcher: boolean;
	withoutAsBy: boolean;
	filterBeforeSum: boolean;
	topkBeforeSum: boolean;
	ratePerMinute: boolean;
	sumCodes: boolean;
	missingAsZero: boolean;
	avgOfRatios: boolean;
	instanceRatio: boolean;
}

const RIGHT: Rules = {
	noReset: false,
	resetAsZero: false,
	ignoreMatcher: false,
	withoutAsBy: false,
	filterBeforeSum: false,
	topkBeforeSum: false,
	ratePerMinute: false,
	sumCodes: false,
	missingAsZero: false,
	avgOfRatios: false,
	instanceRatio: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'no-reset': { noReset: true },
	'reset-as-zero': { resetAsZero: true },
	'ignore-matcher': { ignoreMatcher: true },
	'without-as-by': { withoutAsBy: true },
	'filter-before-sum': { filterBeforeSum: true },
	'topk-before-sum': { topkBeforeSum: true },
	'rate-per-minute': { ratePerMinute: true },
	'sum-codes': { sumCodes: true },
	'missing-as-zero': { missingAsZero: true },
	'avg-of-ratios': { avgOfRatios: true },
	'instance-ratio': { instanceRatio: true }
};

// ---------------------------------------------------------------------------------------------------------------
// Values.

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
const q = (n: number, d = 1): Q => {
	const g = gcd(n, d) || 1;
	return { n: n / g, d: d / g };
};
const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const greater = (a: Q, b: Q): boolean => a.n * b.d > b.n * a.d;

/** Integer, or rounded half up to three decimals without trailing zeros. */
function show(v: Q): string {
	if (v.n % v.d === 0) return String(v.n / v.d);
	const t = Math.floor((2 * v.n * 1000 + v.d) / (2 * v.d));
	const sign = t < 0 ? '-' : '';
	const abs = Math.abs(t);
	const frac = String(abs % 1000)
		.padStart(3, '0')
		.replace(/0+$/, '');
	return `${sign}${Math.floor(abs / 1000)}${frac ? `.${frac}` : ''}`;
}

function increase(samples: readonly number[], rules: Rules): number {
	if (rules.noReset) return (samples[samples.length - 1] ?? 0) - (samples[0] ?? 0);
	let sum = 0;
	for (let i = 1; i < samples.length; i += 1) {
		const prev = samples[i - 1] ?? 0;
		const cur = samples[i] ?? 0;
		sum += cur >= prev ? cur - prev : rules.resetAsZero ? 0 : cur;
	}
	return sum;
}

const keyOf = (labels: Labels): string =>
	Object.keys(labels)
		.sort()
		.map((k) => `${k}=${labels[k] ?? ''}`)
		.join(',');

const pick = (labels: Labels, names: readonly string[]): Labels =>
	Object.fromEntries(names.filter((n) => n in labels).map((n) => [n, labels[n] ?? '']));

const drop = (labels: Labels, names: readonly string[]): Labels =>
	Object.fromEntries(Object.entries(labels).filter(([n]) => !names.includes(n)));

interface Elem {
	labels: Labels;
	value: Q;
}

function sumBy(elems: readonly Elem[], group: (l: Labels) => Labels): Elem[] {
	const out = new Map<string, Elem>();
	for (const e of elems) {
		const labels = group(e.labels);
		const key = keyOf(labels);
		const prev = out.get(key);
		out.set(key, { labels, value: prev ? add(prev.value, e.value) : e.value });
	}
	return [...out.values()];
}

const inc = (series: readonly Series[], metric: string, rules: Rules, match?: Labels): Elem[] =>
	series
		.filter(
			(s) =>
				s.metric === metric &&
				(rules.ignoreMatcher || !match || Object.entries(match).every(([k, v]) => s.labels[k] === v))
		)
		.map((s) => ({ labels: s.labels, value: q(increase(s.samples, rules)) }));

const lines = (elems: readonly Elem[]): string[] => {
	const out = elems.map((e) => `${keyOf(e.labels)} ${show(e.value)}`).sort();
	return out.length ? out : ['-'];
};

const REQUESTS = 'http_requests_total';
const ERRORS = 'http_errors_total';

function answerOf(p: Params, rules: Rules): string[] {
	const s = p.series;
	switch (p.classId) {
		case 'increase-reset':
			return lines(sumBy(inc(s, REQUESTS, rules, { code: '500' }), (l) => pick(l, ['service'])));
		case 'sum-without':
			return lines(
				sumBy(inc(s, REQUESTS, rules), (l) => (rules.withoutAsBy ? pick(l, ['instance']) : drop(l, ['instance'])))
			);
		case 'threshold-filter': {
			const c = q(p.threshold);
			const raw = inc(s, REQUESTS, rules, { code: '500' });
			if (rules.filterBeforeSum)
				return lines(
					sumBy(
						raw.filter((e) => greater(e.value, c)),
						(l) => pick(l, ['service'])
					)
				);
			return lines(sumBy(raw, (l) => pick(l, ['service'])).filter((e) => greater(e.value, c)));
		}
		case 'topk-rate': {
			const per = rules.ratePerMinute ? 5 : 300;
			const rates = inc(s, REQUESTS, rules).map((e) => ({ labels: e.labels, value: div(e.value, q(per)) }));
			const top = (elems: Elem[]): Elem[] =>
				[...elems].sort((a, b) => (greater(a.value, b.value) ? -1 : greater(b.value, a.value) ? 1 : 0)).slice(0, p.k);
			if (rules.topkBeforeSum) return lines(sumBy(top(rates), (l) => pick(l, ['route'])));
			return lines(top(sumBy(rates, (l) => pick(l, ['route']))));
		}
		case 'group-left': {
			const right = sumBy(inc(s, REQUESTS, rules), (l) => pick(l, ['service']));
			const left = sumBy(inc(s, ERRORS, rules), (l) => pick(l, rules.sumCodes ? ['service'] : ['service', 'code']));
			return lines(matchMany(left, right, ['service']));
		}
		case 'unmatched':
		case 'ratio-filter': {
			let result: Elem[];
			if (rules.avgOfRatios) result = averageRatios(s, rules);
			else {
				const left = sumBy(inc(s, ERRORS, rules), (l) => pick(l, ['service']));
				const right = sumBy(inc(s, REQUESTS, rules), (l) => pick(l, ['service']));
				if (rules.missingAsZero) {
					for (const r of right)
						if (!left.some((e) => e.labels.service === r.labels.service)) left.push({ labels: r.labels, value: q(0) });
				}
				result = matchMany(left, right, ['service']);
			}
			if (p.classId === 'ratio-filter') result = result.filter((e) => greater(e.value, q(p.threshold, 1000)));
			return lines(result);
		}
		case 'ignoring-group-left': {
			const left = sumBy(inc(s, ERRORS, rules), (l) => pick(l, ['service', 'instance']));
			if (rules.instanceRatio) {
				const right = sumBy(inc(s, REQUESTS, rules), (l) => pick(l, ['service', 'instance']));
				return lines(matchMany(left, right, ['service', 'instance']));
			}
			const right = sumBy(inc(s, REQUESTS, rules), (l) => pick(l, ['service']));
			return lines(matchMany(left, right, ['service']));
		}
	}
	throw new Error(`unknown class ${p.classId}`);
}

/** Every left element divided by the right element with the same `on` labels; elements without a pair drop out. */
function matchMany(left: readonly Elem[], right: readonly Elem[], on: readonly string[]): Elem[] {
	return left.flatMap((l) => {
		const r = right.find((x) => keyOf(pick(x.labels, on)) === keyOf(pick(l.labels, on)));
		return r && r.value.n !== 0 ? [{ labels: l.labels, value: div(l.value, r.value) }] : [];
	});
}

/** The misconception: per instance error ratio, averaged per service over the instances that have both counters. */
function averageRatios(s: readonly Series[], rules: Rules): Elem[] {
	const left = sumBy(inc(s, ERRORS, rules), (l) => pick(l, ['service', 'instance']));
	const right = sumBy(inc(s, REQUESTS, rules), (l) => pick(l, ['service', 'instance']));
	const ratios = matchMany(left, right, ['service', 'instance']);
	const groups = new Map<string, Q[]>();
	for (const r of ratios) groups.set(r.labels.service ?? '', [...(groups.get(r.labels.service ?? '') ?? []), r.value]);
	return [...groups].map(([service, values]) => ({
		labels: { service },
		value: div(
			values.reduce((a, b) => add(a, b), q(0)),
			q(values.length)
		)
	}));
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const SERVICES = ['api', 'auth', 'billing', 'cart', 'search', 'orders', 'media', 'users'];
const ROUTES = ['/login', '/cart', '/search', '/orders', '/profile', '/feed', '/pay'];

/** Five samples a minute apart; `reset` restarts the counter at one of the steps. */
function counter(rng: Rng, maxDelta: number, reset: boolean, step = 1): number[] {
	const out = [step * rng.int(30, 3000)];
	const at = reset ? rng.int(1, 4) : -1;
	for (let i = 1; i < 5; i += 1) {
		const prev = out[i - 1] ?? 0;
		const delta = step * rng.int(1, Math.floor(maxDelta / step));
		out.push(i === at ? step * rng.int(0, Math.floor(maxDelta / step)) : prev + delta);
	}
	return out;
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const series: Series[] = [];
	const add1 = (metric: string, labels: Labels, maxDelta: number, reset: boolean, step = 1): void => {
		series.push({ metric, labels, samples: counter(rng, maxDelta, reset, step) });
	};
	let expr = '';
	let threshold = 0;
	let k = 0;
	if (grade === 'middle') {
		if (classId === 'topk-rate') {
			const routes = rng.sample(ROUTES, rng.int(3, 4));
			for (const route of routes)
				for (const instance of ['web-1', 'web-2']) add1(REQUESTS, { route, instance }, 120, rng.bool(0.25), 3);
			k = rng.int(1, routes.length - 1);
			expr = `topk(${k}, sum by (route) (rate(${REQUESTS}[5m])))`;
		} else {
			const services = rng.sample(SERVICES, classId === 'sum-without' ? 2 : rng.int(2, 3));
			for (const service of services) {
				for (const n of [1, 2]) {
					const instance = `${service}-${n}`;
					const codes = classId === 'sum-without' ? ['200', '500'] : rng.bool(0.4) ? ['500', '200'] : ['500'];
					for (const code of codes)
						add1(REQUESTS, { service, instance, code }, code === '200' ? 200 : 40, rng.bool(0.3));
				}
			}
			if (classId === 'increase-reset') expr = `sum by (service) (increase(${REQUESTS}{code="500"}[5m]))`;
			if (classId === 'sum-without') expr = `sum without (instance) (increase(${REQUESTS}[5m]))`;
			if (classId === 'threshold-filter') {
				const sums = sumBy(inc(series, REQUESTS, RIGHT, { code: '500' }), (l) => pick(l, ['service']))
					.map((e) => e.value.n)
					.sort((a, b) => a - b);
				threshold = Math.max(1, (sums[rng.int(0, Math.max(0, sums.length - 2))] ?? 0) + rng.int(0, 3));
				expr = `sum by (service) (increase(${REQUESTS}{code="500"}[5m])) > ${threshold}`;
			}
		}
		return { classId, expr, series, threshold, k };
	}
	const services = rng.sample(SERVICES, classId === 'unmatched' ? 4 : classId === 'ratio-filter' ? 3 : 2);
	const instancesOf = (service: string): string[] =>
		Array.from({ length: classId === 'ignoring-group-left' ? rng.int(2, 3) : 2 }, (_, i) => `${service}-${i + 1}`);
	const reset = (): boolean => rng.bool(0.2);
	services.forEach((service, si) => {
		for (const instance of instancesOf(service)) {
			const hasRequests = !(classId === 'unmatched' && si === 2);
			const hasErrors = !(classId === 'unmatched' && si === 3);
			if (hasRequests) add1(REQUESTS, { service, instance }, 400, reset());
			if (classId === 'group-left') {
				for (const code of rng.bool(0.5) ? ['500', '503'] : [rng.pick(['500', '503'])])
					add1(ERRORS, { service, instance, code }, 20, reset());
			} else if (hasErrors) add1(ERRORS, { service, instance }, 30, reset());
		}
	});
	// Unmatched: the third service exports errors only, the fourth has no error counter at all.
	if (classId === 'group-left')
		expr = `sum by (service, code) (increase(${ERRORS}[5m]))\n  / on (service) group_left\nsum by (service) (increase(${REQUESTS}[5m]))`;
	if (classId === 'unmatched' || classId === 'ratio-filter')
		expr = `sum by (service) (increase(${ERRORS}[5m]))\n  /\nsum by (service) (increase(${REQUESTS}[5m]))`;
	if (classId === 'ratio-filter') {
		threshold = rng.pick([10, 20, 30, 50, 80, 100]);
		expr = `(\n  ${expr.replaceAll('\n', '\n  ')}\n) > ${threshold / 1000}`;
	}
	if (classId === 'ignoring-group-left')
		expr = `sum by (service, instance) (increase(${ERRORS}[5m]))\n  / ignoring (instance) group_left\nsum by (service) (increase(${REQUESTS}[5m]))`;
	return { classId, expr, series, threshold, k };
}

/** Whether the drawn scenario shows what its class is about. */
function fits(p: Params, answer: readonly string[]): boolean {
	if (answer[0] === '-') return false;
	if (p.classId === 'threshold-filter' || p.classId === 'ratio-filter') {
		const all = answerOf({ ...p, threshold: p.classId === 'threshold-filter' ? -1 : 0 }, RIGHT);
		if (all.length === answer.length) return false;
	}
	if (p.classId === 'topk-rate') {
		// Distinct sums: topk has no ties to break.
		const per = sumBy(
			inc(p.series, REQUESTS, RIGHT).map((e) => ({ labels: e.labels, value: e.value })),
			(l) => pick(l, ['route'])
		).map((e) => `${e.value.n}/${e.value.d}`);
		if (new Set(per).size !== per.length) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const selector = (s: Series): string =>
	`${s.metric}{${Object.entries(s.labels)
		.map(([k, v]) => `${k}="${v}"`)
		.join(', ')}}`;

function describe(p: Params): string {
	return [
		'Prometheus вычисляет выражение (ниже) в момент T. Отсчёты счётчиков за последние 5 минут — в таблице; все они попадают в окно `[5m]`, других рядов у этих метрик нет.',
		'',
		'| ряд | T−4m | T−3m | T−2m | T−1m | T |',
		'|---|---|---|---|---|---|',
		...p.series.map((s) => `| \`${selector(s)}\` | ${s.samples.join(' | ')} |`),
		'',
		'Считайте по правилам:',
		'',
		'- `increase(v[5m])` ряда — сумма приростов между соседними отсчётами окна, **без экстраполяции**; если значение уменьшилось, счётчик перезапустился с нуля, и прирост на этом шаге равен новому значению; `rate(v[5m])` — `increase` / 300 (в секунду);',
		'- `sum by (метки)` складывает ряды с одинаковыми значениями перечисленных меток и оставляет только их; `sum without (метки)` убирает перечисленные метки и складывает ряды, совпавшие по остальным; `topk(k, v)` оставляет k рядов с наибольшими значениями;',
		'- сравнение с числом (`v > c`) — фильтр: остаются ряды, для которых оно верно, их значения не меняются;',
		'- `a / b` сопоставляет ряды по всем меткам (с `on (метки)` — только по перечисленным, с `ignoring (метки)` — по всем, кроме перечисленных); ряд без пары на другой стороне в результат не попадает; `group_left` разрешает нескольким рядам слева делить один ряд справа, у результата — метки левого ряда.',
		'',
		'Введите результат: по ряду в строке, `<метки> <значение>`, где метки — `имя=значение` через запятую без пробелов и кавычек, по алфавиту имён меток. Целое значение пишите без точки; нецелое округлите до трёх знаков после точки (половина — вверх) без незначащих нулей. Порядок строк не важен; если результат пуст, введите `-`. Например:',
		'',
		'```',
		'code=500,service=api 0.125',
		'code=503,service=api 0.04',
		'```'
	].join('\n');
}

// An independent reference: parses the shown expression and evaluates it over the shown samples.
const PYTHON_REFERENCE = `import json, math, re
from fractions import Fraction

data = json.loads(input())
series = data["series"]
tokens = re.findall(r'"[^"]*"|[A-Za-z_:][A-Za-z0-9_:]*|\\d+(?:\\.\\d+)?|\\[\\d+m\\]|[(){},=/>*]', data["expr"])
pos = 0

def peek():
    return tokens[pos] if pos < len(tokens) else None

def take(expected=None):
    global pos
    tok = tokens[pos]
    if expected is not None and tok != expected:
        raise SyntaxError("expected %s, got %s" % (expected, tok))
    pos += 1
    return tok

def label_list():
    take("(")
    names = []
    while peek() != ")":
        names.append(take())
        if peek() == ",":
            take(",")
    take(")")
    return names

def increase(samples):
    total = 0
    for prev, cur in zip(samples, samples[1:]):
        total += cur - prev if cur >= prev else cur
    return total

def selector():
    name = take()
    match = {}
    if peek() == "{":
        take("{")
        while peek() != "}":
            key = take()
            take("=")
            match[key] = take()[1:-1]
            if peek() == ",":
                take(",")
        take("}")
    return name, match

def range_function(fn):
    take("(")
    name, match = selector()
    seconds = int(take()[1:-2]) * 60
    take(")")
    out = []
    for s in series:
        if s["metric"] == name and all(s["labels"].get(k) == v for k, v in match.items()):
            value = Fraction(increase(s["samples"]))
            out.append((dict(s["labels"]), value / seconds if fn == "rate" else value))
    return out

def aggregate(vector, names, without):
    groups = {}
    for labels, value in vector:
        kept = {k: v for k, v in labels.items() if (k not in names) == without}
        key = tuple(sorted(kept.items()))
        groups[key] = groups.get(key, 0) + value
    return [(dict(key), value) for key, value in groups.items()]

def primary():
    tok = peek()
    if tok == "(":
        take("(")
        v = expression()
        take(")")
        return v
    if tok == "sum":
        take()
        mode = take()
        names = label_list()
        take("(")
        v = expression()
        take(")")
        return aggregate(v, names, mode == "without")
    if tok == "topk":
        take()
        take("(")
        k = int(take())
        take(",")
        v = expression()
        take(")")
        return sorted(v, key=lambda e: -e[1])[:k]
    if tok in ("increase", "rate"):
        take()
        return range_function(tok)
    raise SyntaxError(tok)

def signature(labels, on, ignoring):
    if on is not None:
        return tuple(sorted((k, v) for k, v in labels.items() if k in on))
    return tuple(sorted((k, v) for k, v in labels.items() if k not in (ignoring or [])))

def product():
    left = primary()
    while peek() in ("/", "*"):
        op = take()
        on = ignoring = None
        many = False
        if peek() == "on":
            take()
            on = label_list()
        elif peek() == "ignoring":
            take()
            ignoring = label_list()
        if peek() == "group_left":
            take()
            many = True
        right = primary()
        index = {}
        for labels, value in right:
            sig = signature(labels, on, ignoring)
            assert sig not in index, "many-to-many"
            index[sig] = value
        if not many:
            sigs = [signature(l, on, ignoring) for l, _ in left]
            assert len(sigs) == len(set(sigs)), "one-to-one needs group_left"
        out = []
        for labels, value in left:
            other = index.get(signature(labels, on, ignoring))
            if other is None:
                continue
            out.append((labels, value / other if op == "/" else value * other))
        left = out
    return left

def expression():
    v = product()
    if peek() == ">":
        take()
        c = Fraction(take())
        v = [(l, x) for l, x in v if x > c]
    return v

result = expression()
assert pos == len(tokens)

def show(x):
    if x.denominator == 1:
        return str(x.numerator)
    t = math.floor(x * 1000 + Fraction(1, 2))
    whole, frac = divmod(abs(t), 1000)
    text = ("-" if t < 0 else "") + str(whole)
    frac = ("%03d" % frac).rstrip("0")
    return text + ("." + frac if frac else "")

lines = sorted(",".join("%s=%s" % kv for kv in sorted(l.items())) + " " + show(x) for l, x in result)
print("\\n".join(lines) if lines else "-")
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/increase-reset': ['no-reset', 'reset-as-zero'],
	'middle/sum-without': ['without-as-by', 'no-reset'],
	'middle/threshold-filter': ['filter-before-sum', 'ignore-matcher'],
	'middle/topk-rate': ['topk-before-sum', 'reset-as-zero'],
	'senior/group-left': ['sum-codes', 'no-reset'],
	'senior/unmatched': ['missing-as-zero', 'avg-of-ratios'],
	'senior/ratio-filter': ['avg-of-ratios', 'no-reset'],
	'senior/ignoring-group-left': ['instance-ratio', 'reset-as-zero']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = answerOf(p, RIGHT);
		if (!fits(p, answer)) continue;
		const key = JSON.stringify(answer);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(p, { ...RIGHT, ...change });
				return [id, JSON.stringify([...value].sort()) === key ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'promql', source: p.expr } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ expr: p.expr, series: p.series })
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
