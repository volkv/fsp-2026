// A product funnel in SQL over an event log: unique users against events, conversion between steps, users who did
// both steps; at Junior the order of steps in time, a time window after a step, sessions as the unit and the last step
// a user reached.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows } from '../../_lib/sql.ts';
import { addMinutes, buildFromDraft, type SqlDraft } from '../../_lib/sql-draft.ts';

const descriptor = readDescriptor(import.meta.url);

/** The answer lines are compared as text: the separator is fixed exactly. */
const ROW_SPACING =
	'Значения разделяются ровно так: пробел, черта, пробел — без лишних пробелов вокруг черты; пробелы внутри самих значений сохраняются как есть. Например, строка из трёх столбцов: `7 | NULL | 2.5`.';

type Row = (string | number | null)[];

const PLATFORMS = ['android', 'ios', 'web'] as const;

/** A moment of a day in October 2026 as SQLite's `datetime()` writes it. */
function moment(rng: Rng): string {
	return addMinutes(
		`2026-10-${String(rng.int(1, 20)).padStart(2, '0')} 00:00:00`,
		rng.int(0, 23 * 60) + rng.int(0, 59)
	);
}

function eventsSetup(table: string, rows: Row[], rng: Rng, session = false): string {
	const ordered = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	return session
		? `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, session_id INTEGER NOT NULL, event TEXT NOT NULL, platform TEXT NOT NULL);\n${insertRows(table, ['id', 'user_id', 'session_id', 'event', 'platform'], ordered)}`
		: `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, event TEXT NOT NULL, ts TEXT NOT NULL, platform TEXT NOT NULL);\n${insertRows(table, ['id', 'user_id', 'event', 'ts', 'platform'], ordered)}`;
}

/** Unique users per event against the number of events: a user repeats an event. */
function uniqueUsers(rng: Rng): SqlDraft {
	const table = rng.pick(['events', 'app_events', 'tracking']);
	const steps = ['visit', 'search', 'cart', 'purchase'];
	const rows: Row[] = [];
	const users = rng.int(4, 7);
	for (let user = 1; user <= users; user += 1) {
		const platform = rng.pick(PLATFORMS);
		const depth = user === 1 ? 4 : rng.int(1, 4);
		for (const step of steps.slice(0, depth)) {
			// The trap: user 1 repeats every step, the others sometimes.
			const times = user === 1 ? 2 : rng.bool(0.3) ? 2 : 1;
			for (let k = 0; k < times; k += 1) rows.push([user, step, moment(rng), platform]);
		}
	}
	const q = (count: string): string => `SELECT event, ${count} FROM ${table} GROUP BY event ORDER BY event;`;
	return {
		setup: eventsSetup(table, rows, rng),
		query: q('COUNT(DISTINCT user_id)'),
		wrong: { 'count-events': q('COUNT(*)') },
		purpose: 'Аналитик строит воронку: сколько пользователей дошло до каждого шага.'
	};
}

/** Conversion from visit to purchase by platform, on distinct users. */
function conversion(rng: Rng): SqlDraft {
	const table = rng.pick(['events', 'app_events', 'tracking']);
	const rows: Row[] = [];
	const platforms = rng.sample(PLATFORMS, 2);
	let user = 0;
	for (const platform of platforms) {
		const users = rng.int(3, 5);
		for (let k = 0; k < users; k += 1) {
			user += 1;
			// The traps: repeated visits, a buyer with two purchases.
			for (let v = rng.int(1, 3); v > 0; v -= 1) rows.push([user, 'visit', moment(rng), platform]);
			if (k === 0 || (k > 1 && rng.bool(0.4)))
				for (let p = k === 0 ? 2 : 1; p > 0; p -= 1) rows.push([user, 'purchase', moment(rng), platform]);
		}
	}
	const users = (event: string, distinct: boolean): string =>
		`COUNT(${distinct ? 'DISTINCT ' : ''}CASE WHEN event = '${event}' THEN user_id END)`;
	const q = (distinct: boolean): string =>
		`SELECT platform, ${users('visit', distinct)}, ${users('purchase', distinct)},\n       ROUND(100.0 * ${users('purchase', distinct)} / ${users('visit', distinct)}, 1)\nFROM ${table} GROUP BY platform ORDER BY platform;`;
	return {
		setup: eventsSetup(table, rows, rng),
		query: q(true),
		wrong: { 'count-events': q(false) },
		purpose: 'Аналитик считает конверсию из визита в покупку по платформам.'
	};
}

/** Users who did both steps: COUNT(DISTINCT event) = 2, not COUNT(*) = 2. */
function bothSteps(rng: Rng): SqlDraft {
	const table = rng.pick(['events', 'app_events', 'tracking']);
	const [first, second] = rng.pick([
		['cart', 'purchase'],
		['signup', 'subscribe'],
		['search', 'order']
	] as const);
	const rows: Row[] = [];
	const users = rng.int(5, 7);
	const ids = rng.sample(
		Array.from({ length: 40 }, (_, i) => i + 10),
		users
	);
	ids.forEach((user, k) => {
		const platform = rng.pick(PLATFORMS);
		// The traps: a user with the first step twice and no second one, a user with both steps and a repeat.
		const plan =
			k === 0
				? [first, first]
				: k === 1
					? [first, second, first]
					: rng.pick([[first], [first, second], [second], [first, first], [first, second]]);
		for (const event of plan) rows.push([user, event, moment(rng), platform]);
	});
	const q = (having: string): string =>
		`SELECT user_id FROM ${table}\nWHERE event IN ('${first}', '${second}')\nGROUP BY user_id HAVING ${having}\nORDER BY user_id;`;
	return {
		setup: eventsSetup(table, rows, rng),
		query: q('COUNT(DISTINCT event) = 2'),
		wrong: { 'having-count-rows': q('COUNT(*) = 2') },
		purpose: `Аналитик ищет пользователей, сделавших и \`${first}\`, и \`${second}\`.`
	};
}

/** Event types with enough users: HAVING on distinct users after a filter by time. */
function havingUsers(rng: Rng): SqlDraft {
	const table = rng.pick(['events', 'app_events', 'tracking']);
	const types = rng.sample(['search', 'view', 'cart', 'share', 'review', 'purchase'], 4);
	const rows: Row[] = [];
	const users = rng.int(5, 7);
	const since = rng.int(5, 12);
	for (let user = 1; user <= users; user += 1) {
		const platform = rng.pick(PLATFORMS);
		for (let k = rng.int(2, 4); k > 0; k -= 1) {
			const event = rng.pick(types);
			// Some events before the start of the period, some users repeating an event.
			const ts = moment(rng);
			rows.push([user, event, ts, platform]);
			if (rng.bool(0.35)) rows.push([user, event, moment(rng), platform]);
		}
	}
	const threshold = rng.int(2, 3);
	const q = (having: string): string =>
		`SELECT event, COUNT(*), COUNT(DISTINCT user_id) FROM ${table}\nWHERE ts >= '2026-10-${String(since).padStart(2, '0')}'\nGROUP BY event HAVING ${having} >= ${threshold}\nORDER BY event;`;
	return {
		setup: eventsSetup(table, rows, rng),
		query: q('COUNT(DISTINCT user_id)'),
		wrong: { 'count-events': q('COUNT(*)') },
		purpose: `Аналитик ищет действия, которые с ${since} октября сделали хотя бы ${threshold} разных пользователя.`
	};
}

/** First moments of each step per user; a step counts only after the previous one. */
function orderedFunnel(rng: Rng): SqlDraft {
	const table = rng.pick(['events', 'app_events', 'tracking']);
	const rows: Row[] = [];
	const platforms = rng.sample(PLATFORMS, 2);
	let user = 0;
	for (const platform of platforms) {
		for (let k = rng.int(3, 4); k > 0; k -= 1) {
			user += 1;
			const start = moment(rng);
			const kind = rng.pick(['full', 'full', 'signup-first', 'purchase-before', 'visit-only', 'no-visit']);
			const at = (minutes: number): string => addMinutes(start, minutes);
			if (kind !== 'no-visit') rows.push([user, 'visit', at(kind === 'signup-first' ? 30 : 0), platform]);
			if (kind !== 'visit-only') rows.push([user, 'signup', at(kind === 'signup-first' ? 0 : 20), platform]);
			if (kind === 'full' || kind === 'signup-first') rows.push([user, 'purchase', at(rng.int(40, 600)), platform]);
			if (kind === 'purchase-before') rows.push([user, 'purchase', at(10), platform]);
		}
	}
	const step = (event: string): string => `MIN(CASE WHEN event = '${event}' THEN ts END) AS ${event[0]}`;
	const q = (signup: string, purchase: string): string =>
		`WITH f AS (\n  SELECT user_id, platform, ${step('visit')}, ${step('signup')}, ${step('purchase')}\n  FROM ${table} GROUP BY user_id, platform\n)\nSELECT platform, COUNT(v),\n       COUNT(CASE WHEN ${signup} THEN 1 END),\n       COUNT(CASE WHEN ${purchase} THEN 1 END)\nFROM f GROUP BY platform ORDER BY platform;`;
	return {
		setup: eventsSetup(table, rows, rng),
		query: q('s > v', 'p > s AND s > v'),
		wrong: {
			'ignore-order': q('s IS NOT NULL AND v IS NOT NULL', 'p IS NOT NULL AND s IS NOT NULL AND v IS NOT NULL')
		},
		purpose: 'Аналитик строит упорядоченную воронку «визит → регистрация → покупка» по первым моментам шагов.'
	};
}

/** A purchase within 24 hours after the signup, the boundary included; datetime() shifts the moment. */
function windowHours(rng: Rng): SqlDraft {
	const table = rng.pick(['events', 'app_events', 'tracking']);
	const hours = rng.pick([24, 48, 72]);
	const rows: Row[] = [];
	const platforms = rng.sample(PLATFORMS, 2);
	let user = 0;
	for (const platform of platforms) {
		for (let k = rng.int(3, 5); k > 0; k -= 1) {
			user += 1;
			const start = moment(rng);
			rows.push([user, 'signup', start, platform]);
			const kind = user === 1 ? 'edge' : user === 2 ? 'late' : rng.pick(['inside', 'late', 'none', 'edge', 'inside']);
			const offset =
				kind === 'edge'
					? hours * 60
					: kind === 'inside'
						? rng.int(5, hours * 60 - 5)
						: kind === 'late'
							? hours * 60 + rng.int(1, 600)
							: null;
			if (offset !== null) rows.push([user, 'purchase', addMinutes(start, offset), platform]);
		}
	}
	const q = (cond: string): string =>
		`WITH f AS (\n  SELECT user_id, platform,\n         MIN(CASE WHEN event = 'signup' THEN ts END) AS s,\n         MIN(CASE WHEN event = 'purchase' THEN ts END) AS p\n  FROM ${table} GROUP BY user_id, platform\n)\nSELECT platform, COUNT(s), COUNT(CASE WHEN ${cond} THEN 1 END)\nFROM f GROUP BY platform ORDER BY platform;`;
	const until = `datetime(s, '+${hours} hours')`;
	return {
		setup: eventsSetup(table, rows, rng),
		query: q(`p >= s AND p <= ${until}`),
		wrong: {
			'ignore-window': q('p >= s'),
			'strict-window': q(`p >= s AND p < ${until}`)
		},
		purpose: `Аналитик считает пользователей, купивших не позже чем через ${hours} ч после регистрации.`
	};
}

/** Cart-to-purchase conversion of sessions: a user's purchase in another session does not convert this one. */
function perSession(rng: Rng): SqlDraft {
	const table = rng.pick(['events', 'app_events', 'tracking']);
	const rows: Row[] = [];
	const platforms = rng.sample(PLATFORMS, 2);
	let user = 0;
	let session = rng.int(1, 9) * 100;
	for (const platform of platforms) {
		for (let k = rng.int(2, 3); k > 0; k -= 1) {
			user += 1;
			for (let s = rng.int(1, 3); s > 0; s -= 1) {
				session += rng.int(1, 7);
				// The trap: a user whose cart session has no purchase but another session has one.
				const plan = rng.pick([['view', 'cart'], ['cart', 'purchase'], ['view', 'purchase'], ['cart'], ['view']]);
				for (const event of plan) rows.push([user, session, event, platform]);
			}
		}
	}
	const q = (unit: string): string =>
		`WITH s AS (\n  SELECT ${unit}, platform, MAX(event = 'cart') AS c, MAX(event = 'purchase') AS p\n  FROM ${table} GROUP BY ${unit}, platform\n)\nSELECT platform, SUM(c), SUM(c * p), ROUND(100.0 * SUM(c * p) / SUM(c), 1)\nFROM s GROUP BY platform ORDER BY platform;`;
	return {
		setup: eventsSetup(table, rows, rng, true),
		query: q('session_id'),
		wrong: { 'per-user': q('user_id') },
		purpose: 'Аналитик считает конверсию сессий с корзиной в покупку по платформам.'
	};
}

/** The last step a user reached, by the order of steps: each user counts once, at the deepest step. */
function lastStep(rng: Rng): SqlDraft {
	const table = rng.pick(['events', 'app_events', 'tracking']);
	const steps = ['visit', 'signup', 'cart', 'purchase'];
	const rows: Row[] = [];
	const users = rng.int(6, 8);
	for (let user = 1; user <= users; user += 1) {
		const platform = rng.pick(PLATFORMS);
		const depth = rng.int(1, 4);
		for (const event of steps.slice(0, depth)) {
			rows.push([user, event, moment(rng), platform]);
			if (rng.bool(0.25)) rows.push([user, event, moment(rng), platform]);
		}
	}
	const rank = `CASE event WHEN 'visit' THEN 1 WHEN 'signup' THEN 2 WHEN 'cart' THEN 3 WHEN 'purchase' THEN 4 END`;
	const right = `WITH last AS (\n  SELECT user_id, MAX(${rank}) AS step FROM ${table} GROUP BY user_id\n)\nSELECT step, COUNT(*) FROM last GROUP BY step ORDER BY step;`;
	const reached = `SELECT ${rank} AS step, COUNT(DISTINCT user_id) FROM ${table} GROUP BY step ORDER BY step;`;
	return {
		setup: eventsSetup(table, rows, rng),
		query: right,
		wrong: { 'reached-not-last': reached },
		purpose:
			'Аналитик считает, сколько пользователей дошли до каждого шага воронки как до самого дальнего (по порядку шагов).'
	};
}

/** A draft redrawn until its log has `min`–`max` events, the size the time norm of the level is set for. */
function sized(draft: (rng: Rng) => SqlDraft, min: number, max: number): (rng: Rng) => SqlDraft {
	return (rng) => {
		for (let attempt = 0; attempt < 1000; attempt += 1) {
			const d = draft(rng);
			const events = d.setup.match(/^INSERT /gm)?.length ?? 0;
			if (events >= min && events <= max) return d;
		}
		throw new Error(`${descriptor.key}: no log of ${min}–${max} events after 1000 draws`);
	};
}

const DRAFTS: Record<string, (rng: Rng) => SqlDraft> = {
	'intern/unique-users': sized(uniqueUsers, 8, 25),
	'intern/conversion': sized(conversion, 8, 25),
	'intern/both-steps': sized(bothSteps, 8, 25),
	'intern/having-users': sized(havingUsers, 8, 25),
	'junior/ordered-funnel': sized(orderedFunnel, 10, 30),
	'junior/window-hours': sized(windowHours, 10, 30),
	'junior/per-session': sized(perSession, 10, 30),
	'junior/last-step': sized(lastStep, 10, 30)
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
