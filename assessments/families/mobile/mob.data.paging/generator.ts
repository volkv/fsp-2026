// Paged loading of a feed from the local database: which post ids the list on screen shows after several pages when
// posts are added, deleted or re-ordered between page loads — OFFSET against a keyset cursor, and at Senior the cursor
// written wrong: `<=` with `AND`, or a sort key that is not unique.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildSql, roomTable, type Required, type SqlItem } from '../../_lib/mob-data.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

const REQUIRED: Required = {
	'middle/offset-shift': ['offset-snapshot'],
	'middle/keyset-cursor': ['offset-snapshot', 'keyset-dups'],
	'middle/keyset-late': ['offset-snapshot', 'keyset-dups'],
	'middle/offset-pages': ['offset-snapshot'],
	'senior/and-cursor': ['and-equivalent'],
	'senior/tie-skip': ['tie-safe'],
	'senior/moving-key': ['offset-snapshot', 'keyset-dups'],
	'senior/tie-dup': ['tie-safe']
};

/** How a page query picks the rows after the last shown one. */
type Cursor = 'offset' | 'row-value' | 'and' | 'key-lt' | 'key-le';

interface Feed {
	table: 'posts' | 'chats';
	key: 'created_at' | 'updated_at';
	/** Rows `[id, key]` before the first page. */
	rows: [number, number][];
	size: number;
	pages: number;
	/** Statements run between page p and page p + 1 (index p − 1). */
	gaps: string[][];
}

const SCREEN = roomTable(
	'screen',
	[
		['pos', 'INTEGER', true],
		['page', 'INTEGER', true],
		['item_id', 'INTEGER', true],
		['sort_key', 'INTEGER', true]
	],
	{ autoGenerate: 'pos' }
);

function pageStatement(feed: Feed, page: number, cursor: Cursor): string {
	const { table, key, size } = feed;
	const order = `ORDER BY ${key} DESC, id DESC LIMIT ${size}`;
	const head = `INSERT INTO screen (page, item_id, sort_key)`;
	if (cursor === 'offset')
		return `${head} SELECT ${page}, id, ${key} FROM ${table} ${order} OFFSET ${(page - 1) * size};`;
	if (page === 1) return `${head} SELECT ${page}, id, ${key} FROM ${table} ${order};`;
	const where: Record<Exclude<Cursor, 'offset'>, string> = {
		'row-value': `(${key}, id) < (cur.k, cur.i)`,
		and: `${key} <= cur.k AND id < cur.i`,
		'key-lt': `${key} < cur.k`,
		'key-le': `${key} <= cur.k`
	};
	return [
		'WITH cur AS (SELECT sort_key AS k, item_id AS i FROM screen ORDER BY pos DESC LIMIT 1)',
		`${head} SELECT ${page}, id, ${key} FROM ${table}, cur WHERE ${where[cursor]} ${order};`
	].join('\n');
}

const QUERY = "SELECT page, group_concat(item_id, ' ' ORDER BY pos) FROM screen GROUP BY page ORDER BY page;";

function script(feed: Feed, cursor: Cursor, mutations: boolean): string {
	const lines = [
		'PRAGMA foreign_keys = ON;',
		roomTable(
			feed.table,
			[
				['id', 'INTEGER', true],
				[feed.key, 'INTEGER', true]
			],
			{ primary: ['id'] }
		),
		SCREEN,
		insertRows(feed.table, ['id', feed.key], feed.rows)
	];
	for (let page = 1; page <= feed.pages; page += 1) {
		lines.push(`-- страница ${page}`, pageStatement(feed, page, cursor));
		const gap = feed.gaps[page - 1] ?? [];
		if (page < feed.pages && gap.length > 0 && mutations) lines.push('-- пока пользователь читает', ...gap);
	}
	return lines.join('\n');
}

/** The item: the right cursor, and what each misconception runs instead. */
function item(feed: Feed, cursor: Cursor, statement: string): SqlItem {
	const wrong: Record<string, { setup: string; query: string }> = {
		'offset-snapshot': { setup: script(feed, cursor, false), query: QUERY },
		'keyset-dups': { setup: script(feed, 'offset', true), query: QUERY }
	};
	if (cursor === 'and' || cursor === 'key-lt' || cursor === 'key-le') {
		const safe = { setup: script(feed, 'row-value', true), query: QUERY };
		if (cursor === 'and') wrong['and-equivalent'] = safe;
		else wrong['tie-safe'] = safe;
	}
	return {
		setup: script(feed, cursor, true),
		query: QUERY,
		statement: `${statement} Таблица \`screen\` — список на экране: каждая загруженная страница дописывается в его конец. Запрос в конце выводит id, показанные каждой страницей, через пробел в порядке списка (\`ORDER BY\` внутри \`group_concat\` — SQLite 3.44 и новее; здесь SQLite 3.46). Строки ответа сравниваются как текст: номер страницы и список id разделяются ровно так — пробел, черта, пробел, id в списке — ровно одним пробелом.`,
		wrong
	};
}

/** `count` distinct moments in ascending order below `top`, at least 2 apart: a moment fits between any two. */
function ascending(rng: Rng, count: number, top: number): number[] {
	const out: number[] = [];
	let t = top;
	for (let k = 0; k < count; k += 1) {
		t -= rng.int(2, 9);
		out.push(t);
	}
	return out.reverse();
}

/** The id of the oldest post: ids are surface, the feed keeps them in the order of creation. */
const firstId = (rng: Rng): number => rng.int(11, 300);

/** The id a newly arriving row takes. */
const nextIdOf = (rows: readonly [number, number][]): number => Math.max(...rows.map(([id]) => id)) + 1;

/** A feed of `count` posts below the moment `top`: ids grow with the time of creation. */
function feedRows(rng: Rng, count: number, top: number): [number, number][] {
	const base = firstId(rng);
	return ascending(rng, count, top).map((t, i) => [base + i, t]);
}

const insert = (table: string, key: string, id: number, at: number): string =>
	`INSERT INTO ${table} (id, ${key}) VALUES (${id}, ${at});`;
const remove = (table: string, id: number): string => `DELETE FROM ${table} WHERE id = ${id};`;

function offsetShift(rng: Rng): SqlItem {
	const size = rng.int(3, 4);
	const rows = feedRows(rng, size * 3 + rng.int(1, 3), 500);
	const newest = 500;
	let nextId = nextIdOf(rows);
	const shown = rows.slice(-size).map(([id]) => id);
	const gap1: string[] = [];
	for (let k = rng.int(1, 2); k > 0; k -= 1)
		gap1.push(insert('posts', 'created_at', nextId++, newest + rng.int(1, 9) + k * 10));
	for (const id of rng.sample(shown, rng.int(1, 2))) gap1.push(remove('posts', id));
	const gap2: string[] = rng.bool()
		? [insert('posts', 'created_at', nextId, newest + 100 + rng.int(1, 9))]
		: [remove('posts', rows[rows.length - size - 1]?.[0] ?? 0)];
	const feed: Feed = { table: 'posts', key: 'created_at', rows, size, pages: 3, gaps: [rng.shuffle(gap1), gap2] };
	return item(
		feed,
		'offset',
		'Лента подгружает страницы постов запросом с OFFSET, пока пользователь прокручивает её; между загрузками в базу приходят новые посты, а часть уже показанных удаляется.'
	);
}

function keysetCursor(rng: Rng): SqlItem {
	const size = rng.int(3, 4);
	const rows = feedRows(rng, size * 3 + rng.int(1, 3), 500);
	let nextId = nextIdOf(rows);
	const page1 = rows.slice(-size).map(([id]) => id);
	const last1 = page1[0] ?? 1;
	const gap1: string[] = [];
	for (let k = rng.int(1, 2); k > 0; k -= 1)
		gap1.push(insert('posts', 'created_at', nextId++, 500 + k * 10 + rng.int(1, 9)));
	// The last shown post — the cursor — is deleted before the next page is loaded.
	gap1.push(remove('posts', last1));
	// A post not shown yet — one page 3 would show — is deleted too: the cursor skips it, the next post moves up.
	const unseen = rows[rng.int(rows.length - 3 * size, rows.length - size - 1)]?.[0] ?? 1;
	const gap2: string[] = [insert('posts', 'created_at', nextId, 600 + rng.int(1, 9))];
	if (unseen >= (rows[rows.length - 2 * size]?.[0] ?? 0)) gap1.push(remove('posts', unseen));
	else gap2.push(remove('posts', unseen));
	const shown2 = rows[rows.length - size - 1]?.[0] ?? 1;
	if (shown2 !== unseen && rng.bool()) gap2.push(remove('posts', shown2));
	const feed: Feed = { table: 'posts', key: 'created_at', rows, size, pages: 3, gaps: [rng.shuffle(gap1), gap2] };
	return item(
		feed,
		'row-value',
		'Лента подгружает страницы постов по ключу последнего показанного поста (keyset); между загрузками в базу приходят новые посты, а часть постов удаляется — в том числе последний показанный.'
	);
}

function keysetLate(rng: Rng): SqlItem {
	const size = rng.int(3, 4);
	const rows = feedRows(rng, size * 3 + rng.int(0, 2), 500);
	let nextId = nextIdOf(rows);
	// Page 1 shows the newest `size` posts; a late post older than the cursor will appear, one newer than it never will.
	// Moments are at least 2 apart, so «one less» falls strictly between two neighbours.
	const sorted = [...rows].sort((a, b) => b[1] - a[1]);
	const lateBelow = (sorted[size + 1]?.[1] ?? 0) - 1;
	const lateAbove = (sorted[0]?.[1] ?? 0) - 1;
	const gap1 = rng.shuffle([
		insert('posts', 'created_at', nextId++, lateBelow),
		insert('posts', 'created_at', nextId++, lateAbove),
		insert('posts', 'created_at', nextId, 500 + rng.int(1, 9))
	]);
	const feed: Feed = { table: 'posts', key: 'created_at', rows, size, pages: 3, gaps: [gap1, []] };
	return item(
		feed,
		'row-value',
		'Лента подгружает страницы постов по ключу последнего показанного поста (keyset). Между загрузками синхронизация догружает посты, написанные офлайн: их `created_at` — момент написания, он может быть в прошлом.'
	);
}

function offsetPages(rng: Rng): SqlItem {
	const size = rng.int(3, 4);
	const rows = feedRows(rng, size * 3 + rng.int(0, 2), 500);
	let nextId = nextIdOf(rows);
	const gaps: string[][] = [];
	for (let p = 1; p < 3; p += 1) {
		const gap: string[] = [];
		for (let k = rng.int(1, 2); k > 0; k -= 1)
			gap.push(insert('posts', 'created_at', nextId++, 500 + p * 100 + k * 10));
		gaps.push(gap);
	}
	const feed: Feed = { table: 'posts', key: 'created_at', rows, size, pages: 3, gaps };
	return item(
		feed,
		'offset',
		'Лента подгружает страницы постов запросом с OFFSET, пока пользователь прокручивает её; перед каждой следующей страницей в базу приходят новые посты.'
	);
}

function andCursor(rng: Rng): SqlItem {
	const size = rng.int(3, 4);
	const count = size * 3 + rng.int(0, 2);
	// Slots are moments from the oldest; posts synced late are old but take the largest ids.
	const times = ascending(rng, count, 500);
	const slots = times.map((_, i) => i);
	const late = rng.sample(slots.slice(0, count - size - 1), rng.int(2, 3));
	const order = [...slots.filter((s) => !late.includes(s)), ...late];
	const base = firstId(rng);
	const rows: [number, number][] = order.map((slot, i) => [base + i, times[slot] ?? 0]);
	const feed: Feed = { table: 'posts', key: 'created_at', rows, size, pages: 3, gaps: [[], []] };
	return item(
		feed,
		'and',
		'Лента подгружает страницы постов по ключу последнего показанного поста. Часть постов пришла синхронизацией позже, поэтому их id больше, чем у более новых постов.'
	);
}

/** A feed with ties of the sort key; an instance is drawn again until a tie straddles a page boundary. */
function tiedFeed(rng: Rng, size: number): [number, number][] {
	const count = size * 3 + rng.int(0, 2);
	const times: number[] = [];
	let t = 500;
	while (times.length < count) {
		t -= rng.int(1, 5);
		for (let k = rng.bool(0.45) ? rng.int(2, 3) : 1; k > 0 && times.length < count; k -= 1) times.push(t);
	}
	const base = firstId(rng);
	return times.reverse().map((at, i): [number, number] => [base + i, at]);
}

function tieSkip(rng: Rng): SqlItem {
	const size = rng.int(3, 4);
	const feed: Feed = { table: 'posts', key: 'created_at', rows: tiedFeed(rng, size), size, pages: 3, gaps: [[], []] };
	return item(
		feed,
		'key-lt',
		'Лента подгружает страницы постов по ключу последнего показанного поста — только по `created_at`. Посты, импортированные пачкой, получили одинаковый `created_at`.'
	);
}

function tieDup(rng: Rng): SqlItem {
	const size = rng.int(3, 4);
	const feed: Feed = { table: 'posts', key: 'created_at', rows: tiedFeed(rng, size), size, pages: 3, gaps: [[], []] };
	return item(
		feed,
		'key-le',
		'Лента подгружает страницы постов по ключу последнего показанного поста — только по `created_at`, через `<=`, чтобы не пропустить посты с одинаковым временем. Посты, импортированные пачкой, получили одинаковый `created_at`.'
	);
}

function movingKey(rng: Rng): SqlItem {
	const size = rng.int(3, 4);
	const rows = feedRows(rng, size * 3 + rng.int(0, 2), 500);
	const sorted = [...rows].sort((a, b) => b[1] - a[1]);
	// Between pages a chat not shown yet and a shown one get a new message: both move to the top of the list.
	const unseen = rng.pick(sorted.slice(size + 1)).at(0) ?? 1;
	const seen = rng.pick(sorted.slice(0, size)).at(0) ?? 1;
	const gap1 = rng.shuffle([
		`UPDATE chats SET updated_at = ${500 + rng.int(10, 19)} WHERE id = ${unseen};`,
		`UPDATE chats SET updated_at = ${500 + rng.int(20, 29)} WHERE id = ${seen};`
	]);
	const gap2 = rng.bool()
		? [
				`UPDATE chats SET updated_at = ${500 + rng.int(30, 39)} WHERE id = ${rng.pick(sorted.slice(size * 2)).at(0) ?? 1};`
			]
		: [];
	const feed: Feed = { table: 'chats', key: 'updated_at', rows, size, pages: 3, gaps: [gap1, gap2] };
	return item(
		feed,
		'row-value',
		'Список чатов отсортирован по времени последней активности и подгружается страницами по ключу последнего показанного чата (keyset). Между загрузками в чатах появляются новые сообщения, и их `updated_at` растёт.'
	);
}

const MAKERS: Record<string, (rng: Rng) => SqlItem> = {
	'middle/offset-shift': offsetShift,
	'middle/keyset-cursor': keysetCursor,
	'middle/keyset-late': keysetLate,
	'middle/offset-pages': offsetPages,
	'senior/and-cursor': andCursor,
	'senior/tie-skip': tieSkip,
	'senior/moving-key': movingKey,
	'senior/tie-dup': tieDup
};

export function build(input: GenerateInput): Built {
	const make = MAKERS[`${input.grade}/${input.classId}`];
	if (!make) throw new Error(`${descriptor.key}: no class ${input.grade}/${input.classId}`);
	return buildSql(descriptor, input, REQUIRED, make);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
