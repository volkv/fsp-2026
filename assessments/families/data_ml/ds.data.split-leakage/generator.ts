// Leakage in time-ordered features built with pandas: which features of a row use data not known when the row is
// predicted — future rows, statistics over the whole column or group, the row's own target. The reference proves the
// answer by perturbation: it changes everything a row's prediction may not see and checks which features move.
import { stdinJson } from '../../_lib/ds.ts';
import { framesMarkdown, pandasSource, type Frame } from '../../_lib/ds-frame.ts';
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
	'shift-sign' | 'current-feature-leaks' | 'global-safe' | 'own-target-safe' | 'centered-safe' | 'any-target-leaks';
const RULES: readonly Rule[] = [
	'shift-sign',
	'current-feature-leaks',
	'global-safe',
	'own-target-safe',
	'centered-safe',
	'any-target-leaks'
];

type Tag = 'lag' | 'lead' | 'current' | 'global' | 'own-target' | 'centered' | 'past-target';

interface Kind {
	leaks: boolean;
	tags: readonly Tag[];
	/** The pandas expression; `y` — the target column, `x` — the feature column, `k` and `w` — the drawn shift and window. */
	expr: (c: { y: string; x: string; k: number; w: number }) => string;
}

const KINDS: Record<string, Kind> = {
	lag_y: { leaks: false, tags: ['lag', 'past-target'], expr: (c) => `df['${c.y}'].shift(${c.k})` },
	lag_group_y: {
		leaks: false,
		tags: ['lag', 'past-target'],
		expr: (c) => `df.groupby('user')['${c.y}'].shift(1)`
	},
	lead_y: { leaks: true, tags: ['lead'], expr: (c) => `df['${c.y}'].shift(-${c.k})` },
	lead_x: { leaks: true, tags: ['lead'], expr: (c) => `df['${c.x}'].shift(-1)` },
	diff_x: { leaks: false, tags: ['lag', 'current'], expr: (c) => `df['${c.x}'].diff()` },
	diff_lead_x: { leaks: true, tags: ['lead'], expr: (c) => `df['${c.x}'].diff(-1)` },
	roll_x: { leaks: false, tags: ['current'], expr: (c) => `df['${c.x}'].rolling(${c.w}).mean()` },
	cumsum_x: { leaks: false, tags: ['current'], expr: (c) => `df.groupby('user')['${c.x}'].cumsum()` },
	norm_x: {
		leaks: true,
		tags: ['global'],
		expr: (c) => `(df['${c.x}'] - df['${c.x}'].mean()) / df['${c.x}'].std()`
	},
	rank_x: { leaks: true, tags: ['global'], expr: (c) => `df['${c.x}'].rank(pct=True)` },
	group_mean_x: { leaks: true, tags: ['global'], expr: (c) => `df.groupby('user')['${c.x}'].transform('mean')` },
	group_mean_y: { leaks: true, tags: ['global'], expr: (c) => `df.groupby('user')['${c.y}'].transform('mean')` },
	expanding_prev_y: {
		leaks: false,
		tags: ['past-target'],
		expr: (c) => `df.groupby('user')['${c.y}'].transform(lambda s: s.shift(1).expanding().mean())`
	},
	roll_prev_y: {
		leaks: false,
		tags: ['past-target'],
		expr: (c) => `df['${c.y}'].shift(1).rolling(${c.w}).mean()`
	},
	roll_y: { leaks: true, tags: ['own-target'], expr: (c) => `df['${c.y}'].rolling(${c.w}).mean()` },
	expanding_y: {
		leaks: true,
		tags: ['own-target'],
		expr: (c) => `df.groupby('user')['${c.y}'].transform(lambda s: s.expanding().mean())`
	},
	cummax_y: { leaks: true, tags: ['own-target'], expr: (c) => `df.groupby('user')['${c.y}'].cummax()` },
	centered_x: { leaks: true, tags: ['centered'], expr: (c) => `df['${c.x}'].rolling(3, center=True).mean()` },
	centered_prev_y: {
		leaks: true,
		tags: ['centered'],
		expr: (c) => `df['${c.y}'].shift(1).rolling(3, center=True).mean()`
	}
};

const THEMES: Record<string, readonly string[]> = {
	shifts: ['lag_y', 'lag_group_y', 'lead_y', 'lead_x', 'diff_x', 'diff_lead_x'],
	'global-stats': ['norm_x', 'rank_x', 'group_mean_x', 'group_mean_y', 'cumsum_x', 'expanding_prev_y', 'roll_x'],
	'own-target': ['roll_y', 'expanding_y', 'cummax_y', 'roll_prev_y', 'expanding_prev_y', 'lag_group_y', 'roll_x'],
	windows: ['centered_x', 'centered_prev_y', 'roll_x', 'roll_prev_y', 'cumsum_x', 'lead_x', 'diff_x']
};

const REQUIRED: Record<string, Rule> = {
	shifts: 'shift-sign',
	'global-stats': 'global-safe',
	'own-target': 'own-target-safe',
	windows: 'centered-safe'
};

/** Whether a feature of this kind leaks in the eyes of a misconception (or truly, without one). */
function leaksUnder(kind: Kind, rule: Rule | null): boolean {
	const has = (t: Tag) => kind.tags.includes(t);
	switch (rule) {
		case 'shift-sign':
			return has('lag') ? true : has('lead') ? false : kind.leaks;
		case 'current-feature-leaks':
			return has('current') || kind.leaks;
		case 'global-safe':
			return has('global') ? false : kind.leaks;
		case 'own-target-safe':
			return has('own-target') ? false : kind.leaks;
		case 'centered-safe':
			return has('centered') ? false : kind.leaks;
		case 'any-target-leaks':
			return has('past-target') || kind.leaks;
		case null:
			return kind.leaks;
	}
}

const FEATURE_NAMES = ['alpha', 'beta', 'gamma', 'delta', 'kappa', 'sigma', 'theta', 'omega', 'zeta', 'iota'];

interface Feature {
	name: string;
	kind: string;
}

const PYTHON_REFERENCE = `import json
import math

data = json.loads(input())
f = data["frames"]["df"]
cols = f["columns"]
base = sorted((dict(zip(cols, r)) for r in f["rows"]), key=lambda r: r["day"])
X, Y, K, W = data["x"], data["y"], data["k"], data["w"]


def shift(xs, k):
    n = len(xs)
    return [xs[i - k] if 0 <= i - k < n else None for i in range(n)]


def by_user(rows, f):
    out = [None] * len(rows)
    for u in {r["user"] for r in rows}:
        idx = [i for i, r in enumerate(rows) if r["user"] == u]
        for i, v in zip(idx, f([rows[i] for i in idx])):
            out[i] = v
    return out


def roll(xs, w, center=False):
    out = []
    for i in range(len(xs)):
        lo = i - w // 2 if center else i - w + 1
        win = xs[lo : lo + w] if lo >= 0 else []
        ok = len(win) == w and all(v is not None for v in win)
        out.append(sum(win) / w if ok else None)
    return out


def expanding(xs):
    out, seen = [], []
    for v in xs:
        if v is not None:
            seen.append(v)
        out.append(sum(seen) / len(seen) if seen else None)
    return out


def rank_pct(xs):
    n = len(xs)
    return [(sum(1 for y in xs if y < v) + (sum(1 for y in xs if y == v) + 1) / 2) / n for v in xs]


def feature(kind, rows):
    x = [r[X] for r in rows]
    y = [r[Y] for r in rows]
    if kind == "lag_y":
        return shift(y, K)
    if kind == "lag_group_y":
        return by_user(rows, lambda g: shift([r[Y] for r in g], 1))
    if kind == "lead_y":
        return shift(y, -K)
    if kind == "lead_x":
        return shift(x, -1)
    if kind == "diff_x":
        p = shift(x, 1)
        return [None if b is None else a - b for a, b in zip(x, p)]
    if kind == "diff_lead_x":
        p = shift(x, -1)
        return [None if b is None else a - b for a, b in zip(x, p)]
    if kind == "roll_x":
        return roll(x, W)
    if kind == "cumsum_x":
        return by_user(rows, lambda g: [sum(r[X] for r in g[: i + 1]) for i in range(len(g))])
    if kind == "norm_x":
        m = sum(x) / len(x)
        s = math.sqrt(sum((v - m) ** 2 for v in x) / (len(x) - 1))
        return [(v - m) / s for v in x]
    if kind == "rank_x":
        return rank_pct(x)
    if kind == "group_mean_x":
        return by_user(rows, lambda g: [sum(r[X] for r in g) / len(g)] * len(g))
    if kind == "group_mean_y":
        return by_user(rows, lambda g: [sum(r[Y] for r in g) / len(g)] * len(g))
    if kind == "expanding_prev_y":
        return by_user(rows, lambda g: expanding(shift([r[Y] for r in g], 1)))
    if kind == "roll_prev_y":
        return roll(shift(y, 1), W)
    if kind == "roll_y":
        return roll(y, W)
    if kind == "expanding_y":
        return by_user(rows, lambda g: expanding([r[Y] for r in g]))
    if kind == "cummax_y":
        return by_user(rows, lambda g: [max(r[Y] for r in g[: i + 1]) for i in range(len(g))])
    if kind == "centered_x":
        return roll(x, 3, center=True)
    if kind == "centered_prev_y":
        return roll(shift(y, 1), 3, center=True)
    raise ValueError(kind)


def same(a, b):
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))


leaky = set()
for feat in data["features"]:
    original = feature(feat["kind"], base)
    for i in range(len(base)):
        for sign in (1, -1):
            # Everything the prediction of row i may not see: its own target and every later row.
            changed = [dict(r) for r in base]
            for j in range(i, len(base)):
                changed[j][Y] += sign * (1000 + j)
                if j > i:
                    changed[j][X] += sign * (1000 + j)
            if not same(original[i], feature(feat["kind"], changed)[i]):
                leaky.add(feat["name"])
for name in sorted(leaky):
    print(name)
`;

function scenario(
	rng: Rng,
	theme: string
): { frame: Frame; features: Feature[]; c: { y: string; x: string; k: number; w: number } } {
	const c = {
		y: rng.pick(['spend', 'orders', 'revenue']),
		x: rng.pick(['visits', 'clicks', 'views']),
		k: rng.int(1, 2),
		w: rng.int(2, 3)
	};
	const users = rng.sample(PERSON_NAMES, rng.int(2, 3));
	const n = rng.int(8, 10);
	const days = rng
		.sample(
			Array.from({ length: 30 }, (_, i) => i + 1),
			n
		)
		.sort((a, b) => a - b);
	// Every user has at least two rows, so a group statistic always sees a later row of the group.
	const owners = rng.shuffle([
		...users,
		...users,
		...Array.from({ length: n - 2 * users.length }, () => rng.pick(users))
	]);
	const rows = rng.shuffle(days.map((d, i) => [d, owners[i] ?? '', rng.int(1, 40), rng.int(0, 30) * 10]));
	const kinds = rng.sample(THEMES[theme] ?? [], 5);
	const names = rng.sample(FEATURE_NAMES, 5);
	return {
		frame: { name: 'df', columns: ['day', 'user', c.x, c.y], rows },
		features: kinds.map((kind, i) => ({ name: names[i] ?? '', kind })),
		c
	};
}

const leakySet = (features: readonly Feature[], rule: Rule | null): string[] =>
	features
		.filter((f) => {
			const kind = KINDS[f.kind];
			if (!kind) throw new Error(`unknown feature kind ${f.kind}`);
			return leaksUnder(kind, rule);
		})
		.map((f) => f.name)
		.sort();

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const theme = input.classId;
	for (let tries = 0; tries < 300; tries += 1) {
		const s = scenario(rng, theme);
		const answer = leakySet(s.features, null);
		if (answer.length === 0 || answer.length === s.features.length) continue;
		const key = JSON.stringify(answer);
		const wrong = Object.fromEntries(
			RULES.map((rule) => {
				const set = leakySet(s.features, rule);
				return [rule, JSON.stringify(set) === key ? null : set];
			})
		);
		const required = REQUIRED[theme];
		if (required && wrong[required] === null) continue;
		const steps = [
			"df = df.sort_values('day').reset_index(drop=True)",
			...s.features.map((f) => `df['${f.name}'] = ${KINDS[f.kind]?.expr(s.c) ?? ''}`)
		];
		const markdown = [
			framesMarkdown([s.frame]),
			'',
			`Модель по признакам строки прогнозирует \`${s.c.y}\` этого дня. В момент прогноза известны все столбцы прошлых дней и \`${s.c.x}\` текущего дня, но не \`${s.c.y}\` текущего дня и ничего из более поздних дней (дни всех строк разные).`,
			'',
			`Признак **протекает**, если хотя бы в одной строке его значение зависит от данных, недоступных в момент прогноза этой строки. Какие из признаков ${s.features.map((f) => `\`${f.name}\``).join(', ')} протекают?`,
			'',
			'Введите имена протекающих признаков — по одному в строке, порядок не важен.'
		].join('\n');
		const instance = makeInstance(descriptor, input, {
			statement: { markdown, code: { language: 'python3', source: pandasSource([s.frame], steps) } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: stdinJson({
					frames: { df: { columns: s.frame.columns, rows: s.frame.rows } },
					features: s.features,
					...s.c
				})
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([rule, set]) => [
						rule,
						set === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value: set } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${theme} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
