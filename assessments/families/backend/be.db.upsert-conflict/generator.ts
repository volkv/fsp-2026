// Conflicts on insert: the state of a table after a series of INSERT OR IGNORE, INSERT OR REPLACE and
// INSERT … ON CONFLICT … DO UPDATE statements.
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
import { runSql, sqlProbeSource, sqlText, SQL_ROW_FORMAT } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

type Value = string | number | null;

/** A SET item of DO UPDATE: the expression from the value in the table and the inserted value of a column. */
interface SetItem {
	col: string;
	expr: (old: (c: string) => string, inserted: (c: string) => string) => string;
}

type Stmt =
	| { kind: 'insert' | 'ignore' | 'replace'; cols: string[]; values: Value[] }
	| {
			kind: 'upsert';
			cols: string[];
			values: Value[];
			target: string[];
			set: SetItem[] | null;
			where: SetItem['expr'] | null;
			/** Further rows of the same statement (`VALUES (…), (…)`). */
			more?: Value[][];
	  };

/** How the misconception renders a statement; the shown script uses `RIGHT`. */
interface Semantics {
	replaceAsUpdate: boolean;
	ignoreOverwrites: boolean;
	swapExcluded: boolean;
	upsertOverwrites: boolean;
	ignoreWhere: boolean;
}

const RIGHT: Semantics = {
	replaceAsUpdate: false,
	ignoreOverwrites: false,
	swapExcluded: false,
	upsertOverwrites: false,
	ignoreWhere: false
};

interface Scenario {
	table: string;
	ddl: string;
	/** The unique key REPLACE and IGNORE conflict on, as the misconceptions rewrite them. */
	key: string[];
	statements: Stmt[];
	query: string;
	/** Misconception id → how it renders the script; the null-conflicts misconception rewrites the data instead. */
	wrong: Record<string, Partial<Semantics> | 'null-sentinel'>;
	/** Columns of the final query that may hold NULL keys (for the null-conflicts rewrite). */
	nullable?: string;
}

function literal(v: Value): string {
	return v === null ? 'NULL' : typeof v === 'number' ? String(v) : sqlText(v);
}

function render(table: string, key: string[], s: Stmt, sem: Semantics): string {
	const head = (verb: string): string =>
		`${verb} INTO ${table} (${s.cols.join(', ')}) VALUES ${[s.values, ...(s.kind === 'upsert' ? (s.more ?? []) : [])]
			.map((row) => `(${row.map(literal).join(', ')})`)
			.join(', ')}`;
	const overwrite = (): string =>
		`${head('INSERT')} ON CONFLICT(${key.join(', ')}) DO UPDATE SET ${s.cols
			.filter((c) => !key.includes(c))
			.map((c) => `${c} = excluded.${c}`)
			.join(', ')};`;
	if (s.kind !== 'upsert') {
		if (s.kind === 'insert') return `${head('INSERT')};`;
		if (s.kind === 'ignore') return sem.ignoreOverwrites ? overwrite() : `${head('INSERT OR IGNORE')};`;
		return sem.replaceAsUpdate ? overwrite() : `${head('INSERT OR REPLACE')};`;
	}
	const old = (c: string): string => (sem.swapExcluded ? `excluded.${c}` : c);
	const inserted = (c: string): string => (sem.swapExcluded ? c : `excluded.${c}`);
	const target = `ON CONFLICT(${s.target.join(', ')})`;
	if (s.set === null) return `${head('INSERT')} ${target} DO NOTHING;`;
	const set = sem.upsertOverwrites
		? s.cols.filter((c) => !s.target.includes(c)).map((c) => `${c} = excluded.${c}`)
		: s.set.map((item) => `${item.col} = ${item.expr(old, inserted)}`);
	const where = s.where && !sem.ignoreWhere ? ` WHERE ${s.where(old, inserted)}` : '';
	return `${head('INSERT')} ${target} DO UPDATE SET ${set.join(', ')}${where};`;
}

function script(sc: Scenario, sem: Semantics, statements: readonly Stmt[] = sc.statements): string {
	return [sc.ddl, ...statements.map((s) => render(sc.table, sc.key, s, sem))].join('\n');
}

const DOMAINS = ['mail.ru', 'ya.ru', 'corp.io', 'inbox.dev'] as const;

/** Distinct people with e-mails. */
function people(rng: Rng, n: number): { name: string; email: string }[] {
	const domain = rng.pick(DOMAINS);
	return rng.sample(PERSON_NAMES, n).map((name) => ({ name, email: `${name}@${domain}` }));
}

const USERS_DDL = (table: string): string =>
	`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, visits INTEGER NOT NULL DEFAULT 0);`;

function renamed(rng: Rng, name: string): string {
	return `${name}_${rng.pick(['new', 'v2', 'x', 'pro'])}`;
}

function replaceRow(rng: Rng): Scenario {
	const table = rng.pick(['users', 'accounts', 'members']);
	const ps = people(rng, 6);
	const initial = ps.slice(0, 4);
	const statements: Stmt[] = initial.map((p) => ({
		kind: 'insert',
		cols: ['email', 'name', 'visits'],
		values: [p.email, p.name, rng.int(1, 9)]
	}));
	const fresh = ps.slice(4);
	const targets = rng.sample(initial.slice(0, 3), 2);
	const series: Stmt[] = [
		...targets.map((p): Stmt => ({
			kind: 'replace',
			cols: ['email', 'name'],
			values: [p.email, renamed(rng, p.name)]
		})),
		{ kind: 'replace', cols: ['email', 'name'], values: [fresh[0]?.email ?? '', fresh[0]?.name ?? ''] },
		{
			kind: 'ignore',
			cols: ['email', 'name', 'visits'],
			values: [initial[3]?.email ?? '', renamed(rng, initial[3]?.name ?? ''), rng.int(10, 20)]
		}
	];
	statements.push(...rng.shuffle(series));
	return {
		table,
		ddl: USERS_DDL(table),
		key: ['email'],
		statements,
		query: `SELECT id, email, name, visits FROM ${table} ORDER BY id;`,
		wrong: { 'replace-as-update': { replaceAsUpdate: true } }
	};
}

function ignoreFirstWins(rng: Rng): Scenario {
	const table = rng.pick(['users', 'accounts', 'members']);
	const ps = people(rng, 6);
	const statements: Stmt[] = [];
	const seen: { email: string; name: string }[] = [];
	for (let i = 0; i < rng.int(6, 7); i += 1) {
		// Every other statement repeats an e-mail already inserted, with another name and number of visits.
		const repeat = seen.length > 0 && (i === 2 || (i > 2 && rng.bool(0.45)));
		const p = repeat ? rng.pick(seen) : ps.find((x) => !seen.some((s) => s.email === x.email));
		if (!p) break;
		const name = repeat ? renamed(rng, p.name) : p.name;
		if (!repeat) seen.push(p);
		statements.push({ kind: 'ignore', cols: ['email', 'name', 'visits'], values: [p.email, name, rng.int(1, 9)] });
	}
	return {
		table,
		ddl: USERS_DDL(table),
		key: ['email'],
		statements,
		query: `SELECT id, email, name, visits FROM ${table} ORDER BY id;`,
		wrong: { 'ignore-overwrites': { ignoreOverwrites: true } }
	};
}

const SKUS = ['ab', 'cd', 'ef', 'gh', 'kl', 'mn', 'pq', 'rs'] as const;

function skus(rng: Rng, n: number): string[] {
	const base = rng.int(100, 899);
	return rng.sample(SKUS, n).map((s, i) => `${s}-${base + i * rng.int(1, 9)}`);
}

function doUpdate(rng: Rng): Scenario {
	const table = rng.pick(['stock', 'inventory', 'warehouse']);
	const codes = skus(rng, 3);
	const statements: Stmt[] = [];
	const add: SetItem = { col: 'qty', expr: (o, n) => `${o('qty')} + ${n('qty')}` };
	const setQty: SetItem = { col: 'qty', expr: (_o, n) => n('qty') };
	const lowPrice: SetItem = { col: 'price', expr: (o, n) => `MIN(${o('price')}, ${n('price')})` };
	const newPrice: SetItem = { col: 'price', expr: (_o, n) => n('price') };
	const bump: SetItem = { col: 'qty', expr: (o) => `${o('qty')} + 1` };
	const sets: SetItem[][] = [[add, newPrice], [add, lowPrice], [setQty], [bump], [add]];
	const upsert = (sku: string, set: SetItem[] | null): Stmt => ({
		kind: 'upsert',
		cols: ['sku', 'qty', 'price'],
		values: [sku, rng.int(1, 9) * 5, rng.int(10, 90) * 10],
		target: ['sku'],
		set,
		where: null
	});
	for (const sku of codes) statements.push(upsert(sku, rng.pick(sets)));
	// Conflicts: the order mixes accumulation, replacement and a DO NOTHING.
	const series = rng.shuffle([
		upsert(codes[0] ?? '', sets[0] ?? null),
		upsert(codes[1] ?? '', rng.pick([sets[2] ?? null, sets[3] ?? null])),
		upsert(codes[rng.int(0, 2)] ?? '', rng.pick([sets[1] ?? null, sets[4] ?? null])),
		upsert(codes[2] ?? '', rng.bool(0.3) ? null : (sets[0] ?? null))
	]);
	statements.push(...series);
	return {
		table,
		ddl: `CREATE TABLE ${table} (sku TEXT PRIMARY KEY, qty INTEGER NOT NULL, price INTEGER NOT NULL);`,
		key: ['sku'],
		statements,
		query: `SELECT sku, qty, price FROM ${table} ORDER BY sku;`,
		wrong: { 'excluded-is-old': { swapExcluded: true }, 'upsert-overwrites': { upsertOverwrites: true } }
	};
}

function compositeNull(rng: Rng): Scenario {
	const table = rng.pick(['daily_hits', 'page_views', 'logins']);
	const users = rng.sample([11, 12, 13, 14, 15, 16, 17, 18, 19], 2);
	const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
	const statements: Stmt[] = [];
	const set: SetItem[] = [
		{ col: 'hits', expr: (o, n) => `${o('hits')} + ${n('hits')}` },
		{ col: 'source', expr: (_o, n) => n('source') }
	];
	const hit = (user: number, day: string | null): Stmt => ({
		kind: 'upsert',
		cols: ['user_id', 'day', 'hits', 'source'],
		values: [user, day, rng.int(1, 9), rng.pick(['web', 'ios', 'android', 'api'])],
		target: ['user_id', 'day'],
		set,
		where: null
	});
	const u0 = users[0] ?? 11;
	const u1 = users[1] ?? 12;
	const d0 = rng.pick(days);
	// The traps: the same user on the same day twice, the same day for another user, a NULL day twice.
	const series = [hit(u0, d0), hit(u1, d0), hit(u0, null), hit(u0, d0), hit(u0, null)];
	for (let k = rng.int(1, 3); k > 0; k -= 1) series.push(hit(rng.pick(users), rng.bool(0.3) ? null : rng.pick(days)));
	statements.push(...series.slice(0, 1), ...rng.shuffle(series.slice(1)));
	return {
		table,
		ddl: `CREATE TABLE ${table} (user_id INTEGER NOT NULL, day TEXT, hits INTEGER NOT NULL, source TEXT NOT NULL, UNIQUE (user_id, day));`,
		key: ['user_id', 'day'],
		statements,
		query: `SELECT user_id, day, hits, source FROM ${table} ORDER BY user_id, day, rowid;`,
		wrong: { 'null-conflicts': 'null-sentinel', 'excluded-is-old': { swapExcluded: true } },
		nullable: 'day'
	};
}

function updateWhere(rng: Rng): Scenario {
	const table = rng.pick(['prices', 'catalog', 'offers']);
	const codes = skus(rng, 3);
	const set: SetItem[] = [
		{ col: 'price', expr: (_o, n) => n('price') },
		{ col: 'version', expr: (_o, n) => n('version') }
	];
	const newer: SetItem['expr'] = (o, n) => `${n('version')} > ${o('version')}`;
	const statements: Stmt[] = [];
	const put = (sku: string, version: number): Stmt => ({
		kind: 'upsert',
		cols: ['sku', 'price', 'version'],
		values: [sku, rng.int(10, 99) * 10, version],
		target: ['sku'],
		set,
		where: newer
	});
	const start = codes.map(() => rng.int(1, 4));
	codes.forEach((sku, i) => statements.push(put(sku, start[i] ?? 1)));
	// The traps: a stale update (lower version), an equal version, a newer one.
	const series = [
		put(codes[0] ?? '', (start[0] ?? 1) + rng.int(1, 3)),
		put(codes[1] ?? '', (start[1] ?? 1) - rng.int(0, 1)),
		put(codes[2] ?? '', (start[2] ?? 1) + rng.int(1, 2)),
		put(codes[2] ?? '', (start[2] ?? 1) + rng.int(0, 1)),
		put(codes[rng.int(0, 2)] ?? '', rng.int(1, 6))
	];
	statements.push(...rng.shuffle(series));
	return {
		table,
		ddl: `CREATE TABLE ${table} (sku TEXT PRIMARY KEY, price INTEGER NOT NULL, version INTEGER NOT NULL);`,
		key: ['sku'],
		statements,
		query: `SELECT sku, price, version FROM ${table} ORDER BY sku;`,
		wrong: { 'where-ignored': { ignoreWhere: true }, 'excluded-is-old': { swapExcluded: true } }
	};
}

function mixedSeries(rng: Rng): Scenario {
	const table = rng.pick(['users', 'accounts', 'members']);
	const ps = people(rng, 6);
	const initial = ps.slice(0, 4);
	const statements: Stmt[] = initial.map((p) => ({
		kind: 'insert',
		cols: ['email', 'name', 'visits'],
		values: [p.email, p.name, rng.int(1, 9)]
	}));
	const visit: SetItem[] = [
		{ col: 'visits', expr: (o) => `${o('visits')} + 1` },
		{ col: 'name', expr: (_o, n) => n('name') }
	];
	const [a, b, c] = rng.sample(initial.slice(0, 3), 3);
	const fresh = ps[4];
	const series: Stmt[] = [
		{ kind: 'replace', cols: ['email', 'name'], values: [a?.email ?? '', renamed(rng, a?.name ?? '')] },
		{ kind: 'ignore', cols: ['email', 'name', 'visits'], values: [b?.email ?? '', renamed(rng, b?.name ?? ''), 0] },
		{
			kind: 'upsert',
			cols: ['email', 'name', 'visits'],
			values: [c?.email ?? '', renamed(rng, c?.name ?? ''), rng.int(20, 30)],
			target: ['email'],
			set: visit,
			where: null
		},
		{
			kind: 'upsert',
			cols: ['email', 'name', 'visits'],
			values: [a?.email ?? '', renamed(rng, a?.name ?? ''), rng.int(20, 30)],
			target: ['email'],
			set: visit,
			where: null
		},
		{ kind: 'insert', cols: ['email', 'name'], values: [fresh?.email ?? '', fresh?.name ?? ''] }
	];
	statements.push(...rng.shuffle(series));
	return {
		table,
		ddl: USERS_DDL(table),
		key: ['email'],
		statements,
		query: `SELECT id, email, name, visits FROM ${table} ORDER BY id;`,
		wrong: {
			'replace-as-update': { replaceAsUpdate: true },
			'ignore-overwrites': { ignoreOverwrites: true },
			'excluded-is-old': { swapExcluded: true }
		}
	};
}

function primaryKeyReplace(rng: Rng): Scenario {
	const table = rng.pick(['users', 'accounts', 'members']);
	const ps = people(rng, 7);
	const initial = ps.slice(0, 4);
	const statements: Stmt[] = initial.map((p) => ({
		kind: 'insert',
		cols: ['email', 'name', 'visits'],
		values: [p.email, p.name, rng.int(1, 9)]
	}));
	// Conflicts on the primary key, not on the e-mail: REPLACE swaps the whole row with id k, IGNORE keeps it.
	const [k1, k2] = rng.sample([1, 2, 3, 4], 2) as [number, number];
	const fresh = ps.slice(4);
	const series: Stmt[] = [
		{ kind: 'replace', cols: ['id', 'email', 'name'], values: [k1, fresh[0]?.email ?? '', fresh[0]?.name ?? ''] },
		{
			kind: 'ignore',
			cols: ['id', 'email', 'name', 'visits'],
			values: [k2, fresh[1]?.email ?? '', fresh[1]?.name ?? '', rng.int(10, 20)]
		}
	];
	statements.push(...rng.shuffle(series), {
		kind: 'insert',
		cols: ['email', 'name'],
		values: [fresh[2]?.email ?? '', fresh[2]?.name ?? '']
	});
	return {
		table,
		ddl: USERS_DDL(table),
		key: ['id'],
		statements,
		query: `SELECT id, email, name, visits FROM ${table} ORDER BY id;`,
		wrong: { 'replace-as-update': { replaceAsUpdate: true }, 'ignore-overwrites': { ignoreOverwrites: true } }
	};
}

function multiRowUpsert(rng: Rng): Scenario {
	const table = rng.pick(['stock', 'inventory', 'warehouse']);
	const codes = skus(rng, 4);
	const [a, b, c, d] = codes as [string, string, string, string];
	const set: SetItem[] = [
		{ col: 'qty', expr: (o, n) => `${o('qty')} + ${n('qty')}` },
		{ col: 'price', expr: (_o, n) => n('price') }
	];
	const row = (sku: string): Value[] => [sku, rng.int(1, 9) * 5, rng.int(10, 90) * 10];
	const statements: Stmt[] = [a, b].map((sku) => ({ kind: 'insert', cols: ['sku', 'qty', 'price'], values: row(sku) }));
	// One statement with several rows: a row conflicts with a row inserted earlier in the same statement as well as
	// with the rows already in the table.
	const batch = rng.shuffle([row(a), row(c), row(c), row(rng.pick([b, d]))]);
	statements.push({
		kind: 'upsert',
		cols: ['sku', 'qty', 'price'],
		values: batch[0] ?? [],
		more: batch.slice(1),
		target: ['sku'],
		set,
		where: null
	});
	if (rng.bool())
		statements.push({
			kind: 'upsert',
			cols: ['sku', 'qty', 'price'],
			values: row(rng.pick([a, c])),
			more: [row(d)],
			target: ['sku'],
			set: null,
			where: null
		});
	return {
		table,
		ddl: `CREATE TABLE ${table} (sku TEXT PRIMARY KEY, qty INTEGER NOT NULL, price INTEGER NOT NULL);`,
		key: ['sku'],
		statements,
		query: `SELECT sku, qty, price FROM ${table} ORDER BY sku;`,
		wrong: { 'excluded-is-old': { swapExcluded: true }, 'upsert-overwrites': { upsertOverwrites: true } }
	};
}

const SCENARIOS: Record<string, (rng: Rng) => Scenario> = {
	'junior/primary-key-replace': primaryKeyReplace,
	'middle/multi-row-upsert': multiRowUpsert,
	'junior/replace-row': replaceRow,
	'junior/do-update': doUpdate,
	'junior/ignore-first-wins': ignoreFirstWins,
	'middle/composite-null': compositeNull,
	'middle/update-where': updateWhere,
	'middle/mixed-series': mixedSeries
};

/** REPLACE of the row with the largest id: whether the new row reuses the id is an implementation detail, avoided. */
function replacesLargestId(sc: Scenario): boolean {
	return sc.statements.some((s, i) => {
		if (s.kind !== 'replace') return false;
		const before = script(sc, RIGHT, sc.statements.slice(0, i));
		const [flag] = runSql(
			before,
			`SELECT (SELECT MAX(id) FROM ${sc.table}) = (SELECT id FROM ${sc.table} WHERE email = ${literal(s.values[0] ?? null)});`
		);
		return flag === '1';
	});
}

/** The same series with NULL keys replaced by a marker value that conflicts like any other value. */
function nullSentinelRows(sc: Scenario): string[] {
	const marker = '(none)';
	const statements = sc.statements.map((s) => ({
		...s,
		values: s.values.map((v, i) => (s.cols[i] === sc.nullable && v === null ? marker : v))
	})) as Stmt[];
	const column = sc.nullable ?? '';
	return runSql(
		script(sc, RIGHT, statements),
		sc.query.replace(/^SELECT (.*) FROM/, (_m, cols: string) => {
			const list = cols
				.split(', ')
				.map((c) => (c === column ? `NULLIF(${c}, ${sqlText(marker)})` : c))
				.join(', ');
			return `SELECT ${list} FROM`;
		})
	);
}

function sameRows(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

function statementText(): string {
	return [
		'Скрипт выполняется целиком, ни один оператор не завершается ошибкой. Что вернёт последний запрос?',
		'База — SQLite: столбец `INTEGER PRIMARY KEY` без явного значения получает наибольший id таблицы + 1.',
		'',
		SQL_ROW_FORMAT
	].join('\n');
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const make = SCENARIOS[`${input.grade}/${input.classId}`];
	if (!make) throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId}`);
	// Scenarios are drawn until every misconception of the class changes the result.
	for (let tries = 0; tries < 200; tries += 1) {
		const sc = make(rng);
		const setup = script(sc, RIGHT);
		const answer = runSql(setup, sc.query);
		const wrong: Record<string, string[]> = Object.fromEntries(
			Object.entries(sc.wrong).map(([id, sem]) => [
				id,
				sem === 'null-sentinel' ? nullSentinelRows(sc) : runSql(script(sc, { ...RIGHT, ...sem }), sc.query)
			])
		);
		if (Object.values(wrong).some((rows) => sameRows(rows, answer))) continue;
		if (replacesLargestId(sc)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: statementText(), code: { language: 'sql', source: `${setup}\n\n${sc.query}` } },
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: sqlProbeSource(setup, sc.query), stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					descriptor.wrongSolutions.map(({ id }) => {
						const rows = wrong[id];
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
