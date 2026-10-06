// Subnet planning: the network, the last address, the host range and the host count of `address/prefix`; and the
// split of a block into subnets of variable length for segments with given host counts — sizes, the order of
// allocation, alignment on the subnet's own size, an already occupied range and a block too small for everything.
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

const prefixOf = (size: number): number => 32 - Math.round(Math.log2(size));

const FIRST_OCTETS = [10, 172, 192, 100, 185, 91, 46, 31, 85, 77];
const SEGMENTS = ['office', 'wifi', 'voip', 'cams', 'servers', 'dmz', 'lab', 'printers', 'guests', 'mgmt', 'storage'];

function randomAddress(rng: Rng): number {
	return ((rng.pick(FIRST_OCTETS) * 256 + rng.int(0, 255)) * 256 + rng.int(0, 255)) * 256 + rng.int(0, 255);
}

interface Rules {
	sizing: 'right' | 'no-subtract' | 'minus-one';
	roundDown: boolean;
	hostBitsKept: boolean;
	bcastNext: boolean;
	p2pLikeOthers: boolean;
	listedOrder: boolean;
	noAlignment: boolean;
	stopOnOverflow: boolean;
}

const RIGHT: Rules = {
	sizing: 'right',
	roundDown: false,
	hostBitsKept: false,
	bcastNext: false,
	p2pLikeOthers: false,
	listedOrder: false,
	noAlignment: false,
	stopOnOverflow: false
};

const lost = (rules: Rules): number => (rules.sizing === 'right' ? 2 : rules.sizing === 'minus-one' ? 1 : 0);

// Intern: one address with its prefix.

interface Single {
	address: number;
	prefix: number;
}

function single(p: Single, rules: Rules): string {
	const prefix = rules.roundDown ? 8 * Math.floor(p.prefix / 8) : p.prefix;
	const size = blockSize(prefix);
	const net = rules.hostBitsKept ? p.address : netOf(p.address, prefix);
	const last = rules.bcastNext ? net + size : net + size - 1;
	if (prefix >= 31 && !rules.p2pLikeOthers)
		return [toIp(net), toIp(net + size - 1), toIp(net), toIp(net + size - 1), size].join(' ');
	return [toIp(net), toIp(last), toIp(net + 1), toIp(last - 1), Math.max(0, size - lost(rules))].join(' ');
}

// Junior: a block split for segments.

interface Plan {
	block: number;
	blockPrefix: number;
	needs: number[];
	names: string[];
	reserved: { net: number; prefix: number } | null;
}

function sizeFor(need: number, rules: Rules): number {
	let size = 4;
	while (size - lost(rules) < need) size *= 2;
	return size;
}

function allocate(p: Plan, rules: Rules): string {
	const bsize = blockSize(p.blockPrefix);
	const end = p.block + bsize;
	const taken: [number, number][] = p.reserved ? [[p.reserved.net, p.reserved.net + blockSize(p.reserved.prefix)]] : [];
	const free = (lo: number, hi: number): boolean => taken.every(([a, b]) => hi <= a || lo >= b);
	const sizes = p.needs.map((need) => sizeFor(need, rules));
	const order = sizes.map((_, i) => i);
	if (!rules.listedOrder) order.sort((a, b) => (sizes[b] ?? 0) - (sizes[a] ?? 0) || a - b);
	const result: string[] = p.needs.map(() => '-');
	let stopped = false;
	for (const i of order) {
		if (stopped) break;
		const size = sizes[i] ?? 4;
		let start: number | null = null;
		if (rules.noAlignment) {
			const starts = [p.block, ...taken.map(([, b]) => b)].sort((a, b) => a - b);
			start = starts.find((s) => s + size <= end && free(s, s + size)) ?? null;
		} else {
			for (let s = p.block; s + size <= end; s += size)
				if (free(s, s + size)) {
					start = s;
					break;
				}
		}
		if (start === null) {
			if (rules.stopOnOverflow) stopped = true;
			continue;
		}
		taken.push([start, start + size]);
		result[i] = `${toIp(start)}/${prefixOf(size)}`;
	}
	const used = taken.reduce((sum, [a, b]) => sum + (b - a), 0);
	return [...result, String(bsize - used)].join(' ');
}

/** A need that a subnet of `size` is the smallest fit for. */
const needFor = (rng: Rng, size: number): number => rng.int(Math.max(2, size / 2 - 1), size - 2);

function planScenario(rng: Rng, classId: string): Plan {
	const blockPrefix = classId === 'overflow' ? rng.int(23, 25) : rng.int(21, 24);
	const bsize = blockSize(blockPrefix);
	const block = netOf(randomAddress(rng), blockPrefix);
	const count = rng.int(4, 5);
	const names = rng.sample(SEGMENTS, count);
	const choices = [bsize / 2, bsize / 4, bsize / 8, bsize / 16, bsize / 32, bsize / 64].filter((s) => s >= 4);
	const sizes = Array.from({ length: count }, () => rng.pick(choices));
	let reserved: Plan['reserved'] = null;
	if (classId === 'reserved') {
		const largest = Math.max(...sizes);
		const size = rng.pick(choices.filter((s) => s < largest));
		reserved = { net: block + size * rng.int(0, largest / size - 1), prefix: prefixOf(size) };
	}
	if (classId === 'overflow') {
		// More than the free part holds, and the occupied range splits it: a large subnet fails, smaller ones fit.
		sizes[0] = bsize / 2;
		sizes[1] = rng.pick([bsize / 2, bsize / 4]);
		const size = rng.pick(choices.filter((s) => s <= bsize / 8));
		reserved = { net: block + size * rng.int(0, bsize / size - 1), prefix: prefixOf(size) };
	}
	const needs = sizes.map((size) => {
		if (classId !== 'exact-fit') return needFor(rng, size);
		return rng.pick([size - 2, size / 2 - 1, size / 2 > 4 ? size / 2 : size - 2]);
	});
	return { block, blockPrefix, needs: rng.shuffle(needs), names, reserved };
}

function describePlan(p: Plan): string {
	const rows = p.needs.map((need, i) => `| \`${p.names[i] ?? ''}\` | ${need} |`);
	return [
		`Блок \`${toIp(p.block)}/${p.blockPrefix}\` нужно разбить на подсети под сегменты сети:`,
		'',
		'| Сегмент | Узлов |',
		'|---|---|',
		...rows,
		'',
		...(p.reserved
			? [
					`Подсеть \`${toIp(p.reserved.net)}/${p.reserved.prefix}\` внутри блока уже занята; новые подсети с ней не пересекаются.`,
					''
				]
			: []),
		'Правила:',
		'',
		'- каждому сегменту — одна подсеть наименьшего размера, в которой хватает адресов узлов на все его узлы; подсети /31 и /32 не используются;',
		'- подсети выделяются по убыванию размера, при равном размере — в порядке таблицы;',
		'- каждая подсеть занимает самый младший свободный участок блока, с которого может начинаться подсеть такого размера, и не пересекается с уже выделенными;',
		'- если подсеть не помещается в блок, сегмент остаётся без подсети, а выделение продолжается со следующего.',
		'',
		'Введите через пробел подсети сегментов в порядке таблицы в записи `адрес/префикс` (сегмент без подсети — `-`), а последним — число адресов блока, не занятых ни одной подсетью. Например: `10.0.0.0/25 10.0.0.128/26 - 10.0.0.192/27 32`.'
	].join('\n');
}

function describeSingle(p: Single): string {
	return [
		`Интерфейсу назначен адрес \`${toIp(p.address)}/${p.prefix}\`.`,
		'',
		'Для его подсети найдите адрес сети, последний адрес блока, первый и последний адреса узлов и число адресов узлов. В подсети /31 оба её адреса — адреса узлов (RFC 3021), в подсети /32 её единственный адрес — адрес узла; в остальных подсетях последний адрес блока — широковещательный.',
		'',
		'Введите пять значений через пробел в этом порядке. Например: `10.0.0.0 10.0.0.255 10.0.0.1 10.0.0.254 254`.'
	].join('\n');
}

const PYTHON_SINGLE = `import ipaddress
import json

p = json.loads(input())
net = ipaddress.ip_interface(p["interface"]).network
if net.prefixlen >= 31:
    first, last, count = net[0], net[-1], net.num_addresses
else:
    first, last, count = net[1], net[-2], net.num_addresses - 2
print(net.network_address, net[-1], first, last, count)
`;

const PYTHON_PLAN = `import ipaddress
import json

p = json.loads(input())
block = ipaddress.ip_network(p["block"])
taken = [ipaddress.ip_network(p["reserved"])] if p["reserved"] else []


def prefix_for(need):
    plen = 30
    while 2 ** (32 - plen) - 2 < need:
        plen -= 1
    return plen


needs = p["needs"]
order = sorted(range(len(needs)), key=lambda i: (prefix_for(needs[i]), i))
result = ["-"] * len(needs)
for i in order:
    plen = prefix_for(needs[i])
    if plen < block.prefixlen:
        continue
    for cand in block.subnets(new_prefix=plen):
        if not any(cand.overlaps(t) for t in taken):
            taken.append(cand)
            result[i] = str(cand)
            break
free = block.num_addresses - sum(t.num_addresses for t in taken)
print(" ".join(result + [str(free)]))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'count-no-subtract': { sizing: 'no-subtract' },
	'count-minus-one': { sizing: 'minus-one' },
	'octet-round-down': { roundDown: true },
	'host-bits-kept': { hostBitsKept: true },
	'bcast-next-network': { bcastNext: true },
	'p2p-like-others': { p2pLikeOthers: true },
	'listed-order': { listedOrder: true },
	'no-alignment': { noAlignment: true },
	'stop-on-overflow': { stopOnOverflow: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/last-octet': ['count-no-subtract', 'host-bits-kept', 'octet-round-down'],
	'intern/cross-octet': ['octet-round-down', 'host-bits-kept'],
	'intern/wide': ['octet-round-down', 'host-bits-kept'],
	'intern/p2p': ['p2p-like-others'],
	'junior/descending': ['listed-order'],
	'junior/reserved': ['no-alignment'],
	'junior/exact-fit': ['count-no-subtract', 'count-minus-one'],
	'junior/overflow': ['stop-on-overflow']
};

function singleScenario(rng: Rng, classId: string): Single {
	const prefix =
		classId === 'last-octet'
			? rng.int(25, 30)
			: classId === 'cross-octet'
				? rng.int(17, 23)
				: classId === 'wide'
					? rng.int(9, 15)
					: rng.pick([31, 31, 32]);
	const net = netOf(randomAddress(rng), prefix);
	const size = blockSize(prefix);
	const address = size <= 2 ? net + rng.int(0, size - 1) : net + rng.int(1, size - 2);
	return { address, prefix };
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class requires changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const intern = input.grade === 'intern';
		const s = intern ? singleScenario(rng, input.classId) : null;
		const plan = intern ? null : planScenario(rng, input.classId);
		const solve = (rules: Rules): string => (s ? single(s, rules) : allocate(plan as Plan, rules));
		const answer = solve(RIGHT);
		if (plan && input.classId !== 'overflow' && answer.split(' ').includes('-')) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve({ ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: s ? describeSingle(s) : describePlan(plan as Plan), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const reference = s
			? { source: PYTHON_SINGLE, stdin: JSON.stringify({ interface: `${toIp(s.address)}/${s.prefix}` }) }
			: {
					source: PYTHON_PLAN,
					stdin: JSON.stringify({
						block: `${toIp((plan as Plan).block)}/${(plan as Plan).blockPrefix}`,
						reserved: plan?.reserved ? `${toIp(plan.reserved.net)}/${plan.reserved.prefix}` : null,
						needs: plan?.needs ?? []
					})
				};
		return {
			instance,
			reference: () => ({ kind: 'output', ...reference }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
