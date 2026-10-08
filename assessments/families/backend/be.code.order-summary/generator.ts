// Practice: a summary of orders per customer from a plain-text log, by a rule the class sets (an aggregate, a count,
// a streak in log order); from Junior up the log carries updates of orders and the answer is the top K. Parametric
// hidden tests in five groups, one of them with sums past 2³¹.
// The words of the statuses and the smallest amount an order needs to count are the instance's own (`Spec`): they are
// given only in the statement, and every group of hidden tests fails a program with another smallest amount or other
// words, so a program written for another instance of the class fails here.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type HiddenTestGroup,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const LANGUAGES = ['python3', 'go', 'java21', 'javascript', 'typescript', 'cpp17'] as const;

const descriptor = readDescriptor(import.meta.url);

type Status = 'paid' | 'cancelled' | 'new';

/** The constants of the instance's specification, stated in the text only. */
interface Spec {
	/** The words of `paid`, `new` and `cancelled` in the log; no word is shared by two sets. */
	words: Readonly<Record<Status, string>>;
	/** An order counts only with an amount of at least this. */
	min: number;
}

const WORDS: readonly Readonly<Record<Status, string>>[] = [
	{ paid: 'paid', new: 'new', cancelled: 'cancelled' },
	{ paid: 'settled', new: 'pending', cancelled: 'voided' },
	{ paid: 'captured', new: 'created', cancelled: 'refunded' },
	{ paid: 'complete', new: 'open', cancelled: 'rejected' }
];
/** At least 100 apart, so an amount 50 under the smallest is still over the next smaller one. */
const MINS = [100, 200, 300, 500, 800, 1200, 2000] as const;

function drawSpec(rng: Rng): Spec {
	return { words: rng.pick(WORDS), min: rng.pick(MINS) };
}
interface Order {
	id: number;
	customer: string;
	amount: number;
	status: Status;
}

/**
 * The orders after updates: a later line with the same number replaces the earlier one and keeps its place; a
 * solution that keeps the first line of a number instead is the wrong solution `first-wins`.
 */
function latest(orders: readonly Order[], updates: boolean, firstWins: boolean): Order[] {
	if (!updates) return [...orders];
	const byId = new Map<number, Order>();
	for (const order of orders) if (!firstWins || !byId.has(order.id)) byId.set(order.id, order);
	return [...byId.values()];
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A sum kept in a signed 32-bit integer, as a solution that overflows it sees it. */
const wrap32 = (x: number): number => ((x + 2 ** 31) % 2 ** 32) - 2 ** 31;

const SUMMED = new Set(['paid-sum', 'top-paid', 'top-orders', 'top-average']);

/** The rows of the class before ordering: a key, the printed text, kept or not. */
function rowsOf(classId: string, orders: readonly Order[], updates: boolean, min: number, variant: Variant): Row[] {
	const ignores = variant === 'ignores-status';
	// The wrong solution `min-before-latest` drops the lines under the smallest amount while reading, so an earlier
	// version of the order comes back.
	const lines = variant === 'min-before-latest' ? orders.filter((o) => o.amount >= min) : orders;
	const rows = latest(lines, updates, variant === 'first-wins').filter((o) => o.amount >= min);
	if (classId === 'paid-streak') {
		const per = new Map<string, { run: number; best: number }>();
		for (const o of rows) {
			const e = per.get(o.customer) ?? { run: 0, best: 0 };
			e.run = ignores || o.status === 'paid' ? e.run + 1 : variant === 'streak-no-reset' ? e.run : 0;
			e.best = Math.max(e.best, e.run);
			per.set(o.customer, e);
		}
		return [...per].map(([name, e]) => ({
			name,
			key: e.best,
			text: `${name} ${e.best}`,
			kept: e.best > 0 || variant === 'keeps-empty'
		}));
	}
	if (classId === 'cancel-after-paid') {
		const paid = new Set((variant === 'first-wins' ? rows : lines).filter((o) => o.status === 'paid').map((o) => o.id));
		const per = new Map<string, { count: number; sum: number }>();
		for (const o of rows) {
			if (o.status !== 'cancelled' || (!ignores && !paid.has(o.id))) continue;
			const e = per.get(o.customer) ?? { count: 0, sum: 0 };
			e.count += 1;
			e.sum += o.amount;
			per.set(o.customer, e);
		}
		return [...per].map(([name, e]) => ({ name, key: e.count, text: `${name} ${e.count} ${e.sum}`, kept: true }));
	}
	const per = new Map<string, number[]>();
	for (const o of rows) {
		const values = per.get(o.customer) ?? [];
		if (ignores || (classId === 'active-count' ? o.status !== 'cancelled' : o.status === 'paid')) values.push(o.amount);
		per.set(o.customer, values);
	}
	return [...per].map(([name, found]) => {
		const v = found.length === 0 && variant === 'keeps-empty' ? [0] : found;
		const raw = v.reduce((s, x) => s + x, 0);
		const sum = variant === 'int32-sum' ? wrap32(raw) : raw;
		const key: Record<string, number> = {
			'paid-sum': sum,
			'active-count': v.length,
			'max-paid': Math.max(...v),
			'top-paid': sum,
			'top-orders': v.length,
			'top-average': Math.floor(sum / v.length)
		};
		const value = key[classId] ?? 0;
		const text = classId === 'top-orders' ? `${name} ${value} ${sum}` : `${name} ${value}`;
		return { name, key: value, text, kept: v.length > 0 };
	});
}

interface Row {
	name: string;
	key: number;
	text: string;
	kept: boolean;
}

/**
 * The expected output of the class on an input with the smallest amount `min`; a variant other than `right` reproduces
 * a wrong solution.
 */
function solve(classId: string, orders: readonly Order[], k: number, min: number, variant: Variant = 'right'): string {
	const updates = k > 0;
	const lines = rowsOf(classId, orders, updates, min, variant).filter((r) => r.kept);
	if (classId === 'paid-sum') lines.sort((a, b) => byName(a.name, b.name));
	else lines.sort((a, b) => b.key - a.key || (variant === 'no-tie-break' ? 0 : byName(a.name, b.name)));
	return (updates ? lines.slice(0, k) : lines).map((l) => l.text).join('\n');
}

function render(orders: readonly Order[], k: number, words: Spec['words']): string {
	const head = k > 0 ? `${orders.length} ${k}` : `${orders.length}`;
	return `${[head, ...orders.map((o) => `${o.id} ${o.customer} ${o.amount} ${words[o.status]}`)].join('\n')}\n`;
}

/** An amount: now and then on or just under the smallest one that counts, so the threshold decides. */
function amountOf(rng: Rng, min: number): number {
	return rng.bool(0.4) ? rng.pick([min - 50, min, min, min + 50]) : rng.int(1, 200) * 50;
}

/** A pool of customer names large enough for the scale tests. */
function names(rng: Rng, count: number): string[] {
	const pool = new Set<string>();
	while (pool.size < count)
		pool.add(`${rng.pick(PERSON_NAMES)}${pool.size < PERSON_NAMES.length ? '' : rng.int(1, 999)}`);
	return [...pool];
}

interface TestShape {
	customers: number;
	orders: number;
	/** Force equal keys so the tie-break decides the order. */
	ties: boolean;
	/** Customers with only cancelled or new orders, cancelled orders with large amounts. */
	edge: boolean;
	/** One customer with thousands of orders near the largest amount: the sums pass 2³¹. */
	large: boolean;
	updates: boolean;
	k: number;
}

function makeOrders(rng: Rng, shape: TestShape, min: number): Order[] {
	const people = names(rng, shape.customers);
	let id = rng.int(1000, 5000);
	const status = (): Status => rng.pick<Status>(['paid', 'paid', 'paid', 'new', 'cancelled']);
	const base: Order[] = [];
	for (let i = 0; i < shape.orders; i += 1) {
		base.push({
			id: (id += rng.int(1, 3)),
			customer: rng.pick(people),
			amount: amountOf(rng, min),
			status: status()
		});
	}
	const orders = rng.shuffle(base);
	if (shape.ties) {
		// Two customers with identical baskets, written in the reverse order of their names.
		const [x, y] = [`zz${rng.pick(PERSON_NAMES)}`, `aa${rng.pick(PERSON_NAMES)}`];
		const pair: Order[] = [];
		for (const amount of [amountOf(rng, min), amountOf(rng, min)]) {
			pair.push({ id: (id += 1), customer: x, amount, status: 'paid' });
			pair.push({ id: (id += 1), customer: y, amount, status: 'paid' });
		}
		orders.push(...pair);
		orders.push({ id: (id += 1), customer: x, amount: min, status: 'new' });
		orders.push({ id: (id += 1), customer: y, amount: min, status: 'new' });
		if (shape.updates && rng.bool()) {
			// Both cancel the same paid order after the payment: the baskets stay equal, and orders cancelled after a
			// payment tie too.
			const [ox, oy] = [pair[0], pair[1]];
			if (ox && oy) orders.push({ ...ox, status: 'cancelled' }, { ...oy, status: 'cancelled' });
		}
	}
	if (shape.large) {
		// A customer whose paid sum passes 2³¹, and a few small ones around.
		const whale = `${rng.pick(PERSON_NAMES)}${rng.int(1, 9)}`;
		for (let i = rng.int(2300, 2500); i > 0; i -= 1) {
			const status: Status = rng.bool(0.95) ? 'paid' : rng.pick<Status>(['new', 'cancelled']);
			orders.push({ id: (id += 1), customer: whale, amount: rng.int(900_000, 1_000_000), status });
		}
	}
	if (rng.bool(0.5)) {
		// A customer whose only paid order is under the smallest amount: a solution without the threshold prints it.
		orders.push({
			id: (id += 1),
			customer: `${rng.pick(PERSON_NAMES)}${rng.int(10, 99)}`,
			amount: min - 50,
			status: 'paid'
		});
	}
	if (shape.edge) {
		// A customer with only a cancelled order, and large cancelled orders that must not count.
		orders.push({ id: (id += 1), customer: `${rng.pick(PERSON_NAMES)}x`, amount: 999_950, status: 'cancelled' });
		orders.push({ id: (id += 1), customer: rng.pick(people), amount: 999_900, status: 'cancelled' });
	}
	if (shape.updates) {
		// Later lines rewrite earlier orders; one large paid order is cancelled by its update.
		for (const o of rng.sample(base, Math.max(2, Math.floor(base.length / 5)))) {
			orders.push({ ...o, status: rng.pick<Status>(['paid', 'cancelled']), amount: amountOf(rng, min) });
		}
		const big: Order = { id: id + 1, customer: rng.pick(people), amount: 900_000, status: 'paid' };
		orders.push(big, { ...big, status: 'cancelled' });
		if (shape.large || rng.bool(0.3)) {
			// Two orders paid and cancelled right on either side of the smallest amount that counts.
			for (const [i, amount] of [min - 50, rng.pick([min, min + 50])].entries()) {
				const edge: Order = { id: id + 2 + i, customer: rng.pick(people), amount, status: 'paid' };
				orders.push(edge, { ...edge, status: 'cancelled' });
			}
		}
		if (rng.bool(0.6)) {
			// The threshold on the last record only: a paid order rewritten under the smallest amount drops out whole, and
			// one paid under it and then cancelled over it counts as cancelled after a payment.
			const drops: Order = { id: id + 4, customer: rng.pick(people), amount: min + 50 * rng.int(0, 4), status: 'paid' };
			const counts: Order = { id: id + 5, customer: rng.pick(people), amount: min - 50, status: 'paid' };
			orders.push(
				drops,
				counts,
				{ ...drops, amount: min - 50 },
				{ ...counts, amount: min + 50 * rng.int(0, 4), status: 'cancelled' }
			);
		}
	}
	return orders;
}

const SHAPES: Record<string, (rng: Rng, junior: boolean) => TestShape> = {
	basic: (rng, junior) => ({
		customers: rng.int(3, 6),
		orders: rng.int(6, 12),
		ties: false,
		edge: false,
		large: false,
		updates: junior,
		k: junior ? rng.int(2, 3) : 0
	}),
	ties: (rng, junior) => ({
		customers: rng.int(2, 4),
		orders: rng.int(4, 8),
		ties: true,
		edge: false,
		large: false,
		updates: junior,
		k: junior ? 50 : 0
	}),
	edge: (rng, junior) => ({
		customers: rng.int(2, 5),
		orders: rng.int(4, 10),
		ties: false,
		edge: true,
		large: false,
		updates: junior,
		k: junior ? rng.int(20, 40) : 0
	}),
	large: (rng, junior) => ({
		customers: rng.int(2, 4),
		// Junior: enough orders that the updates cancel some after a payment, on both sides of the smallest amount.
		orders: junior ? rng.int(10, 16) : rng.int(4, 10),
		ties: false,
		edge: false,
		large: true,
		updates: junior,
		k: junior ? rng.int(2, 5) : 0
	}),
	scale: (rng, junior) => ({
		customers: rng.int(200, 400),
		orders: rng.int(2000, 2600),
		ties: true,
		edge: true,
		large: false,
		updates: junior,
		k: junior ? rng.int(5, 15) : 0
	})
};

/** The wrong solutions a group must expose on every test, by class and grade. */
function traps(classId: string, group: string, junior: boolean): Variant[] {
	switch (group) {
		case 'basic':
			return classId === 'paid-streak' ? ['ignores-status', 'streak-no-reset'] : ['ignores-status'];
		case 'ties':
			return classId === 'paid-sum' ? [] : ['no-tie-break'];
		case 'edge':
			return junior ? ['first-wins'] : ['keeps-empty'];
		case 'large':
			return SUMMED.has(classId) ? ['int32-sum'] : ['ignores-status'];
		default:
			return [];
	}
}

/**
 * A program of another instance of the class: another smallest amount, or other words of the statuses — it knows none
 * of this log's words, so every order is neither paid nor cancelled for it.
 */
interface Neighbour {
	name: string;
	solve(classId: string, orders: readonly Order[], k: number): string;
}

function neighbours(spec: Spec, junior: boolean): Neighbour[] {
	return [
		{
			name: 'no smallest amount',
			solve: (classId: string, orders: readonly Order[], k: number) => solve(classId, orders, k, 1)
		},
		...(junior
			? [
					{
						name: 'smallest amount before the last record',
						solve: (classId: string, orders: readonly Order[], k: number) =>
							solve(classId, orders, k, spec.min, 'min-before-latest')
					}
				]
			: []),
		...MINS.filter((m) => m !== spec.min).map((m) => ({
			name: `min ${m}`,
			solve: (classId: string, orders: readonly Order[], k: number) => solve(classId, orders, k, m)
		})),
		{
			name: 'other words',
			solve: (classId: string, orders: readonly Order[], k: number) =>
				solve(
					classId,
					orders.map((o) => ({ ...o, status: 'new' as const })),
					k,
					spec.min
				)
		}
	];
}

/**
 * Hidden tests of the class; every test tells this class from the others of the level, and every group fails a
 * program of a neighbouring specification: each neighbour is told apart by some test of the group, every test tells
 * apart one not told yet.
 */
function groups(rng: Rng, classId: string, others: readonly string[], junior: boolean, spec: Spec): HiddenTestGroup[] {
	return Object.entries(SHAPES).map(([id, shapeOf]) => {
		const count = id === 'scale' || id === 'large' ? 1 : 4;
		const open = neighbours(spec, junior);
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 2000)
				throw new Error(
					`${descriptor.key}: no distinguishing ${id} test for ${classId}${open.length > 0 ? ` (min ${spec.min} not told from ${open.map((n) => n.name).join(', ')})` : ''}`
				);
			const shape = shapeOf(rng, junior);
			const orders = makeOrders(rng, shape, spec.min);
			const expected = solve(classId, orders, shape.k, spec.min);
			if (expected === '' || others.some((other) => solve(other, orders, shape.k, spec.min) === expected)) continue;
			if (traps(classId, id, junior).some((v) => solve(classId, orders, shape.k, spec.min, v) === expected)) continue;
			const told = open.filter((n) => n.solve(classId, orders, shape.k) !== expected);
			if (open.length > 0 && told.length === 0) continue;
			if (tests.length === count - 1 && told.length < open.length) continue;
			for (const n of told) open.splice(open.indexOf(n), 1);
			tests.push({ stdin: render(orders, shape.k, spec.words), expected: `${expected}\n` });
		}
		return { id, tests };
	});
}

const RULES: Record<string, (w: Spec['words']) => string> = {
	'paid-sum': (w) =>
		`Для каждого клиента, у которого есть хотя бы один заказ со статусом \`${w.paid}\`, выведите строку \`<клиент> <сумма оплаченных заказов>\`. Строки — по имени клиента в лексикографическом порядке.`,
	'active-count': (w) =>
		`Для каждого клиента выведите строку \`<клиент> <число заказов со статусом не ${w.cancelled}>\`; клиентов, у которых таких заказов нет, не выводите. Строки — по убыванию числа, при равенстве — по имени клиента в лексикографическом порядке.`,
	'max-paid': (w) =>
		`Для каждого клиента, у которого есть хотя бы один заказ со статусом \`${w.paid}\`, выведите строку \`<клиент> <наибольшая сумма оплаченного заказа>\`. Строки — по убыванию суммы, при равенстве — по имени клиента в лексикографическом порядке.`,
	'top-paid': (w) =>
		`Выведите K клиентов с наибольшей суммой оплаченных (\`${w.paid}\`) заказов, строками \`<клиент> <сумма>\`: по убыванию суммы, при равенстве — по имени в лексикографическом порядке. Клиенты без оплаченных заказов не участвуют; если участников меньше K — выведите всех.`,
	'top-orders': (w) =>
		`Выведите K клиентов с наибольшим числом оплаченных (\`${w.paid}\`) заказов, строками \`<клиент> <число> <сумма оплаченных>\`: по убыванию числа, при равенстве — по имени в лексикографическом порядке. Клиенты без оплаченных заказов не участвуют; если участников меньше K — выведите всех.`,
	'top-average': (w) =>
		`Выведите K клиентов с наибольшей средней суммой оплаченного (\`${w.paid}\`) заказа, строками \`<клиент> <среднее>\`, где среднее — сумма, делённая на число оплаченных заказов, с округлением вниз до целого. Порядок — по убыванию среднего, при равенстве — по имени в лексикографическом порядке. Клиенты без оплаченных заказов не участвуют; если участников меньше K — выведите всех.`,
	'paid-streak': (w) =>
		`Для каждого клиента найдите самую длинную серию подряд идущих оплаченных (\`${w.paid}\`) заказов среди **его** заказов в порядке строк журнала: заказ этого клиента с другим статусом прерывает серию, заказы других клиентов — нет. Выведите строки \`<клиент> <длина серии>\` для клиентов, у которых есть хотя бы один оплаченный заказ: по убыванию длины, при равенстве — по имени клиента в лексикографическом порядке.`,
	'cancel-after-paid': (w) =>
		`Заказ «отменён после оплаты», если среди строк с его номером есть строка со статусом \`${w.paid}\`, а последняя строка — \`${w.cancelled}\`. Для каждого клиента (по последней записи заказа) посчитайте число таких заказов и сумму их сумм из последних записей. Выведите K клиентов с наибольшим числом таких заказов строками \`<клиент> <число> <сумма>\`: по убыванию числа, при равенстве — по имени в лексикографическом порядке. Клиенты без таких заказов не участвуют; если участников меньше K — выведите всех.`
};

function statement(classId: string, junior: boolean, spec: Spec): string {
	const w = spec.words;
	return [
		'Сервис заказов пишет журнал: одна строка — один заказ. Напишите программу, которая читает журнал со стандартного ввода и печатает сводку по клиентам.',
		'',
		junior
			? `Наименьшая сумма заказа — **M = ${spec.min}**; M во входе нет. Порог проверяется только по **последней** записи номера: если в ней сумма меньше M, заказ в сводке не участвует целиком, а прежние записи этого номера не возвращаются. Например, при строках \`7 anna ${spec.min + 600} ${w.paid}\` и затем \`7 anna ${spec.min - 50} ${w.paid}\` заказа 7 в сводке нет.${classId === 'cancel-after-paid' ? ` Более ранняя запись \`${w.paid}\` считается оплатой при любой своей сумме.` : ''}`
			: `Заказ с суммой меньше **M = ${spec.min}** в сводке не участвует вовсе — как будто его строки нет в журнале${classId === 'paid-streak' ? ' (серию он не прерывает)' : ''}. M во входе нет.`,
		'',
		'## Вход',
		'',
		junior
			? 'В первой строке — числа `N` и `K` (1 ≤ N ≤ 10 000, 1 ≤ K ≤ 100). Далее `N` строк `<номер> <клиент> <сумма> <статус>`.'
			: 'В первой строке — число `N` (1 ≤ N ≤ 10 000). Далее `N` строк `<номер> <клиент> <сумма> <статус>`.',
		'',
		'- номер — целое от 1 до 10⁹; клиент — строка из латинских букв и цифр без пробелов; сумма — целое от 1 до 10⁶;',
		`- статус — \`${w.paid}\` (оплачен), \`${w.new}\` (новый) или \`${w.cancelled}\` (отменён).`,
		...(junior
			? [
					'- журнал содержит обновления: строка с номером, который уже встречался, заменяет прежнюю запись этого заказа целиком (клиент, сумма, статус); учитывается только последняя запись каждого номера.'
				]
			: ['- номера заказов не повторяются.']),
		'',
		'## Выход',
		'',
		RULES[classId]?.(w) ?? '',
		'',
		'Программа проверяется скрытыми тестами пяти групп: обычные данные, равенство ключей, граничные случаи, большие суммы, большой объём. Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

type Variant = 'right' | (typeof WRONG_IDS)[number];

const VALUE: Record<string, string> = {
	'paid-sum': 'sum(v)',
	'active-count': 'len(v)',
	'max-paid': 'max(v)',
	'top-paid': 'sum(v)',
	'top-orders': 'len(v)',
	'top-average': 'sum(v) // len(v)'
};

/** The reference of the streak class: the current and the longest run of paid orders per customer. */
function streakSource(spec: Spec, variant: Variant): string {
	const paid = variant === 'ignores-status' ? 'True' : `status == '${spec.words.paid}'`;
	const broken = variant === 'streak-no-reset' ? 'run.get(customer, 0)' : '0';
	const rows =
		variant === 'no-tie-break'
			? 'sorted(((-b, c) for c, b in best.items() if b > 0), key=lambda r: r[0])'
			: variant === 'keeps-empty'
				? 'sorted((-b, c) for c, b in best.items())'
				: 'sorted((-b, c) for c, b in best.items() if b > 0)';
	return [
		'import sys',
		'',
		'data = sys.stdin.read().split()',
		'n = int(data[0])',
		`MIN = ${spec.min}`,
		'best, run = {}, {}',
		'for i in range(n):',
		'    customer, amount, status = data[2 + 4 * i], int(data[3 + 4 * i]), data[4 + 4 * i]',
		'    if amount < MIN:',
		'        continue',
		`    run[customer] = run.get(customer, 0) + 1 if ${paid} else ${broken}`,
		'    best[customer] = max(best.get(customer, 0), run[customer])',
		`rows = ${rows}`,
		'for b, c in rows:',
		'    print(c, -b)'
	].join('\n');
}

/** The reference of the class of orders cancelled after a payment, on the orders after updates. */
function cancelSource(spec: Spec, variant: Variant): string {
	const { paid, cancelled } = spec.words;
	return [
		'import sys',
		'',
		'data = sys.stdin.read().split()',
		'n, k = int(data[0]), int(data[1])',
		`MIN = ${spec.min}`,
		'orders, paid = {}, set()',
		'for i in range(n):',
		'    oid, customer, amount, status = data[2 + 4 * i:6 + 4 * i]',
		...(variant === 'first-wins' ? ['    if oid in orders:', '        continue'] : []),
		...(variant === 'min-before-latest' ? ['    if int(amount) < MIN:', '        continue'] : []),
		'    orders[oid] = (customer, int(amount), status)',
		`    if status == '${paid}':`,
		'        paid.add(oid)',
		'count = {}',
		'for oid, (customer, amount, status) in orders.items():',
		`    if amount >= MIN and status == '${cancelled}'${variant === 'ignores-status' ? '' : ' and oid in paid'}:`,
		'        c = count.setdefault(customer, [0, 0])',
		'        c[0] += 1',
		'        c[1] += amount',
		`rows = sorted(count.items(), key=lambda r: ${variant === 'no-tie-break' ? '-r[1][0]' : '(-r[1][0], r[0])'})`,
		'for customer, c in rows[:k]:',
		'    print(customer, c[0], c[1])'
	].join('\n');
}

/** The reference program of a class in Python; a variant other than `right` is a wrong solution. */
function referenceSource(classId: string, spec: Spec, variant: Variant): string {
	if (classId === 'paid-streak') return streakSource(spec, variant);
	if (classId === 'cancel-after-paid') return cancelSource(spec, variant);
	const updates = classId.startsWith('top-');
	const store = !updates
		? 'orders[i]'
		: variant === 'first-wins'
			? 'orders.setdefault(oid, None) or orders'
			: 'orders[oid]';
	const filter =
		variant === 'ignores-status'
			? 'True'
			: classId === 'active-count'
				? `status != '${spec.words.cancelled}'`
				: `status == '${spec.words.paid}'`;
	const sort = classId === 'paid-sum' ? 'r[0]' : variant === 'no-tie-break' ? '-r[1]' : '(-r[1], r[0])';
	const overflow = variant === 'int32-sum';
	const total = overflow ? 'wrap(sum(v))' : 'sum(v)';
	const text = classId === 'top-orders' ? `f"{name} {value} {${total}}"` : 'f"{name} {value}"';
	const value = (VALUE[classId] ?? '').replaceAll('sum(v)', total);
	return [
		'import sys',
		'',
		'data = sys.stdin.read().split()',
		'n = int(data[0])',
		`k = ${updates ? 'int(data[1])' : '0'}`,
		`pos = ${updates ? 2 : 1}`,
		`MIN = ${spec.min}`,
		...(overflow ? ['wrap = lambda x: (x + 2 ** 31) % 2 ** 32 - 2 ** 31'] : []),
		'orders = {}',
		'for i in range(n):',
		'    oid, customer, amount, status = data[pos:pos + 4]',
		'    pos += 4',
		...(variant === 'min-before-latest' ? ['    if int(amount) < MIN:', '        continue'] : []),
		variant === 'first-wins'
			? '    if oid not in orders:\n        orders[oid] = (customer, int(amount), status)'
			: `    ${store} = (customer, int(amount), status)`,
		'groups = {}',
		'for customer, amount, status in orders.values():',
		'    if amount < MIN:',
		'        continue',
		'    values = groups.setdefault(customer, [])',
		`    if ${filter}:`,
		'        values.append(amount)',
		variant === 'keeps-empty'
			? `rows = [(name, ${value.replaceAll('(v)', '(v or [0])')}, v) for name, v in groups.items()]`
			: `rows = [(name, ${value}, v) for name, v in groups.items() if v]`,
		`rows.sort(key=lambda r: ${sort})`,
		...(updates ? ['rows = rows[:k]'] : []),
		'for name, value, v in rows:',
		`    print(${text})`
	].join('\n');
}

const WRONG_IDS = [
	'no-tie-break',
	'ignores-status',
	'first-wins',
	'keeps-empty',
	'int32-sum',
	'streak-no-reset',
	'min-before-latest'
] as const;

function applies(id: (typeof WRONG_IDS)[number], classId: string, junior: boolean): boolean {
	switch (id) {
		case 'no-tie-break':
			return classId !== 'paid-sum';
		case 'ignores-status':
			return true;
		case 'first-wins':
			return junior;
		case 'keeps-empty':
			return !junior;
		case 'int32-sum':
			return SUMMED.has(classId);
		case 'streak-no-reset':
			return classId === 'paid-streak';
		case 'min-before-latest':
			return junior;
	}
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const spec = drawSpec(rng);
	const others = level.classes.map((c) => c.id).filter((id) => id !== input.classId);
	const hidden = groups(rng, input.classId, others, junior, spec);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(input.classId, junior, spec), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: hidden, checker: { kind: 'tokens' } }
	});
	return {
		instance,
		reference: () => ({ kind: 'practice', source: referenceSource(input.classId, spec, 'right'), changeSource: null }),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, input.classId, junior)
						? { kind: 'program' as const, source: referenceSource(input.classId, spec, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
