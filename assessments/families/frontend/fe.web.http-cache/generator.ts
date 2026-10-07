// The browser's HTTP cache (RFC 9111) as a user sees it: on every visit of a page, which of its resources come from
// the cache, which are revalidated with a conditional request and which are downloaded in full — and which version
// of each one the page is drawn with. `max-age`, `no-cache` against `no-store`, ETag and Last-Modified, a link
// against a reload and a hard reload; a level up, `immutable`, file names with a content hash against one URL, and
// `Vary: Accept-Language` in a cache that keeps one response per URL.
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

type Validator = 'etag' | 'last-modified' | 'none';
type Kind = 'nav' | 'reload' | 'hard';

interface Resource {
	url: string;
	maxAge: number | null;
	noCache: boolean;
	noStore: boolean;
	immutable: boolean;
	validator: Validator;
	vary: boolean;
	/** Moments the content changes on the server; each change is the next version. */
	changes: number[];
	/** A file with a content hash in its name: its content never changes, this is the build it came with. */
	build: number | null;
}

interface Visit {
	t: number;
	kind: Kind;
	lang: 'ru' | 'en';
}

interface Params {
	origin: string;
	doc: string;
	resources: Resource[];
	/** The subresources the document of each version includes, in order; one list when the document never names others. */
	subs: string[][];
	visits: Visit[];
	/** Whether the visits differ in Accept-Language. */
	langs: boolean;
}

interface Rules {
	revalidate: boolean;
	refresh304: boolean;
	lastModifiedValidates: boolean;
	noValidator304: boolean;
	noCacheAsNoStore: boolean;
	noStoreRevalidates: boolean;
	hitShowsCurrent: boolean;
	reload: 'right' | 'cache' | 'full';
	hardConditional: boolean;
	immutableIgnored: boolean;
	immutableForever: boolean;
	hashedRefetch: boolean;
	deployRefreshes: boolean;
	ignoreVary: boolean;
}

const RIGHT: Rules = {
	revalidate: true,
	refresh304: true,
	lastModifiedValidates: true,
	noValidator304: false,
	noCacheAsNoStore: false,
	noStoreRevalidates: false,
	hitShowsCurrent: false,
	reload: 'right',
	hardConditional: false,
	immutableIgnored: false,
	immutableForever: false,
	hashedRefetch: false,
	deployRefreshes: false,
	ignoreVary: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'stale-full-fetch': { revalidate: false },
	'no-refresh-304': { refresh304: false },
	'last-modified-not-validator': { lastModifiedValidates: false },
	'no-validator-304': { noValidator304: true },
	'no-cache-as-no-store': { noCacheAsNoStore: true },
	'no-store-revalidates': { noStoreRevalidates: true },
	'hit-shows-current': { hitShowsCurrent: true },
	'reload-uses-cache': { reload: 'cache' },
	'reload-full': { reload: 'full' },
	'hard-reload-conditional': { hardConditional: true },
	'immutable-ignored': { immutableIgnored: true },
	'immutable-forever': { immutableForever: true },
	'hashed-refetch': { hashedRefetch: true },
	'deploy-refreshes-same-url': { deployRefreshes: true },
	'ignore-vary': { ignoreVary: true }
};

const versionAt = (r: Resource, t: number): number => r.build ?? 1 + r.changes.filter((c) => c <= t).length;

interface Entry {
	storedAt: number;
	version: number;
	lang: string;
}

/** Per visit, per resource in order: `hit`, `304` or `200`, a colon and the version the page is drawn with. */
function simulate(p: Params, rules: Rules): string {
	const cache = new Map<string, Entry>();
	const out: string[] = [];
	let lastDoc = 0;
	for (const visit of p.visits) {
		const label = (r: Resource, version: number, lang: string): string => `${r.vary ? lang : ''}${version}`;
		const load = (r: Resource, docChanged: boolean): number => {
			const current = versionAt(r, visit.t);
			const noStore = r.noStore || (r.noCache && rules.noCacheAsNoStore);
			const storable = !noStore || rules.noStoreRevalidates;
			const mustRevalidate = r.noCache || (r.noStore && rules.noStoreRevalidates);
			const store = (): number => {
				if (storable) cache.set(r.url, { storedAt: visit.t, version: current, lang: visit.lang });
				out.push(`200:${label(r, current, visit.lang)}`);
				return current;
			};
			const entry = storable ? cache.get(r.url) : undefined;
			if (!entry) return store();
			if (r.vary && entry.lang !== visit.lang && !rules.ignoreVary) return store();
			const hasValidator = r.validator === 'etag' || (r.validator === 'last-modified' && rules.lastModifiedValidates);
			const revalidate = (): number => {
				if ((hasValidator || rules.noValidator304) && rules.revalidate && entry.version === current) {
					if (rules.refresh304) entry.storedAt = visit.t;
					out.push(`304:${label(r, entry.version, entry.lang)}`);
					return entry.version;
				}
				return store();
			};
			const age = visit.t - entry.storedAt;
			const fresh =
				!mustRevalidate &&
				r.maxAge !== null &&
				(age < r.maxAge || (r.immutable && rules.immutableForever)) &&
				!(docChanged && rules.deployRefreshes && r.build === null) &&
				!(docChanged && rules.hashedRefetch && r.build !== null);
			if (visit.kind === 'hard') return rules.hardConditional ? revalidate() : store();
			if (visit.kind === 'reload') {
				if (rules.reload === 'full') return store();
				const skip = rules.reload === 'cache' || (r.immutable && !rules.immutableIgnored);
				if (!(skip && fresh)) return revalidate();
			}
			if (fresh) {
				const shown = rules.hitShowsCurrent ? current : entry.version;
				out.push(`hit:${label(r, shown, entry.lang)}`);
				return shown;
			}
			return revalidate();
		};
		const doc = p.resources.find((r) => r.url === p.doc);
		if (!doc) throw new Error('no document');
		const docVersion = load(doc, false);
		const docChanged = lastDoc !== 0 && docVersion !== lastDoc;
		lastDoc = docVersion;
		const subs = p.subs[Math.min(docVersion, p.subs.length) - 1] ?? [];
		for (const url of subs) {
			const r = p.resources.find((x) => x.url === url);
			if (!r) throw new Error(`no resource ${url}`);
			load(r, docChanged);
		}
	}
	return out.join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const ORIGINS = [
	'https://shop.example.ru',
	'https://news.example.ru',
	'https://kino.example.ru',
	'https://docs.example.com'
];
const DOCS = ['/', '/catalog', '/news', '/account'];

function plain(url: string): Resource {
	return {
		url,
		maxAge: null,
		noCache: false,
		noStore: false,
		immutable: false,
		validator: 'etag',
		vary: false,
		changes: [],
		build: null
	};
}

const hash = (rng: Rng): string => rng.int(0x1000, 0xffff).toString(16);

/** Visit moments: the first at 0, then gaps of the given range. */
function moments(rng: Rng, count: number, gap: [number, number]): number[] {
	const out = [0];
	while (out.length < count) out.push((out[out.length - 1] ?? 0) + rng.int(gap[0], gap[1]));
	return out;
}

/** A change moment strictly between two visits (never at a visit). */
function between(rng: Rng, times: readonly number[], from: number): number {
	const i = rng.int(from, times.length - 2);
	const a = times[i] ?? 0;
	const b = times[i + 1] ?? a + 2;
	return a + 1 + rng.int(0, Math.max(0, b - a - 2));
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const origin = rng.pick(ORIGINS);
	const doc = rng.pick(DOCS);
	const resources: Resource[] = [];
	let subs: string[][];
	let visits: Visit[];
	const kinds = (count: number, pool: Kind[]): Kind[] => [
		'nav',
		...Array.from({ length: count - 1 }, () => rng.pick(pool))
	];
	if (grade === 'junior') {
		const count = rng.int(3, 4);
		const times = moments(rng, count, [20, 160]);
		const ages = [60, 90, 120, 180, 300];
		const urls = ['/style.css', '/app.js', '/logo.png'];
		if (classId === 'validators') {
			const validators = rng.shuffle<Validator>(['etag', 'last-modified', 'none']);
			resources.push({
				...plain(doc),
				maxAge: rng.pick(ages),
				validator: rng.pick<Validator>(['etag', 'last-modified'])
			});
			urls.forEach((url, i) =>
				resources.push({ ...plain(url), maxAge: rng.pick(ages), validator: validators[i] ?? 'etag' })
			);
			visits = times.map((t) => ({ t, kind: 'nav', lang: 'ru' }));
		} else if (classId === 'no-cache-no-store') {
			const roles = rng.shuffle(['no-cache', 'no-store', 'max-age']);
			resources.push({ ...plain(doc), noCache: true, validator: rng.pick<Validator>(['etag', 'last-modified']) });
			urls.forEach((url, i) => {
				const role = roles[i];
				resources.push(
					role === 'no-cache'
						? { ...plain(url), noCache: true }
						: role === 'no-store'
							? { ...plain(url), noStore: true }
							: { ...plain(url), maxAge: rng.pick(ages) }
				);
			});
			visits = times.map((t) => ({ t, kind: 'nav', lang: 'ru' }));
		} else if (classId === 'reload') {
			resources.push({ ...plain(doc), maxAge: rng.pick(ages) });
			const validators = rng.shuffle<Validator>(['etag', 'last-modified', rng.pick<Validator>(['etag', 'none'])]);
			urls.forEach((url, i) =>
				resources.push({ ...plain(url), maxAge: rng.pick(ages), validator: validators[i] ?? 'etag' })
			);
			visits = kinds(count, ['nav', 'reload', 'reload']).map((kind, i) => ({ t: times[i] ?? 0, kind, lang: 'ru' }));
		} else {
			resources.push({ ...plain(doc), noCache: rng.bool(), maxAge: rng.pick(ages) });
			urls.forEach((url) =>
				resources.push({
					...plain(url),
					maxAge: rng.pick(ages),
					validator: rng.pick<Validator>(['etag', 'last-modified'])
				})
			);
			visits = kinds(count, ['nav', 'reload', 'hard', 'hard']).map((kind, i) => ({
				t: times[i] ?? 0,
				kind,
				lang: 'ru'
			}));
		}
		for (const r of rng.sample(resources, rng.int(1, 2))) r.changes = [between(rng, times, 0)];
		const docResource = resources[0] as Resource;
		if (docResource.noCache) docResource.maxAge = null;
		subs = [urls];
	} else {
		const count = rng.int(4, 5);
		if (classId === 'hashed-urls') {
			const times = moments(rng, count, [30, 600]);
			const deploys = rng.int(1, 2);
			const deployAt = rng
				.sample(
					Array.from({ length: count - 1 }, (_, i) => i),
					deploys
				)
				.sort((a, b) => a - b)
				.map((i) => between(rng, times, i))
				.sort((a, b) => a - b);
			resources.push({ ...plain(doc), noCache: true, changes: deployAt });
			const names = ['style', 'app', 'vendor'].slice(0, rng.int(2, 3));
			const exts: Record<string, string> = { style: 'css', app: 'js', vendor: 'js' };
			let current = names.map((n) => ({ name: n, build: 1, url: `/assets/${n}.${hash(rng)}.${exts[n] ?? 'js'}` }));
			const lists: string[][] = [];
			const add = (): void => {
				lists.push(current.map((f) => f.url));
				for (const f of current) {
					if (!resources.some((r) => r.url === f.url)) {
						resources.push({ ...plain(f.url), maxAge: 31536000, immutable: true, build: f.build });
					}
				}
			};
			add();
			deployAt.forEach((_, d) => {
				const changed = rng.sample(current, rng.int(1, current.length - 1)).map((f) => f.name);
				current = current.map((f) =>
					changed.includes(f.name)
						? { name: f.name, build: d + 2, url: `/assets/${f.name}.${hash(rng)}.${exts[f.name] ?? 'js'}` }
						: f
				);
				add();
			});
			subs = lists;
			visits = kinds(count, ['nav', 'reload']).map((kind, i) => ({ t: times[i] ?? 0, kind, lang: 'ru' }));
		} else if (classId === 'single-url') {
			const times = moments(rng, count, [30, 200]);
			const deploy = between(rng, times, 0);
			resources.push({ ...plain(doc), noCache: true, changes: [deploy] });
			const age = rng.pick([300, 600, 900]);
			resources.push({ ...plain('/app.js'), maxAge: age, changes: [deploy] });
			resources.push({
				...plain('/style.css'),
				maxAge: rng.pick([300, 600, 900]),
				validator: 'last-modified',
				changes: rng.bool() ? [deploy] : []
			});
			subs = [['/style.css', '/app.js']];
			visits = kinds(count, ['nav', 'nav', 'reload']).map((kind, i) => ({ t: times[i] ?? 0, kind, lang: 'ru' }));
		} else if (classId === 'immutable-reload') {
			const times = moments(rng, count, [20, 160]);
			resources.push({ ...plain(doc), noCache: true });
			const urls = ['/fonts.css', '/app.js', '/logo.svg'];
			const flags = rng.shuffle([true, false, rng.bool()]);
			urls.forEach((url, i) =>
				resources.push({
					...plain(url),
					maxAge: rng.pick([60, 90, 120, 180]),
					immutable: flags[i] ?? false,
					validator: rng.pick<Validator>(['etag', 'last-modified'])
				})
			);
			const changed = rng.pick(resources.slice(1));
			changed.changes = [between(rng, times, 0)];
			subs = [urls];
			visits = kinds(count, ['nav', 'reload', 'reload']).map((kind, i) => ({ t: times[i] ?? 0, kind, lang: 'ru' }));
		} else {
			const times = moments(rng, count, [20, 160]);
			resources.push({ ...plain(doc), noCache: true });
			resources.push({
				...plain('/i18n/messages.json'),
				maxAge: rng.pick([300, 600]),
				vary: true,
				changes: [between(rng, times, 0)]
			});
			resources.push({ ...plain('/app.js'), maxAge: rng.pick([60, 120, 180]) });
			subs = [['/i18n/messages.json', '/app.js']];
			const first = rng.pick<'ru' | 'en'>(['ru', 'en']);
			const langs = [first, ...Array.from({ length: count - 1 }, () => rng.pick<'ru' | 'en'>(['ru', 'en']))];
			visits = langs.map((lang, i) => ({ t: times[i] ?? 0, kind: rng.bool(0.8) || i === 0 ? 'nav' : 'reload', lang }));
		}
	}
	return { origin, doc, resources, subs, visits, langs: resources.some((r) => r.vary) };
}

/** Whether no visit comes exactly when a response stored at an earlier visit stops being fresh. */
function clearOfBoundaries(p: Params): boolean {
	const times = p.visits.map((v) => v.t);
	for (const r of p.resources) {
		if (r.changes.some((c) => times.includes(c))) return false;
		if (r.maxAge === null) continue;
		for (const a of times) if (times.includes(a + r.maxAge)) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Statement.

function cacheControl(r: Resource): string {
	const parts: string[] = [];
	if (r.noCache) parts.push('no-cache');
	if (r.noStore) parts.push('no-store');
	if (r.maxAge !== null) parts.push(`max-age=${r.maxAge}`);
	if (r.immutable) parts.push('immutable');
	return parts.join(', ');
}

const VALIDATOR_TEXT: Record<Validator, string> = {
	etag: '`ETag`',
	'last-modified': '`Last-Modified`',
	none: 'нет (ни `ETag`, ни `Last-Modified`)'
};

const KIND_TEXT: Record<Kind, string> = {
	nav: 'переход по ссылке на страницу',
	reload: 'перезагрузка (F5)',
	hard: 'жёсткая перезагрузка (Ctrl+Shift+R)'
};

function describe(p: Params): string {
	const hashed = p.resources.some((r) => r.build !== null);
	const vary = p.resources.some((r) => r.vary);
	const rows = p.resources.map((r) => {
		const versions =
			r.build !== null
				? `файл сборки ${r.build}, не меняется`
				: r.changes.length
					? `v1, с момента ${r.changes.map((c, i) => `${c} — v${i + 2}`).join(', с момента ')}`
					: 'v1, не меняется';
		const extra = r.vary ? ', `Vary: Accept-Language`' : '';
		return `| \`${r.url}\` | \`${cacheControl(r)}\`${extra} | ${VALIDATOR_TEXT[r.validator]} | ${versions} |`;
	});
	const includes = hashed
		? [
				'Документ каждой сборки подключает свои файлы (в имени — хэш содержимого, поэтому файл с тем же именем не меняется):',
				'',
				...p.subs.map(
					(list, i) =>
						`- документ v${i + 1}${i === 0 ? '' : ` (сборка ${i + 1})`} подключает ${list.map((u) => `\`${u}\``).join(', ')};`
				)
			]
		: [`Документ \`${p.doc}\` подключает по порядку ${(p.subs[0] ?? []).map((u) => `\`${u}\``).join(', ')}.`];
	const visitHead = p.langs
		? '| # | момент | действие | Accept-Language |\n|---|---|---|---|'
		: '| # | момент | действие |\n|---|---|---|';
	const visitRows = p.visits.map((v, i) =>
		p.langs
			? `| ${i + 1} | ${v.t} | ${KIND_TEXT[v.kind]} | ${v.lang} |`
			: `| ${i + 1} | ${v.t} | ${KIND_TEXT[v.kind]} |`
	);
	const kinds = new Set(p.visits.map((v) => v.kind));
	const rules = [
		'- Кэш — кэш браузера одного пользователя, сначала он пуст; сервер отвечает мгновенно, внутри визита время не идёт. Сначала загружается документ, затем — подключённые им ресурсы по порядку.',
		'- Эвристическую свежесть по `Last-Modified` браузер не применяет: срок свежести есть только у ответов с `max-age`. Сервер на условный запрос отвечает `304`, если версия не изменилась.'
	];
	if (kinds.has('reload')) {
		rules.push(
			'- Браузер ведёт себя как Firefox: при перезагрузке (F5) он перепроверяет условным запросом каждый ресурс, сохранённый в кэше, даже свежий, — кроме свежих ответов с `immutable`, их он берёт из кэша.'
		);
	}
	if (kinds.has('hard')) {
		rules.push('- При жёсткой перезагрузке браузер запрашивает каждый ресурс заново, без условных заголовков.');
	}
	if (vary) {
		rules.push(
			'- Браузер хранит одну запись на URL. Пользователь переключает язык браузера, и он отправляет другой `Accept-Language`; у каждой языковой версии ресурса свой `ETag`.'
		);
	}
	const versionHelp = hashed
		? 'у документа — номер его версии, у файла с хэшем — номер сборки из таблицы'
		: vary
			? 'номер версии, а у ресурса с `Vary` — язык и номер, например `en2`'
			: 'номер версии из таблицы';
	return [
		`Страница \`${p.origin}${p.doc}\`. Сервер отдаёт ресурсы так (момент — в секундах от первого визита):`,
		'',
		'| ресурс | Cache-Control | валидатор | версии на сервере |',
		'|---|---|---|---|',
		...rows,
		'',
		...includes,
		'',
		'Условия:',
		'',
		...rules,
		'',
		'Визиты пользователя:',
		'',
		visitHead,
		...visitRows,
		'',
		`Для каждого визита по порядку, а внутри визита — для документа и затем для подключённых ресурсов по порядку, введите через пробел \`исход:версия\`. Исход: \`hit\` — ресурс взят из кэша без обращения к серверу, \`304\` — условный запрос и ответ 304, \`200\` — сервер отдал ресурс целиком. Версия — с какой версией ресурса отрисуется страница: ${versionHelp}. Например: \`200:1 200:1 hit:1 304:1\`.`
	].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The independent reference.

const PYTHON_REFERENCE = `import json

p = json.loads(input())
by_url = {r["url"]: r for r in p["resources"]}
stored = {}
tokens = []


def server_version(r, t):
    if r["build"] is not None:
        return r["build"]
    return 1 + len([c for c in r["changes"] if c <= t])


def name(r, v, lang):
    return (lang if r["vary"] else "") + str(v)


def fetch(r, visit):
    t = visit["t"]
    v = server_version(r, t)
    old = stored.get(r["url"])
    if r["noStore"]:
        tokens.append("200:" + name(r, v, visit["lang"]))
        return v
    if old is not None and r["vary"] and old["lang"] != visit["lang"]:
        old = None
    conditional = False
    if old is not None:
        if visit["kind"] == "hard":
            old = None
        else:
            fresh = not r["noCache"] and r["maxAge"] is not None and t - old["at"] < r["maxAge"]
            if fresh and (visit["kind"] == "nav" or r["immutable"]):
                tokens.append("hit:" + name(r, old["v"], old["lang"]))
                return old["v"]
            conditional = r["validator"] != "none"
    if conditional and old["v"] == v:
        old["at"] = t
        tokens.append("304:" + name(r, old["v"], old["lang"]))
        return v
    stored[r["url"]] = {"at": t, "v": v, "lang": visit["lang"]}
    tokens.append("200:" + name(r, v, visit["lang"]))
    return v


for visit in p["visits"]:
    dv = fetch(by_url[p["doc"]], visit)
    for url in p["subs"][min(dv, len(p["subs"])) - 1]:
        fetch(by_url[url], visit)
print(" ".join(tokens))
`;

/** Per class: misconceptions of which at least `min` must apply to every instance. */
const REQUIRED: Record<string, { ids: string[]; min: number }> = {
	'junior/validators': {
		ids: ['stale-full-fetch', 'last-modified-not-validator', 'no-validator-304', 'no-refresh-304'],
		min: 3
	},
	'junior/no-cache-no-store': { ids: ['no-cache-as-no-store', 'no-store-revalidates', 'hit-shows-current'], min: 2 },
	'junior/reload': { ids: ['reload-uses-cache', 'reload-full', 'no-refresh-304'], min: 2 },
	'junior/hard-reload': { ids: ['hard-reload-conditional', 'reload-full', 'stale-full-fetch'], min: 2 },
	'middle/hashed-urls': { ids: ['hashed-refetch', 'immutable-ignored'], min: 2 },
	'middle/single-url': { ids: ['hit-shows-current', 'deploy-refreshes-same-url'], min: 2 },
	'middle/immutable-reload': { ids: ['immutable-ignored', 'immutable-forever', 'reload-uses-cache'], min: 2 },
	'middle/vary': { ids: ['ignore-vary', 'stale-full-fetch'], min: 2 }
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? { ids: [], min: 0 };
	let chosen: { p: Params; answer: string; wrong: Record<string, string | null> } | undefined;
	// The draw settles within a few tries; if it never does, the last draw that keeps clear of freshness boundaries
	// is kept: a misconception that gives the right answer there is simply not applied to the instance.
	for (let tries = 0; tries < 300; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		if (!clearOfBoundaries(p)) continue;
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		chosen = { p, answer, wrong };
		if (required.ids.filter((id) => wrong[id] !== null).length >= required.min) break;
	}
	chosen ??= fallback(input);
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

/** A draw clear of boundaries by construction: visits at moments no freshness lifetime can separate. */
function fallback(input: GenerateInput): { p: Params; answer: string; wrong: Record<string, string | null> } {
	const rng = instanceRng(descriptor, { ...input, seed: `${input.seed}|fallback` });
	const p = scenario(rng, input.grade, input.classId);
	// Visits a prime number of seconds apart: no lifetime of the family is a multiple of it, so no visit falls on the
	// end of a freshness window; changes fall halfway between visits.
	p.visits = p.visits.map((v, i) => ({ ...v, t: i * 1009 }));
	for (const r of p.resources) r.changes = r.changes.map((_, k) => 1009 * (k + 1) - 500);
	const answer = simulate(p, RIGHT);
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = simulate(p, { ...RIGHT, ...change });
			return [id, value === answer ? null : value];
		})
	);
	return { p, answer, wrong };
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
