// Admission of pods into a namespace with a LimitRange and a ResourceQuota: requests and limits after the defaults
// (a limit alone sets the request, the LimitRange fills what is missing), the checks of min, max and
// maxLimitRequestRatio, and the quota spent only by the pods admitted before. The candidate gives the fate of every pod.
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
const RESOURCES: readonly Resource[] = ['cpu', 'memory'];

interface Container {
	name: string;
	requests: Partial<Record<Resource, number>>;
	limits: Partial<Record<Resource, number>>;
}

interface Pod {
	name: string;
	containers: Container[];
}

interface LimitRange {
	default: Record<Resource, number>;
	defaultRequest: Record<Resource, number>;
	max: Record<Resource, number>;
	min: Partial<Record<Resource, number>>;
	ratio: Partial<Record<Resource, number>>;
}

interface Quota {
	pods: number;
	requests: Record<Resource, number>;
	limits: Record<Resource, number>;
}

interface Params {
	namespace: string;
	range: LimitRange;
	quota: Quota;
	pods: Pod[];
}

interface Rules {
	defaultRequestOverLimit: boolean;
	limitFromRequest: boolean;
	ratioIgnored: boolean;
	maxOnRequest: boolean;
	rejectedConsume: boolean;
	quotaLimitsIgnored: boolean;
}

const RIGHT: Rules = {
	defaultRequestOverLimit: false,
	limitFromRequest: false,
	ratioIgnored: false,
	maxOnRequest: false,
	rejectedConsume: false,
	quotaLimitsIgnored: false
};

/** Requests and limits of a container after the defaults. */
function effective(
	c: Container,
	range: LimitRange,
	r: Rules
): { req: Record<Resource, number>; lim: Record<Resource, number> } {
	const req = { cpu: 0, memory: 0 };
	const lim = { cpu: 0, memory: 0 };
	for (const res of RESOURCES) {
		const q = c.requests[res];
		const l = c.limits[res];
		if (q !== undefined && l !== undefined) {
			req[res] = q;
			lim[res] = l;
		} else if (l !== undefined) {
			lim[res] = l;
			req[res] = r.defaultRequestOverLimit ? range.defaultRequest[res] : l;
		} else if (q !== undefined) {
			req[res] = q;
			lim[res] = r.limitFromRequest ? q : range.default[res];
		} else {
			req[res] = range.defaultRequest[res];
			lim[res] = range.default[res];
		}
	}
	return { req, lim };
}

type Totals = Record<'reqCpu' | 'limCpu' | 'reqMemory' | 'limMemory', number>;

function admit(p: Params, r: Rules): string[] {
	const used: Totals = { reqCpu: 0, limCpu: 0, reqMemory: 0, limMemory: 0 };
	let pods = 0;
	return p.pods.map((pod) => {
		const all = pod.containers.map((c) => effective(c, p.range, r));
		const total: Totals = {
			reqCpu: all.reduce((s, e) => s + e.req.cpu, 0),
			limCpu: all.reduce((s, e) => s + e.lim.cpu, 0),
			reqMemory: all.reduce((s, e) => s + e.req.memory, 0),
			limMemory: all.reduce((s, e) => s + e.lim.memory, 0)
		};
		const consume = (): void => {
			pods += 1;
			used.reqCpu += total.reqCpu;
			used.limCpu += total.limCpu;
			used.reqMemory += total.reqMemory;
			used.limMemory += total.limMemory;
		};
		const reject = (reason: string): string => {
			if (r.rejectedConsume) consume();
			return `rejected ${reason}`;
		};
		const any = (test: (e: (typeof all)[number], res: Resource) => boolean): boolean =>
			all.some((e) => RESOURCES.some((res) => test(e, res)));
		if (any((e, res) => e.req[res] > e.lim[res])) return reject('invalid');
		if (any((e, res) => p.range.min[res] !== undefined && e.req[res] < (p.range.min[res] ?? 0))) return reject('min');
		if (any((e, res) => (r.maxOnRequest ? e.req[res] : e.lim[res]) > p.range.max[res])) return reject('max');
		if (
			!r.ratioIgnored &&
			any((e, res) => p.range.ratio[res] !== undefined && e.lim[res] > (p.range.ratio[res] ?? 0) * e.req[res])
		)
			return reject('ratio');
		const q = p.quota;
		const over =
			pods + 1 > q.pods ||
			used.reqCpu + total.reqCpu > q.requests.cpu ||
			used.reqMemory + total.reqMemory > q.requests.memory ||
			(!r.quotaLimitsIgnored &&
				(used.limCpu + total.limCpu > q.limits.cpu || used.limMemory + total.limMemory > q.limits.memory));
		if (over) return reject('quota');
		consume();
		return `ok ${total.reqCpu} ${total.limCpu} ${total.reqMemory} ${total.limMemory}`;
	});
}

// ---- Drawing ----

type Kind = 'full' | 'limit-only' | 'request-only' | 'none' | 'high-ratio' | 'over-max' | 'request-over-default';

const CONTAINER_NAMES = ['app', 'proxy', 'agent', 'worker'];
const POD_NAMES = ['api', 'web', 'cart', 'search', 'billing', 'auth', 'reports', 'feed', 'media', 'mailer'];

function container(rng: Rng, kind: Kind, range: LimitRange, name: string): Container {
	const cpuReq = rng.pick([100, 200, 250, 300, 500]);
	const memReq = rng.pick([128, 192, 256, 384, 512]);
	const fit = (base: number, cap: number, step: number): number =>
		Math.min(cap, base * rng.int(1, 2) + step * rng.int(0, 2));
	switch (kind) {
		case 'full':
			return {
				name,
				requests: { cpu: cpuReq, memory: memReq },
				limits: { cpu: fit(cpuReq, range.max.cpu, 100), memory: fit(memReq, range.max.memory, 128) }
			};
		case 'limit-only': {
			const res: Resource = rng.pick(RESOURCES);
			const other: Resource = res === 'cpu' ? 'memory' : 'cpu';
			const value = res === 'cpu' ? rng.pick([300, 400, 600, 750]) : rng.pick([320, 384, 448, 640, 768]);
			return {
				name,
				requests: rng.bool() ? { [other]: other === 'cpu' ? cpuReq : memReq } : {},
				limits: {
					[res]: value,
					...(rng.bool() ? { [other]: other === 'cpu' ? range.default.cpu : range.default.memory } : {})
				}
			};
		}
		case 'request-only':
			return { name, requests: rng.bool() ? { cpu: cpuReq } : { memory: memReq }, limits: {} };
		case 'request-over-default': {
			const res: Resource = rng.pick(RESOURCES);
			const value =
				res === 'cpu' ? range.default.cpu + rng.pick([100, 250, 500]) : range.default.memory + rng.pick([128, 256]);
			return { name, requests: { [res]: Math.min(value, range.max[res]) }, limits: {} };
		}
		case 'none':
			return { name, requests: {}, limits: {} };
		case 'high-ratio': {
			const res: Resource = rng.pick(RESOURCES.filter((x) => range.ratio[x] !== undefined));
			const ratio = range.ratio[res] ?? 2;
			const req = res === 'cpu' ? rng.pick([100, 200, 250]) : rng.pick([128, 256]);
			const lim = Math.min(
				range.max[res],
				req * ratio + (res === 'cpu' ? rng.pick([50, 100, 200]) : rng.pick([64, 128]))
			);
			return {
				name,
				requests: { cpu: res === 'cpu' ? req : cpuReq, memory: res === 'memory' ? req : memReq },
				limits: { cpu: res === 'cpu' ? lim : cpuReq * 2, memory: res === 'memory' ? lim : memReq * 2 }
			};
		}
		case 'over-max': {
			const res: Resource = rng.pick(RESOURCES);
			const lim = range.max[res] + (res === 'cpu' ? rng.pick([250, 500]) : rng.pick([256, 512]));
			const req = res === 'cpu' ? rng.pick([500, 750]) : rng.pick([512, 768]);
			return {
				name,
				requests: { cpu: res === 'cpu' ? req : cpuReq, memory: res === 'memory' ? req : memReq },
				limits: { cpu: res === 'cpu' ? lim : cpuReq, memory: res === 'memory' ? lim : memReq }
			};
		}
	}
}

function scenario(rng: Rng, classId: string): Params {
	const range: LimitRange = {
		default: { cpu: rng.pick([500, 1000]), memory: rng.pick([512, 1024]) },
		defaultRequest: { cpu: rng.pick([100, 200, 250]), memory: rng.pick([128, 256]) },
		max: { cpu: rng.pick([1500, 2000]), memory: rng.pick([1536, 2048]) },
		min: rng.bool(0.4) ? { cpu: 50, memory: 64 } : {},
		ratio: rng.pick([{ cpu: rng.int(2, 4) }, { memory: 2 }, { cpu: rng.int(2, 4), memory: 2 }])
	};
	const trap: Kind[] =
		classId === 'defaults'
			? ['limit-only']
			: classId === 'ratio-max'
				? ['high-ratio', 'over-max']
				: classId === 'request-only'
					? ['request-over-default', 'request-only']
					: ['full', 'high-ratio'];
	const plain: Kind[] = ['full', 'full', 'none', 'limit-only', 'request-only'];
	const names = rng.sample(POD_NAMES, rng.int(5, 6));
	const pods: Pod[] = names.map((name, i) => {
		const count = rng.bool(0.35) ? 2 : 1;
		const containerNames = rng.sample(CONTAINER_NAMES, count);
		const kinds = Array.from({ length: count }, (_, j) =>
			i < 2 && j === 0 ? rng.pick(trap) : rng.pick(rng.bool(0.3) ? trap : plain)
		);
		return { name, containers: kinds.map((k, j) => container(rng, k, range, containerNames[j] ?? 'app')) };
	});
	const p: Params = {
		namespace: rng.pick(['team-a', 'shop', 'payments', 'analytics', 'staging']),
		range,
		quota: { pods: 20, requests: { cpu: 100000, memory: 100000 }, limits: { cpu: 100000, memory: 100000 } },
		pods: rng.shuffle(pods)
	};
	// The quota: what the pods passing the LimitRange would use. In the tight class the last of them breaks a limits
	// quota, and the requests quota fits them all exactly, so any extra spending shows.
	const totals = admit(p, RIGHT)
		.filter((x) => x.startsWith('ok'))
		.map((x) => x.split(' ').slice(1).map(Number));
	const sum = (i: number, rows: readonly number[][]): number => rows.reduce((s, t) => s + (t[i] ?? 0), 0);
	if (classId !== 'quota') {
		p.quota = {
			pods: rng.int(totals.length, 10),
			requests: { cpu: sum(0, totals) + rng.int(1, 4) * 100, memory: sum(2, totals) + rng.int(1, 4) * 128 },
			limits: { cpu: sum(1, totals) + rng.int(1, 4) * 250, memory: sum(3, totals) + rng.int(1, 4) * 256 }
		};
		return p;
	}
	const kept = totals.slice(0, -1);
	const bound = rng.bool() ? 1 : 3;
	p.quota = {
		pods: totals.length + rng.int(0, 1),
		requests: { cpu: sum(0, totals), memory: sum(2, totals) },
		limits: {
			cpu: sum(1, bound === 1 ? kept : totals) + (bound === 1 ? 0 : rng.int(1, 3) * 250),
			memory: sum(3, bound === 3 ? kept : totals) + (bound === 3 ? 0 : rng.int(1, 3) * 256)
		}
	};
	return p;
}

// ---- The statement ----

const cpuText = (m: number): string =>
	m % 1000 === 0 ? String(m / 1000) : m % 100 === 0 && m > 1000 ? String(m / 1000) : `${m}m`;
const memoryText = (mi: number): string => (mi % 1024 === 0 ? `${mi / 1024}Gi` : `${mi}Mi`);
const quantity = (res: Resource, v: number): string => (res === 'cpu' ? cpuText(v) : memoryText(v));
const section = (values: Partial<Record<Resource, number>>): { [key: string]: Yaml } =>
	Object.fromEntries(
		RESOURCES.filter((res) => values[res] !== undefined).map((res) => [res, quantity(res, values[res] ?? 0)])
	);

function manifest(p: Params): string {
	const limit: { [key: string]: Yaml } = {
		type: 'Container',
		default: section(p.range.default),
		defaultRequest: section(p.range.defaultRequest),
		max: section(p.range.max)
	};
	if (Object.keys(p.range.min).length) limit.min = section(p.range.min);
	limit.maxLimitRequestRatio = Object.fromEntries(
		RESOURCES.filter((res) => p.range.ratio[res] !== undefined).map((res) => [res, String(p.range.ratio[res])])
	);
	return yamlText([
		{
			apiVersion: 'v1',
			kind: 'LimitRange',
			metadata: { name: 'defaults', namespace: p.namespace },
			spec: { limits: [limit] }
		},
		{
			apiVersion: 'v1',
			kind: 'ResourceQuota',
			metadata: { name: 'budget', namespace: p.namespace },
			spec: {
				hard: {
					pods: String(p.quota.pods),
					'requests.cpu': cpuText(p.quota.requests.cpu),
					'requests.memory': memoryText(p.quota.requests.memory),
					'limits.cpu': cpuText(p.quota.limits.cpu),
					'limits.memory': memoryText(p.quota.limits.memory)
				}
			}
		},
		...p.pods.map((pod) => ({
			apiVersion: 'v1',
			kind: 'Pod',
			metadata: { name: pod.name, namespace: p.namespace },
			spec: {
				containers: pod.containers.map((c) => {
					const entry: { [key: string]: Yaml } = { name: c.name, image: `registry.local/${c.name}:1.8` };
					const resources: { [key: string]: Yaml } = {};
					if (Object.keys(c.requests).length) resources.requests = section(c.requests);
					if (Object.keys(c.limits).length) resources.limits = section(c.limits);
					if (Object.keys(resources).length) entry.resources = resources;
					return entry;
				})
			}
		}))
	]);
}

function describe(p: Params): string {
	return [
		`Namespace \`${p.namespace}\` пуст; в нём созданы LimitRange и ResourceQuota из манифеста ниже. Затем поды из того же манифеста создаются по одному, в порядке манифеста.`,
		'',
		'Для каждого контейнера сначала подставляются значения по умолчанию — как это делают API-сервер и LimitRange в Kubernetes. Затем под проверяется; первая не пройденная проверка в этом порядке даёт причину отказа:',
		'',
		'1. `invalid` — у какого-нибудь контейнера request больше limit;',
		'2. `min` — у какого-нибудь контейнера значение меньше `min` LimitRange;',
		'3. `max` — у какого-нибудь контейнера значение больше `max` LimitRange;',
		'4. `ratio` — у какого-нибудь контейнера отношение limit / request больше `maxLimitRequestRatio`;',
		'5. `quota` — с этим подом какое-нибудь значение `hard` ResourceQuota будет превышено.',
		'',
		'Введите для каждого пода в порядке манифеста одну строку: `rejected <причина>`, если под отклонён, или `ok` и четыре суммы по всем контейнерам пода через пробел — requests CPU и limits CPU в милликорах, requests памяти и limits памяти в Mi. Например:',
		'',
		'```\nok 350 1500 384 1024\nrejected ratio\n```'
	].join('\n');
}

// ---- The proof: an independent reading of the shown manifest ----

const PYTHON_REFERENCE = `${PY_YAML}from fractions import Fraction

docs = parse_yaml(json.loads(sys.stdin.read())["yaml"])

def qty(resource, text):
    text = str(text)
    if resource == "cpu":
        return Fraction(text[:-1]) if text.endswith("m") else Fraction(text) * 1000
    if text.endswith("Gi"):
        return Fraction(text[:-2]) * 1024
    return Fraction(text[:-2])

limits = next(d for d in docs if d["kind"] == "LimitRange")["spec"]["limits"][0]
hard = next(d for d in docs if d["kind"] == "ResourceQuota")["spec"]["hard"]
cap = {"pods": int(hard["pods"])}
for key, value in hard.items():
    if key != "pods":
        cap[key] = qty(key.split(".")[1], value)
used = {key: 0 for key in cap}
section = lambda name: {k: qty(k, v) for k, v in limits.get(name, {}).items()}
default, default_request = section("default"), section("defaultRequest")
lo, hi = section("min"), section("max")
ratio = {k: Fraction(str(v)) for k, v in limits.get("maxLimitRequestRatio", {}).items()}

for pod in (d for d in docs if d["kind"] == "Pod"):
    containers = []
    for c in pod["spec"]["containers"]:
        res = c.get("resources", {})
        req = {k: qty(k, v) for k, v in res.get("requests", {}).items()}
        lim = {k: qty(k, v) for k, v in res.get("limits", {}).items()}
        for k in ("cpu", "memory"):
            if k in lim and k not in req:
                req[k] = lim[k]
            if k not in req:
                req[k] = default_request[k]
            if k not in lim:
                lim[k] = default[k]
        containers.append((req, lim))
    def bad(test):
        return any(test(req, lim, k) for req, lim in containers for k in ("cpu", "memory"))
    reason = None
    if bad(lambda q, l, k: q[k] > l[k]):
        reason = "invalid"
    elif bad(lambda q, l, k: k in lo and q[k] < lo[k]):
        reason = "min"
    elif bad(lambda q, l, k: k in hi and l[k] > hi[k]):
        reason = "max"
    elif bad(lambda q, l, k: k in ratio and l[k] > ratio[k] * q[k]):
        reason = "ratio"
    total = {
        "requests.cpu": sum(q["cpu"] for q, _ in containers),
        "limits.cpu": sum(l["cpu"] for _, l in containers),
        "requests.memory": sum(q["memory"] for q, _ in containers),
        "limits.memory": sum(l["memory"] for _, l in containers),
        "pods": 1,
    }
    if reason is None and any(used[k] + total[k] > cap[k] for k in cap):
        reason = "quota"
    if reason is not None:
        print("rejected", reason)
        continue
    for k in cap:
        used[k] += total[k]
    print("ok", *(int(total[k]) for k in ("requests.cpu", "limits.cpu", "requests.memory", "limits.memory")))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'default-request-over-limit': { defaultRequestOverLimit: true },
	'limit-from-request': { limitFromRequest: true },
	'ratio-ignored': { ratioIgnored: true },
	'max-on-request': { maxOnRequest: true },
	'rejected-consume': { rejectedConsume: true },
	'quota-limits-ignored': { quotaLimitsIgnored: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/defaults': ['default-request-over-limit'],
	'senior/ratio-max': ['ratio-ignored', 'max-on-request'],
	'senior/quota': ['rejected-consume', 'quota-limits-ignored'],
	'senior/request-only': ['limit-from-request']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = admit(p, RIGHT);
		if (answer.filter((x) => x.startsWith('ok')).length < 2) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = admit(p, { ...RIGHT, ...change });
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
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify({ yaml }) }),
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
