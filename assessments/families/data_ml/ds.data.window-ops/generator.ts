// Window operations in pandas: shift by groups after a sort, rolling windows with and without min_periods and with
// missing values, cumulative sums by groups, pct_change, expanding means of past values and exponential smoothing.
import { floatAnswer, roundingRule, type Cell, farApart } from '../../_lib/ds.ts';
import {
	compareKeys,
	framesMarkdown,
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
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Rule =
	| 'across-groups'
	| 'unsorted'
	| 'partial-windows'
	| 'window-ahead'
	| 'global-cumsum'
	| 'group-total'
	| 'reverse-ratio'
	| 'first-zero'
	| 'min-periods-ignored'
	| 'includes-current'
	| 'adjust-true'
	| 'alpha-swapped'
	| 'nan-as-zero'
	| 'min-periods-counts-rows';

const RULES: readonly Rule[] = [
	'across-groups',
	'unsorted',
	'partial-windows',
	'window-ahead',
	'global-cumsum',
	'group-total',
	'reverse-ratio',
	'first-zero',
	'min-periods-ignored',
	'includes-current',
	'adjust-true',
	'alpha-swapped',
	'nan-as-zero',
	'min-periods-counts-rows'
];

const REQUIRED: Record<string, Rule[]> = {
	'junior/group-shift': ['across-groups', 'unsorted'],
	'junior/rolling-mean': ['partial-windows', 'window-ahead'],
	'junior/group-cumsum': ['global-cumsum', 'group-total'],
	'junior/pct-change': ['reverse-ratio', 'first-zero'],
	'middle/rolling-min-periods': ['min-periods-ignored', 'across-groups'],
	'middle/expanding-prior': ['includes-current', 'across-groups'],
	'middle/ewm': ['adjust-true', 'alpha-swapped'],
	'middle/rolling-nan': ['nan-as-zero', 'min-periods-counts-rows']
};

interface Case {
	frame: Frame;
	steps: string[];
	digits: number;
	params: Record<string, unknown>;
	evaluate: (rule: Rule | null) => number | null;
}

const amountOf = (rng: Rng): number => rng.int(2, 60) * 5;

/** Mean of a rolling window ending at each position: `min` non-missing values needed, `null` otherwise. */
function rolling(xs: readonly Cell[], w: number, min: number): Cell[] {
	return xs.map((_, i) => {
		const window = present(xs.slice(Math.max(0, i - w + 1), i + 1));
		return window.length >= min && window.length > 0 ? window.reduce((s, v) => s + v, 0) / window.length : null;
	});
}

/** Rows of users with distinct days; `sorted` — by user and day as `sort_values(['user', 'day'])` gives them. */
function userRows(rng: Rng): { shuffled: Cell[][]; sorted: Cell[][]; users: string[] } {
	const users = rng.sample(PERSON_NAMES, rng.int(2, 3)).sort(compareKeys);
	const rows: Cell[][] = [];
	for (const u of users) {
		const days = rng.sample([1, 2, 3, 4, 5, 6, 7, 8, 9], rng.int(3, 4));
		for (const d of days) rows.push([u, d, amountOf(rng)]);
	}
	const shuffled = rng.shuffle(rows);
	const sorted = [...shuffled].sort(
		(p, q) => compareKeys(p[0] as string, q[0] as string) || (p[1] as number) - (q[1] as number)
	);
	return { shuffled, sorted, users };
}

/** Applies `f` to the values of every user's rows (in the given order) and sums the result. */
function byUser(rows: readonly Cell[][], users: readonly string[], f: (xs: Cell[]) => Cell[]): number {
	return users.reduce((s, u) => s + sumSkip(f(rows.filter((r) => r[0] === u).map((r) => r[2] ?? null))), 0);
}

const absDiffs = (xs: readonly Cell[]): Cell[] =>
	xs.map((x, i) =>
		i === 0 || x === null || xs[i - 1] === null ? null : Math.abs((x as number) - (xs[i - 1] as number))
	);

const userFrame = (rows: Cell[][]): Frame => ({ name: 'df', columns: ['user', 'day', 'amount'], rows });

function groupShift(rng: Rng): Case {
	const { shuffled, sorted, users } = userRows(rng);
	return {
		frame: userFrame(shuffled),
		steps: [
			"df = df.sort_values(['user', 'day'])",
			"df['prev'] = df.groupby('user')['amount'].shift(1)",
			"print((df['amount'] - df['prev']).abs().sum())"
		],
		digits: 2,
		params: {},
		evaluate: (rule) =>
			rule === 'across-groups'
				? sumSkip(absDiffs(sorted.map((r) => r[2] ?? null)))
				: byUser(rule === 'unsorted' ? shuffled : sorted, users, absDiffs)
	};
}

function series(rng: Rng, n: number): Cell[] {
	return Array.from({ length: n }, () => amountOf(rng));
}

const dayFrame = (xs: readonly Cell[]): Frame => ({
	name: 'df',
	columns: ['day', 'amount'],
	rows: xs.map((x, i) => [i + 1, x])
});

function rollingMean(rng: Rng): Case {
	const w = rng.int(2, 4);
	const xs = series(rng, rng.int(7, 10));
	const k = rng.int(w + 1, xs.length - 2);
	const head = (ms: Cell[]): number => sumSkip(ms.slice(0, k));
	return {
		frame: dayFrame(xs),
		steps: [`df['ma'] = df['amount'].rolling(${w}).mean()`, `print(df['ma'].head(${k}).sum())`],
		digits: 2,
		params: { w, k },
		evaluate: (rule) => {
			if (rule === 'window-ahead') return head(rolling([...xs].reverse(), w, w).reverse());
			return head(rolling(xs, w, rule === 'partial-windows' ? 1 : w));
		}
	};
}

function groupCumsum(rng: Rng): Case {
	const { shuffled, users } = userRows(rng);
	const cum = (xs: Cell[]): Cell[] => {
		let s = 0;
		return xs.map((x) => (s += typeof x === 'number' ? x : 0));
	};
	return {
		frame: userFrame(shuffled),
		steps: ["df['cum'] = df.groupby('user')['amount'].cumsum()", "print(df['cum'].sum())"],
		digits: 2,
		params: {},
		evaluate: (rule) => {
			if (rule === 'global-cumsum') return sumSkip(cum(shuffled.map((r) => r[2] ?? null)));
			if (rule === 'group-total') return byUser(shuffled, users, (xs) => xs.map(() => sumSkip(xs)));
			return byUser(shuffled, users, cum);
		}
	};
}

function pctChange(rng: Rng): Case {
	const xs = Array.from({ length: rng.int(5, 8) }, () => rng.int(8, 60) * 5);
	return {
		frame: dayFrame(xs),
		steps: ["df['g'] = df['amount'].pct_change()", "print(df['g'].mean())"],
		digits: 4,
		params: {},
		evaluate: (rule) => {
			const changes = xs.slice(1).map((x, i) => {
				const prev = xs[i] ?? 1;
				return rule === 'reverse-ratio' ? (x - prev) / x : (x - prev) / prev;
			});
			const s = changes.reduce((a, b) => a + b, 0);
			return rule === 'first-zero' ? s / xs.length : s / changes.length;
		}
	};
}

function rollingMinPeriods(rng: Rng): Case {
	const { shuffled, sorted, users } = userRows(rng);
	return {
		frame: userFrame(shuffled),
		steps: [
			"df = df.sort_values(['user', 'day'])",
			"df['ma'] = df.groupby('user')['amount'].transform(lambda s: s.rolling(3, min_periods=2).mean())",
			"print(df['ma'].sum())"
		],
		digits: 2,
		params: {},
		evaluate: (rule) => {
			if (rule === 'across-groups')
				return sumSkip(
					rolling(
						sorted.map((r) => r[2] ?? null),
						3,
						2
					)
				);
			return byUser(sorted, users, (xs) => rolling(xs, 3, rule === 'min-periods-ignored' ? 3 : 2));
		}
	};
}

function expandingPrior(rng: Rng): Case {
	const { shuffled, sorted, users } = userRows(rng);
	const prior = (xs: Cell[], withCurrent: boolean): Cell[] =>
		xs.map((_, i) => {
			const past = present(xs.slice(0, withCurrent ? i + 1 : i));
			return past.length === 0 ? null : past.reduce((s, v) => s + v, 0) / past.length;
		});
	return {
		frame: userFrame(shuffled),
		steps: [
			"df = df.sort_values(['user', 'day'])",
			"df['prior'] = df.groupby('user')['amount'].transform(lambda s: s.shift(1).expanding().mean())",
			"print(df['prior'].sum())"
		],
		digits: 2,
		params: {},
		evaluate: (rule) => {
			if (rule === 'across-groups')
				return sumSkip(
					prior(
						sorted.map((r) => r[2] ?? null),
						false
					)
				);
			return byUser(sorted, users, (xs) => prior(xs, rule === 'includes-current'));
		}
	};
}

function ewm(rng: Rng): Case {
	const alpha = rng.pick([0.2, 0.3, 0.4, 0.6, 0.7]);
	const xs = series(rng, rng.int(5, 7)) as number[];
	return {
		frame: dayFrame(xs),
		steps: [`df['e'] = df['amount'].ewm(alpha=${alpha}, adjust=False).mean()`, "print(df['e'].iloc[-1])"],
		digits: 2,
		params: { alpha },
		evaluate: (rule) => {
			if (rule === 'adjust-true') {
				let num = 0;
				let den = 0;
				xs.forEach((x, i) => {
					const weight = (1 - alpha) ** (xs.length - 1 - i);
					num += weight * x;
					den += weight;
				});
				return num / den;
			}
			const a = rule === 'alpha-swapped' ? 1 - alpha : alpha;
			return xs.slice(1).reduce((e, x) => a * x + (1 - a) * e, xs[0] ?? 0);
		}
	};
}

function rollingNan(rng: Rng): Case {
	const xs: Cell[] = series(rng, rng.int(8, 11));
	const holes = rng.sample(
		Array.from({ length: xs.length - 1 }, (_, i) => i + 1),
		rng.int(2, 3)
	);
	for (const i of holes) xs[i] = null;
	return {
		frame: dayFrame(xs),
		steps: ["df['ma'] = df['amount'].rolling(3, min_periods=2).mean()", "print(df['ma'].sum())"],
		digits: 2,
		params: {},
		evaluate: (rule) => {
			if (rule === 'nan-as-zero')
				return sumSkip(
					rolling(
						xs.map((x) => x ?? 0),
						3,
						2
					)
				);
			if (rule === 'min-periods-counts-rows')
				return sumSkip(
					xs.map((_, i) => {
						const window = xs.slice(Math.max(0, i - 2), i + 1);
						const values = present(window);
						return window.length >= 2 && values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null;
					})
				);
			return sumSkip(rolling(xs, 3, 2));
		}
	};
}

const CASES: Record<string, (rng: Rng) => Case> = {
	'junior/group-shift': groupShift,
	'junior/rolling-mean': rollingMean,
	'junior/group-cumsum': groupCumsum,
	'junior/pct-change': pctChange,
	'middle/rolling-min-periods': rollingMinPeriods,
	'middle/expanding-prior': expandingPrior,
	'middle/ewm': ewm,
	'middle/rolling-nan': rollingNan
};

const PYTHON_REFERENCE = `import json

data = json.loads(input())
rows = data["frames"]["df"]["rows"]
op = data["op"]


def by_user(rows, f, sort=True):
    total = 0
    for user in sorted({r[0] for r in rows}):
        mine = [r for r in rows if r[0] == user]
        if sort:
            mine.sort(key=lambda r: r[1])
        total += sum(v for v in f([r[2] for r in mine]) if v is not None)
    return total


def window_mean(xs, w, need):
    out = []
    for i in range(len(xs)):
        vals = [v for v in xs[max(0, i - w + 1) : i + 1] if v is not None]
        out.append(sum(vals) / len(vals) if len(vals) >= need and vals else None)
    return out


if op == "junior/group-shift":
    print(by_user(rows, lambda xs: [abs(b - a) for a, b in zip(xs, xs[1:])]))
elif op == "junior/rolling-mean":
    w = data["w"]
    print(sum(v for v in window_mean([r[1] for r in rows], w, w)[: data["k"]] if v is not None))
elif op == "junior/group-cumsum":
    def cum(xs):
        out, s = [], 0
        for x in xs:
            s += x
            out.append(s)
        return out
    print(by_user(rows, cum, sort=False))
elif op == "junior/pct-change":
    xs = [r[1] for r in rows]
    ch = [(b - a) / a for a, b in zip(xs, xs[1:])]
    print(sum(ch) / len(ch))
elif op == "middle/rolling-min-periods":
    print(by_user(rows, lambda xs: window_mean(xs, 3, 2)))
elif op == "middle/expanding-prior":
    print(by_user(rows, lambda xs: [sum(xs[:i]) / i if i else None for i in range(len(xs))]))
elif op == "middle/ewm":
    a = data["alpha"]
    xs = [r[1] for r in rows]
    e = xs[0]
    for x in xs[1:]:
        e = a * x + (1 - a) * e
    print(e)
else:
    print(sum(v for v in window_mean([r[1] for r in rows], 3, 2) if v is not None))
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
				return [rule, v !== null && farApart(answer, v, c.digits) ? v : null];
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
					roundingRule(c.digits)
				].join('\n'),
				code: { language: 'python3', source: pandasSource([c.frame], c.steps) }
			},
			answer: floatAnswer(answer, c.digits)
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
						v === null ? null : { kind: 'answer' as const, answer: floatAnswer(v, c.digits) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${id} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
