// Expected status codes by the contract: a tester runs a sequence of requests against a vacancies API whose contract
// lists its checks in order (method, token, role, existence, body, fields, uniqueness) and predicts the code of every
// response, with the state the earlier requests leave behind.
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

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
type Role = 'viewer' | 'editor' | 'admin';
type FieldValue = string | number;
type Fields = Partial<Record<'title' | 'salary_from' | 'salary_to', FieldValue>>;

interface Token {
	name: string;
	role: Role | 'expired';
}

interface Vacancy {
	id: number;
	title: string;
	from: number;
	to: number;
}

interface Request {
	method: Method;
	/** `null` — the collection address. */
	id: number | null;
	/** `null` — no Authorization header. */
	token: string | null;
	/** The raw body as sent; `null` — no body. */
	body: string | null;
	/** The parsed body; `null` with a body — it does not parse as a JSON object. */
	fields: Fields | null;
}

interface Params {
	vacancies: Vacancy[];
	nextId: number;
	tokens: Token[];
	requests: Request[];
}

interface Rules {
	anon403: boolean;
	validation400: boolean;
	success200: boolean;
	authBeforeMethod: boolean;
	existenceBeforeRights: boolean;
	bodyBeforeExistence: boolean;
	conflictBeforeValidation: boolean;
	repeatDelete204: boolean;
	deletedTitleTaken: boolean;
}

const RIGHT: Rules = {
	anon403: false,
	validation400: false,
	success200: false,
	authBeforeMethod: false,
	existenceBeforeRights: false,
	bodyBeforeExistence: false,
	conflictBeforeValidation: false,
	repeatDelete204: false,
	deletedTitleTaken: false
};

type Check = 'method' | 'auth' | 'rights' | 'exists' | 'body' | 'fields' | 'conflict';

const MAY: Record<Method, readonly Role[]> = {
	GET: ['viewer', 'editor', 'admin'],
	POST: ['editor', 'admin'],
	PATCH: ['editor', 'admin'],
	DELETE: ['admin'],
	PUT: ['viewer', 'editor', 'admin']
};

const isSalary = (v: FieldValue | undefined): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isTitle = (v: FieldValue | undefined): v is string => typeof v === 'string' && v.length >= 3 && v.length <= 40;

/** Whether the fields break the contract; `current` is the vacancy a PATCH changes, if it exists. */
function invalid(method: Method, fields: Fields, current: Vacancy | undefined): boolean {
	const keys = Object.keys(fields);
	if (method === 'POST' && keys.length !== 3) return true;
	if (keys.length === 0) return true;
	if ('title' in fields && !isTitle(fields.title)) return true;
	if ('salary_from' in fields && !isSalary(fields.salary_from)) return true;
	if ('salary_to' in fields && !isSalary(fields.salary_to)) return true;
	const from = fields.salary_from ?? current?.from;
	const to = fields.salary_to ?? current?.to;
	return typeof from === 'number' && typeof to === 'number' && from > to;
}

/** The codes of the responses in order, under a model of the contract. */
function run(p: Params, rules: Rules): string[] {
	const live = new Map(p.vacancies.map((v) => [v.id, { ...v }]));
	const deleted = new Map<number, string>();
	let next = p.nextId;
	const codes: string[] = [];
	for (const r of p.requests) {
		const token = p.tokens.find((t) => t.name === r.token);
		const role = token && token.role !== 'expired' ? token.role : null;
		const allowed: readonly Method[] = r.id === null ? ['GET', 'POST'] : ['GET', 'PATCH', 'DELETE'];
		const current = r.id === null ? undefined : live.get(r.id);
		const writes = r.method === 'POST' || r.method === 'PATCH';
		const title = r.fields?.title;
		const taken =
			typeof title === 'string' &&
			([...live.values()].some((v) => v.title === title && v.id !== r.id) ||
				(rules.deletedTitleTaken && [...deleted.values()].includes(title)));
		const repeatDelete = rules.repeatDelete204 && r.method === 'DELETE' && r.id !== null && deleted.has(r.id);
		const fails: Record<Check, boolean> = {
			method: !allowed.includes(r.method),
			auth: role === null,
			rights: role !== null && !MAY[r.method].includes(role),
			exists: r.id !== null && current === undefined && !repeatDelete,
			body: writes && r.fields === null,
			fields: writes && r.fields !== null && invalid(r.method, r.fields, current),
			conflict: writes && r.fields !== null && taken
		};
		let order: Check[] = ['method', 'auth', 'rights', 'exists', 'body', 'fields', 'conflict'];
		if (rules.authBeforeMethod) order = ['auth', 'method', 'rights', 'exists', 'body', 'fields', 'conflict'];
		if (rules.existenceBeforeRights) order = ['method', 'auth', 'exists', 'rights', 'body', 'fields', 'conflict'];
		if (rules.bodyBeforeExistence) order = ['method', 'auth', 'rights', 'body', 'fields', 'exists', 'conflict'];
		if (rules.conflictBeforeValidation) order = ['method', 'auth', 'rights', 'exists', 'body', 'conflict', 'fields'];
		const failed = order.find((check) => fails[check]);
		if (failed !== undefined) {
			const code: Record<Check, string> = {
				method: '405',
				auth: rules.anon403 ? '403' : '401',
				rights: '403',
				exists: '404',
				body: '400',
				fields: rules.validation400 ? '400' : '422',
				conflict: '409'
			};
			codes.push(code[failed]);
			continue;
		}
		const ok = (code: string): string => (rules.success200 ? '200' : code);
		if (r.method === 'GET') codes.push('200');
		else if (r.method === 'POST') {
			const f = r.fields ?? {};
			live.set(next, { id: next, title: String(f.title), from: Number(f.salary_from), to: Number(f.salary_to) });
			next += 1;
			codes.push(ok('201'));
		} else if (r.method === 'PATCH' && current) {
			const f = r.fields ?? {};
			if (typeof f.title === 'string') current.title = f.title;
			if (typeof f.salary_from === 'number') current.from = f.salary_from;
			if (typeof f.salary_to === 'number') current.to = f.salary_to;
			codes.push('200');
		} else if (r.method === 'DELETE') {
			if (current) {
				live.delete(current.id);
				deleted.set(current.id, current.title);
			}
			codes.push(ok('204'));
		}
	}
	return codes;
}

const TITLES = [
	'QA Engineer',
	'QA Lead',
	'SDET',
	'Manual QA',
	'Mobile QA',
	'Automation QA',
	'Performance QA',
	'Тестировщик API',
	'Тестировщик ПО',
	'Инженер по качеству',
	'Аналитик данных',
	'Backend Developer',
	'Frontend Developer',
	'DevOps Engineer',
	'Data Engineer',
	'Product Manager'
] as const;
const SHORT_TITLES = ['QA', 'Go', 'BA', 'PM'] as const;

interface Mix {
	tokens: Readonly<Record<'none' | 'expired' | Role, number>>;
	ops: Readonly<Record<'getItem' | 'getList' | 'post' | 'patch' | 'delete' | 'badMethod', number>>;
	/** Share of item requests to a vacancy that does not exist (never existed or deleted). */
	missing: number;
	/** Share of deleted vacancies among missing targets. */
	deletedTarget: number;
	body: Readonly<Record<'valid' | 'malformed' | 'invalid', number>>;
	/** Share of writes that take a title already used (by a live or a deleted vacancy). */
	dupTitle: number;
	requests: [number, number];
}

const MIXES: Record<string, Mix> = {
	'intern/auth-role': {
		tokens: { none: 0.15, expired: 0.15, viewer: 0.3, editor: 0.25, admin: 0.15 },
		ops: { getItem: 0.2, getList: 0.1, post: 0.25, patch: 0.25, delete: 0.2, badMethod: 0 },
		missing: 0,
		deletedTarget: 0,
		body: { valid: 1, malformed: 0, invalid: 0 },
		dupTitle: 0,
		requests: [5, 6]
	},
	'intern/body-validation': {
		tokens: { none: 0, expired: 0, viewer: 0, editor: 0.5, admin: 0.5 },
		ops: { getItem: 0.1, getList: 0, post: 0.45, patch: 0.45, delete: 0, badMethod: 0 },
		missing: 0,
		deletedTarget: 0,
		body: { valid: 0.35, malformed: 0.3, invalid: 0.35 },
		dupTitle: 0,
		requests: [5, 6]
	},
	'intern/success-codes': {
		tokens: { none: 0, expired: 0, viewer: 0, editor: 0.4, admin: 0.6 },
		ops: { getItem: 0.2, getList: 0.1, post: 0.25, patch: 0.2, delete: 0.25, badMethod: 0 },
		missing: 0.25,
		deletedTarget: 0.5,
		body: { valid: 1, malformed: 0, invalid: 0 },
		dupTitle: 0,
		requests: [5, 6]
	},
	'intern/method-check': {
		tokens: { none: 0.25, expired: 0.1, viewer: 0.2, editor: 0.2, admin: 0.25 },
		ops: { getItem: 0.15, getList: 0.1, post: 0.15, patch: 0.1, delete: 0.1, badMethod: 0.4 },
		missing: 0,
		deletedTarget: 0,
		body: { valid: 1, malformed: 0, invalid: 0 },
		dupTitle: 0,
		requests: [5, 6]
	},
	'junior/rights-vs-existence': {
		tokens: { none: 0.1, expired: 0.05, viewer: 0.35, editor: 0.3, admin: 0.2 },
		ops: { getItem: 0.15, getList: 0, post: 0.15, patch: 0.3, delete: 0.4, badMethod: 0 },
		missing: 0.5,
		deletedTarget: 0.5,
		body: { valid: 0.8, malformed: 0, invalid: 0.2 },
		dupTitle: 0.1,
		requests: [7, 8]
	},
	'junior/body-vs-existence': {
		tokens: { none: 0, expired: 0, viewer: 0, editor: 0.5, admin: 0.5 },
		ops: { getItem: 0, getList: 0, post: 0.45, patch: 0.45, delete: 0.1, badMethod: 0 },
		missing: 0.5,
		deletedTarget: 0.5,
		body: { valid: 0.3, malformed: 0.25, invalid: 0.45 },
		dupTitle: 0.45,
		requests: [7, 8]
	},
	'junior/stateful': {
		tokens: { none: 0, expired: 0, viewer: 0, editor: 0.3, admin: 0.7 },
		ops: { getItem: 0.15, getList: 0, post: 0.35, patch: 0.1, delete: 0.4, badMethod: 0 },
		missing: 0.45,
		deletedTarget: 0.9,
		body: { valid: 1, malformed: 0, invalid: 0 },
		dupTitle: 0.5,
		requests: [7, 8]
	},
	'junior/mixed': {
		tokens: { none: 0.1, expired: 0.1, viewer: 0.2, editor: 0.3, admin: 0.3 },
		ops: { getItem: 0.1, getList: 0.05, post: 0.3, patch: 0.3, delete: 0.2, badMethod: 0.05 },
		missing: 0.4,
		deletedTarget: 0.5,
		body: { valid: 0.45, malformed: 0.2, invalid: 0.35 },
		dupTitle: 0.25,
		requests: [7, 8]
	}
};

/** A key drawn by its weight. */
function weighted<K extends string>(rng: Rng, weights: Readonly<Record<K, number>>): K {
	const entries = Object.entries(weights) as [K, number][];
	const total = entries.reduce((s, [, w]) => s + w, 0);
	let x = rng.next() * total;
	for (const [key, w] of entries) {
		if (x < w) return key;
		x -= w;
	}
	const last = entries.filter(([, w]) => w > 0).at(-1);
	if (!last) throw new Error('weighted: no positive weight');
	return last[0];
}

const salary = (rng: Rng): number => rng.int(6, 30) * 10000;

/** The body as a client sends it: JSON with a space after colons and commas. */
const jsonBody = (fields: Fields): string =>
	`{${Object.entries(fields)
		.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
		.join(', ')}}`;

/** A body that does not parse as a JSON object, made from a valid one. */
function malformed(rng: Rng, fields: Fields): string {
	const json = jsonBody(fields);
	switch (rng.int(0, 3)) {
		case 0:
			return json.slice(0, -1);
		case 1:
			return json.replaceAll('"', "'");
		case 2:
			return json.replace(/"([a-z_]+)":/g, '$1:');
		default:
			return `${json.slice(0, -1)},}`;
	}
}

/** Breaks one field of a valid body; `keepTitle` leaves the title as it is. */
function breakFields(rng: Rng, method: Method, fields: Fields, keepTitle: boolean): Fields {
	const broken = { ...fields };
	const ways: string[] = ['negative', 'string', 'order'];
	if (!keepTitle && 'title' in broken) ways.push('short');
	if (method === 'POST') ways.push('missing');
	if (method === 'PATCH' && Object.keys(broken).length === 1 && !keepTitle) ways.push('empty');
	const way = rng.pick(ways);
	if (way === 'short') broken.title = rng.pick(SHORT_TITLES);
	else if (way === 'missing') {
		if (rng.bool()) delete broken.salary_from;
		else delete broken.salary_to;
	} else if (way === 'empty') return {};
	else {
		const key = rng.pick(['salary_from', 'salary_to'] as const);
		const current = broken[key];
		const value = typeof current === 'number' ? current : salary(rng);
		if (way === 'negative') broken[key] = -value;
		else if (way === 'string') broken[key] = String(value);
		else {
			broken.salary_from = value + rng.int(1, 5) * 10000;
			broken.salary_to = value;
		}
	}
	return broken;
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const mix = MIXES[`${grade}/${classId}`];
	if (!mix) throw new Error(`${descriptor.key}: no mix for ${grade}/${classId}`);
	const titles = rng.shuffle(TITLES);
	// Sparse ids: the gaps are vacancies that never existed.
	let id = rng.int(10, 80);
	const vacancies: Vacancy[] = [];
	for (let i = 0; i < rng.int(3, 4); i += 1) {
		const from = salary(rng);
		vacancies.push({ id, title: titles.pop() ?? 'QA', from, to: from + rng.int(0, 8) * 10000 });
		id += rng.int(2, 4);
	}
	const gaps: number[] = [];
	for (let k = (vacancies[0]?.id ?? 0) + 1; k < id; k += 1) if (!vacancies.some((v) => v.id === k)) gaps.push(k);
	const nextId = id + rng.int(0, 5);
	const names = rng.sample(['k7f2', 'x91a', 'm3qd', 'p0zt', 'r8hc', 'w2nb', 'd5ke', 'h6ty'], 5);
	const tokens: Token[] = [
		{ name: names[0] ?? 'a', role: 'viewer' },
		{ name: names[1] ?? 'b', role: 'editor' },
		{ name: names[2] ?? 'c', role: 'admin' },
		{ name: names[3] ?? 'd', role: 'expired' }
	];
	const tokenOf = (kind: 'none' | 'expired' | Role): string | null =>
		kind === 'none' ? null : (tokens.find((t) => t.role === kind)?.name ?? null);

	// Requests are drawn against the state the right answer leaves, so targets and titles stay meaningful.
	const requests: Request[] = [];
	const live = new Map(vacancies.map((v) => [v.id, { ...v }]));
	const deleted = new Map<number, string>();
	let next = nextId;
	const count = rng.int(mix.requests[0], mix.requests[1]);
	for (let i = 0; i < count; i += 1) {
		const op = weighted(rng, mix.ops);
		const token = tokenOf(weighted(rng, mix.tokens));
		const target = (): number => {
			if (live.size === 0 || rng.bool(mix.missing)) {
				if (deleted.size > 0 && rng.bool(mix.deletedTarget)) return rng.pick([...deleted.keys()]);
				if (gaps.length > 0) return rng.pick(gaps);
			}
			if (live.size > 0) return rng.pick([...live.keys()]);
			return rng.pick(gaps.length ? gaps : [nextId + 50]);
		};
		const freshTitle = (): string => {
			const used = new Set([...live.values()].map((v) => v.title).concat([...deleted.values()]));
			const free = TITLES.filter((t) => !used.has(t));
			return rng.pick(free.length ? free : TITLES);
		};
		const titleFor = (selfId: number | null): { title: string; dup: boolean } => {
			if (rng.bool(mix.dupTitle)) {
				const fromLive = [...live.values()].filter((v) => v.id !== selfId).map((v) => v.title);
				const fromDeleted = [...deleted.values()].filter((t) => ![...live.values()].some((v) => v.title === t));
				const pool = rng.bool()
					? fromLive.length
						? fromLive
						: fromDeleted
					: fromDeleted.length
						? fromDeleted
						: fromLive;
				if (pool.length) return { title: rng.pick(pool), dup: true };
			}
			return { title: freshTitle(), dup: false };
		};
		let request: Request;
		if (op === 'getList') request = { method: 'GET', id: null, token, body: null, fields: null };
		else if (op === 'getItem') request = { method: 'GET', id: target(), token, body: null, fields: null };
		else if (op === 'delete') request = { method: 'DELETE', id: target(), token, body: null, fields: null };
		else if (op === 'badMethod') {
			const kind = rng.int(0, 3);
			const method: Method = kind === 0 ? 'PUT' : kind === 1 ? 'POST' : kind === 2 ? 'DELETE' : 'PATCH';
			const onItem = kind <= 1;
			const from = salary(rng);
			const fields: Fields = { title: freshTitle(), salary_from: from, salary_to: from + 20000 };
			const withBody = method !== 'DELETE';
			request = {
				method,
				id: onItem ? target() : null,
				token,
				body: withBody ? jsonBody(fields) : null,
				fields: withBody ? fields : null
			};
		} else {
			const method: Method = op === 'post' ? 'POST' : 'PATCH';
			const targetId = method === 'PATCH' ? target() : null;
			const { title, dup } = titleFor(targetId);
			let fields: Fields;
			if (method === 'POST') {
				const from = salary(rng);
				fields = { title, salary_from: from, salary_to: from + rng.int(0, 10) * 10000 };
			} else {
				const which = rng.int(0, 2);
				const base = live.get(targetId ?? -1);
				fields =
					which === 0
						? { title }
						: which === 1
							? { salary_to: (base?.to ?? salary(rng)) + rng.int(1, 4) * 10000 }
							: { title, salary_from: Math.max(0, (base?.from ?? salary(rng)) - rng.int(1, 3) * 10000) };
			}
			const kind = weighted(rng, mix.body);
			if (kind === 'invalid') fields = breakFields(rng, method, fields, dup);
			const body = kind === 'malformed' ? malformed(rng, fields) : jsonBody(fields);
			request = { method, id: targetId, token, body, fields: kind === 'malformed' ? null : fields };
		}
		requests.push(request);
		// Advance the right state.
		const [code] = run({ vacancies: [...live.values()], nextId: next, tokens, requests: [request] }, RIGHT);
		if (code === '201') {
			const f = request.fields ?? {};
			live.set(next, { id: next, title: String(f.title), from: Number(f.salary_from), to: Number(f.salary_to) });
			next += 1;
		} else if (code === '204' && request.id !== null) {
			const v = live.get(request.id);
			if (v) {
				live.delete(v.id);
				deleted.set(v.id, v.title);
			}
		} else if (code === '200' && request.method === 'PATCH' && request.id !== null) {
			const v = live.get(request.id);
			const f = request.fields ?? {};
			if (v) {
				if (typeof f.title === 'string') v.title = f.title;
				if (typeof f.salary_from === 'number') v.from = f.salary_from;
				if (typeof f.salary_to === 'number') v.to = f.salary_to;
			}
		}
	}
	return { vacancies, nextId, tokens, requests };
}

function describe(p: Params): string {
	const base = '/api/v1/vacancies';
	const lines = p.requests.map((r, i) => {
		const path = r.id === null ? base : `${base}/${r.id}`;
		const auth = r.token === null ? 'без Authorization' : `Bearer ${r.token}`;
		return `${i + 1}. ${r.method} ${path} | ${auth} | ${r.body ?? 'без тела'}`;
	});
	const roleText = (t: Token): string => (t.role === 'expired' ? 'токен истёк' : `роль ${t.role}`);
	return [
		'Тестировщик проверяет API вакансий по контракту и заранее записывает ожидаемый код ответа на каждый запрос.',
		'',
		'## Контракт',
		'',
		'Адреса и методы (других методов у адресов нет):',
		'',
		`- \`GET ${base}\` — список вакансий;`,
		`- \`POST ${base}\` — создать вакансию;`,
		`- \`GET ${base}/{id}\` — получить вакансию;`,
		`- \`PATCH ${base}/{id}\` — изменить поля вакансии;`,
		`- \`DELETE ${base}/{id}\` — удалить вакансию.`,
		'',
		'Читать (`GET`) может любая роль; создавать и изменять (`POST`, `PATCH`) — роли `editor` и `admin`; удалять — только `admin`.',
		'',
		'Тело `POST` и `PATCH` — JSON-объект с полями `title` (строка от 3 до 40 символов), `salary_from` и `salary_to` (целые числа JSON без кавычек, не меньше 0). В `POST` все три поля обязательны, других полей нет. В `PATCH` — хотя бы одно из них; поля, которых нет в теле, остаются прежними. После создания или изменения `salary_from` не больше `salary_to`. Название уникально среди существующих вакансий.',
		'',
		'Сервер проверяет запрос по порядку и отвечает кодом первой не пройденной проверки:',
		'',
		'1. у адреса нет такого метода — `405`;',
		'2. нет заголовка `Authorization` или токен истёк — `401`;',
		'3. роли токена операция не разрешена — `403`;',
		'4. для адреса с `{id}`: вакансии с таким номером нет (не было или удалена) — `404`;',
		'5. для `POST` и `PATCH`: тело не разбирается как JSON-объект — `400`;',
		'6. для `POST` и `PATCH`: поля не соответствуют правилам выше — `422`;',
		'7. для `POST` и `PATCH`: `title` совпадает с названием другой существующей вакансии — `409`.',
		'',
		`Если все проверки пройдены: \`GET\` и \`PATCH\` — \`200\`, \`POST\` — \`201\` (вакансия создана), \`DELETE\` — \`204\` (вакансия удалена). Созданные вакансии получают номера ${p.nextId}, ${p.nextId + 1}, ${p.nextId + 2} и так далее по порядку создания; номера удалённых вакансий повторно не выдаются.`,
		'',
		'## Состояние перед запросами',
		'',
		'Вакансии:',
		'',
		...p.vacancies.map((v) => `- ${v.id} — \`${v.title}\`, зарплата ${v.from}–${v.to}`),
		'',
		'Токены:',
		'',
		...p.tokens.map((t) => `- \`${t.name}\` — ${roleText(t)}`),
		'',
		'## Запросы по порядку',
		'',
		'Метод и адрес, заголовок `Authorization`, тело как оно отправлено:',
		'',
		'```',
		...lines,
		'```',
		'',
		'Введите через пробел ожидаемые коды ответов на все запросы по порядку. Например: `200 404 201`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
roles = {t["name"]: t["role"] for t in p["tokens"]}
live = {v["id"]: {"title": v["title"], "from": v["from"], "to": v["to"]} for v in p["vacancies"]}
next_id = p["nextId"]
may = {"GET": {"viewer", "editor", "admin"}, "POST": {"editor", "admin"},
       "PATCH": {"editor", "admin"}, "DELETE": {"admin"}}

def is_int(v):
    return type(v) is int and v >= 0

def fields_ok(method, f, cur):
    names = {"title", "salary_from", "salary_to"}
    if not f or not set(f) <= names:
        return False
    if method == "POST" and set(f) != names:
        return False
    if "title" in f and not (type(f["title"]) is str and 3 <= len(f["title"]) <= 40):
        return False
    for k in ("salary_from", "salary_to"):
        if k in f and not is_int(f[k]):
            return False
    lo = f.get("salary_from", cur["from"] if cur else None)
    hi = f.get("salary_to", cur["to"] if cur else None)
    return lo is None or hi is None or lo <= hi

out = []
for r in p["requests"]:
    m, vid = r["method"], r["id"]
    methods = ("GET", "POST") if vid is None else ("GET", "PATCH", "DELETE")
    role = roles.get(r["token"])
    if m not in methods:
        out.append(405); continue
    if role is None or role == "expired":
        out.append(401); continue
    if role not in may[m]:
        out.append(403); continue
    if vid is not None and vid not in live:
        out.append(404); continue
    if m in ("POST", "PATCH"):
        try:
            f = json.loads(r["body"])
        except ValueError:
            f = None
        if not isinstance(f, dict):
            out.append(400); continue
        cur = live.get(vid)
        if not fields_ok(m, f, cur):
            out.append(422); continue
        if "title" in f and any(v["title"] == f["title"] and k != vid for k, v in live.items()):
            out.append(409); continue
        if m == "POST":
            live[next_id] = {"title": f["title"], "from": f["salary_from"], "to": f["salary_to"]}
            next_id += 1
            out.append(201)
        else:
            cur.update({"title": f.get("title", cur["title"]), "from": f.get("salary_from", cur["from"]),
                        "to": f.get("salary_to", cur["to"])})
            out.append(200)
    elif m == "DELETE":
        del live[vid]
        out.append(204)
    else:
        out.append(200)
print(" ".join(str(c) for c in out))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'anon-403': { anon403: true },
	'validation-400': { validation400: true },
	'success-200': { success200: true },
	'auth-before-method': { authBeforeMethod: true },
	'existence-before-rights': { existenceBeforeRights: true },
	'body-before-existence': { bodyBeforeExistence: true },
	'conflict-before-validation': { conflictBeforeValidation: true },
	'repeat-delete-204': { repeatDelete204: true },
	'deleted-title-taken': { deletedTitleTaken: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/auth-role': ['anon-403'],
	'intern/body-validation': ['validation-400'],
	'intern/success-codes': ['success-200'],
	'intern/method-check': ['auth-before-method'],
	'junior/rights-vs-existence': ['existence-before-rights'],
	'junior/body-vs-existence': ['body-before-existence', 'conflict-before-validation'],
	'junior/stateful': ['repeat-delete-204', 'deleted-title-taken'],
	'junior/mixed': ['anon-403', 'body-before-existence']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Sequences are drawn until every misconception the class is about changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = run(p, RIGHT).join(' ');
		if (new Set(answer.split(' ')).size < 3) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = run(p, { ...RIGHT, ...change }).join(' ');
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
