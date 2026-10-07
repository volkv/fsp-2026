// Practice: the data of a chat list screen from a log of messages — per chat the counter of unread messages of the
// others and the preview of the last message cut to K characters, in the order the class sets (newest first, pinned on
// top, unread first, alphabetical with muted chats). Junior logs arrive out of time order and carry edits and
// deletions. Parametric hidden tests in five groups; the candidate writes Kotlin.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type HiddenTestGroup,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import type { Rng } from '../../_lib/rng.ts';

const LANGUAGES = ['kotlin'] as const;

const descriptor = readDescriptor(import.meta.url);

const ME = 'me';
const OWN = 'Вы: ';
const ELLIPSIS = '…';

const CHAT_NAMES = [
	'family',
	'work',
	'android_team',
	'design',
	'football',
	'school',
	'neighbors',
	'travel',
	'books',
	'support',
	'backend',
	'qa_chat',
	'friends',
	'gym',
	'cinema',
	'music',
	'dacha',
	'robots',
	'release',
	'parents'
];
const WORDS = [
	'привет',
	'как',
	'дела',
	'завтра',
	'встреча',
	'в',
	'десять',
	'созвон',
	'отправил',
	'макет',
	'посмотри',
	'пожалуйста',
	'ок',
	'спасибо',
	'билеты',
	'купил',
	'где',
	'ты',
	'уже',
	'еду',
	'релиз',
	'сборка',
	'упала',
	'починил',
	'тесты',
	'зелёные',
	'кофе',
	'обед',
	'через',
	'минут',
	'фото',
	'скинь',
	'адрес',
	'договорились'
];

interface Message {
	id: number;
	ts: number;
	chat: string;
	author: string;
	read: boolean;
	text: string;
}
type LogEvent = { kind: 'msg'; m: Message } | { kind: 'edit'; id: number; text: string } | { kind: 'del'; id: number };
interface Input {
	k: number;
	/** Pinned chats in the order of pinning (class `pinned`) or muted chats (class `muted-alpha`). */
	flagged: string[];
	events: LogEvent[];
}

const WRONG_IDS = [
	'counts-own',
	'ellipsis-at-k',
	'prefix-in-limit',
	'pin-order',
	'last-line',
	'equal-ts-first',
	'delete-no-rollback'
] as const;
type WrongId = (typeof WRONG_IDS)[number];
type Variant = 'right' | WrongId;

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Row {
	chat: string;
	unread: number;
	ts: number;
	preview: string;
}

/** The rows of the screen before ordering; a variant other than `right` reproduces a wrong solution. */
function rowsOf(input: Input, variant: Variant): Row[] {
	interface Entry {
		m: Message;
		line: number;
		text: string;
		alive: boolean;
	}
	const entries = new Map<number, Entry>();
	input.events.forEach((e, line) => {
		if (e.kind === 'msg') entries.set(e.m.id, { m: e.m, line, text: e.m.text, alive: true });
		else {
			const entry = entries.get(e.id);
			if (!entry) throw new Error(`${descriptor.key}: event on an unknown message ${e.id}`);
			if (e.kind === 'edit') entry.text = e.text;
			else entry.alive = false;
		}
	});
	const later = (a: Entry, b: Entry): boolean => {
		if (variant === 'last-line') return a.line > b.line;
		if (variant === 'equal-ts-first') return a.m.ts > b.m.ts;
		return a.m.ts > b.m.ts || (a.m.ts === b.m.ts && a.line > b.line);
	};
	const perChat = new Map<string, { last: Entry; unread: number }>();
	for (const e of entries.values()) {
		if (!e.alive && variant !== 'delete-no-rollback') continue;
		const row = perChat.get(e.m.chat) ?? { last: e, unread: 0 };
		if (later(e, row.last)) row.last = e;
		if (e.alive && !e.m.read && (e.m.author !== ME || variant === 'counts-own')) row.unread += 1;
		perChat.set(e.m.chat, row);
	}
	const cut = (s: string): string =>
		(variant === 'ellipsis-at-k' ? s.length >= input.k : s.length > input.k) ? s.slice(0, input.k) + ELLIPSIS : s;
	return [...perChat].map(([chat, { last, unread }]) => {
		const own = last.m.author === ME;
		const preview =
			variant === 'prefix-in-limit' ? cut((own ? OWN : '') + last.text) : (own ? OWN : '') + cut(last.text);
		return { chat, unread, ts: last.m.ts, preview };
	});
}

const recent = (a: Row, b: Row): number => b.ts - a.ts || byName(a.chat, b.chat);

/** The expected screen of the class on an input. */
function solve(classId: string, input: Input, variant: Variant = 'right'): string {
	const rows = rowsOf(input, variant);
	let ordered: Row[];
	if (classId === 'recent') ordered = rows.sort(recent);
	else if (classId === 'unread-first')
		ordered = rows.sort((a, b) => Number(a.unread === 0) - Number(b.unread === 0) || recent(a, b));
	else if (classId === 'pinned') {
		const order = variant === 'pin-order' ? input.flagged : [...input.flagged].reverse();
		const top = order.flatMap((chat) => rows.filter((r) => r.chat === chat));
		ordered = [...top, ...rows.filter((r) => !input.flagged.includes(r.chat)).sort(recent)];
	} else ordered = rows.sort((a, b) => byName(a.chat, b.chat));
	const muted = classId === 'muted-alpha';
	return ordered
		.map((r) => `${r.chat} ${muted && input.flagged.includes(r.chat) ? '-' : r.unread} ${r.preview}`)
		.join('\n');
}

function render(classId: string, input: Input, junior: boolean): string {
	const head = [`${input.events.length} ${input.k}`];
	if (classId === 'pinned' || classId === 'muted-alpha') head.push([input.flagged.length, ...input.flagged].join(' '));
	const lines = input.events.map((e) => {
		if (e.kind === 'edit') return `edit ${e.id} ${e.text}`;
		if (e.kind === 'del') return `del ${e.id}`;
		const m = e.m;
		const body = `${m.ts} ${m.chat} ${m.author} ${m.read ? 1 : 0} ${m.text}`;
		return junior ? `msg ${m.id} ${body}` : body;
	});
	return `${[...head, ...lines].join('\n')}\n`;
}

/** A text of exactly `length` characters: words with single spaces, no space at either end. */
function makeText(rng: Rng, length: number): string {
	const words: string[] = [];
	while (words.join(' ').length < length) words.push(rng.pick(WORDS));
	const text = words.join(' ').slice(0, length);
	return text.endsWith(' ') ? `${text.slice(0, -1)}о` : text;
}

type GroupId = 'basic' | 'trim' | 'own' | 'quiet' | 'ties' | 'edits' | 'scale';

interface Shape {
	chats: number;
	messages: number;
	own: number;
	read: number;
	/** Lengths of texts near K. */
	trim: boolean;
	/** Step between timestamps may be zero (Junior). */
	ties: boolean;
	/** Lines out of time order (Junior). */
	shuffle: boolean;
	/** Share of messages edited and deleted (Junior), and whether one chat loses every message. */
	edits: number;
	wipe: boolean;
	/** Flagged chats that have no messages. */
	ghosts: number;
}

function shapeOf(rng: Rng, group: GroupId, junior: boolean): Shape {
	const base: Shape = {
		chats: rng.int(3, 6),
		messages: rng.int(8, 16),
		own: 0.25,
		read: 0.5,
		trim: false,
		ties: false,
		shuffle: junior,
		edits: junior ? 0.15 : 0,
		wipe: false,
		ghosts: 0
	};
	switch (group) {
		case 'trim':
			return { ...base, trim: true };
		case 'own':
			return { ...base, own: 0.5, read: 0.4, trim: rng.bool() };
		case 'quiet':
			return { ...base, own: 0.4, read: 0.8, ghosts: rng.int(1, 2) };
		case 'ties':
			return { ...base, ties: true, trim: true };
		case 'edits':
			return { ...base, messages: rng.int(10, 18), edits: 0.4, wipe: true, ghosts: 1 };
		case 'scale':
			return {
				...base,
				chats: rng.int(120, 200),
				messages: junior ? rng.int(1800, 2200) : rng.int(2500, 3000),
				ties: junior,
				trim: true,
				edits: junior ? 0.2 : 0,
				wipe: junior,
				ghosts: 2
			};
		default:
			return base;
	}
}

function makeInput(rng: Rng, shape: Shape): Input {
	const pool =
		shape.chats <= CHAT_NAMES.length
			? rng.sample(CHAT_NAMES, Math.min(shape.chats + shape.ghosts, CHAT_NAMES.length))
			: Array.from({ length: shape.chats + shape.ghosts }, (_, i) => `${rng.pick(CHAT_NAMES)}_${i + 1}`);
	const chats = pool.slice(0, shape.chats);
	const ghosts = pool.slice(shape.chats);
	const k = rng.int(6, 24);
	const length = (): number =>
		shape.trim && rng.bool(0.7) ? k + rng.int(-1, 1) : rng.bool(0.5) ? rng.int(1, k - 1) : rng.int(k + 2, 2 * k + 10);
	let ts = rng.int(1000, 90_000);
	const messages: Message[] = [];
	// Every chat gets a message, then the rest at random.
	const order = [
		...rng.shuffle(chats),
		...Array.from({ length: Math.max(0, shape.messages - chats.length) }, () => rng.pick(chats))
	];
	for (const chat of order) {
		ts += shape.ties && rng.bool(0.35) ? 0 : rng.int(1, 9) * 10;
		const own = rng.bool(shape.own);
		messages.push({
			id: 0,
			ts,
			chat,
			author: own ? ME : rng.pick(PERSON_NAMES),
			read: rng.bool(shape.read),
			text: makeText(rng, length())
		});
	}
	// Lines out of time order: a message arrives up to a few steps late.
	const lines = shape.shuffle
		? messages
				.map((m, i) => ({ m, key: i + rng.int(0, 3) + rng.next() }))
				.sort((a, b) => a.key - b.key)
				.map((x) => x.m)
		: messages;
	let id = rng.int(100, 900);
	for (const m of lines) m.id = id += rng.int(1, 4);
	const events: LogEvent[] = lines.map((m) => ({ kind: 'msg', m }));
	if (shape.edits > 0) {
		const alive = new Set(lines.map((m) => m.id));
		const insert = (at: number, e: LogEvent): void => {
			events.splice(at, 0, e);
		};
		for (const m of rng.sample(lines, Math.floor(lines.length * shape.edits))) {
			const after = events.findIndex((e) => e.kind === 'msg' && e.m.id === m.id) + 1;
			const at = rng.int(after, events.length);
			if (rng.bool()) insert(at, { kind: 'edit', id: m.id, text: makeText(rng, length()) });
			else {
				// A deletion after every edit of the message: nothing refers to a deleted message.
				const lastRef = events.reduce((acc, e, i) => (e.kind !== 'msg' && e.id === m.id ? i + 1 : acc), after);
				insert(Math.max(at, lastRef), { kind: 'del', id: m.id });
				alive.delete(m.id);
			}
		}
		if (shape.wipe) {
			const victim = rng.pick(chats);
			for (const m of lines.filter((x) => x.chat === victim && alive.has(x.id))) {
				events.push({ kind: 'del', id: m.id });
				alive.delete(m.id);
			}
		}
	}
	const flagged = rng.shuffle([...rng.sample(chats, Math.min(chats.length, rng.int(2, 3))), ...ghosts]);
	return { k, flagged, events };
}

/** The wrong solutions a group must expose on every test of the class. */
function traps(classId: string, group: GroupId, junior: boolean): WrongId[] {
	const pinned: WrongId[] = classId === 'pinned' ? ['pin-order'] : [];
	switch (group) {
		case 'basic':
			return junior ? ['last-line', ...pinned] : pinned;
		case 'trim':
			return ['ellipsis-at-k'];
		case 'ties':
			return ['equal-ts-first', 'ellipsis-at-k'];
		case 'own':
			return ['counts-own', 'prefix-in-limit'];
		case 'edits':
			return ['delete-no-rollback'];
		default:
			return [];
	}
}

const GROUPS: Record<'intern' | 'junior', GroupId[]> = {
	intern: ['basic', 'trim', 'own', 'quiet', 'scale'],
	junior: ['basic', 'ties', 'own', 'edits', 'scale']
};

/** Hidden tests of the class; every test tells the class from the others of the level. */
function groups(rng: Rng, classId: string, others: readonly string[], junior: boolean): HiddenTestGroup[] {
	return GROUPS[junior ? 'junior' : 'intern'].map((id) => {
		const count = id === 'scale' ? 1 : 4;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${classId}`);
			const input = makeInput(rng, shapeOf(rng, id, junior));
			const expected = solve(classId, input);
			if (expected === '' || others.some((other) => solve(other, input) === expected)) continue;
			if (traps(classId, id, junior).some((v) => solve(classId, input, v) === expected)) continue;
			tests.push({ stdin: render(classId, input, junior), expected: `${expected}\n` });
		}
		return { id, tests };
	});
}

const ORDER: Record<string, string> = {
	recent:
		'Строки — по убыванию момента последнего сообщения чата (сверху самый свежий чат), при равенстве моментов — по названию чата в лексикографическом порядке.',
	pinned:
		'Сверху — закреплённые чаты: вторая строка входа перечисляет их в порядке закрепления, а на экране закреплённый **позже** стоит **выше** (последний закреплённый — первая строка). Закреплённый чат без сообщений не показывается. Под закреплёнными — остальные чаты по убыванию момента последнего сообщения, при равенстве моментов — по названию в лексикографическом порядке.',
	'unread-first':
		'Сверху — чаты, в которых есть непрочитанные (счётчик больше нуля), под ними — остальные. Внутри каждой части — по убыванию момента последнего сообщения, при равенстве моментов — по названию чата в лексикографическом порядке.',
	'muted-alpha':
		'Строки — по названию чата в лексикографическом порядке. У чатов без уведомлений (они перечислены во второй строке входа; там могут быть и чаты без сообщений) вместо счётчика печатается `-`.'
};

const FLAG_LINE: Record<string, string> = {
	pinned:
		'Во второй строке — `P` и затем `P` названий закреплённых чатов в порядке закрепления (0 ≤ P ≤ 10; названия различны).',
	'muted-alpha':
		'Во второй строке — `M` и затем `M` названий чатов с отключёнными уведомлениями (0 ≤ M ≤ 10; названия различны).'
};

function statement(classId: string, junior: boolean): string {
	const flag = FLAG_LINE[classId];
	return [
		'Экран «Чаты» мессенджера строится из журнала сообщений. Напишите на Kotlin программу (`fun main()`), которая читает журнал со стандартного ввода и печатает строки списка чатов.',
		'',
		'## Вход',
		'',
		junior
			? 'В первой строке — числа `N` и `K`: число строк журнала (1 ≤ N ≤ 5000) и длина превью (1 ≤ K ≤ 50).'
			: 'В первой строке — числа `N` и `K`: число сообщений (1 ≤ N ≤ 5000) и длина превью (1 ≤ K ≤ 50).',
		...(flag ? [flag] : []),
		'',
		...(junior
			? [
					'Далее `N` строк журнала трёх видов:',
					'',
					'- `msg <id> <t> <чат> <автор> <прочитано> <текст>` — новое сообщение;',
					'- `edit <id> <текст>` — сообщение `id` отредактировано: новый текст заменяет прежний, момент и место сообщения не меняются;',
					'- `del <id>` — сообщение `id` удалено: оно больше не существует ни для счётчика, ни для превью.',
					'',
					'`id` — уникальный номер сообщения (целое до 10⁹); `edit` и `del` ссылаются только на уже пришедшее и не удалённое сообщение.',
					'`t` — момент отправки в мс (целое от 0 до 10⁹). Сообщения приходят **не по порядку времени**: строка с меньшим `t` может стоять ниже, моменты могут совпадать. Последнее сообщение чата — с наибольшим `t`; из сообщений с одинаковым `t` последним считается то, чья строка `msg` стоит ниже.'
				]
			: [
					'Далее `N` строк `<t> <чат> <автор> <прочитано> <текст>` — сообщения в порядке отправки: `t` — момент в мс (целое от 0 до 10⁹), моменты строго возрастают сверху вниз.'
				]),
		'',
		'- чат и автор — строки из латинских букв, цифр и `_`; автор `me` — это владелец телефона (свои сообщения), остальные — собеседники;',
		'- прочитано — `1` или `0`;',
		'- текст — всё до конца строки: слова из букв (в том числе русских) через одиночные пробелы, без пробелов в начале и конце, от 1 до 100 символов.',
		'',
		'## Выход',
		'',
		`По строке на каждый чат, в котором есть ${junior ? 'хотя бы одно неудалённое сообщение' : 'хотя бы одно сообщение'}: \`<чат> <счётчик> <превью>\`.`,
		'',
		`- счётчик — число непрочитанных (\`0\`) сообщений собеседников в чате${junior ? ' (удалённые не считаются)' : ''}; свои сообщения в счётчик не входят никогда, каким бы ни был их флаг;`,
		'- превью — текст последнего сообщения чата: если он длиннее `K` символов — первые `K` символов и сразу за ними символ `…` (U+2026, один символ), иначе текст целиком; если последнее сообщение своё, перед превью ставится `Вы: ` (с пробелом), и в `K` символов этот префикс не входит.',
		'',
		ORDER[classId] ?? '',
		'',
		`Скрытые тесты — пять групп: обычные данные, ${junior ? 'равные моменты и границы обрезки превью' : 'границы обрезки превью'}, свои сообщения, ${junior ? 'правки и удаления' : 'чаты без непрочитанных и упомянутые чаты без сообщений'}, большой объём (тысячи строк). Группа засчитывается, если пройдены все её тесты.`
	].join('\n');
}

/** The reference program of a class in Python; a variant other than `right` is a wrong solution. */
function referenceSource(classId: string, junior: boolean, variant: Variant): string {
	const flagged = classId === 'pinned' || classId === 'muted-alpha';
	const keepDeleted = variant === 'delete-no-rollback';
	const read = junior
		? [
				'for order, line in enumerate(lines[start:start + n]):',
				"    kind, rest = line.split(' ', 1)",
				"    if kind == 'msg':",
				"        mid, ts, chat, author, read, text = rest.split(' ', 5)",
				"        msgs[mid] = [int(ts), order, chat, author, read == '0', text, True]",
				"    elif kind == 'edit':",
				"        mid, text = rest.split(' ', 1)",
				'        msgs[mid][5] = text',
				'    else:',
				'        msgs[rest][6] = False'
			]
		: [
				'for order, line in enumerate(lines[start:start + n]):',
				"    ts, chat, author, read, text = line.split(' ', 4)",
				"    msgs[order] = [int(ts), order, chat, author, read == '0', text, True]"
			];
	const newer =
		!junior || variant === 'last-line'
			? '    c[0] = m'
			: variant === 'equal-ts-first'
				? '    if m[0] > c[0][0]:\n        c[0] = m'
				: '    if (m[0], m[1]) > (c[0][0], c[0][1]):\n        c[0] = m';
	const unread = [
		variant === 'counts-own' ? '    if m[4]' : "    if m[4] and m[3] != 'me'",
		keepDeleted ? ' and m[6]:' : ':'
	].join('');
	const cut = variant === 'ellipsis-at-k' ? 'len(s) >= k' : 'len(s) > k';
	const preview =
		variant === 'prefix-in-limit'
			? "    preview = cut(('Вы: ' if m[3] == 'me' else '') + m[5])"
			: "    preview = 'Вы: ' + cut(m[5]) if m[3] == 'me' else cut(m[5])";
	const order: Record<string, string[]> = {
		recent: ['rows.sort(key=lambda r: (-r[2], r[0]))'],
		'unread-first': ['rows.sort(key=lambda r: (r[1] == 0, -r[2], r[0]))'],
		pinned: [
			`top = [r for p in ${variant === 'pin-order' ? 'flagged' : 'reversed(flagged)'} for r in rows if r[0] == p]`,
			'rest = sorted((r for r in rows if r[0] not in flagged), key=lambda r: (-r[2], r[0]))',
			'rows = top + rest'
		],
		'muted-alpha': ['rows.sort()']
	};
	const counter = classId === 'muted-alpha' ? "'-' if r[0] in flagged else r[1]" : 'r[1]';
	return [
		'import sys',
		'',
		"lines = sys.stdin.read().split('\\n')",
		'n, k = map(int, lines[0].split())',
		...(flagged ? ['flagged = lines[1].split()[1:]', 'start = 2'] : ['start = 1']),
		'msgs = {}',
		...read,
		'chats = {}',
		'for m in msgs.values():',
		...(keepDeleted ? [] : ['    if not m[6]:', '        continue']),
		'    c = chats.setdefault(m[2], [m, 0])',
		newer,
		unread,
		'        c[1] += 1',
		'',
		'',
		'def cut(s):',
		`    return s[:k] + '…' if ${cut} else s`,
		'',
		'',
		'rows = []',
		'for chat, (m, unread) in chats.items():',
		preview,
		'    rows.append((chat, unread, m[0], preview))',
		...(order[classId] ?? []),
		'for r in rows:',
		`    print(r[0], ${counter}, r[3])`
	].join('\n');
}

function applies(id: WrongId, classId: string, junior: boolean): boolean {
	switch (id) {
		case 'counts-own':
		case 'ellipsis-at-k':
		case 'prefix-in-limit':
			return true;
		case 'pin-order':
			return classId === 'pinned';
		case 'last-line':
		case 'equal-ts-first':
		case 'delete-no-rollback':
			return junior;
	}
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const others = level.classes.map((c) => c.id).filter((id) => id !== input.classId);
	const hidden = groups(rng, input.classId, others, junior);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(input.classId, junior), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: hidden, checker: { kind: 'tokens' } }
	});
	return {
		instance,
		reference: () => ({
			kind: 'practice',
			source: referenceSource(input.classId, junior, 'right'),
			changeSource: null
		}),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, input.classId, junior)
						? { kind: 'program' as const, source: referenceSource(input.classId, junior, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
