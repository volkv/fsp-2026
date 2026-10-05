// A module of business rules (form validation, prices, statuses), each function with its specification in the
// docstring; exactly one line breaks its function's specification. The tester names that line. The checks of the
// specification are boundary inputs of each rule. The defect's kind is the essential class; the other functions,
// their order and the module header are surface.
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
	/** `line` and `neighbour.line` are 0-based within the function. */
	defects: { kind: string; line: number; text: string; neighbour: { line: number; text: string } }[];
}

const INTERN: Fn[] = [
	{
		name: 'age_allowed',
		lines: [
			'def age_allowed(age):',
			'    """Регистрация разрешена с 14 до 65 лет, оба конца включены."""',
			'    return 14 <= age <= 65'
		],
		checks: [
			'assert age_allowed(14)',
			'assert age_allowed(65)',
			'assert age_allowed(30)',
			'assert not age_allowed(13)',
			'assert not age_allowed(66)'
		],
		defects: [
			{
				kind: 'boundary',
				line: 2,
				text: '    return 14 < age <= 65',
				neighbour: { line: 0, text: 'def age_allowed(age=18):' }
			},
			{
				kind: 'boundary',
				line: 2,
				text: '    return 14 <= age < 65',
				neighbour: { line: 0, text: 'def age_allowed(age=14):' }
			},
			{
				kind: 'logic',
				line: 2,
				text: '    return 14 <= age or age <= 65',
				neighbour: { line: 0, text: 'def age_allowed(age=0):' }
			}
		]
	},
	{
		name: 'delivery_cost',
		lines: [
			'def delivery_cost(total, express):',
			'    """Доставка: при сумме заказа от 2000 рублей включительно — бесплатно, иначе 300 рублей.',
			'    Экспресс-доставка добавляет 500 рублей в любом случае."""',
			'    cost = 0 if total >= 2000 else 300',
			'    if express:',
			'        cost += 500',
			'    return cost'
		],
		checks: [
			'assert delivery_cost(2000, False) == 0',
			'assert delivery_cost(1999, False) == 300',
			'assert delivery_cost(2000, True) == 500',
			'assert delivery_cost(100, True) == 800'
		],
		defects: [
			{
				kind: 'boundary',
				line: 3,
				text: '    cost = 0 if total > 2000 else 300',
				neighbour: { line: 4, text: '    if express is True:' }
			},
			{
				kind: 'logic',
				line: 4,
				text: '    if not express:',
				neighbour: { line: 6, text: '    return int(cost)' }
			}
		]
	},
	{
		name: 'discounted_price',
		lines: [
			'def discounted_price(price, percent, coupon):',
			'    """Цена в рублях: сначала скидка percent процентов от price (дробная часть рубля отбрасывается),',
			'    затем вычитается купон coupon рублей. Цена не бывает меньше 0."""',
			'    result = price * (100 - percent) // 100 - coupon',
			'    return max(result, 0)'
		],
		checks: [
			'assert discounted_price(1000, 10, 100) == 800',
			'assert discounted_price(995, 15, 0) == 845',
			'assert discounted_price(100, 0, 150) == 0',
			'assert discounted_price(1000, 50, 100) == 400'
		],
		defects: [
			{
				kind: 'order',
				line: 3,
				text: '    result = (price - coupon) * (100 - percent) // 100',
				neighbour: { line: 4, text: '    return result if result > 0 else 0' }
			},
			{
				kind: 'rounding',
				line: 3,
				text: '    result = round(price * (100 - percent) / 100) - coupon',
				neighbour: { line: 4, text: '    return result if result > 0 else 0' }
			}
		]
	},
	{
		name: 'password_error',
		lines: [
			'def password_error(password):',
			'    """Первая нарушенная проверка пароля по порядку: пустой — "empty"; короче 8 символов — "short";',
			'    нет ни одной цифры — "no_digit". Все проверки пройдены — None."""',
			'    checks = [',
			'        ("empty", password == ""),',
			'        ("short", len(password) < 8),',
			'        ("no_digit", not any(c.isdigit() for c in password)),',
			'    ]',
			'    for code, failed in checks:',
			'        if failed:',
			'            return code',
			'    return None'
		],
		checks: [
			'assert password_error("") == "empty"',
			'assert password_error("abc") == "short"',
			'assert password_error("abc1") == "short"',
			'assert password_error("abcdefgh") == "no_digit"',
			'assert password_error("abcdefg1") is None'
		],
		defects: [
			{
				kind: 'order',
				line: 8,
				text: '    for code, failed in sorted(checks):',
				neighbour: { line: 9, text: '        if failed is True:' }
			},
			{
				kind: 'boundary',
				line: 5,
				text: '        ("short", len(password) <= 8),',
				neighbour: { line: 4, text: '        ("empty", not password),' }
			},
			{
				kind: 'logic',
				line: 6,
				text: '        ("no_digit", any(c.isdigit() for c in password)),',
				neighbour: { line: 5, text: '        ("short", len(password) < 8 and password != ""),' }
			}
		]
	},
	{
		name: 'late_fee',
		lines: [
			'def late_fee(days_late):',
			'    """Пеня за возврат книги: первые 3 дня просрочки бесплатно, далее 50 рублей за каждый день',
			'    сверх трёх, но всего не больше 1000 рублей."""',
			'    if days_late <= 3:',
			'        return 0',
			'    return min((days_late - 3) * 50, 1000)'
		],
		checks: [
			'assert late_fee(0) == 0',
			'assert late_fee(3) == 0',
			'assert late_fee(4) == 50',
			'assert late_fee(22) == 950',
			'assert late_fee(23) == 1000',
			'assert late_fee(40) == 1000'
		],
		defects: [
			{
				kind: 'boundary',
				line: 5,
				text: '    return min((days_late - 2) * 50, 1000)',
				neighbour: { line: 3, text: '    if days_late < 3:' }
			},
			{
				kind: 'logic',
				line: 5,
				text: '    return max((days_late - 3) * 50, 1000)',
				neighbour: { line: 3, text: '    if days_late <= 0:' }
			}
		]
	},
	{
		name: 'bonus_points',
		lines: [
			'def bonus_points(amount):',
			'    """Бонусы за покупку: 1 балл за каждые полные 100 рублей суммы; при сумме от 5000 рублей',
			'    включительно баллов вдвое больше."""',
			'    points = amount // 100',
			'    if amount >= 5000:',
			'        points *= 2',
			'    return points'
		],
		checks: [
			'assert bonus_points(99) == 0',
			'assert bonus_points(199) == 1',
			'assert bonus_points(4999) == 49',
			'assert bonus_points(5000) == 100',
			'assert bonus_points(5099) == 100'
		],
		defects: [
			{
				kind: 'rounding',
				line: 3,
				text: '    points = round(amount / 100)',
				neighbour: { line: 6, text: '    return int(points)' }
			},
			{
				kind: 'boundary',
				line: 4,
				text: '    if amount > 5000:',
				neighbour: { line: 3, text: '    points = int(amount / 100)' }
			}
		]
	},
	{
		name: 'order_status',
		lines: [
			'def order_status(paid, shipped, cancelled):',
			'    """Статус заказа: отменённый — "cancelled", даже если он оплачен или отправлен; иначе',
			'    отправленный — "shipped"; иначе оплаченный — "paid"; иначе — "new"."""',
			'    if cancelled:',
			'        return "cancelled"',
			'    if shipped:',
			'        return "shipped"',
			'    if paid:',
			'        return "paid"',
			'    return "new"'
		],
		checks: [
			'assert order_status(True, False, True) == "cancelled"',
			'assert order_status(True, True, True) == "cancelled"',
			'assert order_status(True, True, False) == "shipped"',
			'assert order_status(True, False, False) == "paid"',
			'assert order_status(False, False, False) == "new"'
		],
		defects: [
			{
				kind: 'logic',
				line: 3,
				text: '    if cancelled and not paid:',
				neighbour: { line: 5, text: '    if shipped and paid:' }
			}
		]
	},
	{
		name: 'vat_part',
		lines: [
			'def vat_part(total):',
			'    """НДС 20 % внутри суммы total в копейках: total * 20 / 120, округление до копейки по правилам',
			'    арифметики — половина копейки округляется вверх."""',
			'    return (total * 20 + 60) // 120'
		],
		checks: [
			'assert vat_part(120) == 20',
			'assert vat_part(100) == 17',
			'assert vat_part(3) == 1',
			'assert vat_part(9) == 2',
			'assert vat_part(6) == 1'
		],
		defects: [
			{
				kind: 'rounding',
				line: 3,
				text: '    return total * 20 // 120',
				neighbour: { line: 0, text: 'def vat_part(total=0):' }
			},
			{
				kind: 'rounding',
				line: 3,
				text: '    return round(total * 20 / 120)',
				neighbour: { line: 0, text: 'def vat_part(total=120):' }
			}
		]
	},
	{
		name: 'split_bill',
		lines: [
			'def split_bill(total, people):',
			'    """Делит счёт total копеек на people человек поровну; копейки, которые не делятся поровну,',
			'    доплачивает первый. Возвращает список сумм по людям."""',
			'    share = total // people',
			'    rest = total - share * people',
			'    return [share + rest] + [share] * (people - 1)'
		],
		checks: [
			'assert split_bill(100, 3) == [34, 33, 33]',
			'assert split_bill(200, 3) == [68, 66, 66]',
			'assert split_bill(90, 3) == [30, 30, 30]',
			'assert split_bill(5, 1) == [5]'
		],
		defects: [
			{
				kind: 'rounding',
				line: 3,
				text: '    share = round(total / people)',
				neighbour: { line: 4, text: '    rest = total % people' }
			},
			{
				kind: 'boundary',
				line: 5,
				text: '    return [share + rest] + [share] * people',
				neighbour: { line: 4, text: '    rest = total % people' }
			}
		]
	},
	{
		name: 'coupon_applies',
		lines: [
			'def coupon_applies(day, total):',
			'    """Купон действует с 10-го по 20-е число месяца включительно и только при сумме заказа',
			'    от 1500 рублей включительно."""',
			'    in_period = 10 <= day <= 20',
			'    return in_period and total >= 1500'
		],
		checks: [
			'assert coupon_applies(10, 1500)',
			'assert coupon_applies(20, 1500)',
			'assert not coupon_applies(21, 5000)',
			'assert not coupon_applies(9, 5000)',
			'assert not coupon_applies(15, 1499)'
		],
		defects: [
			{
				kind: 'boundary',
				line: 3,
				text: '    in_period = 10 <= day < 20',
				neighbour: { line: 4, text: '    return total >= 1500 and in_period' }
			},
			{
				kind: 'boundary',
				line: 4,
				text: '    return in_period and total > 1500',
				neighbour: { line: 3, text: '    in_period = day in range(10, 21)' }
			},
			{
				kind: 'logic',
				line: 4,
				text: '    return in_period or total >= 1500',
				neighbour: { line: 3, text: '    in_period = day in range(10, 21)' }
			}
		]
	},
	{
		name: 'price_with_tax',
		lines: [
			'def price_with_tax(net, discount):',
			'    """Цена с налогом в рублях: сначала из net вычитается скидка discount рублей, затем начисляется',
			'    налог 20 %; дробная часть рубля отбрасывается."""',
			'    return (net - discount) * 120 // 100'
		],
		checks: [
			'assert price_with_tax(1000, 100) == 1080',
			'assert price_with_tax(999, 0) == 1198',
			'assert price_with_tax(0, 0) == 0'
		],
		defects: [
			{
				kind: 'order',
				line: 3,
				text: '    return net * 120 // 100 - discount',
				neighbour: { line: 0, text: 'def price_with_tax(net, discount=0):' }
			},
			{
				kind: 'rounding',
				line: 3,
				text: '    return round((net - discount) * 1.2)',
				neighbour: { line: 0, text: 'def price_with_tax(net, discount=0):' }
			}
		]
	},
	{
		name: 'pick_discount',
		lines: [
			'def pick_discount(is_employee, has_coupon, is_birthday):',
			'    """Скидка в процентах; применяется одна, по приоритету: сотруднику — 30, имениннику — 15,',
			'    по купону — 10; иначе 0."""',
			'    for applies, percent in ((is_employee, 30), (is_birthday, 15), (has_coupon, 10)):',
			'        if applies:',
			'            return percent',
			'    return 0'
		],
		checks: [
			'assert pick_discount(True, True, True) == 30',
			'assert pick_discount(False, True, True) == 15',
			'assert pick_discount(False, True, False) == 10',
			'assert pick_discount(False, False, True) == 15',
			'assert pick_discount(False, False, False) == 0'
		],
		defects: [
			{
				kind: 'order',
				line: 3,
				text: '    for applies, percent in ((is_employee, 30), (has_coupon, 10), (is_birthday, 15)):',
				neighbour: { line: 4, text: '        if applies is True:' }
			}
		]
	}
];

const JUNIOR: Fn[] = [
	{
		name: 'loan_decision',
		lines: [
			'def loan_decision(age, income, debt):',
			'    """Решение по заявке на кредит, правила проверяются по порядку:',
			'    - возраст вне 21..70 (оба конца включены) — "reject";',
			'    - нагрузка debt / income больше 0.5 — "reject";',
			'    - доход от 100000 включительно и нагрузка не больше 0.3 — "approve";',
			'    - иначе — "manual"."""',
			'    if age < 21 or age > 70:',
			'        return "reject"',
			'    load = debt / income',
			'    if load > 0.5:',
			'        return "reject"',
			'    if income >= 100000 and load <= 0.3:',
			'        return "approve"',
			'    return "manual"'
		],
		checks: [
			'assert loan_decision(21, 100000, 30000) == "approve"',
			'assert loan_decision(70, 100000, 0) == "approve"',
			'assert loan_decision(20, 100000, 0) == "reject"',
			'assert loan_decision(71, 100000, 0) == "reject"',
			'assert loan_decision(30, 100000, 50000) == "manual"',
			'assert loan_decision(30, 100000, 50001) == "reject"',
			'assert loan_decision(30, 99999, 0) == "manual"',
			'assert loan_decision(30, 100000, 30001) == "manual"',
			'assert loan_decision(30, 200000, 150000) == "reject"'
		],
		defects: [
			{
				kind: 'boundary-of-many',
				line: 6,
				text: '    if age < 21 or age >= 70:',
				neighbour: { line: 8, text: '    load = debt / max(income, 1)' }
			},
			{
				kind: 'boundary-of-many',
				line: 9,
				text: '    if load >= 0.5:',
				neighbour: { line: 11, text: '    if income >= 100000 and load < 0.5:' }
			},
			{
				kind: 'boundary-of-many',
				line: 11,
				text: '    if income > 100000 and load <= 0.3:',
				neighbour: { line: 9, text: '    if load > 0.50:' }
			},
			{
				kind: 'boundary-of-many',
				line: 11,
				text: '    if income >= 100000 and load < 0.3:',
				neighbour: { line: 13, text: '    return "manual" if load > 0.3 else "approve"' }
			},
			{
				kind: 'combination',
				line: 6,
				text: '    if age < 21 and age > 70:',
				neighbour: { line: 8, text: '    load = debt / max(income, 1)' }
			},
			{
				kind: 'combination',
				line: 11,
				text: '    if income >= 100000 or load <= 0.3:',
				neighbour: { line: 13, text: '    return "reject"' }
			}
		]
	},
	{
		name: 'cart_total',
		lines: [
			'def cart_total(lines):',
			'    """Итог корзины в копейках. lines — пары (цена в копейках, количество). На позицию с количеством',
			'    от 10 штук включительно — скидка 5 % от стоимости позиции; скидка каждой позиции округляется',
			'    вниз до копейки отдельно, затем позиции складываются."""',
			'    total = 0',
			'    for price, qty in lines:',
			'        amount = price * qty',
			'        if qty >= 10:',
			'            amount -= amount * 5 // 100',
			'        total += amount',
			'    return total'
		],
		checks: [
			'assert cart_total([(199, 10)]) == 1891',
			'assert cart_total([(199, 10), (333, 11)]) == 5371',
			'assert cart_total([(100, 9)]) == 900',
			'assert cart_total([]) == 0'
		],
		defects: [
			{
				kind: 'rounding-step',
				line: 8,
				text: '            amount -= round(amount * 0.05)',
				neighbour: { line: 6, text: '        amount = qty * price' }
			},
			{
				kind: 'rounding-step',
				line: 8,
				text: '            amount = amount * 95 // 100',
				neighbour: { line: 9, text: '        total = total + amount' }
			},
			{
				kind: 'boundary-of-many',
				line: 7,
				text: '        if qty > 10:',
				neighbour: { line: 8, text: '            amount -= amount // 20' }
			}
		]
	},
	{
		name: 'account_status',
		lines: [
			'def account_status(flags):',
			'    """Итоговый статус счёта по набору флагов: "blocked" важнее "overdue", "overdue" важнее "active";',
			'    пустой набор — "active"."""',
			'    priority = {"blocked": 3, "overdue": 2, "active": 1}',
			'    if not flags:',
			'        return "active"',
			'    return max(flags, key=priority.get)'
		],
		checks: [
			'assert account_status({"active", "overdue"}) == "overdue"',
			'assert account_status({"blocked", "overdue", "active"}) == "blocked"',
			'assert account_status({"overdue", "blocked"}) == "blocked"',
			'assert account_status({"active"}) == "active"',
			'assert account_status(set()) == "active"'
		],
		defects: [
			{
				kind: 'priority',
				line: 3,
				text: '    priority = {"blocked": 3, "overdue": 1, "active": 2}',
				neighbour: { line: 4, text: '    if len(flags) == 0:' }
			},
			{
				kind: 'priority',
				line: 6,
				text: '    return min(flags, key=priority.get)',
				neighbour: { line: 3, text: '    priority = {"blocked": 30, "overdue": 20, "active": 10}' }
			}
		]
	},
	{
		name: 'can_withdraw',
		lines: [
			'def can_withdraw(balance, amount, used_today, vip):',
			'    """Снятие наличных разрешено, только если выполнены все условия:',
			'    - сумма amount от 100 до 50000 рублей включительно;',
			'    - после снятия баланс не меньше 0;',
			'    - снято за день вместе с этой суммой не больше 100000 рублей, для vip — не больше 300000."""',
			'    if amount < 100 or amount > 50000:',
			'        return False',
			'    if balance - amount < 0:',
			'        return False',
			'    limit = 300000 if vip else 100000',
			'    return used_today + amount <= limit'
		],
		checks: [
			'assert can_withdraw(1000, 100, 0, False)',
			'assert not can_withdraw(1000, 99, 0, False)',
			'assert can_withdraw(60000, 50000, 0, False)',
			'assert not can_withdraw(60000, 50001, 0, False)',
			'assert can_withdraw(500, 500, 0, False)',
			'assert not can_withdraw(500, 501, 0, False)',
			'assert can_withdraw(10**6, 1000, 99000, False)',
			'assert not can_withdraw(10**6, 1000, 99001, False)',
			'assert can_withdraw(10**6, 1000, 299000, True)',
			'assert not can_withdraw(10**6, 1000, 299001, True)',
			'assert not can_withdraw(10**6, 1000, 150000, False)'
		],
		defects: [
			{
				kind: 'boundary-of-many',
				line: 5,
				text: '    if amount < 100 or amount >= 50000:',
				neighbour: { line: 7, text: '    if amount > balance:' }
			},
			{
				kind: 'boundary-of-many',
				line: 7,
				text: '    if balance - amount <= 0:',
				neighbour: { line: 5, text: '    if not 100 <= amount <= 50000:' }
			},
			{
				kind: 'boundary-of-many',
				line: 10,
				text: '    return used_today + amount < limit',
				neighbour: { line: 9, text: '    limit = 100000 if not vip else 300000' }
			},
			{
				kind: 'combination',
				line: 5,
				text: '    if amount < 100 and amount > 50000:',
				neighbour: { line: 7, text: '    if amount > balance:' }
			},
			{
				kind: 'combination',
				line: 9,
				text: '    limit = 100000 if vip else 300000',
				neighbour: { line: 10, text: '    return not used_today + amount > limit' }
			}
		]
	},
	{
		name: 'monthly_payments',
		lines: [
			'def monthly_payments(total, months):',
			'    """Платежи рассрочки в копейках: total делится на months частей; каждый платёж, кроме последнего,',
			'    равен total / months с округлением вверх до целого рубля (кратно 100 копейкам); последний —',
			'    остаток, чтобы сумма платежей была равна total."""',
			'    payment = -(-total // months)',
			'    payment = -(-payment // 100) * 100',
			'    last = total - payment * (months - 1)',
			'    return [payment] * (months - 1) + [last]'
		],
		checks: [
			'assert monthly_payments(100000, 3) == [33400, 33400, 33200]',
			'assert monthly_payments(90000, 3) == [30000, 30000, 30000]',
			'assert monthly_payments(100001, 2) == [50100, 49901]',
			'assert monthly_payments(500, 1) == [500]'
		],
		defects: [
			{
				kind: 'rounding-step',
				line: 5,
				text: '    payment = payment // 100 * 100',
				neighbour: { line: 6, text: '    last = total - payment * months + payment' }
			},
			{
				kind: 'rounding-step',
				line: 4,
				text: '    payment = total // months',
				neighbour: { line: 5, text: '    payment = (payment + 99) // 100 * 100' }
			}
		]
	},
	{
		name: 'pick_warehouse',
		lines: [
			'def pick_warehouse(warehouses, city):',
			'    """Склад для отгрузки. warehouses — тройки (имя, город, остаток). Подходят склады с остатком',
			'    больше 0. Склад в городе city важнее любого другого; среди равных по этому признаку — с наибольшим',
			'    остатком; при равных остатках — первый по алфавиту имени. Подходящих нет — None."""',
			'    available = [w for w in warehouses if w[2] > 0]',
			'    if not available:',
			'        return None',
			'    best = min(available, key=lambda w: (w[1] != city, -w[2], w[0]))',
			'    return best[0]'
		],
		checks: [
			'assert pick_warehouse([("a", "Омск", 5), ("b", "Тула", 9)], "Омск") == "a"',
			'assert pick_warehouse([("a", "Омск", 0), ("b", "Тула", 9)], "Омск") == "b"',
			'assert pick_warehouse([("c", "Тула", 4), ("b", "Тула", 4)], "Омск") == "b"',
			'assert pick_warehouse([("x", "Тула", 3), ("y", "Тула", 7)], "Омск") == "y"',
			'assert pick_warehouse([], "Омск") is None',
			'assert pick_warehouse([("a", "Омск", 0)], "Омск") is None'
		],
		defects: [
			{
				kind: 'priority',
				line: 7,
				text: '    best = min(available, key=lambda w: (-w[2], w[1] != city, w[0]))',
				neighbour: { line: 8, text: '    return best[0] if best else None' }
			},
			{
				kind: 'boundary-of-many',
				line: 4,
				text: '    available = [w for w in warehouses if w[2] >= 0]',
				neighbour: { line: 5, text: '    if len(available) == 0:' }
			}
		]
	},
	{
		name: 'exam_result',
		lines: [
			'def exam_result(score, attempt):',
			'    """Итог экзамена. Проходной балл с первой попытки — 60, с любой следующей — 70 (оба включительно).',
			'    От 90 баллов включительно с первой попытки — "excellent"; иначе прошёл — "passed",',
			'    не прошёл — "failed"."""',
			'    threshold = 60 if attempt == 1 else 70',
			'    if score >= 90 and attempt == 1:',
			'        return "excellent"',
			'    if score >= threshold:',
			'        return "passed"',
			'    return "failed"'
		],
		checks: [
			'assert exam_result(60, 1) == "passed"',
			'assert exam_result(59, 1) == "failed"',
			'assert exam_result(70, 2) == "passed"',
			'assert exam_result(69, 2) == "failed"',
			'assert exam_result(90, 1) == "excellent"',
			'assert exam_result(89, 1) == "passed"',
			'assert exam_result(95, 2) == "passed"',
			'assert exam_result(65, 3) == "failed"'
		],
		defects: [
			{
				kind: 'boundary-of-many',
				line: 5,
				text: '    if score > 90 and attempt == 1:',
				neighbour: { line: 4, text: '    threshold = 70 if attempt > 1 else 60' }
			},
			{
				kind: 'boundary-of-many',
				line: 7,
				text: '    if score > threshold:',
				neighbour: { line: 5, text: '    if attempt == 1 and score >= 90:' }
			},
			{
				kind: 'combination',
				line: 5,
				text: '    if score >= 90 or attempt == 1:',
				neighbour: { line: 7, text: '    if not score < threshold:' }
			},
			{
				kind: 'combination',
				line: 4,
				text: '    threshold = 60 if attempt > 1 else 70',
				neighbour: { line: 7, text: '    if not score < threshold:' }
			}
		]
	},
	{
		name: 'receipt_total',
		lines: [
			'def receipt_total(subtotal, discount_pct, vat_pct):',
			'    """Сумма чека в копейках: сначала скидка discount_pct % от subtotal, затем НДС vat_pct % на сумму',
			'    после скидки. Скидка и налог считаются в копейках и каждый округляется вниз отдельно."""',
			'    discount = subtotal * discount_pct // 100',
			'    after_discount = subtotal - discount',
			'    vat = after_discount * vat_pct // 100',
			'    return after_discount + vat'
		],
		checks: [
			'assert receipt_total(1999, 15, 20) == 2040',
			'assert receipt_total(1703, 0, 20) == 2043',
			'assert receipt_total(1000, 10, 20) == 1080',
			'assert receipt_total(0, 50, 20) == 0'
		],
		defects: [
			{
				kind: 'rounding-step',
				line: 3,
				text: '    discount = -(-subtotal * discount_pct // 100)',
				neighbour: { line: 4, text: '    after_discount = subtotal - int(discount)' }
			},
			{
				kind: 'rounding-step',
				line: 5,
				text: '    vat = round(after_discount * vat_pct / 100)',
				neighbour: { line: 6, text: '    return vat + after_discount' }
			},
			{
				kind: 'priority',
				line: 5,
				text: '    vat = subtotal * vat_pct // 100',
				neighbour: { line: 4, text: '    after_discount = subtotal - discount if discount else subtotal' }
			}
		]
	},
	{
		name: 'route_ticket',
		lines: [
			'def route_ticket(security, plan, minutes_waiting):',
			'    """Очередь обращения в поддержку; срабатывает первое подходящее правило по приоритету:',
			'    1) вопрос безопасности (security) — "security";',
			'    2) тариф plan == "enterprise" — "priority";',
			'    3) ожидание больше 60 минут — "escalated";',
			'    4) иначе — "general"."""',
			'    rules = {',
			'        "security": (security, "security"),',
			'        "plan": (plan == "enterprise", "priority"),',
			'        "waiting": (minutes_waiting > 60, "escalated"),',
			'    }',
			'    for name in ("security", "plan", "waiting"):',
			'        matched, queue = rules[name]',
			'        if matched:',
			'            return queue',
			'    return "general"'
		],
		checks: [
			'assert route_ticket(True, "enterprise", 100) == "security"',
			'assert route_ticket(True, "basic", 0) == "security"',
			'assert route_ticket(False, "enterprise", 100) == "priority"',
			'assert route_ticket(False, "enterprise", 0) == "priority"',
			'assert route_ticket(False, "basic", 61) == "escalated"',
			'assert route_ticket(False, "basic", 60) == "general"'
		],
		defects: [
			{
				kind: 'priority',
				line: 11,
				text: '    for name in ("security", "waiting", "plan"):',
				neighbour: { line: 12, text: '        matched, queue = rules.get(name)' }
			},
			{
				kind: 'boundary-of-many',
				line: 9,
				text: '        "waiting": (minutes_waiting >= 60, "escalated"),',
				neighbour: { line: 8, text: '        "plan": (plan in ("enterprise",), "priority"),' }
			},
			{
				kind: 'combination',
				line: 8,
				text: '        "plan": (plan != "enterprise", "priority"),',
				neighbour: { line: 7, text: '        "security": (security is True, "security"),' }
			}
		]
	}
];

const MODULE_TITLES = [
	'Правила оформления заказа',
	'Бизнес-правила личного кабинета',
	'Правила расчётов интернет-магазина',
	'Проверки и статусы сервиса заявок'
];
const HEADER_CONSTANTS = [
	'CURRENCY = "RUB"',
	'RULES_VERSION = "2026.10"',
	'LOCALE = "ru-RU"',
	'SUPPORT_EMAIL = "support@example.com"',
	'TIMEZONE = "Europe/Moscow"',
	'AUDIT = True'
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
	const constants = rng.sample(HEADER_CONSTANTS, rng.int(0, 5));
	const lines: string[] = [
		`"""${rng.pick(MODULE_TITLES)}."""`,
		...(rng.bool() ? ['', 'import math'] : []),
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
			// A defect of the same kind in a correct function is the most tempting wrong line.
			const sibling = fn.defects.find((d) => d.kind === kind) ?? fn.defects[0];
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
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const intern = input.grade === 'intern';
	const p = compose(rng, intern ? INTERN : JUNIOR, input.classId, 4);
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown: [
				'Модуль бизнес-правил на Python 3. Спецификация каждой функции записана в её строке документации — это требования, по которым идёт проверка.',
				'',
				intern
					? 'Тестировщик прогнал функции на граничных и типичных входах из спецификации: одна функция ведёт себя не так, как описано.'
					: 'Тестировщик прогнал функции на граничных значениях каждого условия и на их сочетаниях: одна функция ведёт себя не так, как описано.',
				'Ровно одна строка модуля расходится со спецификацией своей функции: если заменить только её, все функции будут работать по спецификации.',
				'',
				'Введите номер этой строки (нумерация с 1). Например: `17`.'
			].join('\n'),
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
