// Conflict strategies of a Room DAO: what the tables hold after a sync writes into them with `INSERT OR REPLACE`
// (`@Insert(onConflict = REPLACE)`), `INSERT OR IGNORE`, an upsert `ON CONFLICT DO UPDATE` and a composite unique
// index; at Junior — a replaced parent row and its children under `ON DELETE CASCADE` / `SET NULL`, a conditional upsert.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildSql, CHAT_TITLES, MESSAGE_BODIES, roomTable, type Required, type SqlItem } from '../../_lib/mob-data.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows, sqlText } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

const REQUIRED: Required = {
	'intern/replace-defaults': ['replace-as-update'],
	'intern/insert-ignore': ['ignore-as-replace', 'ignore-stops'],
	'intern/composite-unique': ['unique-per-column'],
	'intern/replace-new-rowid': ['replace-keeps-rowid'],
	'junior/replace-cascade': ['replace-keeps-children', 'replace-as-update'],
	'junior/upsert-where': ['upsert-where-ignored', 'upsert-as-replace'],
	'junior/reactions-mix': ['unique-per-column', 'replace-keeps-rowid', 'ignore-as-replace'],
	'junior/replace-set-null': ['replace-keeps-children', 'replace-keeps-rowid']
};

type Value = string | number | null;
type Row = Value[];

const NAMES = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дина', 'Егор', 'Зоя', 'Илья', 'Кира', 'Лев', 'Мила', 'Олег'];
const EMOJI = ['like', 'heart', 'fire', 'smile', 'wow'];

const literal = (v: Value): string => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : sqlText(v));

/** A multi-row `INSERT` with a conflict clause: `OR REPLACE`, `OR IGNORE` or a plain one with an upsert tail. */
function insert(verb: string, table: string, columns: readonly string[], rows: readonly Row[], tail = ''): string {
	const values = rows.map((r) => `(${r.map(literal).join(', ')})`).join(', ');
	return `INSERT${verb ? ` ${verb}` : ''} INTO ${table} (${columns.join(', ')}) VALUES ${values}${tail};`;
}

/** The upsert a misconception takes `INSERT OR REPLACE` for: the conflicting row is updated in place. */
function asUpdate(table: string, columns: readonly string[], rows: readonly Row[], target: string): string {
	const set = columns
		.filter((c) => c !== target)
		.map((c) => `${c} = excluded.${c}`)
		.join(', ');
	return insert('', table, columns, rows, ` ON CONFLICT(${target}) DO UPDATE SET ${set}`);
}

function phone(rng: Rng): string {
	return `+7 9${rng.int(10, 99)} ${rng.int(100, 999)}-${rng.int(10, 99)}-${rng.int(10, 99)}`;
}

const CONTACTS = roomTable(
	'contacts',
	[
		['id', 'INTEGER', true],
		['name', 'TEXT', true],
		['phone', 'TEXT', false],
		['favorite', 'INTEGER', true, '0']
	],
	{ primary: ['id'] }
);

function replaceDefaults(rng: Rng): SqlItem {
	const names = rng.sample(NAMES, 7);
	const count = rng.int(3, 4);
	const rows: Row[] = [];
	for (let id = 1; id <= count; id += 1)
		rows.push([id, names[id - 1] ?? 'Анна', rng.bool(0.7) ? phone(rng) : null, rng.bool() ? 1 : 0]);
	// The trap in every instance: a favourite contact with a phone is replaced by a row that names only id and name.
	const target = rng.int(1, count);
	const row = rows[target - 1];
	if (row) {
		row[2] = phone(rng);
		row[3] = 1;
	}
	const fresh = names[5] ?? 'Олег';
	const added = names[6] ?? 'Мила';
	const ops: [string[], Row[]][] = [
		[['id', 'name'], [[target, fresh]]],
		[['id', 'name', 'phone'], [[count + 1, added, phone(rng)]]]
	];
	if (rng.bool()) {
		const other = rng.pick(rows.map((r) => Number(r[0])).filter((id) => id !== target));
		ops.push([['id', 'name', 'favorite'], [[other, names[4] ?? 'Зоя', 1]]]);
	}
	const head = [
		'PRAGMA foreign_keys = ON;',
		CONTACTS,
		insertRows('contacts', ['id', 'name', 'phone', 'favorite'], rows)
	];
	const ordered = rng.shuffle(ops);
	const setup = [...head, ...ordered.map(([cols, r]) => insert('OR REPLACE', 'contacts', cols, r))].join('\n');
	const query = 'SELECT id, name, phone, favorite FROM contacts ORDER BY id;';
	return {
		setup,
		query,
		statement:
			'Синхронизация контактов сохраняет данные сервера методом DAO `@Insert(onConflict = OnConflictStrategy.REPLACE)`, он выполняет `INSERT OR REPLACE`. Что вернёт запрос в конце?',
		wrong: {
			'replace-as-update': {
				setup: [...head, ...ordered.map(([cols, r]) => asUpdate('contacts', cols, r, 'id'))].join('\n'),
				query
			}
		}
	};
}

const NOTES = roomTable(
	'notes',
	[
		['id', 'INTEGER', true],
		['title', 'TEXT', true],
		['edited', 'INTEGER', true, '0']
	],
	{ primary: ['id'] }
);

const NOTE_TITLES = ['Покупки', 'Идеи', 'Пароль от Wi-Fi', 'Отпуск', 'Книги', 'Рецепт', 'План', 'Встреча', 'Фильмы'];

function insertIgnore(rng: Rng): SqlItem {
	const titles = rng.sample(NOTE_TITLES, 9);
	const count = rng.int(3, 4);
	const local: Row[] = [];
	for (let id = 1; id <= count; id += 1) local.push([id, `${titles[id - 1] ?? 'План'} (моё)`, rng.bool() ? 1 : 0]);
	// The batch from the server: new notes and notes already on the device; a conflict is never the first or last row.
	const existing = rng.sample(
		local.map((r) => Number(r[0])),
		rng.int(1, 2)
	);
	const fresh = [count + 1, count + 2, count + 3].slice(0, rng.int(2, 3));
	const firstNew = fresh[0] ?? count + 1;
	const lastNew = fresh[fresh.length - 1] ?? count + 2;
	const middle = rng.shuffle([...existing, ...fresh.slice(1, -1)]);
	const order = [firstNew, ...middle, lastNew];
	const batch: Row[] = order.map((id, i) => [id, titles[(id + 3) % titles.length] ?? `Заметка ${i}`]);
	const head = ['PRAGMA foreign_keys = ON;', NOTES, insertRows('notes', ['id', 'title', 'edited'], local)];
	const firstConflict = batch.findIndex((r) => existing.includes(Number(r[0])));
	const query = 'SELECT id, title, edited FROM notes ORDER BY id;';
	return {
		setup: [...head, insert('OR IGNORE', 'notes', ['id', 'title'], batch)].join('\n'),
		query,
		statement:
			'Первая загрузка заметок с сервера сохраняет пакет одним `INSERT OR IGNORE` (метод DAO с `OnConflictStrategy.IGNORE`), чтобы не затереть правки, сделанные на устройстве. Что вернёт запрос в конце?',
		wrong: {
			'ignore-as-replace': {
				setup: [...head, insert('OR REPLACE', 'notes', ['id', 'title'], batch)].join('\n'),
				query
			},
			'ignore-stops': {
				setup: [...head, insert('', 'notes', ['id', 'title'], batch.slice(0, firstConflict))].join('\n'),
				query
			}
		}
	};
}

const REACTIONS = roomTable(
	'reactions',
	[
		['id', 'INTEGER', true],
		['message_id', 'INTEGER', true],
		['user_id', 'INTEGER', true],
		['emoji', 'TEXT', true]
	],
	{ autoGenerate: 'id' }
);
const REACTIONS_INDEX =
	'CREATE UNIQUE INDEX IF NOT EXISTS `index_reactions_message_id_user_id` ON `reactions` (`message_id`, `user_id`);';
const REACTIONS_PER_COLUMN = [
	'CREATE UNIQUE INDEX IF NOT EXISTS `index_reactions_message_id` ON `reactions` (`message_id`);',
	'CREATE UNIQUE INDEX IF NOT EXISTS `index_reactions_user_id` ON `reactions` (`user_id`);'
].join('\n');

interface ReactionOp {
	verb: 'OR IGNORE' | 'OR REPLACE';
	row: Row;
}

/** Reaction writes: pairs repeat exactly, and pairs share a message or a user without repeating. */
function reactionOps(rng: Rng, verbs: readonly ('OR IGNORE' | 'OR REPLACE')[]): ReactionOp[] {
	const messages = [rng.int(100, 199), rng.int(200, 299), rng.int(300, 399)];
	const users = rng.sample([1, 2, 3, 4, 5, 6], 3);
	const pairs: [number, number][] = [];
	for (let k = rng.int(5, 6); k > 0; k -= 1) pairs.push([rng.pick(messages), rng.pick(users)]);
	// The traps in every instance: an exact repeat of a pair, a pair sharing only the message, one sharing only the user.
	const first = pairs[0] ?? [100, 1];
	const otherUser = users.find((u) => u !== first[1]) ?? 1;
	const otherMessage = messages.find((m) => m !== first[0]) ?? 200;
	pairs.push([first[0], otherUser], [otherMessage, first[1]], [first[0], first[1]]);
	const ordered = [first, ...rng.shuffle(pairs.slice(1))];
	return ordered.map(([m, u]) => ({ verb: rng.pick(verbs), row: [m, u, rng.pick(EMOJI)] }));
}

function reactionScript(index: string, ops: readonly ReactionOp[], render: (op: ReactionOp) => string): string {
	return ['PRAGMA foreign_keys = ON;', REACTIONS, index, ...ops.map(render)].join('\n');
}

function reactionItem(rng: Rng, verbs: readonly ('OR IGNORE' | 'OR REPLACE')[]): SqlItem {
	const ops = reactionOps(rng, verbs);
	const cols = ['message_id', 'user_id', 'emoji'];
	const plain = (op: ReactionOp): string => insert(op.verb, 'reactions', cols, [op.row]);
	// Ids are not shown: an ignored row still takes a number of AUTOINCREMENT, which the order alone does not reveal.
	const query = 'SELECT message_id, user_id, emoji FROM reactions ORDER BY id;';
	return {
		setup: reactionScript(REACTIONS_INDEX, ops, plain),
		query,
		statement:
			verbs.length > 1
				? 'Реакции на сообщения приходят с сервера и сохраняются этими операциями (уникальный индекс Room `@Index(value = ["message_id", "user_id"], unique = true)`). Что вернёт запрос в конце?'
				: 'Реакции на сообщения сохраняются методом DAO с `OnConflictStrategy.IGNORE` (уникальный индекс Room `@Index(value = ["message_id", "user_id"], unique = true)`). Что вернёт запрос в конце?',
		wrong: {
			'unique-per-column': { setup: reactionScript(REACTIONS_PER_COLUMN, ops, plain), query },
			'replace-keeps-rowid': {
				setup: reactionScript(REACTIONS_INDEX, ops, (op) =>
					op.verb === 'OR REPLACE'
						? insert(
								'',
								'reactions',
								cols,
								[op.row],
								' ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji'
							)
						: plain(op)
				),
				query
			},
			'ignore-as-replace': {
				setup: reactionScript(REACTIONS_INDEX, ops, (op) => insert('OR REPLACE', 'reactions', cols, [op.row])),
				query
			}
		}
	};
}

const SYNCED_CONTACTS = roomTable(
	'contacts',
	[
		['id', 'INTEGER', true],
		['remote_id', 'TEXT', true],
		['name', 'TEXT', true]
	],
	{ autoGenerate: 'id' }
);
const SYNCED_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS `index_contacts_remote_id` ON `contacts` (`remote_id`);';

function replaceNewRowid(rng: Rng): SqlItem {
	const names = rng.sample(NAMES, 8);
	const count = rng.int(3, 5);
	const remote = rng.sample(['u17', 'u23', 'u31', 'u42', 'u58', 'u64', 'u75', 'u86'], count + 1);
	const local: Row[] = remote.slice(0, count).map((r, i) => [r, names[i] ?? 'Анна']);
	const replaced = rng.sample(local, rng.int(1, 2)).map((r, i) => [r[0] ?? 'u17', names[count + i] ?? 'Олег']);
	const batch: Row[] = rng.shuffle([...replaced, [remote[count] ?? 'u99', names[7] ?? 'Мила']]);
	const head = [
		'PRAGMA foreign_keys = ON;',
		SYNCED_CONTACTS,
		SYNCED_INDEX,
		insertRows('contacts', ['remote_id', 'name'], local)
	];
	const query = 'SELECT id, remote_id, name FROM contacts ORDER BY id;';
	return {
		setup: [...head, insert('OR REPLACE', 'contacts', ['remote_id', 'name'], batch)].join('\n'),
		query,
		statement:
			'Локальный id контакта Room генерирует сам (`@PrimaryKey(autoGenerate = true)`), а сервер знает контакт по `remote_id`. Синхронизация сохраняет пакет методом DAO с `OnConflictStrategy.REPLACE`. Что вернёт запрос в конце?',
		wrong: {
			'replace-keeps-rowid': {
				setup: [
					...head,
					insert(
						'',
						'contacts',
						['remote_id', 'name'],
						batch,
						' ON CONFLICT(remote_id) DO UPDATE SET name = excluded.name'
					)
				].join('\n'),
				query
			}
		}
	};
}

function chatsTable(): string {
	return roomTable(
		'chats',
		[
			['id', 'INTEGER', true],
			['title', 'TEXT', true],
			['muted', 'INTEGER', true, '0']
		],
		{ primary: ['id'] }
	);
}

const CASCADE_MESSAGES = roomTable(
	'messages',
	[
		['id', 'INTEGER', true],
		['chat_id', 'INTEGER', true],
		['body', 'TEXT', true]
	],
	{ autoGenerate: 'id' },
	['FOREIGN KEY(`chat_id`) REFERENCES `chats`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE']
);

function replaceCascade(rng: Rng): SqlItem {
	const titles = rng.sample(CHAT_TITLES, 6);
	const count = rng.int(3, 4);
	const chats: Row[] = [];
	for (let id = 1; id <= count; id += 1) chats.push([id, titles[id - 1] ?? 'Семья', rng.bool() ? 1 : 0]);
	// The trap: a muted chat with messages is refreshed by REPLACE without `muted`.
	const target = rng.int(1, count);
	const targetRow = chats[target - 1];
	if (targetRow) targetRow[2] = 1;
	const messages: Row[] = [];
	for (let id = 1; id <= count; id += 1)
		for (let k = id === target ? rng.int(2, 3) : rng.int(0, 2); k > 0; k -= 1)
			messages.push([id, rng.pick(MESSAGE_BODIES)]);
	const refreshed: Row[] = rng.shuffle([
		[target, `${titles[target - 1] ?? 'Семья'} 2.0`],
		[count + 1, titles[4] ?? 'Дача']
	]);
	const after: Row[] = [[target, rng.pick(MESSAGE_BODIES)]];
	const script = (fk: 'ON' | 'OFF', refresh: string): string =>
		[
			`PRAGMA foreign_keys = ${fk};`,
			chatsTable(),
			CASCADE_MESSAGES,
			insertRows('chats', ['id', 'title', 'muted'], chats),
			insertRows('messages', ['chat_id', 'body'], messages),
			refresh,
			insertRows('messages', ['chat_id', 'body'], after)
		].join('\n');
	const query =
		'SELECT c.id, c.title, c.muted, COUNT(m.id) FROM chats c LEFT JOIN messages m ON m.chat_id = c.id GROUP BY c.id ORDER BY c.id;';
	const replace = insert('OR REPLACE', 'chats', ['id', 'title'], refreshed);
	return {
		setup: script('ON', replace),
		query,
		statement:
			'Обновление списка чатов сохраняет данные сервера методом DAO с `OnConflictStrategy.REPLACE`, затем приходит новое сообщение. Сообщения ссылаются на чат внешним ключом Room с `onDelete = ForeignKey.CASCADE`. Что вернёт запрос в конце?',
		wrong: {
			'replace-keeps-children': { setup: script('OFF', replace), query },
			'replace-as-update': { setup: script('ON', asUpdate('chats', ['id', 'title'], refreshed, 'id')), query }
		}
	};
}

function upsertWhere(rng: Rng): SqlItem {
	const titles = rng.sample(NOTE_TITLES, 9);
	const count = rng.int(3, 4);
	const table = roomTable(
		'notes',
		[
			['id', 'INTEGER', true],
			['title', 'TEXT', true],
			['updated_at', 'INTEGER', true],
			['pinned', 'INTEGER', true, '0']
		],
		{ primary: ['id'] }
	);
	const local: Row[] = [];
	for (let id = 1; id <= count; id += 1)
		local.push([id, titles[id - 1] ?? 'План', rng.int(20, 60) * 10, rng.bool() ? 1 : 0]);
	// The traps in every instance: a newer server version of a pinned note, an older one, and a new note.
	const ids = rng.shuffle(local.map((r) => Number(r[0])));
	const newer = ids[0] ?? 1;
	const older = ids[1] ?? 2;
	const newerRow = local[newer - 1];
	if (newerRow) newerRow[3] = 1;
	const at = (id: number): number => Number(local[id - 1]?.[2] ?? 0);
	const server: Row[] = [
		[newer, `${titles[newer - 1] ?? 'План'}!`, at(newer) + rng.int(1, 30) * 10],
		[older, `${titles[older - 1] ?? 'План'}?`, at(older) - rng.int(1, 15) * 10],
		[count + 1, titles[6] ?? 'Книги', rng.int(20, 60) * 10]
	];
	if (rng.bool() && ids[2] !== undefined) server.push([ids[2], `${titles[ids[2] - 1] ?? 'План'}.`, at(ids[2])]);
	const batch = rng.shuffle(server);
	const head = [
		'PRAGMA foreign_keys = ON;',
		table,
		insertRows('notes', ['id', 'title', 'updated_at', 'pinned'], local)
	];
	const tail = (set: string, where: boolean): string =>
		` ON CONFLICT(id) DO UPDATE SET ${set}${where ? ' WHERE excluded.updated_at > notes.updated_at' : ''}`;
	const set = 'title = excluded.title, updated_at = excluded.updated_at';
	const script = (t: string): string =>
		[...head, ...batch.map((r) => insert('', 'notes', ['id', 'title', 'updated_at'], [r], t))].join('\n');
	const query = 'SELECT id, title, updated_at, pinned FROM notes ORDER BY id;';
	return {
		setup: script(tail(set, true)),
		query,
		statement:
			'Синхронизация заметок применяет версии с сервера запросом-upsert из DAO: версия с сервера заменяет локальную, только если она новее. Что вернёт запрос в конце?',
		wrong: {
			'upsert-where-ignored': { setup: script(tail(set, false)), query },
			'upsert-as-replace': { setup: script(tail(`${set}, pinned = 0`, true)), query }
		}
	};
}

function replaceSetNull(rng: Rng): SqlItem {
	const titles = rng.sample(CHAT_TITLES, 6);
	const count = rng.int(3, 4);
	const remote = rng.sample(['c11', 'c27', 'c38', 'c46', 'c59', 'c63'], count);
	const chats = roomTable(
		'chats',
		[
			['id', 'INTEGER', true],
			['remote_id', 'TEXT', true],
			['title', 'TEXT', true]
		],
		{ autoGenerate: 'id' }
	);
	const index = 'CREATE UNIQUE INDEX IF NOT EXISTS `index_chats_remote_id` ON `chats` (`remote_id`);';
	const drafts = roomTable(
		'drafts',
		[
			['id', 'INTEGER', true],
			['chat_id', 'INTEGER', false],
			['body', 'TEXT', true]
		],
		{ primary: ['id'] },
		['FOREIGN KEY(`chat_id`) REFERENCES `chats`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL']
	);
	const local: Row[] = remote.map((r, i) => [r, titles[i] ?? 'Семья']);
	// Every chat has a draft; one or two chats are refreshed by remote_id.
	const draftRows: Row[] = rng
		.shuffle(remote.map((_, i) => i + 1))
		.map((chat, i) => [i + 1, chat, rng.pick(MESSAGE_BODIES)]);
	const refreshed: Row[] = rng.sample(local, rng.int(1, 2)).map((r) => [r[0] ?? 'c11', `${String(r[1])} (обновлён)`]);
	const script = (fk: 'ON' | 'OFF', refresh: string): string =>
		[
			`PRAGMA foreign_keys = ${fk};`,
			chats,
			index,
			drafts,
			insertRows('chats', ['remote_id', 'title'], local),
			insertRows('drafts', ['id', 'chat_id', 'body'], draftRows),
			refresh
		].join('\n');
	const replace = insert('OR REPLACE', 'chats', ['remote_id', 'title'], refreshed);
	const query = 'SELECT d.id, d.chat_id, c.title FROM drafts d LEFT JOIN chats c ON c.id = d.chat_id ORDER BY d.id;';
	return {
		setup: script('ON', replace),
		query,
		statement:
			'Черновики ссылаются на чат внешним ключом Room с `onDelete = ForeignKey.SET_NULL`; локальный id чата Room генерирует сам, сервер знает чат по `remote_id`. Синхронизация сохраняет чаты методом DAO с `OnConflictStrategy.REPLACE`. Что вернёт запрос в конце?',
		wrong: {
			'replace-keeps-children': { setup: script('OFF', replace), query },
			'replace-keeps-rowid': {
				setup: script(
					'ON',
					insert(
						'',
						'chats',
						['remote_id', 'title'],
						refreshed,
						' ON CONFLICT(remote_id) DO UPDATE SET title = excluded.title'
					)
				),
				query
			}
		}
	};
}

const MAKERS: Record<string, (rng: Rng) => SqlItem> = {
	'intern/replace-defaults': replaceDefaults,
	'intern/insert-ignore': insertIgnore,
	'intern/composite-unique': (rng) => reactionItem(rng, ['OR IGNORE']),
	'intern/replace-new-rowid': replaceNewRowid,
	'junior/replace-cascade': replaceCascade,
	'junior/upsert-where': upsertWhere,
	'junior/reactions-mix': (rng) => reactionItem(rng, ['OR IGNORE', 'OR REPLACE']),
	'junior/replace-set-null': replaceSetNull
};

export function build(input: GenerateInput): Built {
	const make = MAKERS[`${input.grade}/${input.classId}`];
	if (!make) throw new Error(`${descriptor.key}: no class ${input.grade}/${input.classId}`);
	return buildSql(descriptor, input, REQUIRED, make);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
