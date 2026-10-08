// Name resolution: which full names a resolver tries for a name (search domains, ndots, a trailing dot), /etc/hosts
// before DNS, CNAME chains and names without an A record; for the junior level a caching resolver on a timeline —
// TTL of every record from the moment it was received, the expiry boundary, negative caching, a zone and /etc/hosts
// edited while the cache still holds the old answer.
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

const NX = 'NXDOMAIN';

interface Rules {
	noSearch: boolean;
	firstSearchOnly: boolean;
	alwaysAbsoluteFirst: boolean;
	alwaysSearchFirst: boolean;
	ndotsStrict: boolean;
	dnsFirst: boolean;
	hostsWithSearch: boolean;
	nodataStops: boolean;
	trailingDotIgnored: boolean;
	noCache: boolean;
	ttlInclusive: boolean;
	slidingTtl: boolean;
	chainFirstTtl: boolean;
	noNegativeCache: boolean;
	cacheBeforeFiles: boolean;
}

const RIGHT: Rules = {
	noSearch: false,
	firstSearchOnly: false,
	alwaysAbsoluteFirst: false,
	alwaysSearchFirst: false,
	ndotsStrict: false,
	dnsFirst: false,
	hostsWithSearch: false,
	nodataStops: false,
	trailingDotIgnored: false,
	noCache: false,
	ttlInclusive: false,
	slidingTtl: false,
	chainFirstTtl: false,
	noNegativeCache: false,
	cacheBeforeFiles: false
};

// Intern: one resolver configuration, several lookups.

interface Rec {
	type: 'A' | 'AAAA' | 'CNAME';
	value: string;
}

interface Static {
	search: string[];
	ndots: number;
	hosts: { ip: string; names: string[] }[];
	zone: Record<string, Rec[]>;
	lookups: string[];
}

function candidates(name: string, s: Static, rules: Rules): string[] {
	if (name.endsWith('.')) {
		if (!rules.trailingDotIgnored) return [name.slice(0, -1)];
		name = name.slice(0, -1);
	}
	const dots = name.split('.').length - 1;
	let absoluteFirst = rules.ndotsStrict ? dots > s.ndots : dots >= s.ndots;
	if (rules.alwaysAbsoluteFirst) absoluteFirst = true;
	if (rules.alwaysSearchFirst) absoluteFirst = false;
	const domains = rules.noSearch ? [] : rules.firstSearchOnly ? s.search.slice(0, 1) : s.search;
	const searched = domains.map((d) => `${name}.${d}`);
	return absoluteFirst ? [name, ...searched] : [...searched, name];
}

function addressOf(zone: Static['zone'], name: string): { exists: boolean; address: string | null } {
	let current = name;
	for (let depth = 0; depth < 10; depth += 1) {
		const recs = zone[current];
		if (!recs) return { exists: depth > 0, address: null };
		const a = recs.find((r) => r.type === 'A');
		if (a) return { exists: true, address: a.value };
		const cname = recs.find((r) => r.type === 'CNAME');
		if (!cname) return { exists: true, address: null };
		current = cname.value;
	}
	return { exists: true, address: null };
}

function lookupStatic(name: string, s: Static, rules: Rules): string {
	const fromHosts = (): string | null => {
		const names = rules.hostsWithSearch ? candidates(name, s, RIGHT) : [name.replace(/\.$/, '')];
		for (const n of names) {
			const entry = s.hosts.find((h) => h.names.includes(n));
			if (entry) return entry.ip;
		}
		return null;
	};
	const fromDns = (): string | null => {
		for (const c of candidates(name, s, rules)) {
			const r = addressOf(s.zone, c);
			if (r.address) return r.address;
			if (rules.nodataStops && r.exists) return null;
		}
		return null;
	};
	const first = rules.dnsFirst ? fromDns() : fromHosts();
	return first ?? (rules.dnsFirst ? fromHosts() : fromDns()) ?? NX;
}

// Junior: a caching resolver on a timeline.

interface TRec {
	type: 'A' | 'CNAME';
	value: string;
	ttl: number;
}

interface Timeline {
	zone: Record<string, TRec>;
	changes: { at: number; name: string; rec: TRec | null }[];
	negTtl: number;
	hosts: Record<string, string>;
	hostChanges: { at: number; name: string; ip: string | null }[];
	useHosts: boolean;
	queries: { t: number; name: string }[];
}

function zoneAt(p: Timeline, name: string, t: number): TRec | null {
	let rec = p.zone[name] ?? null;
	for (const c of p.changes) if (c.at <= t && c.name === name) rec = c.rec;
	return rec;
}

function hostsAt(p: Timeline, name: string, t: number): string | null {
	let ip = p.hosts[name] ?? null;
	for (const c of p.hostChanges) if (c.at <= t && c.name === name) ip = c.ip;
	return ip;
}

function simulate(p: Timeline, rules: Rules): string[] {
	const cache = new Map<string, { got: number; ttl: number; rec: TRec | null }>();
	const chains = new Map<string, { got: number; ttl: number; answer: string }>();
	const fresh = (got: number, ttl: number, t: number): boolean => (rules.ttlInclusive ? t <= got + ttl : t < got + ttl);
	const fetch = (name: string, t: number): TRec | null => {
		const entry = rules.noCache ? undefined : cache.get(name);
		if (entry && fresh(entry.got, entry.ttl, t)) {
			if (rules.slidingTtl) entry.got = t;
			return entry.rec;
		}
		const rec = zoneAt(p, name, t);
		if (!rules.noCache && !(rec === null && rules.noNegativeCache))
			cache.set(name, { got: t, ttl: rec ? rec.ttl : p.negTtl, rec });
		return rec;
	};
	const dns = (name: string, t: number): string => {
		if (rules.chainFirstTtl) {
			const entry = chains.get(name);
			if (entry && fresh(entry.got, entry.ttl, t)) return entry.answer;
			let current = name;
			let answer = NX;
			const first = zoneAt(p, name, t);
			for (let depth = 0; depth < 10; depth += 1) {
				const rec = zoneAt(p, current, t);
				if (!rec) break;
				if (rec.type === 'A') {
					answer = rec.value;
					break;
				}
				current = rec.value;
			}
			if (!(first === null && rules.noNegativeCache))
				chains.set(name, { got: t, ttl: first ? first.ttl : p.negTtl, answer });
			return answer;
		}
		let current = name;
		for (let depth = 0; depth < 10; depth += 1) {
			const rec = fetch(current, t);
			if (!rec) return NX;
			if (rec.type === 'A') return rec.value;
			current = rec.value;
		}
		return NX;
	};
	return p.queries.map(({ t, name }) => {
		if (!p.useHosts) return dns(name, t);
		if (rules.cacheBeforeFiles) {
			const entry = cache.get(name);
			if (entry && fresh(entry.got, entry.ttl, t)) return dns(name, t);
		}
		return hostsAt(p, name, t) ?? dns(name, t);
	});
}

// Scenarios.

const BASES = ['corp.example', 'acme.test', 'infra.example', 'north.example', 'shop.test', 'lab.example'];
const ENVS = ['stage', 'prod', 'dev', 'qa', 'eu', 'us'];
const SERVICES = ['api', 'db', 'cache', 'auth', 'mq', 'git', 'ci', 'vault', 'grafana', 'kafka', 'wiki', 'jira'];

class Ips {
	readonly #used = new Set<string>();
	readonly #rng: Rng;
	constructor(rng: Rng) {
		this.#rng = rng;
	}
	next(): string {
		for (;;) {
			const ip = `10.${this.#rng.int(0, 255)}.${this.#rng.int(0, 255)}.${this.#rng.int(2, 254)}`;
			if (!this.#used.has(ip)) {
				this.#used.add(ip);
				return ip;
			}
		}
	}
}

function staticScenario(rng: Rng, classId: string): Static {
	const ips = new Ips(rng);
	const base = rng.pick(BASES);
	const [env1 = 'stage', env2 = 'prod'] = rng.sample(ENVS, 2);
	const zone: Static['zone'] = {};
	const add = (name: string, rec: Rec): void => {
		zone[name] = [...(zone[name] ?? []), rec];
	};
	const services = rng.sample(SERVICES, 6);
	const svc = (i: number): string => services[i] ?? 'api';
	if (classId === 'search-order') {
		const search = rng.bool() ? [`${env1}.${base}`, `${env2}.${base}`, base] : [`${env1}.${base}`, base];
		const lookups = services.slice(0, rng.int(4, 5));
		for (const name of lookups) {
			const where = search.filter(() => rng.bool(0.55));
			for (const d of where) add(`${name}.${d}`, { type: 'A', value: ips.next() });
		}
		return { search, ndots: 1, hosts: [], zone, lookups };
	}
	if (classId === 'ndots') {
		const ndots = rng.int(2, 3);
		const search = rng.bool() ? [`${env1}.${base}`] : [`${env1}.${base}`, base];
		const suffixes =
			ndots === 2
				? ['internal', `${env2}.internal`, 'svc', `mesh.svc`]
				: [`${env2}.internal`, `blue.${env2}.internal`, 'svc.cluster', `${env1}.svc.cluster`];
		const lookups: string[] = [];
		for (let i = 0; i < rng.int(4, 5); i += 1) {
			const name = `${svc(i)}.${rng.pick(suffixes)}`;
			if (lookups.includes(name)) continue;
			lookups.push(name);
			const both = rng.bool(0.75);
			if (both || rng.bool()) add(name, { type: 'A', value: ips.next() });
			if (both || !zone[name]) add(`${name}.${search[0] ?? base}`, { type: 'A', value: ips.next() });
			if (search.length > 1 && rng.bool(0.3)) add(`${name}.${base}`, { type: 'A', value: ips.next() });
		}
		return { search, ndots, hosts: [], zone, lookups };
	}
	if (classId === 'hosts-file') {
		const search = rng.bool() ? [base] : [`${env1}.${base}`, base];
		const last = search[search.length - 1] ?? base;
		const [aliased, fqdnOnly, shortOnly, dnsOnly] = [svc(0), svc(1), svc(2), svc(3)];
		const hosts = [
			{ ip: ips.next(), names: [`${aliased}.${last}`, aliased] },
			{ ip: ips.next(), names: [`${fqdnOnly}.${last}`] },
			{ ip: ips.next(), names: [shortOnly] }
		];
		for (const name of [aliased, fqdnOnly, shortOnly, dnsOnly])
			add(`${name}.${last}`, { type: 'A', value: ips.next() });
		const lookups = rng
			.shuffle([aliased, fqdnOnly, `${fqdnOnly}.${last}`, rng.pick([`${shortOnly}.${last}`, shortOnly]), dnsOnly])
			.slice(0, rng.int(4, 5));
		return { search, ndots: 1, hosts: rng.shuffle(hosts), zone, lookups };
	}
	// CNAME chains, names without an A record, a name with a trailing dot.
	const search = [`${env1}.${base}`, base];
	const lookups: string[] = [];
	const lb = `lb-${rng.int(1, 9)}.${base}`;
	add(lb, { type: 'A', value: ips.next() });
	add(`${svc(0)}.${env1}.${base}`, { type: 'CNAME', value: lb });
	lookups.push(svc(0));
	const cdn = `${svc(1)}.cdn-${rng.int(10, 99)}.example`;
	add(`${svc(1)}.${env1}.${base}`, { type: 'CNAME', value: cdn });
	if (rng.bool()) add(cdn, { type: 'AAAA', value: `fd00::${rng.int(1, 999)}` });
	add(`${svc(1)}.${base}`, { type: 'A', value: ips.next() });
	lookups.push(svc(1));
	add(`${svc(2)}.${env1}.${base}`, { type: 'AAAA', value: `fd00::${rng.int(1, 999)}` });
	const mid = `${svc(2)}-${rng.pick(['blue', 'green'])}.${base}`;
	add(`${svc(2)}.${base}`, { type: 'CNAME', value: mid });
	add(mid, { type: 'A', value: ips.next() });
	lookups.push(svc(2));
	add(`${svc(3)}.${base}`, { type: 'A', value: ips.next() });
	add(`${svc(3)}.${base}.${env1}.${base}`, { type: 'A', value: ips.next() });
	lookups.push(`${svc(3)}.${base}.`);
	if (rng.bool()) {
		add(`${svc(4)}.${env1}.${base}`, { type: 'CNAME', value: `${svc(4)}.old.${base}` });
		lookups.push(svc(4));
	}
	return { search, ndots: 3, hosts: [], zone, lookups: rng.shuffle(lookups) };
}

function describeStatic(s: Static): string {
	const rows = Object.entries(s.zone).flatMap(([name, recs]) =>
		recs.map((r) => `| \`${name}\` | ${r.type} | \`${r.value}\` |`)
	);
	const lines = [
		'Приложение разрешает имена в адреса IPv4 (запрос A). Настройки хоста:',
		'',
		'- `/etc/nsswitch.conf`: `hosts: files dns`;',
		`- \`/etc/resolv.conf\`: \`search ${s.search.join(' ')}\` и \`options ndots:${s.ndots}\`.`,
		''
	];
	if (s.hosts.length) lines.push('`/etc/hosts`:', '', ...s.hosts.map((h) => `- \`${h.ip} ${h.names.join(' ')}\``), '');
	else lines.push('В `/etc/hosts` только строки для `localhost`.', '');
	lines.push(
		'Все записи DNS (других имён нет):',
		'',
		'| Имя | Тип | Значение |',
		'|---|---|---|',
		...rows,
		'',
		'Правила:',
		'',
		'- источники опрашиваются в порядке `hosts:`; в `/etc/hosts` имя ищется ровно в том виде, как его запросили (среди имени и псевдонимов строки), search-домены к файлу не применяются;',
		'- имя с точкой на конце пробуется только как есть; иначе, если точек в имени не меньше `ndots`, оно пробуется сначала как есть, затем с каждым search-доменом по порядку, а если меньше — сначала с search-доменами, затем как есть;',
		'- для каждого полного имени: есть A-запись — это ответ; есть CNAME — так же разрешается имя-цель; если у имени (или в конце цепочки) нет A-записи или имени нет вовсе, пробуется следующее полное имя;',
		'- если ни одно полное имя не дало адреса — ответ `NXDOMAIN`.',
		'',
		'Приложение запрашивает имена:',
		'',
		...s.lookups.map((name, i) => `${i + 1}. \`${name}\``),
		'',
		'Введите ответы в порядке запросов, по одному в строке: адрес IPv4 или `NXDOMAIN`.'
	);
	return lines.join('\n');
}

const pickTtl = (rng: Rng, from: readonly number[]): number => rng.pick(from);

function timelineScenario(rng: Rng, classId: string): Timeline {
	const ips = new Ips(rng);
	const base = rng.pick(BASES);
	const services = rng.sample(SERVICES, 4);
	const n1 = `${services[0] ?? 'api'}.${base}`;
	const n2 = `${services[1] ?? 'db'}.${base}`;
	const zone: Timeline['zone'] = {};
	const changes: Timeline['changes'] = [];
	const hosts: Timeline['hosts'] = {};
	const hostChanges: Timeline['hostChanges'] = [];
	const queries: Timeline['queries'] = [];
	const negTtl = pickTtl(rng, [30, 60, 90, 120]);
	const a = rng.int(0, 15);
	const ttl1 = pickTtl(rng, [30, 60, 120, 300]);
	const ttl2 = pickTtl(rng, [20, 45, 60, 90]);
	const between = (lo: number, hi: number): number => (hi - lo > 1 ? rng.int(lo + 1, hi - 1) : lo);
	if (classId === 'ttl-change') {
		zone[n1] = { type: 'A', value: ips.next(), ttl: ttl1 };
		zone[n2] = { type: 'A', value: ips.next(), ttl: ttl2 };
		const c = between(a, a + ttl1);
		changes.push({ at: c, name: n1, rec: { type: 'A', value: ips.next(), ttl: ttl1 } });
		queries.push({ t: a, name: n1 }, { t: between(c, a + ttl1), name: n1 }, { t: a + ttl1, name: n1 });
		const b = a + rng.int(1, 10);
		const d = between(b, b + ttl2);
		changes.push({ at: d, name: n2, rec: { type: 'A', value: ips.next(), ttl: ttl2 } });
		queries.push({ t: b, name: n2 }, { t: b + ttl2 + rng.pick([0, 0, 5]), name: n2 });
		if (rng.bool()) queries.push({ t: a + ttl1 + rng.int(1, 9), name: n1 });
	} else if (classId === 'cname-ttl') {
		const lb1 = `lb1.${base}`;
		const lb2 = `lb2.${base}`;
		const ttlC = pickTtl(rng, [300, 600, 900]);
		const ttlA = pickTtl(rng, [30, 60, 120]);
		zone[n1] = { type: 'CNAME', value: lb1, ttl: ttlC };
		zone[lb1] = { type: 'A', value: ips.next(), ttl: ttlA };
		zone[lb2] = { type: 'A', value: ips.next(), ttl: ttlA };
		const c = between(a, a + ttlA);
		changes.push({ at: c, name: lb1, rec: { type: 'A', value: ips.next(), ttl: ttlA } });
		const q2 = a + ttlA + rng.int(0, 20);
		const c2 = q2 + rng.int(5, 60);
		changes.push({ at: c2, name: n1, rec: { type: 'CNAME', value: lb2, ttl: ttlC } });
		queries.push(
			{ t: a, name: n1 },
			{ t: q2, name: n1 },
			{ t: between(c2, a + ttlC), name: n1 },
			{ t: a + ttlC, name: n1 }
		);
		if (rng.bool()) queries.push({ t: between(a, c), name: lb1 });
	} else if (classId === 'negative-cache') {
		const ttl = pickTtl(rng, [60, 120, 300]);
		const c = between(a, a + negTtl);
		changes.push({ at: c, name: n1, rec: { type: 'A', value: ips.next(), ttl } });
		queries.push({ t: a, name: n1 }, { t: between(c, a + negTtl), name: n1 }, { t: a + negTtl, name: n1 });
		zone[n2] = { type: 'A', value: ips.next(), ttl: ttl2 };
		const b = a + rng.int(1, 10);
		const d = between(b, b + ttl2);
		changes.push({ at: d, name: n2, rec: null });
		queries.push({ t: b, name: n2 }, { t: between(d, b + ttl2), name: n2 }, { t: b + ttl2 + rng.int(0, 5), name: n2 });
	} else {
		zone[n1] = { type: 'A', value: ips.next(), ttl: ttl1 };
		zone[n2] = { type: 'A', value: ips.next(), ttl: ttl2 };
		hosts[n2] = ips.next();
		const h = between(a, a + ttl1);
		hostChanges.push({ at: h, name: n1, ip: ips.next() });
		queries.push({ t: a, name: n1 }, { t: between(h, a + ttl1), name: n1 });
		const b = a + rng.int(1, 10);
		queries.push({ t: b, name: n2 });
		const h2 = b + rng.int(5, 40);
		hostChanges.push({ at: h2, name: n2, ip: null });
		queries.push({ t: h2 + rng.int(0, 10), name: n2 });
		const h3 = Math.max(h, h2) + rng.int(5, 30);
		hostChanges.push({ at: h3, name: n1, ip: null });
		queries.push({ t: h3 + rng.int(0, 10), name: n1 });
	}
	queries.sort((x, y) => x.t - y.t);
	changes.sort((x, y) => x.at - y.at);
	hostChanges.sort((x, y) => x.at - y.at);
	return { zone, changes, negTtl, hosts, hostChanges, useHosts: classId === 'hosts-and-cache', queries };
}

function recText(rec: TRec | null): string {
	return rec ? `${rec.type} \`${rec.value}\`, TTL ${rec.ttl}` : 'запись удалена';
}

function describeTimeline(p: Timeline): string {
	const rows = Object.entries(p.zone).map(
		([name, rec]) => `| \`${name}\` | ${rec.type} | \`${rec.value}\` | ${rec.ttl} |`
	);
	const events = [
		...p.changes.map((c) => ({ at: c.at, text: `в зоне: \`${c.name}\` — ${recText(c.rec)}` })),
		...p.hostChanges.map((c) => ({
			at: c.at,
			text: c.ip
				? `в \`/etc/hosts\` добавлена строка \`${c.ip} ${c.name}\``
				: `из \`/etc/hosts\` удалена строка с \`${c.name}\``
		}))
	].sort((x, y) => x.at - y.at);
	const hostsLines = Object.entries(p.hosts).map(([name, ip]) => `\`${ip} ${name}\``);
	return [
		'Приложение разрешает имена в адреса IPv4 через локальный кэширующий резолвер. Время — в секундах от начала наблюдения. В момент 0 кэш резолвера пуст; других запросов к резолверу, кроме перечисленных ниже, нет.',
		'',
		'Записи зоны в момент 0 (других имён нет):',
		'',
		'| Имя | Тип | Значение | TTL, с |',
		'|---|---|---|---|',
		...rows,
		'',
		...(p.useHosts
			? [
					`\`/etc/nsswitch.conf\`: \`hosts: files dns\`; \`/etc/hosts\` в момент 0: ${hostsLines.length ? hostsLines.join(', ') : 'нужных имён нет'}. Файл читается заново при каждом запросе и в кэш резолвера не попадает: правку файла в момент c видят запросы в момент c и позже.`,
					''
				]
			: []),
		'Изменения:',
		'',
		...events.map((e, i) => `- в момент ${e.at} ${e.text}${i === events.length - 1 ? '.' : ';'}`),
		'',
		'Правила резолвера:',
		'',
		'- на запрос имени авторитетный сервер отдаёт одну запись этого имени (A или CNAME) или ответ «имени нет»; изменение, сделанное в момент c, сервер отдаёт на запросы в момент c и позже;',
		'- каждая полученная запись кладётся в кэш отдельно, со своим TTL от момента получения: запрос в момент t берёт её из кэша, если t < момент получения + TTL; иначе запись запрашивается у сервера заново и кэшируется снова; попадание в кэш срок не продлевает;',
		`- ответ «имени нет» кэшируется так же, на ${p.negTtl} с (отрицательный TTL зоны);`,
		'- для CNAME резолвер так же, из кэша или с сервера, разрешает имя-цель.',
		'',
		'Запросы приложения:',
		'',
		...p.queries.map((q, i) => `${i + 1}. в момент ${q.t} — \`${q.name}\``),
		'',
		'Введите ответы в порядке запросов, по одному в строке: адрес IPv4 или `NXDOMAIN`.'
	].join('\n');
}

const PYTHON_STATIC = `import json

p = json.loads(input())
zone = p["zone"]


def full_names(name):
    if name.endswith("."):
        return [name[:-1]]
    with_search = [name + "." + d for d in p["search"]]
    if name.count(".") >= p["ndots"]:
        return [name] + with_search
    return with_search + [name]


def a_record(name):
    seen = 0
    while name in zone and seen < 10:
        seen += 1
        recs = zone[name]
        a = [r["value"] for r in recs if r["type"] == "A"]
        if a:
            return a[0]
        c = [r["value"] for r in recs if r["type"] == "CNAME"]
        if not c:
            return None
        name = c[0]
    return None


def from_hosts(name):
    name = name.rstrip(".")
    for line in p["hosts"]:
        if name in line["names"]:
            return line["ip"]
    return None


for name in p["lookups"]:
    answer = from_hosts(name)
    if answer is None:
        for full in full_names(name):
            answer = a_record(full)
            if answer:
                break
    print(answer or "NXDOMAIN")
`;

const PYTHON_TIMELINE = `import json

p = json.loads(input())


def authoritative(name, t):
    rec = p["zone"].get(name)
    for c in p["changes"]:
        if c["at"] <= t and c["name"] == name:
            rec = c["rec"]
    return rec


def hosts(name, t):
    ip = p["hosts"].get(name)
    for c in p["hostChanges"]:
        if c["at"] <= t and c["name"] == name:
            ip = c["ip"]
    return ip


cache = {}


def record(name, t):
    if name in cache:
        got, ttl, rec = cache[name]
        if t < got + ttl:
            return rec
    rec = authoritative(name, t)
    cache[name] = (t, rec["ttl"] if rec else p["negTtl"], rec)
    return rec


def resolve(name, t):
    for _ in range(10):
        rec = record(name, t)
        if rec is None:
            return "NXDOMAIN"
        if rec["type"] == "A":
            return rec["value"]
        name = rec["value"]
    return "NXDOMAIN"


for q in p["queries"]:
    ip = hosts(q["name"], q["t"]) if p["useHosts"] else None
    print(ip or resolve(q["name"], q["t"]))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'no-search': { noSearch: true },
	'first-search-only': { firstSearchOnly: true },
	'always-absolute-first': { alwaysAbsoluteFirst: true },
	'always-search-first': { alwaysSearchFirst: true },
	'ndots-strict': { ndotsStrict: true },
	'dns-first': { dnsFirst: true },
	'hosts-with-search': { hostsWithSearch: true },
	'nodata-stops': { nodataStops: true },
	'trailing-dot-ignored': { trailingDotIgnored: true },
	'no-cache': { noCache: true },
	'ttl-inclusive': { ttlInclusive: true },
	'sliding-ttl': { slidingTtl: true },
	'chain-first-ttl': { chainFirstTtl: true },
	'no-negative-cache': { noNegativeCache: true },
	'cache-before-files': { cacheBeforeFiles: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/search-order': ['no-search', 'first-search-only'],
	'intern/ndots': ['always-absolute-first', 'always-search-first', 'ndots-strict'],
	'intern/hosts-file': ['dns-first', 'hosts-with-search'],
	'intern/cname-chain': ['nodata-stops', 'trailing-dot-ignored'],
	'junior/ttl-change': ['no-cache', 'ttl-inclusive', 'sliding-ttl'],
	'junior/cname-ttl': ['chain-first-ttl'],
	'junior/negative-cache': ['no-negative-cache', 'ttl-inclusive'],
	'junior/hosts-and-cache': ['cache-before-files']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class requires changes the answer and not every answer is the
	// same.
	for (let tries = 0; tries < 400; tries += 1) {
		const intern = input.grade === 'intern';
		const s = intern ? staticScenario(rng, input.classId) : null;
		const t = intern ? null : timelineScenario(rng, input.classId);
		const solve = (rules: Rules): string[] =>
			s ? s.lookups.map((name) => lookupStatic(name, s, rules)) : simulate(t as Timeline, rules);
		const answer = solve(RIGHT);
		if (new Set(answer).size < 2) continue;
		if (new Set((t?.queries ?? []).map((q) => q.t)).size !== (t?.queries.length ?? 0)) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve({ ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: s ? describeStatic(s) : describeTimeline(t as Timeline), code: null },
			answer: { kind: 'sequence', value: answer }
		});
		const reference = s
			? { source: PYTHON_STATIC, stdin: JSON.stringify(s) }
			: { source: PYTHON_TIMELINE, stdin: JSON.stringify(t) };
		return {
			instance,
			reference: () => ({ kind: 'output', ...reference }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
