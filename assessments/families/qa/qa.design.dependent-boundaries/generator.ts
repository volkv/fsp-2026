// Boundary values of a computed quantity, found on the input: an order sum that is price × quantity, a date counted
// from another date, an amount with its fee against a limit, a price that drops with volume — and at the senior level
// several constraints of which only the strictest bound the domain, a fee with a lower rate above a step, and a linear
// boundary of two integer inputs. Two-point boundary value analysis throughout.
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

type Params =
	| { kind: 'computed-sum'; item: string; price: number; low: number; high: number }
	| { kind: 'date-window'; start: number; min: number; max: number }
	| { kind: 'fee-limit'; limit: number; rate: number; minFee: number; level: string }
	| {
			kind: 'tier-price';
			item: string;
			price: number;
			bulkPrice: number;
			bulkFrom: number;
			threshold: number;
			maxQty: number;
	  }
	| {
			kind: 'effective-domain';
			item: string;
			price: number;
			grams: number;
			maxQty: number;
			maxKg: number;
			minSum: number;
	  }
	| { kind: 'lattice-2d'; a: number; b: number; capacity: number; things: [string, string] }
	| {
			kind: 'fee-tiers';
			limit: number;
			minAmount: number;
			step: number;
			rateLow: number;
			rateHigh: number;
			minFee: number;
	  }
	| { kind: 'date-caps'; start: number; min: number; max: number; opens: number; closes: number };

interface Rules {
	onSum: boolean;
	roundWrong: boolean;
	inclusive: boolean;
	month30: boolean;
	ignoreFee: boolean;
	roundDown: boolean;
	monotonic: boolean;
	allConstraints: boolean;
	offPoint: boolean;
}

const RIGHT: Rules = {
	onSum: false,
	roundWrong: false,
	inclusive: false,
	month30: false,
	ignoreFee: false,
	roundDown: false,
	monotonic: false,
	allConstraints: false,
	offPoint: false
};

const DAY = 86_400_000;
const YEAR_START = Date.UTC(2026, 0, 1) / DAY;

function iso(day: number): string {
	return new Date(day * DAY).toISOString().slice(0, 10);
}

/** Adding days as if every month had 30 days: the date may not exist. */
function add30(day: number, n: number): string {
	const d = new Date(day * DAY);
	const t = d.getUTCFullYear() * 360 + d.getUTCMonth() * 30 + (d.getUTCDate() - 1) + n;
	const y = Math.floor(t / 360);
	const m = Math.floor((t % 360) / 30) + 1;
	const dd = (t % 30) + 1;
	return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** A date written in Russian for the statement, e.g. «28 февраля 2026». */
function human(day: number): string {
	const months = [
		'января',
		'февраля',
		'марта',
		'апреля',
		'мая',
		'июня',
		'июля',
		'августа',
		'сентября',
		'октября',
		'ноября',
		'декабря'
	];
	const d = new Date(day * DAY);
	return `${d.getUTCDate()} ${months[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

/** A per-mille rate as a percentage with a decimal comma: 15 → «1,5». */
const percent = (perMille: number): string => String(perMille / 10).replace('.', ',');

const ceilDiv = (a: number, b: number): number => Math.ceil(a / b);
const floorDiv = (a: number, b: number): number => Math.floor(a / b);

/** Distinct numbers, ascending. */
const numbers = (xs: readonly number[]): string[] => [...new Set(xs)].sort((a, b) => a - b).map(String);

const key = (lines: readonly string[]): string => [...lines].sort().join(' ');

/** The fee of an amount: per-mille rate, rounded up to a rouble (or down), not less than the minimum. */
function fee(amount: number, perMille: number, minFee: number, rules: Rules): number {
	const raw = (amount * perMille) / 1000;
	return Math.max(minFee, rules.roundDown ? Math.floor(raw) : Math.ceil(raw));
}

/** The largest amount in [from, to] with amount + fee ≤ limit (fee non-decreasing on the band), or from − 1. */
function largest(from: number, to: number, ok: (amount: number) => boolean): number {
	let lo = from - 1;
	let hi = to;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi + 1) / 2);
		if (mid <= to && ok(mid)) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

function solve(p: Params, rules: Rules): string[] {
	switch (p.kind) {
		case 'computed-sum': {
			if (rules.onSum) return numbers([p.low - 1, p.low, p.high, p.high + 1]);
			const lo = rules.roundWrong ? floorDiv(p.low, p.price) : ceilDiv(p.low, p.price);
			const hi = rules.roundWrong ? ceilDiv(p.high, p.price) : floorDiv(p.high, p.price);
			return numbers([lo - 1, lo, hi, hi + 1]);
		}
		case 'date-window':
		case 'date-caps': {
			const shift = rules.inclusive ? -1 : 0;
			const fromStart = (n: number): number => p.start + n + shift;
			const text = (n: number, extra: number): string =>
				rules.month30 ? add30(p.start, n + shift + extra) : iso(fromStart(n) + extra);
			if (p.kind === 'date-window') return [text(p.min, -1), text(p.min, 0), text(p.max, 0), text(p.max, 1)];
			// The caps of the season are plain dates; the window is counted from the start.
			const lows: [string, string][] = [
				[text(p.min, -1), text(p.min, 0)],
				[iso(p.opens - 1), iso(p.opens)]
			];
			const highs: [string, string][] = [
				[text(p.max, 0), text(p.max, 1)],
				[iso(p.closes), iso(p.closes + 1)]
			];
			if (rules.allConstraints) return [...lows, ...highs].flat();
			const low = fromStart(p.min) >= p.opens ? lows[0] : lows[1];
			const high = fromStart(p.max) <= p.closes ? highs[0] : highs[1];
			return [...(low ?? []), ...(high ?? [])];
		}
		case 'fee-limit': {
			if (rules.ignoreFee) return numbers([p.limit, p.limit + 1]);
			const a = largest(1, p.limit, (x) => x + fee(x, p.rate, p.minFee, rules) <= p.limit);
			return numbers([a, a + 1]);
		}
		case 'tier-price': {
			const sum = (q: number): number => q * (q >= p.bulkFrom && !rules.monotonic ? p.bulkPrice : p.price);
			if (rules.onSum) return numbers([p.threshold - 1, p.threshold]);
			const out: number[] = [];
			for (let q = 1; q < p.maxQty; q += 1) if (sum(q) >= p.threshold !== sum(q + 1) >= p.threshold) out.push(q, q + 1);
			return out.length ? numbers(out) : ['-'];
		}
		case 'effective-domain': {
			const sumLow = rules.roundWrong ? floorDiv(p.minSum, p.price) : ceilDiv(p.minSum, p.price);
			const weightHigh = rules.roundWrong ? ceilDiv(p.maxKg * 1000, p.grams) : floorDiv(p.maxKg * 1000, p.grams);
			if (rules.allConstraints)
				return numbers([0, 1, sumLow - 1, sumLow, p.maxQty, p.maxQty + 1, weightHigh, weightHigh + 1]);
			const lo = Math.max(1, sumLow);
			const hi = Math.min(p.maxQty, weightHigh);
			return numbers([lo - 1, lo, hi, hi + 1]);
		}
		case 'lattice-2d': {
			let on = 0;
			const rows: string[] = [];
			for (let y = 0; y * p.b <= p.capacity; y += 1) {
				const left = p.capacity - y * p.b;
				if (left % p.a === 0) on += 1;
				const x = rules.roundWrong ? Math.round(left / p.a) : Math.floor(left / p.a);
				rows.push(`${rules.offPoint ? x + 1 : x},${y}`);
			}
			return [String(on), ...rows];
		}
		case 'fee-tiers': {
			const rate = (x: number): number => (x >= p.step && !rules.monotonic ? p.rateHigh : p.rateLow);
			const ok = (x: number): boolean => x + fee(x, rate(x), rules.ignoreFee ? 0 : p.minFee, rules) <= p.limit;
			const out = [p.minAmount - 1, p.minAmount];
			const first = largest(p.minAmount, p.step - 1, ok);
			if (first < p.step - 1 || rules.monotonic) {
				const end = rules.monotonic ? largest(p.minAmount, p.limit, ok) : first;
				out.push(end, end + 1);
			}
			if (!rules.monotonic && ok(p.step)) {
				if (first < p.step - 1) out.push(p.step - 1, p.step);
				const second = largest(p.step, p.limit, ok);
				out.push(second, second + 1);
			}
			return numbers(out);
		}
	}
}

const ITEMS = ['кабель USB-C', 'картридж', 'набор маркеров', 'флешка', 'чехол', 'наушники', 'клавиатура'];
const LEVELS = ['базовый', 'серебряный', 'золотой'];

function scenario(rng: Rng, classId: string): Params {
	switch (classId) {
		case 'computed-sum': {
			const price = rng.int(37, 990);
			const low = rng.int(4, 30) * price + rng.int(1, price - 1);
			const high = low + rng.int(10, 60) * price + rng.int(1, price - 1);
			return { kind: 'computed-sum', item: rng.pick(ITEMS), price, low, high };
		}
		case 'date-window': {
			// The window crosses the end of a month that is not 30 days long.
			const start = YEAR_START + rng.int(0, 364);
			return { kind: 'date-window', start, min: rng.int(2, 12), max: rng.int(20, 75) };
		}
		case 'fee-limit': {
			const rate = rng.int(5, 35);
			return {
				kind: 'fee-limit',
				limit: rng.int(20, 600) * 500 + rng.pick([0, 100, 250]),
				rate,
				minFee: rng.int(3, 20) * 10,
				level: rng.pick(LEVELS)
			};
		}
		case 'tier-price': {
			const price = rng.int(40, 400);
			const bulkPrice = Math.round(price * rng.int(55, 85)) / 100;
			const bulk = Math.max(1, Math.round(bulkPrice));
			const bulkFrom = rng.int(10, 40);
			// The threshold falls between the sum just before the step and the sum at it.
			const before = (bulkFrom - 1) * price;
			const at = bulkFrom * bulk;
			const threshold = at < before ? rng.int(at + 1, before) : before;
			return {
				kind: 'tier-price',
				item: rng.pick(ITEMS),
				price,
				bulkPrice: bulk,
				bulkFrom,
				threshold,
				maxQty: bulkFrom + rng.int(15, 60)
			};
		}
		case 'effective-domain': {
			const price = rng.int(90, 2500);
			const grams = rng.int(70, 1900);
			const maxQty = rng.int(20, 200);
			return {
				kind: 'effective-domain',
				item: rng.pick(ITEMS),
				price,
				grams,
				maxQty,
				maxKg: Math.max(1, Math.round((maxQty * grams * rng.int(60, 140)) / 100_000)),
				minSum: rng.int(2, 15) * price + rng.int(1, price - 1)
			};
		}
		case 'lattice-2d': {
			const pair = rng.pick([
				['ноутбуков', 'мониторов'],
				['коробок', 'мешков'],
				['принтеров', 'сканеров'],
				['серверов', 'стоек ИБП']
			] as const);
			const a = rng.int(2, 9);
			let b = rng.int(3, 12);
			if (b === a) b += 1;
			return { kind: 'lattice-2d', a, b, capacity: rng.int(30, 90), things: [pair[0], pair[1]] };
		}
		case 'fee-tiers': {
			const step = rng.int(10, 30) * 5000;
			const rateLow = rng.int(12, 25);
			const rateHigh = rng.int(2, 5);
			const minFee = Math.ceil(((step * rateHigh) / 1000) * 1.3) + rng.int(1, 30) * 10;
			const room = Math.floor((step * rateLow) / 1000) - minFee;
			return {
				kind: 'fee-tiers',
				limit: step + minFee + rng.int(1, Math.max(1, room - 1)),
				minAmount: rng.int(1, 50) * 100,
				step,
				rateLow,
				rateHigh,
				minFee
			};
		}
		case 'date-caps': {
			const start = YEAR_START + rng.int(0, 300);
			const min = rng.int(2, 10);
			const max = rng.int(25, 60);
			// One cap of the season is stricter than the window, the other is not.
			const lowCap = rng.bool();
			return {
				kind: 'date-caps',
				start,
				min,
				max,
				opens: lowCap ? start + min + rng.int(1, 8) : start + min - rng.int(1, 8),
				closes: lowCap ? start + max + rng.int(1, 10) : start + max - rng.int(1, 10)
			};
		}
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function suits(p: Params, answer: readonly string[]): boolean {
	switch (p.kind) {
		case 'tier-price':
			return answer.length >= 6;
		case 'effective-domain': {
			const lo = Math.max(1, ceilDiv(p.minSum, p.price));
			const hi = Math.min(p.maxQty, floorDiv(p.maxKg * 1000, p.grams));
			return lo + 3 < hi && p.maxKg * 1000 !== hi * p.grams;
		}
		case 'fee-tiers':
			return answer.length === 8;
		case 'lattice-2d':
			return Math.floor(p.capacity / p.b) >= 3;
		default:
			return true;
	}
}

const BVA =
	'Граничные значения ищутся двухточечным методом: для каждой границы условия берутся два соседних значения входа — последнее по одну сторону границы и первое по другую.';

function describe(p: Params): string {
	switch (p.kind) {
		case 'computed-sum':
			return [
				`Товар «${p.item}» стоит ${p.price} ₽ за штуку; количество в заказе — целое число от 1. Скидка 10% действует, если сумма заказа (цена × количество) не меньше ${p.low} ₽ и не больше ${p.high} ₽.`,
				'',
				BVA,
				'',
				'Введите граничные значения **количества** для условия скидки по одному в строке, в любом порядке. Например:',
				'',
				'```',
				'9',
				'10',
				'31',
				'32',
				'```'
			].join('\n');
		case 'date-window':
			return [
				`Аренда начинается ${human(p.start)}. Дата окончания должна быть не раньше, чем через ${p.min} дн. после даты начала, и не позже, чем через ${p.max} дн. после неё (через 1 день после 10 марта — 11 марта).`,
				'',
				BVA,
				'',
				'Введите граничные значения даты окончания в формате `ГГГГ-ММ-ДД` по одному в строке, в любом порядке. Например:',
				'',
				'```',
				'2026-03-14',
				'2026-03-15',
				'2026-04-20',
				'2026-04-21',
				'```'
			].join('\n');
		case 'fee-limit':
			return [
				`Клиент уровня «${p.level}» переводит целую сумму в рублях. За перевод берётся комиссия ${percent(p.rate)}% от суммы, округлённая вверх до целого рубля, но не меньше ${p.minFee} ₽. Перевод разрешён, если сумма вместе с комиссией не больше лимита уровня — ${p.limit} ₽.`,
				'',
				BVA,
				'',
				'Введите граничные значения суммы перевода для верхней границы — наибольшую разрешённую сумму и следующую за ней — по одному в строке, в любом порядке. Например:',
				'',
				'```',
				'48750',
				'48751',
				'```'
			].join('\n');
		case 'tier-price':
			return [
				`Товар «${p.item}» стоит ${p.price} ₽ за штуку, а при заказе от ${p.bulkFrom} шт. — ${p.bulkPrice} ₽ за штуку на весь заказ. Бесплатная доставка действует, если сумма заказа не меньше ${p.threshold} ₽. Количество в заказе — от 1 до ${p.maxQty} шт.`,
				'',
				BVA,
				'',
				`Введите все граничные значения **количества** для условия бесплатной доставки в пределах от 1 до ${p.maxQty} по одному в строке, в любом порядке. Например:`,
				'',
				'```',
				'7',
				'8',
				'12',
				'13',
				'```'
			].join('\n');
		case 'effective-domain':
			return [
				`Товар «${p.item}» стоит ${p.price} ₽ и весит ${p.grams} г за штуку. Заказ принимается, если одновременно:`,
				'',
				'- количество — целое число от 1;',
				`- количество не больше ${p.maxQty} шт.;`,
				`- общий вес заказа не больше ${p.maxKg} кг;`,
				`- сумма заказа не меньше ${p.minSum} ₽.`,
				'',
				`${BVA} Граница — только там, где заказ меняется с принимаемого на непринимаемый.`,
				'',
				'Введите граничные значения количества по одному в строке, в любом порядке. Например:',
				'',
				'```',
				'2',
				'3',
				'57',
				'58',
				'```'
			].join('\n');
		case 'lattice-2d':
			return [
				`В фургон грузят x ${p.things[0]} по ${p.a} ед. объёма и y ${p.things[1]} по ${p.b} ед. объёма; x и y — целые, не меньше 0. Погрузка допустима, если ${p.a}·x + ${p.b}·y ≤ ${p.capacity}.`,
				'',
				'Для тестов на границе нужны точки (x, y) на самой линии границы — где объём ровно равен вместимости, — и для каждого возможного y наибольшее допустимое x.',
				'',
				`Введите по одному в строке, в любом порядке: число целых точек (x, y) с x, y ≥ 0 на линии ${p.a}·x + ${p.b}·y = ${p.capacity} и для каждого y = 0, 1, 2, …, пока при x = 0 погрузка допустима, точку с наибольшим допустимым x в виде \`x,y\` (без пробелов). Например:`,
				'',
				'```',
				'2',
				'10,0',
				'8,1',
				'5,2',
				'3,3',
				'0,4',
				'```'
			].join('\n');
		case 'fee-tiers':
			return [
				`Перевод — целая сумма в рублях, не меньше ${p.minAmount} ₽. Комиссия — ${percent(p.rateLow)}% от суммы для сумм меньше ${p.step} ₽ и ${percent(p.rateHigh)}% от суммы для сумм от ${p.step} ₽; комиссия округляется вверх до целого рубля, но не меньше ${p.minFee} ₽. Перевод разрешён, если сумма вместе с комиссией не больше ${p.limit} ₽.`,
				'',
				BVA,
				'',
				'Введите все граничные значения суммы перевода для условия «перевод разрешён» по одному в строке, в любом порядке. Например:',
				'',
				'```',
				'99',
				'100',
				'61800',
				'61801',
				'```'
			].join('\n');
		case 'date-caps':
			return [
				`Прокат снаряжения начинается ${human(p.start)}. Дата возврата должна быть не раньше, чем через ${p.min} дн. после начала, и не позже, чем через ${p.max} дн. после него (через 1 день после 10 марта — 11 марта). Кроме того, пункт проката принимает возвраты только с ${human(p.opens)} по ${human(p.closes)} включительно.`,
				'',
				`${BVA} Граница — только там, где дата меняется с допустимой на недопустимую.`,
				'',
				'Введите граничные значения даты возврата в формате `ГГГГ-ММ-ДД` по одному в строке, в любом порядке. Например:',
				'',
				'```',
				'2026-03-14',
				'2026-03-15',
				'2026-04-20',
				'2026-04-21',
				'```'
			].join('\n');
	}
}

const PYTHON_REFERENCE = `import json
from datetime import date, timedelta

p = json.loads(input())
k = p["kind"]


def flips(allowed, first, last):
    out = []
    for x in range(first, last):
        if allowed(x) != allowed(x + 1):
            out += [x, x + 1]
    return sorted(set(out))


def fee(amount, per_mille, minimum):
    return max(minimum, -(-amount * per_mille // 1000))


def day(n):
    return (date(1970, 1, 1) + timedelta(days=n)).isoformat()


if k == "computed-sum":
    ok = lambda q: p["low"] <= p["price"] * q <= p["high"]
    out = "\\n".join(map(str, flips(ok, 0, p["high"] // p["price"] + 2)))
elif k == "date-window":
    s = p["start"]
    ok = lambda d: s + p["min"] <= d <= s + p["max"]
    out = "\\n".join(day(d) for d in flips(ok, s, s + p["max"] + 3))
elif k == "fee-limit":
    ok = lambda a: a + fee(a, p["rate"], p["minFee"]) <= p["limit"]
    out = "\\n".join(map(str, flips(ok, 1, p["limit"] + 1)))
elif k == "tier-price":
    total = lambda q: q * (p["bulkPrice"] if q >= p["bulkFrom"] else p["price"])
    ok = lambda q: total(q) >= p["threshold"]
    out = "\\n".join(map(str, flips(ok, 1, p["maxQty"])))
elif k == "effective-domain":
    ok = lambda q: 1 <= q <= p["maxQty"] and q * p["grams"] <= p["maxKg"] * 1000 and q * p["price"] >= p["minSum"]
    out = "\\n".join(map(str, flips(ok, 0, p["maxQty"] + 2)))
elif k == "lattice-2d":
    a, b, c = p["a"], p["b"], p["capacity"]
    on = sum(1 for x in range(c + 1) for y in range(c + 1) if a * x + b * y == c)
    lines = [str(on)]
    y = 0
    while b * y <= c:
        lines.append(f"{max(x for x in range(c + 1) if a * x + b * y <= c)},{y}")
        y += 1
    out = "\\n".join(lines)
elif k == "fee-tiers":
    rate = lambda a: p["rateHigh"] if a >= p["step"] else p["rateLow"]
    ok = lambda a: a >= p["minAmount"] and a + fee(a, rate(a), p["minFee"]) <= p["limit"]
    out = "\\n".join(map(str, flips(ok, p["minAmount"] - 1, p["limit"] + 1)))
elif k == "date-caps":
    s = p["start"]
    ok = lambda d: max(s + p["min"], p["opens"]) <= d <= min(s + p["max"], p["closes"])
    out = "\\n".join(day(d) for d in flips(ok, s, max(s + p["max"], p["closes"]) + 3))
print(out)
`;

const WRONG: Record<string, Partial<Rules>> = {
	'boundary-on-sum': { onSum: true },
	'round-wrong': { roundWrong: true },
	'inclusive-count': { inclusive: true },
	'month-30': { month30: true },
	'ignore-fee': { ignoreFee: true },
	'round-down': { roundDown: true },
	'monotonic-assumption': { monotonic: true },
	'all-constraints': { allConstraints: true },
	'off-point': { offPoint: true }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	'computed-sum': ['boundary-on-sum', 'round-wrong'],
	'date-window': ['inclusive-count', 'month-30'],
	'fee-limit': ['ignore-fee', 'round-down'],
	'tier-price': ['monotonic-assumption', 'boundary-on-sum'],
	'effective-domain': ['all-constraints', 'round-wrong'],
	'lattice-2d': ['round-wrong', 'off-point'],
	'fee-tiers': ['monotonic-assumption', 'ignore-fee'],
	'date-caps': ['all-constraints', 'inclusive-count']
};

/** Misconceptions that do not touch a class's computation: they would give the right answer by construction. */
const APPLIES: Record<string, string[]> = {
	'computed-sum': ['boundary-on-sum', 'round-wrong'],
	'date-window': ['inclusive-count', 'month-30'],
	'fee-limit': ['ignore-fee', 'round-down'],
	'tier-price': ['monotonic-assumption', 'boundary-on-sum'],
	'effective-domain': ['all-constraints', 'round-wrong'],
	'lattice-2d': ['round-wrong', 'off-point'],
	'fee-tiers': ['monotonic-assumption', 'ignore-fee', 'round-down'],
	'date-caps': ['all-constraints', 'inclusive-count', 'month-30']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { classId } = input;
	// Scenarios are drawn until the question is well posed and every misconception the class must expose changes
	// the answer.
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = scenario(rng, classId);
		const answer = solve(p, RIGHT);
		if (!suits(p, answer)) continue;
		const wrong: Record<string, string[] | null> = {};
		for (const [id, change] of Object.entries(WRONG)) {
			const value = (APPLIES[classId] ?? []).includes(id) ? solve(p, { ...RIGHT, ...change }) : answer;
			wrong[id] = key(value) === key(answer) ? null : value;
		}
		if ((REQUIRED[classId] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
