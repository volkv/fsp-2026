// Planning an experiment by the normal approximation: the sample size per group for a proportion and for a mean, the
// achieved power; Senior — an unequal split, cluster randomization, several variants against one control and the
// minimal detectable effect. The quantiles are given in the statement; the answer uses exactly those values.
import { readDescriptor, type Built, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { floatAnswer, num, roundTo, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';
import { normalCdf, normalQuantile } from '../../_lib/stats.ts';

const descriptor = readDescriptor(import.meta.url);
const f = (value: number, digits = 4) => floatAnswer(value, digits);
const WHOLE = 'Ответ — целое число.';

/** A quantile of the table: Φ(z) = p, rounded to six places as the statement shows it. */
interface Quantile {
	label: string;
	p: number;
}
const q = (label: string, p: number): Quantile => ({ label, p });
const z = (x: Quantile): number => roundTo(normalQuantile(x.p), 6);

const BASE = [q('0.8', 0.8), q('0.9', 0.9), q('0.95', 0.95), q('0.975', 0.975), q('0.99', 0.99), q('0.995', 0.995)];

function zTable(extra: readonly Quantile[] = []): string {
	const all = [...BASE, ...extra].sort((a, b) => a.p - b.p);
	return [
		'Квантили стандартного нормального распределения z_p (Φ(z_p) = p):',
		'',
		'| p | z_p |',
		'| --- | --- |',
		...all.map((x) => `| ${x.label} | ${z(x).toFixed(6)} |`)
	].join('\n');
}

const twoSidedAlpha = (alpha: number): Quantile => q(String(1 - alpha / 2), 1 - alpha / 2);
const oneSidedAlpha = (alpha: number): Quantile => q(String(1 - alpha), 1 - alpha);
const powerQ = (power: number): Quantile => q(String(power), power);
const powerTwoSided = (power: number): Quantile => q(String(1 - (1 - power) / 2), 1 - (1 - power) / 2);

/** The sample size: a whole number above the exact value, unless the exact value sits too close to a whole number. */
function ceilSafe(exact: number): number | null {
	const frac = exact - Math.floor(exact);
	return frac < 0.02 || frac > 0.98 ? null : Math.ceil(exact);
}

const PRODUCTS = [
	'новый экран оплаты',
	'изменённая выдача рекомендаций',
	'другой порядок тарифов',
	'новая push-кампания'
];
const ALPHAS = [0.05, 0.01, 0.1] as const;
const POWERS = [0.8, 0.9] as const;

const nProportion = (za: number, zb: number, p1: number, p2: number): number =>
	((za + zb) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (p2 - p1) ** 2;

const PROPORTION_RULE =
	'Используйте нормальное приближение: n = (z₁₋α/₂ + z₁₋β)² · (p₁(1 − p₁) + p₂(1 − p₂)) / (p₂ − p₁)², где 1 − β — мощность.';

function setting(rng: Rng): { alpha: number; power: number; p1: number } {
	return { alpha: rng.pick(ALPHAS), power: rng.pick(POWERS), p1: rng.int(4, 80) / 200 };
}

function proportionN(rng: Rng): ComputedScenario | null {
	const { alpha, power, p1 } = setting(rng);
	const d = rng.int(5, 50) / 1000;
	const p2 = p1 + d;
	const right = ceilSafe(nProportion(z(twoSidedAlpha(alpha)), z(powerQ(power)), p1, p2));
	if (right === null) return null;
	return {
		markdown: [
			`Планируют A/B-тест: ${rng.pick(PRODUCTS)}. Текущая конверсия p₁ = ${num(p1)}; хотят обнаружить рост на ${num(d)} в абсолютных единицах (до p₂ = ${num(p2)}). Гипотеза двусторонняя, α = ${alpha}, мощность ${power}. Группы равные.`,
			'',
			`${PROPORTION_RULE} Найдите **минимальное число пользователей в одной группе**.`,
			'',
			zTable(),
			'',
			WHOLE
		].join('\n'),
		code: null,
		answer: f(right),
		input: { cls: 'proportion-n', alpha, power, p1, p2 },
		wrong: {
			'one-sided-alpha': f(Math.ceil(nProportion(z(oneSidedAlpha(alpha)), z(powerQ(power)), p1, p2))),
			'power-two-sided': f(Math.ceil(nProportion(z(twoSidedAlpha(alpha)), z(powerTwoSided(power)), p1, p2)))
		}
	};
}

function relativeMde(rng: Rng): ComputedScenario | null {
	const { alpha, power, p1 } = setting(rng);
	const r = rng.int(3, 25) / 100;
	const p2 = p1 * (1 + r);
	const za = z(twoSidedAlpha(alpha));
	const zb = z(powerQ(power));
	const right = ceilSafe(nProportion(za, zb, p1, p2));
	if (right === null || p1 + r >= 1) return null;
	return {
		markdown: [
			`Планируют A/B-тест: ${rng.pick(PRODUCTS)}. Текущая конверсия ${num(p1)}; минимальный интересный эффект — **относительный** рост конверсии на ${num(r * 100)} %. Гипотеза двусторонняя, α = ${alpha}, мощность ${power}. Группы равные.`,
			'',
			`${PROPORTION_RULE} Найдите **минимальное число пользователей в одной группе**.`,
			'',
			zTable(),
			'',
			WHOLE
		].join('\n'),
		code: null,
		answer: f(right),
		input: { cls: 'relative-mde', alpha, power, p1, p2 },
		wrong: { 'relative-as-absolute': f(Math.ceil(nProportion(za, zb, p1, p1 + r))) }
	};
}

function meanN(rng: Rng): ComputedScenario | null {
	const alpha = rng.pick(ALPHAS);
	const power = rng.pick(POWERS);
	const sigma = rng.int(20, 800);
	const delta = Math.max(1, Math.round(sigma * (rng.int(3, 30) / 100)));
	const za = z(twoSidedAlpha(alpha));
	const zb = z(powerQ(power));
	const exact = (2 * (za + zb) ** 2 * sigma ** 2) / delta ** 2;
	const right = ceilSafe(exact);
	if (right === null) return null;
	return {
		markdown: [
			`Метрика эксперимента — выручка на пользователя, ₽; стандартное отклонение метрики σ = ${sigma} в обеих группах. Хотят обнаружить разность средних ${delta} ₽. Гипотеза двусторонняя, α = ${alpha}, мощность ${power}. Группы равные.`,
			'',
			'Используйте нормальное приближение для разности двух средних. Найдите **минимальное число пользователей в одной группе**.',
			'',
			zTable(),
			'',
			WHOLE
		].join('\n'),
		code: null,
		answer: f(right),
		input: { cls: 'mean-n', alpha, power, sigma, delta },
		wrong: {
			'single-variance': f(Math.ceil(exact / 2)),
			'one-sided-alpha': f(Math.ceil((2 * (z(oneSidedAlpha(alpha)) + zb) ** 2 * sigma ** 2) / delta ** 2))
		}
	};
}

function achievedPower(rng: Rng): ComputedScenario | null {
	const alpha = rng.pick(ALPHAS);
	const p1 = rng.int(4, 80) / 200;
	const d = rng.int(5, 40) / 1000;
	const p2 = p1 + d;
	const n = rng.int(10, 400) * 50;
	const se = Math.sqrt((p1 * (1 - p1) + p2 * (1 - p2)) / n);
	const power = normalCdf(d / se - z(twoSidedAlpha(alpha)));
	if (power < 0.15 || power > 0.97) return null;
	return {
		markdown: [
			`В тесте будет по ${n} пользователей в каждой группе. Текущая конверсия p₁ = ${num(p1)}, ожидаемая в тесте p₂ = ${num(p2)}. Гипотеза двусторонняя, α = ${alpha}.`,
			'',
			'Найдите **мощность** теста по нормальному приближению: 1 − β = Φ(|p₂ − p₁| / SE − z₁₋α/₂), SE = √((p₁(1 − p₁) + p₂(1 − p₂)) / n). Вероятностью отвергнуть H₀ в противоположную сторону пренебрегите.',
			'',
			zTable(),
			'',
			roundingRule(4)
		].join('\n'),
		code: null,
		answer: f(power),
		input: { cls: 'achieved-power', alpha, p1, p2, n },
		wrong: { 'one-sided-alpha': f(normalCdf(d / se - z(oneSidedAlpha(alpha)))) }
	};
}

function unequalAllocation(rng: Rng): ComputedScenario | null {
	const { alpha, power, p1 } = setting(rng);
	const d = rng.int(5, 50) / 1000;
	const p2 = p1 + d;
	const k = rng.pick([2, 3, 4]);
	const za = z(twoSidedAlpha(alpha));
	const zb = z(powerQ(power));
	const right = ceilSafe(((za + zb) ** 2 * (p1 * (1 - p1) + (p2 * (1 - p2)) / k)) / d ** 2);
	if (right === null) return null;
	return {
		markdown: [
			`Тестовую версию (${rng.pick(PRODUCTS)}) показывают в ${k} раза большему числу пользователей, чем контрольную: n_B = ${k}·n_A. Конверсия контроля p₁ = ${num(p1)}, ожидаемая в тесте p₂ = ${num(p2)}. Гипотеза двусторонняя, α = ${alpha}, мощность ${power}.`,
			'',
			'Нормальное приближение: дисперсия разности долей — p₁(1 − p₁)/n_A + p₂(1 − p₂)/n_B, и тест должен иметь заданную мощность. Найдите **минимальное n_A** (размер контроля).',
			'',
			zTable(),
			'',
			WHOLE
		].join('\n'),
		code: null,
		answer: f(right),
		input: { cls: 'unequal-allocation', alpha, power, p1, p2, k },
		wrong: { 'equal-allocation': f(Math.ceil(nProportion(za, zb, p1, p2))) }
	};
}

function clusterDesign(rng: Rng): ComputedScenario | null {
	const { alpha, power, p1 } = setting(rng);
	const d = rng.int(10, 60) / 1000;
	const p2 = p1 + d;
	const m = rng.int(5, 50);
	const rho = rng.int(1, 20) / 100;
	const za = z(twoSidedAlpha(alpha));
	const zb = z(powerQ(power));
	const base = nProportion(za, zb, p1, p2);
	const right = ceilSafe(base * (1 + (m - 1) * rho));
	if (right === null) return null;
	return {
		markdown: [
			`Новую выкладку товаров тестируют по магазинам: магазин целиком попадает в контроль или в тест, в среднем в магазине ${m} покупателей за период теста. Внутрикластерная корреляция конверсии ρ = ${num(rho)}. Конверсия контроля ${num(p1)}, ожидаемая в тесте ${num(p2)}. Гипотеза двусторонняя, α = ${alpha}, мощность ${power}.`,
			'',
			`${PROPORTION_RULE} Учтите кластеры эффектом дизайна 1 + (m − 1)·ρ, умножив на него размер для независимых наблюдений. Найдите **минимальное число покупателей в одной группе** (округление вверх — один раз, в конце).`,
			'',
			zTable(),
			'',
			WHOLE
		].join('\n'),
		code: null,
		answer: f(right),
		input: { cls: 'cluster-design', alpha, power, p1, p2, m, rho },
		wrong: { 'ignore-clustering': f(Math.ceil(base)) }
	};
}

function multipleVariants(rng: Rng): ComputedScenario | null {
	const { power, p1 } = setting(rng);
	const alpha = rng.pick([0.05, 0.1] as const);
	const k = rng.int(2, 4);
	const d = rng.int(5, 50) / 1000;
	const p2 = p1 + d;
	const adjusted = q(`1 − ${alpha}/${2 * k}`, 1 - alpha / (2 * k));
	const zb = z(powerQ(power));
	const right = ceilSafe(nProportion(z(adjusted), zb, p1, p2));
	if (right === null) return null;
	return {
		markdown: [
			`В тесте ${k} новых варианта сравнивают с одним контролем, каждый — отдельной двусторонней проверкой; общий уровень ошибки первого рода α = ${alpha} контролируют поправкой Бонферрони по числу сравнений с контролем. Конверсия контроля ${num(p1)}, у варианта ожидают ${num(p2)}; мощность каждого сравнения ${power}. Группы равные.`,
			'',
			`${PROPORTION_RULE} В формуле α — уровень одного сравнения. Найдите **минимальное число пользователей в одной группе**.`,
			'',
			zTable([adjusted]),
			'',
			WHOLE
		].join('\n'),
		code: null,
		answer: f(right),
		input: { cls: 'multiple-variants', alpha, power, p1, p2, k },
		wrong: { unadjusted: f(Math.ceil(nProportion(z(twoSidedAlpha(alpha)), zb, p1, p2))) }
	};
}

function mdeGivenN(rng: Rng): ComputedScenario {
	const alpha = rng.pick(ALPHAS);
	const power = rng.pick(POWERS);
	const sigma = rng.int(20, 800);
	const n = rng.int(10, 400) * 50;
	const za = z(twoSidedAlpha(alpha));
	const zb = z(powerQ(power));
	return {
		markdown: [
			`Трафик позволяет набрать по ${n} пользователей в группу. Метрика — время в приложении за неделю, мин; σ = ${sigma} в обеих группах. Гипотеза двусторонняя, α = ${alpha}, мощность ${power}.`,
			'',
			'Найдите **минимальный обнаружимый эффект** (разность средних, мин) по нормальному приближению для разности двух средних.',
			'',
			zTable(),
			'',
			roundingRule(3)
		].join('\n'),
		code: null,
		answer: f((za + zb) * sigma * Math.sqrt(2 / n), 3),
		input: { cls: 'mde-given-n', alpha, power, sigma, n },
		wrong: {
			'single-variance': f((za + zb) * sigma * Math.sqrt(1 / n), 3),
			'one-sided-alpha': f((z(oneSidedAlpha(alpha)) + zb) * sigma * Math.sqrt(2 / n), 3)
		}
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	'proportion-n': proportionN,
	'relative-mde': relativeMde,
	'mean-n': meanN,
	'achieved-power': achievedPower,
	'unequal-allocation': unequalAllocation,
	'cluster-design': clusterDesign,
	'multiple-variants': multipleVariants,
	'mde-given-n': mdeGivenN
};

/** The reference searches the smallest n whose power reaches the target, instead of solving the formula for n. */
const PYTHON_REFERENCE = `import json
import math
from statistics import NormalDist

p = json.loads(input())
cls = p["cls"]

def zq(prob):
    return round(NormalDist().inv_cdf(prob), 6)

def smallest(enough):
    hi = 1
    while not enough(hi):
        hi *= 2
    lo = hi // 2
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if enough(mid):
            hi = mid
        else:
            lo = mid
    return hi

alpha = p.get("alpha")
za = zq(1 - alpha / 2) if alpha is not None else None
zb = zq(p["power"]) if "power" in p else None

def prop_var(p1, p2):
    return p1 * (1 - p1) + p2 * (1 - p2)

if cls in ("proportion-n", "relative-mde"):
    d = abs(p["p2"] - p["p1"])
    v = prop_var(p["p1"], p["p2"])
    print(smallest(lambda n: d / math.sqrt(v / n) >= za + zb))
elif cls == "mean-n":
    print(smallest(lambda n: p["delta"] / (p["sigma"] * math.sqrt(2 / n)) >= za + zb))
elif cls == "achieved-power":
    se = math.sqrt(prop_var(p["p1"], p["p2"]) / p["n"])
    print(repr(NormalDist().cdf(abs(p["p2"] - p["p1"]) / se - za)))
elif cls == "unequal-allocation":
    d = abs(p["p2"] - p["p1"])
    a = p["p1"] * (1 - p["p1"])
    b = p["p2"] * (1 - p["p2"])
    print(smallest(lambda n: d / math.sqrt(a / n + b / (p["k"] * n)) >= za + zb))
elif cls == "cluster-design":
    d = abs(p["p2"] - p["p1"])
    deff = 1 + (p["m"] - 1) * p["rho"]
    v = prop_var(p["p1"], p["p2"])
    print(smallest(lambda n: d / math.sqrt(v * deff / n) >= za + zb))
elif cls == "multiple-variants":
    zk = zq(1 - alpha / (2 * p["k"]))
    d = abs(p["p2"] - p["p1"])
    v = prop_var(p["p1"], p["p2"])
    print(smallest(lambda n: d / math.sqrt(v / n) >= zk + zb))
elif cls == "mde-given-n":
    print(repr((za + zb) * p["sigma"] * math.sqrt(2 / p["n"])))
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
