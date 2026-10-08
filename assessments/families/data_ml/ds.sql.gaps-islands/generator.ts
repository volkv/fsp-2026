// Gaps and islands in SQL: series of consecutive days of activity (the day minus its row number), sessions split by a
// pause (LAG and a running SUM of new-session flags), runs of one status in a log (the difference of two row
// numbers), and the same series query over a log with repeated days, where the arithmetic breaks.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows } from '../../_lib/sql.ts';
import { addDays, buildFromDraft, type SqlDraft } from '../../_lib/sql-draft.ts';

const descriptor = readDescriptor(import.meta.url);

/** The answer lines are compared as text: the separator is fixed exactly. */
const ROW_SPACING =
	'Значения разделяются ровно так: пробел, черта, пробел — без лишних пробелов вокруг черты; пробелы внутри самих значений сохраняются как есть. Например, строка из трёх столбцов: `7 | NULL | 2.5`.';

type Row = (string | number | null)[];

function userIds(rng: Rng, n: number): number[] {
	let id = rng.int(1, 9) * 10;
	return Array.from({ length: n }, () => (id += rng.int(1, 6)));
}

/** Active days of a user: runs of consecutive days separated by gaps, from a day in spring 2026. */
function activeDays(rng: Rng): string[] {
	const start = addDays('2026-03-01', rng.int(0, 60));
	const days: string[] = [];
	let offset = 0;
	for (let run = rng.int(2, 3); run > 0; run -= 1) {
		for (let k = rng.int(1, 4); k > 0; k -= 1) days.push(addDays(start, offset++));
		offset += rng.int(1, 3);
	}
	return days;
}

/** Series of consecutive days: within a series the day minus its row number is constant. */
function streakQuery(source: string, partition: string): string {
	return [
		`WITH d AS (${source}),`,
		`g AS (SELECT user_id, day, julianday(day) - ROW_NUMBER() OVER (${partition}ORDER BY day) AS grp FROM d),`,
		's AS (SELECT user_id, MIN(day) AS start, COUNT(*) AS len FROM g GROUP BY user_id, grp)',
		'SELECT user_id, start, len FROM s ORDER BY user_id, start, len;'
	].join('\n');
}

/** Series of consecutive active days per user over deduplicated days. */
function streaks(rng: Rng): SqlDraft {
	const table = rng.pick(['activity', 'logins', 'app_opens']);
	const rows: Row[] = [];
	for (const user of userIds(rng, 2)) {
		for (const day of activeDays(rng)) {
			rows.push([user, day]);
			if (rng.bool(0.15)) rows.push([user, day]);
		}
	}
	const setup = `CREATE TABLE ${table} (user_id INTEGER NOT NULL, day TEXT NOT NULL);\n${insertRows(table, ['user_id', 'day'], rng.shuffle(rows))}`;
	const source = `SELECT DISTINCT user_id, day FROM ${table}`;
	return {
		setup,
		query: streakQuery(source, 'PARTITION BY user_id '),
		wrong: { 'no-partition': streakQuery(source, '') },
		purpose: 'Аналитик ищет серии дней подряд, в которые пользователь заходил в приложение.'
	};
}

/** Sessions by a pause: a gap of more than the limit starts a new session; the first event of a user starts one. */
function sessionsByGap(rng: Rng): SqlDraft {
	const table = rng.pick(['events', 'clicks', 'page_views']);
	const limit = rng.pick([20, 30, 45]);
	const rows: Row[] = [];
	userIds(rng, 2).forEach((user, u) => {
		let ts = rng.int(0, 200);
		const n = rng.int(4, 6);
		for (let k = 0; k < n; k += 1) {
			rows.push([user, ts]);
			// The trap: a gap of exactly the limit in the first user's log.
			const gap = u === 0 && k === 1 ? limit : rng.pick([rng.int(1, limit - 1), rng.int(limit + 1, limit * 4), limit]);
			ts += gap;
		}
	});
	const setup = `CREATE TABLE ${table} (user_id INTEGER NOT NULL, ts INTEGER NOT NULL);\n${insertRows(table, ['user_id', 'ts'], rng.shuffle(rows))}`;
	const q = (flag: string): string =>
		[
			`WITH e AS (`,
			`  SELECT user_id, ts, ${flag} AS new_session`,
			`  FROM ${table}`,
			`),`,
			`s AS (SELECT user_id, ts, SUM(new_session) OVER (PARTITION BY user_id ORDER BY ts) AS session FROM e)`,
			`SELECT user_id, session, COUNT(*), MAX(ts) - MIN(ts) FROM s`,
			`GROUP BY user_id, session ORDER BY user_id, session;`
		].join('\n');
	const lag = 'ts - LAG(ts) OVER (PARTITION BY user_id ORDER BY ts)';
	return {
		setup,
		query: q(`CASE WHEN ${lag} <= ${limit} THEN 0 ELSE 1 END`),
		wrong: {
			'gap-inclusive': q(`CASE WHEN ${lag} < ${limit} THEN 0 ELSE 1 END`),
			'first-row-zero': q(`CASE WHEN ${lag} > ${limit} THEN 1 ELSE 0 END`)
		},
		purpose: `Аналитик делит события пользователей на сессии: пауза больше ${limit} минут начинает новую сессию (ts — минуты).`
	};
}

/** Runs of one status in a machine log: ROW_NUMBER overall minus ROW_NUMBER within the status. */
function statusRuns(rng: Rng): SqlDraft {
	const table = rng.pick(['machine_log', 'service_status', 'health_checks']);
	const statuses = rng.sample(['up', 'down', 'degraded', 'idle'], 2);
	const rows: Row[] = [];
	let ts = rng.int(1, 50);
	let current = 0;
	for (let run = rng.int(4, 5); run > 0; run -= 1) {
		for (let k = rng.int(1, 3); k > 0; k -= 1) rows.push([(ts += rng.int(1, 9)), statuses[current] ?? 'up']);
		current = 1 - current;
	}
	const setup = `CREATE TABLE ${table} (ts INTEGER PRIMARY KEY, status TEXT NOT NULL);\n${insertRows(table, ['ts', 'status'], rng.shuffle(rows))}`;
	const r = `WITH r AS (\n  SELECT ts, status,\n         ROW_NUMBER() OVER (ORDER BY ts) - ROW_NUMBER() OVER (PARTITION BY status ORDER BY ts) AS grp\n  FROM ${table}\n)\n`;
	return {
		setup,
		query: `${r}SELECT status, MIN(ts), MAX(ts), COUNT(*) FROM r\nGROUP BY status, grp ORDER BY MIN(ts);`,
		wrong: {
			'group-by-status': `${r}SELECT status, MIN(ts), MAX(ts), COUNT(*) FROM r\nGROUP BY status ORDER BY MIN(ts);`
		},
		purpose: 'Инженер данных ищет непрерывные периоды одного состояния сервиса.'
	};
}

/** The series query without DISTINCT over a log with repeated days: a repeat shifts the row numbers and splits a series. */
function duplicateDays(rng: Rng): SqlDraft {
	const table = rng.pick(['activity', 'logins', 'app_opens']);
	const rows: Row[] = [];
	userIds(rng, 2).forEach((user, u) => {
		activeDays(rng).forEach((day, k) => {
			rows.push([user, day]);
			// The trap: the first user repeats the second day of activity; others repeat now and then.
			if ((u === 0 && k === 1) || rng.bool(0.2)) rows.push([user, day]);
		});
	});
	const setup = `CREATE TABLE ${table} (user_id INTEGER NOT NULL, day TEXT NOT NULL);\n${insertRows(table, ['user_id', 'day'], rng.shuffle(rows))}`;
	return {
		setup,
		query: streakQuery(`SELECT user_id, day FROM ${table}`, 'PARTITION BY user_id '),
		wrong: {
			'ideal-streaks': streakQuery(`SELECT DISTINCT user_id, day FROM ${table}`, 'PARTITION BY user_id ')
		},
		purpose:
			'Аналитик ищет серии дней подряд, в которые пользователь заходил в приложение; в журнале бывает несколько записей за день.'
	};
}

const DRAFTS: Record<string, (rng: Rng) => SqlDraft> = {
	'senior/streaks': streaks,
	'senior/sessions-by-gap': sessionsByGap,
	'senior/status-runs': statusRuns,
	'senior/duplicate-days': duplicateDays
};

export function build(input: GenerateInput): Built {
	const draft = DRAFTS[`${input.grade}/${input.classId}`];
	if (!draft) throw new Error(`${descriptor.key}: no draft for ${input.grade}/${input.classId}`);
	const built = buildFromDraft(descriptor, input, draft);
	const { statement } = built.instance;
	return {
		...built,
		instance: { ...built.instance, statement: { ...statement, markdown: `${statement.markdown} ${ROW_SPACING}` } }
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
