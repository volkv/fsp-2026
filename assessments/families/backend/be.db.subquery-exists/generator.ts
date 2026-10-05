// Subqueries: IN against a join, NOT IN with NULL in the list, EXISTS whatever it selects, correlated subqueries,
// scalar subqueries in SELECT and comparisons with an aggregate of a subquery.
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

interface Draft {
	setup: string;
	query: string;
	/** The rows a misconception gives, by its id; a misconception absent here does not apply to the class. */
	wrong: Record<string, string[]>;
}

interface Order {
	customerId: number;
	status: string;
	total: number;
	coupon: string | null;
}

const STATUSES = ['paid', 'refund', 'new'] as const;
const COUPONS = ['SALE10', 'VIP', 'WELCOME', 'FRIEND'] as const;

/** Customers 1..n with names and cities; orders get ids from 101 in a shuffled order. */
function shop(
	rng: Rng,
	n: number,
	orders: Order[],
	extra: { referrer?: (number | null)[] } = {}
): { setup: string; names: string[]; cities: string[] } {
	const names = rng.sample(PERSON_NAMES, n);
	const cityPool = rng.sample(CITY_NAMES, 3);
	const cities = names.map(() => rng.pick(cityPool));
	const withReferrer = extra.referrer !== undefined;
	const customers = names.map((name, i) => [
		i + 1,
		name,
		cities[i] ?? '',
		...(withReferrer ? [extra.referrer?.[i] ?? null] : [])
	]);
	const setup = [
		`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL${withReferrer ? ', referrer_id INTEGER' : ''});`,
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL, coupon TEXT);',
		insertRows('customers', ['id', 'name', 'city', ...(withReferrer ? ['referrer_id'] : [])], rng.shuffle(customers)),
		insertRows(
			'orders',
			['id', 'customer_id', 'status', 'total', 'coupon'],
			rng.shuffle(orders).map((o, i) => [101 + i, o.customerId, o.status, o.total, o.coupon])
		)
	].join('\n');
	return { setup, names, cities };
}

function order(rng: Rng, customerId: number, total?: number, status?: string): Order {
	return {
		customerId,
		status: status ?? rng.pick(STATUSES),
		total: total ?? rng.int(2, 40) * 50,
		coupon: rng.bool(0.4) ? null : rng.pick(COUPONS)
	};
}

function randomOrders(rng: Rng, from: number, to: number, max: number): Order[] {
	const out: Order[] = [];
	for (let cid = from; cid <= to; cid += 1) for (let k = rng.int(0, max); k > 0; k -= 1) out.push(order(rng, cid));
	return out;
}

function inNoDuplicates(rng: Rng): Draft {
	const n = rng.int(4, 6);
	const threshold = rng.int(10, 25) * 50;
	// The trap: customer 1 has two orders above the threshold.
	const orders = [order(rng, 1, threshold + rng.int(0, 10) * 50), order(rng, 1, threshold + rng.int(0, 10) * 50)];
	orders.push(...randomOrders(rng, 2, n, 2));
	const { setup } = shop(rng, n, orders);
	return {
		setup,
		query: `SELECT name, city FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE total >= ${threshold}) ORDER BY name;`,
		wrong: {
			'in-duplicates': runSql(
				setup,
				`SELECT c.name, c.city FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.total >= ${threshold} ORDER BY c.name;`
			)
		}
	};
}

function notInNull(rng: Rng): Draft {
	const n = rng.int(6, 7);
	// Referrers: customer 1 came by himself (NULL), others were brought by customers 1–3.
	const referrer: (number | null)[] = [null, ...Array.from({ length: n - 1 }, () => rng.int(1, 3))];
	const { setup, cities } = shop(rng, n, randomOrders(rng, 1, n, 1), { referrer });
	const city = rng.pick(cities);
	const tail = `OR city = ${sqlText(city)} ORDER BY name;`;
	return {
		setup,
		query: `SELECT name, city FROM customers WHERE id NOT IN (SELECT referrer_id FROM customers) ${tail}`,
		wrong: {
			'not-in-skips-null': runSql(
				setup,
				`SELECT name, city FROM customers WHERE id NOT IN (SELECT referrer_id FROM customers WHERE referrer_id IS NOT NULL) ${tail}`
			)
		}
	};
}

function existsNullColumn(rng: Rng): Draft {
	const n = rng.int(4, 6);
	const threshold = rng.int(10, 25) * 50;
	// The trap: customer 1 has a large order without a coupon only; customer 2 one with a coupon.
	const orders: Order[] = [
		{ ...order(rng, 1, threshold + rng.int(0, 10) * 50), coupon: null },
		{ ...order(rng, 2, threshold + rng.int(0, 10) * 50), coupon: rng.pick(COUPONS) }
	];
	orders.push(...randomOrders(rng, 3, n, 2));
	const { setup } = shop(rng, n, orders);
	const q = (extra: string): string =>
		`SELECT name FROM customers c WHERE EXISTS (SELECT o.coupon FROM orders o WHERE o.customer_id = c.id AND o.total >= ${threshold}${extra}) ORDER BY name;`;
	return {
		setup,
		query: q(''),
		wrong: { 'exists-checks-value': runSql(setup, q(' AND o.coupon IS NOT NULL')) }
	};
}

function existsCorrelated(rng: Rng): Draft {
	const n = rng.int(4, 6);
	const orders = [order(rng, 1, undefined, 'refund'), order(rng, 2, undefined, 'paid')];
	orders.push(...randomOrders(rng, 3, n, 2));
	const { setup } = shop(rng, n, orders);
	const q = (link: string): string =>
		`SELECT name, city FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE ${link}o.status = 'refund') ORDER BY name;`;
	return {
		setup,
		query: q('o.customer_id = c.id AND '),
		wrong: { 'exists-uncorrelated': runSql(setup, q('')) }
	};
}

function scalarSubquery(rng: Rng): Draft {
	const n = rng.int(4, 6);
	// The trap: a customer without orders keeps his row with 0 and NULL.
	const orders = randomOrders(rng, 2, n, 3);
	orders.push(order(rng, 2));
	const { setup } = shop(rng, n, orders);
	const count = 'SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id';
	const max = 'SELECT MAX(total) FROM orders o WHERE o.customer_id = c.id';
	return {
		setup,
		query: `SELECT c.name, (${count}), (${max}) FROM customers c ORDER BY c.name;`,
		wrong: {
			'scalar-as-join': runSql(
				setup,
				'SELECT c.name, COUNT(*), MAX(o.total) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY c.name;'
			),
			'empty-max-zero': runSql(
				setup,
				`SELECT c.name, (${count}), COALESCE((${max}), 0) FROM customers c ORDER BY c.name;`
			)
		}
	};
}

function correlatedAvg(rng: Rng): Draft {
	const n = rng.int(3, 4);
	// Customers with small and with large orders: the global average splits them differently than their own.
	const orders: Order[] = [];
	for (let cid = 1; cid <= n; cid += 1) {
		const scale = cid % 2 === 0 ? rng.int(2, 6) : rng.int(15, 30);
		for (let k = rng.int(2, 4); k > 0; k -= 1) orders.push(order(rng, cid, (scale + rng.int(0, 8)) * 50));
	}
	const { setup } = shop(rng, n, orders);
	const q = (where: string): string =>
		`SELECT o.id, c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > (SELECT AVG(total) FROM orders${where}) ORDER BY o.id;`;
	return {
		setup,
		query: q(' WHERE customer_id = o.customer_id'),
		wrong: { 'uncorrelated-avg': runSql(setup, q('')) }
	};
}

function maxPerGroupTies(rng: Rng): Draft {
	const n = rng.int(3, 5);
	const orders = randomOrders(rng, 1, n, 3);
	// The trap: customer 1 has two orders with the same largest total.
	const top = rng.int(30, 45) * 50;
	orders.push(order(rng, 1, top), order(rng, 1, top));
	const { setup } = shop(rng, n, orders);
	const head = 'SELECT c.name, o.id, o.total FROM orders o JOIN customers c ON c.id = o.customer_id';
	return {
		setup,
		query: `${head} WHERE o.total = (SELECT MAX(total) FROM orders WHERE customer_id = o.customer_id) ORDER BY c.name, o.id;`,
		wrong: {
			'one-per-group': runSql(
				setup,
				`SELECT name, id, total FROM (SELECT c.name, o.id, o.total, ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.total DESC, o.id) AS rn FROM orders o JOIN customers c ON c.id = o.customer_id) WHERE rn = 1 ORDER BY name, id;`
			)
		}
	};
}

function inGroupCount(rng: Rng): Draft {
	const n = rng.int(6, 8);
	const orders = randomOrders(rng, 2, n, 3);
	// The trap: a customer with several paid orders.
	orders.push(order(rng, 1, undefined, 'paid'), order(rng, 1, undefined, 'paid'));
	const { setup } = shop(rng, n, orders);
	return {
		setup,
		query: `SELECT city, COUNT(*) FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE status = 'paid') GROUP BY city ORDER BY city;`,
		wrong: {
			'in-duplicates': runSql(
				setup,
				`SELECT c.city, COUNT(*) FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.status = 'paid' GROUP BY c.city ORDER BY c.city;`
			)
		}
	};
}

const DRAFTS: Record<string, (rng: Rng) => Draft> = {
	'intern/in-no-duplicates': inNoDuplicates,
	'intern/not-in-null': notInNull,
	'intern/exists-null-column': existsNullColumn,
	'intern/exists-correlated': existsCorrelated,
	'junior/scalar-subquery': scalarSubquery,
	'junior/correlated-avg': correlatedAvg,
	'junior/max-per-group-ties': maxPerGroupTies,
	'junior/in-group-count': inGroupCount
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
