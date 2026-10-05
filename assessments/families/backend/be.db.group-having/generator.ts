// Grouping: rows WHERE drops before grouping against groups HAVING drops after it, aggregates over a join, conditional
// aggregates (CASE and FILTER) and grouping by an expression.
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

const DEPTS = ['sales', 'ops', 'dev', 'hr', 'qa', 'legal', 'support', 'finance'] as const;

/** A table of `id, <group>, amount[, status]` rows. */
function groupTable(
	name: string,
	group: string,
	rows: readonly (readonly (string | number)[])[],
	withStatus: boolean,
	rng: Rng
): string {
	const columns = withStatus ? ['id', group, 'status', 'amount'] : ['id', group, 'amount'];
	const ddl = `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, ${group} TEXT NOT NULL${withStatus ? ', status TEXT NOT NULL' : ''}, amount INTEGER NOT NULL);`;
	return `${ddl}\n${insertRows(
		name,
		columns,
		rng.shuffle(rows).map((r, i) => [i + 1, ...r])
	)}`;
}

function whereThenHaving(rng: Rng): Draft {
	const name = rng.pick(['expenses', 'sales', 'payouts']);
	const depts = rng.sample(DEPTS, 4);
	const floor = rng.int(3, 8) * 50;
	const k = rng.int(2, 3);
	const rows: (string | number)[][] = [];
	const small = (): number => rng.int(1, floor / 50 - 1) * 50;
	const big = (): number => floor + rng.int(0, 12) * 50;
	// The traps: a department with k rows of which fewer than k pass WHERE, one with k passing, one between.
	depts.forEach((dept, i) => {
		const passing = i === 0 ? k - 1 : i === 1 ? k + rng.int(0, 1) : rng.int(0, k + 1);
		const failing = i === 0 ? rng.int(1, 2) : rng.int(0, 2);
		for (let j = 0; j < passing; j += 1) rows.push([dept, big()]);
		for (let j = 0; j < failing; j += 1) rows.push([dept, small()]);
	});
	const setup = groupTable(name, 'dept', rows, false, rng);
	const head = `SELECT dept, COUNT(*), SUM(amount) FROM ${name} WHERE amount >= ${floor} GROUP BY dept`;
	return {
		setup,
		query: `${head} HAVING COUNT(*) >= ${k} ORDER BY dept;`,
		wrong: {
			'having-before-where': runSql(
				setup,
				`${head} HAVING (SELECT COUNT(*) FROM ${name} x WHERE x.dept = ${name}.dept) >= ${k} ORDER BY dept;`
			)
		}
	};
}

function havingJoin(rng: Rng): Draft {
	const names = rng.sample(PERSON_NAMES, rng.int(4, 5));
	const status = rng.pick(['paid', 'shipped', 'done']);
	const other = rng.pick(['cancelled', 'refunded', 'draft']);
	const threshold = rng.int(10, 20) * 100;
	const customers = names.map((name, i) => [i + 1, name, rng.pick(CITY_NAMES)]);
	const orders: (number | string)[][] = [];
	const add = (cid: number, st: string, total: number): void => {
		orders.push([0, cid, st, total]);
	};
	const part = (): number => rng.int(2, Math.floor(threshold / 100) - 2) * 100;
	// The traps: customer 1 crosses the threshold only with the excluded status, customer 2 only with several orders
	// none of which alone crosses it, customer 3 with one large order.
	add(1, status, part());
	add(1, other, threshold);
	const a = part();
	add(2, status, a);
	add(2, status, threshold - a + rng.int(1, 5) * 100);
	add(3, status, threshold + rng.int(1, 8) * 100);
	for (let cid = 3; cid <= names.length; cid += 1)
		for (let j = rng.int(0, 2); j > 0; j -= 1) add(cid, rng.pick([status, other]), part());
	const shuffled = rng.shuffle(orders).map((o, i) => [100 + i + 1, o[1] ?? 0, o[2] ?? '', o[3] ?? 0]);
	const setup = [
		'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL);',
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL);',
		insertRows('customers', ['id', 'name', 'city'], rng.shuffle(customers)),
		insertRows('orders', ['id', 'customer_id', 'status', 'total'], shuffled)
	].join('\n');
	const head = `SELECT c.name, COUNT(o.id), SUM(o.total) FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.status = ${sqlText(status)}`;
	const tail = 'ORDER BY c.name;';
	return {
		setup,
		query: `${head} GROUP BY c.id HAVING SUM(o.total) > ${threshold} ${tail}`,
		wrong: {
			'having-before-where': runSql(
				setup,
				`${head} GROUP BY c.id HAVING (SELECT SUM(total) FROM orders WHERE customer_id = c.id) > ${threshold} ${tail}`
			),
			'having-filters-rows': runSql(setup, `${head} AND o.total > ${threshold} GROUP BY c.id ${tail}`)
		}
	};
}

function havingAggregate(rng: Rng): Draft {
	const name = rng.pick(['salaries', 'bonuses', 'grants']);
	const depts = rng.sample(DEPTS, 4);
	const bar = rng.int(10, 30) * 100;
	const below = (): number => rng.int(3, bar / 100 - 1) * 100;
	const rows: (string | number)[][] = [];
	// The traps: a group with one row above the bar among lower ones, a group entirely below it.
	rows.push([depts[0] ?? '', bar + rng.int(0, 10) * 100], [depts[0] ?? '', below()], [depts[0] ?? '', below()]);
	rows.push([depts[1] ?? '', below()], [depts[1] ?? '', below()]);
	for (const dept of depts.slice(2)) {
		for (let j = rng.int(1, 3); j > 0; j -= 1) rows.push([dept, rng.bool(0.4) ? bar + rng.int(0, 10) * 100 : below()]);
	}
	const setup = groupTable(name, 'dept', rows, false, rng);
	const cols = `SELECT dept, COUNT(*), MIN(amount) FROM ${name}`;
	return {
		setup,
		query: `${cols} GROUP BY dept HAVING MAX(amount) >= ${bar} ORDER BY dept;`,
		wrong: {
			'having-filters-rows': runSql(setup, `${cols} WHERE amount >= ${bar} GROUP BY dept ORDER BY dept;`)
		}
	};
}

function caseAggregates(rng: Rng): Draft {
	const name = rng.pick(['payments', 'transactions', 'charges']);
	const regions = rng.sample(CITY_NAMES, 4);
	const rows: (string | number)[][] = [];
	const amount = (): number => rng.int(1, 40) * 25;
	// The traps: a region without refunds, a region with refunds only, mixed regions.
	regions.forEach((region, i) => {
		const paid = i === 1 ? 0 : rng.int(1, 3);
		const refunds = i === 0 ? 0 : rng.int(1, 2);
		for (let j = 0; j < paid; j += 1) rows.push([region, 'paid', amount()]);
		for (let j = 0; j < refunds; j += 1) rows.push([region, 'refund', amount()]);
		for (let j = rng.int(0, 1); j > 0; j -= 1) rows.push([region, 'pending', amount()]);
	});
	const setup = groupTable(name, 'region', rows, true, rng);
	const paid = "SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END)";
	const refunds = "SUM(CASE WHEN status = 'refund' THEN amount END)";
	const refundCount = "COUNT(CASE WHEN status = 'refund' THEN 1 ELSE 0 END)";
	const q = (count: string, sum: string): string =>
		`SELECT region, ${count}, ${paid}, ${sum} FROM ${name} GROUP BY region ORDER BY region;`;
	return {
		setup,
		query: q(refundCount, refunds),
		wrong: {
			'count-else-zero': runSql(setup, q("SUM(CASE WHEN status = 'refund' THEN 1 ELSE 0 END)", refunds)),
			'empty-sum-zero': runSql(setup, q(refundCount, `COALESCE(${refunds}, 0)`))
		}
	};
}

function filterClause(rng: Rng): Draft {
	const name = rng.pick(['deliveries', 'shipments', 'tickets']);
	const regions = rng.sample(CITY_NAMES, 4);
	const late = rng.pick(['late', 'lost', 'damaged']);
	const floor = rng.int(2, 6) * 10;
	const rows: (string | number)[][] = [];
	const heavy = (): number => floor + rng.int(1, 20) * 5;
	// The traps: a region whose late rows are all filtered by WHERE, a region without late rows, mixed regions.
	regions.forEach((region, i) => {
		const onTime = rng.int(1, 3);
		const lateHeavy = i < 2 ? 0 : rng.int(1, 2);
		const lateLight = i === 0 ? rng.int(1, 2) : rng.int(0, 1);
		for (let j = 0; j < onTime; j += 1) rows.push([region, 'ok', heavy()]);
		for (let j = 0; j < lateHeavy; j += 1) rows.push([region, late, heavy()]);
		for (let j = 0; j < lateLight; j += 1) rows.push([region, late, rng.int(1, floor / 5 - 1) * 5]);
	});
	const setup = groupTable(name, 'region', rows, true, rng);
	const cond = `status = ${sqlText(late)}`;
	return {
		setup,
		query: `SELECT region, COUNT(*), COUNT(*) FILTER (WHERE ${cond}), SUM(amount) FILTER (WHERE ${cond}) FROM ${name} WHERE amount > ${floor} GROUP BY region ORDER BY region;`,
		wrong: {
			'filter-as-where': runSql(
				setup,
				`SELECT region, COUNT(*), COUNT(*), SUM(amount) FROM ${name} WHERE amount > ${floor} AND ${cond} GROUP BY region ORDER BY region;`
			),
			'empty-sum-zero': runSql(
				setup,
				`SELECT region, COUNT(*), COUNT(*) FILTER (WHERE ${cond}), COALESCE(SUM(amount) FILTER (WHERE ${cond}), 0) FROM ${name} WHERE amount > ${floor} GROUP BY region ORDER BY region;`
			)
		}
	};
}

function groupExpression(rng: Rng): Draft {
	const name = rng.pick(['orders', 'purchases', 'baskets']);
	const bulkQty = rng.int(5, 12);
	const largeAmount = rng.int(8, 20) * 100;
	const rows: (number | string)[][] = [];
	const add = (qty: number, amount: number): void => {
		rows.push([qty, amount]);
	};
	const smallQty = (): number => rng.int(1, bulkQty - 1);
	const smallAmount = (): number => rng.int(1, largeAmount / 100 - 1) * 100;
	const bigAmount = (): number => largeAmount + rng.int(0, 10) * 100;
	// The traps: rows that match both branches, rows of each single branch, rows of none.
	for (let j = rng.int(1, 3); j > 0; j -= 1) add(bulkQty + rng.int(0, 5), bigAmount());
	for (let j = rng.int(1, 3); j > 0; j -= 1) add(bulkQty + rng.int(0, 5), smallAmount());
	for (let j = rng.int(1, 3); j > 0; j -= 1) add(smallQty(), bigAmount());
	for (let j = rng.int(2, 4); j > 0; j -= 1) add(smallQty(), smallAmount());
	const minSum = rng.int(2, 6) * 500;
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, r[0] ?? 0, r[1] ?? 0]);
	const setup = `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, qty INTEGER NOT NULL, amount INTEGER NOT NULL);\n${insertRows(name, ['id', 'qty', 'amount'], ids)}`;
	const bulk = `WHEN qty >= ${bulkQty} THEN 'bulk'`;
	const large = `WHEN amount >= ${largeAmount} THEN 'large'`;
	const q = (band: string, where: string, having: string): string =>
		`SELECT CASE ${band} ELSE 'regular' END AS band, COUNT(*), SUM(amount) FROM ${name}${where} GROUP BY band${having} ORDER BY band;`;
	const having = ` HAVING SUM(amount) >= ${minSum}`;
	return {
		setup,
		query: q(`${bulk} ${large}`, '', having),
		wrong: {
			'case-last-match': runSql(setup, q(`${large} ${bulk}`, '', having)),
			'having-filters-rows': runSql(setup, q(`${bulk} ${large}`, ` WHERE amount >= ${minSum}`, ''))
		}
	};
}

function countDistinct(rng: Rng): Draft {
	const name = rng.pick(['timesheets', 'worklogs', 'assignments']);
	const depts = rng.sample(DEPTS, 4);
	const projects = rng.sample(['atlas', 'borealis', 'cobalt', 'delta', 'ember', 'falcon'], 4);
	const k = rng.int(2, 3);
	const rows: (string | number)[][] = [];
	const hours = (): number => rng.int(1, 8);
	// The traps: a department with many rows on fewer than k projects, one with exactly k projects.
	const first = rng.sample(projects, k - 1);
	for (let j = 0; j < k + 1; j += 1) rows.push([depts[0] ?? '', first[j % first.length] ?? '', hours()]);
	for (const project of rng.sample(projects, k)) rows.push([depts[1] ?? '', project, hours()]);
	for (const dept of depts.slice(2))
		for (let j = rng.int(1, 4); j > 0; j -= 1) rows.push([dept, rng.pick(projects), hours()]);
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	const setup = `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, dept TEXT NOT NULL, project TEXT NOT NULL, hours INTEGER NOT NULL);\n${insertRows(name, ['id', 'dept', 'project', 'hours'], ids)}`;
	const q = (count: string): string =>
		`SELECT dept, COUNT(*), ${count}, SUM(hours) FROM ${name} GROUP BY dept HAVING ${count} >= ${k} ORDER BY dept;`;
	return {
		setup,
		query: q('COUNT(DISTINCT project)'),
		wrong: { 'count-distinct-ignored': runSql(setup, q('COUNT(project)')) }
	};
}

function integerDivision(rng: Rng): Draft {
	const name = rng.pick(['orders', 'invoices', 'receipts']);
	const regions = rng.sample(CITY_NAMES, 4);
	const bar = rng.int(20, 60) * 10;
	const rows: (string | number)[][] = [];
	// The traps: a region whose average lies strictly between bar and bar + 1 (integer division gives bar),
	// a region far above, one below.
	const n0 = rng.int(2, 4);
	for (let j = 0; j < n0 - 1; j += 1) rows.push([regions[0] ?? '', bar]);
	rows.push([regions[0] ?? '', bar + rng.int(1, n0 - 1)]);
	for (let j = rng.int(2, 3); j > 0; j -= 1) rows.push([regions[1] ?? '', bar + rng.int(2, 20) * 10]);
	for (let j = rng.int(2, 3); j > 0; j -= 1) rows.push([regions[2] ?? '', bar - rng.int(1, 10) * 10]);
	for (let j = rng.int(1, 3); j > 0; j -= 1) rows.push([regions[3] ?? '', bar + rng.int(-10, 10) * 10 + rng.int(0, 3)]);
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	const setup = `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, region TEXT NOT NULL, amount INTEGER NOT NULL);\n${insertRows(name, ['id', 'region', 'amount'], ids)}`;
	const q = (avg: string): string =>
		`SELECT region, COUNT(*), SUM(amount), ${avg} AS mean FROM ${name} GROUP BY region HAVING ${avg} > ${bar} ORDER BY mean DESC, region;`;
	return {
		setup,
		query: q('SUM(amount) / COUNT(*)'),
		wrong: { 'real-division': runSql(setup, q('ROUND(SUM(amount) * 1.0 / COUNT(*), 2)')) }
	};
}

const DRAFTS: Record<string, (rng: Rng) => Draft> = {
	'junior/count-distinct': countDistinct,
	'middle/integer-division': integerDivision,
	'junior/where-then-having': whereThenHaving,
	'junior/having-join': havingJoin,
	'junior/having-aggregate': havingAggregate,
	'middle/case-aggregates': caseAggregates,
	'middle/filter-clause': filterClause,
	'middle/group-expression': groupExpression
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
