// A module of data preparation for a model: functions that aggregate, fill, parse, join, scale, split and encode
// tables, each with its specification in the docstring; the module has one defect. The candidate names its line (any
// line where a one-instruction replacement restores the specification counts). The kind of defect is the essential
// class; the other functions, their order and the module header are surface.
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

/** A defect of a function (0-based lines): the replaced line, a plausible but wrong neighbouring change, and other lines
 * where a one-instruction replacement also restores the specification. */
interface Defect {
	kind: string;
	line: number;
	text: string;
	neighbour: { line: number; text: string };
	alternatives?: { line: number; text: string }[];
}

/** A function of the module: its lines, the checks of its specification and its possible defects. */
interface Fn {
	lines: string[];
	/** Python statements, each raising when the specification is broken. */
	checks: string[];
	defects: Defect[];
}

const JUNIOR: Fn[] = [
	{
		lines: [
			'def mean_by_key(rows, key, field):',
			'    """rows — словари с полями key и field. Словарь: значение key -> среднее field по строкам, где field не None; ключ без значений в результат не попадает."""',
			'    sums, counts = {}, {}',
			'    for row in rows:',
			'        value = row[field]',
			'        if value is None:',
			'            continue',
			'        k = row[key]',
			'        sums[k] = sums.get(k, 0) + value',
			'        counts[k] = counts.get(k, 0) + 1',
			'    return {k: sums[k] / counts[k] for k in sums}'
		],
		checks: [
			'assert mean_by_key([{"g": "a", "v": 2}, {"g": "a", "v": None}, {"g": "b", "v": 5}, {"g": "a", "v": 4}], "g", "v") == {"a": 3.0, "b": 5.0}',
			'assert mean_by_key([{"g": "c", "v": None}], "g", "v") == {}'
		],
		defects: [
			{
				kind: 'aggregation',
				line: 9,
				text: '        counts[k] = counts.get(k, 1) + 1',
				neighbour: { line: 7, text: '        k = str(row[key])' },
				alternatives: [{ line: 10, text: '    return {k: sums[k] / (counts[k] - 1) for k in sums}' }]
			},
			{
				kind: 'missing',
				line: 5,
				text: '        if value == 0:',
				neighbour: { line: 4, text: '        value = row.get(field)' }
			}
		]
	},
	{
		lines: [
			'def count_distinct(rows, key, field):',
			'    """rows — словари с полями key и field. Словарь: значение key -> число различных значений field, кроме None; ключ без значений в результат не попадает."""',
			'    seen = {}',
			'    for row in rows:',
			'        if row[field] is None:',
			'            continue',
			'        seen.setdefault(row[key], set()).add(row[field])',
			'    return {k: len(v) for k, v in seen.items()}'
		],
		checks: [
			'assert count_distinct([{"u": "a", "i": "x"}, {"u": "a", "i": "x"}, {"u": "a", "i": None}, {"u": "b", "i": "y"}, {"u": "a", "i": "z"}], "u", "i") == {"a": 2, "b": 1}',
			'assert count_distinct([{"u": "c", "i": None}], "u", "i") == {}'
		],
		defects: [
			{
				kind: 'aggregation',
				line: 6,
				text: '        seen.setdefault(row[key], []).append(row[field])',
				neighbour: { line: 4, text: '        if not row[field]:' },
				alternatives: [{ line: 7, text: '    return {k: len(set(v)) for k, v in seen.items()}' }]
			},
			{
				kind: 'missing',
				line: 4,
				text: '        if row[key] is None:',
				neighbour: { line: 7, text: '    return {k: len(set(v)) for k, v in seen.items()}' }
			}
		]
	},
	{
		lines: [
			'def parse_amount(text):',
			'    """Строка суммы вида \' 1 234,50 \': пробелы разделяют тысячи, запятая — десятичная. Число float; пустая строка или \'-\' — None."""',
			'    cleaned = text.strip()',
			'    if cleaned in ("", "-"):',
			'        return None',
			'    cleaned = cleaned.replace(" ", "").replace(",", ".")',
			'    return float(cleaned)'
		],
		checks: [
			'assert parse_amount(" 1 234,50 ") == 1234.5',
			'assert parse_amount("-") is None',
			'assert parse_amount("   ") is None',
			'assert parse_amount("7,25") == 7.25'
		],
		defects: [
			{
				kind: 'types',
				line: 5,
				text: '    cleaned = cleaned.replace(" ", "").replace(",", "")',
				neighbour: { line: 3, text: '    if cleaned == "":' }
			},
			{
				kind: 'types',
				line: 6,
				text: '    return int(float(cleaned))',
				neighbour: { line: 2, text: '    cleaned = text.strip(" ")' }
			},
			{
				kind: 'missing',
				line: 3,
				text: '    if cleaned == "":',
				neighbour: { line: 2, text: '    cleaned = text.strip(" ")' }
			}
		]
	},
	{
		lines: [
			'def to_int_column(values):',
			'    """Список: строки с целым числом (возможны пробелы по краям), пустые или пробельные строки, None. Список int; пустая или пробельная строка и None — None; \'007\' — 7."""',
			'    result = []',
			'    for v in values:',
			'        if v is None or v.strip() == "":',
			'            result.append(None)',
			'        else:',
			'            result.append(int(v))',
			'    return result'
		],
		checks: ['assert to_int_column(["10", "", None, "007", " 3 ", "  "]) == [10, None, None, 7, 3, None]'],
		defects: [
			{
				kind: 'missing',
				line: 4,
				text: '        if v is None:',
				neighbour: { line: 7, text: '            result.append(int(v.strip()))' }
			},
			{
				kind: 'types',
				line: 7,
				text: '            result.append(v.strip().lstrip("0"))',
				neighbour: { line: 3, text: '    for v in list(values):' }
			}
		]
	},
	{
		lines: [
			'def left_join(left, right, key):',
			'    """Списки словарей с полем key; в right ключ уникален, других общих полей у строк left и right нет. Для каждой строки left — её копия с добавленными полями пары из right; без пары — только поля left. Порядок left сохраняется, входные списки не меняются."""',
			'    index = {row[key]: row for row in right}',
			'    result = []',
			'    for row in left:',
			'        merged = dict(row)',
			'        match = index.get(row[key])',
			'        if match is not None:',
			'            merged.update(match)',
			'        result.append(merged)',
			'    return result'
		],
		checks: [
			'lj_left = [{"id": 1, "a": 5}, {"id": 2, "a": 6}, {"id": 3, "a": 7}]',
			'lj_right = [{"id": 3, "b": "z"}, {"id": 1, "b": "x"}]',
			'assert left_join(lj_left, lj_right, "id") == [{"id": 1, "a": 5, "b": "x"}, {"id": 2, "a": 6}, {"id": 3, "a": 7, "b": "z"}]',
			'assert lj_left[0] == {"id": 1, "a": 5}'
		],
		defects: [
			{
				kind: 'join',
				line: 6,
				text: '        match = index[row[key]]',
				neighbour: { line: 5, text: '        merged = row.copy()' }
			},
			{
				kind: 'join',
				line: 5,
				text: '        merged = row',
				neighbour: { line: 10, text: '    return list(result)' }
			}
		]
	},
	{
		lines: [
			'def join_all(left, right, key):',
			'    """Строки обеих таблиц — словари с полем key. Все пары строк с равным ключом (ключ может повторяться в обеих таблицах); None в ключе ни с чем не соединяется. Список слияний {**строка left, **строка right} в порядке left, затем right."""',
			'    groups = {}',
			'    for row in right:',
			'        if row[key] is not None:',
			'            groups.setdefault(row[key], []).append(row)',
			'    result = []',
			'    for row in left:',
			'        for match in groups.get(row[key], []):',
			'            result.append({**row, **match})',
			'    return result'
		],
		checks: [
			'ja = join_all([{"k": "a", "x": 1}, {"k": None, "x": 2}, {"k": "b", "x": 3}], [{"k": "a", "y": 1}, {"k": None, "y": 2}, {"k": "a", "y": 3}], "k")',
			'assert ja == [{"k": "a", "x": 1, "y": 1}, {"k": "a", "x": 1, "y": 3}]'
		],
		defects: [
			{
				kind: 'join',
				line: 5,
				text: '            groups[row[key]] = [row]',
				neighbour: { line: 4, text: '        if row[key]:' }
			},
			{
				kind: 'join',
				line: 4,
				text: '        if key is not None:',
				neighbour: { line: 9, text: '            result.append(dict(row, **match))' }
			}
		]
	},
	{
		lines: [
			'def fill_missing(values, default):',
			'    """Список чисел с None. Новый список, где None заменён средним непустых значений; если непустых нет — default."""',
			'    present = [v for v in values if v is not None]',
			'    if not present:',
			'        return [default for _ in values]',
			'    mean = sum(present) / len(present)',
			'    return [mean if v is None else v for v in values]'
		],
		checks: [
			'assert fill_missing([2, None, 0, 4], 9) == [2, 2.0, 0, 4]',
			'assert fill_missing([None, None], 9) == [9, 9]'
		],
		defects: [
			{
				kind: 'missing',
				line: 5,
				text: '    mean = sum(present) / len(values)',
				neighbour: { line: 2, text: '    present = [v for v in values if v]' }
			},
			{
				kind: 'missing',
				line: 6,
				text: '    return [mean if not v else v for v in values]',
				neighbour: { line: 3, text: '    if len(present) == 0:' }
			}
		]
	},
	{
		lines: [
			'def total_by_group(rows):',
			'    """rows — пары (группа, сумма) в любом порядке. Словарь группа -> сумма; пары с суммой None пропускаются."""',
			'    totals = {}',
			'    for group, amount in rows:',
			'        if amount is None:',
			'            continue',
			'        totals[group] = totals.get(group, 0) + amount',
			'    return totals'
		],
		checks: [
			'assert total_by_group([("a", 5), ("b", 1), ("a", None), ("a", 2)]) == {"a": 7, "b": 1}',
			'assert total_by_group([("c", None)]) == {}'
		],
		defects: [
			{
				kind: 'aggregation',
				line: 6,
				text: '        totals[group] = amount',
				neighbour: { line: 3, text: '    for group, amount in list(rows):' }
			},
			{
				kind: 'missing',
				line: 4,
				text: '        if group is None:',
				neighbour: { line: 7, text: '    return dict(totals)' }
			}
		]
	},
	{
		lines: [
			'def median(values):',
			'    """Медиана значений, кроме None; при чётном их числе — среднее двух средних; без значений — None."""',
			'    data = sorted(v for v in values if v is not None)',
			'    n = len(data)',
			'    if n == 0:',
			'        return None',
			'    mid = n // 2',
			'    if n % 2 == 1:',
			'        return data[mid]',
			'    return (data[mid - 1] + data[mid]) / 2'
		],
		checks: [
			'assert median([5, None, 1, 3]) == 3',
			'assert median([4, 1, 3, 2]) == 2.5',
			'assert median([9, 1, 7, 3, 5]) == 5',
			'assert median([None]) is None'
		],
		defects: [
			{
				kind: 'aggregation',
				line: 2,
				text: '    data = [v for v in values if v is not None]',
				neighbour: { line: 6, text: '    mid = int(n / 2)' }
			},
			{
				kind: 'aggregation',
				line: 9,
				text: '    return (data[mid] + data[mid + 1]) / 2',
				neighbour: { line: 3, text: '    n = len(list(data))' },
				alternatives: [{ line: 6, text: '    mid = (n - 1) // 2' }]
			}
		]
	},
	{
		lines: [
			'def parse_date(text):',
			'    """Дата \'ДД.ММ.ГГГГ\' (возможны пробелы по краям) -> кортеж (год, месяц, день) из int."""',
			'    day, month, year = text.strip().split(".")',
			'    return int(year), int(month), int(day)'
		],
		checks: ['assert parse_date(" 05.03.2024") == (2024, 3, 5)', 'assert parse_date("31.12.1999 ") == (1999, 12, 31)'],
		defects: [
			{
				kind: 'types',
				line: 2,
				text: '    year, month, day = text.strip().split(".")',
				neighbour: { line: 3, text: '    return int(year), int(month), int(day.lstrip("0") or 0)' },
				alternatives: [{ line: 3, text: '    return int(day), int(month), int(year)' }]
			},
			{
				kind: 'types',
				line: 3,
				text: '    return year, month, day',
				neighbour: { line: 2, text: '    day, month, year = text.split(".")' },
				alternatives: [{ line: 2, text: '    day, month, year = map(int, text.strip().split("."))' }]
			}
		]
	}
];

const MIDDLE: Fn[] = [
	{
		lines: [
			'def standardize(train, test):',
			'    """Списки чисел; train непустой, и его значения не все равны. Пара (train, test), стандартизованных средним и стандартным отклонением (делитель n), посчитанными только по train."""',
			'    mean = sum(train) / len(train)',
			'    std = (sum((x - mean) ** 2 for x in train) / len(train)) ** 0.5',
			'    scale = lambda xs: [(x - mean) / std for x in xs]',
			'    return scale(train), scale(test)'
		],
		checks: ['assert standardize([1, 3], [5]) == ([-1.0, 1.0], [3.0])'],
		defects: [
			{
				kind: 'fit-leak',
				line: 2,
				text: '    mean = sum(train + test) / len(train + test)',
				neighbour: { line: 4, text: '    scale = lambda xs: [(x - mean) / std for x in list(xs)]' }
			},
			{
				kind: 'fit-leak',
				line: 3,
				text: '    std = (sum((x - mean) ** 2 for x in train + test) / len(train + test)) ** 0.5',
				neighbour: { line: 5, text: '    return scale(list(train)), scale(list(test))' }
			}
		]
	},
	{
		lines: [
			'def impute_median(train_col, test_col):',
			'    """Списки чисел с None; в train есть хотя бы одно значение не None. Пропуски (None) в обоих списках заполняются медианой непустых значений train; пара новых списков."""',
			'    known = sorted(v for v in train_col if v is not None)',
			'    n = len(known)',
			'    med = known[n // 2] if n % 2 else (known[n // 2 - 1] + known[n // 2]) / 2',
			'    fill = lambda xs: [med if v is None else v for v in xs]',
			'    return fill(train_col), fill(test_col)'
		],
		checks: [
			'assert impute_median([1, None, 5, 3], [None, 100]) == ([1, 3, 5, 3], [3, 100])',
			'assert impute_median([2, None, 4], [10, None]) == ([2, 3, 4], [10, 3])'
		],
		defects: [
			{
				kind: 'fit-leak',
				line: 2,
				text: '    known = sorted(v for v in train_col + test_col if v is not None)',
				neighbour: { line: 3, text: '    n = len(list(known))' }
			}
		]
	},
	{
		lines: [
			'def scale_features(train, test, field):',
			'    """train, test — списки словарей с числовым field; в train есть строки с разными field. Добавляет каждой строке field + \'_scaled\': min-max по min и max field в train (тест может выйти за [0, 1])."""',
			'    lo = min(r[field] for r in train)',
			'    hi = max(r[field] for r in train)',
			'    for r in train + test:',
			'        r[field + "_scaled"] = (r[field] - lo) / (hi - lo)',
			'    return train, test'
		],
		checks: [
			'sf_train, sf_test = [{"x": 2}, {"x": 6}], [{"x": 10}]',
			'scale_features(sf_train, sf_test, "x")',
			'assert [r["x_scaled"] for r in sf_train + sf_test] == [0.0, 1.0, 2.0]'
		],
		defects: [
			{
				kind: 'fit-leak',
				line: 3,
				text: '    hi = max(r[field] for r in train + test)',
				neighbour: { line: 4, text: '    for r in test + train:' }
			}
		]
	},
	{
		lines: [
			'def time_split(rows, cutoff):',
			'    """rows — словари с \'ts\', значения ts различны. train — строки с ts < cutoff, test — с ts >= cutoff; обе части по возрастанию ts."""',
			'    ordered = sorted(rows, key=lambda r: r["ts"])',
			'    train = [r for r in ordered if r["ts"] < cutoff]',
			'    test = [r for r in ordered if r["ts"] >= cutoff]',
			'    return train, test'
		],
		checks: [
			'ts_rows = [{"ts": 5}, {"ts": 1}, {"ts": 3}, {"ts": 4}]',
			'assert time_split(ts_rows, 4) == ([{"ts": 1}, {"ts": 3}], [{"ts": 4}, {"ts": 5}])'
		],
		defects: [
			{
				kind: 'time-split',
				line: 3,
				text: '    train = [r for r in ordered if r["ts"] <= cutoff]',
				neighbour: { line: 2, text: '    ordered = sorted(rows, key=lambda r: (r["ts"], r.get("id", 0)))' }
			}
		]
	},
	{
		lines: [
			'def holdout_last(rows, share):',
			'    """rows — словари с \'ts\' в любом порядке, значения ts различны; 0 <= share <= 1. Последние по времени round(len(rows) * share) строк — test, остальные — train; обе части по возрастанию ts."""',
			'    ordered = sorted(rows, key=lambda r: r["ts"])',
			'    k = round(len(ordered) * share)',
			'    cut = len(ordered) - k',
			'    return ordered[:cut], ordered[cut:]'
		],
		checks: [
			'hl = [{"ts": 7}, {"ts": 2}, {"ts": 9}, {"ts": 4}]',
			'assert holdout_last(hl, 0.25) == ([{"ts": 2}, {"ts": 4}, {"ts": 7}], [{"ts": 9}])'
		],
		defects: [
			{
				kind: 'time-split',
				line: 5,
				text: '    return ordered[cut:], ordered[:cut]',
				neighbour: { line: 4, text: '    cut = max(0, len(ordered) - k)' }
			},
			{
				kind: 'time-split',
				line: 2,
				text: '    ordered = sorted(rows, key=lambda r: r["ts"], reverse=True)',
				neighbour: { line: 3, text: '    k = round(share * len(ordered))' }
			}
		]
	},
	{
		lines: [
			'def lag_feature(rows):',
			"    \"\"\"rows — словари с 'user', 'ts', 'y' в любом порядке. Пары (user, ts) не повторяются. Добавляет 'prev_y': y предыдущей по времени строки того же пользователя, у первой — None.\"\"\"",
			'    last = {}',
			'    for r in sorted(rows, key=lambda r: r["ts"]):',
			'        r["prev_y"] = last.get(r["user"])',
			'        last[r["user"]] = r["y"]',
			'    return rows'
		],
		checks: [
			'lf = [{"user": "a", "ts": 3, "y": 30}, {"user": "a", "ts": 1, "y": 10}, {"user": "b", "ts": 2, "y": 20}, {"user": "a", "ts": 2, "y": 15}]',
			'lag_feature(lf)',
			'assert [r["prev_y"] for r in lf] == [15, None, None, 10]'
		],
		defects: [
			{
				kind: 'time-split',
				line: 3,
				text: '    for r in sorted(rows, key=lambda r: r["user"]):',
				neighbour: { line: 5, text: '        last[r["user"]] = r.get("y")' }
			},
			{
				kind: 'time-split',
				line: 4,
				text: '        r["prev_y"] = last.get(r["user"], r["y"])',
				neighbour: { line: 3, text: '    for r in sorted(rows, key=lambda row: row["ts"]):' }
			}
		]
	},
	{
		lines: [
			'def one_hot(train_values, test_values):',
			'    """Категории — из train в порядке первого появления. Каждое значение — список 0/1 по этим категориям; категория, которой нет в train, — все нули."""',
			'    cats = []',
			'    for v in train_values:',
			'        if v not in cats:',
			'            cats.append(v)',
			'    encode = lambda xs: [[1 if v == c else 0 for c in cats] for v in xs]',
			'    return encode(train_values), encode(test_values)'
		],
		checks: ['assert one_hot(["b", "a", "b"], ["a", "c"]) == ([[1, 0], [0, 1], [1, 0]], [[0, 1], [0, 0]])'],
		defects: [
			{
				kind: 'encoding',
				line: 3,
				text: '    for v in train_values + test_values:',
				neighbour: { line: 2, text: '    cats = list()' },
				alternatives: [{ line: 4, text: '        if v not in cats and v in train_values:' }]
			},
			{
				kind: 'encoding',
				line: 6,
				text: '    encode = lambda xs: [[1 if v == c else 0 for c in sorted(cats)] for v in xs]',
				neighbour: { line: 4, text: '        if cats.count(v) == 0:' }
			}
		]
	},
	{
		lines: [
			'def label_encode(train_values, test_values, unknown):',
			'    """Коды категорий train: 0, 1, … по возрастанию названий; значения test вне train получают unknown. Пара списков кодов."""',
			'    codes = {c: i for i, c in enumerate(sorted(set(train_values)))}',
			'    return [codes[v] for v in train_values], [codes.get(v, unknown) for v in test_values]'
		],
		checks: ['assert label_encode(["m", "a", "m", "z"], ["z", "q"], -1) == ([1, 0, 1, 2], [2, -1])'],
		defects: [
			{
				kind: 'encoding',
				line: 2,
				text: '    codes = {c: i for i, c in enumerate(dict.fromkeys(train_values))}',
				neighbour: {
					line: 3,
					text: '    return [codes[v] for v in list(train_values)], [codes.get(v, unknown) for v in test_values]'
				}
			},
			{
				kind: 'encoding',
				line: 2,
				text: '    codes = {c: i for i, c in enumerate(sorted(set(train_values)), start=1)}',
				neighbour: {
					line: 3,
					text: '    return [codes[v] for v in train_values], [codes.get(v, unknown) for v in list(test_values)]'
				}
			}
		]
	},
	{
		lines: [
			'def bin_values(values, edges):',
			'    """edges — возрастающие границы. Номер корзины значения — число границ, не больших его (значение, равное границе, — в правой корзине)."""',
			'    result = []',
			'    for v in values:',
			'        k = 0',
			'        while k < len(edges) and edges[k] <= v:',
			'            k += 1',
			'        result.append(k)',
			'    return result'
		],
		checks: ['assert bin_values([1, 5, 10, 7], [5, 10]) == [0, 1, 2, 1]'],
		defects: [
			{
				kind: 'encoding',
				line: 5,
				text: '        while k < len(edges) and edges[k] < v:',
				neighbour: { line: 4, text: '        k = int(0)' }
			}
		]
	},
	{
		lines: [
			'def split_by_user(rows, share):',
			'    """rows — словари с \'user\'; 0 <= share <= 1. Различные пользователи по возрастанию; первые round(число пользователей * share) — в test, остальные — в train. Строки пользователя не попадают в обе части; порядок строк сохраняется."""',
			'    users = sorted({r["user"] for r in rows})',
			'    k = round(len(users) * share)',
			'    test_users = set(users[:k])',
			'    train = [r for r in rows if r["user"] not in test_users]',
			'    test = [r for r in rows if r["user"] in test_users]',
			'    return train, test'
		],
		checks: [
			'su = [{"user": u} for u in [5, 2, 5, 7, 9, 5, 7]]',
			'su_train, su_test = split_by_user(su, 0.25)',
			'assert [r["user"] for r in su_test] == [2]',
			'assert [r["user"] for r in su_train] == [5, 5, 7, 9, 5, 7]',
			'su2_train, su2_test = split_by_user([{"user": u} for u in [3, 3, 1, 1, 2]], 0.5)',
			'assert [r["user"] for r in su2_test] == [1, 1, 2]'
		],
		defects: [
			{
				kind: 'group-split',
				line: 2,
				text: '    users = sorted(r["user"] for r in rows)',
				neighbour: { line: 3, text: '    k = int(round(len(users) * share))' }
			},
			{
				kind: 'group-split',
				line: 4,
				text: '    test_users = set(r["user"] for r in rows[:k])',
				neighbour: { line: 5, text: '    train = [r for r in rows if not r["user"] in test_users]' }
			}
		]
	},
	{
		lines: [
			'def dedup_events(rows):',
			'    """rows — словари с \'user\', \'item\', \'ts\', значения ts различны. Из повторов пары (user, item) остаётся самая ранняя по ts; результат по возрастанию ts."""',
			'    seen = set()',
			'    result = []',
			'    for r in sorted(rows, key=lambda r: r["ts"]):',
			'        key = (r["user"], r["item"])',
			'        if key in seen:',
			'            continue',
			'        seen.add(key)',
			'        result.append(r)',
			'    return result'
		],
		checks: [
			'de = [{"user": 1, "item": "x", "ts": 5}, {"user": 1, "item": "x", "ts": 2}, {"user": 1, "item": "y", "ts": 3}, {"user": 2, "item": "x", "ts": 4}]',
			'assert [r["ts"] for r in dedup_events(de)] == [2, 3, 4]'
		],
		defects: [
			{
				kind: 'group-split',
				line: 5,
				text: '        key = r["user"]',
				neighbour: { line: 4, text: '    for r in sorted(rows, key=lambda row: row["ts"]):' }
			},
			{
				kind: 'group-split',
				line: 8,
				text: '        seen.add(r["item"])',
				neighbour: { line: 3, text: '    result = list()' }
			}
		]
	},
	{
		lines: [
			'def kfold_by_group(groups, k):',
			'    """groups — id группы каждой строки (сравнимые между собой), k >= 1. Фолд строки — позиция её группы в отсортированном списке различных групп по модулю k: строки одной группы всегда в одном фолде."""',
			'    order = sorted(set(groups))',
			'    fold_of = {g: i % k for i, g in enumerate(order)}',
			'    return [fold_of[g] for g in groups]'
		],
		checks: [
			'assert kfold_by_group(["b", "a", "b", "c", "a"], 2) == [1, 0, 1, 0, 0]',
			'assert kfold_by_group(["d", "c", "b", "a"], 3) == [0, 2, 1, 0]'
		],
		defects: [
			{
				kind: 'group-split',
				line: 3,
				text: '    fold_of = {g: i // k for i, g in enumerate(order)}',
				neighbour: { line: 2, text: '    order = list(sorted(set(groups)))' }
			},
			{
				kind: 'group-split',
				line: 2,
				text: '    order = sorted(groups)',
				neighbour: { line: 4, text: '    return [fold_of.get(g) for g in groups]' },
				alternatives: [{ line: 3, text: '    fold_of = {g: i % k for i, g in enumerate(dict.fromkeys(order))}' }]
			}
		]
	}
];

const MODULE_TITLES = [
	'Подготовка признаков для модели оттока',
	'Конвейер данных для прогноза спроса',
	'Предобработка выгрузки для обучения',
	'Сборка обучающей выборки из событий'
];
const OPTIONAL_IMPORTS = ['import csv', 'import logging', 'import math', 'import os'];
const HEADER_CONSTANTS = [
	'RANDOM_STATE = 42',
	'TARGET = "churn"',
	'TEST_SHARE = 0.2',
	'N_FOLDS = 5',
	'DATE_FORMAT = "%d.%m.%Y"',
	'MAX_ROWS = 1_000_000'
];

interface Program {
	source: string;
	check: string;
	answer: number;
	fix: string;
	neighbour: { line: number; text: string };
	other: { line: number; text: string };
	alternatives: { line: number; fix: string }[];
}

function compose(rng: Rng, library: readonly Fn[], kind: string, contextCount: number): Program {
	const candidates = library.flatMap((fn) =>
		fn.defects.filter((d) => d.kind === kind).map((defect) => ({ fn, defect }))
	);
	const { fn: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((fn) => fn !== buggy),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	// A module header of random length, so the defect's line number carries no hint.
	const imports = rng.sample(OPTIONAL_IMPORTS, rng.int(0, 2));
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 4));
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
	let alternatives: Program['alternatives'] = [];
	for (const fn of order) {
		const offset = lines.length;
		fn.lines.forEach((line, i) => lines.push(fn === buggy && i === defect.line ? defect.text : line));
		if (fn === buggy) {
			answer = offset + defect.line + 1;
			alternatives = (defect.alternatives ?? []).map((a) => ({ line: offset + a.line + 1, fix: a.text }));
			neighbour = { line: offset + defect.neighbour.line + 1, text: defect.neighbour.text };
		} else if (other.line === 0) {
			const sibling = fn.defects[0];
			if (sibling) other = { line: offset + sibling.line + 1, text: sibling.text };
		}
		lines.push('', '');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	const fix = buggy.lines[defect.line] ?? '';
	const checks = order.flatMap((fn) => fn.checks);
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
	return { source: lines.join('\n'), check, answer, fix, neighbour, other, alternatives };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const p = input.grade === 'junior' ? compose(rng, JUNIOR, input.classId, 4) : compose(rng, MIDDLE, input.classId, 5);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль подготовки данных для модели на Python 3. У каждой функции в строке документации записана её ' +
				'спецификация. В модуле один дефект: одна функция нарушает свою спецификацию. ' +
				'Введите номер строки, замена которой одной инструкцией восстанавливает спецификацию всех функций (нумерация с 1). ' +
				'Если исправить можно в нескольких строках — засчитывается любая из них, где замена одной инструкцией восстанавливает спецификацию. Исправление — одна простая инструкция того же вида, что исправляемая строка: не добавляйте ' +
				'конструкций, которых в ней нет (`:=`, lambda, обёртки, новые функции), и не переносите в неё логику из другой строки.',
			code: { language: 'python3', source: p.source }
		},
		answer: {
			kind: 'line_no',
			value: p.answer,
			...(p.alternatives.length ? { alternatives: p.alternatives.map((a) => a.line) } : {})
		}
	});
	return {
		instance,
		reference: () => ({
			kind: 'bug',
			check: p.check,
			fix: p.fix,
			...(p.alternatives.length ? { alternatives: p.alternatives } : {})
		}),
		wrong: () => ({
			// A neighbour that is itself an accepted alternative is not a wrong answer.
			'neighbour-line': p.alternatives.some((a) => a.line === p.neighbour.line)
				? null
				: { kind: 'line', line: p.neighbour.line, replacement: p.neighbour.text },
			'other-function': p.other.line === 0 ? null : { kind: 'line', line: p.other.line, replacement: p.other.text }
		})
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
