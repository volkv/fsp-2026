// Splits of cross-validation: which rows a scikit-learn splitter puts where on a given iteration — KFold with a
// remainder, GroupKFold, StratifiedKFold, TimeSeriesSplit (Junior); TimeSeriesSplit with a gap and a bounded train
// window, nested cross-validation and a user leaking across a split by rows (Middle). The answer is a set of row
// indices or of users.
import { frameMarkdown, stdinJson, type Cell } from '../../_lib/ds.ts';
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const range = (from: number, to: number): number[] =>
	Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

/** Validation indices of fold `f` (0-based) of KFold without shuffling; the variants are misconceptions. */
function kfold(n: number, k: number, f: number, variant: 'right' | 'equal' | 'extra-last' = 'right'): number[] {
	const base = Math.floor(n / k);
	const extra = n % k;
	if (variant === 'equal') return range(f * base, f === k - 1 ? n : (f + 1) * base);
	const sizes = range(0, k).map(
		(i) => base + (variant === 'extra-last' ? (i >= k - extra ? 1 : 0) : i < extra ? 1 : 0)
	);
	const start = sizes.slice(0, f).reduce((s, x) => s + x, 0);
	return range(start, start + (sizes[f] ?? 0));
}

/** GroupKFold without shuffling: groups by size descending, each into the lightest fold (ties — the lowest number). */
function groupFolds(groups: readonly string[], k: number): Map<string, number> {
	const sizes = new Map<string, number>();
	for (const g of groups) sizes.set(g, (sizes.get(g) ?? 0) + 1);
	const order = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
	const load = range(0, k).map(() => 0);
	const fold = new Map<string, number>();
	for (const [g, size] of order) {
		const lightest = load.indexOf(Math.min(...load));
		load[lightest] = (load[lightest] ?? 0) + size;
		fold.set(g, lightest);
	}
	return fold;
}

/** StratifiedKFold without shuffling (scikit-learn's allocation): fold of every row. */
function stratifiedFolds(labels: readonly string[], k: number): number[] {
	const classes = [...new Set(labels)];
	const sortedClasses = classes.flatMap((c) => labels.filter((l) => l === c).map(() => c));
	const allocation = range(0, k).map((f) =>
		classes.map((c) => sortedClasses.filter((x, p) => p % k === f && x === c).length)
	);
	const folds = labels.map(() => 0);
	classes.forEach((c, ci) => {
		const rows = labels.flatMap((l, i) => (l === c ? [i] : []));
		let r = 0;
		for (let f = 0; f < k; f += 1) {
			for (let t = 0; t < (allocation[f]?.[ci] ?? 0); t += 1) folds[rows[r++] ?? 0] = f;
		}
	});
	return folds;
}

interface TsParams {
	n: number;
	splits: number;
	gap: number;
	maxTrain: number | null;
	f: number;
}

/** TimeSeriesSplit: train and validation index ranges of iteration `f` (1-based). */
function tsSplit(
	p: TsParams,
	variant: { sizeBySplits?: boolean; fromStart?: boolean; noGap?: boolean; gapInVal?: boolean; noMax?: boolean } = {}
) {
	const size = Math.floor(p.n / (variant.sizeBySplits ? p.splits : p.splits + 1));
	const start = variant.fromStart ? p.f * size : p.n - (p.splits - p.f + 1) * size;
	const gap = variant.noGap ? 0 : p.gap;
	if (variant.gapInVal) {
		const trainEnd = start;
		const trainStart = p.maxTrain === null || variant.noMax ? 0 : Math.max(0, trainEnd - p.maxTrain);
		return { train: range(trainStart, trainEnd), val: range(start + gap, start + size) };
	}
	const trainEnd = start - gap;
	const trainStart = p.maxTrain === null || variant.noMax ? 0 : Math.max(0, trainEnd - p.maxTrain);
	return { train: range(trainStart, trainEnd), val: range(start, start + size) };
}

function excluded(n: number, split: { train: number[]; val: number[] }): number[] {
	const used = new Set([...split.train, ...split.val]);
	return range(0, n).filter((i) => !used.has(i));
}

const asSet = (xs: readonly (number | string)[]): string[] =>
	xs.length === 0 ? ['-'] : [...new Set(xs.map(String))].sort();

interface Task {
	markdown: string;
	code: string;
	answer: string[];
	wrong: Record<string, string[] | null>;
	probe: object;
}

const SET_RULE =
	'Введите ответ списком, по одному элементу в строке; порядок не важен. Если таких нет — одна строка `-`.';

function users(rng: Rng, count: number): string[] {
	return rng.sample(PERSON_NAMES, count);
}

function juniorTask(rng: Rng, classId: string): Task | null {
	if (classId === 'kfold') {
		const k = rng.int(3, 6);
		const n = k * rng.int(2, 6) + rng.int(1, k - 1);
		const f = rng.int(1, k);
		return {
			markdown: [
				`В выборке \`X\` ${n} строк с индексами 0…${n - 1}. Модель оценивают так:`,
				'',
				`Какие индексы попадут в валидационную часть на итерации ${f} (итерации считаются с 1)?`,
				'',
				SET_RULE
			].join('\n'),
			code: [
				'from sklearn.model_selection import KFold',
				'',
				`cv = KFold(n_splits=${k}, shuffle=False)`,
				'for i, (train_idx, val_idx) in enumerate(cv.split(X), start=1):',
				'    ...'
			].join('\n'),
			answer: asSet(kfold(n, k, f - 1)),
			wrong: {
				'equal-folds': asSet(kfold(n, k, f - 1, 'equal')),
				'extra-last': asSet(kfold(n, k, f - 1, 'extra-last'))
			},
			probe: { kind: 'kfold', n, k, f }
		};
	}
	if (classId === 'group') {
		const count = rng.int(5, 7);
		const names = users(rng, count);
		const sizes = rng.sample(range(1, 8), count);
		const groups = rng.shuffle(names.flatMap((name, i) => range(0, sizes[i] ?? 1).map(() => name)));
		const k = rng.int(2, 3);
		const f = rng.int(1, k);
		const fold = groupFolds(groups, k);
		const firstSeen = [...new Set(groups)];
		return {
			markdown: [
				'Таблица `df` (индекс — номер строки, `user` — пользователь, по нему задана группа):',
				'',
				frameMarkdown(
					['row', 'user'],
					groups.map((g, i) => [i, g])
				),
				'',
				`Разбиение по группам — \`GroupKFold(n_splits=${k})\` без перемешивания: группы берутся по убыванию числа строк, и каждая целиком идёт в фолд, где сейчас меньше всего строк (при равенстве — в фолд с меньшим номером). Итерация f валидирует на фолде f.`,
				'',
				`Какие строки попадут в валидационную часть на итерации ${f} (итерации и фолды считаются с 1)?`,
				'',
				SET_RULE
			].join('\n'),
			code: [
				'from sklearn.model_selection import GroupKFold',
				'',
				`cv = GroupKFold(n_splits=${k})`,
				"for i, (train_idx, val_idx) in enumerate(cv.split(df, groups=df['user']), start=1):",
				'    ...'
			].join('\n'),
			answer: asSet(groups.flatMap((g, i) => (fold.get(g) === f - 1 ? [i] : []))),
			wrong: {
				'row-kfold': asSet(kfold(groups.length, k, f - 1)),
				'round-robin': asSet(groups.flatMap((g, i) => (firstSeen.indexOf(g) % k === f - 1 ? [i] : [])))
			},
			probe: { kind: 'group', groups, k, f }
		};
	}
	if (classId === 'timeseries') {
		const splits = rng.int(3, 5);
		const n = (splits + 1) * rng.int(2, 6) + rng.int(1, splits);
		const f = rng.int(1, splits);
		const p: TsParams = { n, splits, gap: 0, maxTrain: null, f };
		return {
			markdown: [
				`Ряд \`X\` из ${n} наблюдений упорядочен по времени, индексы 0…${n - 1}. Модель оценивают так:`,
				'',
				`Какие индексы попадут в валидационную часть на итерации ${f} (итерации считаются с 1)?`,
				'',
				SET_RULE
			].join('\n'),
			code: [
				'from sklearn.model_selection import TimeSeriesSplit',
				'',
				`cv = TimeSeriesSplit(n_splits=${splits})`,
				'for i, (train_idx, val_idx) in enumerate(cv.split(X), start=1):',
				'    ...'
			].join('\n'),
			answer: asSet(tsSplit(p).val),
			wrong: {
				'size-by-splits': asSet(tsSplit(p, { sizeBySplits: true }).val),
				'from-start': asSet(tsSplit(p, { fromStart: true }).val)
			},
			probe: { kind: 'timeseries', ...p }
		};
	}
	const k = rng.int(3, 4);
	const [pos, neg] = rng.pick([
		['churn', 'stay'],
		['fraud', 'ok'],
		['spam', 'ham'],
		['click', 'skip']
	] as const);
	const nPos = rng.int(k + 1, 2 * k + 1);
	const nNeg = rng.int(2 * k, 4 * k);
	const labels = rng.shuffle([...range(0, nPos).map(() => pos), ...range(0, nNeg).map(() => neg)]);
	const f = rng.int(1, k);
	const folds = stratifiedFolds(labels, k);
	const classes = [...new Set(labels)];
	return {
		markdown: [
			'Таблица `df` (индекс — номер строки, `y` — метка класса):',
			'',
			frameMarkdown(
				['row', 'y'],
				labels.map((l, i) => [i, l])
			),
			'',
			`Разбиение — \`StratifiedKFold(n_splits=${k})\` без перемешивания, как в scikit-learn. Сколько строк каждого класса получает фолд: метки выписываются по классам (сначала все метки класса, встретившегося в данных первым, затем второго), и позиции этого списка раздаются фолдам по кругу — позиция p (с 0) достаётся фолду p mod ${k} (фолды с 0). Строки класса идут в фолды блоками в исходном порядке: первые — в фолд 0, следующие — в фолд 1 и т. д. Итерация i валидирует на фолде i − 1.`,
			'',
			`Какие строки попадут в валидационную часть на итерации ${f} (итерации считаются с 1)?`,
			'',
			SET_RULE
		].join('\n'),
		code: [
			'from sklearn.model_selection import StratifiedKFold',
			'',
			`cv = StratifiedKFold(n_splits=${k}, shuffle=False)`,
			"for i, (train_idx, val_idx) in enumerate(cv.split(df, df['y']), start=1):",
			'    ...'
		].join('\n'),
		answer: asSet(labels.flatMap((_, i) => (folds[i] === f - 1 ? [i] : []))),
		wrong: {
			'row-kfold': asSet(kfold(labels.length, k, f - 1)),
			'round-robin': asSet(
				labels.flatMap((l, i) => (labels.slice(0, i).filter((x) => x === l).length % k === f - 1 ? [i] : []))
			)
		},
		probe: { kind: 'stratified', labels, k, f, classes }
	};
}

function middleTask(rng: Rng, classId: string): Task | null {
	if (classId === 'ts-gap' || classId === 'ts-max-train') {
		const splits = rng.int(3, 5);
		const n = (splits + 1) * rng.int(3, 4) + rng.int(0, splits);
		const f = rng.int(splits - 1, splits);
		const gap = rng.int(1, 3);
		const p: TsParams = { n, splits, gap, maxTrain: null, f };
		const trainEnd = tsSplit(p).train.length;
		// scikit-learn refuses a split whose first iteration has no train rows.
		if (trainEnd < 4 || n - gap - Math.floor(n / (splits + 1)) * splits < 2) return null;
		if (classId === 'ts-max-train') p.maxTrain = rng.int(2, trainEnd - 2);
		const args = `n_splits=${splits}, gap=${gap}${p.maxTrain === null ? '' : `, max_train_size=${p.maxTrain}`}`;
		const answer = asSet(excluded(n, tsSplit(p)));
		return {
			markdown: [
				`Ряд \`X\` из ${n} наблюдений упорядочен по времени, индексы 0…${n - 1}. Модель оценивают так:`,
				'',
				`Какие индексы на итерации ${f} (итерации считаются с 1) не попадут ни в обучающую, ни в валидационную часть?`,
				'',
				SET_RULE
			].join('\n'),
			code: [
				'from sklearn.model_selection import TimeSeriesSplit',
				'',
				`cv = TimeSeriesSplit(${args})`,
				'for i, (train_idx, val_idx) in enumerate(cv.split(X), start=1):',
				'    ...'
			].join('\n'),
			answer,
			wrong: {
				'no-gap': asSet(excluded(n, tsSplit(p, { noGap: true }))),
				'gap-in-val': asSet(excluded(n, tsSplit(p, { gapInVal: true }))),
				'size-by-splits': asSet(excluded(n, tsSplit(p, { sizeBySplits: true }))),
				'no-max-train': p.maxTrain === null ? null : asSet(excluded(n, tsSplit(p, { noMax: true })))
			},
			probe: { kind: 'ts', ...p }
		};
	}
	if (classId === 'nested') {
		const outer = rng.int(3, 4);
		const inner = rng.int(2, 3);
		const n = outer * rng.int(3, 5) + rng.int(0, outer - 1);
		const i = rng.int(1, outer - 1);
		const j = rng.int(1, inner);
		const outerVal = new Set(kfold(n, outer, i - 1));
		const trainIdx = range(0, n).filter((x) => !outerVal.has(x));
		const positions = kfold(trainIdx.length, inner, j - 1);
		return {
			markdown: [
				`В выборке \`X\` (DataFrame) ${n} строк с индексами 0…${n - 1}. Гиперпараметры подбирают вложенной кросс-валидацией:`,
				'',
				`Какие строки \`X\` (по исходным индексам 0…${n - 1}) составят \`X_tr.iloc[in_val]\` на внешней итерации ${i} и внутренней итерации ${j} (итерации считаются с 1)?`,
				'',
				SET_RULE
			].join('\n'),
			code: [
				'from sklearn.model_selection import KFold',
				'',
				`outer = KFold(n_splits=${outer}, shuffle=False)`,
				`inner = KFold(n_splits=${inner}, shuffle=False)`,
				'for i, (train_idx, val_idx) in enumerate(outer.split(X), start=1):',
				'    X_tr = X.iloc[train_idx]',
				'    for j, (in_train, in_val) in enumerate(inner.split(X_tr), start=1):',
				'        ...  # подбор на X_tr.iloc[in_train], оценка на X_tr.iloc[in_val]'
			].join('\n'),
			answer: asSet(positions.map((p) => trainIdx[p] ?? -1)),
			wrong: { positions: asSet(positions), 'inner-on-all': asSet(kfold(n, inner, j - 1)) },
			probe: { kind: 'nested', n, outer, inner, i, j }
		};
	}
	const k = rng.int(3, 4);
	const names = users(rng, rng.int(5, 7));
	const n = k * rng.int(3, 4) + rng.int(0, k - 1);
	const rows = range(0, n).map(() => rng.pick(names));
	const f = rng.int(1, k);
	const val = new Set(kfold(n, k, f - 1));
	const answer = asSet(
		[...new Set(rows.filter((_, i) => val.has(i)))].filter((u) => rows.some((x, i) => x === u && !val.has(i)))
	);
	const equalVal = new Set(kfold(n, k, f - 1, 'equal'));
	return {
		markdown: [
			'Таблица `df` событий (индекс — номер строки, `user` — пользователь); у пользователя может быть несколько строк:',
			'',
			frameMarkdown(
				['row', 'user'],
				rows.map((u, i): Cell[] => [i, u])
			),
			'',
			'Модель оценивают так:',
			'',
			`Какие пользователи на итерации ${f} (итерации считаются с 1) окажутся одновременно в обучающей и в валидационной части?`,
			'',
			SET_RULE
		].join('\n'),
		code: [
			'from sklearn.model_selection import KFold',
			'',
			`cv = KFold(n_splits=${k}, shuffle=False)`,
			'for i, (train_idx, val_idx) in enumerate(cv.split(df), start=1):',
			'    ...'
		].join('\n'),
		answer,
		wrong: {
			'val-users': asSet([...new Set(rows.filter((_, i) => val.has(i)))]),
			'equal-folds':
				n % k === 0
					? null
					: asSet(
							[...new Set(rows.filter((_, i) => equalVal.has(i)))].filter((u) =>
								rows.some((x, i) => x === u && !equalVal.has(i))
							)
						)
		},
		probe: { kind: 'group-leak', rows, k, f }
	};
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
kind = p["kind"]

def kfold_val(n, k, f):
    sizes = [n // k] * k
    for i in range(n % k):
        sizes[i] += 1
    start = sum(sizes[:f])
    return list(range(start, start + sizes[f]))

def ts(n, splits, gap, max_train, f):
    size = n // (splits + 1)
    start = n - (splits - f + 1) * size
    end = start - gap
    first = 0 if max_train is None else max(0, end - max_train)
    return list(range(first, end)), list(range(start, start + size))

if kind == "kfold":
    result = kfold_val(p["n"], p["k"], p["f"] - 1)
elif kind == "group":
    counts = {}
    for g in p["groups"]:
        counts[g] = counts.get(g, 0) + 1
    load = [0] * p["k"]
    fold = {}
    for g in sorted(counts, key=lambda g: -counts[g]):
        best = min(range(p["k"]), key=lambda i: (load[i], i))
        load[best] += counts[g]
        fold[g] = best
    result = [i for i, g in enumerate(p["groups"]) if fold[g] == p["f"] - 1]
elif kind == "timeseries":
    result = ts(p["n"], p["splits"], 0, None, p["f"])[1]
elif kind == "stratified":
    labels, k = p["labels"], p["k"]
    order = []
    for y in labels:
        if y not in order:
            order.append(y)
    listed = [y for c in order for y in labels if y == c]
    fold_of = {}
    for c in order:
        quota = [sum(1 for pos, y in enumerate(listed) if y == c and pos % k == f) for f in range(k)]
        rows = [i for i, y in enumerate(labels) if y == c]
        it = iter(rows)
        for f in range(k):
            for _ in range(quota[f]):
                fold_of[next(it)] = f
    result = [i for i in range(len(labels)) if fold_of[i] == p["f"] - 1]
elif kind == "ts":
    train, val = ts(p["n"], p["splits"], p["gap"], p["maxTrain"], p["f"])
    used = set(train) | set(val)
    result = [i for i in range(p["n"]) if i not in used]
elif kind == "nested":
    outer_val = set(kfold_val(p["n"], p["outer"], p["i"] - 1))
    train_idx = [i for i in range(p["n"]) if i not in outer_val]
    result = [train_idx[q] for q in kfold_val(len(train_idx), p["inner"], p["j"] - 1)]
else:
    rows = p["rows"]
    val = set(kfold_val(len(rows), p["k"], p["f"] - 1))
    in_val = {u for i, u in enumerate(rows) if i in val}
    in_train = {u for i, u in enumerate(rows) if i not in val}
    result = sorted(in_val & in_train)
print("\\n".join(str(x) for x in result) if result else "-")
`;

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 300; tries += 1) {
		const task = input.grade === 'junior' ? juniorTask(rng, input.classId) : middleTask(rng, input.classId);
		if (task === null) continue;
		// Every misconception of the class must change the answer on the instance.
		if (Object.values(task.wrong).some((w) => w !== null && same(w, task.answer))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: task.markdown, code: { language: 'python3', source: task.code } },
			answer: { kind: 'set', value: task.answer }
		});
		const all = Object.fromEntries(descriptor.wrongSolutions.map((w) => [w.id, task.wrong[w.id] ?? null]));
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: stdinJson(task.probe) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(all).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
