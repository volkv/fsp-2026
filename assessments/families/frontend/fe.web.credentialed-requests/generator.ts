// Cookies and CORS together, as a single-page app sees them when it calls an API on another subdomain of its site
// or on another site: which `fetch` calls go with a preflight (and which reuse a cached one by
// `Access-Control-Max-Age`, keyed by the credentials flag and the allowed lists), which cookies go with the request
// under `credentials` and `SameSite`/`Domain`, whether the script gets the response, and whether a `Set-Cookie` of a
// cross-origin response is stored — also when the response fails the CORS check.
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

type SameSite = 'Strict' | 'Lax' | 'None';
type Credentials = 'omit' | 'same-origin' | 'include';

interface Cookie {
	name: string;
	/** The host for a host-only cookie, the `Domain` otherwise. */
	domain: string;
	hostOnly: boolean;
	sameSite: SameSite;
}

interface SetCookie {
	name: string;
	/** `Domain` attribute; `null` — a host-only cookie of the API host. */
	domain: string | null;
	sameSite: SameSite;
}

interface Host {
	host: string;
	/** `*` or the echoed Origin when it is listed. */
	acao: '*' | string[];
	acac: boolean;
	methods: string[];
	/** Lower-case names. */
	headers: string[];
	maxAge: number;
	/** Path → the cookie its response sets, or `null`. */
	routes: Record<string, SetCookie | null>;
}

interface Call {
	t: number;
	host: string;
	path: string;
	method: string;
	/** Author request headers, as written. */
	headers: [string, string][];
	credentials: Credentials;
}

interface Params {
	page: string;
	jar: Cookie[];
	hosts: Host[];
	calls: Call[];
}

interface Rules {
	sameOriginSendsSameSite: boolean;
	siteIsOrigin: boolean;
	laxCrossSiteSent: boolean;
	crossSiteLaxStored: boolean;
	blockedNotStored: boolean;
	omitStores: boolean;
	noPreflightCache: boolean;
	cacheIgnoresCredentials: boolean;
	cacheAnyRequest: boolean;
	cacheRequestedOnly: boolean;
	hostOnlyToSiblings: boolean;
	noAcacNeeded: boolean;
}

const RIGHT: Rules = {
	sameOriginSendsSameSite: false,
	siteIsOrigin: false,
	laxCrossSiteSent: false,
	crossSiteLaxStored: false,
	blockedNotStored: false,
	omitStores: false,
	noPreflightCache: false,
	cacheIgnoresCredentials: false,
	cacheAnyRequest: false,
	cacheRequestedOnly: false,
	hostOnlyToSiblings: false,
	noAcacNeeded: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'same-origin-sends-same-site': { sameOriginSendsSameSite: true },
	'site-is-origin': { siteIsOrigin: true },
	'lax-cross-site-sent': { laxCrossSiteSent: true },
	'cross-site-lax-stored': { crossSiteLaxStored: true },
	'blocked-not-stored': { blockedNotStored: true },
	'omit-stores': { omitStores: true },
	'no-preflight-cache': { noPreflightCache: true },
	'cache-ignores-credentials': { cacheIgnoresCredentials: true },
	'cache-any-request': { cacheAnyRequest: true },
	'cache-requested-only': { cacheRequestedOnly: true },
	'host-only-to-siblings': { hostOnlyToSiblings: true },
	'no-acac-needed': { noAcacNeeded: true }
};

const SAFE_METHODS = ['GET', 'HEAD', 'POST'];
const SAFE_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const SAFE_HEADERS = ['accept', 'accept-language', 'content-language'];

/** The registrable domain: every site of the family is a name directly under a public suffix of one label. */
const siteOf = (host: string): string => host.split('.').slice(-2).join('.');
const hostOf = (origin: string): string => new URL(origin).hostname;

interface CacheEntry {
	url: string;
	credentials: boolean;
	kind: 'method' | 'header';
	value: string;
	until: number;
}

/** Four tokens per call: `pre`/`nopre`, the cookies sent (`a,b` or `-`), `ok`/`error`, the cookie stored or `-`. */
function simulate(p: Params, rules: Rules): string {
	const jar = p.jar.map((c) => ({ ...c }));
	const cache: CacheEntry[] = [];
	const out: string[] = [];
	const pageHost = hostOf(p.page);
	for (const call of p.calls) {
		const server = p.hosts.find((h) => h.host === call.host);
		if (!server) throw new Error(`no host ${call.host}`);
		const sameSite = !rules.siteIsOrigin && siteOf(call.host) === siteOf(pageHost);
		const include =
			call.credentials === 'include' ||
			(call.credentials === 'same-origin' && rules.sameOriginSendsSameSite && siteOf(call.host) === siteOf(pageHost));
		const url = `${call.host}${call.path}`;
		const unsafe: string[] = [];
		for (const [name, value] of call.headers) {
			const lower = name.toLowerCase();
			if (lower === 'content-type') {
				if (!SAFE_TYPES.includes(value.split(';')[0]?.trim().toLowerCase() ?? '')) unsafe.push(lower);
			} else if (!SAFE_HEADERS.includes(lower)) unsafe.push(lower);
		}
		const originOk = (): boolean => {
			if (server.acao === '*') return !include;
			return server.acao.includes(p.page) && (!include || server.acac || rules.noAcacNeeded);
		};
		let pre = false;
		if (!SAFE_METHODS.includes(call.method) || unsafe.length > 0) {
			const alive = cache.filter(
				(e) =>
					!rules.noPreflightCache &&
					e.url === url &&
					call.t < e.until &&
					(e.credentials || !include || rules.cacheIgnoresCredentials)
			);
			const has = (kind: CacheEntry['kind'], value: string): boolean =>
				alive.some((e) => e.kind === kind && e.value === value);
			const hit =
				(rules.cacheAnyRequest && alive.length > 0) ||
				((SAFE_METHODS.includes(call.method) || has('method', call.method)) && unsafe.every((h) => has('header', h)));
			if (!hit) {
				pre = true;
				const passes =
					originOk() &&
					(SAFE_METHODS.includes(call.method) || server.methods.includes(call.method)) &&
					unsafe.every((h) => server.headers.includes(h));
				if (!passes) {
					out.push('pre - error -');
					continue;
				}
				const methods = rules.cacheRequestedOnly
					? SAFE_METHODS.includes(call.method)
						? []
						: [call.method]
					: server.methods;
				const headers = rules.cacheRequestedOnly ? unsafe : server.headers;
				const until = call.t + server.maxAge;
				for (const value of methods) cache.push({ url, credentials: include, kind: 'method', value, until });
				for (const value of headers) cache.push({ url, credentials: include, kind: 'header', value, until });
			}
		}
		const sent = include
			? jar
					.filter((c) => {
						const domainOk = c.hostOnly
							? call.host === c.domain || (rules.hostOnlyToSiblings && siteOf(call.host) === siteOf(c.domain))
							: call.host === c.domain || call.host.endsWith(`.${c.domain}`);
						if (!domainOk) return false;
						if (sameSite || c.sameSite === 'None') return true;
						return c.sameSite === 'Lax' && rules.laxCrossSiteSent;
					})
					.map((c) => c.name)
					.sort()
			: [];
		const ok = originOk();
		let stored = '-';
		const set = server.routes[call.path] ?? null;
		if (set && (include || rules.omitStores) && (ok || !rules.blockedNotStored)) {
			const domain = set.domain ?? call.host;
			const domainOk = call.host === domain || call.host.endsWith(`.${domain}`);
			const siteOk = sameSite || set.sameSite === 'None' || rules.crossSiteLaxStored;
			if (domainOk && siteOk) {
				const hostOnly = set.domain === null;
				const kept = jar.filter((c) => !(c.name === set.name && c.domain === domain && c.hostOnly === hostOnly));
				jar.length = 0;
				jar.push(...kept, { name: set.name, domain, hostOnly, sameSite: set.sameSite });
				stored = set.name;
			}
		}
		out.push(`${pre ? 'pre' : 'nopre'} ${sent.length ? sent.join(',') : '-'} ${ok ? 'ok' : 'error'} ${stored}`);
	}
	return out.join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const SITES = ['market.ru', 'cinema.ru', 'travel.ru', 'books.ru', 'tickets.ru'];
const PARTNERS = ['paygate.com', 'widgets.io', 'idprovider.net', 'maps-api.com'];

interface Shape {
	method: string;
	headers: [string, string][];
}

const SHAPES: Shape[] = [
	{ method: 'GET', headers: [] },
	{ method: 'POST', headers: [] },
	{ method: 'POST', headers: [['Content-Type', 'application/json']] },
	{ method: 'PUT', headers: [['Content-Type', 'application/json']] },
	{ method: 'DELETE', headers: [] },
	{ method: 'GET', headers: [['X-CSRF-Token', 'k9']] },
	{ method: 'PATCH', headers: [['Content-Type', 'application/json']] },
	{ method: 'DELETE', headers: [['X-Request-Id', 'q7']] }
];

function moments(rng: Rng, count: number, gap: [number, number]): number[] {
	const out = [0];
	while (out.length < count) out.push((out[out.length - 1] ?? 0) + rng.int(gap[0], gap[1]));
	return out;
}

function host(name: string, page: string, rng: Rng, routes: Record<string, SetCookie | null>): Host {
	return {
		host: name,
		acao: [page],
		acac: true,
		methods: rng.sample(['PUT', 'DELETE', 'PATCH'], 2),
		headers: rng.sample(['content-type', 'x-csrf-token', 'x-request-id'], 2),
		maxAge: rng.pick([60, 120, 300, 600]),
		routes
	};
}

function calls(rng: Rng, p: Omit<Params, 'calls'>, count: number, gap: [number, number], creds: Credentials[]): Call[] {
	const times = moments(rng, count, gap);
	return times.map((t) => {
		const h = rng.pick(p.hosts);
		const shape = rng.pick(SHAPES);
		return {
			t,
			host: h.host,
			path: rng.pick(Object.keys(h.routes)),
			method: shape.method,
			headers: shape.headers,
			credentials: rng.pick(creds)
		};
	});
}

function scenario(rng: Rng, classId: string): Params {
	const site = rng.pick(SITES);
	const partner = rng.pick(PARTNERS);
	const page = `https://app.${site}`;
	const count = rng.int(6, 7);
	const ss = (): SameSite => rng.pick<SameSite>(['Strict', 'Lax', 'None']);
	if (classId === 'same-site-api') {
		const jar: Cookie[] = [
			{ name: 'sid', domain: site, hostOnly: false, sameSite: rng.pick<SameSite>(['Lax', 'Strict']) },
			{ name: 'csrf', domain: site, hostOnly: false, sameSite: 'Strict' },
			{ name: 'ui', domain: `app.${site}`, hostOnly: true, sameSite: ss() }
		];
		const hosts = [
			host(`api.${site}`, page, rng, { '/v1/cart': null, '/v1/orders': null }),
			host(`auth.${site}`, page, rng, {
				'/session/refresh': { name: 'session', domain: site, sameSite: rng.pick<SameSite>(['Lax', 'Strict']) },
				'/session/hint': { name: 'hint', domain: null, sameSite: 'Lax' }
			})
		];
		const base = { page, jar, hosts };
		return { ...base, calls: calls(rng, base, count, [5, 90], ['include', 'include', 'same-origin', 'omit']) };
	}
	if (classId === 'cross-site-api') {
		const jar: Cookie[] = [
			{ name: 'sid', domain: site, hostOnly: false, sameSite: 'Lax' },
			{ name: 'pg_sid', domain: partner, hostOnly: false, sameSite: 'None' },
			{ name: 'pg_lang', domain: partner, hostOnly: false, sameSite: 'Lax' },
			{ name: 'pg_csrf', domain: `api.${partner}`, hostOnly: true, sameSite: 'Strict' }
		];
		const hosts = [
			host(`api.${partner}`, page, rng, {
				'/v2/checkout': { name: 'pg_token', domain: partner, sameSite: 'None' },
				'/v2/prefs': { name: 'pg_pref', domain: null, sameSite: rng.pick<SameSite>(['Lax', 'Strict']) },
				'/v2/status': null
			})
		];
		const base = { page, jar, hosts };
		return { ...base, calls: calls(rng, base, count, [5, 90], ['include', 'include', 'omit', 'same-origin']) };
	}
	if (classId === 'blocked-but-stored') {
		const jar: Cookie[] = [{ name: 'sid', domain: site, hostOnly: false, sameSite: 'Lax' }];
		const strict = host(`api.${site}`, page, rng, {
			'/v1/track': { name: 'visit', domain: site, sameSite: 'Lax' },
			'/v1/cart': null
		});
		const loose = host(`stats.${site}`, page, rng, {
			'/collect': { name: 'uid', domain: site, sameSite: ss() },
			'/ping': null
		});
		if (rng.bool()) loose.acao = '*';
		else loose.acac = false;
		const hosts = rng.shuffle([strict, loose]);
		const base = { page, jar, hosts };
		return { ...base, calls: calls(rng, base, count, [5, 90], ['include', 'include', 'omit']) };
	}
	// preflight-cache
	const apiHost = rng.bool() ? `api.${site}` : `api.${partner}`;
	const jar: Cookie[] = [
		{ name: 'sid', domain: siteOf(apiHost), hostOnly: false, sameSite: 'None' },
		{ name: 'pref', domain: siteOf(apiHost), hostOnly: false, sameSite: 'Lax' }
	];
	const hosts = [host(apiHost, page, rng, { '/v1/items': null })];
	const base = { page, jar, hosts };
	return { ...base, calls: calls(rng, base, rng.int(7, 8), [10, 150], ['include', 'omit']) };
}

/** No call comes exactly when a cached preflight runs out. */
function clear(p: Params): boolean {
	const times = p.calls.map((c) => c.t);
	return !p.hosts.some((h) => times.some((a) => times.includes(a + h.maxAge)));
}

// ---------------------------------------------------------------------------------------------------------------
// Statement.

function setCookieText(set: SetCookie): string {
	return `${set.name}=…; ${set.domain === null ? '' : `Domain=${set.domain}; `}Path=/; Secure; HttpOnly; SameSite=${set.sameSite}`;
}

function describe(p: Params): string {
	const jarRows = p.jar.map(
		(c) =>
			`| \`${c.name}\` | ${c.hostOnly ? `только хост \`${c.domain}\` (без Domain)` : `\`Domain=${c.domain}\``} | \`${c.sameSite}\` |`
	);
	const hostLines = p.hosts.flatMap((h) => {
		const routes = Object.entries(h.routes).map(
			([path, set]) => `- \`${path}\`: ${set ? `\`Set-Cookie: ${setCookieText(set)}\`` : 'кук не ставит'}`
		);
		return [
			`\`https://${h.host}\` отвечает (и на preflight \`OPTIONS\`) с ${
				h.acao === '*'
					? '`Access-Control-Allow-Origin: *`'
					: `\`Access-Control-Allow-Origin: ${p.page}\` для этой страницы`
			}, ${h.acac ? '`Access-Control-Allow-Credentials: true`' : 'без `Access-Control-Allow-Credentials`'}, \`Access-Control-Allow-Methods: ${h.methods.join(', ')}\`, \`Access-Control-Allow-Headers: ${h.headers.join(', ')}\`, \`Access-Control-Max-Age: ${h.maxAge}\`. Пути:`,
			'',
			...routes,
			''
		];
	});
	const code = p.calls.map((c) => {
		const init = [`credentials: '${c.credentials}'`];
		if (c.method !== 'GET') init.unshift(`method: '${c.method}'`);
		if (c.headers.length) init.push(`headers: { ${c.headers.map(([n, v]) => `'${n}': '${v}'`).join(', ')} }`);
		if (c.method !== 'GET' && c.method !== 'DELETE') init.push("body: '{}'");
		return `await call(${c.t}, 'https://${c.host}${c.path}', { ${init.join(', ')} });`;
	});
	return [
		`Одностраничное приложение открыто на \`${p.page}\`. Все куки — \`Secure\`, \`Path=/\`; в браузере уже есть:`,
		'',
		'| кука | область | SameSite |',
		'|---|---|---|',
		...jarRows,
		'',
		'Серверы API:',
		'',
		...hostLines,
		'',
		'Условия: сайт — регистрируемый домен (имя под публичным суффиксом `.ru`, `.com`, `.io`, `.net`); браузер не блокирует и не разбивает сторонние куки; предел браузера на `Max-Age` больше любого значения из условия; ответы и preflight приходят мгновенно, все — с кодом 200 или 204.',
		'',
		'`call(t, url, init)` в момент `t` (секунды от начала) делает `fetch(url, init)`; вызовы идут по очереди:',
		'',
		'```js',
		...code,
		'```',
		'',
		'Для каждого вызова по порядку введите четыре значения через пробел: `pre`, если браузер отправил preflight `OPTIONS`, иначе `nopre`; имена кук, ушедших с самим запросом, через запятую без пробелов в алфавитном порядке, или `-`; `ok`, если `fetch` выполнился, или `error`, если отклонён с `TypeError`; имя куки, которую браузер сохранил из ответа, или `-`. Если preflight не прошёл, запрос не уходит: `pre - error -`. Четвёрки всех вызовов — подряд через пробел. Например: `nopre sid ok - pre - error -`.'
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference.

const PYTHON_REFERENCE = `import json

p = json.loads(input())
page = p["page"]
page_host = page.split("://")[1]
servers = {h["host"]: h for h in p["hosts"]}
jar = {(c["name"], c["domain"], c["hostOnly"]): c["sameSite"] for c in p["jar"]}
remembered = []  # (url, with_credentials, methods, headers, until)
out = []


def site(h):
    return ".".join(h.split(".")[-2:])


def domain_match(h, d):
    return h == d or h.endswith("." + d)


for c in p["calls"]:
    s = servers[c["host"]]
    same_site = site(c["host"]) == site(page_host)
    creds = c["credentials"] == "include"
    url = c["host"] + c["path"]
    names = []
    for name, value in c["headers"]:
        n = name.lower()
        if n == "content-type":
            if value.split(";")[0].strip().lower() in ("text/plain", "multipart/form-data", "application/x-www-form-urlencoded"):
                continue
            names.append(n)
        elif n not in ("accept", "accept-language", "content-language"):
            names.append(n)
    if s["acao"] == "*":
        cors_ok = not creds
    else:
        cors_ok = page in s["acao"] and (s["acac"] or not creds)
    simple_method = c["method"] in ("GET", "HEAD", "POST")
    preflight = False
    if not simple_method or names:
        usable = [e for e in remembered if e[0] == url and c["t"] < e[4] and (e[1] or not creds)]
        covered = (simple_method or any(c["method"] in e[2] for e in usable)) and all(
            any(n in e[3] for e in usable) for n in names
        )
        if not covered:
            preflight = True
            allowed = cors_ok and (simple_method or c["method"] in s["methods"]) and all(n in s["headers"] for n in names)
            if not allowed:
                out.append("pre - error -")
                continue
            remembered.append((url, creds, list(s["methods"]), list(s["headers"]), c["t"] + s["maxAge"]))
    sent = []
    if creds:
        for (name, dom, host_only), mode in jar.items():
            hit = c["host"] == dom if host_only else domain_match(c["host"], dom)
            if hit and (same_site or mode == "None"):
                sent.append(name)
    saved = "-"
    sc = s["routes"].get(c["path"])
    if sc is not None and creds:
        dom = sc["domain"] or c["host"]
        if domain_match(c["host"], dom) and (same_site or sc["sameSite"] == "None"):
            jar[(sc["name"], dom, sc["domain"] is None)] = sc["sameSite"]
            saved = sc["name"]
    out.append(" ".join(["pre" if preflight else "nopre", ",".join(sorted(sent)) or "-", "ok" if cors_ok else "error", saved]))
print(" ".join(out))
`;

/** Per class: misconceptions of which at least `min` must apply to every instance. */
const REQUIRED: Record<string, { ids: string[]; min: number }> = {
	'same-site-api': {
		ids: ['site-is-origin', 'same-origin-sends-same-site', 'host-only-to-siblings', 'omit-stores'],
		min: 3
	},
	'cross-site-api': { ids: ['lax-cross-site-sent', 'cross-site-lax-stored', 'omit-stores'], min: 2 },
	'blocked-but-stored': { ids: ['blocked-not-stored'], min: 1 },
	'preflight-cache': {
		ids: ['no-preflight-cache', 'cache-ignores-credentials', 'cache-requested-only', 'cache-any-request'],
		min: 3
	}
};

type Draw = { p: Params; answer: string; wrong: Record<string, string | null> };

function evaluate(p: Params): Draw {
	const answer = simulate(p, RIGHT);
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = simulate(p, { ...RIGHT, ...change });
			return [id, value === answer ? null : value];
		})
	);
	return { p, answer, wrong };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[input.classId] ?? { ids: [], min: 0 };
	let chosen: Draw | undefined;
	// The draw settles within a few tries; if it never does, the last draw clear of Max-Age boundaries is kept: a
	// misconception that gives the right answer there is simply not applied to the instance.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.classId);
		if (!clear(p)) continue;
		chosen = evaluate(p);
		const errors = chosen.answer.split(' ').filter((t) => t === 'error').length;
		if (required.ids.filter((id) => chosen?.wrong[id] !== null).length >= required.min && errors < p.calls.length)
			break;
	}
	if (!chosen) {
		// Calls a prime number of seconds apart: no Max-Age of the family is a multiple of it.
		const p = scenario(rng, input.classId);
		p.calls = p.calls.map((c, i) => ({ ...c, t: i * 1009 }));
		chosen = evaluate(p);
	}
	const { p, answer, wrong } = chosen;
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

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
