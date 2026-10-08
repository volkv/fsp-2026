// Scheduling pods one by one: requests against what is left of a node's allocatable, nodeSelector, taints and
// tolerations; at the middle level, required and preferred node affinity and pod anti-affinity by hostname, with the
// choice among the fitting nodes given by an explicit score. The candidate names the node of every pod or `Pending`.
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
type Effect = 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
type Operator = 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';

interface Taint {
	key: string;
	value: string;
	effect: Effect;
}

interface Toleration {
	key: string;
	operator: 'Equal' | 'Exists';
	value: string | null;
	effect: Effect | null;
}

interface Expr {
	key: string;
	operator: Operator;
	values: string[];
}

interface Node {
	name: string;
	cpu: number;
	memory: number;
	usedCpu: number;
	usedMemory: number;
	labels: Labels;
	taints: Taint[];
	/** Labels of the pods already running there (middle). */
	pods: Labels[];
}

interface Pod {
	name: string;
	labels: Labels;
	cpu: number;
	memory: number;
	nodeSelector: Labels;
	tolerations: Toleration[];
	required: Expr[][] | null;
	preferred: { weight: number; exprs: Expr[] }[];
	antiRequired: Labels | null;
	antiPreferred: { weight: number; labels: Labels }[];
}

interface Params {
	grade: string;
	nodes: Node[];
	pods: Pod[];
}

interface Rules {
	noAccumulate: boolean;
	cpuOnly: boolean;
	ignoreTaints: boolean;
	equalKeyOnly: boolean;
	ignoreEffect: boolean;
	preferBlocks: boolean;
	selectorAny: boolean;
	termsAnd: boolean;
	notinRequiresKey: boolean;
	ignorePreferred: boolean;
	antiExistingOnly: boolean;
	ignorePreferredAnti: boolean;
}

const RIGHT: Rules = {
	noAccumulate: false,
	cpuOnly: false,
	ignoreTaints: false,
	equalKeyOnly: false,
	ignoreEffect: false,
	preferBlocks: false,
	selectorAny: false,
	termsAnd: false,
	notinRequiresKey: false,
	ignorePreferred: false,
	antiExistingOnly: false,
	ignorePreferredAnti: false
};

const matchesLabels = (labels: Labels, selector: Labels): boolean =>
	Object.entries(selector).every(([k, v]) => labels[k] === v);

function exprHolds(labels: Labels, e: Expr, r: Rules): boolean {
	const has = e.key in labels;
	switch (e.operator) {
		case 'In':
			return has && e.values.includes(labels[e.key] ?? '');
		case 'NotIn':
			return has ? !e.values.includes(labels[e.key] ?? '') : !r.notinRequiresKey;
		case 'Exists':
			return has;
		case 'DoesNotExist':
			return !has;
	}
}

function tolerates(t: Toleration, taint: Taint, r: Rules): boolean {
	if (t.key !== taint.key) return false;
	if (!r.ignoreEffect && t.effect !== null && t.effect !== taint.effect) return false;
	return t.operator === 'Exists' || r.equalKeyOnly || t.value === taint.value;
}

interface Placed {
	labels: Labels;
	fresh: boolean;
}

function schedule(p: Params, r: Rules): string[] {
	const nodes = p.nodes.map((n) => ({
		...n,
		placed: n.pods.map((labels): Placed => ({ labels, fresh: false }))
	}));
	const out: string[] = [];
	for (const pod of p.pods) {
		const fits = nodes.filter((n) => {
			if (pod.cpu > n.cpu - n.usedCpu) return false;
			if (!r.cpuOnly && pod.memory > n.memory - n.usedMemory) return false;
			const pairs = Object.entries(pod.nodeSelector).map(([k, v]) => n.labels[k] === v);
			if (pairs.length && !(r.selectorAny ? pairs.some(Boolean) : pairs.every(Boolean))) return false;
			if (!r.ignoreTaints) {
				for (const taint of n.taints) {
					if (taint.effect === 'PreferNoSchedule' && !r.preferBlocks) continue;
					if (!pod.tolerations.some((t) => tolerates(t, taint, r))) return false;
				}
			}
			if (pod.required) {
				const term = (exprs: Expr[]): boolean => exprs.every((e) => exprHolds(n.labels, e, r));
				if (!(r.termsAnd ? pod.required.every(term) : pod.required.some(term))) return false;
			}
			const others = n.placed.filter((x) => !(r.antiExistingOnly && x.fresh));
			if (pod.antiRequired && others.some((x) => matchesLabels(x.labels, pod.antiRequired ?? {}))) return false;
			return true;
		});
		if (fits.length === 0) {
			out.push('Pending');
			continue;
		}
		const score = (n: (typeof nodes)[number]): number => {
			let s = 0;
			if (!r.ignorePreferred)
				for (const term of pod.preferred) if (term.exprs.every((e) => exprHolds(n.labels, e, r))) s += term.weight;
			if (!r.ignorePreferredAnti)
				for (const term of pod.antiPreferred)
					if (n.placed.some((x) => matchesLabels(x.labels, term.labels))) s -= term.weight;
			return s;
		};
		const best = [...fits].sort(
			(a, b) =>
				score(b) - score(a) ||
				b.cpu - b.usedCpu - (a.cpu - a.usedCpu) ||
				b.memory - b.usedMemory - (a.memory - a.usedMemory) ||
				(a.name < b.name ? -1 : 1)
		)[0];
		if (!best) throw new Error('no best node');
		out.push(best.name);
		if (!r.noAccumulate) {
			best.usedCpu += pod.cpu;
			best.usedMemory += pod.memory;
		}
		best.placed.push({ labels: pod.labels, fresh: true });
	}
	return out;
}

// ---- Drawing ----

const NODE_NAMES = ['node-a', 'node-b', 'node-c', 'node-d'];
const POD_CPU = [250, 500, 750, 1000, 1500, 2000];
const POD_MEMORY = [256, 512, 768, 1024, 1536, 2048, 3072];
const APPS = [
	'api',
	'web',
	'cart',
	'search',
	'billing',
	'auth',
	'reports',
	'feed',
	'media',
	'mailer',
	'ingest',
	'ledger'
];
const TAINT_KEYS: Record<string, string[]> = {
	dedicated: ['db', 'ml', 'batch'],
	gpu: ['true', 'a100'],
	team: ['payments', 'search']
};

function basePod(rng: Rng, name: string, app: string): Pod {
	return {
		name,
		labels: { app },
		cpu: rng.pick(POD_CPU),
		memory: rng.pick(POD_MEMORY),
		nodeSelector: {},
		tolerations: [],
		required: null,
		preferred: [],
		antiRequired: null,
		antiPreferred: []
	};
}

function juniorScenario(rng: Rng, classId: string): Params {
	const nodes: Node[] = NODE_NAMES.slice(0, 3).map((name) => {
		const cpu = rng.pick([2000, 4000, 4000, 8000]);
		const memory = rng.pick([4096, 8192, 8192, 16384]);
		return {
			name,
			cpu,
			memory,
			usedCpu: rng.int(0, Math.floor(cpu / 250) - 2) * 250,
			usedMemory: rng.int(0, Math.floor(memory / 256) - 4) * 256,
			labels: { disktype: rng.pick(['ssd', 'hdd']), zone: rng.pick(['a', 'b', 'c']) },
			taints: [],
			pods: []
		};
	});
	const apps = rng.sample(APPS, 5);
	const count = rng.int(4, 5);
	const pods = apps.slice(0, count).map((app) => basePod(rng, app, app));
	if (classId === 'memory-bound') {
		for (const n of nodes) n.usedMemory = Math.max(n.usedMemory, n.memory - rng.pick([1024, 1536, 2048, 3072]));
		for (const pod of pods) {
			pod.cpu = rng.pick([250, 500]);
			if (rng.bool(0.6)) pod.memory = rng.pick([1536, 2048, 3072]);
		}
	}
	if (classId === 'resources') {
		for (const n of nodes) n.usedCpu = Math.max(n.usedCpu, n.cpu - rng.pick([1000, 1500, 2000, 2500]));
	}
	if (classId === 'taints') {
		const tainted = rng.sample(nodes, 2);
		const keys = rng.sample(Object.keys(TAINT_KEYS), 2);
		tainted.forEach((n, i) => {
			const key = keys[i] ?? 'dedicated';
			n.taints.push({
				key,
				value: rng.pick(TAINT_KEYS[key] ?? []),
				effect: i === 1 && rng.bool(0.3) ? 'PreferNoSchedule' : 'NoSchedule'
			});
		});
		for (const pod of pods) {
			if (!rng.bool(0.7)) continue;
			const taint = rng.pick(tainted.flatMap((n) => n.taints));
			const values = TAINT_KEYS[taint.key] ?? [];
			const kind = rng.int(0, 3);
			pod.tolerations.push(
				kind === 0
					? { key: taint.key, operator: 'Exists', value: null, effect: rng.bool() ? taint.effect : null }
					: kind === 1
						? { key: taint.key, operator: 'Equal', value: taint.value, effect: taint.effect }
						: kind === 2
							? {
									key: taint.key,
									operator: 'Equal',
									value: rng.pick(values.filter((v) => v !== taint.value)),
									effect: taint.effect
								}
							: { key: taint.key, operator: 'Equal', value: taint.value, effect: 'NoExecute' }
			);
		}
	}
	if (classId === 'node-selector') {
		for (const pod of pods) {
			if (!rng.bool(0.7)) continue;
			pod.nodeSelector = rng.bool(0.7)
				? { disktype: rng.pick(['ssd', 'hdd']), zone: rng.pick(['a', 'b', 'c']) }
				: { disktype: rng.pick(['ssd', 'hdd']) };
		}
	}
	return { grade: 'junior', nodes, pods };
}

const ZONES = ['a', 'b', 'c'];
const POOLS = ['general', 'compute', 'storage'];

function middleScenario(rng: Rng, classId: string): Params {
	const nodes: Node[] = NODE_NAMES.map((name) => {
		const cpu = rng.pick([4000, 8000]);
		const memory = rng.pick([8192, 16384]);
		const labels: Labels = { zone: rng.pick(ZONES) };
		if (rng.bool(0.75)) labels.pool = rng.pick(POOLS);
		if (rng.bool(0.5)) labels.disktype = 'ssd';
		return {
			name,
			cpu,
			memory,
			usedCpu: rng.int(0, Math.floor(cpu / 250) - 6) * 250,
			usedMemory: rng.int(0, Math.floor(memory / 512) - 4) * 512,
			labels,
			taints: [],
			pods: []
		};
	});
	const apps = rng.sample(APPS, 3);
	const app = apps[0] ?? 'api';
	const count = rng.int(4, 5);
	const pods: Pod[] = [];
	const expr = (): Expr => {
		const key = rng.pick(['zone', 'pool', 'disktype']);
		const values = key === 'zone' ? ZONES : key === 'pool' ? POOLS : ['ssd'];
		const operator: Operator = rng.pick(
			key === 'disktype' ? (['Exists', 'DoesNotExist'] as const) : (['In', 'NotIn', 'NotIn'] as const)
		);
		return {
			key,
			operator,
			values: operator === 'In' || operator === 'NotIn' ? rng.sample(values, rng.int(1, 2)).sort() : []
		};
	};
	for (let i = 0; i < count; i += 1) {
		const replica = classId === 'anti-affinity' || classId === 'preferred-anti';
		const own = replica ? app : (apps[1 + (i % 2)] ?? 'web');
		const pod = basePod(rng, `${own}-${i + 1}`, own);
		pod.cpu = rng.pick([500, 750, 1000, 1500]);
		pod.memory = rng.pick([512, 1024, 1536, 2048]);
		if (classId === 'required-affinity') {
			pod.required = rng.bool(0.7) ? [[expr(), expr()], [expr()]] : [[expr()], [expr()]];
		}
		if (classId === 'preferred-weights' || classId === 'preferred-anti') {
			const terms = classId === 'preferred-anti' ? 1 : rng.int(1, 2);
			for (let t = 0; t < terms; t += 1) pod.preferred.push({ weight: rng.int(1, 10) * 10, exprs: [expr()] });
		}
		if (classId === 'anti-affinity') pod.antiRequired = { app };
		if (classId === 'preferred-anti') pod.antiPreferred = [{ weight: rng.int(1, 10) * 10, labels: { app } }];
		pods.push(pod);
	}
	// Running pods: some of the replicated app, some of others.
	for (const n of nodes) {
		if (rng.bool(0.35)) n.pods.push({ app });
		if (rng.bool(0.4)) n.pods.push({ app: apps[2] ?? 'web' });
	}
	return { grade: 'middle', nodes, pods };
}

// ---- The statement ----

const cpuText = (m: number): string => (m % 1000 === 0 ? String(m / 1000) : `${m}m`);
const memoryText = (mi: number): string => (mi % 1024 === 0 ? `${mi / 1024}Gi` : `${mi}Mi`);
const exprYaml = (e: Expr): Yaml =>
	e.values.length ? { key: e.key, operator: e.operator, values: e.values } : { key: e.key, operator: e.operator };

function manifest(p: Params): string {
	return yamlText(
		p.pods.map((pod) => {
			const spec: { [key: string]: Yaml } = {};
			if (Object.keys(pod.nodeSelector).length) spec.nodeSelector = pod.nodeSelector;
			if (pod.tolerations.length)
				spec.tolerations = pod.tolerations.map((t) => {
					const entry: { [key: string]: Yaml } = { key: t.key, operator: t.operator };
					if (t.value !== null) entry.value = t.value;
					if (t.effect !== null) entry.effect = t.effect;
					return entry;
				});
			const affinity: { [key: string]: Yaml } = {};
			if (pod.required || pod.preferred.length) {
				const nodeAffinity: { [key: string]: Yaml } = {};
				if (pod.required)
					nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution = {
						nodeSelectorTerms: pod.required.map((term) => ({ matchExpressions: term.map(exprYaml) }))
					};
				if (pod.preferred.length)
					nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution = pod.preferred.map((t) => ({
						weight: t.weight,
						preference: { matchExpressions: t.exprs.map(exprYaml) }
					}));
				affinity.nodeAffinity = nodeAffinity;
			}
			if (pod.antiRequired || pod.antiPreferred.length) {
				const anti: { [key: string]: Yaml } = {};
				if (pod.antiRequired)
					anti.requiredDuringSchedulingIgnoredDuringExecution = [
						{ labelSelector: { matchLabels: pod.antiRequired }, topologyKey: 'kubernetes.io/hostname' }
					];
				if (pod.antiPreferred.length)
					anti.preferredDuringSchedulingIgnoredDuringExecution = pod.antiPreferred.map((t) => ({
						weight: t.weight,
						podAffinityTerm: { labelSelector: { matchLabels: t.labels }, topologyKey: 'kubernetes.io/hostname' }
					}));
				affinity.podAntiAffinity = anti;
			}
			if (Object.keys(affinity).length) spec.affinity = affinity;
			spec.containers = [
				{
					name: 'app',
					image: `registry.local/${pod.labels.app ?? 'app'}:3.2`,
					resources: { requests: { cpu: cpuText(pod.cpu), memory: memoryText(pod.memory) } }
				}
			];
			return { apiVersion: 'v1', kind: 'Pod', metadata: { name: pod.name, labels: pod.labels }, spec };
		})
	);
}

const labelText = (labels: Labels): string =>
	Object.keys(labels).length
		? Object.entries(labels)
				.map(([k, v]) => `\`${k}=${v}\``)
				.join(', ')
		: '—';

function describe(p: Params): string {
	const middle = p.grade === 'middle';
	const table = [
		`| Узел | Allocatable CPU, m | Allocatable память, Mi | Запрошено CPU, m | Запрошено память, Mi | Метки | Taints |${middle ? ' Запущенные поды (метки) |' : ''}`,
		`|---|---|---|---|---|---|---|${middle ? '---|' : ''}`,
		...p.nodes.map(
			(n) =>
				`| \`${n.name}\` | ${n.cpu} | ${n.memory} | ${n.usedCpu} | ${n.usedMemory} | ${labelText(n.labels)} | ${
					n.taints.length ? n.taints.map((t) => `\`${t.key}=${t.value}:${t.effect}\``).join(', ') : '—'
				} |${middle ? ` ${n.pods.length ? n.pods.map(labelText).join('; ') : '—'} |` : ''}`
		)
	];
	const choice = middle
		? [
				'Из узлов, на которые под можно поместить, планировщик выбирает узел с наибольшей оценкой. Оценка узла — сумма весов тех preferred-условий nodeAffinity пода, которым узел удовлетворяет, минус сумма весов тех preferred-условий podAntiAffinity пода, для которых на узле уже есть хотя бы один под, подходящий под их `labelSelector`. При равной оценке выбирается узел с наибольшим свободным CPU (allocatable минус сумма requests CPU подов на узле), затем — с наибольшей свободной памятью, затем — первый по имени.',
				'',
				'У уже запущенных подов своих правил affinity нет; их requests входят в колонку «Запрошено». Все поды — запущенные и новые — в одном namespace. У каждого узла, кроме меток из таблицы, есть метка `kubernetes.io/hostname`, равная имени узла: каждый узел — отдельный домен топологии.'
			]
		: [
				'Из узлов, на которые под можно поместить, планировщик выбирает узел с наибольшим свободным CPU (allocatable минус сумма requests CPU подов на узле), при равенстве — с наибольшей свободной памятью, затем — первый по имени.'
			];
	return [
		`В кластере ${middle ? 'четыре узла' : 'три узла'}:`,
		'',
		...table,
		'',
		'Колонка «Запрошено» — сумма requests подов, уже работающих на узле. Поды из манифеста ниже создаются по одному, в порядке манифеста; каждый следующий — после того, как планировщик один раз попытался разместить предыдущий: под назначен на узел или остался Pending. Pending-под больше не планируется, ресурсов не занимает и очередь не задерживает.',
		'',
		...choice,
		'',
		'На какой узел попадёт каждый под? Введите для каждого пода в порядке манифеста имя узла или `Pending`, если под не поместится никуда, — по одному в строке. Например:',
		'',
		'```\nnode-b\nPending\nnode-a\nnode-b\n```'
	].join('\n');
}

// ---- The proof: an independent reading of the shown manifest ----

const PYTHON_REFERENCE = `${PY_YAML}data = json.loads(sys.stdin.read())
pods = parse_yaml(data["yaml"])
nodes = data["nodes"]

def qty(resource, text):
    text = str(text)
    if resource == "cpu":
        return int(text[:-1]) if text.endswith("m") else round(float(text) * 1000)
    return round(float(text[:-2]) * 1024) if text.endswith("Gi") else int(text[:-2])

def expr_ok(labels, e):
    op, key = e["operator"], e["key"]
    if op == "In":
        return key in labels and labels[key] in e["values"]
    if op == "NotIn":
        return not (key in labels and labels[key] in e["values"])
    if op == "Exists":
        return key in labels
    return key not in labels

def selected(labels, sel):
    return all(labels.get(k) == v for k, v in sel["matchLabels"].items())

for n in nodes:
    n["running"] = list(n["pods"])

for pod in pods:
    spec = pod["spec"]
    req = spec["containers"][0]["resources"]["requests"]
    cpu, mem = qty("cpu", req["cpu"]), qty("memory", req["memory"])
    aff = spec.get("affinity", {})
    na = aff.get("nodeAffinity", {})
    pa = aff.get("podAntiAffinity", {})
    good = []
    for n in nodes:
        if cpu > n["cpu"] - n["usedCpu"] or mem > n["memory"] - n["usedMemory"]:
            continue
        if any(n["labels"].get(k) != v for k, v in spec.get("nodeSelector", {}).items()):
            continue
        blocked = False
        for t in n["taints"]:
            if t["effect"] == "PreferNoSchedule":
                continue
            ok = False
            for tol in spec.get("tolerations", []):
                if tol["key"] != t["key"] or tol.get("effect", t["effect"]) != t["effect"]:
                    continue
                if tol["operator"] == "Exists" or tol.get("value") == t["value"]:
                    ok = True
            blocked = blocked or not ok
        if blocked:
            continue
        hard = na.get("requiredDuringSchedulingIgnoredDuringExecution")
        if hard and not any(all(expr_ok(n["labels"], e) for e in term["matchExpressions"]) for term in hard["nodeSelectorTerms"]):
            continue
        if any(any(selected(x, term["labelSelector"]) for x in n["running"])
               for term in pa.get("requiredDuringSchedulingIgnoredDuringExecution", [])):
            continue
        score = 0
        for term in na.get("preferredDuringSchedulingIgnoredDuringExecution", []):
            if all(expr_ok(n["labels"], e) for e in term["preference"]["matchExpressions"]):
                score += term["weight"]
        for term in pa.get("preferredDuringSchedulingIgnoredDuringExecution", []):
            if any(selected(x, term["podAffinityTerm"]["labelSelector"]) for x in n["running"]):
                score -= term["weight"]
        good.append(((-score, -(n["cpu"] - n["usedCpu"]), -(n["memory"] - n["usedMemory"]), n["name"]), n))
    if not good:
        print("Pending")
        continue
    good.sort(key=lambda g: g[0])
    best = good[0][1]
    print(best["name"])
    best["usedCpu"] += cpu
    best["usedMemory"] += mem
    best["running"].append(pod["metadata"]["labels"])
`;

const WRONG: Record<string, Partial<Rules>> = {
	'no-accumulate': { noAccumulate: true },
	'cpu-only': { cpuOnly: true },
	'ignore-taints': { ignoreTaints: true },
	'equal-key-only': { equalKeyOnly: true },
	'ignore-effect': { ignoreEffect: true },
	'prefer-blocks': { preferBlocks: true },
	'selector-any': { selectorAny: true },
	'terms-and': { termsAnd: true },
	'notin-requires-key': { notinRequiresKey: true },
	'ignore-preferred': { ignorePreferred: true },
	'anti-existing-only': { antiExistingOnly: true },
	'ignore-preferred-anti': { ignorePreferredAnti: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/resources': ['no-accumulate'],
	'junior/taints': ['ignore-taints', 'equal-key-only'],
	'junior/node-selector': ['selector-any'],
	'junior/memory-bound': ['cpu-only'],
	'middle/required-affinity': ['terms-and', 'notin-requires-key'],
	'middle/preferred-weights': ['ignore-preferred'],
	'middle/anti-affinity': ['anti-existing-only'],
	'middle/preferred-anti': ['ignore-preferred-anti']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = input.grade === 'junior' ? juniorScenario(rng, input.classId) : middleScenario(rng, input.classId);
		const answer = schedule(p, RIGHT);
		if (new Set(answer).size < 2) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = schedule(p, { ...RIGHT, ...change });
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
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify({ yaml, nodes: p.nodes }) }),
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
