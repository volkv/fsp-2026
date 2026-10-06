// Which connection attempts a host accepts: listening sockets bound to 127.0.0.1, 0.0.0.0, an interface address,
// [::] or [::1] (dual stack by net.ipv6.bindv6only), attempts from the host itself and from other hosts; for the junior
// level also a first-match filter of incoming IPv4 and IPv6 and container ports published by Docker.
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

interface Socket {
	proc: string;
	address: string;
	port: number;
}

interface Publish {
	container: string;
	/** `null` — no address in `-p`. */
	hostIp: string | null;
	hostPort: number;
	containerPort: number;
}

interface FilterRule {
	port: number | null;
	/** Source subnet in CIDR; `null` — any source. */
	src: string | null;
	action: 'ACCEPT' | 'DROP';
}

interface Filter {
	rules: FilterRule[];
	policy: 'ACCEPT' | 'DROP';
}

interface Attempt {
	/** `srv` itself or the name of another host. */
	from: string;
	to: string;
	port: number;
}

interface Client {
	name: string;
	v4: string;
	v6: string | null;
}

interface Params {
	v6only: 0 | 1;
	eth0: { v4: string; v6: string };
	eth1: string | null;
	sockets: Socket[];
	publishes: Publish[];
	/** `null` — no filter at all (the junior level always has one). */
	filter4: Filter | null;
	filter6: Filter | null;
	clients: Client[];
	attempts: Attempt[];
}

interface Rules {
	portOnly: boolean;
	anyExcludesLoopback: boolean;
	specificMeansHost: boolean;
	v6OnlyV6: boolean;
	v6AlwaysDual: boolean;
	v4AnyAcceptsV6: boolean;
	fwIgnored: boolean;
	fwLastMatch: boolean;
	fwOnDocker: boolean;
	publishAll: boolean;
	containerPort: boolean;
	fwV4OnV6: boolean;
}

const RIGHT: Rules = {
	portOnly: false,
	anyExcludesLoopback: false,
	specificMeansHost: false,
	v6OnlyV6: false,
	v6AlwaysDual: false,
	v4AnyAcceptsV6: false,
	fwIgnored: false,
	fwLastMatch: false,
	fwOnDocker: false,
	publishAll: false,
	containerPort: false,
	fwV4OnV6: false
};

const isV6 = (address: string): boolean => address.includes(':');
const LOOPBACK = new Set(['127.0.0.1', '::1']);

function ipv4ToInt(address: string): number {
	return address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function inCidr(address: string, cidr: string): boolean {
	const [net = '', bits = '32'] = cidr.split('/');
	const size = 2 ** (32 - Number(bits));
	return Math.floor(ipv4ToInt(address) / size) === Math.floor(ipv4ToInt(net) / size);
}

function socketAccepts(s: Socket, to: string, p: Params, rules: Rules): boolean {
	const v6 = isV6(to);
	if (s.address === '0.0.0.0')
		return (!v6 && !(rules.anyExcludesLoopback && to === '127.0.0.1')) || (v6 && rules.v4AnyAcceptsV6);
	if (s.address === '::') {
		if (v6) return true;
		if (rules.v6AlwaysDual) return true;
		if (rules.v6OnlyV6) return false;
		return p.v6only === 0;
	}
	if (s.address === to) return true;
	return rules.specificMeansHost && !LOOPBACK.has(s.address) && !LOOPBACK.has(to) && isV6(s.address) === v6;
}

function filterVerdict(f: Filter, src: string, port: number, rules: Rules): boolean {
	const matching = f.rules.filter(
		(r) => (r.port === null || r.port === port) && (r.src === null || (!isV6(src) && inCidr(src, r.src)))
	);
	const rule = rules.fwLastMatch ? matching[matching.length - 1] : matching[0];
	return (rule?.action ?? f.policy) === 'ACCEPT';
}

function accepted(a: Attempt, p: Params, rules: Rules): boolean {
	const local = a.from === 'srv';
	const v6 = isV6(a.to);
	const client = p.clients.find((c) => c.name === a.from);
	const src = local ? a.to : v6 ? (client?.v6 ?? '') : (client?.v4 ?? '');
	const filterPasses = (): boolean => {
		if (local || rules.fwIgnored) return true;
		const f = v6 && !rules.fwV4OnV6 ? p.filter6 : p.filter4;
		return f === null || filterVerdict(f, src, a.port, rules);
	};
	if (rules.portOnly) {
		const listening =
			p.sockets.some((s) => s.port === a.port) ||
			p.publishes.some((pub) => pub.hostPort === a.port || (rules.containerPort && pub.containerPort === a.port));
		return listening && filterPasses();
	}
	const published = p.publishes.some(
		(pub) => !v6 && pub.hostPort === a.port && (pub.hostIp === null || rules.publishAll || pub.hostIp === a.to)
	);
	if (published) return rules.fwOnDocker ? filterPasses() : true;
	const byContainerPort = rules.containerPort && !v6 && p.publishes.some((pub) => pub.containerPort === a.port);
	const listening = byContainerPort || p.sockets.some((s) => s.port === a.port && socketAccepts(s, a.to, p, rules));
	return listening && filterPasses();
}

function solve(p: Params, rules: Rules): string[] {
	const out = p.attempts.flatMap((a, i) => (accepted(a, p, rules) ? [String(i + 1)] : []));
	return out.length ? out.sort() : ['-'];
}

// Scenario.

const SERVICES: [string, number][] = [
	['sshd', 22],
	['nginx', 80],
	['nginx', 443],
	['postgres', 5432],
	['redis-server', 6379],
	['node', 3000],
	['java', 8080],
	['node_exporter', 9100],
	['prometheus', 9090],
	['mysqld', 3306],
	['memcached', 11211],
	['cupsd', 631],
	['vault', 8200],
	['etcd', 2379]
];

const CONTAINERS: [string, number][] = [
	['web', 80],
	['api', 8000],
	['grafana', 3000],
	['adminer', 8080],
	['minio', 9000],
	['keycloak', 8443]
];

function hostScenario(rng: Rng): { eth0: Params['eth0']; eth1: string; lan: string } {
	const a = rng.pick([...Array.from({ length: 250 }, (_, i) => i + 1)].filter((x) => x !== 8));
	const b = rng.int(1, 250);
	const host = rng.int(5, 200);
	const hex = rng.int(16, 255).toString(16);
	return {
		eth0: { v4: `10.${a}.${b}.${host}`, v6: `fd00:${hex}::${host}` },
		eth1: `192.168.${rng.int(1, 250)}.${rng.int(2, 250)}`,
		lan: `10.${a}.${b}`
	};
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const { eth0, eth1, lan } = hostScenario(rng);
	const services = rng.sample(SERVICES, 6);
	const svc = (i: number): [string, number] => services[i] ?? ['sshd', 22];
	const sockets: Socket[] = [];
	let v6only: 0 | 1 = rng.bool() ? 0 : 1;
	let useEth1 = false;
	const publishes: Publish[] = [];
	let filter4: Filter | null = null;
	let filter6: Filter | null = null;
	const clientHost = rng.int(201, 254);
	const clients: Client[] = [
		{ name: 'client', v4: `${lan}.${clientHost}`, v6: `${eth0.v6.split('::')[0]}::${clientHost}` }
	];
	if (grade === 'intern') {
		if (classId === 'loopback-vs-any') {
			for (const [i, address] of ['127.0.0.1', '0.0.0.0', '127.0.0.1', '0.0.0.0'].entries())
				sockets.push({ proc: svc(i)[0], address, port: svc(i)[1] });
			if (rng.bool()) sockets.push({ proc: svc(4)[0], address: '::1', port: svc(4)[1] });
		} else if (classId === 'specific-ip') {
			useEth1 = true;
			const bound = [eth0.v4, eth1, rng.pick([eth0.v4, eth1]), '127.0.0.1', '0.0.0.0'];
			for (const [i, address] of bound.entries()) sockets.push({ proc: svc(i)[0], address, port: svc(i)[1] });
		} else {
			v6only = classId === 'dual-stack' ? 0 : 1;
			sockets.push(
				{ proc: svc(0)[0], address: '::', port: svc(0)[1] },
				{ proc: svc(1)[0], address: '::', port: svc(1)[1] },
				{ proc: svc(2)[0], address: '0.0.0.0', port: svc(2)[1] },
				{ proc: svc(3)[0], address: rng.pick(['::1', '127.0.0.1']), port: svc(3)[1] }
			);
			if (classId === 'v6only') sockets.push({ proc: svc(1)[0], address: '0.0.0.0', port: svc(1)[1] });
			else sockets.push({ proc: svc(4)[0], address: '0.0.0.0', port: svc(4)[1] });
		}
	} else {
		clients.push(
			{ name: 'vpn', v4: `10.8.0.${rng.int(2, 250)}`, v6: null },
			{
				name: 'ext',
				v4: `203.0.113.${rng.int(2, 250)}`,
				v6: `2001:db8:${rng.int(16, 255).toString(16)}::${rng.int(2, 99)}`
			}
		);
		const rulesFor = (ports: number[]): FilterRule[] => {
			const pool: FilterRule[] = [
				{ port: ports[0] ?? 22, src: '10.8.0.0/24', action: 'ACCEPT' },
				{ port: ports[0] ?? 22, src: null, action: 'DROP' },
				{ port: ports[1] ?? 80, src: `${lan}.0/24`, action: 'ACCEPT' },
				{ port: null, src: '203.0.113.0/24', action: 'DROP' },
				{ port: ports[2] ?? 443, src: null, action: 'ACCEPT' },
				{ port: ports[1] ?? 80, src: null, action: 'DROP' },
				{ port: ports[3] ?? 8080, src: '10.0.0.0/8', action: 'ACCEPT' }
			];
			return rng.shuffle(pool).slice(0, rng.int(3, 5));
		};
		if (classId === 'firewall-input') {
			for (let i = 0; i < 4; i += 1)
				sockets.push({ proc: svc(i)[0], address: i === 3 ? '127.0.0.1' : '0.0.0.0', port: svc(i)[1] });
			filter4 = { rules: rulesFor(services.map((s) => s[1])), policy: rng.pick(['ACCEPT', 'DROP']) };
		} else {
			const containers = rng.sample(CONTAINERS, 3);
			const taken = new Set(services.map((s) => s[1]));
			const hostPorts = rng.sample(
				[8080, 8081, 8443, 9000, 9443, 3001, 5000, 8888].filter((port) => !taken.has(port)),
				3
			);
			for (const [i, [container, containerPort]] of containers.entries()) {
				if (classId === 'v6-firewall' && i > 0) break;
				const hostIp =
					classId === 'docker-publish'
						? (['127.0.0.1', null, rng.pick([eth0.v4, '127.0.0.1'])][i] ?? null)
						: i === 0
							? null
							: rng.pick([null, '127.0.0.1']);
				publishes.push({ container, hostIp, hostPort: hostPorts[i] ?? 8080, containerPort });
			}
			for (let i = 0; i < 3; i += 1)
				sockets.push({
					proc: svc(i)[0],
					address: classId === 'v6-firewall' ? (i === 2 ? '0.0.0.0' : '::') : i === 2 ? '127.0.0.1' : '0.0.0.0',
					port: svc(i)[1]
				});
			if (classId === 'v6-firewall') v6only = 0;
			const ports = [...sockets.map((s) => s.port), ...publishes.map((pub) => pub.hostPort)];
			if (classId === 'docker-publish') filter4 = { rules: [], policy: 'ACCEPT' };
			else if (classId === 'docker-bypass') {
				const pub = publishes.map((x) => x.hostPort);
				filter4 = {
					rules: rng.shuffle([
						{ port: svc(0)[1], src: null, action: 'ACCEPT' as const },
						{ port: pub[0] ?? 8080, src: null, action: 'DROP' as const },
						{ port: pub[1] ?? 8081, src: '203.0.113.0/24', action: 'DROP' as const }
					]),
					policy: 'DROP'
				};
			} else {
				filter4 = { rules: rulesFor(rng.shuffle(ports)), policy: 'DROP' };
				filter6 = {
					rules: [{ port: rng.pick(ports), src: null, action: 'DROP' }],
					policy: 'ACCEPT'
				};
			}
		}
	}
	// Attempts: every reachable address of srv and every port that matters, from srv itself and from other hosts.
	const ports = [
		...new Set([...sockets.map((s) => s.port), ...publishes.flatMap((pub) => [pub.hostPort, pub.containerPort])])
	];
	const external = [eth0.v4, eth0.v6, ...(useEth1 ? [eth1] : [])];
	const pool: Attempt[] = [];
	for (const port of ports) {
		for (const to of ['127.0.0.1', '::1', ...external]) pool.push({ from: 'srv', to, port });
		for (const c of clients)
			for (const to of external) if (!isV6(to) || c.v6 !== null) pool.push({ from: c.name, to, port });
	}
	const count = rng.int(8, 9);
	const ipv6Wanted = grade === 'intern' ? classId === 'dual-stack' || classId === 'v6only' : classId === 'v6-firewall';
	const attempts = rng
		.shuffle(pool)
		.filter((a) => ipv6Wanted || !isV6(a.to) || rng.bool(0.3))
		.slice(0, count);
	return {
		v6only,
		eth0,
		eth1: useEth1 ? eth1 : null,
		sockets: rng.shuffle(sockets),
		publishes,
		filter4,
		filter6,
		clients,
		attempts
	};
}

const target = (a: Attempt): string => (isV6(a.to) ? `[${a.to}]:${a.port}` : `${a.to}:${a.port}`);
const bindText = (s: Socket): string => (isV6(s.address) ? `[${s.address}]:${s.port}` : `${s.address}:${s.port}`);

function filterTable(f: Filter, title: string): string[] {
	const rows = f.rules.map(
		(r, i) =>
			`| ${i + 1} | ${r.port === null ? 'любой' : r.port} | ${r.src === null ? 'любой' : `\`${r.src}\``} | ${r.action} |`
	);
	return [
		`${title}, политика по умолчанию — **${f.policy}**${f.rules.length ? ':' : '; правил нет.'}`,
		...(f.rules.length ? ['', '| № | Порт назначения | Источник | Действие |', '|---|---|---|---|', ...rows] : [])
	];
}

function describe(p: Params, grade: string): string {
	const lines: string[] = [
		`Адреса хоста \`srv\`: \`lo\` — \`127.0.0.1\` и \`::1\`; \`eth0\` — \`${p.eth0.v4}\` и \`${p.eth0.v6}\`${p.eth1 ? `; \`eth1\` — \`${p.eth1}\`` : ''}.`,
		'',
		`\`net.ipv6.bindv6only = ${p.v6only}\`: ${
			p.v6only === 0
				? 'сокет, слушающий `[::]`, принимает подключения и по IPv6, и по IPv4 (двойной стек).'
				: 'сокет, слушающий `[::]`, принимает только подключения по IPv6.'
		}`,
		'',
		'Слушающие TCP-сокеты на `srv` (как в `ss -ltnp`):',
		'',
		'| Процесс | Локальный адрес:порт |',
		'|---|---|',
		...p.sockets.map((s) => `| \`${s.proc}\` | \`${bindText(s)}\` |`),
		''
	];
	if (p.publishes.length) {
		lines.push(
			'Контейнеры Docker запущены с публикацией портов (Docker на `srv` публикует порты только по IPv4); процесс в каждом контейнере слушает свой порт:',
			'',
			'| Контейнер | Публикация |',
			'|---|---|',
			...p.publishes.map(
				(pub) =>
					`| \`${pub.container}\` | \`-p ${pub.hostIp ? `${pub.hostIp}:` : ''}${pub.hostPort}:${pub.containerPort}\` |`
			),
			''
		);
	}
	if (grade === 'junior') {
		lines.push(
			'Входящие подключения с других хостов проходят фильтр: правила проверяются сверху вниз, срабатывает первое совпавшее, если ни одно не совпало — политика по умолчанию. Подключения `srv` к самому себе фильтр пропускает всегда.',
			'',
			...filterTable(p.filter4 as Filter, 'Правила для IPv4'),
			''
		);
		if (p.filter6)
			lines.push(...filterTable(p.filter6, 'Правила для IPv6 (отдельный набор, к IPv4 не применяется)'), '');
		if (p.publishes.length)
			lines.push(
				'Опубликованные порты Docker перенаправляет правилами DNAT до фильтра входящих: правила выше к подключениям на опубликованные порты не применяются.',
				''
			);
		lines.push(
			`Другие хосты: ${p.clients.map((c) => `\`${c.name}\` — \`${c.v4}\`${c.v6 ? ` и \`${c.v6}\`` : ''}`).join('; ')}; все они достают до внешних адресов \`srv\`.`,
			''
		);
	} else {
		lines.push('Хост `client` в той же сети достаёт до внешних адресов `srv` по IPv4 и IPv6.', '');
	}
	lines.push(
		'Попытки подключения по TCP:',
		'',
		...p.attempts.map((a, i) => `${i + 1}. с \`${a.from}\` к \`${target(a)}\``),
		'',
		`Какие подключения будут приняты процессом на \`srv\`${p.publishes.length ? ' (или в его контейнере)' : ''}? Введите номера попыток по одному в строке, порядок не важен; если ни одно — одну строку \`-\`.`
	);
	return lines.join('\n');
}

const PYTHON_REFERENCE = `import ipaddress
import json

p = json.loads(input())
local_addrs = {"127.0.0.1", "::1"}


def is_v6(a):
    return ipaddress.ip_address(a).version == 6


def socket_takes(bind, dst):
    v6 = is_v6(dst)
    if bind == "0.0.0.0":
        return not v6
    if bind == "::":
        return v6 or p["v6only"] == 0
    return ipaddress.ip_address(bind) == ipaddress.ip_address(dst)


def filter_allows(chain, src, port):
    if chain is None:
        return True
    for r in chain["rules"]:
        if r["port"] is not None and r["port"] != port:
            continue
        if r["src"] is not None:
            if is_v6(src) or ipaddress.ip_address(src) not in ipaddress.ip_network(r["src"]):
                continue
        return r["action"] == "ACCEPT"
    return chain["policy"] == "ACCEPT"


hosts = {c["name"]: c for c in p["clients"]}
ok = []
for n, a in enumerate(p["attempts"], 1):
    dst, port, local = a["to"], a["port"], a["from"] == "srv"
    v6 = is_v6(dst)
    pub = any(not v6 and x["hostPort"] == port and (x["hostIp"] is None or x["hostIp"] == dst) for x in p["publishes"])
    if pub:
        ok.append(n)
        continue
    if not any(s["port"] == port and socket_takes(s["address"], dst) for s in p["sockets"]):
        continue
    if not local:
        src = hosts[a["from"]]["v6" if v6 else "v4"]
        if not filter_allows(p["filter6"] if v6 else p["filter4"], src, port):
            continue
    ok.append(n)
print("\\n".join(str(n) for n in ok) if ok else "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'port-only': { portOnly: true },
	'any-excludes-loopback': { anyExcludesLoopback: true },
	'specific-means-host': { specificMeansHost: true },
	'v6-only-v6': { v6OnlyV6: true },
	'v6-always-dual': { v6AlwaysDual: true },
	'v4-any-accepts-v6': { v4AnyAcceptsV6: true },
	'fw-ignored': { fwIgnored: true },
	'fw-last-match': { fwLastMatch: true },
	'fw-on-docker': { fwOnDocker: true },
	'publish-all': { publishAll: true },
	'container-port': { containerPort: true },
	'fw-v4-on-v6': { fwV4OnV6: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/loopback-vs-any': ['port-only', 'any-excludes-loopback'],
	'intern/specific-ip': ['specific-means-host', 'port-only'],
	'intern/dual-stack': ['v6-only-v6', 'v4-any-accepts-v6'],
	'intern/v6only': ['v6-always-dual'],
	'junior/firewall-input': ['fw-ignored', 'fw-last-match'],
	'junior/docker-publish': ['publish-all', 'container-port'],
	'junior/docker-bypass': ['fw-on-docker'],
	'junior/v6-firewall': ['fw-v4-on-v6', 'v6-only-v6']
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class requires changes the answer, and some attempts are
	// accepted and some are not.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = solve(p, RIGHT);
		if (answer.length < 2 || answer.length > p.attempts.length - 2) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, { ...RIGHT, ...change });
				return [id, sameSet(value, answer) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, input.grade), code: null },
			answer: { kind: 'set', value: answer }
		});
		const stdin = JSON.stringify({
			v6only: p.v6only,
			sockets: p.sockets,
			publishes: p.publishes,
			filter4: p.filter4,
			filter6: p.filter6,
			clients: p.clients,
			attempts: p.attempts
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
