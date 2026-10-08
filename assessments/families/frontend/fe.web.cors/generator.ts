// CORS as a script on the page sees it (Fetch Standard): which `fetch` calls go with a preflight, whether the call
// resolves or rejects with `TypeError`, which status and which response headers the script reads — safelisted
// request headers and the `Content-Type` a body brings, credentials against `*` and `Access-Control-Allow-Credentials`,
// `Access-Control-Expose-Headers`, `mode: 'no-cors'`; a level up, wildcards under credentials, `Authorization` against
// `Access-Control-Allow-Headers: *`, a preflight answered with an error status and error responses without CORS headers.
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

type Body = 'none' | 'json-string' | 'form-data' | 'url-params';
type Credentials = 'omit' | 'same-origin' | 'include' | null;

interface Server {
	/** `*`, `echo` — the Origin of the request when it is in `allowed`, or `null` — no CORS headers at all. */
	acao: '*' | 'echo' | null;
	allowed: string[];
	acac: boolean;
	/** Tokens of `Access-Control-Allow-Methods`, `*` included as written. */
	methods: string[];
	/** Lower-case tokens of `Access-Control-Allow-Headers`. */
	headers: string[];
	/** Lower-case tokens of `Access-Control-Expose-Headers`. */
	expose: string[];
}

interface Route {
	path: string;
	status: number;
	/** Response headers besides the CORS ones: lower-case name → value. */
	headers: Record<string, string>;
	/** Whether the response to the request itself carries the CORS headers. */
	cors: boolean;
	/** Status of the answer to OPTIONS; it always carries the CORS headers. */
	optionsStatus: number;
}

interface Call {
	page: string;
	route: string;
	method: string;
	/** Author request headers: [name as written, value]. */
	headers: [string, string][];
	body: Body;
	credentials: Credentials;
	mode: 'cors' | 'no-cors';
	/** The response header the script reads. */
	read: string;
}

interface Params {
	api: string;
	server: Server;
	routes: Route[];
	calls: Call[];
}

interface Rules {
	jsonStringIsJson: boolean;
	anyHeaderPreflight: boolean;
	postPreflight: boolean;
	listsNotChecked: boolean;
	starWithCredentials: boolean;
	noAcacNeeded: boolean;
	defaultIsInclude: boolean;
	allHeadersVisible: boolean;
	onlyExposedVisible: boolean;
	errorStatusRejects: boolean;
	noCorsReadable: boolean;
	noCorsError: boolean;
	noCorsAnyMethod: boolean;
	wildcardWithCredentials: boolean;
	wildcardNever: boolean;
	starCoversAuthorization: boolean;
	preflightStatusIgnored: boolean;
	statusWithoutCors: boolean;
}

const RIGHT: Rules = {
	jsonStringIsJson: false,
	anyHeaderPreflight: false,
	postPreflight: false,
	listsNotChecked: false,
	starWithCredentials: false,
	noAcacNeeded: false,
	defaultIsInclude: false,
	allHeadersVisible: false,
	onlyExposedVisible: false,
	errorStatusRejects: false,
	noCorsReadable: false,
	noCorsError: false,
	noCorsAnyMethod: false,
	wildcardWithCredentials: false,
	wildcardNever: false,
	starCoversAuthorization: false,
	preflightStatusIgnored: false,
	statusWithoutCors: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'json-string-preflight': { jsonStringIsJson: true },
	'safelisted-header-preflight': { anyHeaderPreflight: true },
	'post-preflight': { postPreflight: true },
	'lists-not-checked': { listsNotChecked: true },
	'star-with-credentials': { starWithCredentials: true },
	'no-acac-needed': { noAcacNeeded: true },
	'default-is-include': { defaultIsInclude: true },
	'all-headers-visible': { allHeadersVisible: true },
	'only-exposed-visible': { onlyExposedVisible: true },
	'error-status-rejects': { errorStatusRejects: true },
	'no-cors-readable': { noCorsReadable: true },
	'no-cors-error': { noCorsError: true },
	'no-cors-any-method': { noCorsAnyMethod: true },
	'wildcard-with-credentials': { wildcardWithCredentials: true },
	'wildcard-never': { wildcardNever: true },
	'star-covers-authorization': { starCoversAuthorization: true },
	'preflight-status-ignored': { preflightStatusIgnored: true },
	'status-without-cors': { statusWithoutCors: true }
};

const SAFE_METHODS = ['GET', 'HEAD', 'POST'];
const SAFE_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const SAFE_REQUEST_HEADERS = ['accept', 'accept-language', 'content-language'];
const SAFE_RESPONSE_HEADERS = [
	'cache-control',
	'content-language',
	'content-type',
	'expires',
	'last-modified',
	'pragma'
];

/** The `Content-Type` a body brings by itself. */
const BODY_TYPE: Record<Body, string | null> = {
	none: null,
	'json-string': 'text/plain;charset=UTF-8',
	'form-data': 'multipart/form-data',
	'url-params': 'application/x-www-form-urlencoded;charset=UTF-8'
};

const ok = (status: number): boolean => status >= 200 && status <= 299;

/** Three tokens per call: `pre`/`nopre`, `error` or the status, the header value, `null` or `-`. */
function outcome(p: Params, call: Call, rules: Rules): string {
	const s = p.server;
	const route = p.routes.find((r) => r.path === call.route);
	if (!route) throw new Error(`no route ${call.route}`);
	const failed = (pre: boolean): string => `${pre ? 'pre' : 'nopre'} error -`;
	const valueOf = (): string => route.headers[call.read.toLowerCase()] ?? 'null';
	if (call.mode === 'no-cors') {
		if (!SAFE_METHODS.includes(call.method) && !rules.noCorsAnyMethod) return failed(false);
		if (rules.noCorsReadable) return `nopre ${route.status} ${valueOf()}`;
		if (rules.noCorsError && s.acao === null) return failed(false);
		return 'nopre 0 null';
	}
	const include = call.credentials === 'include' || (call.credentials === null && rules.defaultIsInclude);
	const wildcard = (list: readonly string[]): boolean =>
		!rules.wildcardNever && list.includes('*') && (!include || rules.wildcardWithCredentials);
	const corsCheck = (): boolean => {
		if (s.acao === null) return false;
		if (s.acao === '*') return !include || rules.starWithCredentials;
		if (!s.allowed.includes(call.page)) return false;
		return !include || s.acac || rules.noAcacNeeded;
	};
	// Request headers the preflight must cover.
	const unsafe: string[] = [];
	let explicitType = false;
	for (const [name, value] of call.headers) {
		const lower = name.toLowerCase();
		if (lower === 'content-type') {
			explicitType = true;
			const essence = value.split(';')[0]?.trim().toLowerCase() ?? '';
			if (!SAFE_TYPES.includes(essence) || rules.anyHeaderPreflight) unsafe.push(lower);
		} else if (!SAFE_REQUEST_HEADERS.includes(lower) || rules.anyHeaderPreflight) unsafe.push(lower);
	}
	if (!explicitType) {
		// The body sets Content-Type by itself; the misconception takes a JSON string for application/json.
		const bodyType = call.body === 'json-string' && rules.jsonStringIsJson ? 'application/json' : BODY_TYPE[call.body];
		const essence = bodyType?.split(';')[0]?.trim() ?? null;
		if (essence !== null && !SAFE_TYPES.includes(essence)) unsafe.push('content-type');
	}
	const pre =
		!SAFE_METHODS.includes(call.method) || unsafe.length > 0 || (rules.postPreflight && call.method === 'POST');
	if (pre) {
		if (!ok(route.optionsStatus) && !rules.preflightStatusIgnored) return failed(true);
		if (!corsCheck()) return failed(true);
		if (!rules.listsNotChecked) {
			const methodOk = SAFE_METHODS.includes(call.method) || s.methods.includes(call.method) || wildcard(s.methods);
			const headersOk = unsafe.every(
				(h) =>
					s.headers.includes(h) || (wildcard(s.headers) && (h !== 'authorization' || rules.starCoversAuthorization))
			);
			if (!methodOk || !headersOk) return failed(true);
		}
	}
	const tag = pre ? 'pre' : 'nopre';
	if (!route.cors) return rules.statusWithoutCors ? `${tag} ${route.status} null` : failed(pre);
	if (!corsCheck()) return failed(pre);
	if (!ok(route.status) && rules.errorStatusRejects) return failed(pre);
	const name = call.read.toLowerCase();
	const visible =
		rules.allHeadersVisible ||
		(SAFE_RESPONSE_HEADERS.includes(name) && !rules.onlyExposedVisible) ||
		s.expose.includes(name) ||
		wildcard(s.expose);
	return `${tag} ${route.status} ${visible ? valueOf() : 'null'}`;
}

function simulate(p: Params, rules: Rules): string {
	return p.calls.map((call) => outcome(p, call, rules)).join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const SITES = ['market.ru', 'cinema.ru', 'travel.ru', 'books.ru', 'tickets.ru', 'garden.ru'];
const PATHS = ['/v1/items', '/v1/orders', '/v1/profile', '/v1/cart', '/v1/reviews', '/v1/upload'];
const CUSTOM_HEADERS = ['x-total-count', 'x-request-id', 'etag', 'x-rate-limit-remaining'];

function customValue(rng: Rng, name: string): string {
	if (name === 'x-total-count') return String(rng.int(11, 99));
	if (name === 'x-request-id') return `r-${rng.int(100, 999)}`;
	if (name === 'etag') return `"v${rng.int(2, 40)}"`;
	return String(rng.int(1, 60));
}

function makeRoute(rng: Rng, path: string, status: number): Route {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	for (const name of rng.sample(CUSTOM_HEADERS, rng.int(2, 3))) headers[name] = customValue(rng, name);
	if (rng.bool(0.6)) headers['cache-control'] = rng.pick(['no-store', 'max-age=60', 'no-cache']);
	if (rng.bool(0.4)) headers['content-language'] = rng.pick(['ru', 'en']);
	return { path, status, headers, cors: true, optionsStatus: 204 };
}

/** A header of the route the script reads: a safelisted one with the given share, otherwise a custom one. */
function readOf(rng: Rng, route: Route, safelistedShare: number): string {
	const names = Object.keys(route.headers);
	const safe = names.filter((n) => SAFE_RESPONSE_HEADERS.includes(n));
	const custom = names.filter((n) => !SAFE_RESPONSE_HEADERS.includes(n));
	const pool = rng.bool(safelistedShare) ? safe : custom;
	return display(rng.pick(pool.length ? pool : names));
}

function display(name: string): string {
	if (name === 'etag') return 'ETag';
	return name
		.split('-')
		.map((part) => (part === 'id' ? 'Id' : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`))
		.join('-');
}

interface Shape {
	method: string;
	headers: [string, string][];
	body: Body;
}

const SIMPLE_SHAPES: Shape[] = [
	{ method: 'GET', headers: [], body: 'none' },
	{ method: 'GET', headers: [['Accept', 'application/json']], body: 'none' },
	{ method: 'GET', headers: [['Content-Language', 'ru']], body: 'none' },
	{ method: 'POST', headers: [], body: 'json-string' },
	{ method: 'POST', headers: [], body: 'form-data' },
	{ method: 'POST', headers: [], body: 'url-params' },
	{ method: 'POST', headers: [['Content-Type', 'text/plain;charset=UTF-8']], body: 'json-string' }
];

const PREFLIGHT_SHAPES: Shape[] = [
	{ method: 'POST', headers: [['Content-Type', 'application/json']], body: 'json-string' },
	{ method: 'PUT', headers: [['Content-Type', 'application/json']], body: 'json-string' },
	{ method: 'DELETE', headers: [], body: 'none' },
	{ method: 'PATCH', headers: [['Content-Type', 'application/json']], body: 'json-string' },
	{ method: 'GET', headers: [['X-Request-Id', 'q-17']], body: 'none' },
	{ method: 'GET', headers: [['Authorization', 'Bearer t0k3n']], body: 'none' },
	{ method: 'POST', headers: [['X-Request-Id', 'q-42']], body: 'form-data' }
];

function base(rng: Rng): { site: string; page: string; api: string; paths: string[] } {
	const site = rng.pick(SITES);
	return { site, page: `https://app.${site}`, api: `https://api.${site}`, paths: rng.sample(PATHS, 3) };
}

function call(page: string, route: Route, shape: Shape, credentials: Credentials, read: string): Call {
	return { page, route: route.path, ...shape, credentials, mode: 'cors', read };
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const { site, page, api, paths } = base(rng);
	const server: Server = { acao: 'echo', allowed: [page], acac: false, methods: [], headers: [], expose: [] };
	const routes: Route[] = [];
	const calls: Call[] = [];
	const count = grade === 'junior' ? rng.int(5, 6) : rng.int(6, 7);
	const creds = (): Credentials => rng.pick<Credentials>([null, 'omit', 'same-origin', 'include']);
	if (grade === 'junior' && classId === 'preflight-trigger') {
		server.methods = rng.sample(['PUT', 'DELETE', 'PATCH'], rng.int(1, 2));
		server.headers = rng.sample(['content-type', 'x-request-id', 'authorization'], rng.int(1, 2));
		for (const path of paths) routes.push(makeRoute(rng, path, rng.pick([200, 201])));
		const shapes = [...rng.sample(SIMPLE_SHAPES, 3), ...rng.sample(PREFLIGHT_SHAPES, 3)];
		for (const shape of rng.shuffle(shapes).slice(0, count)) {
			const route = rng.pick(routes);
			calls.push(call(page, route, shape, rng.pick<Credentials>([null, 'omit']), readOf(rng, route, 0.8)));
		}
	} else if (grade === 'junior' && classId === 'credentials') {
		// `*` with or without Allow-Credentials, or the echoed Origin without it: credentials decide either way.
		server.acao = rng.bool() ? '*' : 'echo';
		server.acac = server.acao === '*' && rng.bool();
		const admin = `https://admin.${site}`;
		server.allowed = rng.bool() ? [page] : [page, admin];
		for (const path of paths) routes.push(makeRoute(rng, path, 200));
		const modes = rng.shuffle<Credentials>([
			'include',
			'include',
			null,
			...Array.from({ length: count - 3 }, () => rng.pick<Credentials>([null, 'omit', 'same-origin', 'include']))
		]);
		for (const credentials of modes) {
			const route = rng.pick(routes);
			const shape = rng.pick(SIMPLE_SHAPES);
			calls.push(call(rng.bool(0.75) ? page : admin, route, shape, credentials, readOf(rng, route, 0.9)));
		}
	} else if (grade === 'junior' && classId === 'exposed-headers') {
		server.acac = true;
		server.methods = ['PUT', 'DELETE'];
		server.headers = ['content-type'];
		const statuses = rng.shuffle([200, rng.pick([404, 409, 422]), rng.pick([500, 503])]);
		paths.forEach((path, i) => routes.push(makeRoute(rng, path, statuses[i] ?? 200)));
		const customs = [...new Set(routes.flatMap((r) => Object.keys(r.headers)))].filter(
			(n) => !SAFE_RESPONSE_HEADERS.includes(n)
		);
		server.expose = rng.sample(customs, Math.min(customs.length, rng.int(1, 2)));
		for (let i = 0; i < count; i += 1) {
			const route = rng.pick(routes);
			const shape = rng.bool(0.7) ? rng.pick(SIMPLE_SHAPES) : (PREFLIGHT_SHAPES[rng.int(0, 2)] as Shape);
			calls.push(call(page, route, shape, creds(), readOf(rng, route, 0.4)));
		}
	} else if (grade === 'junior') {
		// no-cors
		server.acao = rng.bool(0.6) ? null : 'echo';
		server.methods = ['PUT', 'DELETE'];
		server.headers = ['content-type'];
		for (const path of paths) routes.push(makeRoute(rng, path, rng.pick([200, 200, 201, 404])));
		for (let i = 0; i < count; i += 1) {
			const route = rng.pick(routes);
			const noCors = rng.bool(0.65);
			const shape = noCors
				? rng.pick<Shape>([
						...SIMPLE_SHAPES.slice(0, 1),
						...SIMPLE_SHAPES.slice(3, 6),
						PREFLIGHT_SHAPES[2] as Shape,
						{ method: 'PUT', headers: [], body: 'json-string' }
					])
				: rng.pick(SIMPLE_SHAPES);
			calls.push({
				...call(page, route, shape, rng.pick<Credentials>([null, 'include']), readOf(rng, route, 0.6)),
				mode: noCors ? 'no-cors' : 'cors'
			});
		}
	} else if (classId === 'credentialed-wildcards') {
		server.acac = true;
		server.methods = rng.bool() ? ['*'] : ['*', rng.pick(['PUT', 'DELETE'])];
		server.headers = rng.bool() ? ['*'] : ['*', 'content-type'];
		server.expose = ['*'];
		for (const path of paths) routes.push(makeRoute(rng, path, rng.pick([200, 200, 201, 404])));
		for (let i = 0; i < count; i += 1) {
			const route = rng.pick(routes);
			const shape = rng.bool(0.65) ? (PREFLIGHT_SHAPES[rng.int(0, 4)] as Shape) : rng.pick(SIMPLE_SHAPES);
			calls.push(
				call(page, route, shape, rng.pick<Credentials>(['include', 'include', null, 'omit']), readOf(rng, route, 0.3))
			);
		}
	} else if (classId === 'authorization-star') {
		server.acao = rng.bool() ? '*' : 'echo';
		server.methods = rng.bool() ? ['*'] : rng.sample(['PUT', 'DELETE', 'PATCH'], 2);
		server.headers = rng.bool(0.75) ? ['*'] : ['*', 'authorization'];
		server.expose = rng.bool() ? ['*'] : [rng.pick(CUSTOM_HEADERS)];
		for (const path of paths) routes.push(makeRoute(rng, path, rng.pick([200, 201])));
		const authShapes: Shape[] = [
			{ method: 'GET', headers: [['Authorization', 'Bearer t0k3n']], body: 'none' },
			{ method: 'DELETE', headers: [['Authorization', 'Bearer t0k3n']], body: 'none' },
			{
				method: 'PUT',
				headers: [
					['Content-Type', 'application/json'],
					['X-Request-Id', 'q-5']
				],
				body: 'json-string'
			},
			{ method: 'GET', headers: [['X-Request-Id', 'q-17']], body: 'none' },
			{
				method: 'POST',
				headers: [
					['Authorization', 'Basic YTpi'],
					['Content-Type', 'application/json']
				],
				body: 'json-string'
			},
			{ method: 'PATCH', headers: [['Content-Type', 'application/json']], body: 'json-string' }
		];
		for (let i = 0; i < count; i += 1) {
			const route = rng.pick(routes);
			const shape = rng.bool(0.8) ? rng.pick(authShapes) : rng.pick(SIMPLE_SHAPES);
			calls.push(
				call(page, route, shape, rng.pick<Credentials>([null, 'omit', 'same-origin']), readOf(rng, route, 0.3))
			);
		}
	} else if (classId === 'preflight-status') {
		server.acac = rng.bool();
		server.methods = ['PUT', 'DELETE', 'PATCH'];
		server.headers = ['content-type', 'x-request-id', 'authorization'];
		server.expose = rng.sample(CUSTOM_HEADERS, 2);
		const statuses = rng.shuffle([rng.pick([200, 201]), rng.pick([404, 409]), rng.pick([500, 503])]);
		const options = rng.shuffle([204, rng.pick([200, 204]), rng.pick([404, 405])]);
		paths.forEach((path, i) =>
			routes.push({ ...makeRoute(rng, path, statuses[i] ?? 200), optionsStatus: options[i] ?? 204 })
		);
		for (let i = 0; i < count; i += 1) {
			const route = rng.pick(routes);
			const shape = rng.bool(0.6) ? rng.pick(PREFLIGHT_SHAPES) : rng.pick(SIMPLE_SHAPES);
			calls.push(call(page, route, shape, rng.pick<Credentials>([null, 'include']), readOf(rng, route, 0.4)));
		}
	} else {
		// error-handler
		server.acac = true;
		server.methods = ['PUT', 'DELETE', 'PATCH'];
		server.headers = ['content-type', 'x-request-id', 'authorization'];
		server.expose = rng.sample(CUSTOM_HEADERS, 2);
		const kinds = rng.shuffle([
			{ status: rng.pick([200, 201]), cors: true },
			{ status: rng.pick([404, 422]), cors: true },
			{ status: rng.pick([500, 502]), cors: false },
			{ status: 401, cors: rng.bool() }
		]);
		const fourth = PATHS.find((x) => !paths.includes(x)) ?? '/v1/admin';
		[...paths, fourth].forEach((path, i) => {
			const kind = kinds[i] ?? { status: 200, cors: true };
			routes.push({ ...makeRoute(rng, path, kind.status), cors: kind.cors });
		});
		for (let i = 0; i < count; i += 1) {
			const route = rng.pick(routes);
			const shape = rng.bool(0.5) ? (PREFLIGHT_SHAPES[rng.int(0, 5)] as Shape) : rng.pick(SIMPLE_SHAPES);
			calls.push(call(page, route, shape, rng.pick<Credentials>([null, 'include']), readOf(rng, route, 0.5)));
		}
	}
	return { api, server, routes, calls };
}

// ---------------------------------------------------------------------------------------------------------------
// Statement.

const BODY_CODE: Record<Body, string> = {
	none: '',
	'json-string': 'body: JSON.stringify(data)',
	'form-data': 'body: new FormData(form)',
	'url-params': "body: new URLSearchParams({ q: 'books' })"
};

function callCode(p: Params, c: Call, i: number, pages: boolean): string {
	const init: string[] = [];
	if (c.method !== 'GET') init.push(`method: '${c.method}'`);
	if (c.mode === 'no-cors') init.push("mode: 'no-cors'");
	if (c.credentials !== null) init.push(`credentials: '${c.credentials}'`);
	if (c.headers.length) init.push(`headers: { ${c.headers.map(([n, v]) => `'${n}': '${v}'`).join(', ')} }`);
	if (c.body !== 'none') init.push(BODY_CODE[c.body]);
	const args = `'${p.api}${c.route}'${init.length ? `, { ${init.join(', ')} }` : ''}`;
	return [
		`// ${i + 1}${pages ? ` — страница ${c.page}` : ''}`,
		`r = await fetch(${args});`,
		`console.log(r.status, r.headers.get('${c.read}'));`
	].join('\n');
}

function describe(p: Params): string {
	const s = p.server;
	const withOptions = p.routes.some((r) => r.optionsStatus !== 204);
	const withCors = p.routes.some((r) => !r.cors);
	const serverLines: string[] = [];
	if (s.acao !== null) {
		serverLines.push(
			s.acao === '*'
				? '- `Access-Control-Allow-Origin: *`;'
				: `- \`Access-Control-Allow-Origin: <Origin запроса>\`, если Origin — ${s.allowed.map((o) => `\`${o}\``).join(' или ')}; для других источников этого заголовка нет;`,
			s.acac ? '- `Access-Control-Allow-Credentials: true`;' : '- заголовка `Access-Control-Allow-Credentials` нет;'
		);
		if (s.methods.length) serverLines.push(`- \`Access-Control-Allow-Methods: ${s.methods.join(', ')}\`;`);
		if (s.headers.length) serverLines.push(`- \`Access-Control-Allow-Headers: ${s.headers.join(', ')}\`;`);
		serverLines.push('- `Access-Control-Max-Age: 0`;');
		serverLines.push(
			s.expose.length
				? `- \`Access-Control-Expose-Headers: ${s.expose.map((h) => (h === '*' ? '*' : display(h))).join(', ')}\`.`
				: '- заголовка `Access-Control-Expose-Headers` нет.'
		);
	}
	const head = [
		'| путь | статус ответа на сам запрос | другие заголовки ответа',
		withOptions ? ' | ответ на OPTIONS' : '',
		withCors ? ' | заголовки CORS в ответе' : '',
		' |\n|---|---|---',
		withOptions ? '|---' : '',
		withCors ? '|---' : '',
		'|'
	].join('');
	const rows = p.routes.map((r) => {
		const headers = Object.entries(r.headers)
			.map(([n, v]) => `\`${display(n)}: ${v}\``)
			.join(', ');
		return `| \`${r.path}\` | ${r.status} | ${headers}${withOptions ? ` | ${r.optionsStatus}` : ''}${withCors ? ` | ${r.cors ? 'есть' : 'нет — ответ формирует обработчик ошибок до CORS'}` : ''} |`;
	});
	const pages = new Set(p.calls.map((c) => c.page)).size > 1;
	const code = p.calls.map((c, i) => callCode(p, c, i, pages)).join('\n\n');
	const firstPage = p.calls[0]?.page ?? '';
	return [
		s.acao === null
			? `Сервер API \`${p.api}\` заголовков \`Access-Control-*\` не ставит вовсе.`
			: withCors
				? `Сервер API \`${p.api}\` ставит на ответы на preflight \`OPTIONS\` всегда, а на остальные ответы — если в таблице не сказано «нет», такие заголовки CORS:`
				: `Сервер API \`${p.api}\` ставит на все ответы, включая ответы на preflight \`OPTIONS\`, такие заголовки CORS:`,
		'',
		...serverLines,
		'',
		withOptions
			? 'Статус ответа на preflight `OPTIONS` для каждого пути указан в таблице.'
			: 'На preflight `OPTIONS` по любому пути сервер отвечает статусом `204`; статус в таблице — у ответа на сам запрос.',
		'',
		...(s.acao === null
			? []
			: [
					'Кэш preflight браузера в начале пуст, а `Access-Control-Max-Age: 0` не даёт сохранить в нём результат: каждый вызов, которому нужен preflight, отправляет свой `OPTIONS`.',
					''
				]),
		head,
		...rows,
		'',
		`${pages ? 'Скрипты страниц выполняют' : `Скрипт страницы \`${firstPage}\` выполняет`} вызовы ниже по очереди; каждый вызов обёрнут в свой \`try { … } catch { console.log('error') }\`, \`data\` — обычный объект, \`form\` — форма на странице.`,
		'',
		'```js',
		'let r;',
		code,
		'```',
		'',
		'Для каждого вызова по порядку введите три значения через пробел: `pre`, если браузер отправил preflight `OPTIONS`, иначе `nopre`; затем `error`, если `fetch` отклонён с `TypeError`, иначе `r.status`; затем то, что вернёт `r.headers.get(…)`, — значение как в таблице или `null`, а после `error` — знак `-`. Тройки всех вызовов — подряд через пробел. Например: `nopre 200 application/json pre error -`.'
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference.

const PYTHON_REFERENCE = `import json

p = json.loads(input())
srv = p["server"]
routes = {r["path"]: r for r in p["routes"]}
SIMPLE_METHODS = {"GET", "HEAD", "POST"}
SIMPLE_TYPES = {"text/plain", "multipart/form-data", "application/x-www-form-urlencoded"}
SAFE_IN = {"accept", "accept-language", "content-language"}
SAFE_OUT = {"cache-control", "content-language", "content-type", "expires", "last-modified", "pragma"}


def origin_ok(page, with_credentials):
    if srv["acao"] is None:
        return False
    if srv["acao"] == "*":
        return not with_credentials
    return page in srv["allowed"] and (srv["acac"] or not with_credentials)


def listed(tokens, name, with_credentials, never_wild=False):
    if name in tokens:
        return True
    return "*" in tokens and not with_credentials and not never_wild


out = []
for c in p["calls"]:
    r = routes[c["route"]]
    if c["mode"] == "no-cors":
        out += ["nopre", "0", "null"] if c["method"] in SIMPLE_METHODS else ["nopre", "error", "-"]
        continue
    cred = c["credentials"] == "include"
    names = []
    for name, value in c["headers"]:
        n = name.lower()
        if n == "content-type":
            if value.split(";")[0].strip().lower() not in SIMPLE_TYPES:
                names.append(n)
        elif n not in SAFE_IN:
            names.append(n)
    preflight = c["method"] not in SIMPLE_METHODS or bool(names)
    tag = "pre" if preflight else "nopre"
    if preflight:
        good = 200 <= r["optionsStatus"] < 300 and origin_ok(c["page"], cred)
        good = good and (c["method"] in SIMPLE_METHODS or listed(srv["methods"], c["method"], cred))
        good = good and all(listed(srv["headers"], n, cred, n == "authorization") for n in names)
        if not good:
            out += [tag, "error", "-"]
            continue
    if not r["cors"] or not origin_ok(c["page"], cred):
        out += [tag, "error", "-"]
        continue
    h = c["read"].lower()
    shown = h in SAFE_OUT or listed(srv["expose"], h, cred)
    out += [tag, str(r["status"]), r["headers"].get(h, "null") if shown else "null"]
print(" ".join(out))
`;

/** Per class: misconceptions of which at least `min` must apply to every instance. */
const REQUIRED: Record<string, { ids: string[]; min: number }> = {
	'junior/preflight-trigger': {
		ids: ['json-string-preflight', 'safelisted-header-preflight', 'post-preflight', 'lists-not-checked'],
		min: 3
	},
	'junior/credentials': { ids: ['star-with-credentials', 'no-acac-needed', 'default-is-include'], min: 2 },
	'junior/exposed-headers': { ids: ['all-headers-visible', 'only-exposed-visible', 'error-status-rejects'], min: 3 },
	'junior/no-cors': { ids: ['no-cors-readable', 'no-cors-error', 'no-cors-any-method'], min: 2 },
	'middle/credentialed-wildcards': { ids: ['wildcard-with-credentials', 'wildcard-never'], min: 2 },
	'middle/authorization-star': { ids: ['star-covers-authorization', 'wildcard-never'], min: 2 },
	'middle/preflight-status': { ids: ['preflight-status-ignored', 'error-status-rejects'], min: 2 },
	'middle/error-handler': { ids: ['status-without-cors', 'error-status-rejects'], min: 2 }
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? { ids: [], min: 0 };
	let chosen: { p: Params; answer: string; wrong: Record<string, string | null> } | undefined;
	// The draw settles within a few tries; if it never does, the last draw is kept: a misconception that gives the
	// right answer there is simply not applied to the instance.
	for (let tries = 0; tries < 300; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		chosen = { p, answer, wrong };
		if (required.ids.filter((id) => wrong[id] !== null).length >= required.min && varied(p, answer)) break;
	}
	if (!chosen) throw new Error(`${descriptor.key}: no draw`);
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

/** No call repeats another, and not every call fails: the script reads something somewhere. */
function varied(p: Params, answer: string): boolean {
	const distinct = new Set(p.calls.map((c) => JSON.stringify(c))).size === p.calls.length;
	return distinct && answer.split(' ').filter((t) => t === 'error').length < p.calls.length;
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
