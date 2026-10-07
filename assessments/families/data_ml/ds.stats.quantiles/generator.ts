// Quantiles by linear interpolation (the position (n − 1)·p in the sorted sample, as numpy and pandas do by default):
// a percentile, the IQR, the fence of outliers, a robust score; Junior — the percentile of two groups united,
// winsorizing, the percentile rank of a value with ties and the median of a frequency table.
import { readDescriptor, type Built, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { floatAnswer, num, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';
import { mean, variance } from '../../_lib/stats.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 3;
const f = (value: number) => floatAnswer(value, DIGITS);

const PLOTS = ['время ответа API, мс', 'размер корзины, ₽', 'время до первой покупки, ч', 'число событий за сессию'];

const METHOD =
	'Перцентиль уровня p считается **линейной интерполяцией**: значения сортируются по возрастанию (x₀ ≤ x₁ ≤ … ≤ x₍ₙ₋₁₎), ' +
	'позиция h = (n − 1)·p; перцентиль равен x⌊h⌋ + (h − ⌊h⌋)·(x⌊h⌋+1 − x⌊h⌋). Так считают `numpy.percentile` и `pandas.Series.quantile` по умолчанию. Q1 и Q3 — перцентили 25 и 75, IQR = Q3 − Q1.';

/** The linear percentile of `xs` at level `p` in [0, 1]; `sorted` false reproduces interpolating the raw order. */
function percentile(xs: readonly number[], p: number, sorted = true): number {
	const s = sorted ? [...xs].sort((a, b) => a - b) : [...xs];
	const h = (s.length - 1) * p;
	const lo = Math.floor(h + 1e-9);
	const hi = Math.min(lo + 1, s.length - 1);
	return (s[lo] ?? 0) + (h - lo) * ((s[hi] ?? 0) - (s[lo] ?? 0));
}

/** The value of rank ⌈n·p⌉ in the sorted sample (no interpolation). */
function nearestRank(xs: readonly number[], p: number): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.max(1, Math.ceil(s.length * p - 1e-9)) - 1] ?? 0;
}

const sample = (rng: Rng, n: number, lo: number, hi: number): number[] =>
	Array.from({ length: n }, () => rng.int(lo, hi));
const listOf = (xs: readonly number[]): string => xs.map((x) => num(x)).join(', ');

function head(rng: Rng, xs: readonly number[]): string {
	return `Выборка (${rng.pick(PLOTS)}), в порядке записи: ${listOf(xs)}.`;
}

function percentileLinear(rng: Rng): ComputedScenario {
	const xs = sample(rng, rng.int(8, 14), 10, 250);
	const level = rng.pick([10, 20, 30, 40, 60, 70, 80, 90]);
	const p = level / 100;
	return {
		markdown: [head(rng, xs), '', METHOD, '', `Найдите **${level}-й перцентиль**.`, '', roundingRule(DIGITS)].join(
			'\n'
		),
		code: null,
		answer: f(percentile(xs, p)),
		input: { cls: 'percentile-linear', xs, level },
		wrong: { 'nearest-rank': f(nearestRank(xs, p)), 'unsorted-position': f(percentile(xs, p, false)) }
	};
}

function iqr(rng: Rng): ComputedScenario {
	const xs = sample(rng, rng.int(8, 14), 10, 250);
	return {
		markdown: [head(rng, xs), '', METHOD, '', 'Найдите **IQR**.', '', roundingRule(DIGITS)].join('\n'),
		code: null,
		answer: f(percentile(xs, 0.75) - percentile(xs, 0.25)),
		input: { cls: 'iqr', xs },
		wrong: {
			'nearest-rank': f(nearestRank(xs, 0.75) - nearestRank(xs, 0.25)),
			'unsorted-position': f(percentile(xs, 0.75, false) - percentile(xs, 0.25, false))
		}
	};
}

function outlierFence(rng: Rng): ComputedScenario {
	const xs = sample(rng, rng.int(9, 14), 10, 120);
	xs[rng.int(0, xs.length - 1)] = rng.int(300, 600);
	const q1 = percentile(xs, 0.25);
	const q3 = percentile(xs, 0.75);
	return {
		markdown: [
			head(rng, xs),
			'',
			METHOD,
			'',
			'Значение считается выбросом сверху, если оно больше Q3 + 1,5·IQR. Найдите эту **верхнюю границу**.',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(q3 + 1.5 * (q3 - q1)),
		input: { cls: 'outlier-fence', xs },
		wrong: {
			'nearest-rank': f(nearestRank(xs, 0.75) + 1.5 * (nearestRank(xs, 0.75) - nearestRank(xs, 0.25))),
			'fence-from-median': f(percentile(xs, 0.5) + 1.5 * (q3 - q1))
		}
	};
}

function robustScore(rng: Rng): ComputedScenario | null {
	const xs = sample(rng, rng.int(9, 14), 20, 120);
	for (let i = rng.int(1, 2); i > 0; i -= 1) xs[rng.int(0, xs.length - 1)] = rng.int(400, 900);
	const x = rng.pick(xs.filter((v) => v < 200));
	const iqrValue = percentile(xs, 0.75) - percentile(xs, 0.25);
	if (iqrValue === 0) return null;
	return {
		markdown: [
			head(rng, xs),
			'',
			METHOD,
			'',
			`Выборка содержит выбросы, поэтому значения стандартизуют робастно: (x − медиана) / IQR. Найдите эту оценку для значения ${x}.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f((x - percentile(xs, 0.5)) / iqrValue),
		input: { cls: 'robust-score', xs, x },
		wrong: { 'mean-std': f((x - mean(xs)) / Math.sqrt(variance(xs, 1))) }
	};
}

function groupedPercentile(rng: Rng): ComputedScenario {
	const a = sample(rng, rng.int(6, 10), 10, 120);
	const b = sample(rng, rng.int(6, 10), 80, 300);
	const level = rng.pick([20, 25, 40, 60, 75, 80, 90]);
	const p = level / 100;
	const plot = rng.pick(PLOTS);
	return {
		markdown: [
			`Метрика — ${plot}. Значения в двух регионах:`,
			'',
			`- первый: ${listOf(a)};`,
			`- второй: ${listOf(b)}.`,
			'',
			METHOD,
			'',
			`Найдите **${level}-й перцентиль метрики по обоим регионам вместе**.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(percentile([...a, ...b], p)),
		input: { cls: 'grouped-percentile', a, b, level },
		wrong: {
			'mean-of-group-percentiles': f((percentile(a, p) + percentile(b, p)) / 2),
			'nearest-rank': f(nearestRank([...a, ...b], p))
		}
	};
}

function winsorize(rng: Rng): ComputedScenario {
	const xs = sample(rng, rng.int(12, 20), 20, 150);
	xs[rng.int(0, xs.length - 1)] = rng.int(500, 1500);
	xs[rng.int(0, xs.length - 1)] = rng.int(0, 5);
	const level = rng.pick([5, 10, 15]);
	const lo = percentile(xs, level / 100);
	const hi = percentile(xs, 1 - level / 100);
	const clipped = xs.map((x) => Math.min(hi, Math.max(lo, x)));
	const kept = xs.filter((x) => x >= lo && x <= hi);
	return {
		markdown: [
			head(rng, xs),
			'',
			METHOD,
			'',
			`Выборку **винзоризуют** на уровне ${level} %: значения ниже ${level}-го перцентиля заменяют на него, значения выше ${100 - level}-го — на него. Найдите среднее винзоризованной выборки.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(mean(clipped)),
		input: { cls: 'winsorize', xs, level },
		wrong: {
			'trim-instead': f(mean(kept)),
			'nearest-rank': f(
				mean(xs.map((x) => Math.min(nearestRank(xs, 1 - level / 100), Math.max(nearestRank(xs, level / 100), x))))
			)
		}
	};
}

function percentileRank(rng: Rng): ComputedScenario {
	const n = rng.int(15, 40);
	const xs = sample(rng, n, 1, 12).map((v) => v * 5);
	const x = rng.pick(xs);
	const below = xs.filter((v) => v < x).length;
	const equal = xs.filter((v) => v === x).length;
	return {
		markdown: [
			`Оценки ответов операторов поддержки (${n} оценок): ${listOf(xs)}.`,
			'',
			`**Перцентильный ранг** значения x — доля значений меньше x плюс половина доли значений, равных x, в процентах. Найдите перцентильный ранг значения ${x}.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(((below + equal / 2) / n) * 100),
		input: { cls: 'percentile-rank', xs, x },
		wrong: { 'le-count': f(((below + equal) / n) * 100) }
	};
}

function weightedMedian(rng: Rng): ComputedScenario {
	const distinct = rng
		.sample(
			Array.from({ length: 60 }, (_, i) => 10 + i * 5),
			rng.int(5, 8)
		)
		.sort((a, b) => a - b);
	const counts = distinct.map(() => rng.int(1, 40));
	const expanded = distinct.flatMap((v, i) => Array.from({ length: counts[i] ?? 0 }, () => v));
	const median = percentile(expanded, 0.5);
	return {
		markdown: [
			'Распределение заказов по сумме доставки:',
			'',
			'| стоимость доставки, ₽ | заказов |',
			'| --- | --- |',
			...rng.shuffle(distinct.map((v, i) => `| ${v} | ${counts[i]} |`)),
			'',
			'Найдите **медиану стоимости доставки по всем заказам** (при чётном числе заказов — среднее двух средних значений).',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(median),
		input: { cls: 'weighted-median', values: distinct, counts },
		wrong: { 'median-of-distinct': f(percentile(distinct, 0.5)) }
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	'percentile-linear': percentileLinear,
	iqr,
	'outlier-fence': outlierFence,
	'robust-score': robustScore,
	'grouped-percentile': groupedPercentile,
	winsorize,
	'percentile-rank': percentileRank,
	'weighted-median': weightedMedian
};

const PYTHON_REFERENCE = `import json
import statistics

def pct(xs, level):
    # statistics.quantiles with the inclusive method is the linear interpolation at (n - 1) * p.
    if level == 50:
        return statistics.median(xs)
    return statistics.quantiles(xs, n=100, method="inclusive")[level - 1]

p = json.loads(input())
cls = p["cls"]
if cls == "percentile-linear":
    print(repr(pct(p["xs"], p["level"])))
elif cls == "iqr":
    q = statistics.quantiles(p["xs"], n=4, method="inclusive")
    print(repr(q[2] - q[0]))
elif cls == "outlier-fence":
    q = statistics.quantiles(p["xs"], n=4, method="inclusive")
    print(repr(q[2] + 1.5 * (q[2] - q[0])))
elif cls == "robust-score":
    q = statistics.quantiles(p["xs"], n=4, method="inclusive")
    print(repr((p["x"] - q[1]) / (q[2] - q[0])))
elif cls == "grouped-percentile":
    print(repr(pct(p["a"] + p["b"], p["level"])))
elif cls == "winsorize":
    lo = pct(p["xs"], p["level"])
    hi = pct(p["xs"], 100 - p["level"])
    print(repr(statistics.mean(min(hi, max(lo, x)) for x in p["xs"])))
elif cls == "percentile-rank":
    xs, x = p["xs"], p["x"]
    print(repr(100 * (sum(v < x for v in xs) + 0.5 * sum(v == x for v in xs)) / len(xs)))
elif cls == "weighted-median":
    data = [v for v, c in zip(p["values"], p["counts"]) for _ in range(c)]
    print(repr(float(statistics.median(data))))
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
