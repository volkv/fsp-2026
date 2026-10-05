// Conditional requests between two or three clients: If-Match, If-None-Match and If-Modified-Since over one resource
// with ETag and second-precision Last-Modified; the tester predicts the code of every response and the final version.
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

/** A header value: the client's saved ETag, a literal version, or `*`. */
type Tag = { kind: 'own' } | { kind: 'literal'; version: number } | { kind: 'star' };

interface Req {
	/** Milliseconds from 12:00:00.000. */
	t: number;
	client: string;
	method: 'GET' | 'PUT' | 'DELETE';
	ifMatch: Tag | null;
	ifNoneMatch: Tag | null;
	/** If-Modified-Since with the client's saved Last-Modified. */
	ifModifiedSince: boolean;
}

interface Params {
	weak: boolean;
	fractional: boolean;
	version: number;
	/** The last write before the requests, ms from 12:00:00 (negative). */
	lastWrite: number;
	requests: Req[];
}

interface Rules {
	lastWriteWins: boolean;
	putKeepsEtag: boolean;
	missingAs412: boolean;
	noPreconditionOk: boolean;
	imsStrict: boolean;
	weakMatches: boolean;
	bothConditions: boolean;
	msPrecision: boolean;
	starAlwaysMatches: boolean;
}

const RIGHT: Rules = {
	lastWriteWins: false,
	putKeepsEtag: false,
	missingAs412: false,
	noPreconditionOk: false,
	imsStrict: false,
	weakMatches: false,
	bothConditions: false,
	msPrecision: false,
	starAlwaysMatches: false
};

/**
 * The codes in order and the final version (`v<n>` or `deleted`), under a model of the contract; `null` when a request
 * refers to a saved ETag or Last-Modified its client does not have yet.
 */
function simulate(p: Params, rules: Rules): string | null {
	let exists = true;
	let version = p.version;
	let last = p.version;
	let written = p.lastWrite;
	const memory = new Map<string, { version: number; lm: number }>();
	const header = (ms: number): number => (rules.msPrecision ? ms : Math.floor(ms / 1000) * 1000);
	const codes: string[] = [];
	for (const r of p.requests) {
		const saved = memory.get(r.client);
		const usesSaved = r.ifModifiedSince || r.ifMatch?.kind === 'own' || r.ifNoneMatch?.kind === 'own';
		if (usesSaved && !saved) return null;
		const value = (tag: Tag): number | '*' =>
			tag.kind === 'star' ? '*' : tag.kind === 'literal' ? tag.version : (saved?.version ?? -1);
		const weakEqual = (tag: Tag): boolean => {
			const v = value(tag);
			return exists && (v === '*' || v === version);
		};
		const strongEqual = (tag: Tag): boolean => {
			const v = value(tag);
			if (v === '*') return exists || rules.starAlwaysMatches;
			return exists && v === version && (!p.weak || rules.weakMatches);
		};
		const remember = (): void => {
			memory.set(r.client, { version, lm: header(written) });
		};
		if (r.method === 'GET') {
			if (!exists) {
				codes.push('404');
				continue;
			}
			const ims = saved?.lm ?? 0;
			const unchangedSince = rules.imsStrict ? header(written) < ims : header(written) <= ims;
			let notModified: boolean;
			if (r.ifNoneMatch && r.ifModifiedSince && rules.bothConditions)
				notModified = weakEqual(r.ifNoneMatch) || unchangedSince;
			else if (r.ifNoneMatch) notModified = weakEqual(r.ifNoneMatch);
			else if (r.ifModifiedSince) notModified = unchangedSince;
			else notModified = false;
			codes.push(notModified ? '304' : '200');
			remember();
			continue;
		}
		let proceed: boolean;
		let code = '';
		if (r.method === 'PUT' && r.ifNoneMatch?.kind === 'star') {
			proceed = !exists;
			if (exists) code = '412';
		} else if (!r.ifMatch) {
			proceed = rules.noPreconditionOk;
			if (!proceed) code = rules.missingAs412 ? '412' : '428';
		} else if (rules.lastWriteWins && r.ifMatch.kind !== 'star') {
			proceed = exists;
			if (!exists) code = '412';
		} else {
			proceed = strongEqual(r.ifMatch);
			if (!proceed) code = '412';
		}
		if (!proceed) {
			codes.push(code);
			continue;
		}
		if (r.method === 'DELETE') {
			codes.push(exists ? '204' : '404');
			exists = false;
			continue;
		}
		codes.push(exists ? '200' : '201');
		exists = true;
		last += 1;
		version = last;
		written = r.t;
		if (!rules.putKeepsEtag) remember();
	}
	return [...codes, exists ? `v${version}` : 'deleted'].join(' ');
}

type Kind =
	| 'get'
	| 'get-inm'
	| 'get-ims'
	| 'get-both'
	| 'get-inm-old'
	| 'put-own'
	| 'put-old'
	| 'put-none'
	| 'put-star'
	| 'put-create'
	| 'del-own'
	| 'del-none';

interface Mix {
	kinds: Readonly<Partial<Record<Kind, number>>>;
	clients: readonly string[];
	count: [number, number];
	/** Gaps between requests, ms. */
	gap: [number, number];
	weak: boolean;
	fractional: boolean;
}

const MIXES: Record<string, Mix> = {
	'middle/lost-update': {
		kinds: { get: 2, 'put-own': 4, 'get-inm': 1 },
		clients: ['A', 'B'],
		count: [6, 8],
		gap: [2, 20],
		weak: false,
		fractional: false
	},
	'middle/own-write-etag': {
		kinds: { 'put-own': 4, 'get-inm': 2, get: 1 },
		clients: ['A', 'A', 'B'],
		count: [6, 8],
		gap: [2, 20],
		weak: false,
		fractional: false
	},
	'middle/missing-precondition': {
		kinds: { 'put-none': 2, 'del-none': 1, 'put-own': 3, get: 1, 'get-inm': 1 },
		clients: ['A', 'B'],
		count: [6, 8],
		gap: [2, 20],
		weak: false,
		fractional: false
	},
	'middle/if-modified-since': {
		kinds: { 'get-ims': 4, 'put-own': 2, get: 1 },
		clients: ['A', 'B'],
		count: [6, 8],
		gap: [2, 20],
		weak: false,
		fractional: false
	},
	'senior/weak-etag': {
		kinds: { 'put-own': 3, 'get-inm': 2, 'put-star': 1, get: 1, 'get-inm-old': 1 },
		clients: ['A', 'B', 'C'],
		count: [7, 9],
		gap: [2, 20],
		weak: true,
		fractional: false
	},
	'senior/inm-overrides-ims': {
		kinds: { 'get-both': 4, 'put-own': 2, 'put-star': 1, get: 1, 'get-ims': 1 },
		clients: ['A', 'B', 'C'],
		count: [7, 9],
		gap: [2, 20],
		weak: false,
		fractional: false
	},
	'senior/create-and-delete': {
		kinds: { 'del-own': 2, 'put-create': 2, 'put-star': 2, get: 2, 'get-inm': 1, 'put-own': 1 },
		clients: ['A', 'B', 'C'],
		count: [7, 9],
		gap: [2, 20],
		weak: false,
		fractional: false
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

/**
 * Two writes within one second: a client writes and saves Last-Modified, another client overwrites in the same second,
 * and later the first client asks with If-Modified-Since. Other requests go around the burst.
 */
function secondBurst(rng: Rng): Params {
	const version = rng.int(2, 9);
	const lastWrite = -rng.int(30, 600) * 1000 - rng.int(0, 9) * 100;
	const [x, y, z] = rng.shuffle(['A', 'B', 'C']) as [string, string, string];
	const base = { ifMatch: null, ifNoneMatch: null, ifModifiedSince: false };
	const requests: Req[] = [];
	let t = rng.int(1, 4) * 1000 + rng.int(0, 9) * 100;
	const step = (): number => rng.int(3, 25) * 100;
	requests.push({ ...base, t, client: x, method: 'GET' });
	if (rng.bool()) {
		t += step();
		requests.push({ ...base, t, client: z, method: 'GET' });
	}
	const second = Math.floor((t + rng.int(1, 3) * 1000) / 1000) * 1000;
	requests.push({ ...base, t: second + rng.int(1, 3) * 100, client: x, method: 'PUT', ifMatch: { kind: 'own' } });
	t = second + rng.int(5, 9) * 100;
	requests.push({ ...base, t, client: y, method: 'PUT', ifMatch: { kind: 'star' } });
	const tail = rng.shuffle<Req['client']>([x, z, rng.pick([y, z])]);
	for (const client of tail) {
		t += step();
		const roll = rng.int(0, 2);
		requests.push(
			client === x || roll === 0
				? { ...base, t, client, method: 'GET', ifModifiedSince: true }
				: roll === 1
					? { ...base, t, client, method: 'GET', ifNoneMatch: { kind: 'own' } }
					: { ...base, t, client, method: 'PUT', ifMatch: { kind: 'own' } }
		);
	}
	return { weak: false, fractional: true, version, lastWrite, requests };
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	if (classId === 'second-precision') return secondBurst(rng);
	const mix = MIXES[`${grade}/${classId}`];
	if (!mix) throw new Error(`${descriptor.key}: no mix for ${grade}/${classId}`);
	const version = rng.int(2, 9);
	const lastWrite = -rng.int(30, 600) * 1000 - (mix.fractional ? rng.int(0, 9) * 100 : 0);
	const requests: Req[] = [];
	const known = new Set<string>();
	let t = rng.int(1, 5) * 1000;
	for (let i = 0, count = rng.int(mix.count[0], mix.count[1]); i < count; i += 1) {
		const client = rng.pick(mix.clients);
		let kind = weighted(rng, mix.kinds);
		const own =
			kind === 'get-inm' || kind === 'get-ims' || kind === 'get-both' || kind === 'put-own' || kind === 'del-own';
		if (own && !known.has(client)) kind = 'get';
		if (kind === 'get' || kind === 'get-inm' || kind === 'get-ims' || kind === 'get-both' || kind === 'get-inm-old')
			known.add(client);
		const old: Tag = { kind: 'literal', version: rng.int(Math.max(1, version - 2), version) };
		const base = { t, client, ifMatch: null, ifNoneMatch: null, ifModifiedSince: false };
		const req: Req =
			kind === 'get'
				? { ...base, method: 'GET' }
				: kind === 'get-inm'
					? { ...base, method: 'GET', ifNoneMatch: { kind: 'own' } }
					: kind === 'get-ims'
						? { ...base, method: 'GET', ifModifiedSince: true }
						: kind === 'get-both'
							? { ...base, method: 'GET', ifNoneMatch: old, ifModifiedSince: true }
							: kind === 'get-inm-old'
								? { ...base, method: 'GET', ifNoneMatch: old }
								: kind === 'put-own'
									? { ...base, method: 'PUT', ifMatch: { kind: 'own' } }
									: kind === 'put-old'
										? { ...base, method: 'PUT', ifMatch: old }
										: kind === 'put-none'
											? { ...base, method: 'PUT' }
											: kind === 'put-star'
												? { ...base, method: 'PUT', ifMatch: { kind: 'star' } }
												: kind === 'put-create'
													? { ...base, method: 'PUT', ifNoneMatch: { kind: 'star' } }
													: kind === 'del-own'
														? { ...base, method: 'DELETE', ifMatch: { kind: 'own' } }
														: { ...base, method: 'DELETE' };
		requests.push(req);
		t += mix.fractional ? rng.int(mix.gap[0], mix.gap[1]) * 100 : rng.int(mix.gap[0], mix.gap[1]) * 1000;
	}
	return { weak: mix.weak, fractional: mix.fractional, version, lastWrite, requests };
}

function clock(ms: number, fractional: boolean): string {
	const total = 12 * 3600 * 1000 + ms;
	const h = Math.floor(total / 3600000);
	const m = Math.floor((total % 3600000) / 60000);
	const s = Math.floor((total % 60000) / 1000);
	const text = [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
	return fractional ? `${text}.${String(total % 1000).padStart(3, '0')}` : text;
}

function describe(p: Params): string {
	const etag = (v: number): string => (p.weak ? `W/"v${v}"` : `"v${v}"`);
	const tagText = (tag: Tag, client: string): string =>
		tag.kind === 'star' ? '*' : tag.kind === 'literal' ? etag(tag.version) : `сохранённый ETag клиента ${client}`;
	const lines = p.requests.map((r, i) => {
		const conditions: string[] = [];
		if (r.ifMatch) conditions.push(`If-Match: ${tagText(r.ifMatch, r.client)}`);
		if (r.ifNoneMatch) conditions.push(`If-None-Match: ${tagText(r.ifNoneMatch, r.client)}`);
		if (r.ifModifiedSince) conditions.push(`If-Modified-Since: сохранённый Last-Modified клиента ${r.client}`);
		return `${i + 1}. ${clock(r.t, p.fractional)} | клиент ${r.client} | ${r.method} | ${conditions.length ? conditions.join(', ') : 'без условных заголовков'}`;
	});
	return [
		'Тестировщик проверяет условные запросы к ресурсу `/api/v1/profiles/7` и заранее записывает ожидаемые ответы.',
		'',
		'## Контракт',
		'',
		`- У каждой версии ресурса ETag вида \`${etag(1)}\`, \`${etag(2)}\` и так далее (номер версии)${p.weak ? ' — это слабые ETag, с префиксом `W/`' : ''}, и Last-Modified — время записи этой версии с точностью до секунды: доли секунды отбрасываются.`,
		'- `If-Match` сравнивает ETag строго: совпадение — только если ресурс существует, значения равны и оба ETag не слабые. `If-None-Match` сравнивает слабо: префикс `W/` не учитывается. Значение `*` совпадает с любым существующим ресурсом и не совпадает, если ресурса нет.',
		'- `GET`: ресурса нет — `404`. Есть `If-None-Match` — `304`, если он совпал, иначе `200`; `If-Modified-Since` при этом не проверяется. Нет `If-None-Match`, но есть `If-Modified-Since` — `304`, если Last-Modified ресурса не позже значения заголовка, иначе `200`. Без условий — `200`.',
		'- `PUT` с `If-None-Match: *`: ресурс существует — `412`, иначе ресурс создаётся — `201`. Остальные `PUT` и `DELETE`: нет `If-Match` — `428`; `If-Match` не совпал — `412`; иначе `PUT` записывает новую версию — `200`, `DELETE` удаляет ресурс — `204`.',
		'- Каждая запись (`200` или `201` на `PUT`) создаёт версию с номером на 1 больше последней когда-либо существовавшей; её Last-Modified — момент запроса.',
		'- Ответы `200`, `201` и `304` содержат ETag и Last-Modified текущей версии. Клиент сохраняет их из последнего такого ответа и подставляет, где написано «сохранённый».',
		'',
		'## Перед запросами',
		'',
		`Ресурс существует, текущая версия — \`${etag(p.version)}\`, записана в ${clock(p.lastWrite, p.fractional)}. Клиенты ещё ничего не сохранили.`,
		'',
		'## Запросы',
		'',
		'```',
		...lines,
		'```',
		'',
		'Введите через пробел коды ответов на все запросы по порядку, а последним значением — итоговое состояние ресурса: `v<номер версии>` или `deleted`, если ресурса нет. Например: `200 412 304 v5`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())
exists, ver, top, wrote = True, p["version"], p["version"], p["lastWrite"]
saved = {}
codes = []

def sec(ms):
    return ms // 1000 * 1000

def tag_value(tag, client):
    if tag["kind"] == "star":
        return "*"
    if tag["kind"] == "literal":
        return tag["version"]
    return saved[client][0]

def matches(tag, client, strong):
    v = tag_value(tag, client)
    if not exists:
        return False
    if v == "*":
        return True
    return v == ver and not (strong and p["weak"])

for r in p["requests"]:
    c = r["client"]
    if r["method"] == "GET":
        if not exists:
            codes.append("404")
            continue
        if r["ifNoneMatch"] is not None:
            fresh = matches(r["ifNoneMatch"], c, False)
        elif r["ifModifiedSince"]:
            fresh = sec(wrote) <= saved[c][1]
        else:
            fresh = False
        codes.append("304" if fresh else "200")
        saved[c] = (ver, sec(wrote))
        continue
    inm = r["ifNoneMatch"]
    if r["method"] == "PUT" and inm is not None and inm["kind"] == "star":
        if exists:
            codes.append("412")
            continue
    elif r["ifMatch"] is None:
        codes.append("428")
        continue
    elif not matches(r["ifMatch"], c, True):
        codes.append("412")
        continue
    if r["method"] == "DELETE":
        codes.append("204")
        exists = False
        continue
    codes.append("200" if exists else "201")
    exists = True
    top += 1
    ver = top
    wrote = r["t"]
    saved[c] = (ver, sec(wrote))
print(" ".join(codes), ("v%d" % ver) if exists else "deleted")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'last-write-wins': { lastWriteWins: true },
	'put-keeps-etag': { putKeepsEtag: true },
	'missing-as-412': { missingAs412: true },
	'no-precondition-ok': { noPreconditionOk: true },
	'ims-strict': { imsStrict: true },
	'weak-matches': { weakMatches: true },
	'both-conditions': { bothConditions: true },
	'ms-precision': { msPrecision: true },
	'star-always-matches': { starAlwaysMatches: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/lost-update': ['last-write-wins'],
	'middle/own-write-etag': ['put-keeps-etag'],
	'middle/missing-precondition': ['missing-as-412', 'no-precondition-ok'],
	'middle/if-modified-since': ['ims-strict'],
	'senior/weak-etag': ['weak-matches'],
	'senior/inm-overrides-ims': ['both-conditions'],
	'senior/second-precision': ['ms-precision'],
	'senior/create-and-delete': ['star-always-matches']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
	// Feeds are drawn until every misconception the class is about changes the answer.
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = simulate(p, RIGHT);
		if (answer === null) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = simulate(p, { ...RIGHT, ...change });
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
