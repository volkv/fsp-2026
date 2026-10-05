// Reconciliation after a migration or a load: the tester compares the source and the target with EXCEPT, with sums
// per group, with rows found on one side only (two LEFT JOINs under UNION — no FULL JOIN) and looks for duplicates
// after the load; the result of the shown check on a generated pair of tables.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { CITY_NAMES, PERSON_NAMES } from '../../_lib/names.ts';
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

const NULL_ORDER = 'В SQLite NULL при сортировке по возрастанию идёт раньше любого значения.';

const ids = (rng: Rng, n: number, lo: number, hi: number): number[] =>
	rng.sample(
		Array.from({ length: hi - lo + 1 }, (_, i) => lo + i),
		n
	);

function exceptDiff(rng: Rng): Draft {
	const rowIds = ids(rng, rng.int(6, 8), 10, 99);
	const src: Row[] = rowIds.map((id, i) => [
		id,
		`${PERSON_NAMES[i] ?? 'anna'}@${rng.pick(['mail.ru', 'ya.ru', 'corp.ru'])}`,
		rng.int(1, 40) * 50,
		i < 2 || rng.bool(0.25) ? null : rng.pick(CITY_NAMES)
	]);
	const dst: Row[] = src.map((r) => [...r]);
	// Changes in transit: a changed amount, e-mail or city, and a lost row; the rows with a NULL city stay unchanged.
	const changeable = dst.filter((r) => r[3] !== null);
	for (const row of rng.sample(changeable, Math.min(changeable.length, rng.int(1, 2)))) {
		const way = rng.int(0, 2);
		if (way === 0) row[1] = String(row[1]).toUpperCase();
		else if (way === 1) row[2] = Number(row[2]) + rng.int(1, 9) * 10;
		else row[3] = null;
	}
	const lost = rng.int(2, dst.length - 1);
	const lostRow = dst[lost];
	dst.splice(lost, 1);
	// The legacy source has no key: one row is there twice.
	const doubled = src.find((r) => r[0] === lostRow?.[0]) ?? src[0];
	if (doubled) src.push([...doubled]);
	const ddl = (t: string): string => `CREATE TABLE ${t} (id INTEGER, email TEXT, amount INTEGER, city TEXT);`;
	const cols = ['id', 'email', 'amount', 'city'];
	const setup = [
		ddl('src'),
		ddl('dst'),
		insertRows('src', cols, rng.shuffle(src)),
		insertRows('dst', cols, rng.shuffle(dst))
	].join('\n');
	const match = (op: string): string =>
		`NOT EXISTS (SELECT 1 FROM dst d WHERE d.id ${op} s.id AND d.email ${op} s.email AND d.amount ${op} s.amount AND d.city ${op} s.city)`;
	return {
		setup,
		query: 'SELECT * FROM src EXCEPT SELECT * FROM dst ORDER BY id;',
		wrong: {
			'except-null-distinct': `SELECT DISTINCT * FROM src s WHERE ${match('=')} ORDER BY id;`,
			'except-keeps-duplicates': `SELECT * FROM src s WHERE ${match('IS')} ORDER BY id;`
		},
		purpose:
			'После переноса клиентов из старой системы (`src`, без первичного ключа) в новую (`dst`) тестировщик ищет строки источника, которых нет в приёмнике в точности.'
	};
}

function groupSums(rng: Rng): Draft {
	const regions = rng.sample(CITY_NAMES, rng.int(4, 5));
	const src: Row[] = [];
	for (const region of regions) for (let i = rng.int(1, 3); i > 0; i -= 1) src.push([region, rng.int(1, 40) * 50]);
	let dst: Row[] = src.map((r) => [...r]);
	const [gone, blank, changed] = rng.shuffle(regions);
	// A region lost in the load, a region whose amounts came as NULL, a region with one amount changed.
	dst = dst.filter((r) => r[0] !== gone);
	for (const r of dst) if (r[0] === blank) r[1] = null;
	const victim = dst.find((r) => r[0] === changed);
	if (victim) victim[1] = Number(victim[1]) + rng.int(1, 9) * 10 * (rng.bool() ? 1 : -1);
	const srcIds = ids(rng, src.length, 1, 99);
	const dstIds = ids(rng, dst.length, 100, 199);
	const setup = [
		'CREATE TABLE src (id INTEGER PRIMARY KEY, region TEXT NOT NULL, amount INTEGER);',
		'CREATE TABLE dst (id INTEGER PRIMARY KEY, region TEXT NOT NULL, amount INTEGER);',
		insertRows(
			'src',
			['id', 'region', 'amount'],
			rng.shuffle(src).map((r, i) => [srcIds[i] ?? 0, ...r])
		),
		insertRows(
			'dst',
			['id', 'region', 'amount'],
			rng.shuffle(dst).map((r, i) => [dstIds[i] ?? 0, ...r])
		)
	].join('\n');
	const q = (cmp: string): string =>
		`SELECT s.region, s.total, d.total FROM (SELECT region, SUM(amount) AS total FROM src GROUP BY region) s LEFT JOIN (SELECT region, SUM(amount) AS total FROM dst GROUP BY region) d ON d.region = s.region WHERE s.total ${cmp} d.total ORDER BY s.region;`;
	return {
		setup,
		query: q('<>'),
		wrong: { 'ne-catches-null': q('IS NOT') },
		purpose: 'Тестировщик сверяет суммы платежей по регионам между источником `src` и приёмником `dst` после загрузки.'
	};
}

function oneSideRows(rng: Rng): Draft {
	const pool = ids(rng, 12, 10, 99);
	const common = pool.slice(0, rng.int(3, 5));
	const srcOnly = pool.slice(6, 6 + rng.int(1, 2));
	const dstOnly = pool.slice(9, 9 + rng.int(1, 2));
	const name = (): string => rng.pick(PERSON_NAMES);
	const src: Row[] = [...common, ...srcOnly].map((id) => [id, name()]);
	const dst: Row[] = [...common, ...dstOnly].map((id) => [id, name()]);
	// A source record entered twice, and records without a key on both sides.
	const twice = rng.pick(srcOnly);
	src.push([twice, name()]);
	src.push([null, name()]);
	for (let i = rng.int(1, 2); i > 0; i -= 1) dst.push([null, name()]);
	const setup = [
		'CREATE TABLE src (id INTEGER, name TEXT NOT NULL);',
		'CREATE TABLE dst (id INTEGER, name TEXT NOT NULL);',
		insertRows('src', ['id', 'name'], rng.shuffle(src)),
		insertRows('dst', ['id', 'name'], rng.shuffle(dst))
	].join('\n');
	const q = (op: string, union: string): string =>
		`SELECT s.id, 'src only' FROM src s LEFT JOIN dst d ON d.id ${op} s.id WHERE d.name IS NULL ${union} SELECT d.id, 'dst only' FROM dst d LEFT JOIN src s ON s.id ${op} d.id WHERE s.name IS NULL ORDER BY 1, 2;`;
	return {
		setup,
		query: q('=', 'UNION'),
		wrong: { 'union-all': q('=', 'UNION ALL'), 'null-key-matches': q('IS', 'UNION') },
		purpose: `Тестировщик ищет записи, которые есть только в источнике \`src\` или только в приёмнике \`dst\`. ${NULL_ORDER}`
	};
}

function loadDuplicates(rng: Rng): Draft {
	const keys = ids(rng, rng.int(5, 7), 100, 999);
	const batches = rng.sample(['b1', 'b2', 'b3', 'b4'], 3);
	const rows: Row[] = keys.map((id) => [id, rng.pick(PERSON_NAMES), rng.pick(batches)]);
	const [x, y] = rng.sample(keys, 2);
	// An id loaded twice in different batches, one loaded twice with the batch lost, rows without an id.
	rows.push([x ?? 0, rng.pick(PERSON_NAMES), rng.pick(batches)]);
	rows.push([y ?? 0, rng.pick(PERSON_NAMES), null]);
	for (let i = rng.int(2, 3); i > 0; i -= 1)
		rows.push([null, rng.pick(PERSON_NAMES), rng.bool(0.4) ? null : rng.pick(batches)]);
	if (rng.bool(0.5)) rows.push([rng.pick(keys), rng.pick(PERSON_NAMES), rng.pick(batches)]);
	const setup = [
		'CREATE TABLE dst (id INTEGER, name TEXT NOT NULL, batch TEXT);',
		insertRows('dst', ['id', 'name', 'batch'], rng.shuffle(rows))
	].join('\n');
	const q = (distinct: string, where: string): string =>
		`SELECT id, COUNT(*), COUNT(DISTINCT ${distinct}) FROM dst ${where}GROUP BY id HAVING COUNT(*) > 1 ORDER BY id;`;
	return {
		setup,
		query: q('batch', ''),
		wrong: {
			'null-group-excluded': q('batch', 'WHERE id IS NOT NULL '),
			'distinct-counts-null': q("COALESCE(batch, '-')", '')
		},
		purpose: `После загрузки тестировщик ищет записи, загруженные больше одного раза, и считает, из скольких партий они пришли. ${NULL_ORDER}`
	};
}

const DRAFTS: Record<string, (rng: Rng) => Draft> = {
	'middle/except-diff': exceptDiff,
	'middle/group-sums': groupSums,
	'middle/one-side-rows': oneSideRows,
	'middle/load-duplicates': loadDuplicates
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
