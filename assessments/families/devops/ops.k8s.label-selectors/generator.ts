// Label selectors: which pods a Service sends traffic to (equality selector, readiness, namespace, the labels of a
// Deployment's pods coming from its template), and which pods a set-based selector of a PodDisruptionBudget takes
// (`matchLabels` with `In`, `NotIn`, `Exists`, `DoesNotExist`). The candidate names the selected pods.
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
type Operator = 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';

interface Expr {
	key: string;
	operator: Operator;
	values: string[];
}

interface Pod {
	name: string;
	namespace: string;
	labels: Labels;
	ready: boolean;
	/** The `metadata.labels` of the Deployment that made the pod, when a Deployment did. */
	ownerLabels: Labels | null;
}

interface Deployment {
	name: string;
	namespace: string;
	replicas: number;
	labels: Labels;
	template: Labels;
}

interface Params {
	kind: 'Service' | 'PodDisruptionBudget';
	name: string;
	namespace: string;
	matchLabels: Labels;
	exprs: Expr[];
	pods: Pod[];
	/** Junior `template-labels`: the pods are those of these Deployments, not listed in a table. */
	deployments: Deployment[] | null;
}

interface Rules {
	anyLabel: boolean;
	exactLabels: boolean;
	ignoreReady: boolean;
	ignoreNamespace: boolean;
	deploymentLabels: boolean;
	notinRequiresKey: boolean;
	emptyAsAbsent: boolean;
	orSections: boolean;
}

const RIGHT: Rules = {
	anyLabel: false,
	exactLabels: false,
	ignoreReady: false,
	ignoreNamespace: false,
	deploymentLabels: false,
	notinRequiresKey: false,
	emptyAsAbsent: false,
	orSections: false
};

function select(p: Params, r: Rules): string[] {
	return p.pods
		.filter((pod) => {
			if (!r.ignoreNamespace && pod.namespace !== p.namespace) return false;
			if (p.kind === 'Service' && !r.ignoreReady && !pod.ready) return false;
			const labels = r.deploymentLabels && pod.ownerLabels ? pod.ownerLabels : pod.labels;
			const has = (key: string): boolean => key in labels && !(r.emptyAsAbsent && labels[key] === '');
			const pairs = Object.entries(p.matchLabels).map(([k, v]) => has(k) && labels[k] === v);
			let byLabels = r.anyLabel ? pairs.some(Boolean) : pairs.every(Boolean);
			if (r.exactLabels) byLabels &&= Object.keys(labels).length === pairs.length;
			const byExprs = p.exprs.every((e) => {
				switch (e.operator) {
					case 'In':
						return has(e.key) && e.values.includes(labels[e.key] ?? '');
					case 'NotIn':
						return has(e.key) ? !e.values.includes(labels[e.key] ?? '') : !r.notinRequiresKey;
					case 'Exists':
						return has(e.key);
					case 'DoesNotExist':
						return !has(e.key);
				}
			});
			if (p.exprs.length === 0) return byLabels;
			return r.orSections ? byLabels || byExprs : byLabels && byExprs;
		})
		.map((pod) => pod.name)
		.sort();
}

const APPS = ['api', 'web', 'worker', 'cart', 'orders', 'gateway', 'reports', 'notifier', 'search', 'billing'];
const NAMESPACES = ['shop', 'payments', 'catalog', 'auth', 'media', 'delivery', 'crm', 'analytics'];
const TIERS = ['frontend', 'backend', 'cache', 'queue'];
const ENVS = ['prod', 'stage'];
const EXTRAS: Record<string, string[]> = {
	version: ['v1', 'v2', 'v3'],
	team: ['core', 'growth', 'ops'],
	release: ['r17', 'r18', 'r19'],
	owner: ['alpha', 'beta', 'sre']
};
const TEAMS = EXTRAS.team ?? [];
const SUFFIX = 'bcdfghjklmnpqrstvwxz2456789';

function podName(rng: Rng, base: string, used: Set<string>): string {
	for (;;) {
		const name = `${base}-${Array.from({ length: 5 }, () => SUFFIX.charAt(rng.int(0, SUFFIX.length - 1))).join('')}`;
		if (!used.has(name)) {
			used.add(name);
			return name;
		}
	}
}

function extras(rng: Rng, count: number): Labels {
	const keys = rng.sample(Object.keys(EXTRAS), count);
	return Object.fromEntries(keys.map((k) => [k, rng.pick(EXTRAS[k] ?? [])]));
}

function juniorScenario(rng: Rng, classId: string): Params {
	const [app, otherApp] = rng.sample(APPS, 2) as [string, string];
	const [namespace, otherNamespace] = rng.sample(NAMESPACES, 2) as [string, string];
	const tier = rng.pick(TIERS);
	const matchLabels: Labels = rng.bool() ? { app, tier } : { app, tier, env: rng.pick(ENVS) };
	const keys = Object.keys(matchLabels);
	const used = new Set<string>();
	const pods: Pod[] = [];
	const add = (labels: Labels, ns = namespace, ready = true): void => {
		pods.push({ name: podName(rng, labels.app ?? app, used), namespace: ns, labels, ready, ownerLabels: null });
	};
	const full = (): Labels => ({ ...matchLabels, ...extras(rng, rng.int(1, 2)) });
	const partial = (): Labels => {
		const drop = rng.pick(keys.filter((k) => k !== 'app'));
		const labels = { ...matchLabels, ...extras(rng, rng.int(0, 1)) };
		Reflect.deleteProperty(labels, drop);
		return labels;
	};
	const otherValue = (): Labels => {
		const key = rng.pick(keys);
		const value = key === 'app' ? otherApp : key === 'tier' ? rng.pick(TIERS.filter((t) => t !== tier)) : 'dev';
		return { ...matchLabels, [key]: value, ...extras(rng, rng.int(0, 1)) };
	};
	if (classId === 'template-labels') {
		const names = rng.sample(['frontline', 'backbone', 'edge', 'core', 'relay', 'beacon', 'harbor', 'summit'], 3);
		const template = (labels: Labels): Labels => ({ ...labels, ...extras(rng, 1) });
		const shapes: { labels: Labels; template: Labels }[] = [
			// Its own labels look like the selector, its pods do not match.
			{ labels: { ...matchLabels }, template: template(otherValue()) },
			// Its own labels are unrelated, its pods match.
			{ labels: { team: rng.pick(TEAMS) }, template: template({ ...matchLabels }) },
			rng.bool()
				? { labels: { ...matchLabels }, template: template({ ...matchLabels }) }
				: { labels: { app: otherApp }, template: template({ app: otherApp, tier }) }
		];
		const deployments: Deployment[] = rng.shuffle(shapes).map((d, i) => ({
			name: names[i] ?? 'x',
			namespace,
			replicas: rng.int(1, 3),
			labels: d.labels,
			template: d.template
		}));
		for (const d of deployments) {
			for (let i = 1; i <= d.replicas; i += 1)
				pods.push({ name: `${d.name}-${i}`, namespace, labels: d.template, ready: true, ownerLabels: d.labels });
		}
		return { kind: 'Service', name: app, namespace, matchLabels, exprs: [], pods, deployments };
	}
	const fullCount = rng.int(2, 3);
	for (let i = 0; i < fullCount; i += 1) add(full(), namespace, classId !== 'readiness' || i > 0 || rng.bool(0.8));
	if (rng.bool(0.5)) add({ ...matchLabels });
	add(partial());
	add(otherValue());
	if (rng.bool()) add(rng.bool() ? partial() : otherValue());
	add({ app: otherApp, tier: rng.pick(TIERS), ...extras(rng, 1) });
	if (classId === 'readiness') {
		const count = rng.int(1, 2);
		for (let i = 0; i < count; i += 1) add(rng.bool() ? full() : { ...matchLabels }, namespace, false);
		if (rng.bool()) add(partial(), namespace, false);
	}
	if (classId === 'namespace') {
		const count = rng.int(1, 2);
		for (let i = 0; i < count; i += 1) add(full(), otherNamespace);
		if (rng.bool()) add(otherValue(), otherNamespace);
	}
	if (classId !== 'readiness') for (const pod of pods) pod.ready = pod.ready && rng.bool(0.9);
	return { kind: 'Service', name: app, namespace, matchLabels, exprs: [], pods: rng.shuffle(pods), deployments: null };
}

const EXPR_KEYS: Record<string, string[]> = {
	track: ['stable', 'canary', 'beta'],
	zone: ['a', 'b', 'c'],
	tier: ['frontend', 'backend', 'cache'],
	release: ['r1', 'r2', 'r3']
};

function middleScenario(rng: Rng, classId: string): Params {
	const [app, otherApp] = rng.sample(APPS, 2) as [string, string];
	const [namespace, otherNamespace] = rng.sample(NAMESPACES, 2) as [string, string];
	const keys = rng.sample(Object.keys(EXPR_KEYS), 3);
	const valuesOf = (key: string): string[] => EXPR_KEYS[key] ?? [];
	const someValues = (key: string): string[] => rng.sample(valuesOf(key), rng.int(1, 2)).sort();
	const operators: Operator[] =
		classId === 'notin-missing'
			? ['NotIn', rng.pick(['In', 'Exists'] as const)]
			: classId === 'empty-value'
				? [rng.pick(['Exists', 'DoesNotExist'] as const), rng.pick(['In', 'NotIn'] as const)]
				: classId === 'and-sections'
					? rng.shuffle(['In', rng.pick(['NotIn', 'Exists'] as const), rng.pick(['In', 'DoesNotExist'] as const)])
					: ['NotIn', rng.pick(['In', 'Exists', 'DoesNotExist'] as const)];
	const exprs: Expr[] = operators.map((operator, i) => {
		const key = keys[i] ?? 'zone';
		return { key, operator, values: operator === 'In' || operator === 'NotIn' ? someValues(key) : [] };
	});
	const emptyKey = classId === 'empty-value' ? (exprs[0]?.key ?? null) : null;
	const used = new Set<string>();
	const pods: Pod[] = [];
	const count = rng.int(8, 10);
	for (let i = 0; i < count; i += 1) {
		const ownApp = rng.bool(0.75);
		const labels: Labels = { app: ownApp ? app : otherApp };
		for (const key of keys) {
			const roll = rng.next();
			if (key === emptyKey && roll < 0.3) labels[key] = '';
			else if (roll < 0.7) labels[key] = rng.pick(valuesOf(key));
		}
		const foreign = classId === 'combined' ? i < 2 || rng.bool(0.1) : rng.bool(0.05);
		pods.push({
			name: podName(rng, labels.app ?? app, used),
			namespace: foreign ? otherNamespace : namespace,
			labels,
			ready: true,
			ownerLabels: null
		});
	}
	return {
		kind: 'PodDisruptionBudget',
		name: `${app}-pdb`,
		namespace,
		matchLabels: { app },
		exprs,
		pods: rng.shuffle(pods),
		deployments: null
	};
}

// ---- The statement ----

function manifest(p: Params): string {
	const docs: Yaml[] = [];
	if (p.kind === 'Service') {
		docs.push({
			apiVersion: 'v1',
			kind: 'Service',
			metadata: { name: p.name, namespace: p.namespace },
			spec: { selector: p.matchLabels, ports: [{ port: 80, targetPort: 8080 }] }
		});
	} else {
		const selector: { [key: string]: Yaml } = { matchLabels: p.matchLabels };
		selector.matchExpressions = p.exprs.map((e): Yaml =>
			e.values.length ? { key: e.key, operator: e.operator, values: e.values } : { key: e.key, operator: e.operator }
		);
		docs.push({
			apiVersion: 'policy/v1',
			kind: 'PodDisruptionBudget',
			metadata: { name: p.name, namespace: p.namespace },
			spec: { minAvailable: 1, selector }
		});
	}
	for (const d of p.deployments ?? []) {
		docs.push({
			apiVersion: 'apps/v1',
			kind: 'Deployment',
			metadata: { name: d.name, namespace: d.namespace, labels: d.labels },
			spec: {
				replicas: d.replicas,
				selector: { matchLabels: d.template },
				template: {
					metadata: { labels: d.template },
					spec: {
						containers: [{ name: 'app', image: `registry.local/${d.name}:1.4`, ports: [{ containerPort: 8080 }] }]
					}
				}
			}
		});
	}
	return yamlText(docs);
}

const labelText = (labels: Labels): string =>
	Object.entries(labels)
		.map(([k, v]) => `\`${k}=${v === '' ? '""' : v}\``)
		.join(', ');

function describe(p: Params): string {
	const answer =
		'Введите имена подов по одному в строке, в любом порядке; если таких нет — одна строка `-`. Например:\n\n```\nweb-x7k2p\nweb-q4m9t\n```';
	if (p.deployments) {
		return [
			`Манифест ниже применён в пустой namespace \`${p.namespace}\`. Каждый Deployment создаёт столько подов, сколько указано в \`replicas\`; поды Deployment \`<имя>\` называются \`<имя>-1\`, \`<имя>-2\`, … Все поды запущены и находятся в состоянии Ready, других подов в кластере нет.`,
			'',
			`На какие поды Service \`${p.name}\` будет направлять трафик (какие попадут в его endpoints)?`,
			'',
			answer
		].join('\n');
	}
	const service = p.kind === 'Service';
	const table = [
		service ? '| Под | Namespace | Метки | Ready |' : '| Под | Namespace | Метки |',
		service ? '|---|---|---|---|' : '|---|---|---|',
		...p.pods.map(
			(pod) =>
				`| \`${pod.name}\` | \`${pod.namespace}\` | ${labelText(pod.labels)} |${service ? ` ${pod.ready ? 'да' : 'нет'} |` : ''}`
		)
	];
	return [
		service
			? `В кластере запущены поды из таблицы. В namespace \`${p.namespace}\` применён Service из манифеста ниже.`
			: `В кластере запущены поды из таблицы (метка с пустым значением записана как \`ключ=""\`; ключа, которого нет в строке пода, у пода нет). В namespace \`${p.namespace}\` применён PodDisruptionBudget из манифеста ниже.`,
		'',
		...table,
		'',
		service
			? `На какие поды Service \`${p.name}\` будет направлять трафик (какие попадут в его endpoints)?`
			: `Какие поды выбирает селектор PodDisruptionBudget \`${p.name}\` (их бюджет и будет учитывать)?`,
		'',
		answer
	].join('\n');
}

// ---- The proof: an independent reading of the shown manifest ----

const PYTHON_REFERENCE = `${PY_YAML}data = json.loads(sys.stdin.read())
docs = parse_yaml(data["yaml"])
target = next(d for d in docs if d["kind"] in ("Service", "PodDisruptionBudget"))
ns = target["metadata"]["namespace"]
if data["pods"] is None:
    pods = []
    for d in docs:
        if d["kind"] == "Deployment":
            labels = d["spec"]["template"]["metadata"]["labels"]
            for i in range(1, d["spec"]["replicas"] + 1):
                pods.append({"name": d["metadata"]["name"] + "-" + str(i), "namespace": d["metadata"]["namespace"], "labels": labels, "ready": True})
else:
    pods = data["pods"]

def matches(labels):
    if target["kind"] == "Service":
        return all(labels.get(k) == v for k, v in target["spec"]["selector"].items())
    sel = target["spec"]["selector"]
    if any(labels.get(k) != v for k, v in sel.get("matchLabels", {}).items()):
        return False
    for e in sel.get("matchExpressions", []):
        op, key = e["operator"], e["key"]
        if op == "In" and not (key in labels and labels[key] in e["values"]):
            return False
        if op == "NotIn" and key in labels and labels[key] in e["values"]:
            return False
        if op == "Exists" and key not in labels:
            return False
        if op == "DoesNotExist" and key in labels:
            return False
    return True

chosen = sorted(p["name"] for p in pods
                if p["namespace"] == ns and matches(p["labels"]) and (p["ready"] or target["kind"] != "Service"))
print("\\n".join(chosen) if chosen else "-")
`;

const WRONG: Record<string, Partial<Rules>> = {
	'any-label': { anyLabel: true },
	'exact-labels': { exactLabels: true },
	'ignore-ready': { ignoreReady: true },
	'ignore-namespace': { ignoreNamespace: true },
	'deployment-labels': { deploymentLabels: true },
	'notin-requires-key': { notinRequiresKey: true },
	'empty-as-absent': { emptyAsAbsent: true },
	'or-sections': { orSections: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/subset': ['any-label', 'exact-labels'],
	'junior/readiness': ['ignore-ready'],
	'junior/namespace': ['ignore-namespace'],
	'junior/template-labels': ['deployment-labels'],
	'middle/notin-missing': ['notin-requires-key'],
	'middle/empty-value': ['empty-as-absent'],
	'middle/and-sections': ['or-sections'],
	'middle/combined': ['notin-requires-key', 'ignore-namespace']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 300; tries += 1) {
		const p = input.grade === 'junior' ? juniorScenario(rng, input.classId) : middleScenario(rng, input.classId);
		const answer = select(p, RIGHT);
		const least = input.grade === 'middle' ? 2 : 1;
		if (answer.length < least || answer.length > p.pods.length - 2) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = select(p, { ...RIGHT, ...change });
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
		const pods = p.deployments
			? null
			: p.pods.map((pod) => ({ name: pod.name, namespace: pod.namespace, labels: pod.labels, ready: pod.ready }));
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify({ yaml, pods }) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null
							? null
							: {
									kind: 'answer' as const,
									answer: { kind: 'set' as const, value: value.length ? value : ['-'] }
								}
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
