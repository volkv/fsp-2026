// Data checks a tester runs after a migration: orphans (LEFT JOIN … IS NULL, NOT EXISTS) and duplicates (GROUP BY …
// HAVING, IN and NOT IN over groups, normalized keys); the result of the shown check query on a generated database,
// where NULL references, soft deletes, case and spaces decide the answer.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows, runSql, sqlProbeSource, SQL_ROW_FORMAT } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

interface Draft {
	setup: string;
	query: string;
	/** The query a misconception reads instead, by its id; a misconception absent here does not apply to the class. */
	wrong: Record<string, string>;
	/** What the check is for, one sentence. */
	purpose: string;
}

const QUOTE_NOTE =
	"Функция `quote` выводит строку в одинарных кавычках, чтобы были видны пробелы (`' anna@ya.ru'`), а NULL — как `NULL`.";

const DOMAINS = ['mail.ru', 'ya.ru', 'corp.ru', 'inbox.ru'] as const;

/** Distinct ids drawn from [lo, hi]. */
const ids = (rng: Rng, n: number, lo: number, hi: number): number[] =>
	rng.sample(
		Array.from({ length: hi - lo + 1 }, (_, i) => lo + i),
		n
	);

function leftJoinOrphans(rng: Rng): Draft {
	const customers = ids(rng, rng.int(4, 6), 1, 60).sort((a, b) => a - b);
	const gone = ids(rng, 6, 61, 99);
	const orders: (number | null)[][] = [];
	const orderIds = ids(rng, 12, 100, 999);
	let k = 0;
	const add = (customer: number | null): void => {
		orders.push([orderIds[k++] ?? 0, customer, rng.int(5, 90) * 100]);
	};
	for (let i = rng.int(4, 6); i > 0; i -= 1) add(rng.pick(customers));
	for (let i = rng.int(1, 2); i > 0; i -= 1) add(rng.pick(gone));
	for (let i = rng.int(1, 2); i > 0; i -= 1) add(null);
	const setup = [
		'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total INTEGER NOT NULL);',
		insertRows(
			'customers',
			['id', 'name'],
			customers.map((id, i) => [id, PERSON_NAMES[i] ?? 'anna'])
		),
		insertRows('orders', ['id', 'customer_id', 'total'], rng.shuffle(orders))
	].join('\n');
	const head =
		'SELECT o.id, o.customer_id FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE c.id IS NULL';
	return {
		setup,
		query: `${head} ORDER BY o.id;`,
		wrong: { 'null-fk-not-orphan': `${head} AND o.customer_id IS NOT NULL ORDER BY o.id;` },
		purpose: 'Проверочный запрос ищет заказы, у которых нет клиента.'
	};
}

/** Emails of distinct people and their variants: exact copies, other case, spaces at the ends. */
function emails(rng: Rng, people: number): string[] {
	return rng.sample(PERSON_NAMES, people).map((name) => `${name}@${rng.pick(DOMAINS)}`);
}

const upperFirst = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

function variant(rng: Rng, email: string, kinds: readonly ('exact' | 'case' | 'space' | 'inner')[]): string {
	switch (rng.pick(kinds)) {
		case 'exact':
			return email;
		case 'case':
			return rng.bool() ? upperFirst(email) : email.toUpperCase();
		case 'space':
			return rng.bool() ? `${email} ` : ` ${email}`;
		case 'inner':
			return email.replace('@', ' @');
	}
}

function userRows(rng: Rng, values: readonly (string | null)[]): (string | number | null)[][] {
	const rowIds = ids(rng, values.length, 1, 99);
	return rng.shuffle(values).map((email, i) => [rowIds[i] ?? 0, email]);
}

const USERS_DDL = 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);';

function groupDuplicates(rng: Rng): Draft {
	const base = emails(rng, rng.int(4, 5));
	const values: string[] = [...base];
	for (let i = rng.int(1, 2); i > 0; i -= 1) values.push(rng.pick(base));
	for (let i = rng.int(1, 3); i > 0; i -= 1) values.push(variant(rng, rng.pick(base), ['case', 'space']));
	const setup = [USERS_DDL, insertRows('users', ['id', 'email'], userRows(rng, values))].join('\n');
	return {
		setup,
		query: 'SELECT quote(email), COUNT(*) FROM users GROUP BY email HAVING COUNT(*) > 1 ORDER BY email;',
		wrong: {
			'normalized-assumed':
				'SELECT quote(lower(trim(email))), COUNT(*) FROM users GROUP BY lower(trim(email)) HAVING COUNT(*) > 1 ORDER BY 1;'
		},
		purpose: `Проверочный запрос ищет повторяющиеся адреса почты. ${QUOTE_NOTE}`
	};
}

function duplicateRows(rng: Rng): Draft {
	const base = emails(rng, rng.int(4, 5));
	const values: string[] = [...base];
	for (let i = rng.int(2, 4); i > 0; i -= 1) values.push(rng.pick(base));
	const setup = [USERS_DDL, insertRows('users', ['id', 'email'], userRows(rng, values))].join('\n');
	const dups = 'SELECT email FROM users GROUP BY email HAVING COUNT(*) > 1';
	return {
		setup,
		query: `SELECT id, email FROM users WHERE email IN (${dups}) ORDER BY id;`,
		wrong: {
			'only-extras': `SELECT id, email FROM users WHERE email IN (${dups}) AND id NOT IN (SELECT MIN(id) FROM users GROUP BY email) ORDER BY id;`
		},
		purpose: 'Проверочный запрос показывает строки с повторяющимися адресами почты.'
	};
}

function notExistsOrphans(rng: Rng): Draft {
	const orderIds = ids(rng, rng.int(4, 6), 100, 999).sort((a, b) => a - b);
	const missing = ids(rng, 6, 1000, 1999);
	const orders = orderIds.map((id, i) => [
		id,
		rng.int(5, 90) * 100,
		i === 0 || rng.bool(0.25) ? `2026-0${rng.int(1, 9)}-${String(rng.int(10, 28))}` : null
	]);
	const softDeleted = orders.filter((o) => o[2] !== null).map((o) => Number(o[0]));
	const payments: (number | null)[][] = [];
	const payIds = ids(rng, 12, 1, 99);
	let k = 0;
	const add = (order: number | null): void => {
		payments.push([payIds[k++] ?? 0, order, rng.int(5, 90) * 100]);
	};
	for (let i = rng.int(3, 5); i > 0; i -= 1) add(rng.pick(orderIds));
	add(rng.pick(softDeleted));
	for (let i = rng.int(1, 2); i > 0; i -= 1) add(rng.pick(missing));
	for (let i = rng.int(1, 2); i > 0; i -= 1) add(null);
	const setup = [
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER NOT NULL, deleted_at TEXT);',
		'CREATE TABLE payments (id INTEGER PRIMARY KEY, order_id INTEGER, amount INTEGER NOT NULL);',
		insertRows('orders', ['id', 'total', 'deleted_at'], rng.shuffle(orders)),
		insertRows('payments', ['id', 'order_id', 'amount'], rng.shuffle(payments))
	].join('\n');
	const q = (inner: string, extra: string): string =>
		`SELECT p.id, p.order_id FROM payments p WHERE ${extra}NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = p.order_id${inner}) ORDER BY p.id;`;
	return {
		setup,
		query: q('', ''),
		wrong: {
			'soft-deleted-orphans': q(' AND o.deleted_at IS NULL', ''),
			'null-fk-not-orphan': q('', 'p.order_id IS NOT NULL AND ')
		},
		purpose:
			'Проверочный запрос ищет платежи, у которых нет заказа. Заказ с заполненным `deleted_at` помечен удалённым, но строка в таблице осталась.'
	};
}

function normalizedUnique(rng: Rng): Draft {
	const base = emails(rng, rng.int(4, 5));
	const values: string[] = [...base];
	for (let i = rng.int(1, 2); i > 0; i -= 1) values.push(variant(rng, rng.pick(base), ['case']));
	for (let i = rng.int(1, 2); i > 0; i -= 1) values.push(variant(rng, rng.pick(base), ['space']));
	for (let i = rng.int(1, 2); i > 0; i -= 1) values.push(variant(rng, rng.pick(base), ['exact', 'inner']));
	const setup = [USERS_DDL, insertRows('users', ['id', 'email'], userRows(rng, values))].join('\n');
	const q = (expr: string): string =>
		`SELECT ${expr}, COUNT(*), MIN(id) FROM users GROUP BY ${expr} HAVING COUNT(*) > 1 ORDER BY 1;`;
	return {
		setup,
		query: q('lower(trim(email))'),
		wrong: { 'case-only': q('lower(email)'), 'trim-only': q('trim(email)') },
		purpose:
			'Проверочный запрос ищет адреса почты, которые совпадут, если не учитывать регистр латинских букв и пробелы в начале и в конце.'
	};
}

function compositeNull(rng: Rng): Draft {
	const customers = ids(rng, rng.int(3, 4), 1, 60);
	const coupons = rng.sample(['SPRING', 'WELCOME', 'VIP', 'BLACK', 'FRIEND'], 3);
	const rows: (number | string | null)[][] = [];
	const add = (customer: number, coupon: string | null): void => {
		rows.push([customer, coupon]);
	};
	// The traps: one customer twice with no coupon, one customer with the same coupon twice.
	const [a, b] = customers;
	add(a ?? 1, null);
	add(a ?? 1, null);
	const c = rng.pick(coupons);
	add(b ?? 2, c);
	add(b ?? 2, c);
	for (let i = rng.int(3, 6); i > 0; i -= 1) add(rng.pick(customers), rng.bool(0.3) ? null : rng.pick(coupons));
	const rowIds = ids(rng, rows.length, 100, 999);
	const setup = [
		'CREATE TABLE redemptions (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, coupon TEXT);',
		insertRows(
			'redemptions',
			['id', 'customer_id', 'coupon'],
			rng.shuffle(rows).map((r, i) => [rowIds[i] ?? 0, ...r])
		)
	].join('\n');
	const q = (where: string): string =>
		`SELECT customer_id, coupon, COUNT(*) FROM redemptions ${where}GROUP BY customer_id, coupon HAVING COUNT(*) > 1 ORDER BY customer_id, coupon;`;
	return {
		setup,
		query: q(''),
		wrong: { 'null-groups-separate': q('WHERE coupon IS NOT NULL ') },
		purpose:
			'Проверочный запрос ищет повторные погашения: одна и та же пара «клиент — купон» больше одного раза. В SQLite NULL при сортировке по возрастанию идёт раньше любого значения.'
	};
}

function keepFirst(rng: Rng): Draft {
	const base = emails(rng, rng.int(3, 4));
	const values: (string | null)[] = [...base];
	for (let i = rng.int(1, 2); i > 0; i -= 1) values.push(variant(rng, rng.pick(base), ['case', 'space']));
	for (let i = rng.int(0, 1); i > 0; i -= 1) values.push(rng.pick(base));
	for (let i = rng.int(1, 3); i > 0; i -= 1) values.push(null);
	const setup = [USERS_DDL, insertRows('users', ['id', 'email'], userRows(rng, values))].join('\n');
	const q = (expr: string): string =>
		`SELECT id, quote(email) FROM users WHERE id NOT IN (SELECT MIN(id) FROM users GROUP BY ${expr}) ORDER BY id;`;
	return {
		setup,
		query: q('lower(trim(email))'),
		wrong: { 'raw-group': q('email') },
		purpose: `Перед дедупликацией тестировщик смотрит, какие строки скрипт удалит: в каждой группе совпадающих адресов остаётся строка с наименьшим \`id\`, остальные удаляются. ${QUOTE_NOTE}`
	};
}

function childlessParents(rng: Rng): Draft {
	const customers = ids(rng, rng.int(5, 7), 1, 99).sort((a, b) => a - b);
	const names = rng.sample(PERSON_NAMES, customers.length);
	const withOrders = rng.sample(customers, customers.length - rng.int(1, 3));
	const orders: (number | string)[][] = [];
	const orderIds = ids(rng, 14, 100, 999);
	let k = 0;
	for (const c of withOrders)
		for (let i = rng.int(1, 2); i > 0; i -= 1)
			orders.push([orderIds[k++] ?? 0, c, rng.pick(['paid', 'new', 'cancelled'])]);
	const setup = [
		'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status TEXT NOT NULL);',
		insertRows('customers', ['id', 'name'], rng.shuffle(customers.map((id, i) => [id, names[i] ?? 'anna']))),
		insertRows('orders', ['id', 'customer_id', 'status'], rng.shuffle(orders))
	].join('\n');
	const q = (count: string): string =>
		`SELECT c.id, c.name, ${count} FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id HAVING ${count} = 0 ORDER BY c.id;`;
	return {
		setup,
		query: q('COUNT(o.id)'),
		wrong: { 'count-star': q('COUNT(*)') },
		purpose: 'Проверочный запрос ищет клиентов без единого заказа.'
	};
}

const DRAFTS: Record<string, (rng: Rng) => Draft> = {
	'intern/left-join-orphans': leftJoinOrphans,
	'intern/group-duplicates': groupDuplicates,
	'intern/duplicate-rows': duplicateRows,
	'intern/not-exists-orphans': notExistsOrphans,
	'junior/normalized-unique': normalizedUnique,
	'junior/composite-null': compositeNull,
	'junior/keep-first': keepFirst,
	'junior/childless-parents': childlessParents
};

const WRONG_IDS = descriptor.wrongSolutions.map((w) => w.id);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const draft = DRAFTS[`${input.grade}/${input.classId}`];
	if (!draft) throw new Error(`${descriptor.key}: no draft for ${input.grade}/${input.classId}`);
	// Data are drawn until every misconception of the class changes the rows and the result is not empty.
	for (let tries = 0; tries < 300; tries += 1) {
		const d = draft(rng);
		const rows = runSql(d.setup, d.query);
		if (rows.length === 0) continue;
		const wrongRows = Object.fromEntries(Object.entries(d.wrong).map(([id, q]) => [id, runSql(d.setup, q)]));
		if (Object.values(wrongRows).some((w) => JSON.stringify(w) === JSON.stringify(rows))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: `${d.purpose} Что вернёт запрос? База — SQLite, схема и данные приведены вместе с запросом.\n\n${SQL_ROW_FORMAT}`,
				code: { language: 'sql', source: `${d.setup}\n\n${d.query}` }
			},
			answer: { kind: 'sequence', value: rows }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: sqlProbeSource(d.setup, d.query), stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					WRONG_IDS.map((id) => {
						const value = wrongRows[id];
						return [
							id,
							value === undefined ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
						];
					})
				)
		};
	}
	throw new Error(`${descriptor.key}: no data for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
