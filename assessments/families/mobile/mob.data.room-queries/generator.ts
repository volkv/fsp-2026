// Queries of a DAO over the local database of a messenger: sorting with NULL, pages with LIMIT and OFFSET, unread
// counters, LIKE; at Junior — the last message of every chat, COALESCE and CASE over a LEFT JOIN, NOT IN with NULL.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildSql, CHAT_TITLES, MESSAGE_BODIES, roomTable, type Required, type SqlItem } from '../../_lib/mob-data.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows, sqlText } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

const REQUIRED: Required = {
	'intern/null-order': ['nulls-largest'],
	'intern/limit-offset': ['limit-comma-swapped', 'offset-one-based'],
	'intern/unread-count': ['count-star'],
	'intern/like-case': ['like-case-sensitive'],
	'junior/last-message': ['max-id-last', 'left-as-inner'],
	'junior/case-null': ['case-null-match', 'left-as-inner'],
	'junior/not-in-null': ['not-in-ignores-null'],
	'junior/chat-list': ['nulls-largest', 'left-as-inner']
};

type Row = (string | number | null)[];

const USERS = roomTable(
	'users',
	[
		['id', 'INTEGER', true],
		['login', 'TEXT', true],
		['name', 'TEXT', false]
	],
	{ primary: ['id'] }
);

const CHATS = roomTable(
	'chats',
	[
		['id', 'INTEGER', true],
		['title', 'TEXT', true],
		['pinned_at', 'INTEGER', false]
	],
	{ primary: ['id'] }
);

const MESSAGES = roomTable(
	'messages',
	[
		['id', 'INTEGER', true],
		['chat_id', 'INTEGER', true],
		['author_id', 'INTEGER', false],
		['body', 'TEXT', true],
		['sent_at', 'INTEGER', true],
		['read_at', 'INTEGER', false]
	],
	{ primary: ['id'] }
);

/** Distinct moments, as Room keeps them in `Long` columns (seconds here), in random order. */
function moments(rng: Rng, count: number): number[] {
	const set = new Set<number>();
	while (set.size < count) set.add(rng.int(1000, 9999));
	return rng.shuffle([...set]);
}

/** Message rows of chats: ids follow the insertion order, which is not the order of `sent_at` (sync brings old ones). */
function messageRows(
	rng: Rng,
	perChat: readonly (readonly [chatId: number, count: number])[],
	authors: readonly (number | null)[],
	readShare = 0.5
): Row[] {
	const total = perChat.reduce((s, [, n]) => s + n, 0);
	const times = moments(rng, total);
	const rows: Row[] = [];
	let k = 0;
	for (const [chatId, count] of perChat) {
		for (let i = 0; i < count; i += 1) {
			const sent = times[k] ?? 0;
			k += 1;
			rows.push([
				0,
				chatId,
				rng.pick(authors),
				rng.pick(MESSAGE_BODIES),
				sent,
				rng.bool(readShare) ? sent + rng.int(1, 90) : null
			]);
		}
	}
	return rng.shuffle(rows).map((r, i) => [i + 1, ...r.slice(1)]);
}

const MESSAGE_COLUMNS = ['id', 'chat_id', 'author_id', 'body', 'sent_at', 'read_at'];

function nullOrder(rng: Rng): SqlItem {
	const titles = rng.sample(CHAT_TITLES, rng.int(5, 6));
	const pins = moments(rng, titles.length);
	const nulls = rng.int(2, titles.length - 2);
	const rows: Row[] = titles.map((t, i) => [i + 1, t, i < nulls ? null : (pins[i] ?? 0)]);
	const setup = [
		'PRAGMA foreign_keys = ON;',
		CHATS,
		insertRows('chats', ['id', 'title', 'pinned_at'], rng.shuffle(rows))
	].join('\n');
	const desc = rng.bool();
	const dir = desc ? ' DESC' : '';
	return {
		setup,
		query: `SELECT title, pinned_at FROM chats ORDER BY pinned_at${dir}, title;`,
		statement: 'Экран списка чатов вызывает метод DAO с этим запросом. Что вернёт запрос?',
		wrong: {
			// NULL taken for the largest value, as PostgreSQL sorts it.
			'nulls-largest': `SELECT title, pinned_at FROM chats ORDER BY pinned_at IS NULL${desc ? ' DESC' : ''}, pinned_at${dir}, title;`
		}
	};
}

function limitOffset(rng: Rng): SqlItem {
	const chat = rng.int(1, 4);
	const other = chat === 1 ? 2 : 1;
	const size = rng.int(2, 4);
	const offset = rng.int(2, 5);
	const count = offset + size + rng.int(1, 3);
	const rows = messageRows(
		rng,
		rng.shuffle([
			[chat, count],
			[other, rng.int(2, 4)]
		] as const),
		[1, 2, 3]
	);
	const setup = ['PRAGMA foreign_keys = ON;', MESSAGES, insertRows('messages', MESSAGE_COLUMNS, rows)].join('\n');
	const head = `SELECT id, body FROM messages WHERE chat_id = ${chat} ORDER BY sent_at DESC`;
	return {
		setup,
		query: `${head} LIMIT ${offset}, ${size};`,
		statement: 'Экран чата подгружает следующую страницу истории этим запросом. Что он вернёт?',
		wrong: {
			'limit-comma-swapped': `${head} LIMIT ${offset} OFFSET ${size};`,
			'offset-one-based': `${head} LIMIT ${size} OFFSET ${offset - 1};`
		}
	};
}

function unreadCount(rng: Rng): SqlItem {
	const chats = rng.int(3, 4);
	const perChat: [number, number][] = [];
	for (let c = 1; c <= chats; c += 1) perChat.push([c, rng.int(2, 4)]);
	const rows = messageRows(rng, perChat, [1, 2, 3, 4], 0.55);
	const setup = ['PRAGMA foreign_keys = ON;', MESSAGES, insertRows('messages', MESSAGE_COLUMNS, rows)].join('\n');
	const q = (read: string): string =>
		`SELECT chat_id, COUNT(*), COUNT(*) - ${read} AS unread FROM messages GROUP BY chat_id ORDER BY unread DESC, chat_id;`;
	return {
		setup,
		query: q('COUNT(read_at)'),
		statement:
			'Счётчики на списке чатов: `read_at` — момент прочтения, NULL — сообщение не прочитано. Что вернёт запрос?',
		wrong: { 'count-star': q('COUNT(*)') }
	};
}

/** A login in one of the cases a user could type it in. */
function cased(rng: Rng, login: string): string {
	const form = rng.int(0, 2);
	if (form === 0) return login;
	if (form === 1) return login.toUpperCase();
	return login.charAt(0).toUpperCase() + login.slice(1);
}

function likeCase(rng: Rng): SqlItem {
	const fragment = rng.pick(['an', 'ma', 'ra', 'il', 'ri', 'le', 'ol', 'er']);
	const shape = rng.pick(['prefix', 'contains', 'suffix'] as const);
	const pattern = shape === 'prefix' ? `${fragment}%` : shape === 'suffix' ? `%${fragment}` : `%${fragment}%`;
	const glob = pattern.replaceAll('%', '*');
	const base = rng.sample(PERSON_NAMES, 5);
	// The trap in every instance: a match typed in upper case, a match in lower case, and a miss.
	const extra = [
		shape === 'suffix' ? `ol${fragment}` : `${fragment}ton`,
		shape === 'suffix' ? `max${fragment}` : `${fragment}ika`,
		rng.pick(['bob', 'zed', 'tim', 'kim'])
	];
	const logins = [...base, ...extra];
	const rows: Row[] = rng.shuffle(logins).map((l, i) => {
		const login = l === extra[0] ? l.toUpperCase() : l === extra[1] ? l : cased(rng, l);
		return [i + 1, login, null];
	});
	const setup = ['PRAGMA foreign_keys = ON;', USERS, insertRows('users', ['id', 'login', 'name'], rows)].join('\n');
	return {
		setup,
		query: `SELECT id, login FROM users WHERE login LIKE ${sqlText(pattern)} ORDER BY id;`,
		statement: 'Поиск контакта по логину вызывает метод DAO с этим запросом. Что вернёт запрос?',
		wrong: {
			'like-case-sensitive': `SELECT id, login FROM users WHERE login GLOB ${sqlText(glob)} ORDER BY id;`
		}
	};
}

function lastMessage(rng: Rng): SqlItem {
	const titles = rng.sample(CHAT_TITLES, rng.int(4, 5));
	const chats: Row[] = titles.map((t, i) => [i + 1, t, null]);
	// The last chat has no messages at all.
	const perChat: [number, number][] = [];
	for (let c = 1; c < titles.length; c += 1) perChat.push([c, rng.int(2, 4)]);
	const messages = messageRows(rng, perChat, [1, 2, 3]);
	const setup = [
		'PRAGMA foreign_keys = ON;',
		CHATS,
		MESSAGES,
		insertRows('chats', ['id', 'title', 'pinned_at'], rng.shuffle(chats)),
		insertRows('messages', MESSAGE_COLUMNS, messages)
	].join('\n');
	const q = (join: string, pick: string): string =>
		`SELECT c.title, m.body, m.sent_at FROM chats c ${join} messages m ON m.id = (${pick}) ORDER BY c.title;`;
	const latest = 'SELECT id FROM messages WHERE chat_id = c.id ORDER BY sent_at DESC LIMIT 1';
	return {
		setup,
		query: q('LEFT JOIN', latest),
		statement:
			'Список чатов показывает последнее сообщение каждого чата. Сообщения, догруженные синхронизацией, получают id позже отправленных раньше них. Что вернёт запрос?',
		wrong: {
			'max-id-last': q('LEFT JOIN', 'SELECT MAX(id) FROM messages WHERE chat_id = c.id'),
			'left-as-inner': q('JOIN', latest)
		}
	};
}

function caseNull(rng: Rng): SqlItem {
	const people = rng.sample(PERSON_NAMES, 4);
	const names = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дина', 'Егор'];
	// User 2 has no display name; user 9 was deleted from the device (no row) but still authors messages.
	const users: Row[] = people.map((login, i) => [i + 1, login, i === 1 ? null : rng.pick(names)]);
	const chat = rng.int(1, 3);
	const messages = messageRows(
		rng,
		[
			[chat, rng.int(5, 7)],
			[chat + 1, rng.int(1, 3)]
		],
		[1, 2, 3, 4, 9]
	);
	const mine = messages.filter((m) => m[1] === chat);
	// The traps in every instance: a read and an unread message, a message of the deleted user.
	if (mine[0]) mine[0][5] = null;
	if (mine[1] && mine[1][5] === null) mine[1][5] = Number(mine[1][4]) + 5;
	if (mine[2]) mine[2][2] = 9;
	if (mine[3]) mine[3][2] = 2;
	const setup = [
		'PRAGMA foreign_keys = ON;',
		USERS,
		MESSAGES,
		insertRows('users', ['id', 'login', 'name'], rng.shuffle(users)),
		insertRows('messages', MESSAGE_COLUMNS, messages)
	].join('\n');
	const q = (join: string, status: string): string =>
		`SELECT m.id, COALESCE(u.name, u.login, 'удалён'), ${status} FROM messages m ${join} users u ON u.id = m.author_id WHERE m.chat_id = ${chat} ORDER BY m.sent_at;`;
	const shown = "CASE m.read_at WHEN NULL THEN 'новое' ELSE 'прочитано' END";
	return {
		setup,
		query: q('LEFT JOIN', shown),
		statement: 'Экран чата строит строки сообщений этим запросом. Что он вернёт?',
		wrong: {
			'case-null-match': q('LEFT JOIN', "CASE WHEN m.read_at IS NULL THEN 'новое' ELSE 'прочитано' END"),
			'left-as-inner': q('JOIN', shown)
		}
	};
}

function notInNull(rng: Rng): SqlItem {
	const people = rng.sample(PERSON_NAMES, rng.int(4, 5));
	const users: Row[] = people.map((login, i) => [i + 1, login, null]);
	const titles = rng.sample(CHAT_TITLES, rng.int(3, 4));
	const chats: Row[] = titles.map((t, i) => [i + 1, t, null]);
	const ids = users.map((u) => Number(u[0]));
	const rows: Row[] = [];
	const times = moments(rng, 40);
	let k = 0;
	const add = (chat: number, author: number | null): void => {
		rows.push([0, chat, author, author === null ? 'участник добавлен' : rng.pick(MESSAGE_BODIES), times[k] ?? 0, null]);
		k += 1;
	};
	for (let c = 1; c <= titles.length; c += 1) {
		const writers = rng.sample(ids, rng.int(1, ids.length - 1));
		for (const w of writers) add(c, w);
		// Chats 1 and 2 always differ: chat 1 has a service message (author NULL), chat 2 has none.
		if (c === 1 || (c > 2 && rng.bool())) add(c, null);
	}
	const messages = rng.shuffle(rows).map((r, i) => [i + 1, ...r.slice(1)]);
	const setup = [
		'PRAGMA foreign_keys = ON;',
		USERS,
		CHATS,
		MESSAGES,
		insertRows('users', ['id', 'login', 'name'], rng.shuffle(users)),
		insertRows('chats', ['id', 'title', 'pinned_at'], rng.shuffle(chats)),
		insertRows('messages', MESSAGE_COLUMNS, messages)
	].join('\n');
	const q = (filter: string): string =>
		`SELECT c.title, (SELECT COUNT(*) FROM users u WHERE u.id NOT IN (SELECT m.author_id FROM messages m WHERE m.chat_id = c.id${filter})) AS silent FROM chats c ORDER BY c.title;`;
	return {
		setup,
		query: q(''),
		statement:
			'Экран статистики считает для каждого чата, сколько пользователей в нём ничего не писали. Служебные сообщения хранятся с `author_id` = NULL. Что вернёт запрос?',
		wrong: { 'not-in-ignores-null': q(' AND m.author_id IS NOT NULL') }
	};
}

function chatList(rng: Rng): SqlItem {
	const titles = rng.sample(CHAT_TITLES, rng.int(5, 6));
	const n = titles.length;
	const perChat: [number, number][] = [];
	// Two chats have no messages: one pinned, one not.
	for (let c = 1; c <= n - 2; c += 1) perChat.push([c, rng.int(1, 3)]);
	const messages = messageRows(rng, perChat, [1, 2, 3]);
	const last = new Map<number, Row>();
	for (const m of messages) {
		const prev = last.get(Number(m[1]));
		if (!prev || Number(m[4]) > Number(prev[4])) last.set(Number(m[1]), m);
	}
	const pinOrder = rng.shuffle(titles.map((_, i) => i + 1));
	const pinned = new Set([n, ...pinOrder.filter((c) => c !== n && c !== n - 1).slice(0, rng.int(1, 2))]);
	const chats: Row[] = titles.map((t, i) => {
		const id = i + 1;
		return [id, t, pinned.has(id) ? 1 : 0, last.get(id)?.[0] ?? null];
	});
	const table = roomTable(
		'chats',
		[
			['id', 'INTEGER', true],
			['title', 'TEXT', true],
			['pinned', 'INTEGER', true],
			['last_message_id', 'INTEGER', false]
		],
		{ primary: ['id'] }
	);
	const setup = [
		'PRAGMA foreign_keys = ON;',
		table,
		MESSAGES,
		insertRows('chats', ['id', 'title', 'pinned', 'last_message_id'], rng.shuffle(chats)),
		insertRows('messages', MESSAGE_COLUMNS, messages)
	].join('\n');
	const q = (join: string, order: string): string =>
		`SELECT c.title, m.body FROM chats c ${join} messages m ON m.id = c.last_message_id ORDER BY c.pinned DESC, ${order}, c.title;`;
	return {
		setup,
		query: q('LEFT JOIN', 'm.sent_at DESC'),
		statement: 'Главный экран мессенджера строит список чатов этим запросом. Что он вернёт?',
		wrong: {
			'nulls-largest': q('LEFT JOIN', 'm.sent_at IS NULL DESC, m.sent_at DESC'),
			'left-as-inner': q('JOIN', 'm.sent_at DESC')
		}
	};
}

const MAKERS: Record<string, (rng: Rng) => SqlItem> = {
	'intern/null-order': nullOrder,
	'intern/limit-offset': limitOffset,
	'intern/unread-count': unreadCount,
	'intern/like-case': likeCase,
	'junior/last-message': lastMessage,
	'junior/case-null': caseNull,
	'junior/not-in-null': notInNull,
	'junior/chat-list': chatList
};

export function build(input: GenerateInput): Built {
	const make = MAKERS[`${input.grade}/${input.classId}`];
	if (!make) throw new Error(`${descriptor.key}: no class ${input.grade}/${input.classId}`);
	return buildSql(descriptor, input, REQUIRED, make);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
