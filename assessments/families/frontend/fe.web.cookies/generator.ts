// Cookies in the browser (RFC 6265bis): which cookies go with each request and what `document.cookie` shows —
// `Domain` and host-only cookies, `Path` and its default, `Secure`, `HttpOnly`, `SameSite` for top-level
// navigations, cross-site forms and `fetch`, expiry by `Max-Age` and `Expires`, and replacing a cookie.
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

/** `address` — typed in the address bar; `link` — a link on page `from`; `form` — a POST form on `from`;
 * `fetch` — `fetch(url, {credentials: 'include'})` on `from`; `script` — `document.cookie` read on page `url`. */
type How = 'address' | 'link' | 'form' | 'fetch' | 'script';

type Event =
	| { kind: 'set'; t: number; url: string; headers: string[] }
	| { kind: 'read'; t: number; how: How; from: string | null; url: string };

interface Params {
	events: Event[];
}

interface Rules {
	domainAttrHostOnly: boolean;
	hostOnlySubdomains: boolean;
	foreignDomainAccepted: boolean;
	pathStringPrefix: boolean;
	defaultPathRoot: boolean;
	strictOnCrossLink: boolean;
	laxNotOnLink: boolean;
	laxOnCrossPost: boolean;
	laxOnCrossFetch: boolean;
	subdomainCrossSite: boolean;
	httpOnlyInDocument: boolean;
	httpOnlyNotSent: boolean;
	secureOnHttp: boolean;
	secureSetOverHttp: boolean;
	expiresOverMaxAge: boolean;
	maxAgeZeroSession: boolean;
	overwriteByName: boolean;
	noOverwrite: boolean;
}

const RIGHT: Rules = {
	domainAttrHostOnly: false,
	hostOnlySubdomains: false,
	foreignDomainAccepted: false,
	pathStringPrefix: false,
	defaultPathRoot: false,
	strictOnCrossLink: false,
	laxNotOnLink: false,
	laxOnCrossPost: false,
	laxOnCrossFetch: false,
	subdomainCrossSite: false,
	httpOnlyInDocument: false,
	httpOnlyNotSent: false,
	secureOnHttp: false,
	secureSetOverHttp: false,
	expiresOverMaxAge: false,
	maxAgeZeroSession: false,
	overwriteByName: false,
	noOverwrite: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'domain-attr-host-only': { domainAttrHostOnly: true },
	'host-only-subdomains': { hostOnlySubdomains: true },
	'foreign-domain-accepted': { foreignDomainAccepted: true },
	'path-string-prefix': { pathStringPrefix: true },
	'default-path-root': { defaultPathRoot: true },
	'strict-on-cross-link': { strictOnCrossLink: true },
	'lax-not-on-link': { laxNotOnLink: true },
	'lax-on-cross-post': { laxOnCrossPost: true },
	'lax-on-cross-fetch': { laxOnCrossFetch: true },
	'subdomain-cross-site': { subdomainCrossSite: true },
	'httponly-in-document': { httpOnlyInDocument: true },
	'httponly-not-sent': { httpOnlyNotSent: true },
	'secure-on-http': { secureOnHttp: true },
	'secure-set-over-http': { secureSetOverHttp: true },
	'expires-over-max-age': { expiresOverMaxAge: true },
	'max-age-zero-session': { maxAgeZeroSession: true },
	'overwrite-by-name': { overwriteByName: true },
	'no-overwrite': { noOverwrite: true }
};

interface Cookie {
	name: string;
	value: string;
	domain: string;
	hostOnly: boolean;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	sameSite: string;
	/** Minute of expiry; `null` — a session cookie. */
	expires: number | null;
}

/** Minutes since 10:00 GMT of 2026-10-05 → `HH:MM`. */
const clock = (t: number): string =>
	`${String(10 + Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const httpDate = (t: number): string => `Mon, 05 Oct 2026 ${clock(t)}:00 GMT`;
/** Inverse of `httpDate`. */
function minuteOf(date: string): number {
	const match = / (\d\d):(\d\d):00 GMT$/.exec(date);
	if (!match) throw new Error(`unexpected date ${date}`);
	return (Number(match[1]) - 10) * 60 + Number(match[2]);
}

const siteOf = (host: string): string => host.split('.').slice(-2).join('.');

function parseUrl(url: string): { https: boolean; host: string; path: string } {
	const u = new URL(url);
	return { https: u.protocol === 'https:', host: u.hostname, path: u.pathname };
}

function pathMatches(cookiePath: string, path: string, rules: Rules): boolean {
	if (rules.pathStringPrefix) return path.startsWith(cookiePath);
	return (
		path === cookiePath ||
		(path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/'))
	);
}

function setCookie(store: Cookie[], t: number, url: string, header: string, rules: Rules): void {
	const target = parseUrl(url);
	const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
	const eq = pair.indexOf('=');
	const name = pair.slice(0, eq);
	const value = pair.slice(eq + 1);
	const attrs = new Map<string, string>();
	for (const attribute of attributes) {
		const at = attribute.indexOf('=');
		attrs.set((at === -1 ? attribute : attribute.slice(0, at)).toLowerCase(), at === -1 ? '' : attribute.slice(at + 1));
	}
	const secure = attrs.has('secure');
	if (secure && !target.https && !rules.secureSetOverHttp) return;
	let domain = target.host;
	let hostOnly = true;
	const domainAttr = attrs.get('domain');
	if (domainAttr !== undefined) {
		const d = domainAttr.replace(/^\./, '').toLowerCase();
		const matches = target.host === d || target.host.endsWith(`.${d}`);
		if (!matches && !rules.foreignDomainAccepted) return;
		domain = d;
		hostOnly = rules.domainAttrHostOnly;
	}
	const pathAttr = attrs.get('path');
	let path: string;
	if (pathAttr !== undefined && pathAttr.startsWith('/')) path = pathAttr;
	else if (rules.defaultPathRoot) path = '/';
	else {
		const last = target.path.lastIndexOf('/');
		path = last <= 0 ? '/' : target.path.slice(0, last);
	}
	let expires: number | null = null;
	const maxAge = attrs.get('max-age');
	const expiresAttr = attrs.get('expires');
	if (rules.expiresOverMaxAge && expiresAttr !== undefined) expires = minuteOf(expiresAttr);
	else if (maxAge !== undefined) {
		const seconds = Number(maxAge);
		expires = seconds <= 0 ? (rules.maxAgeZeroSession ? null : Number.NEGATIVE_INFINITY) : t + seconds / 60;
	} else if (expiresAttr !== undefined) expires = minuteOf(expiresAttr);
	const cookie: Cookie = {
		name,
		value,
		domain,
		hostOnly,
		path,
		secure,
		httpOnly: attrs.has('httponly'),
		sameSite: attrs.get('samesite') ?? 'Lax',
		expires
	};
	const same = (c: Cookie): boolean =>
		c.name === name && (rules.overwriteByName || (c.domain === domain && c.hostOnly === hostOnly && c.path === path));
	if (!rules.noOverwrite) {
		for (let i = store.length - 1; i >= 0; i -= 1) if (same(store[i] as Cookie)) store.splice(i, 1);
	}
	if (expires === null || expires > t) store.push(cookie);
}

function readCookies(store: readonly Cookie[], e: Extract<Event, { kind: 'read' }>, rules: Rules): string[] {
	const target = parseUrl(e.url);
	const from = e.from === null ? null : parseUrl(e.from);
	const crossSite =
		e.how !== 'address' &&
		e.how !== 'script' &&
		from !== null &&
		(rules.subdomainCrossSite
			? from.host !== target.host || from.https !== target.https
			: siteOf(from.host) !== siteOf(target.host) || from.https !== target.https);
	return store
		.filter((c) => {
			if (c.expires !== null && c.expires <= e.t) return false;
			const domainOk = !c.hostOnly
				? target.host === c.domain || target.host.endsWith(`.${c.domain}`)
				: rules.hostOnlySubdomains
					? siteOf(target.host) === siteOf(c.domain)
					: target.host === c.domain;
			if (!domainOk || !pathMatches(c.path, target.path, rules)) return false;
			if (c.secure && !target.https && !rules.secureOnHttp) return false;
			if (e.how === 'script') return !c.httpOnly || rules.httpOnlyInDocument;
			if (c.httpOnly && e.how === 'fetch' && rules.httpOnlyNotSent) return false;
			if (!crossSite || c.sameSite === 'None') return true;
			if (c.sameSite === 'Strict') return e.how === 'link' && rules.strictOnCrossLink;
			if (e.how === 'link') return !rules.laxNotOnLink;
			if (e.how === 'form') return rules.laxOnCrossPost;
			return rules.laxOnCrossFetch;
		})
		.map((c) => `${c.name}=${c.value}`)
		.sort();
}

/** Per read: the cookies it gets, sorted, or `-`; reads separated by `|`. */
function simulate(p: Params, rules: Rules): string {
	const store: Cookie[] = [];
	const out: string[] = [];
	for (const e of p.events) {
		if (e.kind === 'set') for (const header of e.headers) setCookie(store, e.t, e.url, header, rules);
		else {
			const got = readCookies(store, e, rules);
			out.push(got.length ? got.join(' ') : '-');
		}
	}
	return out.join(' | ');
}

const SITES = ['market.ru', 'cinema.ru', 'travel.ru', 'books.ru', 'tickets.ru', 'garden.ru'];
const OTHER_SITES = ['news-portal.ru', 'partner.com', 'promo-media.ru', 'deals.example.com'];
const PATH_PAIRS: [string, string][] = [
	['/docs', '/docsets'],
	['/cart', '/cart-old'],
	['/shop', '/shopping'],
	['/admin', '/administration'],
	['/app', '/apps']
];
const NAMES = [
	'sid',
	'theme',
	'lang',
	'cart',
	'ref',
	'promo',
	'token',
	'csrf',
	'consent',
	'region',
	'currency',
	'seen'
];

/** The reads in their order, a minute apart from `start`. */
const timed = (reads: Event[], start: number): Event[] => reads.map((e, i) => ({ ...e, t: start + i }));

const value = (rng: Rng): string => String(rng.int(10, 99));

interface Draft {
	events: Event[];
}

function domainPath(rng: Rng): Draft {
	const site = rng.pick(SITES);
	const [short, long] = rng.pick(PATH_PAIRS);
	const names = rng.sample(NAMES, 5);
	const n = (i: number): string => names[i] as string;
	const login = `https://www.${site}${short}/login`;
	const deep = rng.pick(['account', 'profile', 'orders']);
	const headers = [
		`${n(0)}=${value(rng)}; Domain=${site}; Path=/; SameSite=Lax`,
		`${n(1)}=${value(rng)}; Path=/; SameSite=Lax`,
		`${n(2)}=${value(rng)}; Path=${short}; SameSite=Lax`,
		`${n(3)}=${value(rng)}; SameSite=Lax`
	];
	const foreign = rng.pick([`api.${site}`, rng.pick(OTHER_SITES)]);
	if (rng.bool(0.6)) headers.push(`${n(4)}=${value(rng)}; Domain=${foreign}; Path=/; SameSite=Lax`);
	const events: Event[] = [
		{
			kind: 'set',
			t: 0,
			url: rng.bool() ? login : `https://www.${site}${short}/${deep}/login`,
			headers: rng.shuffle(headers)
		}
	];
	if (rng.bool(0.4)) {
		const extra = rng.pick(NAMES.filter((x) => !names.includes(x)));
		events.push({
			kind: 'set',
			t: 1,
			url: `https://api.${site}/v1/session`,
			headers: [`${extra}=${value(rng)}; SameSite=Lax`]
		});
	}
	const reads: Event[] = [
		{
			kind: 'read',
			t: 5,
			how: 'address',
			from: null,
			url: `https://www.${site}${short}/${rng.pick(['guide', 'list', 'new'])}`
		},
		{
			kind: 'read',
			t: 6,
			how: 'address',
			from: null,
			url: `https://www.${site}${long}/${rng.pick(['index', 'archive'])}`
		},
		{ kind: 'read', t: 7, how: 'address', from: null, url: `https://api.${site}/v1/${rng.pick(['me', 'items'])}` },
		{ kind: 'read', t: 8, how: 'address', from: null, url: `https://${site}/` },
		{ kind: 'read', t: 9, how: 'script', from: null, url: `https://www.${site}${short}/${deep}/edit` },
		{ kind: 'read', t: 10, how: 'address', from: null, url: `https://www.${site}/` }
	];
	return { events: [...events, ...timed(rng.sample(reads, rng.int(5, 6)), 5)] };
}

function sameSite(rng: Rng): Draft {
	const site = rng.pick(SITES);
	const other = rng.pick(OTHER_SITES);
	const otherPage = `https://${other.split('.').length > 2 ? '' : 'www.'}${other}/${rng.pick(['article', 'review', 'post'])}`;
	const own = `https://www.${site}/${rng.pick(['catalog', 'profile', 'home'])}`;
	const names = rng.sample(NAMES, 4);
	const modes = rng.shuffle(['Strict', 'Lax', 'None', rng.pick(['Strict', 'Lax'])]);
	const headers = names.map(
		(name, i) => `${name}=${value(rng)}; Domain=${site}; Path=/; Secure; SameSite=${modes[i] as string}`
	);
	const reads: Event[] = rng.shuffle([
		{ kind: 'read', t: 5, how: 'link', from: otherPage, url: `https://www.${site}/${rng.pick(['sale', 'item'])}` },
		{ kind: 'read', t: 5, how: 'form', from: otherPage, url: `https://www.${site}/cart/add` },
		{ kind: 'read', t: 5, how: 'fetch', from: otherPage, url: `https://api.${site}/v1/widget` },
		{ kind: 'read', t: 5, how: 'fetch', from: own, url: `https://api.${site}/v1/me` },
		{ kind: 'read', t: 5, how: 'form', from: own, url: `https://pay.${site}/checkout` },
		{ kind: 'read', t: 5, how: 'link', from: own, url: `https://help.${site}/faq` },
		{ kind: 'read', t: 5, how: 'address', from: null, url: `https://www.${site}/` }
	] as Event[]);
	return {
		events: [
			{ kind: 'set', t: 0, url: `https://www.${site}/login`, headers },
			...timed(reads.slice(0, rng.int(5, 6)), 5)
		]
	};
}

function httpOnlySecure(rng: Rng): Draft {
	const site = rng.pick(SITES);
	const host = `www.${site}`;
	const names = rng.sample(NAMES, 6);
	const n = (i: number): string => names[i] as string;
	const first = rng.shuffle([
		`${n(0)}=${value(rng)}; Path=/; Secure; HttpOnly; SameSite=Lax`,
		`${n(1)}=${value(rng)}; Path=/; SameSite=Lax`,
		`${n(2)}=${value(rng)}; Path=/; Secure; SameSite=Lax`,
		`${n(3)}=${value(rng)}; Path=/; HttpOnly; SameSite=Lax`
	]);
	const second = rng.shuffle([
		`${n(4)}=${value(rng)}; Path=/; Secure; SameSite=Lax`,
		`${n(5)}=${value(rng)}; Path=/; SameSite=Lax`
	]);
	const reads: Event[] = rng.shuffle([
		{ kind: 'read', t: 5, how: 'script', from: null, url: `https://${host}/${rng.pick(['profile', 'settings'])}` },
		{ kind: 'read', t: 5, how: 'script', from: null, url: `http://${host}/promo` },
		{ kind: 'read', t: 5, how: 'address', from: null, url: `http://${host}/${rng.pick(['catalog', 'news'])}` },
		{ kind: 'read', t: 5, how: 'fetch', from: `https://${host}/profile`, url: `https://${host}/api/me` },
		{ kind: 'read', t: 5, how: 'address', from: null, url: `https://${host}/` }
	] as Event[]);
	return {
		events: [
			{ kind: 'set', t: 0, url: `https://${host}/login`, headers: first },
			{ kind: 'set', t: 1, url: `http://${host}/promo`, headers: second },
			...timed(reads.slice(0, rng.int(4, 5)), 5)
		]
	};
}

function expiryOverwrite(rng: Rng): Draft {
	const site = rng.pick(SITES);
	const host = `https://www.${site}`;
	const sub = rng.pick(['/shop', '/blog', '/account']);
	const [a, b, c, d] = rng.sample(NAMES, 4) as [string, string, string, string];
	// Moments in minutes: sets at 0 and later, reads between them; no read falls on an expiry minute.
	const ma = rng.pick([10, 15, 20]);
	const mb = rng.pick([5, 10]);
	const eb = mb + rng.pick([15, 20, 25]);
	const ed = rng.pick([20, 25, 30, 35]);
	const t1 = rng.int(3, 7);
	const t2 = t1 + rng.int(3, 6);
	const events: Event[] = [
		{
			kind: 'set',
			t: 0,
			url: `${host}/login`,
			headers: rng.shuffle([
				`${a}=${value(rng)}; Path=/; Max-Age=${ma * 60}`,
				`${b}=${value(rng)}; Path=/; Max-Age=${mb * 60}; Expires=${httpDate(eb)}`,
				`${c}=${value(rng)}; Path=/`,
				`${d}=${value(rng)}; Path=/; Expires=${httpDate(ed)}`
			])
		},
		{ kind: 'read', t: t1, how: 'address', from: null, url: `${host}${sub}/${rng.pick(['list', 'new'])}` },
		{
			kind: 'set',
			t: t2,
			url: `${host}${sub}/update`,
			headers: rng.shuffle([
				rng.bool()
					? `${a}=${value(rng)}; Path=${sub}; Max-Age=${rng.pick([30, 40]) * 60}`
					: `${a}=${value(rng)}; Path=/; Max-Age=${rng.pick([30, 40]) * 60}`,
				`${c}=${value(rng)}; Path=/; Max-Age=0`
			])
		}
	];
	const later = rng
		.sample(
			Array.from({ length: 45 - t2 }, (_, i) => t2 + 1 + i),
			rng.int(3, 4)
		)
		.sort((x, y) => x - y);
	for (const t of later) {
		events.push({
			kind: 'read',
			t,
			how: 'address',
			from: null,
			url: rng.bool() ? `${host}${sub}/${rng.pick(['cart', 'item'])}` : `${host}/`
		});
	}
	return { events };
}

function scenario(rng: Rng, classId: string): Params {
	if (classId === 'domain-path') return domainPath(rng);
	if (classId === 'samesite') return sameSite(rng);
	if (classId === 'httponly-secure') return httpOnlySecure(rng);
	return expiryOverwrite(rng);
}

/** Whether no read happens at the very minute some cookie expires: the boundary is never asked. */
function clearOfExpiry(p: Params): boolean {
	const reads = p.events.filter((e) => e.kind === 'read').map((e) => e.t);
	const edges: number[] = [];
	for (const e of p.events) {
		if (e.kind !== 'set') continue;
		for (const header of e.headers) {
			const maxAge = /Max-Age=(\d+)/.exec(header);
			if (maxAge) edges.push(e.t + Number(maxAge[1]) / 60);
			const expires = /Expires=([^;]+)/.exec(header);
			if (expires) edges.push(minuteOf(expires[1] as string));
		}
	}
	return !reads.some((t) => edges.includes(t));
}

const HOW_TEXT: Record<How, string> = {
	address: 'адрес набран в адресной строке',
	link: 'переход по ссылке',
	form: 'отправка формы `method="post"`',
	fetch: "`fetch(url, { credentials: 'include' })`",
	script: 'скрипт страницы читает `document.cookie`'
};

function describe(p: Params): string {
	const rows: string[] = [];
	let step = 0;
	for (const e of p.events) {
		if (e.kind === 'set') {
			rows.push(
				`| — | ${clock(e.t)} | ответ на \`GET ${e.url}\` (адрес набран в адресной строке) | ${e.headers.map((h) => `\`Set-Cookie: ${h}\``).join('<br>')} |`
			);
		} else {
			step += 1;
			const where =
				e.how === 'script'
					? `страница \`${e.url}\``
					: e.from === null
						? `\`${e.url}\``
						: `со страницы \`${e.from}\` на \`${e.url}\``;
			rows.push(`| ${step} | ${clock(e.t)} | ${where} | ${HOW_TEXT[e.how]} |`);
		}
	}
	return [
		'В браузере сначала нет ни одной куки. События идут в порядке таблицы; все они — 5 октября 2026 года, время — GMT. Считаем, что браузер не блокирует сторонние куки и что все хосты в таблице существуют.',
		...(p.events.some((e) => e.url.startsWith('http:'))
			? ['Сайт доступен и по HTTP, и по HTTPS; браузер сам не переводит запросы на HTTPS.']
			: []),
		'',
		'| № | время | запрос или страница | что происходит |',
		'|---|---|---|---|',
		...rows,
		'',
		`Для каждой пронумерованной строки определите, какие куки браузер отправит с этим запросом в заголовке \`Cookie\` (для \`document.cookie\` — какие куки скрипт увидит). Введите ответы по порядку номеров через знак \`|\`: в каждом — пары \`имя=значение\` через пробел в алфавитном порядке, или \`-\`, если кук нет. Например: \`a=1 b=2 | - | b=2\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import json
from urllib.parse import urlsplit

p = json.loads(input())


def minute(date):
    hh, mm, _ = date.split(" ")[4].split(":")
    return (int(hh) - 10) * 60 + int(mm)


def site(host):
    return ".".join(host.split(".")[-2:])


def path_ok(cookie_path, path):
    if path == cookie_path:
        return True
    if not path.startswith(cookie_path):
        return False
    return cookie_path.endswith("/") or path[len(cookie_path)] == "/"


jar = {}
answers = []
for e in p["events"]:
    u = urlsplit(e["url"])
    host, path, secure_scheme = u.hostname, u.path or "/", u.scheme == "https"
    if e["kind"] == "set":
        for header in e["headers"]:
            parts = [x.strip() for x in header.split(";")]
            name, value = parts[0].split("=", 1)
            attrs = {}
            for a in parts[1:]:
                k, _, v = a.partition("=")
                attrs[k.lower()] = v
            if "secure" in attrs and not secure_scheme:
                continue
            if "domain" in attrs:
                dom = attrs["domain"].lstrip(".").lower()
                if not (host == dom or host.endswith("." + dom)):
                    continue
                host_only = False
            else:
                dom, host_only = host, True
            cpath = attrs.get("path", "")
            if not cpath.startswith("/"):
                cpath = path[: path.rfind("/")] or "/"
            if "max-age" in attrs:
                until = e["t"] + int(attrs["max-age"]) / 60 if int(attrs["max-age"]) > 0 else None
                alive = until is not None
            elif "expires" in attrs:
                until = minute(attrs["expires"])
                alive = until > e["t"]
            else:
                until, alive = float("inf"), True
            key = (name, dom, host_only, cpath)
            jar.pop(key, None)
            if alive:
                jar[key] = {
                    "pair": name + "=" + value,
                    "secure": "secure" in attrs,
                    "httponly": "httponly" in attrs,
                    "samesite": attrs.get("samesite", "Lax"),
                    "until": until,
                }
        continue
    sent = []
    cross = False
    if e["how"] in ("link", "form", "fetch"):
        f = urlsplit(e["from"])
        cross = site(f.hostname) != site(host) or f.scheme != u.scheme
    for (name, dom, host_only, cpath), c in jar.items():
        if c["until"] <= e["t"]:
            continue
        if host_only and host != dom:
            continue
        if not host_only and not (host == dom or host.endswith("." + dom)):
            continue
        if not path_ok(cpath, path):
            continue
        if c["secure"] and not secure_scheme:
            continue
        if e["how"] == "script":
            if not c["httponly"]:
                sent.append(c["pair"])
            continue
        if cross:
            if c["samesite"] == "Strict":
                continue
            if c["samesite"] == "Lax" and e["how"] != "link":
                continue
        sent.append(c["pair"])
    answers.append(" ".join(sorted(sent)) if sent else "-")
print(" | ".join(answers))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'domain-path': ['domain-attr-host-only', 'host-only-subdomains', 'path-string-prefix'],
	samesite: ['lax-on-cross-post', 'subdomain-cross-site', 'strict-on-cross-link'],
	'httponly-secure': ['httponly-in-document', 'secure-on-http', 'secure-set-over-http'],
	'expiry-overwrite': ['expires-over-max-age', 'max-age-zero-session', 'no-overwrite']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[input.classId] ?? [];
	let chosen: { p: Params; answer: string; wrong: Record<string, string | null> } | undefined;
	// The draw settles within a few tries; if it never does, the last draw is kept: a misconception that gives the
	// right answer there is simply not applied to the instance.
	for (let tries = 0; tries < 200; tries += 1) {
		const p = scenario(rng, input.classId);
		if (!clearOfExpiry(p) && tries < 199) continue;
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		chosen = { p, answer, wrong };
		if (required.every((id) => wrong[id] !== null)) break;
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

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
