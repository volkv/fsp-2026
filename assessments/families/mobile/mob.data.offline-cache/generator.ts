// What a screen shows, and when, under a cache policy of the data layer — cache-first with a TTL, network-first with a
// timeout, stale-while-revalidate, revalidation with ETag — while the network is online, slow or absent and the data on
// the server changes. The answer is the sequence of what the screen receives and the number of requests sent.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildCompute, type ComputeItem, type Required } from '../../_lib/mob-data.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const REQUIRED: Required = {
	'middle/network-first': ['wait-past-timeout', 'offline-error'],
	'middle/cache-first-ttl': ['ttl-ignored', 'ttl-from-request'],
	'middle/swr': ['swr-always-fetch', 'swr-no-rerender'],
	'middle/cache-first-offline': ['offline-error', 'ttl-ignored'],
	'senior/late-write': ['late-response-dropped', 'wait-past-timeout'],
	'senior/etag': ['keep-age-304', 'ttl-ignored'],
	'senior/swr-offline': ['swr-always-fetch', 'offline-error'],
	'senior/ttl-boundary': ['ttl-from-request', 'ttl-inclusive']
};

type Policy = 'cache-first' | 'network-first' | 'swr';
type Net = 'online' | 'slow' | 'offline';

interface Scenario {
	policy: Policy;
	/** Seconds an entry stays fresh (cache-first, swr). */
	ttl: number | null;
	/** Seconds network-first waits for the network (network-first). */
	timeout: number | null;
	/** Requests carry the cached version in `If-None-Match`; the server answers 304 when it has not changed. */
	etag: boolean;
	/** The entry in the cache at the start: version and the moment it was saved (negative — before 0). */
	cache: { version: number; savedAt: number } | null;
	/** `[from, version]`: the version on the server from the moment on. */
	versions: [number, number][];
	/** `[from, state]`: the network from the moment on. */
	net: [number, Net][];
	fast: number;
	slow: number;
	opens: number[];
}

interface Rules {
	waitPastTimeout: boolean;
	lateDropped: boolean;
	offlineError: boolean;
	ttlIgnored: boolean;
	ttlFromRequest: boolean;
	ttlInclusive: boolean;
	swrAlwaysFetch: boolean;
	swrNoRerender: boolean;
	keepAge304: boolean;
}

const RIGHT: Rules = {
	waitPastTimeout: false,
	lateDropped: false,
	offlineError: false,
	ttlIgnored: false,
	ttlFromRequest: false,
	ttlInclusive: false,
	swrAlwaysFetch: false,
	swrNoRerender: false,
	keepAge304: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'wait-past-timeout': { waitPastTimeout: true },
	'late-response-dropped': { lateDropped: true },
	'offline-error': { offlineError: true },
	'ttl-ignored': { ttlIgnored: true },
	'ttl-from-request': { ttlFromRequest: true },
	'ttl-inclusive': { ttlInclusive: true },
	'swr-always-fetch': { swrAlwaysFetch: true },
	'swr-no-rerender': { swrNoRerender: true },
	'keep-age-304': { keepAge304: true }
};

/** The activity of one opening overlaps the next one: the scenario is drawn again. */
class OutsideModel extends Error {}

const at = <T>(timeline: readonly [number, T][], t: number): T => {
	let value = timeline[0]?.[1];
	for (const [from, v] of timeline) if (from <= t) value = v;
	if (value === undefined) throw new Error('an empty timeline');
	return value;
};

/** Lines `<moment> v<version>` / `<moment> error` in the order the screen receives them, then `requests <n>`. */
function simulate(s: Scenario, rules: Rules): string[] {
	let cache = s.cache === null ? null : { ...s.cache };
	const shown: [number, string][] = [];
	let requests = 0;
	const fresh = (t: number): boolean => {
		if (cache === null) return false;
		if (rules.ttlIgnored || s.ttl === null) return true;
		const age = t - cache.savedAt;
		return rules.ttlInclusive ? age <= s.ttl : age < s.ttl;
	};
	const fallback = (t: number): void => {
		shown.push([t, cache === null || rules.offlineError ? 'error' : `v${cache.version}`]);
	};
	/** Sends a request at `t`: `null` when offline, else the moment of the answer and what it brings. */
	const send = (t: number): { arrives: number; version: number; notModified: boolean } | null => {
		requests += 1;
		const state = at(s.net, t);
		if (state === 'offline') return null;
		const version = at(s.versions, t);
		return {
			arrives: t + (state === 'slow' ? s.slow : s.fast),
			version,
			notModified: s.etag && cache !== null && cache.version === version
		};
	};
	const save = (version: number, sentAt: number, arrives: number, notModified: boolean): void => {
		const savedAt = rules.ttlFromRequest ? sentAt : arrives;
		if (notModified && cache !== null) {
			if (!rules.keepAge304) cache.savedAt = savedAt;
			return;
		}
		cache = { version, savedAt };
	};
	for (let i = 0; i < s.opens.length; i += 1) {
		const t = s.opens[i] ?? 0;
		const next = s.opens[i + 1] ?? Number.POSITIVE_INFINITY;
		if (s.policy === 'cache-first') {
			if (fresh(t)) {
				shown.push([t, `v${cache?.version ?? 0}`]);
				continue;
			}
			const r = send(t);
			if (r === null) {
				fallback(t);
				continue;
			}
			if (r.arrives >= next) throw new OutsideModel();
			const version = r.notModified ? (cache?.version ?? r.version) : r.version;
			save(r.version, t, r.arrives, r.notModified);
			shown.push([r.arrives, `v${version}`]);
			continue;
		}
		if (s.policy === 'network-first') {
			const timeout = s.timeout ?? 0;
			const r = send(t);
			if (r === null) {
				fallback(t);
				continue;
			}
			if (r.arrives >= next) throw new OutsideModel();
			if (r.arrives - t <= timeout || rules.waitPastTimeout) {
				save(r.version, t, r.arrives, r.notModified);
				shown.push([r.arrives, `v${r.version}`]);
				continue;
			}
			fallback(t + timeout);
			if (!rules.lateDropped) save(r.version, t, r.arrives, r.notModified);
			continue;
		}
		// stale-while-revalidate
		if (cache !== null) {
			shown.push([t, `v${cache.version}`]);
			if (fresh(t) && !rules.swrAlwaysFetch) continue;
			const r = send(t);
			if (r === null) {
				if (rules.offlineError) shown.push([t, 'error']);
				continue;
			}
			if (r.arrives >= next) throw new OutsideModel();
			save(r.version, t, r.arrives, r.notModified);
			if (!rules.swrNoRerender) shown.push([r.arrives, `v${r.version}`]);
			continue;
		}
		const r = send(t);
		if (r === null) {
			shown.push([t, 'error']);
			continue;
		}
		if (r.arrives >= next) throw new OutsideModel();
		save(r.version, t, r.arrives, r.notModified);
		shown.push([r.arrives, `v${r.version}`]);
	}
	return [...shown.map(([t, what]) => `${t} ${what}`), `requests ${requests}`];
}

const PYTHON_REFERENCE = String.raw`import json

s = json.loads(input())

def lookup(timeline, t):
    value = None
    for start, v in sorted(timeline, key=lambda p: p[0]):
        if start <= t:
            value = v
    return value

entry = dict(s["cache"]) if s["cache"] else None
events = []
sent = 0

def request(t):
    global sent
    sent += 1
    net = lookup(s["net"], t)
    if net == "offline":
        return None
    v = lookup(s["versions"], t)
    delay = s["slow"] if net == "slow" else s["fast"]
    same = bool(s["etag"]) and entry is not None and entry["version"] == v
    return t + delay, v, same

def store(v, when, same):
    global entry
    if same:
        entry["savedAt"] = when
    else:
        entry = {"version": v, "savedAt": when}

def cached_or_error(t):
    events.append((t, "v%d" % entry["version"] if entry else "error"))

for t in s["opens"]:
    pol = s["policy"]
    if pol == "network-first":
        r = request(t)
        if r is None:
            cached_or_error(t)
        elif r[0] - t <= s["timeout"]:
            store(r[1], r[0], r[2])
            events.append((r[0], "v%d" % r[1]))
        else:
            cached_or_error(t + s["timeout"])
            store(r[1], r[0], r[2])
        continue
    is_fresh = entry is not None and (s["ttl"] is None or t - entry["savedAt"] < s["ttl"])
    if pol == "cache-first":
        if is_fresh:
            events.append((t, "v%d" % entry["version"]))
            continue
        r = request(t)
        if r is None:
            cached_or_error(t)
            continue
        shown_version = entry["version"] if r[2] else r[1]
        store(r[1], r[0], r[2])
        events.append((r[0], "v%d" % shown_version))
        continue
    if entry is not None:
        events.append((t, "v%d" % entry["version"]))
        if is_fresh:
            continue
        r = request(t)
        if r is not None:
            store(r[1], r[0], r[2])
            events.append((r[0], "v%d" % r[1]))
        continue
    r = request(t)
    if r is None:
        events.append((t, "error"))
    else:
        store(r[1], r[0], r[2])
        events.append((r[0], "v%d" % r[1]))

for t, what in events:
    print(t, what)
print("requests", sent)
`;

const NET_WORDS: Record<Net, string> = { online: 'есть', slow: 'медленная', offline: 'нет' };

function describe(s: Scenario): string {
	const policy: Record<Policy, string[]> = {
		'cache-first': [
			`**cache-first** с TTL ${s.ttl} с: если запись в кэше свежая (с момента сохранения прошло меньше ${s.ttl} с), экран сразу получает её и запроса нет; иначе уходит запрос. Ответ сохраняется в кэш с моментом получения и сразу показывается. Запрос без сети сразу завершается ошибкой: тогда экран получает запись из кэша, даже устаревшую, а если кэш пуст — \`error\`.`,
			...(s.etag
				? [
						'Запрос несёт версию из кэша в `If-None-Match`. Если на сервере та же версия, он отвечает `304 Not Modified`: экран получает запись из кэша, а её момент сохранения становится моментом ответа.'
					]
				: [])
		],
		'network-first': [
			`**network-first** с таймаутом ${s.timeout} с: экран всегда отправляет запрос. Ответ, пришедший не позже чем через ${s.timeout} с, сохраняется в кэш и показывается. Если ответа нет через ${s.timeout} с — экран в этот момент получает запись из кэша (или \`error\`, если кэш пуст); опоздавший ответ всё равно сохраняется в кэш, но экран его не получает. Запрос без сети сразу завершается ошибкой — экран сразу получает запись из кэша или \`error\`.`
		],
		swr: [
			`**stale-while-revalidate** с TTL ${s.ttl} с: если в кэше есть запись, экран сразу получает её; если она устарела (с момента сохранения прошло ${s.ttl} с или больше), уходит запрос, ответ сохраняется в кэш и экран получает его ещё раз — даже ту же версию. Свежая запись запроса не вызывает. Неудачный запрос без сети экран не меняет. Если кэш пуст — запрос, и экран получает ответ или, без сети, \`error\`.`
		]
	};
	const net = s.net.map(([from, state]) => `с ${from} с — ${NET_WORDS[state]}`).join(', ');
	const versions = s.versions.map(([from, v]) => `v${v} с момента ${from} с`).join(', ');
	return [
		'Экран профиля читает данные через репозиторий с кэшем (модель политики, не конкретная библиотека). Время — в секундах от момента 0.',
		'',
		...policy[s.policy],
		'',
		`- Кэш в момент 0: ${s.cache === null ? 'пуст' : `v${s.cache.version}, сохранена в момент ${s.cache.savedAt} с`}.`,
		`- Версия на сервере: ${versions}; ответ несёт версию, действующую в момент отправки запроса.`,
		`- Сеть: ${net}. Состояние сети в момент отправки действует до ответа: при сети ответ приходит через ${s.fast} с, при медленной — через ${s.slow} с.`,
		`- Экран открывают в моменты ${s.opens.join(', ')} с.`,
		'',
		'Введите по строке на каждое получение данных экраном в порядке времени — момент и версию через пробел (`12 v2`) или момент и `error`; последней строкой — `requests` и число отправленных запросов, включая неудачные (`requests 3`). Строки сравниваются как текст: между полями — ровно один пробел.'
	].join('\n');
}

/** Opening moments after 0, at least `gap` apart. */
function opens(rng: Rng, count: number, gap: number, spread: number): number[] {
	const out: number[] = [];
	let t = rng.int(0, 5);
	for (let k = 0; k < count; k += 1) {
		out.push(t);
		t += gap + rng.int(0, spread);
	}
	return out;
}

/** A network timeline: a state per opening window, starting just before each opening. */
function netAround(rng: Rng, moments: readonly number[], states: readonly Net[]): [number, Net][] {
	const out: [number, Net][] = [];
	moments.forEach((m, i) => {
		const state = states[i] ?? 'online';
		const prev = out[out.length - 1];
		if (prev && prev[1] === state) return;
		out.push([i === 0 ? 0 : m - rng.int(1, 4), state]);
	});
	return out;
}

function versionsUntil(rng: Rng, end: number, changes: number): [number, number][] {
	const first = rng.int(2, 5);
	const out: [number, number][] = [[0, first]];
	const moments = new Set<number>();
	while (moments.size < changes) moments.add(rng.int(5, Math.max(6, end)));
	[...moments].sort((a, b) => a - b).forEach((m, i) => out.push([m, first + i + 1]));
	return out;
}

function scenario(rng: Rng, key: string): Scenario {
	const fast = rng.int(1, 2);
	const slow = rng.int(6, 9);
	switch (key) {
		case 'middle/network-first':
		case 'senior/late-write': {
			const timeout = rng.int(3, 5);
			const count = key === 'senior/late-write' ? 4 : rng.int(3, 4);
			const moments = opens(rng, count, 15, 25);
			const states: Net[] =
				key === 'senior/late-write'
					? rng.pick([
							['online', 'slow', 'offline', 'online'],
							['slow', 'offline', 'slow', 'offline'],
							['online', 'slow', 'slow', 'offline']
						] as Net[][])
					: rng.shuffle<Net>(['slow', 'offline', ...(count === 4 ? (['online'] as Net[]) : []), 'online']);
			const end = moments[moments.length - 1] ?? 60;
			return {
				policy: 'network-first',
				ttl: null,
				timeout,
				etag: false,
				cache: { version: 1, savedAt: -rng.int(10, 300) },
				versions: versionsUntil(rng, end, rng.int(1, 3)),
				net: netAround(rng, moments, states),
				fast,
				slow,
				opens: moments
			};
		}
		case 'middle/cache-first-ttl':
		case 'senior/ttl-boundary': {
			const ttl = rng.int(4, 12) * 5;
			const moments = opens(rng, 4, 12, Math.floor(ttl * 1.2));
			const states = moments.map((): Net => (rng.bool(0.5) ? 'slow' : 'online'));
			const s: Scenario = {
				policy: 'cache-first',
				ttl,
				timeout: null,
				etag: false,
				cache: rng.bool() ? { version: 1, savedAt: -rng.int(1, ttl * 2) } : null,
				versions: versionsUntil(rng, (moments[moments.length - 1] ?? 60) + 5, rng.int(1, 3)),
				net: netAround(rng, moments, states),
				fast,
				slow,
				opens: moments
			};
			if (key === 'senior/ttl-boundary') {
				// One opening falls exactly on the end of the freshness of an entry saved by an earlier opening.
				const saved = simulateSaves(s);
				const pick = saved.find(([, i]) => i + 1 < moments.length);
				if (pick) {
					const [savedAt, i] = pick;
					const target = savedAt + ttl;
					const next = moments[i + 1];
					if (next !== undefined && target > (moments[i] ?? 0) + slow) moments[i + 1] = target;
					for (let k = i + 2; k < moments.length; k += 1)
						moments[k] = Math.max(moments[k] ?? 0, (moments[k - 1] ?? 0) + 12 + rng.int(0, 10));
				}
			}
			return s;
		}
		case 'middle/swr':
		case 'senior/swr-offline': {
			const ttl = rng.int(4, 12) * 5;
			const moments = opens(rng, 4, 10, Math.floor(ttl * 1.5));
			const states: Net[] =
				key === 'senior/swr-offline'
					? rng.shuffle<Net>([
							'offline',
							'online',
							rng.pick<Net>(['online', 'slow']),
							rng.pick<Net>(['offline', 'online'])
						])
					: moments.map((): Net => (rng.bool(0.3) ? 'slow' : 'online'));
			return {
				policy: 'swr',
				ttl,
				timeout: null,
				etag: false,
				cache: key === 'senior/swr-offline' || rng.bool() ? { version: 1, savedAt: -rng.int(1, ttl * 2) } : null,
				versions: versionsUntil(rng, (moments[moments.length - 1] ?? 60) + 5, rng.int(1, 3)),
				net: netAround(rng, moments, states),
				fast,
				slow,
				opens: moments
			};
		}
		case 'middle/cache-first-offline': {
			const ttl = rng.int(4, 12) * 5;
			const moments = opens(rng, 4, 12, Math.floor(ttl * 1.2));
			const states = rng.shuffle<Net>(['offline', 'offline', 'online', rng.pick<Net>(['online', 'slow'])]);
			return {
				policy: 'cache-first',
				ttl,
				timeout: null,
				etag: false,
				cache: { version: 1, savedAt: -rng.int(1, ttl * 2) },
				versions: versionsUntil(rng, (moments[moments.length - 1] ?? 60) + 5, rng.int(1, 2)),
				net: netAround(rng, moments, states),
				fast,
				slow,
				opens: moments
			};
		}
		case 'senior/etag': {
			const ttl = rng.int(4, 8) * 5;
			const moments = opens(rng, 5, Math.floor(ttl * 0.6), ttl);
			const states = moments.map((): Net => (rng.bool(0.3) ? 'slow' : 'online'));
			const end = moments[moments.length - 1] ?? 60;
			return {
				policy: 'cache-first',
				ttl,
				timeout: null,
				etag: true,
				cache: { version: 1, savedAt: -rng.int(ttl, ttl * 2) },
				// The version rarely changes: most revalidations end in 304.
				versions: [
					[0, 1],
					[rng.int(Math.floor(end / 2), end), 2]
				],
				net: netAround(rng, moments, states),
				fast,
				slow,
				opens: moments
			};
		}
		default:
			throw new Error(`${descriptor.key}: no class ${key}`);
	}
}

/** Moments an entry is saved by a cache-first scenario with the right rules, with the index of the opening. */
function simulateSaves(s: Scenario): [number, number][] {
	const out: [number, number][] = [];
	let savedAt = s.cache?.savedAt ?? null;
	s.opens.forEach((t, i) => {
		if (savedAt !== null && s.ttl !== null && t - savedAt < s.ttl) return;
		const state = at(s.net, t);
		if (state === 'offline') return;
		savedAt = t + (state === 'slow' ? s.slow : s.fast);
		out.push([savedAt, i]);
	});
	return out;
}

function make(rng: Rng, key: string): ComputeItem | null {
	const s = scenario(rng, key);
	let answer: string[];
	try {
		answer = simulate(s, RIGHT);
	} catch (error) {
		if (error instanceof OutsideModel) return null;
		throw error;
	}
	const wrong: Record<string, { kind: 'sequence'; value: string[] }> = {};
	for (const [id, change] of Object.entries(WRONG)) {
		try {
			wrong[id] = { kind: 'sequence', value: simulate(s, { ...RIGHT, ...change }) };
		} catch (error) {
			// The misconception stretches an opening into the next one: its answer is not defined by the model.
			if (!(error instanceof OutsideModel)) throw error;
		}
	}
	return { markdown: describe(s), answer: { kind: 'sequence', value: answer }, wrong, stdin: JSON.stringify(s) };
}

export function build(input: GenerateInput): Built {
	const key = `${input.grade}/${input.classId}`;
	return buildCompute(descriptor, input, REQUIRED, PYTHON_REFERENCE, (rng) => make(rng, key));
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
