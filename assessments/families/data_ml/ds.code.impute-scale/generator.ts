// Practice: fit on train, transform test — fill the missing values of numeric columns and scale them by the
// statistics of the training rows only, by the rule the class sets (mean or median imputation, the imputation by the
// median of a row's group; z-score with population or sample deviation, min-max, robust scaling by the IQR, clipping).
// Hidden tests in five groups: ordinary data, many missing values, test values outside the training range, a small or
// degenerate training set, a large volume.
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
const GROUP_NAMES = ['north', 'south', 'east', 'west', 'center'] as const;

type Variant = 'right' | 'fit-on-all' | 'missing-dropped' | 'impute-into-stats' | 'ddof';
const WRONG_IDS = ['fit-on-all', 'missing-dropped', 'impute-into-stats', 'ddof'] as const;

type Value = number | null;
interface Row {
	group: string;
	values: Value[];
}
interface Input {
	columns: number;
	train: Row[];
	test: Row[];
}

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

function median(xs: readonly number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const h = Math.floor(s.length / 2);
	return s.length % 2 ? (s[h] ?? 0) : ((s[h - 1] ?? 0) + (s[h] ?? 0)) / 2;
}

function quantile(xs: readonly number[], q: number): number {
	const s = [...xs].sort((a, b) => a - b);
	const at = (s.length - 1) * q;
	const lo = Math.floor(at);
	const hi = Math.min(lo + 1, s.length - 1);
	return (s[lo] ?? 0) + ((s[hi] ?? 0) - (s[lo] ?? 0)) * (at - lo);
}

function deviation(xs: readonly number[], ddof: number): number {
	const mu = mean(xs);
	return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - ddof));
}

const MEAN_FILL = new Set(['mean-zscore', 'mean-minmax', 'zscore-constant', 'clip-zscore']);
const ZSCORE = new Set(['mean-zscore', 'median-zscore-sample', 'zscore-constant', 'clip-zscore']);

/** The transformed test rows of the class; a variant other than `right` reproduces a wrong solution. */
function solve(classId: string, input: Input, variant: Variant = 'right'): string {
	const out: number[][] = input.test.map(() => []);
	const fitRows = variant === 'fit-on-all' ? [...input.train, ...input.test] : input.train;
	for (let c = 0; c < input.columns; c += 1) {
		const known = fitRows.map((r) => r.values[c] ?? null).filter((v): v is number => v !== null);
		const fill = MEAN_FILL.has(classId) ? mean(known) : median(known);
		const basis = variant === 'impute-into-stats' ? input.train.map((r) => r.values[c] ?? fill) : known;
		const byGroup = new Map<string, number[]>();
		for (const r of fitRows) {
			const v = r.values[c] ?? null;
			if (v === null) continue;
			const list = byGroup.get(r.group);
			if (list) list.push(v);
			else byGroup.set(r.group, [v]);
		}
		let transform: (v: number) => number;
		if (ZSCORE.has(classId)) {
			const sample = (classId === 'median-zscore-sample') !== (variant === 'ddof');
			const mu = mean(basis);
			const sd = deviation(basis, sample ? 1 : 0);
			const clip = classId === 'clip-zscore';
			transform = (v) => {
				const z = sd > 0 ? (v - mu) / sd : 0;
				return clip ? Math.min(2, Math.max(-2, z)) : z;
			};
		} else if (classId === 'robust') {
			const med = median(basis);
			const iqr = quantile(basis, 0.75) - quantile(basis, 0.25);
			transform = (v) => (iqr > 0 ? (v - med) / iqr : 0);
		} else {
			const lo = Math.min(...basis);
			const range = Math.max(...basis) - lo;
			transform = (v) => (range > 0 ? (v - lo) / range : 0);
		}
		input.test.forEach((r, i) => {
			const v = r.values[c] ?? null;
			const own = byGroup.get(r.group);
			const filled = v ?? (classId === 'group-median-minmax' && own ? median(own) : fill);
			out[i]?.push(transform(filled));
		});
	}
	return out
		.filter((_, i) => variant !== 'missing-dropped' || !(input.test[i]?.values.includes(null) ?? false))
		.map((row) => row.map((x) => x.toFixed(6)).join(' '))
		.join('\n');
}

const APPLIES: Record<string, Record<string, readonly Variant[]>> = {
	intern: {
		'mean-zscore': ['fit-on-all', 'missing-dropped', 'impute-into-stats', 'ddof'],
		'median-minmax': ['fit-on-all', 'missing-dropped'],
		'mean-minmax': ['fit-on-all', 'missing-dropped'],
		'median-zscore-sample': ['fit-on-all', 'missing-dropped', 'impute-into-stats', 'ddof']
	},
	junior: {
		'zscore-constant': ['fit-on-all', 'missing-dropped', 'impute-into-stats', 'ddof'],
		'group-median-minmax': ['fit-on-all', 'missing-dropped'],
		robust: ['fit-on-all', 'missing-dropped', 'impute-into-stats'],
		'clip-zscore': ['fit-on-all', 'missing-dropped', 'impute-into-stats', 'ddof']
	}
};

type GroupId = 'basic' | 'missing' | 'outside' | 'small' | 'scale';
const GROUP_IDS: readonly GroupId[] = ['basic', 'missing', 'outside', 'small', 'scale'];

/** The wrong solutions each group exposes on every test, where they apply to the class. */
const EXPOSES: Record<GroupId, readonly Variant[]> = {
	basic: ['fit-on-all', 'ddof'],
	missing: ['missing-dropped', 'impute-into-stats'],
	outside: ['fit-on-all'],
	small: [],
	scale: []
};

function makeInput(rng: Rng, group: GroupId, junior: boolean): Input {
	const columns = junior ? (group === 'scale' ? 3 : rng.int(2, 4)) : 1;
	const groupNames = rng.sample(GROUP_NAMES, junior ? rng.int(2, 3) : 1);
	const m = group === 'scale' ? rng.int(1500, 2500) : group === 'small' && !junior ? rng.int(3, 4) : rng.int(6, 14);
	const k = group === 'scale' ? rng.int(400, 600) : rng.int(3, 7);
	const missingShare = group === 'missing' ? 0.35 : group === 'small' && !junior ? 0 : 0.12;
	const lo = rng.int(0, 40);
	const hi = lo + rng.int(10, 80);
	const value = (outside: boolean): number =>
		outside ? (rng.bool() ? lo - rng.int(1, hi - lo) : hi + rng.int(1, hi - lo)) : rng.int(lo, hi);
	const row = (test: boolean): Row => ({
		group: rng.pick(groupNames),
		values: Array.from({ length: columns }, () =>
			rng.bool(test && group === 'small' ? 0.3 : missingShare)
				? null
				: value(test && rng.bool(group === 'outside' ? 0.6 : 0.25))
		)
	});
	const train = Array.from({ length: m }, () => row(false));
	const test = Array.from({ length: k }, () => row(true));
	for (let c = 0; c < columns; c += 1) {
		// Every column keeps two distinct known training values.
		const first = train[0];
		const second = train[1];
		if (first && second) {
			first.values[c] = lo;
			second.values[c] = hi;
		}
	}
	if (group === 'missing' || group === 'small') {
		const t = test[rng.int(0, k - 1)];
		if (t) t.values[rng.int(0, columns - 1)] = null;
		const r = train[rng.int(2, m - 1)];
		if (r && group === 'missing') r.values[rng.int(0, columns - 1)] = null;
	}
	if (group === 'small' && junior) {
		// A column without spread in train, and a test row of a group train has not seen.
		const c = rng.int(0, columns - 1);
		const constant = rng.int(lo, hi);
		for (const r of train) if (r.values[c] !== null) r.values[c] = constant;
		const unseen = GROUP_NAMES.find((g) => !groupNames.includes(g)) ?? 'other';
		const t = test[rng.int(0, k - 1)];
		if (t) {
			t.group = unseen;
			t.values[rng.int(0, columns - 1)] = null;
		}
	}
	return { columns, train, test };
}

const cell = (v: Value): string => (v === null ? 'NA' : String(v));

function render(input: Input, junior: boolean): string {
	if (!junior) {
		return `${input.train.length} ${input.test.length}\n${input.train.map((r) => cell(r.values[0] ?? null)).join(' ')}\n${input.test.map((r) => cell(r.values[0] ?? null)).join(' ')}\n`;
	}
	const lines = [...input.train, ...input.test].map((r) => [r.group, ...r.values.map(cell)].join(' '));
	return `${[`${input.train.length} ${input.test.length} ${input.columns}`, ...lines].join('\n')}\n`;
}

function sameOutput(a: string, b: string): boolean {
	const x = a.trim().split(/\s+/);
	const y = b.trim().split(/\s+/);
	return x.length === y.length && x.every((t, i) => Math.abs(Number(t) - Number(y[i])) <= 1e-4);
}

function groups(rng: Rng, classId: string, others: readonly string[], junior: boolean): HiddenTestGroup[] {
	const applies = APPLIES[junior ? 'junior' : 'intern']?.[classId] ?? [];
	return GROUP_IDS.map((id) => {
		const count = id === 'scale' ? 1 : 4;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 2000) throw new Error(`${descriptor.key}: no ${id} test for ${classId}`);
			const input = makeInput(rng, id, junior);
			const expected = solve(classId, input);
			if (others.some((other) => sameOutput(solve(other, input), expected))) continue;
			const exposes = EXPOSES[id].filter((v) => applies.includes(v));
			if (exposes.some((v) => sameOutput(solve(classId, input, v), expected))) continue;
			tests.push({ stdin: render(input, junior), expected: `${expected}\n` });
		}
		return { id, tests };
	});
}

const RULE: Record<string, string> = {
	'mean-zscore':
		'Пропуск заменяется средним известных значений train. Затем z = (x − μ) / σ, где μ — среднее, σ — стандартное отклонение **с делением на n** (ddof = 0) известных значений train; при σ = 0 результат 0.',
	'median-minmax':
		'Пропуск заменяется медианой известных значений train (при чётном числе — среднее двух средних). Затем (x − min) / (max − min) по известным значениям train; значения test за пределами диапазона train не обрезаются (могут быть < 0 и > 1); при max = min результат 0.',
	'mean-minmax':
		'Пропуск заменяется средним известных значений train. Затем (x − min) / (max − min) по известным значениям train; значения test за пределами диапазона train не обрезаются; при max = min результат 0.',
	'median-zscore-sample':
		'Пропуск заменяется медианой известных значений train (при чётном числе — среднее двух средних). Затем z = (x − μ) / s, где μ — среднее, s — **выборочное** стандартное отклонение (деление на n − 1) известных значений train; при s = 0 результат 0.',
	'zscore-constant':
		'В каждом столбце пропуск заменяется средним известных значений этого столбца в train. Затем z = (x − μ) / σ по известным значениям столбца в train, σ — с делением на n (ddof = 0). Если в train у столбца нет разброса (σ = 0), все его значения в выводе — 0.',
	'group-median-minmax':
		'В каждом столбце пропуск заменяется медианой известных значений этого столбца **у строк train той же группы**; если у группы в train нет известных значений этого столбца (или группы нет в train), — медианой всех известных значений столбца в train. Медиана при чётном числе — среднее двух средних. Затем (x − min) / (max − min) по известным значениям столбца в train, без обрезки; при max = min результат 0. Группу строки test учитывайте только для выбора медианы.',
	robust:
		'В каждом столбце пропуск заменяется медианой известных значений столбца в train. Затем (x − M) / (Q3 − Q1), где M — медиана, Q1 и Q3 — квантили 0.25 и 0.75 известных значений столбца в train, вычисленные линейной интерполяцией: для отсортированных v₀ ≤ … ≤ vₙ₋₁ квантиль q — это v[i] + (v[i+1] − v[i])·f, где (n − 1)·q = i + f. При Q3 = Q1 результат 0. Группы не используются.',
	'clip-zscore':
		'В каждом столбце пропуск заменяется средним известных значений столбца в train. Затем z = (x − μ) / σ по известным значениям столбца в train, σ — с делением на n (ddof = 0), и z обрезается до отрезка [−2, 2]. При σ = 0 результат 0. Группы не используются.'
};

function statement(classId: string, junior: boolean): string {
	return [
		'Подготовка признаков для модели: статистики считаются **только по обучающей выборке** (train) и применяются к тестовой (test). Напишите программу, которая преобразует значения test.',
		'',
		'## Вход',
		'',
		junior
			? 'В первой строке — `M K C`: число строк train и test (1 ≤ M, K ≤ 5000) и число числовых столбцов (1 ≤ C ≤ 5). Далее M строк train, затем K строк test, каждая — `группа v₁ … v_C`: название группы (строчные латинские буквы) и C целых значений или `NA` (пропуск). В каждом столбце train не меньше двух известных значений.'
			: 'В первой строке — `M K`: число значений train и test (3 ≤ M ≤ 5000, 1 ≤ K ≤ 5000). Во второй строке — M значений train, в третьей — K значений test: целые числа или `NA` (пропуск). В train не меньше двух известных значений.',
		'',
		'## Правило',
		'',
		RULE[classId] ?? '',
		'Пропуски train в статистики не входят.',
		'',
		'## Выход',
		'',
		junior
			? 'K строк — преобразованные значения каждой строки test в порядке столбцов, через пробел.'
			: 'K строк — преобразованное значение каждого элемента test по порядку.',
		'Числа выводите с 6 знаками после запятой (например, `-0.512345`); допускается погрешность 10⁻⁵.',
		'',
		`Скрытые тесты — пять групп: обычные данные, много пропусков, значения test за пределами диапазона train, ${junior ? 'столбец без разброса и группа без значений' : 'маленькая выборка train'}, большой объём. Группа засчитывается, если пройдены все её тесты.`
	].join('\n');
}

/** The reference program in Python; a variant other than `right` is a wrong solution. */
function referenceSource(classId: string, junior: boolean, variant: Variant): string {
	const meanFill = MEAN_FILL.has(classId);
	const zscore = ZSCORE.has(classId);
	const sample = (classId === 'median-zscore-sample') !== (variant === 'ddof');
	const read = junior
		? [
				'm, k, cols = int(data[0]), int(data[1]), int(data[2])',
				'rows = [data[3 + i * (cols + 1):4 + i * (cols + 1) + cols] for i in range(m + k)]',
				'rows = [(r[0], [value(v) for v in r[1:]]) for r in rows]',
				'train, test = rows[:m], rows[m:]'
			]
		: [
				'm, k, cols = int(data[0]), int(data[1]), 1',
				"train = [('', [value(v)]) for v in data[2:2 + m]]",
				"test = [('', [value(v)]) for v in data[2 + m:2 + m + k]]"
			];
	const scale = zscore
		? [
				'    mu = sum(basis) / len(basis)',
				`    sd = (sum((x - mu) ** 2 for x in basis) / (len(basis)${sample ? ' - 1' : ''})) ** 0.5`,
				'',
				'    def transform(v):',
				'        z = (v - mu) / sd if sd > 0 else 0.0',
				...(classId === 'clip-zscore' ? ['        return min(2.0, max(-2.0, z))'] : ['        return z'])
			]
		: classId === 'robust'
			? [
					'    med = median(basis)',
					'    iqr = quantile(basis, 0.75) - quantile(basis, 0.25)',
					'',
					'    def transform(v):',
					'        return (v - med) / iqr if iqr > 0 else 0.0'
				]
			: [
					'    lo = min(basis)',
					'    span = max(basis) - lo',
					'',
					'    def transform(v):',
					'        return (v - lo) / span if span > 0 else 0.0'
				];
	const fitRows = variant === 'fit-on-all' ? 'train + test' : 'train';
	return [
		'import sys',
		'',
		'',
		'def value(s):',
		"    return None if s == 'NA' else float(s)",
		'',
		'',
		'def median(values):',
		'    s = sorted(values)',
		'    h = len(s) // 2',
		'    return s[h] if len(s) % 2 else (s[h - 1] + s[h]) / 2',
		'',
		...(classId === 'robust'
			? [
					'',
					'def quantile(values, q):',
					'    s = sorted(values)',
					'    at = (len(s) - 1) * q',
					'    lo = int(at)',
					'    hi = min(lo + 1, len(s) - 1)',
					'    return s[lo] + (s[hi] - s[lo]) * (at - lo)',
					''
				]
			: []),
		'',
		'data = sys.stdin.read().split()',
		...read,
		'out = [[] for _ in test]',
		'for c in range(cols):',
		`    known = [x[c] for g, x in ${fitRows} if x[c] is not None]`,
		meanFill ? '    fill = sum(known) / len(known)' : '    fill = median(known)',
		variant === 'impute-into-stats'
			? '    basis = [fill if x[c] is None else x[c] for g, x in train]'
			: '    basis = known',
		...(classId === 'group-median-minmax'
			? [
					'    by_group = {}',
					`    for g, x in ${fitRows}:`,
					'        if x[c] is not None:',
					'            by_group.setdefault(g, []).append(x[c])'
				]
			: []),
		...scale,
		'',
		'    for i, (g, x) in enumerate(test):',
		...(classId === 'group-median-minmax'
			? ['        v = x[c] if x[c] is not None else (median(by_group[g]) if g in by_group else fill)']
			: ['        v = fill if x[c] is None else x[c]']),
		'        out[i].append(transform(v))',
		'for (g, x), row in zip(test, out):',
		...(variant === 'missing-dropped' ? ['    if None in x:', '        continue'] : []),
		"    print(' '.join(f'{v:.6f}' for v in row))"
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
