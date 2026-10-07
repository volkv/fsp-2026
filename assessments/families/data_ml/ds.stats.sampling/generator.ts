// Sampling variability: the standard error of a mean, of a difference of means and of a share, the spread of a linear
// combination and of a sum of correlated values, the central limit theorem for a mean and a total, and the correction
// for sampling without replacement from a finite population.
import { readDescriptor, type Built, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { floatAnswer, num, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';
import { normalCdf, variance } from '../../_lib/stats.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 4;
const f = (value: number) => floatAnswer(value, DIGITS);

const METRICS = [
	{ what: 'время ответа сервиса', unit: 'мс' },
	{ what: 'сумма чека', unit: 'руб.' },
	{ what: 'длительность сессии', unit: 'мин' },
	{ what: 'время доставки', unit: 'мин' }
] as const;

function seMean(rng: Rng): ComputedScenario | null {
	const metric = rng.pick(METRICS);
	const n = rng.int(8, 12);
	const center = rng.int(20, 200);
	const xs = Array.from({ length: n }, () => center + rng.int(-25, 25));
	const s = Math.sqrt(variance(xs, 1));
	if (s === 0) return null;
	return {
		markdown: [
			`Замерили ${metric.what} (${metric.unit}) на случайной выборке из ${n} наблюдений:`,
			'',
			`\`${xs.join(', ')}\``,
			'',
			'Найдите **стандартную ошибку** выборочного среднего, оценив стандартное отклонение по выборке несмещённо (делитель n − 1).',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(s / Math.sqrt(n)),
		input: { cls: 'se-mean', xs },
		wrong: {
			'sd-not-se': f(s),
			'population-sd': f(Math.sqrt(variance(xs, 0)) / Math.sqrt(n))
		}
	};
}

function linearCombination(rng: Rng): ComputedScenario {
	const sx = rng.int(2, 15);
	const sy = rng.int(2, 15);
	const mx = rng.int(10, 90);
	const my = rng.int(10, 90);
	const a = rng.pick([2, 3, 4, 0.5]);
	const b = rng.pick([-3, -2, -1, 2, 3]);
	const c = rng.int(-20, 20);
	const sd = Math.sqrt(a * a * sx * sx + b * b * sy * sy);
	return {
		markdown: [
			`Случайные величины X и Y независимы: E[X] = ${mx}, σ(X) = ${sx}; E[Y] = ${my}, σ(Y) = ${sy}.`,
			'',
			`Найдите стандартное отклонение величины T = ${num(a)}·X ${b < 0 ? '−' : '+'} ${Math.abs(b)}·Y ${c < 0 ? '−' : '+'} ${Math.abs(c)}.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(sd),
		input: { cls: 'linear-combination', a, b, c, sx, sy },
		wrong: {
			'add-sds': f(Math.abs(a) * sx + Math.abs(b) * sy),
			'coef-not-squared': f(Math.sqrt(Math.abs(a) * sx * sx + Math.abs(b) * sy * sy))
		}
	};
}

function cltMean(rng: Rng): ComputedScenario {
	const metric = rng.pick(METRICS);
	const mu = rng.int(50, 300);
	const sigma = rng.int(20, 120);
	const n = rng.pick([36, 49, 64, 100, 144, 225]);
	const d = rng.int(2, Math.max(3, Math.round((2.2 * sigma) / Math.sqrt(n))));
	const z = (d * Math.sqrt(n)) / sigma;
	return {
		markdown: [
			`${metric.what[0]?.toUpperCase()}${metric.what.slice(1)} одного наблюдения имеет среднее ${mu} ${metric.unit} и стандартное отклонение ${sigma} ${metric.unit}; распределение заметно скошено. Берут ${n} независимых наблюдений и считают их среднее.`,
			'',
			`Пользуясь центральной предельной теоремой, найдите вероятность, что среднее попадёт в интервал [${mu - d}; ${mu + d}]. Функцию стандартного нормального распределения Φ считайте любым инструментом.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(2 * normalCdf(z) - 1),
		input: { cls: 'clt-mean', mu, sigma, n, d },
		wrong: { 'no-sqrt-n': f(2 * normalCdf(d / sigma) - 1) }
	};
}

function cltTotal(rng: Rng): ComputedScenario {
	const mu = rng.int(5, 40);
	const sigma = rng.int(3, 30);
	const n = rng.pick([50, 80, 100, 120, 150, 200]);
	const sdTotal = sigma * Math.sqrt(n);
	const t = n * mu + Math.round(rng.pick([-1.5, -1, -0.5, 0.3, 0.8, 1.2, 1.7]) * sdTotal) + rng.int(-3, 3);
	const tail = (sd: number): number => 1 - normalCdf((t - n * mu) / sd);
	return {
		markdown: [
			`Вес одной посылки в среднем ${mu} кг со стандартным отклонением ${sigma} кг, веса посылок независимы. Машину загружают ${n} посылками.`,
			'',
			`Пользуясь центральной предельной теоремой, найдите вероятность, что общий вес груза **больше ${t} кг**. Функцию стандартного нормального распределения Φ считайте любым инструментом.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(tail(sdTotal)),
		input: { cls: 'clt-total', mu, sigma, n, t },
		wrong: { 'no-sqrt-n': f(tail(sigma * n)), 'add-sds': f(tail(sigma)) }
	};
}

function seDiffMeans(rng: Rng): ComputedScenario {
	const metric = rng.pick(METRICS);
	const n1 = rng.int(40, 400);
	const n2 = rng.int(40, 400);
	const s1 = rng.int(50, 400) / 10;
	const s2 = rng.int(50, 400) / 10;
	const m1 = rng.int(500, 2000) / 10;
	const m2 = rng.int(500, 2000) / 10;
	const se1 = s1 / Math.sqrt(n1);
	const se2 = s2 / Math.sqrt(n2);
	return {
		markdown: [
			`Две независимые группы пользователей, метрика — ${metric.what} (${metric.unit}):`,
			'',
			'| группа | n | среднее | стандартное отклонение (n − 1) |',
			'| --- | --- | --- | --- |',
			`| A | ${n1} | ${num(m1)} | ${num(s1)} |`,
			`| B | ${n2} | ${num(m2)} | ${num(s2)} |`,
			'',
			'Найдите стандартную ошибку разности средних B − A (без предположения о равенстве дисперсий).',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(Math.sqrt(se1 * se1 + se2 * se2)),
		input: { cls: 'se-diff-means', n1, n2, s1, s2 },
		wrong: {
			'add-sds': f(se1 + se2),
			'sd-not-se': f(Math.sqrt(s1 * s1 + s2 * s2))
		}
	};
}

function seProportion(rng: Rng): ComputedScenario {
	const n = rng.int(200, 5000);
	const k = rng.int(Math.round(n * 0.03), Math.round(n * 0.6));
	const p = k / n;
	return {
		markdown: [
			`Из ${n} посетителей, попавших в эксперимент, покупку совершили ${k}. Каждый посетитель — независимое испытание с одной и той же вероятностью покупки.`,
			'',
			'Найдите стандартную ошибку оценки конверсии (доли покупателей) по этой выборке.',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(Math.sqrt((p * (1 - p)) / n)),
		input: { cls: 'se-proportion', n, k },
		wrong: { 'p-over-n': f(Math.sqrt(p / n)), 'sd-not-se': f(Math.sqrt(p * (1 - p))) }
	};
}

function correlatedSum(rng: Rng): ComputedScenario {
	const sx = rng.int(3, 20);
	const sy = rng.int(3, 20);
	const rho = rng.pick([-0.8, -0.6, -0.4, -0.3, 0.3, 0.4, 0.5, 0.7, 0.9]);
	const diff = rng.bool();
	const sign = diff ? -1 : 1;
	const v = sx * sx + sy * sy + sign * 2 * rho * sx * sy;
	return {
		markdown: [
			`Выручка двух магазинов за день — случайные величины X и Y: σ(X) = ${sx}, σ(Y) = ${sy} (тыс. руб.), коэффициент корреляции между ними ρ = ${num(rho)}.`,
			'',
			`Найдите стандартное отклонение величины ${diff ? 'X − Y (разница выручки)' : 'X + Y (общая выручка)'}.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(Math.sqrt(v)),
		input: { cls: 'correlated-sum', sx, sy, rho, diff },
		wrong: {
			'ignore-correlation': f(Math.sqrt(sx * sx + sy * sy)),
			'add-sds': f(sx + sy)
		}
	};
}

function finitePopulation(rng: Rng): ComputedScenario {
	const N = rng.int(200, 1500);
	const n = rng.int(Math.round(N * 0.15), Math.round(N * 0.6));
	const s = rng.int(40, 300) / 10;
	const se = (s / Math.sqrt(n)) * Math.sqrt((N - n) / (N - 1));
	return {
		markdown: [
			`В компании ${N} сотрудников. Для оценки среднего времени на задачу случайно, **без возвращения**, опросили ${n} из них; выборочное стандартное отклонение (n − 1) — ${num(s)} ч.`,
			'',
			'Найдите стандартную ошибку выборочного среднего как оценки среднего по всем сотрудникам компании (с поправкой на конечную совокупность).',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(se),
		input: { cls: 'finite-population', N, n, s },
		wrong: { 'no-fpc': f(s / Math.sqrt(n)), 'sd-not-se': f(s * Math.sqrt((N - n) / (N - 1))) }
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	'se-mean': seMean,
	'linear-combination': linearCombination,
	'clt-mean': cltMean,
	'clt-total': cltTotal,
	'se-diff-means': seDiffMeans,
	'se-proportion': seProportion,
	'correlated-sum': correlatedSum,
	'finite-population': finitePopulation
};

/** The reference uses the standard library: `statistics.stdev` and `NormalDist`. */
const PYTHON_REFERENCE = `import json
import math
from statistics import NormalDist, stdev

p = json.loads(input())
cls = p["cls"]
phi = NormalDist().cdf

if cls == "se-mean":
    print(repr(stdev(p["xs"]) / math.sqrt(len(p["xs"]))))
elif cls == "linear-combination":
    print(repr(math.hypot(p["a"] * p["sx"], p["b"] * p["sy"])))
elif cls == "clt-mean":
    sd = p["sigma"] / math.sqrt(p["n"])
    dist = NormalDist(p["mu"], sd)
    print(repr(dist.cdf(p["mu"] + p["d"]) - dist.cdf(p["mu"] - p["d"])))
elif cls == "clt-total":
    dist = NormalDist(p["n"] * p["mu"], p["sigma"] * math.sqrt(p["n"]))
    print(repr(1 - dist.cdf(p["t"])))
elif cls == "se-diff-means":
    print(repr(math.sqrt(p["s1"] ** 2 / p["n1"] + p["s2"] ** 2 / p["n2"])))
elif cls == "se-proportion":
    q = p["k"] / p["n"]
    print(repr(math.sqrt(q * (1 - q) / p["n"])))
elif cls == "correlated-sum":
    sign = -1 if p["diff"] else 1
    cov = p["rho"] * p["sx"] * p["sy"]
    print(repr(math.sqrt(p["sx"] ** 2 + p["sy"] ** 2 + 2 * sign * cov)))
elif cls == "finite-population":
    big, n = p["N"], p["n"]
    print(repr(p["s"] / math.sqrt(n) * math.sqrt((big - n) / (big - 1))))
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
