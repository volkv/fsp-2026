// Breaking changes between API versions: a list of schema changes from v1 to v2 of one method, the profile of each
// client (which fields and values it sends, which fields it reads, how strict it is) and how the v2 server treats
// unknown request fields; by the team's compatibility rules the tester names the changes that break each client.
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

type Kind =
	| 'req-add-required'
	| 'req-add-optional'
	| 'req-make-required'
	| 'req-remove'
	| 'req-enum-narrow'
	| 'req-enum-widen'
	| 'req-type'
	| 'req-default'
	| 'res-add'
	| 'res-remove'
	| 'res-enum-widen'
	| 'res-enum-narrow'
	| 'res-nullable'
	| 'res-non-nullable'
	| 'res-type'
	| 'res-rename';

interface Change {
	id: number;
	kind: Kind;
	field: string;
	/** The enum value added or removed, the new default, or the new name. */
	value: string;
}

interface Client {
	name: string;
	/** Short Latin code that prefixes the client's changes in an answer with two clients. */
	code: string;
	/** Optional request fields the client sends (`amount` it always sends). */
	sends: string[];
	/** Values the client sends in enum fields it sends. */
	values: Record<string, string[]>;
	reads: string[];
	strictFields: boolean;
	strictEnums: boolean;
}

interface Params {
	serverRejectsUnknown: boolean;
	clients: Client[];
	changes: Change[];
}

interface Rules {
	requiredAddSafe: boolean;
	narrowSafe: boolean;
	usageIgnored: boolean;
	nullableSafe: boolean;
	widenSafe: boolean;
	tolerantAssumed: boolean;
	defaultSafe: boolean;
	removedRequestRejected: boolean;
	enumDirection: boolean;
}

const RIGHT: Rules = {
	requiredAddSafe: false,
	narrowSafe: false,
	usageIgnored: false,
	nullableSafe: false,
	widenSafe: false,
	tolerantAssumed: false,
	defaultSafe: false,
	removedRequestRejected: false,
	enumDirection: false
};

interface RequestField {
	name: string;
	type: 'integer' | 'string' | 'boolean' | 'enum';
	values?: readonly string[];
	default?: string;
}

const REQUEST_FIELDS: readonly RequestField[] = [
	{ name: 'currency', type: 'enum', values: ['RUB', 'USD', 'EUR', 'KZT'], default: 'RUB' },
	{ name: 'priority', type: 'enum', values: ['low', 'normal', 'high'], default: 'normal' },
	{ name: 'channel', type: 'enum', values: ['web', 'app', 'partner'], default: 'web' },
	{ name: 'comment', type: 'string' },
	{ name: 'coupon', type: 'string' },
	{ name: 'notify', type: 'boolean', default: 'true' },
	{ name: 'gift_wrap', type: 'boolean', default: 'false' },
	{ name: 'delivery_slot', type: 'string' }
];
const RESPONSE_ENUMS: Record<string, readonly string[]> = {
	status: ['new', 'paid', 'shipped', 'cancelled'],
	payment_method: ['card', 'cash', 'sbp']
};
const RESPONSE_FIELDS = [
	'status',
	'payment_method',
	'total',
	'discount',
	'created_at',
	'eta',
	'tracking_url',
	'rating',
	'items_count'
] as const;
const NEW_REQUEST = ['region', 'tax_id', 'source', 'locale'] as const;
const NEW_RESPONSE = ['loyalty_points', 'warehouse', 'courier', 'invoice_url'] as const;
const NEW_ENUM_VALUES: Record<string, readonly string[]> = {
	currency: ['CNY', 'BYN'],
	priority: ['urgent'],
	channel: ['kiosk', 'tg'],
	status: ['on_hold', 'returned'],
	payment_method: ['crypto', 'bnpl']
};

/** Whether a change breaks a client under a model of the rules. */
function breaks(c: Change, client: Client, serverRejects: boolean, rules: Rules): boolean {
	const sends = client.sends.includes(c.field);
	const reads = client.reads.includes(c.field);
	const strictFields = client.strictFields && !rules.tolerantAssumed;
	switch (c.kind) {
		case 'req-add-required':
			return !rules.requiredAddSafe;
		case 'req-add-optional':
			return false;
		case 'req-make-required':
			return !rules.requiredAddSafe && !sends;
		case 'req-remove':
			if (rules.removedRequestRejected) return rules.usageIgnored || sends;
			return serverRejects && (rules.usageIgnored || sends);
		case 'req-enum-narrow':
			if (rules.narrowSafe || rules.enumDirection) return false;
			return sends && (client.values[c.field] ?? []).includes(c.value);
		case 'req-enum-widen':
			return rules.enumDirection && sends;
		case 'req-type':
			return rules.usageIgnored || sends;
		case 'req-default':
			return !rules.defaultSafe && !sends;
		case 'res-add':
			return strictFields;
		case 'res-remove':
		case 'res-type':
			return rules.usageIgnored || reads;
		case 'res-nullable':
			return !rules.nullableSafe && (rules.usageIgnored || reads);
		case 'res-enum-widen':
			return !rules.widenSafe && reads && client.strictEnums;
		case 'res-enum-narrow':
		case 'res-non-nullable':
			return false;
		case 'res-rename':
			return rules.usageIgnored || reads || strictFields;
	}
}

/** The breaking changes: their ids for one client, `code:id` pairs for two clients; the single line `-` if none. */
function verdict(p: Params, rules: Rules): string[] {
	const many = p.clients.length > 1;
	const lines = p.clients.flatMap((client) =>
		p.changes
			.filter((c) => breaks(c, client, p.serverRejectsUnknown, rules))
			.map((c) => (many ? `${client.code}:${c.id}` : String(c.id)))
	);
	return lines.length ? lines : ['-'];
}

interface Mix {
	kinds: Readonly<Partial<Record<Kind, number>>>;
	count: [number, number];
	/** Strictness of each client: `true`/`false` fixed, `null` drawn. */
	strict: readonly (boolean | null)[];
	serverRejects: boolean | null;
}

const MIXES: Record<string, Mix> = {
	'middle/request-changes': {
		kinds: {
			'req-add-required': 1,
			'req-add-optional': 1,
			'req-make-required': 2,
			'req-enum-narrow': 3,
			'req-enum-widen': 1,
			'req-type': 1,
			'res-remove': 1,
			'res-add': 1
		},
		count: [6, 8],
		strict: [null],
		serverRejects: null
	},
	'middle/response-changes': {
		kinds: {
			'res-remove': 2,
			'res-nullable': 3,
			'res-type': 1,
			'res-add': 1,
			'res-enum-widen': 1,
			'res-enum-narrow': 1,
			'res-non-nullable': 1,
			'req-add-optional': 1
		},
		count: [6, 8],
		strict: [false],
		serverRejects: null
	},
	'middle/strict-client': {
		kinds: {
			'res-add': 2,
			'res-enum-widen': 3,
			'res-enum-narrow': 1,
			'res-remove': 1,
			'res-non-nullable': 1,
			'req-enum-widen': 1,
			'req-add-optional': 1
		},
		count: [6, 8],
		strict: [true],
		serverRejects: null
	},
	'middle/defaults': {
		kinds: {
			'req-default': 3,
			'req-make-required': 2,
			'req-add-optional': 1,
			'res-non-nullable': 1,
			'req-remove': 1,
			'res-remove': 1
		},
		count: [6, 8],
		strict: [null],
		serverRejects: null
	},
	'senior/two-clients': {
		kinds: {
			'res-add': 2,
			'res-remove': 2,
			'res-type': 1,
			'res-enum-widen': 2,
			'req-make-required': 1,
			'req-enum-narrow': 1,
			'req-type': 1,
			'req-default': 1,
			'res-nullable': 1
		},
		count: [8, 10],
		strict: [false, true],
		serverRejects: null
	},
	'senior/server-mode': {
		kinds: {
			'req-remove': 3,
			'req-enum-widen': 2,
			'req-enum-narrow': 2,
			'req-add-optional': 1,
			'req-type': 1,
			'res-add': 1,
			'res-remove': 1
		},
		count: [8, 10],
		strict: [false, true],
		serverRejects: false
	},
	'senior/renames': {
		kinds: {
			'res-rename': 2,
			'res-type': 2,
			'res-nullable': 2,
			'res-enum-widen': 2,
			'res-add': 1,
			'res-non-nullable': 1,
			'req-add-optional': 1
		},
		count: [8, 10],
		strict: [false, true],
		serverRejects: null
	},
	'senior/mixed-all': {
		kinds: {
			'req-add-required': 1,
			'req-make-required': 1,
			'req-remove': 1,
			'req-enum-narrow': 2,
			'req-enum-widen': 1,
			'req-default': 2,
			'res-add': 1,
			'res-remove': 1,
			'res-enum-widen': 1,
			'res-nullable': 1,
			'res-rename': 1
		},
		count: [8, 10],
		strict: [null, null],
		serverRejects: null
	}
};

function weighted<K extends string>(rng: Rng, weights: Readonly<Partial<Record<K, number>>>): K {
	const entries = Object.entries(weights) as [K, number][];
	const total = entries.reduce((s, [, w]) => s + w, 0);
	let x = rng.next() * total;
	for (const [key, w] of entries) {
		if (x < w) return key;
		x -= w;
	}
	const last = entries.at(-1);
	if (!last) throw new Error('weighted: empty');
	return last[0];
}

const CLIENT_NAMES = [
	{ name: 'Мобильное приложение', code: 'mobile' },
	{ name: 'Интеграция партнёра', code: 'partner' },
	{ name: 'Веб-кабинет', code: 'web' },
	{ name: 'Сервис отчётов', code: 'reports' }
] as const;

function makeClient(rng: Rng, { name, code }: { name: string; code: string }, strict: boolean): Client {
	const sends = REQUEST_FIELDS.filter(() => rng.bool(0.5)).map((f) => f.name);
	const values: Record<string, string[]> = {};
	for (const f of REQUEST_FIELDS) {
		if (f.type === 'enum' && sends.includes(f.name)) values[f.name] = rng.sample(f.values ?? [], rng.int(1, 2));
	}
	const reads = RESPONSE_FIELDS.filter(() => rng.bool(0.5));
	return { name, code, sends, values, reads: [...reads], strictFields: strict, strictEnums: strict };
}

/** A change of the given kind on a field no other change touches; `null` — no such field is left. */
function makeChange(rng: Rng, kind: Kind, id: number, used: Set<string>): Change | null {
	const freeRequest = REQUEST_FIELDS.filter((f) => !used.has(f.name));
	const freeResponse = RESPONSE_FIELDS.filter((f) => !used.has(f));
	const pickFree = <T>(items: readonly T[]): T | null => (items.length ? rng.pick(items) : null);
	let field: string | null = null;
	let value = '';
	switch (kind) {
		case 'req-add-required':
		case 'req-add-optional':
			field = pickFree(NEW_REQUEST.filter((f) => !used.has(f)));
			break;
		case 'res-add':
			field = pickFree(NEW_RESPONSE.filter((f) => !used.has(f)));
			break;
		case 'req-make-required':
		case 'req-remove':
		case 'req-type':
			field = pickFree(freeRequest.filter((f) => kind !== 'req-type' || f.type !== 'string'))?.name ?? null;
			break;
		case 'req-default': {
			const f = pickFree(freeRequest.filter((x) => x.default !== undefined));
			if (f) {
				field = f.name;
				value =
					f.type === 'boolean'
						? f.default === 'true'
							? 'false'
							: 'true'
						: rng.pick((f.values ?? []).filter((v) => v !== f.default));
			}
			break;
		}
		case 'req-enum-narrow':
		case 'req-enum-widen': {
			const f = pickFree(freeRequest.filter((x) => x.type === 'enum'));
			if (f) {
				field = f.name;
				value =
					kind === 'req-enum-narrow'
						? rng.pick((f.values ?? []).filter((v) => v !== f.default))
						: rng.pick(NEW_ENUM_VALUES[f.name] ?? ['other']);
			}
			break;
		}
		case 'res-enum-widen':
		case 'res-enum-narrow': {
			field = pickFree(freeResponse.filter((f) => f in RESPONSE_ENUMS));
			if (field)
				value =
					kind === 'res-enum-widen'
						? rng.pick(NEW_ENUM_VALUES[field] ?? ['other'])
						: rng.pick(RESPONSE_ENUMS[field] ?? ['other']);
			break;
		}
		case 'res-rename':
			field = pickFree(freeResponse.filter((f) => !(f in RESPONSE_ENUMS)));
			if (field) value = `${field}_v2`;
			break;
		case 'res-remove':
		case 'res-nullable':
		case 'res-non-nullable':
		case 'res-type':
			field = pickFree(freeResponse);
			break;
	}
	if (field === null) return null;
	used.add(field);
	return { id, kind, field, value };
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const mix = MIXES[`${grade}/${classId}`];
	if (!mix) throw new Error(`${descriptor.key}: no mix for ${grade}/${classId}`);
	const names = rng.sample(CLIENT_NAMES, mix.strict.length);
	const clients = mix.strict.map((s, i) =>
		makeClient(rng, names[i] ?? { name: 'Клиент', code: 'client' }, s ?? rng.bool())
	);
	const used = new Set<string>();
	const changes: Change[] = [];
	const count = rng.int(mix.count[0], mix.count[1]);
	for (let attempt = 0; changes.length < count && attempt < 50; attempt += 1) {
		const change = makeChange(rng, weighted(rng, mix.kinds), changes.length + 1, used);
		if (change) changes.push(change);
	}
	return { serverRejectsUnknown: mix.serverRejects ?? rng.bool(), clients, changes };
}

function changeText(c: Change): string {
	const f = `\`${c.field}\``;
	const v = `\`${c.value}\``;
	switch (c.kind) {
		case 'req-add-required':
			return `Запрос: новое обязательное поле ${f}.`;
		case 'req-add-optional':
			return `Запрос: новое необязательное поле ${f}.`;
		case 'req-make-required':
			return `Запрос: поле ${f} стало обязательным.`;
		case 'req-remove':
			return `Запрос: поле ${f} удалено из схемы.`;
		case 'req-enum-narrow':
			return `Запрос: из перечисления ${f} удалено значение ${v}.`;
		case 'req-enum-widen':
			return `Запрос: в перечисление ${f} добавлено значение ${v}.`;
		case 'req-type': {
			const type = REQUEST_FIELDS.find((x) => x.name === c.field)?.type;
			return `Запрос: тип поля ${f} изменён с ${type === 'enum' ? 'перечисления' : 'boolean'} на объект.`;
		}
		case 'req-default':
			return `Запрос: значение ${f} по умолчанию изменено на ${v}.`;
		case 'res-add':
			return `Ответ: новое поле ${f}.`;
		case 'res-remove':
			return `Ответ: поле ${f} удалено.`;
		case 'res-enum-widen':
			return `Ответ: в перечисление ${f} добавлено значение ${v}.`;
		case 'res-enum-narrow':
			return `Ответ: из перечисления ${f} удалено значение ${v} — сервер больше его не отдаёт.`;
		case 'res-nullable':
			return `Ответ: поле ${f} теперь может быть null.`;
		case 'res-non-nullable':
			return `Ответ: поле ${f} больше не бывает null.`;
		case 'res-type':
			return `Ответ: тип поля ${f} изменён с числа на строку.`;
		case 'res-rename':
			return `Ответ: поле ${f} переименовано в ${v}.`;
	}
}

function requestFieldText(f: RequestField): string {
	const type = f.type === 'enum' ? `перечисление ${(f.values ?? []).map((x) => `\`${x}\``).join(', ')}` : f.type;
	return `- \`${f.name}\` — ${type}, необязательное${f.default !== undefined ? `, по умолчанию \`${f.default}\`` : ''}`;
}

function clientText(c: Client, many: boolean): string[] {
	const sent = c.sends.map((name) => {
		const values = c.values[name];
		return values ? `\`${name}\` (только значения ${values.map((v) => `\`${v}\``).join(', ')})` : `\`${name}\``;
	});
	return [
		many ? `**${c.name}** (код \`${c.code}\`):` : `**${c.name}**:`,
		'',
		`- передаёт в запросе поля: \`amount\`${sent.length ? `, ${sent.join(', ')}` : ''}; остальные поля запроса не передаёт;`,
		`- читает поля ответа: \`id\`${c.reads.length ? `, ${c.reads.map((r) => `\`${r}\``).join(', ')}` : ''}; остальные поля не читает;`,
		c.strictFields
			? '- ответ с неизвестным полем отклоняет целиком; неизвестное значение перечисления в читаемом поле — тоже ошибка.'
			: '- неизвестные поля ответа игнорирует; неизвестное значение перечисления в читаемом поле показывает как «другое».',
		''
	];
}

function describe(p: Params): string {
	const many = p.clients.length > 1;
	return [
		'Команда готовит v2 метода `POST /api/v1/orders`. Тестировщик по списку изменений схемы и профилям клиентов определяет, какие изменения сломают клиентов.',
		'',
		'## Схема v1',
		'',
		'Запрос:',
		'',
		'- `amount` — integer, обязательное',
		...REQUEST_FIELDS.map(requestFieldText),
		'',
		`Ответ: \`id\`, \`status\` (перечисление ${(RESPONSE_ENUMS.status ?? []).map((x) => `\`${x}\``).join(', ')}), \`payment_method\` (перечисление ${(RESPONSE_ENUMS.payment_method ?? []).map((x) => `\`${x}\``).join(', ')}), ${RESPONSE_FIELDS.filter(
			(f) => !(f in RESPONSE_ENUMS)
		)
			.map((f) => `\`${f}\``)
			.join(', ')}.`,
		'',
		many ? '## Клиенты' : '## Клиент',
		'',
		...p.clients.flatMap((c) => clientText(c, many)),
		`Сервер v2 ${p.serverRejectsUnknown ? 'отклоняет запрос, в котором есть поле, которого нет в схеме v2 (`422`)' : 'игнорирует поля запроса, которых нет в схеме v2'}.`,
		'',
		'## Изменения v1 → v2',
		'',
		...p.changes.map((c) => `${c.id}. ${changeText(c)}`),
		'',
		'## Правила совместимости команды',
		'',
		'Изменение ломает клиента, если его запрос, корректный в v1, в v2 отклоняется или обрабатывается иначе, или клиент не может разобрать ответ:',
		'',
		'- запрос, новое обязательное поле — ломает любого клиента; поле стало обязательным — ломает клиента, который его не передаёт;',
		'- запрос, новое необязательное поле или новое значение перечисления — не ломает;',
		'- запрос, удалённое значение перечисления — ломает клиента, который передаёт это значение;',
		'- запрос, изменённый тип поля — ломает клиента, который передаёт это поле;',
		'- запрос, новое значение по умолчанию — ломает клиента, который поле не передаёт (поведение для него меняется);',
		'- запрос, удалённое поле — ломает клиента, который его передаёт, если сервер v2 отклоняет неизвестные поля; если игнорирует — не ломает;',
		'- ответ, новое поле — ломает клиента, который отклоняет ответы с неизвестными полями;',
		'- ответ, удалённое поле, изменённый тип или поле, ставшее nullable, — ломает клиента, который это поле читает;',
		'- ответ, новое значение перечисления — ломает клиента, который читает это поле и считает неизвестное значение ошибкой;',
		'- ответ, удалённое значение перечисления или поле, переставшее быть null, — не ломает;',
		'- ответ, переименованное поле — как удаление старого поля и добавление нового.',
		'',
		many
			? 'Введите ломающие изменения по одному в строке, в любом порядке: код клиента, двоеточие и номер изменения, которое его ломает (изменение, которое ломает обоих клиентов, — двумя строками); если таких нет — одна строка `-`. Например:'
			: 'Введите номера изменений, которые ломают клиента, по одному в строке, в любом порядке; если таких нет — одна строка `-`. Например:',
		'',
		'```',
		...(many ? ['mobile:1', 'mobile:4', 'web:4'] : ['2', '5', '6']),
		'```'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
rejects = p["serverRejectsUnknown"]

def broken(c, cl):
    k, f = c["kind"], c["field"]
    sends = f in cl["sends"]
    reads = f in cl["reads"]
    if k == "req-add-required":
        return True
    if k == "req-make-required" or k == "req-default":
        return not sends
    if k == "req-remove":
        return sends and rejects
    if k == "req-enum-narrow":
        return sends and c["value"] in cl["values"].get(f, [])
    if k == "req-type":
        return sends
    if k == "res-add":
        return cl["strictFields"]
    if k in ("res-remove", "res-type", "res-nullable"):
        return reads
    if k == "res-enum-widen":
        return reads and cl["strictEnums"]
    if k == "res-rename":
        return reads or cl["strictFields"]
    return False

many = len(p["clients"]) > 1
lines = [f'{cl["code"]}:{c["id"]}' if many else str(c["id"])
         for cl in p["clients"] for c in p["changes"] if broken(c, cl)]
print("\\n".join(lines) if lines else "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'required-add-safe': { requiredAddSafe: true },
	'narrow-safe': { narrowSafe: true },
	'usage-ignored': { usageIgnored: true },
	'nullable-safe': { nullableSafe: true },
	'widen-safe': { widenSafe: true },
	'tolerant-assumed': { tolerantAssumed: true },
	'default-safe': { defaultSafe: true },
	'removed-request-rejected': { removedRequestRejected: true },
	'enum-direction': { enumDirection: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/request-changes': ['required-add-safe', 'narrow-safe'],
	'middle/response-changes': ['usage-ignored', 'nullable-safe'],
	'middle/strict-client': ['widen-safe', 'tolerant-assumed'],
	'middle/defaults': ['default-safe', 'required-add-safe'],
	'senior/two-clients': ['tolerant-assumed', 'usage-ignored'],
	'senior/server-mode': ['removed-request-rejected', 'enum-direction'],
	'senior/renames': ['nullable-safe', 'widen-safe'],
	'senior/mixed-all': ['narrow-safe', 'default-safe']
};

const key = (values: readonly string[]): string => [...values].sort().join(' ');

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Changes and clients are drawn until every misconception the class is about changes the answer.
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = verdict(p, RIGHT);
		if (key(answer) === '-') continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = verdict(p, { ...RIGHT, ...change });
				return [id, key(value) === key(answer) ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
