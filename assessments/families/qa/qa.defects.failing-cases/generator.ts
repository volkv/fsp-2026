// Which test cases fail: a business rule's specification, its implementation with a defect and a list of test cases
// (input and the result the specification expects). The tester names the cases whose actual result differs from the
// expected one. Which inputs expose the defect is the point: a shifted boundary fails only on the threshold, a masked
// boundary only when the other condition holds, rounding only on remainders of the right kind. The kind of defect is
// the essential class; the rule, its thresholds, the inputs and the case ids are surface.
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

type V = number | boolean | string | null | V[];

/** A rule with a concrete defect: what the specification and the shown implementation say about any input. */
interface Rule {
	name: string;
	spec: string[];
	/** The implementation the candidate sees, with the defect. */
	source: string[];
	call: (args: V[]) => string;
	expected: (args: V[]) => V;
	actual: (args: V[]) => V;
	pool: V[][];
	/** The input sits exactly on a threshold of the rule. */
	boundary: (args: V[]) => boolean;
	/** The input belongs to the class the defective code is about, whether or not the defect shows on it. */
	touches: (args: V[]) => boolean;
	/** The result is a refusal (False); `null` — the rule has no refusal. */
	negative: ((value: V) => boolean) | null;
}

const num = (v: V | undefined): number => {
	if (typeof v !== 'number') throw new Error(`number expected, got ${JSON.stringify(v)}`);
	return v;
};
const flag = (v: V | undefined): boolean => {
	if (typeof v !== 'boolean') throw new Error(`boolean expected, got ${JSON.stringify(v)}`);
	return v;
};
const text = (v: V | undefined): string => {
	if (typeof v !== 'string') throw new Error(`string expected, got ${JSON.stringify(v)}`);
	return v;
};

function py(v: V): string {
	if (v === null) return 'None';
	if (v === true) return 'True';
	if (v === false) return 'False';
	if (typeof v === 'number') return String(v);
	if (typeof v === 'string') return JSON.stringify(v);
	return `[${v.map(py).join(', ')}]`;
}

const plainCall =
	(name: string) =>
	(args: V[]): string =>
		`${name}(${args.map(py).join(', ')})`;

/** Python's round(p / q) for non-negative integers: halves go to the even neighbour. */
function roundHalfEven(p: number, q: number): number {
	const f = Math.floor(p / q);
	const r = p - f * q;
	if (2 * r > q) return f + 1;
	if (2 * r < q) return f;
	return f % 2 === 0 ? f : f + 1;
}

const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);

// Intern rules.

function canRegister(rng: Rng): Rule {
	const lo = rng.pick([14, 16, 18]);
	const hi = rng.pick([60, 65, 70, 75]);
	const variant = rng.int(0, 2);
	const ok = (a: number) => lo <= a && a <= hi;
	const bad = [(a: number) => lo < a && a <= hi, (a: number) => lo <= a && a < hi, (a: number) => lo < a && a < hi][
		variant
	] as (a: number) => boolean;
	const condition = [`${lo} < age <= ${hi}`, `${lo} <= age < ${hi}`, `${lo} < age < ${hi}`][variant];
	const ages = new Set([
		rng.int(lo - 8, lo - 2),
		lo - 1,
		lo,
		lo + 1,
		rng.int(lo + 2, hi - 2),
		rng.int(lo + 2, hi - 2),
		hi - 1,
		hi,
		hi + 1,
		rng.int(hi + 2, hi + 20)
	]);
	return {
		name: 'can_register',
		spec: [
			`регистрация разрешена, если возраст age от ${lo} до ${hi} лет, оба конца включены;`,
			'функция возвращает True (разрешено) или False.'
		],
		source: ['def can_register(age):', `    return ${condition}`],
		call: plainCall('can_register'),
		expected: ([a]) => ok(num(a)),
		actual: ([a]) => bad(num(a)),
		pool: [...ages].map((a) => [a]),
		boundary: ([a]) => num(a) === lo || num(a) === hi,
		touches: ([a]) => ok(num(a)),
		negative: (v) => v === false
	};
}

function discountPercent(rng: Rng): Rule {
	const t1 = rng.pick([1000, 1500, 2000, 2500, 3000]);
	const t2 = t1 + rng.pick([2000, 3000, 5000]);
	const p1 = rng.pick([3, 5]);
	const p2 = rng.pick([10, 15]);
	const top = rng.bool();
	const right = (t: number) => (t >= t2 ? p2 : t >= t1 ? p1 : 0);
	const wrong = (t: number) => ((top ? t > t2 : t >= t2) ? p2 : (top ? t >= t1 : t > t1) ? p1 : 0);
	const totals = new Set([
		rng.int(100, t1 - 2),
		t1 - 1,
		t1,
		t1 + 1,
		rng.int(t1 + 2, t2 - 2),
		t2 - 1,
		t2,
		t2 + 1,
		rng.int(t2 + 2, t2 + 5000)
	]);
	return {
		name: 'discount_percent',
		spec: [
			`скидка ${p2} % при сумме заказа total от ${t2} рублей включительно;`,
			`скидка ${p1} % при сумме от ${t1} рублей включительно до ${t2} рублей;`,
			'при меньшей сумме — 0;',
			'функция возвращает размер скидки в процентах.'
		],
		source: [
			'def discount_percent(total):',
			`    if total ${top ? '>' : '>='} ${t2}:`,
			`        return ${p2}`,
			`    if total ${top ? '>=' : '>'} ${t1}:`,
			`        return ${p1}`,
			'    return 0'
		],
		call: plainCall('discount_percent'),
		expected: ([t]) => right(num(t)),
		actual: ([t]) => wrong(num(t)),
		pool: [...totals].map((t) => [t]),
		boundary: ([t]) => num(t) === t1 || num(t) === t2,
		touches: ([t]) => (top ? num(t) >= t2 : num(t) >= t1 && num(t) < t2),
		negative: (v) => v === 0
	};
}

function canReturn(rng: Rng): Rule {
	const d = rng.pick([7, 14, 30]);
	const variant = rng.int(0, 1);
	const right = (days: number, opened: boolean) => days <= d && !opened;
	const wrong = (days: number, opened: boolean) => (variant === 0 ? days <= d || !opened : days <= d && opened);
	const days = [rng.int(0, d - 1), rng.int(0, d - 1), d, d + 1, rng.int(d + 2, d + 40)];
	return {
		name: 'can_return',
		spec: [
			`возврат возможен, если с покупки прошло не больше ${d} дней (days) и упаковка не вскрыта (opened = False);`,
			'функция возвращает True (возврат возможен) или False.'
		],
		source: [
			'def can_return(days, opened):',
			`    return days <= ${d} ${variant === 0 ? 'or not opened' : 'and opened'}`
		],
		call: plainCall('can_return'),
		expected: ([a, b]) => right(num(a), flag(b)),
		actual: ([a, b]) => wrong(num(a), flag(b)),
		pool: uniquePool(days.flatMap((x) => [[x, false] as V[], [x, true] as V[]])),
		boundary: ([a]) => num(a) === d,
		touches: () => true,
		negative: (v) => v === false
	};
}

function needsReview(rng: Rng): Rule {
	const limit = rng.pick([50000, 100000, 150000]);
	const variant = rng.int(0, 1);
	const right = (amount: number, fresh: boolean) => amount > limit || fresh;
	const wrong = (amount: number, fresh: boolean) =>
		variant === 0 ? amount > limit && fresh : amount > limit || !fresh;
	const amounts = [rng.int(1000, limit - 2), limit - 1, limit, limit + 1, rng.int(limit + 2, limit * 3)];
	return {
		name: 'needs_review',
		spec: [
			`ручная проверка платежа нужна, если сумма amount больше ${limit} или клиент новый (new_client = True);`,
			'функция возвращает True (нужна проверка) или False.'
		],
		source: [
			'def needs_review(amount, new_client):',
			`    return amount > ${limit} ${variant === 0 ? 'and new_client' : 'or not new_client'}`
		],
		call: plainCall('needs_review'),
		expected: ([a, b]) => right(num(a), flag(b)),
		actual: ([a, b]) => wrong(num(a), flag(b)),
		pool: uniquePool(amounts.flatMap((x) => [[x, false] as V[], [x, true] as V[]])),
		boundary: ([a]) => num(a) === limit,
		touches: () => true,
		negative: (v) => v === false
	};
}

function discountedPrice(rng: Rng): Rule {
	const variant = rng.int(0, 1);
	const right = (price: number, pct: number) => Math.floor((price * (100 - pct)) / 100);
	const wrong = (price: number, pct: number) =>
		variant === 0 ? roundHalfEven(price * (100 - pct), 100) : price - Math.floor((price * pct) / 100);
	const pool: V[][] = [];
	for (let i = 0; i < 24; i += 1) {
		const pct = rng.pick([5, 10, 15, 20, 25, 30, 35, 50]);
		// Some prices make the product a whole number of roubles: the defect does not show there.
		const price = rng.bool(0.3) ? rng.int(1, 99) * 100 : rng.int(101, 9999);
		pool.push([price, pct]);
	}
	return {
		name: 'discounted_price',
		spec: [
			'цена товара в рублях со скидкой pct процентов: price · (100 − pct) / 100;',
			'дробная часть рубля отбрасывается (округление вниз).'
		],
		source: [
			'def discounted_price(price, pct):',
			variant === 0 ? '    return round(price * (100 - pct) / 100)' : '    return price - price * pct // 100'
		],
		call: plainCall('discounted_price'),
		expected: ([a, b]) => right(num(a), num(b)),
		actual: ([a, b]) => wrong(num(a), num(b)),
		pool: uniquePool(pool),
		boundary: () => false,
		touches: () => true,
		negative: null
	};
}

function pagesCount(rng: Rng): Rule {
	const variant = rng.int(0, 1);
	const right = (total: number, size: number) => ceilDiv(total, size);
	const wrong = (total: number, size: number) =>
		variant === 0 ? Math.floor(total / size) + 1 : roundHalfEven(total, size);
	const pool: V[][] = [[0, rng.pick([10, 20, 25, 50])]];
	for (let i = 0; i < 24; i += 1) {
		const size = rng.pick([10, 20, 25, 50]);
		// Whole pages, a remainder below half a page, exactly half a page and above half a page.
		const kind = rng.int(0, 3);
		const pages = rng.int(0, 20) * size;
		const total =
			kind === 0
				? pages + size
				: kind === 1
					? pages + rng.int(1, Math.floor((size - 1) / 2))
					: kind === 2 && size % 2 === 0
						? pages + size / 2
						: pages + rng.int(Math.floor(size / 2) + 1, size - 1);
		pool.push([total, size]);
	}
	return {
		name: 'pages_count',
		spec: [
			'сколько страниц нужно, чтобы показать total записей по size на странице;',
			'неполная последняя страница тоже считается; 0 записей — 0 страниц.'
		],
		source: [
			'def pages_count(total, size):',
			variant === 0 ? '    return total // size + 1' : '    return round(total / size)'
		],
		call: plainCall('pages_count'),
		expected: ([a, b]) => right(num(a), num(b)),
		actual: ([a, b]) => wrong(num(a), num(b)),
		pool: uniquePool(pool),
		boundary: () => false,
		touches: () => true,
		negative: null
	};
}

function effectiveLimit(rng: Rng): Rule {
	const pool: V[][] = [];
	for (let i = 0; i < 3; i += 1) pool.push([null, rng.int(1, 20) * 10]);
	for (let i = 0; i < 3; i += 1) pool.push([0, rng.int(1, 20) * 10]);
	for (let i = 0; i < 5; i += 1) pool.push([rng.int(1, 300), rng.int(1, 20) * 10]);
	return {
		name: 'effective_limit',
		spec: [
			'лимит заказов в день: личный лимит user_limit, если он задан;',
			'личный лимит не задан (None) — действует общий лимит default;',
			'личный лимит 0 — полный запрет заказов, это заданный лимит.'
		],
		source: ['def effective_limit(user_limit, default):', '    return user_limit or default'],
		call: plainCall('effective_limit'),
		expected: ([u, d]) => (u === null ? num(d) : num(u)),
		actual: ([u, d]) => (u === null || u === 0 ? num(d) : num(u)),
		pool: uniquePool(pool),
		boundary: () => false,
		touches: (args) => args.some((a) => a === 0 || a === null),
		negative: null
	};
}

function bonusAfter(rng: Rng): Rule {
	const pool: V[][] = [[0, 0]];
	for (let i = 0; i < 2; i += 1) pool.push([rng.int(1, 50) * 10, null]);
	for (let i = 0; i < 3; i += 1) pool.push([rng.int(1, 50) * 10, 0]);
	for (let i = 0; i < 5; i += 1) {
		const balance = rng.int(1, 50) * 10;
		pool.push([balance, rng.bool() ? rng.int(1, balance) : rng.int(balance + 1, balance + 300)]);
	}
	return {
		name: 'bonus_after',
		spec: [
			'с бонусного баланса balance списывается spend бонусов, но не больше, чем есть на балансе;',
			'spend = None — списываются все бонусы; spend = 0 — ничего не списывается;',
			'функция возвращает остаток бонусов.'
		],
		source: [
			'def bonus_after(balance, spend):',
			'    to_spend = min(spend or balance, balance)',
			'    return balance - to_spend'
		],
		call: plainCall('bonus_after'),
		expected: ([b, s]) => (s === null ? 0 : num(b) - Math.min(num(s), num(b))),
		actual: ([b, s]) => num(b) - Math.min(s === null || s === 0 ? num(b) : num(s), num(b)),
		pool: uniquePool(pool),
		boundary: () => false,
		touches: (args) => args.some((a) => a === 0 || a === null),
		negative: null
	};
}

// Junior rules.

function prescreen(rng: Rng): Rule {
	const minAge = rng.pick([18, 21]);
	const maxAge = rng.pick([65, 70, 75]);
	const minIncome = rng.pick([30000, 40000, 50000]);
	const variant = rng.int(0, 2);
	const right = (age: number, income: number) => minAge <= age && age <= maxAge && income >= minIncome;
	const wrong = (age: number, income: number) =>
		(variant === 0 ? minAge < age && age <= maxAge : minAge <= age && age <= maxAge) &&
		(variant === 1 ? income > minIncome : income >= minIncome);
	const lines = [
		variant === 0 ? `    age_ok = ${minAge} < age <= ${maxAge}` : `    age_ok = ${minAge} <= age <= ${maxAge}`,
		variant === 1 ? `    income_ok = income > ${minIncome}` : `    income_ok = income >= ${minIncome}`
	];
	const ages = [minAge - 1, minAge, minAge + 1, rng.int(minAge + 2, maxAge - 1), maxAge, maxAge + 1];
	const incomes = [minIncome - 1, minIncome, minIncome + rng.int(1, 5) * 1000, rng.int(5, 25) * 1000];
	const pool = uniquePool(ages.flatMap((a) => incomes.map((i) => [a, i] as V[])));
	return {
		name: 'prescreen',
		spec: [
			`заявка проходит предварительную проверку, если возраст age от ${minAge} до ${maxAge} лет (оба конца включены) и доход income не меньше ${minIncome};`,
			'функция возвращает True (проходит) или False.'
		],
		source: ['def prescreen(age, income):', ...lines, '    return age_ok and income_ok'],
		call: plainCall('prescreen'),
		expected: ([a, i]) => right(num(a), num(i)),
		actual: ([a, i]) => wrong(num(a), num(i)),
		pool,
		boundary: ([a, i]) => num(a) === minAge || num(a) === maxAge || num(i) === minIncome,
		touches: ([a, i]) => (variant === 0 ? num(a) === minAge : num(i) === minIncome),
		negative: (v) => v === false
	};
}

function freeShipping(rng: Rng): Rule {
	const t = rng.pick([2000, 2500, 3000, 4000, 5000]);
	const w = rng.pick([5, 10, 20]);
	const variant = rng.int(0, 1);
	const right = (total: number, weight: number, remote: boolean) => !remote && total >= t && weight <= w;
	const wrong = (total: number, weight: number, remote: boolean) =>
		!remote && (variant === 0 ? total > t : total >= t) && (variant === 1 ? weight < w : weight <= w);
	const totals = [t - 1, t, t + rng.int(1, 500), rng.int(100, t - 2)];
	const weights = [w - 1, w, w + 1, rng.int(1, w - 2)];
	const pool = uniquePool(
		totals.flatMap((a) =>
			weights.flatMap((b) => [[a, b, false] as V[], ...(rng.bool(0.3) ? [[a, b, true] as V[]] : [])])
		)
	);
	return {
		name: 'free_shipping',
		spec: [
			'доставка бесплатна, если адрес не в удалённом регионе (remote = False),',
			`сумма заказа total от ${t} рублей включительно и вес weight не больше ${w} кг;`,
			'функция возвращает True (бесплатно) или False.'
		],
		source: [
			'def free_shipping(total, weight, remote):',
			'    if remote:',
			'        return False',
			variant === 0 ? `    return total > ${t} and weight <= ${w}` : `    return total >= ${t} and weight < ${w}`
		],
		call: plainCall('free_shipping'),
		expected: ([a, b, c]) => right(num(a), num(b), flag(c)),
		actual: ([a, b, c]) => wrong(num(a), num(b), flag(c)),
		pool,
		boundary: ([a, b]) => num(a) === t || num(b) === w,
		touches: ([a, b]) => (variant === 0 ? num(a) === t : num(b) === w),
		negative: (v) => v === false
	};
}

function canBook(rng: Rng): Rule {
	const age = rng.pick([16, 18]);
	const price = rng.int(5, 30) * 100;
	const variant = rng.int(0, 1);
	const right = (a: number, pass: boolean, balance: number) => (a >= age || pass) && balance >= price;
	const wrong = (a: number, pass: boolean, balance: number) =>
		variant === 0 ? a >= age || (pass && balance >= price) : a >= age && pass && balance >= price;
	const ages = [age - 1, age, rng.int(age - 6, age - 2), rng.int(age + 1, age + 40)];
	const balances = [price - 1, price, rng.int(0, price - 2), rng.int(price + 1, price * 3)];
	const pool = uniquePool(ages.flatMap((a) => balances.flatMap((b) => [[a, false, b] as V[], [a, true, b] as V[]])));
	return {
		name: 'can_book',
		spec: [
			`бронирование разрешено, только если одновременно: (1) возраст age не меньше ${age} или есть пропуск (has_pass = True); (2) баланс balance не меньше ${price};`,
			'функция возвращает True (разрешено) или False.'
		],
		source: [
			'def can_book(age, has_pass, balance):',
			variant === 0
				? `    return age >= ${age} or has_pass and balance >= ${price}`
				: `    return age >= ${age} and has_pass and balance >= ${price}`
		],
		call: plainCall('can_book'),
		expected: ([a, p, b]) => right(num(a), flag(p), num(b)),
		actual: ([a, p, b]) => wrong(num(a), flag(p), num(b)),
		pool,
		boundary: ([a, , b]) => num(a) === age || num(b) === price,
		touches: ([a, p, b]) => (variant === 0 ? num(a) >= age : num(a) >= age !== flag(p) || num(b) < price),
		negative: (v) => v === false
	};
}

function promoApplies(rng: Rng): Rule {
	const t = rng.pick([3000, 5000, 7000, 10000]);
	const variant = rng.int(0, 1);
	const right = (member: boolean, total: number, sale: boolean) => (member || total >= t) && !sale;
	const wrong = (member: boolean, total: number, sale: boolean) =>
		variant === 0 ? member || (total >= t && !sale) : member && total >= t && !sale;
	const totals = [t - 1, t, rng.int(100, t - 2), rng.int(t + 1, t * 2)];
	const pool = uniquePool(
		totals.flatMap((x) => [
			[false, x, false] as V[],
			[true, x, false] as V[],
			[false, x, true] as V[],
			[true, x, true] as V[]
		])
	);
	return {
		name: 'promo_applies',
		spec: [
			`промокод действует, если покупатель — участник клуба (member = True) или сумма total от ${t} рублей включительно,`,
			'и при этом товар не уценён (discounted = False);',
			'функция возвращает True (действует) или False.'
		],
		source: [
			'def promo_applies(member, total, discounted):',
			variant === 0
				? `    return member or total >= ${t} and not discounted`
				: `    return member and total >= ${t} and not discounted`
		],
		call: plainCall('promo_applies'),
		expected: ([m, x, s]) => right(flag(m), num(x), flag(s)),
		actual: ([m, x, s]) => wrong(flag(m), num(x), flag(s)),
		pool,
		boundary: ([, x]) => num(x) === t,
		touches: ([m, , s]) => (variant === 0 ? flag(m) : !flag(s)),
		negative: (v) => v === false
	};
}

function cartTotal(rng: Rng): Rule {
	const q = rng.pick([5, 10]);
	const p = rng.pick([5, 10, 15]);
	const variant = rng.int(0, 1);
	const pairs = (v: V | undefined): [number, number][] =>
		(Array.isArray(v) ? v : []).map((pair) => {
			if (!Array.isArray(pair)) throw new Error('pair expected');
			return [num(pair[0]), num(pair[1])];
		});
	const total = (lines: [number, number][], wrongStep: boolean) =>
		lines.reduce((sum, [price, qty]) => {
			let amount = price * qty;
			if (qty >= q) {
				if (!wrongStep) amount -= Math.floor((amount * p) / 100);
				else if (variant === 0) amount = Math.floor((amount * (100 - p)) / 100);
				else amount -= roundHalfEven(amount * p, 100);
			}
			return sum + amount;
		}, 0);
	const pool: V[][] = [];
	for (let i = 0; i < 30; i += 1) {
		const count = rng.int(1, 3);
		const lines: V[] = [];
		for (let j = 0; j < count; j += 1) {
			const qty = rng.bool(0.6) ? rng.int(q, q + 6) : rng.int(1, q - 1);
			const price = rng.bool(0.25) ? rng.int(1, 40) * 20 : rng.int(99, 2999);
			lines.push([price, qty]);
		}
		pool.push([lines]);
	}
	return {
		name: 'cart_total',
		spec: [
			'итог корзины в копейках; lines — список пар (цена в копейках, количество);',
			`на позицию с количеством от ${q} штук включительно — скидка ${p} % от стоимости позиции;`,
			'скидка каждой такой позиции считается отдельно и округляется вниз до копейки, затем позиции складываются.'
		],
		source: [
			'def cart_total(lines):',
			'    total = 0',
			'    for price, qty in lines:',
			'        amount = price * qty',
			`        if qty >= ${q}:`,
			variant === 0
				? `            amount = amount * ${100 - p} // 100`
				: `            amount -= round(amount * ${p} / 100)`,
			'        total += amount',
			'    return total'
		],
		call: ([lines]) =>
			`cart_total([${pairs(lines)
				.map(([a, b]) => `(${a}, ${b})`)
				.join(', ')}])`,
		expected: ([lines]) => total(pairs(lines), false),
		actual: ([lines]) => total(pairs(lines), true),
		pool: uniquePool(pool),
		boundary: () => false,
		touches: ([lines]) => pairs(lines).some(([, qty]) => qty >= q),
		negative: null
	};
}

function monthlyPayments(rng: Rng): Rule {
	const variant = rng.int(0, 1);
	const plan = (totalSum: number, months: number, wrong: boolean): number[] => {
		let payment: number;
		if (wrong && variant === 1) payment = ceilDiv(Math.floor(totalSum / months), 100) * 100;
		else if (wrong) payment = Math.floor(ceilDiv(totalSum, months) / 100) * 100;
		else payment = ceilDiv(ceilDiv(totalSum, months), 100) * 100;
		return [...Array.from({ length: months - 1 }, () => payment), totalSum - payment * (months - 1)];
	};
	const pool: V[][] = [];
	for (let i = 0; i < 24; i += 1) {
		const months = rng.pick([2, 3, 4, 6]);
		const kind = rng.int(0, 2);
		// Exact multiples, a small remainder over whole roubles and a random sum.
		const total =
			kind === 0
				? rng.int(10, 900) * 100 * months
				: kind === 1
					? rng.int(10, 900) * 100 * months + rng.int(1, months - 1)
					: rng.int(1000, 99999) * 10 + rng.int(0, 9);
		pool.push([total, months]);
	}
	return {
		name: 'monthly_payments',
		spec: [
			'платежи рассрочки в копейках: сумма total делится на months платежей;',
			'каждый платёж, кроме последнего, равен total / months, округлённому вверх до целого рубля (кратно 100 копейкам);',
			'последний платёж — остаток, чтобы сумма платежей была равна total; функция возвращает список платежей.'
		],
		source: [
			'def monthly_payments(total, months):',
			variant === 1 ? '    payment = total // months' : '    payment = -(-total // months)',
			variant === 0 ? '    payment = payment // 100 * 100' : '    payment = -(-payment // 100) * 100',
			'    last = total - payment * (months - 1)',
			'    return [payment] * (months - 1) + [last]'
		],
		call: plainCall('monthly_payments'),
		expected: ([a, b]) => plan(num(a), num(b), false),
		actual: ([a, b]) => plan(num(a), num(b), true),
		pool: uniquePool(pool),
		boundary: () => false,
		touches: ([a, b]) => num(a) % (num(b) * 100) !== 0,
		negative: null
	};
}

function routeTicket(rng: Rng): Rule {
	const wait = rng.pick([30, 45, 60, 90]);
	const variant = rng.int(0, 1);
	const swapped = variant === 0 ? ['security', 'waiting', 'plan'] : ['plan', 'security', 'waiting'];
	const rightOrder = ['security', 'plan', 'waiting'];
	const route = (sec: boolean, plan: string, waiting: number, rules: string[]): string => {
		for (const rule of rules) {
			if (rule === 'security' && sec) return 'security';
			if (rule === 'plan' && plan === 'enterprise') return 'priority';
			if (rule === 'waiting' && waiting > wait) return 'escalated';
		}
		return 'general';
	};
	const block: Record<string, string[]> = {
		security: ['    if security:', '        return "security"'],
		plan: ['    if plan == "enterprise":', '        return "priority"'],
		waiting: [`    if waiting > ${wait}:`, '        return "escalated"']
	};
	const pool = uniquePool(
		[false, true].flatMap((s) =>
			['enterprise', 'basic'].flatMap((p) =>
				[rng.int(0, wait - 1), wait, wait + 1, rng.int(wait + 2, wait * 3)].map((w) => [s, p, w] as V[])
			)
		)
	);
	return {
		name: 'route_ticket',
		spec: [
			'очередь обращения в поддержку; срабатывает первое подходящее правило в таком порядке:',
			'1) вопрос безопасности (security = True) — "security";',
			'2) тариф plan == "enterprise" — "priority";',
			`3) ожидание waiting больше ${wait} минут — "escalated";`,
			'4) иначе — "general".'
		],
		source: [
			'def route_ticket(security, plan, waiting):',
			...swapped.flatMap((r) => block[r] ?? []),
			'    return "general"'
		],
		call: plainCall('route_ticket'),
		expected: ([s, p, w]) => route(flag(s), text(p), num(w), rightOrder),
		actual: ([s, p, w]) => route(flag(s), text(p), num(w), swapped),
		pool,
		boundary: ([, , w]) => num(w) === wait,
		touches: ([s, p]) => (variant === 0 ? text(p) === 'enterprise' : flag(s)),
		negative: null
	};
}

function shippingMethod(rng: Rng): Rule {
	const w = rng.pick([20, 30, 50]);
	const variant = rng.int(0, 1);
	const rightOrder = ['fragile', 'country', 'weight'];
	const swapped = variant === 0 ? ['country', 'fragile', 'weight'] : ['fragile', 'weight', 'country'];
	const method = (fragile: boolean, country: string, weight: number, rules: string[]): string => {
		for (const rule of rules) {
			if (rule === 'fragile' && fragile) return 'courier';
			if (rule === 'country' && country !== 'RU') return 'international';
			if (rule === 'weight' && weight > w) return 'freight';
		}
		return 'standard';
	};
	const block: Record<string, string[]> = {
		fragile: ['    if fragile:', '        return "courier"'],
		country: ['    if country != "RU":', '        return "international"'],
		weight: [`    if weight > ${w}:`, '        return "freight"']
	};
	const pool = uniquePool(
		[false, true].flatMap((f) =>
			['RU', rng.pick(['KZ', 'BY', 'AM', 'UZ'])].flatMap((c) =>
				[rng.int(1, w - 1), w, w + 1, rng.int(w + 2, w * 3)].map((x) => [f, c, x] as V[])
			)
		)
	);
	return {
		name: 'shipping_method',
		spec: [
			'способ доставки; срабатывает первое подходящее правило в таком порядке:',
			'1) хрупкий груз (fragile = True) — "courier";',
			'2) страна country не "RU" — "international";',
			`3) вес weight больше ${w} кг — "freight";`,
			'4) иначе — "standard".'
		],
		source: [
			'def shipping_method(fragile, country, weight):',
			...swapped.flatMap((r) => block[r] ?? []),
			'    return "standard"'
		],
		call: plainCall('shipping_method'),
		expected: ([f, c, x]) => method(flag(f), text(c), num(x), rightOrder),
		actual: ([f, c, x]) => method(flag(f), text(c), num(x), swapped),
		pool,
		boundary: ([, , x]) => num(x) === w,
		touches: ([f, c]) => (variant === 0 ? text(c) !== 'RU' : flag(f) || text(c) !== 'RU'),
		negative: null
	};
}

function uniquePool(items: V[][]): V[][] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = JSON.stringify(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const RULES: Record<string, ((rng: Rng) => Rule)[]> = {
	'intern/boundary': [canRegister, discountPercent],
	'intern/logic': [canReturn, needsReview],
	'intern/arithmetic': [discountedPrice, pagesCount],
	'intern/special-value': [effectiveLimit, bonusAfter],
	'junior/masked-boundary': [prescreen, freeShipping],
	'junior/grouping': [canBook, promoApplies],
	'junior/rounding-step': [cartTotal, monthlyPayments],
	'junior/rule-order': [routeTicket, shippingMethod]
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/boundary': ['boundary-miss', 'not-manifest'],
	'intern/logic': ['not-manifest', 'judges-by-actual'],
	'intern/arithmetic': ['not-manifest'],
	'intern/special-value': ['not-manifest'],
	'junior/masked-boundary': ['boundary-miss', 'not-manifest'],
	'junior/grouping': ['not-manifest', 'judges-by-actual'],
	'junior/rounding-step': ['not-manifest'],
	'junior/rule-order': ['not-manifest']
};

interface Case {
	id: string;
	args: V[];
	expected: V;
	actual: V;
}

const PYTHON_REFERENCE = `import json

data = json.loads(input())
namespace = {}
exec(data["source"], namespace)
fn = namespace[data["name"]]
failed = []
for case in data["cases"]:
    try:
        got = fn(*case["args"])
    except Exception as exc:
        got = ("raised", type(exc).__name__)
    if got != case["expected"]:
        failed.append(case["id"])
print("\\n".join(failed) or "-")
`;

const same = (a: V, b: V): boolean => JSON.stringify(a) === JSON.stringify(b);
const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

/** Rules in order become a numbered list after the bullets: `1) …` lines are the steps. */
function specLines(spec: readonly string[]): string[] {
	const bullets = spec.filter((s) => !/^\d\) /.test(s)).map((s) => `- ${s}`);
	const steps = spec.filter((s) => /^\d\) /.test(s)).map((s) => s.replace(/^(\d)\) /, '$1. '));
	return steps.length ? [...bullets, '', ...steps] : bullets;
}

function describe(rule: Rule, cases: readonly Case[]): string {
	return [
		`Спецификация функции \`${rule.name}\`:`,
		'',
		...specLines(rule.spec),
		'',
		'Реализацию, которую проверяют, вы видите в блоке кода. Тестировщик подготовил кейсы; ожидаемый результат каждого записан по спецификации:',
		'',
		...cases.map((c) => `- ${c.id}: \`${rule.call(c.args)}\` → ожидается \`${py(c.expected)}\``),
		'',
		'Какие кейсы упадут при прогоне на этой реализации, то есть фактический результат не совпадёт с ожидаемым? Введите идентификаторы по одному в строке, в любом порядке; если таких нет — одна строка `-`. Например:',
		'',
		'```',
		'TC-104',
		'TC-317',
		'```'
	].join('\n');
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const where = `${input.grade}/${input.classId}`;
	const makers = RULES[where] ?? [];
	const required = REQUIRED[where] ?? [];
	const [minCases, maxCases] = input.grade === 'intern' ? [7, 8] : [8, 10];
	for (let tries = 0; tries < 300; tries += 1) {
		const rule = rng.pick(makers)(rng);
		const count = Math.min(rng.int(minCases, maxCases), rule.pool.length);
		if (count < minCases) continue;
		const picked = rng.sample(rule.pool, count);
		const ids = rng
			.sample(
				Array.from({ length: 900 }, (_, i) => i + 100),
				count
			)
			.sort((a, b) => a - b);
		const cases: Case[] = picked.map((args, i) => ({
			id: `TC-${ids[i] ?? 0}`,
			args,
			expected: rule.expected(args),
			actual: rule.actual(args)
		}));
		const failing = sorted(cases.filter((c) => !same(c.expected, c.actual)).map((c) => c.id));
		const passing = cases.length - failing.length;
		if (failing.length === 0 || passing < 2) continue;
		const key = JSON.stringify(failing);
		const candidates: Record<string, string[] | null> = {
			'boundary-miss': sorted(cases.filter((c) => failing.includes(c.id) && !rule.boundary(c.args)).map((c) => c.id)),
			'not-manifest': sorted([...failing, ...cases.filter((c) => rule.touches(c.args)).map((c) => c.id)]),
			'judges-by-actual':
				rule.negative === null ? null : sorted(cases.filter((c) => rule.negative?.(c.actual) === true).map((c) => c.id))
		};
		const wrong = Object.fromEntries(
			Object.entries(candidates).map(([id, value]) => [
				id,
				value === null || JSON.stringify(value) === key ? null : value
			])
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: describe(rule, cases),
				code: { language: 'python3', source: rule.source.join('\n') }
			},
			answer: { kind: 'set', value: failing }
		});
		const stdin = JSON.stringify({
			source: rule.source.join('\n'),
			name: rule.name,
			cases: cases.map((c) => ({ id: c.id, args: c.args, expected: c.expected }))
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no instance for ${where} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
