// Probabilistic metrics over predicted probabilities grouped by value: log-loss, Brier, clipping and ECE (Middle);
// Platt calibration, the correction of a model trained with thinned negatives, the Brier skill score and MCE (Senior).
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
const DIGITS = 4;

interface Row {
	p: number;
	pos: number;
	neg: number;
}
interface Scenario {
	rows: Row[];
	eps: number;
	/** Upper edges of the bins, the last is 1. */
	edges: number[];
	a: number;
	b: number;
	/** The share of negatives kept in the training data. */
	keep: number;
	plot: { what: string; positive: string };
}

const PLOTS = [
	{ what: 'клик по рекламе', positive: 'кликнул' },
	{ what: 'отток клиента', positive: 'ушёл' },
	{ what: 'дефолт по кредиту', positive: 'дефолт' },
	{ what: 'покупку после рассылки', positive: 'купил' }
] as const;

type Ln = (x: number) => number;

function logloss(rows: readonly Row[], ln: Ln = Math.log, f: (p: number) => number = (p) => p): number {
	let total = 0;
	let n = 0;
	for (const r of rows) {
		const p = f(r.p);
		total += -r.pos * ln(p) - r.neg * ln(1 - p);
		n += r.pos + r.neg;
	}
	return total / n;
}

function brier(rows: readonly Row[], power = 2, f: (p: number) => number = (p) => p): number {
	let total = 0;
	let n = 0;
	for (const r of rows) {
		const p = f(r.p);
		total += r.pos * (1 - p) ** power + r.neg * p ** power;
		n += r.pos + r.neg;
	}
	return total / n;
}

/** Calibration gaps of the non-empty bins with their sizes; a bin holds p in (previous edge, edge], the first [0, edge]. */
function bins(s: Scenario): { gap: number; size: number }[] {
	return s.edges
		.map((edge, i) => {
			const low = i === 0 ? -1 : (s.edges[i - 1] ?? 0);
			const inside = s.rows.filter((r) => r.p > low && r.p <= edge);
			const size = inside.reduce((t, r) => t + r.pos + r.neg, 0);
			if (size === 0) return null;
			const meanP = inside.reduce((t, r) => t + r.p * (r.pos + r.neg), 0) / size;
			const share = inside.reduce((t, r) => t + r.pos, 0) / size;
			return { gap: Math.abs(meanP - share), size };
		})
		.filter((x): x is { gap: number; size: number } => x !== null);
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const logit = (p: number): number => Math.log(p / (1 - p));
const clip = (s: Scenario) => (p: number) => Math.min(1 - s.eps, Math.max(s.eps, p));
const baseRate = (rows: readonly Row[]): number =>
	rows.reduce((t, r) => t + r.pos, 0) / rows.reduce((t, r) => t + r.pos + r.neg, 0);

function metric(classId: string, s: Scenario): number {
	switch (classId) {
		case 'logloss':
			return logloss(s.rows);
		case 'brier':
			return brier(s.rows);
		case 'clipped':
			return logloss(s.rows, Math.log, clip(s));
		case 'ece': {
			const b = bins(s);
			const n = b.reduce((t, x) => t + x.size, 0);
			return b.reduce((t, x) => t + (x.size / n) * x.gap, 0);
		}
		case 'platt':
			return logloss(s.rows, Math.log, (p) => sigmoid(s.a * logit(p) + s.b));
		case 'prior-correction':
			return logloss(s.rows, Math.log, (p) => (s.keep * p) / (s.keep * p + 1 - p));
		case 'brier-skill': {
			const y = baseRate(s.rows);
			return 1 - brier(s.rows) / brier(s.rows, 2, () => y);
		}
		case 'mce':
			return Math.max(...bins(s).map((x) => x.gap));
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function wrongAnswers(classId: string, s: Scenario): Record<string, number | null> {
	const ln10: Ln = (x) => Math.log10(x);
	const b = bins(s);
	const n = b.reduce((t, x) => t + x.size, 0);
	return {
		log10:
			classId === 'logloss' ? logloss(s.rows, ln10) : classId === 'clipped' ? logloss(s.rows, ln10, clip(s)) : null,
		'positives-only':
			classId === 'logloss'
				? s.rows.reduce((t, r) => t - r.pos * Math.log(r.p), 0) / s.rows.reduce((t, r) => t + r.pos, 0)
				: null,
		'brier-abs': classId === 'brier' ? brier(s.rows, 1) : null,
		'drop-extreme': classId === 'clipped' ? logloss(s.rows.filter((r) => r.p > 0 && r.p < 1)) : null,
		'unweighted-ece': classId === 'ece' ? b.reduce((t, x) => t + x.gap, 0) / b.length : null,
		uncalibrated: classId === 'platt' || classId === 'prior-correction' ? logloss(s.rows) : null,
		'platt-on-probability': classId === 'platt' ? logloss(s.rows, Math.log, (p) => sigmoid(s.a * p + s.b)) : null,
		'inverted-correction':
			classId === 'prior-correction' ? logloss(s.rows, Math.log, (p) => p / (p + s.keep * (1 - p))) : null,
		'reference-half': classId === 'brier-skill' ? 1 - brier(s.rows) / 0.25 : null,
		'ece-instead': classId === 'mce' ? b.reduce((t, x) => t + (x.size / n) * x.gap, 0) : null
	};
}

function scenario(rng: Rng, classId: string): Scenario {
	const count = rng.int(6, 9);
	const values = new Set<number>();
	while (values.size < count) values.add(rng.int(3, 97) / 100);
	// Miscalibration of the model: the true rate is the probability bent towards or away from the middle.
	const bend = rng.int(5, 15) / 10;
	const shift = rng.int(-15, 15) / 100;
	const rows: Row[] = [...values]
		.sort((x, y) => x - y)
		.map((p) => {
			const n = rng.int(8, 40);
			const rate = Math.min(0.97, Math.max(0.03, 0.5 + (p - 0.5) * bend + shift));
			const pos = Math.round(n * rate + rng.int(-2, 2));
			return { p, pos: Math.max(0, Math.min(n, pos)), neg: Math.max(0, n - Math.max(0, Math.min(n, pos))) };
		});
	if (classId === 'clipped') {
		// Confident mistakes: probability 0 for a positive and 1 for a negative.
		rows.unshift({ p: 0, pos: rng.int(1, 3), neg: rng.int(5, 20) });
		rows.push({ p: 1, pos: rng.int(5, 20), neg: rng.int(1, 3) });
	}
	if (classId === 'prior-correction') {
		// The model was trained with few negatives: its probabilities are much higher than the real rate.
		for (const r of rows) {
			const total = r.pos + r.neg;
			const real = Math.max(0.01, Math.min(0.9, (r.p * rng.int(10, 30)) / 100));
			r.pos = Math.max(0, Math.round(total * real));
			r.neg = total - r.pos;
		}
	}
	const edgeSets = [
		[0.2, 0.4, 0.6, 0.8, 1],
		[0.25, 0.5, 0.75, 1],
		[0.1, 0.3, 0.5, 0.7, 0.9, 1],
		[0.3, 0.5, 0.7, 1]
	];
	return {
		rows,
		eps: rng.pick([0.01, 0.001, 0.005]),
		edges: rng.pick(edgeSets),
		a: rng.int(5, 18) / 10,
		b: rng.int(-10, 10) / 10,
		keep: rng.pick([0.05, 0.1, 0.2, 0.25]),
		plot: rng.pick(PLOTS)
	};
}

function binsText(edges: readonly number[]): string {
	return edges.map((e, i) => (i === 0 ? `[0; ${num(e)}]` : `(${num(edges[i - 1] ?? 0)}; ${num(e)}]`)).join(', ');
}

function question(classId: string, s: Scenario): string {
	switch (classId) {
		case 'logloss':
			return 'Найдите log-loss (средняя по объектам бинарная кросс-энтропия, натуральный логарифм).';
		case 'brier':
			return 'Найдите Brier score: среднее по объектам значение (p − y)², где y = 1 для положительного объекта и 0 для отрицательного.';
		case 'clipped':
			return `Найдите log-loss (натуральный логарифм), предварительно ограничив вероятности отрезком [${num(s.eps)}; ${num(1 - s.eps)}] (клиппинг, как в библиотеках).`;
		case 'ece':
			return `Найдите ECE. Корзины по вероятности: ${binsText(s.edges)}. Для каждой непустой корзины — модуль разности средней предсказанной вероятности и доли положительных объектов в ней; ECE — среднее этих модулей с весами, равными доле объектов корзины.`;
		case 'platt':
			return `Вероятности модели калибруют методом Платта: p′ = σ(a · ln(p / (1 − p)) + b), σ(z) = 1 / (1 + e^(−z)), a = ${num(s.a)}, b = ${num(s.b)}. Найдите log-loss (натуральный логарифм) откалиброванных вероятностей p′.`;
		case 'prior-correction':
			return `Модель обучали на данных, где из отрицательных объектов оставили случайную долю ${num(s.keep)} (все положительные оставили), поэтому её вероятности завышены. Таблица — реальный поток без прореживания. Поправьте вероятности на прореживание (шансы p / (1 − p) умножаются на ${num(s.keep)}) и найдите log-loss (натуральный логарифм) поправленных вероятностей.`;
		case 'brier-skill':
			return 'Найдите Brier skill score: 1 − Brier(модель) / Brier(константа), где константа — прогноз, равный доле положительных объектов в этой выборке, для всех объектов.';
		case 'mce':
			return `Найдите MCE — наибольшую ошибку калибровки по корзинам. Корзины по вероятности: ${binsText(s.edges)}. Ошибка непустой корзины — модуль разности средней предсказанной вероятности и доли положительных объектов в ней.`;
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function describe(s: Scenario, classId: string): string {
	return [
		`Модель предсказывает вероятность события «${s.plot.positive}» (${s.plot.what}). Объекты проверочной выборки сгруппированы по предсказанной вероятности p: сколько из них на самом деле «${s.plot.positive}» (положительные) и сколько нет.`,
		'',
		frameMarkdown(
			['p', 'положительных', 'отрицательных'],
			s.rows.map((r) => [num(r.p, 2), r.pos, r.neg])
		),
		'',
		question(classId, s),
		'',
		roundingRule(DIGITS)
	].join('\n');
}

const PYTHON_REFERENCE = `import json, math

d = json.loads(input())
kind = d["metric"]
objs = []
for p, pos, neg in d["rows"]:
    objs += [(p, 1)] * pos + [(p, 0)] * neg
n = len(objs)

def ll(pairs):
    return -sum(math.log(p) if y else math.log(1 - p) for p, y in pairs) / len(pairs)

def binned(edges):
    out = []
    lo = -1.0
    for e in edges:
        inside = [(p, y) for p, y in objs if lo < p <= e]
        lo = e
        if inside:
            gap = abs(sum(p for p, _ in inside) / len(inside) - sum(y for _, y in inside) / len(inside))
            out.append((gap, len(inside)))
    return out

if kind == "logloss":
    v = ll(objs)
elif kind == "brier":
    v = sum((p - y) ** 2 for p, y in objs) / n
elif kind == "clipped":
    e = d["eps"]
    v = ll([(min(1 - e, max(e, p)), y) for p, y in objs])
elif kind == "ece":
    v = sum(g * c / n for g, c in binned(d["edges"]))
elif kind == "mce":
    v = max(g for g, _ in binned(d["edges"]))
elif kind == "platt":
    a, b = d["a"], d["b"]
    v = ll([(1 / (1 + math.exp(-(a * math.log(p / (1 - p)) + b))), y) for p, y in objs])
elif kind == "prior-correction":
    k = d["keep"]
    v = ll([(k * p / (1 - p) / (1 + k * p / (1 - p)), y) for p, y in objs])
else:
    base = sum(y for _, y in objs) / n
    model = sum((p - y) ** 2 for p, y in objs) / n
    const = sum((base - y) ** 2 for _, y in objs) / n
    v = 1 - model / const
print(repr(v))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng, input.classId);
		if (s.rows.every((r) => r.pos === 0) || s.rows.every((r) => r.neg === 0)) continue;
		if ((input.classId === 'ece' || input.classId === 'mce') && bins(s).length < 3) continue;
		const answer = metric(input.classId, s);
		const wrong = wrongAnswers(input.classId, s);
		if (Object.values(wrong).some((w) => w !== null && !farApart(answer, w, DIGITS))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s, input.classId), code: null },
			answer: floatAnswer(answer, DIGITS)
		});
		const data = {
			metric: input.classId,
			rows: s.rows.map((r) => [r.p, r.pos, r.neg]),
			eps: s.eps,
			edges: s.edges,
			a: s.a,
			b: s.b,
			keep: s.keep
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
