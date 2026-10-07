// Confidence intervals: a proportion and a mean by the normal approximation, the sample size for a width, a
// difference of proportions; Middle — Wilson's interval, the percentile bootstrap, Welch's difference of means and a
// clustered sample. The quantiles of the normal distribution are given; choosing the right one is part of the task.
import { readDescriptor, type Built, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { floatAnswer, num, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';
import { normalQuantile } from '../../_lib/stats.ts';

const descriptor = readDescriptor(import.meta.url);
const f = (value: number, digits = 4) => floatAnswer(value, digits);

const LEVELS = [90, 95, 99] as const;
const Z_TABLE =
	'Квантили стандартного нормального распределения: z₀.₉₀ = 1.281552, z₀.₉₅ = 1.644854, z₀.₉₇₅ = 1.959964, z₀.₉₉ = 2.326348, z₀.₉₉₅ = 2.575829.';

/** The quantile of a two-sided interval of `level` % and the one-sided one a misconception takes. */
const zTwo = (level: number): number => normalQuantile(1 - (1 - level / 100) / 2);
const zOne = (level: number): number => normalQuantile(level / 100);

const PLOTS = [
	'конверсия в регистрацию',
	'доля сессий с ошибкой',
	'доля пользователей, открывших push',
	'доля оплаченных заказов'
];
const MEAN_PLOTS = [
	{ what: 'время загрузки страницы', unit: 'мс' },
	{ what: 'средний чек', unit: '₽' },
	{ what: 'длительность сессии', unit: 'с' }
];

function waldProportion(rng: Rng): ComputedScenario {
	const level = rng.pick(LEVELS);
	const n = rng.int(200, 5000);
	const k = rng.int(Math.round(n * 0.03), Math.round(n * 0.6));
	const p = k / n;
	const se = Math.sqrt((p * (1 - p)) / n);
	return {
		markdown: [
			`Метрика — ${rng.pick(PLOTS)}: ${k} успехов из ${n} независимых наблюдений.`,
			'',
			`Постройте двусторонний ${level}-процентный доверительный интервал для доли по нормальному приближению (p̂ ± z·√(p̂(1 − p̂)/n)) и найдите его **верхнюю границу**.`,
			'',
			Z_TABLE,
			'',
			roundingRule(4)
		].join('\n'),
		code: null,
		answer: f(p + zTwo(level) * se),
		input: { cls: 'wald-proportion', n, k, level },
		wrong: { 'one-sided-z': f(p + zOne(level) * se), 'std-not-se': f(p + zTwo(level) * Math.sqrt(p * (1 - p))) }
	};
}

function meanLargeN(rng: Rng): ComputedScenario {
	const level = rng.pick(LEVELS);
	const plot = rng.pick(MEAN_PLOTS);
	const n = rng.int(60, 2000);
	const m = rng.int(1000, 9000) / 10;
	const s = rng.int(100, 4000) / 10;
	return {
		markdown: [
			`Метрика — ${plot.what}, ${plot.unit}. По выборке из ${n} независимых наблюдений: среднее ${num(m)}, выборочное стандартное отклонение ${num(s)}.`,
			'',
			`Выборка большая, распределение среднего считайте нормальным. Найдите **нижнюю границу** двустороннего ${level}-процентного доверительного интервала для среднего.`,
			'',
			Z_TABLE,
			'',
			roundingRule(3)
		].join('\n'),
		code: null,
		answer: f(m - (zTwo(level) * s) / Math.sqrt(n), 3),
		input: { cls: 'mean-large-n', n, m, s, level },
		wrong: { 'one-sided-z': f(m - (zOne(level) * s) / Math.sqrt(n), 3), 'std-not-se': f(m - zTwo(level) * s, 3) }
	};
}

function sampleSize(rng: Rng): ComputedScenario | null {
	const level = rng.pick(LEVELS);
	const p0 = rng.int(2, 50) / 100;
	const width = rng.int(4, 40) / 1000;
	const need = (z: number, half: number): number => Math.ceil((z * z * p0 * (1 - p0)) / (half * half));
	const exact = (zTwo(level) ** 2 * p0 * (1 - p0)) / (width / 2) ** 2;
	// Far from a whole number, so that the rounding of the quantile cannot move the answer.
	if (exact - Math.floor(exact) < 0.02 || Math.ceil(exact) - exact < 0.02) return null;
	return {
		markdown: [
			`Планируют опрос, чтобы оценить ${rng.pick(PLOTS)}; по прошлым данным она около ${num(p0)}.`,
			'',
			`Нужен двусторонний ${level}-процентный доверительный интервал по нормальному приближению (p̂ ± z·√(p̂(1 − p̂)/n)), у которого **полная ширина** (от нижней до верхней границы) не больше ${num(width)} при p̂ = ${num(p0)}. Найдите **минимальное** число наблюдений n.`,
			'',
			Z_TABLE,
			'',
			'Ответ — целое число.'
		].join('\n'),
		code: null,
		answer: f(need(zTwo(level), width / 2)),
		input: { cls: 'sample-size', p0, width, level },
		wrong: { 'one-sided-z': f(need(zOne(level), width / 2)), 'width-as-half': f(need(zTwo(level), width)) }
	};
}

function diffProportions(rng: Rng): ComputedScenario {
	const level = rng.pick(LEVELS);
	const nA = rng.int(300, 6000);
	const nB = rng.int(300, 6000);
	const kA = rng.int(Math.round(nA * 0.03), Math.round(nA * 0.5));
	const kB = rng.int(Math.round(nB * 0.03), Math.round(nB * 0.5));
	const pA = kA / nA;
	const pB = kB / nB;
	const seA = Math.sqrt((pA * (1 - pA)) / nA);
	const seB = Math.sqrt((pB * (1 - pB)) / nB);
	const pooled = (kA + kB) / (nA + nB);
	const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
	const z = zTwo(level);
	return {
		markdown: [
			`A/B-тест: в группе A ${kA} конверсий из ${nA} пользователей, в группе B — ${kB} из ${nB}.`,
			'',
			`Постройте двусторонний ${level}-процентный доверительный интервал для разности p_B − p_A по нормальному приближению, со стандартной ошибкой разности, посчитанной по долям каждой группы отдельно. Найдите его **нижнюю границу**.`,
			'',
			Z_TABLE,
			'',
			roundingRule(4)
		].join('\n'),
		code: null,
		answer: f(pB - pA - z * Math.sqrt(seA ** 2 + seB ** 2)),
		input: { cls: 'diff-proportions', nA, kA, nB, kB, level },
		wrong: { 'pooled-se': f(pB - pA - z * sePooled), 'sum-of-se': f(pB - pA - z * (seA + seB)) }
	};
}

function wilson(rng: Rng): ComputedScenario {
	const level = rng.pick(LEVELS);
	const n = rng.int(20, 150);
	const k = rng.bool()
		? rng.int(0, Math.max(1, Math.round(n * 0.08)))
		: n - rng.int(0, Math.max(1, Math.round(n * 0.08)));
	const p = k / n;
	const z = zTwo(level);
	const center = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
	const half = (z / (1 + (z * z) / n)) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	const upper = rng.bool();
	const wald = upper ? p + z * Math.sqrt((p * (1 - p)) / n) : p - z * Math.sqrt((p * (1 - p)) / n);
	return {
		markdown: [
			`Метрика — ${rng.pick(PLOTS)}: ${k} успехов из ${n} наблюдений. Доля близка к краю, выборка небольшая, поэтому строят **интервал Уилсона** (обращение z-критерия для доли).`,
			'',
			`Найдите **${upper ? 'верхнюю' : 'нижнюю'}** границу двустороннего ${level}-процентного интервала Уилсона.`,
			'',
			Z_TABLE,
			'',
			roundingRule(4)
		].join('\n'),
		code: null,
		answer: f(upper ? center + half : center - half),
		input: { cls: 'wilson', n, k, level, upper },
		wrong: { 'wald-interval': f(wald) }
	};
}

/** The linear percentile at level q of `xs` (position (n − 1)·q of the sorted values). */
function percentile(xs: readonly number[], q: number): number {
	const s = [...xs].sort((a, b) => a - b);
	const h = (s.length - 1) * q;
	const lo = Math.floor(h + 1e-9);
	const hi = Math.min(lo + 1, s.length - 1);
	return (s[lo] ?? 0) + (h - lo) * ((s[hi] ?? 0) - (s[lo] ?? 0));
}

function bootstrapPercentile(rng: Rng): ComputedScenario {
	const level = rng.pick([80, 90] as const);
	const estimate = rng.int(300, 900) / 10;
	const count = rng.pick([30, 40, 50]);
	// A skewed resampling distribution: the basic and the percentile intervals differ.
	const resamples = Array.from(
		{ length: count },
		() => Math.round((estimate + (rng.bool(0.7) ? -1 : 3) * rng.next() * rng.int(2, 12)) * 10) / 10
	);
	const alpha = (1 - level / 100) / 2;
	const lowerIndex = Math.ceil(count * alpha) - 1;
	const sorted = [...resamples].sort((a, b) => a - b);
	return {
		markdown: [
			`Оценка медианного времени ответа сервиса по выборке — ${num(estimate)} мс. Выборку ресемплировали с возвращением ${count} раз и на каждом ресемпле посчитали медиану (порядок — как получилось):`,
			'',
			resamples.map((x) => num(x)).join(', '),
			'',
			`Постройте **перцентильный** бутстреп-интервал уровня ${level} %: его границы — перцентили ${num(alpha * 100)} и ${num(100 - alpha * 100)} распределения ресемплов, перцентиль — линейной интерполяцией (позиция (n − 1)·q в отсортированных значениях, как в numpy по умолчанию). Найдите **нижнюю границу**.`,
			'',
			roundingRule(3)
		].join('\n'),
		code: null,
		answer: f(percentile(resamples, alpha), 3),
		input: { cls: 'bootstrap-percentile', resamples, level, estimate },
		wrong: {
			'basic-bootstrap': f(2 * estimate - percentile(resamples, 1 - alpha), 3),
			'nearest-rank': f(sorted[Math.max(0, lowerIndex)] ?? 0, 3)
		}
	};
}

function welchDiff(rng: Rng): ComputedScenario {
	const level = rng.pick(LEVELS);
	const plot = rng.pick(MEAN_PLOTS);
	const nA = rng.int(80, 3000);
	const nB = rng.int(80, 3000);
	const mA = rng.int(1000, 5000) / 10;
	const mB = mA + rng.int(-300, 300) / 10;
	const sA = rng.int(100, 1500) / 10;
	const sB = rng.int(100, 1500) / 10;
	const z = zTwo(level);
	const welch = Math.sqrt(sA ** 2 / nA + sB ** 2 / nB);
	const pooledVar = ((nA - 1) * sA ** 2 + (nB - 1) * sB ** 2) / (nA + nB - 2);
	return {
		markdown: [
			`Метрика — ${plot.what}, ${plot.unit}. Две группы эксперимента:`,
			'',
			'| группа | n | среднее | выборочное стандартное отклонение |',
			'| --- | --- | --- | --- |',
			`| A | ${nA} | ${num(mA)} | ${num(sA)} |`,
			`| B | ${nB} | ${num(mB)} | ${num(sB)} |`,
			'',
			`Дисперсии групп **не считаются равными**; выборки большие, используйте нормальное приближение. Найдите **нижнюю границу** двустороннего ${level}-процентного доверительного интервала для разности средних B − A.`,
			'',
			Z_TABLE,
			'',
			roundingRule(3)
		].join('\n'),
		code: null,
		answer: f(mB - mA - z * welch, 3),
		input: { cls: 'welch-diff', nA, nB, mA, mB, sA, sB, level },
		wrong: {
			'pooled-se': f(mB - mA - z * Math.sqrt(pooledVar * (1 / nA + 1 / nB)), 3),
			'sum-of-se': f(mB - mA - z * (sA / Math.sqrt(nA) + sB / Math.sqrt(nB)), 3)
		}
	};
}

function designEffect(rng: Rng): ComputedScenario {
	const level = rng.pick(LEVELS);
	const clusters = rng.int(20, 200);
	const size = rng.int(5, 40);
	const n = clusters * size;
	const k = rng.int(Math.round(n * 0.05), Math.round(n * 0.6));
	const rho = rng.int(2, 30) / 100;
	const p = k / n;
	const z = zTwo(level);
	const deff = 1 + (size - 1) * rho;
	return {
		markdown: [
			`Опрос удовлетворённости провели в ${clusters} офисах по ${size} сотрудников; довольны ${k} из ${n}. Ответы внутри офиса похожи: внутрикластерная корреляция ρ = ${num(rho)}.`,
			'',
			`Учтите кластеры через эффект дизайна: эффективный размер выборки n / (1 + (m − 1)·ρ), где m — размер кластера; интервал — нормальное приближение p̂ ± z·√(p̂(1 − p̂)/n_eff). Найдите **верхнюю границу** двустороннего ${level}-процентного интервала для доли довольных.`,
			'',
			Z_TABLE,
			'',
			roundingRule(4)
		].join('\n'),
		code: null,
		answer: f(p + z * Math.sqrt((p * (1 - p) * deff) / n)),
		input: { cls: 'design-effect', clusters, size, k, rho, level },
		wrong: {
			'ignore-clustering': f(p + z * Math.sqrt((p * (1 - p)) / n)),
			'one-sided-z': f(p + zOne(level) * Math.sqrt((p * (1 - p) * deff) / n))
		}
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	'wald-proportion': waldProportion,
	'mean-large-n': meanLargeN,
	'sample-size': sampleSize,
	'diff-proportions': diffProportions,
	wilson,
	'bootstrap-percentile': bootstrapPercentile,
	'welch-diff': welchDiff,
	'design-effect': designEffect
};

const PYTHON_REFERENCE = `import json
import math
import statistics
from statistics import NormalDist

p = json.loads(input())
cls = p["cls"]
z = NormalDist().inv_cdf(0.5 + p["level"] / 200)
if cls == "wald-proportion":
    ph = p["k"] / p["n"]
    print(repr(ph + z * math.sqrt(ph * (1 - ph) / p["n"])))
elif cls == "mean-large-n":
    print(repr(p["m"] - z * p["s"] / math.sqrt(p["n"])))
elif cls == "sample-size":
    half = p["width"] / 2
    n = 1
    # the smallest n whose half-width is within the bound, by doubling and bisection
    while z * math.sqrt(p["p0"] * (1 - p["p0"]) / n) > half:
        n *= 2
    lo, hi = n // 2, n
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if z * math.sqrt(p["p0"] * (1 - p["p0"]) / mid) > half:
            lo = mid
        else:
            hi = mid
    print(hi)
elif cls == "diff-proportions":
    a = p["kA"] / p["nA"]
    b = p["kB"] / p["nB"]
    print(repr(b - a - z * math.hypot(math.sqrt(a * (1 - a) / p["nA"]), math.sqrt(b * (1 - b) / p["nB"]))))
elif cls == "wilson":
    # the bounds are the roots of (ph - x)^2 = z^2 x (1 - x) / n
    n = p["n"]
    ph = p["k"] / n
    a = 1 + z * z / n
    b = -(2 * ph + z * z / n)
    c = ph * ph
    d = math.sqrt(b * b - 4 * a * c)
    print(repr((-b + d) / (2 * a) if p["upper"] else (-b - d) / (2 * a)))
elif cls == "bootstrap-percentile":
    alpha = (100 - p["level"]) / 200
    cuts = statistics.quantiles(p["resamples"], n=1000, method="inclusive")
    print(repr(cuts[round(alpha * 1000) - 1]))
elif cls == "welch-diff":
    se = math.sqrt(p["sA"] ** 2 / p["nA"] + p["sB"] ** 2 / p["nB"])
    print(repr(p["mB"] - p["mA"] - z * se))
elif cls == "design-effect":
    n = p["clusters"] * p["size"]
    ph = p["k"] / n
    n_eff = n / (1 + (p["size"] - 1) * p["rho"])
    print(repr(ph + z * math.sqrt(ph * (1 - ph) / n_eff)))
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
