// A module of input validation for request handlers: each function checks or normalizes one part of a request, with
// its specification in the docstring; exactly one line breaks its function's specification. The candidate names that
// line. The defect's kind is the essential class; the other functions, their order and the module header are surface.
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

/** Check lines asserting that a call raises ValueError. */
function raises(call: string): string[] {
	return ['try:', `    ${call}`, `    raise AssertionError(${JSON.stringify(call)})`, 'except ValueError:', '    pass'];
}

const INTERN: Fn[] = [
	{
		lines: [
			'def valid_username(name):',
			'    """Имя пользователя: от 3 до 16 символов включительно, только латинские буквы, цифры и \'_\'."""',
			'    if not 3 <= len(name) <= 16:',
			'        return False',
			'    return all(ch.isascii() and (ch.isalnum() or ch == "_") for ch in name)'
		],
		checks: [
			'assert valid_username("abc")',
			'assert valid_username("a" * 16)',
			'assert not valid_username("a" * 17)',
			'assert not valid_username("ab")',
			'assert not valid_username("ab-c")'
		],
		defects: [
			{
				kind: 'bounds',
				line: 2,
				text: '    if not 3 < len(name) <= 16:',
				neighbour: { line: 4, text: '    return all(ch.isalnum() or ch == "_" for ch in name)' }
			},
			{
				kind: 'bounds',
				line: 2,
				text: '    if not 3 <= len(name) < 16:',
				neighbour: { line: 3, text: '        return None' }
			}
		]
	},
	{
		lines: [
			'def parse_age(data):',
			'    """data — словарь из JSON. Поле \'age\' обязательно: целое от 14 до 120 включительно.',
			'    Возвращает возраст или бросает ValueError."""',
			'    if "age" not in data:',
			'        raise ValueError("age is required")',
			'    age = data["age"]',
			'    if not isinstance(age, int) or age < 14 or age > 120:',
			'        raise ValueError("age is invalid")',
			'    return age'
		],
		checks: [
			'assert parse_age({"age": 14}) == 14',
			'assert parse_age({"age": 120}) == 120',
			...raises('parse_age({})'),
			...raises('parse_age({"age": 30.5})'),
			...raises('parse_age({"age": 121})')
		],
		defects: [
			{
				kind: 'bounds',
				line: 6,
				text: '    if not isinstance(age, int) or age <= 14 or age > 120:',
				neighbour: { line: 3, text: '    if data.get("age") is None:' }
			},
			{
				kind: 'required',
				line: 6,
				text: '    if age < 14 or age > 120:',
				neighbour: { line: 5, text: '    age = data.get("age")' }
			}
		]
	},
	{
		lines: [
			'REQUIRED_ORDER_FIELDS = ("customer_id", "items", "address")',
			'',
			'',
			'def missing_fields(payload):',
			'    """Обязательные поля заказа, которых нет в payload или значение которых None,',
			'    в порядке REQUIRED_ORDER_FIELDS. Пустой список и 0 — это значения, а не пропуск."""',
			'    missing = []',
			'    for field in REQUIRED_ORDER_FIELDS:',
			'        if payload.get(field) is None:',
			'            missing.append(field)',
			'    return missing'
		],
		checks: [
			'assert missing_fields({"customer_id": 7, "items": None}) == ["items", "address"]',
			'assert missing_fields({"customer_id": 0, "items": [], "address": "x"}) == []',
			'assert missing_fields({"items": [1], "address": "y"}) == ["customer_id"]'
		],
		defects: [
			{
				kind: 'required',
				line: 8,
				text: '        if field not in payload:',
				neighbour: { line: 6, text: '    missing = list()' }
			},
			{
				kind: 'required',
				line: 8,
				text: '        if not payload.get(field):',
				neighbour: { line: 9, text: '            missing.insert(len(missing), field)' }
			},
			{
				kind: 'required',
				line: 7,
				text: '    for field in REQUIRED_ORDER_FIELDS[1:]:',
				neighbour: { line: 10, text: '    return list(missing)' }
			}
		]
	},
	{
		lines: [
			'def normalize_email(raw):',
			'    """Адрес без пробелов по краям и в нижнем регистре; без \'@\' или с пустой частью до или после',
			'    \'@\' — None."""',
			'    email = raw.strip().lower()',
			'    local, at, domain = email.partition("@")',
			'    if not at or not local or not domain:',
			'        return None',
			'    return email'
		],
		checks: [
			'assert normalize_email("  Ann@Mail.RU ") == "ann@mail.ru"',
			'assert normalize_email("ann@") is None',
			'assert normalize_email("@mail.ru") is None',
			'assert normalize_email("ann.mail.ru") is None'
		],
		defects: [
			{
				kind: 'normalize',
				line: 3,
				text: '    email = raw.lower()',
				neighbour: { line: 4, text: '    local, at, domain = email.rpartition("@")' }
			},
			{
				kind: 'normalize',
				line: 3,
				text: '    email = raw.strip()',
				neighbour: { line: 7, text: '    return email.strip()' }
			},
			{
				kind: 'normalize',
				line: 5,
				text: '    if not at or not local:',
				neighbour: { line: 6, text: '        return ""' }
			}
		]
	},
	{
		lines: [
			'def normalize_phone(raw):',
			'    """Российский номер в виде \'+7XXXXXXXXXX\'. Принимает цифры с любыми разделителями; ведущая 8',
			'    заменяется на 7. Если после очистки не 11 цифр или первая цифра не 7 и не 8 — None."""',
			'    digits = "".join(ch for ch in raw if ch.isdigit())',
			'    if len(digits) != 11 or digits[0] not in "78":',
			'        return None',
			'    return "+7" + digits[1:]'
		],
		checks: [
			'assert normalize_phone("8 (912) 345-67-89") == "+79123456789"',
			'assert normalize_phone("+7 912 345 67 89") == "+79123456789"',
			'assert normalize_phone("+7 912 345 67 890") is None',
			'assert normalize_phone("912 345 67 89") is None'
		],
		defects: [
			{
				kind: 'normalize',
				line: 6,
				text: '    return "+" + digits',
				neighbour: { line: 5, text: '        return ""' }
			},
			{
				kind: 'bounds',
				line: 4,
				text: '    if len(digits) < 11 or digits[0] not in "78":',
				neighbour: { line: 6, text: '    return "+7" + digits[-10:]' }
			},
			{
				kind: 'normalize',
				line: 3,
				text: '    digits = raw.replace(" ", "").replace("-", "")',
				neighbour: { line: 4, text: '    if len(digits) != 11 or digits[:1] not in "78":' }
			}
		]
	},
	{
		lines: [
			'def page_size(value):',
			'    """Размер страницы из строки запроса: пустая строка — 20; иначе целое от 1 до 100',
			'    включительно, всё остальное — ValueError."""',
			'    if value == "":',
			'        return 20',
			'    size = int(value)',
			'    if size < 1 or size > 100:',
			'        raise ValueError(value)',
			'    return size'
		],
		checks: [
			'assert page_size("") == 20',
			'assert page_size("100") == 100',
			'assert page_size("1") == 1',
			...raises('page_size("0")'),
			...raises('page_size("101")'),
			...raises('page_size("ten")')
		],
		defects: [
			{
				kind: 'bounds',
				line: 6,
				text: '    if size < 1 or size >= 100:',
				neighbour: { line: 3, text: '    if not value:' }
			},
			{
				kind: 'bounds',
				line: 6,
				text: '    if size < 0 or size > 100:',
				neighbour: { line: 8, text: '    return int(size)' }
			}
		]
	},
	{
		lines: [
			'def review_errors(review):',
			"    \"\"\"Отзыв: 'rating' — целое от 1 до 5, 'text' — строка (может быть пустой). Список ошибочных",
			'    полей в этом порядке."""',
			'    errors = []',
			'    if not isinstance(review.get("rating"), int) or not 1 <= review["rating"] <= 5:',
			'        errors.append("rating")',
			'    if not isinstance(review.get("text"), str):',
			'        errors.append("text")',
			'    return errors'
		],
		checks: [
			'assert review_errors({"rating": 5, "text": ""}) == []',
			'assert review_errors({"rating": 5, "text": 42}) == ["text"]',
			'assert review_errors({"rating": 4.5, "text": "ok"}) == ["rating"]',
			'assert review_errors({}) == ["rating", "text"]'
		],
		defects: [
			{
				kind: 'required',
				line: 6,
				text: '    if "text" not in review:',
				neighbour: { line: 3, text: '    errors = list()' }
			},
			{
				kind: 'bounds',
				line: 4,
				text: '    if not isinstance(review.get("rating"), int) or not 1 <= review["rating"] < 5:',
				neighbour: { line: 5, text: '        errors.insert(0, "rating")' }
			},
			{
				kind: 'required',
				line: 4,
				text: '    if not 1 <= review.get("rating", 0) <= 5:',
				neighbour: { line: 8, text: '    return list(errors)' }
			}
		]
	}
];

const JUNIOR: Fn[] = [
	{
		lines: [
			'def transfer_error(amount, balance, daily_left):',
			'    """Перевод в копейках: сумма строго больше нуля, не больше баланса и не больше остатка дневного',
			"    лимита. Код первой нарушенной проверки в этом порядке ('amount', 'balance', 'limit') или None.\"\"\"",
			'    if amount <= 0:',
			'        return "amount"',
			'    if amount > balance:',
			'        return "balance"',
			'    if amount > daily_left:',
			'        return "limit"',
			'    return None'
		],
		checks: [
			'assert transfer_error(0, 100, 100) == "amount"',
			'assert transfer_error(-50, 100, 100) == "amount"',
			'assert transfer_error(100, 100, 100) is None',
			'assert transfer_error(101, 100, 500) == "balance"',
			'assert transfer_error(60, 100, 50) == "limit"',
			'assert transfer_error(10, 100, 0) == "limit"'
		],
		defects: [
			{
				kind: 'dangerous-amount',
				line: 3,
				text: '    if amount < 0:',
				neighbour: { line: 5, text: '    if amount >= balance + 1:' }
			},
			{
				kind: 'dangerous-amount',
				line: 3,
				text: '    if not amount:',
				neighbour: { line: 9, text: '    return ""' }
			},
			{
				kind: 'dangerous-amount',
				line: 7,
				text: '    if amount > daily_left > 0:',
				neighbour: { line: 4, text: '        return "amount".lower()' }
			}
		]
	},
	{
		lines: [
			'def discounted_price(price, percent):',
			'    """Цена в копейках со скидкой percent процентов, округление вниз. percent — целое от 0 до 90',
			'    включительно, иначе ValueError."""',
			'    if not 0 <= percent <= 90:',
			'        raise ValueError(percent)',
			'    return price * (100 - percent) // 100'
		],
		checks: [
			'assert discounted_price(1000, 90) == 100',
			'assert discounted_price(999, 0) == 999',
			...raises('discounted_price(1000, -10)'),
			...raises('discounted_price(1000, 95)')
		],
		defects: [
			{
				kind: 'dangerous-amount',
				line: 3,
				text: '    if percent > 90:',
				neighbour: { line: 5, text: '    return price - price * percent // 100' }
			},
			{
				kind: 'dangerous-amount',
				line: 3,
				text: '    if not 0 <= percent < 100:',
				neighbour: { line: 4, text: '        raise ValueError(str(percent))' }
			}
		]
	},
	{
		lines: [
			'def quantity_ok(qty, stock, max_per_order):',
			'    """Количество в заказе: целое от 1 до min(stock, max_per_order) включительно."""',
			'    limit = min(stock, max_per_order)',
			'    return 1 <= qty <= limit'
		],
		checks: [
			'assert quantity_ok(5, 5, 10)',
			'assert not quantity_ok(8, 5, 10)',
			'assert not quantity_ok(11, 20, 10)',
			'assert not quantity_ok(-1, 5, 10)',
			'assert not quantity_ok(0, 5, 10)'
		],
		defects: [
			{
				kind: 'dangerous-amount',
				line: 2,
				text: '    limit = max(stock, max_per_order)',
				neighbour: { line: 0, text: 'def quantity_ok(qty, stock, max_per_order=10):' }
			},
			{
				kind: 'dangerous-amount',
				line: 3,
				text: '    return qty <= limit',
				neighbour: { line: 2, text: '    limit = min(max_per_order, stock)' }
			}
		]
	},
	{
		lines: [
			'def refund_allowed(paid, refunded, amount):',
			'    """Возврат: сумма больше нуля, и вместе с уже возвращённым не превышает оплаченного."""',
			'    if amount <= 0:',
			'        return False',
			'    return refunded + amount <= paid'
		],
		checks: [
			'assert refund_allowed(1000, 700, 300)',
			'assert not refund_allowed(1000, 700, 400)',
			'assert not refund_allowed(1000, 0, 0)'
		],
		defects: [
			{
				kind: 'dangerous-amount',
				line: 4,
				text: '    return amount <= paid',
				neighbour: { line: 2, text: '    if amount < 1:' }
			},
			{
				kind: 'dangerous-amount',
				line: 2,
				text: '    if amount < 0:',
				neighbour: { line: 3, text: '        return None' }
			}
		]
	},
	{
		lines: [
			'def clean_comment(text):',
			'    """Комментарий: пробельные символы по краям убираются; пустой после очистки — ValueError;',
			'    длиннее 500 символов после очистки — ValueError. Возвращает очищенный текст."""',
			'    cleaned = text.strip()',
			'    if not cleaned:',
			'        raise ValueError("empty")',
			'    if len(cleaned) > 500:',
			'        raise ValueError("too long")',
			'    return cleaned'
		],
		checks: [
			'assert clean_comment("  ok ") == "ok"',
			'assert clean_comment(" " + "x" * 500 + " ") == "x" * 500',
			...raises('clean_comment("   ")'),
			...raises('clean_comment("\\t\\n")'),
			...raises('clean_comment("y" * 501)')
		],
		defects: [
			{
				kind: 'blank-after-strip',
				line: 4,
				text: '    if not text:',
				neighbour: { line: 8, text: '    return cleaned.strip()' }
			},
			{
				kind: 'blank-after-strip',
				line: 6,
				text: '    if len(text) > 500:',
				neighbour: { line: 3, text: '    cleaned = text.strip(" \\t\\n")' }
			},
			{
				kind: 'blank-after-strip',
				line: 3,
				text: '    cleaned = text.strip(" ")',
				neighbour: { line: 6, text: '    if len(cleaned) >= 501:' }
			}
		]
	},
	{
		lines: [
			'def parse_skills(raw):',
			'    """Навыки через запятую, каждый без пробелов по краям. Пустой навык (в том числе из одних',
			'    пробелов) — ValueError; больше 10 навыков — ValueError. Список навыков."""',
			'    skills = [part.strip() for part in raw.split(",")]',
			'    if any(not skill for skill in skills):',
			'        raise ValueError("empty skill")',
			'    if len(skills) > 10:',
			'        raise ValueError("too many")',
			'    return skills'
		],
		checks: [
			'assert parse_skills("go, sql") == ["go", "sql"]',
			...raises('parse_skills("go,,sql")'),
			...raises('parse_skills("go, ,sql")'),
			...raises('parse_skills(",".join("abcdefghijk"))')
		],
		defects: [
			{
				kind: 'blank-after-strip',
				line: 4,
				text: '    if any(skill is None for skill in skills):',
				neighbour: { line: 8, text: '    return list(skills)' }
			},
			{
				kind: 'blank-after-strip',
				line: 3,
				text: '    skills = [part.strip() for part in raw.split(",") if part]',
				neighbour: { line: 6, text: '    if len(skills) >= 11:' }
			}
		]
	},
	{
		lines: [
			'def display_name(first, last):',
			'    """Имя для профиля \'Имя Фамилия\': части без пробелов по краям; если одна часть пуста после',
			'    очистки — только другая; если пусты обе — None."""',
			'    parts = [p.strip() for p in (first, last)]',
			'    present = [p for p in parts if p]',
			'    return " ".join(present) or None'
		],
		checks: [
			'assert display_name(" Ann", "  ") == "Ann"',
			'assert display_name("Ann ", " Lee") == "Ann Lee"',
			'assert display_name(" ", "") is None'
		],
		defects: [
			{
				kind: 'blank-after-strip',
				line: 4,
				text: '    present = [p for p in parts if p is not None]',
				neighbour: { line: 3, text: '    parts = [p.strip(" ") for p in (first, last)]' }
			},
			{
				kind: 'blank-after-strip',
				line: 3,
				text: '    parts = [first, last]',
				neighbour: { line: 4, text: '    present = [p for p in parts if len(p) > 0]' }
			}
		]
	},
	{
		lines: [
			'def parse_limit(value):',
			'    """Лимит из JSON: целое число (не bool, не float, не строка) от 1 до 1000.',
			'    Возвращает его или бросает ValueError."""',
			'    if isinstance(value, bool) or not isinstance(value, int):',
			'        raise ValueError("not an integer")',
			'    if not 1 <= value <= 1000:',
			'        raise ValueError("out of range")',
			'    return value'
		],
		checks: [
			'assert parse_limit(1000) == 1000',
			...raises('parse_limit(True)'),
			...raises('parse_limit(5.5)'),
			...raises('parse_limit("5")'),
			...raises('parse_limit(0)')
		],
		defects: [
			{
				kind: 'type-coercion',
				line: 3,
				text: '    if not isinstance(value, int):',
				neighbour: { line: 5, text: '    if value < 1 or value > 1000:' }
			},
			{
				kind: 'type-coercion',
				line: 3,
				text: '    if isinstance(value, bool) or not isinstance(value, (int, float)):',
				neighbour: { line: 7, text: '    return int(value)' }
			}
		]
	},
	{
		lines: [
			'def parse_price(value):',
			'    """Цена из JSON: число (int или float, не bool), конечное, больше 0 и не больше 1e6.',
			'    Возвращает float или бросает ValueError."""',
			'    if isinstance(value, bool) or not isinstance(value, (int, float)):',
			'        raise ValueError("not a number")',
			'    if not 0 < value <= 1_000_000:',
			'        raise ValueError("out of range")',
			'    return float(value)'
		],
		checks: [
			'assert parse_price(1_000_000) == 1e6',
			'assert parse_price(0.5) == 0.5',
			...raises('parse_price(float("nan"))'),
			...raises('parse_price(float("inf"))'),
			...raises('parse_price(True)'),
			...raises('parse_price(0)')
		],
		defects: [
			{
				kind: 'type-coercion',
				line: 5,
				text: '    if value <= 0 or value > 1_000_000:',
				neighbour: { line: 7, text: '    return value * 1.0' }
			},
			{
				kind: 'type-coercion',
				line: 3,
				text: '    if not isinstance(value, (int, float)):',
				neighbour: { line: 6, text: '        raise ValueError("bad price")' }
			}
		]
	},
	{
		lines: [
			'def parse_flag(value):',
			"    \"\"\"Флаг из строки запроса: 'true' и '1' — True, 'false' и '0' — False (без учёта регистра);",
			'    всё остальное, включая пустую строку, — ValueError."""',
			'    lowered = value.lower()',
			'    if lowered in ("true", "1"):',
			'        return True',
			'    if lowered in ("false", "0"):',
			'        return False',
			'    raise ValueError(value)'
		],
		checks: [
			'assert parse_flag("TRUE") is True',
			'assert parse_flag("false") is False',
			'assert parse_flag("0") is False',
			...raises('parse_flag("")'),
			...raises('parse_flag("yes")')
		],
		defects: [
			{
				kind: 'type-coercion',
				line: 4,
				text: '    if bool(lowered):',
				neighbour: { line: 3, text: '    lowered = value.casefold()' }
			},
			{
				kind: 'blank-after-strip',
				line: 6,
				text: '    if lowered in ("false", "0", ""):',
				neighbour: { line: 8, text: '    raise ValueError(lowered)' }
			}
		]
	}
];

/** Functions of the reserve class X: they serve only its instances, so the instances of the other classes stay as they were. */
const INTERN_X: Fn[] = [
	{
		lines: [
			'ROLES = ("admin", "editor", "viewer")',
			'',
			'',
			'def valid_role(role):',
			'    """Роль — ровно одно из значений ROLES, с учётом регистра."""',
			'    return role in ROLES'
		],
		checks: ['assert valid_role("editor")', 'assert not valid_role("edit")', 'assert not valid_role("Admin")'],
		defects: [
			{
				kind: 'allowed-values',
				line: 5,
				text: '    return role in ",".join(ROLES)',
				neighbour: { line: 3, text: 'def valid_role(role=""):' }
			}
		]
	},
	{
		lines: [
			'def parse_sort(value):',
			"    \"\"\"Направление сортировки: 'asc' или 'desc' без учёта регистра, иначе ValueError.",
			'    Возвращает его в нижнем регистре."""',
			'    lowered = value.lower()',
			'    if lowered not in ("asc", "desc"):',
			'        raise ValueError(value)',
			'    return lowered'
		],
		checks: ['assert parse_sort("DESC") == "desc"', ...raises('parse_sort("as")'), ...raises('parse_sort("")')],
		defects: [
			{
				kind: 'allowed-values',
				line: 4,
				text: '    if lowered not in "asc desc":',
				neighbour: { line: 6, text: '    return lowered.strip()' }
			},
			{
				kind: 'allowed-values',
				line: 3,
				text: '    lowered = value',
				neighbour: { line: 5, text: '        raise ValueError(lowered)' }
			}
		]
	},
	{
		lines: [
			'def currency_ok(code):',
			'    """Код валюты из поддерживаемых: RUB, USD или EUR — ровно так, заглавными буквами."""',
			'    return code in {"RUB", "USD", "EUR"}'
		],
		checks: ['assert currency_ok("USD")', 'assert not currency_ok("rub")', 'assert not currency_ok("RU")'],
		defects: [
			{
				kind: 'allowed-values',
				line: 2,
				text: '    return code.upper() in {"RUB", "USD", "EUR"}',
				neighbour: { line: 0, text: 'def currency_ok(code=""):' }
			}
		]
	}
];

const JUNIOR_X: Fn[] = [
	{
		lines: [
			'def valid_slug(slug):',
			'    """Слаг: от 3 до 30 символов, вся строка — только строчные латинские буквы, цифры и дефис."""',
			'    return re.fullmatch(r"[a-z0-9-]{3,30}", slug) is not None'
		],
		checks: [
			'assert valid_slug("spring-sale-2026")',
			'assert not valid_slug("abc def")',
			'assert not valid_slug("Ab!")'
		],
		defects: [
			{
				kind: 'pattern',
				line: 2,
				text: '    return re.match(r"[a-z0-9-]{3,30}", slug) is not None',
				neighbour: { line: 0, text: 'def valid_slug(slug=""):' }
			},
			{
				kind: 'pattern',
				line: 2,
				text: '    return re.search(r"[a-z0-9-]{3,30}", slug) is not None',
				neighbour: { line: 0, text: 'def valid_slug(slug: str):' }
			}
		]
	},
	{
		lines: [
			'def parse_postcode(raw):',
			'    """Почтовый индекс: ровно 6 цифр, пробелы по краям допустимы. Возвращает индекс без пробелов',
			'    или бросает ValueError."""',
			'    code = raw.strip()',
			'    if not re.fullmatch(r"\\d{6}", code):',
			'        raise ValueError(raw)',
			'    return code'
		],
		checks: [
			'assert parse_postcode(" 630090 ") == "630090"',
			...raises('parse_postcode("1234567")'),
			...raises('parse_postcode("12345")')
		],
		defects: [
			{
				kind: 'pattern',
				line: 4,
				text: '    if not re.match(r"\\d{6}", code):',
				neighbour: { line: 6, text: '    return code.strip()' }
			},
			{
				kind: 'pattern',
				line: 4,
				text: '    if not re.fullmatch(r"\\d{6}", raw):',
				neighbour: { line: 3, text: '    code = raw.strip(" ")' }
			}
		]
	},
	{
		lines: [
			'def valid_hex_color(value):',
			'    """Цвет \'#RRGGBB\': решётка и ровно шесть шестнадцатеричных цифр в любом регистре."""',
			'    return re.fullmatch(r"#[0-9a-fA-F]{6}", value) is not None'
		],
		checks: [
			'assert valid_hex_color("#A0b1C2")',
			'assert not valid_hex_color("#aabbccdd")',
			'assert not valid_hex_color("aabbcc")'
		],
		defects: [
			{
				kind: 'pattern',
				line: 2,
				text: '    return re.fullmatch(r"#[0-9a-f]{6}", value) is not None',
				neighbour: { line: 0, text: 'def valid_hex_color(value=""):' }
			},
			{
				kind: 'pattern',
				line: 2,
				text: '    return re.match(r"#[0-9a-fA-F]{6}", value) is not None',
				neighbour: { line: 0, text: 'def valid_hex_color(value: str):' }
			}
		]
	}
];

const MODULE_TITLES = [
	'Проверки входа обработчиков API',
	'Валидация форм регистрации и профиля',
	'Проверки запросов платёжного сервиса',
	'Нормализация и проверка полей заказа'
];
const OPTIONAL_IMPORTS = ['import logging', 'import re', 'import json'];
const HEADER_CONSTANTS = [
	'MAX_BODY_BYTES = 1_048_576',
	'DEFAULT_LOCALE = "ru"',
	'CURRENCY = "RUB"',
	'API_VERSION = "v2"',
	'PHONE_COUNTRY = "7"',
	'LOG = logging.getLogger(__name__)'
];

interface Program {
	source: string;
	check: string;
	answer: number;
	fix: string;
	neighbour: { line: number; text: string };
	other: { line: number; text: string };
}

function compose(
	rng: Rng,
	library: readonly Fn[],
	kind: string,
	contextCount: number,
	requiredImport: string | null = null
): Program {
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
	if (requiredImport !== null && !imports.includes(requiredImport)) imports.push(requiredImport);
	const constants = rng.sample(
		HEADER_CONSTANTS.filter((c) => imports.includes('import logging') || !c.includes('logging')),
		rng.int(0, 4)
	);
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
			: compose(rng, reserve ? [...JUNIOR, ...JUNIOR_X] : JUNIOR, input.classId, 5, reserve ? 'import re' : null);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль проверок входа для обработчиков сервиса на Python 3. У каждой функции в строке документации записана ' +
				'её спецификация. Ровно одна строка модуля нарушает спецификацию своей функции: если заменить только её, все ' +
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
