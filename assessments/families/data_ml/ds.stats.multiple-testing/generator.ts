// Multiple testing: which of the experiment's hypotheses a procedure rejects — Bonferroni, Holm, Benjamini–Hochberg,
// Hochberg; Senior — Benjamini–Yekutieli, a primary metric whose outcome sets the level of the secondary ones,
// z-statistics instead of p-values and weighted Bonferroni. The answer is the set of rejected metrics.
import {
	readDescriptor,
	type Built,
	type ComputedAnswer,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { num } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';
import { normalCdf } from '../../_lib/stats.ts';

const descriptor = readDescriptor(import.meta.url);

const METRICS = [
	'ctr',
	'conversion',
	'arpu',
	'retention_d1',
	'retention_d7',
	'session_length',
	'orders',
	'aov',
	'refunds',
	'support_tickets',
	'search_success',
	'add_to_cart',
	'checkout_start',
	'push_open',
	'crash_rate',
	'page_load',
	'bounce_rate',
	'reviews',
	'shares',
	'wishlist',
	'cart_value',
	'repeat_orders',
	'signup_rate',
	'trial_start',
	'paid_conversion',
	'churn_d30',
	'nps',
	'time_to_first_order',
	'items_per_order',
	'coupon_use'
] as const;

interface Hypothesis {
	name: string;
	p: number;
}

const set = (names: readonly string[]): ComputedAnswer => ({ kind: 'set', value: [...names].sort() });
const sorted = (hs: readonly Hypothesis[]): Hypothesis[] => [...hs].sort((a, b) => a.p - b.p);

/** Step-down: reject in order of p while p₍ᵢ₎ passes its threshold; `stop` false keeps going past a failure. */
function stepDown(hs: readonly Hypothesis[], threshold: (i: number, m: number) => number, stop = true): string[] {
	const out: string[] = [];
	const s = sorted(hs);
	for (let i = 0; i < s.length; i += 1) {
		const h = s[i] as Hypothesis;
		if (h.p <= threshold(i + 1, s.length)) out.push(h.name);
		else if (stop) break;
	}
	return out;
}

/** Step-up: the largest i whose p₍ᵢ₎ passes its threshold; every hypothesis up to it is rejected. */
function stepUp(hs: readonly Hypothesis[], threshold: (i: number, m: number) => number): string[] {
	const s = sorted(hs);
	let k = 0;
	s.forEach((h, i) => {
		if (h.p <= threshold(i + 1, s.length)) k = i + 1;
	});
	return s.slice(0, k).map((h) => h.name);
}

const bonferroni = (hs: readonly Hypothesis[], alpha: number): string[] =>
	hs.filter((h) => h.p <= alpha / hs.length).map((h) => h.name);
const holm = (hs: readonly Hypothesis[], alpha: number, stop = true): string[] =>
	stepDown(hs, (i, m) => alpha / (m - i + 1), stop);
const bh = (hs: readonly Hypothesis[], alpha: number): string[] => stepUp(hs, (i, m) => (i * alpha) / m);
const harmonic = (m: number): number => Array.from({ length: m }, (_, i) => 1 / (i + 1)).reduce((s, x) => s + x, 0);

/** p-values of an experiment: a few real effects among nulls; distinct, four places. */
function hypotheses(rng: Rng, m: number): Hypothesis[] {
	const names = rng.sample(METRICS, m);
	const signals = rng.int(2, m - 2);
	const ps = new Set<number>();
	while (ps.size < m) {
		const p = ps.size < signals ? rng.int(1, 300) / 10000 : rng.int(5, 9000) / 10000;
		ps.add(p);
	}
	const values = rng.shuffle([...ps]);
	return names.map((name, i) => ({ name, p: values[i] ?? 0 }));
}

/** No p-value within a hair of a threshold any procedure compares it with: the boundary never decides. */
function clearOf(hs: readonly Hypothesis[], thresholds: readonly number[]): boolean {
	return hs.every((h) => thresholds.every((t) => Math.abs(h.p - t) > 1e-9));
}

function thresholds(m: number, alpha: number, extra: readonly number[] = []): number[] {
	const out = [alpha, ...extra];
	for (let i = 1; i <= m; i += 1) out.push(alpha / i, (i * alpha) / m, (i * alpha) / (m * harmonic(m)));
	return out;
}

function pTable(hs: readonly Hypothesis[]): string[] {
	return ['| метрика | p-value |', '| --- | --- |', ...hs.map((h) => `| ${h.name} | ${num(h.p)} |`)];
}

const ANSWER_RULE =
	'Ответ — набор названий метрик, чьи нулевые гипотезы отвергнуты: по одному названию в строке, порядок не важен.';

function scenario(
	rng: Rng,
	cls: string,
	describe: (m: number, alpha: number) => string,
	right: (hs: readonly Hypothesis[], alpha: number) => string[],
	wrong: Record<string, (hs: readonly Hypothesis[], alpha: number) => string[]>
): ComputedScenario | null {
	const m = rng.int(6, 12);
	const alpha = rng.pick([0.05, 0.1]);
	const hs = hypotheses(rng, m);
	if (!clearOf(hs, thresholds(m, alpha))) return null;
	const answer = right(hs, alpha);
	if (answer.length < 2) return null;
	return {
		markdown: [
			`В эксперименте проверили ${m} метрик, у каждой — своя нулевая гипотеза «эффекта нет». p-value:`,
			'',
			...pTable(hs),
			'',
			describe(m, alpha),
			'',
			ANSWER_RULE
		].join('\n'),
		code: null,
		answer: set(answer),
		input: { cls, alpha, hypotheses: hs },
		wrong: Object.fromEntries(Object.entries(wrong).map(([id, fn]) => [id, set(fn(hs, alpha))]))
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	bonferroni: (rng) =>
		scenario(
			rng,
			'bonferroni',
			(m, alpha) =>
				`Вероятность хотя бы одной ложной находки (FWER) ограничивают уровнем α = ${alpha} **поправкой Бонферрони**. Какие гипотезы отвергаются?`,
			bonferroni,
			{ unadjusted: (hs, alpha) => hs.filter((h) => h.p <= alpha).map((h) => h.name) }
		),
	holm: (rng) =>
		scenario(
			rng,
			'holm',
			(m, alpha) =>
				`FWER ограничивают уровнем α = ${alpha} **процедурой Холма**: p-value сортируются по возрастанию, p₍ᵢ₎ сравнивается с α/(m − i + 1), начиная с наименьшего, пока сравнение проходит. Какие гипотезы отвергаются?`,
			(hs, alpha) => holm(hs, alpha),
			{ bonferroni, 'no-stop': (hs, alpha) => holm(hs, alpha, false) }
		),
	bh: (rng) =>
		scenario(
			rng,
			'bh',
			(m, alpha) =>
				`Долю ложных открытий (FDR) ограничивают уровнем q = ${alpha} **процедурой Бенджамини — Хохберга**: p-value сортируются по возрастанию, ищется наибольший i с p₍ᵢ₎ ≤ i·q/m, отвергаются гипотезы с первой по i-ю. Какие гипотезы отвергаются?`,
			bh,
			{ 'step-down-bh': (hs, alpha) => stepDown(hs, (i, m) => (i * alpha) / m), bonferroni }
		),
	hochberg: (rng) =>
		scenario(
			rng,
			'hochberg',
			(m, alpha) =>
				`FWER ограничивают уровнем α = ${alpha} **процедурой Хохберга** (восходящей): p-value сортируются по возрастанию, ищется наибольший i с p₍ᵢ₎ ≤ α/(m − i + 1), отвергаются гипотезы с первой по i-ю. Какие гипотезы отвергаются?`,
			(hs, alpha) => stepUp(hs, (i, m) => alpha / (m - i + 1)),
			{ holm: (hs, alpha) => holm(hs, alpha) }
		),
	by: (rng) =>
		scenario(
			rng,
			'by',
			(m, alpha) =>
				`Метрики сильно зависимы, поэтому FDR на уровне q = ${alpha} контролируют **процедурой Бенджамини — Йекутиели**: как Бенджамини — Хохберг, но с порогами p₍ᵢ₎ ≤ i·q / (m·c(m)), где c(m) = 1 + 1/2 + … + 1/m. Какие гипотезы отвергаются?`,
			(hs, alpha) => stepUp(hs, (i, m) => (i * alpha) / (m * harmonic(m))),
			{ 'bh-instead': bh }
		),
	gatekeeping,
	'holm-from-z': holmFromZ,
	'weighted-bonferroni': weightedBonferroni
};

function gatekeeping(rng: Rng): ComputedScenario | null {
	const m = rng.int(5, 10);
	const alpha = rng.pick([0.05, 0.1]);
	const half = alpha / 2;
	const all = hypotheses(rng, m + 1);
	// Both outcomes of the primary test: below α/2 it is rejected; between α/2 and α it is not, though it is below α.
	const opens = rng.bool();
	const ticks = Math.round(half * 10000);
	const primary = {
		...(all[0] as Hypothesis),
		p: (opens ? rng.int(1, ticks - 1) : rng.int(ticks + 1, 2 * ticks)) / 10000
	};
	const secondary = all.slice(1);
	if (
		!clearOf(secondary, thresholds(m, alpha)) ||
		!clearOf(secondary, thresholds(m, half)) ||
		!clearOf([primary, ...secondary], thresholds(m + 1, alpha))
	)
		return null;
	const answer = opens ? [primary.name, ...holm(secondary, alpha)] : holm(secondary, half);
	if (answer.length < 2) return null;
	return {
		markdown: [
			`Эксперимент оценивают по **первичной** метрике ${primary.name} (p-value ${num(primary.p)}) и ${m} вторичным:`,
			'',
			...pTable(secondary),
			'',
			`По протоколу (процедура с переносом уровня, FWER ≤ α = ${alpha}): первичная метрика проверяется на уровне α/2 = ${num(half)}. Если её гипотеза отвергнута, вторичные проверяются процедурой Холма на уровне α = ${alpha}; если нет — процедурой Холма на уровне α/2 = ${num(half)}. Холм на уровне a среди ${m} вторичных: p-value сортируются по возрастанию, p₍ᵢ₎ сравнивается с a/(m − i + 1), начиная с наименьшего, пока сравнение проходит. Какие гипотезы отвергаются (включая первичную, если она отвергнута)?`,
			'',
			ANSWER_RULE
		].join('\n'),
		code: null,
		answer: set(answer),
		input: { cls: 'gatekeeping', alpha, primary, hypotheses: secondary },
		wrong: {
			'pooled-holm': set(holm([primary, ...secondary], alpha)),
			...(opens
				? {}
				: {
						'ignores-gate': set(holm(secondary, alpha)),
						'primary-at-alpha': set([primary.name, ...holm(secondary, alpha)])
					})
		}
	};
}

function holmFromZ(rng: Rng): ComputedScenario | null {
	const m = rng.int(6, 12);
	const alpha = rng.pick([0.05, 0.1]);
	const names = rng.sample(METRICS, m);
	const signals = rng.int(2, m - 2);
	const zs = names.map(
		(_, i) => ((rng.bool() ? 1 : -1) * (i < signals ? rng.int(2000, 4200) : rng.int(50, 2400))) / 1000
	);
	const shuffled = rng.shuffle(zs);
	const two = names.map((name, i) => ({ name, p: 2 * normalCdf(-Math.abs(shuffled[i] ?? 0)) }));
	const one = names.map((name, i) => ({ name, p: normalCdf(-Math.abs(shuffled[i] ?? 0)) }));
	if (!clearOf(two, thresholds(m, alpha)) || !clearOf(one, thresholds(m, alpha))) return null;
	const answer = holm(two, alpha);
	if (answer.length < 2) return null;
	return {
		markdown: [
			`В эксперименте проверили ${m} метрик; для каждой посчитана z-статистика разности (гипотезы двусторонние: эффект может быть в любую сторону):`,
			'',
			'| метрика | z |',
			'| --- | --- |',
			...names.map((n, i) => `| ${n} | ${num(shuffled[i] ?? 0, 3)} |`),
			'',
			`Переведите z в p-value через Φ — функцию стандартного нормального распределения (считать её можно любым инструментом) — и ограничьте FWER уровнем α = ${alpha} **процедурой Холма**: p₍ᵢ₎ в порядке возрастания сравнивается с α/(m − i + 1), пока сравнение проходит. Какие гипотезы отвергаются?`,
			'',
			ANSWER_RULE
		].join('\n'),
		code: null,
		answer: set(answer),
		input: { cls: 'holm-from-z', alpha, zs: names.map((name, i) => ({ name, z: shuffled[i] ?? 0 })) },
		wrong: { 'one-sided-p': set(holm(one, alpha)), bonferroni: set(bonferroni(two, alpha)) }
	};
}

function weightedBonferroni(rng: Rng): ComputedScenario | null {
	const m = rng.int(5, 8);
	const alpha = rng.pick([0.05, 0.1]);
	const hs = hypotheses(rng, m);
	// Weights in whole percent summing to 100: the key metrics get more of α.
	const raw = hs.map(() => rng.int(1, 6));
	const total = raw.reduce((s, x) => s + x, 0);
	const weights = raw.map((x) => Math.floor((x / total) * 100));
	weights[0] = (weights[0] ?? 0) + 100 - weights.reduce((s, x) => s + x, 0);
	if (weights.some((w) => w <= 0)) return null;
	const thr = weights.map((w) => (alpha * w) / 100);
	if (!clearOf(hs, [...thresholds(m, alpha), ...thr])) return null;
	const answer = hs.filter((h, i) => h.p <= (thr[i] ?? 0)).map((h) => h.name);
	if (answer.length < 2) return null;
	return {
		markdown: [
			`В эксперименте ${m} метрик с разной важностью. Уровень α = ${alpha} распределён между гипотезами **взвешенной поправкой Бонферрони**: гипотеза i отвергается, если p_i ≤ α·w_i (веса в сумме дают 1).`,
			'',
			'| метрика | вес w | p-value |',
			'| --- | --- | --- |',
			...hs.map((h, i) => `| ${h.name} | ${num((weights[i] ?? 0) / 100)} | ${num(h.p)} |`),
			'',
			'Какие гипотезы отвергаются?',
			'',
			ANSWER_RULE
		].join('\n'),
		code: null,
		answer: set(answer),
		input: { cls: 'weighted-bonferroni', alpha, hypotheses: hs, weights: weights.map((w) => w / 100) },
		wrong: { bonferroni: set(bonferroni(hs, alpha)) }
	};
}

/** The reference rejects by adjusted p-values (monotone in the order of p) — the equivalent form of each procedure. */
const PYTHON_REFERENCE = `import json
from statistics import NormalDist

p = json.loads(input())
cls = p["cls"]
alpha = p["alpha"]

def adjusted(hs, factor, step):
    order = sorted(hs, key=lambda h: h["p"])
    m = len(order)
    raw = [min(1.0, factor(i, m) * h["p"]) for i, h in enumerate(order, 1)]
    out = raw[:]
    if step == "down":
        for i in range(1, m):
            out[i] = max(out[i], out[i - 1])
    else:
        for i in range(m - 2, -1, -1):
            out[i] = min(out[i], out[i + 1])
    return {h["name"]: a for h, a in zip(order, out)}

def rejected(adj):
    return [n for n, a in adj.items() if a <= alpha + 1e-12]

holm = lambda hs: rejected(adjusted(hs, lambda i, m: m - i + 1, "down"))
if cls == "bonferroni":
    res = [h["name"] for h in p["hypotheses"] if h["p"] * len(p["hypotheses"]) <= alpha + 1e-12]
elif cls == "holm":
    res = holm(p["hypotheses"])
elif cls == "bh":
    res = rejected(adjusted(p["hypotheses"], lambda i, m: m / i, "up"))
elif cls == "hochberg":
    res = rejected(adjusted(p["hypotheses"], lambda i, m: m - i + 1, "up"))
elif cls == "by":
    c = lambda m: sum(1 / k for k in range(1, m + 1))
    res = rejected(adjusted(p["hypotheses"], lambda i, m: m * c(m) / i, "up"))
elif cls == "gatekeeping":
    if p["primary"]["p"] <= alpha / 2 + 1e-12:
        res = [p["primary"]["name"]] + holm(p["hypotheses"])
    else:
        res = rejected(adjusted(p["hypotheses"], lambda i, m: (m - i + 1) * 2, "down"))
elif cls == "holm-from-z":
    res = holm([{"name": h["name"], "p": 2 * NormalDist().cdf(-abs(h["z"]))} for h in p["zs"]])
elif cls == "weighted-bonferroni":
    res = [h["name"] for h, w in zip(p["hypotheses"], p["weights"]) if h["p"] / w <= alpha + 1e-12]
for name in sorted(res):
    print(name)
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	// A draw is kept only when at least two hypotheses are rejected and every misconception misses the answer; for Holm
	// 400 tries ran out on 2 seeds of 20 000, 4000 tries on none of 100 000.
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw, DRAW_TRIES);
}

const DRAW_TRIES = 4000;

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
