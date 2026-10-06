// Rolling updates of a Deployment: how many pods may exist and must stay available while it rolls (maxSurge rounded
// up, maxUnavailable rounded down, the defaults, Recreate), and at the middle level the timeline of a rollout under an
// explicit model of the controller — waves, minReadySeconds, and a stall caught by progressDeadlineSeconds.
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

type IntOrPercent = number | `${number}%`;

interface Deployment {
	name: string;
	replicas: number;
	/** `null` — no `strategy` in the manifest; `rolling-bare` — RollingUpdate without parameters. */
	strategy: 'Recreate' | 'RollingUpdate' | 'rolling-bare' | null;
	surge: IntOrPercent;
	unavailable: IntOrPercent;
}

interface Params {
	grade: string;
	deployments: Deployment[];
	/** Middle: seconds after creation when the i-th new pod becomes Ready; `null` — never. */
	readyAfter: (number | null)[];
	minReady: number;
	deadline: number;
}

interface Rules {
	surgeFloor: boolean;
	unavailableCeil: boolean;
	roundNearest: boolean;
	defaultOne: boolean;
	recreateAsRolling: boolean;
	ignoreMinReady: boolean;
	deadlineFromStart: boolean;
}

const RIGHT: Rules = {
	surgeFloor: false,
	unavailableCeil: false,
	roundNearest: false,
	defaultOne: false,
	recreateAsRolling: false,
	ignoreMinReady: false,
	deadlineFromStart: false
};

function scaled(value: IntOrPercent, replicas: number, up: boolean, r: Rules): number {
	if (typeof value === 'number') return value;
	const exact = (Number.parseInt(value, 10) * replicas) / 100;
	if (r.roundNearest) return Math.round(exact);
	return up ? Math.ceil(exact) : Math.floor(exact);
}

/** maxSurge and maxUnavailable as numbers of pods; both 0 after rounding — one pod may be unavailable. */
function fenceposts(d: Deployment, r: Rules): { surge: number; unavailable: number } {
	const defaulted = d.strategy === null || d.strategy === 'rolling-bare';
	const surgeValue: IntOrPercent = defaulted ? (r.defaultOne ? 1 : '25%') : d.surge;
	const unavailableValue: IntOrPercent = defaulted ? (r.defaultOne ? 1 : '25%') : d.unavailable;
	const surge = scaled(surgeValue, d.replicas, !r.surgeFloor, r);
	const unavailable = scaled(unavailableValue, d.replicas, r.unavailableCeil, r);
	return { surge, unavailable: surge === 0 && unavailable === 0 ? 1 : unavailable };
}

function bounds(d: Deployment, r: Rules): string {
	if (d.strategy === 'Recreate' && !r.recreateAsRolling) return `${d.replicas} 0`;
	const f = fenceposts(d.strategy === 'Recreate' ? { ...d, strategy: null } : d, r);
	return `${d.replicas + f.surge} ${d.replicas - f.unavailable}`;
}

interface NewPod {
	created: number;
	ready: number | null;
	available: number | null;
}

/** The rollout under the model of the statement; `null` when an event falls exactly on the deadline. */
function rollout(p: Params, r: Rules): string | null {
	const d = p.deployments[0];
	if (!d) throw new Error('no deployment');
	const n = d.replicas;
	const { surge, unavailable } = fenceposts(d, r);
	let old = n;
	const pods: NewPod[] = [];
	let progress = 0;
	const availableAt = (t: number): number => pods.filter((x) => x.available !== null && x.available <= t).length;
	const act = (t: number): void => {
		for (let changed = true; changed;) {
			changed = false;
			while (old + pods.length < n + surge && pods.length < n) {
				const after = p.readyAfter[pods.length] ?? null;
				const ready = after === null ? null : t + after;
				pods.push({
					created: t,
					ready,
					available: ready === null ? null : ready + (r.ignoreMinReady ? 0 : p.minReady)
				});
				progress = t;
				changed = true;
			}
			while (old > 0 && old - 1 + availableAt(t) >= n - unavailable) {
				old -= 1;
				progress = t;
				changed = true;
			}
		}
	};
	act(0);
	for (let t = 0; ;) {
		if (old === 0 && availableAt(t) === n) return `done ${t} 0 ${n}`;
		const limit = (r.deadlineFromStart ? 0 : progress) + p.deadline;
		const next = Math.min(
			...pods.flatMap((x) => [x.ready, x.available]).filter((v): v is number => v !== null && v > t)
		);
		if (next === limit) return null;
		if (next > limit) return `stuck ${limit} ${old} ${availableAt(limit)}`;
		t = next;
		progress = t;
		if (pods.some((x) => x.available === t)) act(t);
	}
}

function answerOf(p: Params, r: Rules): string | null {
	return p.grade === 'junior' ? p.deployments.map((d) => bounds(d, r)).join(' ') : rollout(p, r);
}

// ---- Drawing ----

const NAMES = ['api', 'web', 'cart', 'search', 'billing', 'auth', 'reports', 'feed', 'media', 'mailer'];
const PERCENTS = [10, 20, 25, 30, 40, 50, 60, 75];

const percent = (rng: Rng): `${number}%` => `${rng.pick(PERCENTS)}%`;
function juniorDeployment(rng: Rng, kind: string, name: string): Deployment {
	const replicas = rng.int(3, 24);
	switch (kind) {
		case 'percent':
			return { name, replicas, strategy: 'RollingUpdate', surge: percent(rng), unavailable: percent(rng) };
		case 'defaults':
			return {
				name,
				replicas: rng.int(5, 30),
				strategy: rng.bool() ? null : 'rolling-bare',
				surge: 0,
				unavailable: 0
			};
		case 'mixed':
			return rng.bool()
				? { name, replicas, strategy: 'RollingUpdate', surge: rng.int(1, 3), unavailable: percent(rng) }
				: { name, replicas, strategy: 'RollingUpdate', surge: percent(rng), unavailable: rng.int(0, 2) };
		case 'recreate':
			return { name, replicas: rng.int(2, 30), strategy: 'Recreate', surge: 0, unavailable: 0 };
		default:
			return { name, replicas, strategy: 'RollingUpdate', surge: rng.int(0, 3), unavailable: rng.int(1, 3) };
	}
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const names = rng.sample(NAMES, 2);
	if (grade === 'junior') {
		const other = rng.pick(['percent', 'mixed', 'ints', 'defaults'].filter((k) => k !== classId));
		const deployments = [
			juniorDeployment(rng, classId, names[0] ?? 'api'),
			juniorDeployment(rng, other, names[1] ?? 'web')
		];
		return { grade, deployments: rng.shuffle(deployments), readyAfter: [], minReady: 0, deadline: 0 };
	}
	const replicas = rng.int(4, 8);
	const name = names[0] ?? 'api';
	const d: Deployment =
		classId === 'surge-waves'
			? { name, replicas, strategy: 'RollingUpdate', surge: rng.pick(['20%', '25%', '30%', '40%']), unavailable: 0 }
			: classId === 'unavailable-first'
				? {
						name,
						replicas,
						strategy: 'RollingUpdate',
						surge: 0,
						unavailable: rng.pick(['30%', '40%', '50%', '60%'])
					}
				: {
						name,
						replicas,
						strategy: 'RollingUpdate',
						surge: rng.int(1, 2),
						unavailable: rng.pick([1, 2, '25%', '50%'] as const)
					};
	const readyAfter: (number | null)[] = Array.from({ length: replicas }, () => rng.int(1, 12) * 5);
	if (classId === 'stuck') readyAfter[rng.int(Math.floor(replicas / 2), replicas - 1)] = null;
	return {
		grade,
		deployments: [d],
		readyAfter,
		minReady: rng.int(1, 6) * 5,
		deadline: rng.int(6, 30) * 10
	};
}

// ---- The statement ----

function manifest(p: Params): string {
	return yamlText(
		p.deployments.map((d) => {
			const spec: { [key: string]: Yaml } = { replicas: d.replicas };
			if (p.grade === 'middle') {
				spec.minReadySeconds = p.minReady;
				spec.progressDeadlineSeconds = p.deadline;
			}
			if (d.strategy === 'Recreate') spec.strategy = { type: 'Recreate' };
			if (d.strategy === 'rolling-bare') spec.strategy = { type: 'RollingUpdate' };
			if (d.strategy === 'RollingUpdate')
				spec.strategy = { type: 'RollingUpdate', rollingUpdate: { maxSurge: d.surge, maxUnavailable: d.unavailable } };
			spec.selector = { matchLabels: { app: d.name } };
			spec.template = {
				metadata: { labels: { app: d.name } },
				spec: { containers: [{ name: d.name, image: `registry.local/${d.name}:2.0` }] }
			};
			return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: d.name }, spec };
		})
	);
}

function describe(p: Params): string {
	if (p.grade === 'junior') {
		return [
			'Во всех Deployment из манифеста ниже все поды запущены и доступны. В шаблонах подов меняют образ на новую версию, и Deployment начинают обновляться.',
			'',
			'Для каждого Deployment по порядку манифеста определите два числа: наибольшее число подов (старых и новых вместе), которое может существовать во время обновления, и наименьшее число доступных подов, которое Deployment обязан сохранять во время обновления.',
			'',
			'Введите четыре числа через пробел: два числа первого Deployment, затем два числа второго. Например: `5 3 12 9`.'
		].join('\n');
	}
	const d = p.deployments[0];
	const n = d?.replicas ?? 0;
	return [
		`Deployment \`${d?.name ?? ''}\` из манифеста ниже работает: все его поды (replicas: ${n}) запущены и доступны. В момент 0 в шаблоне пода меняют образ на новую версию. Обновление идёт по такой модели:`,
		'',
		'- Контроллер действует в момент 0 и в каждый момент, когда какой-нибудь новый под становится доступным. Действие повторяется, пока что-то меняется: создать новые поды, пока всех подов (старых и новых) меньше допустимого максимума и новых подов меньше `replicas`; удалить старые поды, пока после удаления доступных подов (старых и новых) остаётся не меньше обязательного минимума. Созданный под появляется сразу, удалённый — сразу исчезает; старые поды всё время доступны.',
		'- Новые поды нумеруются в порядке создания; под номер i становится готовым (Ready) через время из таблицы после своего создания, а доступным — по правилам Kubernetes с учётом `minReadySeconds` манифеста.',
		'- Продвижением считается создание или удаление пода и переход нового пода в Ready или в доступные. Если продвижения нет дольше `progressDeadlineSeconds`, обновление срывается (`ProgressDeadlineExceeded`) в тот момент, когда этот срок истёк; дальше ничего не происходит.',
		'- Обновление завершено, когда старых подов нет и все новые поды доступны.',
		'',
		'| Новый под | Готов через, с |',
		'|---|---|',
		...p.readyAfter.map((v, i) => `| ${i + 1} | ${v === null ? 'никогда: проба готовности не проходит' : v} |`),
		'',
		'Введите через пробел четыре значения: итог (`done` — завершено, `stuck` — сорвано), момент завершения или срыва в секундах, сколько в этот момент старых подов и сколько доступных новых подов. Например: `stuck 245 2 3` или `done 130 0 6`.'
	].join('\n');
}

// ---- The proof: an independent reading of the shown manifest ----

const PYTHON_REFERENCE = `${PY_YAML}import math

data = json.loads(sys.stdin.read())
docs = parse_yaml(data["yaml"])

def limits(spec):
    n = spec["replicas"]
    strategy = spec.get("strategy", {})
    if strategy.get("type") == "Recreate":
        return None
    ru = strategy.get("rollingUpdate", {})
    def amount(value, up):
        value = ru.get(value, "25%")
        if isinstance(value, str) and value.endswith("%"):
            x = int(value[:-1]) * n
            return -(-x // 100) if up else x // 100
        return value
    surge, unavailable = amount("maxSurge", True), amount("maxUnavailable", False)
    if surge == 0 and unavailable == 0:
        unavailable = 1
    return surge, unavailable

if data["readyAfter"] is None:
    out = []
    for d in docs:
        n = d["spec"]["replicas"]
        lim = limits(d["spec"])
        out += [n, 0] if lim is None else [n + lim[0], n - lim[1]]
    print(" ".join(map(str, out)))
else:
    spec = docs[0]["spec"]
    n = spec["replicas"]
    surge, unavailable = limits(spec)
    min_ready, deadline = spec["minReadySeconds"], spec["progressDeadlineSeconds"]
    old = n
    pods = []  # [ready moment or None, available moment or None]
    last = 0
    t = 0
    while True:
        moved = t == 0
        for ready, avail in pods:
            if ready == t or avail == t:
                last = t
            if avail == t:
                moved = True
        if moved:
            changed = True
            while changed:
                changed = False
                if old + len(pods) < n + surge and len(pods) < n:
                    after = data["readyAfter"][len(pods)]
                    pods.append([None, None] if after is None else [t + after, t + after + min_ready])
                    last, changed = t, True
                    continue
                avail_now = sum(1 for _, a in pods if a is not None and a <= t)
                if old > 0 and old - 1 + avail_now >= n - unavailable:
                    old -= 1
                    last, changed = t, True
        avail_now = sum(1 for _, a in pods if a is not None and a <= t)
        if old == 0 and avail_now == n:
            print("done", t, 0, n)
            break
        if t == last + deadline:
            print("stuck", t, old, avail_now)
            break
        t += 1
`;

const WRONG: Record<string, Partial<Rules>> = {
	'surge-floor': { surgeFloor: true },
	'unavailable-ceil': { unavailableCeil: true },
	'round-nearest': { roundNearest: true },
	'default-one': { defaultOne: true },
	'recreate-as-rolling': { recreateAsRolling: true },
	'ignore-minready': { ignoreMinReady: true },
	'deadline-from-start': { deadlineFromStart: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/percent': ['surge-floor', 'unavailable-ceil'],
	'junior/defaults': ['default-one'],
	'junior/mixed': ['round-nearest'],
	'junior/recreate': ['recreate-as-rolling'],
	'middle/surge-waves': ['surge-floor', 'ignore-minready'],
	'middle/unavailable-first': ['unavailable-ceil'],
	'middle/mixed': ['ignore-minready'],
	'middle/stuck': ['deadline-from-start']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = answerOf(p, RIGHT);
		if (answer === null) continue;
		if (input.grade === 'middle' && answer.startsWith('stuck') !== (input.classId === 'stuck')) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = answerOf(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const yaml = manifest(p);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: { language: 'yaml', source: yaml } },
			answer: { kind: 'tokens', value: answer }
		});
		const readyAfter = p.grade === 'junior' ? null : p.readyAfter;
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify({ yaml, readyAfter }) }),
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
