// A module of money and date helpers for billing: amounts in kopecks, rounding rules, calendar boundaries, dates
// parsed from strings — each function with its specification in the docstring; exactly one line breaks its
// function's specification. The candidate names that line. The defect's kind is the essential class; the other
// functions, their order and the module header are surface.
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

/** A defect: the original line it replaces (`at`, unique in its unit), and a plausible but wrong neighbouring change. */
interface Defect {
	kind: string;
	at: string;
	text: string;
	neighbour: { at: string; text: string };
}

/** A function of the module: its lines, the checks of its specification and its possible defects. */
interface Unit {
	lines: string[];
	/** Python statements, each raising when the specification is broken. */
	checks: string[];
	defects: Defect[];
}

const INTERN: Unit[] = [
	{
		lines: [
			'def to_kopecks(text):',
			"    \"\"\"Сумма из строки 'рубли.копейки' ровно с двумя знаками ('12.34') в целые копейки — точно,",
			'    без ошибок округления."""',
			'    rubles, kopecks = text.split(".")',
			'    return int(rubles) * 100 + int(kopecks)'
		],
		checks: [
			'assert to_kopecks("0.29") == 29',
			'assert to_kopecks("12.34") == 1234',
			'assert to_kopecks("1.15") == 115'
		],
		defects: [
			{
				kind: 'money',
				at: '    return int(rubles) * 100 + int(kopecks)',
				text: '    return int(float(text) * 100)',
				neighbour: {
					at: '    rubles, kopecks = text.split(".")',
					text: '    rubles, kopecks = text.strip().split(".")'
				}
			}
		]
	},
	{
		lines: [
			'def split_bill(total_kop, people):',
			'    """Делит счёт total_kop копеек на people частей: части отличаются не больше чем на копейку,',
			'    лишние копейки достаются первым частям, сумма частей равна счёту."""',
			'    base = total_kop // people',
			'    extra = total_kop % people',
			'    return [base + (1 if i < extra else 0) for i in range(people)]'
		],
		checks: ['assert split_bill(1001, 3) == [334, 334, 333]', 'assert split_bill(100, 4) == [25, 25, 25, 25]'],
		defects: [
			{
				kind: 'money',
				at: '    base = total_kop // people',
				text: '    base = round(total_kop / people)',
				neighbour: { at: '    extra = total_kop % people', text: '    extra = total_kop - base * people' }
			},
			{
				kind: 'money',
				at: '    return [base + (1 if i < extra else 0) for i in range(people)]',
				text: '    return [total_kop / people] * people',
				neighbour: { at: '    base = total_kop // people', text: '    base = int(total_kop // people)' }
			}
		]
	},
	{
		lines: [
			'def fully_paid(payments, due):',
			'    """payments — платежи, due — сумма к оплате; всё в рублях строками с двумя знаками (\'0.70\').',
			'    True, если платежей не меньше суммы к оплате; считать в целых копейках."""',
			'    return sum(int(p.replace(".", "")) for p in payments) >= int(due.replace(".", ""))'
		],
		checks: [
			'assert fully_paid(["0.10", "0.70"], "0.80") is True',
			'assert fully_paid(["0.10", "0.10", "0.70"], "0.90") is True',
			'assert fully_paid(["0.99"], "1.00") is False'
		],
		defects: [
			{
				kind: 'money',
				at: '    return sum(int(p.replace(".", "")) for p in payments) >= int(due.replace(".", ""))',
				text: '    return sum(float(p) for p in payments) >= float(due)',
				neighbour: { at: 'def fully_paid(payments, due):', text: 'def fully_paid(payments, due="0.00"):' }
			}
		]
	},
	{
		lines: [
			'def vat_kop(amount_kop, rate_percent):',
			'    """НДС с суммы amount_kop копеек по ставке rate_percent процентов, округлённый до копейки:',
			'    половина копейки и больше — вверх."""',
			'    return (amount_kop * rate_percent + 50) // 100'
		],
		checks: ['assert vat_kop(250, 1) == 3', 'assert vat_kop(1000, 20) == 200', 'assert vat_kop(149, 1) == 1'],
		defects: [
			{
				kind: 'rounding',
				at: '    return (amount_kop * rate_percent + 50) // 100',
				text: '    return round(amount_kop * rate_percent / 100)',
				neighbour: { at: 'def vat_kop(amount_kop, rate_percent):', text: 'def vat_kop(amount_kop, rate_percent=20):' }
			},
			{
				kind: 'rounding',
				at: '    return (amount_kop * rate_percent + 50) // 100',
				text: '    return amount_kop * rate_percent // 100',
				neighbour: { at: 'def vat_kop(amount_kop, rate_percent):', text: 'def vat_kop(amount_kop=0, rate_percent=20):' }
			}
		]
	},
	{
		lines: [
			'def invoice_total(lines, rate_percent):',
			'    """lines — суммы позиций в копейках. Итог с наценкой rate_percent %: наценка считается один раз',
			'    с суммы всех позиций и округляется до копейки, половина — вверх."""',
			'    subtotal = sum(lines)',
			'    markup = (subtotal * rate_percent + 50) // 100',
			'    return subtotal + markup'
		],
		checks: ['assert invoice_total([150, 150, 150], 1) == 455', 'assert invoice_total([1000], 15) == 1150'],
		defects: [
			{
				kind: 'rounding',
				at: '    markup = (subtotal * rate_percent + 50) // 100',
				text: '    markup = sum((x * rate_percent + 50) // 100 for x in lines)',
				neighbour: { at: '    return subtotal + markup', text: '    return int(subtotal + markup)' }
			},
			{
				kind: 'rounding',
				at: '    markup = (subtotal * rate_percent + 50) // 100',
				text: '    markup = round(subtotal * rate_percent / 100)',
				neighbour: { at: '    subtotal = sum(lines)', text: '    subtotal = sum(lines, 0)' }
			}
		]
	},
	{
		lines: [
			'def unit_price(total_kop, qty):',
			'    """Цена за штуку в копейках при покупке партии: total_kop / qty, округление вверх до копейки."""',
			'    return -(-total_kop // qty)'
		],
		checks: ['assert unit_price(1000, 3) == 334', 'assert unit_price(1001, 7) == 143', 'assert unit_price(10, 4) == 3'],
		defects: [
			{
				kind: 'rounding',
				at: '    return -(-total_kop // qty)',
				text: '    return total_kop // qty',
				neighbour: { at: 'def unit_price(total_kop, qty):', text: 'def unit_price(total_kop, qty=1):' }
			},
			{
				kind: 'rounding',
				at: '    return -(-total_kop // qty)',
				text: '    return round(total_kop / qty)',
				neighbour: { at: 'def unit_price(total_kop, qty):', text: 'def unit_price(total_kop=0, qty=1):' }
			}
		]
	},
	{
		lines: [
			'def days_left(today, due):',
			'    """Сколько дней осталось на оплату: due — последний день оплаты включительно (в день due ещё',
			'    можно платить — остаётся 1 день); если срок прошёл — 0."""',
			'    return max(0, (due - today).days + 1)'
		],
		checks: [
			'assert days_left(date(2026, 3, 1), date(2026, 3, 1)) == 1',
			'assert days_left(date(2026, 2, 27), date(2026, 3, 1)) == 3',
			'assert days_left(date(2026, 3, 5), date(2026, 3, 1)) == 0'
		],
		defects: [
			{
				kind: 'dates',
				at: '    return max(0, (due - today).days + 1)',
				text: '    return max(0, (due - today).days)',
				neighbour: { at: 'def days_left(today, due):', text: 'def days_left(today, due=None):' }
			},
			{
				kind: 'dates',
				at: '    return max(0, (due - today).days + 1)',
				text: '    return (due - today).days + 1',
				neighbour: { at: 'def days_left(today, due):', text: 'def days_left(today=None, due=None):' }
			}
		]
	},
	{
		lines: [
			'def month_end(day):',
			'    """Последний день месяца, в котором лежит дата day."""',
			'    first_next = (day.replace(day=1) + timedelta(days=32)).replace(day=1)',
			'    return first_next - timedelta(days=1)'
		],
		checks: [
			'assert month_end(date(2026, 1, 31)) == date(2026, 1, 31)',
			'assert month_end(date(2028, 2, 10)) == date(2028, 2, 29)',
			'assert month_end(date(2026, 12, 5)) == date(2026, 12, 31)'
		],
		defects: [
			{
				kind: 'dates',
				at: '    first_next = (day.replace(day=1) + timedelta(days=32)).replace(day=1)',
				text: '    first_next = (day + timedelta(days=31)).replace(day=1)',
				neighbour: {
					at: '    return first_next - timedelta(days=1)',
					text: '    return first_next + timedelta(days=-1)'
				}
			},
			{
				kind: 'dates',
				at: '    first_next = (day.replace(day=1) + timedelta(days=32)).replace(day=1)',
				text: '    first_next = day.replace(month=day.month + 1, day=1)',
				neighbour: {
					at: '    return first_next - timedelta(days=1)',
					text: '    return date.fromordinal(first_next.toordinal() - 1)'
				}
			}
		]
	},
	{
		lines: [
			'def add_month(day):',
			'    """Та же дата через месяц; если такого числа в следующем месяце нет — последний день',
			'    следующего месяца."""',
			'    year = day.year + day.month // 12',
			'    month = day.month % 12 + 1',
			'    last = calendar.monthrange(year, month)[1]',
			'    return date(year, month, min(day.day, last))'
		],
		checks: [
			'assert add_month(date(2026, 1, 31)) == date(2026, 2, 28)',
			'assert add_month(date(2026, 12, 15)) == date(2027, 1, 15)',
			'assert add_month(date(2028, 1, 30)) == date(2028, 2, 29)'
		],
		defects: [
			{
				kind: 'dates',
				at: '    return date(year, month, min(day.day, last))',
				text: '    return date(year, month, day.day)',
				neighbour: {
					at: '    last = calendar.monthrange(year, month)[1]',
					text: '    last = calendar.monthrange(year, month)[-1]'
				}
			},
			{
				kind: 'dates',
				at: '    year = day.year + day.month // 12',
				text: '    year = day.year',
				neighbour: { at: '    month = day.month % 12 + 1', text: '    month = (day.month % 12) + 1' }
			}
		]
	},
	{
		lines: [
			'def in_period(day, start, end):',
			'    """Попадает ли дата в отчётный период: с start по end, оба конца включительно."""',
			'    return start <= day <= end'
		],
		checks: [
			'assert in_period(date(2026, 3, 31), date(2026, 3, 1), date(2026, 3, 31))',
			'assert not in_period(date(2026, 4, 1), date(2026, 3, 1), date(2026, 3, 31))'
		],
		defects: [
			{
				kind: 'dates',
				at: '    return start <= day <= end',
				text: '    return start <= day < end',
				neighbour: { at: 'def in_period(day, start, end):', text: 'def in_period(day, start, end=None):' }
			}
		]
	},
	{
		lines: ['def is_weekend(day):', '    """True для субботы и воскресенья."""', '    return day.weekday() >= 5'],
		checks: ['assert is_weekend(date(2026, 10, 10))', 'assert not is_weekend(date(2026, 10, 9))'],
		defects: [
			{
				kind: 'dates',
				at: '    return day.weekday() >= 5',
				text: '    return day.isoweekday() >= 5',
				neighbour: { at: 'def is_weekend(day):', text: 'def is_weekend(day=None):' }
			}
		]
	},
	{
		lines: [
			'def parse_ru_date(text):',
			'    """Дата из строки \'ДД.ММ.ГГГГ\' (российский формат: день первым)."""',
			'    day, month, year = text.split(".")',
			'    return date(int(year), int(month), int(day))'
		],
		checks: [
			'assert parse_ru_date("05.03.2026") == date(2026, 3, 5)',
			'assert parse_ru_date("31.01.2026") == date(2026, 1, 31)'
		],
		defects: [
			{
				kind: 'date-parse',
				at: '    day, month, year = text.split(".")',
				text: '    month, day, year = text.split(".")',
				neighbour: {
					at: '    return date(int(year), int(month), int(day))',
					text: '    return date(year=int(year), month=int(month), day=int(day))'
				}
			},
			{
				kind: 'date-parse',
				at: '    return date(int(year), int(month), int(day))',
				text: '    return date(int(year), int(day), int(month))',
				neighbour: {
					at: '    day, month, year = text.split(".")',
					text: '    day, month, year = text.strip().split(".")'
				}
			}
		]
	},
	{
		lines: [
			'def latest_ru(dates):',
			'    """dates — строки \'ДД.ММ.ГГГГ\'. Самая поздняя дата, строкой в том же формате."""',
			'    return max(dates, key=lambda s: tuple(reversed(s.split("."))))'
		],
		checks: ['assert latest_ru(["31.01.2026", "05.03.2026", "15.12.2025"]) == "05.03.2026"'],
		defects: [
			{
				kind: 'date-parse',
				at: '    return max(dates, key=lambda s: tuple(reversed(s.split("."))))',
				text: '    return max(dates)',
				neighbour: { at: 'def latest_ru(dates):', text: 'def latest_ru(dates=()):' }
			},
			{
				kind: 'date-parse',
				at: '    return max(dates, key=lambda s: tuple(reversed(s.split("."))))',
				text: '    return max(dates, key=lambda s: s.split(".")[::-1][0])',
				neighbour: { at: 'def latest_ru(dates):', text: 'def latest_ru(dates: list):' }
			}
		]
	},
	{
		lines: [
			'def day_of(stamp):',
			'    """Дата из метки времени \'ГГГГ-ММ-ДДTчч:мм:сс\' (без часового пояса)."""',
			'    return date.fromisoformat(stamp[:10])'
		],
		checks: ['assert day_of("2026-03-05T23:59:30") == date(2026, 3, 5)'],
		defects: [
			{
				kind: 'date-parse',
				at: '    return date.fromisoformat(stamp[:10])',
				text: '    return date.fromisoformat(stamp.split(" ")[0])',
				neighbour: { at: 'def day_of(stamp):', text: 'def day_of(stamp=""):' }
			}
		]
	},
	{
		lines: [
			'def parse_month(text):',
			'    """Отчётный месяц из строки \'ММ/ГГГГ\' — первый день этого месяца."""',
			'    month, year = text.split("/")',
			'    return date(int(year), int(month), 1)'
		],
		checks: ['assert parse_month("03/2026") == date(2026, 3, 1)'],
		defects: [
			{
				kind: 'date-parse',
				at: '    month, year = text.split("/")',
				text: '    year, month = text.split("/")',
				neighbour: {
					at: '    return date(int(year), int(month), 1)',
					text: '    return date(int(year), int(month), day=1)'
				}
			}
		]
	}
];

const MODULE_TITLES = [
	'Деньги и даты биллинга',
	'Расчёты счетов и сроков оплаты',
	'Вспомогательные функции бухгалтерии',
	'Суммы и календарь подписок'
];
const OPTIONAL_IMPORTS = ['import logging', 'import json', 'from decimal import Decimal'];
const HEADER_CONSTANTS = [
	'CURRENCY = "RUB"',
	'VAT_PERCENT = 20',
	'GRACE_DAYS = 3',
	'BILLING_TZ = "Europe/Moscow"',
	'MIN_PAYMENT_KOP = 100',
	'INVOICE_PREFIX = "INV"'
];

/** The index of the line `at` in a unit; it must occur exactly once. */
function lineOf(unit: Unit, at: string): number {
	const index = unit.lines.indexOf(at);
	if (index === -1 || unit.lines.lastIndexOf(at) !== index) throw new Error(`line not unique in its unit: ${at}`);
	return index;
}

interface Program {
	source: string;
	check: string;
	answer: number;
	fix: string;
	neighbour: { line: number; text: string };
	other: { line: number; text: string };
}

function compose(rng: Rng, library: readonly Unit[], kind: string, contextCount: number): Program {
	const candidates = library.flatMap((unit) =>
		unit.defects.filter((d) => d.kind === kind).map((defect) => ({ unit, defect }))
	);
	const { unit: buggy, defect } = rng.pick(candidates);
	const context = rng.sample(
		library.filter((unit) => unit !== buggy),
		contextCount
	);
	const order = rng.shuffle([buggy, ...context]);
	// A module header of random length, so the defect's line number carries no hint.
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 4));
	const lines: string[] = [
		`"""${rng.pick(MODULE_TITLES)}."""`,
		'',
		...['import calendar', ...rng.sample(OPTIONAL_IMPORTS, rng.int(0, 2))].sort(),
		'from datetime import date, timedelta',
		...(constants.length ? ['', ...constants] : []),
		'',
		''
	];
	const defectLine = lineOf(buggy, defect.at);
	let answer = 0;
	let neighbour = { line: 0, text: '' };
	let other = { line: 0, text: '' };
	for (const unit of order) {
		const offset = lines.length;
		unit.lines.forEach((line, i) => lines.push(unit === buggy && i === defectLine ? defect.text : line));
		if (unit === buggy) {
			answer = offset + defectLine + 1;
			neighbour = { line: offset + lineOf(buggy, defect.neighbour.at) + 1, text: defect.neighbour.text };
		} else if (other.line === 0) {
			const sibling = unit.defects[0];
			if (sibling) other = { line: offset + lineOf(unit, sibling.at) + 1, text: sibling.text };
		}
		lines.push('', '');
	}
	while (lines[lines.length - 1] === '') lines.pop();
	const fix = buggy.lines[defectLine] ?? '';
	const checks = order.flatMap((unit) => unit.checks);
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
	const p = compose(rng, INTERN, input.classId, 4);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown:
				'Модуль денежных расчётов и дат на Python 3. Суммы хранятся в копейках, даты — объекты `date`. У каждой ' +
				'функции в строке документации записана её спецификация. Ровно одна строка модуля нарушает спецификацию своей ' +
				'функции: если заменить только её, все функции будут работать по спецификации. Введите номер этой строки ' +
				'(нумерация с 1).',
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
