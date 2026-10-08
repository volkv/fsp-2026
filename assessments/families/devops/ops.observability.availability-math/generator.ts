// Availability of a composed system as expected downtime over 30 days: chains, redundant groups, quorums and N+1 spares
// that degrade one instance short of capacity (middle, with the inverse question of a component's allowed downtime); retries that mask only short failures, zone
// outages that take all replicas of a zone at once and redundant paths sharing a database (senior).
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

const MONTH = 43200;
const EPS = 0.01;
/** Probabilities are integers in units of 1e-5 (99.95 % is 99950). */
const UNIT = 100000;

/**
 * A structure the reference enumerates: a component, all of the items, at least k of the items, or a capacity group
 * that serves fully with `need` items up and loses `loss` % of requests with one item fewer.
 */
type Node =
	| { kind: 'comp'; id: string; a: number }
	| { kind: 'all'; items: Node[] }
	| { kind: 'atLeast'; k: number; items: Node[] }
	| { kind: 'capacity'; need: number; loss: number; items: Node[] };

interface Params {
	classId: string;
	text: string[];
	/** The structure whose downtime is asked, or (inverse) the rest of the system. */
	tree: Node;
	/** Inverse: the allowed downtime of the system, minutes per 30 days. */
	target: number | null;
	answer: (rules: Rules) => number;
}

interface Rules {
	parallelIgnored: boolean;
	minOfChain: boolean;
	anyOfN: boolean;
	allOfN: boolean;
	ignoreSpare: boolean;
	degradedIgnored: boolean;
	ignoreRest: boolean;
	noRetry: boolean;
	retryMasksAll: boolean;
	ignoreZone: boolean;
	independentReplicas: boolean;
	pathParallel: boolean;
}

const RIGHT: Rules = {
	parallelIgnored: false,
	minOfChain: false,
	anyOfN: false,
	allOfN: false,
	ignoreSpare: false,
	degradedIgnored: false,
	ignoreRest: false,
	noRetry: false,
	retryMasksAll: false,
	ignoreZone: false,
	independentReplicas: false,
	pathParallel: false
};

const WRONG: Record<string, Partial<Rules>> = {
	'parallel-ignored': { parallelIgnored: true },
	'min-of-chain': { minOfChain: true },
	'any-of-n': { anyOfN: true },
	'all-of-n': { allOfN: true },
	'ignore-spare': { ignoreSpare: true },
	'degraded-ignored': { degradedIgnored: true },
	'ignore-rest': { ignoreRest: true },
	'no-retry': { noRetry: true },
	'retry-masks-all': { retryMasksAll: true },
	'ignore-zone': { ignoreZone: true },
	'independent-replicas': { independentReplicas: true },
	'path-parallel': { pathParallel: true }
};

// ---------------------------------------------------------------------------------------------------------------
// Formulas of the model.

const anyOf = (a: number, n: number): number => 1 - (1 - a) ** n;

function binom(n: number, k: number): number {
	let c = 1;
	for (let i = 1; i <= k; i += 1) c = (c * (n - k + i)) / i;
	return c;
}

/** Exactly j of n independent items with availability a are up. */
const exactly = (a: number, n: number, j: number): number => binom(n, j) * a ** j * (1 - a) ** (n - j);

/** At least k of n independent items with availability a. */
function atLeast(a: number, n: number, k: number): number {
	let sum = 0;
	for (let j = k; j <= n; j += 1) sum += binom(n, j) * a ** j * (1 - a) ** (n - j);
	return sum;
}

/** At least k nodes up, nodes spread over zones (`perZone`), a zone down with probability pz takes its nodes down. */
function zonedAtLeast(perZone: readonly number[], a: number, pz: number, k: number): number {
	let total = 0;
	for (let mask = 0; mask < 1 << perZone.length; mask += 1) {
		let p = 1;
		// Distribution of the number of nodes up over the zones that are up.
		let dist = [1];
		perZone.forEach((m, z) => {
			const up = (mask >> z) & 1;
			p *= up ? 1 - pz : pz;
			if (!up) return;
			const next = Array<number>(dist.length + m).fill(0);
			dist.forEach((q, have) => {
				for (let j = 0; j <= m; j += 1)
					next[have + j] = (next[have + j] ?? 0) + q * binom(m, j) * a ** j * (1 - a) ** (m - j);
			});
			dist = next;
		});
		total += p * dist.reduce((s, q, have) => (have >= k ? s + q : s), 0);
	}
	return total;
}

const downtime = (availability: number): number => (1 - availability) * MONTH;

// ---------------------------------------------------------------------------------------------------------------
// The statement's numbers.

function percent(units: number): string {
	return `${(units / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')} %`;
}

const comp = (id: string, units: number): Node => ({ kind: 'comp', id, a: units });

const LB = [99990, 99995, 99950];
const DB = [99950, 99900, 99990, 99980];
const REPLICA = [99000, 99500, 98000, 95000, 99900, 97000];

function scenario(rng: Rng, grade: string, classId: string): Params {
	const p = (units: number): number => units / UNIT;
	if (grade === 'middle') {
		const lb = rng.pick(LB);
		const db = rng.pick(DB);
		const extra = rng.bool(0.5) ? rng.pick([99900, 99950, 99990]) : null;
		const chainText = (middle: string): string[] => [
			`- балансировщик — ${percent(lb)};`,
			middle,
			...(extra === null ? [] : [`- очередь сообщений — ${percent(extra)};`]),
			`- база данных — ${percent(db)}.`
		];
		const chain = (group: number, rules: Rules): number => {
			const parts = [p(lb), group, p(db), ...(extra === null ? [] : [p(extra)])];
			return rules.minOfChain ? Math.min(...parts) : parts.reduce((x, y) => x * y, 1);
		};
		const tail = (group: Node): Node => ({
			kind: 'all',
			items: [comp('lb', lb), group, comp('db', db), ...(extra === null ? [] : [comp('queue', extra)])]
		});
		const replicas = (n: number, a: number, k: number): Node => ({
			kind: 'atLeast',
			k,
			items: Array.from({ length: n }, (_, i) => comp(`node${i}`, a))
		});
		if (classId === 'series-parallel' || classId === 'inverse') {
			const n = rng.int(2, 4);
			const a = rng.pick(REPLICA);
			const group = (rules: Rules): number => (rules.parallelIgnored ? p(a) : anyOf(p(a), n));
			const appLine = `- приложение — ${n} одинаковых экземпляра${n > 4 ? 'ов' : ''}, у каждого ${percent(a)}; запрос обслужит любой работающий экземпляр;`;
			if (classId === 'series-parallel') {
				return {
					classId,
					text: chainText(appLine),
					tree: tail(replicas(n, a, 1)),
					target: null,
					answer: (rules) => downtime(chain(group(rules), rules))
				};
			}
			const restText = [`- балансировщик — ${percent(lb)};`, appLine];
			const rest = (rules: Rules): number => p(lb) * group(rules);
			const restDowntime = downtime(rest(RIGHT));
			const target = Math.round(restDowntime * (1.5 + rng.next() * 2) + rng.int(5, 40));
			return {
				classId,
				text: restText,
				tree: { kind: 'all', items: [comp('lb', lb), replicas(n, a, 1)] },
				target,
				answer: (rules) => {
					if (rules.ignoreRest) return target;
					return downtime((1 - target / MONTH) / rest(rules));
				}
			};
		}
		if (classId === 'k-of-n') {
			const [k, n] = rng.pick([
				[2, 3],
				[3, 5],
				[2, 4],
				[3, 4],
				[4, 5]
			] as const);
			const a = rng.pick([99000, 98000, 95000, 97000, 99500, 90000]);
			const group = (rules: Rules): number =>
				rules.anyOfN ? anyOf(p(a), n) : rules.allOfN ? p(a) ** n : atLeast(p(a), n, k);
			return {
				classId,
				text: chainText(
					`- кластер из ${n} узлов, у каждого ${percent(a)}; кластер работает, пока доступны не меньше ${k} узлов (кворум);`
				),
				tree: tail(replicas(n, a, k)),
				target: null,
				answer: (rules) => downtime(chain(group(rules), rules))
			};
		}
		const need = rng.int(2, 4);
		const spare = rng.int(1, 2);
		const n = need + spare;
		const a = rng.pick([99000, 98000, 97000, 99500, 95000, 90000]);
		const loss = rng.pick([20, 30, 40, 50, 60]);
		const group = (rules: Rules): number => {
			if (rules.anyOfN) return anyOf(p(a), n);
			if (rules.ignoreSpare) return p(a) ** need;
			const full = atLeast(p(a), n, need);
			return rules.degradedIgnored ? full : full + (1 - loss / 100) * exactly(p(a), n, need - 1);
		};
		return {
			classId,
			text: chainText(
				`- приложение: нагрузку полностью выдерживают ${need} работающих экземпляра${need > 4 ? 'ов' : ''}, развёрнуто N+${spare} = ${n}, у каждого ${percent(a)}; когда работающих ровно ${need - 1}, приложение перегружено и отвечает ошибкой на ${loss} % запросов — это время входит в простой с весом ${loss} %; ${need === 2 ? 'когда не работает ни один' : `когда работающих меньше ${need - 1}`}, приложение недоступно;`
			),
			tree: tail({
				kind: 'capacity',
				need,
				loss,
				items: Array.from({ length: n }, (_, i) => comp(`node${i}`, a))
			}),
			target: null,
			answer: (rules) => downtime(chain(group(rules), rules))
		};
	}
	if (classId === 'retries') {
		const gw = rng.pick([99990, 99995, 99980]);
		const svc = rng.pick([99950, 99990, 99980]);
		const long = rng.pick([10, 20, 30, 50, 100]);
		const fail = rng.pick([1000, 2000, 3000, 5000]);
		const r = rng.int(2, 4);
		const dep = (rules: Rules): number => {
			const L = p(long);
			const f = p(fail);
			if (rules.noRetry) return (1 - L) * (1 - f);
			if (rules.retryMasksAll) return 1 - (L + (1 - L) * f) ** r;
			return (1 - L) * (1 - f ** r);
		};
		return {
			classId,
			text: [
				`- шлюз API — ${percent(gw)};`,
				`- сервис заказов — ${percent(svc)};`,
				`- зависимость \`pricing\`, которую сервис вызывает с повторами: всего до ${r} попыток на запрос. В среднем ${percent(long)} времени \`pricing\` находится в длительном отказе — тогда неуспешны все попытки. В остальное время каждая попытка независимо неуспешна с вероятностью ${percent(fail)}. Запрос успешен, если успешна хоть одна попытка.`
			],
			tree: {
				kind: 'all',
				items: [
					comp('gw', gw),
					comp('svc', svc),
					comp('pricing-long', UNIT - long),
					{ kind: 'atLeast', k: 1, items: Array.from({ length: r }, (_, i) => comp(`try${i}`, UNIT - fail)) }
				]
			},
			target: null,
			answer: (rules) => downtime(p(gw) * p(svc) * dep(rules))
		};
	}
	if (classId === 'zone-failure' || classId === 'quorum-zones') {
		const pz = rng.pick([100, 200, 300, 500, 1000, 1500]);
		const a = rng.pick([90000, 95000, 96000, 97000, 98000, 99000, 99500]);
		const zoned = classId === 'zone-failure';
		const [perZone, k] = zoned
			? rng.pick([
					[[2, 2], 1],
					[[3, 3], 1],
					[[1, 1, 1], 1],
					[[2, 2, 2], 1],
					[[1, 1], 1]
				] as const)
			: rng.pick([
					[[1, 1, 1], 2],
					[[2, 2, 1], 3],
					[[2, 1, 1], 3],
					[[3, 2, 2], 4],
					[[2, 2, 2], 4]
				] as const);
		const n = perZone.reduce((s, m) => s + m, 0);
		const items: Node[] = [];
		perZone.forEach((m, z) => {
			for (let i = 0; i < m; i += 1)
				items.push({ kind: 'all', items: [comp(`zone${z}`, UNIT - pz), comp(`r${z}-${i}`, a)] });
		});
		const zones = perZone.map((m, z) => `зона ${String.fromCharCode(97 + z)} — ${m}`).join(', ');
		return {
			classId,
			text: [
				`- ${zoned ? 'реплики сервиса' : 'узлы кластера'}: всего ${n}, по зонам: ${zones}; ${zoned ? 'у каждой реплики' : 'у каждого узла'} ${percent(a)} в исправной зоне;`,
				`- каждая зона независимо недоступна ${percent(pz)} времени — тогда недоступны все её ${zoned ? 'реплики' : 'узлы'};`,
				zoned
					? '- сервис работает, пока доступна хотя бы одна реплика.'
					: `- кластер работает, пока доступны не меньше ${k} узлов (кворум).`
			],
			tree: { kind: 'atLeast', k, items },
			target: null,
			answer: (rules) => {
				if (rules.ignoreZone) return downtime(atLeast(p(a), n, k));
				if (rules.independentReplicas) return downtime(atLeast(p(a) * (1 - p(pz)), n, k));
				if (rules.anyOfN) return downtime(zonedAtLeast(perZone, p(a), p(pz), 1));
				return downtime(zonedAtLeast(perZone, p(a), p(pz), k));
			}
		};
	}
	const paths = rng.int(2, 3);
	const app = rng.pick(REPLICA);
	const cache = rng.pick([99000, 99500, 99900]);
	const db = rng.pick(DB);
	const path = p(app) * p(cache);
	return {
		classId,
		text: [
			`- ${paths} независимых пути обработки; путь — экземпляр приложения (${percent(app)}) и его собственный кэш (${percent(cache)}); путь работает, если работают оба;`,
			`- все пути пишут в одну общую базу данных — ${percent(db)};`,
			'- запрос обслужен, если работает хотя бы один путь и база данных.'
		],
		tree: {
			kind: 'all',
			items: [
				{
					kind: 'atLeast',
					k: 1,
					items: Array.from({ length: paths }, (_, i) => ({
						kind: 'all' as const,
						items: [comp(`app${i}`, app), comp(`cache${i}`, cache)]
					}))
				},
				comp('db', db)
			]
		},
		target: null,
		answer: (rules) => {
			if (rules.pathParallel) return downtime(anyOf(path * p(db), paths));
			if (rules.parallelIgnored) return downtime(path * p(db));
			return downtime(anyOf(path, paths) * p(db));
		}
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The statement.

function describe(p: Params): string {
	const lines =
		p.classId === 'inverse'
			? [
					'Система обслуживает запрос, только если работают все её части (отказы независимы):',
					'',
					...p.text,
					'- база данных — её доступность нужно выбрать.',
					'',
					`Система должна быть недоступна в среднем не больше ${p.target} мин за 30 суток (43 200 минут). Какой наибольший средний простой за 30 суток может быть у базы данных, чтобы система уложилась в этот предел? Введите число минут, округлённое до сотых, например \`12.34\`.`
				]
			: [
					p.classId === 'zone-failure' || p.classId === 'quorum-zones'
						? 'Отказы реплик и зон независимы, кроме того, что отказ зоны выключает всё внутри неё.'
						: p.classId === 'shared-dependency' || p.classId === 'retries'
							? 'Запрос проходит через компоненты ниже; отказы компонентов независимы (кроме сказанного явно).'
							: 'Запрос последовательно проходит через все части системы; отказы компонентов независимы, доступность указана как доля времени:',
					'',
					...p.text,
					...(p.classId === 'k-of-n' || p.classId === 'n-plus-one' || p.classId === 'quorum-zones'
						? [
								'',
								'Вероятность, что из m независимых узлов с доступностью a работают ровно j: C(m, j) · a^j · (1 − a)^(m − j), где C(m, j) — число сочетаний.'
							]
						: []),
					'',
					'Сколько минут в среднем за 30 суток (43 200 минут) система недоступна? Введите число минут, округлённое до сотых, например `12.34`.'
				];
	return lines.join('\n');
}

// An independent reference: enumerates every up/down state of the distinct components of the structure.
const PYTHON_REFERENCE = `import json, itertools

data = json.loads(input())
tree = data["tree"]
probs = {}

def collect(node):
    if node["kind"] == "comp":
        probs[node["id"]] = node["a"] / 100000
    else:
        for item in node["items"]:
            collect(item)

collect(tree)
ids = sorted(probs)

# The share of requests served in a state: 1 or 0, except a capacity group one item short of its need.
def served(node, up):
    if node["kind"] == "comp":
        return 1.0 if up[node["id"]] else 0.0
    values = [served(item, up) for item in node["items"]]
    if node["kind"] == "all":
        out = 1.0
        for v in values:
            out *= v
        return out
    count = sum(1 for v in values if v == 1.0)
    if node["kind"] == "atLeast":
        return 1.0 if count >= node["k"] else 0.0
    if count >= node["need"]:
        return 1.0
    return 1 - node["loss"] / 100 if count == node["need"] - 1 else 0.0

availability = 0.0
for states in itertools.product((True, False), repeat=len(ids)):
    up = dict(zip(ids, states))
    share = served(tree, up)
    if share:
        p = 1.0
        for i, s in zip(ids, states):
            p *= probs[i] if s else 1 - probs[i]
        availability += p * share
if data["target"] is None:
    print(repr((1 - availability) * 43200))
else:
    allowed = 1 - data["target"] / 43200
    print(repr((1 - allowed / availability) * 43200))
`;

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'middle/series-parallel': ['parallel-ignored', 'min-of-chain'],
	'middle/k-of-n': ['any-of-n', 'all-of-n'],
	'middle/n-plus-one': ['ignore-spare', 'any-of-n', 'degraded-ignored'],
	'middle/inverse': ['ignore-rest', 'parallel-ignored'],
	'senior/retries': ['no-retry', 'retry-masks-all'],
	'senior/zone-failure': ['ignore-zone', 'independent-replicas'],
	'senior/quorum-zones': ['ignore-zone', 'any-of-n'],
	'senior/shared-dependency': ['path-parallel', 'parallel-ignored']
};

/** A wrong value is caught when it is far outside the tolerance of the answer. */
const distinct = (right: number, wrong: number): boolean =>
	Math.abs(right - wrong) > 3 * EPS * Math.max(1, Math.abs(right), Math.abs(wrong));

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 300; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = p.answer(RIGHT);
		if (!(answer > 0.05 && answer < MONTH)) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = p.answer({ ...RIGHT, ...change });
				return [id, distinct(answer, value) ? value : null];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'float_eps', value: answer, eps: EPS }
		});
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ tree: p.tree, target: p.target })
			}),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'float_eps' as const, value, eps: EPS } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 300 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
