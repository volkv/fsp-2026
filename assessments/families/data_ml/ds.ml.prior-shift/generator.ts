// Class imbalance and prior shift: the precision, F1 or accuracy of a classifier when the share of positives in
// production differs from validation, the probability of a model trained on undersampled negatives (Middle); the score
// threshold equivalent to a posterior threshold or to a cost-optimal one under a new prior, and the estimate of the new
// prior from the model's outputs (Senior). No formula is given: knowing it is the task.
import { farApart, floatAnswer, frameMarkdown, num, roundingRule, stdinJson } from '../../_lib/ds.ts';
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const DIGITS = 3;

const PLOTS = [
	{ what: 'мошеннических транзакций', pos: 'fraud', neg: 'ok' },
	{ what: 'уходящих клиентов', pos: 'churn', neg: 'stay' },
	{ what: 'спама', pos: 'spam', neg: 'ham' },
	{ what: 'бракованных деталей', pos: 'defect', neg: 'good' }
] as const;

const odds = (p: number): number => p / (1 - p);
const prob = (o: number): number => o / (1 + o);

interface Matrix {
	tp: number;
	fn: number;
	fp: number;
	tn: number;
}

function matrix(rng: Rng, positives: number, negatives: number): Matrix {
	const tp = Math.round(positives * (rng.int(60, 95) / 100));
	const fp = Math.round(negatives * (rng.int(2, 20) / 100));
	return { tp, fn: positives - tp, fp, tn: negatives - fp };
}

function matrixTable(m: Matrix, pos: string, neg: string): string {
	return frameMarkdown(
		['', `предсказано ${pos}`, `предсказано ${neg}`],
		[
			[`на деле ${pos}`, m.tp, m.fn],
			[`на деле ${neg}`, m.fp, m.tn]
		]
	);
}

interface Task {
	markdown: string;
	answer: number;
	wrong: Record<string, number | null>;
	probe: object;
}

const percent = (p: number): string => `${num(p * 100, 2)} %`;

function middleTask(rng: Rng, classId: string): Task {
	const plot = rng.pick(PLOTS);
	if (classId === 'undersampling') {
		const keep = rng.pick([0.05, 0.1, 0.2, 0.25, 0.5]);
		const score = rng.int(30, 95) / 100;
		const answer = (keep * score) / (keep * score + 1 - score);
		return {
			markdown: [
				`Модель поиска ${plot.what} обучали на выборке, где все примеры \`${plot.pos}\` оставлены, а из примеров \`${plot.neg}\` случайно оставлена доля ${num(keep)} (каждый пример — с вероятностью ${num(keep)}). На этой выборке модель хорошо откалибрована. Для нового объекта модель выдала вероятность \`${plot.pos}\`, равную ${num(score)}.`,
				'',
				`Какова вероятность \`${plot.pos}\` для этого объекта в исходной (не прореженной) генеральной совокупности?`,
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer,
			wrong: {
				'no-correction': score,
				'inverse-correction': score / (score + keep * (1 - score))
			},
			probe: { kind: 'undersampling', keep, score }
		};
	}
	const balanced = classId === 'precision-shift';
	const positives = balanced ? rng.pick([200, 300, 400, 500]) : rng.int(8, 30) * 10;
	const negatives = balanced ? positives : rng.int(40, 120) * 10;
	const m = matrix(rng, positives, negatives);
	const tpr = m.tp / (m.tp + m.fn);
	const fpr = m.fp / (m.fp + m.tn);
	const share = rng.pick([0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.3, 0.4]);
	const precisionAt = (pi: number, f: number): number => (tpr * pi) / (tpr * pi + f * (1 - pi));
	const f1 = (p: number, r: number): number => (2 * p * r) / (p + r);
	const testPrecision = m.tp / (m.tp + m.fp);
	const head = [
		`Классификатор ${plot.what} на валидационной выборке дал матрицу ошибок:`,
		'',
		matrixTable(m, plot.pos, plot.neg),
		'',
		`В эксплуатации доля \`${plot.pos}\` среди объектов — ${percent(share)}. Считайте, что доли верно распознанных объектов каждого класса (TPR и TNR) в эксплуатации те же, что на валидации.`,
		''
	];
	if (classId === 'precision-shift') {
		return {
			markdown: [...head, 'Какой будет precision классификатора в эксплуатации?', '', roundingRule(DIGITS)].join('\n'),
			answer: precisionAt(share, fpr),
			wrong: { 'test-metric': testPrecision, 'fpr-as-specificity': precisionAt(share, 1 - fpr) },
			probe: { kind: 'precision', ...m, share }
		};
	}
	if (classId === 'f1-shift') {
		return {
			markdown: [...head, 'Каким будет F1 классификатора в эксплуатации?', '', roundingRule(DIGITS)].join('\n'),
			answer: f1(precisionAt(share, fpr), tpr),
			wrong: { 'test-metric': f1(testPrecision, tpr), 'fpr-as-specificity': f1(precisionAt(share, 1 - fpr), tpr) },
			probe: { kind: 'f1', ...m, share }
		};
	}
	return {
		markdown: [...head, 'Какой будет accuracy классификатора в эксплуатации?', '', roundingRule(DIGITS)].join('\n'),
		answer: tpr * share + (1 - fpr) * (1 - share),
		wrong: {
			'test-metric': (m.tp + m.tn) / (positives + negatives),
			'balanced-accuracy': (tpr + 1 - fpr) / 2
		},
		probe: { kind: 'accuracy', ...m, share }
	};
}

/** The score threshold equivalent to a posterior threshold `t` when the model is calibrated for prior `from`. */
const scoreThreshold = (t: number, from: number, to: number): number => prob((odds(t) * odds(from)) / odds(to));

function seniorTask(rng: Rng, classId: string): Task {
	const plot = rng.pick(PLOTS);
	if (classId === 'bbse' || classId === 'probabilistic-count') {
		const tpr = rng.int(60, 95) / 100;
		const fpr = rng.int(3, 20) / 100;
		const truth = rng.int(5, 40) / 100;
		if (classId === 'bbse') {
			const flagged = tpr * truth + fpr * (1 - truth) + rng.int(-5, 5) / 1000;
			const n = rng.pick([2000, 5000, 10000, 20000]);
			const q = Math.round(flagged * n) / n;
			return {
				markdown: [
					`Классификатор ${plot.what} на размеченной валидации: TPR = ${num(tpr)}, FPR = ${num(fpr)}. В новой партии из ${n} объектов без разметки он отметил как \`${plot.pos}\` ${Math.round(q * n)} объектов. Распределение признаков внутри каждого класса не изменилось — поменялась только доля классов.`,
					'',
					`Оцените долю \`${plot.pos}\` в новой партии по доле отмеченных с поправкой на ошибки классификатора.`,
					'',
					roundingRule(DIGITS)
				].join('\n'),
				answer: (q - fpr) / (tpr - fpr),
				wrong: { 'classify-count': q, 'divide-by-tpr': q / tpr },
				probe: { kind: 'bbse', tpr, fpr, q }
			};
		}
		const meanPos = rng.int(60, 90) / 100;
		const meanNeg = rng.int(5, 30) / 100;
		const m = Math.round((meanPos * truth + meanNeg * (1 - truth) + rng.int(-5, 5) / 1000) * 1000) / 1000;
		return {
			markdown: [
				`Модель ${plot.what} выдаёт вероятность класса \`${plot.pos}\`. На размеченной валидации средняя выданная вероятность среди объектов \`${plot.pos}\` — ${num(meanPos)}, среди \`${plot.neg}\` — ${num(meanNeg)}. В новой партии без разметки средняя выданная вероятность — ${num(m)}. Распределение признаков внутри каждого класса не изменилось — поменялась только доля классов.`,
				'',
				`Оцените долю \`${plot.pos}\` в новой партии по средней вероятности с поправкой на средние вероятности классов.`,
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: (m - meanNeg) / (meanPos - meanNeg),
			wrong: { 'classify-count': m, 'divide-by-tpr': m / meanPos },
			probe: { kind: 'probabilistic', meanPos, meanNeg, m }
		};
	}
	const from = rng.pick([0.5, 0.3, 0.2, 0.1]);
	const to = rng.pick([0.01, 0.02, 0.05, 0.08]);
	const context = `Модель ${plot.what} хорошо откалибрована на обучающей выборке, где доля \`${plot.pos}\` — ${percent(from)}. В эксплуатации доля \`${plot.pos}\` — ${percent(to)}; распределение признаков внутри каждого класса то же.`;
	if (classId === 'threshold-shift') {
		const t = rng.int(4, 16) / 20;
		return {
			markdown: [
				context,
				'',
				`Объект нужно отправлять на проверку, когда вероятность \`${plot.pos}\` для него **в эксплуатации** не меньше ${num(t)}. Какой порог надо поставить на выход модели, чтобы правило выполнялось?`,
				'',
				roundingRule(DIGITS)
			].join('\n'),
			answer: scoreThreshold(t, from, to),
			wrong: { 'no-adjust': t, 'inverse-adjust': scoreThreshold(t, to, from) },
			probe: { kind: 'threshold', t, from, to }
		};
	}
	const costFp = rng.int(1, 10) * 10;
	const costFn = costFp * rng.int(3, 30);
	const t = costFp / (costFp + costFn);
	return {
		markdown: [
			context,
			'',
			`Проверка одного объекта, который оказался \`${plot.neg}\`, стоит ${costFp} ₽; пропущенный \`${plot.pos}\` стоит ${costFn} ₽; верные решения ничего не стоят. Объект отправляют на проверку, когда это уменьшает ожидаемые потери. Какой порог надо поставить на выход модели?`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		answer: scoreThreshold(t, from, to),
		wrong: {
			'ignore-costs': scoreThreshold(0.5, from, to),
			'no-adjust': t,
			'inverse-cost': scoreThreshold(costFn / (costFp + costFn), from, to)
		},
		probe: { kind: 'cost', costFp, costFn, from, to }
	};
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
kind = p["kind"]

def to_score(t, base, now):
    o = t / (1 - t) * (base / (1 - base)) / (now / (1 - now))
    return o / (1 + o)

if kind in ("precision", "f1", "accuracy"):
    tpr = p["tp"] / (p["tp"] + p["fn"])
    tnr = p["tn"] / (p["tn"] + p["fp"])
    pi = p["share"]
    tp, fp = tpr * pi, (1 - tnr) * (1 - pi)
    precision = tp / (tp + fp)
    if kind == "precision":
        r = precision
    elif kind == "f1":
        r = 2 * precision * tpr / (precision + tpr)
    else:
        r = tp + tnr * (1 - pi)
elif kind == "undersampling":
    o = p["score"] / (1 - p["score"]) * p["keep"]
    r = o / (1 + o)
elif kind == "threshold":
    r = to_score(p["t"], p["from"], p["to"])
elif kind == "cost":
    r = to_score(p["costFp"] / (p["costFp"] + p["costFn"]), p["from"], p["to"])
elif kind == "bbse":
    r = (p["q"] - p["fpr"]) / (p["tpr"] - p["fpr"])
else:
    r = (p["m"] - p["meanNeg"]) / (p["meanPos"] - p["meanNeg"])
print(repr(r))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 300; tries += 1) {
		const t = input.grade === 'middle' ? middleTask(rng, input.classId) : seniorTask(rng, input.classId);
		if (!(t.answer > 0 && t.answer < 1)) continue;
		if (Object.values(t.wrong).some((w) => w !== null && !farApart(t.answer, w, DIGITS))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: t.markdown, code: null },
			answer: floatAnswer(t.answer, DIGITS)
		});
		const all = Object.fromEntries(descriptor.wrongSolutions.map((w) => [w.id, t.wrong[w.id] ?? null]));
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(t.probe) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(all).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
