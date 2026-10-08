// Subnet membership: which addresses fall into an IPv4 subnet (or into which of several overlapping subnets), with
// masks inside an octet and across an octet boundary, dotted masks, interface addresses with host bits set, and the
// difference between belonging to a subnet and being a host address of it (/31 and /32 included).
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

import { blockSize, netOf, toIp } from '../../_lib/ipv4.ts';
const descriptor = readDescriptor(import.meta.url);

const dottedMask = (prefix: number): string => toIp(2 ** 32 - blockSize(prefix));

interface Subnet {
	name: string;
	/** The address as written: the network, or an interface address with host bits set. */
	address: number;
	prefix: number;
	dotted: boolean;
}

interface Params {
	question: 'member' | 'host';
	/** Several named subnets: the answer is pairs of an address and a subnet. */
	multi: boolean;
	/** Subnets are written as interface addresses. */
	iface: boolean;
	subnets: Subnet[];
	addresses: number[];
}

interface Rules {
	round: 'none' | 'down' | 'up';
	hostsIncludeEndpoints: boolean;
	startFromGiven: boolean;
	dottedOnesOctets: boolean;
	longestOnly: boolean;
	p2pLikeOthers: boolean;
	noHostIn32: boolean;
}

const RIGHT: Rules = {
	round: 'none',
	hostsIncludeEndpoints: false,
	startFromGiven: false,
	dottedOnesOctets: false,
	longestOnly: false,
	p2pLikeOthers: false,
	noHostIn32: false
};

function effectivePrefix(s: Subnet, rules: Rules): number {
	let prefix = s.prefix;
	if (s.dotted && rules.dottedOnesOctets) prefix = 8 * Math.floor(prefix / 8);
	if (rules.round === 'down') prefix = 8 * Math.floor(prefix / 8);
	if (rules.round === 'up') prefix = 8 * Math.ceil(prefix / 8);
	return prefix;
}

function contains(s: Subnet, address: number, question: Params['question'], rules: Rules): boolean {
	const prefix = effectivePrefix(s, rules);
	const lo = rules.startFromGiven ? s.address : netOf(s.address, prefix);
	const hi = lo + blockSize(prefix) - 1;
	if (address < lo || address > hi) return false;
	if (question === 'member') return true;
	if (prefix === 32 && rules.noHostIn32) return false;
	if (prefix >= 31 && !rules.p2pLikeOthers) return true;
	if (rules.hostsIncludeEndpoints) return true;
	return address !== lo && address !== hi;
}

function solve(p: Params, rules: Rules): string[] {
	const out: string[] = [];
	for (const address of p.addresses) {
		let hits = p.subnets.filter((s) => contains(s, address, p.question, rules));
		if (rules.longestOnly && hits.length > 1) {
			const longest = Math.max(...hits.map((s) => effectivePrefix(s, rules)));
			hits = hits.filter((s) => effectivePrefix(s, rules) === longest);
		}
		for (const s of hits) out.push(p.multi ? `${toIp(address)} ${s.name}` : toIp(address));
	}
	const unique = [...new Set(out)].sort();
	return unique.length ? unique : ['-'];
}

const FIRST_OCTETS = [10, 172, 192, 100, 185, 91, 46, 31, 85];
const NAMES = ['office', 'dmz', 'voip', 'mgmt', 'lab', 'wifi', 'cams', 'vpn', 'store', 'build', 'guest', 'db'];

function randomAddress(rng: Rng): number {
	return ((rng.pick(FIRST_OCTETS) * 256 + rng.int(0, 255)) * 256 + rng.int(0, 255)) * 256 + rng.int(0, 255);
}

/** Addresses that tell the right reading of a subnet from the misreadings: edges, neighbours, octet-rounded blocks. */
function boundaryPool(rng: Rng, s: Subnet): number[] {
	const net = netOf(s.address, s.prefix);
	const size = blockSize(s.prefix);
	const bcast = net + size - 1;
	const pool = [net, bcast, net - 1, bcast + 1];
	if (size > 2) pool.push(net + rng.int(1, size - 2));
	const down = 8 * Math.floor(s.prefix / 8);
	if (down < s.prefix) {
		const wide = netOf(net, down);
		const outside = blockSize(down) - size;
		let k = rng.int(0, outside - 1);
		const offsetOfNet = net - wide;
		if (k >= offsetOfNet) k += size;
		pool.push(wide + k);
	}
	const up = 8 * Math.ceil(s.prefix / 8);
	if (up > s.prefix && size > blockSize(up)) pool.push(net + blockSize(up) + rng.int(0, size - blockSize(up) - 1));
	if (s.address !== net) {
		// Interface address: inside before it, and outside within «address + size».
		if (s.address - net > 1) pool.push(net + rng.int(1, s.address - net - 1));
		pool.push(bcast + 1 + rng.int(0, s.address - net - 1));
	}
	return pool;
}

const pickPrefix = (rng: Rng, from: number, to: number, skipOctet: boolean): number => {
	for (;;) {
		const prefix = rng.int(from, to);
		if (!skipOctet || prefix % 8 !== 0) return prefix;
	}
};

function scenario(rng: Rng, grade: string, classId: string): Params {
	if (grade === 'intern') {
		const question = classId === 'hosts-only' ? 'host' : 'member';
		const iface = classId === 'interface-address';
		const prefix =
			classId === 'octet-27'
				? rng.int(25, 29)
				: classId === 'cross-octet'
					? rng.int(17, 23)
					: classId === 'hosts-only'
						? rng.int(25, 30)
						: pickPrefix(rng, 20, 29, true);
		const net = netOf(randomAddress(rng), prefix);
		const size = blockSize(prefix);
		const address = iface ? net + rng.int(2, size - 2) : net;
		const s: Subnet = { name: 'net', address, prefix, dotted: false };
		const pool = [...new Set(boundaryPool(rng, s))];
		const extra = [...new Set([...boundaryPool(rng, s), ...boundaryPool(rng, s)])].filter((a) => !pool.includes(a));
		const count = rng.int(6, 8);
		const addresses = rng.shuffle([...pool, ...extra].filter((a) => a !== address)).slice(0, count);
		return { question, multi: false, iface, subnets: [s], addresses };
	}
	const base = netOf(randomAddress(rng), 16);
	const names = rng.sample(NAMES, 4);
	const subnets: Subnet[] = [];
	const at = (prefix: number, within: number, withinPrefix: number): number =>
		within + blockSize(prefix) * rng.int(0, blockSize(withinPrefix) / blockSize(prefix) - 1);
	if (classId === 'dotted-masks') {
		const area = at(20, base, 16);
		for (let i = 0; i < 4; i += 1) {
			const prefix = pickPrefix(rng, i < 2 ? 21 : 23, i < 2 ? 23 : 28, true);
			subnets.push({ name: names[i] ?? 'net', address: at(prefix, area, 20), prefix, dotted: i < 3 });
		}
	} else if (classId === 'nested') {
		const p1 = rng.int(17, 19);
		const p2 = rng.int(20, 22);
		const p3 = rng.int(23, 26);
		const p4 = rng.int(27, 29);
		const n1 = at(p1, base, 16);
		const n2 = at(p2, n1, p1);
		const n3 = at(p3, n2, p2);
		const n4 = at(p4, n3, p3);
		subnets.push(
			{ name: names[0] ?? 'a', address: n1, prefix: p1, dotted: rng.bool() },
			{ name: names[1] ?? 'b', address: n2, prefix: p2, dotted: rng.bool() },
			{ name: names[2] ?? 'c', address: n3, prefix: p3, dotted: rng.bool() },
			{ name: names[3] ?? 'd', address: n4, prefix: p4, dotted: rng.bool() }
		);
	} else if (classId === 'p2p-hosts') {
		const area = at(26, base, 16);
		const p0 = rng.int(28, 29);
		subnets.push({ name: names[0] ?? 'a', address: at(p0, area, 26), prefix: p0, dotted: rng.bool() });
		for (const [i, prefix] of [30, 31, 32].entries())
			subnets.push({ name: names[i + 1] ?? 'x', address: at(prefix, area, 26), prefix, dotted: rng.bool(0.3) });
	} else {
		const area = at(18, base, 16);
		for (let i = 0; i < 4; i += 1) {
			const prefix = pickPrefix(rng, i < 2 ? 19 : 22, i < 2 ? 23 : 29, true);
			const net = at(prefix, area, 18);
			subnets.push({
				name: names[i] ?? 'net',
				address: net + rng.int(2, blockSize(prefix) - 2),
				prefix,
				dotted: rng.bool()
			});
		}
	}
	const pool = [...new Set(subnets.flatMap((s) => boundaryPool(rng, s)))].filter(
		(a) => !subnets.some((s) => s.address === a && classId === 'interface-address')
	);
	const shown = rng.shuffle(subnets);
	let addresses: number[];
	if (classId === 'p2p-hosts') {
		// The single address of the /32 and an address of the /31 are always asked about.
		const single = subnets.find((s) => s.prefix === 32)?.address ?? 0;
		const p2p = subnets.find((s) => s.prefix === 31)?.address ?? 0;
		const must = [...new Set([single, p2p + rng.int(0, 1)])];
		const rest = pool.filter((a) => !must.includes(a));
		addresses = rng.shuffle([...must, ...rng.sample(rest, Math.min(rest.length, 3))]);
	} else addresses = rng.sample(pool, Math.min(pool.length, 4));
	return {
		question: classId === 'p2p-hosts' ? 'host' : 'member',
		multi: true,
		iface: classId === 'interface-address',
		subnets: shown,
		addresses
	};
}

function maskText(s: Subnet): string {
	return s.dotted ? `${toIp(s.address)} маска ${dottedMask(s.prefix)}` : `${toIp(s.address)}/${s.prefix}`;
}

function describe(p: Params): string {
	const list = p.addresses.map((a) => `- \`${toIp(a)}\``);
	const memberRule = 'в диапазон от адреса сети до широковещательного адреса включительно';
	if (!p.multi) {
		const s = p.subnets[0] as Subnet;
		const head = p.iface
			? `Интерфейсу \`eth0\` назначен адрес \`${toIp(s.address)}/${s.prefix}\`.`
			: `Подсеть: \`${toIp(s.address)}/${s.prefix}\`.`;
		const question =
			p.question === 'member'
				? p.iface
					? `Какие из этих адресов входят в ту же подсеть, что и интерфейс \`eth0\`, — ${memberRule}?`
					: `Какие из этих адресов входят в подсеть — ${memberRule}?`
				: 'Какие из этих адресов можно назначить сетевым интерфейсам узлов этой подсети?';
		return [
			head,
			'',
			'Адреса:',
			'',
			...list,
			'',
			question,
			'',
			'Введите адреса по одному в строке, порядок не важен; если таких нет — одну строку `-`.'
		].join('\n');
	}
	const rows = p.subnets.map((s) => `| \`${s.name}\` | \`${maskText(s)}\` |`);
	const head = p.iface
		? 'Интерфейсам маршрутизатора назначены адреса (маска — длиной префикса или в точечной записи). Подсеть интерфейса — та, в которой лежит его адрес.'
		: 'Подсети (маска — длиной префикса или в точечной записи); подсети могут пересекаться.';
	const question =
		p.question === 'member'
			? `Для каждого адреса из списка определите все подсети, в которые он входит, — ${memberRule}.`
			: 'Для каждого адреса из списка определите все подсети, в которых этот адрес можно назначить сетевому интерфейсу узла. В подсетях /31 оба адреса — адреса узлов (RFC 3021), в подсети /32 её единственный адрес — адрес узла.';
	return [
		head,
		'',
		`| ${p.iface ? 'Интерфейс' : 'Подсеть'} | Адрес и маска |`,
		'|---|---|',
		...rows,
		'',
		'Адреса:',
		'',
		...list,
		'',
		question,
		'',
		`Введите пары «адрес имя» по одной в строке, например \`192.0.2.10 lab\`; порядок строк не важен; если подходящих пар нет — одну строку \`-\`.`
	].join('\n');
}

const PYTHON_REFERENCE = `import ipaddress
import json

p = json.loads(input())
out = set()
for a in p["addresses"]:
    ip = ipaddress.ip_address(a)
    for s in p["subnets"]:
        net = ipaddress.ip_network(s["address"] + "/" + s["mask"], strict=False)
        if ip not in net:
            continue
        if p["question"] == "host" and net.prefixlen <= 30 and ip in (net.network_address, net.broadcast_address):
            continue
        out.add(f"{a} {s['name']}" if p["multi"] else a)
print("\\n".join(sorted(out)) if out else "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'octet-round-down': { round: 'down' },
	'octet-round-up': { round: 'up' },
	'hosts-include-endpoints': { hostsIncludeEndpoints: true },
	'start-from-given': { startFromGiven: true },
	'dotted-ones-octets': { dottedOnesOctets: true },
	'longest-only': { longestOnly: true },
	'p2p-like-others': { p2pLikeOthers: true },
	'no-host-in-32': { noHostIn32: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/octet-27': ['octet-round-down'],
	'intern/cross-octet': ['octet-round-down', 'octet-round-up'],
	'intern/hosts-only': ['hosts-include-endpoints', 'octet-round-down'],
	'intern/interface-address': ['start-from-given'],
	'junior/dotted-masks': ['dotted-ones-octets'],
	'junior/nested': ['longest-only'],
	'junior/p2p-hosts': ['p2p-like-others', 'no-host-in-32', 'hosts-include-endpoints'],
	'junior/interface-address': ['start-from-given', 'octet-round-down']
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class requires changes the answer and the answer is neither
	// empty nor every address.
	for (let tries = 0; tries < 300; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = solve(p, RIGHT);
		if (answer[0] === '-') continue;
		if (!p.multi && answer.length === p.addresses.length) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, { ...RIGHT, ...change });
				return [id, sameSet(value, answer) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'set', value: answer }
		});
		const stdin = JSON.stringify({
			question: p.question,
			multi: p.multi,
			subnets: p.subnets.map((s) => ({
				name: s.name,
				address: toIp(s.address),
				mask: s.dotted ? dottedMask(s.prefix) : String(s.prefix)
			})),
			addresses: p.addresses.map(toIp)
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'set' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
