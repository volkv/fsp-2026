// Draining nodes under PodDisruptionBudgets: which evictions the budgets allow (minAvailable and maxUnavailable, by
// number and by percent rounded up, NotReady pods already spending the budget), the drain going in passes while the
// replacement pods are not ready yet, the replacements landing on nodes drained later, and where the drain gets stuck.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	readDescriptor,
	type GenerateInput,
	type ItemInstance
} from '../../_lib/family.ts';
import { PY_YAML, yamlText } from '../../_lib/yaml.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

// ---- The scenario ----

type Amount = number | `${number}%`;

interface App {
	name: string;
	replicas: number;
	budget: { kind: 'minAvailable' | 'maxUnavailable'; value: Amount } | null;
}

interface PodRow {
	name: string;
	app: string;
	node: string | null;
	ready: boolean;
}

interface Params {
	nodes: string[];
	apps: App[];
	pods: PodRow[];
	drain: string[];
}

interface Rules {
	countUnready: boolean;
	percentFloor: boolean;
	readyImmediately: boolean;
	stopOnRefusal: boolean;
	skipReplacements: boolean;
}

const RIGHT: Rules = {
	countUnready: false,
	percentFloor: false,
	readyImmediately: false,
	stopOnRefusal: false,
	skipReplacements: false
};

/** The fewest healthy pods a budget keeps. */
function desired(app: App, r: Rules): number {
	const b = app.budget;
	if (!b) return 0;
	const amount = (v: Amount): number => {
		if (typeof v === 'number') return v;
		const exact = Number.parseInt(v, 10) * app.replicas;
		return r.percentFloor ? Math.floor(exact / 100) : Math.ceil(exact / 100);
	};
	return b.kind === 'minAvailable' ? amount(b.value) : app.replicas - amount(b.value);
}

const ELSEWHERE = '(elsewhere)';

/** Pods by application name, then by number as a number: `api-2` before `api-10`. */
const podKey = (name: string): [string, number] => {
	const cut = name.lastIndexOf('-');
	return [name.slice(0, cut), Number(name.slice(cut + 1))];
};
const byName = (a: PodRow, b: PodRow): number => {
	const [appA, nA] = podKey(a.name);
	const [appB, nB] = podKey(b.name);
	return appA === appB ? nA - nB : appA < appB ? -1 : 1;
};

function drain(p: Params, r: Rules): string[] {
	const pods: PodRow[] = p.pods.map((x) => ({ ...x }));
	const next = new Map(p.apps.map((a) => [a.name, a.replicas + 1]));
	const cordoned = new Set<string>();
	const out: string[] = [];
	const place = (): string | null => {
		if (r.skipReplacements) return ELSEWHERE;
		const free = p.nodes.filter((n) => !cordoned.has(n));
		const count = (n: string): number => pods.filter((x) => x.node === n).length;
		return [...free].sort((a, b) => count(a) - count(b) || (a < b ? -1 : 1))[0] ?? null;
	};
	const allowed = (pod: PodRow): boolean => {
		const app = p.apps.find((a) => a.name === pod.app);
		if (!app?.budget) return true;
		const healthy = pods.filter((x) => x.app === pod.app && x.node !== null && (x.ready || r.countUnready)).length;
		return healthy - 1 >= desired(app, r);
	};
	for (const node of p.drain) {
		cordoned.add(node);
		for (;;) {
			const here = pods.filter((x) => x.node === node).sort(byName);
			if (here.length === 0) break;
			const created: PodRow[] = [];
			for (const pod of here) {
				if (!allowed(pod)) {
					if (r.stopOnRefusal) return [...out, node];
					continue;
				}
				pods.splice(pods.indexOf(pod), 1);
				out.push(pod.name);
				const index = next.get(pod.app) ?? 1;
				next.set(pod.app, index + 1);
				const target = place();
				const replacement: PodRow = {
					name: `${pod.app}-${index}`,
					app: pod.app,
					node: target,
					ready: r.readyImmediately && target !== null
				};
				pods.push(replacement);
				created.push(replacement);
			}
			for (const c of created) if (c.node !== null) c.ready = true;
			if (created.length === 0) return [...out, node];
		}
	}
	return [...out, 'done'];
}

// ---- Drawing ----

const APPS = ['api', 'cart', 'search', 'auth', 'billing', 'feed', 'media', 'mailer', 'ledger'];

function scenario(rng: Rng, classId: string): Params {
	const nodeCount = classId === 'replacements' ? 4 : rng.int(3, 4);
	const nodes = Array.from({ length: nodeCount }, (_, i) => `node-${i + 1}`);
	const drainCount = nodeCount === 4 ? (classId === 'replacements' ? 3 : rng.int(2, 3)) : 2;
	const drainOrder = rng.sample(nodes, drainCount);
	const kept = nodes.filter((n) => !drainOrder.includes(n));
	const apps: App[] = rng.sample(APPS, rng.int(2, 3)).map((name) => ({ name, replicas: rng.int(2, 5), budget: null }));
	const percent = classId === 'percent';
	for (const app of apps) {
		if (!percent && app !== apps[0] && rng.bool(0.15)) continue;
		const usePercent = percent ? rng.bool(0.85) : rng.bool(0.2);
		const min = rng.bool();
		app.budget = min
			? {
					kind: 'minAvailable',
					value: usePercent ? `${rng.pick([20, 25, 34, 50, 60, 67, 75, 80])}%` : rng.int(1, app.replicas - 1)
				}
			: {
					kind: 'maxUnavailable',
					value: usePercent ? `${rng.pick([10, 20, 25, 34, 40, 50])}%` : rng.int(1, 2)
				};
	}
	const pods: PodRow[] = [];
	for (const app of apps) {
		for (let i = 1; i <= app.replicas; i += 1) {
			const node = classId === 'passes' && i <= 2 && app === apps[0] ? (drainOrder[0] ?? 'node-1') : rng.pick(nodes);
			pods.push({ name: `${app.name}-${i}`, app: app.name, node, ready: true });
		}
	}
	if (classId === 'unready-budget' || rng.bool(0.15)) {
		const candidates = pods.filter((x) => x.node !== null && kept.includes(x.node));
		for (const pod of rng.sample(candidates, Math.min(candidates.length, rng.int(1, 2)))) pod.ready = false;
	}
	return { nodes, apps, pods, drain: drainOrder };
}

// ---- The statement ----

function manifest(p: Params): string {
	return yamlText(
		p.apps
			.filter((a) => a.budget)
			.map((a) => ({
				apiVersion: 'policy/v1',
				kind: 'PodDisruptionBudget',
				metadata: { name: `${a.name}-pdb` },
				spec: { [a.budget?.kind ?? 'minAvailable']: a.budget?.value ?? 0, selector: { matchLabels: { app: a.name } } }
			}))
	);
}

function describe(p: Params): string {
	const noBudget = p.apps.filter((a) => !a.budget).map((a) => `\`${a.name}\``);
	return [
		`В кластере узлы ${p.nodes.map((n) => `\`${n}\``).join(', ')}. Приложения — Deployment с числом реплик: ${p.apps.map((a) => `\`${a.name}\` — ${a.replicas}`).join(', ')}; поды приложения X помечены \`app=X\`. Для приложений действуют PodDisruptionBudget из манифеста ниже${noBudget.length ? ` (у ${noBudget.join(', ')} бюджета нет)` : ''}. Поды сейчас:`,
		'',
		'| Под | Узел | Ready |',
		'|---|---|---|',
		...p.pods.map((x) => `| \`${x.name}\` | \`${x.node ?? ''}\` | ${x.ready ? 'да' : 'нет'} |`),
		'',
		`Администратор сливает узлы по очереди: ${p.drain.map((n) => `\`${n}\``).join(', ')}. Модель слива:`,
		'',
		'- Слив узла: узел помечается недоступным для новых подов (cordon) и остаётся таким до конца. Затем идут проходы: в каждом проходе drain по очереди запрашивает вытеснение каждого пода, оставшегося на узле, — по имени приложения, а внутри приложения по номеру пода как числу (`api-2` раньше `api-10`). Запрос либо выполняется — под сразу удаляется, — либо отклоняется по PodDisruptionBudget, и под остаётся.',
		'- Вместо удалённого пода Deployment сразу создаёт новый под `<app>-<следующий номер>` (номера продолжают нумерацию приложения) и ставит его на узел без cordon с наименьшим числом подов, при равенстве — на первый по имени; если такого узла нет, под остаётся Pending. Новые поды становятся Ready в конце прохода, в котором созданы; Pending-поды не становятся Ready никогда.',
		'- Если на узле не осталось подов, он слит, и начинается слив следующего. Если за проход не удалось вытеснить ни одного пода, слив застревает, и дальше ничего не происходит.',
		'- Проценты в PodDisruptionBudget считаются от `replicas` Deployment и округляются вверх.',
		'',
		'Введите имена вытесненных подов в порядке вытеснения, по одному в строке, а последней строкой — `done`, если все узлы слиты, или имя узла, на котором слив застрял. Например:',
		'',
		'```\napi-2\ncart-1\nnode-3\n```'
	].join('\n');
}

// ---- The proof: an independent reading of the shown budgets ----

const PYTHON_REFERENCE = `${PY_YAML}import math

data = json.loads(sys.stdin.read())
budgets = {d["spec"]["selector"]["matchLabels"]["app"]: d["spec"] for d in parse_yaml(data["yaml"])} if data["yaml"] else {}
replicas = data["replicas"]
pods = [dict(p) for p in data["pods"]]
counter = {app: n + 1 for app, n in replicas.items()}
nodes = data["nodes"]
cordoned = set()
log = []

def floor_of(app):
    spec = budgets[app]
    n = replicas[app]
    def amount(v):
        if isinstance(v, str) and v.endswith("%"):
            return math.ceil(int(v[:-1]) * n / 100)
        return v
    if "minAvailable" in spec:
        return amount(spec["minAvailable"])
    return n - amount(spec["maxUnavailable"])

def may_evict(pod):
    app = pod["app"]
    if app not in budgets:
        return True
    healthy = sum(1 for x in pods if x["app"] == app and x["node"] is not None and x["ready"])
    return healthy - 1 >= floor_of(app)

def run():
    for node in data["drain"]:
        cordoned.add(node)
        while True:
            here = sorted((x for x in pods if x["node"] == node), key=lambda x: (x["name"].rsplit("-", 1)[0], int(x["name"].rsplit("-", 1)[1])))
            if not here:
                break
            fresh = []
            for pod in here:
                if not may_evict(pod):
                    continue
                pods.remove(pod)
                log.append(pod["name"])
                free = [n for n in nodes if n not in cordoned]
                free.sort(key=lambda n: (sum(1 for x in pods if x["node"] == n), n))
                new = {"name": "%s-%d" % (pod["app"], counter[pod["app"]]), "app": pod["app"],
                       "node": free[0] if free else None, "ready": False}
                counter[pod["app"]] += 1
                pods.append(new)
                fresh.append(new)
            for x in fresh:
                if x["node"] is not None:
                    x["ready"] = True
            if not fresh:
                return node
    return "done"

end = run()
print("\\n".join(log + [end]))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'count-unready': { countUnready: true },
	'percent-floor': { percentFloor: true },
	'ready-immediately': { readyImmediately: true },
	'stop-on-refusal': { stopOnRefusal: true },
	'skip-replacements': { skipReplacements: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/unready-budget': ['count-unready'],
	'senior/percent': ['percent-floor'],
	'senior/passes': ['ready-immediately', 'stop-on-refusal'],
	'senior/replacements': ['skip-replacements']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = drain(p, RIGHT);
		if (answer.length < 3) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = drain(p, { ...RIGHT, ...change });
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
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({
					yaml,
					replicas: Object.fromEntries(p.apps.map((a) => [a.name, a.replicas])),
					pods: p.pods,
					nodes: p.nodes,
					drain: p.drain
				})
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 400 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
