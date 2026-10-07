// Ordering and top-N of an analyst's query: the direction of each key of ORDER BY, where NULL goes in SQLite, LIMIT with
// OFFSET, the row with the maximum of a group when several rows share it, and top-N per group by ROW_NUMBER, RANK and
// DENSE_RANK when values tie.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows } from '../../_lib/sql.ts';
import { buildFromDraft, type SqlDraft } from '../../_lib/sql-draft.ts';

const descriptor = readDescriptor(import.meta.url);

type Row = (string | number | null)[];

const DEPTS = ['sales', 'ops', 'dev', 'hr', 'risk', 'growth'] as const;
const CATEGORIES = ['books', 'games', 'garden', 'music', 'sport', 'toys'] as const;
const NULL_ORDER = 'В SQLite NULL при сортировке считается меньше любого значения.';

/** Rows with ids 1..n in a shuffled order of insertion. */
function numbered(rng: Rng, rows: Row[]): Row[] {
	return rng.shuffle(rows.map((r, i) => [i + 1, ...r]));
}

/** A leaderboard: ORDER BY score DESC, name — the second key ascends. */
function multiKeyOrder(rng: Rng): SqlDraft {
	const table = rng.pick(['leaderboard', 'contest', 'ratings']);
	const names = rng.sample(PERSON_NAMES, rng.int(7, 10));
	const scores = names.map(() => rng.int(5, 12) * 10);
	// The trap: two names share a score inside the top.
	scores[1] = scores[0] ?? 100;
	const rows: Row[] = names.map((name, i) => [name, scores[i] ?? 0]);
	const k = rng.int(3, 5);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score INTEGER NOT NULL);\n${insertRows(table, ['id', 'name', 'score'], numbered(rng, rows))}`;
	const q = (second: string): string => `SELECT name, score FROM ${table} ORDER BY score DESC, ${second} LIMIT ${k};`;
	return {
		setup,
		query: q('name'),
		wrong: { 'desc-applies-all': q('name DESC') },
		purpose: `Аналитик выбирает ${k} лучших участников по баллам.`
	};
}

/** ORDER BY a column with NULL, descending: NULL is the smallest value in SQLite and goes last. */
function nullOrder(rng: Rng): SqlDraft {
	const table = rng.pick(['employees', 'staff', 'members']);
	const names = rng.sample(PERSON_NAMES, rng.int(7, 10));
	const rows: Row[] = names.map((name, i) => [name, i < 2 ? null : rng.bool(0.25) ? null : rng.int(1, 40) * 50]);
	const k = rng.int(3, 5);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, bonus INTEGER);\n${insertRows(table, ['id', 'name', 'bonus'], numbered(rng, rows))}`;
	const q = (order: string): string => `SELECT name, bonus FROM ${table} ORDER BY ${order} LIMIT ${k};`;
	return {
		setup,
		query: q('bonus DESC, id'),
		wrong: { 'null-first-desc': q('bonus IS NULL DESC, bonus DESC, id') },
		purpose: `Аналитик выбирает ${k} сотрудников с наибольшей премией. ${NULL_ORDER}`
	};
}

/** LIMIT n OFFSET m: the page starts at the (m + 1)-th row. */
function limitOffset(rng: Rng): SqlDraft {
	const table = rng.pick(['orders', 'payments', 'invoices']);
	const count = rng.int(9, 14);
	const rows: Row[] = [];
	const amounts = rng.sample(
		Array.from({ length: 60 }, (_, i) => (i + 5) * 25),
		count
	);
	for (let i = 0; i < count; i += 1) rows.push([rng.pick(PERSON_NAMES), amounts[i] ?? 0]);
	const limit = rng.int(2, 4);
	const offset = rng.int(2, 5);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, customer TEXT NOT NULL, amount INTEGER NOT NULL);\n${insertRows(table, ['id', 'customer', 'amount'], numbered(rng, rows))}`;
	const q = (skip: number): string =>
		`SELECT id, customer, amount FROM ${table} ORDER BY amount DESC LIMIT ${limit} OFFSET ${skip};`;
	return {
		setup,
		query: q(offset),
		wrong: { 'offset-skips-less': q(offset - 1) },
		purpose: `Аналитик листает заказы по убыванию суммы, по ${limit} на странице.`
	};
}

/** The row with the maximum of its group by a correlated MAX: tied maxima give several rows. */
function maxRow(rng: Rng): SqlDraft {
	const table = rng.pick(['salaries', 'staff', 'payroll']);
	const depts = rng.sample(DEPTS, rng.int(2, 3));
	const people = rng.sample(PERSON_NAMES, 14);
	const rows: Row[] = [];
	let p = 0;
	depts.forEach((dept, d) => {
		const top = rng.int(8, 15) * 10;
		// The trap: the first department has its maximum twice.
		rows.push([people[p++] ?? 'x', dept, top]);
		if (d === 0) rows.push([people[p++] ?? 'x', dept, top]);
		for (let k = rng.int(1, 2); k > 0; k -= 1) rows.push([people[p++] ?? 'x', dept, top - rng.int(1, 6) * 10]);
	});
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept TEXT NOT NULL, salary INTEGER NOT NULL);\n${insertRows(table, ['id', 'name', 'dept', 'salary'], numbered(rng, rows))}`;
	return {
		setup,
		query: `SELECT dept, name, salary FROM ${table} t1\nWHERE salary = (SELECT MAX(salary) FROM ${table} t2 WHERE t2.dept = t1.dept)\nORDER BY dept, name;`,
		wrong: {
			'one-per-group': `SELECT dept, name, salary FROM (\n  SELECT dept, name, salary, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC, name) AS rn FROM ${table}\n) WHERE rn = 1 ORDER BY dept, name;`
		},
		purpose: 'Аналитик ищет в каждом отделе сотрудников с наибольшей зарплатой.'
	};
}

/** Scores of products per category with ties at the boundary of the top. */
function tiedGroups(rng: Rng, table: string): string {
	const cats = rng.sample(CATEGORIES, rng.int(2, 3));
	const rows: Row[] = [];
	let item = 0;
	for (const cat of cats) {
		const values = rng.sample([3, 4, 5, 6, 7, 8, 9], 4).map((v) => v * 10);
		const sorted = [...values].sort((a, b) => b - a);
		// The trap in every category: a tie on the second place and one at the top in some categories.
		const list = [sorted[0] ?? 0, sorted[1] ?? 0, sorted[1] ?? 0, sorted[2] ?? 0, sorted[3] ?? 0];
		if (rng.bool(0.5)) list.push(sorted[0] ?? 0);
		for (const v of list) rows.push([`p${(item += 1)}`, cat, v]);
	}
	return `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, product TEXT NOT NULL, category TEXT NOT NULL, score INTEGER NOT NULL);\n${insertRows(table, ['id', 'product', 'category', 'score'], numbered(rng, rows))}`;
}

const ranked = (table: string, fn: string, filter: string): string =>
	`SELECT category, product, score FROM (\n  SELECT category, product, score,\n         ${fn} OVER (PARTITION BY category ORDER BY score DESC${fn === 'ROW_NUMBER()' ? ', product' : ''}) AS r\n  FROM ${table}\n) WHERE r ${filter} ORDER BY category, score DESC, product;`;

function rowNumberTies(rng: Rng): SqlDraft {
	const table = rng.pick(['products', 'catalog', 'items']);
	const setup = tiedGroups(rng, table);
	const n = rng.int(2, 3);
	return {
		setup,
		query: ranked(table, 'ROW_NUMBER()', `<= ${n}`),
		wrong: { 'rank-as-row-number': ranked(table, 'RANK()', `<= ${n}`) },
		purpose: `Аналитик выбирает ${n} товара с наибольшим баллом в каждой категории.`
	};
}

function rankGaps(rng: Rng): SqlDraft {
	const table = rng.pick(['products', 'catalog', 'items']);
	const setup = tiedGroups(rng, table);
	const n = 3;
	return {
		setup,
		query: ranked(table, 'RANK()', `<= ${n}`),
		wrong: { 'dense-as-rank': ranked(table, 'DENSE_RANK()', `<= ${n}`) },
		purpose: 'Аналитик выбирает товары, занявшие первые три места в своей категории.'
	};
}

function denseRankNth(rng: Rng): SqlDraft {
	const table = rng.pick(['salaries', 'staff', 'payroll']);
	const depts = rng.sample(DEPTS, rng.int(2, 3));
	const people = rng.sample(PERSON_NAMES, 16);
	const rows: Row[] = [];
	let p = 0;
	depts.forEach((dept, d) => {
		const top = rng.int(10, 15) * 10;
		const second = top - rng.int(1, 3) * 10;
		// The trap: the first department shares its maximum, so RANK jumps over 2.
		rows.push([people[p++] ?? 'x', dept, top], [people[p++] ?? 'x', dept, second]);
		if (d === 0 || rng.bool(0.4)) rows.push([people[p++] ?? 'x', dept, top]);
		if (rng.bool(0.5)) rows.push([people[p++] ?? 'x', dept, second - rng.int(1, 3) * 10]);
	});
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept TEXT NOT NULL, salary INTEGER NOT NULL);\n${insertRows(table, ['id', 'name', 'dept', 'salary'], numbered(rng, rows))}`;
	const q = (fn: string): string =>
		`SELECT dept, name, salary FROM (\n  SELECT dept, name, salary, ${fn} OVER (PARTITION BY dept ORDER BY salary DESC) AS r FROM ${table}\n) WHERE r = 2 ORDER BY dept, name;`;
	return {
		setup,
		query: q('DENSE_RANK()'),
		wrong: { 'rank-as-dense': q('RANK()') },
		purpose: 'Аналитик ищет в каждом отделе сотрудников со второй по величине зарплатой.'
	};
}

/** The sum of the two largest values per group: NULL sorts last descending and enters the top only when values run out. */
function topSumNull(rng: Rng): SqlDraft {
	const table = rng.pick(['purchases', 'orders', 'payments']);
	const customers = rng.sample(PERSON_NAMES, rng.int(3, 4));
	const rows: Row[] = [];
	customers.forEach((c, i) => {
		// The trap: every customer but the last has a NULL amount next to at least two values.
		const k = rng.int(2, 3);
		for (let j = 0; j < k; j += 1) rows.push([c, rng.int(2, 60) * 10]);
		if (i < customers.length - 1 || rng.bool(0.5)) rows.push([c, null]);
	});
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, customer TEXT NOT NULL, amount INTEGER);\n${insertRows(table, ['id', 'customer', 'amount'], numbered(rng, rows))}`;
	const q = (order: string): string =>
		`SELECT customer, COUNT(amount), SUM(amount) FROM (\n  SELECT customer, amount, ROW_NUMBER() OVER (PARTITION BY customer ORDER BY ${order}) AS rn FROM ${table}\n) WHERE rn <= 2 GROUP BY customer ORDER BY customer;`;
	return {
		setup,
		query: q('amount DESC, id'),
		wrong: { 'null-first-desc': q('amount IS NULL DESC, amount DESC, id') },
		purpose: `Аналитик считает по каждому покупателю сумму двух самых крупных покупок. ${NULL_ORDER}`
	};
}

const DRAFTS: Record<string, (rng: Rng) => SqlDraft> = {
	'intern/multi-key-order': multiKeyOrder,
	'intern/null-order': nullOrder,
	'intern/limit-offset': limitOffset,
	'intern/max-row': maxRow,
	'junior/row-number-ties': rowNumberTies,
	'junior/rank-gaps': rankGaps,
	'junior/dense-rank-nth': denseRankNth,
	'junior/top-sum-null': topSumNull
};

export function build(input: GenerateInput): Built {
	const draft = DRAFTS[`${input.grade}/${input.classId}`];
	if (!draft) throw new Error(`${descriptor.key}: no draft for ${input.grade}/${input.classId}`);
	return buildFromDraft(descriptor, input, draft);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
