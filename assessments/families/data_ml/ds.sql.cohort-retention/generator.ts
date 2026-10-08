// Cohort retention in SQL with SQLite's date functions: the size of a cohort with users who never came back, retention
// on day N and from day N on, user-days against users; at Middle the calendar offset of months across a year, the
// share with integer division, a cohort by the first purchase and a cohort by the week of the signup.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows } from '../../_lib/sql.ts';
import { addDays, buildFromDraft, type SqlDraft } from '../../_lib/sql-draft.ts';

const descriptor = readDescriptor(import.meta.url);

/** The answer lines are compared as text: the separator is fixed exactly. */
const ROW_SPACING =
	'Значения разделяются ровно так: пробел, черта, пробел — без лишних пробелов вокруг черты; пробелы внутри самих значений сохраняются как есть. Например, строка из трёх столбцов: `7 | NULL | 2.5`.';

type Row = (string | number | null)[];

interface Data {
	users: Row[];
	activity: Row[];
}

function setupOf(rng: Rng, data: Data, activityTable: string, column = 'signup'): string {
	return [
		`CREATE TABLE users (id INTEGER PRIMARY KEY, ${column} TEXT NOT NULL);`,
		`CREATE TABLE ${activityTable} (user_id INTEGER NOT NULL, day TEXT NOT NULL);`,
		insertRows('users', ['id', column], rng.shuffle(data.users)),
		insertRows(activityTable, ['user_id', 'day'], rng.shuffle(data.activity))
	].join('\n');
}

/**
 * Users in monthly cohorts; a user is active on the signup day and then on some days after it. `shape` gives the
 * offsets of a user's later days; the first user of a cohort never comes back, and with `silentFirst` has no activity
 * at all (signed up on the site, never opened the app).
 */
function cohorts(
	rng: Rng,
	months: readonly string[],
	shape: (rng: Rng, k: number) => number[],
	silentFirst = false
): Data {
	const users: Row[] = [];
	const activity: Row[] = [];
	let id = rng.int(1, 9) * 10;
	for (const month of months) {
		const count = rng.int(2, 4);
		for (let k = 0; k < count; k += 1) {
			id += rng.int(1, 4);
			const signup = `${month}-${String(rng.int(1, 28)).padStart(2, '0')}`;
			users.push([id, signup]);
			if (!(silentFirst && k === 0)) activity.push([id, signup]);
			const offsets = k === 0 ? [] : shape(rng, k);
			for (const offset of offsets) activity.push([id, addDays(signup, offset)]);
		}
	}
	return { users, activity };
}

const MONTHS_2026 = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'] as const;

function twoMonths(rng: Rng): string[] {
	const start = rng.int(0, MONTHS_2026.length - 2);
	return MONTHS_2026.slice(start, start + 2);
}

/** Days of a user around a target day: on it, just before, just after, much later. */
function aroundDay(n: number) {
	return (rng: Rng): number[] => {
		const pick = rng.pick([
			[n],
			[n - 1],
			[n + 1],
			[n, n + 2],
			[n + rng.int(2, 9)],
			[rng.int(1, n - 1)],
			[n - 1, n + 1]
		]);
		return [...new Set(pick)];
	};
}

const cohortSelect = "strftime('%Y-%m', u.signup) AS cohort";

/** Cohort sizes with users who never came back: LEFT JOIN keeps them, an inner join loses them. */
function cohortSize(rng: Rng): SqlDraft {
	const table = rng.pick(['activity', 'visits', 'app_opens']);
	const data = cohorts(rng, twoMonths(rng), (r) => [r.int(1, 12), ...(r.bool(0.4) ? [r.int(1, 20)] : [])], true);
	const q = (join: string): string =>
		`SELECT ${cohortSelect}, COUNT(DISTINCT u.id),\n       COUNT(DISTINCT CASE WHEN a.day BETWEEN date(u.signup, '+1 day') AND date(u.signup, '+7 days') THEN u.id END)\nFROM users u ${join} ${table} a ON a.user_id = u.id\nGROUP BY cohort ORDER BY cohort;`;
	return {
		setup: setupOf(rng, data, table),
		query: q('LEFT JOIN'),
		wrong: { 'inner-join-cohort': q('JOIN') },
		purpose:
			'Аналитик считает размер месячных когорт и сколько пользователей вернулись в первую неделю после регистрации.'
	};
}

/** Retention on day N exactly: the signup day is day 0. */
function dayN(rng: Rng): SqlDraft {
	const table = rng.pick(['activity', 'visits', 'app_opens']);
	const n = rng.pick([3, 7, 14]);
	const data = cohorts(rng, twoMonths(rng), aroundDay(n));
	const q = (cond: string): string =>
		`SELECT ${cohortSelect}, COUNT(DISTINCT u.id),\n       COUNT(DISTINCT CASE WHEN ${cond} THEN u.id END)\nFROM users u LEFT JOIN ${table} a ON a.user_id = u.id\nGROUP BY cohort ORDER BY cohort;`;
	return {
		setup: setupOf(rng, data, table),
		query: q(`a.day = date(u.signup, '+${n} days')`),
		wrong: {
			'day-n-or-later': q(`a.day >= date(u.signup, '+${n} days')`),
			'signup-is-day-one': q(`a.day = date(u.signup, '+${n - 1} days')`)
		},
		purpose: `Аналитик считает retention дня ${n} по месячным когортам; день регистрации — день 0.`
	};
}

/** Rolling retention: active on day N or any day after it. */
function rolling(rng: Rng): SqlDraft {
	const table = rng.pick(['activity', 'visits', 'app_opens']);
	const n = rng.pick([7, 14, 30]);
	const data = cohorts(rng, twoMonths(rng), aroundDay(n));
	const q = (cond: string): string =>
		`SELECT ${cohortSelect}, COUNT(DISTINCT u.id),\n       COUNT(DISTINCT CASE WHEN ${cond} THEN u.id END)\nFROM users u LEFT JOIN ${table} a ON a.user_id = u.id\nGROUP BY cohort ORDER BY cohort;`;
	return {
		setup: setupOf(rng, data, table),
		query: q(`a.day >= date(u.signup, '+${n} days')`),
		wrong: { 'exact-day': q(`a.day = date(u.signup, '+${n} days')`) },
		purpose: `Аналитик считает rolling retention дня ${n} (вернулся в день ${n} или позже) по месячным когортам.`
	};
}

/** Active user-days of the first week against active users; BETWEEN includes both ends. */
function userDays(rng: Rng): SqlDraft {
	const table = rng.pick(['activity', 'visits', 'app_opens']);
	const data = cohorts(rng, twoMonths(rng), (r) => {
		const days = new Set<number>();
		// The traps: days on the ends of the week and a user active several days of it.
		days.add(r.pick([1, 7, 8, 3]));
		for (let k = r.int(0, 3); k > 0; k -= 1) days.add(r.int(1, 9));
		return [...days];
	});
	const inWeek = `a.day BETWEEN date(u.signup, '+1 day') AND date(u.signup, '+7 days')`;
	const q = (cond: string, distinct: string): string =>
		`SELECT ${cohortSelect}, COUNT(DISTINCT u.id),\n       COUNT(${distinct}CASE WHEN ${cond} THEN u.id END)\nFROM users u LEFT JOIN ${table} a ON a.user_id = u.id\nGROUP BY cohort ORDER BY cohort;`;
	return {
		setup: setupOf(rng, data, table),
		query: q(inWeek, ''),
		wrong: {
			'count-rows': q(inWeek, 'DISTINCT '),
			'between-exclusive': q(`a.day > date(u.signup, '+1 day') AND a.day < date(u.signup, '+7 days')`, '')
		},
		purpose: 'Аналитик считает по когортам активные пользователе-дни первой недели после регистрации (дни 1–7).'
	};
}

/** Months from the signup month to the month of activity, by the calendar, across the turn of a year. */
function monthOffset(rng: Rng): SqlDraft {
	const table = rng.pick(['activity', 'visits', 'app_opens']);
	const months = rng.pick([
		['2025-11', '2025-12'],
		['2025-12', '2026-01']
	]);
	const data = cohorts(rng, months, (r) => {
		// The traps: activity early in the next calendar month (< 30 days later) and in the month after it.
		return [...new Set([r.int(20, 45), r.int(25, 75), ...(r.bool(0.5) ? [r.int(40, 70)] : [])])];
	});
	const year = (d: string): string => `CAST(strftime('%Y', ${d}) AS INTEGER)`;
	const month = (d: string): string => `CAST(strftime('%m', ${d}) AS INTEGER)`;
	const calendar = `(${year('a.day')} - ${year('u.signup')}) * 12 + ${month('a.day')} - ${month('u.signup')}`;
	const q = (k: string): string =>
		`WITH c AS (\n  SELECT u.id, strftime('%Y-%m', u.signup) AS cohort,\n         ${k} AS k\n  FROM users u JOIN ${table} a ON a.user_id = u.id\n)\nSELECT cohort, k, COUNT(DISTINCT id) FROM c\nWHERE k BETWEEN 1 AND 2\nGROUP BY cohort, k ORDER BY cohort, k;`;
	return {
		setup: setupOf(rng, data, table),
		query: q(calendar),
		wrong: { 'days-as-months': q(`CAST((julianday(a.day) - julianday(u.signup)) / 30 AS INTEGER)`) },
		purpose: 'Аналитик строит матрицу удержания: сколько пользователей когорты активны через 1 и 2 календарных месяца.'
	};
}

/** A share with integer division and a LEFT JOIN: users who never came back are in the denominator. */
function shareInt(rng: Rng): SqlDraft {
	const table = rng.pick(['activity', 'visits', 'app_opens']);
	const data = cohorts(
		rng,
		twoMonths(rng),
		(r) => (r.bool(0.6) ? [r.int(1, 7), ...(r.bool(0.5) ? [r.int(8, 20)] : [])] : [r.int(8, 30)]),
		true
	);
	// The window of week 1 is a condition of the LEFT JOIN: users without activity in it stay in the cohort with NULL.
	const window = `a.day BETWEEN date(u.signup, '+1 day') AND date(u.signup, '+7 days')`;
	const retained = 'COUNT(DISTINCT a.user_id)';
	const intShare = `100 * ${retained} / COUNT(DISTINCT u.id)`;
	const q = (share: string, where = false): string =>
		`SELECT ${cohortSelect}, COUNT(DISTINCT u.id), ${retained},\n       ${share}\nFROM users u LEFT JOIN ${table} a ON a.user_id = u.id${where ? `\nWHERE ${window}` : ` AND ${window}`}\nGROUP BY cohort ORDER BY cohort;`;
	return {
		setup: setupOf(rng, data, table),
		query: q(intShare),
		wrong: {
			'real-division': q(`ROUND(100.0 * ${retained} / COUNT(DISTINCT u.id), 1)`),
			'on-filter-as-where': q(intShare, true)
		},
		purpose: 'Аналитик считает долю пользователей когорты, вернувшихся в первую неделю, в процентах.'
	};
}

/** A cohort by the month of the first purchase, not of the signup; a repeat purchase in the next calendar month. */
function firstPurchase(rng: Rng): SqlDraft {
	const months = twoMonths(rng);
	const users: Row[] = [];
	const purchases: Row[] = [];
	let id = rng.int(1, 9) * 10;
	const count = rng.int(5, 7);
	for (let k = 0; k < count; k += 1) {
		id += rng.int(1, 4);
		// The trap: the signup is often a month before the first purchase.
		const signupMonth = rng.pick(['2026-01', '2026-02', months[0] ?? '2026-03']);
		users.push([id, `${signupMonth}-${String(rng.int(1, 28)).padStart(2, '0')}`]);
		const first = `${rng.pick(months)}-${String(rng.int(1, 28)).padStart(2, '0')}`;
		purchases.push([id, first]);
		for (let r = rng.int(0, 2); r > 0; r -= 1) purchases.push([id, addDays(first, rng.int(3, 50))]);
	}
	const setup = [
		'CREATE TABLE users (id INTEGER PRIMARY KEY, signup TEXT NOT NULL);',
		'CREATE TABLE purchases (user_id INTEGER NOT NULL, day TEXT NOT NULL);',
		insertRows('users', ['id', 'signup'], rng.shuffle(users)),
		insertRows('purchases', ['user_id', 'day'], rng.shuffle(purchases))
	].join('\n');
	const q = (start: string): string =>
		`WITH first AS (\n  SELECT p.user_id, ${start} AS start FROM purchases p JOIN users u ON u.id = p.user_id GROUP BY p.user_id\n)\nSELECT strftime('%Y-%m', f.start) AS cohort, COUNT(DISTINCT f.user_id),\n       COUNT(DISTINCT CASE WHEN strftime('%Y-%m', p.day) = strftime('%Y-%m', date(f.start, 'start of month', '+1 month')) THEN f.user_id END)\nFROM first f JOIN purchases p ON p.user_id = f.user_id\nGROUP BY cohort ORDER BY cohort;`;
	return {
		setup,
		query: q('MIN(p.day)'),
		wrong: { 'cohort-by-signup': q('MIN(u.signup)') },
		purpose:
			'Аналитик делит покупателей на когорты по месяцу первой покупки и считает, кто купил снова в следующем календарном месяце.'
	};
}

/** A weekly cohort: the Monday of the signup week; week 1 is days 7–13 after that Monday, not after the signup. */
function weekCohort(rng: Rng): SqlDraft {
	const table = rng.pick(['activity', 'visits', 'app_opens']);
	const users: Row[] = [];
	const activity: Row[] = [];
	let id = rng.int(1, 9) * 10;
	// Mondays of two weeks in 2026 (2026-03-02 is a Monday).
	const first = rng.int(0, 20);
	const mondays = [addDays('2026-03-02', first * 7), addDays('2026-03-02', (first + 1) * 7)];
	for (const monday of mondays) {
		for (let k = rng.int(2, 4); k > 0; k -= 1) {
			id += rng.int(1, 4);
			const signup = addDays(monday, rng.int(0, 6));
			users.push([id, signup]);
			activity.push([id, signup]);
			// The trap: activity 7–13 days after the signup that falls outside week 1 of the cohort, or inside it.
			for (const offset of new Set([rng.int(3, 15), ...(rng.bool(0.5) ? [rng.int(5, 16)] : [])]))
				activity.push([id, addDays(signup, offset)]);
		}
	}
	const q = (from: string): string =>
		`WITH c AS (SELECT id, signup, date(signup, '-6 days', 'weekday 1') AS week FROM users)\nSELECT c.week, COUNT(DISTINCT c.id),\n       COUNT(DISTINCT CASE WHEN a.day BETWEEN date(${from}, '+7 days') AND date(${from}, '+13 days') THEN c.id END)\nFROM c LEFT JOIN ${table} a ON a.user_id = c.id\nGROUP BY c.week ORDER BY c.week;`;
	return {
		setup: setupOf(rng, { users, activity }, table),
		query: q('c.week'),
		wrong: { 'week-from-signup': q('c.signup') },
		purpose: `Аналитик строит недельные когорты: \`date(d, '-6 days', 'weekday 1')\` — понедельник недели, в которую попал день \`d\`; неделя 1 когорты — дни с 7-го по 13-й после этого понедельника. Для справки: ${mondays[0]} — понедельник.`
	};
}

const DRAFTS: Record<string, (rng: Rng) => SqlDraft> = {
	'junior/cohort-size': cohortSize,
	'junior/day-n': dayN,
	'junior/rolling': rolling,
	'junior/user-days': userDays,
	'middle/month-offset': monthOffset,
	'middle/share-int': shareInt,
	'middle/first-purchase': firstPurchase,
	'middle/week-cohort': weekCohort
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
