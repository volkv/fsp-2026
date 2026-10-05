// Risk-based selection of test areas under a budget of hours: risk is probability × impact, the selection rule is
// given exactly (by risk or by risk per hour, ties to the cheaper area, an area that does not fit is skipped), and at
// the senior level areas depend on each other, have two levels of checks, carry mandatory regulatory checks, or the
// best total risk within the budget is asked instead of the greedy pick.
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

interface Area {
	name: string;
	probability: number;
	impact: number;
	hours: number;
	/** Senior two-levels: hours of the API-level check (`hours` is the E2E check). */
	apiHours: number | null;
	/** Senior dependencies: the area that must be checked with this one. */
	dependsOn: number | null;
	/** Senior regulatory: the check is mandatory. */
	regulatory: boolean;
}

interface Params {
	areas: Area[];
	budget: number;
	/** Middle threshold: areas with impact at least this are mandatory. */
	threshold: number | null;
}

interface Rules {
	stop: boolean;
	sum: boolean;
	ignoreTies: boolean;
	byRisk: boolean;
	ignoreMandatory: boolean;
	ignoreDependencies: boolean;
	apiFull: boolean;
	greedy: boolean;
}

const RIGHT: Rules = {
	stop: false,
	sum: false,
	ignoreTies: false,
	byRisk: false,
	ignoreMandatory: false,
	ignoreDependencies: false,
	apiFull: false,
	greedy: false
};

const NAMES = [
	'Оплата',
	'Корзина',
	'Каталог',
	'Поиск',
	'Профиль',
	'Доставка',
	'Возвраты',
	'Уведомления',
	'Отчёты',
	'Авторизация',
	'Промокоды',
	'Отзывы',
	'Чат',
	'Импорт',
	'Подписки',
	'Бонусы'
];

const risk = (a: Area, rules: Rules): number => (rules.sum ? a.probability + a.impact : a.probability * a.impact);

/** The order of consideration: by risk (or risk per hour), ties to the cheaper area, then by the list. */
function order(p: Params, rules: Rules, density: boolean): number[] {
	const idx = p.areas.map((_, k) => k);
	const a = (k: number): Area => p.areas[k] as Area;
	return idx.sort((x, y) => {
		if (density && !rules.byRisk) {
			const d = risk(a(y), rules) * a(x).hours - risk(a(x), rules) * a(y).hours;
			if (d !== 0) return d;
			const r = risk(a(y), rules) - risk(a(x), rules);
			return r !== 0 ? r : x - y;
		}
		const r = risk(a(y), rules) - risk(a(x), rules);
		if (r !== 0) return r;
		if (!rules.ignoreTies && a(x).hours !== a(y).hours) return a(x).hours - a(y).hours;
		return x - y;
	});
}

/** Greedy: take each area in order while it fits; a misfit is skipped (or, by the misconception, ends the pick). */
function greedy(p: Params, rules: Rules, sequence: readonly number[], taken: Set<number>, budget: number): number {
	let left = budget;
	for (const k of sequence) {
		if (taken.has(k)) continue;
		// The area comes with the dependencies not yet taken.
		const group: number[] = [];
		for (let x: number | null = k; x !== null && !taken.has(x) && !group.includes(x);) {
			group.push(x);
			x = rules.ignoreDependencies ? null : (p.areas[x]?.dependsOn ?? null);
		}
		const cost = group.reduce((s, x) => s + (p.areas[x]?.hours ?? 0), 0);
		if (cost <= left) {
			for (const x of group) taken.add(x);
			left -= cost;
		} else if (rules.stop) break;
	}
	return left;
}

/** The subset of `pool` with the largest total risk within the budget; ties to fewer hours. Null when not unique. */
function best(p: Params, rules: Rules, pool: readonly number[], budget: number): number[] | null {
	let top: number[] = [];
	let topRisk = -1;
	let topHours = 0;
	let unique = true;
	for (let mask = 0; mask < 1 << pool.length; mask += 1) {
		const pick = pool.filter((_, b) => ((mask >> b) & 1) === 1);
		const hours = pick.reduce((s, k) => s + (p.areas[k]?.hours ?? 0), 0);
		if (hours > budget) continue;
		const total = pick.reduce((s, k) => s + risk(p.areas[k] as Area, rules), 0);
		if (total > topRisk || (total === topRisk && hours < topHours)) {
			top = pick;
			topRisk = total;
			topHours = hours;
			unique = true;
		} else if (total === topRisk && hours === topHours) unique = false;
	}
	return unique ? top : null;
}

function solve(p: Params, classId: string, rules: Rules): string | null {
	const taken = new Set<number>();
	const levels = new Map<number, 'E2E' | 'API'>();
	switch (classId) {
		case 'greedy-skip':
		case 'ties':
		case 'dependencies':
			greedy(p, rules, order(p, rules, false), taken, p.budget);
			break;
		case 'density':
			greedy(p, rules, order(p, rules, true), taken, p.budget);
			break;
		case 'threshold': {
			let left = p.budget;
			if (!rules.ignoreMandatory) {
				for (const [k, a] of p.areas.entries()) {
					if (a.impact >= (p.threshold ?? Infinity)) {
						taken.add(k);
						left -= a.hours;
					}
				}
			}
			greedy(p, rules, order(p, rules, false), taken, left);
			break;
		}
		case 'two-levels': {
			let left = p.budget;
			for (const k of order(p, rules, false)) {
				const a = p.areas[k] as Area;
				if (a.hours <= left) {
					levels.set(k, 'E2E');
					left -= a.hours;
				} else if ((a.apiHours ?? Infinity) <= left) {
					levels.set(k, 'API');
					left -= a.apiHours ?? 0;
				} else if (rules.stop) break;
			}
			const residual = p.areas.reduce((s, a, k) => {
				const r = risk(a, rules);
				const level = levels.get(k);
				return s + (level === 'E2E' ? 0 : level === 'API' ? (rules.apiFull ? 0 : Math.ceil(r / 2)) : r);
			}, 0);
			const picked = p.areas
				.map((a, k) => (levels.has(k) ? `${a.name}:${levels.get(k) ?? ''}` : null))
				.filter((x) => x !== null);
			return `${picked.join(' ')} | ${residual}`;
		}
		case 'regulatory':
		case 'knapsack': {
			const mandatory =
				classId === 'regulatory' && !rules.ignoreMandatory
					? p.areas.map((a, k) => (a.regulatory ? k : -1)).filter((k) => k >= 0)
					: [];
			for (const k of mandatory) taken.add(k);
			const left = p.budget - mandatory.reduce((s, k) => s + (p.areas[k]?.hours ?? 0), 0);
			const pool = p.areas.map((_, k) => k).filter((k) => !taken.has(k));
			if (rules.greedy) greedy(p, rules, order(p, rules, false), taken, left);
			else {
				const pick = best(p, rules, pool, left);
				if (!pick) return null;
				for (const k of pick) taken.add(k);
			}
			break;
		}
		default:
			throw new Error(`${descriptor.key}: unknown class ${classId}`);
	}
	const residual = p.areas.reduce((s, a, k) => s + (taken.has(k) ? 0 : risk(a, rules)), 0);
	const names = p.areas.filter((_, k) => taken.has(k)).map((a) => a.name);
	return `${names.length ? names.join(' ') : '-'} | ${residual}`;
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const count = grade === 'senior' ? rng.int(6, 8) : rng.int(6, 9);
	const names = rng.sample(NAMES, count);
	const ties = classId === 'ties';
	// For ties, few distinct risks: products of a narrow range of scores repeat.
	const areas: Area[] = names.map((name) => ({
		name,
		probability: ties ? rng.pick([2, 3, 4]) : rng.int(1, 5),
		impact: ties ? rng.pick([2, 3, 4]) : rng.int(1, 5),
		hours: rng.int(2, 16),
		apiHours: null,
		dependsOn: null,
		regulatory: false
	}));
	const total = areas.reduce((s, a) => s + a.hours, 0);
	const p: Params = { areas, budget: Math.round((total * rng.int(35, 65)) / 100), threshold: null };
	if (classId === 'threshold') p.threshold = rng.pick([4, 5]);
	if (classId === 'two-levels')
		for (const a of areas) a.apiHours = Math.max(1, Math.round((a.hours * rng.int(25, 50)) / 100));
	if (classId === 'dependencies') {
		// Each dependency points to an area earlier in the list: no cycles.
		for (let k = 1; k < areas.length; k += 1) {
			const a = areas[k];
			if (a && rng.bool(0.45)) a.dependsOn = rng.int(0, k - 1);
		}
	}
	if (classId === 'regulatory')
		for (const k of rng.sample(
			areas.map((_, i) => i),
			rng.int(1, 2)
		)) {
			const a = areas[k];
			if (a) a.regulatory = true;
		}
	return p;
}

function suits(p: Params, classId: string, answer: string): boolean {
	if (answer.startsWith('-')) return false;
	if (classId === 'threshold') {
		const mandatory = p.areas.filter((a) => a.impact >= (p.threshold ?? Infinity));
		const hours = mandatory.reduce((s, a) => s + a.hours, 0);
		return mandatory.length >= 1 && hours < p.budget;
	}
	if (classId === 'regulatory') {
		const hours = p.areas.filter((a) => a.regulatory).reduce((s, a) => s + a.hours, 0);
		return hours < p.budget;
	}
	return true;
}

function table(p: Params, classId: string): string[] {
	const headers = ['область', 'вероятность', 'влияние', classId === 'two-levels' ? 'E2E, ч' : 'часы'];
	if (classId === 'two-levels') headers.push('API, ч');
	if (classId === 'dependencies') headers.push('проверяется вместе с');
	if (classId === 'regulatory') headers.push('регуляторная');
	const rows = p.areas.map((a) => {
		const row = [a.name, String(a.probability), String(a.impact), String(a.hours)];
		if (classId === 'two-levels') row.push(String(a.apiHours ?? ''));
		if (classId === 'dependencies') row.push(a.dependsOn === null ? '-' : (p.areas[a.dependsOn]?.name ?? ''));
		if (classId === 'regulatory') row.push(a.regulatory ? 'да' : 'нет');
		return row;
	});
	const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)) + 2);
	const line = (cells: string[]): string =>
		cells
			.map((cell, c) => cell.padEnd(widths[c] ?? 0))
			.join('')
			.trimEnd();
	return ['```', line(headers), ...rows.map(line), '```'];
}

const RISK = 'Риск области — вероятность отказа × влияние отказа (оценки от 1 до 5).';
const TIES =
	'при равном риске раньше идёт область с меньшей стоимостью проверки, при равной стоимости — стоящая выше в таблице';
const ANSWER =
	'Введите через пробел выбранные области в порядке таблицы, затем знак `|` и остаточный риск — сумму рисков невыбранных областей.';

function describe(p: Params, classId: string): string {
	const out = [
		`На регрессию перед релизом есть ${p.budget} ч. Области продукта:`,
		'',
		...table(p, classId),
		'',
		RISK,
		''
	];
	switch (classId) {
		case 'greedy-skip':
		case 'ties':
			out.push(
				`Области рассматриваются по убыванию риска (${TIES}). Область берётся, если её стоимость помещается в оставшийся бюджет; если не помещается, её пропускают и рассматривают следующую.`,
				'',
				`${ANSWER} Например: \`Поиск Чат | 37\`.`
			);
			break;
		case 'density':
			out.push(
				'Области рассматриваются по убыванию риска на час проверки (риск ÷ часы); при равном значении раньше идёт область с большим риском, при равном риске — стоящая выше в таблице. Область берётся, если её стоимость помещается в оставшийся бюджет; если не помещается, её пропускают и рассматривают следующую.',
				'',
				`${ANSWER} Например: \`Поиск Чат | 37\`.`
			);
			break;
		case 'threshold':
			out.push(
				`Области с влиянием отказа ${p.threshold ?? 0} и выше критичны и проверяются обязательно — их берут первыми. Оставшийся бюджет распределяется по остальным областям по убыванию риска (${TIES}): область берётся, если помещается в оставшийся бюджет, иначе её пропускают и рассматривают следующую.`,
				'',
				`${ANSWER} Например: \`Поиск Чат | 37\`.`
			);
			break;
		case 'dependencies':
			out.push(
				`Область со значением в последнем столбце проверяют только вместе с названной областью (а ту — вместе с её зависимостью, если она есть). Области рассматриваются по убыванию собственного риска (${TIES}). Если область ещё не выбрана, её берут вместе со всеми ещё не выбранными областями её цепочки, когда их суммарная стоимость помещается в оставшийся бюджет; иначе область пропускают и рассматривают следующую.`,
				'',
				`${ANSWER} Например: \`Поиск Чат | 37\`.`
			);
			break;
		case 'two-levels':
			out.push(
				`Область можно проверить на уровне E2E (снимает весь её риск) или на уровне API (дешевле, снимает половину риска: остаётся половина, округлённая вверх). Области рассматриваются по убыванию риска (${TIES}); для каждой выбирается E2E, если он помещается в оставшийся бюджет, иначе API, если помещается он, иначе область пропускают.`,
				'',
				'Введите через пробел проверяемые области в порядке таблицы в виде `область:E2E` или `область:API`, затем знак `|` и остаточный риск — сумму рисков, оставшихся после проверок. Например: `Поиск:E2E Чат:API | 41`.'
			);
			break;
		case 'regulatory':
			out.push(
				'Регуляторные области проверяются обязательно. Оставшийся бюджет нужно потратить на набор остальных областей с наибольшим суммарным риском; если таких наборов несколько — на тот, что требует меньше часов. Гарантируется, что такой набор один.',
				'',
				`${ANSWER} Например: \`Поиск Чат | 37\`.`
			);
			break;
		case 'knapsack':
			out.push(
				'Нужно выбрать набор областей с наибольшим суммарным риском, суммарная стоимость которого помещается в бюджет; если таких наборов несколько — тот, что требует меньше часов. Гарантируется, что такой набор один.',
				'',
				`${ANSWER} Например: \`Поиск Чат | 37\`.`
			);
			break;
	}
	return out.join('\n');
}

const PYTHON_REFERENCE = `import json
from itertools import combinations

p = json.loads(input())
cls = p["classId"]
areas = p["areas"]
n = len(areas)
budget = p["budget"]
risk = [a["probability"] * a["impact"] for a in areas]
by_risk = sorted(range(n), key=lambda k: (-risk[k], areas[k]["hours"], k))


def answer(chosen, rest):
    names = [areas[k]["name"] for k in range(n) if k in chosen]
    return (" ".join(names) or "-") + f" | {rest}"


def take_in_order(seq, chosen, left):
    for k in seq:
        if k in chosen:
            continue
        chain, x = [], k
        while x is not None and x not in chosen and x not in chain:
            chain.append(x)
            x = areas[x]["dependsOn"]
        cost = sum(areas[x]["hours"] for x in chain)
        if cost <= left:
            chosen.update(chain)
            left -= cost
    return chosen


def best(pool, left):
    top = None
    for size in range(len(pool) + 1):
        for pick in combinations(pool, size):
            hours = sum(areas[k]["hours"] for k in pick)
            if hours <= left:
                key = (sum(risk[k] for k in pick), -hours)
                if top is None or key > top[0]:
                    top = (key, set(pick))
    return top[1]


if cls in ("greedy-skip", "ties", "dependencies"):
    chosen = take_in_order(by_risk, set(), budget)
elif cls == "density":
    seq = sorted(range(n), key=lambda k: (-risk[k] / areas[k]["hours"], -risk[k], k))
    chosen = take_in_order(seq, set(), budget)
elif cls == "threshold":
    must = {k for k in range(n) if areas[k]["impact"] >= p["threshold"]}
    chosen = take_in_order(by_risk, set(must), budget - sum(areas[k]["hours"] for k in must))
elif cls in ("regulatory", "knapsack"):
    must = {k for k in range(n) if areas[k]["regulatory"]}
    left = budget - sum(areas[k]["hours"] for k in must)
    chosen = must | best([k for k in range(n) if k not in must], left)
if cls == "two-levels":
    level, left = {}, budget
    for k in by_risk:
        if areas[k]["hours"] <= left:
            level[k], left = "E2E", left - areas[k]["hours"]
        elif areas[k]["apiHours"] <= left:
            level[k], left = "API", left - areas[k]["apiHours"]
    rest = sum(0 if level.get(k) == "E2E" else (risk[k] + 1) // 2 if level.get(k) == "API" else risk[k] for k in range(n))
    print(" ".join(f"{areas[k]['name']}:{level[k]}" for k in range(n) if k in level) + f" | {rest}")
else:
    print(answer(chosen, sum(risk[k] for k in range(n) if k not in chosen)))
`;

const WRONG: Record<string, Partial<Rules>> = {
	'stop-at-misfit': { stop: true },
	'sum-not-product': { sum: true },
	'ignore-tie-rule': { ignoreTies: true },
	'risk-not-density': { byRisk: true },
	'ignore-mandatory': { ignoreMandatory: true },
	'ignore-dependencies': { ignoreDependencies: true },
	'api-full': { apiFull: true },
	'greedy-not-optimal': { greedy: true }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	'greedy-skip': ['stop-at-misfit', 'sum-not-product'],
	density: ['risk-not-density'],
	threshold: ['ignore-mandatory'],
	ties: ['ignore-tie-rule'],
	dependencies: ['ignore-dependencies'],
	'two-levels': ['api-full'],
	regulatory: ['greedy-not-optimal', 'ignore-mandatory'],
	knapsack: ['greedy-not-optimal']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { grade, classId } = input;
	// Scenarios are drawn until the question is well posed and every misconception the class must expose changes
	// the answer.
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = scenario(rng, grade, classId);
		const answer = solve(p, classId, RIGHT);
		if (answer === null || !suits(p, classId, answer)) continue;
		const wrong: Record<string, string | null> = {};
		for (const [id, change] of Object.entries(WRONG)) {
			const value = solve(p, classId, { ...RIGHT, ...change });
			wrong[id] = value === null || value === answer ? null : value;
		}
		if ((REQUIRED[classId] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, classId), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin: JSON.stringify({ classId, ...p }) }),
			wrong: () =>
				Object.fromEntries(
					Object.entries(wrong).map(([id, value]) => [
						id,
						value === null ? null : { kind: 'answer' as const, answer: { kind: 'tokens' as const, value } }
					])
				)
		};
	}
	throw new Error(`${descriptor.key}: no scenario for ${grade}/${classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
