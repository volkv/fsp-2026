// Service worker caching: which version of a resource a page gets on every request, given the strategies of the
// worker (cache-first over a precache, network-first with a timeout, stale-while-revalidate, network-only), the network
// (offline, slow) and the lifecycle of a new worker: found only on a navigation, waiting until every tab is closed or
// taking the open tabs at once with skipWaiting, deleting the old cache when it activates.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Event {
	t: number;
	type: 'open' | 'reload' | 'close' | 'request' | 'deploy';
	tab: number;
	path: string;
}

interface Params {
	precache: string[];
	/** Paths served cache-first without being precached. */
	image: string;
	networkFirst: string;
	swr: string;
	networkOnly: string;
	timeoutSec: number;
	latencySec: number;
	skipWaiting: boolean;
	/** Moments each path changes on the server; a deploy changes every precached path. */
	changes: Record<string, number[]>;
	offline: [number, number][];
	slow: [number, number][];
	events: Event[];
}

interface Rules {
	updateAtDeploy: boolean;
	skipWaitingTakesTabs: boolean;
	reloadActivates: boolean;
	runtimeKept: boolean;
	cacheFirstNetwork: boolean;
	swrFresh: boolean;
	swrUpdates: boolean;
	offlineNfError: boolean;
	nfTimeout: boolean;
	lateCached: boolean;
}

const RIGHT: Rules = {
	updateAtDeploy: false,
	skipWaitingTakesTabs: true,
	reloadActivates: false,
	runtimeKept: false,
	cacheFirstNetwork: false,
	swrFresh: false,
	swrUpdates: true,
	offlineNfError: false,
	nfTimeout: true,
	lateCached: true
};

const WRONG: Record<string, Partial<Rules>> = {
	'update-at-deploy': { updateAtDeploy: true },
	'skip-waiting-next-load': { skipWaitingTakesTabs: false },
	'reload-activates': { reloadActivates: true },
	'runtime-cache-kept': { runtimeKept: true },
	'cache-first-as-network': { cacheFirstNetwork: true },
	'swr-returns-fresh': { swrFresh: true },
	'swr-no-update': { swrUpdates: false },
	'offline-nf-error': { offlineNfError: true },
	'nf-no-timeout': { nfTimeout: false },
	'late-response-dropped': { lateCached: false }
};

interface Worker {
	version: number;
	cache: Map<string, number>;
	alive: boolean;
}

interface Outcome {
	answer: string;
	/**
	 * A late write or a network-first timeout meets an event or each other at the same moment, or outlives the cache it
	 * targets: the order would be a matter of the event loop, such a scenario is redrawn.
	 */
	ambiguous: boolean;
}

const within = (windows: readonly [number, number][], t: number): boolean => windows.some(([a, b]) => t >= a && t <= b);

function simulate(p: Params, rules: Rules): Outcome {
	const versionAt = (path: string, t: number): number => 1 + (p.changes[path] ?? []).filter((c) => c <= t).length;
	let ambiguous = false;
	let deployed = 1;
	let active: Worker = { version: 1, cache: new Map(p.precache.map((path) => [path, 1])), alive: true };
	// Held in an object: closures assign it, and flow analysis does not follow them.
	const pendingWorker: { waiting: Worker | null } = { waiting: null };
	const tabs = new Map<number, Worker>();
	/**
	 * What happens between the events, in time order: a late response lands in the cache, or a network-first timeout
	 * reads the cache at that moment and answers request `slot` with it — or, with nothing cached, waits for the network.
	 */
	const pending: (
		| { kind: 'write'; at: number; worker: Worker; path: string; version: number }
		| { kind: 'timeout'; at: number; worker: Worker; path: string; version: number; slot: number }
	)[] = [];
	const out: string[] = [];
	/** Runs everything pending up to `limit`; `event` — an event comes at `limit` itself. */
	const settle = (limit: number, event: boolean): void => {
		// After the last event only the timeouts matter: a later write changes no answer.
		while (event || pending.some((x) => x.kind === 'timeout')) {
			pending.sort((a, b) => a.at - b.at);
			const next = pending[0];
			if (next === undefined || next.at > limit) return;
			pending.shift();
			if ((event && next.at === limit) || !next.worker.alive) ambiguous = true;
			if (pending.some((x) => x.at === next.at && x.kind !== next.kind)) ambiguous = true;
			if (next.kind === 'write') next.worker.cache.set(next.path, next.version);
			else {
				const cached = next.worker.cache.get(next.path);
				out[next.slot] = `v${cached ?? next.version}`;
			}
		}
	};

	const activate = (next: Worker, viaSkipWaiting: boolean): void => {
		const old = active;
		if (rules.runtimeKept) {
			for (const [path, version] of old.cache)
				if (!p.precache.includes(path) && !next.cache.has(path)) next.cache.set(path, version);
		}
		active = next;
		pendingWorker.waiting = null;
		const keepOld = viaSkipWaiting && !rules.skipWaitingTakesTabs;
		if (!keepOld) old.alive = false;
		for (const [tab, worker] of tabs) if (worker === old && !keepOld) tabs.set(tab, next);
	};
	const install = (t: number): void => {
		const newest = Math.max(active.version, pendingWorker.waiting?.version ?? 0);
		if (deployed <= newest || within(p.offline, t)) return;
		const next: Worker = {
			version: deployed,
			cache: new Map(p.precache.map((path) => [path, versionAt(path, t)])),
			alive: true
		};
		if (p.skipWaiting) activate(next, true);
		else if (tabs.size === 0) activate(next, false);
		else pendingWorker.waiting = next;
	};
	const put = (worker: Worker, path: string, version: number, at: number, t: number): void => {
		if (at === t) worker.cache.set(path, version);
		else pending.push({ kind: 'write', at, worker, path, version });
	};

	const handle = (worker: Worker, path: string, t: number): string => {
		const online = !within(p.offline, t);
		const slow = online && within(p.slow, t);
		const arrives = slow ? t + p.latencySec : t;
		const fresh = versionAt(path, t);
		const cached = worker.cache.get(path);
		const isCacheFirst = p.precache.includes(path) || path === p.image;
		if (isCacheFirst) {
			if (rules.cacheFirstNetwork && online) {
				put(worker, path, fresh, arrives, t);
				return `v${fresh}`;
			}
			if (cached !== undefined) return `v${cached}`;
			if (!online) return 'err';
			put(worker, path, fresh, arrives, t);
			return `v${fresh}`;
		}
		if (path === p.networkFirst) {
			if (!online) return cached !== undefined && !rules.offlineNfError ? `v${cached}` : 'err';
			if (slow && rules.nfTimeout && p.latencySec > p.timeoutSec) {
				if (rules.lateCached) put(worker, path, fresh, arrives, t);
				// The cache is read when the timeout fires, not when the request is sent.
				pending.push({ kind: 'timeout', at: t + p.timeoutSec, worker, path, version: fresh, slot: out.length });
				return 'pending';
			}
			put(worker, path, fresh, arrives, t);
			return `v${fresh}`;
		}
		if (path === p.swr) {
			if (rules.swrFresh && online) {
				put(worker, path, fresh, arrives, t);
				return `v${fresh}`;
			}
			if (cached !== undefined) {
				if (online && rules.swrUpdates) put(worker, path, fresh, arrives, t);
				return `v${cached}`;
			}
			if (!online) return 'err';
			put(worker, path, fresh, arrives, t);
			return `v${fresh}`;
		}
		return online ? `v${fresh}` : 'err';
	};

	const events = [...p.events].sort((a, b) => a.t - b.t);
	for (const e of events) {
		settle(e.t, true);
		if (e.type === 'deploy') {
			deployed += 1;
			if (rules.updateAtDeploy) install(e.t);
		} else if (e.type === 'open') {
			tabs.set(e.tab, active);
			install(e.t);
		} else if (e.type === 'reload') {
			const { waiting } = pendingWorker;
			if (rules.reloadActivates && waiting !== null && tabs.size === 1) activate(waiting, false);
			tabs.set(e.tab, active);
			install(e.t);
		} else if (e.type === 'close') {
			tabs.delete(e.tab);
			const { waiting } = pendingWorker;
			if (tabs.size === 0 && waiting !== null) activate(waiting, false);
		} else {
			const worker = tabs.get(e.tab);
			if (!worker) throw new Error(`tab ${e.tab} is not open at ${e.t}`);
			out.push(handle(worker, e.path, e.t));
		}
	}
	settle(Infinity, false);
	return { answer: out.join(' '), ambiguous };
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const ASSETS = ['/app.js', '/styles.css', '/vendor.js'] as const;
const IMAGES = ['/img/hero.webp', '/img/banner.webp', '/img/promo.webp'] as const;
const NF = ['/api/menu', '/api/news', '/api/feed'] as const;
const SWR = ['/api/prices', '/api/rates', '/api/stock'] as const;
const ONLY = ['/api/cart', '/api/orders', '/api/profile'] as const;

/** Events at distinct whole seconds. */
class Timeline {
	readonly events: Event[] = [];
	readonly #rng: Rng;

	constructor(rng: Rng) {
		this.#rng = rng;
	}

	free(t: number): boolean {
		return !this.events.some((e) => e.t === t);
	}

	/** An event at a free moment in [lo, hi]; null when there is none. */
	add(lo: number, hi: number, type: Event['type'], tab = 0, path = ''): number | null {
		const free: number[] = [];
		for (let t = Math.max(0, lo); t <= hi; t += 1) if (this.free(t)) free.push(t);
		if (free.length === 0) return null;
		const t = this.#rng.pick(free);
		this.events.push({ t, type, tab, path });
		return t;
	}
}

/** Which tabs are open at a moment, from the open/close events so far. */
function openTabs(events: readonly Event[], t: number): number[] {
	const open = new Set<number>();
	for (const e of [...events].sort((a, b) => a.t - b.t)) {
		if (e.t > t) break;
		if (e.type === 'open') open.add(e.tab);
		if (e.type === 'close') open.delete(e.tab);
	}
	return [...open];
}

function scenario(rng: Rng, classId: string): Params | null {
	const precache = rng.sample(ASSETS, rng.int(1, 2));
	const [asset] = precache as [string];
	const p: Params = {
		precache,
		image: rng.pick(IMAGES),
		networkFirst: rng.pick(NF),
		swr: rng.pick(SWR),
		networkOnly: rng.pick(ONLY),
		timeoutSec: rng.pick([2, 3, 4]),
		latencySec: rng.int(6, 12),
		skipWaiting: classId === 'skip-waiting',
		changes: {},
		offline: [],
		slow: [],
		events: []
	};
	const line = new Timeline(rng);
	const runtime = [p.image, p.networkFirst, p.swr, p.networkOnly];
	let span: number;
	let requests: number;
	if (classId === 'skip-waiting') {
		line.add(0, 0, 'open', 1);
		line.add(2, 15, 'request', 1, asset);
		const img = line.add(16, 30, 'request', 1, p.image) ?? 0;
		const deploy = line.add(img + 5, img + 20, 'deploy') ?? 0;
		line.add(deploy + 2, deploy + 10, 'request', 1, rng.pick(precache));
		const nav = line.add(deploy + 12, deploy + 25, 'open', 2) ?? 0;
		line.add(nav + 2, nav + 10, 'request', 1, rng.pick(precache));
		const from = nav + rng.int(12, 18);
		const to = from + rng.int(15, 30);
		p.offline.push([from, to]);
		line.add(from + 1, to - 1, 'request', 1, p.image);
		p.changes[p.image] = rng.bool(0.5) ? [deploy] : [];
		for (const path of precache) p.changes[path] = [deploy];
		p.changes[p.swr] = [rng.int(5, to)];
		p.changes[p.networkFirst] = [rng.int(5, to)];
		span = to + rng.int(10, 20);
		requests = rng.int(9, 11);
	} else if (classId === 'waiting') {
		line.add(0, 0, 'open', 1);
		line.add(1, 4, 'open', 2);
		line.add(5, 15, 'request', 1, asset);
		const deploy = line.add(18, 35, 'deploy') ?? 0;
		const c2 = line.add(deploy + 2, deploy + 12, 'close', 2) ?? 0;
		const c1 = line.add(c2 + 1, c2 + 10, 'close', 1) ?? 0;
		// The first visit after the deploy only finds the new worker; it serves the old version.
		const o3 = line.add(c1 + 3, c1 + 12, 'open', 3) ?? 0;
		const q1 = line.add(o3 + 1, o3 + 6, 'request', 3, rng.pick(precache)) ?? 0;
		const r3 = line.add(q1 + 2, q1 + 10, 'reload', 3) ?? 0;
		const q2 = line.add(r3 + 1, r3 + 6, 'request', 3, rng.pick(precache)) ?? 0;
		const c3 = line.add(q2 + 3, q2 + 12, 'close', 3) ?? 0;
		const o4 = line.add(c3 + 3, c3 + 12, 'open', 4) ?? 0;
		line.add(o4 + 1, o4 + 6, 'request', 4, rng.pick(precache));
		for (const path of precache) p.changes[path] = [deploy];
		p.changes[p.swr] = [rng.int(5, o4)];
		p.changes[p.networkFirst] = [rng.int(5, o4)];
		span = o4 + 8;
		requests = rng.int(8, 10);
	} else if (classId === 'offline') {
		line.add(0, 0, 'open', 1);
		const s1 = line.add(2, 12, 'request', 1, p.swr) ?? 0;
		const cP = rng.int(s1 + 1, s1 + 10);
		const s2 = line.add(cP + 1, cP + 15, 'request', 1, p.swr) ?? 0;
		line.add(s2 + 2, s2 + 25, 'request', 1, p.swr);
		const n1 = line.add(2, 20, 'request', 1, p.networkFirst) ?? 0;
		const i1 = line.add(2, 20, 'request', 1, p.image) ?? 0;
		const cI = rng.int(i1 + 1, i1 + 10);
		line.add(cI + 1, cI + 30, 'request', 1, p.image);
		const cM = rng.int(n1 + 1, n1 + 10);
		const from = Math.max(cM, s2) + rng.int(3, 10);
		const to = from + rng.int(12, 25);
		p.offline.push([from, to]);
		line.add(from + 1, to - 1, 'request', 1, p.networkFirst);
		p.changes[p.swr] = [cP];
		p.changes[p.image] = [cI];
		p.changes[p.networkFirst] = [cM];
		p.changes[asset] = [rng.int(5, to)];
		span = to + rng.int(8, 15);
		requests = rng.int(9, 11);
	} else {
		line.add(0, 0, 'open', 1);
		const n1 = line.add(2, 10, 'request', 1, p.networkFirst) ?? 0;
		const cM = rng.int(n1 + 1, n1 + 8);
		const from = cM + rng.int(2, 6);
		const to = from + rng.int(30, 45);
		p.slow.push([from, to]);
		const n2 = line.add(from + 1, from + 8, 'request', 1, p.networkFirst) ?? 0;
		line.add(n2 + p.latencySec + 1, to, 'request', 1, p.networkFirst);
		const s1 = line.add(2, from - 1, 'request', 1, p.swr);
		if (s1 === null) return null;
		const cP = rng.int(s1 + 1, from);
		const s2 = line.add(from + 1, to - p.latencySec - 2, 'request', 1, p.swr) ?? 0;
		line.add(s2 + 1, to, 'request', 1, p.swr);
		p.changes[p.networkFirst] = [cM];
		p.changes[p.swr] = [cP];
		p.changes[p.image] = [rng.int(5, to)];
		span = to + rng.int(5, 15);
		requests = rng.int(8, 10);
	}
	// The data behind the API keeps changing: every API path changes once or twice more.
	for (const path of [p.swr, p.networkFirst, p.networkOnly]) {
		const more = Array.from({ length: rng.int(1, 2) }, () => rng.int(3, span - 3));
		p.changes[path] = [...new Set([...(p.changes[path] ?? []), ...more])].sort((a, b) => a - b);
	}
	requests += 1;
	const paths = [...precache, ...runtime, p.networkFirst, p.swr, p.networkOnly];
	for (let guard = 0; line.events.filter((e) => e.type === 'request').length < requests && guard < 50; guard += 1) {
		const t = rng.int(1, span);
		const tabs = openTabs(line.events, t);
		if (tabs.length === 0 || !line.free(t)) continue;
		line.add(t, t, 'request', rng.pick(tabs), rng.pick(paths));
	}
	// A change never falls on the moment of an event: which comes first would be a matter of convention.
	const busy = new Set(line.events.filter((e) => e.type !== 'deploy').map((e) => e.t));
	if (Object.values(p.changes).some((times) => times.some((c) => busy.has(c)))) return null;
	// Navigations need the network: the page itself is not served by the worker.
	if (
		line.events.some(
			(e) => (e.type === 'open' || e.type === 'reload') && (within(p.offline, e.t) || within(p.slow, e.t))
		)
	)
		return null;
	p.events = [...line.events].sort((a, b) => a.t - b.t);
	return p;
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function workerSource(p: Params): string {
	return [
		"const VERSION = 'v1'; // каждая выкладка меняет это значение",
		'const CACHE = `app-${VERSION}`;',
		`const PRECACHE = [${p.precache.map((x) => `'${x}'`).join(', ')}];`,
		'',
		"self.addEventListener('install', (event) => {",
		'  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));',
		...(p.skipWaiting ? ['  self.skipWaiting();'] : []),
		'});',
		'',
		"self.addEventListener('activate', (event) => {",
		'  event.waitUntil(',
		'    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))',
		'  );',
		'});',
		'',
		"self.addEventListener('fetch', (event) => {",
		'  const { pathname } = new URL(event.request.url);',
		"  if (PRECACHE.includes(pathname) || pathname.startsWith('/img/')) event.respondWith(cacheFirst(event.request));",
		`  else if (pathname === '${p.networkFirst}') event.respondWith(networkFirst(event, ${p.timeoutSec * 1000}));`,
		`  else if (pathname === '${p.swr}') event.respondWith(staleWhileRevalidate(event));`,
		'  // остальные запросы SW не перехватывает: они идут в сеть',
		'});',
		'',
		'async function cacheFirst(request) {',
		'  const cache = await caches.open(CACHE);',
		'  const hit = await cache.match(request);',
		'  if (hit) return hit;',
		'  const response = await fetch(request);',
		'  await cache.put(request, response.clone());',
		'  return response;',
		'}',
		'',
		'async function networkFirst(event, timeoutMs) {',
		'  const cache = await caches.open(CACHE);',
		'  const network = fetch(event.request).then(async (response) => {',
		'    await cache.put(event.request, response.clone());',
		'    return response;',
		'  });',
		'  event.waitUntil(network.catch(() => undefined));',
		'  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));',
		'  const first = await Promise.race([network.catch(() => null), timeout]);',
		'  if (first) return first;',
		'  return (await cache.match(event.request)) ?? network;',
		'}',
		'',
		'async function staleWhileRevalidate(event) {',
		'  const cache = await caches.open(CACHE);',
		'  const hit = await cache.match(event.request);',
		'  const update = fetch(event.request).then(async (response) => {',
		'    await cache.put(event.request, response.clone());',
		'    return response;',
		'  });',
		'  event.waitUntil(update.catch(() => undefined));',
		'  return hit ?? update;',
		'}'
	].join('\n');
}

function eventText(e: Event, p: Params): string {
	switch (e.type) {
		case 'open':
			return `открыта вкладка ${e.tab}`;
		case 'reload':
			return `вкладка ${e.tab} перезагружена`;
		case 'close':
			return `вкладка ${e.tab} закрыта`;
		case 'deploy':
			return `выкладка: на сервере новые ${p.precache.map((x) => `\`${x}\``).join(' и ')} и новый \`sw.js\``;
		case 'request':
			return `вкладка ${e.tab} запрашивает \`${e.path}\``;
	}
}

function describe(p: Params): string {
	let n = 0;
	const rows = p.events.map((e) => {
		const number = e.type === 'request' ? String((n += 1)) : '';
		return `| ${e.t} | ${number} | ${eventText(e, p)} |`;
	});
	const changes = Object.entries(p.changes)
		.filter(
			([path, times]) => times.length > 0 && !(p.precache.includes(path) && p.events.some((e) => e.type === 'deploy'))
		)
		.map(([path, times]) =>
			times.length === 1
				? `\`${path}\` — в момент ${times[0]}`
				: `\`${path}\` — в моменты ${times.slice(0, -1).join(', ')} и ${times[times.length - 1]}`
		);
	const network: string[] = [];
	for (const [a, b] of p.offline)
		network.push(`- с ${a} по ${b} включительно сети нет: любой запрос в сеть сразу завершается ошибкой;`);
	for (const [a, b] of p.slow)
		network.push(
			`- с ${a} по ${b} включительно сеть медленная: ответ на запрос, отправленный в эти моменты, приходит через ${p.latencySec} с;`
		);
	return [
		'Сайт регистрирует service worker `sw.js`:',
		'',
		'```javascript',
		workerSource(p),
		'```',
		'',
		'До начала (момент 0) SW версии `v1` установлен, активен и управляет каждой открываемой вкладкой; в его кэше `app-v1` — предкэш первой версии. Первая версия каждого ресурса — `v1`, после каждого изменения на сервере номер растёт: `v2`, `v3`, …',
		...(changes.length ? ['', `Ресурсы меняются на сервере сами по себе: ${changes.join('; ')}.`] : []),
		'',
		'Считаем, что:',
		'',
		'- сеть отвечает мгновенно, кроме оговорённого ниже; HTTP-кэш браузера не участвует (сервер отдаёт `Cache-Control: no-store`);',
		'- браузер проверяет `sw.js` на обновление при каждой навигации (открытие или перезагрузка вкладки), а установка нового SW вместе с предкэшем завершается в тот же момент;',
		'- операции SW, не ждущие сети, завершаются в тот же момент; браузер не останавливает SW, пока не завершены работы, переданные в `event.respondWith` и `event.waitUntil`, поэтому запоздавший ответ сети попадает в кэш в момент своего прихода;',
		'- содержимое ответа определяется состоянием сервера в момент отправки запроса: медленная сеть только задерживает его доставку;',
		...(network.length ? network : ['- сеть есть всё время;']),
		'',
		'События (момент — в секундах; запросы пронумерованы):',
		'',
		'| момент | запрос | событие |',
		'|---|---|---|',
		...rows,
		'',
		'Введите через пробел для каждого запроса по порядку, какую версию ресурса получила страница (`v1`, `v2`, …), или `err`, если запрос завершился ошибкой. Например: `v1 v2 err v1`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json

p = json.loads(input())


def inside(spans, t):
    return any(a <= t <= b for a, b in spans)


def ver(path, t):
    return 1 + len([c for c in p["changes"].get(path, []) if c <= t])


class SW:
    def __init__(self, number, t):
        self.number = number
        self.store = {path: ver(path, t) if number > 1 else 1 for path in p["precache"]}
        self.gone = False


cur = SW(1, 0)
nxt = None
server_sw = 1
clients = {}
later = []  # (moment, sw, path, version): a late response lands in the cache
timers = []  # (moment, sw, path, version, answer index): a network-first timeout reads the cache
answers = []


def take_over(new):
    global cur, nxt
    cur.gone = True
    for tab in clients:
        clients[tab] = new
    cur = new
    nxt = None


def check_update(t):
    global nxt
    known = nxt.number if nxt else cur.number
    if server_sw > known and not inside(p["offline"], t):
        fresh = SW(server_sw, t)
        if p["skipWaiting"] or not clients:
            take_over(fresh)
        else:
            nxt = fresh


def store(sw, path, value, t):
    delay = p["latencySec"] if inside(p["slow"], t) else 0
    if delay:
        later.append((t + delay, sw, path, value))
    else:
        sw.store[path] = value


def serve(sw, path, t):
    if inside(p["offline"], t):
        if path == p["networkOnly"]:
            return "err"
        held = sw.store.get(path)
        return "err" if held is None else "v%d" % held
    now = ver(path, t)
    held = sw.store.get(path)
    if path in p["precache"] or path == p["image"]:
        if held is not None:
            return "v%d" % held
        store(sw, path, now, t)
        return "v%d" % now
    if path == p["networkFirst"]:
        store(sw, path, now, t)
        if inside(p["slow"], t) and p["latencySec"] > p["timeoutSec"]:
            timers.append((t + p["timeoutSec"], sw, path, now, len(answers)))
            return "?"
        return "v%d" % now
    if path == p["swr"]:
        store(sw, path, now, t)
        return "v%d" % (now if held is None else held)
    return "v%d" % now


def run_until(t):
    while True:
        due = [x for x in later + timers if x[0] <= t]
        if not due:
            return
        item = min(due, key=lambda x: x[0])
        if item in later:
            later.remove(item)
            item[1].store[item[2]] = item[3]
        else:
            timers.remove(item)
            held = item[1].store.get(item[2])
            answers[item[4]] = "v%d" % (item[3] if held is None else held)


for e in sorted(p["events"], key=lambda x: x["t"]):
    t = e["t"]
    run_until(t)
    kind = e["type"]
    if kind == "deploy":
        server_sw += 1
    elif kind in ("open", "reload"):
        clients[e["tab"]] = cur
        check_update(t)
    elif kind == "close":
        del clients[e["tab"]]
        if not clients and nxt is not None:
            take_over(nxt)
    else:
        answers.append(serve(clients[e["tab"]], e["path"], t))
run_until(float("inf"))
print(" ".join(answers))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/skip-waiting': ['update-at-deploy', 'skip-waiting-next-load', 'runtime-cache-kept'],
	'senior/waiting': ['update-at-deploy', 'reload-activates'],
	'senior/offline': ['swr-returns-fresh', 'swr-no-update', 'offline-nf-error', 'cache-first-as-network'],
	'senior/slow-network': ['nf-no-timeout', 'late-response-dropped', 'swr-returns-fresh']
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
	if (right.ambiguous) return null;
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
