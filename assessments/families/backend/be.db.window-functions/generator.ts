// Window functions: ranks with ties, running totals, LAG and LEAD, and the frame a window really covers — the default
// RANGE frame with peers, ROWS against RANGE with an offset, partitions as frame boundaries.
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
	/** The rows a misconception gives, by its id; a misconception absent here does not apply to the class. */
	wrong: Record<string, string[]>;
}

const DEPTS = ['sales', 'ops', 'dev', 'support', 'finance', 'qa'] as const;

function accounts(rng: Rng, n: number): string[] {
	const base = rng.int(10, 89);
	return Array.from({ length: n }, (_, i) => `acc-${base + i * rng.int(1, 5)}`);
}

/** Rows `(acc, day, amount)` with days distinct within an account; ids follow the insertion order. */
function ledger(rng: Rng, accs: readonly string[], perAcc: [number, number], days: number): (string | number)[][] {
	const rows: (string | number)[][] = [];
	for (const acc of accs) {
		const own = rng.sample(
			Array.from({ length: days }, (_, i) => i + 1),
			rng.int(perAcc[0], perAcc[1])
		);
		for (const day of own) rows.push([acc, day, rng.int(1, 30) * 10]);
	}
	return rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
}

function ledgerSetup(table: string, rows: (string | number)[][]): string {
	return `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, acc TEXT NOT NULL, day INTEGER NOT NULL, amount INTEGER NOT NULL);\n${insertRows(table, ['id', 'acc', 'day', 'amount'], rows)}`;
}

function rankTies(rng: Rng): Draft {
	const table = rng.pick(['scores', 'reviews', 'results']);
	const depts = rng.sample(DEPTS, rng.int(2, 3));
	const names = rng.sample(PERSON_NAMES, depts.length * 4);
	const rows: (string | number)[][] = [];
	let n = 0;
	depts.forEach((dept, d) => {
		const top = rng.int(80, 99);
		// The traps: the first department has a tie at the top, the others ties somewhere in the first three.
		const scores = d === 0 ? [top, top, top - rng.int(1, 5)] : [top, top - rng.int(1, 4), top - rng.int(1, 4)];
		for (let k = rng.int(0, 1); k > 0; k -= 1) scores.push(top - rng.int(5, 15));
		for (const score of scores) rows.push([names[n++] ?? 'x', dept, score]);
	});
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept TEXT NOT NULL, score INTEGER NOT NULL);\n${insertRows(table, ['id', 'name', 'dept', 'score'], ids)}`;
	const w = 'OVER (PARTITION BY dept ORDER BY score DESC)';
	const q = (rk: string, dr: string): string =>
		`SELECT dept, name, score, rk, dr FROM (SELECT dept, name, score, ${rk} ${w} AS rk, ${dr} ${w} AS dr FROM ${table}) WHERE dr <= 2 ORDER BY dept, dr, name;`;
	return {
		setup,
		query: q('RANK()', 'DENSE_RANK()'),
		wrong: {
			'rank-no-gaps': runSql(setup, q('DENSE_RANK()', 'DENSE_RANK()')),
			'dense-gaps': runSql(setup, q('RANK()', 'RANK()'))
		}
	};
}

function runningTotal(rng: Rng): Draft {
	const table = rng.pick(['payments', 'deposits', 'charges']);
	const rows = ledger(rng, accounts(rng, rng.int(2, 3)), [3, 4], 28);
	const setup = ledgerSetup(table, rows);
	const q = (running: string, total: string): string =>
		`SELECT acc, day, amount, SUM(amount) OVER (${running}) AS running, SUM(amount) OVER (${total}) AS total FROM ${table} ORDER BY acc, day;`;
	const running = 'PARTITION BY acc ORDER BY day';
	return {
		setup,
		query: q(running, 'PARTITION BY acc'),
		wrong: {
			'no-order-running': runSql(setup, q(running, running)),
			'ignores-partition': runSql(setup, q('ORDER BY acc, day', 'PARTITION BY acc'))
		}
	};
}

function lagLead(rng: Rng): Draft {
	const table = rng.pick(['payments', 'deposits', 'readings']);
	const rows = ledger(rng, accounts(rng, rng.int(2, 3)), [3, 4], 28);
	const setup = ledgerSetup(table, rows);
	const q = (lag: string, lead: string, w: string): string =>
		`SELECT acc, day, amount, ${lag}(amount) OVER w AS prev, amount - ${lag}(amount, 1, 0) OVER w AS delta, ${lead}(day) OVER w AS next_day FROM ${table} WINDOW w AS (${w}) ORDER BY acc, day;`;
	const w = 'PARTITION BY acc ORDER BY day';
	return {
		setup,
		query: q('LAG', 'LEAD', w),
		wrong: {
			'lag-lead-swapped': runSql(setup, q('LEAD', 'LAG', w)),
			'ignores-partition': runSql(setup, q('LAG', 'LEAD', 'ORDER BY acc, day'))
		}
	};
}

function rangePeers(rng: Rng): Draft {
	const table = rng.pick(['payments', 'deposits', 'charges']);
	const accs = accounts(rng, 2);
	const rows: (string | number)[][] = [];
	// The traps: two or three payments on the same day within an account.
	for (const acc of accs) {
		const days = rng.sample([1, 2, 3, 4, 5, 6, 7, 8, 9], rng.int(2, 3)).sort((a, b) => a - b);
		const busy = rng.pick(days);
		for (const day of days) {
			const count = day === busy ? rng.int(2, 3) : rng.int(1, 2);
			for (let k = 0; k < count; k += 1) rows.push([acc, day, rng.int(1, 30) * 10]);
		}
	}
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	const setup = ledgerSetup(table, ids);
	const byRows = (dir: string): string =>
		`PARTITION BY acc ORDER BY day${dir}, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`;
	const q = (up: string, down: string): string =>
		`SELECT acc, day, id, amount, SUM(amount) OVER (${up}) AS so_far, COUNT(*) OVER (${up}) AS n, SUM(amount) OVER (${down}) AS from_end FROM ${table} ORDER BY acc, day, id;`;
	return {
		setup,
		query: q('PARTITION BY acc ORDER BY day', 'PARTITION BY acc ORDER BY day DESC'),
		wrong: {
			'frame-is-rows': runSql(setup, q(byRows(''), byRows(' DESC'))),
			'frame-whole-partition': runSql(setup, q('PARTITION BY acc', 'PARTITION BY acc'))
		}
	};
}

function rangeOffset(rng: Rng): Draft {
	const table = rng.pick(['payments', 'deposits', 'readings']);
	const span = rng.int(2, 3);
	const rows = ledger(rng, accounts(rng, 2), [4, 6], 14);
	const setup = ledgerSetup(table, rows);
	const q = (range: string, rows3: string): string =>
		`SELECT acc, day, amount, SUM(amount) OVER (${range}) AS last_days, COUNT(*) OVER (${rows3}) AS around FROM ${table} ORDER BY acc, day;`;
	const range = `PARTITION BY acc ORDER BY day RANGE BETWEEN ${span} PRECEDING AND CURRENT ROW`;
	const around = 'PARTITION BY acc ORDER BY day ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING';
	return {
		setup,
		query: q(range, around),
		wrong: {
			'range-as-rows': runSql(
				setup,
				q(`PARTITION BY acc ORDER BY day ROWS BETWEEN ${span} PRECEDING AND CURRENT ROW`, around)
			),
			'ignores-partition': runSql(
				setup,
				q(
					`ORDER BY day RANGE BETWEEN ${span} PRECEDING AND CURRENT ROW`,
					'ORDER BY acc, day ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING'
				)
			)
		}
	};
}

function frameValues(rng: Rng): Draft {
	const table = rng.pick(['salaries', 'staff', 'payroll']);
	const depts = rng.sample(DEPTS, 2);
	const names = rng.sample(PERSON_NAMES, 10);
	const rows: (string | number)[][] = [];
	let n = 0;
	// The traps: equal salaries inside a department, so the default frame takes peers in.
	for (const dept of depts) {
		const tied = rng.int(10, 30) * 10;
		const salaries = [tied, tied, ...Array.from({ length: rng.int(1, 3) }, () => rng.int(10, 30) * 10)];
		for (const salary of rng.shuffle(salaries)) rows.push([names[n++] ?? 'x', dept, salary]);
	}
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, dept TEXT NOT NULL, salary INTEGER NOT NULL);\n${insertRows(table, ['id', 'name', 'dept', 'salary'], ids)}`;
	const ordered = 'PARTITION BY dept ORDER BY salary DESC, name';
	const q = (nth: string, sum: string): string =>
		`SELECT dept, name, salary, NTH_VALUE(name, 2) OVER (${nth}) AS second, LAST_VALUE(name) OVER (${ordered} ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS lowest, SUM(salary) OVER (${sum}) AS paid_so_far FROM ${table} ORDER BY dept, salary DESC, name;`;
	return {
		setup,
		query: q(ordered, 'PARTITION BY dept ORDER BY salary DESC'),
		wrong: {
			'frame-whole-partition': runSql(
				setup,
				q(`${ordered} ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`, 'PARTITION BY dept')
			),
			'frame-is-rows': runSql(setup, q(ordered, `${ordered} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`))
		}
	};
}

function whereBeforeWindow(rng: Rng): Draft {
	const table = rng.pick(['payments', 'transfers', 'charges']);
	const accs = accounts(rng, rng.int(2, 3));
	const rows: (string | number)[][] = [];
	const status = rng.pick(['failed', 'declined', 'reversed']);
	// The trap: failed rows among the latest of each account, so numbering before or after WHERE differs.
	for (const acc of accs) {
		const days = rng.sample(
			Array.from({ length: 20 }, (_, i) => i + 1),
			rng.int(4, 6)
		);
		const latest = Math.max(...days);
		for (const day of days)
			rows.push([acc, day, rng.int(1, 30) * 10, day === latest || rng.bool(0.25) ? status : 'ok']);
	}
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, acc TEXT NOT NULL, day INTEGER NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL);\n${insertRows(table, ['id', 'acc', 'day', 'amount', 'status'], ids)}`;
	const k = 2;
	const rn = 'ROW_NUMBER() OVER (PARTITION BY acc ORDER BY day DESC) AS rn';
	return {
		setup,
		query: `SELECT acc, day, amount, rn FROM (SELECT acc, day, amount, ${rn} FROM ${table} WHERE status = 'ok') WHERE rn <= ${k} ORDER BY acc, rn;`,
		wrong: {
			'window-before-where': runSql(
				setup,
				`SELECT acc, day, amount, rn FROM (SELECT acc, day, amount, status, ${rn} FROM ${table}) WHERE status = 'ok' AND rn <= ${k} ORDER BY acc, rn;`
			)
		}
	};
}

function windowAfterGroup(rng: Rng): Draft {
	const table = rng.pick(['sales', 'orders', 'receipts']);
	const rows: (string | number)[][] = [];
	const days = rng.sample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], rng.int(5, 6)).sort((a, b) => a - b);
	const minCount = 2;
	// The trap: days with a single sale, which HAVING drops before the windows are computed.
	const lonely = rng.sample(days, 2);
	for (const day of days) {
		const n = lonely.includes(day) ? 1 : rng.int(2, 3);
		for (let j = 0; j < n; j += 1) rows.push([day, rng.int(1, 20) * 10]);
	}
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, day INTEGER NOT NULL, amount INTEGER NOT NULL);\n${insertRows(table, ['id', 'day', 'amount'], ids)}`;
	const windows = 'SUM(SUM(amount)) OVER (ORDER BY day) AS running, RANK() OVER (ORDER BY SUM(amount) DESC) AS place';
	return {
		setup,
		query: `SELECT day, COUNT(*), SUM(amount), ${windows} FROM ${table} GROUP BY day HAVING COUNT(*) >= ${minCount} ORDER BY day;`,
		wrong: {
			'window-before-having': runSql(
				setup,
				`SELECT * FROM (SELECT day, COUNT(*) AS n, SUM(amount), ${windows} FROM ${table} GROUP BY day) WHERE n >= ${minCount} ORDER BY day;`
			)
		}
	};
}

const DRAFTS: Record<string, (rng: Rng) => Draft> = {
	'middle/where-before-window': whereBeforeWindow,
	'senior/window-after-group': windowAfterGroup,
	'middle/rank-ties': rankTies,
	'middle/running-total': runningTotal,
	'middle/lag-lead': lagLead,
	'senior/range-peers': rangePeers,
	'senior/range-offset': rangeOffset,
	'senior/frame-values': frameValues
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
