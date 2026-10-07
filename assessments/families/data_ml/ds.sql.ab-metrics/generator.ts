// Metrics of an A/B experiment in SQL: the first assignment of a reassigned user and orders only after it, users seen
// in both variants excluded, revenue per user against per order with users who bought nothing, and the ratio of sums
// against the mean of per-user ratios with SQLite's integer division.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows } from '../../_lib/sql.ts';
import { buildFromDraft, type SqlDraft } from '../../_lib/sql-draft.ts';

const descriptor = readDescriptor(import.meta.url);

type Row = (string | number | null)[];

function users(rng: Rng, n: number): number[] {
	let id = rng.int(1, 9) * 100;
	return Array.from({ length: n }, () => (id += rng.int(1, 5)));
}

const amount = (rng: Rng): number => rng.int(2, 60) * 50;

function setupOf(rng: Rng, assignments: Row[], orders: Row[]): string {
	return [
		'CREATE TABLE assignments (user_id INTEGER NOT NULL, variant TEXT NOT NULL, ts INTEGER NOT NULL);',
		'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, ts INTEGER NOT NULL);',
		insertRows('assignments', ['user_id', 'variant', 'ts'], rng.shuffle(assignments)),
		insertRows(
			'orders',
			['id', 'user_id', 'amount', 'ts'],
			rng.shuffle(orders).map((o, i) => [i + 1, ...o])
		)
	].join('\n');
}

/** The first assignment of each user, orders only after it; a reassigned user and an order before the assignment. */
function firstAssignment(rng: Rng): SqlDraft {
	const ids = users(rng, rng.int(6, 8));
	const assignments: Row[] = [];
	const orders: Row[] = [];
	ids.forEach((user, k) => {
		const variant = rng.pick(['A', 'B']);
		const ts = rng.int(10, 40);
		assignments.push([user, variant, ts]);
		// The traps: user 0 is reassigned to the other variant later, user 1 bought before the assignment.
		if (k === 0 || rng.bool(0.2)) assignments.push([user, variant === 'A' ? 'B' : 'A', ts + rng.int(5, 30)]);
		if (k === 1) orders.push([user, amount(rng), ts - rng.int(1, 9)]);
		for (let n = k === 0 ? 1 : rng.int(0, 2); n > 0; n -= 1) orders.push([user, amount(rng), ts + rng.int(1, 60)]);
		if (k > 1 && rng.bool(0.2)) orders.push([user, amount(rng), ts - rng.int(1, 9)]);
	});
	const first = `SELECT user_id, variant, ts FROM (\n    SELECT user_id, variant, ts, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts) AS rn\n    FROM assignments\n  ) WHERE rn = 1`;
	const q = (a: string, on: string): string =>
		`WITH a AS (\n  ${a}\n)\nSELECT a.variant, COUNT(DISTINCT a.user_id), COUNT(DISTINCT o.user_id),\n       ROUND(1.0 * COALESCE(SUM(o.amount), 0) / COUNT(DISTINCT a.user_id), 2)\nFROM a LEFT JOIN orders o ON ${on}\nGROUP BY a.variant ORDER BY a.variant;`;
	const after = 'o.user_id = a.user_id AND o.ts >= a.ts';
	return {
		setup: setupOf(rng, assignments, orders),
		query: q(first, after),
		wrong: {
			'all-assignments': q('SELECT user_id, variant, ts FROM assignments', after),
			'orders-before-assignment': q(first, 'o.user_id = a.user_id')
		},
		purpose:
			'Аналитик считает по вариантам эксперимента пользователей, покупателей и выручку на пользователя; пользователь относится к варианту первого назначения, учитываются заказы после него.'
	};
}

/** Users seen in both variants are excluded from the comparison. */
function excludeCrossed(rng: Rng): SqlDraft {
	const ids = users(rng, rng.int(6, 8));
	const assignments: Row[] = [];
	const orders: Row[] = [];
	ids.forEach((user, k) => {
		const variant = rng.pick(['A', 'B']);
		const ts = rng.int(10, 40);
		assignments.push([user, variant, ts]);
		// The traps: user 0 is in both variants and bought, user 1 got the same variant twice.
		if (k === 0 || (k > 1 && rng.bool(0.25)))
			assignments.push([user, variant === 'A' ? 'B' : 'A', ts + rng.int(1, 20)]);
		if (k === 1) assignments.push([user, variant, ts + rng.int(1, 20)]);
		for (let n = k === 0 ? 1 : rng.int(0, 2); n > 0; n -= 1) orders.push([user, amount(rng), ts + rng.int(1, 60)]);
	});
	const clean =
		'SELECT user_id, MIN(variant) AS variant FROM assignments GROUP BY user_id HAVING COUNT(DISTINCT variant) = 1';
	const q = (c: string): string =>
		`WITH clean AS (\n  ${c}\n)\nSELECT c.variant, COUNT(DISTINCT c.user_id), COUNT(o.id), COALESCE(SUM(o.amount), 0)\nFROM clean c LEFT JOIN orders o ON o.user_id = c.user_id\nGROUP BY c.variant ORDER BY c.variant;`;
	return {
		setup: setupOf(rng, assignments, orders),
		query: q(clean),
		wrong: { 'crossed-in-both': q('SELECT DISTINCT user_id, variant FROM assignments') },
		purpose: 'Аналитик сравнивает варианты, исключив пользователей, попавших в оба варианта.'
	};
}

/** Revenue per user over all assigned users (LEFT JOIN), and per order over orders. */
function arpuVsAov(rng: Rng): SqlDraft {
	const ids = users(rng, rng.int(6, 8));
	const assignments: Row[] = [];
	const orders: Row[] = [];
	ids.forEach((user, k) => {
		const variant = k < 2 ? (k === 0 ? 'A' : 'B') : rng.pick(['A', 'B']);
		const ts = rng.int(10, 40);
		assignments.push([user, variant, ts]);
		// The traps: users without orders in both variants, buyers with several orders.
		const n = k < 2 ? 0 : k < 4 ? rng.int(1, 3) : rng.int(0, 2);
		for (let j = 0; j < n; j += 1) orders.push([user, amount(rng), ts + rng.int(1, 60)]);
	});
	const q = (join: string, denominator: string): string =>
		`SELECT a.variant, COUNT(DISTINCT a.user_id), COUNT(o.id),\n       ROUND(1.0 * COALESCE(SUM(o.amount), 0) / ${denominator}, 2) AS arpu,\n       ROUND(1.0 * SUM(o.amount) / COUNT(o.id), 2) AS aov\nFROM assignments a ${join} orders o ON o.user_id = a.user_id\nGROUP BY a.variant ORDER BY a.variant;`;
	return {
		setup: setupOf(rng, assignments, orders),
		query: q('LEFT JOIN', 'COUNT(DISTINCT a.user_id)'),
		wrong: {
			'arpu-over-buyers': q('LEFT JOIN', 'COUNT(DISTINCT o.user_id)'),
			'inner-join': q('JOIN', 'COUNT(DISTINCT a.user_id)')
		},
		purpose: 'Аналитик считает по вариантам выручку на пользователя (ARPU) и средний чек (AOV).'
	};
}

/** The ratio of sums against the mean of per-user ratios; `clicks / views` of two integers is integer division. */
function intDivision(rng: Rng): SqlDraft {
	const rows: Row[] = [];
	const ids = users(rng, rng.int(6, 8));
	ids.forEach((user, k) => {
		const variant = k < 2 ? (k === 0 ? 'A' : 'B') : rng.pick(['A', 'B']);
		// The traps: users with very different numbers of views, so the mean of ratios is not the ratio of sums.
		const views = rng.bool(0.3) ? rng.int(1, 4) : rng.int(10, 80);
		rows.push([user, variant, views, rng.int(0, Math.max(1, Math.floor(views * 0.6)))]);
	});
	const setup = `CREATE TABLE user_stats (user_id INTEGER PRIMARY KEY, variant TEXT NOT NULL, views INTEGER NOT NULL, clicks INTEGER NOT NULL);\n${insertRows('user_stats', ['user_id', 'variant', 'views', 'clicks'], rng.shuffle(rows))}`;
	const ratio = 'ROUND(1.0 * SUM(clicks) / SUM(views), 3)';
	const q = (second: string, third: string): string =>
		`SELECT variant, ${ratio},\n       ${second},\n       ${third}\nFROM user_stats GROUP BY variant ORDER BY variant;`;
	const intMean = 'ROUND(AVG(clicks / views), 3)';
	const realMean = 'ROUND(AVG(1.0 * clicks / views), 3)';
	return {
		setup,
		query: q(intMean, realMean),
		wrong: {
			'int-division': q(realMean, realMean),
			'ratio-equals-mean': q(intMean, ratio)
		},
		purpose: 'Аналитик сравнивает CTR вариантов двумя способами: отношением сумм и средним CTR пользователей.'
	};
}

const DRAFTS: Record<string, (rng: Rng) => SqlDraft> = {
	'senior/first-assignment': firstAssignment,
	'senior/exclude-crossed': excludeCrossed,
	'senior/arpu-vs-aov': arpuVsAov,
	'senior/int-division': intDivision
};

export function build(input: GenerateInput): Built {
	const draft = DRAFTS[`${input.grade}/${input.classId}`];
	if (!draft) throw new Error(`${descriptor.key}: no draft for ${input.grade}/${input.classId}`);
	return buildFromDraft(descriptor, input, draft);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
