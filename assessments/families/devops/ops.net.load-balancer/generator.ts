// Load balancing: which server takes each request — smooth weighted round robin, weighted least connections over
// time, a hash of the client's address with a server taken out, passive health checks (max_fails, fail_timeout,
// a retry on the next server); for the senior level consistent hashing on a ring with virtual nodes — which keys
// move, and where, when a node is added, removed or replaced.
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

interface Rules {
	plainWeighted: boolean;
	rrIgnoresWeight: boolean;
	countTotal: boolean;
	lcIgnoresWeight: boolean;
	finishAfterArrival: boolean;
	allFourOctets: boolean;
	downIgnored: boolean;
	downModAlive: boolean;
	noRetry: boolean;
	failsNeverExpire: boolean;
	markedForever: boolean;
	counterClockwise: boolean;
	strictGreater: boolean;
	noWrap: boolean;
	modN: boolean;
	toNextInList: boolean;
}

const RIGHT: Rules = {
	plainWeighted: false,
	rrIgnoresWeight: false,
	countTotal: false,
	lcIgnoresWeight: false,
	finishAfterArrival: false,
	allFourOctets: false,
	downIgnored: false,
	downModAlive: false,
	noRetry: false,
	failsNeverExpire: false,
	markedForever: false,
	counterClockwise: false,
	strictGreater: false,
	noWrap: false,
	modN: false,
	toNextInList: false
};

interface Server {
	name: string;
	weight: number;
	down: boolean;
	/** Passive health: the server fails every attempt within these closed intervals of seconds. */
	broken: [number, number][];
}

type Middle =
	| { kind: 'smooth-weighted'; servers: Server[]; requests: number }
	| { kind: 'least-conn'; servers: Server[]; requests: { t: number; d: number }[] }
	| { kind: 'ip-hash'; servers: Server[]; clients: number[][] }
	| { kind: 'passive-health'; servers: Server[]; maxFails: number; failTimeout: number; requests: number[] };

function smoothWeighted(servers: readonly Server[], n: number, rules: Rules): string[] {
	const out: string[] = [];
	if (rules.plainWeighted || rules.rrIgnoresWeight) {
		const cycle = servers.flatMap((s) => Array.from({ length: rules.rrIgnoresWeight ? 1 : s.weight }, () => s.name));
		for (let i = 0; i < n; i += 1) out.push(cycle[i % cycle.length] ?? '');
		return out;
	}
	const current = servers.map(() => 0);
	const total = servers.reduce((sum, s) => sum + s.weight, 0);
	for (let i = 0; i < n; i += 1) {
		let best = 0;
		servers.forEach((s, j) => {
			current[j] = (current[j] ?? 0) + s.weight;
			if ((current[j] ?? 0) > (current[best] ?? 0)) best = j;
		});
		current[best] = (current[best] ?? 0) - total;
		out.push(servers[best]?.name ?? '');
	}
	return out;
}

function leastConn(servers: readonly Server[], requests: readonly { t: number; d: number }[], rules: Rules): string[] {
	const ends: number[][] = servers.map(() => []);
	return requests.map(({ t, d }) => {
		const load = ends.map((list) =>
			rules.countTotal ? list.length : list.filter((end) => (rules.finishAfterArrival ? end >= t : end > t)).length
		);
		let best = 0;
		servers.forEach((s, j) => {
			const w = rules.lcIgnoresWeight ? 1 : s.weight;
			const bw = rules.lcIgnoresWeight ? 1 : (servers[best]?.weight ?? 1);
			// load[j] / w < load[best] / bw, without fractions.
			if ((load[j] ?? 0) * bw < (load[best] ?? 0) * w) best = j;
		});
		ends[best]?.push(t + d);
		return servers[best]?.name ?? '';
	});
}

function ipHash(servers: readonly Server[], clients: readonly number[][], rules: Rules): string[] {
	return clients.map((octets) => {
		const sum = (octets[0] ?? 0) + (octets[1] ?? 0) + (octets[2] ?? 0) + (rules.allFourOctets ? (octets[3] ?? 0) : 0);
		if (rules.downModAlive) {
			const alive = servers.filter((s) => !s.down);
			return alive[sum % alive.length]?.name ?? '';
		}
		let i = sum % servers.length;
		if (!rules.downIgnored) while (servers[i]?.down) i = (i + 1) % servers.length;
		return servers[i]?.name ?? '';
	});
}

function passiveHealth(m: Extract<Middle, { kind: 'passive-health' }>, rules: Rules): string[] {
	const n = m.servers.length;
	const failures: number[][] = m.servers.map(() => []);
	const until: number[] = m.servers.map(() => -1);
	let pointer = 0;
	return m.requests.map((t) => {
		const tried: string[] = [];
		const seen = new Set<number>();
		for (;;) {
			let pick = -1;
			for (let k = 0; k < n; k += 1) {
				const i = (pointer + k) % n;
				if (seen.has(i) || t < (until[i] ?? -1)) continue;
				pick = i;
				break;
			}
			if (pick === -1) {
				tried.push('502');
				break;
			}
			pointer = (pick + 1) % n;
			seen.add(pick);
			const s = m.servers[pick] as Server;
			tried.push(s.name);
			const fails = s.broken.some(([a, b]) => t >= a && t <= b);
			if (!fails) break;
			const list = failures[pick] ?? [];
			list.push(t);
			const counted = rules.failsNeverExpire ? list.length : list.filter((x) => x > t - m.failTimeout).length;
			if (counted >= m.maxFails) {
				until[pick] = rules.markedForever ? Number.POSITIVE_INFINITY : t + m.failTimeout;
				failures[pick] = [];
			}
			if (rules.noRetry) break;
		}
		return tried.join('>');
	});
}

function solveMiddle(m: Middle, rules: Rules): string[] {
	switch (m.kind) {
		case 'smooth-weighted':
			return smoothWeighted(m.servers, m.requests, rules);
		case 'least-conn':
			return leastConn(m.servers, m.requests, rules);
		case 'ip-hash':
			return ipHash(m.servers, m.clients, rules);
		case 'passive-health':
			return passiveHealth(m, rules);
	}
}

// Senior: a ring of 360 positions.

interface RingNode {
	name: string;
	points: number[];
}

interface Senior {
	before: RingNode[];
	after: RingNode[];
	keys: number[];
}

const RING = 360;

function owner(nodes: readonly RingNode[], hash: number, rules: Rules): string {
	if (rules.modN) return nodes[hash % nodes.length]?.name ?? '';
	const points = nodes.flatMap((n) => n.points.map((p) => ({ p, name: n.name }))).sort((a, b) => a.p - b.p);
	if (rules.counterClockwise) {
		const found = [...points].reverse().find((x) => x.p <= hash);
		return (found ?? points[points.length - 1])?.name ?? '';
	}
	const found = points.find((x) => (rules.strictGreater ? x.p > hash : x.p >= hash));
	if (found) return found.name;
	return (rules.noWrap ? points[points.length - 1] : points[0])?.name ?? '';
}

function solveSenior(s: Senior, rules: Rules): string[] {
	const removed = s.before.filter((n) => !s.after.some((a) => a.name === n.name)).map((n) => n.name);
	const out: string[] = [];
	for (const id of s.keys) {
		const h = id % RING;
		const old = owner(s.before, h, rules);
		let now = owner(s.after, h, rules);
		if (rules.toNextInList && removed.includes(old)) {
			const i = s.before.findIndex((n) => n.name === old);
			for (let k = 1; k < s.before.length; k += 1) {
				const next = s.before[(i + k) % s.before.length];
				if (next && !removed.includes(next.name)) {
					now = next.name;
					break;
				}
			}
		}
		if (now !== old) out.push(`user:${id} ${now}`);
	}
	return out.length ? out : ['-'];
}

// Scenarios.

const SERVER_NAMES = ['alpha', 'bravo', 'delta', 'echo', 'kilo', 'lima', 'oscar', 'tango', 'zulu', 'sierra'];
const NODE_NAMES = ['cache-a', 'cache-b', 'cache-c', 'cache-d', 'cache-e', 'cache-f', 'cache-g'];

const servers = (rng: Rng, n: number): Server[] =>
	rng.sample(SERVER_NAMES, n).map((name) => ({ name, weight: 1, down: false, broken: [] }));

function middleScenario(rng: Rng, classId: string): Middle {
	if (classId === 'smooth-weighted') {
		const list = servers(rng, rng.int(3, 4));
		for (const s of list) s.weight = rng.int(1, 5);
		return { kind: 'smooth-weighted', servers: list, requests: rng.int(8, 11) };
	}
	if (classId === 'least-conn') {
		const list = servers(rng, 3);
		for (const s of list) s.weight = rng.int(1, 3);
		let t = 0;
		const requests = Array.from({ length: rng.int(8, 10) }, () => {
			t += rng.pick([0, 1, 1, 2, 2, 3, 5]);
			return { t, d: rng.int(1, 8) };
		});
		return { kind: 'least-conn', servers: list, requests };
	}
	if (classId === 'ip-hash') {
		const list = servers(rng, rng.int(4, 5));
		const down = list[rng.int(0, list.length - 1)];
		if (down) down.down = true;
		// Five networks, at least four of them among the clients: as many sums to compute as there are state updates
		// in the other classes.
		const nets = Array.from({ length: 5 }, () => [rng.pick([10, 172, 192, 85, 31]), rng.int(0, 255), rng.int(0, 255)]);
		let clients: number[][] = [];
		while (new Set(clients.map((c) => c.slice(0, 3).join('.'))).size < 4)
			clients = Array.from({ length: rng.int(8, 9) }, () => [...rng.pick(nets), rng.int(1, 254)]);
		return { kind: 'ip-hash', servers: list, clients };
	}
	const list = servers(rng, 3);
	const victim = list[rng.int(0, 2)] as Server;
	const start = rng.int(2, 12);
	victim.broken = [[start, start + rng.int(20, 60)]];
	if (rng.bool(0.4)) {
		const other = list.find((s) => s !== victim) as Server;
		const s2 = rng.int(start, start + 30);
		other.broken = [[s2, s2 + rng.int(3, 10)]];
	}
	let t = 0;
	const requests = Array.from({ length: rng.int(10, 12) }, () => {
		t += rng.int(1, 10);
		return t;
	});
	return {
		kind: 'passive-health',
		servers: list,
		maxFails: rng.int(2, 3),
		failTimeout: rng.pick([10, 15, 20, 30]),
		requests
	};
}

function points(rng: Rng, used: Set<number>, count: number, from = 0, to = RING - 1): number[] {
	const out: number[] = [];
	while (out.length < count) {
		const p = rng.int(from, to);
		if (used.has(p)) continue;
		used.add(p);
		out.push(p);
	}
	return out.sort((a, b) => a - b);
}

function seniorScenario(rng: Rng, classId: string): Senior {
	const used = new Set<number>();
	const names = rng.sample(NODE_NAMES, 5);
	const name = (i: number): string => names[i] ?? 'cache-x';
	let before: RingNode[];
	let after: RingNode[];
	if (classId === 'add-node') {
		before = [0, 1, 2].map((i) => ({ name: name(i), points: points(rng, used, rng.int(2, 3)) }));
		after = [...before, { name: name(3), points: points(rng, used, rng.int(2, 3)) }];
	} else if (classId === 'remove-node') {
		before = [0, 1, 2, 3].map((i) => ({ name: name(i), points: points(rng, used, rng.int(2, 3)) }));
		const gone = rng.int(0, 3);
		after = before.filter((_, i) => i !== gone);
	} else if (classId === 'wraparound') {
		// Every point sits away from both ends of the ring; the added node takes a point after the last one.
		before = [0, 1, 2].map((i) => ({ name: name(i), points: points(rng, used, 2, 30, 320) }));
		after = [
			...before,
			{
				name: name(3),
				points: [...points(rng, used, 1, 330, 355), ...points(rng, used, 1, 30, 320)].sort((a, b) => a - b)
			}
		];
	} else {
		before = [0, 1, 2].map((i) => ({ name: name(i), points: points(rng, used, rng.int(1, 4)) }));
		const gone = rng.int(0, 2);
		const goneCount = before[gone]?.points.length ?? 1;
		const added = {
			name: name(3),
			points: points(rng, used, goneCount >= 3 ? rng.int(1, 2) : rng.int(goneCount + 1, 4))
		};
		after = [...before.filter((_, i) => i !== gone), added];
	}
	const all = [...new Set([...before, ...after].flatMap((n) => n.points))];
	const keys = new Set<number>();
	const count = rng.int(7, 9);
	if (classId === 'wraparound') {
		keys.add(rng.pick(all) + RING * rng.int(1, 8));
		keys.add(rng.int(Math.max(...before.flatMap((n) => n.points)) + 1, RING - 1) + RING * rng.int(0, 8));
	}
	while (keys.size < count) {
		const h = rng.bool(0.15) ? rng.pick(all) : rng.int(0, RING - 1);
		keys.add(h + RING * rng.int(0, 8));
	}
	return { before, after, keys: rng.shuffle([...keys]) };
}

// Statements.

const serverTable = (list: readonly Server[], extra: (s: Server) => string, head: string): string[] => [
	`| Сервер | ${head} |`,
	'|---|---|',
	...list.map((s) => `| \`${s.name}\` | ${extra(s)} |`)
];

const MIDDLE_FORMAT = 'Введите имена серверов в порядке запросов, по одному в строке.';

function describeMiddle(m: Middle): string {
	if (m.kind === 'smooth-weighted') {
		return [
			'Балансировщик распределяет запросы между серверами по сглаженному взвешенному круговому алгоритму (как `weight` в upstream nginx):',
			'',
			...serverTable(m.servers, (s) => String(s.weight), 'Вес'),
			'',
			'- у каждого сервера есть текущий вес, в начале 0;',
			'- на каждый запрос к текущему весу каждого сервера прибавляется его вес; запрос получает сервер с наибольшим текущим весом (при равенстве — тот, что выше в таблице); затем текущий вес выбранного сервера уменьшается на сумму весов всех серверов.',
			'',
			`Приходят ${m.requests} запросов подряд. Каким серверам они достанутся? ${MIDDLE_FORMAT}`
		].join('\n');
	}
	if (m.kind === 'least-conn') {
		return [
			'Балансировщик выбирает сервер по наименьшему числу активных запросов с учётом веса (как `least_conn` в nginx):',
			'',
			...serverTable(m.servers, (s) => String(s.weight), 'Вес'),
			'',
			'- запрос, пришедший в момент t с длительностью d, активен с t до t + d; в момент t + d он уже завершён и не считается;',
			'- новый запрос получает сервер с наименьшим отношением «число активных запросов / вес»; при равенстве — тот, что выше в таблице;',
			'- запросы, пришедшие в один момент, распределяются по одному в порядке списка;',
			'- до первого запроса активных запросов нет ни на одном сервере; других запросов, кроме перечисленных, нет.',
			'',
			'Запросы (момент прихода, длительность — в секундах):',
			'',
			...m.requests.map((r, i) => `${i + 1}. t = ${r.t}, d = ${r.d}`),
			'',
			MIDDLE_FORMAT
		].join('\n');
	}
	if (m.kind === 'ip-hash') {
		return [
			'Балансировщик закрепляет клиентов за серверами по хешу адреса (как `ip_hash` в nginx, но с явной функцией):',
			'',
			...serverTable(m.servers, (s) => (s.down ? 'выведен (`down`)' : 'в работе'), 'Состояние'),
			'',
			`- номер сервера = (первый + второй + третий октет адреса клиента) mod ${m.servers.length}; серверы нумеруются с 0 в порядке таблицы, выведенные тоже;`,
			'- если сервер с этим номером выведен, запрос получает следующий по таблице сервер в работе (после последнего — снова первый).',
			'',
			'Запросы приходят от клиентов:',
			'',
			...m.clients.map((c, i) => `${i + 1}. \`${c.join('.')}\``),
			'',
			MIDDLE_FORMAT
		].join('\n');
	}
	return [
		`Балансировщик распределяет запросы по кругу (как upstream nginx с \`max_fails=${m.maxFails} fail_timeout=${m.failTimeout}s\`) между серверами в порядке таблицы:`,
		'',
		...serverTable(
			m.servers,
			(s) =>
				s.broken.length
					? s.broken.map(([a, b]) => `не отвечает с ${a} по ${b} с включительно`).join('; ')
					: 'отвечает всегда',
			'Поведение'
		),
		'',
		'- очередной попытке достаётся следующий по кругу сервер после того, кому досталась предыдущая попытка (первая попытка — первому серверу); выведенные из работы серверы пропускаются;',
		'- если сервер не ответил, попытка неудачна, и тот же запрос сразу пробуется на следующем по кругу сервере, который этот запрос ещё не пробовал; если таких нет, клиент получает ошибку `502`;',
		`- если после неудачной попытки в момент t число неудачных попыток сервера за последние ${m.failTimeout} с (в моменты больше t − ${m.failTimeout} и не больше t) достигло ${m.maxFails}, сервер выводится из работы до момента t + ${m.failTimeout}, в который он снова в работе; счётчик его неудач обнуляется.`,
		'',
		'Запросы приходят в моменты (в секундах):',
		'',
		...m.requests.map((t, i) => `${i + 1}. t = ${t}`),
		'',
		'Для каждого запроса введите по порядку, по одному в строке, серверы, на которые он попадал, через `>` без пробелов, например `bravo>delta` (если клиент получил ошибку — в конце `>502`).'
	].join('\n');
}

function describeSenior(s: Senior): string {
	const table = (nodes: readonly RingNode[]): string[] => [
		'| Узел | Точки на кольце |',
		'|---|---|',
		...nodes.map((n) => `| \`${n.name}\` | ${n.points.join(', ')} |`)
	];
	const removed = s.before.filter((n) => !s.after.some((a) => a.name === n.name));
	const added = s.after.filter((n) => !s.before.some((b) => b.name === n.name));
	const change = [
		...removed.map((n) => `узел \`${n.name}\` удаляется`),
		...added.map((n) => `добавляется узел \`${n.name}\` с точками ${n.points.join(', ')}`)
	].join(', и одновременно ');
	return [
		'Кэш распределяет ключи по узлам консистентным хешированием. Кольцо — позиции от 0 до 359; у каждого узла несколько виртуальных узлов — точек на кольце:',
		'',
		...table(s.before),
		'',
		'- хеш ключа `user:<n>` равен n mod 360;',
		'- ключ принадлежит узлу первой точки, позиция которой больше или равна хешу ключа (по часовой стрелке); если таких нет — узлу точки с наименьшей позицией (переход через 0).',
		'',
		`Изменение: ${change}.`,
		'',
		`Ключи: ${s.keys.map((k) => `\`user:${k}\``).join(', ')}.`,
		'',
		'Какие ключи сменят узел и куда переедут? Введите по одной строке на каждый переезжающий ключ — ключ и его новый узел через пробел, например `user:42 cache-a`, — в том порядке, в каком ключи перечислены; если ни один ключ не переедет — одну строку `-`.'
	].join('\n');
}

const PYTHON_MIDDLE = `import json
from fractions import Fraction

m = json.loads(input())
servers = m["servers"]
out = []
if m["kind"] == "smooth-weighted":
    cur = {s["name"]: 0 for s in servers}
    total = sum(s["weight"] for s in servers)
    for _ in range(m["requests"]):
        for s in servers:
            cur[s["name"]] += s["weight"]
        best = max(servers, key=lambda s: (cur[s["name"]], -servers.index(s)))
        cur[best["name"]] -= total
        out.append(best["name"])
elif m["kind"] == "least-conn":
    active = {s["name"]: [] for s in servers}
    for r in m["requests"]:
        def load(s):
            return Fraction(sum(1 for end in active[s["name"]] if end > r["t"]), s["weight"])
        best = min(servers, key=lambda s: (load(s), servers.index(s)))
        active[best["name"]].append(r["t"] + r["d"])
        out.append(best["name"])
elif m["kind"] == "ip-hash":
    n = len(servers)
    for c in m["clients"]:
        i = (c[0] + c[1] + c[2]) % n
        while servers[i]["down"]:
            i = (i + 1) % n
        out.append(servers[i]["name"])
else:
    n = len(servers)
    fails = [[] for _ in servers]
    back = [None] * n
    nxt = 0
    for t in m["requests"]:
        chain, tried = [], set()
        while True:
            order = [(nxt + k) % n for k in range(n)]
            ok = [i for i in order if i not in tried and (back[i] is None or t >= back[i])]
            if not ok:
                chain.append("502")
                break
            i = ok[0]
            nxt = (i + 1) % n
            tried.add(i)
            chain.append(servers[i]["name"])
            if not any(a <= t <= b for a, b in servers[i]["broken"]):
                break
            fails[i].append(t)
            if len([x for x in fails[i] if t - m["failTimeout"] < x <= t]) >= m["maxFails"]:
                back[i] = t + m["failTimeout"]
                fails[i] = []
        out.append(">".join(chain))
print("\\n".join(out))
`;

const PYTHON_SENIOR = `import bisect
import json

s = json.loads(input())


def ring(nodes):
    pts = sorted((p, n["name"]) for n in nodes for p in n["points"])
    return [p for p, _ in pts], [name for _, name in pts]


def owner(r, h):
    pos, names = r
    i = bisect.bisect_left(pos, h)
    return names[i] if i < len(pos) else names[0]


before, after = ring(s["before"]), ring(s["after"])
moved = []
for k in s["keys"]:
    h = k % 360
    if owner(before, h) != owner(after, h):
        moved.append("user:%d %s" % (k, owner(after, h)))
print("\\n".join(moved) if moved else "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'plain-weighted': { plainWeighted: true },
	'rr-ignores-weight': { rrIgnoresWeight: true },
	'count-total': { countTotal: true },
	'lc-ignores-weight': { lcIgnoresWeight: true },
	'finish-after-arrival': { finishAfterArrival: true },
	'all-four-octets': { allFourOctets: true },
	'down-ignored': { downIgnored: true },
	'down-mod-alive': { downModAlive: true },
	'no-retry': { noRetry: true },
	'fails-never-expire': { failsNeverExpire: true },
	'marked-forever': { markedForever: true },
	'counter-clockwise': { counterClockwise: true },
	'strict-greater': { strictGreater: true },
	'no-wrap': { noWrap: true },
	'mod-n': { modN: true },
	'to-next-in-list': { toNextInList: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/smooth-weighted': ['plain-weighted', 'rr-ignores-weight'],
	'middle/least-conn': ['count-total', 'lc-ignores-weight', 'finish-after-arrival'],
	'middle/ip-hash': ['all-four-octets', 'down-ignored', 'down-mod-alive'],
	'middle/passive-health': ['no-retry', 'fails-never-expire', 'marked-forever'],
	'senior/add-node': ['counter-clockwise', 'mod-n'],
	'senior/remove-node': ['to-next-in-list', 'counter-clockwise'],
	'senior/wraparound': ['no-wrap', 'strict-greater'],
	'senior/replace-weighted': ['to-next-in-list', 'mod-n']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class requires changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const middle = input.grade === 'middle' ? middleScenario(rng, input.classId) : null;
		const senior = middle ? null : seniorScenario(rng, input.classId);
		const solve = (rules: Rules): string[] =>
			middle ? solveMiddle(middle, rules) : solveSenior(senior as Senior, rules);
		const answer = solve(RIGHT);
		if (answer[0] === '-' || new Set(answer).size < (middle?.kind === 'ip-hash' ? 3 : 2)) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve({ ...RIGHT, ...change });
				return [id, same(value, answer) ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: middle ? describeMiddle(middle) : describeSenior(senior as Senior), code: null },
			answer: { kind: 'sequence', value: answer }
		});
		const reference = middle
			? { source: PYTHON_MIDDLE, stdin: JSON.stringify(middle) }
			: { source: PYTHON_SENIOR, stdin: JSON.stringify(senior) };
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
