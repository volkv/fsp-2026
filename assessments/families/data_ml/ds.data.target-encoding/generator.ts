// Target encoding with pandas: the value of the encoded feature when the mean of the category is taken out of fold,
// smoothed towards the prior of the training part, without the row itself, or replaced by the prior for a category the
// training part has not seen.
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
import { CITY_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 3;

type Rule = 'naive' | 'unseen-as-zero' | 'no-smoothing' | 'stats-from-all' | 'loo-count' | 'unseen-dropped';
const RULES: readonly Rule[] = [
	'naive',
	'unseen-as-zero',
	'no-smoothing',
	'stats-from-all',
	'loo-count',
	'unseen-dropped'
];

const REQUIRED: Record<string, Rule[]> = {
	'middle/out-of-fold': ['naive', 'unseen-as-zero'],
	'middle/smoothing': ['no-smoothing', 'stats-from-all'],
	'middle/leave-one-out': ['naive', 'loo-count'],
	'middle/unseen-category': ['unseen-as-zero', 'unseen-dropped', 'stats-from-all']
};

interface Row {
	cat: string;
	y: number;
	part: number | string;
}

interface Case {
	frame: Frame;
	steps: string[];
	params: Record<string, unknown>;
	evaluate: (rule: Rule | null) => number;
}

const mean = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;

/** Category → mean target over the rows. */
function means(rows: readonly Row[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const c of new Set(rows.map((r) => r.cat))) out.set(c, mean(rows.filter((r) => r.cat === c).map((r) => r.y)));
	return out;
}

function names(rng: Rng): { cat: string; y: string; cats: string[] } {
	const cat = rng.pick(['city', 'device', 'brand']);
	const pool: readonly string[] =
		cat === 'city'
			? CITY_NAMES
			: cat === 'device'
				? ['ios', 'android', 'web', 'tv', 'tablet']
				: ['acme', 'nova', 'zeta', 'orion', 'lumo'];
	return { cat, y: rng.pick(['clicked', 'churn', 'bought']), cats: rng.sample(pool, 4) };
}

function outOfFold(rng: Rng): Case {
	const n = names(rng);
	const rows: Row[] = [];
	const [rare, ...common] = n.cats as [string, ...string[]];
	for (let fold = 1; fold <= 3; fold += 1)
		for (let i = rng.int(3, 4); i > 0; i -= 1) rows.push({ cat: rng.pick(common), y: rng.int(0, 1), part: fold });
	// A category met in one fold only: out of fold it has no statistics.
	const only = rng.int(1, 3);
	rows.push({ cat: rare, y: 1, part: only }, { cat: rare, y: rng.int(0, 1), part: only });
	const shuffled = rng.shuffle(rows);
	const frame: Frame = {
		name: 'df',
		columns: ['fold', n.cat, n.y],
		rows: shuffled.map((r) => [r.part, r.cat, r.y])
	};
	return {
		frame,
		steps: [
			"df['te'] = 0.0",
			"for k in sorted(df['fold'].unique()):",
			"    train = df[df['fold'] != k]",
			`    means = train.groupby('${n.cat}')['${n.y}'].mean()`,
			"    mask = df['fold'] == k",
			`    df.loc[mask, 'te'] = df.loc[mask, '${n.cat}'].map(means).fillna(train['${n.y}'].mean())`,
			"print(df['te'].mean())"
		],
		params: {},
		evaluate: (rule) => {
			if (rule === 'naive') {
				const all = means(shuffled);
				return mean(shuffled.map((r) => all.get(r.cat) ?? 0));
			}
			return mean(
				shuffled.map((r) => {
					const train = shuffled.filter((t) => t.part !== r.part);
					const m = means(train).get(r.cat);
					return m ?? (rule === 'unseen-as-zero' ? 0 : mean(train.map((t) => t.y)));
				})
			);
		}
	};
}

function trainTest(rng: Rng, unseen: boolean): { rows: Row[]; n: ReturnType<typeof names> } {
	const n = names(rng);
	const [fresh, ...seen] = n.cats as [string, ...string[]];
	const rows: Row[] = [];
	for (let i = rng.int(8, 10); i > 0; i -= 1) rows.push({ cat: rng.pick(seen), y: rng.int(0, 1), part: 'train' });
	for (const c of seen) if (!rows.some((r) => r.cat === c)) rows.push({ cat: c, y: rng.int(0, 1), part: 'train' });
	for (let i = rng.int(3, 4); i > 0; i -= 1) rows.push({ cat: rng.pick(seen), y: rng.int(0, 1), part: 'test' });
	if (unseen) rows.push({ cat: fresh, y: rng.int(0, 1), part: 'test' });
	return { rows: rng.shuffle(rows), n };
}

const splitFrame = (rows: readonly Row[], n: ReturnType<typeof names>): Frame => ({
	name: 'df',
	columns: ['split', n.cat, n.y],
	rows: rows.map((r): Cell[] => [r.part, r.cat, r.y])
});

const SPLIT_STEPS = ["train = df[df['split'] == 'train']", "test = df[df['split'] == 'test']"];

function smoothing(rng: Rng): Case {
	const { rows, n } = trainTest(rng, false);
	const m = rng.int(2, 10);
	return {
		frame: splitFrame(rows, n),
		steps: [
			...SPLIT_STEPS,
			`prior = train['${n.y}'].mean()`,
			`stats = train.groupby('${n.cat}')['${n.y}'].agg(['sum', 'count'])`,
			`enc = (stats['sum'] + ${m} * prior) / (stats['count'] + ${m})`,
			`print(test['${n.cat}'].map(enc).mean())`
		],
		params: { m },
		evaluate: (rule) => {
			const base = rule === 'stats-from-all' ? rows : rows.filter((r) => r.part === 'train');
			const prior = mean(base.map((r) => r.y));
			return mean(
				rows
					.filter((r) => r.part === 'test')
					.map((r) => {
						const ys = base.filter((t) => t.cat === r.cat).map((t) => t.y);
						return rule === 'no-smoothing' ? mean(ys) : (ys.reduce((s, v) => s + v, 0) + m * prior) / (ys.length + m);
					})
			);
		}
	};
}

function leaveOneOut(rng: Rng): Case {
	const n = names(rng);
	const rows: Row[] = [];
	for (const c of n.cats.slice(0, rng.int(3, 4)))
		for (let i = rng.int(2, 6); i > 0; i -= 1) rows.push({ cat: c, y: rng.int(0, 1), part: 0 });
	const shuffled = rng.shuffle(rows);
	return {
		frame: { name: 'df', columns: [n.cat, n.y], rows: shuffled.map((r) => [r.cat, r.y]) },
		steps: [
			`g = df.groupby('${n.cat}')['${n.y}']`,
			`df['te'] = (g.transform('sum') - df['${n.y}']) / (g.transform('count') - 1)`,
			`print(df.loc[df['${n.y}'] == 1, 'te'].mean())`
		],
		params: {},
		evaluate: (rule) =>
			mean(
				shuffled
					.filter((r) => r.y === 1)
					.map((r) => {
						const ys = shuffled.filter((t) => t.cat === r.cat).map((t) => t.y);
						const sum = ys.reduce((s, v) => s + v, 0);
						if (rule === 'naive') return sum / ys.length;
						return (sum - r.y) / (rule === 'loo-count' ? ys.length : ys.length - 1);
					})
			)
	};
}

function unseenCategory(rng: Rng): Case {
	const { rows, n } = trainTest(rng, true);
	return {
		frame: splitFrame(rows, n),
		steps: [
			...SPLIT_STEPS,
			`means = train.groupby('${n.cat}')['${n.y}'].mean()`,
			`prior = train['${n.y}'].mean()`,
			`te = test['${n.cat}'].map(means).fillna(prior)`,
			'print(te.mean())'
		],
		params: {},
		evaluate: (rule) => {
			const train = rows.filter((r) => r.part === 'train');
			const ms = means(train);
			const prior = mean((rule === 'stats-from-all' ? rows : train).map((r) => r.y));
			const values = rows
				.filter((r) => r.part === 'test')
				.flatMap((r) => {
					const m = ms.get(r.cat);
					if (m !== undefined) return [m];
					return rule === 'unseen-dropped' ? [] : [rule === 'unseen-as-zero' ? 0 : prior];
				});
			return mean(values);
		}
	};
}

const CASES: Record<string, (rng: Rng) => Case> = {
	'middle/out-of-fold': outOfFold,
	'middle/smoothing': smoothing,
	'middle/leave-one-out': leaveOneOut,
	'middle/unseen-category': unseenCategory
};

const PYTHON_REFERENCE = `import json

data = json.loads(input())
f = data["frames"]["df"]
rows = f["rows"]
op = data["op"]


def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs)


def cat_means(rs, ci, yi):
    out = {}
    for r in rs:
        out.setdefault(r[ci], []).append(r[yi])
    return {k: mean(v) for k, v in out.items()}


if op == "middle/out-of-fold":
    te = []
    for r in rows:
        train = [t for t in rows if t[0] != r[0]]
        cm = cat_means(train, 1, 2)
        te.append(cm.get(r[1], mean(t[2] for t in train)))
    print(mean(te))
elif op == "middle/leave-one-out":
    te = []
    for r in rows:
        if r[1] != 1:
            continue
        ys = [t[1] for t in rows if t[0] == r[0]]
        te.append((sum(ys) - r[1]) / (len(ys) - 1))
    print(mean(te))
else:
    train = [r for r in rows if r[0] == "train"]
    test = [r for r in rows if r[0] == "test"]
    prior = mean(r[2] for r in train)
    if op == "middle/smoothing":
        m = data["m"]
        enc = []
        for r in test:
            ys = [t[2] for t in train if t[1] == r[1]]
            enc.append((sum(ys) + m * prior) / (len(ys) + m))
        print(mean(enc))
    else:
        cm = cat_means(train, 1, 2)
        print(mean(cm.get(r[1], prior) for r in test))
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
		if (!Number.isFinite(answer)) continue;
		const wrong = Object.fromEntries(
			RULES.map((rule) => {
				const v = c.evaluate(rule);
				return [rule, farApart(answer, v, DIGITS) ? v : null];
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
