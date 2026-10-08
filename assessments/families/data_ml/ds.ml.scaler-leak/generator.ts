// Fit and transform of a scaler: the value a model gets for one row after scaling, when the scaler is fitted on the
// training part only — the train of a split (Junior) or the training folds of KFold inside cross-validation (Middle).
// The class sets the transformer and whether missing values are imputed first.
import { farApart, floatAnswer, frameMarkdown, roundingRule, stdinJson, type Cell } from '../../_lib/ds.ts';
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
const FEATURES = ['income', 'age', 'tenure', 'visits', 'basket', 'latency', 'sessions', 'clicks'] as const;

type Kind = 'standard' | 'minmax' | 'impute-standard' | 'robust' | 'impute-median';

/** How a misconception changes the computation; all false — the right one. */
interface Rules {
	fitOnAll: boolean;
	ddofOne: boolean;
	clip: boolean;
	stdSkipsMissing: boolean;
	meanCenter: boolean;
	fitOnFold: boolean;
	equalFolds: boolean;
}

const RIGHT: Rules = {
	fitOnAll: false,
	ddofOne: false,
	clip: false,
	stdSkipsMissing: false,
	meanCenter: false,
	fitOnFold: false,
	equalFolds: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'fit-on-all': { fitOnAll: true },
	'ddof-one': { ddofOne: true },
	clip: { clip: true },
	'std-skips-missing': { stdSkipsMissing: true },
	'mean-center': { meanCenter: true },
	'fit-on-fold': { fitOnFold: true },
	'equal-folds': { equalFolds: true }
};

/** Which misconceptions a class can show. */
const APPLIES: Record<string, readonly string[]> = {
	standard: ['fit-on-all', 'ddof-one'],
	minmax: ['fit-on-all', 'clip'],
	'impute-standard': ['fit-on-all', 'std-skips-missing'],
	robust: ['fit-on-all', 'mean-center'],
	'cv-standard': ['fit-on-all', 'ddof-one', 'fit-on-fold', 'equal-folds'],
	'cv-impute-median': ['fit-on-all', 'std-skips-missing', 'fit-on-fold', 'equal-folds'],
	'cv-minmax': ['fit-on-all', 'clip', 'fit-on-fold', 'equal-folds'],
	'cv-robust': ['fit-on-all', 'mean-center', 'fit-on-fold', 'equal-folds']
};

const KIND: Record<string, Kind> = {
	standard: 'standard',
	minmax: 'minmax',
	'impute-standard': 'impute-standard',
	robust: 'robust',
	'cv-standard': 'standard',
	'cv-impute-median': 'impute-median',
	'cv-minmax': 'minmax',
	'cv-robust': 'robust'
};

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

function std(xs: readonly number[], ddof: number): number {
	const m = mean(xs);
	return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - ddof));
}

/** The quantile of numpy's default method: linear interpolation at position (n − 1)·q of the sorted values. */
function quantile(xs: readonly number[], q: number): number {
	const sorted = [...xs].sort((a, b) => a - b);
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.min(lo + 1, sorted.length - 1);
	return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (pos - lo);
}

/** Fits the transformer on `fit` (null — missing) and transforms `value`; null when the fit is degenerate. */
function transform(kind: Kind, fit: readonly (number | null)[], value: number | null, rules: Rules): number | null {
	const observed = fit.filter((x): x is number => x !== null);
	if (observed.length < 2) return null;
	let column = observed;
	let x = value;
	if (kind === 'impute-standard' || kind === 'impute-median') {
		const fill = kind === 'impute-standard' ? mean(observed) : quantile(observed, 0.5);
		column = fit.map((v) => v ?? fill);
		x ??= fill;
		if (rules.stdSkipsMissing) column = observed;
	}
	if (x === null) return null;
	if (kind === 'minmax') {
		const lo = Math.min(...column);
		const hi = Math.max(...column);
		if (hi === lo) return null;
		const scaled = (x - lo) / (hi - lo);
		return rules.clip ? Math.min(1, Math.max(0, scaled)) : scaled;
	}
	if (kind === 'robust') {
		const iqr = quantile(column, 0.75) - quantile(column, 0.25);
		if (iqr === 0) return null;
		return (x - (rules.meanCenter ? mean(column) : quantile(column, 0.5))) / iqr;
	}
	const s = std(column, rules.ddofOne ? 1 : 0);
	if (s === 0) return null;
	return (x - mean(column)) / s;
}

/** KFold(n_splits=k, shuffle=False): the first n mod k folds get one row more. */
function foldOf(n: number, k: number, row: number, equal: boolean): number {
	const base = Math.floor(n / k);
	const extra = n % k;
	if (equal) return Math.min(Math.floor(row / base), k - 1);
	let start = 0;
	for (let f = 0; f < k; f += 1) {
		const size = base + (f < extra ? 1 : 0);
		if (row < start + size) return f;
		start += size;
	}
	throw new Error(`row ${row} outside ${n} rows`);
}

interface Junior {
	grade: 'junior';
	values: (number | null)[];
	split: ('train' | 'test')[];
	target: number;
}
interface Middle {
	grade: 'middle';
	values: (number | null)[];
	k: number;
	target: number;
}
type Scenario = Junior | Middle;

function compute(kind: Kind, s: Scenario, rules: Rules): number | null {
	if (s.grade === 'junior') {
		const fit = s.values.filter((_, i) => rules.fitOnAll || s.split[i] === 'train');
		return transform(kind, fit, s.values[s.target] ?? null, rules);
	}
	const n = s.values.length;
	const fold = foldOf(n, s.k, s.target, rules.equalFolds);
	const fit = s.values.filter((_, i) => {
		if (rules.fitOnAll) return true;
		const same = foldOf(n, s.k, i, rules.equalFolds) === fold;
		return rules.fitOnFold ? same : !same;
	});
	return transform(kind, fit, s.values[s.target] ?? null, rules);
}

function juniorScenario(rng: Rng, classId: string): Junior {
	const n = rng.int(9, 14);
	const tests = rng.int(3, 4);
	const split: ('train' | 'test')[] = rng.shuffle([
		...Array.from({ length: n - tests }, () => 'train' as const),
		...Array.from({ length: tests }, () => 'test' as const)
	]);
	const values: (number | null)[] = split.map(() => rng.int(5, 80));
	const testRows = split.flatMap((s, i) => (s === 'test' ? [i] : []));
	const target = rng.pick(testRows);
	if (classId === 'minmax') {
		// The asked test value lies outside the range of the train: above or below it.
		const train = values.filter((_, i) => split[i] === 'train') as number[];
		values[target] = rng.bool() ? Math.max(...train) + rng.int(3, 25) : Math.max(0, Math.min(...train) - rng.int(3, 5));
	}
	if (classId === 'impute-standard') {
		const trainRows = split.flatMap((s, i) => (s === 'train' ? [i] : []));
		for (const i of rng.sample(trainRows, rng.int(2, 3))) values[i] = null;
		for (const i of rng.sample(
			testRows.filter((r) => r !== target),
			1
		))
			values[i] = null;
	}
	return { grade: 'junior', values, split, target };
}

function middleScenario(rng: Rng, classId: string): Middle {
	const k = rng.int(3, 5);
	// About two of three instances leave a remainder, so the sizes of KFold's folds matter.
	const n = k * rng.int(3, 4) + (rng.bool(0.7) ? rng.int(1, k - 1) : 0);
	const values: (number | null)[] = Array.from({ length: n }, () => rng.int(5, 80));
	const target = rng.int(0, n - 1);
	if (classId === 'cv-impute-median') {
		values[target] = null;
		for (const i of rng.sample(
			values.map((_, i) => i).filter((i) => i !== target),
			rng.int(1, 2)
		))
			values[i] = null;
	}
	if (classId === 'cv-minmax') {
		// The asked row is an extreme of the whole column: out of the range of the training folds.
		const others = values.filter((_, i) => i !== target) as number[];
		values[target] = rng.bool()
			? Math.max(...others) + rng.int(3, 25)
			: Math.max(0, Math.min(...others) - rng.int(3, 5));
	}
	return { grade: 'middle', values, k, target };
}

const CLASS_CODE: Record<Kind, { import: string; make: string }> = {
	standard: { import: 'from sklearn.preprocessing import StandardScaler', make: 'StandardScaler()' },
	minmax: { import: 'from sklearn.preprocessing import MinMaxScaler', make: 'MinMaxScaler()' },
	robust: { import: 'from sklearn.preprocessing import RobustScaler', make: 'RobustScaler()' },
	'impute-standard': {
		import: 'from sklearn.impute import SimpleImputer\nfrom sklearn.preprocessing import StandardScaler',
		make: "SimpleImputer(strategy='mean'), StandardScaler()"
	},
	'impute-median': {
		import: 'from sklearn.impute import SimpleImputer\nfrom sklearn.preprocessing import StandardScaler',
		make: "SimpleImputer(strategy='median'), StandardScaler()"
	}
};

function juniorCode(kind: Kind, feature: string): string {
	const c = CLASS_CODE[kind];
	const piped = kind === 'impute-standard';
	return [
		'import pandas as pd',
		...(piped ? ['from sklearn.pipeline import make_pipeline'] : []),
		c.import,
		'',
		'# df — таблица из условия',
		"train = df[df['split'] == 'train']",
		"test = df[df['split'] == 'test']",
		piped ? `prep = make_pipeline(${c.make})` : `prep = ${c.make}`,
		`prep.fit(train[['${feature}']])`,
		`test_scaled = prep.transform(test[['${feature}']])`
	].join('\n');
}

function middleCode(kind: Kind, feature: string, k: number): string {
	const c = CLASS_CODE[kind];
	return [
		'import pandas as pd',
		'from sklearn.linear_model import LogisticRegression',
		'from sklearn.model_selection import KFold, cross_val_score',
		'from sklearn.pipeline import make_pipeline',
		c.import,
		'',
		'# df — таблица из условия, y — метки 0/1 тех же строк; в каждом обучающем фолде есть оба класса',
		`model = make_pipeline(${c.make}, LogisticRegression())`,
		`cv = KFold(n_splits=${k}, shuffle=False)`,
		`scores = cross_val_score(model, df[['${feature}']], y, cv=cv)`
	].join('\n');
}

const RULES_TEXT: Record<Kind, string> = {
	standard: '`StandardScaler` вычитает среднее и делит на стандартное отклонение с делением на n (как в scikit-learn).',
	minmax: '`MinMaxScaler` переводит минимум в 0, максимум в 1 и ничего не обрезает.',
	robust:
		'`RobustScaler` вычитает медиану и делит на межквартильный размах Q3 − Q1; квантили — линейной интерполяцией, как `numpy.percentile` по умолчанию.',
	'impute-standard':
		"`SimpleImputer(strategy='mean')` заполняет пропуски средним, затем `StandardScaler` вычитает среднее и делит на стандартное отклонение с делением на n.",
	'impute-median':
		"`SimpleImputer(strategy='median')` заполняет пропуски медианой, затем `StandardScaler` вычитает среднее и делит на стандартное отклонение с делением на n."
};

function statement(kind: Kind, s: Scenario, feature: string): { markdown: string; code: string } {
	if (s.grade === 'junior') {
		const rows: Cell[][] = s.values.map((v, i) => [i + 1, v, s.split[i] ?? 'train']);
		return {
			markdown: [
				`Таблица \`df\` (пропуск — \`NaN\`):`,
				'',
				frameMarkdown(['id', feature, 'split'], rows),
				'',
				'Признак готовят к модели кодом ниже. ' + RULES_TEXT[kind],
				'',
				`Какое значение \`test_scaled\` получит строка с \`id = ${s.target + 1}\`?`,
				'',
				roundingRule(DIGITS)
			].join('\n'),
			code: juniorCode(kind, feature)
		};
	}
	const rows: Cell[][] = s.values.map((v, i) => [i, v]);
	return {
		markdown: [
			`Таблица \`df\` (индекс — номер строки, пропуск — \`NaN\`), строки идут в этом порядке:`,
			'',
			frameMarkdown(['row', feature], rows),
			'',
			'Модель оценивают кросс-валидацией кодом ниже. Метки `y` не показаны: они 0/1, в каждом обучающем фолде есть оба класса, и обучение на каждом фолде проходит без ошибок. ' +
				RULES_TEXT[kind],
			'',
			`Какое значение признака после подготовки получит логистическая регрессия для строки ${s.target}, когда эта строка окажется в валидационном фолде?`,
			'',
			roundingRule(DIGITS)
		].join('\n'),
		code: middleCode(kind, feature, s.k)
	};
}

const PYTHON_REFERENCE = `import json
import statistics

p = json.loads(input())
kind, grade, values, target = p["kind"], p["grade"], p["values"], p["target"]

if grade == "junior":
    fit = [v for v, s in zip(values, p["split"]) if s == "train"]
else:
    n, k = len(values), p["k"]
    sizes = [n // k + (1 if f < n % k else 0) for f in range(k)]
    bounds, start = [], 0
    for size in sizes:
        bounds.append((start, start + size))
        start += size
    lo, hi = next(b for b in bounds if b[0] <= target < b[1])
    fit = [v for i, v in enumerate(values) if not (lo <= i < hi)]

def pct(xs, q):
    xs = sorted(xs)
    pos = (len(xs) - 1) * q
    i = int(pos)
    j = min(i + 1, len(xs) - 1)
    return xs[i] + (xs[j] - xs[i]) * (pos - i)

x = values[target]
observed = [v for v in fit if v is not None]
if kind in ("impute-standard", "impute-median"):
    fill = statistics.fmean(observed) if kind == "impute-standard" else statistics.median(observed)
    fit = [fill if v is None else v for v in fit]
    if x is None:
        x = fill
if kind == "minmax":
    result = (x - min(fit)) / (max(fit) - min(fit))
elif kind == "robust":
    result = (x - statistics.median(fit)) / (pct(fit, 0.75) - pct(fit, 0.25))
else:
    result = (x - statistics.fmean(fit)) / statistics.pstdev(fit)
print(repr(result))
`;

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const kind = KIND[input.classId];
	if (!kind) throw new Error(`${descriptor.key}: unknown class ${input.classId}`);
	const applies = APPLIES[input.classId] ?? [];
	for (let tries = 0; tries < 300; tries += 1) {
		const s = input.grade === 'junior' ? juniorScenario(rng, input.classId) : middleScenario(rng, input.classId);
		const answer = compute(kind, s, RIGHT);
		if (answer === null) continue;
		const wrong: Record<string, number | null> = {};
		let distinct = true;
		for (const id of Object.keys(WRONG)) {
			if (!applies.includes(id) || (id === 'equal-folds' && s.grade === 'middle' && s.values.length % s.k === 0)) {
				wrong[id] = null;
				continue;
			}
			const value = compute(kind, s, { ...RIGHT, ...WRONG[id] });
			if (value === null || !farApart(answer, value, DIGITS)) distinct = false;
			wrong[id] = value;
		}
		if (!distinct) continue;
		const feature = rng.pick(FEATURES);
		const text = statement(kind, s, feature);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: text.markdown, code: { language: 'python3', source: text.code } },
			answer: floatAnswer(answer, DIGITS)
		});
		const probe = {
			kind,
			grade: s.grade,
			values: s.values,
			target: s.target,
			...(s.grade === 'junior' ? { split: s.split } : { k: s.k })
		};
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(probe) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
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
