// The timeline of container probes: when a pod first becomes Ready, when the liveness (or startup) probe first gets
// the container killed and how many times it is killed by a moment T — from initialDelaySeconds, periodSeconds and the
// thresholds, with the probe schedule starting over on every start; at the middle level, startupProbe holding the
// other probes back and the growing CrashLoopBackOff pause before every new start.
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

interface Probe {
	initialDelay: number;
	period: number;
	successThreshold: number;
	failureThreshold: number;
}

interface Params {
	grade: string;
	name: string;
	port: number;
	readiness: Probe;
	liveness: Probe;
	startup: Probe | null;
	/** After every start, seconds from which `/healthz` answers. */
	upAt: number;
	/** After every start, seconds from which `/ready` answers. */
	readyAt: number;
	/** After every start, seconds from which the application hangs and both endpoints fail; `null` — never. */
	downAt: number | null;
	horizon: number;
}

interface Rules {
	successOnce: boolean;
	firstAfterPeriod: boolean;
	offByOne: boolean;
	noDelayAfterRestart: boolean;
	livenessWaitsReady: boolean;
	ignoreStartup: boolean;
	noBackoff: boolean;
	noCap: boolean;
}

const RIGHT: Rules = {
	successOnce: false,
	firstAfterPeriod: false,
	offByOne: false,
	noDelayAfterRestart: false,
	livenessWaitsReady: false,
	ignoreStartup: false,
	noBackoff: false,
	noCap: false
};

type Kind = 'startup' | 'readiness' | 'liveness';
const ORDER: Record<Kind, number> = { startup: 0, readiness: 1, liveness: 2 };

function timeline(p: Params, r: Rules): string {
	const healthy = (x: number): boolean => x >= p.upAt && (p.downAt === null || x < p.downAt);
	const answers = (x: number): boolean => x >= p.readyAt && (p.downAt === null || x < p.downAt);
	let start = 0;
	let kills = 0;
	let firstReady: number | null = null;
	let firstKill: number | null = null;
	while (start <= p.horizon) {
		const events: { t: number; kind: Kind }[] = [];
		const schedule = (kind: Kind, probe: Probe): void => {
			const shift = r.firstAfterPeriod ? probe.period : 0;
			// The misconception keeps the grid of the first start after a restart.
			const origin = r.noDelayAfterRestart && kills > 0 ? 0 : start;
			for (let t = origin + probe.initialDelay + shift; t <= p.horizon; t += probe.period)
				if (t > start || (t === start && origin === start)) events.push({ t, kind });
		};
		if (p.startup) schedule('startup', p.startup);
		schedule('readiness', p.readiness);
		schedule('liveness', p.liveness);
		events.sort((a, b) => a.t - b.t || ORDER[a.kind] - ORDER[b.kind]);
		let startupDone = p.startup === null || r.ignoreStartup;
		let startupAt = -1;
		let startupFailures = 0;
		let ready = false;
		let successes = 0;
		let failures = 0;
		let livenessFailures = 0;
		let killedAt: number | null = null;
		for (const e of events) {
			const x = e.t - start;
			if (e.kind === 'startup') {
				if (startupDone || !p.startup) continue;
				if (healthy(x)) {
					startupDone = true;
					startupAt = e.t;
				} else if (++startupFailures >= p.startup.failureThreshold) {
					killedAt = e.t;
					break;
				}
				continue;
			}
			if (!startupDone || e.t <= startupAt) continue;
			if (e.kind === 'readiness') {
				if (answers(x)) {
					failures = 0;
					successes += 1;
					if (!ready && successes >= (r.successOnce ? 1 : p.readiness.successThreshold)) {
						ready = true;
						firstReady ??= e.t;
					}
				} else {
					successes = 0;
					failures += 1;
					if (ready && failures >= p.readiness.failureThreshold) ready = false;
				}
				continue;
			}
			if (r.livenessWaitsReady && !ready) continue;
			if (healthy(x)) livenessFailures = 0;
			else if (++livenessFailures >= p.liveness.failureThreshold + (r.offByOne ? 1 : 0)) {
				killedAt = e.t;
				break;
			}
		}
		if (killedAt === null) break;
		kills += 1;
		firstKill ??= killedAt;
		const pause =
			p.grade === 'junior' || r.noBackoff ? 0 : r.noCap ? 10 * 2 ** (kills - 1) : Math.min(300, 10 * 2 ** (kills - 1));
		start = killedAt + pause;
	}
	return `${firstReady ?? 'never'} ${firstKill ?? 'none'} ${kills}`;
}

// ---- Drawing ----

const NAMES = ['api', 'web', 'cart', 'search', 'billing', 'auth', 'reports', 'feed', 'media', 'mailer'];

function scenario(rng: Rng, grade: string, classId: string): Params {
	const readiness: Probe = {
		initialDelay: rng.pick([2, 3, 5, 8, 10]),
		period: rng.pick([2, 3, 5, 10]),
		successThreshold: rng.int(1, 3),
		failureThreshold: 3
	};
	const liveness: Probe = {
		initialDelay: rng.pick([5, 10, 15, 20, 30]),
		period: rng.pick([5, 10, 15]),
		successThreshold: 1,
		failureThreshold: rng.int(2, 5)
	};
	const p: Params = {
		grade,
		name: rng.pick(NAMES),
		port: rng.pick([8080, 8000, 9000, 3000]),
		readiness,
		liveness,
		startup: null,
		upAt: 0,
		readyAt: rng.int(4, 40),
		downAt: null,
		horizon: 0
	};
	if (grade === 'junior') {
		if (classId === 'readiness') {
			readiness.successThreshold = rng.int(2, 3);
			readiness.initialDelay = rng.int(2, 45);
			p.readyAt = rng.int(1, readiness.initialDelay + 10);
			if (rng.bool(0.7)) p.downAt = p.readyAt + rng.int(10, 80);
			p.horizon = p.readyAt + rng.int(30, 200);
		} else if (classId === 'liveness') {
			p.downAt = p.readyAt + rng.int(5, 60);
			p.horizon = p.downAt + rng.int(20, 100);
		} else if (classId === 'restarts-count') {
			p.downAt = p.readyAt + rng.int(5, 30);
			p.horizon = rng.int(4, 9) * (p.downAt + 10);
		} else {
			p.upAt = rng.int(20, 60);
			p.readyAt = p.upAt + rng.int(0, 10);
			liveness.initialDelay = rng.pick([3, 5, 8, 10]);
			liveness.period = rng.pick([2, 3, 5]);
			liveness.failureThreshold = rng.int(1, 3);
			p.horizon = rng.int(60, 240);
		}
		return p;
	}
	p.startup = {
		initialDelay: rng.pick([1, 2, 5]),
		period: rng.pick([5, 10]),
		successThreshold: 1,
		failureThreshold: rng.int(3, 30)
	};
	p.upAt = rng.int(20, 150);
	p.readyAt = p.upAt + rng.int(0, 20);
	const window = (s: Probe): number => s.initialDelay + (s.failureThreshold - 1) * s.period;
	if (classId === 'startup-fails' || (classId === 'backoff-cap' && rng.bool())) {
		p.startup.failureThreshold = rng.int(2, 8);
		p.upAt = window(p.startup) + rng.int(5, 60);
		p.readyAt = p.upAt + rng.int(0, 20);
	} else {
		while (window(p.startup) < p.upAt + 5) p.startup.failureThreshold += 3;
		if (classId !== 'startup-ok' || rng.bool(0.4)) p.downAt = p.readyAt + rng.int(10, 120);
	}
	p.horizon =
		classId === 'backoff-cap'
			? rng.int(900, 1500)
			: classId === 'startup-ok'
				? p.upAt + rng.int(60, 300)
				: rng.int(200, 700);
	return p;
}

// ---- The statement ----

function probeYaml(p: Params, probe: Probe, path: string, withSuccess: boolean): Yaml {
	const entry: { [key: string]: Yaml } = {
		httpGet: { path, port: p.port },
		initialDelaySeconds: probe.initialDelay,
		periodSeconds: probe.period
	};
	if (withSuccess) entry.successThreshold = probe.successThreshold;
	entry.failureThreshold = probe.failureThreshold;
	return entry;
}

function manifest(p: Params): string {
	const container: { [key: string]: Yaml } = {
		name: p.name,
		image: `registry.local/${p.name}:5.3`,
		ports: [{ containerPort: p.port }]
	};
	if (p.startup) container.startupProbe = probeYaml(p, p.startup, '/healthz', false);
	container.readinessProbe = probeYaml(p, p.readiness, '/ready', true);
	container.livenessProbe = probeYaml(p, p.liveness, '/healthz', false);
	return yamlText([
		{
			apiVersion: 'v1',
			kind: 'Pod',
			metadata: { name: p.name },
			spec: { restartPolicy: 'Always', containers: [container] }
		}
	]);
}

function describe(p: Params): string {
	const behaviour = [
		`- \`/healthz\` отвечает успешно ${p.upAt === 0 ? 'сразу' : `начиная с ${p.upAt}-й секунды после запуска`}${p.downAt === null ? '' : `, а начиная с ${p.downAt}-й секунды приложение зависает, и обе ручки отвечают ошибкой до следующего запуска`};`,
		`- \`/ready\` отвечает успешно начиная с ${p.readyAt}-й секунды после запуска${p.downAt === null ? '' : ' (до зависания)'}, раньше — ошибкой.`
	];
	const restart =
		p.grade === 'junior'
			? 'Убитый контейнер запускается заново мгновенно, в тот же момент.'
			: 'После k-го убийства (k = 1, 2, …) контейнер запускается заново через min(300, 10 · 2^(k−1)) секунд (CrashLoopBackOff: 10, 20, 40, …, 300, 300, …); пока он не запущен, пробы не выполняются.';
	return [
		`Под из манифеста ниже создан в момент 0, его контейнер запускается в момент 0. После каждого запуска контейнера приложение ведёт себя одинаково (секунды отсчитываются от этого запуска):`,
		'',
		...behaviour,
		'',
		'Модель проб:',
		'',
		'- проба выполняется в моменты «запуск контейнера + initialDelaySeconds + k · periodSeconds», k = 0, 1, 2, …, и отвечает мгновенно;',
		...(p.startup
			? [
					'- пробы liveness и readiness выполняются только в те свои моменты, которые строго позже момента успеха startupProbe этого запуска;'
				]
			: []),
		`- если пробы совпали по времени, сначала выполняется ${p.startup ? 'startup, затем readiness' : 'readiness'}, затем liveness;`,
		`- контейнер убивают в момент пробы, которая это решила. ${restart}`,
		'',
		`Определите для промежутка от 0 до ${p.horizon}-й секунды включительно: момент, когда под впервые станет Ready (или \`never\`, если не станет), момент первого убийства контейнера kubelet (или \`none\`) и сколько всего раз контейнер убьют.`,
		'',
		'Введите три значения через пробел. Например: `24 71 2` или `never 18 3`.'
	].join('\n');
}

// ---- The proof: an independent reading of the shown manifest ----

const PYTHON_REFERENCE = `${PY_YAML}data = json.loads(sys.stdin.read())
c = parse_yaml(data["yaml"])[0]["spec"]["containers"][0]
app = data["app"]
horizon = data["horizon"]
backoff = data["backoff"]
probes = [(k, c[k + "Probe"]) for k in ("startup", "readiness", "liveness") if k + "Probe" in c]

def endpoint(path, x):
    start = app["upAt"] if path == "/healthz" else app["readyAt"]
    return x >= start and (app["downAt"] is None or x < app["downAt"])

start, kills, first_ready, first_kill = 0, 0, None, None
def fresh():
    return {"startup": "startupProbe" not in c, "startup_at": -1, "fails": {}, "succ": 0, "ready": False}
st = fresh()
for t in range(horizon + 1):
    if t < start:
        continue
    x = t - start
    for kind, pr in probes:
        delay, period = pr["initialDelaySeconds"], pr["periodSeconds"]
        if x < delay or (x - delay) % period:
            continue
        if kind == "startup":
            if st["startup"]:
                continue
            if endpoint(pr["httpGet"]["path"], x):
                st["startup"], st["startup_at"] = True, t
                continue
        elif not st["startup"] or t <= st["startup_at"]:
            continue
        ok = endpoint(pr["httpGet"]["path"], x)
        if kind == "readiness":
            if ok:
                st["fails"]["readiness"] = 0
                st["succ"] += 1
                if not st["ready"] and st["succ"] >= pr.get("successThreshold", 1):
                    st["ready"] = True
                    if first_ready is None:
                        first_ready = t
            else:
                st["succ"] = 0
                st["fails"]["readiness"] = st["fails"].get("readiness", 0) + 1
                if st["ready"] and st["fails"]["readiness"] >= pr["failureThreshold"]:
                    st["ready"] = False
            continue
        if ok:
            st["fails"][kind] = 0
            continue
        st["fails"][kind] = st["fails"].get(kind, 0) + 1
        if st["fails"][kind] >= pr["failureThreshold"]:
            kills += 1
            if first_kill is None:
                first_kill = t
            start = t + (min(300, 10 * 2 ** (kills - 1)) if backoff else 0)
            st = fresh()
            break
print("never" if first_ready is None else first_ready, "none" if first_kill is None else first_kill, kills)
`;

const WRONG: Record<string, Partial<Rules>> = {
	'success-once': { successOnce: true },
	'first-after-period': { firstAfterPeriod: true },
	'threshold-off-by-one': { offByOne: true },
	'no-delay-after-restart': { noDelayAfterRestart: true },
	'liveness-waits-ready': { livenessWaitsReady: true },
	'ignore-startup': { ignoreStartup: true },
	'no-backoff': { noBackoff: true },
	'no-cap': { noCap: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'junior/readiness': ['success-once', 'first-after-period'],
	'junior/liveness': ['threshold-off-by-one'],
	'junior/restarts-count': ['no-delay-after-restart'],
	'junior/slow-start': ['liveness-waits-ready'],
	'middle/startup-ok': ['ignore-startup'],
	'middle/startup-fails': ['no-backoff'],
	'middle/liveness-backoff': ['no-backoff'],
	'middle/backoff-cap': ['no-cap']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = timeline(p, RIGHT);
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = timeline(p, { ...RIGHT, ...change });
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
		const app = { upAt: p.upAt, readyAt: p.readyAt, downAt: p.downAt };
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ yaml, app, horizon: p.horizon, backoff: p.grade === 'middle' })
			}),
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
