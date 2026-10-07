// Window functions of an analyst: a running total by user, the difference with the previous row (LAG), the last
// record of an object (ROW_NUMBER), a moving average over the rows there are; at Middle the frame a window really
// covers — RANGE with peers by default, RANGE with an offset over gaps in days, ORDER BY turning a total into a running
// count, LAST_VALUE under the default frame.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows } from '../../_lib/sql.ts';
import { buildFromDraft, type SqlDraft } from '../../_lib/sql-draft.ts';

const descriptor = readDescriptor(import.meta.url);

type Row = (string | number | null)[];

/** User ids that are not 1, 2, 3, so a column of ids is not read as a row number. */
function userIds(rng: Rng, n: number): number[] {
	let id = rng.int(1, 8) * 10;
	return Array.from({ length: n }, () => (id += rng.int(1, 4)));
}

/** Rows `(user, day, amount)` with days distinct within a user (and, if `globalDays`, across all rows). */
function ledger(rng: Rng, users: readonly number[], perUser: [number, number], globalDays = false): Row[] {
	const rows: Row[] = [];
	const pool = rng.shuffle(Array.from({ length: 30 }, (_, i) => i + 1));
	let next = 0;
	for (const user of users) {
		const count = rng.int(perUser[0], perUser[1]);
		const days = globalDays
			? pool.slice(next, (next += count))
			: rng.sample(
					Array.from({ length: 30 }, (_, i) => i + 1),
					count
				);
		for (const day of days) rows.push([user, day, rng.int(1, 30) * 10]);
	}
	return rows;
}

function ledgerSetup(rng: Rng, table: string, rows: Row[], column = 'amount'): string {
	const ordered = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	return `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, day INTEGER NOT NULL, ${column} INTEGER NOT NULL);\n${insertRows(table, ['id', 'user_id', 'day', column], ordered)}`;
}

/** A running total within each user. */
function runningSum(rng: Rng): SqlDraft {
	const table = rng.pick(['payments', 'deposits', 'top_ups']);
	const rows = ledger(rng, userIds(rng, 2), [3, 4], true);
	const q = (over: string): string =>
		`SELECT user_id, day, amount, SUM(amount) OVER (${over}) AS running\nFROM ${table} ORDER BY user_id, day;`;
	return {
		setup: ledgerSetup(rng, table, rows),
		query: q('PARTITION BY user_id ORDER BY day'),
		wrong: { 'no-partition': q('ORDER BY day') },
		purpose: 'Аналитик считает накопленную сумму пополнений каждого пользователя по дням.'
	};
}

/** The change since the previous record of a user: LAG of the first row is NULL, so the difference is NULL. */
function lagDiff(rng: Rng): SqlDraft {
	const table = rng.pick(['weights', 'balances', 'scores']);
	const rows = ledger(rng, userIds(rng, 2), [3, 4], true);
	const q = (lag: string): string =>
		`SELECT user_id, day, value - ${lag} AS delta\nFROM ${table} ORDER BY user_id, day;`;
	return {
		setup: ledgerSetup(rng, table, rows, 'value'),
		query: q('LAG(value) OVER (PARTITION BY user_id ORDER BY day)'),
		wrong: {
			'lag-zero': q('LAG(value, 1, 0) OVER (PARTITION BY user_id ORDER BY day)'),
			'no-partition': q('LAG(value) OVER (ORDER BY day)')
		},
		purpose: 'Аналитик считает изменение показателя пользователя относительно его предыдущей записи.'
	};
}

/** The last status of each order: ROW_NUMBER over the moments in descending order. */
function lastRecord(rng: Rng): SqlDraft {
	const table = rng.pick(['order_status', 'status_log', 'transitions']);
	const statuses = ['created', 'paid', 'packed', 'shipped', 'delivered'];
	const orders = rng.int(3, 4);
	const rows: Row[] = [];
	let order = rng.int(1, 9) * 100;
	for (let k = 0; k < orders; k += 1) {
		order += rng.int(1, 9);
		const depth = rng.int(k === 0 ? 3 : 1, 5);
		let ts = rng.int(1, 50);
		for (const status of statuses.slice(0, depth)) {
			rows.push([order, (ts += rng.int(1, 30)), status]);
		}
	}
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL);\n${insertRows(
		table,
		['id', 'order_id', 'ts', 'status'],
		rng.shuffle(rows).map((r, i) => [i + 1, ...r])
	)}`;
	const q = (dir: string): string =>
		`SELECT order_id, ts, status FROM (\n  SELECT order_id, ts, status, ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY ts${dir}) AS rn\n  FROM ${table}\n) WHERE rn = 1 ORDER BY order_id;`;
	return {
		setup,
		query: q(' DESC'),
		wrong: { 'asc-order': q('') },
		purpose: 'Аналитик берёт текущий статус каждого заказа.'
	};
}

/** A moving average over the current and two previous rows: the first rows average what they have. */
function movingAvg(rng: Rng): SqlDraft {
	const table = rng.pick(['daily_metrics', 'dau', 'revenue_daily']);
	const start = rng.int(1, 20);
	const n = rng.int(5, 7);
	const rows: Row[] = Array.from({ length: n }, (_, i) => [start + i, rng.int(10, 99)]);
	const setup = `CREATE TABLE ${table} (day INTEGER PRIMARY KEY, value INTEGER NOT NULL);\n${insertRows(table, ['day', 'value'], rng.shuffle(rows))}`;
	const frame = 'OVER (ORDER BY day ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)';
	const right = `ROUND(AVG(value) ${frame}, 2)`;
	const q = (avg: string): string => `SELECT day, value, ${avg} AS ma3\nFROM ${table} ORDER BY day;`;
	return {
		setup,
		query: q(right),
		wrong: { 'full-window-only': q(`CASE WHEN COUNT(*) ${frame} < 3 THEN NULL ELSE ${right} END`) },
		purpose: 'Аналитик сглаживает дневной показатель скользящим средним по трём дням.'
	};
}

/** A running total with the default frame: rows of the same day are peers and enter together. */
function rangePeers(rng: Rng): SqlDraft {
	const table = rng.pick(['payments', 'deposits', 'top_ups']);
	const n = rng.int(6, 8);
	const days: number[] = [];
	for (let d = rng.int(1, 5); days.length < n; d += rng.int(1, 3)) {
		// The trap: several rows on the same day.
		for (let k = rng.bool(0.5) ? 2 : 1; k > 0 && days.length < n; k -= 1) days.push(d);
	}
	if (new Set(days).size === days.length) days[1] = days[0] ?? 1;
	const rows: Row[] = days.map((day) => [rng.int(1, 30) * 10, day]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, day INTEGER NOT NULL);\n${insertRows(
		table,
		['id', 'amount', 'day'],
		rows.map((r, i) => [i + 1, ...r])
	)}`;
	const q = (over: string): string =>
		`SELECT id, day, amount, SUM(amount) OVER (${over}) AS running\nFROM ${table} ORDER BY id;`;
	return {
		setup,
		query: q('ORDER BY day'),
		wrong: { 'rows-frame': q('ORDER BY day, id ROWS UNBOUNDED PRECEDING') },
		purpose: 'Аналитик считает накопленную выручку по дням.'
	};
}

/** RANGE with an offset covers days within the distance, whatever the number of rows; ROWS counts rows. */
function rangeOffset(rng: Rng): SqlDraft {
	const table = rng.pick(['daily_sales', 'orders_daily', 'signups_daily']);
	const span = rng.pick([2, 3]);
	const n = rng.int(6, 7);
	const days: number[] = [];
	// The trap: gaps between days, so the last `span` rows reach further back than `span` days.
	for (let d = rng.int(1, 5); days.length < n; d += rng.pick([1, 1, 2, 3, 4])) days.push(d);
	const rows: Row[] = days.map((day) => [day, rng.int(1, 40) * 5]);
	const setup = `CREATE TABLE ${table} (day INTEGER PRIMARY KEY, amount INTEGER NOT NULL);\n${insertRows(table, ['day', 'amount'], rng.shuffle(rows))}`;
	const q = (unit: string): string =>
		`SELECT day, amount, SUM(amount) OVER (ORDER BY day ${unit} BETWEEN ${span} PRECEDING AND CURRENT ROW) AS recent\nFROM ${table} ORDER BY day;`;
	return {
		setup,
		query: q('RANGE'),
		wrong: { 'rows-frame': q('ROWS') },
		purpose: `Аналитик считает сумму продаж за текущий день и ${span} предыдущих календарных дня (дни без продаж в таблице отсутствуют).`
	};
}

/** COUNT(*) over a partition is its size; with ORDER BY the frame ends at the current row (and its peers). */
function orderChangesFrame(rng: Rng): SqlDraft {
	const table = rng.pick(['sessions', 'logins', 'visits']);
	const rows = ledger(rng, userIds(rng, 2), [2, 4]);
	const setup = ledgerSetup(rng, table, rows, 'minutes');
	const q = (running: string): string =>
		`SELECT user_id, day,\n       COUNT(*) OVER (PARTITION BY user_id) AS total,\n       ${running} AS nth,\n       minutes - FIRST_VALUE(minutes) OVER (PARTITION BY user_id ORDER BY day) AS since_first\nFROM ${table} ORDER BY user_id, day;`;
	return {
		setup,
		query: q('COUNT(*) OVER (PARTITION BY user_id ORDER BY day)'),
		wrong: { 'order-ignored': q('COUNT(*) OVER (PARTITION BY user_id)') },
		purpose: 'Аналитик нумерует визиты пользователя и сравнивает длительность с первым визитом.'
	};
}

/** LAST_VALUE under the default frame (up to the current row) returns the current row's value. */
function lastValue(rng: Rng): SqlDraft {
	const table = rng.pick(['order_status', 'status_log', 'transitions']);
	const statuses = ['created', 'paid', 'packed', 'shipped'];
	const rows: Row[] = [];
	const base = rng.int(1, 9) * 100;
	for (let k = 0; k < 2; k += 1) {
		const order = base + k * rng.int(2, 9);
		let ts = rng.int(1, 50);
		for (const status of statuses.slice(0, rng.int(2, 4))) rows.push([order, (ts += rng.int(1, 30)), status]);
	}
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL);\n${insertRows(
		table,
		['id', 'order_id', 'ts', 'status'],
		rng.shuffle(rows).map((r, i) => [i + 1, ...r])
	)}`;
	const q = (frame: string): string =>
		`SELECT order_id, ts, status,\n       LAST_VALUE(status) OVER (PARTITION BY order_id ORDER BY ts${frame}) AS final_status\nFROM ${table} ORDER BY order_id, ts;`;
	return {
		setup,
		query: q(''),
		wrong: { 'last-of-partition': q(' ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING') },
		purpose: 'Аналитик хочет рядом с каждой записью видеть итоговый статус заказа.'
	};
}

const DRAFTS: Record<string, (rng: Rng) => SqlDraft> = {
	'junior/running-sum': runningSum,
	'junior/lag-diff': lagDiff,
	'junior/last-record': lastRecord,
	'junior/moving-avg': movingAvg,
	'middle/range-peers': rangePeers,
	'middle/range-offset': rangeOffset,
	'middle/order-changes-frame': orderChangesFrame,
	'middle/last-value': lastValue
};

export function build(input: GenerateInput): Built {
	const draft = DRAFTS[`${input.grade}/${input.classId}`];
	if (!draft) throw new Error(`${descriptor.key}: no draft for ${input.grade}/${input.classId}`);
	return buildFromDraft(descriptor, input, draft);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
