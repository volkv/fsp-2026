// A module of a data pipeline: functions that parse and aggregate CSV rows and log lines, each with its specification
// in the docstring; exactly one line breaks its function's specification. The candidate names that line. The defect's
// kind is the essential class; the other functions, their order and the module header are surface.
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
	lines: string[];
	/** Python statements, each raising when the specification is broken. */
	checks: string[];
	defects: { kind: string; line: number; text: string; neighbour: { line: number; text: string } }[];
}

const INTERN: Fn[] = [
	{
		lines: [
			'def total_by_day(lines):',
			'    """Строки \'дата;сумма\' отсортированы по дате. Список пар (дата, сумма за день) в порядке дат."""',
			'    result = []',
			'    current, total = None, 0',
			'    for line in lines:',
			'        day, amount = line.split(";")',
			'        if day != current:',
			'            if current is not None:',
			'                result.append((current, total))',
			'            current, total = day, 0',
			'        total += int(amount)',
			'    if current is not None:',
			'        result.append((current, total))',
			'    return result'
		],
		checks: [
			'assert total_by_day(["01;5", "01;7", "02;3", "03;4", "03;1"]) == [("01", 12), ("02", 3), ("03", 5)]',
			'assert total_by_day([]) == []'
		],
		defects: [
			{
				kind: 'accumulator',
				line: 9,
				text: '            current = day',
				neighbour: { line: 10, text: '        total = total + int(amount)' }
			},
			{
				kind: 'accumulator',
				line: 11,
				text: '    if current is None:',
				neighbour: { line: 7, text: '            if current:' }
			}
		]
	},
	{
		lines: [
			'def parse_record(line):',
			"    \"\"\"Строка журнала 'уровень | сервис | сообщение'; в сообщении тоже может быть '|'.",
			'    Кортеж из трёх полей без пробелов по краям."""',
			'    parts = line.split("|", 2)',
			'    level = parts[0].strip()',
			'    service = parts[1].strip()',
			'    message = parts[2].strip()',
			'    return level, service, message'
		],
		checks: [
			'assert parse_record(" WARN | api | retry | 2 ") == ("WARN", "api", "retry | 2")',
			'assert parse_record("INFO|db| started  ") == ("INFO", "db", "started")'
		],
		defects: [
			{
				kind: 'parsing',
				line: 3,
				text: '    parts = line.split("|")',
				neighbour: { line: 4, text: '    level = parts[0].strip().upper()' }
			},
			{
				kind: 'parsing',
				line: 6,
				text: '    message = parts[2].lstrip()',
				neighbour: { line: 5, text: '    service = parts[1].strip(" ")' }
			}
		]
	},
	{
		lines: [
			'def count_by_status(lines):',
			'    """Строки CSV \'id,метод,путь,статус\' без заголовка. Словарь: класс статуса (\'2xx\', \'4xx\', ...) -> число строк."""',
			'    counts = {}',
			'    for line in lines:',
			'        fields = line.strip().split(",")',
			'        key = fields[3][0] + "xx"',
			'        counts[key] = counts.get(key, 0) + 1',
			'    return counts'
		],
		checks: [
			'assert count_by_status(["1,GET,/a,200", "2,POST,/b,404", "3,GET,/c,201\\n", "4,GET,/d,503"]) == {"2xx": 2, "4xx": 1, "5xx": 1}'
		],
		defects: [
			{
				kind: 'grouping',
				line: 5,
				text: '        key = fields[3][:2] + "x"',
				neighbour: { line: 4, text: '        fields = line.split(",")' }
			},
			{
				kind: 'grouping',
				line: 5,
				text: '        key = fields[2][0] + "xx"',
				neighbour: { line: 6, text: '        counts[key] = counts.get(key, 1)' }
			}
		]
	},
	{
		lines: [
			'def max_latency_by_service(rows):',
			'    """rows — словари с ключами \'service\' и \'ms\'. Словарь: сервис -> наибольшая задержка этого сервиса."""',
			'    result = {}',
			'    for row in rows:',
			'        name = row["service"]',
			'        if name not in result or row["ms"] > result[name]:',
			'            result[name] = row["ms"]',
			'    return result'
		],
		checks: [
			'rows = [{"service": "a", "ms": 50}, {"service": "b", "ms": 30}, {"service": "b", "ms": 40}, {"service": "a", "ms": 20}]',
			'assert max_latency_by_service(rows) == {"a": 50, "b": 40}'
		],
		defects: [
			{
				kind: 'grouping',
				line: 5,
				text: '        if name not in result or row["ms"] > max(result.values()):',
				neighbour: { line: 4, text: '        name = row.get("service")' }
			}
		]
	},
	{
		lines: [
			'def sessions_per_user(events):',
			'    """events — пары (пользователь, действие) по времени; действие \'login\' открывает сессию.',
			'    Словарь: пользователь -> число его сессий."""',
			'    sessions = {}',
			'    for user, action in events:',
			'        if action == "login":',
			'            sessions[user] = sessions.get(user, 0) + 1',
			'    return sessions'
		],
		checks: [
			'events = [("ann", "login"), ("bob", "login"), ("ann", "logout"), ("ann", "login"), ("bob", "view")]',
			'assert sessions_per_user(events) == {"ann": 2, "bob": 1}'
		],
		defects: [
			{
				kind: 'grouping',
				line: 6,
				text: '            sessions[user] = sessions.get(action, 0) + 1',
				neighbour: { line: 5, text: '        if action.startswith("login"):' }
			}
		]
	},
	{
		lines: [
			'def parse_tags(header):',
			"    \"\"\"Заголовок 'tags: a, b ,c' (теги могут содержать ':'). Список тегов без пробелов по краям,",
			'    в нижнем регистре, без пустых."""',
			'    _, _, value = header.partition(":")',
			'    tags = []',
			'    for raw in value.split(","):',
			'        tag = raw.strip().lower()',
			'        if tag:',
			'            tags.append(tag)',
			'    return tags'
		],
		checks: [
			'assert parse_tags("tags: API, Db ,,cache") == ["api", "db", "cache"]',
			'assert parse_tags("tags: a:b, c") == ["a:b", "c"]'
		],
		defects: [
			{
				kind: 'parsing',
				line: 6,
				text: '        tag = raw.lower()',
				neighbour: { line: 7, text: '        if tag.strip():' }
			},
			{
				kind: 'parsing',
				line: 5,
				text: '    for raw in value.split():',
				neighbour: { line: 4, text: '    tags = list()' }
			},
			{
				kind: 'parsing',
				line: 3,
				text: '    _, _, value = header.rpartition(":")',
				neighbour: { line: 6, text: '        tag = raw.lower().strip()' }
			}
		]
	},
	{
		lines: [
			'def last_status(lines):',
			'    """Строки \'заказ статус\' по времени. Словарь: заказ -> его последний статус."""',
			'    result = {}',
			'    for line in lines:',
			'        order, status = line.split()',
			'        result[order] = status',
			'    return result'
		],
		checks: [
			'assert last_status(["7 new", "8 new", "7 paid", "7 shipped", "8 paid"]) == {"7": "shipped", "8": "paid"}'
		],
		defects: [
			{
				kind: 'grouping',
				line: 5,
				text: '        result.setdefault(order, status)',
				neighbour: { line: 4, text: '        order, status = line.split(" ")' }
			}
		]
	},
	{
		lines: [
			'def batch_sums(values, size):',
			'    """Суммы подряд идущих пачек по size значений; последняя пачка может быть неполной."""',
			'    sums = []',
			'    batch = 0',
			'    for i, value in enumerate(values, 1):',
			'        batch += value',
			'        if i % size == 0:',
			'            sums.append(batch)',
			'            batch = 0',
			'    if len(values) % size:',
			'        sums.append(batch)',
			'    return sums'
		],
		checks: [
			'assert batch_sums([1, 2, 3, 4, 5], 2) == [3, 7, 5]',
			'assert batch_sums([4, -4, 2, -2, 0], 2) == [0, 0, 0]',
			'assert batch_sums([1, 1, 1], 3) == [3]'
		],
		defects: [
			{
				kind: 'accumulator',
				line: 8,
				text: '            batch = value',
				neighbour: { line: 5, text: '        batch = batch + value' }
			},
			{
				kind: 'accumulator',
				line: 9,
				text: '    if batch:',
				neighbour: { line: 3, text: '    batch = int()' }
			},
			{
				kind: 'accumulator',
				line: 4,
				text: '    for i, value in enumerate(values):',
				neighbour: { line: 6, text: '        if i % size == 0 and i > 0:' }
			}
		]
	}
];

const JUNIOR: Fn[] = [
	{
		lines: [
			'def load_csv(text):',
			'    """CSV с заголовком в первой непустой строке. Список словарей по строкам данных;',
			'    пустые строки и строки из пробелов пропускаются."""',
			'    lines = [line for line in text.splitlines() if line.strip()]',
			'    header = lines[0].split(",")',
			'    rows = []',
			'    for line in lines[1:]:',
			'        rows.append(dict(zip(header, line.split(","))))',
			'    return rows'
		],
		checks: [
			'assert load_csv("id,name\\n1,a\\n\\n2,b\\n  \\n") == [{"id": "1", "name": "a"}, {"id": "2", "name": "b"}]',
			'assert load_csv("\\nid,name\\n3,c") == [{"id": "3", "name": "c"}]'
		],
		defects: [
			{
				kind: 'empty-fields',
				line: 6,
				text: '    for line in lines:',
				neighbour: { line: 4, text: '    header = lines[0].strip().split(",")' }
			},
			{
				kind: 'empty-fields',
				line: 3,
				text: '    lines = [line for line in text.splitlines() if line]',
				neighbour: { line: 7, text: '        rows.append(dict(zip(header, line.strip().split(","))))' }
			}
		]
	},
	{
		lines: [
			'def average_price(rows):',
			'    """rows — словари из CSV, значения — строки; пустая цена означает «нет данных» и не учитывается.',
			'    Среднее по указанным ценам с округлением вниз до целого; если цен нет — None."""',
			'    prices = [int(row["price"]) for row in rows if row["price"] != ""]',
			'    if not prices:',
			'        return None',
			'    return sum(prices) // len(prices)'
		],
		checks: [
			'assert average_price([{"price": "10"}, {"price": ""}, {"price": "21"}]) == 15',
			'assert average_price([{"price": ""}]) is None'
		],
		defects: [
			{
				kind: 'empty-fields',
				line: 3,
				text: '    prices = [int(row["price"] or 0) for row in rows]',
				neighbour: { line: 6, text: '    return int(sum(prices) / len(prices))' }
			},
			{
				kind: 'types',
				line: 6,
				text: '    return round(sum(prices) / len(prices))',
				neighbour: { line: 4, text: '    if len(prices) == 0:' }
			}
		]
	},
	{
		lines: [
			'def latest_version(tags):',
			'    """Теги вида \'v1.10.2\'. Самый новый тег: версии сравниваются по числам частей, не как строки."""',
			'    def key(tag):',
			'        return tuple(int(part) for part in tag[1:].split("."))',
			'    return max(tags, key=key)'
		],
		checks: [
			'assert latest_version(["v1.9.0", "v1.10.0", "v1.2.5"]) == "v1.10.0"',
			'assert latest_version(["v2.0.9", "v2.0.10"]) == "v2.0.10"'
		],
		defects: [
			{
				kind: 'types',
				line: 3,
				text: '        return tuple(part for part in tag[1:].split("."))',
				neighbour: { line: 4, text: '    return sorted(tags, key=key)[-1]' }
			}
		]
	},
	{
		lines: [
			'def sum_amounts(rows):',
			"    \"\"\"rows — словари из CSV; поле 'amount' — сумма в копейках строкой ('1250'), пустое поле — 0.",
			'    Итог в рублях строкой с двумя знаками копеек: \'12.05\'."""',
			'    total = 0',
			'    for row in rows:',
			'        total += int(row["amount"] or 0)',
			'    return f"{total // 100}.{total % 100:02d}"'
		],
		checks: [
			'assert sum_amounts([{"amount": "1200"}, {"amount": "5"}, {"amount": ""}]) == "12.05"',
			'assert sum_amounts([{"amount": "99"}, {"amount": "1"}]) == "1.00"'
		],
		defects: [
			{
				kind: 'types',
				line: 6,
				text: '    return f"{total // 100}.{total % 100}"',
				neighbour: { line: 3, text: '    total = int()' }
			},
			{
				kind: 'empty-fields',
				line: 5,
				text: '        total += int(row["amount"])',
				neighbour: { line: 6, text: '    return f"{total // 100}.{total % 100:0>2}"' }
			}
		]
	},
	{
		lines: [
			'def first_purchases(rows):',
			'    """rows — покупки (пользователь, день, сумма) в произвольном порядке. Для каждого пользователя —',
			'    сумма его самой ранней покупки; результат — список пар по алфавиту пользователей."""',
			'    ordered = sorted(rows, key=lambda r: r[1])',
			'    first = {}',
			'    for user, day, amount in ordered:',
			'        if user not in first:',
			'            first[user] = amount',
			'    return sorted(first.items())'
		],
		checks: [
			'rows = [("b", 3, 10), ("a", 5, 7), ("b", 1, 4), ("a", 2, 9), ("c", 4, 1)]',
			'assert first_purchases(rows) == [("a", 9), ("b", 4), ("c", 1)]'
		],
		defects: [
			{
				kind: 'order',
				line: 5,
				text: '    for user, day, amount in rows:',
				neighbour: { line: 8, text: '    return sorted(first.items(), key=lambda p: p[0])' }
			},
			{
				kind: 'order',
				line: 3,
				text: '    ordered = sorted(rows, key=lambda r: r[1], reverse=True)',
				neighbour: { line: 6, text: '        if first.get(user) is None:' }
			}
		]
	},
	{
		lines: [
			'def unique_signups(rows):',
			'    """rows — строки \'email;день\'. Число разных адресов; адреса сравниваются без учёта регистра',
			'    и пробелов по краям."""',
			'    emails = [row.split(";")[0] for row in rows]',
			'    normalized = {email.strip().lower() for email in emails}',
			'    return len(normalized)'
		],
		checks: ['assert unique_signups(["Ann@x.ru;1", "ann@x.ru ;2", "bob@x.ru;2", " BOB@x.ru;3", "eve@x.ru;3"]) == 3'],
		defects: [
			{
				kind: 'order',
				line: 4,
				text: '    normalized = [email.strip().lower() for email in set(emails)]',
				neighbour: { line: 3, text: '    emails = [row.split(";", 1)[0] for row in rows]' }
			}
		]
	},
	{
		lines: [
			'def recent_errors(entries, limit):',
			'    """entries — пары (время, уровень) в произвольном порядке. Последние limit записей уровня',
			'    ERROR, от новых к старым."""',
			'    errors = [e for e in entries if e[1] == "ERROR"]',
			'    errors.sort(reverse=True)',
			'    return errors[:limit]'
		],
		checks: [
			'entries = [(5, "ERROR"), (9, "INFO"), (7, "ERROR"), (1, "ERROR"), (8, "ERROR")]',
			'assert recent_errors(entries, 2) == [(8, "ERROR"), (7, "ERROR")]'
		],
		defects: [
			{
				kind: 'order',
				line: 3,
				text: '    errors = [e for e in entries[:limit] if e[1] == "ERROR"]',
				neighbour: { line: 5, text: '    return errors[:limit:]' }
			},
			{
				kind: 'order',
				line: 4,
				text: '    errors.sort()',
				neighbour: { line: 3, text: '    errors = [e for e in entries if "ERROR" in e]' }
			}
		]
	},
	{
		lines: [
			'def fill_missing(rows, defaults):',
			'    """rows — словари из CSV; пустая строка или строка из пробелов означает «нет значения» — берётся',
			'    значение из defaults. Возвращает новые словари, исходные не меняются."""',
			'    result = []',
			'    for row in rows:',
			'        filled = dict(row)',
			'        for key, value in row.items():',
			'            if not value.strip():',
			'                filled[key] = defaults[key]',
			'        result.append(filled)',
			'    return result'
		],
		checks: [
			'src = [{"a": " ", "b": "2"}, {"a": "", "b": "5"}]',
			'assert fill_missing(src, {"a": "0", "b": "9"}) == [{"a": "0", "b": "2"}, {"a": "0", "b": "5"}]',
			'assert src[0]["a"] == " "'
		],
		defects: [
			{
				kind: 'empty-fields',
				line: 7,
				text: '            if not value:',
				neighbour: { line: 5, text: '        filled = row.copy()' }
			},
			{
				kind: 'empty-fields',
				line: 7,
				text: '            if value is None:',
				neighbour: { line: 9, text: '        result.append(dict(filled))' }
			}
		]
	},
	{
		lines: [
			'def parse_bool(value):',
			'    """Поле CSV в bool: \'true\', \'yes\', \'1\' без учёта регистра и пробелов — True, всё остальное — False."""',
			'    return value.strip().lower() in ("true", "yes", "1")'
		],
		checks: [
			'assert parse_bool(" YES") is True',
			'assert parse_bool("False") is False',
			'assert parse_bool("0") is False'
		],
		defects: [
			{
				kind: 'types',
				line: 2,
				text: '    return bool(value.strip())',
				neighbour: { line: 0, text: 'def parse_bool(value=""):' }
			}
		]
	},
	{
		lines: [
			'def column(text, name):',
			'    """CSV с заголовком в первой строке; значения столбца name по строкам данных как целые числа;',
			'    пустые значения пропускаются."""',
			'    lines = text.strip().splitlines()',
			'    index = lines[0].split(",").index(name)',
			'    values = []',
			'    for line in lines[1:]:',
			'        cell = line.split(",")[index]',
			'        if cell:',
			'            values.append(int(cell))',
			'    return values'
		],
		checks: ['assert column("sku,qty\\na,3\\nb,\\nc,10", "qty") == [3, 10]', 'assert column("qty\\n7", "qty") == [7]'],
		defects: [
			{
				kind: 'types',
				line: 9,
				text: '            values.append(cell)',
				neighbour: { line: 8, text: '        if cell != "":' }
			},
			{
				kind: 'empty-fields',
				line: 6,
				text: '    for line in lines:',
				neighbour: { line: 5, text: '    values = list()' }
			},
			{
				kind: 'empty-fields',
				line: 8,
				text: '        if cell is not None:',
				neighbour: { line: 7, text: '        cell = line.split(",")[index].strip()' }
			}
		]
	}
];

/** Functions of the reserve class X: they serve only its instances, so the instances of the other classes stay as they were. */
const INTERN_X: Fn[] = [
	{
		lines: [
			'def top_products(sales, n):',
			'    """sales — пары (товар, выручка). n товаров с наибольшей выручкой, по убыванию выручки."""',
			'    ordered = sorted(sales, key=lambda p: p[1], reverse=True)',
			'    return [name for name, _ in ordered[:n]]'
		],
		checks: ['assert top_products([("b", 5), ("a", 9), ("c", 7)], 2) == ["a", "c"]'],
		defects: [
			{
				kind: 'sorting',
				line: 2,
				text: '    ordered = sorted(sales, key=lambda p: p[1])',
				neighbour: { line: 3, text: '    return [p[0] for p in ordered[:n]]' }
			},
			{
				kind: 'sorting',
				line: 2,
				text: '    ordered = sorted(sales, reverse=True)',
				neighbour: { line: 3, text: '    return [name for name, _ in ordered][:n]' }
			}
		]
	},
	{
		lines: [
			'def by_size(lines):',
			'    """Строки \'файл;размер в байтах\'. Имена файлов по возрастанию размера (размер — число)."""',
			'    rows = [line.split(";") for line in lines]',
			'    rows.sort(key=lambda r: int(r[1]))',
			'    return [r[0] for r in rows]'
		],
		checks: ['assert by_size(["a;900", "b;1000", "c;20"]) == ["c", "a", "b"]'],
		defects: [
			{
				kind: 'sorting',
				line: 3,
				text: '    rows.sort(key=lambda r: r[1])',
				neighbour: { line: 2, text: '    rows = [line.strip().split(";") for line in lines]' }
			}
		]
	},
	{
		lines: [
			'def rank_players(scores):',
			'    """scores — словарь игрок -> очки. Игроки по убыванию очков, при равенстве — по имени по алфавиту."""',
			'    return sorted(scores, key=lambda name: (-scores[name], name))'
		],
		checks: ['assert rank_players({"bob": 5, "ann": 5, "eve": 7}) == ["eve", "ann", "bob"]'],
		defects: [
			{
				kind: 'sorting',
				line: 2,
				text: '    return sorted(scores, key=lambda name: (scores[name], name), reverse=True)',
				neighbour: { line: 0, text: 'def rank_players(scores=None):' }
			}
		]
	}
];

const JUNIOR_X: Fn[] = [
	{
		lines: [
			'def merge_profiles(crm, billing):',
			'    """Словари id -> профиль (словарь полей) из двух систем. В результате все id из обеих систем; поля',
			'    billing перекрывают поля crm, но пустая строка в billing значение не перекрывает. Исходные не меняются."""',
			'    result = {}',
			'    for uid in sorted(set(crm) | set(billing)):',
			'        merged = dict(crm.get(uid, {}))',
			'        for key, value in billing.get(uid, {}).items():',
			'            if value != "":',
			'                merged[key] = value',
			'        result[uid] = merged',
			'    return result'
		],
		checks: [
			'mp_crm = {1: {"name": "Ann", "city": "Омск"}, 2: {"name": "Bob"}}',
			'mp_billing = {1: {"city": "", "plan": "pro"}, 3: {"name": "Eve"}}',
			'assert merge_profiles(mp_crm, mp_billing) == {1: {"name": "Ann", "city": "Омск", "plan": "pro"}, 2: {"name": "Bob"}, 3: {"name": "Eve"}}',
			'assert mp_crm[1] == {"name": "Ann", "city": "Омск"}'
		],
		defects: [
			{
				kind: 'merge',
				line: 4,
				text: '    for uid in sorted(set(crm) & set(billing)):',
				neighbour: { line: 5, text: '        merged = dict(crm.get(uid, dict()))' }
			},
			{
				kind: 'merge',
				line: 7,
				text: '            if value is not None:',
				neighbour: { line: 8, text: '                merged[key] = str(value)' }
			},
			{
				kind: 'merge',
				line: 5,
				text: '        merged = crm.get(uid, {})',
				neighbour: { line: 9, text: '        result[uid] = dict(merged)' }
			}
		]
	},
	{
		lines: [
			'def apply_updates(prices, updates):',
			'    """prices — словарь sku -> цена; updates — пары (sku, цена) по времени, побеждает последнее обновление.',
			'    Новый словарь с ценами после всех обновлений; исходный не меняется."""',
			'    result = dict(prices)',
			'    for sku, price in updates:',
			'        result[sku] = price',
			'    return result'
		],
		checks: [
			'au_prices = {"a": 1}',
			'assert apply_updates(au_prices, [("a", 2), ("b", 5), ("a", 3)]) == {"a": 3, "b": 5}',
			'assert au_prices == {"a": 1}'
		],
		defects: [
			{
				kind: 'merge',
				line: 5,
				text: '        result.setdefault(sku, price)',
				neighbour: { line: 3, text: '    result = prices.copy()' }
			},
			{
				kind: 'merge',
				line: 3,
				text: '    result = prices',
				neighbour: { line: 6, text: '    return dict(result)' }
			}
		]
	}
];

const MODULE_TITLES = [
	'Обработка выгрузок для отчётов',
	'Разбор журналов сервиса',
	'Конвейер импорта данных',
	'Агрегаты для панели метрик'
];
const OPTIONAL_IMPORTS = ['import csv', 'import logging', 'import os'];
const HEADER_CONSTANTS = [
	'DELIMITER = ","',
	'ENCODING = "utf-8"',
	'BATCH_SIZE = 500',
	'REPORT_TZ = "Europe/Moscow"',
	'MAX_ROWS = 100_000',
	'LOG_FORMAT = "%(levelname)s %(message)s"'
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
				'Модуль конвейера обработки данных на Python 3. У каждой функции в строке документации записана её ' +
				'спецификация. Ровно одна строка модуля нарушает спецификацию своей функции: если заменить только её, все ' +
				'функции будут работать по спецификации. Введите номер этой строки (нумерация с 1).',
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
