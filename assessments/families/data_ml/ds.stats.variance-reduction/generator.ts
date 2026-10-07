// Variance reduction in experiments: CUPED (the coefficient θ, the adjusted difference, the standard error after it)
// and stratification; Senior — the sample size with CUPED, θ estimated on both groups together, the standard error of
// a post-stratified mean and users without a pre-period.
import { readDescriptor, type Built, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { floatAnswer, num, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';
import { covariance, mean, variance } from '../../_lib/stats.ts';

const descriptor = readDescriptor(import.meta.url);
const f = (value: number, digits: number) => floatAnswer(value, digits);
const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

const CUPED =
	'CUPED: скорректированная метрика пользователя Y′ = Y − θ·(X − X̄), где X — та же метрика за период до эксперимента (ковариата), X̄ — её среднее, θ = cov(X, Y) / var(X).';

/** Pairs (before, during) of users with a strong linear link and noise. */
function pairs(rng: Rng, n: number): { xs: number[]; ys: number[] } {
	const slope = rng.int(5, 15) / 10;
	const shift = rng.int(0, 20);
	const xs = Array.from({ length: n }, () => rng.int(0, 60));
	const ys = xs.map((x) => Math.max(0, Math.round(shift + slope * x + rng.int(-12, 12))));
	return { xs, ys };
}

function theta(rng: Rng): ComputedScenario | null {
	const n = rng.int(8, 12);
	const { xs, ys } = pairs(rng, n);
	const vx = variance(xs, 1);
	const vy = variance(ys, 1);
	if (vx === 0 || vy === 0) return null;
	const cov = covariance(xs, ys, 1);
	return {
		markdown: [
			`Для CUPED нужен коэффициент θ. Выручка пользователей (₽, в сотнях) за месяц до эксперимента (X) и во время него (Y), ${n} пользователей:`,
			'',
			'| пользователь | X | Y |',
			'| --- | --- | --- |',
			...xs.map((x, i) => `| u${i + 1} | ${x} | ${ys[i]} |`),
			'',
			`${CUPED} Найдите θ по этим данным (ковариация и дисперсия — с одним и тем же делителем).`,
			'',
			roundingRule(4)
		].join('\n'),
		code: null,
		answer: f(cov / vx, 4),
		input: { cls: 'theta', xs, ys },
		wrong: { 'var-of-metric': f(cov / vy, 4), correlation: f(cov / Math.sqrt(vx * vy), 4) }
	};
}

function cupedDiff(rng: Rng): ComputedScenario {
	const th = rng.int(30, 120) / 100;
	const xA = rng.int(800, 2000) / 10;
	const xB = xA + (rng.bool() ? 1 : -1) * (rng.int(10, 80) / 10);
	const yA = rng.int(900, 2500) / 10;
	const yB = yA + rng.int(-60, 60) / 10;
	const nA = rng.int(5000, 50000);
	const nB = rng.int(5000, 50000);
	return {
		markdown: [
			'Средние по группам эксперимента (метрика — число действий пользователя за период; ковариата — то же за месяц до эксперимента):',
			'',
			'| группа | пользователей | среднее X (до) | среднее Y (во время) |',
			'| --- | --- | --- | --- |',
			`| A | ${nA} | ${num(xA)} | ${num(yA)} |`,
			`| B | ${nB} | ${num(xB)} | ${num(yB)} |`,
			'',
			`${CUPED} θ = ${num(th)} оценён по объединённым данным; X̄ — общее среднее ковариаты по обеим группам. Найдите **оценку эффекта** — разность средних Y′ группы B и группы A.`,
			'',
			roundingRule(3)
		].join('\n'),
		code: null,
		answer: f(yB - yA - th * (xB - xA), 3),
		input: { cls: 'cuped-diff', th, nA, nB, xA, xB, yA, yB },
		wrong: { 'plain-diff': f(yB - yA, 3), 'sign-flip': f(yB - yA + th * (xB - xA), 3) }
	};
}

function cupedVariance(rng: Rng): ComputedScenario {
	const sigma = rng.int(10, 300);
	const rho = rng.int(30, 90) / 100;
	const n = rng.int(10, 400) * 50;
	const se = (factor: number) => Math.sqrt((2 * sigma ** 2 * factor) / n);
	return {
		markdown: [
			`В каждой группе эксперимента по ${n} пользователей. Стандартное отклонение метрики Y в каждой группе — ${sigma}; корреляция Y с ковариатой предпериода — ρ = ${num(rho)}.`,
			'',
			`${CUPED} θ оценён точно. Найдите **стандартную ошибку разности средних Y′** двух групп (дисперсии групп одинаковы).`,
			'',
			roundingRule(3)
		].join('\n'),
		code: null,
		answer: f(se(1 - rho ** 2), 3),
		input: { cls: 'cuped-variance', sigma, rho, n },
		wrong: { 'one-minus-rho': f(se(1 - rho), 3), 'plain-diff': f(se(1), 3) }
	};
}

interface Stratum {
	name: string;
	weight: number;
	nA: number;
	yA: number;
	nB: number;
	yB: number;
}

function strata(rng: Rng): Stratum[] {
	const names = rng.pick([
		['новые', 'вернувшиеся', 'постоянные'],
		['Android', 'iOS', 'веб'],
		['Москва', 'регионы', 'СНГ']
	]);
	const count = rng.int(2, 3);
	const cut = rng.int(20, 60);
	const weights = count === 2 ? [cut, 100 - cut] : [cut, rng.int(10, 90 - cut), 0];
	if (count === 3) weights[2] = 100 - (weights[0] ?? 0) - (weights[1] ?? 0);
	return names.slice(0, count).map((name, i) => {
		const base = rng.int(200, 2000) / 10;
		return {
			name,
			weight: (weights[i] ?? 0) / 100,
			nA: rng.int(100, 3000),
			yA: base,
			nB: rng.int(100, 3000),
			yB: Math.round((base + rng.int(-50, 80) / 10) * 10) / 10
		};
	});
}

function stratified(rng: Rng): ComputedScenario {
	const ss = strata(rng);
	const naive = (n: (s: Stratum) => number, y: (s: Stratum) => number) =>
		sum(ss.map((s) => n(s) * y(s))) / sum(ss.map(n));
	return {
		markdown: [
			'Пользователи делятся на страты с известными долями в генеральной совокупности. Средняя выручка на пользователя (₽) в выборках групп:',
			'',
			'| страта | доля в совокупности | A: пользователей | A: среднее | B: пользователей | B: среднее |',
			'| --- | --- | --- | --- | --- | --- |',
			...ss.map((s) => `| ${s.name} | ${num(s.weight)} | ${s.nA} | ${num(s.yA)} | ${s.nB} | ${num(s.yB)} |`),
			'',
			'Оцените эффект **стратифицированно**: среднее группы — сумма средних страт с весами долей страт в совокупности; эффект — разность таких средних B − A.',
			'',
			roundingRule(3)
		].join('\n'),
		code: null,
		answer: f(sum(ss.map((s) => s.weight * (s.yB - s.yA))), 3),
		input: { cls: 'stratified', strata: ss },
		wrong: {
			'plain-diff': f(
				naive(
					(s) => s.nB,
					(s) => s.yB
				) -
					naive(
						(s) => s.nA,
						(s) => s.yA
					),
				3
			)
		}
	};
}

function nAfterCuped(rng: Rng): ComputedScenario | null {
	const vx = rng.int(100, 5000);
	const vy = rng.int(100, 5000);
	const rho = rng.int(30, 90) / 100;
	const cov = Math.round(rho * Math.sqrt(vx * vy));
	const r = cov / Math.sqrt(vx * vy);
	const n0 = rng.int(20, 400) * 100;
	const exact = n0 * (1 - r * r);
	const frac = exact - Math.floor(exact);
	if (frac < 0.02 || frac > 0.98) return null;
	return {
		markdown: [
			`Без снижения дисперсии тесту нужно ${n0} пользователей в группе. По данным прошлых периодов: var(X) = ${vx}, var(Y) = ${vy}, cov(X, Y) = ${cov}, где X — метрика за месяц до теста, Y — метрика во время теста.`,
			'',
			`${CUPED} Мощность и MDE те же. Сколько пользователей в группе нужно с CUPED? Округлите вверх.`,
			'',
			'Ответ — целое число.'
		].join('\n'),
		code: null,
		answer: f(Math.ceil(exact), 4),
		input: { cls: 'n-after-cuped', vx, vy, cov, n0 },
		wrong: { 'one-minus-rho': f(Math.ceil(n0 * (1 - r)), 4) }
	};
}

function cupedAdjusted(xs: readonly number[], ys: readonly number[], th: number, center: number): number {
	return mean(ys.map((y, i) => y - th * ((xs[i] ?? 0) - center)));
}

function groupTheta(rng: Rng): ComputedScenario | null {
	const a = pairs(rng, rng.int(6, 8));
	const b = pairs(rng, rng.int(6, 8));
	const bShift = rng.int(5, 15);
	b.xs = b.xs.map((x) => x + bShift);
	const xs = [...a.xs, ...b.xs];
	const ys = [...a.ys, ...b.ys];
	if (variance(a.xs, 1) === 0 || variance(b.xs, 1) === 0) return null;
	const th = covariance(xs, ys, 1) / variance(xs, 1);
	const center = mean(xs);
	const effect = (ta: number, tb: number) =>
		cupedAdjusted(b.xs, b.ys, tb, center) - cupedAdjusted(a.xs, a.ys, ta, center);
	const row = (g: string, d: { xs: number[]; ys: number[] }) => d.xs.map((x, i) => `| ${g} | ${x} | ${d.ys[i]} |`);
	return {
		markdown: [
			'Маленький пилот: метрика пользователя до эксперимента (X) и во время (Y).',
			'',
			'| группа | X | Y |',
			'| --- | --- | --- |',
			...row('A', a),
			...row('B', b),
			'',
			`${CUPED} По протоколу θ оценивается **по объединённым данным обеих групп** (ковариация и дисперсия с одним делителем), X̄ — среднее X по всем пользователям пилота. Найдите оценку эффекта — разность средних Y′ групп B и A.`,
			'',
			roundingRule(3)
		].join('\n'),
		code: null,
		answer: f(effect(th, th), 3),
		input: { cls: 'group-theta', a, b },
		wrong: {
			'per-group-theta': f(
				effect(covariance(a.xs, a.ys, 1) / variance(a.xs, 1), covariance(b.xs, b.ys, 1) / variance(b.xs, 1)),
				3
			),
			'plain-diff': f(mean(b.ys) - mean(a.ys), 3)
		}
	};
}

function stratifiedSe(rng: Rng): ComputedScenario {
	const count = rng.int(2, 3);
	const names = ['новые', 'вернувшиеся', 'постоянные'].slice(0, count);
	const cut = rng.int(20, 60);
	const ws = count === 2 ? [cut, 100 - cut] : [cut, rng.int(10, 90 - cut)];
	if (count === 3) ws.push(100 - sum(ws));
	const rows = names.map((name, i) => ({
		name,
		weight: (ws[i] ?? 0) / 100,
		n: rng.int(50, 2000),
		mean: rng.int(100, 3000) / 10,
		sd: rng.int(50, 1500) / 10
	}));
	const total = sum(rows.map((r) => r.n));
	const grand = sum(rows.map((r) => r.n * r.mean)) / total;
	const pooledVar =
		(sum(rows.map((r) => (r.n - 1) * r.sd ** 2)) + sum(rows.map((r) => r.n * (r.mean - grand) ** 2))) / (total - 1);
	return {
		markdown: [
			'Выручка на пользователя (₽) в одной группе эксперимента по стратам; доли страт в совокупности известны:',
			'',
			'| страта | доля W | пользователей n | среднее | выборочное стандартное отклонение s |',
			'| --- | --- | --- | --- | --- |',
			...rows.map((r) => `| ${r.name} | ${num(r.weight)} | ${r.n} | ${num(r.mean)} | ${num(r.sd)} |`),
			'',
			'Среднее группы оценивают **постстратификацией**: Σ W·(среднее страты). Найдите стандартную ошибку этой оценки: √(Σ W²·s²/n) по стратам.',
			'',
			roundingRule(4)
		].join('\n'),
		code: null,
		answer: f(Math.sqrt(sum(rows.map((r) => (r.weight ** 2 * r.sd ** 2) / r.n))), 4),
		input: { cls: 'stratified-se', strata: rows },
		wrong: { 'naive-se': f(Math.sqrt(pooledVar / total), 4) }
	};
}

function missingPre(rng: Rng): ComputedScenario | null {
	const th = rng.int(40, 110) / 100;
	const group = () => ({
		withPre: rng.int(2000, 20000),
		without: rng.int(200, 8000),
		x: rng.int(500, 1500) / 10,
		y: rng.int(600, 1800) / 10,
		yNew: rng.int(200, 900) / 10
	});
	const a = group();
	const b = group();
	if (Math.abs(a.without / (a.without + a.withPre) - b.without / (b.without + b.withPre)) < 0.03) return null;
	const center = (a.withPre * a.x + b.withPre * b.x) / (a.withPre + b.withPre);
	const adjusted = (g: typeof a, missing: number | null) =>
		(g.withPre * (g.y - th * (g.x - center)) +
			(missing === null ? 0 : g.without * (g.yNew - th * (missing - center)))) /
		(g.withPre + (missing === null ? 0 : g.without));
	return {
		markdown: [
			'Часть пользователей пришла уже во время эксперимента, и метрики предпериода (X) у них нет. Сводка по группам (метрика — выручка на пользователя, ₽):',
			'',
			'| группа | с предпериодом: пользователей | среднее X | среднее Y | без предпериода: пользователей | среднее Y |',
			'| --- | --- | --- | --- | --- | --- |',
			`| A | ${a.withPre} | ${num(a.x)} | ${num(a.y)} | ${a.without} | ${num(a.yNew)} |`,
			`| B | ${b.withPre} | ${num(b.x)} | ${num(b.y)} | ${b.without} | ${num(b.yNew)} |`,
			'',
			`${CUPED} θ = ${num(th)}, X̄ — среднее X по всем пользователям с предпериодом в обеих группах. Пользователям без предпериода X заменяют на X̄ (поправка для них нулевая), все пользователи остаются в анализе. Найдите оценку эффекта — разность средних Y′ групп B и A.`,
			'',
			roundingRule(3)
		].join('\n'),
		code: null,
		answer: f(adjusted(b, center) - adjusted(a, center), 3),
		input: { cls: 'missing-pre', th, a, b },
		wrong: {
			'drop-missing': f(adjusted(b, null) - adjusted(a, null), 3),
			'zero-impute': f(adjusted(b, 0) - adjusted(a, 0), 3)
		}
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	theta,
	'cuped-diff': cupedDiff,
	'cuped-variance': cupedVariance,
	stratified,
	'n-after-cuped': nAfterCuped,
	'group-theta': groupTheta,
	'stratified-se': stratifiedSe,
	'missing-pre': missingPre
};

const PYTHON_REFERENCE = `import json
import math
import statistics

p = json.loads(input())
cls = p["cls"]

def cuped_mean(xs, ys, th, center):
    return statistics.mean(y - th * (x - center) for x, y in zip(xs, ys))

if cls == "theta":
    # theta is the slope of the least-squares line of Y on X
    print(repr(statistics.linear_regression(p["xs"], p["ys"]).slope))
elif cls == "cuped-diff":
    total = p["nA"] + p["nB"]
    center = (p["nA"] * p["xA"] + p["nB"] * p["xB"]) / total
    ya = p["yA"] - p["th"] * (p["xA"] - center)
    yb = p["yB"] - p["th"] * (p["xB"] - center)
    print(repr(yb - ya))
elif cls == "cuped-variance":
    var = p["sigma"] ** 2 * (1 - p["rho"] ** 2)
    print(repr(math.sqrt(var / p["n"] + var / p["n"])))
elif cls == "stratified":
    a = sum(s["weight"] * s["yA"] for s in p["strata"])
    b = sum(s["weight"] * s["yB"] for s in p["strata"])
    print(repr(b - a))
elif cls == "n-after-cuped":
    r2 = p["cov"] ** 2 / (p["vx"] * p["vy"])
    print(math.ceil(p["n0"] * (1 - r2)))
elif cls == "group-theta":
    xs = p["a"]["xs"] + p["b"]["xs"]
    ys = p["a"]["ys"] + p["b"]["ys"]
    th = statistics.linear_regression(xs, ys).slope
    center = statistics.mean(xs)
    print(repr(cuped_mean(p["b"]["xs"], p["b"]["ys"], th, center) - cuped_mean(p["a"]["xs"], p["a"]["ys"], th, center)))
elif cls == "stratified-se":
    print(repr(math.sqrt(sum(s["weight"] ** 2 * s["sd"] ** 2 / s["n"] for s in p["strata"]))))
elif cls == "missing-pre":
    a, b, th = p["a"], p["b"], p["th"]
    center = (a["withPre"] * a["x"] + b["withPre"] * b["x"]) / (a["withPre"] + b["withPre"])
    def adjusted(g):
        total = g["withPre"] * (g["y"] - th * (g["x"] - center)) + g["without"] * g["yNew"]
        return total / (g["withPre"] + g["without"])
    print(repr(adjusted(b) - adjusted(a)))
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
