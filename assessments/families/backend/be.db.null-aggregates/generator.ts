// NULL in filters, aggregates and grouping: the result of a query on a generated table where NULL decides the answer.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { CITY_NAMES, PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows, runSql, sqlProbeSource, sqlText, SQL_ROW_FORMAT } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

interface Query {
	setup: string;
	query: string;
	wrong: Record<string, string | null>;
	statement: string;
}

const NONE = {
	'count-star': null,
	'null-matches': null,
	'null-as-zero': null,
	'null-group-dropped': null,
	'on-as-where': null,
	'null-equals-null': null
};

function internQuery(rng: Rng, classId: string): Query {
	const table = rng.pick(['payments', 'orders', 'invoices', 'refunds']);
	const cities = rng.sample(CITY_NAMES, 3);
	const target = cities[0] ?? 'Омск';
	const count = rng.int(8, 10);
	const rows: (string | number | null)[][] = [];
	for (let id = 1; id <= count; id += 1) rows.push([id, rng.pick(cities), rng.bool(0.3) ? null : rng.int(1, 30) * 10]);
	// The trap in every instance: the target city has rows with and without NULL.
	rows[0] = [1, target, null];
	rows[1] = [2, target, rng.int(1, 30) * 10];
	if (classId === 'null-arithmetic') return nullArithmetic(rng, table, cities, target);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, city TEXT NOT NULL, amount INTEGER);\n${insertRows(table, ['id', 'city', 'amount'], rng.shuffle(rows))}`;
	if (classId === 'count-column') {
		return {
			setup,
			query: `SELECT COUNT(*), COUNT(amount), SUM(amount) FROM ${table} WHERE city = ${sqlText(target)};`,
			wrong: {
				...NONE,
				'count-star': `SELECT COUNT(*), COUNT(*), SUM(amount) FROM ${table} WHERE city = ${sqlText(target)};`
			},
			statement: 'Что вернёт запрос?'
		};
	}
	if (classId === 'not-equal-null') {
		const status = rng.pick(['refunded', 'cancelled', 'failed']);
		// The trap in every instance: a NULL status, the excluded status and a kept one.
		const statusRows: (number | string | null)[][] = [
			[1, null],
			[2, status],
			[3, 'paid']
		];
		for (let id = 4; id <= count; id += 1)
			statusRows.push([id, rng.bool(0.35) ? null : rng.pick([status, 'paid', 'new'])]);
		const statusSetup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, status TEXT);\n${insertRows(table, ['id', 'status'], rng.shuffle(statusRows))}`;
		return {
			setup: statusSetup,
			query: `SELECT id FROM ${table} WHERE status <> ${sqlText(status)} ORDER BY id;`,
			wrong: {
				...NONE,
				'null-matches': `SELECT id FROM ${table} WHERE COALESCE(status, '') <> ${sqlText(status)} ORDER BY id;`
			},
			statement: 'Что вернёт запрос?'
		};
	}
	// AVG over the target city: the generator keeps the true average whole, so the answer is a plain number.
	const targetRows = rows.filter((r) => r[1] === target && r[2] !== null);
	const sum = targetRows.reduce((s, r) => s + Number(r[2]), 0);
	const remainder = sum % targetRows.length;
	const last = targetRows[targetRows.length - 1];
	if (last && remainder !== 0) last[2] = Number(last[2]) + (targetRows.length - remainder);
	const avgSetup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, city TEXT NOT NULL, amount INTEGER);\n${insertRows(table, ['id', 'city', 'amount'], rng.shuffle(rows))}`;
	return {
		setup: avgSetup,
		query: `SELECT SUM(amount), AVG(amount) FROM ${table} WHERE city = ${sqlText(target)};`,
		wrong: {
			...NONE,
			'null-as-zero': `SELECT SUM(amount), AVG(COALESCE(amount, 0)) FROM ${table} WHERE city = ${sqlText(target)};`
		},
		statement: 'Что вернёт запрос?'
	};
}

/** NULL in arithmetic: `price + fee` is NULL where the fee is, so the sum of sums and the sum of the row totals differ. */
function nullArithmetic(rng: Rng, table: string, cities: readonly string[], target: string): Query {
	const rows: (string | number | null)[][] = [];
	const fee = (): number => rng.int(1, 9) * 5;
	// The trap in every instance: the target city has rows with a fee and without one.
	rows.push([target, rng.int(1, 30) * 10, null], [target, rng.int(1, 30) * 10, fee()]);
	for (let k = rng.int(1, 3); k > 0; k -= 1) rows.push([target, rng.int(1, 30) * 10, rng.bool(0.4) ? null : fee()]);
	for (let k = rng.int(3, 5); k > 0; k -= 1)
		rows.push([rng.pick(cities.slice(1)), rng.int(1, 30) * 10, rng.bool(0.4) ? null : fee()]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, city TEXT NOT NULL, price INTEGER NOT NULL, fee INTEGER);\n${insertRows(
		table,
		['id', 'city', 'price', 'fee'],
		rng.shuffle(rows).map((r, i) => [i + 1, ...r])
	)}`;
	const q = (f: string): string =>
		`SELECT COUNT(price + ${f}), SUM(price + ${f}), SUM(price) + SUM(${f}) FROM ${table} WHERE city = ${sqlText(target)};`;
	return {
		setup,
		query: q('fee'),
		wrong: { ...NONE, 'null-as-zero': q('COALESCE(fee, 0)') },
		statement: 'Что вернёт запрос?'
	};
}

/** NULL keys in a join: NULL = NULL is not true, so an order without a promo code does not meet the promo with no code. */
function joinNullKey(rng: Rng): Query {
	const codes = rng.sample(['SPRING', 'WELCOME', 'VIP', 'BLACK', 'FRIEND', 'AUTUMN'], 3);
	const promos: (string | number | null)[][] = [[null, rng.int(1, 4) * 5], ...codes.map((c) => [c, rng.int(1, 8) * 5])];
	const orders: (string | number | null)[][] = [];
	// The traps: orders without a code, an order with a code the promo table lacks.
	orders.push([null, rng.int(5, 60) * 50], [null, rng.int(5, 60) * 50], ['SUMMER', rng.int(5, 60) * 50]);
	for (let k = rng.int(2, 4); k > 0; k -= 1) orders.push([rng.pick(codes), rng.int(5, 60) * 50]);
	const setup = [
		'CREATE TABLE promos (code TEXT UNIQUE, discount INTEGER NOT NULL);',
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, promo TEXT, total INTEGER NOT NULL);',
		insertRows('promos', ['code', 'discount'], rng.shuffle(promos)),
		insertRows(
			'orders',
			['id', 'promo', 'total'],
			rng.shuffle(orders).map((o, i) => [100 + i + 1, ...o])
		)
	].join('\n');
	const q = (on: string): string =>
		`SELECT o.id, o.total, p.discount FROM orders o LEFT JOIN promos p ON ${on} ORDER BY o.id;`;
	return {
		setup,
		query: q('p.code = o.promo'),
		wrong: { ...NONE, 'null-equals-null': q('p.code IS o.promo') },
		statement: 'Что вернёт запрос?'
	};
}

function juniorQuery(rng: Rng, classId: string): Query {
	if (classId === 'join-null-key') return joinNullKey(rng);
	if (classId === 'left-join-on') {
		const people = rng.sample(PERSON_NAMES, rng.int(4, 6));
		const customers = people.map((name, i) => [i + 1, name]);
		const orders: (string | number)[][] = [];
		let id = 100;
		// The trap: customer 1 has only unpaid orders, customer 2 has none; the others have a paid one at least.
		for (let k = rng.int(1, 2); k > 0; k -= 1) orders.push([(id += 1), 1, 'new', rng.int(1, 9) * 100]);
		for (let cid = 3; cid <= customers.length; cid += 1) {
			orders.push([(id += 1), cid, 'paid', rng.int(1, 9) * 100]);
			for (let k = rng.int(0, 2); k > 0; k -= 1)
				orders.push([(id += 1), cid, rng.pick(['paid', 'new']), rng.int(1, 9) * 100]);
		}
		const setup = [
			'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
			'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL);',
			insertRows('customers', ['id', 'name'], rng.shuffle(customers)),
			insertRows('orders', ['id', 'customer_id', 'status', 'total'], rng.shuffle(orders))
		].join('\n');
		const join = 'FROM customers c LEFT JOIN orders o ON o.customer_id = c.id';
		const tail = 'GROUP BY c.id ORDER BY c.name;';
		return {
			setup,
			query: `SELECT c.name, COUNT(o.id), SUM(o.total) ${join} AND o.status = 'paid' ${tail}`,
			wrong: {
				...NONE,
				'on-as-where': `SELECT c.name, COUNT(o.id), SUM(o.total) ${join} WHERE o.status = 'paid' ${tail}`,
				'count-star': `SELECT c.name, COUNT(*), SUM(o.total) ${join} AND o.status = 'paid' ${tail}`,
				'null-as-zero': `SELECT c.name, COUNT(o.id), COALESCE(SUM(o.total), 0) ${join} AND o.status = 'paid' ${tail}`
			},
			statement: 'Что вернёт запрос?'
		};
	}
	const table = rng.pick(['employees', 'staff', 'members']);
	const [first, second, third] = rng.sample(['sales', 'ops', 'dev', 'hr', 'qa', 'legal'], 3) as [
		string,
		string,
		string
	];
	const rows: (string | number | null)[][] = [];
	const add = (dept: string | null, bonus: number | null): void => {
		rows.push([rows.length + 1, dept, bonus]);
	};
	if (classId === 'null-group') {
		// The trap: NULL departments with and without a bonus, and NULL bonuses inside named departments.
		add(null, rng.int(1, 20) * 5);
		add(null, null);
		for (const dept of [first, second, third]) {
			add(dept, null);
			for (let k = rng.int(1, 3); k > 0; k -= 1) add(dept, rng.bool(0.3) ? null : rng.int(1, 20) * 5);
		}
		const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, dept TEXT, bonus INTEGER);\n${insertRows(table, ['id', 'dept', 'bonus'], rng.shuffle(rows))}`;
		return {
			setup,
			query: `SELECT dept, COUNT(*), COUNT(bonus) FROM ${table} GROUP BY dept ORDER BY dept;`,
			wrong: {
				...NONE,
				'null-group-dropped': `SELECT dept, COUNT(*), COUNT(bonus) FROM ${table} WHERE dept IS NOT NULL GROUP BY dept ORDER BY dept;`,
				'count-star': `SELECT dept, COUNT(*), COUNT(*) FROM ${table} GROUP BY dept ORDER BY dept;`
			},
			statement: 'Что вернёт запрос? В SQLite NULL при сортировке по возрастанию идёт раньше любого значения.'
		};
	}
	// HAVING over sums: one department has only NULL bonuses, one a small sum, one a large sum.
	const threshold = rng.int(4, 8) * 5;
	add(third, null);
	add(third, null);
	add(first, rng.int(1, threshold / 5 - 1) * 5);
	add(second, threshold * 4 + rng.int(0, 4) * 5);
	for (let k = rng.int(1, 3); k > 0; k -= 1) add(second, rng.bool(0.4) ? null : rng.int(1, 6) * 5);
	add(null, rng.int(1, 4) * 5);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, dept TEXT, bonus INTEGER);\n${insertRows(table, ['id', 'dept', 'bonus'], rng.shuffle(rows))}`;
	const sum = 'SUM(bonus)';
	const zero = 'COALESCE(SUM(bonus), 0)';
	const having = (x: string) => `HAVING ${x} < ${threshold} OR ${x} >= ${threshold * 4}`;
	return {
		setup,
		query: `SELECT dept, ${sum} FROM ${table} WHERE dept IS NOT NULL GROUP BY dept ${having(sum)} ORDER BY dept;`,
		wrong: {
			...NONE,
			'null-as-zero': `SELECT dept, ${zero} FROM ${table} WHERE dept IS NOT NULL GROUP BY dept ${having(zero)} ORDER BY dept;`
		},
		statement: 'Что вернёт запрос?'
	};
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const q = input.grade === 'intern' ? internQuery(rng, input.classId) : juniorQuery(rng, input.classId);
	const answer = { kind: 'sequence' as const, value: runSql(q.setup, q.query) };
	const instance = makeInstance(descriptor, input, {
		statement: {
			markdown: `${q.statement} База — SQLite, схема и данные приведены вместе с запросом.\n\n${SQL_ROW_FORMAT}`,
			code: { language: 'sql', source: `${q.setup}\n\n${q.query}` }
		},
		answer
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source: sqlProbeSource(q.setup, q.query), stdin: '' }),
		wrong: () =>
			Object.fromEntries(
				Object.entries(q.wrong).map(([id, query]) => [
					id,
					query === null
						? null
						: { kind: 'answer' as const, answer: { kind: 'sequence' as const, value: runSql(q.setup, query) } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
