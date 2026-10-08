// Practice: client-side validation of forms by a schema of rules (required, lengths, a pattern, an integer range; from
// Junior up a dependent requirement and equality with another field). The class sets what the form reports (the
// first error of a field, all of them, only the first field) and whether values are trimmed before the checks.
// Parametric hidden tests in five groups, every test a schema of its own and many forms; two of them are plain: no blank
// values, and no answer rests on the exact edge of a length or a range.
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

type Rule =
	| { kind: 'required' }
	| { kind: 'requiredif'; field: string; value: string }
	| { kind: 'minlen' | 'maxlen'; n: number }
	| { kind: 'pattern'; source: string }
	| { kind: 'range'; lo: number; hi: number }
	| { kind: 'equals'; field: string };

/** A value of a field as one kind of input makes it; `null` is a field missing from the form. */
type Mode = 'valid' | 'edge' | 'bad1' | 'bad2' | 'pad' | 'blank';
type Form = Record<string, string>;

interface Field {
	name: string;
	rules: Rule[];
	/** A value of the kind; the form so far lets a value follow another field. */
	gen: Record<'valid' | 'edge' | 'bad1' | 'bad2', (form: Form) => string>;
}

type Variant = 'right' | (typeof WRONG_IDS)[number];
const WRONG_IDS = [
	'empty-optional-checked',
	'blank-not-empty',
	'length-strict',
	'string-compare',
	'requiredif-ignored'
] as const;

// ---------------------------------------------------------------------------------------------------------------
// The model.

function errorsOf(field: Field, form: Form, classId: string, variant: Variant): string[] {
	const norm = (s: string): string => (classId === 'trimmed' ? s.trim() : s);
	const raw = form[field.name] ?? '';
	const v = norm(raw);
	const blank = variant === 'blank-not-empty' ? raw === '' : raw.trim() === '';
	const need = field.rules.some(
		(r) =>
			r.kind === 'required' ||
			(r.kind === 'requiredif' && variant !== 'requiredif-ignored' && (form[r.field] ?? '').trim() === r.value)
	);
	if (blank && (need || variant !== 'empty-optional-checked')) return need ? ['required'] : [];
	const strict = variant === 'length-strict';
	const found: string[] = [];
	for (const r of field.rules) {
		let bad = false;
		if (r.kind === 'minlen') bad = strict ? v.length <= r.n : v.length < r.n;
		else if (r.kind === 'maxlen') bad = strict ? v.length >= r.n : v.length > r.n;
		else if (r.kind === 'pattern') bad = !new RegExp(r.source).test(v);
		else if (r.kind === 'range') {
			const inside =
				variant === 'string-compare' ? String(r.lo) <= v && v <= String(r.hi) : r.lo <= Number(v) && Number(v) <= r.hi;
			bad = !/^-?[0-9]+$/.test(v) || !inside;
		} else if (r.kind === 'equals') bad = v !== norm(form[r.field] ?? '');
		if (bad) found.push(r.kind);
	}
	return found;
}

/** The expected output of the class; a variant other than `right` reproduces a wrong solution. */
function solve(classId: string, fields: readonly Field[], forms: readonly Form[], variant: Variant = 'right'): string {
	const lines = forms.map((form) => {
		const out: string[] = [];
		for (const field of fields) {
			const found = errorsOf(field, form, classId, variant);
			if (found.length > 0) out.push(`${field.name}:${classId === 'all-errors' ? found.join(',') : found[0]}`);
		}
		if (out.length === 0) return 'ok';
		return classId === 'first-field' ? (out[0] ?? '') : out.join(' ');
	});
	return `${lines.join('\n')}\n`;
}

function ruleText(r: Rule): string {
	switch (r.kind) {
		case 'required':
			return 'required';
		case 'requiredif':
			return `requiredif:${r.field}=${r.value}`;
		case 'minlen':
		case 'maxlen':
			return `${r.kind}:${r.n}`;
		case 'pattern':
			return `pattern:${r.source}`;
		case 'range':
			return `range:${r.lo}..${r.hi}`;
		case 'equals':
			return `equals:${r.field}`;
	}
}

function render(fields: readonly Field[], forms: readonly Form[]): string {
	return `${[
		String(fields.length),
		...fields.map((f) => [f.name, ...f.rules.map(ruleText)].join(' ')),
		String(forms.length),
		...forms.map((form) => JSON.stringify(form))
	].join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Schemas and values.

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const WORD = `${LOWER}${DIGITS}_`;
const ALNUM = `${LOWER}${UPPER}${DIGITS}`;
const EMAIL = '^[a-z0-9.]+@[a-z]+\\.[a-z]+$';
const PHONE = '^\\+?[0-9]{10,12}$';

const text = (rng: Rng, alphabet: string, length: number): string =>
	Array.from({ length: Math.max(length, 0) }, () => alphabet[rng.int(0, alphabet.length - 1)] ?? 'a').join('');

/** A string with one character replaced by one from `alphabet` (the string must not be empty). */
function spoil(rng: Rng, s: string, alphabet: string): string {
	const i = rng.int(0, s.length - 1);
	return `${s.slice(0, i)}${text(rng, alphabet, 1)}${s.slice(i + 1)}`;
}

interface Template {
	names: readonly string[];
	make(rng: Rng): Pick<Field, 'rules' | 'gen'>;
}

const login: Template = {
	names: ['login', 'nick', 'username'],
	make(rng) {
		const a = rng.int(3, 5);
		const b = rng.int(8, 12);
		return {
			rules: rng.shuffle<Rule>([
				{ kind: 'minlen', n: a },
				{ kind: 'maxlen', n: b },
				{ kind: 'pattern', source: '^[a-z0-9_]+$' }
			]),
			gen: {
				valid: () => text(rng, WORD, rng.int(a, b)),
				edge: () => text(rng, WORD, rng.pick([a, b, a - 1, b + 1])),
				bad1: () => spoil(rng, text(rng, WORD, rng.int(a, b)), '-.A'),
				bad2: () => spoil(rng, text(rng, WORD, rng.pick([a - 1, b + 1, b + 2])), '-.AZ')
			}
		};
	}
};

const personName: Template = {
	names: ['name', 'first', 'city'],
	make(rng) {
		const b = rng.int(6, 10);
		const word = (length: number): string => `${text(rng, UPPER, 1)}${text(rng, LOWER, length - 1)}`;
		return {
			rules: rng.shuffle<Rule>([
				{ kind: 'pattern', source: '^[A-Z][a-z]+$' },
				{ kind: 'maxlen', n: b }
			]),
			gen: {
				valid: () => word(rng.int(2, b)),
				edge: () => word(rng.pick([b, b + 1])),
				bad1: () => (rng.bool() ? text(rng, LOWER, rng.int(2, b)) : spoil(rng, word(rng.int(3, b)), DIGITS)),
				bad2: () => text(rng, LOWER, rng.int(b + 1, b + 3))
			}
		};
	}
};

/** An integer range; `small` makes 1..hi, where one-digit values break a comparison of strings the other way. */
function rangeTemplate(names: readonly string[], small: boolean): Template {
	return {
		names,
		make(rng) {
			const lo = small ? rng.int(1, 2) : rng.int(14, 21);
			const hi = small ? rng.int(10, 19) : rng.int(60, 99);
			const inside = (): number => rng.int(lo + 1, hi - 1);
			const notNumber = (): string =>
				rng.pick([text(rng, LOWER, 3), `${inside()}.5`, `${inside()}e1`, `${inside()}+`, `#${inside()}`]);
			return {
				rules: [{ kind: 'range', lo, hi }],
				gen: {
					valid: () => String(inside()),
					edge: () =>
						rng.pick([
							String(lo - 1),
							String(lo),
							String(hi),
							String(hi + 1),
							small ? String(rng.int(Math.max(lo, 3), 9)) : String(rng.int(1, 9)),
							small ? String(rng.int(Math.max(lo, 3), 9)) : `0${inside()}`
						]),
					bad1: notNumber,
					bad2: () => (rng.bool() ? notNumber() : `-${inside()}`)
				}
			};
		}
	};
}

const email: Template = {
	names: ['email', 'mail'],
	make(rng) {
		const b = rng.int(18, 26);
		const address = (length: number): string => {
			const domain = text(rng, LOWER, rng.int(3, 5));
			const tld = rng.pick(['ru', 'com', 'org']);
			return `${text(rng, `${LOWER}${DIGITS}.`, Math.max(length - domain.length - tld.length - 2, 1))}@${domain}.${tld}`;
		};
		return {
			rules: rng.shuffle<Rule>([
				{ kind: 'maxlen', n: b },
				{ kind: 'pattern', source: EMAIL }
			]),
			gen: {
				valid: () => address(rng.int(10, b)),
				edge: () => address(rng.pick([b, b + 1])),
				bad1: () => {
					const good = address(rng.int(10, b - 1));
					return rng.bool() ? good.replace('@', '') : spoil(rng, good, 'A ');
				},
				bad2: () => address(rng.int(b + 1, b + 4)).replace('@', '_')
			}
		};
	}
};

/** Values of a phone field: a plus, then 10–12 digits. */
function phoneGen(rng: Rng): Field['gen'] {
	const plus = (): string => (rng.bool() ? '+' : '');
	const bad = (): string => {
		const digits = text(rng, DIGITS, 11);
		return rng.pick([
			`${digits.slice(0, 4)}-${digits.slice(4)}`,
			`${digits.slice(0, 3)} ${digits.slice(3)}`,
			`8${spoil(rng, digits.slice(1), LOWER)}`
		]);
	};
	return {
		valid: () => `${plus()}${text(rng, DIGITS, rng.int(10, 12))}`,
		edge: () => `${plus()}${text(rng, DIGITS, rng.pick([9, 10, 12, 13]))}`,
		bad1: bad,
		bad2: bad
	};
}

const phone: Template = {
	names: ['phone', 'tel'],
	make: (rng) => ({ rules: [{ kind: 'pattern', source: PHONE }], gen: phoneGen(rng) })
};

const zip: Template = {
	names: ['zip', 'index', 'code'],
	make(rng) {
		const n = rng.int(5, 6);
		return {
			rules: rng.shuffle<Rule>([
				{ kind: 'minlen', n },
				{ kind: 'maxlen', n },
				{ kind: 'pattern', source: '^[0-9]+$' }
			]),
			gen: {
				valid: () => text(rng, DIGITS, n),
				edge: () => text(rng, DIGITS, rng.pick([n - 1, n + 1, n])),
				bad1: () => spoil(rng, text(rng, DIGITS, n), LOWER),
				bad2: () => spoil(rng, text(rng, DIGITS, rng.pick([n - 1, n + 1])), LOWER)
			}
		};
	}
};

const comment: Template = {
	names: ['comment', 'note', 'about'],
	make(rng) {
		const b = rng.int(10, 20);
		const phrase = (length: number): string => spoil(rng, text(rng, LOWER, length), ' ').replace(/^ | $/g, 'x');
		return {
			rules: [{ kind: 'maxlen', n: b }],
			gen: {
				valid: () => phrase(rng.int(3, b)),
				edge: () => phrase(rng.pick([b, b + 1])),
				bad1: () => phrase(rng.int(b + 1, b + 6)),
				bad2: () => phrase(rng.int(b + 1, b + 6))
			}
		};
	}
};

const age = rangeTemplate(['age', 'years', 'level'], false);
const qty = rangeTemplate(['qty', 'count', 'seats'], true);
const INTERN_POOL: readonly Template[] = [login, personName, email, phone, zip, comment];

/** The fields of the cross-field rules of Junior: a password with its confirmation, a contact way and a phone. */
function juniorFields(rng: Rng): Field[] {
	const m = rng.int(6, 8);
	const password: Field = {
		name: rng.pick(['password', 'secret']),
		rules: [
			{ kind: 'required' },
			...rng.shuffle<Rule>([
				{ kind: 'minlen', n: m },
				{ kind: 'pattern', source: '^[A-Za-z0-9]+$' }
			])
		],
		gen: {
			valid: () => text(rng, ALNUM, rng.int(m, m + 5)),
			edge: () => text(rng, ALNUM, rng.pick([m, m - 1])),
			bad1: () => spoil(rng, text(rng, ALNUM, rng.int(m, m + 4)), '!-'),
			bad2: () => spoil(rng, text(rng, ALNUM, m - 1), '!-')
		}
	};
	const confirm: Field = {
		name: rng.pick(['confirm', 'repeat']),
		rules: [{ kind: 'required' }, { kind: 'equals', field: password.name }],
		gen: {
			valid: (form) => form[password.name] ?? '',
			edge: (form) => {
				const p = form[password.name] ?? '';
				return p.trim() !== p ? p.trim() : `${p} `;
			},
			bad1: () => text(rng, ALNUM, rng.int(m, m + 4)),
			bad2: (form) => `${(form[password.name] ?? '').trim()}${text(rng, DIGITS, 1)}`
		}
	};
	const contact: Field = {
		name: rng.pick(['contact', 'channel']),
		rules: [{ kind: 'required' }, { kind: 'pattern', source: '^(phone|email)$' }],
		gen: {
			valid: () => rng.pick(['phone', 'phone', 'email']),
			edge: () => rng.pick([' phone', 'phone ', ' email']),
			bad1: () => rng.pick(['fax', 'Phone', 'sms']),
			bad2: () => rng.pick(['tel', 'mail'])
		}
	};
	const tel: Field = {
		name: rng.pick(['phone', 'tel']),
		rules: [
			{ kind: 'requiredif', field: contact.name, value: 'phone' },
			{ kind: 'pattern', source: PHONE }
		],
		gen: phoneGen(rng)
	};
	return [password, confirm, contact, tel];
}

interface Schema {
	fields: Field[];
	/** The fields in the order their values are made: a confirmation after its password. */
	making: Field[];
}

function schema(rng: Rng, junior: boolean, plain: boolean): Schema {
	const used = new Set<string>();
	const named = (t: Template): Field => {
		const name = t.names.find((n) => !used.has(n)) ?? `${t.names[0] ?? 'f'}${used.size}`;
		used.add(name);
		return { name, ...t.make(rng) };
	};
	const fields: Field[] = [];
	if (junior) {
		const first = juniorFields(rng);
		for (const f of first) used.add(f.name);
		fields.push(...first);
		const pool = INTERN_POOL.filter((t) => t !== phone && (!plain || t !== zip));
		const extra = rng.sample(pool, rng.int(1, 2)).map(named);
		fields.push(named(rng.pick([age, qty])), ...extra);
	} else {
		// A zip code has minlen = maxlen: its valid value always stands on the edge of the length.
		const chosen = rng.sample(
			INTERN_POOL.filter((t) => !plain || t !== zip),
			rng.int(2, 4)
		);
		fields.push(named(rng.pick([age, qty])), ...chosen.map(named));
	}
	// Requiredness: at least one required and one optional field whose blank value would break a check.
	const free = fields.filter((f) => f.rules[0]?.kind !== 'required' && f.rules[0]?.kind !== 'requiredif');
	const optional = rng.pick(free.filter((f) => f.rules.some((r) => r.kind !== 'maxlen' && r.kind !== 'equals')));
	for (const f of free) if (f !== optional && rng.bool(0.5)) f.rules.unshift({ kind: 'required' });
	if (!junior && fields.every((f) => f.rules[0]?.kind !== 'required')) {
		const other = fields.find((f) => f !== optional);
		other?.rules.unshift({ kind: 'required' });
	}
	const ordered = rng.shuffle(fields);
	const making = [...fields];
	return { fields: ordered, making };
}

type GroupId = 'basic' | 'blank' | 'bounds' | 'multi' | 'scale';

/**
 * The groups a partly right solution passes: every field is filled (no blank value), and no form's errors depend on a
 * subtle rule — inclusive edges of lengths and ranges, numbers compared as numbers, the blank value. Padded values stay:
 * the trimming is the essential parameter of a class.
 */
const PLAIN: ReadonlySet<GroupId> = new Set(['basic', 'scale']);
const PLAIN_MODES: [Mode, number][] = [
	['valid', 55],
	['pad', 10],
	['bad1', 20],
	['bad2', 15]
];

const WEIGHTS: Record<GroupId, [Mode, number][]> = {
	basic: PLAIN_MODES,
	blank: [
		['valid', 30],
		['pad', 25],
		['blank', 30],
		['bad1', 15]
	],
	bounds: [
		['valid', 25],
		['edge', 55],
		['bad1', 10],
		['pad', 10]
	],
	multi: [
		['valid', 20],
		['bad1', 30],
		['bad2', 40],
		['pad', 10]
	],
	scale: PLAIN_MODES
};

function mode(rng: Rng, group: GroupId): Mode {
	const weights = WEIGHTS[group];
	let roll = rng.int(
		1,
		weights.reduce((s, [, w]) => s + w, 0)
	);
	for (const [m, w] of weights) {
		roll -= w;
		if (roll <= 0) return m;
	}
	return 'valid';
}

function makeForm(rng: Rng, s: Schema, group: GroupId): Form {
	const values = new Map<string, string | null>();
	const form: Form = {};
	for (const field of s.making) {
		const m = mode(rng, group);
		let value: string | null;
		if (m === 'blank') value = rng.pick(['', ' ', '   ', null]);
		else if (m === 'pad') {
			const v = field.gen.valid(form);
			value = rng.bool() ? `${' '.repeat(rng.int(1, 2))}${v}` : `${v}${' '.repeat(rng.int(1, 2))}`;
			if (v === '') value = v;
		} else value = field.gen[m](form);
		values.set(field.name, value);
		if (value !== null) form[field.name] = value;
	}
	// The keys of the object follow the schema.
	const ordered: Form = {};
	for (const field of s.fields) {
		const value = values.get(field.name);
		if (value !== null && value !== undefined) ordered[field.name] = value;
	}
	return ordered;
}

/** The wrong solutions a group must expose on every test. */
function traps(group: GroupId, junior: boolean): Variant[] {
	if (group === 'blank')
		return junior
			? ['empty-optional-checked', 'blank-not-empty', 'requiredif-ignored']
			: ['empty-optional-checked', 'blank-not-empty'];
	if (group === 'bounds') return ['length-strict', 'string-compare'];
	return [];
}

interface Test {
	fields: Field[];
	forms: Form[];
}

function makeTest(rng: Rng, classId: string, group: GroupId, junior: boolean, count: number): Test {
	const plain = PLAIN.has(group);
	const s = schema(rng, junior, plain);
	const forms = Array.from({ length: count }, () => {
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const form = makeForm(rng, s, group);
			// A plain form: every wrong solution of the level reports it as the right one does.
			if (!plain) return form;
			const expected = solve(classId, s.fields, [form]);
			if (WRONG_IDS.every((v) => solve(classId, s.fields, [form], v) === expected)) return form;
		}
		throw new Error(`${descriptor.key}: no plain ${group} form for ${classId}`);
	});
	return { fields: s.fields, forms };
}

const COUNTS: Record<GroupId, [number, number]> = {
	basic: [8, 12],
	blank: [12, 16],
	bounds: [8, 12],
	multi: [8, 12],
	scale: [700, 900]
};

/** Hidden tests of the class; every test tells this class from the others of the level. */
function groups(rng: Rng, classId: string, others: readonly string[], junior: boolean): HiddenTestGroup[] {
	const ids: GroupId[] = ['basic', 'blank', 'bounds', 'multi', 'scale'];
	return ids.map((id) => {
		const count = id === 'scale' ? 1 : 5;
		const tests: { stdin: string; expected: string }[] = [];
		for (let attempt = 0; tests.length < count; attempt += 1) {
			if (attempt > 500) throw new Error(`${descriptor.key}: no distinguishing ${id} test for ${classId}`);
			const [lo, hi] = COUNTS[id];
			const t = makeTest(rng, classId, id, junior, rng.int(lo, hi));
			const expected = solve(classId, t.fields, t.forms);
			if (others.some((other) => solve(other, t.fields, t.forms) === expected)) continue;
			if (traps(id, junior).some((v) => solve(classId, t.fields, t.forms, v) === expected)) continue;
			tests.push({ stdin: render(t.fields, t.forms), expected });
		}
		return { id, tests };
	});
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

const OUTPUT: Record<string, string> = {
	'first-error':
		'Для каждой формы — одна строка: `ok`, если ошибок нет, иначе через пробел `<поле>:<ошибка>` для каждого поля с ошибками в порядке схемы, где `<ошибка>` — первая ошибка поля в порядке его правил.',
	'all-errors':
		'Для каждой формы — одна строка: `ok`, если ошибок нет, иначе через пробел `<поле>:<ошибки>` для каждого поля с ошибками в порядке схемы, где `<ошибки>` — все ошибки поля через запятую без пробелов в порядке его правил (например, `zip:minlen,pattern`).',
	trimmed:
		'Для каждой формы — одна строка: `ok`, если ошибок нет, иначе через пробел `<поле>:<ошибка>` для каждого поля с ошибками в порядке схемы, где `<ошибка>` — первая ошибка поля в порядке его правил.',
	'first-field':
		'Форма показывает пользователю только одну ошибку. Для каждой формы — одна строка: `ok`, если ошибок нет, иначе `<поле>:<ошибка>` — первое в порядке схемы поле с ошибками и первая ошибка этого поля в порядке его правил.'
};

/** A ready reader of the input, so the candidate writes the rules, not the parsing. */
const READER = [
	'```javascript',
	"const lines = require('node:fs').readFileSync(0, 'utf8').split('\\n');",
	'const k = Number(lines[0]);',
	"// схема: [{ name: 'login', rules: ['required', 'minlen:3', …] }, …] в порядке входа",
	'const schema = lines.slice(1, k + 1).map((line) => {',
	'  const [name, ...rules] = line.trim().split(/\\s+/);',
	'  return { name, rules };',
	'});',
	'const n = Number(lines[k + 1]);',
	'// формы: объекты { поле: значение }',
	'const forms = lines.slice(k + 2, k + 2 + n).map((line) => JSON.parse(line));',
	'```'
];

function statement(classId: string, junior: boolean, example: Test): string {
	const trimmed = classId === 'trimmed';
	return [
		'Форма на сайте проверяется на клиенте по схеме правил. Напишите программу, которая по схеме и заполненным формам печатает ошибки каждой формы.',
		'',
		'## Вход',
		'',
		'В первой строке — `K`, число полей (1 ≤ K ≤ 10). Далее `K` строк схемы: `<поле> <правило> <правило> …` — имя поля (латинские строчные буквы) и его правила через пробел. Порядок полей и порядок правил поля важны.',
		'',
		'Затем строка с `N` (1 ≤ N ≤ 1000) и `N` строк — формы, каждая — JSON-объект в одну строку: `{"<поле>": "<значение>", …}`. Значения — строки из печатных символов ASCII без `"` и `\\`. Поле, которого нет в объекте, имеет значение `""`.',
		'',
		'Чтение входа можно взять готовым (JavaScript и TypeScript):',
		'',
		...READER,
		'',
		'## Правила',
		'',
		'- `required` — поле обязательное;',
		...(junior
			? [
					'- `requiredif:<другое поле>=<слово>` — поле обязательное, если значение другого поля после удаления пробелов по краям равно `<слово>`;'
				]
			: []),
		'- `minlen:<n>` — длина значения не меньше `n` символов; `maxlen:<n>` — не больше `n`;',
		'- `pattern:<выражение>` — значение подходит под регулярное выражение (как `new RegExp(<выражение>).test(<значение>)` в JavaScript);',
		'- `range:<a>..<b>` — значение — целое число в десятичной записи (необязательный `-` и одни цифры, без пробелов и других знаков; ведущие нули допустимы) от `a` до `b` включительно;',
		...(junior ? ['- `equals:<другое поле>` — значение совпадает со значением другого поля.'] : []),
		'',
		`Правило обязательности (\`required\`${junior ? ' или `requiredif`' : ''}) у поля не больше одного и стоит первым.`,
		'',
		'Поле проверяется так:',
		'',
		`1. Значение **пустое**, если после удаления пробелов по краям ничего не осталось (в том числе поля нет в объекте). Пустое значение даёт ошибку \`required\`, если поле обязательное${junior ? ' (`required` или `requiredif` с выполненным условием)' : ''}, иначе ошибок у поля нет. Остальные правила к пустому значению не применяются.`,
		`2. Непустое значение проверяется остальными правилами по порядку схемы; нарушенное правило даёт ошибку с именем правила: \`minlen\`, \`maxlen\`, \`pattern\`, \`range\`${junior ? ', `equals`' : ''}.`,
		trimmed
			? `3. Перед проверками п. 2 значение обрезается: пробелы по краям удаляются, длина, шаблон и число считаются по обрезанному значению${junior ? '; `equals` сравнивает обрезанные значения обоих полей' : ''}.`
			: `3. В п. 2 значение проверяется как есть, с пробелами по краям: длина считает пробелы, шаблон и число их видят${junior ? '; `equals` сравнивает значения обоих полей как есть' : ''}.`,
		'',
		'## Выход',
		'',
		OUTPUT[classId] ?? '',
		'',
		'## Пример',
		'',
		'Вход:',
		'',
		'```',
		render(example.fields, example.forms).trimEnd(),
		'```',
		'',
		'Выход:',
		'',
		'```',
		solve(classId, example.fields, example.forms).trimEnd(),
		'```',
		'',
		'Скрытые тесты — пять групп разной сложности. Две простые — обычные формы и большой объём: в них все поля заполнены (пустых значений и значений из одних пробелов нет), правил `minlen` и `maxlen` с одинаковым числом нет, и ни одна ошибка не зависит от того, включительны ли границы длин и диапазонов и сравниваются ли числа как числа или как строки. Три полные: пустые и пробельные значения, значения на границах длин и диапазонов, несколько нарушений в поле и форме. Группа засчитывается, если пройдены все её тесты.'
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The reference in Python and the wrong solutions.

function referenceSource(classId: string, junior: boolean, variant: Variant): string {
	const trimmed = classId === 'trimmed';
	const value = trimmed ? 'raw.strip()' : 'raw';
	const other = trimmed ? "form.get(arg, '').strip()" : "form.get(arg, '')";
	const strict = variant === 'length-strict';
	const inside =
		variant === 'string-compare'
			? "arg.split('..')[0] <= v <= arg.split('..')[1]"
			: "int(arg.split('..')[0]) <= int(v) <= int(arg.split('..')[1])";
	const blank = variant === 'blank-not-empty' ? 'not raw' : 'not raw.strip()';
	const report =
		classId === 'all-errors' ? "out.append(name + ':' + ','.join(found))" : "out.append(name + ':' + found[0])";
	return [
		'import json',
		'import re',
		'import sys',
		'',
		"lines = sys.stdin.read().split('\\n')",
		'k = int(lines[0])',
		'fields = [line.split() for line in lines[1:k + 1]]',
		'for line in lines[k + 2:k + 2 + int(lines[k + 1])]:',
		'    form = json.loads(line)',
		'    out = []',
		'    for name, *rules in fields:',
		"        raw = form.get(name, '')",
		`        v = ${value}`,
		'        need = False',
		'        found = []',
		'        for rule in rules:',
		"            kind, _, arg = rule.partition(':')",
		"            if kind == 'required':",
		'                need = True',
		...(junior
			? [
					"            elif kind == 'requiredif':",
					variant === 'requiredif-ignored'
						? '                pass'
						: "                need = form.get(arg.split('=')[0], '').strip() == arg.split('=')[1]",
					"            elif kind == 'equals' and v != " + other + ':',
					'                found.append(kind)'
				]
			: []),
		`            elif (kind == 'minlen' and len(v) ${strict ? '<=' : '<'} int(arg)`,
		`                  or kind == 'maxlen' and len(v) ${strict ? '>=' : '>'} int(arg)`,
		"                  or kind == 'pattern' and not re.search(arg, v)",
		`                  or kind == 'range' and not (re.fullmatch('-?[0-9]+', v) and ${inside})):`,
		'                found.append(kind)',
		variant === 'empty-optional-checked' ? `        if ${blank} and need:` : `        if ${blank}:`,
		"            found = ['required'] if need else []",
		'        if found:',
		`            ${report}`,
		classId === 'first-field' ? "    print(out[0] if out else 'ok')" : "    print(' '.join(out) or 'ok')"
	].join('\n');
}

function applies(id: (typeof WRONG_IDS)[number], junior: boolean): boolean {
	return id !== 'requiredif-ignored' || junior;
}

export function build(input: GenerateInput): Built {
	const { level } = levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	const others = level.classes.map((c) => c.id).filter((id) => id !== input.classId);
	const hidden = groups(rng, input.classId, others, junior);
	const example = makeTest(rng, input.classId, 'basic', junior, 5);
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: statement(input.classId, junior, example), code: null },
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
					applies(id, junior) ? { kind: 'program' as const, source: referenceSource(input.classId, junior, id) } : null
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
