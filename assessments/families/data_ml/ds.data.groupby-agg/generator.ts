// Grouping a table with pandas: what `groupby` gives when values or keys are missing, how groups are ordered, what
// `nunique`, `transform`, `filter` and two keys do. The candidate reads the code and the table and says what it prints.
import { floatAnswer, roundingRule, type Cell, farApart } from '../../_lib/ds.ts';
import {
	compareKeys,
	framesMarkdown,
	meanSkip,
	pandasSource,
	present,
	referenceStdin,
	sumSkip,
	type Frame
} from '../../_lib/ds-frame.ts';
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { CITY_NAMES, PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 2;

interface Row {
	key: string | null;
	key2: string;
	user: string;
	value: number | null;
}

interface Scenario {
	rows: Row[];
	cols: { key: string; key2: string; user: string; value: string };
	target: string;
	k: number;
}

type Rule =
	| 'nan-as-zero'
	| 'nan-key-kept'
	| 'nunique-as-count'
	| 'appearance-order'
	| 'global-mean'
	| 'first-key-only'
	| 'all-combinations'
	| 'count-is-size'
	| 'overall-mean';

const RULES: readonly Rule[] = [
	'nan-as-zero',
	'nan-key-kept',
	'nunique-as-count',
	'appearance-order',
	'global-mean',
	'first-key-only',
	'all-combinations',
	'count-is-size',
	'overall-mean'
];

/** The misconceptions each class must expose on every instance. */
const REQUIRED: Record<string, Rule[]> = {
	'intern/mean-skipna': ['nan-as-zero'],
	'intern/nan-key-dropped': ['nan-key-kept'],
	'intern/per-buyer': ['nunique-as-count'],
	'intern/sorted-groups': ['appearance-order'],
	'junior/transform-dev': ['global-mean', 'nan-as-zero'],
	'junior/multi-key': ['first-key-only', 'all-combinations'],
	'junior/filter-count': ['count-is-size'],
	'junior/mean-of-means': ['overall-mean', 'nan-key-kept']
};

/** Groups of rows by a key in pandas order (sorted); NaN keys only under the misconception, as the last group. */
function groups(rows: readonly Row[], key: (r: Row) => string | null, rule: Rule | null): Row[][] {
	const byKey = new Map<string, Row[]>();
	const appearance: string[] = [];
	const nan: Row[] = [];
	for (const r of rows) {
		const k = key(r);
		if (k === null) {
			nan.push(r);
			continue;
		}
		if (!byKey.has(k)) {
			byKey.set(k, []);
			appearance.push(k);
		}
		byKey.get(k)?.push(r);
	}
	const order = rule === 'appearance-order' ? appearance : [...byKey.keys()].sort(compareKeys);
	const result = order.map((k) => byKey.get(k) ?? []);
	if (rule === 'nan-key-kept' && nan.length > 0) result.push(nan);
	return result;
}

const values = (rows: readonly Row[]): Cell[] => rows.map((r) => r.value);

/** pandas mean of a group; under `nan-as-zero` the sum over the number of rows. */
function groupMean(rows: readonly Row[], rule: Rule | null): number | null {
	if (rule === 'nan-as-zero') return rows.length === 0 ? null : sumSkip(values(rows)) / rows.length;
	return meanSkip(values(rows));
}

/** What the program prints, under one misconception or none. */
function evaluate(grade: string, classId: string, s: Scenario, rule: Rule | null): number | null {
	const byKey = (r: Row) => r.key;
	const id = `${grade}/${classId}`;
	if (id === 'intern/mean-skipna')
		return groupMean(
			s.rows.filter((r) => r.key === s.target),
			rule
		);
	if (id === 'intern/nan-key-dropped') {
		const sums = groups(s.rows, byKey, rule).map((g) => sumSkip(values(g)));
		return sums.reduce((a, b) => a + b, 0) / sums.length;
	}
	if (id === 'intern/per-buyer') {
		const g = s.rows.filter((r) => r.key === s.target);
		const buyers = rule === 'nunique-as-count' ? g.length : new Set(g.map((r) => r.user)).size;
		return sumSkip(values(g)) / buyers;
	}
	if (id === 'intern/sorted-groups') {
		const g = groups(s.rows, byKey, rule)[1];
		return g ? sumSkip(values(g)) : null;
	}
	if (id === 'junior/transform-dev') {
		const all = meanSkip(values(s.rows.filter((r) => r.key !== null)));
		let best: number | null = null;
		for (const g of groups(s.rows, byKey, null)) {
			const mean = rule === 'global-mean' ? all : groupMean(g, rule);
			for (const v of present(values(g))) {
				if (mean === null) continue;
				const dev = Math.abs(v - mean);
				if (best === null || dev > best) best = dev;
			}
		}
		return best;
	}
	if (id === 'junior/multi-key') {
		const total = sumSkip(values(s.rows));
		const keys = new Set(s.rows.map((r) => r.key));
		const combos = new Set(s.rows.map((r) => `${r.key}|${r.key2}`));
		if (rule === 'first-key-only') return total / keys.size;
		if (rule === 'all-combinations') return total / (keys.size * new Set(s.rows.map((r) => r.key2)).size);
		return total / combos.size;
	}
	if (id === 'junior/filter-count') {
		const kept = groups(s.rows, byKey, null).filter(
			(g) => (rule === 'count-is-size' ? g.length : present(values(g)).length) >= s.k
		);
		return kept.reduce((sum, g) => sum + sumSkip(values(g)), 0);
	}
	if (rule === 'overall-mean') return meanSkip(values(s.rows));
	const means = groups(s.rows, byKey, rule)
		.map((g) => groupMean(g, rule))
		.filter((m): m is number => m !== null);
	return means.reduce((a, b) => a + b, 0) / means.length;
}

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const cols = {
		key: rng.pick(['city', 'region', 'store']),
		key2: 'channel',
		user: rng.pick(['user', 'client', 'buyer']),
		value: rng.pick(['amount', 'revenue', 'total'])
	};
	const cities = rng.sample(CITY_NAMES, grade === 'intern' ? rng.int(3, 4) : rng.int(3, 5));
	const users = rng.sample(PERSON_NAMES, rng.int(5, 8));
	const channels = rng.sample(['web', 'app', 'shop'], grade === 'junior' && classId === 'multi-key' ? 3 : 2);
	const target = cities[0] ?? 'Омск';
	const n = grade === 'intern' ? rng.int(9, 12) : rng.int(12, 16);
	const amount = (): number => rng.int(2, 80) * 5;
	const rows: Row[] = [];
	const add = (key: string | null, value: number | null, user = rng.pick(users)): void => {
		rows.push({ key, key2: rng.pick(channels), user, value });
	};
	const nanKeys = classId === 'nan-key-dropped' || classId === 'mean-of-means';
	const nanValues = classId !== 'nan-key-dropped' && classId !== 'multi-key';
	// Every class meets its trap: the target group with a missing value and two present ones, a repeated buyer,
	// rows without a key.
	add(target, null);
	add(target, amount());
	add(target, amount());
	if (classId === 'per-buyer') {
		const buyer = rng.pick(users);
		add(target, amount(), buyer);
		add(target, amount(), buyer);
	}
	if (nanKeys) {
		add(null, amount());
		if (rng.bool()) add(null, amount());
	}
	if (classId === 'filter-count') {
		// A group with as many rows as the bar but fewer values, and a group above the bar.
		const [low, high] = [cities[1] ?? target, cities[2] ?? target];
		for (let i = 0; i < 3; i += 1) add(low, i === 0 ? null : amount());
		for (let i = 0; i < 3; i += 1) add(high, amount());
	}
	while (rows.length < n) {
		const value = nanValues && rng.bool(0.15) ? null : amount();
		add(nanKeys && rng.bool(0.1) ? null : rng.pick(cities), value);
	}
	// A key of each city at least once, so the number of groups is the number of cities.
	for (const city of cities) if (!rows.some((r) => r.key === city)) add(city, amount());
	return { rows: rng.shuffle(rows), cols, target, k: 3 };
}

function steps(grade: string, classId: string, s: Scenario): string[] {
	const { key, key2, user, value } = s.cols;
	const t = JSON.stringify(s.target).replaceAll('"', "'");
	const id = `${grade}/${classId}`;
	switch (id) {
		case 'intern/mean-skipna':
			return [`res = df.groupby('${key}')['${value}'].mean()`, `print(res[${t}])`];
		case 'intern/nan-key-dropped':
			return [`res = df.groupby('${key}')['${value}'].sum()`, 'print(res.mean())'];
		case 'intern/per-buyer':
			return [
				`res = df.groupby('${key}').agg(total=('${value}', 'sum'), buyers=('${user}', 'nunique'))`,
				`print((res['total'] / res['buyers'])[${t}])`
			];
		case 'intern/sorted-groups':
			return [`res = df.groupby('${key}')['${value}'].sum()`, 'print(res.iloc[1])'];
		case 'junior/transform-dev':
			return [
				`df['dev'] = df['${value}'] - df.groupby('${key}')['${value}'].transform('mean')`,
				"print(df['dev'].abs().max())"
			];
		case 'junior/multi-key':
			return [
				`res = df.groupby(['${key}', '${key2}'], as_index=False)['${value}'].sum()`,
				`print(res['${value}'].mean())`
			];
		case 'junior/filter-count':
			return [
				`res = df.groupby('${key}').filter(lambda g: g['${value}'].count() >= ${s.k})`,
				`print(res['${value}'].sum())`
			];
		default:
			return [`print(df.groupby('${key}')['${value}'].mean().mean())`];
	}
}

function frame(s: Scenario, grade: string, classId: string): Frame {
	const withChannel = grade === 'junior' && classId === 'multi-key';
	const withUser = grade === 'intern' && classId === 'per-buyer';
	const columns = [s.cols.key, ...(withChannel ? [s.cols.key2] : []), ...(withUser ? [s.cols.user] : []), s.cols.value];
	return {
		name: 'df',
		columns,
		rows: s.rows.map((r) => [r.key, ...(withChannel ? [r.key2] : []), ...(withUser ? [r.user] : []), r.value])
	};
}

const PYTHON_REFERENCE = `import json

data = json.loads(input())
f = data["frames"]["df"]
rows = [dict(zip(f["columns"], r)) for r in f["rows"]]
key, value, op = data["key"], data["value"], data["op"]


def groups(rows, cols):
    out = {}
    for r in rows:
        k = tuple(r[c] for c in cols)
        if any(x is None for x in k):
            continue
        out.setdefault(k, []).append(r)
    return [out[k] for k in sorted(out)]


def vals(g):
    return [r[value] for r in g if r[value] is not None]


def mean(xs):
    return sum(xs) / len(xs)


if op == "intern/mean-skipna":
    print(mean(vals([r for r in rows if r[key] == data["target"]])))
elif op == "intern/nan-key-dropped":
    print(mean([sum(vals(g)) for g in groups(rows, [key])]))
elif op == "intern/per-buyer":
    g = [r for r in rows if r[key] == data["target"]]
    print(sum(vals(g)) / len({r[data["user"]] for r in g}))
elif op == "intern/sorted-groups":
    print(sum(vals(groups(rows, [key])[1])))
elif op == "junior/transform-dev":
    devs = []
    for g in groups(rows, [key]):
        if not vals(g):
            continue
        m = mean(vals(g))
        devs += [abs(v - m) for v in vals(g)]
    print(max(devs))
elif op == "junior/multi-key":
    sums = [sum(vals(g)) for g in groups(rows, [key, data["key2"]])]
    print(mean(sums))
elif op == "junior/filter-count":
    print(sum(sum(vals(g)) for g in groups(rows, [key]) if len(vals(g)) >= data["k"]))
else:
    print(mean([mean(vals(g)) for g in groups(rows, [key]) if vals(g)]))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const id = `${input.grade}/${input.classId}`;
	for (let tries = 0; tries < 300; tries += 1) {
		const s = scenario(rng, input.grade, input.classId);
		const answer = evaluate(input.grade, input.classId, s, null);
		if (answer === null) continue;
		const wrong = Object.fromEntries(
			RULES.map((rule) => {
				const value = evaluate(input.grade, input.classId, s, rule);
				return [rule, value !== null && farApart(answer, value, DIGITS) ? value : null];
			})
		);
		if ((REQUIRED[id] ?? []).some((rule) => wrong[rule] === null)) continue;
		const f = frame(s, input.grade, input.classId);
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					framesMarkdown([f]),
					'',
					'Что напечатает программа (pandas 2 и новее, параметры по умолчанию)?',
					'',
					roundingRule(DIGITS)
				].join('\n'),
				code: { language: 'python3', source: pandasSource([f], steps(input.grade, input.classId, s)) }
			},
			answer: floatAnswer(answer, DIGITS)
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: referenceStdin([f], { op: id, ...s.cols, target: s.target, k: s.k })
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([rule, value]) => [
						rule,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${id} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
