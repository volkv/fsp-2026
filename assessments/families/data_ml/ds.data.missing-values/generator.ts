// Missing values in pandas: what fillna, dropna (subset, thresh), ffill and bfill by groups and with a limit, and
// linear interpolation do to a column, and what the statistics over it then are.
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

type Rule =
	| 'nan-as-zero'
	| 'fill-with-mean'
	| 'dropna-any-column'
	| 'subset-all'
	| 'skipna'
	| 'thresh-ignores-key'
	| 'thresh-as-nan-count'
	| 'ffill-across-groups'
	| 'unsorted'
	| 'global-mean'
	| 'ffill-instead'
	| 'trailing-nan'
	| 'leading-filled'
	| 'no-limit'
	| 'wrong-direction';

const RULES: readonly Rule[] = [
	'nan-as-zero',
	'fill-with-mean',
	'dropna-any-column',
	'subset-all',
	'skipna',
	'thresh-ignores-key',
	'thresh-as-nan-count',
	'ffill-across-groups',
	'unsorted',
	'global-mean',
	'ffill-instead',
	'trailing-nan',
	'leading-filled',
	'no-limit',
	'wrong-direction'
];

const REQUIRED: Record<string, Rule[]> = {
	'intern/fillna-median': ['nan-as-zero', 'fill-with-mean'],
	'intern/dropna-subset': ['dropna-any-column', 'subset-all'],
	'intern/fill-zero-mean': ['skipna'],
	'intern/thresh': ['thresh-ignores-key', 'thresh-as-nan-count'],
	'junior/ffill-groups': ['ffill-across-groups', 'unsorted'],
	'junior/group-mean-fill': ['global-mean', 'nan-as-zero'],
	'junior/interpolate': ['ffill-instead', 'trailing-nan', 'leading-filled'],
	'junior/bfill-limit': ['no-limit', 'wrong-direction']
};

interface Case {
	frame: Frame;
	steps: string[];
	params: Record<string, unknown>;
	evaluate: (rule: Rule | null) => number | null;
}

const value = (rng: Rng): number => rng.int(10, 99);

function median(xs: readonly number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Fill forward (or backward) along the list; `limit` caps how many consecutive missing values are filled. */
function fillAlong(xs: readonly Cell[], backward: boolean, limit: number | null): Cell[] {
	const order = xs.map((_, i) => i);
	if (backward) order.reverse();
	const out = [...xs];
	let last: Cell = null;
	let run = 0;
	for (const i of order) {
		const x = xs[i] ?? null;
		if (x !== null) {
			last = x;
			run = 0;
			continue;
		}
		run += 1;
		if (last !== null && (limit === null || run <= limit)) out[i] = last;
	}
	return out;
}

/** pandas `interpolate()`: linear by position between known values, last value forward at the end, start left NaN. */
function interpolate(xs: readonly Cell[]): Cell[] {
	const out = [...xs];
	const known = xs.flatMap((x, i) => (x === null ? [] : [i]));
	for (let k = 0; k + 1 < known.length; k += 1) {
		const a = known[k] ?? 0;
		const b = known[k + 1] ?? 0;
		const va = xs[a] as number;
		const vb = xs[b] as number;
		for (let i = a + 1; i < b; i += 1) out[i] = va + ((vb - va) * (i - a)) / (b - a);
	}
	const lastIndex = known[known.length - 1];
	if (lastIndex !== undefined) for (let i = lastIndex + 1; i < xs.length; i += 1) out[i] = xs[lastIndex] ?? null;
	return out;
}

function pickCols(rng: Rng, n: number): string[] {
	return rng.sample(['age', 'income', 'score', 'visits', 'weight', 'height', 'spend'], n);
}

function fillnaMedian(rng: Rng): Case {
	const [x] = pickCols(rng, 1) as [string];
	const n = rng.int(7, 10);
	const xs: (number | null)[] = Array.from({ length: n }, () => value(rng));
	for (const i of rng.sample(
		Array.from({ length: n }, (_, k) => k),
		rng.int(2, 3)
	))
		xs[i] = null;
	const frame: Frame = { name: 'df', columns: [x], rows: xs.map((v) => [v]) };
	return {
		frame,
		steps: [`df['${x}'] = df['${x}'].fillna(df['${x}'].median())`, `print(df['${x}'].mean())`],
		params: { x },
		evaluate: (rule) => {
			const fill =
				rule === 'nan-as-zero'
					? median(xs.map((v) => v ?? 0))
					: rule === 'fill-with-mean'
						? (meanSkip(xs) ?? 0)
						: median(present(xs));
			return xs.reduce<number>((s, v) => s + (v ?? fill), 0) / n;
		}
	};
}

function dropnaSubset(rng: Rng): Case {
	const [a, b, c] = pickCols(rng, 3) as [string, string, string];
	const names = rng.sample(PERSON_NAMES, rng.int(7, 9));
	// The traps: a value of the printed column with the other subset column empty, and with only the third empty.
	const rows: Cell[][] = names.map((name) => [name, value(rng), value(rng), value(rng)]);
	const at = rng.sample(
		rows.map((_, i) => i),
		4
	);
	(rows[at[0] ?? 0] as Cell[])[2] = null;
	(rows[at[1] ?? 0] as Cell[])[3] = null;
	(rows[at[2] ?? 0] as Cell[])[1] = null;
	if (rng.bool()) (rows[at[3] ?? 0] as Cell[])[3] = null;
	const frame: Frame = { name: 'df', columns: ['name', a, b, c], rows };
	return {
		frame,
		steps: [`clean = df.dropna(subset=['${a}', '${b}'])`, `print(clean['${a}'].sum())`],
		params: { a, b, c },
		evaluate: (rule) =>
			sumSkip(
				rows
					.filter((r) =>
						rule === 'dropna-any-column'
							? r.every((v) => v !== null)
							: rule === 'subset-all'
								? r[1] !== null || r[2] !== null
								: r[1] !== null && r[2] !== null
					)
					.map((r) => r[1] ?? null)
			)
	};
}

function fillZeroMean(rng: Rng): Case {
	const [x] = pickCols(rng, 1) as [string];
	const n = rng.int(6, 9);
	const xs: (number | null)[] = Array.from({ length: n }, () => (rng.bool(0.3) ? null : value(rng)));
	xs[rng.int(0, n - 1)] = null;
	if (present(xs).length < 2) xs[0] = value(rng);
	const frame: Frame = { name: 'df', columns: ['day', x], rows: xs.map((v, i) => [i + 1, v]) };
	return {
		frame,
		steps: [`print(df['${x}'].fillna(0).mean())`],
		params: { x },
		evaluate: (rule) => (rule === 'skipna' ? meanSkip(xs) : xs.reduce<number>((s, v) => s + (v ?? 0), 0) / n)
	};
}

function thresh(rng: Rng): Case {
	const [a, b, c] = pickCols(rng, 3) as [string, string, string];
	const k = rng.int(2, 3);
	const names = rng.sample(PERSON_NAMES, rng.int(7, 9));
	const rows: Cell[][] = names.map((name) => [name, ...[0, 1, 2].map(() => (rng.bool(0.35) ? null : value(rng)))]);
	// The traps: a row with only the printed value present, and one with exactly k − 1 values present.
	rows[0] = [names[0] ?? '', value(rng), null, null];
	rows[1] = [names[1] ?? '', value(rng), value(rng), null];
	const shuffled = rng.shuffle(rows);
	const frame: Frame = { name: 'df', columns: ['name', a, b, c], rows: shuffled };
	return {
		frame,
		steps: [`clean = df.dropna(thresh=${k})`, `print(clean['${a}'].sum())`],
		params: { k },
		evaluate: (rule) =>
			sumSkip(
				shuffled
					.filter((r) => {
						const nonNull = r.filter((v) => v !== null).length;
						if (rule === 'thresh-ignores-key') return nonNull - 1 >= k;
						if (rule === 'thresh-as-nan-count') return r.length - nonNull < k;
						return nonNull >= k;
					})
					.map((r) => r[1] ?? null)
			)
	};
}

function ffillGroups(rng: Rng): Case {
	const [x] = pickCols(rng, 1) as [string];
	const users = rng.sample(PERSON_NAMES, 3).sort(compareKeys);
	const rows: Cell[][] = [];
	users.forEach((u, ui) => {
		const days = rng.sample([1, 2, 3, 4, 5, 6, 7, 8], rng.int(3, 4)).sort((p, q) => p - q);
		days.forEach((d, i) => {
			// Every user after the first starts with a missing value; gaps inside every group.
			const missing = (ui > 0 && i === 0) || (i > 0 && rng.bool(0.4));
			rows.push([u, d, missing ? null : value(rng)]);
		});
	});
	const shuffled = rng.shuffle(rows);
	const frame: Frame = { name: 'df', columns: ['user', 'day', x], rows: shuffled };
	const sorted = [...shuffled].sort(
		(p, q) => compareKeys(p[0] as string, q[0] as string) || (p[1] as number) - (q[1] as number)
	);
	return {
		frame,
		steps: [
			"df = df.sort_values(['user', 'day'])",
			`df['${x}'] = df.groupby('user')['${x}'].ffill()`,
			`print(df['${x}'].sum())`
		],
		params: { x },
		evaluate: (rule) => {
			if (rule === 'ffill-across-groups')
				return sumSkip(
					fillAlong(
						sorted.map((r) => r[2] ?? null),
						false,
						null
					)
				);
			const base = rule === 'unsorted' ? shuffled : sorted;
			return users.reduce(
				(s, u) =>
					s +
					sumSkip(
						fillAlong(
							base.filter((r) => r[0] === u).map((r) => r[2] ?? null),
							false,
							null
						)
					),
				0
			);
		}
	};
}

function groupMeanFill(rng: Rng): Case {
	const [x] = pickCols(rng, 1) as [string];
	const cities = rng.sample(CITY_NAMES, 3);
	const rows: Cell[][] = [];
	for (const c of cities) {
		const n = rng.int(3, 4);
		for (let i = 0; i < n; i += 1) rows.push([c, i === 0 || (i > 1 && rng.bool(0.3)) ? null : value(rng)]);
		rows.push([c, value(rng)]);
	}
	const shuffled = rng.shuffle(rows);
	const frame: Frame = { name: 'df', columns: ['city', x], rows: shuffled };
	return {
		frame,
		steps: [`df['${x}'] = df['${x}'].fillna(df.groupby('city')['${x}'].transform('mean'))`, `print(df['${x}'].sum())`],
		params: { x },
		evaluate: (rule) => {
			const all = meanSkip(shuffled.map((r) => r[1] ?? null)) ?? 0;
			let total = 0;
			for (const c of cities) {
				const xs = shuffled.filter((r) => r[0] === c).map((r) => (typeof r[1] === 'number' ? r[1] : null));
				const mean =
					rule === 'global-mean' ? all : rule === 'nan-as-zero' ? sumSkip(xs) / xs.length : (meanSkip(xs) ?? 0);
				total += xs.reduce<number>((s, v) => s + (v ?? mean), 0);
			}
			return total;
		}
	};
}

function gappedSeries(rng: Rng, leading: number, trailing: number): Cell[] {
	const xs: Cell[] = [];
	for (let i = 0; i < leading; i += 1) xs.push(null);
	xs.push(value(rng));
	const gaps = [rng.int(2, 3), rng.int(1, 2)];
	for (const g of rng.shuffle(gaps)) {
		xs.push(value(rng));
		if (rng.bool()) xs.push(value(rng));
		for (let i = 0; i < g; i += 1) xs.push(null);
		xs.push(value(rng));
	}
	for (let i = 0; i < trailing; i += 1) xs.push(null);
	return xs;
}

function interpolateCase(rng: Rng): Case {
	const [x] = pickCols(rng, 1) as [string];
	const xs = gappedSeries(rng, rng.int(1, 2), rng.int(1, 2));
	const frame: Frame = { name: 'df', columns: ['day', x], rows: xs.map((v, i) => [i + 1, v]) };
	return {
		frame,
		steps: [`df['${x}'] = df['${x}'].interpolate()`, `print(df['${x}'].sum())`],
		params: { x },
		evaluate: (rule) => {
			if (rule === 'ffill-instead') return sumSkip(fillAlong(xs, false, null));
			const out = interpolate(xs);
			if (rule === 'trailing-nan') {
				const last = xs.reduce<number>((k, v, i) => (v === null ? k : i), 0);
				return sumSkip(out.slice(0, last + 1));
			}
			if (rule === 'leading-filled') {
				const first = xs.findIndex((v) => v !== null);
				const firstValue = xs[first];
				return sumSkip(out) + first * (typeof firstValue === 'number' ? firstValue : 0);
			}
			return sumSkip(out);
		}
	};
}

function bfillLimit(rng: Rng): Case {
	const [x] = pickCols(rng, 1) as [string];
	const xs = gappedSeries(rng, rng.int(0, 2), rng.int(0, 1));
	const frame: Frame = { name: 'df', columns: ['day', x], rows: xs.map((v, i) => [i + 1, v]) };
	return {
		frame,
		steps: [`df['${x}'] = df['${x}'].bfill(limit=1)`, `print(df['${x}'].sum())`],
		params: { x },
		evaluate: (rule) =>
			sumSkip(
				rule === 'no-limit'
					? fillAlong(xs, true, null)
					: rule === 'wrong-direction'
						? fillAlong(xs, false, 1)
						: fillAlong(xs, true, 1)
			)
	};
}

const CASES: Record<string, (rng: Rng) => Case> = {
	'intern/fillna-median': fillnaMedian,
	'intern/dropna-subset': dropnaSubset,
	'intern/fill-zero-mean': fillZeroMean,
	'intern/thresh': thresh,
	'junior/ffill-groups': ffillGroups,
	'junior/group-mean-fill': groupMeanFill,
	'junior/interpolate': interpolateCase,
	'junior/bfill-limit': bfillLimit
};

const PYTHON_REFERENCE = `import json

data = json.loads(input())
f = data["frames"]["df"]
cols = f["columns"]
rows = f["rows"]
op = data["op"]


def col(name, rs=None):
    i = cols.index(name)
    return [r[i] for r in (rows if rs is None else rs)]


def known(xs):
    return [x for x in xs if x is not None]


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def ffill(xs, limit=None):
    out, last, run = [], None, 0
    for x in xs:
        if x is not None:
            last, run = x, 0
            out.append(x)
        else:
            run += 1
            out.append(last if last is not None and (limit is None or run <= limit) else None)
    return out


if op == "intern/fillna-median":
    xs = col(data["x"])
    m = median(known(xs))
    print(sum(m if x is None else x for x in xs) / len(xs))
elif op == "intern/dropna-subset":
    a, b = cols.index(data["a"]), cols.index(data["b"])
    print(sum(r[a] for r in rows if r[a] is not None and r[b] is not None))
elif op == "intern/fill-zero-mean":
    xs = col(data["x"])
    print(sum(x or 0 for x in xs) / len(xs))
elif op == "intern/thresh":
    kept = [r for r in rows if sum(v is not None for v in r) >= data["k"]]
    print(sum(known(col(cols[1], kept))))
elif op == "junior/ffill-groups":
    total = 0
    for user in sorted(set(col("user"))):
        mine = sorted((r for r in rows if r[0] == user), key=lambda r: r[1])
        total += sum(known(ffill([r[2] for r in mine])))
    print(total)
elif op == "junior/group-mean-fill":
    total = 0
    for city in set(col("city")):
        xs = [r[1] for r in rows if r[0] == city]
        m = sum(known(xs)) / len(known(xs))
        total += sum(m if x is None else x for x in xs)
    print(total)
elif op == "junior/interpolate":
    xs = col(data["x"])
    idx = [i for i, x in enumerate(xs) if x is not None]
    out = list(xs)
    for a, b in zip(idx, idx[1:]):
        for i in range(a + 1, b):
            out[i] = xs[a] + (xs[b] - xs[a]) * (i - a) / (b - a)
    for i in range(idx[-1] + 1, len(xs)):
        out[i] = xs[idx[-1]]
    print(sum(known(out)))
else:
    xs = col(data["x"])
    print(sum(known(ffill(xs[::-1], 1))))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const id = `${input.grade}/${input.classId}`;
	const make = CASES[id];
	if (!make) throw new Error(`${descriptor.key}: no case ${id}`);
	for (let tries = 0; tries < 300; tries += 1) {
		const c = make(rng);
		const answer = c.evaluate(null);
		if (answer === null) continue;
		const wrong = Object.fromEntries(
			RULES.map((rule) => {
				const v = c.evaluate(rule);
				return [rule, v !== null && farApart(answer, v, DIGITS) ? v : null];
			})
		);
		if ((REQUIRED[id] ?? []).some((rule) => wrong[rule] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					framesMarkdown([c.frame]),
					'',
					'Что напечатает программа (pandas 2 и новее, параметры по умолчанию)?',
					'',
					roundingRule(DIGITS)
				].join('\n'),
				code: { language: 'python3', source: pandasSource([c.frame], c.steps) }
			},
			answer: floatAnswer(answer, DIGITS)
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: referenceStdin([c.frame], { op: id, ...c.params })
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([rule, v]) => [
						rule,
						v === null ? null : { kind: 'answer' as const, answer: floatAnswer(v, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${id} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
