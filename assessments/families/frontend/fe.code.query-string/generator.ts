// Practice: parse query strings of URLs and print each in a canonical form (sorted keys, percent-encoded by the
// unreserved set). The class sets what a repeated key means (the last value, all values, lists by `[]` in the PHP way,
// flags and removal by an empty value); Junior adds multibyte UTF-8, `%` without two hex digits, encoded keys and
// `=` inside a value. Parametric hidden tests in five groups; two of them are plain: keys and values of letters, digits
// and `-._`, nothing to decode and nothing to encode but the brackets of a key.
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
import type { Rng } from '../../_lib/rng.ts';

const LANGUAGES = ['javascript', 'typescript'] as const;

const descriptor = readDescriptor(import.meta.url);

type Variant = 'right' | (typeof WRONG_IDS)[number];
const WRONG_IDS = [
	'plus-kept',
	'plus-after-decode',
	'encode-uri-component',
	'no-sort',
	'split-every-eq',
	'keys-raw',
	'first-wins',
	'scalar-joins-list',
	'empty-kept'
] as const;

/** The wrong solutions of one rule of repeated keys: each applies to its class only. */
const CLASS_OF: Partial<Record<Variant, string>> = {
	'first-wins': 'last-wins',
	'scalar-joins-list': 'php-brackets',
	'empty-kept': 'flags'
};

/** Not a wrong solution: keys ordered by their encoded form (`[]` included), which the plain tests must not feel. */
type Probe = Variant | 'sort-encoded';

// ---------------------------------------------------------------------------------------------------------------
// The model.

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function encode(s: string, variant: Probe): string {
	let out = '';
	for (const byte of ENCODER.encode(s)) {
		const c = String.fromCharCode(byte);
		if (byte < 0x80 && (UNRESERVED.test(c) || (variant === 'encode-uri-component' && "!'()*".includes(c)))) out += c;
		else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
	}
	return out;
}

/** `+` as a space, then `%XX` as bytes (a `%` without two hex digits stays), the bytes read as UTF-8. */
function decode(s: string, variant: Probe): string {
	const text = variant === 'right' || !variant.startsWith('plus') ? s.replaceAll('+', ' ') : s;
	const bytes: number[] = [];
	for (let i = 0; i < text.length; i += 1) {
		const hex = text.slice(i + 1, i + 3);
		if (text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			i += 2;
		} else bytes.push(text.charCodeAt(i));
	}
	const decoded = DECODER.decode(new Uint8Array(bytes));
	return variant === 'plus-after-decode' ? decoded.replaceAll('+', ' ') : decoded;
}

interface Part {
	key: string;
	value: string;
	eq: boolean;
}

function parts(line: string, variant: Probe): Part[] {
	return line
		.slice(1)
		.split('&')
		.map((piece) => {
			const i = piece.indexOf('=');
			const eq = i >= 0;
			const rawKey = eq ? piece.slice(0, i) : piece;
			const rawValue = eq ? piece.slice(i + 1) : '';
			return {
				key: variant === 'keys-raw' ? rawKey : decode(rawKey, variant),
				value: decode(variant === 'split-every-eq' ? (rawValue.split('=')[0] ?? '') : rawValue, variant),
				eq
			};
		});
}

/** The canonical form of one query string; a variant other than `right` reproduces a wrong solution. */
function canonical(classId: string, line: string, variant: Probe): string {
	// A parameter: one value, a list (all values or `[]`), or a flag (null).
	const params = new Map<string, string | string[] | null>();
	for (const { key, value, eq } of parts(line, variant)) {
		if (classId === 'php-brackets' && key.endsWith('[]')) {
			const name = key.slice(0, -2);
			const list = params.get(name);
			if (Array.isArray(list)) list.push(value);
			else if (variant === 'scalar-joins-list' && typeof list === 'string') params.set(name, [list, value]);
			else params.set(name, [value]);
		} else if (key === '') continue;
		else if (classId === 'all-values') {
			const list = params.get(key);
			if (Array.isArray(list)) list.push(value);
			else params.set(key, [value]);
		} else if (classId === 'flags' && !eq) params.set(key, null);
		else if (classId === 'flags' && value === '' && variant !== 'empty-kept') params.delete(key);
		else if (variant !== 'first-wins' || !params.has(key)) params.set(key, value);
	}
	const names = [...params.keys()];
	if (variant === 'sort-encoded') {
		const shown = (name: string): string =>
			encode(classId === 'php-brackets' && Array.isArray(params.get(name)) ? `${name}[]` : name, 'right');
		names.sort((a, b) => (shown(a) < shown(b) ? -1 : shown(a) > shown(b) ? 1 : 0));
	} else if (variant !== 'no-sort') names.sort();
	const pairs = names.flatMap((name) => {
		const v = params.get(name);
		if (v === null || v === undefined) return [encode(name, variant)];
		if (!Array.isArray(v)) return [`${encode(name, variant)}=${encode(v, variant)}`];
		const key = classId === 'php-brackets' ? `${name}[]` : name;
		return v.map((item) => `${encode(key, variant)}=${encode(item, variant)}`);
	});
	return `?${pairs.join('&')}`;
}

function solve(classId: string, lines: readonly string[], variant: Probe = 'right'): string {
	return `${lines.map((line) => canonical(classId, line, variant)).join('\n')}\n`;
}

const render = (lines: readonly string[]): string => `${[String(lines.length), ...lines].join('\n')}\n`;

// ---------------------------------------------------------------------------------------------------------------
// Query strings.

const KEYS = [
	'q',
	'page',
	'sort',
	'tag',
	'id',
	'lang',
	'filter',
	'limit',
	'from',
	'to',
	'ref',
	'city',
	'color',
	'size'
];
const COMPOUND = ['utm_source', 'price-from', 'price.to', 'per_page', 'sort-by'];
const WORDS = ['red', 'blue', 'sale', 'new', 'spb', 'msk', 'book', 'asc', 'desc', 'price', '2024', '10', '50', 'tv'];
const CYRILLIC = ['город', 'книга', 'цена', 'синий', 'ёлка', 'мяч'];
/** Keys beyond Cyrillic: above U+FFFF (two UTF-16 code units) and just below it, where code points and units disagree. */
const WIDE = ['😀', '𝒙y', 'ｑ', '№'];
/** Special characters written as they are and as `%XX`: every one is encoded on output. */
const SPECIAL_RAW = ['!', '*', "'", '(', ')', ',', ':', '/', '@', '$', ';'];
const SPECIAL_ENCODED = [
	'%21',
	'%2A',
	'%27',
	'%28',
	'%29',
	'%2C',
	'%3A',
	'%2F',
	'%40',
	'%26',
	'%3D',
	'%3F',
	'%25',
	'%23'
];
/** A `%` without two hex digits after it, safe before any next piece. */
const MALFORMED = ['%zz', '%gx', '%_1', '%.x', '%-'];

/** The bytes of a string as `%XX`, the hex digits in upper or lower case. */
function percent(rng: Rng, s: string): string {
	const lower = rng.bool(0.4);
	return [...ENCODER.encode(s)]
		.map((b) => {
			const hex = b.toString(16).padStart(2, '0');
			return `%${lower ? hex : hex.toUpperCase()}`;
		})
		.join('');
}

type GroupId = 'basic' | 'encoding' | 'repeat' | 'edge' | 'scale';

/**
 * The groups a partly right solution passes: keys and values of Latin letters, digits and `-._` only, no empty parts
 * and no parts without a key, and the order of keys is the same by their decoded and by their encoded form. The rule
 * of repeated keys stays: it is the essential parameter of a class.
 */
const PLAIN: ReadonlySet<GroupId> = new Set(['basic', 'scale']);
const PLAIN_PIECES = ['-', '.', '_'];

interface Style {
	junior: boolean;
	group: GroupId;
}

function valuePiece(rng: Rng, s: Style): string {
	if (PLAIN.has(s.group)) {
		if (rng.bool(0.15)) return rng.pick(PLAIN_PIECES);
		const word = rng.pick(WORDS);
		return rng.bool(0.15) ? word.toUpperCase() : word;
	}
	const roll = rng.next();
	const special = s.group === 'encoding' ? 0.55 : 0.25;
	if (roll < 1 - special) {
		const word = rng.pick(WORDS);
		return rng.bool(0.15) ? word.toUpperCase() : word;
	}
	const pool: string[] = ['+', '%20', '%2B', ...SPECIAL_RAW, ...SPECIAL_ENCODED, '-', '.', '_', '~', '%7E'];
	if (s.junior) {
		pool.push(percent(rng, rng.pick(CYRILLIC)), '%e2%82%ac', '=', '?', '%2b', '%3d', rng.pick(MALFORMED));
		if (s.group === 'edge') pool.push(percent(rng, rng.pick(CYRILLIC)), '=', rng.pick(MALFORMED), '==');
	}
	return rng.pick(pool);
}

function value(rng: Rng, s: Style): string {
	const n = rng.int(1, s.group === 'encoding' ? 5 : 3);
	let v = Array.from({ length: n }, () => valuePiece(rng, s)).join('');
	// A trailing `%` or `%X` at the very end of a value.
	if (s.junior && s.group === 'edge' && rng.bool(0.15)) v += rng.pick(['%', '%4', '%a']);
	return v;
}

function freshKey(rng: Rng, s: Style): string {
	if (!s.junior || PLAIN.has(s.group) || rng.bool(s.group === 'edge' ? 0.4 : 0.7))
		return rng.bool(0.8) ? rng.pick(KEYS) : rng.pick(COMPOUND);
	return rng.pick([
		() => `${rng.pick(KEYS)}+${rng.pick(KEYS)}`,
		() => `${rng.pick(KEYS)}%20${rng.pick(KEYS)}`,
		() => percent(rng, rng.pick(CYRILLIC)),
		() => percent(rng, rng.pick(WIDE)),
		() => `${rng.pick(KEYS)}${rng.pick(['[x]', '%5Bx%5D', '%5b0%5d'])}`,
		() => `${rng.pick(KEYS)}%2B`,
		() => `${rng.pick(KEYS)}%5B%5D`
	])();
}

/** One query string: a mix of pairs, repeated keys, bare keys, empty values, `[]` keys and empty parts. */
function makeLine(rng: Rng, s: Style): string {
	const used: string[] = [];
	const key = (): string => {
		const k = used.length > 0 && rng.bool(s.group === 'repeat' ? 0.55 : 0.3) ? rng.pick(used) : freshKey(rng, s);
		used.push(k.replace(/\[\]$/, ''));
		return k;
	};
	const kinds: [string, number][] = [
		['pair', s.group === 'repeat' ? 35 : 55],
		['bare', s.group === 'repeat' ? 12 : 8],
		['empty', s.group === 'repeat' ? 12 : 8],
		['bracket', s.group === 'repeat' ? 25 : 14],
		...(PLAIN.has(s.group) ? [] : ([['blank', 6]] as [string, number][])),
		...(s.junior && !PLAIN.has(s.group) ? ([['nokey', s.group === 'edge' ? 8 : 3]] as [string, number][]) : [])
	];
	const total = kinds.reduce((sum, [, w]) => sum + w, 0);
	const count = rng.int(2, s.group === 'scale' ? 6 : 7);
	const out: string[] = [];
	for (let i = 0; i < count; i += 1) {
		let roll = rng.int(1, total);
		const kind = kinds.find(([, w]) => (roll -= w) <= 0)?.[0] ?? 'pair';
		if (kind === 'pair') out.push(`${key()}=${value(rng, s)}`);
		else if (kind === 'bare') out.push(key());
		else if (kind === 'empty') out.push(`${key()}=`);
		else if (kind === 'bracket') {
			const name = used.length > 0 && rng.bool(0.5) ? rng.pick(used) : rng.pick(KEYS);
			used.push(name);
			const brackets = s.junior && !PLAIN.has(s.group) && rng.bool(0.3) ? rng.pick(['%5B%5D', '%5b%5d']) : '[]';
			out.push(`${name}${brackets}=${value(rng, s)}`);
		} else if (kind === 'blank') out.push('');
		else out.push(`=${value(rng, s)}`);
	}
	if (s.group === 'edge' && !s.junior && rng.bool(0.2)) return rng.pick(['?', '?&', '?&&']);
	return `?${out.join('&')}`;
}

const WRONG_BY_GROUP: Record<GroupId, (junior: boolean, classId: string) => Probe[]> = {
	basic: () => ['no-sort'],
	encoding: () => ['plus-kept', 'plus-after-decode', 'encode-uri-component'],
	repeat: (_junior, classId) => WRONG_IDS.filter((v) => CLASS_OF[v] === classId),
	edge: (junior) => (junior ? ['split-every-eq', 'keys-raw'] : []),
	scale: () => []
};

const SIZES: Record<GroupId, [number, number]> = {
	basic: [8, 12],
	encoding: [8, 12],
	repeat: [8, 12],
	edge: [8, 12],
	scale: [300, 400]
};

/** Hidden tests of the class; every test tells this class from the others of the level. */
function groups(rng: Rng, classId: string, others: readonly string[], junior: boolean): HiddenTestGroup[] {
	const ids: GroupId[] = ['basic', 'encoding', 'repeat', 'edge', 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 1 : 5;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${classId}`);
			const [lo, hi] = SIZES[id];
			const lines = Array.from({ length: rng.int(lo, hi) }, () => makeLine(rng, { junior, group: id }));
			const expected = solve(classId, lines);
			if (others.some((other) => solve(other, lines) === expected)) continue;
			if (WRONG_BY_GROUP[id](junior, classId).some((v) => solve(classId, lines, v) === expected)) continue;
			if (PLAIN.has(id) && solve(classId, lines, 'sort-encoded') !== expected) continue;
			tests.push({ stdin: render(lines), expected });
		}
		return { id, tests };
	});
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const RULE: Record<string, string[]> = {
	'last-wins': [
		'4. Если ключ встречается несколько раз, действует последнее значение.',
		'',
		'Выход для строки: по паре `ключ=значение` на каждый ключ.'
	],
	'all-values': [
		'4. Если ключ встречается несколько раз, сохраняются все его значения в порядке появления.',
		'',
		'Выход для строки: для каждого ключа — по паре `ключ=значение` на каждое его значение, значения одного ключа — в порядке появления.'
	],
	'php-brackets': [
		'4. Части обрабатываются по порядку. Если декодированный ключ оканчивается на `[]`, имя параметра — ключ без этих двух символов, а значение добавляется в конец списка этого имени; если у имени не было списка (ничего или одиночное значение), список начинается заново. Иначе имя — сам ключ, и параметр получает одиночное значение, заменяя прежнее, будь то значение или список.',
		'',
		'Выход для строки: имена по возрастанию; одиночное значение — пара `имя=значение`, список — по паре `имя[]=значение` на каждый элемент по порядку (ключ `имя[]` кодируется по общему правилу: `tag[]` → `tag%5B%5D`).'
	],
	flags: [
		'4. Части обрабатываются по порядку: часть без `=` делает ключ **флагом** (параметр без значения); часть с `=` и пустым после декодирования значением удаляет параметр (если его не было — ничего не происходит); часть с непустым значением задаёт значение, заменяя прежнее значение или флаг.',
		'',
		'Выход для строки: флаг — просто закодированный ключ, параметр со значением — пара `ключ=значение`.'
	]
};

/** A ready reader of the input, so the candidate writes the rules, not the reading. */
const READER = [
	'```javascript',
	"const lines = require('node:fs').readFileSync(0, 'utf8').split('\\n');",
	'const n = Number(lines[0]);',
	'for (const line of lines.slice(1, n + 1)) {',
	"  const parts = line.trim().slice(1).split('&'); // части строки после «?»",
	'  // …',
	'}',
	'```'
];

/** Where the order of keys by their decoded form differs from the order of what is printed. */
const ORDER_EXAMPLE: Record<string, string> = {
	'php-brackets':
		'например, список `sort` (в выводе `sort%5B%5D=…`) идёт перед параметром `sort-by`: сравниваются имена `sort` и `sort-by`, а не `sort[]`',
	other:
		'например, ключ `sort[]` (в выводе `sort%5B%5D`) идёт после `sort-by`, потому что `[` больше `-`, хотя в выводе `%` меньше `-`'
};

function statement(classId: string, junior: boolean, example: readonly string[]): string {
	return [
		'Фронтенд хранит состояние фильтров каталога в строке запроса URL. Напишите программу, которая разбирает строки запроса и печатает каждую в каноническом виде.',
		'',
		'## Вход',
		'',
		'В первой строке — `N` (1 ≤ N ≤ 500). Далее `N` строк; каждая начинается с `?`, за ним — строка запроса (возможно, пустая) из печатных символов ASCII без пробелов и `#`.',
		'',
		'Чтение входа можно взять готовым (JavaScript и TypeScript):',
		'',
		...READER,
		'',
		'## Разбор',
		'',
		'1. Строка после `?` делится по `&` на части.',
		`2. Часть делится по **первому** \`=\` на ключ и значение (остальные \`=\` входят в значение); часть без \`=\` — ${classId === 'flags' ? 'ключ без значения' : 'ключ с пустым значением'}.`,
		`3. В ключе и в значении сначала каждый \`+\` заменяется пробелом, затем каждая последовательность \`%XX\` (две шестнадцатеричные цифры в любом регистре) заменяется байтом с этим кодом; получившиеся байты читаются как UTF-8. ${
			junior
				? '`%`, за которым не идут две шестнадцатеричные цифры, остаётся символом `%` (`decodeURIComponent` на такой строке бросает исключение). Последовательности `%XX` во входе всегда дают корректный UTF-8.'
				: 'Во входе каждый `%` начинает правильную последовательность `%XX`, и она кодирует символ ASCII.'
		} Часть, у которой ключ после декодирования пустой (в том числе пустая часть между \`&&\`), пропускается.`,
		...(RULE[classId] ?? []),
		'',
		'## Сборка',
		'',
		`${classId === 'php-brackets' ? 'Имена параметров' : 'Ключи'} выводятся по возрастанию в **декодированном** виде, до кодирования: строки сравниваются по кодам UTF-16, как \`sort()\` массива строк в JavaScript без функции сравнения; ${ORDER_EXAMPLE[classId] ?? ORDER_EXAMPLE.other ?? ''}${junior ? '; кириллический ключ идёт после всех латинских' : ''}. Пары соединяются через \`&\`, перед первой ставится \`?\`; если параметров не осталось, строка выхода — \`?\`.`,
		'',
		"Ключ и значение кодируются: символы `A`–`Z`, `a`–`z`, `0`–`9`, `-`, `.`, `_`, `~` остаются как есть, каждый байт UTF-8 любого другого символа (в том числе пробела) записывается как `%XX` заглавными шестнадцатеричными цифрами. Обратите внимание: `encodeURIComponent` оставляет `!'()*` как есть, а здесь они кодируются.",
		'',
		'## Выход',
		'',
		'`N` строк — канонический вид каждой строки запроса по порядку.',
		'',
		'## Пример',
		'',
		'Вход:',
		'',
		'```',
		render(example).trimEnd(),
		'```',
		'',
		'Выход:',
		'',
		'```',
		solve(classId, example).trimEnd(),
		'```',
		'',
		'Скрытые тесты — пять групп разной сложности. Две простые — обычные строки и большой объём: ключи и значения в них — только латинские буквы, цифры и `-`, `.`, `_` (декодировать нечего, кодировать — только скобки `[]` в ключе), пустых частей и частей без ключа нет, а порядок ключей одинаков в декодированном и в закодированном виде; повторные ключи есть. Три полные: кодирование символов, повторные ключи, граничные случаи. Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The reference in Python and the wrong solutions.

function body(classId: string, variant: Variant): string[] {
	switch (classId) {
		case 'last-wins':
			return [
				variant === 'first-wins' ? '        if key and key not in params:' : '        if key:',
				'            params[key] = value'
			];
		case 'all-values':
			return ['        if key:', '            params.setdefault(key, []).append(value)'];
		case 'php-brackets':
			return [
				"        if key[-2:] == '[]':",
				'            if not isinstance(params.get(key[:-2]), list):',
				variant === 'scalar-joins-list'
					? '                params[key[:-2]] = [params[key[:-2]]] if key[:-2] in params else []'
					: '                params[key[:-2]] = []',
				'            params[key[:-2]].append(value)',
				'        elif key:',
				'            params[key] = value'
			];
		default:
			return [
				'        if not key:',
				'            continue',
				'        if not eq:',
				'            params[key] = None',
				...(variant === 'empty-kept'
					? ['        else:', '            params[key] = value']
					: [
							'        elif value:',
							'            params[key] = value',
							'        else:',
							'            params.pop(key, None)'
						])
			];
	}
}

function referenceSource(classId: string, variant: Variant): string {
	const decodeOf = (x: string): string =>
		variant === 'plus-kept'
			? `unquote(${x})`
			: variant === 'plus-after-decode'
				? `unquote(${x}).replace('+', ' ')`
				: `unquote(${x}.replace('+', ' '))`;
	const enc = (x: string): string => `quote(${x}, safe=${variant === 'encode-uri-component' ? '"!\'()*"' : "''"})`;
	// The order of `sort()` in JavaScript: UTF-16 code units, not code points.
	const order = variant === 'no-sort' ? 'params' : "sorted(params, key=lambda k: k.encode('utf-16-be'))";
	const value = variant === 'split-every-eq' ? "value.split('=')[0]" : 'value';
	const pairs: Record<string, string[]> = {
		'last-wins': [`    print('?' + '&'.join(${enc('k')} + '=' + ${enc('params[k]')} for k in ${order}))`],
		'all-values': [`    print('?' + '&'.join(${enc('k')} + '=' + ${enc('v')} for k in ${order} for v in params[k]))`],
		'php-brackets': [
			'    pairs = []',
			`    for k in ${order}:`,
			'        if isinstance(params[k], list):',
			`            pairs += [${enc("k + '[]'")} + '=' + ${enc('v')} for v in params[k]]`,
			'        else:',
			`            pairs.append(${enc('k')} + '=' + ${enc('params[k]')})`,
			"    print('?' + '&'.join(pairs))"
		],
		flags: [
			`    print('?' + '&'.join(${enc('k')} + ('' if params[k] is None else '=' + ${enc('params[k]')}) for k in ${order}))`
		]
	};
	return [
		'import sys',
		'from urllib.parse import quote, unquote',
		'',
		"lines = sys.stdin.read().split('\\n')",
		'for line in lines[1:int(lines[0]) + 1]:',
		'    params = {}',
		"    for part in line[1:].split('&'):",
		"        key, eq, value = part.partition('=')",
		`        key, value = ${variant === 'keys-raw' ? 'key' : decodeOf('key')}, ${decodeOf(value)}`,
		...body(classId, variant),
		...(pairs[classId] ?? [])
	].join('\n');
}

function applies(id: (typeof WRONG_IDS)[number], junior: boolean, classId: string): boolean {
	const owner = CLASS_OF[id];
	if (owner !== undefined) return owner === classId;
	return junior || (id !== 'split-every-eq' && id !== 'keys-raw');
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const others = level.classes.map((c) => c.id).filter((id) => id !== input.classId);
	const hidden = groups(rng, input.classId, others, junior);
	const example = Array.from({ length: 3 }, () => makeLine(rng, { junior, group: 'repeat' }));
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(input.classId, junior, example), code: null },
		answer: null,
		practice: { languages: [...LANGUAGES], groups: hidden, checker: { kind: 'tokens' } }
	});
	return {
		instance,
		reference: () => ({ kind: 'practice', source: referenceSource(input.classId, 'right'), changeSource: null }),
		wrong: () =>
			Object.fromEntries(
				WRONG_IDS.map((id) => [
					id,
					applies(id, junior, input.classId)
						? { kind: 'program' as const, source: referenceSource(input.classId, id) }
						: null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
