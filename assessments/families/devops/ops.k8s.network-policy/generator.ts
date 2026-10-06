// NetworkPolicy: which connections between pods of several namespaces and outside addresses pass — isolation by
// direction, peers of a rule joined by OR and selectors inside one peer by AND, podSelector scoped to the policy's
// namespace, ipBlock with except, ports and protocols, egress with DNS. The candidate names the allowed connections.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PY_YAML, yamlText, type Yaml } from '../../_lib/yaml.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

// ---- The scenario ----

type Labels = Record<string, string>;
type Protocol = 'TCP' | 'UDP';
type Direction = 'Ingress' | 'Egress';

interface Namespace {
	name: string;
	labels: Labels;
}

interface PodX {
	name: string;
	namespace: string;
	labels: Labels;
	ip: string;
}

interface Peer {
	pod?: Labels;
	namespace?: Labels;
	block?: { cidr: string; except: string[] };
}

interface Rule {
	/** `null` — the rule has no `from`/`to`: any peer. */
	peers: Peer[] | null;
	/** `null` — any port. */
	ports: { port: number; protocol: Protocol }[] | null;
}

interface Policy {
	name: string;
	namespace: string;
	podSelector: Labels;
	types: Direction[];
	ingress: Rule[];
	egress: Rule[];
}

type End = { pod: string } | { ip: string };

interface Connection {
	id: string;
	from: End;
	to: End;
	port: number;
	protocol: Protocol;
}

interface Params {
	namespaces: Namespace[];
	pods: PodX[];
	policies: Policy[];
	connections: Connection[];
}

interface Rules {
	andAsOr: boolean;
	ingressOnly: boolean;
	ignoreExcept: boolean;
	podAnyNamespace: boolean;
	portsIgnored: boolean;
}

const RIGHT: Rules = {
	andAsOr: false,
	ingressOnly: false,
	ignoreExcept: false,
	podAnyNamespace: false,
	portsIgnored: false
};

const matches = (labels: Labels, selector: Labels): boolean =>
	Object.entries(selector).every(([k, v]) => labels[k] === v);

const ipNumber = (ip: string): number => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

function inCidr(ip: string, cidr: string): boolean {
	const [base = '', bits = '32'] = cidr.split('/');
	const size = 2 ** (32 - Number(bits));
	return Math.floor(ipNumber(ip) / size) === Math.floor(ipNumber(base) / size);
}

function allowed(p: Params, c: Connection, r: Rules): boolean {
	const podOf = (end: End): PodX | null => ('pod' in end ? (p.pods.find((x) => x.name === end.pod) ?? null) : null);
	const nsLabels = (name: string): Labels => p.namespaces.find((n) => n.name === name)?.labels ?? {};
	const peerMatches = (peer: Peer, policyNs: string, end: End): boolean => {
		const pod = podOf(end);
		if (!pod) {
			if (!peer.block || !('ip' in end)) return false;
			return inCidr(end.ip, peer.block.cidr) && (r.ignoreExcept || !peer.block.except.some((x) => inCidr(end.ip, x)));
		}
		if (peer.block) return false;
		const byPod = (sel: Labels): boolean => matches(pod.labels, sel);
		const byNs = (sel: Labels): boolean => matches(nsLabels(pod.namespace), sel);
		if (peer.pod && peer.namespace) {
			if (r.andAsOr) return (byPod(peer.pod) && pod.namespace === policyNs) || byNs(peer.namespace);
			return byPod(peer.pod) && byNs(peer.namespace);
		}
		if (peer.pod) return byPod(peer.pod) && (r.podAnyNamespace || pod.namespace === policyNs);
		return byNs(peer.namespace ?? {});
	};
	const side = (pod: PodX, direction: Direction, other: End): boolean => {
		const selecting = p.policies.filter(
			(x) => x.namespace === pod.namespace && x.types.includes(direction) && matches(pod.labels, x.podSelector)
		);
		if (selecting.length === 0) return true;
		return selecting.some((x) =>
			(direction === 'Ingress' ? x.ingress : x.egress).some(
				(rule) =>
					(rule.peers === null || rule.peers.some((peer) => peerMatches(peer, x.namespace, other))) &&
					(rule.ports === null ||
						r.portsIgnored ||
						rule.ports.some((q) => q.port === c.port && q.protocol === c.protocol))
			)
		);
	};
	const src = podOf(c.from);
	const dst = podOf(c.to);
	if (src && !r.ingressOnly && !side(src, 'Egress', c.to)) return false;
	if (dst && !side(dst, 'Ingress', c.from)) return false;
	return true;
}

function answerOf(p: Params, r: Rules): string[] {
	return p.connections
		.filter((c) => allowed(p, c, r))
		.map((c) => c.id)
		.sort();
}

// ---- Drawing ----

const SUFFIX = 'bcdfghjklmnpqrstvwxz2456789';

function scenario(rng: Rng, classId: string): Params {
	const [app, mon, other] = [
		rng.pick(['shop', 'payments', 'orders', 'crm']),
		rng.pick(['monitoring', 'observability']),
		rng.pick(['dev', 'staging', 'sandbox'])
	];
	const meta = (name: string): Labels => ({ 'kubernetes.io/metadata.name': name });
	const namespaces: Namespace[] = [
		{ name: app, labels: { ...meta(app), env: 'prod' } },
		{ name: mon, labels: { ...meta(mon), purpose: 'monitoring' } },
		{ name: other, labels: { ...meta(other), env: other } },
		{ name: 'kube-system', labels: meta('kube-system') }
	];
	const used = new Set<number>();
	const pod = (base: string, namespace: string, labels: Labels): PodX => {
		let host = rng.int(2, 250);
		while (used.has(host)) host = rng.int(2, 250);
		used.add(host);
		const suffix = Array.from({ length: 4 }, () => SUFFIX.charAt(rng.int(0, SUFFIX.length - 1))).join('');
		return { name: `${base}-${suffix}`, namespace, labels, ip: `10.244.${rng.int(0, 3)}.${host}` };
	};
	const frontend = pod('frontend', app, { app: 'frontend' });
	const api = pod('api', app, { app: 'api', tier: 'backend' });
	const db = pod('db', app, { app: 'db', tier: 'data' });
	const worker = pod('worker', app, { app: 'worker', tier: 'backend' });
	const prometheus = pod('prometheus', mon, { app: 'prometheus' });
	const grafana = pod('grafana', mon, { app: 'grafana' });
	const strayApi = pod('api', other, { app: 'api', tier: 'backend' });
	const strayProm = pod('prometheus', other, { app: 'prometheus' });
	const dns = pod('coredns', 'kube-system', { 'k8s-app': 'kube-dns' });
	const pods = [frontend, api, db, worker, prometheus, grafana, strayApi, strayProm, dns];
	const apiPort = rng.pick([8080, 8000, 9000]);
	const metricsPort = rng.pick([9090, 9102]);
	const webPort = rng.pick([80, 443]);
	const andForm = classId === 'peer-and-or' || rng.bool();
	const monitorPeers: Peer[] = andForm
		? [{ pod: { app: 'prometheus' }, namespace: { purpose: 'monitoring' } }]
		: [{ pod: { app: 'prometheus' } }, { namespace: { purpose: 'monitoring' } }];
	const policies: Policy[] = [
		{
			name: 'default-deny',
			namespace: app,
			podSelector: {},
			types: classId === 'egress-dns' && rng.bool() ? ['Ingress', 'Egress'] : ['Ingress'],
			ingress: [],
			egress: []
		},
		{
			name: 'api-ingress',
			namespace: app,
			podSelector: { app: 'api' },
			types: ['Ingress'],
			ingress: [
				{ peers: [{ pod: { app: 'frontend' } }], ports: [{ port: apiPort, protocol: 'TCP' }] },
				{ peers: monitorPeers, ports: [{ port: metricsPort, protocol: 'TCP' }] }
			],
			egress: []
		}
	];
	if (classId === 'namespace-scope' || rng.bool(0.6)) {
		policies.push({
			name: 'db-ingress',
			namespace: app,
			podSelector: { app: 'db' },
			types: ['Ingress'],
			ingress: [
				{
					peers: [{ pod: rng.bool() ? { app: 'api' } : { tier: 'backend' } }],
					ports: [{ port: 5432, protocol: 'TCP' }]
				}
			],
			egress: []
		});
	}
	const outside = rng.pick(['203.0.113', '198.51.100']);
	const cut = rng.pick([25, 26, 27]);
	const cutBase = rng.pick([0, 64, 128, 192].filter((b) => b % 2 ** (32 - cut) === 0));
	if (classId === 'ipblock' || rng.bool(0.4)) {
		policies.push({
			name: 'frontend-ingress',
			namespace: app,
			podSelector: { app: 'frontend' },
			types: ['Ingress'],
			ingress: [
				{
					peers: [
						rng.bool()
							? { block: { cidr: `${outside}.0/24`, except: [`${outside}.${cutBase}/${cut}`] } }
							: { block: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8', `${outside}.${cutBase}/${cut}`] } }
					],
					ports: [{ port: webPort, protocol: 'TCP' }]
				}
			],
			egress: []
		});
	}
	if (classId === 'egress-dns' || rng.bool(0.25)) {
		const egress: Rule[] = [{ peers: [{ pod: { app: 'db' } }], ports: [{ port: 5432, protocol: 'TCP' }] }];
		if (rng.bool(0.7))
			egress.push({
				peers: [{ namespace: { 'kubernetes.io/metadata.name': 'kube-system' }, pod: { 'k8s-app': 'kube-dns' } }],
				ports: [{ port: 53, protocol: rng.bool(0.7) ? 'UDP' : 'TCP' }]
			});
		egress.push({
			peers: [{ block: { cidr: `${outside}.0/24`, except: [] } }],
			ports: [{ port: 443, protocol: 'TCP' }]
		});
		policies.push({
			name: 'api-egress',
			namespace: app,
			podSelector: { app: 'api' },
			types: ['Egress'],
			ingress: [],
			egress
		});
	}
	const ext = (lo: number, hi: number): string => `${outside}.${rng.int(lo, hi)}`;
	const inside = (): string => ext(cutBase, cutBase + 2 ** (32 - cut) - 1);
	const outsideCut = (): string => {
		for (;;) {
			const ip = ext(1, 254);
			if (!inCidr(ip, `${outside}.${cutBase}/${cut}`)) return ip;
		}
	};
	const other24 = `${outside === '203.0.113' ? '198.51.100' : '203.0.113'}.${rng.int(1, 254)}`;
	const P = (x: PodX): End => ({ pod: x.name });
	const pool: Omit<Connection, 'id'>[] = [
		{ from: P(frontend), to: P(api), port: apiPort, protocol: 'TCP' },
		{ from: P(strayApi), to: P(api), port: apiPort, protocol: 'TCP' },
		{ from: P(frontend), to: P(api), port: metricsPort, protocol: 'TCP' },
		{ from: P(prometheus), to: P(api), port: metricsPort, protocol: 'TCP' },
		{ from: P(strayProm), to: P(api), port: metricsPort, protocol: 'TCP' },
		{ from: P(grafana), to: P(api), port: metricsPort, protocol: 'TCP' },
		{ from: P(prometheus), to: P(api), port: apiPort, protocol: 'TCP' },
		{ from: P(api), to: P(db), port: 5432, protocol: 'TCP' },
		{ from: P(strayApi), to: P(db), port: 5432, protocol: 'TCP' },
		{ from: P(worker), to: P(db), port: 5432, protocol: 'TCP' },
		{ from: P(frontend), to: P(db), port: 5432, protocol: 'TCP' },
		{ from: P(api), to: P(dns), port: 53, protocol: 'UDP' },
		{ from: P(frontend), to: P(dns), port: 53, protocol: 'UDP' },
		{ from: P(api), to: { ip: ext(1, 254) }, port: 443, protocol: 'TCP' },
		{ from: P(api), to: { ip: other24 }, port: 443, protocol: 'TCP' },
		{ from: { ip: inside() }, to: P(frontend), port: webPort, protocol: 'TCP' },
		{ from: { ip: outsideCut() }, to: P(frontend), port: webPort, protocol: 'TCP' },
		{ from: { ip: outsideCut() }, to: P(api), port: apiPort, protocol: 'TCP' },
		{ from: P(db), to: P(api), port: apiPort, protocol: 'TCP' },
		{ from: P(api), to: P(strayApi), port: apiPort, protocol: 'TCP' }
	];
	const picked = rng.sample(pool, 8);
	return {
		namespaces,
		pods,
		policies,
		connections: picked.map((c, i) => ({ ...c, id: `c${i + 1}` }))
	};
}

// ---- The statement ----

const selectorYaml = (labels: Labels): Yaml => (Object.keys(labels).length ? { matchLabels: labels } : {});

function peerYaml(peer: Peer): Yaml {
	const out: { [key: string]: Yaml } = {};
	if (peer.pod) out.podSelector = selectorYaml(peer.pod);
	if (peer.namespace) out.namespaceSelector = selectorYaml(peer.namespace);
	if (peer.block)
		out.ipBlock = peer.block.except.length
			? { cidr: peer.block.cidr, except: peer.block.except }
			: { cidr: peer.block.cidr };
	return out;
}

function ruleYaml(rule: Rule, key: 'from' | 'to'): Yaml {
	const out: { [key: string]: Yaml } = {};
	if (rule.peers) out[key] = rule.peers.map(peerYaml);
	if (rule.ports) out.ports = rule.ports.map((q) => ({ protocol: q.protocol, port: q.port }));
	return out;
}

function manifest(p: Params): string {
	return yamlText(
		p.policies.map((x) => {
			const spec: { [key: string]: Yaml } = { podSelector: selectorYaml(x.podSelector), policyTypes: x.types };
			if (x.ingress.length) spec.ingress = x.ingress.map((rule) => ruleYaml(rule, 'from'));
			if (x.egress.length) spec.egress = x.egress.map((rule) => ruleYaml(rule, 'to'));
			return {
				apiVersion: 'networking.k8s.io/v1',
				kind: 'NetworkPolicy',
				metadata: { name: x.name, namespace: x.namespace },
				spec
			};
		})
	);
}

const labelText = (labels: Labels): string =>
	Object.entries(labels)
		.map(([k, v]) => `\`${k}=${v}\``)
		.join(', ');

function describe(p: Params): string {
	const end = (e: End): string => {
		if ('ip' in e) return `внешний адрес \`${e.ip}\``;
		const pod = p.pods.find((x) => x.name === e.pod);
		return `\`${e.pod}\` (\`${pod?.namespace ?? ''}\`)`;
	};
	return [
		'Namespace кластера и их метки:',
		'',
		'| Namespace | Метки |',
		'|---|---|',
		...p.namespaces.map((n) => `| \`${n.name}\` | ${labelText(n.labels)} |`),
		'',
		'Поды:',
		'',
		'| Под | Namespace | Метки | IP |',
		'|---|---|---|---|',
		...p.pods.map((x) => `| \`${x.name}\` | \`${x.namespace}\` | ${labelText(x.labels)} | \`${x.ip}\` |`),
		'',
		'В кластере действуют только NetworkPolicy из манифеста ниже; сетевой плагин выполняет их полностью. Допущения задачи: `ipBlock` совпадает только с внешними адресами (адреса подов под него не подпадают); у внешних адресов политик нет; ответы на разрешённое подключение проходят всегда.',
		'',
		'Подключения:',
		'',
		...p.connections.map((c) => `- \`${c.id}\`: ${end(c.from)} → ${end(c.to)}, ${c.protocol} ${c.port}`),
		'',
		'Какие подключения будут разрешены? Введите их номера (`c1`, `c2`, …) по одному в строке, в любом порядке; если разрешённых нет — одна строка `-`. Например:',
		'',
		'```\nc2\nc5\n```'
	].join('\n');
}

// ---- The proof: an independent reading of the shown policies ----

const PYTHON_REFERENCE = `${PY_YAML}import ipaddress

data = json.loads(sys.stdin.read())
policies = parse_yaml(data["yaml"])
ns_labels = {n["name"]: n["labels"] for n in data["namespaces"]}
pods = {p["name"]: p for p in data["pods"]}

def selects(sel, labels):
    return all(labels.get(k) == v for k, v in sel.get("matchLabels", {}).items())

def peer_ok(peer, policy_ns, end):
    if "ip" in end:
        block = peer.get("ipBlock")
        if block is None:
            return False
        ip = ipaddress.ip_address(end["ip"])
        return ip in ipaddress.ip_network(block["cidr"]) and not any(
            ip in ipaddress.ip_network(x) for x in block.get("except", []))
    if "ipBlock" in peer:
        return False
    pod = pods[end["pod"]]
    ok_pod = selects(peer["podSelector"], pod["labels"]) if "podSelector" in peer else True
    if "namespaceSelector" in peer:
        ok_ns = selects(peer["namespaceSelector"], ns_labels[pod["namespace"]])
    else:
        ok_ns = pod["namespace"] == policy_ns
    return ok_pod and ok_ns

def open_side(pod, kind, other, port, proto):
    mine = [p for p in policies if p["metadata"]["namespace"] == pod["namespace"]
            and kind in p["spec"]["policyTypes"] and selects(p["spec"]["podSelector"], pod["labels"])]
    if not mine:
        return True
    key, peers_key = ("ingress", "from") if kind == "Ingress" else ("egress", "to")
    for p in mine:
        for rule in p["spec"].get(key, []):
            peers = rule.get(peers_key)
            if peers is not None and not any(peer_ok(x, p["metadata"]["namespace"], other) for x in peers):
                continue
            ports = rule.get("ports")
            if ports is not None and not any(x["port"] == port and x.get("protocol", "TCP") == proto for x in ports):
                continue
            return True
    return False

out = []
for c in data["connections"]:
    ok = True
    if "pod" in c["from"]:
        ok = ok and open_side(pods[c["from"]["pod"]], "Egress", c["to"], c["port"], c["protocol"])
    if "pod" in c["to"]:
        ok = ok and open_side(pods[c["to"]["pod"]], "Ingress", c["from"], c["port"], c["protocol"])
    if ok:
        out.append(c["id"])
print("\\n".join(sorted(out)) if out else "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'and-as-or': { andAsOr: true },
	'ingress-only': { ingressOnly: true },
	'ignore-except': { ignoreExcept: true },
	'podselector-any-namespace': { podAnyNamespace: true },
	'ports-ignored': { portsIgnored: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/peer-and-or': ['and-as-or'],
	'senior/egress-dns': ['ingress-only'],
	'senior/ipblock': ['ignore-except'],
	'senior/namespace-scope': ['podselector-any-namespace']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = answerOf(p, RIGHT);
		if (answer.length < 2 || answer.length > 6) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(p, { ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const yaml = manifest(p);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'yaml', source: yaml } },
			answer: { kind: 'set', value: answer }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ yaml, namespaces: p.namespaces, pods: p.pods, connections: p.connections })
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null
							? null
							: { kind: 'answer' as const, answer: { kind: 'set' as const, value: value.length ? value : ['-'] } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
