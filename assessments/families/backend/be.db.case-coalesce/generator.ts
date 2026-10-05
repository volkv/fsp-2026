// Expressions in a row: the branch CASE takes, what COALESCE and NULLIF return, how numbers stored as text compare and
// sort, and sorting by a CASE expression.
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
import { insertRows, runSql, sqlProbeSource, sqlText, SQL_ROW_FORMAT } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

interface Draft {
	setup: string;
	query: string;
	/** The rows a misconception gives, by its id; a misconception absent here does not apply to the class. */
	wrong: Record<string, string[]>;
}

const GOODS = ['cable', 'mouse', 'lamp', 'chair', 'desk', 'monitor', 'webcam', 'dock', 'stand', 'hub'] as const;

function caseFirstMatch(rng: Rng): Draft {
	const table = rng.pick(['products', 'goods', 'items']);
	const bulk = rng.int(5, 12);
	const premium = rng.int(5, 20) * 100;
	const names = rng.sample(GOODS, rng.int(7, 9));
	const rows = names.map((name, i) => {
		// The traps: the first rows match both branches, then each branch alone, then neither.
		const many = i < 2 || (i >= 4 && rng.bool());
		const dear = i < 2 || i === 3 || (i >= 4 && rng.bool());
		const qty = many ? bulk + rng.int(0, 10) : rng.int(1, bulk - 1);
		const price = dear ? premium + rng.int(0, 10) * 100 : rng.int(1, premium / 100 - 1) * 100;
		return [name, qty, price];
	});
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL, price INTEGER NOT NULL);\n${insertRows(table, ['id', 'name', 'qty', 'price'], ids)}`;
	const bulkWhen = `WHEN qty >= ${bulk} THEN 'bulk'`;
	const premiumWhen = `WHEN price >= ${premium} THEN 'premium'`;
	const q = (whens: string): string =>
		`SELECT name, qty, price, CASE ${whens} ELSE 'regular' END AS kind FROM ${table} ORDER BY id;`;
	const [first, second] = rng.bool() ? [bulkWhen, premiumWhen] : [premiumWhen, bulkWhen];
	return {
		setup,
		query: q(`${first} ${second}`),
		wrong: { 'case-last-match': runSql(setup, q(`${second} ${first}`)) }
	};
}

function coalesceNullif(rng: Rng): Draft {
	const table = rng.pick(['contacts', 'clients', 'leads']);
	const names = rng.sample(PERSON_NAMES, rng.int(6, 8));
	const rows = names.map((name, i) => {
		// The traps: an empty phone with an e-mail, NULL phone with an e-mail, nothing at all; zero and nonzero discounts.
		const phone =
			i === 0
				? ''
				: i === 1 || i === 2
					? null
					: rng.bool(0.3)
						? ''
						: rng.bool(0.3)
							? null
							: `+7900${rng.int(1000000, 9999999)}`;
		const email = i === 2 ? null : rng.bool(0.8) ? `${name}@mail.ru` : null;
		const discount = i === 3 ? 0 : i === 4 ? rng.int(1, 4) * 5 : rng.pick([0, 0, 5, 10, 15]);
		return [name, phone, email, discount];
	});
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, discount INTEGER NOT NULL);\n${insertRows(table, ['id', 'name', 'phone', 'email', 'discount'], ids)}`;
	const q = (contact: string, nullif: string): string =>
		`SELECT name, '<' || ${contact} || '>' AS contact, ${nullif} AS discount FROM ${table} ORDER BY id;`;
	const contact = "COALESCE(phone, email, 'none')";
	const nullif = 'NULLIF(discount, 0)';
	return {
		setup,
		query: q(contact, nullif),
		wrong: {
			'empty-is-null': runSql(setup, q("COALESCE(NULLIF(phone, ''), email, 'none')", nullif)),
			'nullif-inverted': runSql(setup, q(contact, 'CASE WHEN discount <> 0 THEN NULL ELSE discount END'))
		}
	};
}

function textNumberCompare(rng: Rng): Draft {
	const table = rng.pick(['releases', 'builds', 'versions']);
	const bound = rng.int(2, 6) * 10;
	const used = new Set<number>();
	const values: number[] = [];
	const add = (v: number): void => {
		if (!used.has(v)) {
			used.add(v);
			values.push(v);
		}
	};
	// The traps: one-digit numbers above the bound as text, three-digit numbers below it as text.
	add(rng.int(Math.floor(bound / 10) + 1, 9));
	add(rng.int(100, 199));
	add(bound + rng.int(1, 9));
	add(rng.int(10, bound - 1));
	for (let k = rng.int(2, 4); k > 0; k -= 1) add(rng.pick([rng.int(1, 9), rng.int(10, 99), rng.int(100, 999)]));
	const names = rng.sample(GOODS, values.length);
	const ids = rng.shuffle(values.map((v, i) => [names[i] ?? '', String(v)])).map((r, i) => [i + 1, ...r]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, build TEXT NOT NULL);\n${insertRows(table, ['id', 'name', 'build'], ids)}`;
	return {
		setup,
		query: `SELECT name, build FROM ${table} WHERE build > ${sqlText(String(bound))} ORDER BY build;`,
		wrong: {
			'text-as-number': runSql(
				setup,
				`SELECT name, build FROM ${table} WHERE CAST(build AS INTEGER) > ${bound} ORDER BY CAST(build AS INTEGER);`
			)
		}
	};
}

function orderByCase(rng: Rng): Draft {
	const table = rng.pick(['tickets', 'tasks', 'incidents']);
	const levels = ['high', 'normal', 'low'];
	const n = rng.int(6, 8);
	const created = rng.sample(
		Array.from({ length: 40 }, (_, i) => i + 1),
		n
	);
	// Every level is present, so the order of the CASE differs from the alphabetical one.
	const rows = created.map((c, i) => [levels[i % 3] ?? 'low', c]);
	const ids = rng.shuffle(rows).map((r, i) => [i + 1, ...r]);
	const setup = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, priority TEXT NOT NULL, created INTEGER NOT NULL);\n${insertRows(table, ['id', 'priority', 'created'], ids)}`;
	const rank = "CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";
	return {
		setup,
		query: `SELECT id, priority, created FROM ${table} ORDER BY ${rank}, created DESC;`,
		wrong: {
			'sort-by-label': runSql(setup, `SELECT id, priority, created FROM ${table} ORDER BY priority, created DESC;`)
		}
	};
}

const DRAFTS: Record<string, (rng: Rng) => Draft> = {
	'intern/case-first-match': caseFirstMatch,
	'intern/coalesce-nullif': coalesceNullif,
	'intern/text-number-compare': textNumberCompare,
	'intern/order-by-case': orderByCase
};

function sameRows(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const draft = DRAFTS[`${input.grade}/${input.classId}`];
	if (!draft) throw new Error(`${descriptor.key}: no draft for ${input.grade}/${input.classId}`);
	// Data are drawn until every misconception of the class changes the result.
	for (let tries = 0; tries < 200; tries += 1) {
		const q = draft(rng);
		const answer = runSql(q.setup, q.query);
		if (answer.length < 2) continue;
		if (Object.values(q.wrong).some((rows) => sameRows(rows, answer))) continue;
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: `Что вернёт запрос? База — SQLite, схема и данные приведены вместе с запросом.\n\n${SQL_ROW_FORMAT}`,
				code: { language: 'sql', source: `${q.setup}\n\n${q.query}` }
			},
			answer: { kind: 'sequence', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: sqlProbeSource(q.setup, q.query), stdin: '' }),
			wrong: () =>
				Object.fromEntries(
					descriptor.wrongSolutions.map(({ id }) => {
						const rows = q.wrong[id];
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
	throw new Error(`${descriptor.key}: no data for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
