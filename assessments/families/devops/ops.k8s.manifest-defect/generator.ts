// A Deployment with its Service (and, at the middle level, a ConfigMap and a sidecar) against a written
// specification: exactly one line breaks it — a selector that misses the pod labels, a port named nowhere, a probe on a
// port of another container, limits below requests in other units, a missing ConfigMap key or volume. The candidate
// names that line.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PY_YAML, renderYaml, type Scalar, type Yaml, type Marked } from '../../_lib/yaml.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

// ---- The scenario ----

type Labels = Record<string, string>;
type Resource = 'cpu' | 'memory';

interface Spec {
	name: string;
	replicas: number;
	labels: Labels;
	serviceSelector: Labels;
	servicePort: number;
	port: number;
	portName: string;
	readyPath: string;
	/** How the readiness probe names its port in the manifest. */
	readyByName: boolean;
	livePath: string | null;
	requests: Record<Resource, number>;
	limits: Record<Resource, number>;
	/** Texts of the quantities in the manifest. */
	texts: { requests: Record<Resource, string>; limits: Record<Resource, string> };
	config: { name: string; key: string; value: string; env: string } | null;
	volume: { name: string; mountPath: string } | null;
	sidecar: { name: string; port: number; portName: string } | null;
}

interface Layout {
	serviceFirst: boolean;
	configFirst: boolean;
	annotations: Labels;
	podAnnotations: Labels;
	env: { name: string; value: string }[];
	image: string;
	serviceLabels: Labels;
	serviceType: boolean;
	revisionHistoryLimit: number | null;
	strategy: boolean;
	/** Objects around the service that only shift the lines: a ServiceAccount, a PodDisruptionBudget, an autoscaler. */
	extras: { kind: 'ServiceAccount' | 'PodDisruptionBudget' | 'HorizontalPodAutoscaler'; at: number }[];
	/** Key order of the labels in each place they appear. */
	order: { template: string[]; selector: string[]; service: string[] };
}

const m = (id: string, v: Scalar): Marked => ({ $mark: id, v });

/** The manifest of a spec; `override` replaces the value of one marked line. */
function documents(spec: Spec, layout: Layout, override: { id: string; v: Scalar } | null): Yaml[] {
	const val = (id: string, v: Scalar): Marked => m(id, override?.id === id ? override.v : v);
	const marked = (prefix: string, labels: Labels, order: readonly string[]): { [key: string]: Yaml } =>
		Object.fromEntries(order.filter((k) => k in labels).map((k) => [k, val(`${prefix}:${k}`, labels[k] ?? '')]));
	const account = layout.extras.some((e) => e.kind === 'ServiceAccount');
	const probe = (path: string, port: Scalar, id: string): Yaml => ({
		httpGet: { path, port: val(id, port) },
		periodSeconds: 10
	});
	const app: { [key: string]: Yaml } = {
		name: spec.name,
		image: layout.image,
		ports: [{ name: val('port-name', spec.portName), containerPort: val('container-port', spec.port) }]
	};
	const env: Yaml[] = layout.env.map((e) => ({ name: e.name, value: e.value }));
	if (spec.config) {
		env.splice(Math.min(1, env.length), 0, {
			name: spec.config.env,
			valueFrom: {
				configMapKeyRef: {
					name: val('cm-ref-name', spec.config.name),
					key: val('cm-ref-key', spec.config.key)
				}
			}
		});
	}
	if (env.length) app.env = env;
	app.readinessProbe = probe(spec.readyPath, spec.readyByName ? spec.portName : spec.port, 'ready-port');
	if (spec.livePath) app.livenessProbe = probe(spec.livePath, spec.portName, 'live-port');
	app.resources = {
		requests: { cpu: val('req:cpu', spec.texts.requests.cpu), memory: val('req:memory', spec.texts.requests.memory) },
		limits: { cpu: val('lim:cpu', spec.texts.limits.cpu), memory: val('lim:memory', spec.texts.limits.memory) }
	};
	if (spec.volume)
		app.volumeMounts = [
			{ name: val('mount-name', spec.volume.name), mountPath: val('mount-path', spec.volume.mountPath) }
		];
	const containers: Yaml[] = [app];
	if (spec.sidecar) {
		containers.push({
			name: spec.sidecar.name,
			image: `registry.local/${spec.sidecar.name}:0.9`,
			ports: [{ name: val('sidecar-port-name', spec.sidecar.portName), containerPort: spec.sidecar.port }]
		});
	}
	const podSpec: { [key: string]: Yaml } = account ? { serviceAccountName: spec.name, containers } : { containers };
	if (spec.volume && spec.config)
		podSpec.volumes = [{ name: val('volume-name', spec.volume.name), configMap: { name: spec.config.name } }];
	const podMeta: { [key: string]: Yaml } = { labels: marked('tpl-label', spec.labels, layout.order.template) };
	if (Object.keys(layout.podAnnotations).length) podMeta.annotations = layout.podAnnotations;
	const deployMeta: { [key: string]: Yaml } = { name: spec.name };
	if (Object.keys(layout.annotations).length) deployMeta.annotations = layout.annotations;
	const deployment: Yaml = {
		apiVersion: 'apps/v1',
		kind: 'Deployment',
		metadata: deployMeta,
		spec: {
			replicas: spec.replicas,
			...(layout.revisionHistoryLimit === null ? {} : { revisionHistoryLimit: layout.revisionHistoryLimit }),
			...(layout.strategy
				? { strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } } }
				: {}),
			selector: { matchLabels: marked('dep-sel', spec.labels, layout.order.selector) },
			template: { metadata: podMeta, spec: podSpec }
		}
	};
	const service: Yaml = {
		apiVersion: 'v1',
		kind: 'Service',
		metadata: Object.keys(layout.serviceLabels).length
			? { name: spec.name, labels: layout.serviceLabels }
			: { name: spec.name },
		spec: {
			...(layout.serviceType ? { type: 'ClusterIP' } : {}),
			selector: marked('svc-sel', spec.serviceSelector, layout.order.service),
			ports: [{ port: val('svc-port', spec.servicePort), targetPort: val('target-port', spec.portName) }]
		}
	};
	const docs: Yaml[] = layout.serviceFirst ? [service, deployment] : [deployment, service];
	if (spec.config) {
		const configMap: Yaml = {
			apiVersion: 'v1',
			kind: 'ConfigMap',
			metadata: { name: spec.config.name },
			data: { [spec.config.key]: val('cm-data-key', spec.config.value), 'cache-ttl': '300s' }
		};
		if (layout.configFirst) docs.unshift(configMap);
		else docs.push(configMap);
	}
	for (const extra of layout.extras) {
		const meta = { name: spec.name };
		const doc: Yaml =
			extra.kind === 'ServiceAccount'
				? { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta }
				: extra.kind === 'PodDisruptionBudget'
					? {
							apiVersion: 'policy/v1',
							kind: 'PodDisruptionBudget',
							metadata: meta,
							spec: { maxUnavailable: 1, selector: { matchLabels: { app: spec.name } } }
						}
					: {
							apiVersion: 'autoscaling/v2',
							kind: 'HorizontalPodAutoscaler',
							metadata: meta,
							spec: {
								scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: spec.name },
								minReplicas: spec.replicas,
								maxReplicas: spec.replicas * 3
							}
						};
		docs.splice(Math.min(extra.at, docs.length), 0, doc);
	}
	return docs;
}

/** The defect line of a class: which marked value changes, to what, and the lines a misreading picks instead. */
interface Defect {
	id: string;
	v: Scalar;
	neighbour: string;
	decoy: string;
}

const NAMES = ['api', 'orders', 'catalog', 'billing', 'gateway', 'profile', 'search', 'notify'];
const TIERS = ['backend', 'frontend', 'worker'];
const PORT_NAMES = ['http', 'web', 'app'];

function typo(rng: Rng, value: string, taken: readonly string[]): string {
	for (;;) {
		const i = rng.int(0, value.length - 2);
		const variants = [
			`${value}s`,
			value.slice(0, -1),
			value.slice(0, i) + (value[i + 1] ?? '') + (value[i] ?? '') + value.slice(i + 2),
			`${value}-v2`
		];
		const v = rng.pick(variants);
		if (v !== value && v.length > 1 && !taken.includes(v)) return v;
	}
}

const cpuText = (mc: number, alt: boolean): string => ((mc % 1000 === 0) !== alt ? String(mc / 1000) : `${mc}m`);
/** Memory in Mi, written in Gi where it divides evenly (whole Gi, or halves too for the other spelling). */
const memoryText = (mi: number, alt: boolean): string => (mi % (alt ? 512 : 1024) === 0 ? `${mi / 1024}Gi` : `${mi}Mi`);

function drawSpec(rng: Rng, grade: string, classId: string): Spec {
	const name = rng.pick(NAMES);
	const labels: Labels = { app: name, tier: rng.pick(TIERS) };
	if (rng.bool(0.4)) labels.team = rng.pick(['core', 'growth', 'platform']);
	const requests = { cpu: rng.pick([100, 250, 500, 1000]), memory: rng.pick([128, 256, 512, 768, 1024]) };
	const limits = {
		cpu: requests.cpu * rng.pick([1, 2, 3]),
		memory: requests.memory * rng.pick([1, 2])
	};
	const middle = grade === 'middle';
	const spec: Spec = {
		name,
		replicas: rng.int(2, 5),
		labels,
		serviceSelector: rng.bool() ? { app: name } : { app: name, tier: labels.tier ?? 'backend' },
		servicePort: rng.pick([80, 8080, 443]),
		port: rng.pick([8080, 8000, 9000, 3000, 5000]),
		portName: rng.pick(PORT_NAMES),
		readyPath: rng.pick(['/ready', '/readyz', '/health/ready']),
		readyByName: classId === 'probe-port' ? rng.bool() : rng.bool(0.7),
		livePath: middle ? rng.pick(['/healthz', '/livez', '/health/live']) : null,
		requests,
		limits,
		texts: {
			requests: { cpu: cpuText(requests.cpu, rng.bool(0.3)), memory: memoryText(requests.memory, rng.bool(0.3)) },
			limits: { cpu: cpuText(limits.cpu, rng.bool(0.5)), memory: memoryText(limits.memory, rng.bool(0.5)) }
		},
		config: middle
			? {
					name: `${name}-config`,
					key: rng.pick(['log-level', 'feature-flags', 'db-pool-size', 'region']),
					value: rng.pick(['debug', 'on', '20', 'eu-1']),
					env: rng.pick(['LOG_LEVEL', 'APP_SETTING', 'TUNING'])
				}
			: null,
		volume: middle ? { name: rng.pick(['config', 'settings', 'app-conf']), mountPath: `/etc/${name}` } : null,
		sidecar: middle ? { name: 'exporter', port: rng.pick([9100, 9113, 9187]), portName: 'metrics' } : null
	};
	return spec;
}

function drawDefect(rng: Rng, spec: Spec, classId: string): Defect | null {
	const otherKey = (labels: Labels): string => rng.pick(Object.keys(labels));
	switch (classId) {
		case 'service-selector': {
			const k = otherKey(spec.serviceSelector);
			return {
				id: `svc-sel:${k}`,
				v: typo(rng, spec.serviceSelector[k] ?? '', Object.values(spec.labels)),
				neighbour: `tpl-label:${k}`,
				decoy: `dep-sel:${k}`
			};
		}
		case 'target-port':
			return {
				id: 'target-port',
				v: typo(rng, spec.portName, PORT_NAMES),
				neighbour: 'port-name',
				decoy: 'svc-port'
			};
		case 'deploy-selector': {
			const k = otherKey(spec.labels);
			return {
				id: `dep-sel:${k}`,
				v: typo(rng, spec.labels[k] ?? '', Object.values(spec.labels)),
				neighbour: `tpl-label:${k}`,
				decoy: k in spec.serviceSelector ? `svc-sel:${k}` : 'svc-sel:app'
			};
		}
		case 'probe-port':
			return spec.readyByName
				? { id: 'ready-port', v: typo(rng, spec.portName, PORT_NAMES), neighbour: 'port-name', decoy: 'target-port' }
				: {
						id: 'ready-port',
						v: spec.port + rng.pick([1, -1, 80, 1000]),
						neighbour: 'container-port',
						decoy: 'target-port'
					};
		case 'requests-limits': {
			const r: Resource = rng.pick(['cpu', 'memory']);
			const other: Resource = r === 'cpu' ? 'memory' : 'cpu';
			// The limit drops below the request; the other resource keeps a limit in other units than its request.
			const lower =
				r === 'cpu' ? rng.pick([0.5, 0.75]) * spec.requests.cpu : rng.pick([0.5, 0.75]) * spec.requests.memory;
			if (!Number.isInteger(lower) || lower < 64) return null;
			const text = r === 'cpu' ? cpuText(lower, spec.texts.requests.cpu.endsWith('m')) : memoryText(lower, rng.bool());
			if (spec.texts.limits[other] === spec.texts.requests[other]) return null;
			return { id: `lim:${r}`, v: text, neighbour: `req:${r}`, decoy: `lim:${other}` };
		}
		case 'configmap-key':
			return {
				id: 'cm-ref-key',
				v: typo(rng, spec.config?.key ?? '', ['cache-ttl']),
				neighbour: 'cm-data-key',
				decoy: 'cm-ref-name'
			};
		case 'probe-sidecar-port':
			return {
				id: 'live-port',
				v: spec.sidecar?.portName ?? 'metrics',
				neighbour: 'sidecar-port-name',
				decoy: 'ready-port'
			};
		default:
			return {
				id: 'mount-name',
				v: typo(rng, spec.volume?.name ?? '', []),
				neighbour: 'volume-name',
				decoy: 'mount-path'
			};
	}
}

const ANNOTATIONS: Labels = {
	'deployment.kubernetes.io/revision': '"4"',
	'team.example.com/owner': 'platform',
	'team.example.com/oncall': 'sre-duty',
	'example.com/docs': 'wiki/services'
};
const ENV = [
	{ name: 'TZ', value: 'UTC' },
	{ name: 'GOMAXPROCS', value: '"2"' },
	{ name: 'APP_ENV', value: 'production' },
	{ name: 'HTTP_TIMEOUT', value: '5s' },
	{ name: 'LOG_FORMAT', value: 'json' }
];

function drawLayout(rng: Rng, spec: Spec): Layout {
	const pick = (count: number): Labels =>
		Object.fromEntries(rng.sample(Object.entries(ANNOTATIONS), count).map(([k, v]) => [k, v.replaceAll('"', '')]));
	return {
		serviceFirst: rng.bool(),
		configFirst: rng.bool(),
		annotations: pick(rng.int(0, 3)),
		podAnnotations: rng.bool() ? { 'prometheus.io/scrape': 'true' } : {},
		env: rng.sample(ENV, rng.int(0, 4)).map((e) => ({ name: e.name, value: e.value.replaceAll('"', '') })),
		image: `registry.local/${spec.name}:${rng.int(1, 9)}.${rng.int(0, 20)}`,
		serviceLabels: rng.bool() ? Object.fromEntries(Object.entries(spec.labels).slice(0, rng.int(1, 2))) : {},
		serviceType: rng.bool(),
		revisionHistoryLimit: rng.bool() ? rng.int(3, 10) : null,
		strategy: rng.bool(),
		extras: rng
			.sample(['ServiceAccount', 'PodDisruptionBudget', 'HorizontalPodAutoscaler'] as const, rng.int(0, 2))
			.map((kind) => ({ kind, at: rng.int(0, 3) })),
		order: {
			template: rng.shuffle(Object.keys(spec.labels)),
			selector: rng.shuffle(Object.keys(spec.labels)),
			service: rng.shuffle(Object.keys(spec.serviceSelector))
		}
	};
}

// ---- The statement ----

const labelText = (labels: Labels): string =>
	Object.entries(labels)
		.map(([k, v]) => `\`${k}=${v}\``)
		.join(', ');
const cpuHuman = (mc: number): string => (mc % 1000 === 0 ? `${mc / 1000} CPU` : `${mc}m CPU`);

function specification(spec: Spec): string[] {
	const lines = [
		`- Deployment \`${spec.name}\` держит подов: ${spec.replicas}; метки подов — ${labelText(spec.labels)}, других меток нет.`,
		`- Контейнер \`${spec.name}\` слушает порт ${spec.port} под именем \`${spec.portName}\`; проба готовности — \`GET ${spec.readyPath}\` на этот порт${spec.livePath ? `; проба живости — \`GET ${spec.livePath}\` на этот же порт` : ''}.`,
		`- requests контейнера \`${spec.name}\` — ${cpuHuman(spec.requests.cpu)} и ${spec.requests.memory}Mi памяти; limits не меньше requests.`,
		`- Service \`${spec.name}\` слушает порт ${spec.servicePort}, выбирает поды по метк${Object.keys(spec.serviceSelector).length > 1 ? 'ам' : 'е'} ${labelText(spec.serviceSelector)} и направляет трафик в порт контейнера по имени \`${spec.portName}\`.`
	];
	if (spec.config)
		lines.push(
			`- Переменная окружения \`${spec.config.env}\` контейнера \`${spec.name}\` берётся из ключа \`${spec.config.key}\` ConfigMap \`${spec.config.name}\`.`
		);
	if (spec.volume && spec.config)
		lines.push(
			`- ConfigMap \`${spec.config.name}\` подключён к контейнеру \`${spec.name}\` томом \`${spec.volume.name}\` в каталог \`${spec.volume.mountPath}\`.`
		);
	if (spec.sidecar)
		lines.push(
			`- Контейнер-спутник \`${spec.sidecar.name}\` отдаёт метрики на порт ${spec.sidecar.port} под именем \`${spec.sidecar.portName}\`; проб у него нет.`
		);
	return lines;
}

function describe(spec: Spec): string {
	return [
		'Манифест ниже должен описывать сервис по спецификации:',
		'',
		...specification(spec),
		'',
		'Ровно одна строка манифеста нарушает спецификацию или ссылается на то, чего нет (порт, метку, ключ, том). Остальные строки правильные. Укажите номер этой строки (нумерация с 1, разделители `---` тоже считаются строками).'
	].join('\n');
}

// ---- The proof: an independent check of the shown manifest against the specification ----

const PYTHON_REFERENCE = `${PY_YAML}data = json.loads(sys.stdin.read())
spec = data["spec"]

def qty(resource, text):
    text = str(text)
    if resource == "cpu":
        return float(text[:-1]) if text.endswith("m") else float(text) * 1000
    return float(text[:-2]) * 1024 if text.endswith("Gi") else float(text[:-2])

def problems(text):
    out = []
    docs = {d["kind"]: d for d in parse_yaml(text)}
    dep, svc = docs["Deployment"], docs["Service"]
    if dep["spec"]["replicas"] != spec["replicas"]:
        out.append("replicas")
    tpl = dep["spec"]["template"]
    labels = tpl["metadata"]["labels"]
    if labels != spec["labels"]:
        out.append("pod labels")
    if any(labels.get(k) != v for k, v in dep["spec"]["selector"]["matchLabels"].items()):
        out.append("deployment selector")
    if svc["spec"]["selector"] != spec["serviceSelector"]:
        out.append("service selector")
    sp = svc["spec"]["ports"][0]
    if sp["port"] != spec["servicePort"] or sp["targetPort"] != spec["portName"]:
        out.append("service port")
    containers = {c["name"]: c for c in tpl["spec"]["containers"]}
    app = containers.get(spec["name"])
    if app is None:
        return out + ["no app container"]
    if not any(p.get("name") == spec["portName"] and p["containerPort"] == spec["port"] for p in app["ports"]):
        out.append("app port")
    for c in containers.values():
        names = {p.get("name"): p["containerPort"] for p in c.get("ports", [])}
        for kind in ("readinessProbe", "livenessProbe"):
            if kind not in c:
                continue
            port = c[kind]["httpGet"]["port"]
            number = names.get(port) if isinstance(port, str) else (port if port in names.values() else None)
            if number is None:
                out.append(kind + " port of " + c["name"])
            elif c is app and number != spec["port"]:
                out.append(kind + " targets another port")
    if app["readinessProbe"]["httpGet"]["path"] != spec["readyPath"]:
        out.append("readiness path")
    if spec["livePath"] is not None and app.get("livenessProbe", {}).get("httpGet", {}).get("path") != spec["livePath"]:
        out.append("liveness path")
    res = app["resources"]
    for r in ("cpu", "memory"):
        req = qty(r, res["requests"][r])
        if req != spec["requests"][r]:
            out.append("request " + r)
        if r in res.get("limits", {}) and qty(r, res["limits"][r]) < req:
            out.append("limit below request " + r)
    cfg = spec["config"]
    if cfg is not None:
        cm = docs.get("ConfigMap", {})
        refs = [e["valueFrom"]["configMapKeyRef"] for e in app.get("env", []) if e["name"] == cfg["env"] and "valueFrom" in e]
        if not refs or refs[0]["name"] != cfg["name"] or refs[0]["key"] != cfg["key"]:
            out.append("env reference")
        if cm.get("metadata", {}).get("name") != cfg["name"] or cfg["key"] not in cm.get("data", {}):
            out.append("config map key")
        for e in app.get("env", []):
            ref = e.get("valueFrom", {}).get("configMapKeyRef")
            if ref and (ref["name"] != cm.get("metadata", {}).get("name") or ref["key"] not in cm.get("data", {})):
                out.append("dangling key reference")
    vol = spec["volume"]
    if vol is not None:
        volumes = {v["name"]: v for v in tpl["spec"].get("volumes", [])}
        if vol["name"] not in volumes or volumes[vol["name"]]["configMap"]["name"] != cfg["name"]:
            out.append("volume")
        mounts = app.get("volumeMounts", [])
        if any(mt["name"] not in volumes for mt in mounts):
            out.append("dangling mount")
        if not any(mt["name"] == vol["name"] and mt["mountPath"] == vol["mountPath"] for mt in mounts):
            out.append("mount")
    side = spec["sidecar"]
    if side is not None:
        c = containers.get(side["name"])
        if c is None or not any(p.get("name") == side["portName"] and p["containerPort"] == side["port"] for p in c["ports"]):
            out.append("sidecar port")
    return out

lines = data["yaml"].split("\\n")
line = data["line"]
broken = problems(data["yaml"])
fixed_lines = list(lines)
fixed_lines[line - 1] = data["fix"]
left = problems("\\n".join(fixed_lines))
print(line if broken and not left else "no proof: broken=%s left=%s" % (broken, left))
`;

const specJson = (spec: Spec): object => ({
	name: spec.name,
	replicas: spec.replicas,
	labels: spec.labels,
	serviceSelector: spec.serviceSelector,
	servicePort: spec.servicePort,
	port: spec.port,
	portName: spec.portName,
	readyPath: spec.readyPath,
	livePath: spec.livePath,
	requests: spec.requests,
	config: spec.config,
	volume: spec.volume,
	sidecar: spec.sidecar
});

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 200; tries += 1) {
		const spec = drawSpec(rng, input.grade, input.classId);
		const defect = drawDefect(rng, spec, input.classId);
		if (!defect) continue;
		const layout = drawLayout(rng, spec);
		const good = renderYaml(documents(spec, layout, null));
		const bad = renderYaml(documents(spec, layout, { id: defect.id, v: defect.v }));
		const goodLines = good.text.split('\n');
		const badLines = bad.text.split('\n');
		const changed = badLines.flatMap((text, i) => (text === goodLines[i] ? [] : [i + 1]));
		const line = bad.marks.get(defect.id);
		const neighbour = bad.marks.get(defect.neighbour);
		const decoy = bad.marks.get(defect.decoy);
		if (changed.length !== 1 || changed[0] !== line || line === undefined) continue;
		if (neighbour === undefined || decoy === undefined || neighbour === line || decoy === line) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(spec), code: { language: 'yaml', source: bad.text } },
			answer: { kind: 'line_no', value: line }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ yaml: bad.text, line, fix: goodLines[line - 1], spec: specJson(spec) })
			}),
			wrong: () => ({
				'neighbour-line': { kind: 'answer', answer: { kind: 'line_no', value: neighbour } },
				'decoy-line': { kind: 'answer', answer: { kind: 'line_no', value: decoy } }
			})
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 200 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
