// Binning and recoding a column with pandas: the closed side of `pd.cut` intervals and `include_lowest`, quantile edges
// of `pd.qcut`, `map` with a dictionary, string normalisation before counting, `value_counts(normalize=True)` and a
// group-by over interval categories. The candidate reads the table and the code and says what the program prints.
import { farApart, floatAnswer, roundingRule } from '../../_lib/ds.ts';
import { framesMarkdown, pandasSource, referenceStdin, type Frame } from '../../_lib/ds-frame.ts';
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { CITY_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Rule =
	| 'left-closed'
	| 'missing-as-zero'
	| 'nan-in-denominator'
	| 'lowest-included'
	| 'right-closed'
	| 'equal-count'
	| 'raw-values'
	| 'observed-only'
	| 'lowest-excluded';

const RULES: readonly Rule[] = [
	'left-closed',
	'missing-as-zero',
	'nan-in-denominator',
	'lowest-included',
	'right-closed',
	'equal-count',
	'raw-values',
	'observed-only',
	'lowest-excluded'
];

/** The misconceptions each class must expose on every instance. */
const REQUIRED: Record<string, Rule[]> = {
	'intern/cut-edges': ['left-closed'],
	'intern/map-missing': ['missing-as-zero'],
	'intern/normalize-share': ['nan-in-denominator'],
	'intern/cut-lowest': ['lowest-included'],
	'junior/cut-left': ['right-closed'],
	'junior/qcut': ['equal-count'],
	'junior/str-normalize': ['raw-values', 'nan-in-denominator'],
	'junior/empty-band': ['observed-only', 'lowest-excluded']
};

interface Scenario {
	/** The table as pandas holds it. */
	frame: Frame;
	/** The table as the statement shows it (strings quoted where spaces matter). */
	shown: Frame;
	steps: string[];
	digits: number;
	/** What the program prints under a misconception, or without one (`null`); `null` — nothing printable. */
	evaluate: (rule: Rule | null) => number | null;
	/** Parameters of the Python reference. */
	params: Record<string, unknown>;
}

/** The interval of `v` among `edges`, as `pd.cut` assigns it; `null` — outside every interval (NaN). */
function cutIndex(v: number, edges: readonly number[], right: boolean, lowest: boolean): number | null {
	for (let i = 0; i + 1 < edges.length; i += 1) {
		const lo = edges[i] ?? 0;
		const hi = edges[i + 1] ?? 0;
		if (right ? (lo < v && v <= hi) || (lowest && i === 0 && v === lo) : lo <= v && v < hi) return i;
	}
	return null;
}

const mean = (xs: readonly number[]): number | null =>
	xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Increasing integer edges: a start and `bins` widths. */
function makeEdges(rng: Rng, bins: number): number[] {
	const edges = [rng.pick([0, 10, 18, 20, 30])];
	for (let i = 0; i < bins; i += 1) edges.push((edges[i] ?? 0) + rng.int(2, 6) * 5);
	return edges;
}

/** Integer values strictly inside (lo, hi). */
function inside(rng: Rng, lo: number, hi: number): number {
	return rng.int(lo + 1, hi - 1);
}

const edgesText = (edges: readonly number[]): string => `[${edges.join(', ')}]`;

function cutShare(rng: Rng, lowestTrap: boolean): Scenario {
	const col = rng.pick(['age', 'tenure', 'score', 'visits']);
	const bins = rng.int(3, 5);
	const edges = makeEdges(rng, bins);
	const first = edges[0] ?? 0;
	const last = edges[bins] ?? 0;
	const n = rng.int(10, 18);
	const values: number[] = [];
	// The traps: a value on an interior edge and one on the top edge; for the reserve class, values on the lowest edge.
	values.push(edges[rng.int(1, bins - 1)] ?? 0, last);
	if (lowestTrap) {
		values.push(first);
		if (rng.bool()) values.push(first);
	}
	while (values.length < n) {
		const i = rng.int(0, bins - 1);
		values.push(rng.bool(0.25) ? (edges[i + 1] ?? 0) : inside(rng, edges[i] ?? 0, edges[i + 1] ?? 0));
	}
	const shuffled = rng.shuffle(values);
	const k = lowestTrap ? 0 : rng.int(0, bins - 1);
	const frame: Frame = { name: 'df', columns: ['user_id', col], rows: shuffled.map((v, i) => [101 + i, v]) };
	return {
		frame,
		shown: frame,
		digits: 3,
		steps: [
			`bins = pd.cut(df['${col}'], bins=${edgesText(edges)})`,
			`print(bins.value_counts(normalize=True, sort=False).iloc[${k}])`
		],
		evaluate: (rule) => {
			if (rule !== null && rule !== 'left-closed' && rule !== 'lowest-included') return null;
			const idx = shuffled.map((v) => cutIndex(v, edges, rule !== 'left-closed', rule === 'lowest-included'));
			const kept = idx.filter((i) => i !== null);
			return kept.length === 0 ? null : kept.filter((i) => i === k).length / kept.length;
		},
		params: { op: 'cut-share', col, edges, k }
	};
}

function mapMissing(rng: Rng): Scenario {
	const plans = ['basic', 'pro', 'team'];
	const prices = Object.fromEntries(plans.map((p) => [p, rng.int(5, 60) * 50 - 10]));
	const unknown = rng.pick(['trial', 'legacy', 'promo']);
	const n = rng.int(9, 12);
	const rows: string[] = [unknown, ...plans];
	for (let k = rng.int(0, 2); k > 0; k -= 1) rows.push(unknown);
	while (rows.length < n) rows.push(rng.pick(plans));
	const shuffled = rng.shuffle(rows);
	const frame: Frame = { name: 'df', columns: ['user_id', 'plan'], rows: shuffled.map((p, i) => [201 + i, p]) };
	const literal = `{${plans.map((p) => `'${p}': ${prices[p]}`).join(', ')}}`;
	return {
		frame,
		shown: frame,
		digits: 2,
		steps: [`prices = ${literal}`, "df['price'] = df['plan'].map(prices)", "print(df['price'].mean())"],
		evaluate: (rule) => {
			const mapped = shuffled.map((p) => prices[p] ?? null);
			if (rule === 'missing-as-zero') return mapped.reduce<number>((s, v) => s + (v ?? 0), 0) / mapped.length;
			if (rule !== null) return null;
			return mean(mapped.filter((v): v is number => v !== null));
		},
		params: { op: 'map-mean', prices }
	};
}

/** Frequency encoding: each row gets the share of its city among non-missing cities; NaN rows get NaN. */
function normalizeShare(rng: Rng): Scenario {
	const cities = rng.sample(CITY_NAMES, rng.int(3, 5));
	const n = rng.int(10, 16);
	const rows: (string | null)[] = [...cities];
	for (let k = rng.int(1, 3); k > 0; k -= 1) rows.push(null);
	while (rows.length < n) rows.push(rng.pick(cities));
	const shuffled = rng.shuffle(rows);
	const frame: Frame = { name: 'df', columns: ['order_id', 'city'], rows: shuffled.map((c, i) => [301 + i, c]) };
	return {
		frame,
		shown: frame,
		digits: 3,
		steps: [
			"freq = df['city'].value_counts(normalize=True)",
			"df['city_freq'] = df['city'].map(freq)",
			"print(df['city_freq'].mean())"
		],
		evaluate: (rule) => {
			if (rule !== null && rule !== 'nan-in-denominator') return null;
			const present = shuffled.filter((c): c is string => c !== null);
			const denominator = rule === 'nan-in-denominator' ? shuffled.length : present.length;
			const freq = (c: string): number => present.filter((p) => p === c).length / denominator;
			return present.reduce((sum, c) => sum + freq(c), 0) / present.length;
		},
		params: { op: 'freq-encoding', col: 'city' }
	};
}

function cutLeft(rng: Rng): Scenario {
	const x = rng.pick(['minutes', 'distance', 'weight']);
	const y = rng.pick(['amount', 'cost', 'fee']);
	const bins = rng.int(3, 4);
	const edges = makeEdges(rng, bins);
	const n = rng.int(12, 16);
	const xs: number[] = [edges[rng.int(1, bins - 1)] ?? 0, edges[bins] ?? 0];
	if (rng.bool()) xs.push(edges[0] ?? 0);
	for (let i = 0; i < bins; i += 1) xs.push(inside(rng, edges[i] ?? 0, edges[i + 1] ?? 0));
	while (xs.length < n) {
		const i = rng.int(0, bins - 1);
		xs.push(rng.bool(0.3) ? (edges[i + 1] ?? 0) : inside(rng, edges[i] ?? 0, edges[i + 1] ?? 0));
	}
	const pairs = rng.shuffle(xs).map((v) => [v, rng.int(2, 90) * 10] as const);
	const k = rng.int(0, bins - 1);
	const frame: Frame = { name: 'df', columns: [x, y], rows: pairs.map(([a, b]) => [a, b]) };
	return {
		frame,
		shown: frame,
		digits: 2,
		steps: [
			`df['band'] = pd.cut(df['${x}'], bins=${edgesText(edges)}, right=False)`,
			`print(df.groupby('band', observed=True)['${y}'].mean().iloc[${k}])`
		],
		evaluate: (rule) => {
			if (rule !== null && rule !== 'right-closed') return null;
			const byBin = new Map<number, number[]>();
			for (const [a, b] of pairs) {
				const i = cutIndex(a, edges, rule === 'right-closed', false);
				if (i === null) continue;
				byBin.set(i, [...(byBin.get(i) ?? []), b]);
			}
			const observed = [...byBin.keys()].sort((p, q) => p - q);
			// The right answer needs every interval observed, so the position names the interval the statement means.
			if (rule === null && observed.length !== bins) return null;
			const bin = observed[k];
			return bin === undefined ? null : mean(byBin.get(bin) ?? []);
		},
		params: { op: 'cut-left', x, y, edges, k }
	};
}

/** Linear-interpolation quantile edges of `pd.qcut` over sorted distinct values. */
function qcutEdges(sorted: readonly number[], q: number): number[] {
	const edges: number[] = [];
	for (let i = 0; i <= q; i += 1) {
		const pos = ((sorted.length - 1) * i) / q;
		const lo = Math.floor(pos);
		const hi = Math.ceil(pos);
		const a = sorted[lo] ?? 0;
		const b = sorted[hi] ?? 0;
		edges.push(a + (b - a) * (pos - lo));
	}
	return edges;
}

function qcut(rng: Rng): Scenario {
	const x = rng.pick(['income', 'sessions', 'spend']);
	const y = rng.pick(['churn_days', 'tickets', 'returns']);
	const n = rng.int(12, 16);
	const q = rng.int(3, 5);
	const xs = rng.sample(
		Array.from({ length: 80 }, (_, i) => (i + 1) * 5),
		n
	);
	const pairs = xs.map((v) => [v, rng.int(1, 60)] as const);
	const k = rng.int(0, q - 1);
	const frame: Frame = { name: 'df', columns: [x, y], rows: pairs.map(([a, b]) => [a, b]) };
	return {
		frame,
		shown: frame,
		digits: 2,
		steps: [`df['q'] = pd.qcut(df['${x}'], q=${q}, labels=False)`, `print(df.loc[df['q'] == ${k}, '${y}'].mean())`],
		evaluate: (rule) => {
			if (rule !== null && rule !== 'equal-count') return null;
			const sorted = [...pairs].sort((p, r) => p[0] - r[0]);
			if (rule === 'equal-count') {
				const base = Math.floor(n / q);
				const extra = n % q;
				const start = k * base + Math.min(k, extra);
				const size = base + (k < extra ? 1 : 0);
				return mean(sorted.slice(start, start + size).map((p) => p[1]));
			}
			const edges = qcutEdges(
				sorted.map((p) => p[0]),
				q
			);
			return mean(pairs.filter(([a]) => cutIndex(a, edges, true, true) === k).map((p) => p[1]));
		},
		params: { op: 'qcut', x, y, q, k }
	};
}

function strNormalize(rng: Rng): Scenario {
	const plans = rng.shuffle(['pro', 'basic', 'team']);
	const target = plans[0] ?? 'pro';
	const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
	const variants = (p: string): string[] => [p, cap(p), ` ${p}`, `${p.toUpperCase()} `, `${cap(p)} `];
	const n = rng.int(12, 20);
	const rows: (string | null)[] = [target, rng.pick(variants(target).slice(1)), rng.pick(variants(target).slice(1))];
	for (let k = rng.int(1, 2); k > 0; k -= 1) rows.push(null);
	while (rows.length < n) {
		const p = rng.pick(plans);
		rows.push(rng.pick(variants(p)));
	}
	const shuffled = rng.shuffle(rows);
	const ids = shuffled.map((_, i) => 401 + i);
	const frame: Frame = { name: 'df', columns: ['user_id', 'plan'], rows: shuffled.map((p, i) => [ids[i] ?? 0, p]) };
	const shown: Frame = {
		...frame,
		rows: shuffled.map((p, i) => [ids[i] ?? 0, p === null ? null : `'${p}'`])
	};
	return {
		frame,
		shown,
		digits: 3,
		steps: ["plan = df['plan'].str.strip().str.lower()", `print(plan.value_counts(normalize=True)['${target}'])`],
		evaluate: (rule) => {
			if (rule !== null && rule !== 'raw-values' && rule !== 'nan-in-denominator') return null;
			const present = shuffled.filter((p): p is string => p !== null);
			const hits =
				rule === 'raw-values'
					? present.filter((p) => p === target).length
					: present.filter((p) => p.trim().toLowerCase() === target).length;
			return hits / (rule === 'nan-in-denominator' ? shuffled.length : present.length);
		},
		params: { op: 'str-share', target }
	};
}

function emptyBand(rng: Rng): Scenario {
	const x = rng.pick(['minutes', 'distance', 'age']);
	const y = rng.pick(['amount', 'orders', 'points']);
	const bins = 4;
	const edges = makeEdges(rng, bins);
	const empty = rng.int(1, 2);
	const n = rng.int(12, 16);
	const xs: number[] = [edges[0] ?? 0];
	if (rng.bool()) xs.push(edges[0] ?? 0);
	for (let i = 0; i < bins; i += 1) if (i !== empty) xs.push(inside(rng, edges[i] ?? 0, edges[i + 1] ?? 0));
	while (xs.length < n) {
		let i = rng.int(0, bins - 1);
		if (i === empty) i = bins - 1;
		xs.push(rng.bool(0.3) && i !== empty - 1 ? (edges[i + 1] ?? 0) : inside(rng, edges[i] ?? 0, edges[i + 1] ?? 0));
	}
	const pairs = rng.shuffle(xs).map((v) => [v, rng.int(1, 40) * 5] as const);
	const frame: Frame = { name: 'df', columns: [x, y], rows: pairs.map(([a, b]) => [a, b]) };
	return {
		frame,
		shown: frame,
		digits: 2,
		steps: [
			`df['band'] = pd.cut(df['${x}'], bins=${edgesText(edges)}, include_lowest=True)`,
			`res = df.groupby('band', observed=False)['${y}'].sum()`,
			'print(res.mean())'
		],
		evaluate: (rule) => {
			if (rule !== null && rule !== 'observed-only' && rule !== 'lowest-excluded') return null;
			const sums = Array.from({ length: bins }, () => 0);
			const seen = Array.from({ length: bins }, () => false);
			for (const [a, b] of pairs) {
				const i = cutIndex(a, edges, true, rule !== 'lowest-excluded');
				if (i === null) continue;
				sums[i] = (sums[i] ?? 0) + b;
				seen[i] = true;
			}
			const total = sums.reduce((s, v) => s + v, 0);
			if (rule === 'observed-only') return total / seen.filter(Boolean).length;
			return total / bins;
		},
		params: { op: 'empty-band', x, y, edges }
	};
}

function scenario(rng: Rng, id: string): Scenario {
	switch (id) {
		case 'intern/cut-edges':
			return cutShare(rng, false);
		case 'intern/cut-lowest':
			return cutShare(rng, true);
		case 'intern/map-missing':
			return mapMissing(rng);
		case 'intern/normalize-share':
			return normalizeShare(rng);
		case 'junior/cut-left':
			return cutLeft(rng);
		case 'junior/qcut':
			return qcut(rng);
		case 'junior/str-normalize':
			return strNormalize(rng);
		case 'junior/empty-band':
			return emptyBand(rng);
		default:
			throw new Error(`${descriptor.key}: no scenario for ${id}`);
	}
}

const PYTHON_REFERENCE = `import json
import statistics

data = json.loads(input())
f = data["frames"]["df"]
rows = [dict(zip(f["columns"], r)) for r in f["rows"]]
op = data["op"]


def interval(v, edges, right=True, lowest=False):
    for i in range(len(edges) - 1):
        lo, hi = edges[i], edges[i + 1]
        if right and (lo < v <= hi or (lowest and i == 0 and v == lo)):
            return i
        if not right and lo <= v < hi:
            return i
    return None


if op == "cut-share":
    idx = [interval(r[data["col"]], data["edges"]) for r in rows]
    idx = [i for i in idx if i is not None]
    print(idx.count(data["k"]) / len(idx))
elif op == "map-mean":
    vals = [data["prices"][r["plan"]] for r in rows if r["plan"] in data["prices"]]
    print(sum(vals) / len(vals))
elif op == "freq-encoding":
    vals = [r[data["col"]] for r in rows if r[data["col"]] is not None]
    print(sum(vals.count(v) / len(vals) for v in vals) / len(vals))
elif op == "cut-left":
    groups = {}
    for r in rows:
        i = interval(r[data["x"]], data["edges"], right=False)
        if i is not None:
            groups.setdefault(i, []).append(r[data["y"]])
    g = groups[sorted(groups)[data["k"]]]
    print(sum(g) / len(g))
elif op == "qcut":
    xs = [r[data["x"]] for r in rows]
    cuts = statistics.quantiles(xs, n=data["q"], method="inclusive")
    edges = [min(xs)] + cuts + [max(xs)]
    g = [r[data["y"]] for r in rows if interval(r[data["x"]], edges, lowest=True) == data["k"]]
    print(sum(g) / len(g))
elif op == "str-share":
    vals = [r["plan"].strip().lower() for r in rows if r["plan"] is not None]
    print(vals.count(data["target"]) / len(vals))
else:
    edges = data["edges"]
    total = sum(r[data["y"]] for r in rows if interval(r[data["x"]], edges, lowest=True) is not None)
    print(total / (len(edges) - 1))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const id = `${input.grade}/${input.classId}`;
	for (let tries = 0; tries < 400; tries += 1) {
		const s = scenario(rng, id);
		const answer = s.evaluate(null);
		if (answer === null) continue;
		const wrong = Object.fromEntries(
			RULES.map((rule) => {
				const value = s.evaluate(rule);
				return [rule, value !== null && farApart(answer, value, s.digits) ? value : null];
			})
		);
		if ((REQUIRED[id] ?? []).some((rule) => wrong[rule] === null)) continue;
		const quoted = id === 'junior/str-normalize';
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					framesMarkdown([s.shown]),
					...(quoted ? ['', 'Строки показаны в кавычках, чтобы были видны пробелы; кавычки — не часть значения.'] : []),
					'',
					'Что напечатает программа (pandas 2 и новее, параметры по умолчанию)?',
					'',
					roundingRule(s.digits)
				].join('\n'),
				code: { language: 'python3', source: pandasSource([s.frame], s.steps) }
			},
			answer: floatAnswer(answer, s.digits)
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: referenceStdin([s.frame], s.params) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([rule, value]) => [
						rule,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, s.digits) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${id} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
