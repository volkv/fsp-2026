// A HorizontalPodAutoscaler tick by tick under the formulas the statement gives: ceil(current · value / target) with
// the 0.1 tolerance and the largest proposal of several metrics, the stabilization windows, the rate policies of
// scaling up and down with selectPolicy, and the bounds. The candidate gives the number of replicas after every tick.
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

interface Policy {
	type: 'Pods' | 'Percent';
	value: number;
	period: number;
}

interface Direction {
	window: number;
	select: 'Max' | 'Min';
	policies: Policy[];
}

interface Metric {
	kind: 'cpu' | 'rps';
	target: number;
	values: number[];
}

interface Params {
	name: string;
	initial: number;
	min: number;
	max: number;
	metrics: Metric[];
	up: Direction;
	down: Direction;
	ticks: number;
}

interface Rules {
	ignoreTolerance: boolean;
	firstMetric: boolean;
	roundNearest: boolean;
	noStabilization: boolean;
	baseCurrent: boolean;
	selectFlip: boolean;
}

const RIGHT: Rules = {
	ignoreTolerance: false,
	firstMetric: false,
	roundNearest: false,
	noStabilization: false,
	baseCurrent: false,
	selectFlip: false
};

const TICK = 15;
const ceilDiv = (a: number, b: number): number => Math.ceil(a / b - 1e-9);

function replicas(p: Params, r: Rules): string[] {
	let c = p.initial;
	const recs: { t: number; rec: number }[] = [];
	const changes: { t: number; delta: number }[] = [];
	const out: string[] = [];
	for (let k = 1; k <= p.ticks; k += 1) {
		const t = k * TICK;
		const proposals = p.metrics.map((m) => {
			const v = m.values[k - 1] ?? m.target;
			if (!r.ignoreTolerance && Math.abs(v - m.target) * 10 <= m.target) return c;
			return r.roundNearest ? Math.floor((2 * c * v + m.target) / (2 * m.target)) : ceilDiv(c * v, m.target);
		});
		const rec = r.firstMetric ? (proposals[0] ?? c) : Math.max(...proposals);
		const within = (window: number): number[] => [rec, ...recs.filter((x) => x.t > t - window).map((x) => x.rec)];
		const up = Math.min(...within(p.up.window));
		const down = r.noStabilization ? rec : Math.max(...within(p.down.window));
		recs.push({ t, rec });
		let s = c;
		if (s < up) s = up;
		if (s > down) s = down;
		const moved = (period: number, sign: number): number =>
			changes
				.filter((x) => x.t > t - period && Math.sign(x.delta) === sign)
				.reduce((sum, x) => sum + Math.abs(x.delta), 0);
		const upLimits = p.up.policies.map((pol) => {
			const base = r.baseCurrent ? c : c - moved(pol.period, 1);
			return pol.type === 'Pods' ? base + pol.value : ceilDiv(base * (100 + pol.value), 100);
		});
		const downLimits = p.down.policies.map((pol) => {
			const base = r.baseCurrent ? c : c + moved(pol.period, -1);
			return pol.type === 'Pods' ? base - pol.value : ceilDiv(base * (100 - pol.value), 100);
		});
		const upMax = (p.up.select === 'Max') !== r.selectFlip;
		const downMax = (p.down.select === 'Max') !== r.selectFlip;
		const upLimit = Math.max(c, upMax ? Math.max(...upLimits) : Math.min(...upLimits));
		const downLimit = Math.min(c, downMax ? Math.min(...downLimits) : Math.max(...downLimits));
		const high = Math.min(p.max, upLimit);
		const low = Math.max(p.min, downLimit);
		const next = s > high ? high : s < low ? low : s;
		if (next !== c) changes.push({ t, delta: next - c });
		c = next;
		out.push(String(c));
	}
	return out;
}

// ---- Drawing ----

const NAMES = ['api', 'checkout', 'search', 'feed', 'ingest', 'render', 'gateway', 'pricing'];

function series(rng: Rng, target: number, factors: readonly number[]): number[] {
	return factors.map((f) => Math.max(1, Math.round(target * f)));
}

function scenario(rng: Rng, classId: string): Params {
	const ticks = rng.int(8, 9);
	const cpuTarget = rng.pick([50, 60, 70, 75, 80]);
	const rpsTarget = rng.pick([100, 150, 200, 250, 400]);
	const between = (a: number, b: number): number => a + rng.int(0, Math.round((b - a) * 100)) / 100;
	const p: Params = {
		name: rng.pick(NAMES),
		initial: rng.int(3, 8),
		min: 2,
		max: rng.int(14, 30),
		metrics: [],
		up: {
			window: 0,
			select: 'Max',
			policies: [
				{ type: 'Percent', value: 100, period: 15 },
				{ type: 'Pods', value: 4, period: 15 }
			]
		},
		down: { window: rng.pick([0, 15, 30]), select: 'Max', policies: [{ type: 'Percent', value: 100, period: 15 }] },
		ticks
	};
	if (classId === 'tolerance-metrics') {
		const near = Array.from({ length: ticks }, () => (rng.bool(0.75) ? between(0.91, 1.09) : between(0.6, 1.5)));
		const driver = Array.from({ length: ticks }, () => between(0.5, 1.7));
		const cpuFirst = rng.bool();
		p.metrics = [
			{ kind: cpuFirst ? 'cpu' : 'rps', target: cpuFirst ? cpuTarget : rpsTarget, values: [] },
			{ kind: cpuFirst ? 'rps' : 'cpu', target: cpuFirst ? rpsTarget : cpuTarget, values: [] }
		];
		const [first, second] = p.metrics;
		if (first && second) {
			first.values = series(rng, first.target, rng.bool() ? near : driver);
			second.values = series(rng, second.target, first.values.length && rng.bool() ? driver : near);
		}
		return p;
	}
	if (classId === 'stabilization') {
		p.down = {
			window: rng.int(4, 10) * 15,
			select: 'Max',
			policies: [{ type: 'Percent', value: 100, period: 15 }]
		};
		const high = rng.int(2, 3);
		const factors = Array.from({ length: ticks }, (_, i) => (i < high ? between(1.2, 1.8) : between(0.3, 0.8)));
		p.metrics = [{ kind: 'cpu', target: cpuTarget, values: series(rng, cpuTarget, factors) }];
		if (rng.bool(0.4))
			p.metrics.push({
				kind: 'rps',
				target: rpsTarget,
				values: series(
					rng,
					rpsTarget,
					factors.map((f) => f * between(0.6, 0.95))
				)
			});
		return p;
	}
	if (classId === 'scale-up-policies') {
		p.initial = rng.int(2, 6);
		p.max = rng.int(20, 40);
		p.up = {
			window: rng.pick([0, 0, 15]),
			select: rng.pick(['Max', 'Min']),
			policies: rng.shuffle([
				{ type: 'Pods', value: rng.int(1, 4), period: rng.pick([30, 45, 60]) },
				{ type: 'Percent', value: rng.pick([50, 100, 200]), period: rng.pick([30, 45, 60]) }
			])
		};
		const start = rng.int(0, 2);
		const factors = Array.from({ length: ticks }, (_, i) => (i < start ? between(0.95, 1.05) : between(1.8, 4)));
		p.metrics = [{ kind: rng.bool() ? 'cpu' : 'rps', target: 0, values: [] }];
		const m = p.metrics[0];
		if (m) {
			m.target = m.kind === 'cpu' ? cpuTarget : rpsTarget;
			m.values = series(rng, m.target, factors);
		}
		return p;
	}
	p.initial = rng.int(12, 24);
	p.max = 30;
	p.min = rng.int(1, 3);
	p.down = {
		window: rng.pick([0, 15, 30]),
		select: rng.pick(['Max', 'Min']),
		policies: rng.shuffle([
			{ type: 'Pods', value: rng.int(1, 4), period: rng.pick([30, 45, 60]) },
			{ type: 'Percent', value: rng.pick([10, 20, 25, 50]), period: rng.pick([30, 45, 60]) }
		])
	};
	const factors = Array.from({ length: ticks }, () => between(0.1, 0.6));
	p.metrics = [{ kind: 'cpu', target: cpuTarget, values: series(rng, cpuTarget, factors) }];
	return p;
}

// ---- The statement ----

function manifest(p: Params): string {
	const direction = (d: Direction): Yaml => ({
		stabilizationWindowSeconds: d.window,
		selectPolicy: d.select,
		policies: d.policies.map((pol) => ({ type: pol.type, value: pol.value, periodSeconds: pol.period }))
	});
	return yamlText([
		{
			apiVersion: 'autoscaling/v2',
			kind: 'HorizontalPodAutoscaler',
			metadata: { name: p.name },
			spec: {
				scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: p.name },
				minReplicas: p.min,
				maxReplicas: p.max,
				metrics: p.metrics.map((m): Yaml =>
					m.kind === 'cpu'
						? {
								type: 'Resource',
								resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: m.target } }
							}
						: {
								type: 'Pods',
								pods: {
									metric: { name: 'http_requests_per_second' },
									target: { type: 'AverageValue', averageValue: String(m.target) }
								}
							}
				),
				behavior: { scaleUp: direction(p.up), scaleDown: direction(p.down) }
			}
		}
	]);
}

function describe(p: Params): string {
	const header = p.metrics.map((m) => (m.kind === 'cpu' ? 'утилизация CPU, %' : '`http_requests_per_second` на под'));
	return [
		`В момент 0 число реплик Deployment \`${p.name}\` — ${p.initial}; им управляет HorizontalPodAutoscaler из манифеста ниже. Значения метрик (средние по подам), которые контроллер видит на тактах:`,
		'',
		`| Такт, с | ${header.join(' | ')} |`,
		`|---|${header.map(() => '---').join('|')}|`,
		...Array.from(
			{ length: p.ticks },
			(_, i) => `| ${(i + 1) * TICK} | ${p.metrics.map((m) => String(m.values[i] ?? '')).join(' | ')} |`
		),
		'',
		'Контроллер срабатывает в моменты 15, 30, 45, … Новое число реплик применяется сразу. На такте в момент t при текущем числе реплик c:',
		'',
		'1. Каждая метрика даёт отношение r = значение / цель (`averageUtilization` или `averageValue`). Если |r − 1| ≤ 0,1, метрика предлагает c, иначе — ⌈c · r⌉ (точно, без промежуточного округления r). Рекомендация такта — наибольшее из предложений метрик.',
		'2. Стабилизация. up — наименьшая, down — наибольшая из рекомендаций: этого такта и прежних тактов с моментом строго больше t − `stabilizationWindowSeconds` (у up окно из `scaleUp`, у down — из `scaleDown`). Значение s = c; если s < up, то s = up; если s > down, то s = down.',
		'3. Скорость. У политики роста база — c минус сумма увеличений числа реплик на тактах с моментом строго больше t − `periodSeconds` этой политики; предел политики `Pods` — база + value, `Percent` — ⌈база · (100 + value) / 100⌉. У политики уменьшения база — c плюс сумма уменьшений за такой же промежуток; предел `Pods` — база − value, `Percent` — ⌈база · (100 − value) / 100⌉. `selectPolicy: Max` берёт политику, допускающую наибольшее изменение, `Min` — наименьшее. Предел роста не меньше c, предел уменьшения не больше c.',
		'4. Новое число реплик — s, поднятое до наибольшего из `minReplicas` и предела уменьшения, если s ниже его, и опущенное до наименьшего из `maxReplicas` и предела роста, если s выше его.',
		'',
		'Введите число реплик после каждого такта, по одному в строке, в порядке тактов. Например:',
		'',
		'```\n4\n6\n6\n5\n```'
	].join('\n');
}

// ---- The proof: an independent reading of the shown manifest ----

const PYTHON_REFERENCE = `${PY_YAML}from fractions import Fraction
import math

data = json.loads(sys.stdin.read())
spec = parse_yaml(data["yaml"])[0]["spec"]
table = data["table"]
c = data["initial"]
history = []  # (moment, recommendation)
moves = []  # (moment, new - old)

def targets():
    out = []
    for m in spec["metrics"]:
        if m["type"] == "Resource":
            out.append(Fraction(m["resource"]["target"]["averageUtilization"]))
        else:
            out.append(Fraction(m["pods"]["target"]["averageValue"]))
    return out

goal = targets()
for k, row in enumerate(table, start=1):
    t = 15 * k
    props = []
    for value, target in zip(row, goal):
        ratio = Fraction(value) / target
        props.append(c if abs(ratio - 1) <= Fraction(1, 10) else math.ceil(c * ratio))
    rec = max(props)
    b = spec["behavior"]
    up = min([rec] + [r for (m, r) in history if m > t - b["scaleUp"]["stabilizationWindowSeconds"]])
    down = max([rec] + [r for (m, r) in history if m > t - b["scaleDown"]["stabilizationWindowSeconds"]])
    history.append((t, rec))
    if c < up:
        s = up
    elif c > down:
        s = down
    else:
        s = c
    def limit(direction):
        rules = b[direction]
        values = []
        for pol in rules["policies"]:
            if direction == "scaleUp":
                base = c - sum(d for (m, d) in moves if m > t - pol["periodSeconds"] and d > 0)
                values.append(base + pol["value"] if pol["type"] == "Pods" else math.ceil(Fraction(base * (100 + pol["value"]), 100)))
            else:
                base = c + sum(-d for (m, d) in moves if m > t - pol["periodSeconds"] and d < 0)
                values.append(base - pol["value"] if pol["type"] == "Pods" else math.ceil(Fraction(base * (100 - pol["value"]), 100)))
        if direction == "scaleUp":
            return max(c, max(values) if rules["selectPolicy"] == "Max" else min(values))
        return min(c, min(values) if rules["selectPolicy"] == "Max" else max(values))
    high = min(spec["maxReplicas"], limit("scaleUp"))
    low = max(spec["minReplicas"], limit("scaleDown"))
    new = high if s > high else low if s < low else s
    if new != c:
        moves.append((t, new - c))
    c = new
    print(c)
`;

const WRONG: Record<string, Partial<Rules>> = {
	'ignore-tolerance': { ignoreTolerance: true },
	'first-metric': { firstMetric: true },
	'round-nearest': { roundNearest: true },
	'no-stabilization': { noStabilization: true },
	'base-current': { baseCurrent: true },
	'select-flip': { selectFlip: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'senior/tolerance-metrics': ['ignore-tolerance', 'first-metric'],
	'senior/stabilization': ['no-stabilization'],
	'senior/scale-up-policies': ['base-current', 'select-flip'],
	'senior/scale-down-policies': ['base-current', 'select-flip']
};

const same = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until every misconception the class must expose changes the answer.
	for (let tries = 0; tries < 400; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = replicas(p, RIGHT);
		if (new Set(answer).size < 3) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = replicas(p, { ...RIGHT, ...change });
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
		const table = Array.from({ length: p.ticks }, (_, i) => p.metrics.map((m) => m.values[i] ?? 0));
		return {
			instance,
			reference: () => ({
				kind: 'output',
				source: PYTHON_REFERENCE,
				stdin: JSON.stringify({ yaml, table, initial: p.initial })
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
