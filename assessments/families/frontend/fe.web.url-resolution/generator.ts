// Resolving the relative URLs of a document's links against its base URL: dot segments, a query or a fragment
// alone, absolute paths and network-path references, and a `<base href>` that is itself resolved against the
// document. The cases are those where the WHATWG URL Standard and RFC 3986 agree.
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

interface Url {
	scheme: string;
	host: string;
	path: string;
	query: string | null;
	fragment: string | null;
}

interface Params {
	document: string;
	/** The `href` of `<base>`, as written; `null` — the document has no `<base>`. */
	base: string | null;
	refs: string[];
}

interface Rules {
	/** The base path counts as a directory even when it ends with a file name. */
	fileAsDir: boolean;
	/** `.` and `..` stay in the path as written. */
	dotsLiteral: boolean;
	/** `?q` adds to the base's query instead of replacing it. */
	queryAppends: boolean;
	/** `?q` keeps the base's fragment. */
	queryKeepsFragment: boolean;
	/** `#f` drops the base's query. */
	fragmentDropsQuery: boolean;
	/** A relative path without its own query takes the base's query. */
	relativeKeepsQuery: boolean;
	/** `//host/path` is read as a path on the same host. */
	networkAsPath: boolean;
	/** `<base>` is not looked at. */
	baseIgnored: boolean;
	/** A relative `<base href>` is read from the root of the site, not from the document. */
	baseFromRoot: boolean;
	/** `#f` goes to the document, not to the base. */
	fragmentToDocument: boolean;
}

const RIGHT: Rules = {
	fileAsDir: false,
	dotsLiteral: false,
	queryAppends: false,
	queryKeepsFragment: false,
	fragmentDropsQuery: false,
	relativeKeepsQuery: false,
	networkAsPath: false,
	baseIgnored: false,
	baseFromRoot: false,
	fragmentToDocument: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'file-as-dir': { fileAsDir: true },
	'dots-literal': { dotsLiteral: true },
	'query-appends': { queryAppends: true },
	'query-keeps-fragment': { queryKeepsFragment: true },
	'fragment-drops-query': { fragmentDropsQuery: true },
	'relative-keeps-query': { relativeKeepsQuery: true },
	'network-path-as-path': { networkAsPath: true },
	'base-ignored': { baseIgnored: true },
	'base-from-root': { baseFromRoot: true },
	'fragment-to-document': { fragmentToDocument: true }
};

function parseAbsolute(url: string): Url {
	const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(url);
	if (!match) throw new Error(`not an absolute URL: ${url}`);
	return {
		scheme: match[1] ?? '',
		host: match[2] ?? '',
		path: match[3] || '/',
		query: match[4] ?? null,
		fragment: match[5] ?? null
	};
}

function serialize(u: Url): string {
	return `${u.scheme}://${u.host}${u.path}${u.query === null ? '' : `?${u.query}`}${u.fragment === null ? '' : `#${u.fragment}`}`;
}

/** RFC 3986, 5.2.4: an input buffer consumed from the left into an output buffer. */
function removeDots(path: string): string {
	let input = path;
	let output = '';
	while (input.length > 0) {
		if (input.startsWith('../')) input = input.slice(3);
		else if (input.startsWith('./')) input = input.slice(2);
		else if (input.startsWith('/./')) input = input.slice(2);
		else if (input === '/.') input = '/';
		else if (input.startsWith('/../') || input === '/..') {
			input = input === '/..' ? '/' : input.slice(3);
			output = output.slice(0, Math.max(0, output.lastIndexOf('/')));
		} else if (input === '.' || input === '..') input = '';
		else {
			const next = input.indexOf('/', input.startsWith('/') ? 1 : 0);
			const segment = next === -1 ? input : input.slice(0, next);
			output += segment;
			input = input.slice(segment.length);
		}
	}
	return output;
}

function splitRef(ref: string): { path: string; query: string | null; fragment: string | null } {
	const hash = ref.indexOf('#');
	const fragment = hash === -1 ? null : ref.slice(hash + 1);
	const beforeHash = hash === -1 ? ref : ref.slice(0, hash);
	const mark = beforeHash.indexOf('?');
	return {
		path: mark === -1 ? beforeHash : beforeHash.slice(0, mark),
		query: mark === -1 ? null : beforeHash.slice(mark + 1),
		fragment
	};
}

function resolve(base: Url, ref: string, rules: Rules): Url {
	const dots = (path: string): string => (rules.dotsLiteral ? path : removeDots(path));
	if (/^[a-z][a-z0-9+.-]*:/.test(ref)) {
		const target = parseAbsolute(ref);
		return { ...target, path: dots(target.path) };
	}
	if (ref.startsWith('//')) {
		if (rules.networkAsPath) return resolve(base, ref.slice(1), rules);
		const target = parseAbsolute(`${base.scheme}:${ref}`);
		return { ...target, path: dots(target.path) };
	}
	const r = splitRef(ref);
	if (r.path === '') {
		if (r.query !== null) {
			const query = rules.queryAppends && base.query ? `${base.query}&${r.query}` : r.query;
			const fragment = r.fragment ?? (rules.queryKeepsFragment ? base.fragment : null);
			return { ...base, query, fragment };
		}
		return { ...base, query: rules.fragmentDropsQuery ? null : base.query, fragment: r.fragment };
	}
	let path: string;
	if (r.path.startsWith('/')) path = dots(r.path);
	else {
		const dir = rules.fileAsDir
			? base.path.endsWith('/')
				? base.path
				: `${base.path}/`
			: base.path.slice(0, base.path.lastIndexOf('/') + 1);
		path = dots(dir + r.path);
	}
	const query = r.query ?? (rules.relativeKeepsQuery ? base.query : null);
	return { ...base, path, query, fragment: r.fragment };
}

/** The resolved URL of every link, in order. */
function simulate(p: Params, rules: Rules): string[] {
	const document = parseAbsolute(p.document);
	let base = document;
	if (p.base !== null && !rules.baseIgnored) {
		const relative = !/^[a-z][a-z0-9+.-]*:/.test(p.base) && !p.base.startsWith('/');
		base = resolve(rules.baseFromRoot && relative ? { ...document, path: '/' } : document, p.base, rules);
	}
	return p.refs.map((ref) =>
		serialize(resolve(ref.startsWith('#') && rules.fragmentToDocument ? document : base, ref, rules))
	);
}

const HOSTS = ['shop.example.ru', 'docs.example.ru', 'news.example.ru', 'learn.example.com', 'blog.example.com'];
const CDNS = ['cdn.example.net', 'static.example.org', 'img.example.net'];
const SEGMENTS = ['catalog', 'books', 'guide', 'blog', 'posts', 'docs', 'v2', 'media', 'shop', 'help', 'news', 'items'];
const FILES = ['index.html', 'page.html', 'item.html', 'list.html', 'about.html', 'view.html'];
const NAMES = ['cart.html', 'style.css', 'logo.png', 'app.js', 'faq.html', 'price.html', 'map.svg', 'team.html'];
const QUERIES = ['page=2', 'sort=price', 'lang=en', 'id=17', 'tab=specs', 'q=book', 'view=grid', 'id=42'];
const FRAGMENTS = ['top', 'reviews', 'section-3', 'comments', 'specs', 'contacts'];

function documentUrl(rng: Rng, depth: number, file: boolean, query: boolean, fragment: boolean): string {
	const dirs = rng.sample(SEGMENTS, depth);
	const path = `/${dirs.join('/')}/${file ? rng.pick(FILES) : ''}`;
	return `https://${rng.pick(HOSTS)}${path}${query ? `?${rng.pick(QUERIES)}` : ''}${fragment ? `#${rng.pick(FRAGMENTS)}` : ''}`;
}

/** `count` distinct references: every one of `required`, then picks from `optional`. */
function refsOf(rng: Rng, required: string[], optional: string[], count: number): string[] {
	const unique = [...new Set(required)];
	for (const ref of rng.shuffle(optional)) {
		if (unique.length >= count) break;
		if (!unique.includes(ref)) unique.push(ref);
	}
	return rng.shuffle(unique);
}

function scenario(rng: Rng, classId: string): Params {
	const name = (): string => rng.pick(NAMES);
	const seg = (): string => rng.pick(SEGMENTS);
	const q = (): string => rng.pick(QUERIES);
	const f = (): string => rng.pick(FRAGMENTS);
	const count = rng.int(6, 7);
	if (classId === 'dot-segments') {
		const depth = rng.int(2, 3);
		const document = documentUrl(rng, depth, true, rng.bool(0.4), rng.bool(0.4));
		const required = [name(), `../${name()}`, `${'../'.repeat(depth + rng.int(1, 2))}${name()}`];
		const optional = [
			`./${name()}`,
			`../../${name()}`,
			`../${seg()}/${name()}`,
			`${seg()}/../${name()}`,
			`${seg()}/./${name()}`,
			'.',
			'..',
			'./',
			`./${seg()}/`
		];
		return { document, base: null, refs: refsOf(rng, required, optional, count) };
	}
	if (classId === 'query-fragment') {
		const document = documentUrl(rng, rng.int(1, 3), rng.bool(0.75), true, true);
		const required = [`?${q()}`, `#${f()}`];
		const optional = [
			`?${q()}#${f()}`,
			`${name()}?${q()}`,
			`${name()}#${f()}`,
			`./?${q()}`,
			`../#${f()}`,
			name(),
			`../${name()}`
		];
		return { document, base: null, refs: refsOf(rng, required, optional, count) };
	}
	if (classId === 'absolute-forms') {
		const document = documentUrl(rng, rng.int(2, 3), rng.bool(0.75), rng.bool(0.5), rng.bool(0.3));
		const host = parseAbsolute(document).host;
		const other = rng.pick([...HOSTS.filter((h) => h !== host), ...CDNS]);
		const required = [`//${rng.pick(CDNS)}/${seg()}/${name()}`, `/${seg()}/${name()}`];
		const optional = [
			`/${seg()}/../${name()}`,
			`https://${other}/${seg()}/${name()}`,
			`http://${host}/${name()}`,
			`//${other}/${name()}`,
			'/',
			name(),
			`../${name()}`,
			`/${name()}?${q()}`
		];
		return { document, base: null, refs: refsOf(rng, required, optional, count) };
	}
	const depth = rng.int(2, 3);
	const document = documentUrl(rng, depth, rng.bool(0.8), true, rng.bool(0.5));
	const base = rng.pick([`../${seg()}/`, `${seg()}/`, `/${seg()}/${seg()}/`, `https://${rng.pick(CDNS)}/${seg()}/`]);
	const required = [`#${f()}`, rng.pick([name(), `./${seg()}/${name()}`])];
	const optional = [`../${name()}`, `?${q()}`, `/${seg()}/${name()}`, `${seg()}/${name()}`, name()];
	return { document, base, refs: refsOf(rng, required, optional, count) };
}

function describe(p: Params): string {
	const lines = [
		`Документ открыт по адресу \`${p.document}\`.`,
		p.base === null ? 'Элемента `<base>` в документе нет.' : `В \`<head>\` документа есть \`<base href="${p.base}">\`.`,
		'',
		'В документе есть ссылки `<a href="…">` с такими значениями `href` (в таблице — ровно то, что написано в атрибуте):',
		'',
		'| # | href |',
		'|---|---|',
		...p.refs.map((ref, i) => `| ${i + 1} | \`${ref}\` |`),
		'',
		'Куда ведёт каждая ссылка? Введите построчно, по одной строке на ссылку в порядке таблицы, полный адрес так, как его вернёт `new URL(href, document.baseURI).href`: со схемой и хостом, с запросом `?…` и фрагментом `#…`, если они есть в результате.'
	];
	return lines.join('\n');
}

const PYTHON_REFERENCE = `import json
from urllib.parse import urljoin

p = json.loads(input())
base = p["document"] if p["base"] is None else urljoin(p["document"], p["base"])
for ref in p["refs"]:
    print(urljoin(base, ref))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'dot-segments': ['file-as-dir', 'dots-literal'],
	'query-fragment': ['query-keeps-fragment', 'fragment-drops-query'],
	'absolute-forms': ['network-path-as-path'],
	'base-href': ['base-ignored', 'fragment-to-document']
};

/** A `<base href>` that points to the document's own directory would change nothing. */
function distinctBase(p: Params): boolean {
	if (p.base === null) return true;
	const document = parseAbsolute(p.document);
	const base = resolve(document, p.base, RIGHT);
	return base.host !== document.host || base.path !== document.path.slice(0, document.path.lastIndexOf('/') + 1);
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[input.classId] ?? [];
	let chosen: { p: Params; answer: string[]; wrong: Record<string, string[] | null> } | null = null;
	// The draw settles almost always on the first try; the last draw is kept when it does not, since every
	// misconception that gives the right answer there is simply not applied to the instance.
	for (let tries = 0; tries < 50; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		chosen = { p, answer, wrong };
		if (required.every((id) => wrong[id] !== null) && distinctBase(p)) break;
	}
	if (!chosen) throw new Error('unreachable: at least one draw');
	const { p, answer, wrong } = chosen;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(p), code: null },
		answer: { kind: 'sequence', value: answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
		wrong: () =>
			Object.fromEntries(
				Object.entries(wrong).map(([id, value]) => [
					id,
					value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
				])
			)
	};
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
