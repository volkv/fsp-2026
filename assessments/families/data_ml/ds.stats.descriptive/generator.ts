// Descriptive statistics: the sample variance, the median of an even sample, a z-score, a trimmed mean; Junior — the
// variance of two groups pooled from their summaries, a weighted mean of daily averages, the variance after one value is
// removed and the average growth rate. Every rule the answer depends on is stated; the trap is the rule the candidate
// replaces with a habit.
import {
	readDescriptor,
	type Built,
	type ComputedAnswer,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { floatAnswer, num, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';
import { mean, variance } from '../../_lib/stats.ts';

const descriptor = readDescriptor(import.meta.url);

const PLOTS = [
	{ what: 'время ответа сервиса, мс', unit: 'мс' },
	{ what: 'сумма заказа, ₽', unit: '₽' },
	{ what: 'длительность сессии, с', unit: 'с' },
	{ what: 'число просмотренных карточек за визит', unit: '' }
] as const;

const f = (value: number, digits: number): ComputedAnswer => floatAnswer(value, digits);

function sample(rng: Rng, n: number, lo: number, hi: number): number[] {
	return Array.from({ length: n }, () => rng.int(lo, hi));
}

const listOf = (xs: readonly number[]): string => xs.map((x) => num(x)).join(', ');

function sampleVariance(rng: Rng): ComputedScenario {
	const plot = rng.pick(PLOTS);
	const xs = sample(rng, rng.int(7, 10), 10, 99);
	const digits = 3;
	return {
		markdown: [
			`Выборка (${plot.what}): ${listOf(xs)}.`,
			'',
			'Найдите **выборочную дисперсию** — несмещённую оценку дисперсии генеральной совокупности по этой выборке.',
			'',
			roundingRule(digits)
		].join('\n'),
		code: null,
		answer: f(variance(xs, 1), digits),
		input: { cls: 'sample-variance', xs },
		wrong: { 'population-variance': f(variance(xs, 0), digits) }
	};
}

function medianEven(rng: Rng): ComputedScenario | null {
	const plot = rng.pick(PLOTS);
	const n = rng.pick([8, 10, 12]);
	const xs = sample(rng, n, 10, 99);
	const sorted = [...xs].sort((a, b) => a - b);
	const lower = sorted[n / 2 - 1] ?? 0;
	const upper = sorted[n / 2] ?? 0;
	if (lower === upper) return null;
	const digits = 3;
	return {
		markdown: [
			`Значения в порядке записи в журнал (${plot.what}): ${listOf(xs)}.`,
			'',
			'Найдите **медиану** выборки.',
			'',
			roundingRule(digits)
		].join('\n'),
		code: null,
		answer: f((lower + upper) / 2, digits),
		input: { cls: 'median-even', xs },
		wrong: {
			'unsorted-median': f(((xs[n / 2 - 1] ?? 0) + (xs[n / 2] ?? 0)) / 2, digits),
			'upper-middle': f(upper, digits)
		}
	};
}

function zScore(rng: Rng): ComputedScenario {
	const plot = rng.pick(PLOTS);
	const xs = sample(rng, rng.int(7, 10), 10, 99);
	const x = rng.pick(xs);
	const m = mean(xs);
	const digits = 3;
	return {
		markdown: [
			`Выборка (${plot.what}): ${listOf(xs)}.`,
			'',
			`Найдите z-оценку значения ${x}: его отклонение от среднего выборки в единицах **выборочного** стандартного отклонения (корень из несмещённой оценки дисперсии).`,
			'',
			roundingRule(digits)
		].join('\n'),
		code: null,
		answer: f((x - m) / Math.sqrt(variance(xs, 1)), digits),
		input: { cls: 'z-score', xs, x },
		wrong: { 'population-variance': f((x - m) / Math.sqrt(variance(xs, 0)), digits) }
	};
}

function trimmedMean(rng: Rng): ComputedScenario {
	const plot = rng.pick(PLOTS);
	const n = rng.int(10, 15);
	const share = rng.pick([0.1, 0.2]);
	const xs = sample(rng, n, 10, 99);
	// Outliers make trimming matter: one or two extreme values at random places.
	for (let i = rng.int(1, 2); i > 0; i -= 1) xs[rng.int(0, n - 1)] = rng.int(300, 900);
	const k = Math.floor(n * share);
	const sorted = [...xs].sort((a, b) => a - b);
	const digits = 3;
	return {
		markdown: [
			`Значения в порядке записи (${plot.what}): ${listOf(xs)}.`,
			'',
			`Найдите **усечённое среднее** с долей ${num(share * 100)} %: k = ⌊${num(share)} · n⌋ наименьших и k наибольших значений отбрасываются, остальные усредняются.`,
			'',
			roundingRule(digits)
		].join('\n'),
		code: null,
		answer: f(mean(sorted.slice(k, n - k)), digits),
		input: { cls: 'trimmed-mean', xs, share },
		wrong: {
			'trim-one-side': f(mean(sorted.slice(0, n - k)), digits),
			'trim-unsorted': f(mean(xs.slice(k, n - k)), digits)
		}
	};
}

function pooledVariance(rng: Rng): ComputedScenario {
	const plot = rng.pick(PLOTS);
	const n1 = rng.int(15, 60);
	const n2 = rng.int(15, 60);
	const m1 = rng.int(40, 90);
	const m2 = m1 + rng.pick([-1, 1]) * rng.int(8, 30);
	const v1 = rng.int(20, 300);
	const v2 = rng.int(20, 300);
	const total = n1 + n2;
	const grand = (n1 * m1 + n2 * m2) / total;
	const ss = (n1 - 1) * v1 + (n2 - 1) * v2 + n1 * (m1 - grand) ** 2 + n2 * (m2 - grand) ** 2;
	const digits = 3;
	return {
		markdown: [
			`Метрика — ${plot.what}. Две группы пользователей описаны сводками (дисперсия — выборочная, с делителем n − 1):`,
			'',
			'| группа | n | среднее | выборочная дисперсия |',
			'| --- | --- | --- | --- |',
			`| первая | ${n1} | ${m1} | ${v1} |`,
			`| вторая | ${n2} | ${m2} | ${v2} |`,
			'',
			`Группы объединили в одну выборку из ${total} значений. Найдите её **выборочную дисперсию** (делитель — общее n − 1).`,
			'',
			roundingRule(digits)
		].join('\n'),
		code: null,
		answer: f(ss / (total - 1), digits),
		input: { cls: 'pooled-variance', n1, n2, m1, m2, v1, v2 },
		wrong: {
			'within-only': f((n1 * v1 + n2 * v2) / total, digits),
			'mean-of-variances': f((v1 + v2) / 2, digits)
		}
	};
}

function weightedMean(rng: Rng): ComputedScenario {
	const days = rng.int(3, 6);
	const names = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].slice(0, days);
	const counts = Array.from({ length: days }, () => rng.int(5, 400));
	const averages = Array.from({ length: days }, () => rng.int(400, 3000));
	const total = counts.reduce((s, c, i) => s + c * (averages[i] ?? 0), 0);
	const orders = counts.reduce((s, c) => s + c, 0);
	const digits = 3;
	return {
		markdown: [
			'Отчёт магазина по дням недели:',
			'',
			'| день | заказов | средний чек, ₽ |',
			'| --- | --- | --- |',
			...names.map((d, i) => `| ${d} | ${counts[i]} | ${averages[i]} |`),
			'',
			'Найдите **средний чек по всем заказам** за эти дни, ₽.',
			'',
			roundingRule(digits)
		].join('\n'),
		code: null,
		answer: f(total / orders, digits),
		input: { cls: 'weighted-mean', counts, averages },
		wrong: { 'mean-of-means': f(mean(averages), digits) }
	};
}

function removePoint(rng: Rng): ComputedScenario {
	const plot = rng.pick(PLOTS);
	const n = rng.int(20, 60);
	const m = rng.int(300, 900) / 10;
	const v = rng.int(400, 4000) / 10;
	const sd = Math.sqrt(v);
	const x = Math.round(m + rng.pick([-1, 1]) * sd * (1.5 + rng.next() * 1.5));
	const shifted = (n * m - x) / (n - 1);
	const ss = (n - 1) * v;
	const right = (ss - (x - m) * (x - shifted)) / (n - 2);
	const digits = 3;
	return {
		markdown: [
			`Метрика — ${plot.what}. Сводка выборки: n = ${n}, среднее ${num(m)}, выборочная дисперсия (делитель n − 1) ${num(v)}.`,
			'',
			`Одно значение, равное ${x}, оказалось ошибочной записью и удаляется. Найдите **выборочную дисперсию** оставшихся ${n - 1} значений (делитель — новое n − 1). Сводка точная, исходные значения не нужны.`,
			'',
			roundingRule(digits)
		].join('\n'),
		code: null,
		answer: f(right, digits),
		input: { cls: 'remove-point', n, m, v, x },
		wrong: {
			'old-divisor': f((ss - (x - m) * (x - shifted)) / (n - 1), digits),
			'ignore-mean-shift': f((ss - (x - m) ** 2) / (n - 2), digits)
		}
	};
}

function geometricGrowth(rng: Rng): ComputedScenario {
	const periods = rng.int(3, 5);
	const unit = rng.pick(['месяц', 'квартал', 'год']);
	const rates = Array.from({ length: periods }, () => rng.pick([-1, 1, 1]) * rng.int(2, 45));
	const factor = rates.reduce((p, r) => p * (1 + r / 100), 1);
	const digits = 3;
	return {
		markdown: [
			`Выручка менялась так (изменение за ${unit} к предыдущему, %): ${rates.map((r) => (r > 0 ? `+${r}` : String(r))).join(', ')}.`,
			'',
			`Найдите **средний темп роста за ${unit}** в процентах: такой постоянный темп, который за те же ${periods} периодов дал бы то же итоговое изменение выручки.`,
			'',
			roundingRule(digits)
		].join('\n'),
		code: null,
		answer: f((factor ** (1 / periods) - 1) * 100, digits),
		input: { cls: 'geometric-growth', rates },
		wrong: { 'arithmetic-growth': f(mean(rates), digits) }
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	'sample-variance': sampleVariance,
	'median-even': medianEven,
	'z-score': zScore,
	'trimmed-mean': trimmedMean,
	'pooled-variance': pooledVariance,
	'weighted-mean': weightedMean,
	'remove-point': removePoint,
	'geometric-growth': geometricGrowth
};

const PYTHON_REFERENCE = `import json
import math
import statistics

p = json.loads(input())
cls = p["cls"]
if cls == "sample-variance":
    print(repr(statistics.variance(p["xs"])))
elif cls == "median-even":
    print(repr(float(statistics.median(p["xs"]))))
elif cls == "z-score":
    print(repr((p["x"] - statistics.mean(p["xs"])) / statistics.stdev(p["xs"])))
elif cls == "trimmed-mean":
    xs = sorted(p["xs"])
    k = int(len(xs) * p["share"] + 1e-9)
    print(repr(statistics.mean(xs[k:len(xs) - k])))
elif cls == "pooled-variance":
    # Rebuild the sums of both groups and pool them.
    n = p["n1"] + p["n2"]
    s1 = p["n1"] * p["m1"] + p["n2"] * p["m2"]
    s2 = (p["n1"] - 1) * p["v1"] + p["n1"] * p["m1"] ** 2 + (p["n2"] - 1) * p["v2"] + p["n2"] * p["m2"] ** 2
    print(repr((s2 - s1 * s1 / n) / (n - 1)))
elif cls == "weighted-mean":
    print(repr(sum(c * a for c, a in zip(p["counts"], p["averages"])) / sum(p["counts"])))
elif cls == "remove-point":
    n, m, v, x = p["n"], p["m"], p["v"], p["x"]
    s1 = n * m - x
    s2 = (n - 1) * v + n * m * m - x * x
    k = n - 1
    print(repr((s2 - s1 * s1 / k) / (k - 1)))
elif cls == "geometric-growth":
    prod = math.prod(1 + r / 100 for r in p["rates"])
    print(repr((prod ** (1 / len(p["rates"])) - 1) * 100))
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
