// Capacity estimate: how many instances a service needs across availability zones to serve the peak with one zone
// lost, given the binding limit of one instance — CPU with a mix of request kinds, the database connection pool, or
// memory per in-flight request — and a target utilization. Every rule of the model is in the statement.
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

interface Params {
	service: string;
	avgRps: number;
	peakFactor: number;
	cores: number;
	/** CPU milliseconds per request: one kind, or two kinds with the share of the first in percent. */
	cpu: { kind: 'single'; ms: number } | { kind: 'mix'; share: number; ms1: number; ms2: number };
	pool: { connections: number; holdMs: number } | null;
	memory: { ramMb: number; baseMb: number; perRequestMb: number; latencyMs: number } | null;
	utilization: number;
	zones: number;
	/** Reserve class X: each user request makes `calls` requests to the service, a cache in front absorbs `hitPercent`. */
	fanout?: { calls: number; hitPercent: number };
}

interface Rules {
	peak: boolean;
	zoneLoss: boolean;
	utilization: boolean;
	allLimits: boolean;
	weightedCost: boolean;
	fanout: boolean;
	missShare: boolean;
}

const RIGHT: Rules = {
	peak: true,
	zoneLoss: true,
	utilization: true,
	allLimits: true,
	weightedCost: true,
	fanout: true,
	missShare: true
};

/** `<usable rps of an instance> <instances per zone> <instances in total>`. */
function estimate(p: Params, rules: Rules): string {
	const cpuMs =
		p.cpu.kind === 'single'
			? p.cpu.ms
			: rules.weightedCost
				? (p.cpu.share * p.cpu.ms1 + (100 - p.cpu.share) * p.cpu.ms2) / 100
				: (p.cpu.ms1 + p.cpu.ms2) / 2;
	const limits = [Math.floor((p.cores * 1000) / cpuMs)];
	if (rules.allLimits && p.pool) limits.push(Math.floor((p.pool.connections * 1000) / p.pool.holdMs));
	if (rules.allLimits && p.memory) {
		const concurrent = Math.floor((p.memory.ramMb - p.memory.baseMb) / p.memory.perRequestMb);
		limits.push(Math.floor((concurrent * 1000) / p.memory.latencyMs));
	}
	const capacity = Math.min(...limits);
	const usable = rules.utilization ? Math.floor((capacity * p.utilization) / 100) : capacity;
	// The load in hundredths of a request per second when a cache passes a percentage of it: integers only.
	let load = rules.peak ? p.avgRps * p.peakFactor : p.avgRps;
	let scale = 1;
	if (p.fanout) {
		const calls = rules.fanout ? p.fanout.calls : 1;
		const passed = rules.missShare ? 100 - p.fanout.hitPercent : p.fanout.hitPercent;
		load *= calls * passed;
		scale = 100;
	}
	const needed = Math.ceil(load / (usable * scale));
	const perZone = Math.ceil(needed / (rules.zoneLoss ? p.zones - 1 : p.zones));
	return `${usable} ${perZone} ${perZone * p.zones}`;
}

const SERVICES = ['catalog-api', 'orders-api', 'search-gateway', 'profile-service', 'checkout-api', 'feed-service'];

function scenario(rng: Rng, classId: string): Params {
	const p: Params = {
		service: rng.pick(SERVICES),
		avgRps: rng.int(30, 400) * 10,
		peakFactor: rng.int(2, 5),
		cores: rng.pick([2, 4, 8, 16]),
		cpu: { kind: 'single', ms: rng.int(2, 9) },
		pool: null,
		memory: null,
		utilization: rng.pick([50, 60, 65, 70, 75, 80]),
		zones: rng.int(2, 4)
	};
	if (classId === 'fanout-cache') {
		p.fanout = { calls: rng.int(2, 6), hitPercent: rng.pick([50, 60, 70, 75, 80, 90]) };
	} else if (classId === 'cpu-mix') {
		// The weighted mean cost is a whole number of milliseconds.
		for (;;) {
			const share = rng.pick([60, 70, 75, 80, 90]);
			const ms1 = rng.int(2, 12);
			const ms2 = rng.int(15, 60);
			if ((share * ms1 + (100 - share) * ms2) % 100 === 0) {
				p.cpu = { kind: 'mix', share, ms1, ms2 };
				break;
			}
		}
	} else if (classId === 'db-pool') {
		p.pool = { connections: rng.pick([10, 16, 20, 25, 32, 40, 50]), holdMs: rng.int(4, 30) * 5 };
	} else {
		p.memory = {
			ramMb: rng.pick([1024, 2048, 4096]),
			baseMb: rng.int(4, 12) * 32,
			perRequestMb: rng.pick([8, 12, 16, 24, 32, 48]),
			latencyMs: rng.int(4, 40) * 10
		};
	}
	return p;
}

function describe(p: Params): string {
	const limits: string[] = [];
	if (p.cpu.kind === 'single') {
		limits.push(
			`- процессор: ядер у инстанса — ${p.cores}, каждый запрос занимает ${p.cpu.ms} мс процессорного времени — инстанс выдерживает ${p.cores} · 1000 / ${p.cpu.ms} запросов в секунду;`
		);
	} else {
		limits.push(
			`- процессор: ядер у инстанса — ${p.cores}; ${p.cpu.share} % запросов занимают по ${p.cpu.ms1} мс процессорного времени, остальные ${100 - p.cpu.share} % — по ${p.cpu.ms2} мс; инстанс выдерживает ${p.cores} · 1000 / (среднее процессорное время одного запроса) запросов в секунду;`
		);
	}
	if (p.pool) {
		limits.push(
			`- пул соединений с базой: ${p.pool.connections} соединений на инстанс, каждый запрос держит одно соединение ${p.pool.holdMs} мс — пул пропускает ${p.pool.connections} · 1000 / ${p.pool.holdMs} запросов в секунду;`
		);
	}
	if (p.memory) {
		limits.push(
			`- память: у инстанса ${p.memory.ramMb} МБ, сам процесс занимает ${p.memory.baseMb} МБ, каждый запрос в обработке — ещё ${p.memory.perRequestMb} МБ; одновременно в обработке не больше ⌊(${p.memory.ramMb} − ${p.memory.baseMb}) / ${p.memory.perRequestMb}⌋ запросов, каждый обрабатывается ${p.memory.latencyMs} мс — инстанс выдерживает (число одновременных запросов) · 1000 / ${p.memory.latencyMs} запросов в секунду;`
		);
	}
	return [
		`Сервис \`${p.service}\` разворачивается в ${p.zones} зонах доступности, в каждой зоне одинаковое число одинаковых инстансов. Оцените ёмкость по правилам модели.`,
		'',
		'Ограничения одного инстанса (каждое округляется вниз до целого числа запросов в секунду):',
		'',
		...limits,
		'',
		'Правила модели:',
		'',
		p.fanout
			? `- Пользователи присылают в среднем ${p.avgRps} запросов в секунду, в пиковый час — в ${p.peakFactor} ${p.peakFactor === 5 ? 'раз' : 'раза'} больше. Каждый пользовательский запрос порождает ${p.fanout.calls} ${p.fanout.calls < 5 ? 'обращения' : 'обращений'} к сервису \`${p.service}\`; перед сервисом стоит кэш с долей попаданий ${p.fanout.hitPercent} %: обращения, попавшие в кэш, до сервиса не доходят.`
			: `- Средняя нагрузка — ${p.avgRps} запросов в секунду, в пиковый час она в ${p.peakFactor} ${p.peakFactor === 5 ? 'раз' : 'раза'} выше.`,
		'- Ёмкость инстанса — наименьшее из его ограничений.',
		`- Рабочая ёмкость инстанса — ${p.utilization} % ёмкости, округление вниз до целого: выше этой загрузки инстанс не нагружают.`,
		'- Пиковая нагрузка должна обслуживаться рабочей ёмкостью инстансов даже при отказе одной зоны целиком; число инстансов в зоне — наименьшее, при котором это выполняется.',
		'',
		'Введите три числа через пробел: рабочую ёмкость одного инстанса (запросов в секунду), минимальное число инстансов в одной зоне и соответствующее ему общее число инстансов. Например: `150 4 12`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json
from fractions import Fraction

p = json.loads(input())
cpu = p["cpu"]
if cpu["kind"] == "single":
    cost = Fraction(cpu["ms"])
else:
    cost = Fraction(cpu["share"], 100) * cpu["ms1"] + Fraction(100 - cpu["share"], 100) * cpu["ms2"]
limits = [int(Fraction(p["cores"] * 1000) / cost)]
if p["pool"]:
    limits.append(p["pool"]["connections"] * 1000 // p["pool"]["holdMs"])
if p["memory"]:
    m = p["memory"]
    concurrent = (m["ramMb"] - m["baseMb"]) // m["perRequestMb"]
    limits.append(concurrent * 1000 // m["latencyMs"])
usable = min(limits) * p["utilization"] // 100
peak = Fraction(p["avgRps"] * p["peakFactor"])
fanout = p.get("fanout")
if fanout:
    peak = peak * fanout["calls"] * Fraction(100 - fanout["hitPercent"], 100)
per_zone = 0
while (p["zones"] - 1) * per_zone * usable < peak:
    per_zone += 1
print(usable, per_zone, per_zone * p["zones"])
`;

const WRONG: Record<string, Partial<Rules>> = {
	'average-load': { peak: false },
	'no-zone-loss': { zoneLoss: false },
	'full-utilization': { utilization: false },
	'cpu-only': { allLimits: false },
	'simple-mean-cost': { weightedCost: false },
	'ignore-fanout': { fanout: false },
	'hits-as-load': { missShare: false }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	'cpu-mix': ['average-load', 'no-zone-loss', 'full-utilization', 'simple-mean-cost'],
	'db-pool': ['average-load', 'no-zone-loss', 'full-utilization', 'cpu-only'],
	memory: ['average-load', 'no-zone-loss', 'full-utilization', 'cpu-only'],
	'fanout-cache': ['average-load', 'no-zone-loss', 'full-utilization', 'ignore-fanout', 'hits-as-load']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	// Scenarios are drawn until the instance count is realistic and every misconception of the class changes the answer.
	for (let tries = 0; tries < 500; tries += 1) {
		const p = scenario(rng, input.classId);
		const answer = estimate(p, RIGHT);
		const total = Number(answer.split(' ')[2]);
		if (Number(answer.split(' ')[0]) < 20 || total < 6 || total > 120) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = estimate(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		if ((REQUIRED[input.classId] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify(p) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 500 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
