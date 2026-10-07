// Averaging of multiclass metrics over a confusion matrix: macro-precision, macro-recall, macro-F1 and micro-F1
// (Intern); weighted-F1, a class the model never predicts, a transposed matrix and abstentions (Junior).
import { farApart, floatAnswer, frameMarkdown, roundingRule, stdinJson } from '../../_lib/ds.ts';
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
	labels: string[];
	/** m[true][predicted]; with abstentions the last column counts the objects without an answer. */
	m: number[][];
	abstain: number[] | null;
	plot: string;
}

const PLOTS: readonly { plot: string; labels: readonly string[] }[] = [
	{ plot: 'обращения в поддержку', labels: ['оплата', 'доставка', 'возврат', 'аккаунт', 'прочее'] },
	{ plot: 'снимки товаров', labels: ['обувь', 'сумки', 'одежда', 'часы', 'очки'] },
	{ plot: 'новостные тексты', labels: ['спорт', 'политика', 'наука', 'культура', 'экономика'] },
	{ plot: 'банковские транзакции', labels: ['продукты', 'транспорт', 'кафе', 'связь', 'аптеки'] }
];

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
const mean = (xs: readonly number[]): number => sum(xs) / xs.length;
const col = (m: readonly number[][], j: number): number => sum(m.map((r) => r[j] ?? 0));
const row = (m: readonly number[][], i: number): number => sum(m[i] ?? []);
const diag = (m: readonly number[][], i: number): number => m[i]?.[i] ?? 0;
const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);
const f1 = (p: number, r: number): number => (p + r === 0 ? 0 : (2 * p * r) / (p + r));

/** Per-class precision, recall and F1 of a matrix m[true][pred]; `swapped` reads it the other way round. */
function perClass(m: readonly number[][], swapped = false): { p: number[]; r: number[]; f: number[] } {
	const n = m.length;
	const p: number[] = [];
	const r: number[] = [];
	for (let i = 0; i < n; i += 1) {
		const predicted = swapped ? row(m, i) : col(m, i);
		const actual = swapped ? col(m, i) : row(m, i);
		p.push(ratio(diag(m, i), predicted));
		r.push(ratio(diag(m, i), actual));
	}
	return { p, r, f: p.map((x, i) => f1(x, r[i] ?? 0)) };
}

const transpose = (m: readonly number[][]): number[][] => m.map((_, i) => m.map((r) => r[i] ?? 0));

function microWithAbstain(s: Scenario, ignore: boolean): number {
	const correct = sum(s.m.map((_, i) => diag(s.m, i)));
	const answered = sum(s.m.map((r) => sum(r)));
	const all = answered + sum(s.abstain ?? []);
	if (ignore) return correct / answered;
	return f1(correct / answered, correct / all);
}

function metric(classId: string, s: Scenario): number {
	const c = perClass(s.m);
	const support = s.m.map((_, i) => row(s.m, i));
	switch (classId) {
		case 'macro-precision':
			return mean(c.p);
		case 'macro-recall':
		case 'transposed-recall':
			return mean(c.r);
		case 'macro-f1':
		case 'empty-class-f1':
			return mean(c.f);
		case 'micro-f1':
			return sum(s.m.map((_, i) => diag(s.m, i))) / sum(support);
		case 'weighted-f1':
			return sum(c.f.map((f, i) => f * (support[i] ?? 0))) / sum(support);
		case 'abstain-f1':
			return microWithAbstain(s, false);
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function wrongAnswers(classId: string, s: Scenario): Record<string, number | null> {
	const c = perClass(s.m);
	const accuracy = sum(s.m.map((_, i) => diag(s.m, i))) / sum(s.m.map((r) => sum(r)));
	const swapped = perClass(s.m, true);
	const macroF1 = mean(c.f);
	return {
		'micro-instead-of-macro': ['macro-precision', 'macro-recall', 'macro-f1', 'empty-class-f1'].includes(classId)
			? accuracy
			: null,
		'f1-of-macros': classId === 'macro-f1' || classId === 'empty-class-f1' ? f1(mean(c.p), mean(c.r)) : null,
		'rows-cols-swapped':
			classId === 'macro-precision'
				? mean(swapped.p)
				: classId === 'macro-recall' || classId === 'transposed-recall'
					? mean(swapped.r)
					: null,
		'macro-instead-of-micro': classId === 'micro-f1' ? macroF1 : null,
		unweighted: classId === 'weighted-f1' ? macroF1 : null,
		'empty-class-dropped': classId === 'empty-class-f1' ? mean(c.f.filter((_, i) => col(s.m, i) > 0)) : null,
		'abstain-ignored': classId === 'abstain-f1' ? microWithAbstain(s, true) : null
	};
}

function scenario(rng: Rng, grade: string, classId: string): Scenario {
	const k = grade === 'junior' ? 4 : 3;
	const theme = rng.pick(PLOTS);
	const labels = rng.sample(theme.labels, k);
	const sizes = labels.map(() => rng.int(1, 6));
	const m = labels.map((_, i) =>
		labels.map((__, j) => (i === j ? rng.int(15, 80) : rng.int(0, 12 + 3 * (sizes[i] ?? 1))))
	);
	if (classId === 'weighted-f1') {
		// Very different class sizes: weighting matters.
		const big = rng.int(0, k - 1);
		m[big] = (m[big] ?? []).map((x) => x * rng.int(3, 5));
	}
	if (classId === 'empty-class-f1') {
		const never = rng.int(0, k - 1);
		for (const r of m) r[never] = 0;
		// Its objects are spread over the other classes.
		const own = m[never] ?? [];
		for (let j = 0; j < k; j += 1) if (j !== never) own[j] = (own[j] ?? 0) + rng.int(4, 15);
	}
	const abstain = classId === 'abstain-f1' ? labels.map(() => rng.int(3, 25)) : null;
	return { labels, m, abstain, plot: theme.plot };
}

const QUESTION: Record<string, string> = {
	'macro-precision': 'Найдите macro-precision: precision каждого класса, затем простое среднее по классам.',
	'macro-recall': 'Найдите macro-recall: recall каждого класса, затем простое среднее по классам.',
	'macro-f1': 'Найдите macro-F1: F1 каждого класса, затем простое среднее по классам.',
	'micro-f1': 'Найдите micro-F1 (TP, FP и FN суммируются по всем классам, затем считается F1).',
	'weighted-f1':
		'Найдите weighted-F1: F1 каждого класса, усреднённые с весами, равными числу объектов этого класса в выборке.',
	'empty-class-f1':
		'Найдите macro-F1: F1 каждого класса, затем простое среднее по всем классам. Если у класса нет ни одного предсказания, его precision и F1 считаются равными 0.',
	'transposed-recall': 'Найдите macro-recall: recall каждого класса, затем простое среднее по классам.',
	'abstain-f1':
		'Если модель не уверена, она отказывается от ответа (столбец «отказ»). Найдите micro-F1, где precision — доля верных среди объектов, на которые модель ответила, а recall — доля верных среди всех объектов.'
};

function describe(s: Scenario, classId: string): string {
	const transposed = classId === 'transposed-recall';
	const shown = transposed ? transpose(s.m) : s.m;
	const header = transposed
		? 'Матрица ошибок на проверочной выборке: **строка — предсказанный класс, столбец — истинный класс**.'
		: 'Матрица ошибок на проверочной выборке: строка — истинный класс, столбец — предсказанный класс.';
	const columns = [
		transposed ? 'предсказан \\ истинный' : 'истинный \\ предсказан',
		...s.labels,
		...(s.abstain ? ['отказ'] : [])
	];
	const rows = shown.map((r, i) => [s.labels[i] ?? '', ...r, ...(s.abstain ? [s.abstain[i] ?? 0] : [])]);
	return [
		`Модель относит ${s.plot} к одному из ${s.labels.length} классов. ${header}`,
		'',
		frameMarkdown(columns, rows),
		'',
		QUESTION[classId] ?? '',
		'',
		roundingRule(DIGITS)
	].join('\n');
}

const PYTHON_REFERENCE = `import json

d = json.loads(input())
m, kind, abst = d["m"], d["metric"], d["abstain"]
n = len(m)
tp = [m[i][i] for i in range(n)]
pred = [sum(m[r][i] for r in range(n)) for i in range(n)]
true = [sum(m[i]) for i in range(n)]
prec = [tp[i] / pred[i] if pred[i] else 0.0 for i in range(n)]
rec = [tp[i] / true[i] if true[i] else 0.0 for i in range(n)]
f = [2 * p * r / (p + r) if p + r else 0.0 for p, r in zip(prec, rec)]
if kind == "macro-precision":
    v = sum(prec) / n
elif kind in ("macro-recall", "transposed-recall"):
    v = sum(rec) / n
elif kind in ("macro-f1", "empty-class-f1"):
    v = sum(f) / n
elif kind == "micro-f1":
    v = sum(tp) / sum(true)
elif kind == "weighted-f1":
    v = sum(fi * t for fi, t in zip(f, true)) / sum(true)
else:
    p = sum(tp) / sum(true)
    r = sum(tp) / (sum(true) + sum(abst))
    v = 2 * p * r / (p + r)
print(repr(v))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 500; tries += 1) {
		const s = scenario(rng, input.grade, input.classId);
		const answer = metric(input.classId, s);
		const wrong = wrongAnswers(input.classId, s);
		if (Object.values(wrong).some((w) => w !== null && !farApart(answer, w, DIGITS))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(s, input.classId), code: null },
			answer: floatAnswer(answer, DIGITS)
		});
		const data = { m: s.m, metric: input.classId, abstain: s.abstain };
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
