// iptables-like packet filtering: the verdict for every packet of a sequence. Middle — the chain INPUT of a host with a
// user chain, RETURN, LOG, the first matching rule and conntrack states; senior — a gateway with DNAT in PREROUTING
// before the filter, SNAT or MASQUERADE in POSTROUTING after it, INPUT or FORWARD by the address after DNAT,
// interfaces in the conditions and replies translated back by conntrack.
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

import { ip, netOf, toIp } from '../../_lib/ipv4.ts';
const descriptor = readDescriptor(import.meta.url);

type Proto = 'tcp' | 'udp';
type State = 'NEW' | 'EST';

interface Tuple {
	proto: Proto;
	src: number;
	sport: number;
	dst: number;
	dport: number;
}

interface Packet extends Tuple {
	iface: string;
}

interface Cond {
	proto?: Proto;
	src?: [number, number];
	dst?: number;
	dport?: number;
	inIface?: string;
	outIface?: string;
	state?: State;
}

interface FilterRule {
	cond: Cond;
	/** ACCEPT, DROP, REJECT, RETURN, LOG or the name of a user chain. */
	target: string;
}

interface NatRule {
	cond: Cond;
	target: 'DNAT' | 'SNAT' | 'MASQUERADE';
	toIp?: number;
	toPort?: number;
}

interface HostParams {
	ext: number;
	int: number;
	chains: Record<string, FilterRule[]>;
	policy: 'ACCEPT' | 'DROP';
	events: { out: boolean; pkt: Packet }[];
}

interface GatewayParams {
	wan: number;
	lan: number;
	lanNet: number;
	pre: NatRule[];
	post: NatRule[];
	input: FilterRule[];
	inputPolicy: 'ACCEPT' | 'DROP';
	forward: FilterRule[];
	forwardPolicy: 'ACCEPT' | 'DROP';
	packets: Packet[];
}

interface Rules {
	returnAccepts: boolean;
	chainEndPolicy: boolean;
	noConntrack: boolean;
	droppedTracked: boolean;
	lastMatch: boolean;
	mostSpecific: boolean;
	logTerminates: boolean;
	filterSeesOriginal: boolean;
	natRepliesNew: boolean;
	snatBeforeFilter: boolean;
	dnatAlwaysForward: boolean;
	ignoreIface: boolean;
}

const RIGHT: Rules = {
	returnAccepts: false,
	chainEndPolicy: false,
	noConntrack: false,
	droppedTracked: false,
	lastMatch: false,
	mostSpecific: false,
	logTerminates: false,
	filterSeesOriginal: false,
	natRepliesNew: false,
	snatBeforeFilter: false,
	dnatAlwaysForward: false,
	ignoreIface: false
};

/** What a rule sees of a packet. */
interface View {
	proto: Proto;
	src: number;
	dst: number;
	dport: number;
	inIface: string;
	outIface: string | null;
}

function matches(c: Cond, v: View, state: State, rules: Rules): boolean {
	if (c.proto && c.proto !== v.proto) return false;
	if (c.src && netOf(v.src, c.src[1]) !== c.src[0]) return false;
	if (c.dst !== undefined && c.dst !== v.dst) return false;
	if (c.dport !== undefined && c.dport !== v.dport) return false;
	if (!rules.ignoreIface) {
		if (c.inIface && c.inIface !== v.inIface) return false;
		if (c.outIface && c.outIface !== v.outIface) return false;
	}
	if (c.state && c.state !== state) return false;
	return true;
}

function ordered(list: readonly FilterRule[], rules: Rules): FilterRule[] {
	if (rules.lastMatch) return [...list].reverse();
	if (rules.mostSpecific) return [...list].sort((a, b) => (b.cond.src?.[1] ?? 0) - (a.cond.src?.[1] ?? 0));
	return [...list];
}

function traverse(p: HostParams, chain: string, v: View, state: State, rules: Rules, depth = 0): string | null {
	for (const r of ordered(p.chains[chain] ?? [], rules)) {
		if (!matches(r.cond, v, state, rules)) continue;
		if (r.target === 'ACCEPT' || r.target === 'DROP' || r.target === 'REJECT') return r.target;
		if (r.target === 'LOG') {
			if (rules.logTerminates) return 'ACCEPT';
			continue;
		}
		if (r.target === 'RETURN') {
			if (rules.returnAccepts) return 'ACCEPT';
			return chain === 'INPUT' ? p.policy : null;
		}
		if (depth < 4) {
			const verdict = traverse(p, r.target, v, state, rules, depth + 1);
			if (verdict !== null) return verdict;
		}
	}
	if (chain === 'INPUT') return p.policy;
	return rules.chainEndPolicy ? p.policy : null;
}

const connKey = (t: Tuple): string => {
	const a = `${t.src}:${t.sport}`;
	const b = `${t.dst}:${t.dport}`;
	return `${t.proto}|${a < b ? a : b}|${a < b ? b : a}`;
};

function simulateHost(p: HostParams, rules: Rules): string[] {
	const conns = new Set<string>();
	const out: string[] = [];
	for (const { out: outgoing, pkt } of p.events) {
		const key = connKey(pkt);
		if (outgoing) {
			conns.add(key);
			continue;
		}
		const state: State = !rules.noConntrack && conns.has(key) ? 'EST' : 'NEW';
		const view: View = {
			proto: pkt.proto,
			src: pkt.src,
			dst: pkt.dst,
			dport: pkt.dport,
			inIface: pkt.iface,
			outIface: null
		};
		const verdict = traverse(p, 'INPUT', view, state, rules) ?? p.policy;
		if (verdict === 'ACCEPT' || rules.droppedTracked) conns.add(key);
		out.push(verdict);
	}
	return out;
}

const tupleKey = (t: Tuple): string => `${t.proto}|${t.src}:${t.sport}|${t.dst}:${t.dport}`;
const reverse = (t: Tuple): Tuple => ({ proto: t.proto, src: t.dst, sport: t.dport, dst: t.src, dport: t.sport });
const tupleOf = (p: Packet): Tuple => ({ proto: p.proto, src: p.src, sport: p.sport, dst: p.dst, dport: p.dport });
const shown = (t: Tuple): string => `${toIp(t.src)}:${t.sport}>${toIp(t.dst)}:${t.dport}`;

function firstFilter(list: readonly FilterRule[], v: View, state: State, rules: Rules): string | null {
	for (const r of ordered(list, rules)) if (matches(r.cond, v, state, rules)) return r.target;
	return null;
}

function simulateGateway(p: GatewayParams, rules: Rules): string[] {
	const entries: { orig: Tuple; trans: Tuple }[] = [];
	const own = new Set([p.wan, p.lan]);
	const outIfaceOf = (dst: number): string => (netOf(dst, 24) === p.lanNet ? 'eth1' : 'eth0');
	const pre = (pkt: Packet): { t: Tuple; dnat: boolean } => {
		const view: View = {
			proto: pkt.proto,
			src: pkt.src,
			dst: pkt.dst,
			dport: pkt.dport,
			inIface: pkt.iface,
			outIface: null
		};
		const rule = p.pre.find((r) => matches(r.cond, view, 'NEW', rules));
		if (!rule || rule.target !== 'DNAT') return { t: tupleOf(pkt), dnat: false };
		return { t: { ...tupleOf(pkt), dst: rule.toIp ?? pkt.dst, dport: rule.toPort ?? pkt.dport }, dnat: true };
	};
	const post = (t: Tuple, inIface: string, outIface: string): Tuple => {
		const view: View = { proto: t.proto, src: t.src, dst: t.dst, dport: t.dport, inIface, outIface };
		const rule = p.post.find((r) => matches(r.cond, view, 'NEW', rules));
		if (!rule) return t;
		if (rule.target === 'MASQUERADE') return { ...t, src: outIface === 'eth0' ? p.wan : p.lan };
		return { ...t, src: rule.toIp ?? t.src };
	};
	return p.packets.map((pkt) => {
		const key = tupleKey(pkt);
		const original = entries.find((e) => tupleKey(e.orig) === key);
		const reply = original ? undefined : entries.find((e) => tupleKey(reverse(e.trans)) === key);
		const known = original ?? reply;
		const state: State = known && !rules.noConntrack ? 'EST' : 'NEW';
		let translated: Tuple | null = null;
		let dnat = false;
		if (known && !rules.natRepliesNew)
			translated = original ? original.trans : reverse((reply as { orig: Tuple }).orig);
		let routed: Tuple;
		if (translated) routed = translated;
		else {
			const r = pre(pkt);
			routed = r.t;
			dnat = r.dnat;
		}
		const local = own.has(routed.dst) && !(rules.dnatAlwaysForward && dnat);
		const outIface = local ? null : outIfaceOf(routed.dst);
		const view: View = {
			proto: pkt.proto,
			src: pkt.src,
			dst: rules.filterSeesOriginal ? pkt.dst : routed.dst,
			dport: rules.filterSeesOriginal ? pkt.dport : routed.dport,
			inIface: pkt.iface,
			outIface
		};
		const leaving = translated && !local ? translated : outIface ? post(routed, pkt.iface, outIface) : routed;
		if (rules.snatBeforeFilter && !local) view.src = leaving.src;
		const verdict =
			firstFilter(local ? p.input : p.forward, view, state, rules) ?? (local ? p.inputPolicy : p.forwardPolicy);
		if (verdict !== 'ACCEPT') return 'DROP';
		if (state === 'NEW' && !known) entries.push({ orig: tupleOf(pkt), trans: leaving });
		return local ? 'LOCAL' : shown(leaving);
	});
}

// Scenarios.

const port = (rng: Rng): number => rng.int(32768, 60999);
const publicHost = (rng: Rng): number =>
	ip(rng.pick([77, 93, 151, 185, 212, 89]), rng.int(0, 255), rng.int(0, 255), rng.int(2, 254));

interface Nets {
	mgmt: number;
	office: number;
	sub: number;
	bad: number;
}

function hostNets(rng: Rng): Nets {
	const office = ip(10, 20 + rng.int(0, 9), 0, 0);
	return {
		mgmt: ip(10, 1, rng.int(0, 255), 0),
		office,
		sub: office + 256 * rng.int(0, 255),
		bad: ip(198, 51, 100, 0)
	};
}

function hostScenario(rng: Rng, classId: string): HostParams {
	const ext = ip(185, rng.int(0, 255), rng.int(0, 255), rng.int(2, 254));
	const int = ip(10, 0, 0, rng.int(2, 254));
	const n = hostNets(rng);
	const [web = 443, db = 5432, rej = 8080, other = 3000] = rng.sample([443, 80, 5432, 3306, 6379, 8080, 9090, 3000], 4);
	const mgmt: [number, number] = [n.mgmt, 24];
	const office: [number, number] = [n.office, 16];
	const sub: [number, number] = [n.sub, 24];
	const bad: [number, number] = [n.bad, 24];
	const policy: 'ACCEPT' | 'DROP' = classId === 'conntrack' ? 'DROP' : rng.pick(['ACCEPT', 'DROP']);
	const chains: Record<string, FilterRule[]> = {};
	const inFrom = (net: [number, number], dport: number, proto: Proto = 'tcp'): Packet => ({
		proto,
		src: net[0] + rng.int(1, net[1] === 16 ? 65534 : 254),
		sport: port(rng),
		dst: net[0] === n.bad ? ext : int,
		dport,
		iface: net[0] === n.bad ? 'eth0' : 'eth1'
	});
	const fromInternet = (dport: number, proto: Proto = 'tcp'): Packet => ({
		proto,
		src: publicHost(rng),
		sport: port(rng),
		dst: ext,
		dport,
		iface: 'eth0'
	});
	let pool: Packet[] = [];
	const events: HostParams['events'] = [];
	if (classId === 'user-chain') {
		const name = rng.pick(['SERVICES', 'TCP_IN', 'ADMIN', 'WEB_IN']);
		const sub1: FilterRule[] = [
			{ cond: { proto: 'tcp', dport: 22, src: mgmt }, target: 'ACCEPT' },
			{ cond: { proto: 'tcp', dport: 22 }, target: 'RETURN' }
		];
		const tail = rng.shuffle<FilterRule>([
			{ cond: { src: bad }, target: 'RETURN' },
			{ cond: { proto: 'tcp', dport: web }, target: 'ACCEPT' },
			{ cond: { proto: 'tcp', dport: db, src: office }, target: 'ACCEPT' }
		]);
		chains.INPUT = [
			{ cond: { proto: 'tcp' }, target: name },
			{ cond: { src: bad }, target: 'DROP' },
			{ cond: { proto: 'udp', dport: 53, src: office }, target: 'ACCEPT' },
			{ cond: { proto: 'tcp', dport: rng.pick([22, rej]) }, target: 'REJECT' }
		];
		if (rng.bool())
			chains.INPUT.push({ cond: { proto: 'tcp', src: office }, target: policy === 'DROP' ? 'ACCEPT' : 'DROP' });
		chains[name] = [...sub1, ...tail];
		pool = [
			inFrom(mgmt, 22),
			inFrom(office, 22),
			inFrom(bad, web),
			fromInternet(web),
			inFrom(office, db),
			fromInternet(db),
			fromInternet(rej),
			inFrom(office, 53, 'udp'),
			fromInternet(53, 'udp'),
			inFrom(bad, 22),
			inFrom(office, other)
		];
	} else if (classId === 'conntrack') {
		chains.INPUT = rng.shuffle<FilterRule>([
			{ cond: { proto: 'tcp', dport: 22, src: mgmt, state: 'NEW' }, target: 'ACCEPT' },
			{ cond: { proto: 'tcp', dport: web, state: 'NEW' }, target: 'ACCEPT' }
		]);
		chains.INPUT.unshift({ cond: { state: 'EST' }, target: 'ACCEPT' });
		if (rng.bool()) chains.INPUT.push({ cond: { proto: 'udp', src: office }, target: 'REJECT' });
		const outTo = (dst: number, dport: number, proto: Proto, inside: boolean): Packet => ({
			proto,
			src: inside ? int : ext,
			sport: port(rng),
			dst,
			dport,
			iface: inside ? 'eth1' : 'eth0'
		});
		const conn1 = outTo(publicHost(rng), rng.pick([443, 80]), 'tcp', false);
		const dns = outTo(n.office + rng.int(2, 9), 53, 'udp', true);
		const office22 = inFrom(office, 22);
		const mgmt22 = inFrom(mgmt, 22);
		const story: HostParams['events'] = [
			{ out: true, pkt: conn1 },
			{ out: false, pkt: { ...reverse(conn1), iface: 'eth0' } },
			{ out: false, pkt: { ...reverse(conn1), sport: conn1.dport, dport: port(rng), iface: 'eth0' } },
			{ out: false, pkt: office22 },
			{ out: false, pkt: office22 },
			{ out: false, pkt: mgmt22 },
			{ out: false, pkt: mgmt22 },
			{ out: true, pkt: dns },
			{ out: false, pkt: { ...reverse(dns), iface: 'eth1' } },
			{ out: false, pkt: fromInternet(web) }
		];
		const keep = story.filter((e, i) => i < 2 || rng.bool(0.8));
		events.push(...interleave(rng, keep, (e, earlier) => connKey(e.pkt) === connKey(earlier.pkt)));
	} else if (classId === 'rule-order') {
		chains.INPUT = rng.shuffle<FilterRule>([
			{ cond: { src: office }, target: 'DROP' },
			{ cond: { proto: 'tcp', dport: 22, src: sub }, target: 'ACCEPT' },
			{ cond: { proto: 'tcp', dport: 22 }, target: 'REJECT' },
			{ cond: { src: mgmt }, target: 'ACCEPT' },
			{ cond: { proto: 'tcp', dport: db, src: office }, target: 'ACCEPT' },
			{ cond: { proto: 'tcp', dport: web }, target: 'ACCEPT' }
		]);
		pool = [
			inFrom(sub, 22),
			inFrom(office, 22),
			inFrom(office, db),
			inFrom(sub, db),
			inFrom(mgmt, 22),
			inFrom(mgmt, db),
			fromInternet(22),
			fromInternet(web),
			inFrom(office, web),
			inFrom(sub, web),
			inFrom(bad, web)
		];
	} else {
		const telnet = rng.pick([23, 21, 2323]);
		chains.INPUT = rng.shuffle<FilterRule>([
			{ cond: { proto: 'tcp', dport: telnet }, target: 'LOG' },
			{ cond: { src: bad }, target: 'LOG' },
			{ cond: { proto: 'tcp', dport: telnet, src: mgmt }, target: 'ACCEPT' },
			{ cond: { src: bad }, target: 'DROP' },
			{ cond: { proto: 'tcp', dport: web }, target: 'ACCEPT' },
			{ cond: { proto: 'tcp', dport: telnet }, target: 'REJECT' }
		]);
		if (rng.bool()) chains.INPUT.splice(rng.int(0, 2), 0, { cond: { proto: 'tcp', src: office }, target: 'LOG' });
		pool = [
			inFrom(mgmt, telnet),
			inFrom(office, telnet),
			fromInternet(telnet),
			inFrom(bad, web),
			inFrom(bad, telnet),
			fromInternet(web),
			inFrom(office, web),
			inFrom(office, db),
			fromInternet(db)
		];
	}
	if (classId !== 'conntrack') {
		for (const pkt of rng.shuffle(pool).slice(0, rng.int(7, 8))) events.push({ out: false, pkt });
	}
	return { ext, int, chains, policy, events };
}

function gatewayScenario(rng: Rng, classId: string): GatewayParams {
	const wan = ip(203, 0, 113, rng.int(2, 254));
	const c = rng.int(1, 250);
	const lanNet = ip(192, 168, c, 0);
	const lan = lanNet + 1;
	const web = lanNet + rng.int(10, 40);
	const nas = lanNet + rng.int(41, 80);
	const client = (): number => lanNet + rng.int(100, 250);
	const admin: [number, number] = [ip(198, 51, 100, 0), 24];
	const [e1 = 8080, e2 = 8443, e3 = 2222] = rng.sample([8080, 8443, 8000, 9443, 2222, 10022, 8888], 3);
	const est: FilterRule = { cond: { state: 'EST' }, target: 'ACCEPT' };
	const lanOut: FilterRule = rng.bool()
		? { cond: { inIface: 'eth1', outIface: 'eth0' }, target: 'ACCEPT' }
		: { cond: { src: [lanNet, 24], outIface: 'eth0' }, target: 'ACCEPT' };
	const masq: NatRule = rng.bool()
		? { cond: { outIface: 'eth0', src: [lanNet, 24] }, target: 'MASQUERADE' }
		: { cond: { outIface: 'eth0' }, target: 'SNAT', toIp: wan };
	const fromInternet = (dport: number, src = publicHost(rng)): Packet => ({
		proto: 'tcp',
		src,
		sport: port(rng),
		dst: wan,
		dport,
		iface: 'eth0'
	});
	const fromLan = (dst: number, dport: number, proto: Proto = 'tcp'): Packet => ({
		proto,
		src: client(),
		sport: port(rng),
		dst,
		dport,
		iface: 'eth1'
	});
	const replyTo = (out: Packet, leavingSrc: number): Packet => ({
		proto: out.proto,
		src: out.dst,
		sport: out.dport,
		dst: leavingSrc,
		dport: out.sport,
		iface: 'eth0'
	});
	const p: GatewayParams = {
		wan,
		lan,
		lanNet,
		pre: [],
		post: [masq],
		input: [est],
		inputPolicy: 'DROP',
		forward: [est],
		forwardPolicy: 'DROP',
		packets: []
	};
	const out1 = fromLan(publicHost(rng), rng.pick([443, 80]));
	if (classId === 'dnat-forward') {
		p.pre.push(
			{ cond: { inIface: 'eth0', proto: 'tcp', dport: e1 }, target: 'DNAT', toIp: web, toPort: 80 },
			{ cond: { inIface: 'eth0', proto: 'tcp', dport: e2 }, target: 'DNAT', toIp: nas, toPort: 443 }
		);
		p.forward.push(
			...rng.shuffle<FilterRule>([
				lanOut,
				{ cond: { proto: 'tcp', dst: web, dport: 80 }, target: 'ACCEPT' },
				{ cond: { proto: 'tcp', dport: e2 }, target: 'ACCEPT' }
			])
		);
		const in1 = fromInternet(e1);
		p.packets = [in1, fromInternet(e2), in1, out1, replyTo(out1, wan), fromInternet(e3)];
	} else if (classId === 'masquerade-replies') {
		p.forward.push({ cond: { src: [lanNet, 24], outIface: 'eth0' }, target: 'ACCEPT' });
		p.input.push({ cond: { inIface: 'eth1', proto: 'udp', dport: 53 }, target: 'ACCEPT' });
		const dnsOut = fromLan(ip(rng.pick([1, 8, 9]), rng.int(0, 255), rng.int(0, 255), rng.int(1, 254)), 53, 'udp');
		const out2 = fromLan(publicHost(rng), 22);
		p.packets = rng.bool()
			? [out1, replyTo(out1, wan), dnsOut, replyTo(dnsOut, wan), fromInternet(out1.sport)]
			: [out1, out2, replyTo(out2, wan), replyTo(out1, wan), fromInternet(rng.pick([22, 443]))];
		if (rng.bool()) p.packets.push(fromLan(lan, 53, 'udp'));
	} else if (classId === 'dnat-to-local') {
		const local = rng.pick([wan, lan]);
		p.pre.push(
			{ cond: { inIface: 'eth0', proto: 'tcp', dport: e3 }, target: 'DNAT', toIp: local, toPort: 22 },
			{ cond: { inIface: 'eth0', proto: 'tcp', dport: e1 }, target: 'DNAT', toIp: web, toPort: 80 }
		);
		p.input.push({ cond: { proto: 'tcp', dport: 22, src: admin }, target: 'ACCEPT' });
		p.forward.push(
			lanOut,
			{ cond: { proto: 'tcp', dport: 22 }, target: rng.pick(['ACCEPT', 'DROP']) },
			{ cond: { proto: 'tcp', dst: web, dport: 80 }, target: 'ACCEPT' }
		);
		const adminIn = fromInternet(e3, admin[0] + rng.int(2, 254));
		p.packets = [adminIn, fromInternet(e3), fromInternet(e1), adminIn, out1, replyTo(out1, wan)];
	} else {
		p.pre.push({ cond: { inIface: 'eth0', proto: 'tcp', dport: e1 }, target: 'DNAT', toIp: web, toPort: 80 });
		p.input.push({ cond: { inIface: 'eth1', proto: 'tcp', dport: e1 }, target: rng.pick(['ACCEPT', 'DROP']) });
		p.forward.push(
			{ cond: { inIface: 'eth0', outIface: 'eth1', proto: 'tcp', dst: web, dport: 80 }, target: 'ACCEPT' },
			{ cond: { inIface: 'eth1', outIface: 'eth0' }, target: 'ACCEPT' }
		);
		p.post = [{ cond: { outIface: 'eth0', src: [lanNet, 24] }, target: 'MASQUERADE' }];
		p.packets = [fromLan(wan, e1), fromInternet(e1), out1, replyTo(out1, wan), fromInternet(80)];
	}
	p.packets = interleave(rng, p.packets, dependsOn);
	return p;
}

/** A random order that keeps every item after the ones it depends on: a reply after its request, a repeat after the first. */
function interleave<T>(rng: Rng, items: readonly T[], dependsOn: (item: T, earlier: T) => boolean): T[] {
	const result: T[] = [];
	const left = [...items];
	while (left.length) {
		const ready = left.filter((item, i) => !left.slice(0, i).some((earlier) => dependsOn(item, earlier)));
		const next = rng.pick(ready);
		result.push(next);
		left.splice(left.indexOf(next), 1);
	}
	return result;
}

function dependsOn(pkt: Packet, earlier: Packet): boolean {
	return (
		(pkt.sport === earlier.dport && pkt.dport === earlier.sport && pkt.src === earlier.dst) ||
		tupleKey(pkt) === tupleKey(earlier)
	);
}

// Statements.

function condText(c: Cond): string {
	const parts: string[] = [];
	if (c.inIface) parts.push(`-i ${c.inIface}`);
	if (c.outIface) parts.push(`-o ${c.outIface}`);
	if (c.src) parts.push(`-s ${toIp(c.src[0])}/${c.src[1]}`);
	if (c.dst !== undefined) parts.push(`-d ${toIp(c.dst)}`);
	if (c.proto) parts.push(`-p ${c.proto}`);
	if (c.dport !== undefined) parts.push(`--dport ${c.dport}`);
	if (c.state) parts.push(`-m conntrack --ctstate ${c.state === 'EST' ? 'ESTABLISHED,RELATED' : 'NEW'}`);
	return parts.join(' ');
}

function ruleLine(chain: string, r: FilterRule): string {
	const cond = condText(r.cond);
	return `\`-A ${chain} ${cond ? `${cond} ` : ''}-j ${r.target}\``;
}

function natLine(chain: string, r: NatRule): string {
	const to =
		r.target === 'DNAT'
			? ` --to-destination ${toIp(r.toIp ?? 0)}${r.toPort ? `:${r.toPort}` : ''}`
			: r.target === 'SNAT'
				? ` --to-source ${toIp(r.toIp ?? 0)}`
				: '';
	return `\`-A ${chain} ${condText(r.cond)} -j ${r.target}${to}\``;
}

const pktText = (pkt: Tuple): string =>
	`${pkt.proto} \`${toIp(pkt.src)}:${pkt.sport}\` → \`${toIp(pkt.dst)}:${pkt.dport}\``;

function describeHost(p: HostParams): string {
	const chains = Object.entries(p.chains);
	let n = 0;
	const events = p.events.map(({ out, pkt }) => {
		if (out) return `- \`srv\` сам отправляет пакет: ${pktText(pkt)}`;
		n += 1;
		return `${n}. на \`${pkt.iface}\`: ${pktText(pkt)}`;
	});
	return [
		`Хост \`srv\`: \`eth0\` — \`${toIp(p.ext)}\` (интернет), \`eth1\` — \`${toIp(p.int)}\` (внутренняя сеть). Правила таблицы filter для входящих пакетов (в синтаксисе \`iptables\`); цепочка OUTPUT пропускает всё.`,
		'',
		...chains.flatMap(([name, rules]) => [
			name === 'INPUT'
				? `Цепочка \`INPUT\`, политика по умолчанию — **${p.policy}**:`
				: `Пользовательская цепочка \`${name}\`:`,
			'',
			...rules.map((r, i) => `${i + 1}. ${ruleLine(name, r)}`),
			''
		]),
		'Правила обработки:',
		'',
		'- входящий пакет проходит `INPUT` сверху вниз; срабатывает первое правило, все условия которого выполнены; `ACCEPT`, `DROP` и `REJECT` — окончательный вердикт;',
		'- `LOG` записывает пакет в журнал, и проверка продолжается со следующего правила;',
		'- `-j <цепочка>` продолжает проверку в пользовательской цепочке; `RETURN` или конец пользовательской цепочки возвращают пакет в вызвавшую цепочку, к правилу после перехода; конец `INPUT` — политика по умолчанию;',
		'- состояние пакета для `--ctstate`: ESTABLISHED, если для его соединения (протокол и пара «адрес:порт» обеих сторон, в любом направлении) уже есть запись conntrack, иначе NEW; запись появляется, когда `srv` отправляет пакет, или когда входящий пакет принят (`ACCEPT`); отброшенный пакет записи не создаёт (упрощение: в Linux пакет того же направления, что первый, остаётся NEW, пока не было ответа);',
		'- в начале наблюдения таблица conntrack пуста; других пакетов, кроме перечисленных ниже, нет.',
		'',
		'События по порядку:',
		'',
		...events,
		'',
		'Введите вердикт для каждого пронумерованного входящего пакета по порядку, по одному в строке: `ACCEPT`, `DROP` или `REJECT`.'
	].join('\n');
}

function describeGateway(p: GatewayParams): string {
	return [
		`Маршрутизатор: \`eth0\` — \`${toIp(p.wan)}\` (интернет), \`eth1\` — \`${toIp(p.lan)}\` (локальная сеть \`${toIp(p.lanNet)}/24\`). Правила (в синтаксисе \`iptables\`):`,
		'',
		'Таблица nat:',
		'',
		...[...p.pre.map((r) => natLine('PREROUTING', r)), ...p.post.map((r) => natLine('POSTROUTING', r))].map(
			(l) => `- ${l}`
		),
		'',
		`Таблица filter, цепочка \`INPUT\` (политика **${p.inputPolicy}**):`,
		'',
		...p.input.map((r, i) => `${i + 1}. ${ruleLine('INPUT', r)}`),
		'',
		`Таблица filter, цепочка \`FORWARD\` (политика **${p.forwardPolicy}**):`,
		'',
		...p.forward.map((r, i) => `${i + 1}. ${ruleLine('FORWARD', r)}`),
		'',
		'Обработка пакета, пришедшего на интерфейс:',
		'',
		'1. conntrack: если пакет относится к уже записанному соединению — того же направления, что его первый пакет, или ответного, — его состояние ESTABLISHED, к нему применяется та же подмена адресов и портов, что к первому пакету (к ответному — обратная), и правила таблицы nat для него не проверяются. Иначе состояние NEW.',
		'2. Пакет NEW проходит `PREROUTING`: срабатывает первое подходящее правило; DNAT заменяет адрес (и порт, если указан) назначения.',
		`3. Маршрутизация: если адрес назначения — адрес самого маршрутизатора, пакет идёт в цепочку \`INPUT\`; иначе он пересылается через \`FORWARD\` на \`eth1\`, если назначение в \`${toIp(p.lanNet)}/24\`, или на \`eth0\`.`,
		'4. Цепочка filter: срабатывает первое подходящее правило, иначе — политика; `-i` — интерфейс, на который пакет пришёл, `-o` — через который уйдёт.',
		'5. Пересылаемый пакет NEW проходит `POSTROUTING`: первое подходящее правило; MASQUERADE заменяет адрес источника адресом маршрутизатора на выходном интерфейсе, SNAT — указанным адресом; порт источника сохраняется.',
		'6. Принятый пакет NEW создаёт запись conntrack (с подменами шагов 2 и 5); отброшенный — не создаёт.',
		'',
		'В начале наблюдения таблица conntrack пуста; других пакетов, кроме перечисленных ниже, нет.',
		'',
		'Пакеты по порядку:',
		'',
		...p.packets.map((pkt, i) => `${i + 1}. на \`${pkt.iface}\`: ${pktText(pkt)}`),
		'',
		'Введите результат для каждого пакета по порядку, по одному в строке: `DROP` — отброшен; `LOCAL` — принят самим маршрутизатором; для пересланного — каким он уходит, в записи `источник:порт>назначение:порт` без пробелов, например `203.0.113.5:40000>8.8.8.8:53`.'
	].join('\n');
}

const PYTHON_HOST = `import ipaddress
import json

p = json.loads(input())


def match(c, pkt, state):
    if c.get("proto") and c["proto"] != pkt["proto"]:
        return False
    if c.get("src") and ipaddress.ip_address(pkt["src"]) not in ipaddress.ip_network(c["src"]):
        return False
    if c.get("dport") is not None and c["dport"] != pkt["dport"]:
        return False
    if c.get("state") and c["state"] != state:
        return False
    return True


def walk(chain, pkt, state):
    for rule in p["chains"][chain]:
        if not match(rule["cond"], pkt, state):
            continue
        t = rule["target"]
        if t in ("ACCEPT", "DROP", "REJECT"):
            return t
        if t == "LOG":
            continue
        if t == "RETURN":
            return p["policy"] if chain == "INPUT" else None
        verdict = walk(t, pkt, state)
        if verdict is not None:
            return verdict
    return p["policy"] if chain == "INPUT" else None


def conn(pkt):
    return (pkt["proto"], frozenset([(pkt["src"], pkt["sport"]), (pkt["dst"], pkt["dport"])]))


tracked = set()
for ev in p["events"]:
    pkt = ev["pkt"]
    if ev["out"]:
        tracked.add(conn(pkt))
        continue
    state = "EST" if conn(pkt) in tracked else "NEW"
    verdict = walk("INPUT", pkt, state)
    if verdict == "ACCEPT":
        tracked.add(conn(pkt))
    print(verdict)
`;

const PYTHON_GATEWAY = `import ipaddress
import json

p = json.loads(input())
own = {p["wan"], p["lan"]}
lan_net = ipaddress.ip_network(p["lanNet"])


def match(c, view, state):
    if c.get("proto") and c["proto"] != view["proto"]:
        return False
    if c.get("src") and ipaddress.ip_address(view["src"]) not in ipaddress.ip_network(c["src"]):
        return False
    if c.get("dst") and c["dst"] != view["dst"]:
        return False
    if c.get("dport") is not None and c["dport"] != view["dport"]:
        return False
    if c.get("inIface") and c["inIface"] != view["in"]:
        return False
    if c.get("outIface") and c["outIface"] != view["out"]:
        return False
    if c.get("state") and c["state"] != state:
        return False
    return True


def first(rules, view, state):
    for r in rules:
        if match(r["cond"], view, state):
            return r
    return None


def key(t):
    return (t["proto"], t["src"], t["sport"], t["dst"], t["dport"])


def rev(t):
    return {"proto": t["proto"], "src": t["dst"], "sport": t["dport"], "dst": t["src"], "dport": t["sport"]}


conns = []
for pkt in p["packets"]:
    t = {k: pkt[k] for k in ("proto", "src", "sport", "dst", "dport")}
    state, now = "NEW", None
    for orig, out in conns:
        if key(orig) == key(t):
            state, now = "EST", out
            break
        if key(rev(out)) == key(t):
            state, now = "EST", rev(orig)
            break
    if now is None:
        view = {"proto": t["proto"], "src": t["src"], "dst": t["dst"], "dport": t["dport"], "in": pkt["iface"], "out": None}
        rule = first(p["pre"], view, "NEW")
        now = dict(t)
        if rule:
            now["dst"] = rule["toIp"]
            if rule.get("toPort"):
                now["dport"] = rule["toPort"]
    local = now["dst"] in own
    out_if = None if local else ("eth1" if ipaddress.ip_address(now["dst"]) in lan_net else "eth0")
    view = {"proto": t["proto"], "src": t["src"], "dst": now["dst"], "dport": now["dport"], "in": pkt["iface"], "out": out_if}
    if local:
        rule = first(p["input"], view, state)
        verdict = rule["target"] if rule else p["inputPolicy"]
    else:
        rule = first(p["forward"], view, state)
        verdict = rule["target"] if rule else p["forwardPolicy"]
    if verdict != "ACCEPT":
        print("DROP")
        continue
    if not local and state == "NEW":
        rule = first(p["post"], dict(view, src=now["src"]), "NEW")
        if rule:
            now = dict(now, src=(p["wan"] if out_if == "eth0" else p["lan"]) if rule["target"] == "MASQUERADE" else rule["toIp"])
    if state == "NEW":
        conns.append((t, now))
    print("LOCAL" if local else "%s:%d>%s:%d" % (now["src"], now["sport"], now["dst"], now["dport"]))
`;

function hostStdin(p: HostParams): string {
	const cond = (c: Cond) => ({
		proto: c.proto ?? null,
		src: c.src ? `${toIp(c.src[0])}/${c.src[1]}` : null,
		dport: c.dport ?? null,
		state: c.state ?? null
	});
	const pkt = (x: Packet) => ({ proto: x.proto, src: toIp(x.src), sport: x.sport, dst: toIp(x.dst), dport: x.dport });
	return JSON.stringify({
		policy: p.policy,
		chains: Object.fromEntries(
			Object.entries(p.chains).map(([name, rules]) => [
				name,
				rules.map((r) => ({ cond: cond(r.cond), target: r.target }))
			])
		),
		events: p.events.map((e) => ({ out: e.out, pkt: pkt(e.pkt) }))
	});
}

function gatewayStdin(p: GatewayParams): string {
	const cond = (c: Cond) => ({
		proto: c.proto ?? null,
		src: c.src ? `${toIp(c.src[0])}/${c.src[1]}` : null,
		dst: c.dst === undefined ? null : toIp(c.dst),
		dport: c.dport ?? null,
		inIface: c.inIface ?? null,
		outIface: c.outIface ?? null,
		state: c.state ?? null
	});
	const filter = (rules: FilterRule[]) => rules.map((r) => ({ cond: cond(r.cond), target: r.target }));
	const nat = (rules: NatRule[]) =>
		rules.map((r) => ({
			cond: cond(r.cond),
			target: r.target,
			toIp: r.toIp === undefined ? null : toIp(r.toIp),
			toPort: r.toPort ?? null
		}));
	return JSON.stringify({
		wan: toIp(p.wan),
		lan: toIp(p.lan),
		lanNet: `${toIp(p.lanNet)}/24`,
		pre: nat(p.pre),
		post: nat(p.post),
		input: filter(p.input),
		inputPolicy: p.inputPolicy,
		forward: filter(p.forward),
		forwardPolicy: p.forwardPolicy,
		packets: p.packets.map((x) => ({
			proto: x.proto,
			src: toIp(x.src),
			sport: x.sport,
			dst: toIp(x.dst),
			dport: x.dport,
			iface: x.iface
		}))
	});
}

const WRONG: Record<string, Partial<Rules>> = {
	'return-accepts': { returnAccepts: true },
	'chain-end-policy': { chainEndPolicy: true },
	'no-conntrack': { noConntrack: true },
	'dropped-tracked': { droppedTracked: true },
	'last-match': { lastMatch: true },
	'most-specific': { mostSpecific: true },
	'log-terminates': { logTerminates: true },
	'filter-sees-original': { filterSeesOriginal: true },
	'nat-replies-new': { natRepliesNew: true },
	'snat-before-filter': { snatBeforeFilter: true },
	'dnat-always-forward': { dnatAlwaysForward: true },
	'ignore-iface': { ignoreIface: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/user-chain': ['return-accepts', 'chain-end-policy'],
	'middle/conntrack': ['no-conntrack', 'dropped-tracked'],
	'middle/rule-order': ['last-match', 'most-specific'],
	'middle/log-target': ['log-terminates'],
	'senior/dnat-forward': ['filter-sees-original'],
	'senior/masquerade-replies': ['nat-replies-new', 'snat-before-filter'],
	'senior/dnat-to-local': ['dnat-always-forward'],
	'senior/iface-match': ['ignore-iface']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class requires changes the answer and the verdicts differ.
	for (let tries = 0; tries < 400; tries += 1) {
		const host = input.grade === 'middle' ? hostScenario(rng, input.classId) : null;
		const gateway = host ? null : gatewayScenario(rng, input.classId);
		const solve = (rules: Rules): string[] =>
			host ? simulateHost(host, rules) : simulateGateway(gateway as GatewayParams, rules);
		const answer = solve(RIGHT);
		if (new Set(answer).size < 2) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve({ ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: host ? describeHost(host) : describeGateway(gateway as GatewayParams), code: null },
			answer: { kind: 'sequence', value: answer }
		});
		const reference = host
			? { source: PYTHON_HOST, stdin: hostStdin(host) }
			: { source: PYTHON_GATEWAY, stdin: gatewayStdin(gateway as GatewayParams) };
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
