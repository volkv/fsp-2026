// Two tiers of HTTP caching seen from the client: each user's browser cache in front of a shared CDN in front of the
// origin. Which version every request shows and how many requests reach the origin: max-age against s-maxage, the Age
// a CDN copy carries into the browser, Vary, private, a purge of the CDN, stale-while-revalidate on both tiers and
// stale-if-error when the origin fails.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PERSON_NAMES } from '../../_lib/names.ts';
import { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Resource {
	path: string;
	maxAge: number;
	sMaxage: number | null;
	swr: number | null;
	staleIfError: number | null;
	private: boolean;
	vary: 'Accept-Encoding' | 'Cookie' | null;
	/** Moments the origin starts serving the next version. */
	changes: number[];
}

interface User {
	name: string;
	encoding: 'br' | 'gzip';
	/** The session cookie, or none for an anonymous visitor. */
	cookie: string | null;
}

interface Request {
	t: number;
	user: string;
	path: string;
}

interface Params {
	resources: Resource[];
	users: User[];
	requests: Request[];
	purges: { t: number; path: string }[];
	/** Moments [from, to], both included, when the origin answers 503 to everything. */
	outages: [number, number][];
}

interface Rules {
	age: boolean;
	browserSMaxage: boolean;
	cdnSMaxage: boolean;
	purgeClearsBrowser: boolean;
	vary: boolean;
	privateAtCdn: boolean;
	swr: 'right' | 'blocking' | 'no-background';
	browserSwr: boolean;
	cdnStaleIfError: 'right' | 'ignore' | 'forever';
	browserStaleIfError: boolean;
}

const RIGHT: Rules = {
	age: true,
	browserSMaxage: false,
	cdnSMaxage: true,
	purgeClearsBrowser: false,
	vary: true,
	privateAtCdn: false,
	swr: 'right',
	browserSwr: true,
	cdnStaleIfError: 'right',
	browserStaleIfError: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'ignore-age': { age: false },
	'browser-uses-s-maxage': { browserSMaxage: true },
	'cdn-uses-max-age': { cdnSMaxage: false },
	'purge-clears-browser': { purgeClearsBrowser: true },
	'ignore-vary': { vary: false },
	'private-at-cdn': { privateAtCdn: true },
	'swr-blocking': { swr: 'blocking' },
	'swr-no-background': { swr: 'no-background' },
	'swr-cdn-only': { browserSwr: false },
	'error-passthrough': { cdnStaleIfError: 'ignore' },
	'browser-stale-if-error': { browserStaleIfError: true },
	'stale-forever': { cdnStaleIfError: 'forever' }
};

const versionAt = (r: Resource, t: number): number => 1 + r.changes.filter((c) => c <= t).length;

interface Outcome {
	answer: string;
	/** Some age equals the end of a window exactly: the boundary is a matter of convention, such a scenario is redrawn. */
	tie: boolean;
}

function simulate(p: Params, rules: Rules): Outcome {
	const browser = new Map<string, { version: number; receivedAt: number; age: number }>();
	const cdn = new Map<string, { version: number; storedAt: number; path: string }>();
	let origin = 0;
	let tie = false;
	const out: string[] = [];
	const purges = [...p.purges].sort((a, b) => a.t - b.t);
	const down = (t: number): boolean => p.outages.some(([a, b]) => t >= a && t <= b);
	const below = (x: number, limit: number): boolean => {
		if (x === limit) tie = true;
		return x < limit;
	};

	/** The CDN serves a request of a user: the version (or null for an error) and the Age it sends. */
	const viaCdn = (r: Resource, user: User, t: number): { version: number | null; age: number } => {
		const variant =
			r.vary === null || !rules.vary ? '' : r.vary === 'Cookie' ? `c:${user.cookie ?? ''}` : `e:${user.encoding}`;
		const key = `${r.path}|${variant}`;
		const storable = !r.private || rules.privateAtCdn;
		const life = rules.cdnSMaxage ? (r.sMaxage ?? r.maxAge) : r.maxAge;
		const entry = storable ? cdn.get(key) : undefined;
		const fromOrigin = (): number | null => {
			origin += 1;
			if (down(t)) return null;
			const version = versionAt(r, t);
			if (storable) cdn.set(key, { version, storedAt: t, path: r.path });
			return version;
		};
		if (entry) {
			const age = t - entry.storedAt;
			if (below(age, life)) return { version: entry.version, age };
			if (r.swr !== null && rules.swr !== 'blocking' && below(age, life + r.swr)) {
				if (rules.swr === 'right') fromOrigin();
				return { version: entry.version, age };
			}
		}
		const version = fromOrigin();
		if (version !== null) return { version, age: 0 };
		if (entry && r.staleIfError !== null && rules.cdnStaleIfError !== 'ignore') {
			const age = t - entry.storedAt;
			if (rules.cdnStaleIfError === 'forever' || below(age, life + r.staleIfError))
				return { version: entry.version, age };
		}
		return { version: null, age: 0 };
	};

	for (const q of p.requests) {
		while (purges.length > 0 && (purges[0]?.t ?? Infinity) < q.t) {
			const purge = purges.shift();
			for (const [key, entry] of cdn) if (entry.path === purge?.path) cdn.delete(key);
			if (rules.purgeClearsBrowser)
				for (const key of browser.keys()) if (key.endsWith(`|${purge?.path}`)) browser.delete(key);
		}
		const r = p.resources.find((x) => x.path === q.path);
		const user = p.users.find((u) => u.name === q.user);
		if (!r || !user) throw new Error(`unknown request ${q.user} ${q.path}`);
		const key = `${user.name}|${r.path}`;
		const life = rules.browserSMaxage ? (r.sMaxage ?? r.maxAge) : r.maxAge;
		const store = (res: { version: number | null; age: number }): void => {
			if (res.version !== null) browser.set(key, { version: res.version, receivedAt: q.t, age: res.age });
		};
		const entry = browser.get(key);
		const current = entry ? (rules.age ? entry.age : 0) + (q.t - entry.receivedAt) : 0;
		if (entry) {
			if (below(current, life)) {
				out.push(`v${entry.version}`);
				continue;
			}
			if (r.swr !== null && rules.browserSwr && rules.swr !== 'blocking' && below(current, life + r.swr)) {
				out.push(`v${entry.version}`);
				if (rules.swr === 'right') store(viaCdn(r, user, q.t));
				continue;
			}
		}
		const res = viaCdn(r, user, q.t);
		store(res);
		if (res.version !== null) out.push(`v${res.version}`);
		else if (entry && rules.browserStaleIfError && r.staleIfError !== null && below(current, life + r.staleIfError))
			out.push(`v${entry.version}`);
		else out.push('err');
	}
	return { answer: [...out, String(origin)].join(' '), tie };
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const PATHS = ['/app.js', '/styles.css', '/api/menu', '/api/prices', '/catalog.json', '/banner.webp'] as const;

function resource(path: string, maxAge: number): Resource {
	return {
		path,
		maxAge,
		sMaxage: null,
		swr: null,
		staleIfError: null,
		private: false,
		vary: null,
		changes: []
	};
}

function usersOf(rng: Rng, count: number, vary: Resource['vary']): User[] {
	const names = rng.sample(PERSON_NAMES, count);
	return names.map((name, i) => ({
		name,
		// Under a Vary the users must not all share one variant.
		encoding:
			vary === 'Accept-Encoding' && i < 2 ? ((['br', 'gzip'] as const)[i] ?? 'br') : rng.pick(['br', 'gzip'] as const),
		cookie:
			vary === 'Cookie' && i < 2
				? i === 0
					? null
					: `sid=${rng.int(1000, 9999)}`
				: rng.bool(0.5)
					? null
					: `sid=${rng.int(1000, 9999)}`
	}));
}

/** Requests placed on free whole seconds; a skeleton puts the requests that expose the class first. */
class Timeline {
	readonly requests: Request[] = [];
	readonly #rng: Rng;

	constructor(rng: Rng) {
		this.#rng = rng;
	}

	/** A request at a free moment in [lo, hi]; false when there is none. */
	add(lo: number, hi: number, user: string, path: string): number | null {
		const free: number[] = [];
		for (let t = Math.max(1, lo); t <= hi; t += 1) if (!this.requests.some((q) => q.t === t)) free.push(t);
		if (free.length === 0) return null;
		const t = this.#rng.pick(free);
		this.requests.push({ t, user, path });
		return t;
	}

	sorted(): Request[] {
		return [...this.requests].sort((a, b) => a.t - b.t);
	}
}

function scenario(rng: Rng, classId: string): Params | null {
	const [pathA, pathB] = rng.sample(PATHS, 2) as [string, string];
	const resources: Resource[] = [];
	const purges: { t: number; path: string }[] = [];
	const outages: [number, number][] = [];
	const line = new Timeline(rng);
	let users: User[];
	let total: number;
	let span: number;
	if (classId === 'age-header') {
		// A copy that lay long in the CDN reaches a browser with a large Age and is fresh there only briefly.
		const maxAge = rng.pick([30, 40, 60, 90]);
		const sMaxage = maxAge * rng.pick([3, 4, 5]);
		users = usersOf(rng, rng.int(3, 4), null);
		const [u1, u2] = users as [User, User];
		const t1 = line.add(5, 40, u1.name, pathA) ?? 0;
		const t2 = line.add(t1 + sMaxage - maxAge + 1, t1 + sMaxage - 1, u2.name, pathA) ?? 0;
		const t4 = line.add(t1 + sMaxage + 1, t2 + maxAge - 1, u2.name, pathA);
		if (t4 === null) return null;
		total = rng.int(10, 12);
		span = t4 + rng.int(maxAge, 2 * maxAge);
		const changes = [rng.int(t1 + 1, t4 - 1)];
		if (rng.bool(0.6)) changes.push(rng.int(t4 + 1, span - 5));
		resources.push({ ...resource(pathA, maxAge), sMaxage, changes });
		const ageB = rng.pick([20, 30, 45, 60]);
		resources.push({
			...resource(pathB, ageB),
			sMaxage: rng.bool() ? ageB * rng.pick([2, 3]) : null,
			changes: [rng.int(20, span - 20)]
		});
	} else if (classId === 'purge-vary') {
		const vary = rng.pick(['Accept-Encoding', 'Cookie'] as const);
		const maxAge = rng.pick([60, 90, 120]);
		users = usersOf(rng, rng.int(3, 4), vary);
		const [u1, u2, u3] = users as [User, User, User];
		const change = rng.int(60, 120);
		const tA = line.add(change - Math.floor(maxAge / 3), change - 5, u1.name, pathA) ?? 0;
		const purge = change + rng.int(5, Math.floor(maxAge / 3));
		// The other variant asks after the change but before the purge; the first user comes back after the purge.
		if (line.add(change + 1, purge - 1, u2.name, pathA) === null) return null;
		if (line.add(purge + 1, tA + maxAge - 1, u1.name, pathA) === null) return null;
		purges.push({ t: purge, path: pathA });
		const privateAge = rng.pick([30, 45, 60]);
		const r1 = line.add(10, 200, u3.name, pathB) ?? 0;
		line.add(r1 + 1, r1 + privateAge - 1, rng.pick([u1, u2]).name, pathB);
		resources.push({ ...resource(pathA, maxAge), sMaxage: rng.pick([600, 900, 3600]), vary, changes: [change] });
		resources.push({ ...resource(pathB, privateAge), private: true, changes: [rng.int(40, 200)] });
		total = rng.int(10, 12);
		span = rng.int(240, 300);
	} else if (classId === 'swr-two-tier') {
		// The CDN refreshes in the background for one user while another user's browser still serves its stale copy.
		const maxAge = rng.pick([20, 30]);
		const sMaxage = 2 * maxAge;
		const swr = maxAge + rng.pick([15, 20, 30, 40]);
		users = usersOf(rng, rng.int(2, 3), null);
		const [u1, u2] = users as [User, User];
		const t1 = line.add(5, 30, u1.name, pathA) ?? 0;
		const x = line.add(t1 + sMaxage + 1, t1 + maxAge + swr - 3, u2.name, pathA);
		if (x === null) return null;
		if (line.add(x + 1, t1 + maxAge + swr - 1, u1.name, pathA) === null) return null;
		total = rng.int(10, 12);
		span = rng.int(220, 280);
		const changes = [rng.int(t1 + 1, t1 + sMaxage - 1)];
		if (rng.bool(0.6)) changes.push(rng.int(t1 + maxAge + swr + 1, span - 10));
		resources.push({ ...resource(pathA, maxAge), sMaxage, swr, changes });
		if (rng.bool(0.5)) {
			const ageB = rng.pick([30, 45, 60]);
			resources.push({ ...resource(pathB, ageB), sMaxage: ageB * 2, changes: [rng.int(30, span - 30)] });
		}
	} else {
		const maxAge = rng.pick([20, 30]);
		const sMaxage = 2 * maxAge;
		const staleIfError = rng.pick([40, 60, 90]);
		users = usersOf(rng, 3, null);
		const [u1, u2, u3] = users as [User, User, User];
		const t1 = line.add(5, 25, u1.name, pathA) ?? 0;
		const from = t1 + rng.int(maxAge + 1, sMaxage - 1);
		const to = t1 + sMaxage + staleIfError + rng.int(5, 30);
		outages.push([from, to]);
		// Within stale-if-error the CDN covers the outage; past it the user gets the error.
		if (line.add(Math.max(from, t1 + sMaxage + 1), t1 + sMaxage + staleIfError - 1, u2.name, pathA) === null)
			return null;
		if (line.add(t1 + sMaxage + staleIfError + 1, to, u3.name, pathA) === null) return null;
		// A purged path has nothing to fall back on in the CDN, whatever the browser still holds.
		const ageB = rng.pick([30, 45]);
		const errorB = rng.pick([60, 90]);
		const b1 = line.add(Math.max(1, from - ageB + 5), from - 5, u3.name, pathB);
		if (b1 === null) return null;
		const purge = from + rng.int(1, 10);
		if (line.add(Math.max(purge + 1, b1 + ageB + 1), Math.min(b1 + ageB + errorB - 1, to), u3.name, pathB) === null)
			return null;
		purges.push({ t: purge, path: pathB });
		resources.push({ ...resource(pathA, maxAge), sMaxage, staleIfError, changes: [rng.int(t1 + 1, from - 1)] });
		resources.push({ ...resource(pathB, ageB), sMaxage: 2 * ageB, staleIfError: errorB, changes: [] });
		total = rng.int(10, 12);
		span = to + rng.int(30, 60);
	}
	const paths = resources.map((r) => r.path);
	for (let guard = 0; line.requests.length < total && guard < 50; guard += 1)
		line.add(1, span, rng.pick(users).name, rng.pick(paths));
	return { resources, users, requests: line.sorted(), purges, outages };
}

function cacheControl(r: Resource): string {
	const parts: string[] = [];
	if (r.private) parts.push('private');
	parts.push(`max-age=${r.maxAge}`);
	if (r.sMaxage !== null) parts.push(`s-maxage=${r.sMaxage}`);
	if (r.swr !== null) parts.push(`stale-while-revalidate=${r.swr}`);
	if (r.staleIfError !== null) parts.push(`stale-if-error=${r.staleIfError}`);
	return parts.join(', ');
}

function describe(p: Params): string {
	const resourceLines = p.resources.map((r) => {
		const headers = [`\`Cache-Control: ${cacheControl(r)}\``];
		if (r.vary !== null) headers.push(`\`Vary: ${r.vary}\``);
		const change =
			r.changes.length === 0
				? '; ресурс не меняется'
				: r.changes.length === 1
					? `; источник начинает отдавать следующую версию в момент ${r.changes[0]}`
					: `; источник начинает отдавать следующую версию в моменты ${r.changes.join(' и ')}`;
		return `- \`GET ${r.path}\` — ${headers.join(', ')}${change}.`;
	});
	const userLines = p.users.map(
		(u) =>
			`- ${u.name}: \`Accept-Encoding: ${u.encoding}\`, ${u.cookie === null ? 'без куки (не вошёл)' : `\`Cookie: ${u.cookie}\``}`
	);
	const events: string[] = [];
	for (const purge of p.purges) events.push(`- в момент ${purge.t} команда очищает в CDN путь \`${purge.path}\`;`);
	for (const [a, b] of p.outages)
		events.push(`- с ${a} по ${b} включительно источник на любой запрос отвечает \`503\`;`);
	const rows = p.requests.map((q, i) => `| ${i + 1} | ${q.t} | ${q.user} | \`GET ${q.path}\` |`);
	return [
		'Сайт отдаётся через CDN — общий кэш перед источником; у каждого пользователя свой браузер со своим HTTP-кэшем. Все кэши пусты до первого запроса; первая версия каждого ресурса — `v1`, следующие — `v2`, `v3`.',
		'',
		'Ресурсы и заголовки, с которыми их отдаёт источник:',
		'',
		...resourceLines,
		'',
		'Пользователи:',
		'',
		...userLines,
		'',
		...(events.length ? ['События:', '', ...events, ''] : []),
		'Считаем, что:',
		'',
		'- источник и CDN отвечают мгновенно, фоновые обновления завершаются в тот же момент;',
		'- валидаторов (ETag, Last-Modified) нет: несвежую копию запрашивают заново целиком;',
		'- CDN выполняет Cache-Control и Vary по RFC 9111 и RFC 5861 и передаёт заголовок `Age` — сколько секунд отдаваемая копия пролежала в CDN (у ответа, только что полученного от источника, — 0);',
		'- одно отступление от RFC 9111: как большинство CDN, эта CDN применяет `stale-while-revalidate` и `stale-if-error` и к ответам с `s-maxage` (строгий RFC 9111 запрещает общему кэшу отдавать копию, несвежую по `s-maxage`, без проверки у источника — здесь этот запрет не действует);',
		'- окна `stale-while-revalidate` и `stale-if-error` отсчитываются от момента, когда копия перестала быть свежей на своей ступени: копия годится, пока её возраст меньше срока свежести плюс окно;',
		'- браузер выполняет RFC 9111 и поддерживает `stale-while-revalidate`, но не `stale-if-error`; его фоновое обновление — обычный запрос в CDN, и CDN отвечает на него по тем же правилам, в том числе несвежей копией со своим `Age`;',
		'- очистка удаляет из CDN все записи пути; ответы с ошибкой не кэшируются.',
		'',
		'Запросы (момент — в секундах от начала):',
		'',
		'| # | момент | пользователь | запрос |',
		'|---|---|---|---|',
		...rows,
		'',
		'Введите через пробел для каждого запроса по порядку, какую версию увидел пользователь (`v1`, `v2`, `v3`) или `err`, если он получил ошибку; последним значением — сколько всего запросов дошло до источника, включая фоновые. Например: `v1 v1 v2 err 4`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
res = {r["path"]: r for r in p["resources"]}
users = {u["name"]: u for u in p["users"]}
purges = sorted(p["purges"], key=lambda x: x["t"])
browser = {}
cdn = {}
hits = [0]


def outage(t):
    return any(a <= t <= b for a, b in p["outages"])


def version(r, t):
    return 1 + len([c for c in r["changes"] if c <= t])


def origin(r, t, key):
    hits[0] += 1
    if outage(t):
        return None
    v = version(r, t)
    if key is not None:
        cdn[key] = (v, t)
    return v


def edge(r, u, t):
    """(version or None, Age) the CDN answers with."""
    if r["private"]:
        return origin(r, t, None), 0
    if r["vary"] == "Cookie":
        key = (r["path"], u["cookie"])
    elif r["vary"] == "Accept-Encoding":
        key = (r["path"], u["encoding"])
    else:
        key = (r["path"],)
    ttl = r["sMaxage"] if r["sMaxage"] is not None else r["maxAge"]
    held = cdn.get(key)
    if held is not None:
        age = t - held[1]
        if age < ttl:
            return held[0], age
        if r["swr"] is not None and age < ttl + r["swr"]:
            origin(r, t, key)
            return held[0], age
    v = origin(r, t, key)
    if v is not None:
        return v, 0
    if held is not None and r["staleIfError"] is not None and t - held[1] < ttl + r["staleIfError"]:
        return held[0], t - held[1]
    return None, 0


out = []
for q in p["requests"]:
    t = q["t"]
    while purges and purges[0]["t"] < t:
        gone = purges.pop(0)["path"]
        for k in [k for k in cdn if k[0] == gone]:
            del cdn[k]
    r = res[q["path"]]
    u = users[q["user"]]
    mine = (u["name"], r["path"])
    copy = browser.get(mine)
    if copy is not None:
        v, got, age = copy
        current = age + (t - got)
        if current < r["maxAge"]:
            out.append("v%d" % v)
            continue
        if r["swr"] is not None and current < r["maxAge"] + r["swr"]:
            out.append("v%d" % v)
            nv, nage = edge(r, u, t)
            if nv is not None:
                browser[mine] = (nv, t, nage)
            continue
    v, age = edge(r, u, t)
    if v is None:
        out.append("err")
    else:
        browser[mine] = (v, t, age)
        out.append("v%d" % v)
out.append(str(hits[0]))
print(" ".join(out))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/age-header': ['ignore-age', 'cdn-uses-max-age'],
	'senior/purge-vary': ['purge-clears-browser', 'ignore-vary', 'private-at-cdn'],
	'senior/swr-two-tier': ['swr-blocking', 'swr-no-background', 'swr-cdn-only'],
	'senior/stale-if-error': ['error-passthrough', 'stale-forever', 'browser-stale-if-error']
};

interface Attempt {
	params: Params;
	answer: string;
	wrong: Record<string, string | null>;
}

function attempt(rng: Rng, classId: string, required: readonly string[]): Attempt | null {
	const params = scenario(rng, classId);
	if (params === null) return null;
	const right = simulate(params, RIGHT);
	if (right.tie) return null;
	const times = params.requests.map((q) => q.t);
	if (params.purges.some((x) => times.includes(x.t))) return null;
	if (params.resources.some((r) => r.changes.some((c) => times.includes(c)))) return null;
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => {
			const value = simulate(params, { ...RIGHT, ...change }).answer;
			return [id, value === right.answer ? null : value];
		})
	);
	if (required.some((id) => wrong[id] === null)) return null;
	return { params, answer: right.answer, wrong };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	let found: Attempt | null = null;
	for (let tries = 0; tries < 400 && found === null; tries += 1) found = attempt(rng, input.classId, required);
	// A fixed stream that is known to settle keeps the generator total.
	const fallback = new Rng(`${descriptor.key}|${input.grade}|${input.classId}|fallback`);
	for (let tries = 0; tries < 400 && found === null; tries += 1) found = attempt(fallback, input.classId, required);
	if (found === null) throw new Error(`${descriptor.key}: no scenario for ${input.classId}`);
	const { params, answer, wrong } = found;
	const instance = makeInstance(descriptor, input, {
		statement: { markdown: describe(params), code: null },
		answer: { kind: 'tokens', value: answer }
	});
	return {
		instance,
		reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(params) }),
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
