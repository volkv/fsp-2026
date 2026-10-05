// HTTP caching: which requests a cache answers itself and which reach the server, with what code — `max-age`,
// `no-cache` against `no-store`, ETag and `If-None-Match` → 304; a level up, a shared cache with `Vary`, `s-maxage`,
// `private` and `stale-while-revalidate`.
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

interface Resource {
	path: string;
	maxAge: number | null;
	sMaxage: number | null;
	swr: number | null;
	noCache: boolean;
	noStore: boolean;
	private: boolean;
	vary: boolean;
	etag: boolean;
	/** `Expires` set by the server this many seconds after its answer. */
	expires: number | null;
	/** `stale-if-error`, seconds. */
	staleIfError: number | null;
	/** Moments the resource changes on the server; each change gives a new version. */
	changes: number[];
}

interface Request {
	t: number;
	client: string;
	path: string;
	lang: 'ru' | 'en';
}

interface Params {
	shared: boolean;
	resources: Resource[];
	requests: Request[];
	/** Moments [from, to] when the server answers 500 to every request. */
	outages: [number, number][];
}

interface Rules {
	revalidate: boolean;
	etagRequired: boolean;
	refresh304: boolean;
	noCache: 'right' | 'no-store' | 'fresh';
	vary: boolean;
	sMaxage: boolean;
	privateStored: boolean;
	swr: 'right' | 'blocking' | 'no-background';
	expiresWins: boolean;
	staleIfError: 'right' | 'ignore' | 'forever';
}

const RIGHT: Rules = {
	revalidate: true,
	etagRequired: true,
	refresh304: true,
	noCache: 'right',
	vary: true,
	sMaxage: true,
	privateStored: false,
	swr: 'right',
	expiresWins: false,
	staleIfError: 'right'
};

const WRONG: Record<string, Partial<Rules>> = {
	'stale-full-fetch': { revalidate: false },
	'no-refresh-304': { refresh304: false },
	'revalidate-without-etag': { etagRequired: false },
	'no-cache-not-stored': { noCache: 'no-store' },
	'no-cache-as-fresh': { noCache: 'fresh' },
	'ignore-vary': { vary: false },
	'ignore-s-maxage': { sMaxage: false },
	'private-cached': { privateStored: true },
	'swr-blocking': { swr: 'blocking' },
	'swr-no-background': { swr: 'no-background' },
	'expires-wins': { expiresWins: true },
	'error-passthrough': { staleIfError: 'ignore' },
	'stale-forever': { staleIfError: 'forever' }
};

const versionAt = (r: Resource, t: number): number => 1 + r.changes.filter((c) => c <= t).length;

/** Per request: `hit`, `stale`, `304` or `200`; on the middle level, then the number of requests the server got. */
function simulate(p: Params, rules: Rules): string {
	const cache = new Map<string, { storedAt: number; version: number }>();
	const out: string[] = [];
	let served = 0;
	for (const q of p.requests) {
		const r = p.resources.find((x) => x.path === q.path);
		if (!r) throw new Error(`no resource ${q.path}`);
		const key = r.vary && rules.vary ? `${r.path}|${q.lang}` : r.path;
		const noStore = r.noStore || (r.noCache && rules.noCache === 'no-store');
		const storable = !noStore && !(p.shared && r.private && !rules.privateStored);
		const ownLifetime = rules.expiresWins ? (r.expires ?? r.maxAge) : (r.maxAge ?? r.expires);
		const lifetime = (p.shared && rules.sMaxage ? r.sMaxage : null) ?? ownLifetime ?? 0;
		const mustRevalidate = r.noCache && rules.noCache === 'right';
		const current = versionAt(r, q.t);
		const entry = storable ? cache.get(key) : undefined;
		const fetch = (): string => {
			served += 1;
			if (p.outages.some(([from, to]) => q.t >= from && q.t <= to)) {
				const window = r.staleIfError;
				const age = entry ? q.t - entry.storedAt : 0;
				const usable =
					entry !== undefined &&
					window !== null &&
					rules.staleIfError !== 'ignore' &&
					(rules.staleIfError === 'forever' || age < lifetime + window);
				return usable ? 'stale' : '500';
			}
			if (entry && (r.etag || !rules.etagRequired) && rules.revalidate && entry.version === current) {
				if (rules.refresh304) entry.storedAt = q.t;
				return '304';
			}
			if (storable) cache.set(key, { storedAt: q.t, version: current });
			return '200';
		};
		if (!entry) {
			out.push(fetch());
			continue;
		}
		const age = q.t - entry.storedAt;
		if (!mustRevalidate && age < lifetime) {
			out.push('hit');
		} else if (!mustRevalidate && r.swr !== null && age < lifetime + r.swr && rules.swr !== 'blocking') {
			out.push('stale');
			if (rules.swr === 'right') fetch();
		} else {
			out.push(fetch());
		}
	}
	return p.shared ? [...out, String(served)].join(' ') : out.join(' ');
}

const PATHS = ['/api/rates', '/api/catalog', '/api/profile', '/api/menu', '/api/news', '/api/prices'] as const;
const CLIENTS = ['anna', 'boris', 'vera', 'gleb', 'dina', 'egor'] as const;

function plain(path: string): Resource {
	return {
		path,
		maxAge: null,
		sMaxage: null,
		swr: null,
		noCache: false,
		noStore: false,
		private: false,
		vary: false,
		etag: true,
		expires: null,
		staleIfError: null,
		changes: []
	};
}

/** Distinct request moments over a span, in order. */
function moments(rng: Rng, count: number, span: number): number[] {
	return rng
		.sample(
			Array.from({ length: span }, (_, i) => i + 1),
			count
		)
		.sort((a, b) => a - b);
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const [pathA, pathB] = rng.sample(PATHS, 2) as [string, string];
	const resources: Resource[] = [];
	let count: number;
	let span: number;
	if (grade === 'junior') {
		count = rng.int(7, 9);
		span = rng.int(110, 160);
		if (classId === 'max-age-etag') {
			resources.push({ ...plain(pathA), maxAge: rng.pick([20, 30, 40]), changes: [rng.int(40, span - 20)] });
		} else if (classId === 'no-cache-no-store') {
			resources.push({
				...plain(pathA),
				noCache: true,
				maxAge: rng.pick([60, 120, 300]),
				changes: [rng.int(20, span - 20)]
			});
			resources.push({ ...plain(pathB), noStore: true, etag: rng.bool(), changes: [] });
		} else if (classId === 'expires') {
			resources.push({
				...plain(pathA),
				maxAge: rng.pick([20, 30]),
				expires: rng.pick([10, 60, 90]),
				changes: [rng.int(30, span - 20)]
			});
			resources.push({ ...plain(pathB), expires: rng.pick([20, 30, 40]), changes: [] });
		} else {
			resources.push({ ...plain(pathA), maxAge: rng.pick([20, 30]), changes: [rng.int(30, span - 20)] });
			resources.push({ ...plain(pathB), maxAge: rng.pick([20, 30, 40]), etag: false, changes: [] });
		}
	} else {
		count = rng.int(8, 10);
		span = rng.int(120, 180);
		if (classId === 'vary') {
			resources.push({
				...plain(pathA),
				maxAge: rng.pick([30, 40, 60]),
				vary: true,
				changes: [rng.int(50, span - 20)]
			});
		} else if (classId === 's-maxage-private') {
			const maxAge = rng.pick([10, 15, 20]);
			resources.push({
				...plain(pathA),
				maxAge,
				sMaxage: maxAge * rng.pick([3, 4]),
				changes: [rng.int(40, span - 20)]
			});
			resources.push({ ...plain(pathB), maxAge: rng.pick([60, 120]), private: true, changes: [] });
		} else if (classId === 'stale-if-error') {
			resources.push({
				...plain(pathA),
				maxAge: rng.pick([15, 20, 30]),
				staleIfError: rng.pick([20, 30, 60]),
				changes: [rng.int(40, span - 20)]
			});
		} else {
			resources.push({
				...plain(pathA),
				maxAge: rng.pick([15, 20, 30]),
				swr: rng.pick([20, 30, 40]),
				changes: [rng.int(40, span - 20)]
			});
		}
	}
	const paths = resources.map((r) => r.path);
	const requests: Request[] = moments(rng, count, span).map((t) => ({
		t,
		client: rng.pick(CLIENTS),
		path: rng.pick(paths),
		lang: rng.pick(['ru', 'en'] as const)
	}));
	const outages: [number, number][] = [];
	if (classId === 'stale-if-error') {
		for (let k = rng.int(1, 2), from = rng.int(20, 50); k > 0; k -= 1) {
			const to = from + rng.int(10, 40);
			outages.push([from, to]);
			from = to + rng.int(15, 40);
		}
	}
	return { shared: grade === 'middle', resources, requests, outages };
}

function directives(r: Resource): string {
	const parts: string[] = [];
	if (r.private) parts.push('private');
	if (r.noCache) parts.push('no-cache');
	if (r.noStore) parts.push('no-store');
	if (r.maxAge !== null) parts.push(`max-age=${r.maxAge}`);
	if (r.sMaxage !== null) parts.push(`s-maxage=${r.sMaxage}`);
	if (r.swr !== null) parts.push(`stale-while-revalidate=${r.swr}`);
	if (r.staleIfError !== null) parts.push(`stale-if-error=${r.staleIfError}`);
	return parts.join(', ');
}

function describe(p: Params): string {
	const resourceLines = p.resources.map((r) => {
		const cc = directives(r);
		const headers = cc ? [`\`Cache-Control: ${cc}\``] : [];
		if (r.expires !== null) headers.push(`\`Expires\` — момент ответа плюс ${r.expires} с`);
		if (r.vary) headers.push('`Vary: Accept-Language`');
		headers.push(r.etag ? 'ETag текущей версии' : 'без ETag и Last-Modified');
		const change = r.changes.length
			? `; ресурс меняется на сервере в момент ${r.changes.join(', ')}`
			: '; ресурс не меняется';
		return `- \`GET ${r.path}\` — ${headers.join(', ')}${change}.`;
	});
	const rules = [
		'- Ответ сохраняется в кэше вместе с ETag, если директивы это разрешают. Сохранённый ответ свежий, пока с момента его получения прошло меньше срока свежести (в секундах); свежий ответ кэш отдаёт сам — `hit`.',
		'- `no-cache` — ответ хранится, но перед каждым использованием перепроверяется на сервере. `no-store` — ответ не хранится вовсе.',
		'- Перепроверка: если у сохранённого ответа есть ETag, кэш шлёт условный запрос `If-None-Match`; сервер отвечает `304`, если версия не изменилась, — тогда момент получения сохранённого ответа обновляется, и он снова свежий на весь срок. Если версия изменилась или ETag нет — сервер отдаёт `200` с текущей версией, и она заменяет сохранённую.'
	];
	if (p.resources.some((r) => r.expires !== null)) {
		rules.push(
			'- `Expires` — момент, до которого ответ свежий; если в ответе есть `max-age`, `Expires` не учитывается. Ответ `304` приносит те же заголовки, что и `200`.'
		);
	}
	if (p.outages.length) {
		rules.push(
			`- Сервер недоступен и на любой запрос отвечает \`500\` в моменты ${p.outages.map(([a, b]) => `с ${a} по ${b}`).join(' и ')} включительно. Ответ \`500\` не сохраняется.`,
			'- `stale-if-error=S` — если на запрос кэша (перепроверку или новый запрос) сервер ответил ошибкой, а срок свежести сохранённого ответа истёк меньше чем S секунд назад, клиент получает сохранённый ответ (`stale`); иначе клиент получает `500`.'
		);
	}
	if (p.shared) {
		rules.push(
			'- Кэш общий: это прокси перед сервером, им пользуются все клиенты. Для общего кэша `s-maxage` заменяет `max-age`; ответ с `private` общий кэш не хранит.',
			'- `Vary: Accept-Language` — для каждого значения заголовка `Accept-Language` в кэше своя запись.',
			'- `stale-while-revalidate=S` — если срок свежести истёк меньше чем S секунд назад, кэш сразу отдаёт клиенту сохранённый ответ (`stale`) и в тот же момент перепроверяет его на сервере в фоне; результат фоновой перепроверки обновляет кэш. Позже окна — обычная перепроверка до ответа клиенту.',
			'- Сервер отвечает мгновенно.'
		);
	} else {
		rules.unshift('- Кэш — кэш браузера одного клиента; сервер отвечает мгновенно.');
	}
	const header = p.shared
		? '| # | момент | клиент | запрос | Accept-Language |\n|---|---|---|---|---|'
		: '| # | момент | запрос |\n|---|---|---|';
	const rows = p.requests.map((q, i) =>
		p.shared
			? `| ${i + 1} | ${q.t} | ${q.client} | \`GET ${q.path}\` | ${q.lang} |`
			: `| ${i + 1} | ${q.t} | \`GET ${q.path}\` |`
	);
	const answer = p.shared
		? `Введите через пробел для каждого запроса клиента по порядку, как он обслужен: \`hit\` — свежим ответом из кэша, \`stale\` — старым ответом по \`${p.outages.length ? 'stale-if-error' : 'stale-while-revalidate'}\`, ${p.outages.length ? '`304`, `200` или `500`' : '`304` или `200`'} — ответом сервера на запрос кэша; последним значением — сколько всего запросов получил сервер, включая фоновые. Например: \`200 hit stale 304 3\`.`
		: 'Введите через пробел для каждого запроса по порядку, как он обслужен: `hit` — из кэша без обращения к серверу, иначе код ответа сервера — `304` или `200`. Например: `200 hit 304`.';
	return [
		'Ресурсы и заголовки, с которыми сервер их отдаёт (кэш пуст до первого запроса):',
		'',
		...resourceLines,
		'',
		'Правила кэша:',
		'',
		...rules,
		'',
		'Запросы (момент — в секундах от начала):',
		'',
		header,
		...rows,
		'',
		answer
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
res = {r["path"]: r for r in p["resources"]}
cache = {}
out = []
server = 0


def version(r, t):
    return 1 + sum(1 for c in r["changes"] if c <= t)


for q in p["requests"]:
    r = res[q["path"]]
    t = q["t"]
    key = (r["path"], q["lang"] if r["vary"] else "")
    keep = not r["noStore"] and not (p["shared"] and r["private"])
    if p["shared"] and r["sMaxage"] is not None:
        ttl = r["sMaxage"]
    elif r["maxAge"] is not None:
        ttl = r["maxAge"]
    else:
        ttl = r["expires"] or 0
    v = version(r, t)
    entry = cache.get(key) if keep else None
    if entry is not None and not r["noCache"] and t - entry["at"] < ttl:
        out.append("hit")
        continue
    background = (
        entry is not None
        and not r["noCache"]
        and r["swr"] is not None
        and t - entry["at"] < ttl + r["swr"]
    )
    server += 1
    if any(a <= t <= b for a, b in p["outages"]):
        fallback = r["staleIfError"]
        ok = entry is not None and fallback is not None and t - entry["at"] < ttl + fallback
        out.append("stale" if ok else "500")
        continue
    if entry is not None and r["etag"] and entry["v"] == v:
        entry["at"] = t
        code = "304"
    else:
        if keep:
            cache[key] = {"at": t, "v": v}
        code = "200"
    out.append("stale" if background else code)
if p["shared"]:
    out.append(str(server))
print(" ".join(out))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/max-age-etag': ['stale-full-fetch', 'no-refresh-304'],
	'junior/no-cache-no-store': ['no-cache-not-stored', 'no-cache-as-fresh'],
	'junior/without-etag': ['revalidate-without-etag', 'stale-full-fetch'],
	'middle/vary': ['ignore-vary', 'stale-full-fetch'],
	'middle/s-maxage-private': ['ignore-s-maxage', 'private-cached'],
	'middle/swr': ['swr-blocking', 'swr-no-background'],
	'junior/expires': ['expires-wins'],
	'middle/stale-if-error': ['error-passthrough', 'stale-forever']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = simulate(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if (required.some((id) => wrong[id] === null)) continue;
		// No request falls exactly on the end of a freshness window: the boundary is a matter of convention.
		if (!clearOfBoundaries(p)) continue;
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

/**
 * Whether no request comes exactly when a stored response stops being fresh or leaves the stale window, and none
 * comes at the moment of a change: every request time differs from every such edge of every possible storing moment.
 */
function clearOfBoundaries(p: Params): boolean {
	const times = p.requests.map((q) => q.t);
	for (const r of p.resources) {
		if (r.changes.some((c) => times.includes(c))) return false;
		const life = r.sMaxage ?? r.maxAge ?? r.expires ?? 0;
		const spans = [
			r.maxAge,
			r.sMaxage,
			r.expires,
			r.swr === null ? null : life + r.swr,
			r.staleIfError === null ? null : life + r.staleIfError
		].filter((x): x is number => x !== null);
		for (const stored of times) for (const span of spans) if (times.includes(stored + span)) return false;
	}
	return true;
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
