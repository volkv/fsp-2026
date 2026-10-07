// Practice: a classification report from pairs «true label — predicted label», by the metric the class sets (the
// metrics of a positive class, macro- or weighted-averaged F1, the confusion counts, balanced accuracy, the Matthews
// coefficient), with the convention 0/0 = 0 and an explicit set of labels to average over. Hidden tests in five groups:
// ordinary data, labels on one side only, two labels, a rare positive class, a large volume.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type HiddenTestGroup,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const EPS = 1e-5;
const LABELS = ['cat', 'dog', 'fox', 'owl', 'bee', 'elk', 'ant', 'yak', 'emu', 'koi'] as const;

type Variant = 'right' | 'undefined-as-one' | 'swap-axes' | 'label-set' | 'average-mismatch';
const WRONG_IDS = ['undefined-as-one', 'swap-axes', 'label-set', 'average-mismatch'] as const;

interface Input {
	pos: string;
	beta: number | null;
	pairs: [string, string][];
}

interface Counts {
	tp: number;
	fp: number;
	fn: number;
}

function counts(input: Input, label: string, variant: Variant): Counts {
	let tp = 0;
	let fp = 0;
	let fn = 0;
	for (const [t, p] of input.pairs) {
		if (p === label) {
			if (t === label) tp += 1;
			else fp += 1;
		} else if (t === label) fn += 1;
	}
	return variant === 'swap-axes' ? { tp, fp: fn, fn: fp } : { tp, fp, fn };
}

const ratio = (a: number, b: number, variant: Variant): number =>
	b > 0 ? a / b : variant === 'undefined-as-one' ? 1 : 0;

function prf(c: Counts, variant: Variant): [number, number, number] {
	const p = ratio(c.tp, c.tp + c.fp, variant);
	const r = ratio(c.tp, c.tp + c.fn, variant);
	return [p, r, ratio(2 * p * r, p + r, variant)];
}

const f6 = (x: number): string => x.toFixed(6);

function labelsOf(input: Input, union: boolean): string[] {
	const set = new Set(input.pairs.map(([t]) => t));
	if (union) for (const [, p] of input.pairs) set.add(p);
	return [...set].sort();
}

/** The expected output of the class; a variant other than `right` reproduces a wrong solution. */
function solve(classId: string, input: Input, variant: Variant = 'right'): string {
	const n = input.pairs.length;
	const support = (label: string): number => input.pairs.filter(([t]) => t === label).length;
	switch (classId) {
		case 'positive-prf':
			return prf(counts(input, input.pos, variant), variant)
				.map(f6)
				.join(' ');
		case 'pos-counts': {
			const c = counts(input, input.pos, variant);
			return [c.tp, c.fp, c.fn, n - c.tp - c.fp - c.fn].join(' ');
		}
		case 'macro-f1':
		case 'weighted-f1': {
			const weighted = (classId === 'weighted-f1') !== (variant === 'average-mismatch');
			const labels = labelsOf(input, variant !== 'label-set');
			const f1 = labels.map((label) => prf(counts(input, label, variant), variant)[2]);
			return f6(
				weighted
					? f1.reduce((s, f, i) => s + f * support(labels[i] ?? ''), 0) / n
					: f1.reduce((s, f) => s + f, 0) / labels.length
			);
		}
		case 'balanced-accuracy': {
			const labels = labelsOf(input, variant === 'label-set');
			const recall = labels.map((label) => prf(counts(input, label, variant), variant)[1]);
			return f6(recall.reduce((s, r) => s + r, 0) / labels.length);
		}
		case 'fbeta': {
			const [p, r] = prf(counts(input, input.pos, variant), variant);
			const b2 = (input.beta ?? 1) ** 2;
			return f6(ratio((1 + b2) * p * r, b2 * p + r, variant));
		}
		case 'per-class':
			return labelsOf(input, variant !== 'label-set')
				.map((label) => [label, ...prf(counts(input, label, variant), variant).map(f6), support(label)].join(' '))
				.join('\n');
		case 'mcc': {
			const c = counts(input, input.pos, variant);
			const tn = n - c.tp - c.fp - c.fn;
			const den = (c.tp + c.fp) * (c.tp + c.fn) * (tn + c.fp) * (tn + c.fn);
			return f6(ratio(c.tp * tn - c.fp * c.fn, Math.sqrt(den), variant));
		}
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

/** Which wrong solutions change the answer of a class by their nature. */
const APPLIES: Record<string, Record<string, readonly Variant[]>> = {
	intern: {
		'positive-prf': ['undefined-as-one', 'swap-axes'],
		'macro-f1': ['label-set', 'average-mismatch'],
		'pos-counts': ['swap-axes'],
		'balanced-accuracy': ['swap-axes', 'label-set']
	},
	junior: {
		fbeta: ['swap-axes'],
		'weighted-f1': ['average-mismatch'],
		'per-class': ['undefined-as-one', 'swap-axes', 'label-set'],
		mcc: ['undefined-as-one']
	}
};

type GroupId = 'basic' | 'one-sided' | 'binary' | 'rare' | 'scale';
const GROUP_IDS: readonly GroupId[] = ['basic', 'one-sided', 'binary', 'rare', 'scale'];

/** The wrong solutions each group must expose on every one of its tests, where they apply to the class. */
const EXPOSES: Record<GroupId, readonly Variant[]> = {
	basic: ['swap-axes', 'average-mismatch'],
	'one-sided': ['undefined-as-one', 'label-set'],
	binary: [],
	rare: [],
	scale: []
};

function makeInput(rng: Rng, group: GroupId, classId: string, junior: boolean): Input {
	const labelCount = group === 'binary' ? 2 : rng.int(3, group === 'scale' ? 6 : 5);
	const labels = rng.sample(LABELS, labelCount + 1);
	const ghost = labels.pop() ?? 'gnu';
	const pos = rng.pick(labels);
	const others = labels.filter((l) => l !== pos);
	const n = group === 'scale' ? rng.int(3000, 5000) : rng.int(12, 30);
	const pairs: [string, string][] = [];
	for (let i = 0; i < n; i += 1) {
		const t = group === 'rare' ? (rng.bool(0.08) ? pos : rng.pick(others)) : rng.pick(labels);
		const p = rng.bool(group === 'scale' ? 0.7 : 0.55) ? t : rng.pick(labels);
		pairs.push([t, p]);
	}
	if (group === 'rare' && !pairs.some(([t]) => t === pos)) pairs[rng.int(0, n - 1)] = [pos, pos];
	if (group === 'one-sided') {
		// A label only among the predictions, and a label (the positive one where it matters) never predicted, or —
		// for the Matthews coefficient — no negative among the true labels.
		for (let k = rng.int(1, 3); k > 0; k -= 1) {
			const i = rng.int(0, n - 1);
			pairs[i] = [pairs[i]?.[0] ?? pos, ghost];
		}
		if (classId === 'mcc') {
			for (const pair of pairs) pair[0] = pos;
		} else {
			const silent = classId === 'positive-prf' || !junior ? pos : rng.pick(labels);
			const rest = labels.filter((l) => l !== silent);
			for (const pair of pairs) if (pair[1] === silent) pair[1] = rng.pick(rest);
		}
	}
	return { pos, beta: junior ? rng.pick([0.5, 2, 3]) : null, pairs };
}

function render(input: Input): string {
	const head = [input.pairs.length, input.pos, ...(input.beta === null ? [] : [input.beta])].join(' ');
	return `${[head, ...input.pairs.map(([t, p]) => `${t} ${p}`)].join('\n')}\n`;
}

/** Two outputs a float checker cannot tell apart. */
function sameOutput(a: string, b: string): boolean {
	const x = a.trim().split(/\s+/);
	const y = b.trim().split(/\s+/);
	return (
		x.length === y.length &&
		x.every((token, i) => {
			const other = y[i] ?? '';
			if (token === other) return true;
			const u = Number(token);
			const v = Number(other);
			return Number.isFinite(u) && Number.isFinite(v) && Math.abs(u - v) <= 1e-4;
		})
	);
}

function groups(rng: Rng, classId: string, others: readonly string[], junior: boolean): HiddenTestGroup[] {
	const applies = APPLIES[junior ? 'junior' : 'intern']?.[classId] ?? [];
	return GROUP_IDS.map((id) => {
		const count = id === 'scale' ? 1 : 4;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 2000) throw new Error(`${descriptor.key}: no ${id} test for ${classId}`);
			const input = makeInput(rng, id, classId, junior);
			const expected = solve(classId, input);
			if (others.some((other) => sameOutput(solve(other, input), expected))) continue;
			const exposes = EXPOSES[id].filter((v) => applies.includes(v));
			if (exposes.some((v) => sameOutput(solve(classId, input, v), expected))) continue;
			tests.push({ stdin: render(input), expected: `${expected}\n` });
		}
		return { id, tests };
	});
}

const TASK: Record<string, string> = {
	'positive-prf':
		'Выведите через пробел precision, recall и F1 позитивного класса в постановке «один против остальных»: позитив — строки с меткой `pos`, всё остальное — негатив. F1 = 2·P·R / (P + R).',
	'macro-f1':
		'Выведите macro-F1: F1 каждой метки в постановке «один против остальных», усреднённый без весов по всем меткам, которые встречаются **хотя бы в одном** из столбцов (истинном или предсказанном). Строку `pos` первой строки входа игнорируйте.',
	'pos-counts':
		'Выведите через пробел четыре целых числа TP FP FN TN для позитивного класса `pos` в постановке «один против остальных».',
	'balanced-accuracy':
		'Выведите balanced accuracy: среднее без весов значений recall по всем меткам, которые встречаются среди **истинных** меток (recall метки — доля её строк, где предсказание совпало с истиной). Метки, встречающиеся только среди предсказанных, в среднее не входят. Строку `pos` первой строки входа игнорируйте.',
	fbeta:
		'Выведите F-beta позитивного класса `pos` в постановке «один против остальных»: Fβ = (1 + β²)·P·R / (β²·P + R).',
	'weighted-f1':
		'Выведите weighted-F1: F1 каждой метки в постановке «один против остальных» по всем меткам, встречающимся хотя бы в одном столбце, с весом, равным числу строк с этой **истинной** меткой, делённому на N. Значения `pos` и `β` игнорируйте.',
	'per-class':
		'Выведите отчёт: по строке на каждую метку, встречающуюся хотя бы в одном столбце (истинном или предсказанном), в алфавитном порядке меток: `метка precision recall f1 support`, где support — число строк с этой истинной меткой (целое). Значения `pos` и `β` игнорируйте.',
	mcc: 'Выведите коэффициент Мэтьюса позитивного класса `pos` в постановке «один против остальных»: MCC = (TP·TN − FP·FN) / √((TP+FP)(TP+FN)(TN+FP)(TN+FN)). Значение `β` игнорируйте.'
};

function statement(classId: string, junior: boolean): string {
	return [
		'Модель классифицировала N объектов. Напишите программу, которая по парам «истинная метка — предсказанная метка» считает метрику качества.',
		'',
		'## Вход',
		'',
		junior
			? 'В первой строке — `N pos β`: число объектов (1 ≤ N ≤ 5·10⁴), метка позитивного класса и вещественное β > 0.'
			: 'В первой строке — `N pos`: число объектов (1 ≤ N ≤ 5·10⁴) и метка позитивного класса.',
		'Далее `N` строк `истина предсказание` — две метки (строчные латинские буквы). Метка может встречаться только в одном из столбцов.',
		'',
		'## Что вывести',
		'',
		TASK[classId] ?? '',
		'',
		'**Соглашение:** любое отношение вида 0/0 (precision без предсказанных позитивов, recall без истинных позитивов, F1 при P + R = 0, MCC при нулевом знаменателе) равно 0.',
		'',
		'Вещественные числа выводите с 6 знаками после запятой (например, `0.666667`); допускается погрешность 10⁻⁵.',
		'',
		'Скрытые тесты — пять групп: обычные данные, метки только в одном столбце, ровно две метки, редкий позитивный класс, большой объём. Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

const PY_TASK: Record<string, (v: Variant) => string[]> = {
	'positive-prf': () => ["print(' '.join(f'{x:.6f}' for x in prf(*counts(pos))))"],
	'pos-counts': () => ['tp, fp, fn = counts(pos)', 'print(tp, fp, fn, n - tp - fp - fn)'],
	'macro-f1': (v) => [
		v === 'label-set'
			? 'labels = set(t for t, p in pairs)'
			: 'labels = set(t for t, p in pairs) | set(p for t, p in pairs)',
		v === 'average-mismatch'
			? "print(f'{sum(prf(*counts(c))[2] * support(c) for c in labels) / n:.6f}')"
			: "print(f'{sum(prf(*counts(c))[2] for c in labels) / len(labels):.6f}')"
	],
	'weighted-f1': (v) => [
		'labels = set(t for t, p in pairs) | set(p for t, p in pairs)',
		v === 'average-mismatch'
			? "print(f'{sum(prf(*counts(c))[2] for c in labels) / len(labels):.6f}')"
			: "print(f'{sum(prf(*counts(c))[2] * support(c) for c in labels) / n:.6f}')"
	],
	'balanced-accuracy': (v) => [
		v === 'label-set'
			? 'labels = set(t for t, p in pairs) | set(p for t, p in pairs)'
			: 'labels = set(t for t, p in pairs)',
		"print(f'{sum(prf(*counts(c))[1] for c in labels) / len(labels):.6f}')"
	],
	fbeta: () => [
		'p, r, f = prf(*counts(pos))',
		'b2 = beta * beta',
		"print(f'{ratio((1 + b2) * p * r, b2 * p + r):.6f}')"
	],
	'per-class': (v) => [
		v === 'label-set'
			? 'labels = set(t for t, p in pairs)'
			: 'labels = set(t for t, p in pairs) | set(p for t, p in pairs)',
		'for c in sorted(labels):',
		"    print(c, ' '.join(f'{x:.6f}' for x in prf(*counts(c))), support(c))"
	],
	mcc: () => [
		'tp, fp, fn = counts(pos)',
		'tn = n - tp - fp - fn',
		"print(f'{ratio(tp * tn - fp * fn, ((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn)) ** 0.5):.6f}')"
	]
};

const NEEDS_SUPPORT = new Set(['macro-f1', 'weighted-f1', 'per-class']);

/** The reference program in Python; a variant other than `right` is a wrong solution. */
function referenceSource(classId: string, junior: boolean, variant: Variant): string {
	return [
		'import sys',
		'',
		'data = sys.stdin.read().split()',
		'n, pos = int(data[0]), data[1]',
		...(junior ? ['beta = float(data[2])'] : []),
		`pairs = [(data[${junior ? 3 : 2} + 2 * i], data[${junior ? 4 : 3} + 2 * i]) for i in range(n)]`,
		'',
		'',
		'def counts(label):',
		'    tp = fp = fn = 0',
		'    for t, p in pairs:',
		'        if p == label:',
		'            if t == label:',
		'                tp += 1',
		'            else:',
		'                fp += 1',
		'        elif t == label:',
		'            fn += 1',
		variant === 'swap-axes' ? '    return tp, fn, fp' : '    return tp, fp, fn',
		'',
		'',
		'def ratio(a, b):',
		`    return a / b if b > 0 else ${variant === 'undefined-as-one' ? '1.0' : '0.0'}`,
		'',
		'',
		'def prf(tp, fp, fn):',
		'    p = ratio(tp, tp + fp)',
		'    r = ratio(tp, tp + fn)',
		'    return p, r, ratio(2 * p * r, p + r)',
		'',
		...(NEEDS_SUPPORT.has(classId)
			? [
					'',
					'support_of = {}',
					'for t, p in pairs:',
					'    support_of[t] = support_of.get(t, 0) + 1',
					'',
					'',
					'def support(label):',
					'    return support_of.get(label, 0)',
					''
				]
			: []),
		'',
		...(PY_TASK[classId]?.(variant) ?? [])
	].join('\n');
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const classId = input.classId;
	const others = level.classes.map((c) => c.id).filter((id) => id !== classId);
	const hidden = groups(rng, classId, others, junior);
	const applies = APPLIES[junior ? 'junior' : 'intern']?.[classId] ?? [];
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(classId, junior), code: null },
		answer: null,
		practice: { languages: ['python3'], groups: hidden, checker: { kind: 'float_eps', eps: EPS } }
	});
	return {
		instance,
		reference: () => ({ kind: 'practice', source: referenceSource(classId, junior, 'right'), changeSource: null }),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies.includes(id) ? { kind: 'program' as const, source: referenceSource(classId, junior, id) } : null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
