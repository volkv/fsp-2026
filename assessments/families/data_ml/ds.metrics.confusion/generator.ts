// Metrics of a binary classifier from its scores and a threshold: the confusion matrix is built from score values
// with the number of positive and negative objects at each, the objects on the threshold go to the positive side, and
// the class asks for its metric — precision, recall, F1, specificity (Intern), Fβ, NPV, MCC, balanced accuracy (Junior).
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

interface Scenario {
	/** Score values in descending order with the number of positive and negative objects at each. */
	rows: { score: number; pos: number; neg: number }[];
	threshold: number;
	beta: number;
	plot: { task: string; positive: string; negative: string };
}

interface Counts {
	tp: number;
	fp: number;
	fn: number;
	tn: number;
}

const PLOTS = [
	{ task: 'Модель оттока клиентов', positive: 'ушёл', negative: 'остался' },
	{ task: 'Модель фильтра спама', positive: 'спам', negative: 'не спам' },
	{ task: 'Модель антифрода платежей', positive: 'мошенничество', negative: 'норма' },
	{ task: 'Модель контроля качества на конвейере', positive: 'брак', negative: 'годное' }
] as const;

function counts(s: Scenario, strict: boolean): Counts {
	const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
	for (const r of s.rows) {
		const positive = strict ? r.score > s.threshold : r.score >= s.threshold;
		if (positive) {
			c.tp += r.pos;
			c.fp += r.neg;
		} else {
			c.fn += r.pos;
			c.tn += r.neg;
		}
	}
	return c;
}

const precision = (c: Counts): number => c.tp / (c.tp + c.fp);
const recall = (c: Counts): number => c.tp / (c.tp + c.fn);
const fbeta = (c: Counts, beta: number): number => {
	const p = precision(c);
	const r = recall(c);
	return ((1 + beta * beta) * p * r) / (beta * beta * p + r);
};
const accuracy = (c: Counts): number => (c.tp + c.tn) / (c.tp + c.fp + c.fn + c.tn);
const specificity = (c: Counts): number => c.tn / (c.tn + c.fp);
const npv = (c: Counts): number => c.tn / (c.tn + c.fn);
const mcc = (c: Counts): number =>
	(c.tp * c.tn - c.fp * c.fn) / Math.sqrt((c.tp + c.fp) * (c.tp + c.fn) * (c.tn + c.fp) * (c.tn + c.fn));

function metric(classId: string, c: Counts, beta: number): number {
	switch (classId) {
		case 'precision':
			return precision(c);
		case 'recall':
			return recall(c);
		case 'f1':
			return fbeta(c, 1);
		case 'specificity':
			return specificity(c);
		case 'f-beta':
			return fbeta(c, beta);
		case 'npv':
			return npv(c);
		case 'mcc':
			return mcc(c);
		case 'balanced-accuracy':
			return (recall(c) + specificity(c)) / 2;
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

/** The answer of each misconception on the scenario; `null` — it does not apply to the class. */
function wrongAnswers(classId: string, s: Scenario): Record<string, number | null> {
	const c = counts(s, false);
	const swap: Record<string, (x: Counts) => number> = { precision: recall, recall: precision };
	return {
		'strict-threshold': metric(classId, counts(s, true), s.beta),
		'precision-recall-swap': swap[classId]?.(c) ?? null,
		'f1-arithmetic': classId === 'f1' ? (precision(c) + recall(c)) / 2 : null,
		'accuracy-instead': accuracy(c),
		'specificity-as-npv': classId === 'specificity' ? npv(c) : null,
		'f1-instead-of-fbeta': classId === 'f-beta' ? fbeta(c, 1) : null,
		'beta-inverted': classId === 'f-beta' ? fbeta(c, 1 / s.beta) : null,
		'npv-as-ppv': classId === 'npv' ? precision(c) : null
	};
}

function scenario(rng: Rng, junior: boolean, classId: string): Scenario {
	const n = junior ? rng.int(9, 12) : rng.int(7, 9);
	const scores = new Set<number>();
	while (scores.size < n) scores.add(rng.int(3, 97) / 100);
	const sorted = [...scores].sort((a, b) => b - a);
	// Class imbalance: few positives where balanced accuracy is asked, a fair share elsewhere.
	const negScale = classId === 'balanced-accuracy' ? rng.int(4, 8) : rng.int(1, 3);
	const rows = sorted.map((score) => ({
		score,
		pos: Math.round(rng.int(0, 30) * score + rng.int(0, 4)),
		neg: Math.round((rng.int(0, 30) * (1 - score) + rng.int(0, 4)) * negScale)
	}));
	// The threshold is a score some objects of both classes have, inside the list.
	const at = rng.int(2, n - 3);
	const row = rows[at];
	if (row) {
		row.pos = Math.max(row.pos, rng.int(2, 9));
		row.neg = Math.max(row.neg, rng.int(2, 9));
	}
	return {
		rows,
		threshold: row?.score ?? 0.5,
		beta: rng.pick([0.5, 2]),
		plot: rng.pick(PLOTS)
	};
}

const QUESTION: Record<string, (s: Scenario) => string> = {
	precision: (s) => `Найдите precision класса «${s.plot.positive}».`,
	recall: (s) => `Найдите recall класса «${s.plot.positive}».`,
	f1: (s) => `Найдите F1-меру класса «${s.plot.positive}».`,
	specificity: (s) =>
		`Найдите специфичность (specificity): долю объектов класса «${s.plot.negative}», которые модель отнесла к «${s.plot.negative}».`,
	'f-beta': (s) => `Найдите F-меру с β = ${num(s.beta)} для класса «${s.plot.positive}».`,
	npv: (s) =>
		`Найдите precision класса «${s.plot.negative}»: долю объектов, действительно относящихся к «${s.plot.negative}», среди тех, кому модель предсказала «${s.plot.negative}».`,
	mcc: () => 'Найдите коэффициент корреляции Мэттьюса (MCC).',
	'balanced-accuracy': () => 'Найдите сбалансированную точность (balanced accuracy): среднее recall двух классов.'
};

function describe(s: Scenario, classId: string): string {
	const total = s.rows.reduce((sum, r) => sum + r.pos + r.neg, 0);
	return [
		`${s.plot.task} выдала скор каждому из ${total} объектов проверочной выборки. Объекты сгруппированы по значению скора: в строке — сколько среди объектов с этим скором на самом деле «${s.plot.positive}» и сколько «${s.plot.negative}».`,
		'',
		frameMarkdown(
			['скор', `«${s.plot.positive}»`, `«${s.plot.negative}»`],
			s.rows.map((r) => [r.score.toFixed(2), r.pos, r.neg])
		),
		'',
		`Модель предсказывает «${s.plot.positive}», если скор не меньше порога ${s.threshold.toFixed(2)}, иначе — «${s.plot.negative}». Положительный класс — «${s.plot.positive}».`,
		'',
		QUESTION[classId]?.(s) ?? '',
		'',
		roundingRule(DIGITS)
	].join('\n');
}

const PYTHON_REFERENCE = `import json, math

d = json.loads(input())
tp = fp = fn = tn = 0
for score, pos, neg in d["rows"]:
    if score >= d["threshold"]:
        tp += pos
        fp += neg
    else:
        fn += pos
        tn += neg
m = d["metric"]
p = tp / (tp + fp)
r = tp / (tp + fn)
spec = tn / (tn + fp)
if m == "precision":
    v = p
elif m == "recall":
    v = r
elif m == "f1":
    v = 2 * p * r / (p + r)
elif m == "specificity":
    v = spec
elif m == "f-beta":
    b2 = d["beta"] ** 2
    v = (1 + b2) * p * r / (b2 * p + r)
elif m == "npv":
    v = tn / (tn + fn)
elif m == "mcc":
    v = (tp * tn - fp * fn) / math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn))
else:
    v = (r + spec) / 2
print(repr(v))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng, junior, input.classId);
		const c = counts(s, false);
		if ([c.tp, c.fp, c.fn, c.tn].some((x) => x === 0)) continue;
		const answer = metric(input.classId, c, s.beta);
		const wrong = wrongAnswers(input.classId, s);
		if (Object.values(wrong).some((w) => w !== null && !farApart(answer, w, DIGITS))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s, input.classId), code: null },
			answer: floatAnswer(answer, DIGITS)
		});
		const data = {
			rows: s.rows.map((r) => [r.score, r.pos, r.neg]),
			threshold: s.threshold,
			metric: input.classId,
			beta: s.beta
		};
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(data) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
