// The best split of a decision-tree node: the threshold of a numeric feature by weighted Gini or by weighted MSE,
// the information gain of the best split by entropy, and the impurity of the best two-group split of a categorical
// feature. Every optimum is unique on the instance, and so is the optimum of every misconception.
import { farApart, floatAnswer, frameMarkdown, roundingRule, stdinJson, type Cell } from '../../_lib/ds.ts';
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
const DIGITS = 3;

const gini = (pos: number, n: number): number => (n === 0 ? 0 : 1 - (pos / n) ** 2 - ((n - pos) / n) ** 2);

function entropy(pos: number, n: number, log: (x: number) => number): number {
	if (n === 0) return 0;
	return [pos, n - pos].reduce((h, c) => (c === 0 ? h : h - (c / n) * log(c / n)), 0);
}

const errorRate = (pos: number, n: number): number => (n === 0 ? 0 : Math.min(pos, n - pos) / n);

function sse(ys: readonly number[]): number {
	if (ys.length === 0) return 0;
	const m = ys.reduce((s, y) => s + y, 0) / ys.length;
	return ys.reduce((s, y) => s + (y - m) ** 2, 0);
}

/** The unique minimum of `score` over `items` (`null` — a tie within 1e-9 for the best). */
function argminUnique<T>(items: readonly T[], score: (item: T) => number): { item: T; value: number } | null {
	const scored = items.map((item) => ({ item, value: score(item) })).sort((a, b) => a.value - b.value);
	const [first, second] = scored;
	if (!first || (second && second.value - first.value < 1e-9)) return null;
	return first;
}

/** The first minimum of `score` in the order of `items`: how a misconception scanning the candidates picks. */
function argminFirst<T>(items: readonly T[], score: (item: T) => number): { item: T; value: number } {
	let best: { item: T; value: number } | null = null;
	for (const item of items) {
		const value = score(item);
		if (best === null || value < best.value - 1e-9) best = { item, value };
	}
	if (best === null) throw new Error('argminFirst of no items');
	return best;
}

function thresholds(xs: readonly number[]): number[] {
	const values = [...new Set(xs)].sort((a, b) => a - b);
	return values.slice(1).map((v, i) => ((values[i] ?? 0) + v) / 2);
}

interface Split {
	left: number[];
	right: number[];
}

const splitAt = (xs: readonly number[], t: number): Split => ({
	left: xs.flatMap((x, i) => (x <= t ? [i] : [])),
	right: xs.flatMap((x, i) => (x > t ? [i] : []))
});

const positives = (rows: readonly number[], ys: readonly number[]): number => rows.filter((i) => ys[i] === 1).length;

function classImpurity(
	s: Split,
	ys: readonly number[],
	node: (pos: number, n: number) => number,
	weighted: boolean
): number {
	const n = ys.length;
	const l = node(positives(s.left, ys), s.left.length);
	const r = node(positives(s.right, ys), s.right.length);
	return weighted ? (s.left.length / n) * l + (s.right.length / n) * r : (l + r) / 2;
}

interface Task {
	markdown: string;
	answer: number;
	wrong: Record<string, number | null>;
	probe: object;
}

function numericData(rng: Rng, n: number): number[] {
	const xs: number[] = [];
	while (xs.length < n) xs.push(rng.int(1, 40));
	return xs;
}

/** Binary labels with a noisy dependence on x, so splits are informative but not perfect. */
function labels(rng: Rng, xs: readonly number[]): number[] {
	const cut = rng.int(10, 30);
	const up = rng.bool();
	return xs.map((x) => (x > cut === up ? (rng.bool(0.8) ? 1 : 0) : rng.bool(0.25) ? 1 : 0));
}

const RULES_NUMERIC =
	'Кандидаты порогов — середины между соседними различными значениями признака; строка с `x ≤ порог` идёт в левый потомок, остальные — в правый.';

function task(rng: Rng, classId: string): Task | null {
	const feature = rng.pick(['age', 'tenure', 'visits', 'price', 'score', 'days']);
	if (classId === 'categorical') {
		const cats = rng.sample(['web', 'ios', 'android', 'partner', 'email', 'ads', 'offline'], rng.int(4, 5));
		const counts = cats.map(() => rng.int(3, 9));
		const pos = counts.map((c) => rng.int(0, c));
		const n = counts.reduce((s, c) => s + c, 0);
		const total = pos.reduce((s, c) => s + c, 0);
		if (total === 0 || total === n) return null;
		// Non-trivial two-group splits: subsets containing the first category, not all of them.
		const masks = Array.from({ length: 2 ** (cats.length - 1) - 1 }, (_, m) => (m << 1) | 1);
		const score = (mask: number, weighted: boolean): number => {
			const inLeft = (i: number): boolean => ((mask >> i) & 1) === 1;
			const ln = counts.reduce((s, c, i) => s + (inLeft(i) ? c : 0), 0);
			const lp = pos.reduce((s, c, i) => s + (inLeft(i) ? c : 0), 0);
			const l = gini(lp, ln);
			const r = gini(total - lp, n - ln);
			return weighted ? (ln / n) * l + ((n - ln) / n) * r : (l + r) / 2;
		};
		const single = (mask: number): boolean => {
			const ones = mask
				.toString(2)
				.split('')
				.filter((b) => b === '1').length;
			return ones === 1 || ones === cats.length - 1;
		};
		const best = argminUnique(masks, (m) => score(m, true));
		const oneVsRest = argminFirst(masks.filter(single), (m) => score(m, true));
		const unweighted = argminFirst(masks, (m) => score(m, false));
		if (!best || single(best.item)) return null;
		const rows: Cell[][] = cats.map((c, i) => [c, counts[i] ?? 0, pos[i] ?? 0]);
		return {
			markdown: [
				`Узел дерева классификации содержит ${n} строк. Категориальный признак \`channel\` и число строк с \`y = 1\` по категориям:`,
				'',
				frameMarkdown(['channel', 'rows', 'y = 1'], rows),
				'',
				'Узел делят на два потомка, отправляя каждую категорию целиком в одну из групп (любое разбиение категорий на две непустые группы). Нечистота Gini узла — 1 − p₀² − p₁²; качество разбиения — сумма Gini потомков, взвешенная долями строк (меньше — лучше).',
				'',
				'Чему равна взвешенная нечистота Gini лучшего разбиения?',
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: best.value,
			wrong: { 'one-vs-rest': oneVsRest.value, unweighted: unweighted.value },
			probe: { kind: 'categorical', counts, pos }
		};
	}
	const n = rng.int(8, 14);
	const xs = numericData(rng, n);
	const cands = thresholds(xs);
	if (cands.length < 6) return null;
	if (classId === 'mse-threshold') {
		const cut = rng.int(10, 30);
		const ys = xs.map((x) => (x > cut ? rng.int(40, 90) : rng.int(5, 50)));
		const score = (t: number, weighted: boolean): number => {
			const s = splitAt(xs, t);
			const l = s.left.map((i) => ys[i] ?? 0);
			const r = s.right.map((i) => ys[i] ?? 0);
			return weighted ? (sse(l) + sse(r)) / n : (sse(l) / l.length + sse(r) / r.length) / 2;
		};
		const best = argminUnique(cands, (t) => score(t, true));
		const unweighted = argminFirst(cands, (t) => score(t, false));
		if (!best) return null;
		return {
			markdown: [
				`Узел дерева регрессии содержит ${n} строк: признак \`${feature}\` и целевая переменная \`y\`.`,
				'',
				frameMarkdown(
					[feature, 'y'],
					xs.map((x, i) => [x, ys[i] ?? 0])
				),
				'',
				`${RULES_NUMERIC} Качество порога — MSE потомков (средний квадрат отклонения от среднего потомка), взвешенная долями строк (меньше — лучше).`,
				'',
				'Какой порог выберет дерево?',
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: best.item,
			wrong: { unweighted: unweighted.item },
			probe: { kind: 'mse', xs, ys }
		};
	}
	const ys = labels(rng, xs);
	if (ys.every((y) => y === ys[0])) return null;
	const table = frameMarkdown(
		[feature, 'y'],
		xs.map((x, i) => [x, ys[i] ?? 0])
	);
	if (classId === 'gini-threshold') {
		const best = argminUnique(cands, (t) => classImpurity(splitAt(xs, t), ys, gini, true));
		const unweighted = argminFirst(cands, (t) => classImpurity(splitAt(xs, t), ys, gini, false));
		const errors = argminFirst(cands, (t) => classImpurity(splitAt(xs, t), ys, errorRate, true));
		if (!best) return null;
		return {
			markdown: [
				`Узел дерева классификации содержит ${n} строк: признак \`${feature}\` и метка \`y\`.`,
				'',
				table,
				'',
				`${RULES_NUMERIC} Нечистота Gini узла — 1 − p₀² − p₁²; качество порога — сумма Gini потомков, взвешенная долями строк (меньше — лучше).`,
				'',
				'Какой порог выберет дерево?',
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: best.item,
			wrong: { unweighted: unweighted.item, 'error-rate': errors.item },
			probe: { kind: 'gini', xs, ys }
		};
	}
	const parentBits = entropy(
		positives(
			xs.map((_, i) => i),
			ys
		),
		n,
		Math.log2
	);
	const parentNats = entropy(
		positives(
			xs.map((_, i) => i),
			ys
		),
		n,
		Math.log
	);
	const best = argminUnique(cands, (t) => classImpurity(splitAt(xs, t), ys, (p, m) => entropy(p, m, Math.log2), true));
	const unweighted = argminFirst(cands, (t) =>
		classImpurity(splitAt(xs, t), ys, (p, m) => entropy(p, m, Math.log2), false)
	);
	if (!best) return null;
	const nats = parentNats - classImpurity(splitAt(xs, best.item), ys, (p, m) => entropy(p, m, Math.log), true);
	return {
		markdown: [
			`Узел дерева классификации содержит ${n} строк: признак \`${feature}\` и метка \`y\`.`,
			'',
			table,
			'',
			`${RULES_NUMERIC} Энтропия узла — −Σ pₖ·log₂ pₖ (в битах); прирост информации порога — энтропия узла минус сумма энтропий потомков, взвешенная долями строк. Дерево выбирает порог с наибольшим приростом.`,
			'',
			'Чему равен прирост информации выбранного порога (в битах)?',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		answer: parentBits - best.value,
		wrong: { nats, unweighted: parentBits - unweighted.value },
		probe: { kind: 'entropy', xs, ys }
	};
}

const PYTHON_REFERENCE = `import json
from itertools import combinations
from math import log2

p = json.loads(input())
kind = p["kind"]

def gini(rows):
    if not rows:
        return 0.0
    q = sum(rows) / len(rows)
    return 1 - q * q - (1 - q) * (1 - q)

def ent(rows):
    if not rows:
        return 0.0
    q = sum(rows) / len(rows)
    return -sum(r * log2(r) for r in (q, 1 - q) if r > 0)

def mse(rows):
    if not rows:
        return 0.0
    m = sum(rows) / len(rows)
    return sum((r - m) ** 2 for r in rows) / len(rows)

if kind == "categorical":
    counts, pos = p["counts"], p["pos"]
    cats = range(len(counts))
    n = sum(counts)
    best = None
    for size in range(1, len(counts)):
        for left in combinations(cats, size):
            ly = [1] * sum(pos[i] for i in left) + [0] * sum(counts[i] - pos[i] for i in left)
            ry = [1] * sum(pos[i] for i in cats if i not in left) + [0] * sum(counts[i] - pos[i] for i in cats if i not in left)
            score = len(ly) / n * gini(ly) + len(ry) / n * gini(ry)
            best = score if best is None else min(best, score)
    print(repr(best))
else:
    xs, ys = p["xs"], p["ys"]
    n = len(xs)
    vals = sorted(set(xs))
    results = []
    for a, b in zip(vals, vals[1:]):
        t = (a + b) / 2
        ly = [y for x, y in zip(xs, ys) if x <= t]
        ry = [y for x, y in zip(xs, ys) if x > t]
        f = {"gini": gini, "entropy": ent, "mse": mse}[kind]
        results.append((len(ly) / n * f(ly) + len(ry) / n * f(ry), t))
    score, t = min(results)
    print(repr(ent(ys) - score) if kind == "entropy" else repr(t))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const t = task(rng, input.classId);
		if (t === null) continue;
		if (Object.values(t.wrong).some((w) => w !== null && !farApart(t.answer, w, DIGITS))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: t.markdown, code: null },
			answer: floatAnswer(t.answer, DIGITS)
		});
		const all = Object.fromEntries(descriptor.wrongSolutions.map((w) => [w.id, t.wrong[w.id] ?? null]));
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(t.probe) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(all).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
