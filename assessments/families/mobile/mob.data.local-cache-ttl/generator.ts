// A simple cache with a TTL in front of the network: what each opening of a screen shows — the cached version, the
// version from the network, or an error — as the network comes and goes and the data on the server changes.
import { type Built, readDescriptor, type GenerateInput, type ItemInstance } from '../../_lib/family.ts';
import { buildCompute, type ComputeItem, type Required } from '../../_lib/mob-data.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

const REQUIRED: Required = {
	'intern/ttl-fixed': ['ttl-from-read'],
	'intern/offline-stale': ['offline-error'],
	'intern/ttl-boundary': ['ttl-inclusive'],
	'intern/stale-version': ['always-latest']
};

interface Scenario {
	ttl: number;
	cache: { version: number; savedAt: number } | null;
	/** `[from, version]`: the version on the server from the moment on. */
	versions: [number, number][];
	/** Openings of the screen: moment and whether the network is there. */
	opens: { at: number; online: boolean }[];
}

interface Rules {
	ttlFromRead: boolean;
	offlineError: boolean;
	ttlInclusive: boolean;
	alwaysLatest: boolean;
}

const RIGHT: Rules = { ttlFromRead: false, offlineError: false, ttlInclusive: false, alwaysLatest: false };

const WRONG: Record<string, Partial<Rules>> = {
	'ttl-from-read': { ttlFromRead: true },
	'offline-error': { offlineError: true },
	'ttl-inclusive': { ttlInclusive: true },
	'always-latest': { alwaysLatest: true }
};

function serverVersion(s: Scenario, t: number): number {
	let v = s.versions[0]?.[1] ?? 1;
	for (const [from, version] of s.versions) if (from <= t) v = version;
	return v;
}

/** One line per opening: `<moment> cache v<n>`, `<moment> network v<n>` or `<moment> error`. */
function simulate(s: Scenario, rules: Rules): string[] {
	let cache = s.cache === null ? null : { ...s.cache };
	return s.opens.map(({ at, online }) => {
		const shownCache = (): string => {
			if (cache === null) return `${at} error`;
			return `${at} cache v${rules.alwaysLatest ? serverVersion(s, at) : cache.version}`;
		};
		if (cache !== null) {
			const age = at - cache.savedAt;
			if (rules.ttlInclusive ? age <= s.ttl : age < s.ttl) {
				const line = shownCache();
				if (rules.ttlFromRead) cache.savedAt = at;
				return line;
			}
		}
		if (online) {
			const version = serverVersion(s, at);
			cache = { version, savedAt: at };
			return `${at} network v${version}`;
		}
		return rules.offlineError ? `${at} error` : shownCache();
	});
}

const PYTHON_REFERENCE = String.raw`import json

s = json.loads(input())
entry = s["cache"]

def on_server(t):
    current = None
    for start, v in s["versions"]:
        if start <= t:
            current = v
    return current

for o in s["opens"]:
    t = o["at"]
    if entry and t - entry["savedAt"] < s["ttl"]:
        print(t, "cache", "v%d" % entry["version"])
    elif o["online"]:
        entry = {"version": on_server(t), "savedAt": t}
        print(t, "network", "v%d" % entry["version"])
    elif entry:
        print(t, "cache", "v%d" % entry["version"])
    else:
        print(t, "error")
`;

function describe(s: Scenario): string {
	const versions = s.versions.map(([from, v]) => `v${v} с момента ${from} с`).join(', ');
	const opens = s.opens.map((o) => `${o.at} с (${o.online ? 'сеть есть' : 'сети нет'})`).join(', ');
	return [
		'Экран ленты берёт данные через репозиторий с кэшем в памяти (модель, не конкретная библиотека). Время — в секундах.',
		'',
		`- Запись кэша свежая, пока с момента её сохранения прошло меньше ${s.ttl} с. Чтение из кэша момент сохранения не меняет.`,
		'- При открытии экрана: свежая запись — экран показывает её, запроса нет. Иначе, если сеть есть, — запрос: ответ приходит сразу, сохраняется в кэш с моментом открытия и показывается. Если сети нет — экран показывает запись из кэша, даже устаревшую, а если кэш пуст — ошибку.',
		`- Кэш в момент 0: ${s.cache === null ? 'пуст' : `v${s.cache.version}, сохранена в момент ${s.cache.savedAt} с`}.`,
		`- Версия на сервере: ${versions}.`,
		`- Экран открывают в моменты: ${opens}.`,
		'',
		'Введите по строке на каждое открытие: момент, источник и версию через пробел — `30 cache v2` или `30 network v3`, либо момент и `error`. Строки сравниваются как текст: между полями — ровно один пробел.'
	].join('\n');
}

function scenario(rng: Rng, classId: string): Scenario {
	const ttl = rng.int(3, 12) * 5;
	const count = rng.int(4, 5);
	const opens: { at: number; online: boolean }[] = [];
	let t = rng.int(0, 5);
	for (let k = 0; k < count; k += 1) {
		opens.push({
			at: t,
			online: classId === 'offline-stale' ? rng.bool(0.5) : classId === 'ttl-fixed' || rng.bool(0.85)
		});
		t += rng.int(Math.max(2, Math.floor(ttl / 3)), ttl + 10);
	}
	const end = t;
	const first = rng.int(1, 4);
	const versions: [number, number][] = [[0, first]];
	const changes = classId === 'stale-version' ? rng.int(2, 3) : rng.int(1, 2);
	const moments = new Set<number>();
	while (moments.size < changes) moments.add(rng.int(1, end));
	[...moments].sort((a, b) => a - b).forEach((m, i) => versions.push([m, first + i + 1]));
	const cache = rng.bool(0.7) ? { version: first - rng.int(0, 1) || 1, savedAt: -rng.int(1, ttl + 20) } : null;
	if (classId === 'ttl-boundary') {
		// An opening falls exactly on the end of the freshness of the entry saved by an online opening before it.
		const i = rng.int(0, count - 2);
		const opening = opens[i];
		const next = opens[i + 1];
		if (opening && next) {
			opening.online = true;
			next.at = opening.at + ttl;
			for (let k = i + 2; k < count; k += 1) {
				const prev = opens[k - 1]?.at ?? 0;
				const o = opens[k];
				if (o && o.at <= prev) o.at = prev + rng.int(2, 10);
			}
		}
	}
	return { ttl, cache, versions, opens };
}

function make(rng: Rng, classId: string): ComputeItem | null {
	const s = scenario(rng, classId);
	const answer = simulate(s, RIGHT);
	const wrong = Object.fromEntries(
		Object.entries(WRONG).map(([id, change]) => [
			id,
			{ kind: 'sequence' as const, value: simulate(s, { ...RIGHT, ...change }) }
		])
	);
	return { markdown: describe(s), answer: { kind: 'sequence', value: answer }, wrong, stdin: JSON.stringify(s) };
}

export function build(input: GenerateInput): Built {
	return buildCompute(descriptor, input, REQUIRED, PYTHON_REFERENCE, (rng) => make(rng, input.classId));
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
