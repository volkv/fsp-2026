// Joining tables with pandas `merge`: how repeated keys multiply rows, which keys inner, left and outer joins keep,
// what NaN a left join leaves, anti-joins through `indicator`, pairs of keys and NaN in a key, which pandas joins.
import { floatAnswer, roundingRule, type Cell, farApart } from '../../_lib/ds.ts';
import { framesMarkdown, meanSkip, pandasSource, referenceStdin, sumSkip, type Frame } from '../../_lib/ds-frame.ts';
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
	| 'no-multiply'
	| 'keeps-unmatched'
	| 'nan-as-zero'
	| 'mean-over-right'
	| 'inner-only'
	| 'left-only'
	| 'all-left-rows'
	| 'first-key-only'
	| 'sql-null';

const RULES: readonly Rule[] = [
	'no-multiply',
	'keeps-unmatched',
	'nan-as-zero',
	'mean-over-right',
	'inner-only',
	'left-only',
	'all-left-rows',
	'first-key-only',
	'sql-null'
];

const REQUIRED: Record<string, Rule[]> = {
	'intern/inner-dup': ['no-multiply', 'keeps-unmatched'],
	'intern/left-nan': ['nan-as-zero', 'mean-over-right'],
	'intern/many-to-many': ['no-multiply'],
	'intern/outer': ['inner-only', 'left-only'],
	'junior/agg-then-merge': ['inner-only', 'keeps-unmatched'],
	'junior/anti-join': ['all-left-rows'],
	'junior/composite-key': ['first-key-only'],
	'junior/nan-keys': ['sql-null']
};

type Rec = Record<string, Cell>;
type How = 'inner' | 'left' | 'outer';

function records(f: Frame): Rec[] {
	return f.rows.map((row) => Object.fromEntries(f.columns.map((c, i) => [c, row[i] ?? null])));
}

/** pandas `merge`: every pair of rows with equal keys (NaN equals NaN in pandas); the misconceptions change that. */
function merge(
	left: readonly Rec[],
	right: readonly Rec[],
	on: readonly string[],
	how: How,
	opts: { nanMatches: boolean; multiply: boolean }
): (Rec & { _merge: string })[] {
	const same = (a: Rec, b: Rec): boolean =>
		on.every((k) =>
			a[k] === null || b[k] === null ? opts.nanMatches && a[k] === null && b[k] === null : a[k] === b[k]
		);
	const out: (Rec & { _merge: string })[] = [];
	const used = new Set<Rec>();
	const rightCols = right.length ? Object.keys(right[0] ?? {}) : [];
	const leftCols = left.length ? Object.keys(left[0] ?? {}) : [];
	for (const l of left) {
		const matches = right.filter((r) => same(l, r));
		const taken = opts.multiply ? matches : matches.slice(0, 1);
		for (const r of taken) {
			used.add(r);
			out.push({ ...r, ...l, _merge: 'both' });
		}
		for (const r of matches) used.add(r);
		if (matches.length === 0 && how !== 'inner') {
			const blank = Object.fromEntries(rightCols.filter((c) => !on.includes(c)).map((c) => [c, null]));
			out.push({ ...blank, ...l, _merge: 'left_only' });
		}
	}
	if (how === 'outer') {
		for (const r of right) {
			if (used.has(r)) continue;
			const blank = Object.fromEntries(leftCols.filter((c) => !on.includes(c)).map((c) => [c, null]));
			out.push({ ...blank, ...r, _merge: 'right_only' });
		}
	}
	return out;
}

const col = (rows: readonly Rec[], name: string): Cell[] => rows.map((r) => r[name] ?? null);
const num = (v: Cell): number | null => (typeof v === 'number' ? v : null);

interface Case {
	frames: Frame[];
	steps: string[];
	params: Record<string, unknown>;
	evaluate: (rule: Rule | null) => number | null;
}

const frame = (name: string, columns: string[], rows: Cell[][]): Frame => ({ name, columns, rows });

function codes(rng: Rng, n: number, prefix: string): string[] {
	return rng.sample(
		Array.from({ length: 40 }, (_, i) => `${prefix}${i + 11}`),
		n
	);
}

function innerDup(rng: Rng): Case {
	const ids = rng.sample([11, 12, 13, 14, 15, 16, 17, 18, 19], 5);
	const [dup, ...rest] = ids as [number, ...number[]];
	const known = [dup, ...rest.slice(0, 2)];
	const users: Cell[][] = known.map((id) => [id, rng.pick(CITY_NAMES)]);
	users.push([dup, rng.pick(CITY_NAMES)]);
	const orders: Cell[][] = [];
	orders.push([dup, rng.int(2, 90) * 10], [rest[3] ?? 99, rng.int(2, 90) * 10]);
	for (let i = rng.int(3, 5); i > 0; i -= 1) orders.push([rng.pick(ids), rng.int(2, 90) * 10]);
	const o = frame(
		'orders',
		['order_id', 'user_id', 'amount'],
		rng.shuffle(orders).map((r, i) => [100 + i, ...r])
	);
	const u = frame('users', ['user_id', 'city'], rng.shuffle(users));
	return {
		frames: [o, u],
		steps: ["m = orders.merge(users, on='user_id')", "print(m['amount'].sum())"],
		params: {},
		evaluate: (rule) =>
			sumSkip(
				col(
					merge(records(o), records(u), ['user_id'], rule === 'keeps-unmatched' ? 'left' : 'inner', {
						nanMatches: true,
						multiply: rule !== 'no-multiply'
					}),
					'amount'
				)
			)
	};
}

function leftNan(rng: Rng): Case {
	const ids = rng.sample([21, 22, 23, 24, 25, 26, 27, 28], 5);
	const known = ids.slice(0, 3);
	const users = frame('users', ['user_id', 'discount'], rng.shuffle(known.map((id) => [id, rng.int(1, 30)])));
	const orders: Cell[][] = [[known[0] ?? 0], [known[0] ?? 0], [ids[3] ?? 0], [known[1] ?? 0]];
	for (let i = rng.int(2, 4); i > 0; i -= 1) orders.push([rng.pick(ids)]);
	const o = frame(
		'orders',
		['order_id', 'user_id'],
		rng.shuffle(orders).map((r, i) => [200 + i, ...r])
	);
	return {
		frames: [o, users],
		steps: ["m = orders.merge(users, on='user_id', how='left')", "print(m['discount'].mean())"],
		params: {},
		evaluate: (rule) => {
			if (rule === 'mean-over-right') return meanSkip(col(records(users), 'discount'));
			const m = merge(records(o), records(users), ['user_id'], 'left', { nanMatches: true, multiply: true });
			const d = col(m, 'discount');
			return rule === 'nan-as-zero' ? sumSkip(d) / d.length : meanSkip(d);
		}
	};
}

function manyToMany(rng: Rng): Case {
	const skus = codes(rng, 4, 'A');
	const items: Cell[][] = [];
	const prices: Cell[][] = [];
	const [a, b, c, d] = skus as [string, string, string, string];
	items.push([a, rng.int(1, 9)], [a, rng.int(1, 9)], [b, rng.int(1, 9)], [d, rng.int(1, 9)]);
	if (rng.bool()) items.push([c, rng.int(1, 9)]);
	prices.push([a, rng.int(5, 60)], [a, rng.int(5, 60)], [b, rng.int(5, 60)], [b, rng.int(5, 60)], [c, rng.int(5, 60)]);
	const i = frame('items', ['sku', 'qty'], rng.shuffle(items));
	const p = frame('prices', ['sku', 'price'], rng.shuffle(prices));
	return {
		frames: [i, p],
		steps: ["m = items.merge(prices, on='sku')", "print((m['qty'] * m['price']).sum())"],
		params: {},
		evaluate: (rule) =>
			merge(records(i), records(p), ['sku'], rule === 'keeps-unmatched' ? 'left' : 'inner', {
				nanMatches: true,
				multiply: rule !== 'no-multiply'
			}).reduce((s, r) => {
				const q = num(r.qty ?? null);
				const pr = num(r.price ?? null);
				return q === null || pr === null ? s : s + q * pr;
			}, 0)
	};
}

function outer(rng: Rng): Case {
	const depts = rng.sample(['sales', 'ops', 'dev', 'hr', 'qa', 'legal', 'data', 'ads'], 6);
	const plan = frame('plan', ['dept', 'budget'], rng.shuffle(depts.slice(0, 4).map((d) => [d, rng.int(10, 90) * 10])));
	const fact = frame(
		'fact',
		['dept', 'spent'],
		rng.shuffle([...depts.slice(1, 3), ...depts.slice(4)].map((d) => [d, rng.int(10, 90) * 10]))
	);
	return {
		frames: [plan, fact],
		steps: [
			"m = plan.merge(fact, on='dept', how='outer')",
			"print((m['budget'].fillna(0) - m['spent'].fillna(0)).abs().sum())"
		],
		params: {},
		evaluate: (rule) => {
			const how: How = rule === 'inner-only' ? 'inner' : rule === 'left-only' ? 'left' : 'outer';
			return merge(records(plan), records(fact), ['dept'], how, { nanMatches: true, multiply: true }).reduce(
				(s, r) => s + Math.abs((num(r.budget ?? null) ?? 0) - (num(r.spent ?? null) ?? 0)),
				0
			);
		}
	};
}

function aggThenMerge(rng: Rng): Case {
	const ids = rng.sample(
		Array.from({ length: 30 }, (_, i) => 501 + i),
		6
	);
	const orders = frame(
		'orders',
		['order_id', 'amount'],
		rng.shuffle(ids.slice(0, 5).map((id) => [id, rng.int(20, 90) * 10]))
	);
	const pays: Cell[][] = [];
	const [p1, p2, , , , stray] = ids as [number, number, number, number, number, number];
	pays.push(
		[p1, rng.int(1, 15) * 10],
		[p1, rng.int(1, 15) * 10],
		[p2, rng.int(1, 15) * 10],
		[stray, rng.int(1, 15) * 10]
	);
	for (let i = rng.int(1, 3); i > 0; i -= 1) pays.push([rng.pick(ids.slice(0, 4)), rng.int(1, 15) * 10]);
	const payments = frame('payments', ['order_id', 'paid'], rng.shuffle(pays));
	return {
		frames: [orders, payments],
		steps: [
			"paid = payments.groupby('order_id', as_index=False)['paid'].sum()",
			"m = orders.merge(paid, on='order_id', how='left')",
			"print((m['amount'] - m['paid'].fillna(0)).sum())"
		],
		params: {},
		evaluate: (rule) => {
			const sums = new Map<number, number>();
			for (const r of records(payments)) {
				const id = num(r.order_id ?? null) ?? 0;
				sums.set(id, (sums.get(id) ?? 0) + (num(r.paid ?? null) ?? 0));
			}
			const paid = [...sums.entries()].map(([order_id, p]) => ({ order_id, paid: p }));
			const how: How = rule === 'inner-only' ? 'inner' : rule === 'keeps-unmatched' ? 'outer' : 'left';
			return merge(records(orders), paid, ['order_id'], how, { nanMatches: true, multiply: true }).reduce(
				(s, r) => s + (num(r.amount ?? null) ?? 0) - (num(r.paid ?? null) ?? 0),
				0
			);
		}
	};
}

function antiJoin(rng: Rng): Case {
	const people = rng.sample(PERSON_NAMES, 6);
	const users = frame('users', ['user_id', 'bonus'], rng.shuffle(people.map((p) => [p, rng.int(1, 40) * 5])));
	const buyers = people.slice(0, rng.int(2, 3));
	const ord: Cell[][] = [];
	for (const b of buyers) ord.push([b, rng.int(5, 90) * 10]);
	ord.push([buyers[0] ?? '', rng.int(5, 90) * 10]);
	for (let i = rng.int(0, 2); i > 0; i -= 1) ord.push([rng.pick(buyers), rng.int(5, 90) * 10]);
	const orders = frame('orders', ['user_id', 'amount'], rng.shuffle(ord));
	return {
		frames: [users, orders],
		steps: [
			"m = users.merge(orders, on='user_id', how='left', indicator=True)",
			"lonely = m[m['_merge'] == 'left_only']",
			"print(lonely['bonus'].sum())"
		],
		params: {},
		evaluate: (rule) => {
			const m = merge(records(users), records(orders), ['user_id'], 'left', { nanMatches: true, multiply: true });
			return sumSkip(col(rule === 'all-left-rows' ? m : m.filter((r) => r._merge === 'left_only'), 'bonus'));
		}
	};
}

function compositeKey(rng: Rng): Case {
	const stores = rng.sample(CITY_NAMES, 2);
	const days = rng.sample([1, 2, 3, 4, 5, 6, 7], 3).sort((a, b) => a - b);
	const sales: Cell[][] = [];
	const traffic: Cell[][] = [];
	for (const st of stores) {
		for (const d of days) {
			if (rng.bool(0.8)) sales.push([st, d, rng.int(10, 99) * 10]);
			if (rng.bool(0.85)) traffic.push([st, d, rng.int(5, 60)]);
		}
	}
	sales.push([stores[0] ?? '', days[0] ?? 1, rng.int(10, 99) * 10]);
	traffic.push([stores[0] ?? '', days[1] ?? 2, rng.int(5, 60)]);
	const dedup = (rows: Cell[][]): Cell[][] => {
		const seen = new Set<string>();
		return rows.filter((r) => {
			const k = `${r[0]}|${r[1]}`;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
	};
	const s = frame('sales', ['store', 'day', 'amount'], rng.shuffle(dedup(sales)));
	const t = frame('traffic', ['store', 'day', 'visitors'], rng.shuffle(dedup(traffic)));
	return {
		frames: [s, t],
		steps: ["m = sales.merge(traffic, on=['store', 'day'], how='left')", "print((m['amount'] / m['visitors']).mean())"],
		params: {},
		evaluate: (rule) => {
			const right =
				rule === 'first-key-only'
					? records(t).map((r) => ({ store: r.store ?? null, visitors: r.visitors ?? null }))
					: records(t);
			const on = rule === 'first-key-only' ? ['store'] : ['store', 'day'];
			const m = merge(records(s), right, on, 'left', { nanMatches: true, multiply: true });
			return meanSkip(
				m.map((r) => {
					const a = num(r.amount ?? null);
					const v = num(r.visitors ?? null);
					return a === null || v === null ? null : a / v;
				})
			);
		}
	};
}

function nanKeys(rng: Rng): Case {
	const cs = rng.sample(['SPRING', 'WELCOME', 'VIP', 'BLACK', 'FRIEND', 'AUTUMN'], 3);
	const left: Cell[][] = [
		[null, rng.int(10, 90) * 10],
		[cs[0] ?? '', rng.int(10, 90) * 10]
	];
	if (rng.bool()) left.push([null, rng.int(10, 90) * 10]);
	for (let i = rng.int(2, 4); i > 0; i -= 1) left.push([rng.pick(cs), rng.int(10, 90) * 10]);
	const right: Cell[][] = [[null, rng.int(1, 9) / 10], ...cs.slice(0, 2).map((c): Cell[] => [c, rng.int(1, 9) / 10])];
	const o = frame(
		'orders',
		['order_id', 'promo', 'amount'],
		rng.shuffle(left).map((r, i) => [300 + i, ...r])
	);
	const p = frame('promos', ['promo', 'rate'], rng.shuffle(right));
	return {
		frames: [o, p],
		steps: ["m = orders.merge(promos, on='promo')", "print((m['amount'] * m['rate']).sum())"],
		params: {},
		evaluate: (rule) =>
			merge(records(o), records(p), ['promo'], 'inner', { nanMatches: rule !== 'sql-null', multiply: true }).reduce(
				(s, r) => s + (num(r.amount ?? null) ?? 0) * (num(r.rate ?? null) ?? 0),
				0
			)
	};
}

const CASES: Record<string, (rng: Rng) => Case> = {
	'intern/inner-dup': innerDup,
	'intern/left-nan': leftNan,
	'intern/many-to-many': manyToMany,
	'intern/outer': outer,
	'junior/agg-then-merge': aggThenMerge,
	'junior/anti-join': antiJoin,
	'junior/composite-key': compositeKey,
	'junior/nan-keys': nanKeys
};

const PYTHON_REFERENCE = `import json

data = json.loads(input())
frames = {n: [dict(zip(f["columns"], r)) for r in f["rows"]] for n, f in data["frames"].items()}
op = data["op"]


def merge(left, right, on, how):
    out = []
    used = set()
    rcols = list(right[0].keys()) if right else []
    lcols = list(left[0].keys()) if left else []
    for l in left:
        hit = False
        for j, r in enumerate(right):
            if all(l[k] == r[k] for k in on):
                row = dict(r)
                row.update(l)
                row["_merge"] = "both"
                out.append(row)
                used.add(j)
                hit = True
        if not hit and how in ("left", "outer"):
            row = {c: None for c in rcols if c not in on}
            row.update(l)
            row["_merge"] = "left_only"
            out.append(row)
    if how == "outer":
        for j, r in enumerate(right):
            if j not in used:
                row = {c: None for c in lcols if c not in on}
                row.update(r)
                row["_merge"] = "right_only"
                out.append(row)
    return out


def present(xs):
    return [x for x in xs if x is not None]


if op == "intern/inner-dup":
    m = merge(frames["orders"], frames["users"], ["user_id"], "inner")
    print(sum(present(r["amount"] for r in m)))
elif op == "intern/left-nan":
    m = merge(frames["orders"], frames["users"], ["user_id"], "left")
    d = present(r["discount"] for r in m)
    print(sum(d) / len(d))
elif op == "intern/many-to-many":
    m = merge(frames["items"], frames["prices"], ["sku"], "inner")
    print(sum(r["qty"] * r["price"] for r in m))
elif op == "intern/outer":
    m = merge(frames["plan"], frames["fact"], ["dept"], "outer")
    print(sum(abs((r["budget"] or 0) - (r["spent"] or 0)) for r in m))
elif op == "junior/agg-then-merge":
    sums = {}
    for p in frames["payments"]:
        sums[p["order_id"]] = sums.get(p["order_id"], 0) + p["paid"]
    paid = [{"order_id": k, "paid": v} for k, v in sums.items()]
    m = merge(frames["orders"], paid, ["order_id"], "left")
    print(sum(r["amount"] - (r["paid"] or 0) for r in m))
elif op == "junior/anti-join":
    m = merge(frames["users"], frames["orders"], ["user_id"], "left")
    print(sum(r["bonus"] for r in m if r["_merge"] == "left_only"))
elif op == "junior/composite-key":
    m = merge(frames["sales"], frames["traffic"], ["store", "day"], "left")
    q = [r["amount"] / r["visitors"] for r in m if r["visitors"] is not None]
    print(sum(q) / len(q))
else:
    m = merge(frames["orders"], frames["promos"], ["promo"], "inner")
    print(sum(r["amount"] * r["rate"] for r in m))
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
				const value = c.evaluate(rule);
				return [rule, value !== null && farApart(answer, value, DIGITS) ? value : null];
			})
		);
		if ((REQUIRED[id] ?? []).some((rule) => wrong[rule] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					framesMarkdown(c.frames),
					'',
					'Что напечатает программа (pandas 2 и новее, параметры по умолчанию)?',
					'',
					roundingRule(DIGITS)
				].join('\n'),
				code: { language: 'python3', source: pandasSource(c.frames, c.steps) }
			},
			answer: floatAnswer(answer, DIGITS)
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: referenceStdin(c.frames, { op: id }) }),
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
