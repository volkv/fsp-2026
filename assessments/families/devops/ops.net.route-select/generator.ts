// Route selection: for each destination, the route a Linux host takes from its table — the longest matching prefix,
// the metric between equal prefixes, blackhole and unreachable routes, no route at all; for the junior level policy
// routing: rules choose a table by source and destination in the order of their priority and fall through to the
// next rule when the table has no matching route.
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

import { blockSize, ip, netOf, toIp } from '../../_lib/ipv4.ts';
const descriptor = readDescriptor(import.meta.url);

const inPrefix = (address: number, net: number, len: number): boolean => netOf(address, len) === net;

interface Route {
	type: 'unicast' | 'blackhole' | 'unreachable';
	net: number;
	len: number;
	via: number | null;
	dev: string | null;
	/** `null` — not written (0). */
	metric: number | null;
}

interface PolicyRule {
	prio: number;
	from: [number, number] | null;
	to: [number, number] | null;
	table: string;
}

interface Packet {
	src: number | null;
	dst: number;
}

interface Params {
	tables: Record<string, Route[]>;
	/** `null` — only the table `main`. */
	rules: PolicyRule[] | null;
	packets: Packet[];
}

interface Rules {
	firstListed: boolean;
	metricFirst: boolean;
	higherMetric: boolean;
	skipSpecial: boolean;
	octetRound: boolean;
	mainOnly: boolean;
	noFallthrough: boolean;
	listedOrder: boolean;
	specialFallsThrough: boolean;
	fromAsTo: boolean;
}

const RIGHT: Rules = {
	firstListed: false,
	metricFirst: false,
	higherMetric: false,
	skipSpecial: false,
	octetRound: false,
	mainOnly: false,
	noFallthrough: false,
	listedOrder: false,
	specialFallsThrough: false,
	fromAsTo: false
};

const metricOf = (r: Route): number => r.metric ?? 0;

function lookup(table: readonly Route[], dst: number, rules: Rules): Route | null {
	const effLen = (r: Route): number => (rules.octetRound ? 8 * Math.floor(r.len / 8) : r.len);
	let found = table.filter((r) => inPrefix(dst, netOf(r.net, effLen(r)), effLen(r)));
	if (rules.skipSpecial) found = found.filter((r) => r.type === 'unicast');
	if (found.length === 0) return null;
	if (rules.firstListed) return found[0] ?? null;
	const byMetric = (a: Route, b: Route): number =>
		rules.higherMetric ? metricOf(b) - metricOf(a) : metricOf(a) - metricOf(b);
	const sorted = [...found].sort((a, b) =>
		rules.metricFirst ? byMetric(a, b) || effLen(b) - effLen(a) : effLen(b) - effLen(a) || byMetric(a, b)
	);
	return sorted[0] ?? null;
}

function outcome(r: Route | null): string {
	if (!r) return 'unreachable';
	if (r.type !== 'unicast') return r.type;
	return r.via === null ? `dev ${r.dev}` : `via ${toIp(r.via)} dev ${r.dev}`;
}

function resolve(pkt: Packet, p: Params, rules: Rules): string {
	const main = p.tables.main ?? [];
	if (!p.rules || rules.mainOnly) return outcome(lookup(main, pkt.dst, rules));
	const ordered = rules.listedOrder ? p.rules : [...p.rules].sort((a, b) => a.prio - b.prio);
	for (const rule of ordered) {
		const fromAddress = rules.fromAsTo ? pkt.dst : (pkt.src ?? 0);
		if (rule.from && !inPrefix(fromAddress, rule.from[0], rule.from[1])) continue;
		if (rule.to && !inPrefix(pkt.dst, rule.to[0], rule.to[1])) continue;
		const r = lookup(p.tables[rule.table] ?? [], pkt.dst, rules);
		if (!r) {
			if (rules.noFallthrough) return 'unreachable';
			continue;
		}
		if (r.type !== 'unicast' && rules.specialFallsThrough) continue;
		return outcome(r);
	}
	return 'unreachable';
}

const solve = (p: Params, rules: Rules): string[] => p.packets.map((pkt) => resolve(pkt, p, rules));

// Scenarios.

interface Net {
	lan: number;
	host: number;
	gw: number;
	lan2: number;
	gw2: number;
	tun: number;
	peer: number;
}

function network(rng: Rng): Net {
	const a = rng.int(1, 99);
	const b = rng.int(0, 255);
	const lan = ip(10, a, b, 0);
	const lan2 = ip(192, 168, rng.int(1, 250), 0);
	const tun = ip(10, 200, rng.int(0, 255), 0);
	return { lan, host: lan + rng.int(10, 200), gw: lan + 1, lan2, gw2: lan2 + 254, tun, peer: tun + 1 };
}

const direct = (net: number, len: number, dev: string): Route => ({
	type: 'unicast',
	net,
	len,
	via: null,
	dev,
	metric: null
});
const via = (net: number, len: number, gw: number, dev: string, metric: number | null = null): Route => ({
	type: 'unicast',
	net,
	len,
	via: gw,
	dev,
	metric
});
const special = (type: 'blackhole' | 'unreachable', net: number, len: number): Route => ({
	type,
	net,
	len,
	via: null,
	dev: null,
	metric: null
});

/** A prefix of length `len` inside `parent/parentLen`. */
const inside = (rng: Rng, parent: number, parentLen: number, len: number): number =>
	parent + blockSize(len) * rng.int(0, blockSize(parentLen) / blockSize(len) - 1);

const REMOTE_FIRST = [172, 100, 185, 31, 91, 46];
const randomRemote = (rng: Rng, len: number): number =>
	netOf(ip(rng.pick(REMOTE_FIRST), rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)), len);
const randomPublic = (rng: Rng): number =>
	ip(rng.pick([8, 77, 93, 151, 203, 216]), rng.int(0, 255), rng.int(0, 255), rng.int(1, 254));

/** Not the network or broadcast address of a /24, which hosts do not send to. */
const usable = (address: number): boolean => address % 256 !== 0 && address % 256 !== 255;

/** Destinations whose right answers differ as much as possible: one per outcome, then random ones. */
function pickDestinations(
	rng: Rng,
	pool: readonly number[],
	outcomeOf: (dst: number) => string,
	count: number
): number[] {
	const groups = new Map<string, number[]>();
	for (const dst of rng.shuffle(pool.filter(usable)))
		groups.set(outcomeOf(dst), [...(groups.get(outcomeOf(dst)) ?? []), dst]);
	const chosen = rng.shuffle([...groups.values()]).map((g) => g[0] ?? 0);
	const rest = rng.shuffle(pool.filter((d) => usable(d) && !chosen.includes(d)));
	return rng.shuffle([...chosen.slice(0, count), ...rest].slice(0, count));
}

function samplesIn(rng: Rng, net: number, len: number, n: number): number[] {
	return Array.from({ length: n }, () => net + rng.int(0, blockSize(len) - 1));
}

function internScenario(rng: Rng, classId: string): Params {
	const n = network(rng);
	const main: Route[] = [direct(n.lan, 24, 'eth0'), direct(n.lan2, 24, 'eth1'), direct(n.tun, 24, 'wg0')];
	const pool: number[] = [...samplesIn(rng, n.lan2, 24, 2), ...samplesIn(rng, n.tun, 24, 1)];
	const gwOnLan = (): number => n.lan + rng.int(2, 9);
	if (classId === 'longest-prefix') {
		main.push(via(0, 0, n.gw, 'eth0', rng.pick([null, 100])));
		const l1 = rng.int(12, 16);
		const r1 = randomRemote(rng, l1);
		const l2 = rng.int(17, 21);
		const r2 = inside(rng, r1, l1, l2);
		const l3 = rng.int(22, 26);
		const r3 = inside(rng, r2, l2, l3);
		main.push(via(r1, l1, n.gw2, 'eth1'), via(r2, l2, n.peer, 'wg0'), via(r3, l3, gwOnLan(), 'eth0'));
		pool.push(
			...samplesIn(rng, r1, l1, 6),
			...samplesIn(rng, r2, l2, 6),
			...samplesIn(rng, r3, l3, 4),
			randomPublic(rng)
		);
	} else if (classId === 'metric') {
		main.push(via(0, 0, n.gw, 'eth0', 100), via(0, 0, n.gw2, 'eth1', rng.pick([50, 200, 600])));
		const l1 = rng.int(12, 18);
		const r1 = randomRemote(rng, l1);
		const [m1, m2] = rng.shuffle([rng.int(1, 9) * 10, rng.int(11, 40) * 10]);
		main.push(via(r1, l1, n.peer, 'wg0', m1 ?? 10), via(r1, l1, gwOnLan(), 'eth0', m2 ?? 200));
		const l2 = rng.int(20, 26);
		const r2 = inside(rng, r1, l1, l2);
		main.push(via(r2, l2, n.gw2, 'eth1', rng.int(50, 99) * 10));
		pool.push(...samplesIn(rng, r1, l1, 6), ...samplesIn(rng, r2, l2, 4), randomPublic(rng), randomPublic(rng));
	} else if (classId === 'blackhole') {
		main.push(via(0, 0, n.gw, 'eth0', rng.pick([null, 100])));
		const l1 = rng.int(12, 16);
		const r1 = randomRemote(rng, l1);
		main.push(via(r1, l1, n.peer, 'wg0'));
		const lb = rng.int(18, 24);
		const b = inside(rng, r1, l1, lb);
		main.push(special('blackhole', b, lb));
		const lu = rng.int(17, 24);
		const u = rng.bool() ? inside(rng, r1, l1, lu) : randomRemote(rng, lu);
		if (!inPrefix(u, b, lb) && !inPrefix(b, u, lu)) main.push(special('unreachable', u, lu));
		const lv = rng.int(25, 28);
		const v = inside(rng, b, lb, lv);
		if (rng.bool()) main.push(via(v, lv, gwOnLan(), 'eth0'));
		pool.push(
			...samplesIn(rng, r1, l1, 6),
			...samplesIn(rng, b, lb, 4),
			...samplesIn(rng, u, lu, 3),
			...samplesIn(rng, v, lv, 2),
			randomPublic(rng)
		);
	} else {
		const lens = rng.sample([13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27], 4).sort((x, y) => x - y);
		const [l1 = 13, l2 = 19, l3 = 21, l4 = 27] = lens;
		const r1 = randomRemote(rng, l1);
		const r2 = inside(rng, r1, l1, l2);
		const r3 = randomRemote(rng, l3);
		const r4 = inside(rng, r3, l3, l4);
		main.push(
			via(r1, l1, n.gw2, 'eth1'),
			via(r2, l2, n.peer, 'wg0'),
			via(r3, l3, gwOnLan(), 'eth0'),
			via(r4, l4, n.gw, 'eth0')
		);
		for (const [net, len] of [
			[r1, l1],
			[r2, l2],
			[r3, l3],
			[r4, l4]
		] as const) {
			pool.push(...samplesIn(rng, net, len, 3));
			const round = 8 * Math.floor(len / 8);
			pool.push(...samplesIn(rng, netOf(net, round), round, 4));
		}
		pool.push(randomPublic(rng));
	}
	const p: Params = { tables: { main: rng.shuffle(main) }, rules: null, packets: [] };
	const dsts = pickDestinations(rng, pool, (dst) => resolve({ src: null, dst }, p, RIGHT), 5);
	p.packets = dsts.map((dst) => ({ src: null, dst }));
	return p;
}

function juniorScenario(rng: Rng, classId: string): Params {
	const n = network(rng);
	const isp = ip(100, 64, rng.int(0, 255), 0);
	const ispGw = isp + 1;
	const main: Route[] = [
		direct(n.lan, 24, 'eth0'),
		direct(n.lan2, 24, 'eth1'),
		direct(n.tun, 24, 'wg0'),
		direct(isp, 24, 'eth2'),
		via(0, 0, n.gw, 'eth0')
	];
	const corp = ip(10, 0, 0, 0);
	const vpn: Route[] = [];
	const isp2: Route[] = [via(0, 0, ispGw, 'eth2')];
	const lanHalf = n.lan + 128;
	const rules: PolicyRule[] = [];
	const remoteA = randomRemote(rng, rng.int(16, 20));
	if (classId === 'by-source') {
		vpn.push(via(0, 0, n.peer, 'wg0'), via(remoteA, 20, n.peer, 'wg0', 10));
		rules.push(
			{ prio: rng.int(1, 9) * 100, from: [n.lan2, 24], to: null, table: 'vpn' },
			{ prio: 1000 + rng.int(1, 9) * 100, from: [lanHalf, 25], to: null, table: 'isp2' }
		);
	} else if (classId === 'fallthrough') {
		vpn.push(via(corp, 8, n.peer, 'wg0'), via(netOf(remoteA, 16), 16, n.peer, 'wg0'));
		rules.push(
			{ prio: rng.int(1, 9) * 100, from: [n.lan2, 24], to: null, table: 'vpn' },
			{ prio: 1000 + rng.int(1, 9) * 100, from: [n.lan2, 24], to: null, table: 'isp2' }
		);
	} else if (classId === 'priority-order') {
		vpn.push(via(0, 0, n.peer, 'wg0'));
		const prios = rng.shuffle([100, 200, 300]);
		rules.push(
			{ prio: prios[0] ?? 100, from: null, to: [corp, 8], table: 'vpn' },
			{ prio: prios[1] ?? 200, from: [n.lan2, 24], to: null, table: 'isp2' },
			{ prio: prios[2] ?? 300, from: [lanHalf, 25], to: null, table: 'vpn' }
		);
	} else {
		const lb = rng.int(16, 20);
		const lu = rng.int(12, 16);
		vpn.push(
			via(0, 0, n.peer, 'wg0'),
			special('blackhole', netOf(ip(10, rng.int(100, 199), rng.int(0, 255), 0), lb), lb),
			special('unreachable', randomRemote(rng, lu), lu)
		);
		rules.push({ prio: rng.int(1, 9) * 100, from: [n.lan2, 24], to: null, table: 'vpn' });
		if (rng.bool()) rules.push({ prio: 1000 + rng.int(1, 9) * 100, from: [lanHalf, 25], to: null, table: 'isp2' });
	}
	rules.push({ prio: 32766, from: null, to: null, table: 'main' });
	const tables: Record<string, Route[]> = { main: rng.shuffle(main), vpn: rng.shuffle(vpn) };
	if (rules.some((r) => r.table === 'isp2')) tables.isp2 = isp2;
	const p: Params = { tables, rules: classId === 'priority-order' ? rng.shuffle(rules) : rules, packets: [] };
	// Sources from both LANs (both halves of the first); destinations everywhere the tables tell apart.
	const sources = [
		...samplesIn(rng, n.lan, 25, 2),
		...samplesIn(rng, lanHalf, 25, 2),
		...samplesIn(rng, n.lan2, 24, 3)
	];
	const dstPool = [
		...samplesIn(rng, corp, 8, 3),
		...samplesIn(rng, n.lan, 24, 1),
		...samplesIn(rng, n.lan2, 24, 1),
		...Object.values(tables)
			.flat()
			.filter((r) => r.len > 0)
			.flatMap((r) => samplesIn(rng, r.net, r.len, 2)),
		randomPublic(rng),
		randomPublic(rng),
		randomPublic(rng)
	];
	// Hosts of one subnet talk directly: a packet to its own subnet never reaches the router.
	const pool = rng
		.shuffle(dstPool.filter(usable))
		.map((dst) => ({ src: rng.pick(sources), dst }))
		.filter((pkt) => netOf(pkt.src, 24) !== netOf(pkt.dst, 24));
	const keyed = new Map<string, Packet[]>();
	for (const pkt of pool) keyed.set(resolve(pkt, p, RIGHT), [...(keyed.get(resolve(pkt, p, RIGHT)) ?? []), pkt]);
	const chosen = rng.shuffle([...keyed.values()]).map((g) => g[0] as Packet);
	const rest = rng.shuffle(pool.filter((x) => !chosen.includes(x)));
	p.packets = rng.shuffle([...chosen.slice(0, 5), ...rest].slice(0, 5));
	return p;
}

function routeText(r: Route): string {
	if (r.type !== 'unicast') return `${r.type} ${toIp(r.net)}/${r.len}`;
	const dest = r.len === 0 ? 'default' : `${toIp(r.net)}/${r.len}`;
	const metric = r.metric === null ? '' : ` metric ${r.metric}`;
	return r.via === null
		? `${dest} dev ${r.dev} scope link${metric}`
		: `${dest} via ${toIp(r.via)} dev ${r.dev}${metric}`;
}

const prefixText = (pfx: [number, number] | null): string => (pfx ? `${toIp(pfx[0])}/${pfx[1]}` : 'all');

const ANSWER_FORMAT =
	'Введите ответы в порядке пакетов, по одному в строке: `via <шлюз> dev <интерфейс>` для маршрута через шлюз, `dev <интерфейс>` для сети прямо на интерфейсе, `blackhole` или `unreachable`. Например: `via 10.0.0.1 dev eth0`.';

const ROUTE_RULES = [
	'- метрика не указана — она 0; из маршрутов с одинаковой длиной префикса выбирается маршрут с меньшей метрикой;',
	'- если выбран маршрут `blackhole` или `unreachable`, ответ — это слово;'
];

function describe(p: Params): string {
	const table = (name: string): string[] => (p.tables[name] ?? []).map((r) => `- \`${routeText(r)}\``);
	if (!p.rules) {
		return [
			'Таблица маршрутов хоста (`ip route`):',
			'',
			...table('main'),
			'',
			'Правила:',
			'',
			...ROUTE_RULES,
			'- если не подходит ни один маршрут — `unreachable`.',
			'',
			'Хост отправляет пакеты по адресам:',
			'',
			...p.packets.map((pkt, i) => `${i + 1}. \`${toIp(pkt.dst)}\``),
			'',
			ANSWER_FORMAT
		].join('\n');
	}
	const names = Object.keys(p.tables);
	return [
		'Маршрутизатор пересылает пакеты из своих сетей. Правила выбора таблицы (`ip rule`):',
		'',
		...p.rules.map(
			(r) => `- \`${r.prio}: from ${prefixText(r.from)}${r.to ? ` to ${prefixText(r.to)}` : ''} lookup ${r.table}\``
		),
		'',
		...names.flatMap((name) => [`Таблица \`${name}\` (\`ip route show table ${name}\`):`, '', ...table(name), '']),
		'Правила:',
		'',
		'- правила выбора таблицы проверяются по возрастанию номера; правило подходит пакету, если адрес источника входит в `from` (`all` — любой источник), а адрес назначения — в `to`, если оно указано;',
		'- в таблице подошедшего правила маршрут выбирается по обычным правилам одной таблицы;',
		...ROUTE_RULES,
		'- если в таблице нет ни одного подходящего маршрута, проверяется следующее правило; если ни одно правило не дало маршрута — `unreachable`.',
		'',
		'Пакеты:',
		'',
		'| № | Источник | Назначение |',
		'|---|---|---|',
		...p.packets.map((pkt, i) => `| ${i + 1} | \`${toIp(pkt.src ?? 0)}\` | \`${toIp(pkt.dst)}\` |`),
		'',
		ANSWER_FORMAT
	].join('\n');
}

const PYTHON_REFERENCE = `import ipaddress
import json

p = json.loads(input())


def best(table, dst):
    dst = ipaddress.ip_address(dst)
    hits = [r for r in table if dst in ipaddress.ip_network(r["prefix"])]
    if not hits:
        return None
    return min(hits, key=lambda r: (-ipaddress.ip_network(r["prefix"]).prefixlen, r["metric"] or 0))


def show(r):
    if r["type"] != "unicast":
        return r["type"]
    return ("via %s dev %s" % (r["via"], r["dev"])) if r["via"] else ("dev %s" % r["dev"])


def route(src, dst):
    if p["rules"] is None:
        r = best(p["tables"]["main"], dst)
        return show(r) if r else "unreachable"
    for rule in sorted(p["rules"], key=lambda x: x["prio"]):
        if rule["from"] and ipaddress.ip_address(src) not in ipaddress.ip_network(rule["from"]):
            continue
        if rule["to"] and ipaddress.ip_address(dst) not in ipaddress.ip_network(rule["to"]):
            continue
        r = best(p["tables"][rule["table"]], dst)
        if r:
            return show(r)
    return "unreachable"


for pkt in p["packets"]:
    print(route(pkt["src"], pkt["dst"]))
`;

function stdinOf(p: Params): string {
	const routeJson = (r: Route) => ({
		type: r.type,
		prefix: `${toIp(r.net)}/${r.len}`,
		via: r.via === null ? null : toIp(r.via),
		dev: r.dev,
		metric: r.metric
	});
	return JSON.stringify({
		tables: Object.fromEntries(Object.entries(p.tables).map(([name, routes]) => [name, routes.map(routeJson)])),
		rules: p.rules
			? p.rules.map((r) => ({
					prio: r.prio,
					from: r.from ? prefixText(r.from) : null,
					to: r.to ? prefixText(r.to) : null,
					table: r.table
				}))
			: null,
		packets: p.packets.map((pkt) => ({ src: pkt.src === null ? null : toIp(pkt.src), dst: toIp(pkt.dst) }))
	});
}

const WRONG: Record<string, Partial<Rules>> = {
	'first-listed': { firstListed: true },
	'metric-first': { metricFirst: true },
	'higher-metric': { higherMetric: true },
	'skip-special': { skipSpecial: true },
	'octet-round': { octetRound: true },
	'main-only': { mainOnly: true },
	'no-fallthrough': { noFallthrough: true },
	'listed-order': { listedOrder: true },
	'special-falls-through': { specialFallsThrough: true },
	'from-as-to': { fromAsTo: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/longest-prefix': ['first-listed'],
	'intern/metric': ['metric-first', 'higher-metric'],
	'intern/blackhole': ['skip-special'],
	'intern/cross-octet': ['octet-round'],
	'junior/by-source': ['main-only', 'from-as-to'],
	'junior/fallthrough': ['no-fallthrough'],
	'junior/priority-order': ['listed-order'],
	'junior/special-in-table': ['special-falls-through']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class requires changes the answer and the answers differ.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = input.grade === 'intern' ? internScenario(rng, input.classId) : juniorScenario(rng, input.classId);
		const answer = solve(p, RIGHT);
		if (new Set(answer).size < 3) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, { ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'sequence', value: answer }
		});
		const stdin = stdinOf(p);
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
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
