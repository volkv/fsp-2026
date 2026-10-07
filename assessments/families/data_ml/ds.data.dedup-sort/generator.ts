// Duplicates, sorting and ranks in pandas: which row drop_duplicates keeps, where NaN goes in a sort, the top of a
// group, shares from value_counts, the last record by time, rank methods on ties, stable order and nlargest.
import { floatAnswer, roundingRule, type Cell, farApart } from '../../_lib/ds.ts';
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
import { CITY_NAMES, PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

type Rule =
	| 'keep-swapped'
	| 'subset-ignored'
	| 'nan-as-smallest'
	| 'descending'
	| 'ascending-both'
	| 'nan-counted'
	| 'alphabetical'
	| 'unsorted'
	| 'keep-first'
	| 'rank-dense'
	| 'rank-first'
	| 'ties-reversed'
	| 'exactly-k';

const RULES: readonly Rule[] = [
	'keep-swapped',
	'subset-ignored',
	'nan-as-smallest',
	'descending',
	'ascending-both',
	'nan-counted',
	'alphabetical',
	'unsorted',
	'keep-first',
	'rank-dense',
	'rank-first',
	'ties-reversed',
	'exactly-k'
];

const REQUIRED: Record<string, Rule[]> = {
	'intern/keep-rule': ['keep-swapped', 'subset-ignored'],
	'intern/sort-nan-last': ['nan-as-smallest', 'descending'],
	'intern/top-per-group': ['ascending-both'],
	'intern/value-counts-top': ['nan-counted', 'alphabetical'],
	'junior/last-per-user': ['unsorted', 'keep-first'],
	'junior/rank-min': ['rank-dense', 'rank-first'],
	'junior/stable-ties': ['ties-reversed'],
	'junior/nlargest-all': ['exactly-k']
};

interface Case {
	frame: Frame;
	steps: string[];
	digits: number;
	params: Record<string, unknown>;
	evaluate: (rule: Rule | null) => number | null;
}

const amountOf = (rng: Rng): number => rng.int(2, 99) * 10;
const total = (rows: readonly Cell[][], i: number): number =>
	rows.reduce((s, r) => s + (typeof r[i] === 'number' ? r[i] : 0), 0);

/** Rows by the value of a column, keeping the original order of equal ones; `null` goes last unless asked otherwise. */
function sortBy(rows: readonly Cell[][], i: number, descending: boolean, nanFirst = false): Cell[][] {
	const tagged = rows.map((r, k) => ({ r, k }));
	tagged.sort((p, q) => {
		const a = p.r[i] ?? null;
		const b = q.r[i] ?? null;
		if (a === null || b === null) {
			if (a === b) return p.k - q.k;
			return (a === null ? 1 : -1) * (nanFirst ? -1 : 1);
		}
		const d = (a as number) - (b as number);
		return (descending ? -d : d) || p.k - q.k;
	});
	return tagged.map((t) => t.r);
}

function keepRule(rng: Rng): Case {
	const users = rng.sample(PERSON_NAMES, 4);
	const items = ['book', 'pen', 'lamp', 'cup', 'bag'];
	const rows: Cell[][] = [];
	for (const u of users) for (let i = rng.int(1, 3); i > 0; i -= 1) rows.push([u, rng.pick(items), amountOf(rng)]);
	rows.push([...(rows[0] ?? [])]);
	const shuffled = rng.shuffle(rows);
	const keep = rng.pick(['first', 'last'] as const);
	return {
		frame: { name: 'df', columns: ['user', 'item', 'amount'], rows: shuffled },
		steps: [`res = df.drop_duplicates(subset=['user'], keep='${keep}')`, "print(res['amount'].sum())"],
		digits: 2,
		params: { keep },
		evaluate: (rule) => {
			const seen = new Set<string>();
			const which = rule === 'keep-swapped' ? (keep === 'first' ? 'last' : 'first') : keep;
			const ordered = which === 'last' ? [...shuffled].reverse() : shuffled;
			const kept = ordered.filter((r) => {
				const k = rule === 'subset-ignored' ? JSON.stringify(r) : String(r[0]);
				if (seen.has(k)) return false;
				seen.add(k);
				return true;
			});
			return total(kept, 2);
		}
	};
}

function sortNanLast(rng: Rng): Case {
	const n = rng.int(7, 9);
	const names = rng.sample(PERSON_NAMES, n);
	const scores = rng.sample(
		Array.from({ length: 60 }, (_, i) => i + 20),
		n
	);
	const rows: Cell[][] = names.map((name, i) => [name, scores[i] ?? 0, amountOf(rng)]);
	const nan = rng.int(1, 2);
	for (const i of rng.sample(
		rows.map((_, k) => k),
		nan
	))
		(rows[i] as Cell[])[1] = null;
	const k = rng.int(3, 4);
	return {
		frame: { name: 'df', columns: ['name', 'score', 'amount'], rows },
		steps: [`res = df.sort_values('score').head(${k})`, "print(res['amount'].sum())"],
		digits: 2,
		params: { k },
		evaluate: (rule) => total(sortBy(rows, 1, rule === 'descending', rule === 'nan-as-smallest').slice(0, k), 2)
	};
}

function topPerGroup(rng: Rng): Case {
	const cities = rng.sample(CITY_NAMES, rng.int(3, 4));
	const rows: Cell[][] = [];
	for (const c of cities) for (let i = rng.int(2, 3); i > 0; i -= 1) rows.push([c, amountOf(rng)]);
	const shuffled = rng.shuffle(rows);
	return {
		frame: { name: 'df', columns: ['city', 'amount'], rows: shuffled },
		steps: [
			"res = df.sort_values(['city', 'amount'], ascending=[True, False]).drop_duplicates('city')",
			"print(res['amount'].sum())"
		],
		digits: 2,
		params: {},
		evaluate: (rule) =>
			cities.reduce((s, c) => {
				const xs = shuffled.filter((r) => r[0] === c).map((r) => r[1] as number);
				return s + (rule === 'ascending-both' ? Math.min(...xs) : Math.max(...xs));
			}, 0)
	};
}

function valueCountsTop(rng: Rng): Case {
	const cities = rng.sample(CITY_NAMES, 3);
	const counts = rng.shuffle([rng.int(3, 4), rng.int(1, 2), rng.int(1, 2)]);
	const rows: Cell[][] = [];
	cities.forEach((c, i) => {
		for (let k = 0; k < (counts[i] ?? 0); k += 1) rows.push([c, amountOf(rng)]);
	});
	// Missing cities outnumber every city: value_counts drops them all the same.
	for (let k = Math.max(...counts) + rng.int(1, 2); k > 0; k -= 1) rows.push([null, amountOf(rng)]);
	const shuffled = rng.shuffle(rows);
	const meanOf = (city: string | null): number => {
		const xs = shuffled.filter((r) => r[0] === city).map((r) => r[1] as number);
		return xs.reduce((s, v) => s + v, 0) / xs.length;
	};
	const top = cities[counts.indexOf(Math.max(...counts))] ?? '';
	return {
		frame: { name: 'df', columns: ['city', 'amount'], rows: shuffled },
		steps: ["vc = df['city'].value_counts()", 'top = vc.index[0]', "print(df.loc[df['city'] == top, 'amount'].mean())"],
		digits: 2,
		params: {},
		evaluate: (rule) =>
			rule === 'nan-counted'
				? meanOf(null)
				: rule === 'alphabetical'
					? meanOf([...cities].sort()[0] ?? '')
					: meanOf(top)
	};
}

function lastPerUser(rng: Rng): Case {
	const users = rng.sample(PERSON_NAMES, 3);
	const times = rng.sample(
		Array.from({ length: 80 }, (_, i) => i + 10),
		rng.int(9, 11)
	);
	const rows: Cell[][] = times.map((t, i) => [users[i % users.length] ?? '', t, amountOf(rng)]);
	const shuffled = rng.shuffle(rows);
	return {
		frame: { name: 'df', columns: ['user', 'ts', 'amount'], rows: shuffled },
		steps: ["res = df.sort_values('ts').drop_duplicates('user', keep='last')", "print(res['amount'].sum())"],
		digits: 2,
		params: {},
		evaluate: (rule) =>
			users.reduce((s, u) => {
				const mine = shuffled.filter((r) => r[0] === u);
				const pick =
					rule === 'unsorted'
						? mine[mine.length - 1]
						: [...mine].sort((p, q) => (p[1] as number) - (q[1] as number))[
								rule === 'keep-first' ? 0 : mine.length - 1
							];
				const amount = pick?.[2];
				return s + (typeof amount === 'number' ? amount : 0);
			}, 0)
	};
}

function rankMin(rng: Rng): Case {
	const cities = rng.sample(CITY_NAMES, 3);
	const rows: Cell[][] = [];
	for (const c of cities) {
		const base = rng.sample([31, 37, 42, 48, 53, 59, 64, 71, 76, 83, 88, 94], 3).sort((a, b) => b - a);
		const pattern = rng.pick([
			[0, 0, 1, 2],
			[0, 1, 1, 2],
			[0, 1, 2, 2],
			[0, 0, 0, 1],
			[0, 1, 1, 1]
		]);
		for (const p of pattern) rows.push([c, (base[p] ?? 0) * 10]);
	}
	const shuffled = rng.shuffle(rows);
	return {
		frame: { name: 'df', columns: ['city', 'amount'], rows: shuffled },
		steps: [
			"df['r'] = df.groupby('city')['amount'].rank(method='min', ascending=False)",
			"print(df.loc[df['r'] <= 2, 'amount'].sum())"
		],
		digits: 2,
		params: {},
		evaluate: (rule) =>
			cities.reduce((s, c) => {
				const mine = shuffled.filter((r) => r[0] === c).map((r) => r[1] as number);
				const order = [...mine].sort((a, b) => b - a);
				let sum = 0;
				if (rule === 'rank-first') {
					sum = (order[0] ?? 0) + (order[1] ?? 0);
				} else {
					for (const v of mine) {
						const rank =
							rule === 'rank-dense'
								? 1 + new Set(mine.filter((x) => x > v)).size
								: 1 + mine.filter((x) => x > v).length;
						if (rank <= 2) sum += v;
					}
				}
				return s + sum;
			}, 0)
	};
}

function stableTies(rng: Rng): Case {
	const n = rng.int(8, 10);
	const names = rng.sample(PERSON_NAMES, n);
	const levels = rng.sample([3, 4, 5, 6, 7, 8, 9], 4).sort((a, b) => b - a);
	const k = rng.int(3, 5);
	const rows: Cell[][] = names.map((name) => [name, rng.pick(levels), amountOf(rng)]);
	return {
		frame: { name: 'df', columns: ['name', 'score', 'amount'], rows },
		steps: [`res = df.sort_values('score', ascending=False, kind='stable').head(${k})`, "print(res['amount'].sum())"],
		digits: 2,
		params: { k },
		evaluate: (rule) => {
			const base = rule === 'ties-reversed' ? [...rows].reverse() : rows;
			return total(sortBy(base, 1, true).slice(0, k), 2);
		}
	};
}

function nlargestAll(rng: Rng): Case {
	const n = rng.int(8, 10);
	const names = rng.sample(PERSON_NAMES, n);
	const k = rng.int(2, 4);
	const values = Array.from({ length: n }, () => rng.int(6, 40) * 10);
	const rows: Cell[][] = names.map((name, i) => [name, values[i] ?? 0]);
	return {
		frame: { name: 'df', columns: ['name', 'amount'], rows },
		steps: [`res = df.nlargest(${k}, 'amount', keep='all')`, "print(res['amount'].sum())"],
		digits: 2,
		params: { k },
		evaluate: (rule) => {
			const sorted = [...values].sort((a, b) => b - a);
			if (rule === 'exactly-k') return sorted.slice(0, k).reduce((s, v) => s + v, 0);
			const bar = sorted[k - 1] ?? 0;
			return sorted.filter((v) => v >= bar).reduce((s, v) => s + v, 0);
		}
	};
}

const CASES: Record<string, (rng: Rng) => Case> = {
	'intern/keep-rule': keepRule,
	'intern/sort-nan-last': sortNanLast,
	'intern/top-per-group': topPerGroup,
	'intern/value-counts-top': valueCountsTop,
	'junior/last-per-user': lastPerUser,
	'junior/rank-min': rankMin,
	'junior/stable-ties': stableTies,
	'junior/nlargest-all': nlargestAll
};

const PYTHON_REFERENCE = `import json

data = json.loads(input())
rows = data["frames"]["df"]["rows"]
op = data["op"]

if op == "intern/keep-rule":
    seq = rows if data["keep"] == "first" else rows[::-1]
    seen = {}
    for r in seq:
        seen.setdefault(r[0], r)
    print(sum(r[2] for r in seen.values()))
elif op == "intern/sort-nan-last":
    known = sorted((r for r in rows if r[1] is not None), key=lambda r: r[1])
    order = known + [r for r in rows if r[1] is None]
    print(sum(r[2] for r in order[: data["k"]]))
elif op == "intern/top-per-group":
    best = {}
    for city, amount in rows:
        best[city] = max(best.get(city, amount), amount)
    print(sum(best.values()))
elif op == "intern/value-counts-top":
    cities = [r[0] for r in rows if r[0] is not None]
    top = max(set(cities), key=cities.count)
    xs = [r[1] for r in rows if r[0] == top]
    print(sum(xs) / len(xs))
elif op == "junior/last-per-user":
    last = {}
    for user, ts, amount in sorted(rows, key=lambda r: r[1]):
        last[user] = amount
    print(sum(last.values()))
elif op == "junior/rank-min":
    total = 0
    for city, amount in rows:
        better = sum(1 for c, a in rows if c == city and a > amount)
        if better + 1 <= 2:
            total += amount
    print(total)
elif op == "junior/stable-ties":
    order = sorted(rows, key=lambda r: -r[1])
    print(sum(r[2] for r in order[: data["k"]]))
else:
    values = sorted((r[1] for r in rows), reverse=True)
    bar = values[data["k"] - 1]
    print(sum(v for v in values if v >= bar))
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
