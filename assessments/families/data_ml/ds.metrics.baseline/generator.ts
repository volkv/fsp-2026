// A classifier against its baselines on imbalanced classes: the accuracy of the constant majority prediction, the
// expected metrics of a random classifier, lift and the gain over the constant (Intern); the F1 of a random classifier,
// Cohen's kappa, the accuracy after a change of the positive share and the relative reduction of error (Junior).
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
	{ task: 'Модель оттока клиентов', positive: 'ушёл', negative: 'остался' },
	{ task: 'Модель антифрода платежей', positive: 'мошенничество', negative: 'норма' },
	{ task: 'Модель отбора резюме', positive: 'приглашён', negative: 'отказ' },
	{ task: 'Модель предсказания поломок', positive: 'поломка', negative: 'исправно' }
] as const;

interface Scenario {
	plot: (typeof PLOTS)[number];
	tp: number;
	fp: number;
	fn: number;
	tn: number;
	/** Share of objects a random classifier labels positive. */
	q: number;
	/** Model rates and the new positive share for the prior shift. */
	tpr: number;
	fpr: number;
	newShare: number;
}

function scenario(rng: Rng): Scenario {
	const n = rng.int(40, 300) * 10;
	const positives = Math.round((n * rng.int(5, 30)) / 100) + rng.int(0, 9);
	const negatives = n - positives;
	const tp = Math.round((positives * rng.int(30, 90)) / 100);
	const fp = Math.round((negatives * rng.int(2, 15)) / 100);
	return {
		plot: rng.pick(PLOTS),
		tp,
		fp,
		fn: positives - tp,
		tn: negatives - fp,
		q: rng.int(5, 50) / 100,
		tpr: rng.int(50, 95) / 100,
		fpr: rng.int(2, 30) / 100,
		newShare: rng.int(2, 45) / 100
	};
}

interface Task {
	answer: number;
	wrong: Record<string, number>;
}

function task(classId: string, s: Scenario): Task {
	const n = s.tp + s.fp + s.fn + s.tn;
	const p = s.tp + s.fn;
	const share = p / n;
	const precision = s.tp / (s.tp + s.fp);
	const accuracy = (s.tp + s.tn) / n;
	const base = Math.max(p, n - p) / n;
	switch (classId) {
		case 'constant-accuracy':
			return { answer: base, wrong: { 'minority-constant': 1 - base, 'half-baseline': 0.5 } };
		case 'random-precision':
			return { answer: share, wrong: { 'precision-as-q': s.q } };
		case 'lift':
			return {
				answer: precision / share,
				wrong: { 'precision-not-lift': precision, 'inverted-lift': share / precision }
			};
		case 'accuracy-gain':
			return { answer: accuracy - base, wrong: { 'half-baseline': accuracy - 0.5, 'no-baseline': accuracy } };
		case 'random-f1': {
			const f1 = (2 * share * s.q) / (share + s.q);
			return {
				answer: f1,
				wrong: { 'arithmetic-mean': (share + s.q) / 2, 'constant-positive': (2 * share) / (1 + share) }
			};
		}
		case 'kappa': {
			const chance = ((s.tp + s.fp) * p + (s.fn + s.tn) * (n - p)) / (n * n);
			return {
				answer: (accuracy - chance) / (1 - chance),
				wrong: { 'accuracy-no-chance': accuracy, 'half-chance': (accuracy - 0.5) / 0.5 }
			};
		}
		case 'prior-shift-accuracy': {
			const at = (pi: number): number => pi * s.tpr + (1 - pi) * (1 - s.fpr);
			return {
				answer: at(s.newShare),
				wrong: { 'old-prior': at(share), 'balanced-instead': (s.tpr + 1 - s.fpr) / 2 }
			};
		}
		case 'error-reduction': {
			const errBase = 1 - base;
			const errModel = (s.fp + s.fn) / n;
			return {
				answer: (errBase - errModel) / errBase,
				wrong: { 'absolute-gain': errBase - errModel, 'half-baseline': (0.5 - errModel) / 0.5 }
			};
		}
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function matrix(s: Scenario): string {
	return frameMarkdown(
		['', `предсказано «${s.plot.positive}»`, `предсказано «${s.plot.negative}»`],
		[
			[`на самом деле «${s.plot.positive}»`, s.tp, s.fn],
			[`на самом деле «${s.plot.negative}»`, s.fp, s.tn]
		]
	);
}

const RANDOM_RULE = (s: Scenario): string =>
	`Случайный классификатор каждому объекту независимо от его признаков с вероятностью ${num(s.q)} ставит метку «${s.plot.positive}», иначе — «${s.plot.negative}».`;

function describe(classId: string, s: Scenario): string {
	const n = s.tp + s.fp + s.fn + s.tn;
	const p = s.tp + s.fn;
	const counts = `В проверочной выборке ${n} объектов, из них «${s.plot.positive}» — ${p}, «${s.plot.negative}» — ${n - p}.`;
	const lines: string[] = [];
	switch (classId) {
		case 'constant-accuracy':
			lines.push(
				counts,
				'',
				'Константная модель всем объектам предсказывает один и тот же класс — тот, что выбран так, чтобы её accuracy на этой выборке была наибольшей. Найдите эту accuracy.'
			);
			break;
		case 'random-precision':
			lines.push(
				counts,
				'',
				RANDOM_RULE(s),
				'',
				`Найдите ожидаемую precision класса «${s.plot.positive}» у случайного классификатора: отношение ожидаемого числа верных меток «${s.plot.positive}» к ожидаемому числу всех меток «${s.plot.positive}».`
			);
			break;
		case 'lift':
			lines.push(
				`${s.plot.task}: матрица ошибок на проверочной выборке.`,
				'',
				matrix(s),
				'',
				`Найдите lift модели: во сколько раз доля «${s.plot.positive}» среди объектов, которым модель предсказала «${s.plot.positive}», больше доли «${s.plot.positive}» во всей выборке.`
			);
			break;
		case 'accuracy-gain':
			lines.push(
				`${s.plot.task}: матрица ошибок на проверочной выборке.`,
				'',
				matrix(s),
				'',
				'Базой служит константная модель, которая всем объектам предсказывает самый частый в выборке класс. На сколько accuracy модели больше accuracy базы? Ответ — разность accuracy (доли, не проценты).'
			);
			break;
		case 'random-f1':
			lines.push(
				counts,
				'',
				RANDOM_RULE(s),
				'',
				`Найдите F1-меру класса «${s.plot.positive}» у случайного классификатора, посчитанную по ожидаемым значениям клеток матрицы ошибок.`
			);
			break;
		case 'kappa':
			lines.push(
				`${s.plot.task}: матрица ошибок на проверочной выборке.`,
				'',
				matrix(s),
				'',
				'Найдите каппу Коэна (Cohen’s kappa) согласия предсказаний модели с истинными метками: (accuracy − pₑ) / (1 − pₑ), где pₑ — вероятность случайного согласия при тех же долях классов в предсказаниях и в истинных метках.'
			);
			break;
		case 'prior-shift-accuracy':
			lines.push(
				`${s.plot.task} на проверочной выборке, где доля «${s.plot.positive}» — ${num(p / n)}, показала TPR (recall «${s.plot.positive}») ${num(s.tpr)} и FPR (доля «${s.plot.negative}», ошибочно отнесённых к «${s.plot.positive}») ${num(s.fpr)}.`,
				'',
				`В новом месяце доля «${s.plot.positive}» среди объектов стала ${num(s.newShare)}; признаки объектов каждого класса распределены как прежде, поэтому TPR и FPR модели не изменились. Какой будет accuracy модели в новом месяце?`
			);
			break;
		case 'error-reduction':
			lines.push(
				`${s.plot.task}: матрица ошибок на проверочной выборке.`,
				'',
				matrix(s),
				'',
				'Базой служит константная модель, которая всем объектам предсказывает самый частый в выборке класс. Найдите относительное снижение доли ошибок: (ошибка базы − ошибка модели) / ошибка базы, где ошибка — доля неверных предсказаний.'
			);
			break;
	}
	return [...lines, '', roundingRule(DIGITS)].join('\n');
}

const PYTHON_REFERENCE = `import json

d = json.loads(input())
tp, fp, fn, tn = d["tp"], d["fp"], d["fn"], d["tn"]
n = tp + fp + fn + tn
pos = tp + fn
neg = fp + tn
pi = pos / n
acc = (tp + tn) / n
majority = max(pos, neg) / n
c = d["class"]
if c == "constant-accuracy":
    v = majority
elif c == "random-precision":
    exp_tp = d["q"] * pos
    exp_pred = d["q"] * n
    v = exp_tp / exp_pred
elif c == "lift":
    v = (tp / (tp + fp)) / pi
elif c == "accuracy-gain":
    v = acc - majority
elif c == "random-f1":
    q = d["q"]
    etp, efp, efn = q * pos, q * neg, (1 - q) * pos
    v = 2 * etp / (2 * etp + efp + efn)
elif c == "kappa":
    pe = ((tp + fp) / n) * (pos / n) + ((fn + tn) / n) * (neg / n)
    v = (acc - pe) / (1 - pe)
elif c == "prior-shift-accuracy":
    s = d["newShare"]
    v = s * d["tpr"] + (1 - s) * (1 - d["fpr"])
else:
    err_base = 1 - majority
    v = (err_base - (fp + fn) / n) / err_base
print(repr(v))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng);
		if ([s.tp, s.fp, s.fn, s.tn].some((x) => x === 0)) continue;
		const n = s.tp + s.fp + s.fn + s.tn;
		const t = task(input.classId, s);
		if (input.classId === 'accuracy-gain' && t.answer <= 0.005) continue;
		if (input.classId === 'error-reduction' && t.answer <= 0.05) continue;
		if (input.classId === 'prior-shift-accuracy' && Math.abs(s.newShare - (s.tp + s.fn) / n) < 0.08) continue;
		if (Object.values(t.wrong).some((w) => !farApart(t.answer, w, DIGITS))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(input.classId, s), code: null },
			answer: floatAnswer(t.answer, DIGITS)
		});
		const data = {
			class: input.classId,
			tp: s.tp,
			fp: s.fp,
			fn: s.fn,
			tn: s.tn,
			q: s.q,
			tpr: s.tpr,
			fpr: s.fpr,
			newShare: s.newShare
		};
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(data) }),
			wrong: () =>
				Object.fromEntries(
					descriptor.wrongSolutions.map((w) => {
						const value = t.wrong[w.id];
						return [w.id, value === undefined ? null : { kind: 'answer' as const, answer: floatAnswer(value, DIGITS) }];
					})
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
