// Aggregating rates over segments: the overall conversion is a ratio of sums, it moves with the mix of traffic, and it
// can reverse the comparison of every segment (Simpson's paradox). Junior: standardization, the mix effect of a change,
// and a metric defined per user, where the mean of ratios is the right aggregate.
import { readDescriptor, type Built, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { floatAnswer, num, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';
import { mean } from '../../_lib/stats.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 4;
const f = (value: number) => floatAnswer(value, DIGITS);

const SEGMENT_SETS = [
	['iOS', 'Android', 'веб', 'планшеты'],
	['Москва', 'Петербург', 'Казань', 'Новосибирск'],
	['поиск', 'реклама', 'рассылка', 'прямые заходы']
] as const;

const segmentsOf = (rng: Rng, count: number): string[] => rng.pick(SEGMENT_SETS).slice(0, count);
const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
const ratio = (num_: readonly number[], den: readonly number[]): number => sum(num_) / sum(den);
const rates = (conv: readonly number[], users: readonly number[]): number[] => conv.map((c, i) => c / (users[i] ?? 1));
const share = (x: number): string => `${num(x * 100, 2)} %`;

/** Users and conversions of a variant in each segment with conversion rates spread far apart. */
function counts(rng: Rng, segments: number): { users: number[]; conv: number[] } {
	const users = Array.from({ length: segments }, () => rng.int(80, 4000));
	const conv = users.map((u) => Math.round(u * (rng.int(10, 350) / 1000)));
	return { users, conv };
}

const RATE_RULE =
	'Сегменты не пересекаются: каждый пользователь — ровно в одном сегменте. Конверсия — доля пользователей с покупкой.';

function overallRate(rng: Rng): ComputedScenario {
	const names = segmentsOf(rng, rng.int(2, 4));
	const { users, conv } = counts(rng, names.length);
	return {
		markdown: [
			'Результаты рекламной кампании по сегментам:',
			'',
			'| сегмент | пользователей | купили |',
			'| --- | --- | --- |',
			...names.map((n, i) => `| ${n} | ${users[i]} | ${conv[i]} |`),
			'',
			`${RATE_RULE} Найдите **общую конверсию кампании** по всем пользователям.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(ratio(conv, users)),
		input: { cls: 'overall-rate', groups: [{ users, conv }] },
		wrong: { 'mean-of-rates': f(mean(rates(conv, users))) }
	};
}

function rateDifference(rng: Rng): ComputedScenario {
	const names = segmentsOf(rng, rng.int(2, 3));
	const a = counts(rng, names.length);
	const b = counts(rng, names.length);
	return {
		markdown: [
			'Сравнивают два варианта страницы по сегментам:',
			'',
			'| сегмент | A: пользователей | A: купили | B: пользователей | B: купили |',
			'| --- | --- | --- | --- | --- |',
			...names.map((n, i) => `| ${n} | ${a.users[i]} | ${a.conv[i]} | ${b.users[i]} | ${b.conv[i]} |`),
			'',
			`${RATE_RULE} Найдите разность **общих** конверсий: конверсия B по всем её пользователям минус конверсия A по всем её пользователям (как доля, не в процентах).`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(ratio(b.conv, b.users) - ratio(a.conv, a.users)),
		input: { cls: 'rate-difference', groups: [a, b] },
		wrong: { 'mean-of-rates': f(mean(rates(b.conv, b.users)) - mean(rates(a.conv, a.users))) }
	};
}

/** Shares in whole percent summing to 100, each at least `min`. */
function shares(rng: Rng, count: number, min = 5): number[] {
	for (;;) {
		const cuts = Array.from({ length: count - 1 }, () => rng.int(1, 99)).sort((x, y) => x - y);
		const bounds = [0, ...cuts, 100];
		const parts = bounds.slice(1).map((b, i) => b - (bounds[i] ?? 0));
		if (parts.every((p) => p >= min)) return parts.map((p) => p / 100);
	}
}

function mixShift(rng: Rng): ComputedScenario {
	const names = segmentsOf(rng, rng.int(3, 4));
	const r = names.map(() => rng.int(10, 300) / 1000);
	const before = shares(rng, names.length);
	const after = shares(rng, names.length);
	return {
		markdown: [
			'Конверсия в покупку по источникам трафика стабильна, а структура трафика в следующем месяце изменится:',
			'',
			'| источник | конверсия | доля трафика сейчас | доля трафика в следующем месяце |',
			'| --- | --- | --- | --- |',
			...names.map((n, i) => `| ${n} | ${share(r[i] ?? 0)} | ${share(before[i] ?? 0)} | ${share(after[i] ?? 0)} |`),
			'',
			'Найдите ожидаемую **общую конверсию в следующем месяце** (как долю), если конверсия каждого источника не изменится.',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(sum(after.map((w, i) => w * (r[i] ?? 0)))),
		input: { cls: 'mix-shift', rates: r, weights: after },
		wrong: {
			'old-mix': f(sum(before.map((w, i) => w * (r[i] ?? 0)))),
			'mean-of-rates': f(mean(r))
		}
	};
}

function arpu(rng: Rng): ComputedScenario {
	const names = segmentsOf(rng, rng.int(2, 4));
	const users = names.map(() => rng.int(200, 20000));
	// Whole numbers of paying users: a share would have to be rounded back to a count.
	const paying = users.map((u) => Math.max(1, Math.round((u * rng.int(5, 200)) / 1000)));
	const payment = names.map(() => rng.int(150, 3000));
	const revenue = paying.map((p, i) => p * (payment[i] ?? 0));
	return {
		markdown: [
			'Данные игры по платформам за месяц:',
			'',
			'| платформа | пользователей | платящих | средняя выручка за месяц с одного платящего, ₽ |',
			'| --- | --- | --- | --- |',
			...names.map((n, i) => `| ${n} | ${users[i]} | ${paying[i]} | ${payment[i]} |`),
			'',
			'Каждый пользователь играет ровно на одной платформе. Найдите **ARPU** — выручку на одного пользователя по всем платформам вместе, ₽.',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(sum(revenue) / sum(users)),
		input: { cls: 'arpu', users, paying, payment },
		wrong: { 'mean-of-rates': f(mean(revenue.map((r, i) => r / (users[i] ?? 1)))) }
	};
}

function reversal(rng: Rng): ComputedScenario | null {
	// Two values of one attribute: the segments split the users, every user is in exactly one of them.
	const [low, high] = rng.shuffle(
		rng.pick([
			['мобильные', 'десктоп'],
			['новые', 'вернувшиеся']
		] as const)
	);
	const rLow = rng.int(15, 60) / 1000;
	const rHigh = rng.int(150, 350) / 1000;
	const nA = rng.int(1500, 6000);
	const nB = rng.int(1500, 6000);
	const shareA = rng.int(60, 85) / 100;
	const shareB = rng.int(10, 35) / 100;
	const users = (n: number, s: number): number[] => [n - Math.round(n * s), Math.round(n * s)];
	const aUsers = users(nA, shareA);
	const bUsers = users(nB, shareB);
	const aRates = [rLow, rHigh];
	const bRates = [rLow + rng.int(5, 30) / 1000, rHigh + rng.int(5, 40) / 1000];
	const a = { users: aUsers, conv: aUsers.map((u, i) => Math.round(u * (aRates[i] ?? 0))) };
	const b = { users: bUsers, conv: bUsers.map((u, i) => Math.round(u * (bRates[i] ?? 0))) };
	const ra = rates(a.conv, a.users);
	const rb = rates(b.conv, b.users);
	// The reversal: B wins in every segment and loses overall.
	if (!ra.every((r, i) => (rb[i] ?? 0) > r) || ratio(b.conv, b.users) >= ratio(a.conv, a.users)) return null;
	const total = sum(a.users) + sum(b.users);
	const weights = a.users.map((u, i) => (u + (b.users[i] ?? 0)) / total);
	return {
		markdown: [
			'Итоги A/B-теста по сегментам пользователей:',
			'',
			'| сегмент | A: пользователей | A: купили | B: пользователей | B: купили |',
			'| --- | --- | --- | --- | --- |',
			...[low, high].map((n, i) => `| ${n} | ${a.users[i]} | ${a.conv[i]} | ${b.users[i]} | ${b.conv[i]} |`),
			'',
			`${RATE_RULE} Найдите разность **общих** конверсий: конверсия B по всем её пользователям минус конверсия A по всем её пользователям (как доля; знак важен).`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(ratio(b.conv, b.users) - ratio(a.conv, a.users)),
		input: { cls: 'reversal', groups: [a, b] },
		wrong: {
			'mean-of-rates': f(mean(rb) - mean(ra)),
			'segment-weighted': f(sum(weights.map((w, i) => w * ((rb[i] ?? 0) - (ra[i] ?? 0)))))
		}
	};
}

function standardized(rng: Rng): ComputedScenario {
	const names = segmentsOf(rng, rng.int(2, 4));
	const a = counts(rng, names.length);
	const b = counts(rng, names.length);
	const mixA = a.users.map((u) => u / sum(a.users));
	const rb = rates(b.conv, b.users);
	return {
		markdown: [
			'Две страны запустили один и тот же продукт; конверсия сильно зависит от канала привлечения:',
			'',
			'| канал | страна A: пользователей | A: купили | страна B: пользователей | B: купили |',
			'| --- | --- | --- | --- | --- |',
			...names.map((n, i) => `| ${n} | ${a.users[i]} | ${a.conv[i]} | ${b.users[i]} | ${b.conv[i]} |`),
			'',
			`${RATE_RULE} Чтобы сравнить страны без влияния структуры каналов, конверсию B **стандартизуют по структуре A**: конверсии каналов страны B взвешиваются долями каналов среди пользователей страны A. Найдите эту стандартизованную конверсию B.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(sum(mixA.map((w, i) => w * (rb[i] ?? 0)))),
		input: { cls: 'standardized', groups: [a, b] },
		wrong: { 'raw-rate': f(ratio(b.conv, b.users)), 'mean-of-rates': f(mean(rb)) }
	};
}

function decomposition(rng: Rng): ComputedScenario {
	const names = segmentsOf(rng, rng.int(2, 4));
	const wOld = shares(rng, names.length);
	const wNew = shares(rng, names.length);
	const rOld = names.map(() => rng.int(10, 300) / 1000);
	const rNew = rOld.map((r) => Math.max(0.005, r + rng.int(-40, 40) / 1000));
	return {
		markdown: [
			'Общая конверсия изменилась между двумя месяцами. Данные по сегментам:',
			'',
			'| сегмент | доля трафика: было | конверсия: было | доля трафика: стало | конверсия: стало |',
			'| --- | --- | --- | --- | --- |',
			...names.map(
				(n, i) =>
					`| ${n} | ${share(wOld[i] ?? 0)} | ${share(rOld[i] ?? 0)} | ${share(wNew[i] ?? 0)} | ${share(rNew[i] ?? 0)} |`
			),
			'',
			'Изменение раскладывают на эффекты; **эффект структуры** — Σ (доля стала − доля было) · конверсия было, по всем сегментам. Найдите эффект структуры (как долю, со знаком).',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(sum(wNew.map((w, i) => (w - (wOld[i] ?? 0)) * (rOld[i] ?? 0)))),
		input: { cls: 'decomposition', wOld, wNew, rOld, rNew },
		wrong: {
			'total-change': f(sum(wNew.map((w, i) => w * (rNew[i] ?? 0))) - sum(wOld.map((w, i) => w * (rOld[i] ?? 0)))),
			'swapped-weights': f(sum(wNew.map((w, i) => (w - (wOld[i] ?? 0)) * (rNew[i] ?? 0))))
		}
	};
}

function userAverage(rng: Rng): ComputedScenario {
	const count = rng.int(5, 8);
	const people = rng.sample(['anna', 'boris', 'vera', 'gleb', 'dina', 'egor', 'zoya', 'ilya', 'kira', 'lev'], count);
	const shows = people.map(() => (rng.bool(0.3) ? rng.int(200, 900) : rng.int(5, 60)));
	const clicks = shows.map((s) => rng.int(0, Math.max(1, Math.round(s * 0.4))));
	return {
		markdown: [
			'Показы рекомендаций и клики по пользователям за неделю:',
			'',
			'| пользователь | показов | кликов |',
			'| --- | --- | --- |',
			...people.map((p, i) => `| ${p} | ${shows[i]} | ${clicks[i]} |`),
			'',
			'Метрика продукта — **средний CTR пользователя**: у каждого пользователя считается его CTR (клики / показы), затем эти значения усредняются по пользователям. Найдите метрику за неделю (как долю).',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(mean(rates(clicks, shows))),
		input: { cls: 'user-average', shows, clicks },
		wrong: { 'ratio-of-sums': f(ratio(clicks, shows)) }
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	'overall-rate': overallRate,
	'rate-difference': rateDifference,
	'mix-shift': mixShift,
	arpu,
	reversal,
	standardized,
	decomposition,
	'user-average': userAverage
};

const PYTHON_REFERENCE = `import json
from fractions import Fraction

p = json.loads(input())
cls = p["cls"]

def overall(g):
    return Fraction(sum(g["conv"]), sum(g["users"]))

if cls == "overall-rate":
    print(repr(float(overall(p["groups"][0]))))
elif cls in ("rate-difference", "reversal"):
    a, b = p["groups"]
    print(repr(float(overall(b) - overall(a))))
elif cls == "mix-shift":
    print(repr(sum(w * r for w, r in zip(p["weights"], p["rates"]))))
elif cls == "arpu":
    revenue = sum(k * m for k, m in zip(p["paying"], p["payment"]))
    print(repr(revenue / sum(p["users"])))
elif cls == "standardized":
    a, b = p["groups"]
    total_a = sum(a["users"])
    print(repr(float(sum(Fraction(ua, total_a) * Fraction(cb, ub) for ua, cb, ub in zip(a["users"], b["conv"], b["users"])))))
elif cls == "decomposition":
    print(repr(sum((n - o) * r for n, o, r in zip(p["wNew"], p["wOld"], p["rOld"]))))
elif cls == "user-average":
    ctr = [c / s for c, s in zip(p["clicks"], p["shows"])]
    print(repr(sum(ctr) / len(ctr)))
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
