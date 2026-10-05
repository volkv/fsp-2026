// Contract violations in responses: a response schema (types, required keys, null, enumerations, extra keys, arrays,
// dates, a nested object) and actual responses of the API; the tester names the responses that break the contract.
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

const descriptor = readDescriptor(import.meta.url);

type FieldType = 'integer' | 'string' | 'boolean' | 'enum' | 'date' | 'array' | 'object';

interface Field {
	name: string;
	type: FieldType;
	required: boolean;
	nullable: boolean;
	values?: string[];
	minItems?: number;
	/** A nested object: its fields and whether keys outside them are allowed. */
	fields?: Field[];
	additional?: boolean;
}

interface Schema {
	fields: Field[];
	additional: boolean;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

interface Params {
	schema: Schema;
	responses: Obj[];
}

interface Rules {
	nullAlwaysBad: boolean;
	anyNullOk: boolean;
	allRequired: boolean;
	scalarStringOk: boolean;
	enumCaseOk: boolean;
	extraAlwaysBad: boolean;
	extraAlwaysOk: boolean;
	emptyArrayOk: boolean;
	itemsUnchecked: boolean;
	dateFormatOk: boolean;
}

const RIGHT: Rules = {
	nullAlwaysBad: false,
	anyNullOk: false,
	allRequired: false,
	scalarStringOk: false,
	enumCaseOk: false,
	extraAlwaysBad: false,
	extraAlwaysOk: false,
	emptyArrayOk: false,
	itemsUnchecked: false,
	dateFormatOk: false
};

function isDate(v: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const date = new Date(Date.UTC(y, mo - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const isObj = (v: Json): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function valueBad(v: Json, f: Field, rules: Rules): boolean {
	switch (f.type) {
		case 'integer':
			return !(
				(typeof v === 'number' && Number.isInteger(v)) ||
				(rules.scalarStringOk && typeof v === 'string' && /^-?\d+$/.test(v))
			);
		case 'string':
			return typeof v !== 'string';
		case 'boolean':
			return !(typeof v === 'boolean' || (rules.scalarStringOk && (v === 'true' || v === 'false')));
		case 'enum': {
			if (typeof v !== 'string') return true;
			const values = f.values ?? [];
			return !(values.includes(v) || (rules.enumCaseOk && values.includes(v.toLowerCase())));
		}
		case 'date':
			return typeof v !== 'string' || !(rules.dateFormatOk || isDate(v));
		case 'array':
			if (!Array.isArray(v)) return true;
			if (!rules.emptyArrayOk && v.length < (f.minItems ?? 0)) return true;
			return !rules.itemsUnchecked && v.some((item) => typeof item !== 'string');
		case 'object':
			return !isObj(v) || objectBad(v, f.fields ?? [], f.additional ?? true, rules);
	}
}

function objectBad(obj: Obj, fields: readonly Field[], additional: boolean, rules: Rules): boolean {
	for (const f of fields) {
		if (!(f.name in obj)) {
			if (f.required || rules.allRequired) return true;
			continue;
		}
		const v = obj[f.name] ?? null;
		if (v === null) {
			if (rules.nullAlwaysBad) return true;
			if (f.nullable || rules.anyNullOk) continue;
			return true;
		}
		if (valueBad(v, f, rules)) return true;
	}
	const extra = Object.keys(obj).some((k) => !fields.some((f) => f.name === k));
	if (!extra || rules.extraAlwaysOk) return false;
	return rules.extraAlwaysBad || !additional;
}

/** Numbers of the responses that break the schema, or the single line `-`. */
function verdict(p: Params, rules: Rules): string[] {
	const bad = p.responses.flatMap((r, i) =>
		objectBad(r, p.schema.fields, p.schema.additional, rules) ? [String(i + 1)] : []
	);
	return bad.length ? bad : ['-'];
}

const TITLES = ['QA Engineer', 'QA Lead', 'SDET', 'Manual QA', 'Mobile QA', 'Automation QA', 'Тестировщик API'];
const COMPANIES = ['Вектор', 'Полюс', 'Север', 'Гранит', 'Орбита', 'Квант'];
const TAGS = ['python', 'sql', 'api', 'mobile', 'load', 'ui', 'kafka', 'linux'];
const STATUS_SETS = [
	['open', 'closed', 'draft'],
	['active', 'paused', 'archived'],
	['new', 'review', 'published']
];
const EXTRA_KEYS: [string, Json][] = [
	['debug', true],
	['source', 'hh'],
	['rank', 3],
	['trace_id', 'a91f'],
	['legacy_id', 4410]
];

function makeSchema(rng: Rng, grade: string, classId: string): Schema {
	const status: Field = {
		name: 'status',
		type: 'enum',
		required: true,
		nullable: false,
		values: rng.pick(STATUS_SETS)
	};
	const fields: Field[] = [
		{ name: 'id', type: 'integer', required: true, nullable: false },
		{ name: 'title', type: 'string', required: true, nullable: false },
		{ name: 'salary', type: 'integer', required: rng.bool(), nullable: true },
		status,
		{ name: 'remote', type: 'boolean', required: classId === 'optional' ? false : rng.bool(), nullable: false },
		{ name: 'published_at', type: 'date', required: false, nullable: classId === 'dates' ? true : rng.bool() }
	];
	if (classId === 'optional') {
		const salary = fields[2];
		if (salary) salary.required = false;
	}
	let additional = classId === 'extra-fields' ? true : rng.bool();
	if (grade === 'junior') {
		fields.push({
			name: 'tags',
			type: 'array',
			required: rng.bool(0.7),
			nullable: false,
			minItems: classId === 'arrays' ? rng.int(1, 2) : 1
		});
		if (classId === 'dates') fields.push({ name: 'closed_at', type: 'date', required: true, nullable: true });
		const nestedAdditional = classId === 'nested-extra' ? !additional : rng.bool();
		fields.push({
			name: 'company',
			type: 'object',
			required: true,
			nullable: false,
			additional: nestedAdditional,
			fields: [
				{ name: 'name', type: 'string', required: true, nullable: false },
				{ name: 'size', type: 'integer', required: false, nullable: rng.bool() },
				{ name: 'verified', type: 'boolean', required: rng.bool(), nullable: false }
			]
		});
		if (classId === 'nested-extra') additional = !nestedAdditional;
	}
	return { fields, additional };
}

function baseValue(rng: Rng, f: Field): Json {
	switch (f.type) {
		case 'integer':
			return f.name === 'salary' ? rng.int(6, 30) * 10000 : f.name === 'size' ? rng.int(5, 900) : rng.int(10, 999);
		case 'string':
			return f.name === 'title' ? rng.pick(TITLES) : rng.pick(COMPANIES);
		case 'boolean':
			return rng.bool();
		case 'enum':
			return rng.pick(f.values ?? ['open']);
		case 'date':
			return `2026-${String(rng.int(1, 9)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
		case 'array':
			return rng.sample(TAGS, rng.int(Math.max(1, f.minItems ?? 1), 3));
		case 'object': {
			const obj: Obj = {};
			for (const inner of f.fields ?? []) if (inner.required || rng.bool(0.7)) obj[inner.name] = baseValue(rng, inner);
			return obj;
		}
	}
}

function baseObject(rng: Rng, schema: Schema): Obj {
	const obj: Obj = {};
	for (const f of schema.fields) if (f.required || rng.bool(0.75)) obj[f.name] = baseValue(rng, f);
	return obj;
}

type Kind =
	| 'null-nullable'
	| 'null-not-nullable'
	| 'absent-optional'
	| 'absent-required'
	| 'number-string'
	| 'bool-string'
	| 'enum-case'
	| 'enum-unknown'
	| 'extra'
	| 'empty-array'
	| 'array-item'
	| 'bad-date'
	| 'valid-date';

/** A place of a field: the object holding it and the field's spec; the root and the nested object both count. */
interface Slot {
	holder: Obj;
	field: Field;
}

function slots(obj: Obj, fields: readonly Field[]): Slot[] {
	const out: Slot[] = fields.map((field) => ({ holder: obj, field }));
	for (const f of fields) {
		const v = obj[f.name];
		if (f.type === 'object' && v !== undefined && isObj(v)) out.push(...slots(v, f.fields ?? []));
	}
	return out;
}

/** A scalar as text: what a server that quotes everything would send. */
const scalarText = (v: Json | undefined): string => (typeof v === 'string' ? v : JSON.stringify(v ?? null));

/** Applies one deviation in place; `false` — the object has no field it fits. */
function apply(rng: Rng, obj: Obj, schema: Schema, kind: Kind): boolean {
	const all = slots(obj, schema.fields);
	const present = all.filter((s) => s.field.name in s.holder && s.holder[s.field.name] !== null);
	const pick = (candidates: Slot[]): Slot | null => (candidates.length ? rng.pick(candidates) : null);
	let slot: Slot | null;
	switch (kind) {
		case 'null-nullable':
			slot = pick(present.filter((s) => s.field.nullable));
			if (slot) slot.holder[slot.field.name] = null;
			return slot !== null;
		case 'null-not-nullable':
			slot = pick(present.filter((s) => !s.field.nullable && s.field.type !== 'object'));
			if (slot) slot.holder[slot.field.name] = null;
			return slot !== null;
		case 'absent-optional':
			slot = pick(present.filter((s) => !s.field.required));
			if (slot) Reflect.deleteProperty(slot.holder, slot.field.name);
			return slot !== null;
		case 'absent-required':
			slot = pick(present.filter((s) => s.field.required && s.field.type !== 'object'));
			if (slot) Reflect.deleteProperty(slot.holder, slot.field.name);
			return slot !== null;
		case 'number-string':
			slot = pick(present.filter((s) => s.field.type === 'integer'));
			if (slot) slot.holder[slot.field.name] = scalarText(slot.holder[slot.field.name]);
			return slot !== null;
		case 'bool-string':
			slot = pick(present.filter((s) => s.field.type === 'boolean'));
			if (slot) slot.holder[slot.field.name] = scalarText(slot.holder[slot.field.name]);
			return slot !== null;
		case 'enum-case':
		case 'enum-unknown':
			slot = pick(present.filter((s) => s.field.type === 'enum'));
			if (slot) {
				const v = scalarText(slot.holder[slot.field.name]);
				slot.holder[slot.field.name] =
					kind === 'enum-case'
						? rng.bool()
							? v.toUpperCase()
							: `${v.charAt(0).toUpperCase()}${v.slice(1)}`
						: rng.pick(['deleted', 'hidden', 'unknown']);
			}
			return slot !== null;
		case 'extra': {
			const holders = [obj, ...present.filter((s) => s.field.type === 'object').map((s) => s.holder[s.field.name])];
			const holder = rng.pick(holders.filter((h): h is Obj => h !== undefined && isObj(h)));
			const free = EXTRA_KEYS.filter(([k]) => !(k in holder));
			const [key, value] = rng.pick(free.length ? free : EXTRA_KEYS);
			holder[key] = value;
			return true;
		}
		case 'empty-array':
		case 'array-item':
			slot = pick(present.filter((s) => s.field.type === 'array'));
			if (slot) {
				const items = slot.holder[slot.field.name];
				const list = Array.isArray(items) ? items : [];
				slot.holder[slot.field.name] =
					kind === 'empty-array'
						? (slot.field.minItems ?? 1) > 1 && rng.bool()
							? list.slice(0, 1)
							: []
						: [...list.slice(0, 2), rng.pick<Json>([rng.int(1, 9), true, null])];
			}
			return slot !== null && (kind === 'array-item' || (slot.field.minItems ?? 1) > 0);
		case 'bad-date':
		case 'valid-date':
			slot = pick(present.filter((s) => s.field.type === 'date'));
			if (slot) {
				const y = 2026;
				const m = rng.int(1, 9);
				const d = rng.int(10, 28);
				const mm = String(m).padStart(2, '0');
				slot.holder[slot.field.name] =
					kind === 'valid-date'
						? rng.pick([`2024-02-29`, `${y}-12-31`, `${y}-${mm}-${d}`])
						: rng.pick([
								`${y}-${m}-${d}`,
								`${d}.${mm}.${y}`,
								`${y}/${mm}/${d}`,
								`${y}-${mm}-${d}T10:00:00`,
								`${y}-02-30`,
								`${y}-04-31`,
								`${y}-13-0${rng.int(1, 9)}`
							]);
			}
			return slot !== null;
	}
}

/** Deviations a class draws, by weight; `none` — a response that follows the schema. */
const POOLS: Record<string, readonly (readonly [Kind | 'none', number])[]> = {
	'intern/nullable': [
		['none', 1],
		['null-nullable', 3],
		['null-not-nullable', 3],
		['absent-optional', 1]
	],
	'intern/optional': [
		['none', 1],
		['absent-optional', 4],
		['absent-required', 3],
		['null-nullable', 1]
	],
	'intern/types-enum': [
		['none', 3],
		['number-string', 2],
		['bool-string', 2],
		['enum-case', 2],
		['enum-unknown', 1],
		['absent-optional', 2],
		['null-nullable', 1]
	],
	'intern/extra-fields': [
		['none', 1],
		['extra', 4],
		['number-string', 1],
		['absent-required', 1],
		['null-not-nullable', 1]
	],
	'junior/nested-extra': [
		['none', 1],
		['extra', 5],
		['absent-optional', 1],
		['null-not-nullable', 1],
		['bool-string', 1]
	],
	'junior/arrays': [
		['none', 1],
		['empty-array', 3],
		['array-item', 3],
		['absent-optional', 1],
		['null-nullable', 1]
	],
	'junior/dates': [
		['none', 1],
		['bad-date', 4],
		['valid-date', 2],
		['null-nullable', 2],
		['absent-optional', 1]
	],
	'junior/combined': [
		['null-nullable', 2],
		['absent-optional', 2],
		['extra', 1],
		['null-not-nullable', 2],
		['number-string', 1],
		['enum-case', 1],
		['bad-date', 1],
		['empty-array', 1]
	]
};

function drawKind(rng: Rng, pool: readonly (readonly [Kind | 'none', number])[]): Kind | 'none' {
	const total = pool.reduce((s, [, w]) => s + w, 0);
	let x = rng.next() * total;
	for (const [kind, w] of pool) {
		if (x < w) return kind;
		x -= w;
	}
	return pool[pool.length - 1]?.[0] ?? 'none';
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const schema = makeSchema(rng, grade, classId);
	const pool = POOLS[`${grade}/${classId}`];
	if (!pool) throw new Error(`${descriptor.key}: no pool for ${grade}/${classId}`);
	const count = grade === 'intern' ? rng.int(7, 8) : rng.int(8, 10);
	const responses: Obj[] = [];
	for (let i = 0; i < count; i += 1) {
		const obj = baseObject(rng, schema);
		const deviations = grade === 'junior' && classId === 'combined' ? 2 : 1;
		for (let d = 0; d < deviations; d += 1) {
			for (let attempt = 0; attempt < 10; attempt += 1) {
				const kind = drawKind(rng, pool);
				if (kind === 'none' || apply(rng, obj, schema, kind)) break;
			}
		}
		responses.push(obj);
	}
	return { schema, responses };
}

const TYPE_TEXT: Record<FieldType, string> = {
	integer: 'integer',
	string: 'string',
	boolean: 'boolean',
	enum: 'строка-перечисление',
	date: 'date',
	array: 'массив строк',
	object: 'объект'
};

function fieldLine(f: Field): string {
	const parts = [`\`${f.name}\` — ${TYPE_TEXT[f.type]}`];
	if (f.type === 'enum') parts.push(`значения ${(f.values ?? []).map((v) => `\`${v}\``).join(', ')}`);
	if (f.type === 'array')
		parts.push(`не меньше ${f.minItems ?? 0} ${(f.minItems ?? 0) === 1 ? 'элемента' : 'элементов'}`);
	parts.push(f.required ? 'обязательное' : 'необязательное');
	if (f.nullable) parts.push('может быть null');
	return `- ${parts.join(', ')}`;
}

function fmt(v: Json): string {
	if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
	if (isObj(v))
		return `{${Object.entries(v)
			.map(([k, x]) => `${JSON.stringify(k)}: ${fmt(x)}`)
			.join(', ')}}`;
	return JSON.stringify(v);
}

function describe(p: Params): string {
	const nested = p.schema.fields.find((f) => f.type === 'object');
	const extraText = (allowed: boolean): string => (allowed ? 'лишние поля разрешены' : 'лишние поля запрещены');
	return [
		'Тестировщик сверяет ответы метода `GET /api/v1/vacancies/{id}` со схемой из контракта.',
		'',
		'## Схема ответа',
		'',
		`Корневой объект, ${extraText(p.schema.additional)}:`,
		'',
		...p.schema.fields.map(fieldLine),
		...(nested
			? [
					'',
					`Объект \`${nested.name}\`, ${extraText(nested.additional ?? true)}:`,
					'',
					...(nested.fields ?? []).map(fieldLine)
				]
			: []),
		'',
		'## Правила схемы',
		'',
		'- Обязательное поле — ключ обязан присутствовать; необязательный ключ можно не передавать.',
		'- null допустим только в полях с пометкой «может быть null»; в остальных полях null — нарушение, даже если поле необязательное.',
		'- integer — число JSON без кавычек и без дробной части; boolean — `true` или `false` без кавычек; строка `"15"` или `"true"` — не число и не boolean.',
		'- Значение перечисления должно совпасть с одним из перечисленных точно, с учётом регистра.',
		...(p.schema.fields.some((f) => f.type === 'array')
			? ['- Массив строк: каждый элемент — строка, элементов не меньше указанного числа.']
			: []),
		'- date — строка ровно вида `ГГГГ-ММ-ДД` с существующей календарной датой, например `2026-10-05`.',
		'- «Лишние поля разрешены» — ключи, которых нет в схеме, допустимы с любым значением; «запрещены» — любой такой ключ — нарушение.',
		'',
		'## Фактические ответы',
		'',
		'```',
		...p.responses.map((r, i) => `${i + 1}. ${fmt(r)}`),
		'```',
		'',
		'Введите номера ответов, которые нарушают схему, по одному в строке, в любом порядке; если таких нет — одна строка `-`. Например:',
		'',
		'```',
		'2',
		'5',
		'```'
	].join('\n');
}

const PYTHON_REFERENCE = `import json, datetime, re

p = json.loads(input())

def date_ok(s):
    if not re.fullmatch(r"\\d{4}-\\d{2}-\\d{2}", s):
        return False
    try:
        datetime.date(int(s[:4]), int(s[5:7]), int(s[8:]))
    except ValueError:
        return False
    return True

def value_ok(v, f):
    t = f["type"]
    if t == "integer":
        return type(v) is int
    if t == "string":
        return type(v) is str
    if t == "boolean":
        return type(v) is bool
    if t == "enum":
        return type(v) is str and v in f["values"]
    if t == "date":
        return type(v) is str and date_ok(v)
    if t == "array":
        return type(v) is list and len(v) >= f["minItems"] and all(type(x) is str for x in v)
    return type(v) is dict and object_ok(v, f["fields"], f["additional"])

def object_ok(obj, fields, additional):
    names = {f["name"] for f in fields}
    if not additional and any(k not in names for k in obj):
        return False
    for f in fields:
        if f["name"] not in obj:
            if f["required"]:
                return False
        elif obj[f["name"]] is None:
            if not f["nullable"]:
                return False
        elif not value_ok(obj[f["name"]], f):
            return False
    return True

bad = [str(i + 1) for i, raw in enumerate(p["responses"])
       if not object_ok(json.loads(raw), p["schema"]["fields"], p["schema"]["additional"])]
print("\\n".join(bad) if bad else "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'null-nullable-violation': { nullAlwaysBad: true },
	'null-required-ok': { anyNullOk: true },
	'missing-optional-violation': { allRequired: true },
	'string-scalar-ok': { scalarStringOk: true },
	'enum-case-ok': { enumCaseOk: true },
	'extra-allowed-violation': { extraAlwaysBad: true },
	'extra-forbidden-ok': { extraAlwaysOk: true },
	'empty-array-ok': { emptyArrayOk: true },
	'array-items-unchecked': { itemsUnchecked: true },
	'date-format-ok': { dateFormatOk: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/nullable': ['null-nullable-violation', 'null-required-ok'],
	'intern/optional': ['missing-optional-violation'],
	'intern/types-enum': ['string-scalar-ok', 'enum-case-ok'],
	'intern/extra-fields': ['extra-allowed-violation'],
	'junior/nested-extra': ['extra-allowed-violation', 'extra-forbidden-ok'],
	'junior/arrays': ['empty-array-ok', 'array-items-unchecked'],
	'junior/dates': ['date-format-ok', 'null-nullable-violation'],
	'junior/combined': ['missing-optional-violation', 'null-required-ok']
};

const key = (values: readonly string[]): string => [...values].sort().join(' ');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Responses are drawn until every misconception the class is about changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = verdict(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = verdict(p, { ...RIGHT, ...change });
				return [id, key(value) === key(answer) ? null : value];
			})
		);
		if (key(answer) === '-' || required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'set', value: answer }
		});
		// The reference parses the responses from the text the candidate sees.
		const stdin = JSON.stringify({ schema: p.schema, responses: p.responses.map(fmt) });
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
