// NULL traps in a tester's check queries: NOT IN over a subquery with NULL, COUNT of a column, comparisons with NULL,
// AVG and SUM, COALESCE in a condition, SUM over an outer join, simple CASE, concatenation and NOT; the result of the
// shown query on a generated database.
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
	/** The query a misconception reads instead, by its id; a misconception absent here does not apply to the class. */
	wrong: Record<string, string>;
	purpose: string;
}

const ids = (rng: Rng, n: number, lo: number, hi: number): number[] =>
	rng.sample(
		Array.from({ length: hi - lo + 1 }, (_, i) => lo + i),
		n
	);

const BOOL_NOTE = 'В SQLite истина выводится как 1, ложь — как 0.';

function notInNull(rng: Rng): Draft {
	const people = ids(rng, rng.int(6, 9), 10, 99);
	const rows = people.map((id) => [id, rng.pick(PERSON_NAMES), rng.bool(0.3) ? null : rng.pick(people)]);
	// The trap in every instance: at least one customer came without a referrer.
	const first = rows[0];
	if (first) first[2] = null;
	const setup = [
		'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, referrer_id INTEGER);',
		insertRows('customers', ['id', 'name', 'referrer_id'], rng.shuffle(rows))
	].join('\n');
	const q = (sub: string): string =>
		`SELECT c.id, c.id NOT IN (${sub}), NOT EXISTS (SELECT 1 FROM customers r WHERE r.referrer_id = c.id) FROM customers c ORDER BY c.id;`;
	return {
		setup,
		query: q('SELECT referrer_id FROM customers'),
		wrong: { 'not-in-ignores-null': q('SELECT referrer_id FROM customers WHERE referrer_id IS NOT NULL') },
		purpose: `Тестировщик сравнивает два способа найти клиентов, которых никто не пригласил: через \`NOT IN\` и через \`NOT EXISTS\`. ${BOOL_NOTE}`
	};
}

function countColumn(rng: Rng): Draft {
	const cities = rng.sample(CITY_NAMES, 3);
	const phones = Array.from({ length: 4 }, () => `+7 9${rng.int(10, 99)} ${rng.int(100, 999)}`);
	const rows = ids(rng, rng.int(8, 10), 1, 99).map((id) => [
		id,
		rng.pick(cities),
		rng.bool(0.35) ? null : rng.pick(phones)
	]);
	const setup = [
		'CREATE TABLE customers (id INTEGER PRIMARY KEY, city TEXT NOT NULL, phone TEXT);',
		insertRows('customers', ['id', 'city', 'phone'], rows)
	].join('\n');
	const q = (count: string): string =>
		`SELECT city, COUNT(*), ${count}, COUNT(DISTINCT phone) FROM customers GROUP BY city ORDER BY city;`;
	return {
		setup,
		query: q('COUNT(phone)'),
		wrong: { 'count-star': q('COUNT(*)') },
		purpose: 'Тестировщик проверяет, насколько заполнены телефоны клиентов по городам.'
	};
}

function equalsNull(rng: Rng): Draft {
	const staff = ids(rng, rng.int(7, 9), 10, 99);
	const rows = staff.map((id) => [
		id,
		rng.pick(PERSON_NAMES),
		rng.bool(0.3) ? null : rng.pick(staff),
		rng.bool(0.25) ? null : rng.pick(['active', 'active', 'fired', 'vacation'])
	]);
	// The traps: a fired employee without a manager, an employee with no status.
	const [a, b] = rows;
	if (a) {
		a[2] = null;
		a[3] = 'fired';
	}
	if (b) b[3] = null;
	const setup = [
		'CREATE TABLE staff (id INTEGER PRIMARY KEY, name TEXT NOT NULL, manager_id INTEGER, status TEXT);',
		insertRows('staff', ['id', 'name', 'manager_id', 'status'], rng.shuffle(rows))
	].join('\n');
	const q = (left: string, right: string): string =>
		`SELECT id, name FROM staff WHERE ${left} OR ${right} ORDER BY id;`;
	return {
		setup,
		query: q('manager_id = NULL', "status <> 'fired'"),
		wrong: {
			'eq-null-matches': q('manager_id IS NULL', "status <> 'fired'"),
			'null-ne-true': q('manager_id = NULL', "COALESCE(status, '') <> 'fired'")
		},
		purpose: 'Тестировщик проверяет выборку «сотрудники без руководителя или не уволенные».'
	};
}

function avgNull(rng: Rng): Draft {
	const depts = rng.sample(['sales', 'ops', 'dev', 'hr', 'qa', 'legal'], 3);
	const rows: (string | number | null)[][] = [];
	const add = (dept: string, bonus: number | null): void => {
		rows.push([dept, bonus]);
	};
	const [d0, d1, d2] = depts as [string, string, string];
	// The traps: a department with NULL bonuses among values, one with NULL bonuses only.
	add(d0, null);
	for (let i = rng.int(2, 3); i > 0; i -= 1) add(d0, rng.int(1, 20) * 5);
	add(d1, null);
	if (rng.bool()) add(d1, null);
	for (let i = rng.int(2, 3); i > 0; i -= 1) add(d2, rng.bool(0.3) ? null : rng.int(1, 20) * 5);
	// Whole averages: the last value of a department is adjusted so its non-NULL values divide evenly.
	for (const dept of depts) {
		const own = rows.filter((r) => r[0] === dept && r[1] !== null);
		const sum = own.reduce((s, r) => s + Number(r[1]), 0);
		const last = own.at(-1);
		const rest = own.length ? sum % own.length : 0;
		if (last && rest !== 0) last[1] = Number(last[1]) + (own.length - rest);
	}
	const rowIds = ids(rng, rows.length, 1, 99);
	const setup = [
		'CREATE TABLE staff (id INTEGER PRIMARY KEY, dept TEXT NOT NULL, bonus INTEGER);',
		insertRows(
			'staff',
			['id', 'dept', 'bonus'],
			rng.shuffle(rows).map((r, i) => [rowIds[i] ?? 0, ...r])
		)
	].join('\n');
	const q = (x: string): string =>
		`SELECT dept, COUNT(*), SUM(${x}), AVG(${x}) FROM staff GROUP BY dept ORDER BY dept;`;
	return {
		setup,
		query: q('bonus'),
		wrong: { 'null-as-zero': q('COALESCE(bonus, 0)') },
		purpose: 'Тестировщик сверяет премии по отделам с отчётом.'
	};
}

function coalesceCondition(rng: Rng): Draft {
	const rows = ids(rng, rng.int(8, 11), 100, 999).map((id) => [
		id,
		rng.bool(0.3) ? null : rng.int(0, 6) * 5,
		rng.bool(0.3) ? null : rng.pick(['staff', 'spring', 'vip', 'staff'])
	]);
	// The traps: no discount with an ordinary promo, a discount with no promo.
	const [a, b] = rows;
	if (a) {
		a[1] = null;
		a[2] = 'spring';
	}
	if (b) {
		b[1] = 5;
		b[2] = null;
	}
	const setup = [
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, discount INTEGER, promo TEXT);',
		insertRows('orders', ['id', 'discount', 'promo'], rng.shuffle(rows))
	].join('\n');
	const q = (where: string): string => `SELECT id, discount, promo FROM orders WHERE ${where} ORDER BY id;`;
	return {
		setup,
		query: q("COALESCE(discount, 0) < 10 AND COALESCE(promo, 'none') <> 'staff'"),
		wrong: { 'coalesce-ignored': q("discount < 10 AND promo <> 'staff'") },
		purpose:
			'Тестировщик ищет заказы с малой скидкой (меньше 10) не по служебному промокоду; заказ без скидки или без промокода тоже должен попасть в выборку.'
	};
}

function leftJoinSum(rng: Rng): Draft {
	const customers = ids(rng, rng.int(4, 6), 1, 99);
	const crow = customers.map((id) => [id, rng.pick(PERSON_NAMES), rng.int(10, 60) * 100]);
	const payments: (number | null)[][] = [];
	const payIds = ids(rng, 14, 100, 999);
	let k = 0;
	// The traps: a customer without payments, a customer whose only payment has no amount.
	const [, empty, ...others] = customers;
	payments.push([payIds[k++] ?? 0, empty ?? 0, null]);
	for (const c of others)
		for (let i = rng.int(1, 3); i > 0; i -= 1)
			payments.push([payIds[k++] ?? 0, c, rng.bool(0.2) ? null : rng.int(1, 20) * 50]);
	const setup = [
		'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, credit INTEGER NOT NULL);',
		'CREATE TABLE payments (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, amount INTEGER);',
		insertRows('customers', ['id', 'name', 'credit'], rng.shuffle(crow)),
		insertRows('payments', ['id', 'customer_id', 'amount'], rng.shuffle(payments))
	].join('\n');
	const q = (sum: string): string =>
		`SELECT c.id, ${sum}, c.credit - ${sum} FROM customers c LEFT JOIN payments p ON p.customer_id = c.id GROUP BY c.id ORDER BY c.id;`;
	return {
		setup,
		query: q('SUM(p.amount)'),
		wrong: { 'null-as-zero': q('COALESCE(SUM(p.amount), 0)') },
		purpose: 'Тестировщик сверяет остаток кредитного лимита клиентов: лимит минус сумма платежей.'
	};
}

const MIDDLE_NAMES = ['petrovna', 'ivanovich', 'olegovna', 'sergeevich', 'pavlovna', 'borisovich'] as const;

function caseConcat(rng: Rng): Draft {
	const rows = ids(rng, rng.int(6, 9), 10, 99).map((id) => [
		id,
		rng.pick(PERSON_NAMES),
		rng.bool(0.35) ? null : rng.pick(MIDDLE_NAMES),
		rng.bool(0.3) ? null : rng.int(10, 99)
	]);
	// The traps: a person with no middle name, a person with no score.
	const [a, b] = rows;
	if (a) a[2] = null;
	if (b) b[3] = null;
	const setup = [
		'CREATE TABLE people (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, middle_name TEXT, score INTEGER);',
		insertRows('people', ['id', 'first_name', 'middle_name', 'score'], rng.shuffle(rows))
	].join('\n');
	const q = (full: string, simple: string): string =>
		`SELECT id, ${full}, ${simple}, CASE WHEN score >= 50 THEN 'pass' WHEN score < 50 THEN 'fail' ELSE 'none' END FROM people ORDER BY id;`;
	const full = "first_name || ' ' || middle_name";
	const simple = "CASE score WHEN NULL THEN 'missing' ELSE 'present' END";
	return {
		setup,
		query: q(full, simple),
		wrong: {
			'case-null-matches': q(full, "CASE WHEN score IS NULL THEN 'missing' ELSE 'present' END"),
			'concat-skips-null': q("first_name || COALESCE(' ' || middle_name, '')", simple)
		},
		purpose: 'Тестировщик проверяет поля карточки участника, которые собирает отчёт.'
	};
}

function negatedCondition(rng: Rng): Draft {
	const rows = ids(rng, rng.int(7, 10), 100, 999).map((id) => {
		const limit = rng.bool(0.2) ? null : rng.int(2, 10) * 100;
		const amount = rng.bool(0.25) ? null : rng.int(1, 12) * 100;
		return [id, amount, limit];
	});
	// The traps: a refund with no amount, a refund with no limit.
	const [a, b] = rows;
	if (a) a[1] = null;
	if (b) {
		b[1] = rng.int(1, 5) * 100;
		b[2] = null;
	}
	const setup = [
		'CREATE TABLE refunds (id INTEGER PRIMARY KEY, amount INTEGER, limit_amount INTEGER);',
		insertRows('refunds', ['id', 'amount', 'limit_amount'], rng.shuffle(rows))
	].join('\n');
	const q = (where: string): string => `SELECT id, amount, limit_amount FROM refunds WHERE ${where} ORDER BY id;`;
	return {
		setup,
		query: q('NOT (amount > limit_amount)'),
		wrong: { 'not-includes-null': q('NOT COALESCE(amount > limit_amount, 0)') },
		purpose:
			'Тестировщик ищет возвраты, которые не превышают лимит, — их можно провести без согласования. NULL в данных означает, что сумма или лимит ещё не заданы.'
	};
}

const DRAFTS: Record<string, (rng: Rng) => Draft> = {
	'intern/not-in-null': notInNull,
	'intern/count-column': countColumn,
	'intern/equals-null': equalsNull,
	'intern/avg-null': avgNull,
	'junior/coalesce-condition': coalesceCondition,
	'junior/left-join-sum': leftJoinSum,
	'junior/case-concat': caseConcat,
	'junior/negated-condition': negatedCondition
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
