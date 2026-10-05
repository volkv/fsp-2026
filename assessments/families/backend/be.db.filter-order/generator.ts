// Filtering and ordering: which rows a WHERE without parentheses keeps, what BETWEEN and LIKE match, and which rows a
// sort on several keys with LIMIT and OFFSET returns.
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
import { insertRows, runSql, sqlProbeSource, sqlText, SQL_ROW_FORMAT } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

interface Draft {
	setup: string;
	query: string;
	/** The rows a misconception gives; `null` where it does not apply to the class. */
	wrong: Record<string, string[] | null>;
}

const NONE: Record<string, null> = {
	'left-to-right': null,
	'between-exclusive': null,
	'underscore-any': null,
	'desc-all-keys': null,
	'offset-one-based': null,
	'not-whole-condition': null
};

const CATEGORIES = ['keyboards', 'mice', 'monitors', 'cables', 'headsets', 'webcams', 'chairs', 'lamps'] as const;
const PREFIXES = ['kb', 'ms', 'mn', 'cb', 'hs', 'wc', 'ch', 'lp'] as const;

interface Product {
	code: string;
	category: string;
	price: number;
	stock: number;
	rating: number;
}

function table(rng: Rng): string {
	return rng.pick(['products', 'goods', 'catalog', 'stock_items']);
}

function setupOf(name: string, rng: Rng, products: readonly Product[]): string {
	const rows = rng.shuffle(products).map((p, i) => [i + 1, p.code, p.category, p.price, p.stock, p.rating]);
	return [
		`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, category TEXT NOT NULL, price INTEGER NOT NULL, stock INTEGER NOT NULL, rating INTEGER NOT NULL);`,
		insertRows(name, ['id', 'code', 'category', 'price', 'stock', 'rating'], rows)
	].join('\n');
}

/** Distinct codes: a prefix and a number. */
function randomProducts(rng: Rng, count: number, categories: readonly string[]): Product[] {
	const used = new Set<string>();
	const products: Product[] = [];
	while (products.length < count) {
		const code = `${rng.pick(PREFIXES)}-${rng.int(1, 399)}`;
		if (used.has(code)) continue;
		used.add(code);
		products.push({
			code,
			category: rng.pick(categories),
			price: rng.int(5, 60) * 10,
			stock: rng.int(0, 25),
			rating: rng.int(1, 5)
		});
	}
	return products;
}

function andOr(rng: Rng): Draft {
	const name = table(rng);
	const categories = rng.sample(CATEGORIES, 3);
	const products = randomProducts(rng, rng.int(9, 12), categories);
	const setup = setupOf(name, rng, products);
	const [c1, c2] = [sqlText(categories[0] ?? ''), sqlText(categories[1] ?? '')];
	const stock = rng.int(4, 12);
	const price = rng.int(15, 45) * 10;
	const rating = rng.int(3, 4);
	const order = rng.bool() ? 'ORDER BY price DESC, id' : 'ORDER BY id';
	const shapes: [string, string][] = [
		[
			`category = ${c1} OR stock > ${stock} AND price < ${price}`,
			`(category = ${c1} OR stock > ${stock}) AND price < ${price}`
		],
		[
			`category = ${c1} AND price < ${price} OR category = ${c2} AND rating >= ${rating}`,
			`((category = ${c1} AND price < ${price}) OR category = ${c2}) AND rating >= ${rating}`
		],
		[`stock = 0 OR category = ${c2} AND price >= ${price}`, `(stock = 0 OR category = ${c2}) AND price >= ${price}`]
	];
	const [right, wrong] = rng.pick(shapes);
	const select = `SELECT id, code, price FROM ${name} WHERE`;
	return {
		setup,
		query: `${select} ${right} ${order};`,
		wrong: { ...NONE, 'left-to-right': runSql(setup, `${select} ${wrong} ${order};`) }
	};
}

function betweenLike(rng: Rng): Draft {
	const name = table(rng);
	const categories = rng.sample(CATEGORIES, 3);
	const prefix = rng.pick(PREFIXES);
	const digit = rng.int(1, 9);
	const lo = rng.int(10, 25) * 10;
	const hi = lo + rng.int(10, 25) * 10;
	const pick = (): string => rng.pick(categories);
	const products = randomProducts(rng, rng.int(5, 7), categories).filter(
		(p) => !p.code.startsWith(`${prefix}-${digit}`)
	);
	const used = new Set(products.map((p) => p.code));
	const add = (code: string, price: number): void => {
		if (used.has(code)) return;
		used.add(code);
		products.push({ code, category: pick(), price, stock: rng.int(0, 25), rating: rng.int(1, 5) });
	};
	// The traps in every instance: matching codes priced at both bounds and inside, codes the pattern almost matches.
	const two = (): string => `${prefix}-${digit}${rng.int(0, 9)}`;
	add(two(), lo);
	add(two(), hi);
	add(two(), rng.int(lo / 10 + 1, hi / 10 - 1) * 10);
	add(`${prefix}-${digit}${rng.int(0, 9)}${rng.int(0, 9)}`, rng.int(lo / 10, hi / 10) * 10);
	add(`${prefix}-${digit}`, rng.int(lo / 10, hi / 10) * 10);
	if (rng.bool()) add(two(), rng.pick([lo - 10, hi + 10]));
	const setup = setupOf(name, rng, products);
	const pattern = rng.bool() ? `${prefix}-${digit}_` : `%-${digit}_`;
	const select = `SELECT code, price FROM ${name} WHERE`;
	const order = 'ORDER BY price, code';
	const like = (p: string): string => `code LIKE ${sqlText(p)}`;
	return {
		setup,
		query: `${select} price BETWEEN ${lo} AND ${hi} AND ${like(pattern)} ${order};`,
		wrong: {
			...NONE,
			'between-exclusive': runSql(setup, `${select} price > ${lo} AND price < ${hi} AND ${like(pattern)} ${order};`),
			'underscore-any': runSql(
				setup,
				`${select} price BETWEEN ${lo} AND ${hi} AND ${like(pattern.replaceAll('_', '%'))} ${order};`
			)
		}
	};
}

function notPrecedence(rng: Rng): Draft {
	const name = table(rng);
	const categories = rng.sample(CATEGORIES, 3);
	const products = randomProducts(rng, rng.int(9, 12), categories);
	const setup = setupOf(name, rng, products);
	const category = sqlText(categories[0] ?? '');
	const stock = rng.int(4, 12);
	const lo = rng.int(10, 25) * 10;
	const hi = lo + rng.int(10, 20) * 10;
	// NOT binds tighter than AND and OR: it negates only the comparison right after it.
	const shapes: [string, string][] = [
		[`NOT category = ${category} AND stock > ${stock}`, `NOT (category = ${category} AND stock > ${stock})`],
		[`NOT price BETWEEN ${lo} AND ${hi} OR stock = 0`, `NOT (price BETWEEN ${lo} AND ${hi} OR stock = 0)`],
		[
			`NOT stock > ${stock} AND category = ${category} OR price > ${hi}`,
			`NOT (stock > ${stock} AND category = ${category} OR price > ${hi})`
		]
	];
	const [right, wrong] = rng.pick(shapes);
	const select = `SELECT id, code, price, stock FROM ${name} WHERE`;
	return {
		setup,
		query: `${select} ${right} ORDER BY id;`,
		wrong: { ...NONE, 'not-whole-condition': runSql(setup, `${select} ${wrong} ORDER BY id;`) }
	};
}

function orderLimit(rng: Rng): Draft {
	const name = table(rng);
	const categories = rng.sample(CATEGORIES, 3);
	const products = randomProducts(rng, rng.int(9, 12), categories);
	// Distinct prices keep the order total; ratings repeat so that the second key matters.
	const prices = rng.sample(
		Array.from({ length: 60 }, (_, i) => (i + 5) * 10),
		products.length
	);
	products.forEach((p, i) => {
		p.price = prices[i] ?? p.price;
		p.rating = rng.int(2, 5);
	});
	const setup = setupOf(name, rng, products);
	const limit = rng.int(3, 4);
	const offset = rng.int(2, 4);
	const select = `SELECT code, rating, price FROM ${name}`;
	const where = rng.bool() ? '' : ` WHERE stock > 0`;
	return {
		setup,
		query: `${select}${where} ORDER BY rating DESC, price LIMIT ${limit} OFFSET ${offset};`,
		wrong: {
			...NONE,
			'desc-all-keys': runSql(
				setup,
				`${select}${where} ORDER BY rating DESC, price DESC LIMIT ${limit} OFFSET ${offset};`
			),
			'offset-one-based': runSql(
				setup,
				`${select}${where} ORDER BY rating DESC, price LIMIT ${limit} OFFSET ${offset - 1};`
			)
		}
	};
}

function sameRows(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const draft =
		input.classId === 'and-or'
			? andOr
			: input.classId === 'between-like'
				? betweenLike
				: input.classId === 'not-precedence'
					? notPrecedence
					: orderLimit;
	// Data are drawn until every misconception of the class changes the result.
	for (let tries = 0; tries < 200; tries += 1) {
		const q = draft(rng);
		const answer = runSql(q.setup, q.query);
		if (answer.length < 2) continue;
		if (Object.values(q.wrong).some((rows) => rows !== null && sameRows(rows, answer))) continue;
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
					Object.entries(q.wrong).map(([id, rows]) => [
						id,
						rows === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value: rows } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no data for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
