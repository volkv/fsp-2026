// Migrations of a Room database: what a query sees after `ALTER TABLE ADD COLUMN`, after a table is recreated
// (create new → insert select → drop → rename) with its data transformed, and after a chain of migrations — where the
// data is lost to the column order, to a constraint, to a join, to a foreign key or to the order of the steps.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildSql, CHAT_TITLES, MESSAGE_BODIES, roomTable, type Required, type SqlItem } from '../../_lib/mob-data.ts';
import type { Rng } from '../../_lib/rng.ts';
import { insertRows } from '../../_lib/sql.ts';

const descriptor = readDescriptor(import.meta.url);

const REQUIRED: Required = {
	'junior/add-column': ['add-column-null'],
	'junior/column-order': ['select-by-name', 'int-division-real'],
	'junior/constraint-loss': ['ignore-keeps-all', 'ignore-keeps-last'],
	'junior/join-loss': ['join-keeps-all', 'text-equals-nocase'],
	'middle/chain': ['default-fills-null', 'omitted-column-kept'],
	'middle/split-column': ['split-last-space', 'nulls-largest'],
	'middle/drop-cascade': ['drop-keeps-children'],
	'middle/step-order': ['update-after-copy-kept']
};

type Row = (string | number | null)[];

const TITLES = ['Покупки', 'Идеи', 'Отпуск', 'Книги', 'Рецепт', 'План', 'Встреча', 'Фильмы', 'Подарки', 'Ремонт'];
const COLORS = ['red', 'green', 'blue', 'yellow'];

/** A note title marked for the data fix of a migration: it ends with `!`. */
const urgent = (title: string): string => `${title}!`;

function addColumn(rng: Rng): SqlItem {
	const titles = rng.sample(TITLES, 7);
	const old = rng.int(2, 4);
	const v1: Row[] = [];
	for (let id = 1; id <= old; id += 1) v1.push([id, titles[id - 1] ?? 'План', rng.int(100, 999)]);
	const v2: string[] = [
		`INSERT INTO notes (id, title, created_at, pinned, color) VALUES (${old + 1}, '${titles[old] ?? 'Идеи'}', ${rng.int(100, 999)}, 1, '${rng.pick(COLORS)}');`,
		`INSERT INTO notes (id, title, created_at) VALUES (${old + 2}, '${titles[old + 1] ?? 'Книги'}', ${rng.int(100, 999)});`
	];
	const setup = [
		'PRAGMA foreign_keys = ON;',
		'-- версия 1',
		roomTable(
			'notes',
			[
				['id', 'INTEGER', true],
				['title', 'TEXT', true],
				['created_at', 'INTEGER', true]
			],
			{ primary: ['id'] }
		),
		insertRows('notes', ['id', 'title', 'created_at'], v1),
		'PRAGMA user_version = 1;',
		'-- Migration(1, 2)',
		'ALTER TABLE `notes` ADD COLUMN `pinned` INTEGER NOT NULL DEFAULT 0;',
		'ALTER TABLE `notes` ADD COLUMN `color` TEXT;',
		'PRAGMA user_version = 2;',
		'-- приложение версии 2',
		...rng.shuffle(v2)
	].join('\n');
	return {
		setup,
		query: 'SELECT id, title, pinned, color FROM notes ORDER BY id;',
		statement: 'Room выполнил миграцию 1→2, затем приложение версии 2 сохранило новые заметки. Что вернёт запрос?',
		wrong: {
			'add-column-null': `SELECT id, title, CASE WHEN id <= ${old} THEN NULL ELSE pinned END, color FROM notes ORDER BY id;`
		}
	};
}

function columnOrder(rng: Rng): SqlItem {
	const titles = rng.sample(TITLES, 4);
	const bodies = rng.sample(['купить молоко', 'позвонить маме', 'взять зонт', 'оплатить счёт', 'забрать посылку'], 4);
	const count = rng.int(3, 4);
	const rows: Row[] = [];
	// Milliseconds that are not whole seconds, so integer division visibly drops the remainder.
	for (let id = 1; id <= count; id += 1)
		rows.push([
			id,
			titles[id - 1] ?? 'План',
			bodies[id - 1] ?? 'взять зонт',
			rng.int(1700, 1799) * 1000 + rng.int(1, 999)
		]);
	const head = [
		'PRAGMA foreign_keys = ON;',
		'-- версия 1',
		roomTable(
			'notes',
			[
				['id', 'INTEGER', true],
				['title', 'TEXT', true],
				['body', 'TEXT', true],
				['created_ms', 'INTEGER', true]
			],
			{ primary: ['id'] }
		),
		insertRows('notes', ['id', 'title', 'body', 'created_ms'], rows),
		'PRAGMA user_version = 1;',
		'-- Migration(1, 2): время создания теперь в секундах, поле body в сущности перенесли выше title',
		roomTable(
			'notes_new',
			[
				['id', 'INTEGER', true],
				['body', 'TEXT', true],
				['title', 'TEXT', true],
				['created_s', 'INTEGER', true]
			],
			{ primary: ['id'] }
		)
	];
	const tail = ['DROP TABLE `notes`;', 'ALTER TABLE `notes_new` RENAME TO `notes`;', 'PRAGMA user_version = 2;'];
	const script = (copy: string): string => [...head, copy, ...tail].join('\n');
	return {
		setup: script('INSERT INTO notes_new SELECT id, title, body, created_ms / 1000 FROM notes;'),
		query: 'SELECT id, title, body, created_s FROM notes ORDER BY id;',
		statement: 'Room выполнил миграцию 1→2. Что вернёт запрос после неё?',
		wrong: {
			'select-by-name': {
				setup: script(
					'INSERT INTO notes_new (id, title, body, created_s) SELECT id, title, body, created_ms / 1000 FROM notes;'
				),
				query: 'SELECT id, title, body, created_s FROM notes ORDER BY id;'
			},
			'int-division-real': {
				setup: script('INSERT INTO notes_new SELECT id, title, body, created_ms / 1000.0 FROM notes;'),
				query: 'SELECT id, title, body, created_s FROM notes ORDER BY id;'
			}
		}
	};
}

function constraintLoss(rng: Rng): SqlItem {
	const people = rng.sample(['anna', 'boris', 'vera', 'gleb', 'dina', 'egor', 'zoya', 'ilya'], 5);
	const names = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дина', 'Егор', 'Зоя', 'Илья'];
	const domain = rng.pick(['mail.ru', 'ya.ru', 'gmail.com']);
	const dup = people[0] ?? 'anna';
	const emails: (string | null)[] = [
		`${dup}@${domain}`,
		`${dup.charAt(0).toUpperCase()}${dup.slice(1)}@${domain}`,
		null,
		`${people[1] ?? 'boris'}@${domain}`,
		`${(people[2] ?? 'vera').toUpperCase()}@${domain}`
	];
	if (rng.bool()) emails.push(`${people[3] ?? 'gleb'}@${domain}`);
	const rows: Row[] = rng.shuffle(emails).map((e, i) => [i + 1, rng.pick(names), e]);
	const head = [
		'PRAGMA foreign_keys = ON;',
		'-- версия 1',
		roomTable(
			'contacts',
			[
				['id', 'INTEGER', true],
				['name', 'TEXT', true],
				['email', 'TEXT', false]
			],
			{ primary: ['id'] }
		),
		insertRows('contacts', ['id', 'name', 'email'], rows),
		'PRAGMA user_version = 1;',
		'-- Migration(1, 2): email обязателен и уникален, хранится в нижнем регистре'
	];
	const newTable = (strict: boolean): string[] => [
		roomTable(
			'contacts_new',
			[
				['id', 'INTEGER', true],
				['name', 'TEXT', true],
				['email', 'TEXT', strict]
			],
			{ primary: ['id'] }
		),
		...(strict ? ['CREATE UNIQUE INDEX IF NOT EXISTS `index_contacts_email` ON `contacts_new` (`email`);'] : [])
	];
	const tail = [
		'DROP TABLE `contacts`;',
		'ALTER TABLE `contacts_new` RENAME TO `contacts`;',
		'PRAGMA user_version = 2;'
	];
	const copy = (verb: string, filter: string): string =>
		`INSERT ${verb} INTO contacts_new (id, name, email) SELECT id, name, lower(email) FROM contacts${filter} ORDER BY id;`;
	const query = 'SELECT id, name, email FROM contacts ORDER BY id;';
	return {
		setup: [...head, ...newTable(true), copy('OR IGNORE', ''), ...tail].join('\n'),
		query,
		statement: 'Room выполнил миграцию 1→2. Что вернёт запрос после неё?',
		wrong: {
			'ignore-keeps-all': { setup: [...head, ...newTable(false), copy('OR IGNORE', ''), ...tail].join('\n'), query },
			'ignore-keeps-last': {
				setup: [...head, ...newTable(true), copy('OR REPLACE', ' WHERE email IS NOT NULL'), ...tail].join('\n'),
				query
			}
		}
	};
}

function joinLoss(rng: Rng): SqlItem {
	const cats = rng.sample(['work', 'home', 'travel', 'study', 'sport'], 3);
	const titles = rng.sample(TITLES, 7);
	const first = cats[0] ?? 'work';
	// The traps: a category typed in another case, an unknown category, no category, and exact matches.
	const noteCats: (string | null)[] = [
		first,
		`${first.charAt(0).toUpperCase()}${first.slice(1)}`,
		rng.pick(['misc', 'other', 'todo']),
		null,
		cats[1] ?? 'home'
	];
	if (rng.bool()) noteCats.push(rng.pick(cats));
	const notes: Row[] = rng.shuffle(noteCats).map((c, i) => [i + 1, titles[i] ?? 'План', c]);
	const head = [
		'PRAGMA foreign_keys = ON;',
		'-- версия 1',
		roomTable(
			'notes',
			[
				['id', 'INTEGER', true],
				['title', 'TEXT', true],
				['category', 'TEXT', false]
			],
			{ primary: ['id'] }
		),
		insertRows('notes', ['id', 'title', 'category'], notes),
		'PRAGMA user_version = 1;',
		'-- Migration(1, 2): категории — отдельная таблица',
		roomTable(
			'categories',
			[
				['id', 'INTEGER', true],
				['name', 'TEXT', true]
			],
			{ primary: ['id'] }
		),
		insertRows(
			'categories',
			['id', 'name'],
			cats.map((c, i) => [i + 1, c])
		),
		roomTable(
			'notes_new',
			[
				['id', 'INTEGER', true],
				['title', 'TEXT', true],
				['category_id', 'INTEGER', false]
			],
			{ primary: ['id'] }
		)
	];
	const tail = ['DROP TABLE `notes`;', 'ALTER TABLE `notes_new` RENAME TO `notes`;', 'PRAGMA user_version = 2;'];
	const copy = (join: string, on: string): string =>
		`INSERT INTO notes_new (id, title, category_id) SELECT n.id, n.title, c.id FROM notes n ${join} categories c ON ${on};`;
	const query = 'SELECT id, title, category_id FROM notes ORDER BY id;';
	return {
		setup: [...head, copy('JOIN', 'c.name = n.category'), ...tail].join('\n'),
		query,
		statement: 'Room выполнил миграцию 1→2. Что вернёт запрос после неё?',
		wrong: {
			'join-keeps-all': { setup: [...head, copy('LEFT JOIN', 'c.name = n.category'), ...tail].join('\n'), query },
			'text-equals-nocase': {
				setup: [...head, copy('JOIN', 'c.name = n.category COLLATE NOCASE'), ...tail].join('\n'),
				query
			}
		}
	};
}

function chain(rng: Rng): SqlItem {
	const titles = rng.sample(TITLES, 8);
	const old = rng.int(2, 3);
	const v1: Row[] = [];
	for (let id = 1; id <= old; id += 1) v1.push([id, titles[id - 1] ?? 'План']);
	const v2: string[] = [];
	let id = old;
	// Version 2 saves notes with and without a colour, pinned and not.
	const colors = rng.shuffle([rng.pick(COLORS), null, rng.bool() ? rng.pick(COLORS) : null]);
	for (const color of colors) {
		id += 1;
		const pinned = rng.bool() ? 1 : 0;
		v2.push(
			color === null
				? `INSERT INTO notes (id, title, pinned) VALUES (${id}, '${titles[id - 1] ?? 'Идеи'}', ${pinned});`
				: `INSERT INTO notes (id, title, pinned, color) VALUES (${id}, '${titles[id - 1] ?? 'Идеи'}', ${pinned}, '${color}');`
		);
	}
	v2.push(`UPDATE notes SET pinned = 1 WHERE id = ${rng.int(1, old)};`);
	const head = [
		'PRAGMA foreign_keys = ON;',
		'-- версия 1',
		roomTable(
			'notes',
			[
				['id', 'INTEGER', true],
				['title', 'TEXT', true]
			],
			{ primary: ['id'] }
		),
		insertRows('notes', ['id', 'title'], v1),
		'PRAGMA user_version = 1;',
		'-- Migration(1, 2)',
		'ALTER TABLE `notes` ADD COLUMN `pinned` INTEGER NOT NULL DEFAULT 0;',
		'ALTER TABLE `notes` ADD COLUMN `color` TEXT;',
		'PRAGMA user_version = 2;',
		'-- приложение версии 2',
		...v2,
		"-- Migration(2, 3): у цвета появилось значение по умолчанию 'gray'",
		roomTable(
			'notes_new',
			[
				['id', 'INTEGER', true],
				['title', 'TEXT', true],
				['color', 'TEXT', false, "'gray'"],
				['pinned', 'INTEGER', true, '0']
			],
			{ primary: ['id'] }
		)
	];
	const tail = ['DROP TABLE `notes`;', 'ALTER TABLE `notes_new` RENAME TO `notes`;', 'PRAGMA user_version = 3;'];
	const script = (copy: string): string => [...head, copy, ...tail].join('\n');
	const query = 'SELECT id, title, color, pinned FROM notes ORDER BY id;';
	return {
		setup: script('INSERT INTO notes_new (id, title, color) SELECT id, title, color FROM notes;'),
		query,
		statement:
			'Приложение обновили с версии 1 сразу до версии 3 через промежуточную: Room выполнил миграции 1→2 и 2→3 в этом порядке. Что вернёт запрос после них?',
		wrong: {
			'default-fills-null': {
				setup: script("INSERT INTO notes_new (id, title, color) SELECT id, title, COALESCE(color, 'gray') FROM notes;"),
				query
			},
			'omitted-column-kept': {
				setup: script('INSERT INTO notes_new (id, title, color, pinned) SELECT id, title, color, pinned FROM notes;'),
				query
			}
		}
	};
}

const FULL_NAMES = [
	'Иван Петров',
	'Мария Ивановна Соколова',
	'Олег Смирнов',
	'Анна Мария Кузнецова',
	'Шер',
	'Глеб Орлов',
	'Дина Ли',
	'Егор Павлович Волков',
	'Зоя',
	'Кира Белова'
];

function splitAt(full: string, last: boolean): [string, string | null] {
	const at = last ? full.lastIndexOf(' ') : full.indexOf(' ');
	return at < 0 ? [full, null] : [full.slice(0, at), full.slice(at + 1)];
}

function splitColumn(rng: Rng): SqlItem {
	// The traps in every instance: a name of three words and a name of one word.
	const three = rng.pick(FULL_NAMES.filter((n) => n.split(' ').length === 3));
	const one = rng.pick(FULL_NAMES.filter((n) => !n.includes(' ')));
	const two = rng.sample(
		FULL_NAMES.filter((n) => n.split(' ').length === 2),
		rng.int(2, 3)
	);
	const extra = rng.bool() ? FULL_NAMES.filter((n) => n.split(' ').length === 3 && n !== three).slice(0, 1) : [];
	const names = rng.shuffle([three, one, ...two, ...extra]);
	const users: Row[] = names.map((n, i) => [i + 1, n]);
	const head = [
		'PRAGMA foreign_keys = ON;',
		'-- версия 2',
		roomTable(
			'users',
			[
				['id', 'INTEGER', true],
				['full_name', 'TEXT', true]
			],
			{ primary: ['id'] }
		),
		insertRows('users', ['id', 'full_name'], users),
		'PRAGMA user_version = 2;',
		'-- Migration(2, 3): имя делится на имя и фамилию',
		roomTable(
			'users_new',
			[
				['id', 'INTEGER', true],
				['first_name', 'TEXT', true],
				['last_name', 'TEXT', false]
			],
			{ primary: ['id'] }
		)
	];
	const tail = ['DROP TABLE `users`;', 'ALTER TABLE `users_new` RENAME TO `users`;', 'PRAGMA user_version = 3;'];
	const copy = [
		'INSERT INTO users_new (id, first_name, last_name)',
		"SELECT id, CASE WHEN instr(full_name, ' ') = 0 THEN full_name ELSE substr(full_name, 1, instr(full_name, ' ') - 1) END,",
		"CASE WHEN instr(full_name, ' ') = 0 THEN NULL ELSE substr(full_name, instr(full_name, ' ') + 1) END FROM users;"
	].join('\n');
	const query = 'SELECT first_name, last_name FROM users ORDER BY last_name, first_name;';
	const byLast: Row[] = names.map((n, i) => [i + 1, ...splitAt(n, true)]);
	return {
		setup: [...head, copy, ...tail].join('\n'),
		query,
		statement: 'Room выполнил миграцию 2→3, затем экран контактов загрузил список. Что вернёт запрос?',
		wrong: {
			'split-last-space': {
				setup: [...head, insertRows('users_new', ['id', 'first_name', 'last_name'], byLast), ...tail].join('\n'),
				query
			},
			'nulls-largest': {
				setup: [...head, copy, ...tail].join('\n'),
				query: 'SELECT first_name, last_name FROM users ORDER BY last_name IS NULL, last_name, first_name;'
			}
		}
	};
}

function dropCascade(rng: Rng): SqlItem {
	const titles = rng.sample(CHAT_TITLES, 4);
	const count = rng.int(3, 4);
	const chats: Row[] = [];
	for (let id = 1; id <= count; id += 1) chats.push([id, titles[id - 1] ?? 'Семья']);
	const messages: Row[] = [];
	for (let id = 1; id <= count; id += 1)
		for (let k = rng.int(1, 3); k > 0; k -= 1) messages.push([id, rng.pick(MESSAGE_BODIES)]);
	const after: Row[] = [[rng.int(1, count), rng.pick(MESSAGE_BODIES)]];
	const script = (fk: 'ON' | 'OFF'): string =>
		[
			`PRAGMA foreign_keys = ${fk};`,
			'-- версия 1',
			roomTable(
				'chats',
				[
					['id', 'INTEGER', true],
					['title', 'TEXT', true]
				],
				{ primary: ['id'] }
			),
			roomTable(
				'messages',
				[
					['id', 'INTEGER', true],
					['chat_id', 'INTEGER', true],
					['body', 'TEXT', true]
				],
				{ autoGenerate: 'id' },
				['FOREIGN KEY(`chat_id`) REFERENCES `chats`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE']
			),
			insertRows('chats', ['id', 'title'], chats),
			insertRows('messages', ['chat_id', 'body'], messages),
			'PRAGMA user_version = 1;',
			'-- Migration(1, 2): у чата появился флаг архива',
			roomTable(
				'chats_new',
				[
					['id', 'INTEGER', true],
					['title', 'TEXT', true],
					['archived', 'INTEGER', true, '0']
				],
				{ primary: ['id'] }
			),
			'INSERT INTO chats_new (id, title) SELECT id, title FROM chats;',
			'DROP TABLE `chats`;',
			'ALTER TABLE `chats_new` RENAME TO `chats`;',
			'PRAGMA user_version = 2;',
			'-- приложение версии 2',
			insertRows('messages', ['chat_id', 'body'], after)
		].join('\n');
	const query =
		'SELECT c.id, c.title, c.archived, COUNT(m.id) FROM chats c LEFT JOIN messages m ON m.chat_id = c.id GROUP BY c.id ORDER BY c.id;';
	return {
		setup: script('ON'),
		query,
		statement:
			'Room выполнил миграцию 1→2 с включёнными внешними ключами (первая строка скрипта), затем пришло новое сообщение. Что вернёт запрос?',
		wrong: { 'drop-keeps-children': { setup: script('OFF'), query } }
	};
}

function stepOrder(rng: Rng): SqlItem {
	const titles = rng.sample(TITLES, 8);
	const count = rng.int(4, 5);
	const rows: Row[] = [];
	for (let id = 1; id <= count; id += 1) {
		const title = titles[id - 1] ?? 'План';
		rows.push([id, id <= 2 ? urgent(title) : title, rng.bool(0.5) ? rng.pick(COLORS) : null]);
	}
	// The traps in every instance: an urgent note without a colour, a plain note without a colour.
	const first = rows[0];
	if (first) first[2] = null;
	const plain = rows[2];
	if (plain) plain[2] = null;
	const shuffled = rng.shuffle(rows).map((r, i) => [i + 1, r[1] ?? 'План', r[2] ?? null]);
	const fix = "UPDATE notes SET color = 'red' WHERE title LIKE '%!';";
	const head = [
		'PRAGMA foreign_keys = ON;',
		'-- версия 1',
		roomTable(
			'notes',
			[
				['id', 'INTEGER', true],
				['title', 'TEXT', true],
				['color', 'TEXT', false]
			],
			{ primary: ['id'] }
		),
		insertRows('notes', ['id', 'title', 'color'], shuffled),
		'PRAGMA user_version = 1;',
		"-- Migration(1, 2): цвет обязателен, срочные заметки (с '!' в конце) — красные",
		roomTable(
			'notes_new',
			[
				['id', 'INTEGER', true],
				['title', 'TEXT', true],
				['color', 'TEXT', true, "'gray'"]
			],
			{ primary: ['id'] }
		),
		"INSERT INTO notes_new (id, title, color) SELECT id, title, COALESCE(color, 'gray') FROM notes;"
	];
	const tail = ['DROP TABLE `notes`;', 'ALTER TABLE `notes_new` RENAME TO `notes`;', 'PRAGMA user_version = 2;'];
	const query = 'SELECT id, title, color FROM notes ORDER BY id;';
	return {
		setup: [...head, fix, ...tail].join('\n'),
		query,
		statement: 'Room выполнил миграцию 1→2. Что вернёт запрос после неё?',
		wrong: {
			'update-after-copy-kept': { setup: [...head, ...tail, fix].join('\n'), query }
		}
	};
}

const MAKERS: Record<string, (rng: Rng) => SqlItem> = {
	'junior/add-column': addColumn,
	'junior/column-order': columnOrder,
	'junior/constraint-loss': constraintLoss,
	'junior/join-loss': joinLoss,
	'middle/chain': chain,
	'middle/split-column': splitColumn,
	'middle/drop-cascade': dropCascade,
	'middle/step-order': stepOrder
};

export function build(input: GenerateInput): Built {
	const make = MAKERS[`${input.grade}/${input.classId}`];
	if (!make) throw new Error(`${descriptor.key}: no class ${input.grade}/${input.classId}`);
	return buildSql(descriptor, input, REQUIRED, make);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
