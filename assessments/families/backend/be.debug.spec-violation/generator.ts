// A module of small service functions, each with its specification in the docstring; exactly one line breaks its
// function's specification. The candidate names that line. The defect's kind is the essential class; the other
// functions, their order and the numbers are surface.
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

/** A function of the module: its lines, the checks of its specification and its possible defects. */
interface Fn {
	name: string;
	lines: string[];
	/** Python statements, each raising when the specification is broken. */
	checks: string[];
	defects: { kind: string; line: number; text: string; neighbour: { line: number; text: string } }[];
}

const INTERN: Fn[] = [
	{
		name: 'page',
		lines: [
			'def page(items, number, size):',
			'    """Страница номер number (нумерация с 1) по size элементов."""',
			'    start = (number - 1) * size',
			'    end = start + size',
			'    return items[start:end]'
		],
		checks: ['assert page(list(range(1, 11)), 1, 3) == [1, 2, 3]', 'assert page(list(range(1, 11)), 4, 3) == [10]'],
		defects: [
			{
				kind: 'boundary',
				line: 2,
				text: '    start = number * size',
				neighbour: { line: 3, text: '    end = start + size - 1' }
			},
			{
				kind: 'arithmetic',
				line: 2,
				text: '    start = (number - 1) // size',
				neighbour: { line: 3, text: '    end = start * size' }
			}
		]
	},
	{
		name: 'pages_count',
		lines: [
			'def pages_count(total, size):',
			'    """Сколько страниц по size элементов нужно для total элементов."""',
			'    return (total + size - 1) // size'
		],
		checks: ['assert pages_count(10, 5) == 2', 'assert pages_count(11, 5) == 3', 'assert pages_count(0, 5) == 0'],
		defects: [
			{
				kind: 'arithmetic',
				line: 2,
				text: '    return total // size + 1',
				neighbour: { line: 0, text: 'def pages_count(total, size=1):' }
			}
		]
	},
	{
		name: 'in_window',
		lines: [
			'def in_window(ts, start, end):',
			'    """Попадает ли момент ts в окно [start, end): начало включено, конец — нет."""',
			'    return start <= ts < end'
		],
		checks: ['assert in_window(5, 5, 9)', 'assert not in_window(9, 5, 9)', 'assert in_window(8, 5, 9)'],
		defects: [
			{
				kind: 'boundary',
				line: 2,
				text: '    return start < ts <= end',
				neighbour: { line: 0, text: 'def in_window(ts, start, end=None):' }
			}
		]
	},
	{
		name: 'average_rating',
		lines: [
			'def average_rating(ratings):',
			'    """Среднее оценок с одним знаком после запятой; для пустого списка — 0."""',
			'    if not ratings:',
			'        return 0',
			'    return round(sum(ratings) / len(ratings), 1)'
		],
		checks: [
			'assert average_rating([]) == 0',
			'assert average_rating([4, 5]) == 4.5',
			'assert average_rating([5, 4, 4]) == 4.3'
		],
		defects: [
			{
				kind: 'arithmetic',
				line: 4,
				text: '    return round(sum(ratings) // len(ratings), 1)',
				neighbour: { line: 2, text: '    if ratings == []:' }
			},
			{ kind: 'condition', line: 2, text: '    if ratings:', neighbour: { line: 3, text: '        return 0.0' } }
		]
	},
	{
		name: 'can_withdraw',
		lines: [
			'def can_withdraw(balance, amount, overdraft):',
			'    """Списание разрешено, если сумма положительна и баланс после списания не ниже -overdraft."""',
			'    if amount <= 0:',
			'        return False',
			'    return balance - amount >= -overdraft'
		],
		checks: [
			'assert can_withdraw(100, 150, 50)',
			'assert not can_withdraw(100, 151, 50)',
			'assert not can_withdraw(100, 0, 50)',
			'assert not can_withdraw(100, -5, 50)'
		],
		defects: [
			{ kind: 'condition', line: 2, text: '    if amount < 0:', neighbour: { line: 3, text: '        return None' } },
			{
				kind: 'boundary',
				line: 4,
				text: '    return balance - amount > -overdraft',
				neighbour: { line: 2, text: '    if amount < 1:' }
			}
		]
	},
	{
		name: 'count_between',
		lines: [
			'def count_between(xs, lo, hi):',
			'    """Сколько чисел из xs лежит в отрезке [lo, hi], концы включены."""',
			'    count = 0',
			'    for x in xs:',
			'        if lo <= x <= hi:',
			'            count += 1',
			'    return count'
		],
		checks: ['assert count_between([1, 2, 3, 4, 5], 2, 4) == 3', 'assert count_between([], 1, 2) == 0'],
		defects: [
			{ kind: 'boundary', line: 4, text: '        if lo <= x < hi:', neighbour: { line: 2, text: '    count = 1' } },
			{
				kind: 'condition',
				line: 4,
				text: '        if lo <= x or x <= hi:',
				neighbour: { line: 6, text: '    return count - 1' }
			}
		]
	},
	{
		name: 'percent',
		lines: [
			'def percent(part, whole):',
			'    """Доля part от whole в процентах, целое число, округление вниз; при whole = 0 — 0."""',
			'    if whole == 0:',
			'        return 0',
			'    return part * 100 // whole'
		],
		checks: ['assert percent(1, 3) == 33', 'assert percent(0, 0) == 0', 'assert percent(5, 5) == 100'],
		defects: [
			{
				kind: 'arithmetic',
				line: 4,
				text: '    return part // whole * 100',
				neighbour: { line: 2, text: '    if whole <= 0:' }
			}
		]
	},
	{
		name: 'last_n',
		lines: [
			'def last_n(items, n):',
			'    """Последние n элементов списка; при n = 0 — пустой список."""',
			'    if n == 0:',
			'        return []',
			'    return items[-n:]'
		],
		checks: [
			'assert last_n([1, 2, 3], 2) == [2, 3]',
			'assert last_n([1, 2, 3], 0) == []',
			'assert last_n([1, 2], 5) == [1, 2]'
		],
		defects: [
			{ kind: 'boundary', line: 4, text: '    return items[-n - 1:]', neighbour: { line: 2, text: '    if n <= 0:' } }
		]
	},
	{
		name: 'free_delivery',
		lines: [
			'def free_delivery(total, is_member):',
			'    """Бесплатная доставка: участникам клуба от 1000 включительно, остальным от 3000 включительно."""',
			'    limit = 1000 if is_member else 3000',
			'    return total >= limit'
		],
		checks: [
			'assert free_delivery(1000, True)',
			'assert not free_delivery(2999, False)',
			'assert free_delivery(3000, False)',
			'assert not free_delivery(999, True)'
		],
		defects: [
			{
				kind: 'condition',
				line: 2,
				text: '    limit = 3000 if is_member else 1000',
				neighbour: { line: 3, text: '    return not total < limit' }
			}
		]
	}
];

const JUNIOR: Fn[] = [
	{
		name: 'merge_settings',
		lines: [
			'def merge_settings(defaults, overrides):',
			'    """Новый словарь: значения defaults, поверх них — overrides. Аргументы не меняются."""',
			'    result = dict(defaults)',
			'    result.update(overrides)',
			'    return result'
		],
		checks: [
			'd = {"a": 1, "b": 2}',
			'assert merge_settings(d, {"b": 3}) == {"a": 1, "b": 3}',
			'assert d == {"a": 1, "b": 2}'
		],
		defects: [
			{
				kind: 'aliasing',
				line: 2,
				text: '    result = defaults',
				neighbour: { line: 3, text: '    result.update(dict(overrides))' }
			}
		]
	},
	{
		name: 'append_event',
		lines: [
			'def append_event(event, log=None):',
			'    """Добавляет событие в журнал и возвращает журнал; без журнала создаётся новый."""',
			'    if log is None:',
			'        log = []',
			'    log.append(event)',
			'    return log'
		],
		checks: [
			'assert append_event("a") == ["a"]',
			'assert append_event("b") == ["b"]',
			'j = ["x"]',
			'assert append_event("y", j) is j and j == ["x", "y"]'
		],
		defects: [
			{
				kind: 'aliasing',
				line: 3,
				text: '        log = _EMPTY_LOG',
				neighbour: { line: 4, text: '    log = log + [event]' }
			}
		]
	},
	{
		name: 'snapshot',
		lines: [
			'def snapshot(state):',
			'    """Независимая копия состояния: словарь списков; правки копии не видны в state."""',
			'    copy = {}',
			'    for key, values in state.items():',
			'        copy[key] = list(values)',
			'    return copy'
		],
		checks: ['s = {"q": [1, 2]}', 'c = snapshot(s)', 'c["q"].append(3)', 'assert s == {"q": [1, 2]}'],
		defects: [
			{
				kind: 'aliasing',
				line: 4,
				text: '        copy[key] = values',
				neighbour: { line: 2, text: '    copy = dict()' }
			}
		]
	},
	{
		name: 'remove_expired',
		lines: [
			'def remove_expired(sessions, now):',
			'    """Удаляет из словаря sessions записи со сроком <= now; возвращает число удалённых."""',
			'    removed = 0',
			'    for key in list(sessions):',
			'        if sessions[key] <= now:',
			'            del sessions[key]',
			'            removed += 1',
			'    return removed'
		],
		checks: ['s = {"a": 5, "b": 10, "c": 3}', 'assert remove_expired(s, 5) == 2', 'assert s == {"b": 10}'],
		defects: [
			{
				kind: 'iteration',
				line: 3,
				text: '    for key in sessions:',
				neighbour: { line: 4, text: '        if sessions[key] < now:' }
			}
		]
	},
	{
		name: 'dedupe',
		lines: [
			'def dedupe(ids):',
			'    """Убирает повторы, сохраняя порядок первых вхождений."""',
			'    seen = set()',
			'    result = []',
			'    for x in ids:',
			'        if x not in seen:',
			'            seen.add(x)',
			'            result.append(x)',
			'    return result'
		],
		checks: ['assert dedupe([3, 1, 3, 2, 1]) == [3, 1, 2]', 'assert dedupe([]) == []'],
		defects: [
			{
				kind: 'iteration',
				line: 4,
				text: '    for x in set(ids):',
				neighbour: { line: 8, text: '    return sorted(result)' }
			}
		]
	},
	{
		name: 'chunked',
		lines: [
			'def chunked(items, size):',
			'    """Части списка по size элементов; последняя может быть короче."""',
			'    chunks = []',
			'    for i in range(0, len(items), size):',
			'        chunks.append(items[i:i + size])',
			'    return chunks'
		],
		checks: ['assert chunked([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]', 'assert chunked([], 3) == []'],
		defects: [
			{
				kind: 'iteration',
				line: 3,
				text: '    for i in range(0, len(items) - size, size):',
				neighbour: { line: 4, text: '        chunks.append(items[i:i + size - 1])' }
			}
		]
	},
	{
		name: 'top_k',
		lines: [
			'def top_k(scores, k):',
			'    """k пар (имя, балл): по убыванию балла, при равенстве — по алфавиту имён."""',
			'    ordered = sorted(scores.items(), key=lambda p: (-p[1], p[0]))',
			'    return ordered[:k]'
		],
		checks: ['assert top_k({"b": 5, "a": 5, "c": 7}, 2) == [("c", 7), ("a", 5)]'],
		defects: [
			{
				kind: 'iteration',
				line: 2,
				text: '    ordered = sorted(scores.items(), key=lambda p: (p[1], p[0]), reverse=True)',
				neighbour: { line: 3, text: '    return ordered[:k + 1]' }
			}
		]
	},
	{
		name: 'call_with_retries',
		lines: [
			'def call_with_retries(fn, attempts):',
			'    """Вызывает fn до attempts раз, пока она бросает ConnectionError; возвращает первый результат.',
			'    Другие исключения не повторяются; после последней неудачи ConnectionError выходит наружу."""',
			'    for attempt in range(attempts):',
			'        try:',
			'            return fn()',
			'        except ConnectionError:',
			'            if attempt == attempts - 1:',
			'                raise'
		],
		checks: [
			'calls = []',
			'def flaky():',
			'    calls.append(1)',
			'    if len(calls) < 3:',
			'        raise ConnectionError()',
			'    return "ok"',
			'assert call_with_retries(flaky, 3) == "ok"',
			'def broken():',
			'    calls.append(2)',
			'    raise ValueError()',
			'calls.clear()',
			'try:',
			'    call_with_retries(broken, 3)',
			'    raise AssertionError("ValueError swallowed")',
			'except ValueError:',
			'    pass',
			'assert calls == [2]',
			'def down():',
			'    raise ConnectionError()',
			'try:',
			'    call_with_retries(down, 2)',
			'    raise AssertionError("no error after the last attempt")',
			'except ConnectionError:',
			'    pass'
		],
		defects: [
			{
				kind: 'errors',
				line: 6,
				text: '        except Exception:',
				neighbour: { line: 3, text: '    for attempt in range(1, attempts + 1):' }
			},
			{
				kind: 'errors',
				line: 7,
				text: '            if attempt == attempts:',
				neighbour: { line: 5, text: '            return fn' }
			}
		]
	},
	{
		name: 'read_port',
		lines: [
			'def read_port(config):',
			'    """Порт из config["http"]["port"]; нет секции или ключа — 8080; порт вне 1..65535 — ValueError."""',
			'    try:',
			'        port = config["http"]["port"]',
			'    except KeyError:',
			'        return 8080',
			'    if not 1 <= port <= 65535:',
			'        raise ValueError(port)',
			'    return port'
		],
		checks: [
			'assert read_port({}) == 8080',
			'assert read_port({"http": {}}) == 8080',
			'assert read_port({"http": {"port": 443}}) == 443',
			'for bad in (0, 70000):',
			'    try:',
			'        read_port({"http": {"port": bad}})',
			'        raise AssertionError("bad port accepted")',
			'    except ValueError:',
			'        pass'
		],
		defects: [
			{
				kind: 'errors',
				line: 6,
				text: '    if port > 65535:',
				neighbour: { line: 4, text: '    except LookupError:' }
			},
			{
				kind: 'errors',
				line: 7,
				text: '        return 8080',
				neighbour: { line: 4, text: '    except (KeyError, TypeError):' }
			}
		]
	}
];

/** Units of the reserve class X: they serve only its instances, so the instances of the other classes stay as they were. */
const INTERN_X: Fn[] = [
	{
		name: 'discount_or_default',
		lines: [
			'def discount_or_default(discount):',
			'    """Скидка в процентах; None означает «не задана» — тогда 5. Скидка 0 — это 0, а не «не задана»."""',
			'    if discount is None:',
			'        return 5',
			'    return discount'
		],
		checks: [
			'assert discount_or_default(None) == 5',
			'assert discount_or_default(0) == 0',
			'assert discount_or_default(15) == 15'
		],
		defects: [
			{
				kind: 'falsy-zero',
				line: 2,
				text: '    if not discount:',
				neighbour: { line: 4, text: '    return int(discount)' }
			}
		]
	},
	{
		name: 'first_free_slot',
		lines: [
			'def first_free_slot(slots):',
			'    """Индекс первого свободного места (значение None) в списке slots; свободных нет — -1.',
			'    Занятое место хранит id владельца, id может быть 0."""',
			'    for i, owner in enumerate(slots):',
			'        if owner is None:',
			'            return i',
			'    return -1'
		],
		checks: ['assert first_free_slot([0, "ann", None]) == 2', 'assert first_free_slot([1]) == -1'],
		defects: [
			{
				kind: 'falsy-zero',
				line: 4,
				text: '        if not owner:',
				neighbour: { line: 3, text: '    for i, owner in list(enumerate(slots)):' }
			}
		]
	},
	{
		name: 'counter_label',
		lines: [
			'def counter_label(count):',
			'    """Подпись счётчика: None — \'нет данных\', иначе число строкой, в том числе \'0\'."""',
			'    return "нет данных" if count is None else str(count)'
		],
		checks: [
			'assert counter_label(None) == "нет данных"',
			'assert counter_label(0) == "0"',
			'assert counter_label(7) == "7"'
		],
		defects: [
			{
				kind: 'falsy-zero',
				line: 2,
				text: '    return str(count) if count else "нет данных"',
				neighbour: { line: 0, text: 'def counter_label(count=None):' }
			}
		]
	},
	{
		name: 'effective_limit',
		lines: [
			'def effective_limit(user_limit, default_limit):',
			'    """Лимит запросов: личный лимит пользователя, если он задан (не None), иначе общий.',
			'    Личный лимит 0 — полный запрет."""',
			'    return default_limit if user_limit is None else user_limit'
		],
		checks: [
			'assert effective_limit(0, 100) == 0',
			'assert effective_limit(None, 100) == 100',
			'assert effective_limit(5, 100) == 5'
		],
		defects: [
			{
				kind: 'falsy-zero',
				line: 3,
				text: '    return user_limit or default_limit',
				neighbour: { line: 0, text: 'def effective_limit(user_limit, default_limit=100):' }
			}
		]
	}
];

const JUNIOR_X: Fn[] = [
	{
		name: 'make_validators',
		lines: [
			'def make_validators(limits):',
			'    """Список функций-проверок: i-я возвращает True, если значение не больше limits[i]."""',
			'    checks = []',
			'    for limit in limits:',
			'        checks.append(lambda value, limit=limit: value <= limit)',
			'    return checks'
		],
		checks: ['mv = make_validators([3, 10])', 'assert mv[0](5) is False and mv[1](5) is True'],
		defects: [
			{
				kind: 'late-binding',
				line: 4,
				text: '        checks.append(lambda value: value <= limit)',
				neighbour: { line: 2, text: '    checks = list()' }
			}
		]
	},
	{
		name: 'event_handlers',
		lines: [
			'def event_handlers(events):',
			'    """Словарь событие -> функция без аргументов, возвращающая имя своего события."""',
			'    handlers = {}',
			'    for name in events:',
			'        handlers[name] = lambda name=name: name',
			'    return handlers'
		],
		checks: [
			'eh = event_handlers(["created", "paid"])',
			'assert eh["created"]() == "created" and eh["paid"]() == "paid"'
		],
		defects: [
			{
				kind: 'late-binding',
				line: 4,
				text: '        handlers[name] = lambda: name',
				neighbour: { line: 5, text: '    return dict(handlers)' }
			}
		]
	},
	{
		name: 'last_failed',
		lines: [
			'def last_failed(results):',
			'    """results — пары (задача, ошибка или None) по порядку. Имя последней задачи с ошибкой;',
			'    если ошибок нет — None."""',
			'    failed = None',
			'    for task, error in results:',
			'        if error is not None:',
			'            failed = task',
			'    return failed'
		],
		checks: ['assert last_failed([("a", "timeout"), ("b", None)]) == "a"', 'assert last_failed([("c", None)]) is None'],
		defects: [
			{
				kind: 'late-binding',
				line: 7,
				text: '    return task',
				neighbour: { line: 5, text: '        if error:' }
			}
		]
	}
];

const MODULE_TITLES = [
	'Вспомогательные функции сервиса заказов',
	'Утилиты API каталога',
	'Общие функции биллинга',
	'Помощники обработчиков HTTP'
];
const HEADER_CONSTANTS = [
	'DEFAULT_PAGE_SIZE = 20',
	'MAX_PAGE_SIZE = 100',
	'CURRENCY = "RUB"',
	'API_VERSION = "v2"',
	'LOG_LEVEL = "INFO"',
	'RETRY_LIMIT = 3'
];

interface Program {
	source: string;
	check: string;
	answer: number;
	fix: string;
	neighbour: { line: number; text: string };
	other: { line: number; text: string };
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
	// A module header of random length: a docstring and constants, so the defect's line number carries no hint.
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 4));
	if (library.some((fn) => JUNIOR.includes(fn))) constants.push('_EMPTY_LOG = []');
	const lines: string[] = [
		`"""${rng.pick(MODULE_TITLES)}."""`,
		...(rng.bool() ? ['', 'import math'] : []),
		...(constants.length ? ['', ...rng.shuffle(constants)] : []),
		'',
		''
	];
	let answer = 0;
	let neighbour = { line: 0, text: '' };
	let other = { line: 0, text: '' };
	for (const fn of order) {
		const offset = lines.length;
		fn.lines.forEach((line, i) => lines.push(fn === buggy && i === defect.line ? defect.text : line));
		if (fn === buggy) {
			answer = offset + defect.line + 1;
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
	return { source: lines.join('\n'), check, answer, fix, neighbour, other };
}

export function build(input: GenerateInput): Built {
	const { cls } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const reserve = cls.form === 'X';
	const p =
		input.grade === 'intern'
			? compose(rng, reserve ? [...INTERN, ...INTERN_X] : INTERN, input.classId, 4)
			: compose(rng, reserve ? [...JUNIOR, ...JUNIOR_X] : JUNIOR, input.classId, 5);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль сервиса на Python 3. У каждой функции в строке документации записана её спецификация. Ровно одна строка ' +
				'модуля нарушает спецификацию своей функции: если заменить только её, все функции будут работать по спецификации. ' +
				'Введите номер этой строки (нумерация с 1).',
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
