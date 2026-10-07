// Practice: parse query strings of URLs and print each in a canonical form (sorted keys, percent-encoded by the
// unreserved set). The class sets what a repeated key means (the last value, all values, lists by `[]` in the PHP way,
// flags and removal by an empty value); Junior adds multibyte UTF-8, `%` without two hex digits, encoded keys and
// `=` inside a value. Parametric hidden tests in five groups.
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
	'keys-raw'
] as const;

// ---------------------------------------------------------------------------------------------------------------
// The model.

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function encode(s: string, variant: Variant): string {
	let out = '';
	for (const byte of ENCODER.encode(s)) {
		const c = String.fromCharCode(byte);
		if (byte < 0x80 && (UNRESERVED.test(c) || (variant === 'encode-uri-component' && "!'()*".includes(c)))) out += c;
		else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
	}
	return out;
}

/** `+` as a space, then `%XX` as bytes (a `%` without two hex digits stays), the bytes read as UTF-8. */
function decode(s: string, variant: Variant): string {
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

function parts(line: string, variant: Variant): Part[] {
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
function canonical(classId: string, line: string, variant: Variant): string {
	// A parameter: one value, a list (all values or `[]`), or a flag (null).
	const params = new Map<string, string | string[] | null>();
	for (const { key, value, eq } of parts(line, variant)) {
		if (classId === 'php-brackets' && key.endsWith('[]')) {
			const name = key.slice(0, -2);
			const list = params.get(name);
			if (Array.isArray(list)) list.push(value);
			else params.set(name, [value]);
		} else if (key === '') continue;
		else if (classId === 'all-values') {
			const list = params.get(key);
			if (Array.isArray(list)) list.push(value);
			else params.set(key, [value]);
		} else if (classId === 'flags' && !eq) params.set(key, null);
		else if (classId === 'flags' && value === '') params.delete(key);
		else params.set(key, value);
	}
	const names = [...params.keys()];
	if (variant !== 'no-sort') names.sort();
	const pairs = names.flatMap((name) => {
		const v = params.get(name);
		if (v === null || v === undefined) return [encode(name, variant)];
		if (!Array.isArray(v)) return [`${encode(name, variant)}=${encode(v, variant)}`];
		const key = classId === 'php-brackets' ? `${name}[]` : name;
		return v.map((item) => `${encode(key, variant)}=${encode(item, variant)}`);
	});
	return `?${pairs.join('&')}`;
}

function solve(classId: string, lines: readonly string[], variant: Variant = 'right'): string {
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

interface Style {
	junior: boolean;
	group: GroupId;
}

function valuePiece(rng: Rng, s: Style): string {
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
	if (!s.junior || rng.bool(s.group === 'edge' ? 0.4 : 0.7)) return rng.bool(0.8) ? rng.pick(KEYS) : rng.pick(COMPOUND);
	return rng.pick([
		() => `${rng.pick(KEYS)}+${rng.pick(KEYS)}`,
		() => `${rng.pick(KEYS)}%20${rng.pick(KEYS)}`,
		() => percent(rng, rng.pick(CYRILLIC)),
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
		['blank', 6],
		...(s.junior ? ([['nokey', s.group === 'edge' ? 8 : 3]] as [string, number][]) : [])
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
			const brackets = s.junior && rng.bool(0.3) ? rng.pick(['%5B%5D', '%5b%5d']) : '[]';
			out.push(`${name}${brackets}=${value(rng, s)}`);
		} else if (kind === 'blank') out.push('');
		else out.push(`=${value(rng, s)}`);
	}
	if (s.group === 'edge' && !s.junior && rng.bool(0.2)) return rng.pick(['?', '?&', '?&&']);
	return `?${out.join('&')}`;
}

const WRONG_BY_GROUP: Record<GroupId, (junior: boolean) => Variant[]> = {
	basic: () => ['no-sort'],
	encoding: () => ['plus-kept', 'plus-after-decode', 'encode-uri-component'],
	repeat: () => [],
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
			if (WRONG_BY_GROUP[id](junior).some((v) => solve(classId, lines, v) === expected)) continue;
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

function statement(classId: string, junior: boolean, example: readonly string[]): string {
	return [
		'Фронтенд хранит состояние фильтров каталога в строке запроса URL. Напишите программу, которая разбирает строки запроса и печатает каждую в каноническом виде.',
		'',
		'## Вход',
		'',
		'В первой строке — `N` (1 ≤ N ≤ 500). Далее `N` строк; каждая начинается с `?`, за ним — строка запроса (возможно, пустая) из печатных символов ASCII без пробелов и `#`.',
		'',
		'## Разбор',
		'',
		'1. Строка после `?` делится по `&` на части.',
		`2. Часть делится по **первому** \`=\` на ключ и значение (остальные \`=\` входят в значение); часть без \`=\` — ${classId === 'flags' ? 'ключ без значения' : 'ключ с пустым значением'}.`,
		`3. В ключе и в значении сначала каждый \`+\` заменяется пробелом, затем каждая последовательность \`%XX\` (две шестнадцатеричные цифры в любом регистре) заменяется байтом с этим кодом; получившиеся байты читаются как UTF-8. ${
			junior
				? '`%`, за которым не идут две шестнадцатеричные цифры, остаётся символом `%`. Последовательности `%XX` во входе всегда дают корректный UTF-8.'
				: 'Во входе каждый `%` начинает правильную последовательность `%XX`, и она кодирует символ ASCII.'
		} Часть, у которой ключ после декодирования пустой (в том числе пустая часть между \`&&\`), пропускается.`,
		...(RULE[classId] ?? []),
		'',
		'## Сборка',
		'',
		'Ключи выводятся по возрастанию: строки сравниваются по кодам символов, как `sort()` массива строк в JavaScript. Пары соединяются через `&`, перед первой ставится `?`; если параметров не осталось, строка выхода — `?`.',
		'',
		'Ключ и значение кодируются: символы `A`–`Z`, `a`–`z`, `0`–`9`, `-`, `.`, `_`, `~` остаются как есть, каждый байт UTF-8 любого другого символа (в том числе пробела) записывается как `%XX` заглавными шестнадцатеричными цифрами.',
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
		'Скрытые тесты — пять групп: обычные строки, кодирование символов, повторные ключи, граничные случаи, большой объём. Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The reference in Python and the wrong solutions.

const BODY: Record<string, string[]> = {
	'last-wins': ['        if key:', '            params[key] = value'],
	'all-values': ['        if key:', '            params.setdefault(key, []).append(value)'],
	'php-brackets': [
		"        if key[-2:] == '[]':",
		'            if not isinstance(params.get(key[:-2]), list):',
		'                params[key[:-2]] = []',
		'            params[key[:-2]].append(value)',
		'        elif key:',
		'            params[key] = value'
	],
	flags: [
		'        if not key:',
		'            continue',
		'        if not eq:',
		'            params[key] = None',
		'        elif value:',
		'            params[key] = value',
		'        else:',
		'            params.pop(key, None)'
	]
};

function referenceSource(classId: string, variant: Variant): string {
	const decodeOf = (x: string): string =>
		variant === 'plus-kept'
			? `unquote(${x})`
			: variant === 'plus-after-decode'
				? `unquote(${x}).replace('+', ' ')`
				: `unquote(${x}.replace('+', ' '))`;
	const enc = (x: string): string => `quote(${x}, safe=${variant === 'encode-uri-component' ? '"!\'()*"' : "''"})`;
	const order = variant === 'no-sort' ? 'params' : 'sorted(params)';
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
		...(BODY[classId] ?? []),
		...(pairs[classId] ?? [])
	].join('\n');
}

function applies(id: (typeof WRONG_IDS)[number], junior: boolean): boolean {
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
					applies(id, junior) ? { kind: 'program' as const, source: referenceSource(input.classId, id) } : null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
