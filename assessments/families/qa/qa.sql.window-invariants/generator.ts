// Invariants a tester checks with window functions: gaps in numbering (LAG), overlapping bookings, a negative running
// balance and the last status of each object (ROW_NUMBER); the result of the shown check on a generated table, where
// partitions, the first row, touching intervals, the default frame and the place of the filter decide the answer.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
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

type Row = (string | number | null)[];

const ids = (rng: Rng, n: number, lo: number, hi: number): number[] =>
	rng.sample(
		Array.from({ length: hi - lo + 1 }, (_, i) => lo + i),
		n
	);

const accounts = (rng: Rng, n: number): string[] => {
	const base = rng.int(10, 80);
	return Array.from({ length: n }, (_, i) => `acc-${base + i * rng.int(1, 6)}`);
};

function numberingGaps(rng: Rng): Draft {
	const accs = accounts(rng, rng.int(2, 3));
	const rows: Row[] = [];
	for (const acc of accs) {
		// Mostly consecutive numbers; a skipped number, a repeated one, a start other than 1.
		let seq = rng.bool(0.4) ? rng.int(2, 3) : 1;
		for (let i = rng.int(3, 4); i > 0; i -= 1) {
			rows.push([acc, seq]);
			const roll = rng.int(0, 9);
			seq += roll === 0 ? 0 : roll <= 2 ? rng.int(2, 3) : 1;
		}
	}
	const rowIds = ids(rng, rows.length, 1, 99);
	const setup = [
		'CREATE TABLE ledger (id INTEGER PRIMARY KEY, account TEXT NOT NULL, seq INTEGER NOT NULL);',
		insertRows(
			'ledger',
			['id', 'account', 'seq'],
			rng.shuffle(rows).map((r, i) => [rowIds[i] ?? 0, ...r])
		)
	].join('\n');
	const q = (partition: string, prev: string): string =>
		`SELECT account, seq, prev FROM (SELECT account, seq, ${prev} AS prev FROM (SELECT account, seq, LAG(seq) OVER (${partition}ORDER BY seq) AS lagged FROM ledger)) WHERE seq - prev <> 1 ORDER BY account, seq;`;
	return {
		setup,
		query: q('PARTITION BY account ', 'lagged'),
		wrong: {
			'lag-no-partition': q('', 'lagged'),
			'first-row-included': q('PARTITION BY account ', 'COALESCE(lagged, 0)')
		},
		purpose:
			'Номера операций `seq` по каждому счёту должны идти подряд с 1. Тестировщик ищет нарушения: строки, номер которых не на 1 больше предыдущего номера того же счёта.'
	};
}

function overlappingBookings(rng: Rng): Draft {
	const rooms = rng.sample(['A1', 'A2', 'B1', 'B2', 'C1'], 2);
	const rows: Row[] = [];
	for (const room of rooms) {
		let t = rng.int(8, 10);
		for (let i = rng.int(3, 5); i > 0; i -= 1) {
			const length = rng.int(1, 3);
			rows.push([room, t, t + length]);
			const roll = rng.int(0, 5);
			// Touching, overlapping, or with a pause before the next booking.
			t = roll <= 1 ? t + length : roll === 2 ? t + length - 1 : t + length + rng.int(1, 2);
		}
		// A long booking that covers more than the next one.
		if (rng.bool(0.7)) {
			const start = rng.int(8, 12);
			rows.push([room, start, start + rng.int(4, 6)]);
		}
	}
	const rowIds = ids(rng, rows.length, 100, 999);
	const setup = [
		'CREATE TABLE bookings (id INTEGER PRIMARY KEY, room TEXT NOT NULL, start_h INTEGER NOT NULL, end_h INTEGER NOT NULL);',
		insertRows(
			'bookings',
			['id', 'room', 'start_h', 'end_h'],
			rng.shuffle(rows).map((r, i) => [rowIds[i] ?? 0, ...r])
		)
	].join('\n');
	const q = (prev: string, cmp: string): string =>
		`SELECT room, id, prev_end, start_h FROM (SELECT room, id, start_h, ${prev} AS prev_end FROM bookings) WHERE prev_end ${cmp} start_h ORDER BY room, start_h, id;`;
	const lag = 'LAG(end_h) OVER (PARTITION BY room ORDER BY start_h, id)';
	return {
		setup,
		query: q(lag, '>'),
		wrong: {
			'touching-overlap': q(lag, '>='),
			'lag-sees-all': q(
				'MAX(end_h) OVER (PARTITION BY room ORDER BY start_h, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)',
				'>'
			)
		},
		purpose:
			'Брони одной комнаты не должны пересекаться; бронь занимает часы от `start_h` до `end_h`, и следующая может начаться в час окончания предыдущей. Тестировщик проверяет это запросом.'
	};
}

function runningBalance(rng: Rng): Draft {
	const accs = accounts(rng, 2);
	const rows: Row[] = [];
	for (const acc of accs) {
		// Days repeat: a withdrawal and a deposit on the same day.
		const days = rng.int(3, 4);
		for (let day = 1; day <= days; day += 1) {
			for (let m = rng.int(1, 2); m > 0; m -= 1)
				rows.push([acc, day, rng.bool(0.5) ? -rng.int(1, 8) * 100 : rng.int(1, 8) * 100]);
		}
	}
	const rowIds = ids(rng, rows.length, 1, 99);
	// Within an account and a day, ids follow the order of the moves.
	const ordered = [...rowIds].sort((a, b) => a - b);
	const numbered = rows.map((r, i) => ({ r, id: ordered[i] ?? 0 }));
	const setup = [
		'CREATE TABLE moves (id INTEGER PRIMARY KEY, acc TEXT NOT NULL, day INTEGER NOT NULL, amount INTEGER NOT NULL);',
		insertRows(
			'moves',
			['id', 'acc', 'day', 'amount'],
			rng.shuffle(numbered).map(({ r, id }) => [id, ...r])
		)
	].join('\n');
	const q = (over: string): string =>
		`SELECT acc, id, day, balance FROM (SELECT acc, id, day, SUM(amount) OVER (${over}) AS balance FROM moves) WHERE balance < 0 ORDER BY acc, id;`;
	return {
		setup,
		query: q('PARTITION BY acc ORDER BY day'),
		wrong: { 'rows-frame': q('PARTITION BY acc ORDER BY day, id ROWS UNBOUNDED PRECEDING') },
		purpose:
			'Остаток счёта не должен уходить в минус. Тестировщик считает нарастающий итог по дням и ищет строки с отрицательным остатком.'
	};
}

function lastStatus(rng: Rng): Draft {
	const objects = ids(rng, rng.int(3, 5), 100, 999);
	const rows: Row[] = [];
	for (const obj of objects) {
		const times = ids(rng, rng.int(2, 3), 1, 50).sort((a, b) => a - b);
		for (const ts of times) rows.push([obj, ts, rng.pick(['created', 'failed', 'done', 'failed', 'retry'])]);
	}
	const rowIds = ids(rng, rows.length, 1, 99);
	const setup = [
		'CREATE TABLE events (id INTEGER PRIMARY KEY, obj INTEGER NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL);',
		insertRows(
			'events',
			['id', 'obj', 'ts', 'status'],
			rng.shuffle(rows).map((r, i) => [rowIds[i] ?? 0, ...r])
		)
	].join('\n');
	const q = (order: string, inner: string, outer: string): string =>
		`SELECT obj, ts, status FROM (SELECT obj, ts, status, ROW_NUMBER() OVER (PARTITION BY obj ORDER BY ts ${order}) AS rn FROM events${inner}) WHERE rn = 1${outer} ORDER BY obj;`;
	return {
		setup,
		query: q('DESC', '', " AND status = 'failed'"),
		wrong: {
			'filter-before-rank': q('DESC', " WHERE status = 'failed'", ''),
			'first-not-last': q('ASC', '', " AND status = 'failed'")
		},
		purpose: 'Тестировщик ищет объекты, последнее событие которых — сбой (`failed`).'
	};
}

const DRAFTS: Record<string, (rng: Rng) => Draft> = {
	'middle/numbering-gaps': numberingGaps,
	'middle/overlapping-bookings': overlappingBookings,
	'middle/running-balance': runningBalance,
	'middle/last-status': lastStatus
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
