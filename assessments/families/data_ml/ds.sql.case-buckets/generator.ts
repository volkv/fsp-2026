// Buckets and conditional aggregation in an analyst's query: the first matching branch of CASE wins, a CASE without
// ELSE gives NULL, WHERE filters rows before HAVING judges groups, COUNT(DISTINCT …) and a share through SUM(CASE …);
// at Junior — NTILE buckets of unequal size and with NULL, CASE inside an aggregate with and without ELSE, a pivot by
// conditional sums.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { CITY_NAMES, PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows } from '../../_lib/sql.ts';
import { buildFromDraft, type SqlDraft } from '../../_lib/sql-draft.ts';

const descriptor = readDescriptor(import.meta.url);

/** The answer lines are compared as text: the separator is fixed exactly. */
const ROW_SPACING =
	'Значения разделяются ровно так: пробел, черта, пробел — без лишних пробелов вокруг черты; пробелы внутри самих значений сохраняются как есть. Например, строка из трёх столбцов: `7 | NULL | 2.5`.';

type Row = (string | number | null)[];

const NULL_ORDER = 'В SQLite NULL при сортировке считается меньше любого значения.';

/** Rows with ids 1..n in a shuffled order of insertion. */
function numbered(rng: Rng, rows: Row[]): Row[] {
	return rng.shuffle(rows.map((r, i) => [i + 1, ...r]));
}

/** CASE branches checked in order: a lower bound first catches the values of the higher bucket too. */
function caseOrder(rng: Rng): SqlDraft {
	const table = rng.pick(['orders', 'payments', 'invoices']);
	const low = rng.int(2, 4) * 50;
	const high = low * rng.int(3, 4);
	const count = rng.int(9, 13);
	const rows: Row[] = [];
	// The trap: several amounts above the high bound, some between the bounds, some below.
	rows.push([rng.pick(PERSON_NAMES), high + rng.int(1, 20) * 10], [rng.pick(PERSON_NAMES), low + rng.int(0, 3) * 10]);
	for (let i = 2; i < count; i += 1)
		rows.push([rng.pick(PERSON_NAMES), rng.int(1, Math.floor((high * 1.6) / 10)) * 10]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, customer TEXT NOT NULL, amount INTEGER NOT NULL);\n${insertRows(table, ['id', 'customer', 'amount'], numbered(rng, rows))}`;
	const bucket = (first: [number, string], second: [number, string]): string =>
		`CASE WHEN amount >= ${first[0]} THEN '${first[1]}' WHEN amount >= ${second[0]} THEN '${second[1]}' ELSE 'small' END`;
	const q = (expr: string): string =>
		`SELECT ${expr} AS bucket, COUNT(*), SUM(amount)\nFROM ${table}\nGROUP BY bucket\nORDER BY bucket;`;
	return {
		setup,
		query: q(bucket([low, 'medium'], [high, 'large'])),
		wrong: { 'case-most-specific': q(bucket([high, 'large'], [low, 'medium'])) },
		purpose: 'Аналитик раскладывает заказы по корзинам суммы.'
	};
}

/** A CASE without ELSE gives NULL: the unmatched rows form their own group, which sorts first. */
function elseNull(rng: Rng): SqlDraft {
	const table = rng.pick(['attempts', 'exams', 'submissions']);
	const pass = rng.int(7, 9) * 10;
	const retry = pass - rng.int(2, 3) * 10;
	const count = rng.int(9, 13);
	const rows: Row[] = [];
	// The trap: scores below both bounds exist.
	rows.push([rng.pick(PERSON_NAMES), rng.int(1, Math.floor(retry / 10) - 1) * 10 + rng.int(0, 9)]);
	rows.push([rng.pick(PERSON_NAMES), pass + rng.int(0, 10)]);
	for (let i = 2; i < count; i += 1) rows.push([rng.pick(PERSON_NAMES), rng.int(20, 100)]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, student TEXT NOT NULL, score INTEGER NOT NULL);\n${insertRows(table, ['id', 'student', 'score'], numbered(rng, rows))}`;
	const inner = `SELECT CASE WHEN score >= ${pass} THEN 'pass' WHEN score >= ${retry} THEN 'retry' END AS verdict, score FROM ${table}`;
	const q = (filter: string): string =>
		`SELECT verdict, COUNT(*), MIN(score)\nFROM (${inner})${filter}\nGROUP BY verdict\nORDER BY verdict;`;
	return {
		setup,
		query: q(''),
		wrong: { 'else-drops-row': q('\nWHERE verdict IS NOT NULL') },
		purpose: `Аналитик считает итоги экзамена по вердиктам. ${NULL_ORDER}`
	};
}

/** WHERE filters rows before grouping, so HAVING COUNT(*) counts only the rows that passed the filter. */
function whereVsHaving(rng: Rng): SqlDraft {
	const table = rng.pick(['orders', 'deliveries', 'purchases']);
	const cities = rng.sample(CITY_NAMES, rng.int(3, 4));
	const threshold = rng.int(3, 6) * 100;
	const k = rng.int(2, 3);
	const rows: Row[] = [];
	const big = (): number => threshold + rng.int(1, 30) * 10;
	const small = (): number => rng.int(5, threshold / 10) * 10;
	cities.forEach((city, i) => {
		// The trap: the first city has many rows but fewer than k above the threshold.
		if (i === 0) {
			for (let j = 0; j < k - 1; j += 1) rows.push([city, big()]);
			for (let j = rng.int(2, 3); j > 0; j -= 1) rows.push([city, small()]);
		} else {
			for (let j = rng.int(k - 1, k + 1); j > 0; j -= 1) rows.push([city, big()]);
			for (let j = rng.int(0, 2); j > 0; j -= 1) rows.push([city, small()]);
		}
	});
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, city TEXT NOT NULL, amount INTEGER NOT NULL);\n${insertRows(table, ['id', 'city', 'amount'], numbered(rng, rows))}`;
	const bigCount = `COUNT(CASE WHEN amount > ${threshold} THEN 1 END)`;
	const bigSum = `SUM(CASE WHEN amount > ${threshold} THEN amount END)`;
	return {
		setup,
		query: `SELECT city, COUNT(*), SUM(amount)\nFROM ${table}\nWHERE amount > ${threshold}\nGROUP BY city\nHAVING COUNT(*) >= ${k}\nORDER BY city;`,
		wrong: {
			'having-counts-all': `SELECT city, ${bigCount}, ${bigSum}\nFROM ${table}\nGROUP BY city\nHAVING COUNT(*) >= ${k} AND ${bigCount} > 0\nORDER BY city;`
		},
		purpose: `Аналитик ищет города, где не меньше ${k} крупных заказов.`
	};
}

/** COUNT(DISTINCT user) next to COUNT(*) and a share of paid orders through SUM(CASE …) over COUNT(*). */
function shareDistinct(rng: Rng): SqlDraft {
	const table = rng.pick(['orders', 'checkouts', 'purchases']);
	const segments = rng.sample(['new', 'returning', 'vip', 'trial'], rng.int(2, 3));
	const users = rng.sample(PERSON_NAMES, 10);
	const rows: Row[] = [];
	let u = 0;
	for (const segment of segments) {
		const people = users.slice(u, u + rng.int(2, 3));
		u += people.length;
		// The trap: a user with several orders in every segment.
		rows.push([people[0] ?? 'x', segment, 'paid'], [people[0] ?? 'x', segment, rng.pick(['paid', 'failed'])]);
		for (const person of people) {
			for (let j = rng.int(1, 2); j > 0; j -= 1) rows.push([person, segment, rng.pick(['paid', 'paid', 'failed'])]);
		}
	}
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, user_name TEXT NOT NULL, segment TEXT NOT NULL, status TEXT NOT NULL);\n${insertRows(table, ['id', 'user_name', 'segment', 'status'], numbered(rng, rows))}`;
	const q = (users: string): string =>
		`SELECT segment, ${users}, COUNT(*),\n       ROUND(100.0 * SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) / COUNT(*), 1)\nFROM ${table}\nGROUP BY segment\nORDER BY segment;`;
	return {
		setup,
		query: q('COUNT(DISTINCT user_name)'),
		wrong: { 'distinct-ignored': q('COUNT(user_name)') },
		purpose: 'Аналитик считает по сегментам число покупателей, число заказов и долю оплаченных в процентах.'
	};
}

/** NTILE(k) over n rows with n mod k ≠ 0: the first buckets get one row more. */
function ntileBuckets(rng: Rng): SqlDraft {
	const table = rng.pick(['sessions', 'orders', 'visits']);
	const k = rng.int(3, 4);
	let n = rng.int(10, 15);
	if (n % k === 0) n += 1;
	const values = rng.sample(
		Array.from({ length: 90 }, (_, i) => (i + 1) * 5),
		n
	);
	const rows: Row[] = values.map((v) => [rng.pick(PERSON_NAMES), v]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, user_name TEXT NOT NULL, amount INTEGER NOT NULL);\n${insertRows(table, ['id', 'user_name', 'amount'], numbered(rng, rows))}`;
	const q = (bucket: string): string =>
		`SELECT bucket, COUNT(*), MIN(amount), MAX(amount)\nFROM (SELECT amount, ${bucket} AS bucket FROM ${table})\nGROUP BY bucket\nORDER BY bucket;`;
	return {
		setup,
		query: q(`NTILE(${k}) OVER (ORDER BY amount)`),
		wrong: { 'ntile-extra-last': q(`${k + 1} - NTILE(${k}) OVER (ORDER BY amount DESC)`) },
		purpose: `Аналитик делит заказы на ${k} корзины по сумме.`
	};
}

/** AVG(CASE WHEN … THEN x END) averages only the matching rows: ELSE 0 would put zeros into the denominator. */
function caseInAggregate(rng: Rng): SqlDraft {
	const table = rng.pick(['orders', 'purchases', 'payments']);
	const cities = rng.sample(CITY_NAMES, rng.int(3, 4));
	const channel = rng.pick(['ads', 'email', 'push']);
	const rows: Row[] = [];
	cities.forEach((city, i) => {
		// The trap: every city but the last has rows of other channels; the last has none of the channel.
		const last = i === cities.length - 1;
		if (!last) for (let j = rng.int(1, 3); j > 0; j -= 1) rows.push([city, channel, rng.int(2, 40) * 10]);
		for (let j = rng.int(1, 3); j > 0; j -= 1) rows.push([city, rng.pick(['organic', 'direct']), rng.int(2, 40) * 10]);
	});
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, city TEXT NOT NULL, channel TEXT NOT NULL, amount INTEGER NOT NULL);\n${insertRows(table, ['id', 'city', 'channel', 'amount'], numbered(rng, rows))}`;
	const q = (tail: string): string =>
		`SELECT city, COUNT(*), ROUND(AVG(CASE WHEN channel = '${channel}' THEN amount${tail} END), 2)\nFROM ${table}\nGROUP BY city\nORDER BY city;`;
	return {
		setup,
		query: q(''),
		wrong: { 'case-else-zero': q(' ELSE 0') },
		purpose: `Аналитик считает по городам средний чек заказов из канала ${channel}.`
	};
}

/** A pivot by conditional sums: SUM(CASE … END) without ELSE is NULL in a month without matching rows. */
function pivot(rng: Rng): SqlDraft {
	const table = rng.pick(['revenue', 'sales', 'payments']);
	const months = ['2026-01', '2026-02', '2026-03', '2026-04'].slice(0, rng.int(3, 4));
	const platforms = ['ios', 'android', 'web'];
	const rows: Row[] = [];
	months.forEach((month, i) => {
		for (const platform of platforms) {
			// The trap: one month has no Android payments.
			if (platform === 'android' && i === 1) continue;
			for (let j = rng.int(platform === 'web' ? 0 : 1, 2); j > 0; j -= 1)
				rows.push([month, platform, rng.int(1, 30) * 10]);
		}
	});
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, month TEXT NOT NULL, platform TEXT NOT NULL, amount INTEGER NOT NULL);\n${insertRows(table, ['id', 'month', 'platform', 'amount'], numbered(rng, rows))}`;
	const q = (android: string): string =>
		`SELECT month,\n       SUM(CASE WHEN platform = 'ios' THEN amount ELSE 0 END) AS ios,\n       ${android} AS android,\n       COUNT(CASE WHEN platform = 'web' THEN 1 END) AS web_payments\nFROM ${table}\nGROUP BY month\nORDER BY month;`;
	return {
		setup,
		query: q(`SUM(CASE WHEN platform = 'android' THEN amount END)`),
		wrong: { 'sum-null-as-zero': q(`COALESCE(SUM(CASE WHEN platform = 'android' THEN amount END), 0)`) },
		purpose: 'Аналитик строит сводную таблицу выручки по месяцам и платформам.'
	};
}

/** NTILE over a column with NULL: NULL sorts first, so NULL rows fill the first bucket and shift the others. */
function ntileNulls(rng: Rng): SqlDraft {
	const table = rng.pick(['students', 'players', 'members']);
	const k = rng.int(3, 4);
	const n = rng.int(10, 14);
	const scores = rng.sample(
		Array.from({ length: 60 }, (_, i) => i + 40),
		n
	);
	const rows: Row[] = scores.map((s, i) => [PERSON_NAMES[i] ?? `p${i}`, i < 2 || (i < 4 && rng.bool(0.5)) ? null : s]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score INTEGER);\n${insertRows(table, ['id', 'name', 'score'], numbered(rng, rows))}`;
	const q = (filter: string): string =>
		`SELECT bucket, COUNT(*), COUNT(score), MAX(score)\nFROM (SELECT score, NTILE(${k}) OVER (ORDER BY score, id) AS bucket FROM ${table}${filter})\nGROUP BY bucket\nORDER BY bucket;`;
	return {
		setup,
		query: q(''),
		wrong: { 'null-excluded-from-ntile': q(' WHERE score IS NOT NULL') },
		purpose: `Аналитик делит участников на ${k} группы по баллу. ${NULL_ORDER}`
	};
}

const DRAFTS: Record<string, (rng: Rng) => SqlDraft> = {
	'intern/case-order': caseOrder,
	'intern/else-null': elseNull,
	'intern/where-vs-having': whereVsHaving,
	'intern/share-distinct': shareDistinct,
	'junior/ntile-buckets': ntileBuckets,
	'junior/case-in-aggregate': caseInAggregate,
	'junior/pivot': pivot,
	'junior/ntile-nulls': ntileNulls
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
