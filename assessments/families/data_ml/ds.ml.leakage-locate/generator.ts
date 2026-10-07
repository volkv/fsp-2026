// A module of a training pipeline in plain Python: functions that prepare data and validate a model, each with its
// specification in the docstring; exactly one line breaks its function's specification and leaks information the model
// must not see — test statistics, the target, the future, the folds being validated. The candidate names that line.
// The kind of leak is the essential class; the other functions, their order and the module header are surface.
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

/** A defect given by the line it replaces and a plausible edit of a neighbouring line that does not repair it. */
interface DefectSpec {
	kind: string;
	from: string;
	to: string;
	near: string;
	nearTo: string;
}

/** A function of the module: its lines, the checks of its specification and its possible defects. */
interface Fn {
	lines: string[];
	/** Python statements, each raising when the specification is broken. */
	checks: string[];
	defects: { kind: string; line: number; text: string; neighbour: { line: number; text: string } }[];
}

function fn(lines: string[], checks: string[], defects: DefectSpec[]): Fn {
	const at = (text: string): number => {
		const i = lines.indexOf(text);
		if (i < 0) throw new Error(`${descriptor.key}: no line ${JSON.stringify(text)} in ${lines[0] ?? ''}`);
		return i;
	};
	return {
		lines,
		checks,
		defects: defects.map((d) => ({
			kind: d.kind,
			line: at(d.from),
			text: d.to,
			neighbour: { line: at(d.near), text: d.nearTo }
		}))
	};
}

const MIDDLE: Fn[] = [
	fn(
		[
			'def standardize(train, test):',
			'    """Масштабирует списки чисел: среднее и стандартное отклонение (деление на n) — только по train.',
			'    Пара списков (train, test) после масштабирования."""',
			'    mean = sum(train) / len(train)',
			'    std = (sum((x - mean) ** 2 for x in train) / len(train)) ** 0.5',
			'    return [(x - mean) / std for x in train], [(x - mean) / std for x in test]'
		],
		[
			'tr, te = standardize([1.0, 2.0, 3.0], [10.0])',
			'assert abs(te[0] - 8 / (2 / 3) ** 0.5) < 1e-9 and abs(tr[0] + 1 / (2 / 3) ** 0.5) < 1e-9'
		],
		[
			{
				kind: 'fit-on-all',
				from: '    mean = sum(train) / len(train)',
				to: '    mean = sum(train + test) / (len(train) + len(test))',
				near: '    std = (sum((x - mean) ** 2 for x in train) / len(train)) ** 0.5',
				nearTo: '    std = max(1e-12, (sum((x - mean) ** 2 for x in train) / len(train)) ** 0.5)'
			},
			{
				kind: 'fit-on-all',
				from: '    std = (sum((x - mean) ** 2 for x in train) / len(train)) ** 0.5',
				to: '    std = (sum((x - mean) ** 2 for x in train + test) / (len(train) + len(test))) ** 0.5',
				near: '    mean = sum(train) / len(train)',
				nearTo: '    mean = sum(train) / max(len(train), 1)'
			}
		]
	),
	fn(
		[
			'def impute_median(train, test):',
			'    """Заменяет None медианой известных значений train. Пара списков (train, test)."""',
			'    known = sorted(x for x in train if x is not None)',
			'    mid = len(known) // 2',
			'    median = known[mid] if len(known) % 2 else (known[mid - 1] + known[mid]) / 2',
			'    return [median if x is None else x for x in train], [median if x is None else x for x in test]'
		],
		[
			'assert impute_median([1, None, 5, 3], [100, None]) == ([1, 3, 5, 3], [100, 3])',
			'assert impute_median([2, None, 4], [10, None]) == ([2, 3, 4], [10, 3])'
		],
		[
			{
				kind: 'fit-on-all',
				from: '    known = sorted(x for x in train if x is not None)',
				to: '    known = sorted(x for x in train + test if x is not None)',
				near: '    mid = len(known) // 2',
				nearTo: '    mid = len(known) >> 1'
			}
		]
	),
	fn(
		[
			'def minmax_bounds(train, test):',
			'    """Границы MinMax-масштабирования признака — только по train: пара (min, max). test не используется."""',
			'    low = min(train)',
			'    high = max(train)',
			'    return low, high'
		],
		['assert minmax_bounds([4, 9, 2], [15, 1]) == (2, 9)'],
		[
			{
				kind: 'fit-on-all',
				from: '    high = max(train)',
				to: '    high = max(train + test)',
				near: '    low = min(train)',
				nearTo: '    low = min(sorted(train))'
			},
			{
				kind: 'fit-on-all',
				from: '    low = min(train)',
				to: '    low = min(train + test)',
				near: '    return low, high',
				nearTo: '    return (low, high)'
			}
		]
	),
	fn(
		[
			'def time_split(rows, test_size):',
			'    """rows — словари с ключом "ts". Последние по времени test_size строк — test, остальные — train;',
			'    обе части упорядочены по времени. Пара (train, test)."""',
			'    ordered = sorted(rows, key=lambda r: r["ts"])',
			'    cut = len(ordered) - test_size',
			'    return ordered[:cut], ordered[cut:]'
		],
		[
			'tr, te = time_split([{"ts": 3}, {"ts": 1}, {"ts": 4}, {"ts": 2}], 1)',
			'assert [r["ts"] for r in tr] == [1, 2, 3] and [r["ts"] for r in te] == [4]'
		],
		[
			{
				kind: 'split-order',
				from: '    ordered = sorted(rows, key=lambda r: r["ts"])',
				to: '    ordered = list(rows)',
				near: '    cut = len(ordered) - test_size',
				nearTo: '    cut = len(rows) - test_size'
			},
			{
				kind: 'split-order',
				from: '    ordered = sorted(rows, key=lambda r: r["ts"])',
				to: '    ordered = sorted(rows, key=lambda r: r["ts"], reverse=True)',
				near: '    return ordered[:cut], ordered[cut:]',
				nearTo: '    return list(ordered[:cut]), list(ordered[cut:])'
			}
		]
	),
	fn(
		[
			'def dedup_then_split(rows, test_ids):',
			'    """rows — словари с ключами "id" и "text". Сначала убирает повторы текста (остаётся первая строка),',
			'    затем строки с id из test_ids — в test, остальные — в train. Пара (train, test)."""',
			'    seen = set()',
			'    unique = []',
			'    for row in rows:',
			'        if row["text"] not in seen:',
			'            seen.add(row["text"])',
			'            unique.append(row)',
			'    train = [r for r in unique if r["id"] not in test_ids]',
			'    test = [r for r in unique if r["id"] in test_ids]',
			'    return train, test'
		],
		[
			'rows = [{"id": 1, "text": "a"}, {"id": 2, "text": "b"}, {"id": 3, "text": "a"}, {"id": 4, "text": "c"}]',
			'tr, te = dedup_then_split(rows, {1})',
			'assert [r["id"] for r in tr] == [2, 4] and [r["id"] for r in te] == [1]'
		],
		[
			{
				kind: 'split-order',
				from: '    train = [r for r in unique if r["id"] not in test_ids]',
				to: '    train = [r for r in rows if r["id"] not in test_ids]',
				near: '    test = [r for r in unique if r["id"] in test_ids]',
				nearTo: '    test = [r for r in unique if r["id"] in set(test_ids)]'
			}
		]
	),
	fn(
		[
			'def oversample_train(train, test):',
			'    """train, test — списки пар (x, y). Дублирует каждую строку train с y = 1 ещё раз; test не меняется.',
			'    Пара (train, test)."""',
			'    boosted = train + [row for row in train if row[1] == 1]',
			'    return boosted, list(test)'
		],
		['assert oversample_train([(1, 0), (2, 1)], [(3, 1)]) == ([(1, 0), (2, 1), (2, 1)], [(3, 1)])'],
		[
			{
				kind: 'split-order',
				from: '    boosted = train + [row for row in train if row[1] == 1]',
				to: '    boosted = train + [row for row in train + test if row[1] == 1]',
				near: '    return boosted, list(test)',
				nearTo: '    return list(boosted), list(test)'
			}
		]
	),
	fn(
		[
			'def loo_encoding(categories, targets):',
			'    """Значение строки — среднее target по остальным строкам её категории (без самой строки);',
			'    если других строк категории нет — None."""',
			'    sums, counts = {}, {}',
			'    for c, y in zip(categories, targets):',
			'        sums[c] = sums.get(c, 0) + y',
			'        counts[c] = counts.get(c, 0) + 1',
			'    result = []',
			'    for c, y in zip(categories, targets):',
			'        n = counts[c] - 1',
			'        result.append((sums[c] - y) / n if n else None)',
			'    return result'
		],
		['assert loo_encoding(["a", "a", "b", "a"], [1, 0, 1, 1]) == [0.5, 1.0, None, 0.5]'],
		[
			{
				kind: 'target-in-features',
				from: '        result.append((sums[c] - y) / n if n else None)',
				to: '        result.append(sums[c] / counts[c] if n else None)',
				near: '        n = counts[c] - 1',
				nearTo: '        n = counts.get(c, 1) - 1'
			}
		]
	),
	fn(
		[
			'def add_features(rows):',
			'    """rows — словари с ключами "clicks", "views" и меткой "bought". Кортежи признаков',
			'    (clicks, views, ctr), ctr = clicks / views (0.0 при views = 0); метка в признаки не входит."""',
			'    out = []',
			'    for r in rows:',
			'        ctr = r["clicks"] / r["views"] if r["views"] else 0.0',
			'        out.append((r["clicks"], r["views"], ctr))',
			'    return out'
		],
		[
			'rows = [{"clicks": 2, "views": 4, "bought": 1}, {"clicks": 0, "views": 0, "bought": 0}]',
			'assert add_features(rows) == [(2, 4, 0.5), (0, 0, 0.0)]'
		],
		[
			{
				kind: 'target-in-features',
				from: '        out.append((r["clicks"], r["views"], ctr))',
				to: '        out.append((r["clicks"], r["views"], ctr, r["bought"]))',
				near: '        ctr = r["clicks"] / r["views"] if r["views"] else 0.0',
				nearTo: '        ctr = r["clicks"] / r["views"] if r["views"] > 0 else 0.0'
			},
			{
				kind: 'target-in-features',
				from: '        ctr = r["clicks"] / r["views"] if r["views"] else 0.0',
				to: '        ctr = r["bought"] / r["views"] if r["views"] else 0.0',
				near: '        out.append((r["clicks"], r["views"], ctr))',
				nearTo: '        out.append(tuple([r["clicks"], r["views"], ctr]))'
			}
		]
	),
	fn(
		[
			'def feature_columns(columns, target):',
			'    """Признаки — все столбцы, кроме target и производных от него (имя начинается с target + "_")."""',
			'    return [c for c in columns if c != target and not c.startswith(target + "_")]'
		],
		['assert feature_columns(["age", "churn", "churn_prob", "visits"], "churn") == ["age", "visits"]'],
		[
			{
				kind: 'target-in-features',
				from: '    return [c for c in columns if c != target and not c.startswith(target + "_")]',
				to: '    return [c for c in columns if c != target]',
				near: 'def feature_columns(columns, target):',
				nearTo: 'def feature_columns(columns, target="target"):'
			}
		]
	),
	fn(
		[
			'def lag_feature(values, k):',
			'    """values — ряд по времени. Признак строки i — значение k шагов назад, values[i - k];',
			'    для первых k строк — None."""',
			'    return [values[i - k] if i >= k else None for i in range(len(values))]'
		],
		['assert lag_feature([5, 6, 7, 8], 2) == [None, None, 5, 6]'],
		[
			{
				kind: 'future-data',
				from: '    return [values[i - k] if i >= k else None for i in range(len(values))]',
				to: '    return [values[i + k] if i + k < len(values) else None for i in range(len(values))]',
				near: 'def lag_feature(values, k):',
				nearTo: 'def lag_feature(values, k=1):'
			}
		]
	),
	fn(
		[
			'def rolling_prev_mean(values, w):',
			'    """Признак строки i — среднее w предыдущих значений values[i - w : i] (текущее не входит);',
			'    при i < w — None."""',
			'    out = []',
			'    for i in range(len(values)):',
			'        window = values[i - w:i]',
			'        out.append(sum(window) / w if i >= w else None)',
			'    return out'
		],
		['assert rolling_prev_mean([2, 4, 6, 8], 2) == [None, None, 3.0, 5.0]'],
		[
			{
				kind: 'future-data',
				from: '        window = values[i - w:i]',
				to: '        window = values[i - w + 1:i + 1]',
				near: '        out.append(sum(window) / w if i >= w else None)',
				nearTo: '        out.append(sum(window) / len(window) if i >= w else None)'
			}
		]
	),
	fn(
		[
			'def past_purchases(events):',
			'    """events — пары (user, bought) по времени, bought — 0 или 1. Признак события — сколько покупок было',
			'    у пользователя до него (само событие не считается)."""',
			'    count = {}',
			'    out = []',
			'    for user, bought in events:',
			'        out.append(count.get(user, 0))',
			'        count[user] = count.get(user, 0) + bought',
			'    return out'
		],
		['assert past_purchases([("a", 1), ("b", 0), ("a", 1), ("a", 0)]) == [0, 0, 1, 2]'],
		[
			{
				kind: 'future-data',
				from: '        out.append(count.get(user, 0))',
				to: '        out.append(count.get(user, 0) + bought)',
				near: '        count[user] = count.get(user, 0) + bought',
				nearTo: '        count[user] = count.get(user, 0) + int(bought)'
			}
		]
	)
];

const SENIOR: Fn[] = [
	fn(
		[
			'def select_features(rows, folds, k):',
			'    """rows — пары (x, y): x — словарь признак -> число, y — 0 или 1; folds — номер фолда каждой строки.',
			'    Для каждого фолда f — k признаков с наибольшей |mean(x | y = 1) - mean(x | y = 0)|, посчитанной',
			'    только по строкам других фолдов (при равенстве — по имени). Словарь: фолд -> список признаков по имени."""',
			'    result = {}',
			'    for f in sorted(set(folds)):',
			'        train = [row for row, g in zip(rows, folds) if g != f]',
			'        def gap(name):',
			'            pos = [x[name] for x, y in train if y == 1]',
			'            neg = [x[name] for x, y in train if y == 0]',
			'            return abs(sum(pos) / len(pos) - sum(neg) / len(neg))',
			'        names = sorted(rows[0][0], key=lambda n: (-gap(n), n))',
			'        result[f] = sorted(names[:k])',
			'    return result'
		],
		[
			'rows = [({"a": 9, "b": 0}, 1), ({"a": 0, "b": 0}, 0), ({"a": 1, "b": 5}, 1), ({"a": 1, "b": 0}, 0),',
			'        ({"a": 2, "b": 5}, 1), ({"a": 1, "b": 1}, 0)]',
			'assert select_features(rows, [0, 0, 1, 1, 2, 2], 1) == {0: ["b"], 1: ["a"], 2: ["a"]}'
		],
		[
			{
				kind: 'selection-before-cv',
				from: '        train = [row for row, g in zip(rows, folds) if g != f]',
				to: '        train = list(rows)',
				near: '        names = sorted(rows[0][0], key=lambda n: (-gap(n), n))',
				nearTo: '        names = sorted(train[0][0], key=lambda n: (-gap(n), n))'
			}
		]
	),
	fn(
		[
			'def cv_scaled_means(values, folds):',
			'    """Для каждого фолда f — среднее значений фолда f после стандартизации параметрами (среднее,',
			'    отклонение с делением на n), посчитанными только по другим фолдам. Словарь: фолд -> среднее."""',
			'    result = {}',
			'    for f in sorted(set(folds)):',
			'        fit = [v for v, g in zip(values, folds) if g != f]',
			'        mean = sum(fit) / len(fit)',
			'        std = (sum((v - mean) ** 2 for v in fit) / len(fit)) ** 0.5',
			'        held = [(v - mean) / std for v, g in zip(values, folds) if g == f]',
			'        result[f] = sum(held) / len(held)',
			'    return result'
		],
		[
			'cs = cv_scaled_means([1.0, 2.0, 3.0, 4.0, 10.0, 6.0], [0, 0, 1, 1, 2, 2])',
			'assert abs(cs[0] - (1.5 - 5.75) / (sum((v - 5.75) ** 2 for v in [3, 4, 10, 6]) / 4) ** 0.5) < 1e-9'
		],
		[
			{
				kind: 'selection-before-cv',
				from: '        fit = [v for v, g in zip(values, folds) if g != f]',
				to: '        fit = list(values)',
				near: '        mean = sum(fit) / len(fit)',
				nearTo: '        mean = sum(fit) / max(len(fit), 1)'
			}
		]
	),
	fn(
		[
			'def cv_impute(values, folds):',
			'    """Для каждого фолда f — значения фолда f, где None заменён средним известных значений других',
			'    фолдов. Словарь: фолд -> список."""',
			'    result = {}',
			'    for f in sorted(set(folds)):',
			'        known = [v for v, g in zip(values, folds) if g != f and v is not None]',
			'        fill = sum(known) / len(known)',
			'        result[f] = [fill if v is None else v for v, g in zip(values, folds) if g == f]',
			'    return result'
		],
		[
			'ci = cv_impute([1, None, 5, 7, None, 3], [0, 0, 1, 1, 2, 2])',
			'assert ci[0] == [1, 5.0] and ci[1] == [5, 7] and abs(ci[2][0] - 13 / 3) < 1e-9'
		],
		[
			{
				kind: 'selection-before-cv',
				from: '        known = [v for v, g in zip(values, folds) if g != f and v is not None]',
				to: '        known = [v for v in values if v is not None]',
				near: '        fill = sum(known) / len(known)',
				nearTo: '        fill = sum(known) / float(len(known))'
			}
		]
	),
	fn(
		[
			'def oof_target_encoding(categories, targets, folds):',
			'    """Out-of-fold кодирование: значение строки — среднее target её категории по строкам других фолдов;',
			'    если там категории нет — prior, среднее target по всем строкам других фолдов."""',
			'    out = []',
			'    for c, f in zip(categories, folds):',
			'        other = [(cc, y) for cc, y, g in zip(categories, targets, folds) if g != f]',
			'        ys = [y for cc, y in other if cc == c]',
			'        prior = sum(y for _, y in other) / len(other)',
			'        out.append(sum(ys) / len(ys) if ys else prior)',
			'    return out'
		],
		[
			'assert oof_target_encoding(["a", "a", "b", "b", "c"], [1, 0, 1, 1, 0], [0, 1, 0, 1, 1]) == [0.0, 1.0, 1.0, 1.0, 1.0]'
		],
		[
			{
				kind: 'oof-encoding',
				from: '        other = [(cc, y) for cc, y, g in zip(categories, targets, folds) if g != f]',
				to: '        other = [(cc, y) for cc, y, g in zip(categories, targets, folds)]',
				near: '        ys = [y for cc, y in other if cc == c]',
				nearTo: '        ys = [y for cc, y in other if cc == c and y is not None]'
			},
			{
				kind: 'oof-encoding',
				from: '        prior = sum(y for _, y in other) / len(other)',
				to: '        prior = sum(targets) / len(targets)',
				near: '        out.append(sum(ys) / len(ys) if ys else prior)',
				nearTo: '        out.append(sum(ys) / len(ys) if len(ys) > 0 else prior)'
			}
		]
	),
	fn(
		[
			'def smoothed_encoding(train_cats, train_y, test_cats, test_y, m):',
			'    """Кодирование категорий test: (сумма target категории + m * prior) / (число её строк + m) по train,',
			'    prior — среднее train_y. test_y нужны только для оценки качества и в кодирование не входят."""',
			'    prior = sum(train_y) / len(train_y)',
			'    stats = {}',
			'    for c, y in zip(train_cats, train_y):',
			'        s, n = stats.get(c, (0, 0))',
			'        stats[c] = (s + y, n + 1)',
			'    encoded = []',
			'    for c in test_cats:',
			'        s, n = stats.get(c, (0, 0))',
			'        encoded.append((s + m * prior) / (n + m))',
			'    return encoded'
		],
		[
			'se = smoothed_encoding(["a", "a", "b"], [1, 0, 1], ["a", "c"], [1, 0], 1)',
			'assert abs(se[0] - (1 + 2 / 3) / 3) < 1e-9 and abs(se[1] - 2 / 3) < 1e-9'
		],
		[
			{
				kind: 'oof-encoding',
				from: '    for c, y in zip(train_cats, train_y):',
				to: '    for c, y in zip(train_cats + test_cats, train_y + test_y):',
				near: '    stats = {}',
				nearTo: '    stats = dict()'
			},
			{
				kind: 'oof-encoding',
				from: '    prior = sum(train_y) / len(train_y)',
				to: '    prior = sum(train_y + test_y) / (len(train_y) + len(test_y))',
				near: '        encoded.append((s + m * prior) / (n + m))',
				nearTo: '        encoded.append((s + m * prior) / float(n + m))'
			}
		]
	),
	fn(
		[
			'def choose_alpha(scores):',
			'    """scores — словарь alpha -> (val_score, test_score). Выбирает alpha с наибольшим val_score',
			'    (при равенстве — меньший alpha); пара (alpha, test_score выбранного)."""',
			'    best = max(sorted(scores), key=lambda a: scores[a][0])',
			'    return best, scores[best][1]'
		],
		['assert choose_alpha({0.1: (0.8, 0.7), 1.0: (0.9, 0.6), 10.0: (0.85, 0.95)}) == (1.0, 0.6)'],
		[
			{
				kind: 'tuning-on-test',
				from: '    best = max(sorted(scores), key=lambda a: scores[a][0])',
				to: '    best = max(sorted(scores), key=lambda a: scores[a][1])',
				near: '    return best, scores[best][1]',
				nearTo: '    return best, scores.get(best)[1]'
			}
		]
	),
	fn(
		[
			'def best_epoch(history):',
			'    """history — пары (val_loss, test_loss) по эпохам. Номер эпохи (с 1) с наименьшим val_loss',
			'    (при равенстве — более ранней) и test_loss на ней."""',
			'    epoch = min(range(len(history)), key=lambda i: history[i][0])',
			'    return epoch + 1, history[epoch][1]'
		],
		['assert best_epoch([(0.5, 0.6), (0.4, 0.55), (0.45, 0.3), (0.4, 0.5)]) == (2, 0.55)'],
		[
			{
				kind: 'tuning-on-test',
				from: '    epoch = min(range(len(history)), key=lambda i: history[i][0])',
				to: '    epoch = min(range(len(history)), key=lambda i: history[i][1])',
				near: '    return epoch + 1, history[epoch][1]',
				nearTo: '    return epoch + 1, history[epoch][-1]'
			}
		]
	),
	fn(
		[
			'def pick_model(model_scores):',
			'    """model_scores — словарь имя -> (cv_score, holdout_score). Лучшая модель — по cv_score (при равенстве —',
			'    первая по имени); пара (имя, её holdout_score)."""',
			'    name = max(sorted(model_scores), key=lambda m: model_scores[m][0])',
			'    return name, model_scores[name][1]'
		],
		['assert pick_model({"gbm": (0.81, 0.7), "lr": (0.78, 0.9), "rf": (0.81, 0.75)}) == ("gbm", 0.7)'],
		[
			{
				kind: 'tuning-on-test',
				from: '    name = max(sorted(model_scores), key=lambda m: model_scores[m][0])',
				to: '    name = max(sorted(model_scores), key=lambda m: model_scores[m][1])',
				near: '    return name, model_scores[name][1]',
				nearTo: '    return str(name), model_scores[name][1]'
			}
		]
	),
	fn(
		[
			'def purged_train(days, val_start, val_end, horizon):',
			'    """Метка дня t считается по дням t + 1 … t + horizon. Дни обучения для валидации [val_start, val_end]:',
			'    все дни вне неё, кроме тех, чьё окно метки заходит в валидацию."""',
			'    return [t for t in days if t < val_start - horizon or t > val_end]'
		],
		['assert purged_train(list(range(1, 13)), 6, 8, 2) == [1, 2, 3, 9, 10, 11, 12]'],
		[
			{
				kind: 'temporal-purge',
				from: '    return [t for t in days if t < val_start - horizon or t > val_end]',
				to: '    return [t for t in days if t < val_start or t > val_end]',
				near: 'def purged_train(days, val_start, val_end, horizon):',
				nearTo: 'def purged_train(days, val_start, val_end, horizon=1):'
			},
			{
				kind: 'temporal-purge',
				from: '    return [t for t in days if t < val_start - horizon or t > val_end]',
				to: '    return [t for t in days if t <= val_start - horizon or t > val_end]',
				near: 'def purged_train(days, val_start, val_end, horizon):',
				nearTo: 'def purged_train(days, val_start, val_end, horizon=0):'
			}
		]
	),
	fn(
		[
			'def embargoed_train(days, val_start, val_end, embargo):',
			'    """Дни обучения вокруг валидации [val_start, val_end]: все дни вне неё, кроме embargo дней',
			'    сразу после val_end."""',
			'    return [t for t in days if t < val_start or t > val_end + embargo]'
		],
		['assert embargoed_train(list(range(1, 11)), 4, 5, 2) == [1, 2, 3, 8, 9, 10]'],
		[
			{
				kind: 'temporal-purge',
				from: '    return [t for t in days if t < val_start or t > val_end + embargo]',
				to: '    return [t for t in days if t < val_start - embargo or t > val_end]',
				near: 'def embargoed_train(days, val_start, val_end, embargo):',
				nearTo: 'def embargoed_train(days, val_start, val_end, embargo=1):'
			}
		]
	),
	fn(
		[
			'def known_target_feature(values, horizon):',
			'    """values[t] — цель дня t (t с 0); она становится известна в день t + horizon. Признак дня t —',
			'    последнее значение цели, известное к дню t включительно, или None."""',
			'    return [values[t - horizon] if t >= horizon else None for t in range(len(values))]'
		],
		['assert known_target_feature([3, 5, 7, 9], 2) == [None, None, 3, 5]'],
		[
			{
				kind: 'temporal-purge',
				from: '    return [values[t - horizon] if t >= horizon else None for t in range(len(values))]',
				to: '    return [values[t - 1] if t >= 1 else None for t in range(len(values))]',
				near: 'def known_target_feature(values, horizon):',
				nearTo: 'def known_target_feature(values, horizon=1):'
			}
		]
	)
];

const MODULE_TITLES = [
	'Подготовка данных для модели оттока',
	'Конвейер обучения скоринговой модели',
	'Признаки и валидация для модели спроса',
	'Обучение модели рекомендаций: данные и проверка'
];
const OPTIONAL_IMPORTS = ['import math', 'import logging', 'import random'];
const HEADER_CONSTANTS = ['SEED = 42', 'N_FOLDS = 5', 'TEST_SIZE = 0.2', 'TARGET = "label"', 'MAX_ROWS = 1_000_000'];

interface Program {
	source: string;
	check: string;
	answer: number;
	fix: string;
	neighbour: { line: number; text: string };
	other: { line: number; text: string };
}

function compose(rng: Rng, library: readonly Fn[], kind: string, contextCount: number): Program {
	const candidates = library.flatMap((f) => f.defects.filter((d) => d.kind === kind).map((defect) => ({ f, defect })));
	const { f: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((f) => f !== buggy),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	// A module header of random length, so the defect's line number carries no hint.
	const imports = rng.sample(OPTIONAL_IMPORTS, rng.int(0, 2));
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 3));
	const lines: string[] = [
		`"""${rng.pick(MODULE_TITLES)}."""`,
		...(imports.length ? ['', ...imports.sort()] : []),
		...(constants.length ? ['', ...constants] : []),
		'',
		''
	];
	let answer = 0;
	let neighbour = { line: 0, text: '' };
	let other = { line: 0, text: '' };
	for (const f of order) {
		const offset = lines.length;
		f.lines.forEach((line, i) => lines.push(f === buggy && i === defect.line ? defect.text : line));
		if (f === buggy) {
			answer = offset + defect.line + 1;
			neighbour = { line: offset + defect.neighbour.line + 1, text: defect.neighbour.text };
		} else if (other.line === 0) {
			const sibling = f.defects[0];
			if (sibling) other = { line: offset + sibling.line + 1, text: sibling.text };
		}
		lines.push('', '');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	const fix = buggy.lines[defect.line] ?? '';
	const checks = order.flatMap((f) => f.checks);
	const check = [
		'def _spec():',
		...checks.map((c) => `    ${c}`),
		'',
		'try:',
		'    _spec()',
		"    print('ok')",
		'except Exception as exc:',
		"    print('fail', type(exc).__name__)"
	].join('\n');
	return { source: lines.join('\n'), check, answer, fix, neighbour, other };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const p = input.grade === 'middle' ? compose(rng, MIDDLE, input.classId, 4) : compose(rng, SENIOR, input.classId, 5);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль конвейера обучения модели на Python 3. У каждой функции в строке документации записана её ' +
				'спецификация. Ровно одна строка модуля нарушает спецификацию своей функции и тем самым пропускает в ' +
				'обучение или в признаки информацию, которой там быть не должно: если заменить только её, все функции ' +
				'будут работать по спецификации. Введите номер этой строки (нумерация с 1).',
			code: { language: 'python3', source: p.source }
		},
		answer: { kind: 'line_no', value: p.answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'bug', check: p.check, fix: p.fix }),
		wrong: () => ({
			'neighbour-line': { kind: 'line', line: p.neighbour.line, replacement: p.neighbour.text },
			'other-function': p.other.line === 0 ? null : { kind: 'line', line: p.other.line, replacement: p.other.text }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
