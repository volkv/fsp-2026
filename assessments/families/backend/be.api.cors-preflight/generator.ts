// CORS in the browser: which cross-origin requests go out as they are and which need a preflight, whether the script
// gets the response under the server's Access-Control-* headers, credentials and `*`; a level up, the preflight cache
// by Max-Age with the browser's own limit, and a CDN that caches responses without `Vary: Origin`.
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

interface Config {
	/** `*`, or the origins the server echoes back. */
	allowOrigin: '*' | string[];
	credentials: boolean;
	methods: string[];
	/** Lower-case header names. */
	headers: string[];
	maxAge: number | null;
	vary: boolean;
}

interface Request {
	t: number;
	origin: string;
	/** The origin of the URL the request goes to. */
	target: string;
	method: string;
	path: string;
	headers: string[];
	contentType: string | null;
	credentials: boolean;
}

interface Params {
	middle: boolean;
	config: Config;
	requests: Request[];
	/** Seconds the browser keeps a preflight result at most. */
	cap: number | null;
	/** Seconds the CDN keeps a GET response; `null` — no CDN. */
	cdnTtl: number | null;
}

interface Rules {
	jsonSimple: boolean;
	blockedNotSent: boolean;
	starWithCredentials: boolean;
	safelistedListed: boolean;
	hostOnly: boolean;
	preflightCache: 'right' | 'none' | 'any';
	capped: boolean;
	varyHarmless: boolean;
}

const RIGHT: Rules = {
	jsonSimple: false,
	blockedNotSent: false,
	starWithCredentials: false,
	safelistedListed: false,
	hostOnly: false,
	preflightCache: 'right',
	capped: true,
	varyHarmless: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'json-is-simple': { jsonSimple: true },
	'blocked-not-sent': { blockedNotSent: true },
	'star-with-credentials': { starWithCredentials: true },
	'safelisted-method-listed': { safelistedListed: true },
	'host-same-origin': { hostOnly: true },
	'no-preflight-cache': { preflightCache: 'none' },
	'cache-any': { preflightCache: 'any' },
	'uncapped-max-age': { capped: false },
	'vary-harmless': { varyHarmless: true }
};

const SAFE_METHODS = ['GET', 'HEAD', 'POST'];
const SAFE_TYPES = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'];

const hostOf = (origin: string): string => new URL(origin).hostname;

/** Per request: `ok`, `blocked`, `pre+ok` or `pre+fail`; then `|` and how many requests (not OPTIONS) the server got. */
function simulate(p: Params, rules: Rules): string {
	const c = p.config;
	const preflights = new Map<string, { until: number; methods: string[]; headers: string[] }>();
	const cdn = new Map<string, { until: number; acao: string | null }>();
	const out: string[] = [];
	let served = 0;
	for (const q of p.requests) {
		const same = rules.hostOnly ? hostOf(q.origin) === hostOf(q.target) : q.origin === q.target;
		if (same) {
			served += 1;
			out.push('ok');
			continue;
		}
		const acao = c.allowOrigin === '*' ? '*' : c.allowOrigin.includes(q.origin) ? q.origin : null;
		const passes = (value: string | null): boolean =>
			value !== null &&
			(value === '*' ? !q.credentials || rules.starWithCredentials : value === q.origin) &&
			(!q.credentials || c.credentials);
		const typeSafe =
			q.contentType === null ||
			SAFE_TYPES.includes(q.contentType) ||
			(rules.jsonSimple && q.contentType === 'application/json');
		if (SAFE_METHODS.includes(q.method) && q.headers.length === 0 && typeSafe) {
			let seen = acao;
			if (p.cdnTtl !== null && q.method === 'GET') {
				const key = c.vary || rules.varyHarmless ? `${q.path}|${q.origin}` : q.path;
				const hit = cdn.get(key);
				if (hit && q.t < hit.until) seen = hit.acao;
				else {
					served += 1;
					cdn.set(key, { until: q.t + p.cdnTtl, acao });
				}
			} else served += 1;
			const ok = passes(seen);
			if (!ok && rules.blockedNotSent) served -= 1;
			out.push(ok ? 'ok' : 'blocked');
			continue;
		}
		const needed = [...q.headers, ...(typeSafe ? [] : ['content-type'])];
		const listed = !SAFE_METHODS.includes(q.method) || rules.safelistedListed;
		const key = `${q.origin}|${q.target}${q.path}`;
		const entry = preflights.get(key);
		const hit =
			rules.preflightCache !== 'none' &&
			entry !== undefined &&
			q.t < entry.until &&
			(rules.preflightCache === 'any' ||
				((!listed || entry.methods.includes(q.method)) && needed.every((h) => entry.headers.includes(h))));
		if (hit) {
			served += 1;
			out.push(passes(acao) ? 'ok' : 'blocked');
			continue;
		}
		const ok = passes(acao) && (!listed || c.methods.includes(q.method)) && needed.every((h) => c.headers.includes(h));
		if (!ok) {
			out.push('pre+fail');
			continue;
		}
		if (p.middle && c.maxAge !== null) {
			const life = rules.capped && p.cap !== null ? Math.min(c.maxAge, p.cap) : c.maxAge;
			preflights.set(key, { until: q.t + life, methods: c.methods, headers: c.headers });
		}
		served += 1;
		out.push('pre+ok');
	}
	return [...out, '|', String(served)].join(' ');
}

const SITES = ['shop', 'market', 'books', 'travel', 'cinema', 'garden'] as const;
const PATHS = ['/v1/cart', '/v1/orders', '/v1/profile', '/v1/catalog', '/v1/reviews'] as const;

interface Shape {
	method: string;
	headers: string[];
	contentType: string | null;
}

const SIMPLE: Shape[] = [
	{ method: 'GET', headers: [], contentType: null },
	{ method: 'POST', headers: [], contentType: 'text/plain' },
	{ method: 'POST', headers: [], contentType: 'application/x-www-form-urlencoded' }
];
const COMPLEX: Shape[] = [
	{ method: 'POST', headers: [], contentType: 'application/json' },
	{ method: 'PUT', headers: [], contentType: 'application/json' },
	{ method: 'DELETE', headers: [], contentType: null },
	{ method: 'GET', headers: ['x-request-id'], contentType: null },
	{ method: 'GET', headers: ['authorization'], contentType: null },
	{ method: 'PATCH', headers: ['x-request-id'], contentType: 'application/json' },
	{ method: 'POST', headers: ['authorization'], contentType: 'text/plain' }
];

function scenario(rng: Rng, grade: string, classId: string): Params {
	const site = rng.pick(SITES);
	const api = `https://api.${site}.ru`;
	const pages = [
		`https://app.${site}.ru`,
		`https://admin.${site}.ru`,
		`https://${rng.pick(['partner', 'promo'])}.example.com`
	];
	const middle = grade === 'middle';
	const config: Config = {
		allowOrigin: rng.bool(0.3) ? '*' : rng.sample(pages, 2),
		credentials: rng.bool(),
		methods: rng.sample(['PUT', 'DELETE', 'PATCH', 'GET'], rng.int(1, 3)),
		headers: rng.sample(['content-type', 'x-request-id', 'authorization'], rng.int(1, 2)),
		maxAge: null,
		vary: false
	};
	let cap: number | null = null;
	let cdnTtl: number | null = null;
	const count = middle ? rng.int(6, 9) : rng.int(5, 7);
	let pool: Shape[] = [...SIMPLE, ...COMPLEX];
	let credentialRate = 0.25;
	const targets = [api];
	let origins = pages;
	if (classId === 'credentials') {
		config.allowOrigin = rng.bool(0.6) ? '*' : rng.sample(pages, 2);
		credentialRate = 0.6;
	} else if (classId === 'allow-lists') {
		pool = [...COMPLEX, SIMPLE[0] as Shape];
		config.methods = rng.sample(['PUT', 'DELETE', 'PATCH'], rng.int(1, 2));
		config.allowOrigin = rng.sample(pages, 2);
	} else if (classId === 'same-origin') {
		const page = `https://${site}.ru`;
		origins = [page];
		targets.length = 0;
		targets.push(page, `https://${site}.ru:8443`, `http://${site}.ru`, api);
		config.allowOrigin = rng.bool() ? '*' : [page];
	} else if (classId === 'vary-origin') {
		pool = [SIMPLE[0] as Shape];
		config.allowOrigin = rng.sample(pages, 2);
		cdnTtl = rng.pick([30, 60, 120]);
		credentialRate = 0;
	}
	if (middle && classId !== 'vary-origin') {
		cap = rng.pick([300, 600]);
		config.maxAge = classId === 'max-age-cap' ? rng.pick([3600, 7200, 86400]) : rng.pick([30, 60, 90, 120]);
		pool = rng.bool(0.7) ? COMPLEX : [...COMPLEX, ...SIMPLE];
	}
	const span = classId === 'max-age-cap' ? (cap ?? 600) * 3 : 240;
	const times = rng
		.sample(
			Array.from({ length: span }, (_, i) => i + 1),
			count
		)
		.sort((a, b) => a - b);
	// Repeats of the same request shape make the caches matter on the middle level.
	const shapes = rng.sample(pool, Math.min(pool.length, middle ? 3 : count));
	const requests: Request[] = times.map((t) => {
		const shape = rng.pick(shapes);
		return {
			t: middle ? t : 0,
			origin: rng.pick(middle ? origins.slice(0, 2) : origins),
			target: rng.pick(targets),
			method: shape.method,
			path: rng.pick(middle ? PATHS.slice(0, 2) : PATHS),
			headers: shape.headers,
			contentType: shape.contentType,
			credentials: rng.bool(credentialRate)
		};
	});
	return { middle, config, requests, cap, cdnTtl };
}

function describe(p: Params): string {
	const c = p.config;
	const allow =
		c.allowOrigin === '*'
			? '`Access-Control-Allow-Origin: *`'
			: `\`Access-Control-Allow-Origin: <Origin запроса>\`, если Origin — ${c.allowOrigin.map((o) => `\`${o}\``).join(' или ')}; для других источников заголовка нет`;
	const server = [
		`- ${allow};`,
		`- \`Access-Control-Allow-Methods: ${c.methods.join(', ')}\`;`,
		`- \`Access-Control-Allow-Headers: ${c.headers.join(', ')}\`;`,
		c.credentials
			? '- `Access-Control-Allow-Credentials: true`;'
			: '- заголовка `Access-Control-Allow-Credentials` нет;',
		...(c.maxAge !== null ? [`- на OPTIONS — \`Access-Control-Max-Age: ${c.maxAge}\`;`] : []),
		...(p.cdnTtl !== null ? [c.vary ? '- `Vary: Origin`.' : '- заголовка `Vary` нет.'] : [])
	];
	const rules = [
		'- Запрос на тот же источник (совпадают схема, хост и порт) идёт без CORS, ответ доступен скрипту.',
		'- Простой запрос — метод GET, HEAD или POST, без своих заголовков, а `Content-Type`, если есть, — `text/plain`, `application/x-www-form-urlencoded` или `multipart/form-data`. Он уходит на сервер сразу; скрипт получает ответ, только если ответ проходит проверку CORS.',
		'- Любой другой cross-origin запрос сначала идёт preflight-запросом `OPTIONS`. Preflight проходит, если ответ на него проходит проверку CORS, метод — GET, HEAD, POST или есть в `Access-Control-Allow-Methods`, и каждый свой заголовок запроса (и `content-type` с другим значением) есть в `Access-Control-Allow-Headers`. Только тогда уходит сам запрос; если preflight не прошёл, запрос не отправляется.',
		'- Проверка CORS: `Access-Control-Allow-Origin` равен Origin запроса или `*`; для запроса с credentials `*` не подходит, и нужен `Access-Control-Allow-Credentials: true`.'
	];
	if (p.middle && c.maxAge !== null) {
		rules.push(
			`- Браузер запоминает прошедший preflight для пары «источник страницы — адрес запроса» на \`Max-Age\` секунд, но не дольше ${p.cap} с. Пока запись жива, запрос, чей метод и заголовки покрыты запомненными списками, уходит без нового OPTIONS; иначе — новый preflight. Не прошедший preflight не запоминается.`
		);
	}
	if (p.cdnTtl !== null) {
		rules.push(
			`- Между браузерами и сервером стоит CDN: ответ на GET он хранит ${p.cdnTtl} с со всеми заголовками и отдаёт сам, не обращаясь к серверу. Ключ записи — путь, а если в ответе \`Vary: Origin\` — путь и Origin.`
		);
	}
	const head = p.middle
		? '| # | момент | страница (Origin) | запрос | заголовки | credentials |\n|---|---|---|---|---|---|'
		: '| # | страница (Origin) | запрос | заголовки | credentials |\n|---|---|---|---|---|';
	const rows = p.requests.map((q, i) => {
		const headers = [
			...(q.contentType ? [`Content-Type: ${q.contentType}`] : []),
			...q.headers.map((h) => (h === 'x-request-id' ? 'X-Request-Id' : 'Authorization'))
		];
		const cells = [
			String(i + 1),
			...(p.middle ? [String(q.t)] : []),
			`\`${q.origin}\``,
			`\`${q.method} ${q.target}${q.path}\``,
			headers.length ? headers.map((h) => `\`${h}\``).join(', ') : '—',
			q.credentials ? 'include' : 'omit'
		];
		return `| ${cells.join(' | ')} |`;
	});
	return [
		'Сервер API отвечает на любой запрос, включая `OPTIONS`, с заголовками:',
		'',
		...server,
		'',
		'Правила браузера:',
		'',
		...rules,
		'',
		`Скрипты на страницах делают запросы через \`fetch\`${p.middle ? ' (момент — в секундах)' : ''}:`,
		'',
		head,
		...rows,
		'',
		`Введите через пробел исход каждого запроса по порядку: \`ok\` или \`blocked\` — запрос ушёл без preflight, и скрипт получил ответ или нет; \`pre+ok\` — был preflight, он прошёл, и скрипт получил ответ; \`pre+fail\` — preflight не прошёл. Затем знак \`|\` и число запросов, кроме OPTIONS, дошедших до сервера API${p.cdnTtl !== null ? ' (ответы CDN без обращения к серверу не считаются)' : ''}. Например: \`ok pre+fail blocked | 2\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
c = p["config"]
simple_types = ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data")
remembered = {}
edge = {}
result = []
count = 0


def allowed_origin(origin):
    if c["allowOrigin"] == "*":
        return "*"
    return origin if origin in c["allowOrigin"] else None


def cors_ok(header, q):
    if header is None:
        return False
    if q["credentials"]:
        return header == q["origin"] and c["credentials"]
    return header in ("*", q["origin"])


for q in p["requests"]:
    if q["origin"] == q["target"]:
        count += 1
        result.append("ok")
        continue
    plain_type = q["contentType"] is None or q["contentType"] in simple_types
    if q["method"] in ("GET", "HEAD", "POST") and not q["headers"] and plain_type:
        header = allowed_origin(q["origin"])
        if p["cdnTtl"] is not None and q["method"] == "GET":
            key = (q["path"], q["origin"]) if c["vary"] else q["path"]
            cached = edge.get(key)
            if cached is not None and q["t"] < cached[0]:
                header = cached[1]
            else:
                count += 1
                edge[key] = (q["t"] + p["cdnTtl"], header)
        else:
            count += 1
        result.append("ok" if cors_ok(header, q) else "blocked")
        continue
    asks = list(q["headers"]) + ([] if plain_type else ["content-type"])
    must_list = q["method"] not in ("GET", "HEAD", "POST")
    key = (q["origin"], q["target"] + q["path"])
    memo = remembered.get(key)
    if memo is not None and q["t"] < memo[0] and (not must_list or q["method"] in memo[1]) and all(h in memo[2] for h in asks):
        count += 1
        result.append("ok" if cors_ok(allowed_origin(q["origin"]), q) else "blocked")
        continue
    good = cors_ok(allowed_origin(q["origin"]), q)
    good = good and (not must_list or q["method"] in c["methods"]) and all(h in c["headers"] for h in asks)
    if not good:
        result.append("pre+fail")
        continue
    if p["middle"] and c["maxAge"] is not None:
        remembered[key] = (q["t"] + min(c["maxAge"], p["cap"]), c["methods"], c["headers"])
    count += 1
    result.append("pre+ok")
print(" ".join(result), "|", count)
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/simple-vs-preflight': ['json-is-simple', 'blocked-not-sent'],
	'junior/credentials': ['star-with-credentials'],
	'junior/allow-lists': ['safelisted-method-listed'],
	'junior/same-origin': ['host-same-origin'],
	'middle/preflight-cache': ['no-preflight-cache', 'cache-any'],
	'middle/vary-origin': ['vary-harmless'],
	'middle/credentials': ['star-with-credentials', 'no-preflight-cache'],
	'middle/max-age-cap': ['uncapped-max-age']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		// No request falls exactly when a remembered preflight or a CDN entry runs out.
		if (!clear(p)) continue;
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 1000 tries`);
}

function clear(p: Params): boolean {
	if (!p.middle) return true;
	const times = p.requests.map((q) => q.t);
	const spans = [p.cdnTtl, p.config.maxAge, p.cap].filter((x): x is number => x !== null);
	return !times.some((a) => spans.some((s) => times.includes(a + s)));
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
