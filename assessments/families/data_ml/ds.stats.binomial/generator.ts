// Discrete probability: the binomial distribution (exactly k, at least one, a tail, a range), the first success, and
// for Junior — sampling without replacement, the majority of an ensemble and the r-th success.
import { readDescriptor, type Built, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { floatAnswer, num, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';
import { comb } from '../../_lib/stats.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 4;
const f = (value: number) => floatAnswer(value, DIGITS);

const pmf = (n: number, k: number, p: number): number => comb(n, k) * p ** k * (1 - p) ** (n - k);
/** P(lo ≤ X ≤ hi) for X ~ Bin(n, p). */
const between = (n: number, lo: number, hi: number, p: number): number => {
	let sum = 0;
	for (let k = Math.max(0, lo); k <= Math.min(n, hi); k += 1) sum += pmf(n, k, p);
	return sum;
};

const PLOTS = [
	{ trial: 'показ баннера', success: 'клик', many: 'показов' },
	{ trial: 'запрос к реплике', success: 'отказ реплики', many: 'запросов' },
	{ trial: 'проверка детали', success: 'брак', many: 'деталей' },
	{ trial: 'звонок клиенту', success: 'согласие на встречу', many: 'звонков' }
] as const;

const probability = (rng: Rng, lo: number, hi: number): number =>
	rng.int(Math.round(lo * 100), Math.round(hi * 100)) / 100;

function intro(rng: Rng, n: number, p: number): { text: string; success: string } {
	const plot = rng.pick(PLOTS);
	return {
		text: `Испытание — ${plot.trial}; исход «${plot.success}» случается с вероятностью ${num(p)} независимо от других испытаний. Всего ${n} ${plot.many}.`,
		success: plot.success
	};
}

function exactlyK(rng: Rng): ComputedScenario {
	const n = rng.int(5, 15);
	const p = probability(rng, 0.05, 0.6);
	const k = rng.int(1, n - 1);
	const head = intro(rng, n, p);
	return {
		markdown: [
			head.text,
			'',
			`Найдите вероятность, что исход «${head.success}» случится **ровно ${k}** раз.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(pmf(n, k, p)),
		input: { cls: 'exactly-k', n, p, lo: k, hi: k },
		wrong: { 'no-coefficient': f(p ** k * (1 - p) ** (n - k)) }
	};
}

function atLeastOne(rng: Rng): ComputedScenario {
	const n = rng.int(3, 20);
	const p = probability(rng, 0.02, 0.3);
	const head = intro(rng, n, p);
	return {
		markdown: [
			head.text,
			'',
			`Найдите вероятность, что исход «${head.success}» случится **хотя бы один** раз.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(1 - (1 - p) ** n),
		input: { cls: 'at-least-one', n, p, lo: 1, hi: n },
		wrong: { 'sum-probabilities': f(n * p) }
	};
}

function atLeastK(rng: Rng): ComputedScenario {
	const n = rng.int(6, 16);
	const p = probability(rng, 0.1, 0.6);
	const k = rng.int(2, n - 2);
	const head = intro(rng, n, p);
	return {
		markdown: [
			head.text,
			'',
			`Найдите вероятность, что исход «${head.success}» случится **не меньше ${k}** раз.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(between(n, k, n, p)),
		input: { cls: 'at-least-k', n, p, lo: k, hi: n },
		wrong: { 'strict-bound': f(between(n, k + 1, n, p)) }
	};
}

function firstSuccess(rng: Rng): ComputedScenario {
	const p = probability(rng, 0.05, 0.5);
	const k = rng.int(2, 8);
	const plot = rng.pick(PLOTS);
	return {
		markdown: [
			`Испытания (${plot.trial}) идут одно за другим; исход «${plot.success}» в каждом случается с вероятностью ${num(p)} независимо от других.`,
			'',
			`Найдите вероятность, что **первый** исход «${plot.success}» случится **ровно на ${k}-м** испытании.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f((1 - p) ** (k - 1) * p),
		input: { cls: 'first-success', p, k },
		wrong: { 'extra-failure': f((1 - p) ** k * p) }
	};
}

function hypergeometric(rng: Rng): ComputedScenario {
	const total = rng.int(20, 60);
	const bad = rng.int(3, Math.min(15, Math.floor(total / 3)));
	const draw = rng.int(4, 10);
	const j = rng.int(1, Math.min(bad, draw - 1));
	const exact = (comb(bad, j) * comb(total - bad, draw - j)) / comb(total, draw);
	return {
		markdown: [
			`В партии ${total} размеченных примеров, из них ${bad} размечены с ошибкой. Для аудита случайно выбирают ${draw} **разных** примеров (без возвращения).`,
			'',
			`Найдите вероятность, что среди выбранных **ровно ${j}** с ошибкой разметки.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(exact),
		input: { cls: 'hypergeometric', total, bad, draw, j },
		wrong: { 'with-replacement': f(pmf(draw, j, bad / total)) }
	};
}

function majorityVote(rng: Rng): ComputedScenario {
	const models = rng.pick([3, 5, 7, 9]);
	const p = probability(rng, 0.55, 0.85);
	const need = (models + 1) / 2;
	return {
		markdown: [
			`Ансамбль из ${models} независимых классификаторов голосует большинством. Каждый классификатор на случайном объекте прав с вероятностью ${num(p)}, ошибки моделей независимы, классов два.`,
			'',
			'Найдите вероятность, что ответ ансамбля верен.',
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(between(models, need, models, p)),
		input: { cls: 'majority-vote', n: models, p, lo: need, hi: models },
		wrong: { 'single-model': f(p), 'strict-bound': f(between(models, need + 1, models, p)) }
	};
}

function binomialRange(rng: Rng): ComputedScenario {
	const n = rng.int(10, 20);
	const p = probability(rng, 0.15, 0.6);
	const lo = rng.int(1, Math.floor(n / 2));
	const hi = rng.int(lo + 2, n - 1);
	const head = intro(rng, n, p);
	return {
		markdown: [
			head.text,
			'',
			`Найдите вероятность, что исход «${head.success}» случится **от ${lo} до ${hi} раз включительно**.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(between(n, lo, hi, p)),
		input: { cls: 'binomial-range', n, p, lo, hi },
		wrong: {
			'strict-bound': f(between(n, lo + 1, hi - 1, p)),
			'no-coefficient': f(
				Array.from({ length: hi - lo + 1 }, (_, i) => p ** (lo + i) * (1 - p) ** (n - lo - i)).reduce(
					(s, x) => s + x,
					0
				)
			)
		}
	};
}

function negativeBinomial(rng: Rng): ComputedScenario {
	const p = probability(rng, 0.1, 0.6);
	const r = rng.int(2, 4);
	const t = rng.int(r + 1, r + 8);
	const plot = rng.pick(PLOTS);
	return {
		markdown: [
			`Испытания (${plot.trial}) идут одно за другим; исход «${plot.success}» в каждом случается с вероятностью ${num(p)} независимо от других.`,
			'',
			`Найдите вероятность, что **${r}-й** по счёту исход «${plot.success}» случится **ровно на ${t}-м** испытании.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(comb(t - 1, r - 1) * p ** r * (1 - p) ** (t - r)),
		input: { cls: 'negative-binomial', p, r, t },
		wrong: { 'no-last-success': f(pmf(t, r, p)) }
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	'exactly-k': exactlyK,
	'at-least-one': atLeastOne,
	'at-least-k': atLeastK,
	'first-success': firstSuccess,
	hypergeometric,
	'majority-vote': majorityVote,
	'binomial-range': binomialRange,
	'negative-binomial': negativeBinomial
};

/** The reference counts the sequences of trials by their successes where that is small, and uses math.comb otherwise. */
const PYTHON_REFERENCE = `import json
import math
from collections import Counter
from itertools import product

p = json.loads(input())
cls = p["cls"]

def binom_range(n, prob, lo, hi):
    if n <= 16:
        # count the sequences of n trials by their number of successes
        ways = Counter(sum(seq) for seq in product((0, 1), repeat=n))
    else:
        ways = {k: math.comb(n, k) for k in range(n + 1)}
    return sum(ways[k] * prob ** k * (1 - prob) ** (n - k) for k in range(lo, hi + 1))

if cls in ("exactly-k", "at-least-one", "at-least-k", "majority-vote", "binomial-range"):
    print(repr(binom_range(p["n"], p["p"], p["lo"], p["hi"])))
elif cls == "first-success":
    q = p["p"]
    print(repr((1 - q) ** (p["k"] - 1) * q))
elif cls == "hypergeometric":
    t, b, d, j = p["total"], p["bad"], p["draw"], p["j"]
    print(repr(math.comb(b, j) * math.comb(t - b, d - j) / math.comb(t, d)))
elif cls == "negative-binomial":
    q, r, t = p["p"], p["r"], p["t"]
    # the first t - 1 trials hold r - 1 successes, the t-th is a success
    print(repr(math.comb(t - 1, r - 1) * q ** (r - 1) * (1 - q) ** (t - r) * q))
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
