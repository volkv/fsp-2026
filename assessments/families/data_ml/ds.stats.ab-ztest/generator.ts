// Hypothesis tests of an A/B experiment: the z-test of two proportions (two-sided, directional, the statistic itself)
// and of two means; Senior — a ratio metric by the delta method, the sample ratio mismatch, Bonferroni over repeated
// looks and a non-inferiority test. Φ is the standard normal distribution function; any tool may compute it.
import { readDescriptor, type Built, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { floatAnswer, num, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';
import { normalCdf } from '../../_lib/stats.ts';

const descriptor = readDescriptor(import.meta.url);
const f = (value: number, digits = 4) => floatAnswer(value, digits);

const twoSided = (z: number): number => 2 * normalCdf(-Math.abs(z));
const upperTail = (z: number): number => normalCdf(-z);

const PHI = 'Φ — функция стандартного нормального распределения; считать её можно любым инструментом.';
const P_RULE = `${roundingRule(4)} p-value — вероятность от 0 до 1.`;

interface Proportions {
	nA: number;
	kA: number;
	nB: number;
	kB: number;
}

/** Two groups whose pooled z lands in [lo, hi] in absolute value (the sign is random unless `positive`). */
function proportions(rng: Rng, lo: number, hi: number, positive: boolean): Proportions | null {
	const nA = rng.int(800, 20000);
	const nB = Math.round(nA * (rng.int(60, 140) / 100));
	const pA = rng.int(20, 400) / 1000;
	const target = (positive || rng.bool() ? 1 : -1) * (lo + rng.next() * (hi - lo));
	const se = Math.sqrt(pA * (1 - pA) * (1 / nA + 1 / nB));
	const pB = pA + target * se;
	if (pB <= 0.005 || pB >= 0.995) return null;
	const g = { nA, kA: Math.round(nA * pA), nB, kB: Math.round(nB * pB) };
	const z = pooledZ(g);
	return Math.abs(z) >= lo && Math.abs(z) <= hi && (!positive || z > 0) ? g : null;
}

function pooledZ(g: Proportions): number {
	const pooled = (g.kA + g.kB) / (g.nA + g.nB);
	return (g.kB / g.nB - g.kA / g.nA) / Math.sqrt(pooled * (1 - pooled) * (1 / g.nA + 1 / g.nB));
}

function unpooledZ(g: Proportions): number {
	const a = g.kA / g.nA;
	const b = g.kB / g.nB;
	return (b - a) / Math.sqrt((a * (1 - a)) / g.nA + (b * (1 - b)) / g.nB);
}

const PRODUCTS = ['новая карточка товара', 'упрощённая регистрация', 'другой текст кнопки оплаты', 'новый онбординг'];

function table(g: Proportions): string[] {
	return [
		'| группа | пользователей | конверсий |',
		'| --- | --- | --- |',
		`| A (контроль) | ${g.nA} | ${g.kA} |`,
		`| B (тест) | ${g.nB} | ${g.kB} |`
	];
}

const POOLED_RULE =
	'Используйте z-критерий для двух долей с **объединённой** оценкой доли при нулевой гипотезе p_A = p_B: z = (p̂_B − p̂_A) / √(p̂(1 − p̂)(1/n_A + 1/n_B)), где p̂ — доля конверсий в обеих группах вместе.';

function twoSidedP(rng: Rng): ComputedScenario | null {
	const g = proportions(rng, 0.8, 3.3, false);
	if (!g) return null;
	const z = pooledZ(g);
	return {
		markdown: [
			`Эксперимент: ${rng.pick(PRODUCTS)}. Пользователи распределены случайно и независимо.`,
			'',
			...table(g),
			'',
			`Гипотезы: H₀ — конверсии равны, H₁ — конверсии различаются. ${POOLED_RULE} Найдите **p-value**.`,
			'',
			PHI,
			'',
			P_RULE
		].join('\n'),
		code: null,
		answer: f(twoSided(z)),
		input: { cls: 'two-sided-p', ...g },
		wrong: { 'unpooled-se': f(twoSided(unpooledZ(g))), 'one-sided-p': f(twoSided(z) / 2) }
	};
}

function oneSidedP(rng: Rng): ComputedScenario | null {
	const g = proportions(rng, 0.8, 3.3, true);
	if (!g) return null;
	const z = pooledZ(g);
	return {
		markdown: [
			`Эксперимент: ${rng.pick(PRODUCTS)}. До запуска зафиксировали направленную гипотезу: изменение может только улучшить конверсию, ухудшение не рассматривается.`,
			'',
			...table(g),
			'',
			`Гипотезы: H₀ — p_B ≤ p_A, H₁ — p_B > p_A. ${POOLED_RULE} Найдите **p-value**.`,
			'',
			PHI,
			'',
			P_RULE
		].join('\n'),
		code: null,
		answer: f(upperTail(z)),
		input: { cls: 'one-sided-p', ...g },
		wrong: { 'two-sided-p': f(twoSided(z)), 'unpooled-se': f(upperTail(unpooledZ(g))) }
	};
}

function zStatistic(rng: Rng): ComputedScenario | null {
	const nA = rng.int(300, 5000);
	const nB = Math.round(nA * (rng.int(25, 60) / 100));
	const pA = rng.int(20, 300) / 1000;
	const pB = pA * (rng.int(130, 220) / 100);
	const g = { nA, kA: Math.round(nA * pA), nB, kB: Math.round(nB * pB) };
	const z = pooledZ(g);
	if (Math.abs(z) < 1 || Math.abs(z) > 6) return null;
	return {
		markdown: [
			`Эксперимент: ${rng.pick(PRODUCTS)}. На тестовую группу отдали меньшую часть трафика.`,
			'',
			...table(g),
			'',
			`${POOLED_RULE} Найдите **значение статистики z** (со знаком).`,
			'',
			roundingRule(3)
		].join('\n'),
		code: null,
		answer: f(z, 3),
		input: { cls: 'z-statistic', ...g },
		wrong: { 'unpooled-se': f(unpooledZ(g), 3) }
	};
}

function meanTest(rng: Rng): ComputedScenario | null {
	const nA = rng.int(200, 8000);
	const nB = rng.int(200, 8000);
	const sA = rng.int(200, 2000) / 10;
	const sB = rng.int(200, 2000) / 10;
	const se = Math.sqrt(sA ** 2 / nA + sB ** 2 / nB);
	const mA = rng.int(5000, 20000) / 10;
	const z0 = (rng.bool() ? 1 : -1) * (0.8 + rng.next() * 2.5);
	const mB = Math.round((mA + z0 * se) * 10) / 10;
	const z = (mB - mA) / se;
	if (Math.abs(z) < 0.6 || Math.abs(z) > 3.4) return null;
	return {
		markdown: [
			'Эксперимент со средним чеком (₽); выборки большие, распределение разности средних считайте нормальным:',
			'',
			'| группа | пользователей | средний чек | выборочное стандартное отклонение |',
			'| --- | --- | --- | --- |',
			`| A | ${nA} | ${num(mA)} | ${num(sA)} |`,
			`| B | ${nB} | ${num(mB)} | ${num(sB)} |`,
			'',
			'Гипотезы: H₀ — средние равны, H₁ — различаются. z = (m_B − m_A) / SE, где SE — стандартная ошибка разности средних по выборочным дисперсиям групп. Найдите **p-value**.',
			'',
			PHI,
			'',
			P_RULE
		].join('\n'),
		code: null,
		answer: f(twoSided(z)),
		input: { cls: 'mean-test', nA, nB, mA, mB, sA, sB },
		wrong: {
			'sum-of-se': f(twoSided((mB - mA) / (sA / Math.sqrt(nA) + sB / Math.sqrt(nB)))),
			'one-sided-p': f(twoSided(z) / 2)
		}
	};
}

interface RatioGroup {
	n: number;
	mx: number;
	my: number;
	vx: number;
	vy: number;
	cxy: number;
}

const ratioVar = (g: RatioGroup): number =>
	(g.vx / g.my ** 2 - (2 * g.mx * g.cxy) / g.my ** 3 + (g.mx ** 2 * g.vy) / g.my ** 4) / g.n;

function ratioGroup(rng: Rng, ctr: number, n: number): RatioGroup | null {
	const my = rng.int(50, 300) / 10;
	const mx = Math.round(ctr * my * 1000) / 1000;
	const sy = my * (rng.int(60, 140) / 100);
	const sx = Math.sqrt(mx) * (rng.int(120, 300) / 100);
	const rho = rng.int(30, 85) / 100;
	const g = {
		n,
		mx,
		my,
		vx: Math.round(sx * sx * 1000) / 1000,
		vy: Math.round(sy * sy * 100) / 100,
		cxy: Math.round(rho * sx * sy * 1000) / 1000
	};
	return ratioVar(g) > 0 ? g : null;
}

function ratioMetric(rng: Rng): ComputedScenario | null {
	const n = rng.int(2000, 20000);
	const ctr = rng.int(20, 150) / 1000;
	const a = ratioGroup(rng, ctr, n);
	const b = ratioGroup(rng, ctr * (1 + rng.int(-80, 80) / 1000), rng.int(Math.round(n * 0.9), Math.round(n * 1.1)));
	if (!a || !b) return null;
	const ra = a.mx / a.my;
	const rb = b.mx / b.my;
	const z = (rb - ra) / Math.sqrt(ratioVar(a) + ratioVar(b));
	if (Math.abs(z) < 0.6 || Math.abs(z) > 3.4) return null;
	const trials = (g: RatioGroup): number => {
		const r = g.mx / g.my;
		return (r * (1 - r)) / (g.n * g.my);
	};
	return {
		markdown: [
			'Эксперимент рандомизирован **по пользователям**; метрика — CTR = Σ клики / Σ показы по всем пользователям группы. У пользователя бывает много показов, его клики и показы связаны. Сводка на пользователя (дисперсии и ковариация — по пользователям):',
			'',
			'| группа | пользователей | клики: среднее | показы: среднее | клики: дисперсия | показы: дисперсия | cov(клики, показы) |',
			'| --- | --- | --- | --- | --- | --- | --- |',
			...[
				['A', a],
				['B', b]
			].map(([name, g]) => {
				const x = g as RatioGroup;
				return `| ${name as string} | ${x.n} | ${num(x.mx)} | ${num(x.my)} | ${num(x.vx)} | ${num(x.vy)} | ${num(x.cxy)} |`;
			}),
			'',
			'Дисперсию CTR группы оцените **дельта-методом**: Var(R) ≈ (1/n)·(σ²ₓ/μ²ᵧ − 2μₓσₓᵧ/μ³ᵧ + μ²ₓσ²ᵧ/μ⁴ᵧ), где x — клики, y — показы на пользователя. z = (CTR_B − CTR_A) / √(Var_A + Var_B). Гипотеза двусторонняя. Найдите **p-value**.',
			'',
			PHI,
			'',
			P_RULE
		].join('\n'),
		code: null,
		answer: f(twoSided(z)),
		input: { cls: 'ratio-metric', groups: [a, b] },
		wrong: { 'views-as-trials': f(twoSided((rb - ra) / Math.sqrt(trials(a) + trials(b)))) }
	};
}

function srm(rng: Rng): ComputedScenario | null {
	const share = rng.pick([10, 20, 25, 30, 40]) / 100;
	const total = rng.int(5000, 100000);
	const expected = total * share;
	const target = (rng.bool() ? 1 : -1) * (0.8 + rng.next() * 2.5);
	const nB = Math.round(expected + target * Math.sqrt(total * share * (1 - share)));
	const nA = total - nB;
	const chi = (nB - expected) ** 2 / expected + (nA - (total - expected)) ** 2 / (total - expected);
	const p = twoSided(Math.sqrt(chi));
	if (p < 0.001 || p > 0.6) return null;
	const half = total / 2;
	const chiEqual = (nB - half) ** 2 / half + (nA - half) ** 2 / half;
	return {
		markdown: [
			`Эксперимент запланирован со сплитом ${num(100 - share * 100)} / ${num(share * 100)}: в контроль A должна попадать доля ${num(1 - share)} пользователей, в тест B — ${num(share)}. Фактически попали: A — ${nA}, B — ${nB}.`,
			'',
			'Проверьте соответствие фактического соотношения плановому (sample ratio mismatch) критерием χ² Пирсона с одной степенью свободы: χ² = Σ (O − E)² / E по двум группам. При одной степени свободы P(χ² > x) = 2·(1 − Φ(√x)). Найдите **p-value**.',
			'',
			PHI,
			'',
			P_RULE
		].join('\n'),
		code: null,
		answer: f(p),
		input: { cls: 'srm', share, nA, nB },
		wrong: { 'equal-split': f(twoSided(Math.sqrt(chiEqual))) }
	};
}

function peekingBonferroni(rng: Rng): ComputedScenario | null {
	const looks = rng.int(3, 8);
	const g = proportions(rng, 2.2, 3.6, false);
	if (!g) return null;
	const p = twoSided(pooledZ(g));
	return {
		markdown: [
			`Эксперимент: ${rng.pick(PRODUCTS)}. Аналитик смотрел на результат ${looks} раз по ходу теста (включая последний) и был готов остановиться при значимом результате на любом просмотре. Данные на последнем просмотре:`,
			'',
			...table(g),
			'',
			`Гипотеза двусторонняя. ${POOLED_RULE} Чтобы учесть подглядывание, к p-value последнего просмотра применяют поправку Бонферрони на число просмотров (p · k, но не больше 1). Найдите **скорректированное p-value**.`,
			'',
			PHI,
			'',
			P_RULE
		].join('\n'),
		code: null,
		answer: f(Math.min(1, p * looks)),
		input: { cls: 'peeking-bonferroni', looks, ...g },
		wrong: { unadjusted: f(p), 'unpooled-se': f(Math.min(1, twoSided(unpooledZ(g)) * looks)) }
	};
}

function nonInferiority(rng: Rng): ComputedScenario | null {
	const nA = rng.int(500, 10000);
	const nB = rng.int(500, 10000);
	const sA = rng.int(100, 800) / 10;
	const sB = rng.int(100, 800) / 10;
	const se = Math.sqrt(sA ** 2 / nA + sB ** 2 / nB);
	const mA = rng.int(1000, 6000) / 10;
	const margin = Math.round(se * (1 + rng.next() * 2) * 10) / 10;
	const mB = Math.round((mA - rng.next() * margin * 0.8) * 10) / 10;
	const z = (mB - mA + margin) / se;
	if (z < 0.6 || z > 3.4) return null;
	return {
		markdown: [
			'Поиск переводят на более дешёвую модель ранжирования; метрика — **число просмотренных товаров на сессию**, больше — лучше. Новую версию примут, если она хуже старой не больше чем на допуск.',
			'',
			'| группа | сессий | среднее | выборочное стандартное отклонение |',
			'| --- | --- | --- | --- |',
			`| A (старая) | ${nA} | ${num(mA)} | ${num(sA)} |`,
			`| B (новая) | ${nB} | ${num(mB)} | ${num(sB)} |`,
			'',
			`Допуск неухудшения δ = ${num(margin)}. Гипотезы: H₀ — μ_B − μ_A ≤ −δ, H₁ — μ_B − μ_A > −δ. Выборки большие; SE разности — по выборочным дисперсиям групп. Найдите **p-value**.`,
			'',
			PHI,
			'',
			P_RULE
		].join('\n'),
		code: null,
		answer: f(upperTail(z)),
		input: { cls: 'non-inferiority', nA, nB, mA, mB, sA, sB, margin },
		wrong: { 'ignore-margin': f(upperTail((mB - mA) / se)), 'two-sided-p': f(twoSided(z)) }
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	'two-sided-p': twoSidedP,
	'one-sided-p': oneSidedP,
	'z-statistic': zStatistic,
	'mean-test': meanTest,
	'ratio-metric': ratioMetric,
	srm,
	'peeking-bonferroni': peekingBonferroni,
	'non-inferiority': nonInferiority
};

const PYTHON_REFERENCE = `import json
import math
from statistics import NormalDist

N = NormalDist()
p = json.loads(input())
cls = p["cls"]

def pooled_z(p):
    a = p["kA"] / p["nA"]
    b = p["kB"] / p["nB"]
    pool = (p["kA"] + p["kB"]) / (p["nA"] + p["nB"])
    return (b - a) / math.sqrt(pool * (1 - pool) * (1 / p["nA"] + 1 / p["nB"]))

def two_sided(z):
    return 2 * N.cdf(-abs(z))

if cls == "two-sided-p":
    print(repr(two_sided(pooled_z(p))))
elif cls == "one-sided-p":
    print(repr(1 - N.cdf(pooled_z(p))))
elif cls == "z-statistic":
    print(repr(pooled_z(p)))
elif cls == "mean-test":
    se = math.sqrt(p["sA"] ** 2 / p["nA"] + p["sB"] ** 2 / p["nB"])
    print(repr(two_sided((p["mB"] - p["mA"]) / se)))
elif cls == "ratio-metric":
    # the delta method: the gradient of x / y at the means applied to the covariance of the per-user means
    ratios, variances = [], []
    for g in p["groups"]:
        grad = (1 / g["my"], -g["mx"] / g["my"] ** 2)
        cov = ((g["vx"], g["cxy"]), (g["cxy"], g["vy"]))
        var = sum(grad[i] * cov[i][j] * grad[j] for i in range(2) for j in range(2)) / g["n"]
        ratios.append(g["mx"] / g["my"])
        variances.append(var)
    print(repr(two_sided((ratios[1] - ratios[0]) / math.sqrt(sum(variances)))))
elif cls == "srm":
    total = p["nA"] + p["nB"]
    expected = (total * (1 - p["share"]), total * p["share"])
    chi = sum((o - e) ** 2 / e for o, e in zip((p["nA"], p["nB"]), expected))
    print(repr(2 * (1 - N.cdf(math.sqrt(chi)))))
elif cls == "peeking-bonferroni":
    print(repr(min(1.0, two_sided(pooled_z(p)) * p["looks"])))
elif cls == "non-inferiority":
    se = math.sqrt(p["sA"] ** 2 / p["nA"] + p["sB"] ** 2 / p["nB"])
    print(repr(1 - N.cdf((p["mB"] - p["mA"] + p["margin"]) / se)))
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
