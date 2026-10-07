// Aggregates of an analyst's query where NULL and integer arithmetic decide the numbers: COUNT(*) against
// COUNT(column), AVG over non-NULL values, a share through AVG(CASE …), integer division of SQLite, SUM of a group of
// NULLs, LEFT JOIN that brings NULLs into averages, NULLIF against division by zero, an average of averages and
// COUNT(DISTINCT) that skips NULL.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows } from '../../_lib/sql.ts';
import { buildFromDraft, type SqlDraft } from '../../_lib/sql-draft.ts';

const descriptor = readDescriptor(import.meta.url);

type Row = (string | number | null)[];

const SEGMENTS = ['b2b', 'b2c', 'gov', 'edu', 'retail', 'media'] as const;
const CHANNELS = ['ads', 'email', 'organic', 'push', 'referral', 'social'] as const;
const CITIES = ['kazan', 'omsk', 'perm', 'samara', 'tomsk', 'tula', 'ufa'] as const;

/** Rows with ids 1..n in a shuffled order of insertion. */
function numbered(rng: Rng, rows: Row[]): Row[] {
	return rng.shuffle(rows.map((r, i) => [i + 1, ...r]));
}

/** Ratings by segment: COUNT(*) against COUNT(rating), AVG over the rated rows only. */
function countAvgNull(rng: Rng): SqlDraft {
	const table = rng.pick(['reviews', 'ratings', 'feedback']);
	const segments = rng.sample(SEGMENTS, rng.int(2, 3));
	const rows: Row[] = [];
	for (const segment of segments) {
		// The trap in every segment: a row without a rating next to rated ones.
		rows.push([segment, null], [segment, rng.int(1, 5)]);
		for (let k = rng.int(1, 3); k > 0; k -= 1) rows.push([segment, rng.bool(0.3) ? null : rng.int(1, 5)]);
	}
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, segment TEXT NOT NULL, rating INTEGER);\n${insertRows(table, ['id', 'segment', 'rating'], numbered(rng, rows))}`;
	const q = (count: string, avg: string): string =>
		`SELECT segment, COUNT(*), ${count}, ROUND(${avg}, 2) FROM ${table} GROUP BY segment ORDER BY segment;`;
	return {
		setup,
		query: q('COUNT(rating)', 'AVG(rating)'),
		wrong: {
			'count-star': q('COUNT(*)', 'AVG(rating)'),
			'null-as-zero': q('COUNT(rating)', 'AVG(COALESCE(rating, 0))')
		},
		purpose: 'Аналитик считает по сегментам число отзывов, число оценок и среднюю оценку.'
	};
}

/** A conversion rate in percent with integer division: both operands are integers, the result is truncated. */
function intDivision(rng: Rng): SqlDraft {
	const table = rng.pick(['visits', 'sessions', 'landings']);
	const channels = rng.sample(CHANNELS, rng.int(2, 3));
	const rows: Row[] = [];
	for (const channel of channels) {
		const n = rng.int(3, 7);
		// The trap: at least one conversion and one miss in a channel, so the share is a fraction.
		rows.push([channel, 1], [channel, 0]);
		for (let k = n - 2; k > 0; k -= 1) rows.push([channel, rng.bool(0.35) ? 1 : 0]);
	}
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, converted INTEGER NOT NULL);\n${insertRows(table, ['id', 'channel', 'converted'], numbered(rng, rows))}`;
	const q = (share: string): string =>
		`SELECT channel, COUNT(*), SUM(converted), ${share} FROM ${table} GROUP BY channel ORDER BY channel;`;
	return {
		setup,
		query: q('100 * SUM(converted) / COUNT(*)'),
		wrong: { 'real-division': q('ROUND(100.0 * SUM(converted) / COUNT(*), 2)') },
		purpose: 'Аналитик считает конверсию визитов в процентах по каналам.'
	};
}

/** A share through AVG(CASE …): ELSE 0 keeps the rows whose status is NULL in the denominator. */
function caseShare(rng: Rng): SqlDraft {
	const table = rng.pick(['orders', 'deliveries', 'tickets']);
	const status = rng.pick(['refund', 'cancel', 'lost']);
	const cities = rng.sample(CITIES, rng.int(2, 3));
	const rows: Row[] = [];
	for (const city of cities) {
		// The trap in every city: a row with an unknown status, the counted status and another one.
		rows.push([city, null], [city, status], [city, 'done']);
		for (let k = rng.int(1, 3); k > 0; k -= 1) rows.push([city, rng.pick([null, status, 'done', 'done'])]);
	}
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, city TEXT NOT NULL, status TEXT);\n${insertRows(table, ['id', 'city', 'status'], numbered(rng, rows))}`;
	const q = (share: string): string =>
		`SELECT city, COUNT(*), ROUND(${share}, 2) FROM ${table} GROUP BY city ORDER BY city;`;
	return {
		setup,
		query: q(`AVG(CASE WHEN status = '${status}' THEN 1.0 ELSE 0 END)`),
		wrong: {
			'null-dropped': q(`AVG(CASE WHEN status = '${status}' THEN 1.0 WHEN status IS NOT NULL THEN 0 END)`)
		},
		purpose: `Аналитик считает по городам долю записей со статусом \`${status}\`.`
	};
}

/** SUM and MAX of a group whose values are all NULL are NULL, while COUNT of the column is 0. */
function sumAllNull(rng: Rng): SqlDraft {
	const table = rng.pick(['staff', 'employees', 'members']);
	const depts = rng.sample(['sales', 'ops', 'dev', 'hr', 'legal', 'qa'], 3);
	const rows: Row[] = [];
	const bonus = (): number => rng.int(1, 40) * 5;
	// The trap: one department has only NULL bonuses, another a NULL among values.
	for (let k = rng.int(1, 3); k > 0; k -= 1) rows.push([depts[0] ?? 'x', null]);
	rows.push([depts[1] ?? 'y', null], [depts[1] ?? 'y', bonus()]);
	for (let k = rng.int(1, 3); k > 0; k -= 1) rows.push([depts[2] ?? 'z', bonus()]);
	for (let k = rng.int(0, 2); k > 0; k -= 1) rows.push([rng.pick(depts.slice(1)), rng.bool(0.3) ? null : bonus()]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, dept TEXT NOT NULL, bonus INTEGER);\n${insertRows(table, ['id', 'dept', 'bonus'], numbered(rng, rows))}`;
	const q = (sum: string, max: string): string =>
		`SELECT dept, COUNT(*), COUNT(bonus), ${sum}, ${max} FROM ${table} GROUP BY dept ORDER BY dept;`;
	return {
		setup,
		query: q('SUM(bonus)', 'MAX(bonus)'),
		wrong: { 'null-as-zero': q('COALESCE(SUM(bonus), 0)', 'COALESCE(MAX(bonus), 0)') },
		purpose: 'Аналитик сводит премии по отделам.'
	};
}

/** LEFT JOIN of users to orders: users without orders bring a NULL order into the group. */
function leftJoinAvg(rng: Rng): SqlDraft {
	const segments = rng.sample(SEGMENTS, 2);
	const users: Row[] = [];
	const orders: Row[] = [];
	let orderId = rng.int(1, 5) * 100;
	segments.forEach((segment) => {
		const count = rng.int(3, 4);
		for (let k = 0; k < count; k += 1) {
			const id = users.length + 1;
			users.push([id, segment]);
			// The trap: the first user of a segment has no orders, the second has several.
			const n = k === 0 ? 0 : k === 1 ? rng.int(2, 3) : rng.int(0, 2);
			for (let j = 0; j < n; j += 1) orders.push([(orderId += rng.int(1, 9)), id, rng.int(2, 60) * 50]);
		}
	});
	const setup = [
		'CREATE TABLE users (id INTEGER PRIMARY KEY, segment TEXT NOT NULL);',
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL);',
		insertRows('users', ['id', 'segment'], rng.shuffle(users)),
		insertRows('orders', ['id', 'user_id', 'amount'], rng.shuffle(orders))
	].join('\n');
	const q = (count: string, avg: string): string =>
		`SELECT u.segment, COUNT(DISTINCT u.id), ${count}, ROUND(${avg}, 2), ROUND(1.0 * COALESCE(SUM(o.amount), 0) / COUNT(DISTINCT u.id), 2)\nFROM users u LEFT JOIN orders o ON o.user_id = u.id\nGROUP BY u.segment ORDER BY u.segment;`;
	return {
		setup,
		query: q('COUNT(o.id)', 'AVG(o.amount)'),
		wrong: {
			'count-star': q('COUNT(*)', 'AVG(o.amount)'),
			'null-as-zero': q('COUNT(o.id)', 'AVG(COALESCE(o.amount, 0))')
		},
		purpose: 'Аналитик считает по сегментам число пользователей, число заказов, средний чек и выручку на пользователя.'
	};
}

/** NULLIF keeps a division by a zero total from failing: the share is NULL; SUM over NULL clicks is NULL. */
function nullifCtr(rng: Rng): SqlDraft {
	const table = rng.pick(['ad_stats', 'banner_daily', 'campaign_days']);
	const names = rng.sample(['spring', 'promo', 'brand', 'launch', 'retarget', 'video'], 3);
	const rows: Row[] = [];
	const day = (): number => rng.int(1, 28);
	// The traps: a campaign that was never shown (no views, clicks unknown), a NULL click count next to known ones.
	for (let k = rng.int(1, 2); k > 0; k -= 1) rows.push([names[0] ?? 'a', day(), 0, null]);
	const views = (): number => rng.int(2, 40) * 10;
	rows.push([names[1] ?? 'b', day(), views(), null], [names[1] ?? 'b', day(), views(), rng.int(1, 15)]);
	for (let k = rng.int(1, 3); k > 0; k -= 1) rows.push([names[2] ?? 'c', day(), views(), rng.int(0, 15)]);
	for (let k = rng.int(0, 2); k > 0; k -= 1)
		rows.push([rng.pick(names.slice(1)), day(), views(), rng.bool(0.3) ? null : rng.int(0, 15)]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, campaign TEXT NOT NULL, day INTEGER NOT NULL, views INTEGER NOT NULL, clicks INTEGER);\n${insertRows(table, ['id', 'campaign', 'day', 'views', 'clicks'], numbered(rng, rows))}`;
	const q = (clicks: string, ctr: string): string =>
		`SELECT campaign, SUM(views), ${clicks}, ${ctr}\nFROM ${table} GROUP BY campaign ORDER BY campaign;`;
	const ctr = 'ROUND(100.0 * SUM(clicks) / NULLIF(SUM(views), 0), 2)';
	return {
		setup,
		query: q('SUM(clicks)', ctr),
		wrong: { 'null-as-zero': q('COALESCE(SUM(clicks), 0)', `COALESCE(${ctr}, 0)`) },
		purpose: 'Аналитик считает CTR кампаний в процентах.'
	};
}

/** An average of per-user averages: a user whose amounts are all NULL has a NULL average and drops out of it. */
function avgOfAvgs(rng: Rng): SqlDraft {
	const table = rng.pick(['purchases', 'payments', 'checks']);
	const rows: Row[] = [];
	const users = rng.int(4, 5);
	const amount = (): number => rng.int(2, 40) * 25;
	for (let user = 1; user <= users; user += 1) {
		// The traps: user 1 has only NULL amounts, user 2 a NULL among values, the others different numbers of rows.
		const n = user === 1 ? rng.int(1, 2) : rng.int(1, 4);
		for (let k = 0; k < n; k += 1)
			rows.push([user, user === 1 || (user === 2 && k === 0) ? null : rng.bool(0.15) ? null : amount()]);
		if (user === 2) rows.push([user, amount()]);
	}
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER);\n${insertRows(table, ['id', 'user_id', 'amount'], numbered(rng, rows))}`;
	const q = (inner: string): string =>
		`WITH per_user AS (SELECT user_id, ${inner} AS user_avg FROM ${table} GROUP BY user_id)\nSELECT (SELECT ROUND(AVG(amount), 2) FROM ${table}), ROUND(AVG(user_avg), 2), COUNT(*), COUNT(user_avg) FROM per_user;`;
	return {
		setup,
		query: q('AVG(amount)'),
		wrong: { 'null-as-zero': q('AVG(COALESCE(amount, 0))') },
		purpose: 'Аналитик сравнивает средний платёж со средним по пользователям средним платежом.'
	};
}

/** COUNT(DISTINCT column) skips NULL, while DISTINCT rows keep NULL as a value of its own. */
function countDistinctNull(rng: Rng): SqlDraft {
	const table = rng.pick(['orders', 'carts', 'checkouts']);
	const channels = rng.sample(CHANNELS, 2);
	const coupons = rng.sample(['SALE10', 'WELCOME', 'VIP', 'FRIEND', 'BLACK', 'AUTUMN'], 4);
	const rows: Row[] = [];
	for (const channel of channels) {
		// The traps in every channel: orders without a coupon and a coupon used twice.
		const twice = rng.pick(coupons);
		rows.push([channel, null], [channel, twice], [channel, twice]);
		for (let k = rng.int(1, 4); k > 0; k -= 1) rows.push([channel, rng.bool(0.3) ? null : rng.pick(coupons)]);
	}
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, coupon TEXT);\n${insertRows(table, ['id', 'channel', 'coupon'], numbered(rng, rows))}`;
	const distinctRows = `(SELECT COUNT(*) FROM (SELECT DISTINCT coupon FROM ${table} t2 WHERE t2.channel = t.channel))`;
	const q = (distinct: string): string =>
		`SELECT channel, COUNT(*), COUNT(coupon), ${distinct},\n       ${distinctRows}\nFROM ${table} t GROUP BY channel ORDER BY channel;`;
	return {
		setup,
		query: q('COUNT(DISTINCT coupon)'),
		wrong: { 'distinct-counts-null': q(distinctRows) },
		purpose: 'Аналитик считает по каналам заказы, заказы с купоном и число разных купонов.'
	};
}

const DRAFTS: Record<string, (rng: Rng) => SqlDraft> = {
	'intern/count-avg-null': countAvgNull,
	'intern/int-division': intDivision,
	'intern/case-share': caseShare,
	'intern/sum-all-null': sumAllNull,
	'junior/left-join-avg': leftJoinAvg,
	'junior/nullif-ctr': nullifCtr,
	'junior/avg-of-avgs': avgOfAvgs,
	'junior/count-distinct-null': countDistinctNull
};

export function build(input: GenerateInput): Built {
	const draft = DRAFTS[`${input.grade}/${input.classId}`];
	if (!draft) throw new Error(`${descriptor.key}: no draft for ${input.grade}/${input.classId}`);
	return buildFromDraft(descriptor, input, draft);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
