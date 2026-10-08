// Quality of service classes of pods: Guaranteed, Burstable or BestEffort from the requests and limits of every
// container (defaults from limits, quantities in different units); at the middle level, which pods a node under memory
// pressure evicts, in order, by the rule the statement gives, and where it stops.
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

type Resource = 'cpu' | 'memory';

interface Quantity {
	value: number;
	text: string;
}

interface Container {
	name: string;
	requests: Partial<Record<Resource, Quantity>>;
	limits: Partial<Record<Resource, Quantity>>;
}

interface Pod {
	name: string;
	containers: Container[];
	/** Middle: memory the pod uses, Mi. */
	usage: number;
}

interface Params {
	grade: string;
	pods: Pod[];
	/** Middle: eviction goes on while the pods use more than this, Mi. */
	threshold: number;
}

type Qos = 'Guaranteed' | 'Burstable' | 'BestEffort';

interface Rules {
	limitsDefault: boolean;
	firstOnly: boolean;
	cpuOnly: boolean;
	stringCompare: boolean;
	excessByUsage: boolean;
	largestFirst: boolean;
	noThreshold: boolean;
}

const RIGHT: Rules = {
	limitsDefault: true,
	firstOnly: false,
	cpuOnly: false,
	stringCompare: false,
	excessByUsage: false,
	largestFirst: false,
	noThreshold: false
};

const RESOURCES: readonly Resource[] = ['cpu', 'memory'];

const containersOf = (pod: Pod, r: Rules): Container[] => (r.firstOnly ? pod.containers.slice(0, 1) : pod.containers);

/** The request of a resource after defaulting: an explicit request, else the limit. */
function request(c: Container, resource: Resource, r: Rules): Quantity | null {
	return c.requests[resource] ?? (r.limitsDefault ? (c.limits[resource] ?? null) : null);
}

function qos(pod: Pod, r: Rules): Qos {
	const containers = containersOf(pod, r);
	const empty = (c: Container): boolean =>
		RESOURCES.every((res) => c.requests[res] === undefined && c.limits[res] === undefined);
	if (containers.every(empty)) return 'BestEffort';
	const checked: readonly Resource[] = r.cpuOnly ? ['cpu'] : RESOURCES;
	const guaranteed = containers.every((c) =>
		checked.every((res) => {
			const limit = c.limits[res];
			const req = request(c, res, r);
			if (!limit || !req) return false;
			return r.stringCompare ? req.text === limit.text : req.value === limit.value;
		})
	);
	return guaranteed ? 'Guaranteed' : 'Burstable';
}

const memoryRequest = (pod: Pod, r: Rules): number =>
	containersOf(pod, r).reduce((sum, c) => sum + (request(c, 'memory', r)?.value ?? 0), 0);

/** The order in which a node under memory pressure picks pods to evict. */
function evictionQueue(p: Params, r: Rules): Pod[] {
	const byUsage = (a: Pod, b: Pod): number => b.usage - a.usage || (a.name < b.name ? -1 : 1);
	if (r.largestFirst) return [...p.pods].sort(byUsage);
	const group = (pod: Pod): number => {
		const cls = qos(pod, r);
		if (cls === 'BestEffort') return 0;
		if (cls === 'Guaranteed') return 3;
		return pod.usage > memoryRequest(pod, r) ? 1 : 2;
	};
	const excess = (pod: Pod): number => pod.usage - memoryRequest(pod, r);
	return [...p.pods].sort((a, b) => {
		const ga = group(a);
		const gb = group(b);
		if (ga !== gb) return ga - gb;
		if (ga === 1 && !r.excessByUsage) return excess(b) - excess(a) || (a.name < b.name ? -1 : 1);
		return byUsage(a, b);
	});
}

function evicted(p: Params, r: Rules): string[] {
	const queue = evictionQueue(p, r);
	let total = p.pods.reduce((sum, pod) => sum + pod.usage, 0);
	const out: string[] = [];
	for (const pod of queue) {
		const eager =
			r.noThreshold &&
			(qos(pod, r) === 'BestEffort' || (qos(pod, r) === 'Burstable' && pod.usage > memoryRequest(pod, r)));
		if (total <= p.threshold && !eager) break;
		out.push(pod.name);
		total -= pod.usage;
	}
	return out;
}

function answerOf(p: Params, r: Rules): string[] {
	return p.grade === 'junior' ? p.pods.map((pod) => qos(pod, r)) : evicted(p, r);
}

// ---- Drawing pods ----

const CPU = [100, 200, 250, 300, 500, 750, 1000, 1500, 2000];
const MEMORY = [128, 256, 384, 512, 768, 1024, 1536, 2048];
const MEMORY_ALT = [512, 1024, 1536, 2048];

/** CPU in millicores, written as cores for whole cores and as millicores otherwise — or the other way round. */
const cpu = (m: number, alt = false): Quantity => ({
	value: m,
	text: (m % 1000 === 0) !== alt ? String(m / 1000) : `${m}m`
});
function memory(mi: number, alt = false): Quantity {
	if (!alt) return { value: mi, text: mi % 1024 === 0 ? `${mi / 1024}Gi` : `${mi}Mi` };
	return { value: mi, text: mi % 1024 === 0 ? `${mi}Mi` : `${mi / 1024}Gi` };
}

type Kind =
	| 'none'
	| 'guaranteed'
	| 'limits'
	| 'burst'
	| 'requests'
	| 'memory-limit'
	| 'cpu-equal-memory-lower'
	| 'cpu-equal-no-memory'
	| 'guaranteed-units';

const NAMES = ['app', 'proxy', 'agent', 'exporter', 'worker', 'sidecar'];

function container(rng: Rng, kind: Kind, name: string): Container {
	const c = rng.pick(CPU);
	const m = rng.pick(MEMORY);
	const higher = (values: readonly number[], v: number): number =>
		rng.pick(values.filter((x) => x > v).concat([v * 2]));
	switch (kind) {
		case 'none':
			return { name, requests: {}, limits: {} };
		case 'guaranteed':
			return { name, requests: { cpu: cpu(c), memory: memory(m) }, limits: { cpu: cpu(c), memory: memory(m) } };
		case 'limits':
			return { name, requests: {}, limits: { cpu: cpu(c), memory: memory(m) } };
		case 'burst':
			return {
				name,
				requests: { cpu: cpu(c), memory: memory(m) },
				limits: { cpu: cpu(higher(CPU, c)), memory: memory(higher(MEMORY, m)) }
			};
		case 'requests':
			return { name, requests: { cpu: cpu(c), memory: memory(m) }, limits: {} };
		case 'memory-limit':
			return { name, requests: {}, limits: { memory: memory(m) } };
		case 'cpu-equal-memory-lower':
			return {
				name,
				requests: { cpu: cpu(c), memory: memory(m) },
				limits: { cpu: cpu(c), memory: memory(higher(MEMORY, m)) }
			};
		case 'cpu-equal-no-memory':
			return { name, requests: { cpu: cpu(c) }, limits: { cpu: cpu(c) } };
		case 'guaranteed-units': {
			const mm = rng.pick(MEMORY_ALT);
			const altRequest = rng.bool();
			return {
				name,
				requests: { cpu: cpu(c, altRequest), memory: memory(mm, rng.bool() ? altRequest : !altRequest) },
				limits: { cpu: cpu(c, !altRequest), memory: memory(mm, rng.bool()) }
			};
		}
	}
}

/** Container kinds of each pod for a class: one or more pods carry the trap of the class. */
function podKinds(rng: Rng, grade: string, classId: string): Kind[] {
	const plain: Kind[] = ['none', 'guaranteed', 'burst', 'requests', 'memory-limit'];
	const trap: Record<string, Kind[]> = {
		'limits-only': ['limits', 'limits'],
		memory: ['cpu-equal-memory-lower', 'cpu-equal-no-memory'],
		units: ['guaranteed-units', 'guaranteed-units'],
		'multi-container': [],
		'excess-order': ['burst', 'requests'],
		threshold: ['none', 'burst']
	};
	const pool = [...plain, ...(trap[classId] ?? [])];
	const multi = classId === 'multi-container';
	const kinds: Kind[] = [];
	const first = rng.pick(trap[classId]?.length ? (trap[classId] ?? plain) : plain);
	kinds.push(first);
	if (multi || rng.bool(grade === 'junior' ? 0.25 : 0.2)) {
		const more = multi && grade === 'junior' ? rng.int(1, 2) : 1;
		for (let i = 0; i < more; i += 1) kinds.push(rng.pick(pool));
	}
	return kinds;
}

const POD_BASES = ['api', 'web', 'cart', 'search', 'billing', 'auth', 'reports', 'feed', 'media', 'mailer'];
const SUFFIX = 'bcdfghjklmnpqrstvwxz2456789';

function scenario(rng: Rng, grade: string, classId: string): Params {
	const count = grade === 'junior' ? rng.int(5, 6) : rng.int(6, 7);
	const bases = rng.sample(POD_BASES, count);
	const traps = grade === 'junior' ? rng.int(1, 2) : 2;
	const pods: Pod[] = bases.map((base, i) => {
		const kinds = podKinds(rng, grade, i < traps || rng.bool(0.2) ? classId : 'plain');
		const names = rng.sample(NAMES.slice(1), kinds.length);
		const containers = kinds.map((kind, j) => container(rng, kind, j === 0 ? 'app' : (names[j] ?? 'agent')));
		const suffix = Array.from({ length: 5 }, () => SUFFIX.charAt(rng.int(0, SUFFIX.length - 1))).join('');
		return { name: grade === 'junior' ? base : `${base}-${suffix}`, containers, usage: 0 };
	});
	const p: Params = { grade, pods: rng.shuffle(pods), threshold: 0 };
	if (grade === 'junior') return p;
	for (const pod of p.pods) {
		const cls = qos(pod, RIGHT);
		const req = memoryRequest(pod, RIGHT);
		const limited = pod.containers.every((c) => c.limits.memory);
		const limit = pod.containers.reduce((sum, c) => sum + (c.limits.memory?.value ?? 0), 0);
		if (cls === 'BestEffort' || req === 0) pod.usage = rng.int(60, 900);
		else if (cls === 'Guaranteed') pod.usage = rng.int(Math.ceil(req * 0.3), req);
		else pod.usage = Math.min(limited ? limit : Infinity, rng.int(Math.ceil(req * 0.4), Math.floor(req * 1.8)));
	}
	// The threshold makes the right rule stop after 2–4 evictions.
	const queue = evictionQueue(p, RIGHT);
	const total = p.pods.reduce((sum, pod) => sum + pod.usage, 0);
	const k = rng.int(2, Math.min(4, queue.length - 1));
	const cum = (n: number): number => queue.slice(0, n).reduce((sum, pod) => sum + pod.usage, 0);
	p.threshold = rng.int(total - cum(k), total - cum(k - 1) - 1);
	return p;
}

// ---- The statement ----

function manifest(p: Params): string {
	return yamlText(
		p.pods.map((pod) => ({
			apiVersion: 'v1',
			kind: 'Pod',
			metadata: { name: pod.name },
			spec: {
				containers: pod.containers.map((c) => {
					const entry: { [key: string]: Yaml } = { name: c.name, image: `registry.local/${c.name}:2.1` };
					const resources: { [key: string]: Yaml } = {};
					const section = (q: Partial<Record<Resource, Quantity>>): { [key: string]: Yaml } =>
						Object.fromEntries(RESOURCES.filter((res) => q[res]).map((res) => [res, q[res]?.text ?? '']));
					if (Object.keys(c.requests).length) resources.requests = section(c.requests);
					if (Object.keys(c.limits).length) resources.limits = section(c.limits);
					if (Object.keys(resources).length) entry.resources = resources;
					return entry;
				})
			}
		}))
	);
}

function describe(p: Params): string {
	if (p.grade === 'junior') {
		return [
			'Поды из манифеста ниже созданы в кластере (init-контейнеров у них нет; в namespace нет LimitRange и других механизмов, подставляющих ресурсы).',
			'',
			'Какой класс QoS (`status.qosClass`) получит каждый под? Введите классы в порядке подов в манифесте, по одному в строке: `Guaranteed`, `Burstable` или `BestEffort`. Например:',
			'',
			'```\nBurstable\nGuaranteed\nBurstable\nBestEffort\nBurstable\n```'
		].join('\n');
	}
	return [
		'Поды из манифеста ниже (init-контейнеров у них нет; в namespace нет LimitRange и других механизмов, подставляющих ресурсы) работают на одном узле. Сейчас они используют память так:',
		'',
		'| Под | Использование памяти, Mi |',
		'|---|---|',
		...p.pods.map((pod) => `| \`${pod.name}\` | ${pod.usage} |`),
		'',
		`Узлу не хватает памяти: kubelet вытесняет поды по одному, пока суммарное использование памяти подами больше ${p.threshold} Mi. Вытесненный под сразу освобождает всю свою память. Очередь вытеснения:`,
		'',
		'1. поды класса QoS BestEffort — по убыванию использования памяти;',
		'2. поды класса Burstable, у которых использование больше request памяти пода (суммы request памяти его контейнеров; у контейнера без `requests.memory`, но с `limits.memory` request равен limit — так его подставляет API-сервер; если не задано ни то, ни другое, request — ноль), — по убыванию разницы «использование − request»;',
		'3. остальные поды Burstable — по убыванию использования;',
		'4. поды класса Guaranteed — по убыванию использования.',
		'',
		'При равенстве раньше идёт под с меньшим по алфавиту именем.',
		'',
		'Введите имена вытесненных подов в порядке вытеснения, по одному в строке. Например:',
		'',
		'```\nweb-x7k2p\napi-q4m9t\n```'
	].join('\n');
}

// ---- The proof: an independent reading of the shown manifest ----

const PYTHON_REFERENCE = `${PY_YAML}data = json.loads(sys.stdin.read())
docs = parse_yaml(data["yaml"])

def qty(resource, text):
    text = str(text)
    if resource == "cpu":
        return round(float(text[:-1])) if text.endswith("m") else round(float(text) * 1000)
    if text.endswith("Gi"):
        return round(float(text[:-2]) * 1024)
    return round(float(text[:-2]))

def resources(c):
    res = c.get("resources", {})
    req = {k: qty(k, v) for k, v in res.get("requests", {}).items()}
    lim = {k: qty(k, v) for k, v in res.get("limits", {}).items()}
    for k, v in lim.items():
        req.setdefault(k, v)
    return req, lim

def qos_class(pod):
    cs = [resources(c) for c in pod["spec"]["containers"]]
    if all(not req and not lim for req, lim in cs):
        return "BestEffort"
    if all(all(k in lim and req.get(k) == lim[k] for k in ("cpu", "memory")) for req, lim in cs):
        return "Guaranteed"
    return "Burstable"

if data["usage"] is None:
    for d in docs:
        print(qos_class(d))
else:
    rows = []
    for d in docs:
        name = d["metadata"]["name"]
        use = data["usage"][name]
        cls = qos_class(d)
        req = sum(resources(c)[0].get("memory", 0) for c in d["spec"]["containers"])
        if cls == "BestEffort":
            key = (0, -use)
        elif cls == "Guaranteed":
            key = (3, -use)
        elif use > req:
            key = (1, -(use - req))
        else:
            key = (2, -use)
        rows.append((key, name, use))
    rows.sort()
    total = sum(r[2] for r in rows)
    for key, name, use in rows:
        if total <= data["threshold"]:
            break
        print(name)
        total -= use
`;

const WRONG: Record<string, Partial<Rules>> = {
	'limits-only-burstable': { limitsDefault: false },
	'first-container': { firstOnly: true },
	'cpu-only': { cpuOnly: true },
	'string-compare': { stringCompare: true },
	'excess-by-usage': { excessByUsage: true },
	'largest-first': { largestFirst: true },
	'no-threshold': { noThreshold: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/limits-only': ['limits-only-burstable'],
	'junior/multi-container': ['first-container'],
	'junior/memory': ['cpu-only'],
	'junior/units': ['string-compare'],
	'middle/limits-only': ['limits-only-burstable'],
	'middle/excess-order': ['excess-by-usage'],
	'middle/multi-container': ['first-container'],
	'middle/threshold': ['no-threshold', 'largest-first']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 300; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = answerOf(p, RIGHT);
		if (input.grade === 'junior' && new Set(answer).size < 2) continue;
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
			answer: { kind: 'sequence', value: answer }
		});
		const usage = p.grade === 'junior' ? null : Object.fromEntries(p.pods.map((pod) => [pod.name, pod.usage]));
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ yaml, usage, threshold: p.threshold })
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'sequence' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
