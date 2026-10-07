// Bayes' rule: the probability of an event given evidence — a test result, two tests, words of a message, the source
// of a defect, an alarm of any of several detectors — where the base rate and the kind of evidence decide the answer.
import { readDescriptor, type Built, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildComputed, type ComputedScenario } from '../../_lib/ds-compute.ts';
import { floatAnswer, num, roundingRule } from '../../_lib/ds.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 4;
const f = (value: number) => floatAnswer(value, DIGITS);
const pct = (p: number): string => `${num(p * 100, 2)} %`;

/** The posterior of the event from the prior and the likelihoods of the evidence under the event and without it. */
const posterior = (prior: number, ifEvent: number, ifNot: number): number =>
	(prior * ifEvent) / (prior * ifEvent + (1 - prior) * ifNot);

const PLOTS = [
	{
		event: 'мошеннические транзакции',
		claim: 'транзакция мошенническая',
		test: 'Антифрод-модель',
		positive: 'модель пометила транзакцию',
		negative: 'модель не пометила транзакцию'
	},
	{
		event: 'обследуемые с заболеванием',
		claim: 'у обследуемого есть заболевание',
		test: 'Экспресс-тест',
		positive: 'тест положителен',
		negative: 'тест отрицателен'
	},
	{
		event: 'детали с дефектом',
		claim: 'деталь с дефектом',
		test: 'Автоматический контроль',
		positive: 'контроль отбраковал деталь',
		negative: 'контроль пропустил деталь'
	},
	{
		event: 'клиенты, которые уйдут в следующем месяце',
		claim: 'клиент уйдёт',
		test: 'Модель оттока',
		positive: 'модель предсказала уход',
		negative: 'модель не предсказала уход'
	}
] as const;

/** A probability in [lo, hi] with a step of 0.001 (or 0.0005 for small ones). */
const prob = (rng: Rng, lo: number, hi: number, step = 0.001): number =>
	Math.round((lo + rng.int(0, Math.round((hi - lo) / step)) * step) * 1e6) / 1e6;

function positivePosterior(rng: Rng, negative: boolean): ComputedScenario {
	const plot = rng.pick(PLOTS);
	const prior = prob(rng, 0.005, 0.2, 0.0005);
	const sens = prob(rng, 0.8, 0.99);
	const spec = prob(rng, 0.85, 0.995);
	const ifEvent = negative ? 1 - sens : sens;
	const ifNot = negative ? spec : 1 - spec;
	return {
		markdown: [
			`Доля событий (${plot.event}) — ${pct(prior)}. ${plot.test}: при событии результат положителен с вероятностью ${num(sens)} (чувствительность), без события отрицателен с вероятностью ${num(spec)} (специфичность).`,
			'',
			`Известно: ${negative ? plot.negative : plot.positive}. Найдите вероятность, что ${plot.claim}.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(posterior(prior, ifEvent, ifNot)),
		input: { cls: negative ? 'negative-posterior' : 'posterior', prior, results: [[sens, spec, !negative]] },
		wrong: { 'inverse-conditional': f(ifEvent), 'ignore-base-rate': f(posterior(0.5, ifEvent, ifNot)) }
	};
}

function sourcePosterior(rng: Rng): ComputedScenario {
	const names = rng.sample(['«Альфа»', '«Бета»', '«Вега»', '«Гамма»', '«Дельта»', '«Сигма»'], 3);
	const cut1 = rng.int(10, 60);
	const cut2 = rng.int(cut1 + 10, 90);
	const shares = [cut1, cut2 - cut1, 100 - cut2].map((s) => s / 100);
	const rates = names.map(() => rng.int(5, 80) / 1000);
	const k = rng.int(0, 2);
	const total = shares.reduce((s, w, i) => s + w * (rates[i] ?? 0), 0);
	const answer = ((shares[k] ?? 0) * (rates[k] ?? 0)) / total;
	return {
		markdown: [
			'Склад получает детали от трёх поставщиков:',
			'',
			'| поставщик | доля поставок | доля брака у поставщика |',
			'| --- | --- | --- |',
			...names.map((n, i) => `| ${n} | ${pct(shares[i] ?? 0)} | ${pct(rates[i] ?? 0)} |`),
			'',
			`Случайно выбранная деталь оказалась бракованной. Найдите вероятность, что её поставил ${names[k]}.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(answer),
		input: { cls: 'source-posterior', shares, rates, k },
		wrong: {
			'ignore-base-rate': f((rates[k] ?? 0) / rates.reduce((s, r) => s + r, 0)),
			'inverse-conditional': f(rates[k] ?? 0)
		}
	};
}

/** Two independent tests with their sensitivity and specificity; `second` — whether the second one is positive. */
function twoTests(rng: Rng, second: boolean, cls: string): ComputedScenario {
	const plot = rng.pick(PLOTS);
	const prior = prob(rng, 0.005, 0.15, 0.0005);
	const t1 = [prob(rng, 0.8, 0.98), prob(rng, 0.8, 0.97)] as const;
	const t2 = [prob(rng, 0.7, 0.99), prob(rng, 0.85, 0.995)] as const;
	const like2Event = second ? t2[0] : 1 - t2[0];
	const like2Not = second ? 1 - t2[1] : t2[1];
	const answer = posterior(prior, t1[0] * like2Event, (1 - t1[1]) * like2Not);
	return {
		markdown: [
			`Доля событий (${plot.event}) — ${pct(prior)}. Есть две независимые проверки (их ошибки независимы при известном исходе):`,
			'',
			'| проверка | чувствительность | специфичность |',
			'| --- | --- | --- |',
			`| первый | ${num(t1[0])} | ${num(t1[1])} |`,
			`| второй | ${num(t2[0])} | ${num(t2[1])} |`,
			'',
			`Первая проверка дала положительный результат, вторая — ${second ? 'тоже положительный' : 'отрицательный'}. Найдите вероятность, что ${plot.claim}.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(answer),
		input: {
			cls,
			prior,
			results: [
				[t1[0], t1[1], true],
				[t2[0], t2[1], second]
			]
		},
		wrong: {
			'one-test-only': f(posterior(prior, t1[0], 1 - t1[1])),
			'ignore-base-rate': f(posterior(0.5, t1[0] * like2Event, (1 - t1[1]) * like2Not))
		}
	};
}

function naiveBayes(rng: Rng): ComputedScenario {
	const prior = prob(rng, 0.1, 0.4, 0.01);
	const [w1, w2] = rng.sample(['«выигрыш»', '«бесплатно»', '«счёт»', '«встреча»', '«скидка»', '«отчёт»'], 2);
	const a1 = prob(rng, 0.3, 0.8, 0.01);
	const b1 = prob(rng, 0.01, 0.15, 0.005);
	const a2 = prob(rng, 0.02, 0.2, 0.01);
	const b2 = prob(rng, 0.2, 0.7, 0.01);
	return {
		markdown: [
			`Фильтр спама — наивный байесовский классификатор: слова в письме считаются независимыми при известном классе. Доля спама — ${pct(prior)}.`,
			'',
			'| слово | P(слово есть в письме при условии «спам») | P(слово есть в письме при условии «не спам») |',
			'| --- | --- | --- |',
			`| ${w1} | ${num(a1)} | ${num(b1)} |`,
			`| ${w2} | ${num(a2)} | ${num(b2)} |`,
			'',
			`В письме есть слово ${w1} и нет слова ${w2}. Найдите вероятность, что письмо — спам (по модели классификатора, учитывая оба слова).`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(posterior(prior, a1 * (1 - a2), b1 * (1 - b2))),
		input: {
			cls: 'naive-bayes',
			prior,
			words: [
				[a1, b1, true],
				[a2, b2, false]
			]
		},
		wrong: {
			'ignore-absent': f(posterior(prior, a1, b1)),
			'ignore-base-rate': f(posterior(0.5, a1 * (1 - a2), b1 * (1 - b2)))
		}
	};
}

function prevalenceShift(rng: Rng): ComputedScenario {
	const plot = rng.pick(PLOTS);
	const n = rng.pick([500, 1000, 2000]);
	const tp = rng.int(Math.round(n * 0.7), Math.round(n * 0.97));
	const tn = rng.int(Math.round(n * 0.8), Math.round(n * 0.99));
	const prior = prob(rng, 0.002, 0.08, 0.0005);
	const sens = tp / n;
	const spec = tn / n;
	return {
		markdown: [
			`Событие — ${plot.claim}. Модель проверили на сбалансированной выборке: ${n} случаев с событием и ${n} без него.`,
			'',
			'| | модель: «да» | модель: «нет» |',
			'| --- | --- | --- |',
			`| событие есть | ${tp} | ${n - tp} |`,
			`| события нет | ${n - tn} | ${tn} |`,
			'',
			`В эксплуатации доля случаев с событием — ${pct(prior)}, а поведение модели на каждом из классов то же, что на проверке. Найдите **precision** модели в эксплуатации: вероятность события, когда модель говорит «да».`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(posterior(prior, sens, 1 - spec)),
		input: { cls: 'prevalence-shift', n, tp, tn, prior },
		wrong: { 'sample-precision': f(tp / (tp + n - tn)), 'ignore-base-rate': f(posterior(0.5, sens, 1 - spec)) }
	};
}

function anyAlarm(rng: Rng): ComputedScenario {
	const k = rng.int(2, 4);
	const prior = prob(rng, 0.001, 0.05, 0.0005);
	const sens = prob(rng, 0.5, 0.9, 0.01);
	const spec = prob(rng, 0.95, 0.999);
	const ifEvent = 1 - (1 - sens) ** k;
	const ifNot = 1 - spec ** k;
	return {
		markdown: [
			`Сеть защищают ${k} независимых детектора вторжений (их срабатывания независимы при известном состоянии сети). Каждый при атаке срабатывает с вероятностью ${num(sens)}, без атаки молчит с вероятностью ${num(spec)}. Тревога поднимается, если сработал **хотя бы один** детектор.`,
			'',
			`Доля интервалов времени с атакой — ${pct(prior)}. Поднялась тревога. Найдите вероятность, что идёт атака.`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: null,
		answer: f(posterior(prior, ifEvent, ifNot)),
		input: { cls: 'any-alarm', k, prior, sens, spec },
		wrong: {
			'single-detector': f(posterior(prior, sens, 1 - spec)),
			'ignore-base-rate': f(posterior(0.5, ifEvent, ifNot))
		}
	};
}

const DRAW: Record<string, (rng: Rng) => ComputedScenario | null> = {
	posterior: (rng) => positivePosterior(rng, false),
	'negative-posterior': (rng) => positivePosterior(rng, true),
	'source-posterior': sourcePosterior,
	'two-tests': (rng) => twoTests(rng, true, 'two-tests'),
	'positive-then-negative': (rng) => twoTests(rng, false, 'positive-then-negative'),
	'naive-bayes': naiveBayes,
	'prevalence-shift': prevalenceShift,
	'any-alarm': anyAlarm
};

/** The reference enumerates the joint distribution of the hidden state and the evidence. */
const PYTHON_REFERENCE = `import json

p = json.loads(input())
cls = p["cls"]

def joint(prior, likelihoods):
    event = prior
    other = 1 - prior
    for if_event, if_not in likelihoods:
        event *= if_event
        other *= if_not
    return event / (event + other)

if cls in ("posterior", "negative-posterior", "two-tests", "positive-then-negative"):
    pairs = []
    for sens, spec, positive in p["results"]:
        pairs.append((sens, 1 - spec) if positive else (1 - sens, spec))
    print(repr(joint(p["prior"], pairs)))
elif cls == "source-posterior":
    parts = [s * r for s, r in zip(p["shares"], p["rates"])]
    print(repr(parts[p["k"]] / sum(parts)))
elif cls == "naive-bayes":
    pairs = [(a, b) if present else (1 - a, 1 - b) for a, b, present in p["words"]]
    print(repr(joint(p["prior"], pairs)))
elif cls == "prevalence-shift":
    n = p["n"]
    print(repr(joint(p["prior"], [(p["tp"] / n, (n - p["tn"]) / n)])))
elif cls == "any-alarm":
    k = p["k"]
    quiet_event = (1 - p["sens"]) ** k
    quiet_other = p["spec"] ** k
    print(repr(joint(p["prior"], [(1 - quiet_event, 1 - quiet_other)])))
`;

export function build(input: GenerateInput): Built {
	const draw = DRAW[input.classId];
	if (!draw) throw new Error(`${descriptor.key}: no class ${input.classId}`);
	return buildComputed(descriptor, input, PYTHON_REFERENCE, draw);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
