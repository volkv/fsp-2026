// Joins and multiplicity: which rows INNER and LEFT JOIN keep, how a one-to-many join repeats rows, and what an
// aggregate over a join with two «many» tables really sums.
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
import { insertRows, runSql, sqlProbeSource, SQL_ROW_FORMAT } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

interface Draft {
	setup: string;
	query: string;
	/** The rows a misconception gives, by its id; a misconception absent here does not apply to the class. */
	wrong: Record<string, string[]>;
}

interface World {
	customers: { id: number; name: string; city: string }[];
	orders: { id: number; customerId: number; total: number }[];
	tickets: { id: number; customerId: number }[];
}

const TICKET_TABLES = ['tickets', 'reviews', 'visits', 'complaints'] as const;

/** Customers with the given numbers of orders and tickets; order ids start at 101, ticket ids at 501. */
function world(rng: Rng, orderCounts: readonly number[], ticketCounts: readonly number[]): World {
	const names = rng.sample(PERSON_NAMES, orderCounts.length);
	const cities = rng.sample(CITY_NAMES, 3);
	const customers = names.map((name, i) => ({ id: i + 1, name, city: rng.pick(cities) }));
	const orders: World['orders'] = [];
	const tickets: World['tickets'] = [];
	orderCounts.forEach((n, i) => {
		for (let k = 0; k < n; k += 1) orders.push({ id: 0, customerId: i + 1, total: rng.int(2, 40) * 50 });
	});
	ticketCounts.forEach((n, i) => {
		for (let k = 0; k < n; k += 1) tickets.push({ id: 0, customerId: i + 1 });
	});
	rng.shuffle(orders).forEach((o, i) => (o.id = 101 + i));
	rng.shuffle(tickets).forEach((t, i) => (t.id = 501 + i));
	return { customers, orders, tickets };
}

function setupOf(rng: Rng, w: World, ticketTable: string | null): string {
	const lines = [
		'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL);',
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, total INTEGER NOT NULL);'
	];
	if (ticketTable) lines.push(`CREATE TABLE ${ticketTable} (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL);`);
	lines.push(
		insertRows(
			'customers',
			['id', 'name', 'city'],
			rng.shuffle(w.customers).map((c) => [c.id, c.name, c.city])
		),
		insertRows(
			'orders',
			['id', 'customer_id', 'total'],
			[...w.orders].sort((a, b) => a.id - b.id).map((o) => [o.id, o.customerId, o.total])
		)
	);
	if (ticketTable)
		lines.push(
			insertRows(
				ticketTable,
				['id', 'customer_id'],
				[...w.tickets].sort((a, b) => a.id - b.id).map((t) => [t.id, t.customerId])
			)
		);
	return lines.join('\n');
}

function counts(rng: Rng, n: number, min: number, max: number): number[] {
	return Array.from({ length: n }, () => rng.int(min, max));
}

function leftKeepsUnmatched(rng: Rng): Draft {
	// The traps: a customer without orders and a customer with several.
	const orderCounts = rng.shuffle([0, rng.int(2, 3), ...counts(rng, rng.int(2, 3), 0, 2)]);
	const w = world(rng, orderCounts, []);
	const setup = setupOf(rng, w, null);
	const cols = 'SELECT c.name, o.id, o.total FROM customers c';
	const order = 'ORDER BY c.name, o.id';
	return {
		setup,
		query: `${cols} LEFT JOIN orders o ON o.customer_id = c.id ${order};`,
		wrong: {
			'left-as-inner': runSql(setup, `${cols} JOIN orders o ON o.customer_id = c.id ${order};`),
			'one-row-per-left': runSql(
				setup,
				`${cols} LEFT JOIN orders o ON o.id = (SELECT MIN(id) FROM orders WHERE customer_id = c.id) ${order};`
			)
		}
	};
}

function leftSide(rng: Rng): Draft {
	// The traps: orders of a deleted customer (no row in customers) and a customer without orders.
	const orderCounts = rng.shuffle([0, rng.int(1, 2), ...counts(rng, rng.int(2, 3), 1, 2)]);
	const w = world(rng, orderCounts, []);
	const gone = w.customers.length + 1;
	for (let k = rng.int(1, 2); k > 0; k -= 1) w.orders.push({ id: 0, customerId: gone, total: rng.int(2, 40) * 50 });
	rng.shuffle(w.orders).forEach((o, i) => (o.id = 101 + i));
	const setup = setupOf(rng, w, null);
	const cols = 'SELECT o.id, o.total, c.name FROM';
	return {
		setup,
		query: `${cols} orders o LEFT JOIN customers c ON c.id = o.customer_id ORDER BY o.id;`,
		wrong: {
			'left-as-inner': runSql(setup, `${cols} orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id;`),
			'wrong-side': runSql(setup, `${cols} customers c LEFT JOIN orders o ON c.id = o.customer_id ORDER BY o.id;`)
		}
	};
}

function innerRepeats(rng: Rng): Draft {
	const threshold = rng.int(8, 25) * 50;
	const orderCounts = rng.shuffle([rng.int(2, 3), rng.int(2, 3), ...counts(rng, rng.int(2, 3), 0, 2)]);
	const w = world(rng, orderCounts, []);
	// The trap: the first two customers have at least two orders above the threshold.
	for (const cid of [1, 2]) {
		const own = w.orders.filter((o) => o.customerId === cid);
		own.slice(0, 2).forEach((o) => (o.total = threshold + rng.int(0, 10) * 50));
	}
	const setup = setupOf(rng, w, null);
	const tail = `FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.total >= ${threshold} ORDER BY c.name;`;
	return {
		setup,
		query: `SELECT c.name, c.city ${tail}`,
		wrong: { 'one-row-per-left': runSql(setup, `SELECT DISTINCT c.name, c.city ${tail}`) }
	};
}

function sumFanout(rng: Rng): Draft {
	const tickets = rng.pick(TICKET_TABLES);
	// The traps: a customer with several orders and several tickets, one with orders and no tickets.
	const orderCounts = [rng.int(2, 3), rng.int(1, 3), rng.int(0, 2), rng.int(1, 3)];
	const ticketCounts = [rng.int(2, 3), 0, rng.int(0, 2), rng.int(1, 3)];
	const order = rng.shuffle([0, 1, 2, 3]);
	const w = world(
		rng,
		order.map((i) => orderCounts[i] ?? 0),
		order.map((i) => ticketCounts[i] ?? 0)
	);
	const setup = setupOf(rng, w, tickets);
	const select = `SELECT c.name, COUNT(t.id), SUM(o.total) FROM customers c JOIN orders o ON o.customer_id = c.id`;
	const tail = 'GROUP BY c.id ORDER BY c.name;';
	return {
		setup,
		query: `${select} LEFT JOIN ${tickets} t ON t.customer_id = c.id ${tail}`,
		wrong: {
			'no-fanout': runSql(
				setup,
				`SELECT c.name, (SELECT COUNT(*) FROM ${tickets} WHERE customer_id = c.id), SUM(o.total) FROM customers c JOIN orders o ON o.customer_id = c.id ${tail}`
			),
			'left-as-inner': runSql(setup, `${select} JOIN ${tickets} t ON t.customer_id = c.id ${tail}`)
		}
	};
}

function sumDistinct(rng: Rng): Draft {
	const tickets = rng.pick(TICKET_TABLES);
	const orderCounts = [rng.int(2, 3), rng.int(1, 3), rng.int(1, 3), rng.int(1, 2)];
	const ticketCounts = [rng.int(2, 3), rng.int(1, 3), rng.int(1, 2), 0];
	const order = rng.shuffle([0, 1, 2, 3]);
	const w = world(
		rng,
		order.map((i) => orderCounts[i] ?? 0),
		order.map((i) => ticketCounts[i] ?? 0)
	);
	// The trap: the customer with several tickets has two different orders of the same total.
	const target = w.customers[order.indexOf(0)]?.id ?? 1;
	const own = w.orders.filter((o) => o.customerId === target);
	const [first, second] = own;
	if (first && second) second.total = first.total;
	const setup = setupOf(rng, w, tickets);
	const from = `FROM customers c JOIN orders o ON o.customer_id = c.id JOIN ${tickets} t ON t.customer_id = c.id`;
	const tail = 'GROUP BY c.id ORDER BY c.name;';
	return {
		setup,
		query: `SELECT c.name, COUNT(DISTINCT o.id), SUM(DISTINCT o.total) ${from} ${tail}`,
		wrong: {
			'distinct-by-row': runSql(
				setup,
				`SELECT c.name, COUNT(DISTINCT o.id), (SELECT SUM(total) FROM orders WHERE customer_id = c.id) ${from} ${tail}`
			),
			'distinct-ignored': runSql(setup, `SELECT c.name, COUNT(o.id), SUM(o.total) ${from} ${tail}`)
		}
	};
}

function rowsProduct(rng: Rng): Draft {
	const tickets = rng.pick(TICKET_TABLES);
	// The traps: both tables with several rows, one table empty for a customer, both empty for another.
	const orderCounts = [rng.int(2, 3), rng.int(1, 3), 0, rng.int(0, 3)];
	const ticketCounts = [rng.int(3, 4), 0, rng.int(0, 2), rng.int(1, 3)];
	const order = rng.shuffle([0, 1, 2, 3]);
	const w = world(
		rng,
		order.map((i) => orderCounts[i] ?? 0),
		order.map((i) => ticketCounts[i] ?? 0)
	);
	const setup = setupOf(rng, w, tickets);
	const tail = 'GROUP BY c.id ORDER BY c.name;';
	const sub = (table: string): string => `(SELECT COUNT(*) FROM ${table} WHERE customer_id = c.id)`;
	return {
		setup,
		query: `SELECT c.name, COUNT(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id LEFT JOIN ${tickets} t ON t.customer_id = c.id ${tail}`,
		wrong: {
			'rows-add': runSql(setup, `SELECT c.name, MAX(1, ${sub('orders')} + ${sub(tickets)}) FROM customers c ${tail}`),
			'left-as-inner': runSql(
				setup,
				`SELECT c.name, COUNT(*) FROM customers c JOIN orders o ON o.customer_id = c.id JOIN ${tickets} t ON t.customer_id = c.id ${tail}`
			)
		}
	};
}

function commaJoin(rng: Rng): Draft {
	const threshold = rng.int(10, 25) * 50;
	const orderCounts = rng.shuffle([0, rng.int(1, 2), ...counts(rng, rng.int(1, 2), 0, 2)]);
	const w = world(rng, orderCounts, []);
	// The trap: a comma join without a join condition pairs every customer with every order that passes the filter.
	const own = w.orders[0];
	if (own) own.total = threshold + rng.int(0, 10) * 50;
	const setup = setupOf(rng, w, null);
	const tail = `WHERE o.total >= ${threshold} ORDER BY c.name, o.id;`;
	return {
		setup,
		query: `SELECT c.name, o.id, o.total FROM customers c, orders o ${tail}`,
		wrong: {
			'implicit-key-join': runSql(
				setup,
				`SELECT c.name, o.id, o.total FROM customers c JOIN orders o ON o.customer_id = c.id ${tail}`
			)
		}
	};
}

function antiJoin(rng: Rng): Draft {
	const status = rng.pick(['paid', 'shipped', 'delivered']);
	const other = rng.pick(['cancelled', 'pending', 'refunded']);
	const n = rng.int(5, 6);
	const names = rng.sample(PERSON_NAMES, n);
	const customers = names.map((name, i) => [i + 1, name, rng.pick(CITY_NAMES)]);
	const orders: (number | string)[][] = [];
	const add = (cid: number, st: string): void => {
		orders.push([cid, st, rng.int(2, 40) * 50]);
	};
	// The traps: a customer without orders, one with only other statuses, one with both, one with the status only.
	add(2, other);
	add(3, other);
	add(3, status);
	add(4, status);
	for (let cid = 5; cid <= n; cid += 1) for (let k = rng.int(0, 2); k > 0; k -= 1) add(cid, rng.pick([status, other]));
	const setup = [
		'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL);',
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL);',
		insertRows('customers', ['id', 'name', 'city'], rng.shuffle(customers)),
		insertRows(
			'orders',
			['id', 'customer_id', 'status', 'total'],
			rng.shuffle(orders).map((o, i) => [101 + i, ...o])
		)
	].join('\n');
	const st = `'${status}'`;
	return {
		setup,
		query: `SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status = ${st} WHERE o.id IS NULL ORDER BY c.name;`,
		wrong: {
			'anti-as-not-equal': runSql(
				setup,
				`SELECT DISTINCT c.name FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.status <> ${st} ORDER BY c.name;`
			),
			'left-as-inner': runSql(
				setup,
				`SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id AND o.status = ${st} WHERE o.id IS NULL ORDER BY c.name;`
			)
		}
	};
}

const DRAFTS: Record<string, (rng: Rng) => Draft> = {
	'intern/comma-join': commaJoin,
	'junior/anti-join': antiJoin,
	'intern/left-keeps-unmatched': leftKeepsUnmatched,
	'intern/left-side': leftSide,
	'intern/inner-repeats': innerRepeats,
	'junior/sum-fanout': sumFanout,
	'junior/sum-distinct': sumDistinct,
	'junior/rows-product': rowsProduct
};

function sameRows(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const draft = DRAFTS[`${input.grade}/${input.classId}`];
	if (!draft) throw new Error(`${descriptor.key}: no draft for ${input.grade}/${input.classId}`);
	// Data are drawn until every misconception of the class changes the result.
	for (let tries = 0; tries < 200; tries += 1) {
		const q = draft(rng);
		const answer = runSql(q.setup, q.query);
		if (answer.length < 2) continue;
		if (Object.values(q.wrong).some((rows) => sameRows(rows, answer))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: `Что вернёт запрос? База — SQLite, схема и данные приведены вместе с запросом.\n\n${SQL_ROW_FORMAT}`,
				code: { language: 'sql', source: `${q.setup}\n\n${q.query}` }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: sqlProbeSource(q.setup, q.query), stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					descriptor.wrongSolutions.map(({ id }) => {
						const rows = q.wrong[id];
						return [
							id,
							rows === undefined
								? null
								: { kind: 'answer' as const, answer: { kind: 'sequence' as const, value: rows } }
						];
					})
				)
		};
	}
	throw new Error(`${descriptor.key}: no data for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
