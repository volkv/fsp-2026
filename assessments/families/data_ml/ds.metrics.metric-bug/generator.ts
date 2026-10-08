// A module of quality metrics in plain Python: functions that compute classification, regression and ranking metrics,
// each with its specification in the docstring; one line breaks its function's specification. The candidate
// names that line or another line whose one-instruction repair restores the specification (listed as an alternative).
// The defect's kind is the essential class; the other functions, their order and the header are surface.
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

/** A function of the module: its lines, the checks of its specification and its possible defects (0-based lines). */
interface Fn {
	lines: string[];
	/** Python statements, each raising when the specification is broken. */
	checks: string[];
	defects: {
		kind: string;
		line: number;
		text: string;
		neighbour: { line: number; text: string };
		/** Other lines of the function whose one-instruction repair also restores the specification. */
		alternatives?: { line: number; text: string }[];
	}[];
}

const INTERN: Fn[] = [
	{
		lines: [
			'def precision_recall(y_true, y_pred):',
			'    """Метки 0/1, списки одной длины. Пара (precision, recall) класса 1; при нулевом знаменателе метрика равна 0."""',
			'    tp = fp = fn = 0',
			'    for t, p in zip(y_true, y_pred):',
			'        if t == 1 and p == 1:',
			'            tp += 1',
			'        elif t == 0 and p == 1:',
			'            fp += 1',
			'        elif t == 1 and p == 0:',
			'            fn += 1',
			'    precision = tp / (tp + fp) if tp + fp else 0.0',
			'    recall = tp / (tp + fn) if tp + fn else 0.0',
			'    return precision, recall'
		],
		checks: [
			'assert precision_recall([1, 1, 1, 1, 0, 0, 0, 0], [1, 1, 0, 0, 1, 0, 0, 0]) == (2 / 3, 0.5)',
			'assert precision_recall([0, 0], [0, 0]) == (0.0, 0.0)',
			'assert precision_recall([1, 0, 1, 0, 0], [1, 1, 0, 0, 0]) == (0.5, 0.5)'
		],
		defects: [
			{
				kind: 'counting',
				line: 6,
				text: '        elif t == 0 and p == 0:',
				neighbour: { line: 7, text: '            fp = fp + 1' }
			},
			{
				kind: 'counting',
				line: 8,
				text: '        elif t == 0:',
				neighbour: { line: 9, text: '            fn = fn + 1' }
			},
			{
				kind: 'denominator',
				line: 10,
				text: '    precision = tp / len(y_pred) if y_pred else 0.0',
				neighbour: { line: 11, text: '    recall = tp / (fn + tp) if tp + fn else 0.0' }
			}
		]
	},
	{
		lines: [
			'def f1(precision, recall):',
			'    """precision и recall из [0, 1]. F1 — их гармоническое среднее; 0, если обе равны 0."""',
			'    if precision + recall == 0:',
			'        return 0.0',
			'    return 2 * precision * recall / (precision + recall)'
		],
		checks: ['assert abs(f1(0.5, 1.0) - 2 / 3) < 1e-9', 'assert f1(0.0, 0.0) == 0.0'],
		defects: [
			{
				kind: 'aggregation',
				line: 4,
				text: '    return (precision + recall) / 2',
				neighbour: { line: 2, text: '    if precision == 0 and recall == 0:' }
			},
			{
				kind: 'denominator',
				line: 4,
				text: '    return 2 * precision * recall / (precision * recall)',
				neighbour: { line: 3, text: '        return 0' }
			}
		]
	},
	{
		lines: [
			'def rmse(y_true, y_pred):',
			'    """Корень из среднего квадрата ошибок; списки одинаковой непустой длины."""',
			'    total = 0.0',
			'    for t, p in zip(y_true, y_pred):',
			'        total += (t - p) ** 2',
			'    return (total / len(y_true)) ** 0.5'
		],
		checks: ['assert abs(rmse([1, 2, 3], [2, 2, 5]) - (5 / 3) ** 0.5) < 1e-9'],
		defects: [
			{
				kind: 'aggregation',
				line: 5,
				text: '    return (total / (len(y_true) - 1)) ** 0.5',
				neighbour: { line: 2, text: '    total = 0' }
			},
			{
				kind: 'aggregation',
				line: 4,
				text: '        total += abs(t - p)',
				neighbour: { line: 5, text: '    return (total / len(y_pred)) ** 0.5' }
			},
			{
				kind: 'denominator',
				line: 5,
				text: '    return total / len(y_true) ** 0.5',
				neighbour: { line: 4, text: '        total += (p - t) ** 2' }
			}
		]
	},
	{
		lines: [
			'def mae(y_true, y_pred):',
			'    """Средний модуль ошибки прогноза; списки одинаковой непустой длины."""',
			'    errors = [abs(t - p) for t, p in zip(y_true, y_pred)]',
			'    return sum(errors) / len(errors)'
		],
		checks: ['assert mae([3, 1, 4], [1, 3, 4]) == 4 / 3'],
		defects: [
			{
				kind: 'aggregation',
				line: 2,
				text: '    errors = [t - p for t, p in zip(y_true, y_pred)]',
				neighbour: { line: 3, text: '    return sum(errors) / len(y_true)' }
			},
			{
				kind: 'denominator',
				line: 3,
				text: '    return sum(errors) / len(y_true + y_pred)',
				neighbour: { line: 2, text: '    errors = [abs(p - t) for t, p in zip(y_true, y_pred)]' }
			}
		]
	},
	{
		lines: [
			'def precision_at_k(scores, relevant, k):',
			'    """scores — словарь объект -> скор, relevant — множество релевантных объектов.',
			'    Скоры различны, 1 <= k <= len(scores). Доля релевантных среди k объектов с наибольшим скором."""',
			'    ranked = sorted(scores, key=lambda item: scores[item], reverse=True)',
			'    top = ranked[:k]',
			'    hits = sum(1 for item in top if item in relevant)',
			'    return hits / k'
		],
		checks: [
			'pk_scores = {"a": 0.9, "b": 0.8, "c": 0.3, "d": 0.6, "e": 0.1}',
			'assert precision_at_k(pk_scores, {"a", "b", "e"}, 2) == 1.0',
			'assert precision_at_k(pk_scores, {"c", "d"}, 3) == 1 / 3'
		],
		defects: [
			{
				kind: 'ranking',
				line: 3,
				text: '    ranked = sorted(scores, key=lambda item: scores[item])',
				neighbour: { line: 4, text: '    top = list(ranked[:k])' },
				alternatives: [{ line: 4, text: '    top = ranked[-k:]' }]
			},
			{
				kind: 'ranking',
				line: 4,
				text: '    top = ranked[1 : k + 1]',
				neighbour: { line: 5, text: '    hits = len([item for item in top if item in relevant])' }
			},
			{
				kind: 'denominator',
				line: 6,
				text: '    return hits / len(relevant)',
				neighbour: { line: 5, text: '    hits = sum(item in relevant for item in top)' }
			}
		]
	},
	{
		lines: [
			'def recall_at_k(ranking, relevant, k):',
			'    """ranking — различные объекты по убыванию скора, relevant — непустое множество, k >= 0. Доля релевантных в первых k."""',
			'    found = 0',
			'    for item in ranking[:k]:',
			'        if item in relevant:',
			'            found += 1',
			'    return found / len(relevant)'
		],
		checks: [
			'assert recall_at_k(["a", "b", "c", "d"], {"a", "c", "x", "y"}, 3) == 0.5',
			'assert recall_at_k(["a", "b", "c"], {"b", "c"}, 3) == 1.0',
			'assert recall_at_k(["a", "b", "c"], {"a", "d"}, 2) == 0.5'
		],
		defects: [
			{
				kind: 'ranking',
				line: 3,
				text: '    for item in ranking[-k:]:',
				neighbour: { line: 4, text: '        if relevant.__contains__(item):' }
			},
			{
				kind: 'ranking',
				line: 3,
				text: '    for item in ranking[: k - 1]:',
				neighbour: { line: 2, text: '    found = 0.0' }
			},
			{
				kind: 'denominator',
				line: 6,
				text: '    return found / k',
				neighbour: { line: 5, text: '            found = found + 1' }
			}
		]
	},
	{
		lines: [
			'def accuracy(y_true, y_pred):',
			'    """Доля объектов, у которых предсказание совпало с истинной меткой; списки одинаковой непустой длины."""',
			'    correct = 0',
			'    for t, p in zip(y_true, y_pred):',
			'        if t == p:',
			'            correct += 1',
			'    return correct / len(y_true)'
		],
		checks: ['assert accuracy([1, 0, 0, 1], [1, 0, 1, 1]) == 0.75', 'assert accuracy([0, 0, 1], [0, 0, 0]) == 2 / 3'],
		defects: [
			{
				kind: 'counting',
				line: 4,
				text: '        if t == 1 and p == 1:',
				neighbour: { line: 5, text: '            correct = correct + 1' }
			}
		]
	},
	{
		lines: [
			'def confusion(y_true, scores, threshold):',
			'    """Метки 0/1, списки одной длины. Скор не ниже порога — предсказан класс 1. Кортеж (TP, FP, FN, TN)."""',
			'    tp = fp = fn = tn = 0',
			'    for t, s in zip(y_true, scores):',
			'        predicted = s >= threshold',
			'        if predicted and t == 1:',
			'            tp += 1',
			'        elif predicted:',
			'            fp += 1',
			'        elif t == 1:',
			'            fn += 1',
			'        else:',
			'            tn += 1',
			'    return tp, fp, fn, tn'
		],
		checks: ['assert confusion([1, 0, 1, 0, 1, 0], [0.9, 0.5, 0.5, 0.2, 0.1, 0.3], 0.5) == (2, 1, 1, 2)'],
		defects: [
			{
				kind: 'counting',
				line: 4,
				text: '        predicted = s > threshold',
				neighbour: { line: 5, text: '        if t == 1 and predicted:' }
			},
			{
				kind: 'counting',
				line: 9,
				text: '        elif t == 0:',
				neighbour: { line: 7, text: '        elif predicted and t == 0:' }
			}
		]
	},
	{
		lines: [
			'def top_k(scores, k):',
			'    """0 <= k <= len(scores). Имена k объектов с наибольшим скором, по убыванию скора; при равных — по возрастанию имени."""',
			'    order = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))',
			'    return [name for name, _ in order[:k]]'
		],
		checks: ['assert top_k({"b": 0.5, "a": 0.5, "c": 0.9, "d": 0.1}, 2) == ["c", "a"]'],
		defects: [
			{
				kind: 'ranking',
				line: 2,
				text: '    order = sorted(scores.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)',
				neighbour: { line: 3, text: '    return [kv[0] for kv in order[:k]]' }
			},
			{
				kind: 'ranking',
				line: 3,
				text: '    return [name for name, _ in order[: k - 1]]',
				neighbour: { line: 2, text: '    order = sorted(scores.items(), key=lambda kv: (-kv[1], str(kv[0])))' }
			}
		]
	}
];

const JUNIOR: Fn[] = [
	{
		lines: [
			'def roc_auc(y_true, scores):',
			'    """Метки 0/1, есть оба класса. Доля пар (положительный, отрицательный), где скор положительного выше; ничья — половина пары."""',
			'    pos = [s for t, s in zip(y_true, scores) if t == 1]',
			'    neg = [s for t, s in zip(y_true, scores) if t == 0]',
			'    good = 0.0',
			'    for p in pos:',
			'        for n in neg:',
			'            if p > n:',
			'                good += 1',
			'            elif p == n:',
			'                good += 0.5',
			'    return good / (len(pos) * len(neg))'
		],
		checks: ['assert roc_auc([1, 1, 0, 0, 1], [0.9, 0.4, 0.4, 0.2, 0.1]) == 3.5 / 6'],
		defects: [
			{
				kind: 'ties',
				line: 10,
				text: '                good += 1',
				neighbour: { line: 9, text: '            elif n == p:' }
			},
			{
				kind: 'ties',
				line: 7,
				text: '            if p >= n:',
				neighbour: { line: 8, text: '                good = good + 1' }
			},
			{
				kind: 'averaging',
				line: 11,
				text: '    return good / (len(pos) + len(neg))',
				neighbour: { line: 4, text: '    good = 0' }
			}
		]
	},
	{
		lines: [
			'def macro_f1(y_true, y_pred, labels):',
			'    """labels — непустой список различных классов. Среднее F1 по ним; F1 класса = 2TP / (2TP + FP + FN), 0 при нулевом знаменателе."""',
			'    scores = []',
			'    for c in labels:',
			'        tp = sum(1 for t, p in zip(y_true, y_pred) if t == c and p == c)',
			'        fp = sum(1 for t, p in zip(y_true, y_pred) if t != c and p == c)',
			'        fn = sum(1 for t, p in zip(y_true, y_pred) if t == c and p != c)',
			'        denom = 2 * tp + fp + fn',
			'        scores.append(2 * tp / denom if denom else 0.0)',
			'    return sum(scores) / len(labels)'
		],
		checks: [
			'assert abs(macro_f1(["a", "b", "a", "c", "a"], ["a", "a", "a", "b", "c"], ["a", "b", "c", "d"]) - 1 / 6) < 1e-9',
			'assert abs(macro_f1([1, 2, 2, 3], [1, 2, 3, 3], [1, 2, 3, 4]) - 7 / 12) < 1e-9'
		],
		defects: [
			{
				kind: 'averaging',
				line: 9,
				text: '    return sum(scores) / len(y_true)',
				neighbour: { line: 2, text: '    scores = list()' }
			},
			{
				kind: 'averaging',
				line: 9,
				text: '    return sum(scores) / len(set(y_true))',
				neighbour: { line: 7, text: '        denom = fp + fn + 2 * tp' }
			},
			{
				kind: 'edge-cases',
				line: 8,
				text: '        scores.append(2 * tp / denom if tp else 1.0)',
				neighbour: { line: 7, text: '        denom = 2 * tp + (fp + fn)' }
			}
		]
	},
	{
		lines: [
			'def precision_at_k(ranking, relevant, k):',
			'    """ranking — различные объекты по убыванию скора, k >= 0. Число релевантных в первых k, делённое на k,',
			'    даже если объектов меньше k; при k = 0 — 0."""',
			'    if k == 0:',
			'        return 0.0',
			'    hits = sum(1 for item in ranking[:k] if item in relevant)',
			'    return hits / k'
		],
		checks: [
			'assert precision_at_k(["a", "b", "c"], {"a", "c"}, 5) == 0.4',
			'assert precision_at_k(["a", "b"], {"a"}, 0) == 0.0',
			'assert precision_at_k(["a", "b", "c"], {"c"}, 2) == 0.0'
		],
		defects: [
			{
				kind: 'edge-cases',
				line: 6,
				text: '    return hits / min(k, len(ranking))',
				neighbour: { line: 5, text: '    hits = len([item for item in ranking[:k] if item in relevant])' }
			},
			{
				kind: 'edge-cases',
				line: 3,
				text: '    if not ranking:',
				neighbour: { line: 4, text: '        return 0' },
				alternatives: [{ line: 6, text: '    return hits / (k or 1)' }]
			},
			{
				kind: 'thresholds',
				line: 5,
				text: '    hits = sum(1 for item in ranking[: k + 1] if item in relevant)',
				neighbour: { line: 6, text: '    return hits / float(k)' }
			}
		]
	},
	{
		lines: [
			'def average_ranks(values):',
			'    """Ранги значений по возрастанию, начиная с 1; равным значениям — среднее их рангов."""',
			'    order = sorted(range(len(values)), key=lambda i: values[i])',
			'    ranks = [0.0] * len(values)',
			'    i = 0',
			'    while i < len(order):',
			'        j = i',
			'        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:',
			'            j += 1',
			'        for m in range(i, j + 1):',
			'            ranks[order[m]] = (i + j) / 2 + 1',
			'        i = j + 1',
			'    return ranks'
		],
		checks: ['assert average_ranks([30, 10, 20, 10, 40]) == [4.0, 1.5, 3.0, 1.5, 5.0]'],
		defects: [
			{
				kind: 'ties',
				line: 10,
				text: '            ranks[order[m]] = m + 1',
				neighbour: { line: 9, text: '        for m in range(i, j + 1, 1):' }
			},
			{
				kind: 'ties',
				line: 10,
				text: '            ranks[order[m]] = i + 1',
				neighbour: { line: 11, text: '        i = 1 + j' }
			},
			{
				kind: 'ties',
				line: 7,
				text: '        while j + 1 < len(order) and values[order[j]] == values[order[i]]:',
				neighbour: { line: 8, text: '            j = j + 1' }
			}
		]
	},
	{
		lines: [
			'def recall_at_threshold(y_true, scores, threshold):',
			'    """Метки 0/1, списки одной длины. Recall класса 1, если положительным предсказан скор не ниже порога; без положительных объектов — 0."""',
			'    positives = [s for t, s in zip(y_true, scores) if t == 1]',
			'    if not positives:',
			'        return 0.0',
			'    caught = sum(1 for s in positives if s >= threshold)',
			'    return caught / len(positives)'
		],
		checks: [
			'assert recall_at_threshold([1, 0, 1, 1], [0.7, 0.9, 0.5, 0.2], 0.5) == 2 / 3',
			'assert recall_at_threshold([1, 1, 1, 0], [0.9, 0.8, 0.1, 0.6], 0.5) == 2 / 3',
			'assert recall_at_threshold([0, 0], [0.1, 0.9], 0.5) == 0.0'
		],
		defects: [
			{
				kind: 'thresholds',
				line: 5,
				text: '    caught = sum(1 for s in positives if s > threshold)',
				neighbour: { line: 6, text: '    return caught / float(len(positives))' }
			},
			{
				kind: 'thresholds',
				line: 5,
				text: '    caught = sum(1 for s in positives if s <= threshold)',
				neighbour: { line: 3, text: '    if len(positives) == 0:' }
			},
			{
				kind: 'edge-cases',
				line: 3,
				text: '    if positives is None:',
				neighbour: { line: 4, text: '        return 0' },
				alternatives: [{ line: 6, text: '    return caught / (len(positives) or 1)' }]
			}
		]
	},
	{
		lines: [
			'def weighted_average(per_class, support):',
			'    """per_class и support — словари с одними ключами: метрика класса и число объектов класса (>= 0).',
			'    Среднее метрик с весами support; если объектов нет — 0."""',
			'    total = sum(support.values())',
			'    if total == 0:',
			'        return 0.0',
			'    return sum(per_class[c] * support[c] for c in per_class) / total'
		],
		checks: [
			'assert weighted_average({"a": 1.0, "b": 0.5}, {"a": 3, "b": 1}) == 0.875',
			'assert weighted_average({"a": 0.5}, {"a": 0}) == 0.0'
		],
		defects: [
			{
				kind: 'averaging',
				line: 6,
				text: '    return sum(per_class.values()) / len(per_class)',
				neighbour: { line: 3, text: '    total = sum(support[c] for c in support)' }
			},
			{
				kind: 'averaging',
				line: 3,
				text: '    total = len(support)',
				neighbour: { line: 4, text: '    if not total:' }
			},
			{
				kind: 'edge-cases',
				line: 4,
				text: '    if total < 0:',
				neighbour: { line: 5, text: '        return 0' },
				alternatives: [
					{ line: 3, text: '    total = sum(support.values()) or 1' },
					{ line: 6, text: '    return sum(per_class[c] * support[c] for c in per_class) / (total or 1)' }
				]
			}
		]
	},
	{
		lines: [
			'def flag_top_share(scores, share):',
			'    """Помечает долю share (0 <= share <= 1) объектов с наибольшим скором: помеченных int(share * n) (с округлением вниз).',
			'    Список 0/1 в исходном порядке; при равных скорах раньше помечается объект с меньшим индексом."""',
			'    n_flag = int(share * len(scores))',
			'    order = sorted(range(len(scores)), key=lambda i: (-scores[i], i))',
			'    flags = [0] * len(scores)',
			'    for i in order[:n_flag]:',
			'        flags[i] = 1',
			'    return flags'
		],
		checks: [
			'assert flag_top_share([0.2, 0.9, 0.5, 0.5, 0.1], 0.7) == [0, 1, 1, 1, 0]',
			'assert flag_top_share([0.2, 0.9, 0.5, 0.5, 0.1], 0.5) == [0, 1, 1, 0, 0]'
		],
		defects: [
			{
				kind: 'thresholds',
				line: 3,
				text: '    n_flag = round(share * len(scores))',
				neighbour: { line: 5, text: '    flags = [0 for _ in scores]' }
			},
			{
				kind: 'ties',
				line: 4,
				text: '    order = sorted(range(len(scores)), key=lambda i: (scores[i], i), reverse=True)',
				neighbour: { line: 6, text: '    for i in list(order)[:n_flag]:' }
			}
		]
	}
];

const MODULE_TITLES = [
	'Метрики качества для отчёта по модели',
	'Оценка моделей на проверочной выборке',
	'Расчёт метрик для панели экспериментов',
	'Метрики ранжирования и классификации'
];
const OPTIONAL_IMPORTS = ['import math', 'import logging', 'import statistics'];
const HEADER_CONSTANTS = [
	'EPS = 1e-12',
	'DEFAULT_K = 10',
	'REPORT_DIGITS = 4',
	'POSITIVE_LABEL = 1',
	'MAX_ROWS = 1_000_000',
	'LOG_FORMAT = "%(levelname)s %(message)s"'
];

interface Program {
	source: string;
	check: string;
	answer: number;
	fix: string;
	neighbour: { line: number; text: string };
	other: { line: number; text: string };
	/** Accepted other repairs: absolute line and its replacement. */
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
	const p = input.grade === 'intern' ? compose(rng, INTERN, input.classId, 4) : compose(rng, JUNIOR, input.classId, 5);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль расчёта метрик качества модели на Python 3. У каждой функции в строке документации записана её ' +
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
