// Pairwise coverage under constraints: which value pairs a test set must cover when some combinations are forbidden
// («A is incompatible with B», «A only with B»), which tests are invalid or redundant, and at the senior level the
// pairs no valid test can ever contain because constraints chain, and the smallest addition to a set.
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

interface Parameter {
	name: string;
	values: string[];
}

/** By names: `forbid` — value `a` of one parameter and value `b` of another never meet; `only` — `a` only with one of `b`. */
interface ConstraintSpec {
	kind: 'forbid' | 'only';
	a: [string, string];
	b: [string, string[]];
	text: string;
}

/** By indexes into the parameters of an instance. */
interface Constraint {
	kind: 'forbid' | 'only';
	a: [number, number];
	b: [number, number[]];
	text: string;
}

interface Params {
	parameters: Parameter[];
	constraints: Constraint[];
	/** Tests as value indexes, one per parameter. */
	tests: number[][];
	/** The two parameters whose pair table is asked. */
	focus: [number, number] | null;
}

interface Rules {
	forbidden: boolean;
	symmetric: boolean;
	keepInvalid: boolean;
	reachable: boolean;
}

const RIGHT: Rules = { forbidden: true, symmetric: false, keepInvalid: false, reachable: true };

const DOMAINS: { parameters: Parameter[]; constraints: ConstraintSpec[] }[] = [
	{
		parameters: [
			{ name: 'Браузер', values: ['Chrome', 'Firefox', 'Safari', 'Edge'] },
			{ name: 'ОС', values: ['Windows', 'macOS', 'Linux'] },
			{ name: 'Экран', values: ['десктоп', 'планшет', 'телефон'] },
			{ name: 'Язык', values: ['ru', 'en', 'kk'] },
			{ name: 'Тема', values: ['светлая', 'тёмная'] }
		],
		constraints: [
			{ kind: 'only', a: ['Браузер', 'Safari'], b: ['ОС', ['macOS']], text: 'Safari бывает только на macOS' },
			{ kind: 'forbid', a: ['Браузер', 'Edge'], b: ['ОС', ['Linux']], text: 'Edge не ставится на Linux' },
			{
				kind: 'forbid',
				a: ['ОС', 'macOS'],
				b: ['Экран', ['телефон']],
				text: 'эмулятор телефона на macOS не поднимается'
			},
			{
				kind: 'only',
				a: ['Язык', 'kk'],
				b: ['Браузер', ['Chrome', 'Edge']],
				text: 'казахская локализация пока проверяется только в Chrome и Edge'
			},
			{
				kind: 'forbid',
				a: ['Экран', 'планшет'],
				b: ['Тема', ['тёмная']],
				text: 'тёмной темы на планшетной вёрстке нет'
			},
			{
				kind: 'only',
				a: ['Экран', 'телефон'],
				b: ['Браузер', ['Chrome', 'Safari']],
				text: 'телефонную вёрстку проверяют только в Chrome и Safari'
			}
		]
	},
	{
		parameters: [
			{ name: 'Оплата', values: ['карта', 'наличные', 'СБП', 'рассрочка'] },
			{ name: 'Доставка', values: ['курьер', 'самовывоз', 'почта'] },
			{ name: 'Регион', values: ['Москва', 'Казань', 'Омск'] },
			{ name: 'Клиент', values: ['гость', 'участник'] },
			{ name: 'Упаковка', values: ['обычная', 'подарочная'] }
		],
		constraints: [
			{
				kind: 'only',
				a: ['Оплата', 'наличные'],
				b: ['Доставка', ['самовывоз']],
				text: 'наличными платят только при самовывозе'
			},
			{
				kind: 'forbid',
				a: ['Оплата', 'рассрочка'],
				b: ['Клиент', ['гость']],
				text: 'рассрочка недоступна гостю'
			},
			{
				kind: 'only',
				a: ['Доставка', 'самовывоз'],
				b: ['Регион', ['Москва', 'Казань']],
				text: 'пункты самовывоза есть только в Москве и Казани'
			},
			{
				kind: 'forbid',
				a: ['Доставка', 'почта'],
				b: ['Упаковка', ['подарочная']],
				text: 'подарочную упаковку почтой не отправляют'
			},
			{
				kind: 'only',
				a: ['Упаковка', 'подарочная'],
				b: ['Клиент', ['участник']],
				text: 'подарочная упаковка — только для участника программы'
			},
			{ kind: 'forbid', a: ['Оплата', 'СБП'], b: ['Регион', ['Омск']], text: 'СБП в Омске пока не подключена' }
		]
	},
	{
		parameters: [
			{ name: 'Тариф', values: ['эконом', 'стандарт', 'бизнес'] },
			{ name: 'Канал', values: ['сайт', 'приложение', 'касса'] },
			{ name: 'Пассажир', values: ['взрослый', 'ребёнок', 'пенсионер'] },
			{ name: 'Оплата', values: ['карта', 'бонусы'] },
			{ name: 'Багаж', values: ['нет', '10кг', '23кг'] }
		],
		constraints: [
			{
				kind: 'only',
				a: ['Оплата', 'бонусы'],
				b: ['Канал', ['сайт']],
				text: 'бонусами можно заплатить только на сайте'
			},
			{
				kind: 'only',
				a: ['Пассажир', 'пенсионер'],
				b: ['Канал', ['касса']],
				text: 'льготный билет пенсионера оформляется только в кассе'
			},
			{
				kind: 'forbid',
				a: ['Тариф', 'эконом'],
				b: ['Багаж', ['23кг']],
				text: 'в эконом-тарифе нет багажа 23 кг'
			},
			{
				kind: 'only',
				a: ['Тариф', 'бизнес'],
				b: ['Багаж', ['23кг']],
				text: 'в бизнес-тарифе багаж всегда 23 кг'
			},
			{
				kind: 'forbid',
				a: ['Пассажир', 'ребёнок'],
				b: ['Канал', ['приложение']],
				text: 'детский билет в приложении не оформить'
			},
			{
				kind: 'forbid',
				a: ['Канал', 'касса'],
				b: ['Тариф', ['бизнес']],
				text: 'бизнес-тариф в кассе не продаётся'
			}
		]
	}
];

/** A pair of values of two parameters i < j: its key. */
const key = (i: number, vi: number, j: number, vj: number): string =>
	i < j ? `${i}:${vi}|${j}:${vj}` : `${j}:${vj}|${i}:${vi}`;

function forbiddenPairs(p: Params, rules: Rules): Set<string> {
	const out = new Set<string>();
	for (const c of p.constraints) {
		const [pa, va] = c.a;
		const [pb, vbs] = c.b;
		const values = p.parameters[pb]?.values ?? [];
		if (c.kind === 'forbid') {
			for (const vb of vbs) out.add(key(pa, va, pb, vb));
			continue;
		}
		for (let vb = 0; vb < values.length; vb += 1) if (!vbs.includes(vb)) out.add(key(pa, va, pb, vb));
		if (rules.symmetric) {
			// The misreading: every value of B the rule names is taken as allowed only with A.
			const own = p.parameters[pa]?.values ?? [];
			for (const vb of vbs) for (let w = 0; w < own.length; w += 1) if (w !== va) out.add(key(pa, w, pb, vb));
		}
	}
	return out;
}

function pairsOfTest(test: readonly number[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < test.length; i += 1)
		for (let j = i + 1; j < test.length; j += 1) out.push(key(i, test[i] ?? 0, j, test[j] ?? 0));
	return out;
}

function allPairs(p: Params): string[] {
	const out: string[] = [];
	const ps = p.parameters;
	for (let i = 0; i < ps.length; i += 1)
		for (let j = i + 1; j < ps.length; j += 1)
			for (let vi = 0; vi < (ps[i]?.values.length ?? 0); vi += 1)
				for (let vj = 0; vj < (ps[j]?.values.length ?? 0); vj += 1) out.push(key(i, vi, j, vj));
	return out;
}

function allTests(p: Params): number[][] {
	let out: number[][] = [[]];
	for (const parameter of p.parameters) out = out.flatMap((t) => parameter.values.map((_, v) => [...t, v]));
	return out;
}

const isValid = (test: readonly number[], forbidden: ReadonlySet<string>): boolean =>
	pairsOfTest(test).every((pair) => !forbidden.has(pair));

/** The pairs a test set must cover under a rule set. */
function required(p: Params, rules: Rules): string[] {
	if (!rules.forbidden) return allPairs(p);
	const forbidden = forbiddenPairs(p, rules);
	if (!rules.reachable) return allPairs(p).filter((pair) => !forbidden.has(pair));
	const seen = new Set(
		allTests(p)
			.filter((t) => isValid(t, forbidden))
			.flatMap(pairsOfTest)
	);
	return allPairs(p).filter((pair) => seen.has(pair));
}

/** Positions of the tests a rule set runs. */
function runs(p: Params, rules: Rules): number[] {
	const forbidden = forbiddenPairs(p, rules);
	return p.tests.map((_, k) => k).filter((k) => rules.keepInvalid || isValid(p.tests[k] ?? [], forbidden));
}

function coveredBy(p: Params, positions: readonly number[]): Set<string> {
	return new Set(positions.flatMap((k) => pairsOfTest(p.tests[k] ?? [])));
}

const pairText = (p: Params, pair: string): string =>
	pair
		.split('|')
		.map((part) => {
			const [i, v] = part.split(':').map(Number) as [number, number];
			return p.parameters[i]?.values[v] ?? '';
		})
		.join('+');

const ids = (positions: readonly number[]): string =>
	positions.length === 0 ? '-' : positions.map((k) => String(k + 1)).join(' ');

/** The fewest tests of `pool` whose pairs together contain all of `need` (at most 30 pairs); null above `limit`. */
function fewest(pool: readonly (readonly number[])[], need: readonly string[], limit: number): number | null {
	if (need.length === 0) return 0;
	if (need.length > 30) return null;
	const bitOf = new Map(need.map((pair, k) => [pair, 1 << k]));
	const full = (1 << need.length) - 1;
	const masks = [
		...new Set(pool.map((t) => pairsOfTest(t).reduce((mask, pair) => mask | (bitOf.get(pair) ?? 0), 0)))
	].filter((mask) => mask !== 0);
	for (let count = 1; count <= limit; count += 1) {
		const walk = (from: number, left: number, got: number): boolean => {
			if (left === 0) return got === full;
			for (let k = from; k <= masks.length - left; k += 1)
				if (walk(k + 1, left - 1, got | (masks[k] ?? 0))) return true;
			return false;
		};
		if (walk(0, count, 0)) return count;
	}
	return null;
}

function solve(p: Params, classId: string, rules: Rules): string {
	const need = required(p, rules);
	const forbidden = forbiddenPairs(p, rules);
	const run = runs(p, rules);
	const covered = coveredBy(p, run);
	const uncovered = need.filter((pair) => !covered.has(pair));
	const invalid = p.tests.map((_, k) => k).filter((k) => !run.includes(k));
	switch (classId) {
		case 'uncovered':
			return `${need.length} ${uncovered.length}`;
		case 'invalid-tests':
		case 'uncovered-reachable':
			return `${ids(invalid)} | ${uncovered.length}`;
		case 'redundant': {
			const needed = new Set(need);
			const redundant = run.filter((k) => {
				const others = coveredBy(
					p,
					run.filter((q) => q !== k)
				);
				return pairsOfTest(p.tests[k] ?? []).every((pair) => !needed.has(pair) || others.has(pair));
			});
			return ids(redundant);
		}
		case 'pair-table': {
			const [i, j] = p.focus ?? [0, 1];
			const list = uncovered.filter((pair) => pair.startsWith(`${i}:`) && pair.includes(`|${j}:`));
			return list.length === 0 ? '-' : list.map((pair) => pairText(p, pair)).join(' ');
		}
		case 'unreachable': {
			const direct = allPairs(p).filter((pair) => !forbidden.has(pair));
			const needed = new Set(need);
			const lost = direct.filter((pair) => !needed.has(pair));
			return `${need.length} | ${lost.length === 0 ? '-' : lost.map((pair) => pairText(p, pair)).join(' ')}`;
		}
		case 'min-additional': {
			const pool = allTests(p).filter((t) => isValid(t, forbiddenPairs(p, RIGHT)));
			const add = fewest(pool, uncovered, 3);
			return `${uncovered.map((pair) => pairText(p, pair)).join(' ')} | ${add === null ? 'never' : add}`;
		}
		case 'valid-combinations':
			return `${allTests(p).filter((t) => isValid(t, forbidden)).length} ${need.length}`;
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	const domain = rng.pick(DOMAINS);
	const senior = grade === 'senior';
	const count = senior ? (classId === 'min-additional' ? 4 : rng.int(4, 5)) : rng.int(3, 4);
	// Parameters keep their order in the domain; one value may be dropped from a long list.
	const chosen = rng
		.sample(
			domain.parameters.map((_, k) => k),
			count
		)
		.sort((a, b) => a - b)
		.map((k) => domain.parameters[k] as Parameter);
	const parameters = chosen.map((parameter) => {
		if (parameter.values.length < 3 || rng.bool(0.5)) return { ...parameter, values: [...parameter.values] };
		const drop = rng.int(0, parameter.values.length - 1);
		return { ...parameter, values: parameter.values.filter((_, v) => v !== drop) };
	});
	const index = (name: string, value: string): [number, number] | null => {
		const i = parameters.findIndex((x) => x.name === name);
		const v = parameters[i]?.values.indexOf(value) ?? -1;
		return i < 0 || v < 0 ? null : [i, v];
	};
	const usable: Constraint[] = [];
	for (const spec of domain.constraints) {
		const a = index(spec.a[0], spec.a[1]);
		const bValues = spec.b[1].map((value) => index(spec.b[0], value)).filter((x) => x !== null);
		const bParam = parameters.findIndex((x) => x.name === spec.b[0]);
		if (!a || bParam < 0 || bValues.length === 0) continue;
		// An «only» rule that names every remaining value forbids nothing.
		if (spec.kind === 'only' && bValues.length === (parameters[bParam]?.values.length ?? 0)) continue;
		usable.push({ kind: spec.kind, a, b: [bParam, bValues.map(([, v]) => v)], text: spec.text });
	}
	const constraints = rng.sample(usable, Math.min(usable.length, senior ? rng.int(3, 4) : rng.int(2, 3)));
	const p: Params = { parameters, constraints, tests: [], focus: null };
	const forbidden = forbiddenPairs(p, RIGHT);
	const all = allTests(p);
	const valid = all.filter((t) => isValid(t, forbidden));
	const invalid = all.filter((t) => !isValid(t, forbidden));
	const take = (pool: number[][], n: number): number[][] => rng.sample(pool, Math.min(pool.length, n));
	switch (classId) {
		case 'uncovered':
		case 'pair-table':
			p.tests = take(valid, rng.int(5, 7));
			break;
		case 'invalid-tests':
		case 'uncovered-reachable':
			p.tests = rng.shuffle([...take(valid, rng.int(5, 7)), ...take(invalid, rng.int(1, 2))]);
			break;
		case 'redundant':
			p.tests = rng.shuffle([...take(valid, rng.int(7, 9)), ...take(invalid, 1)]);
			break;
		case 'min-additional':
			p.tests = take(valid, rng.int(7, 10));
			break;
		case 'unreachable':
		case 'valid-combinations':
			break;
	}
	if (classId === 'pair-table') {
		const touched = constraints.map((c) => [Math.min(c.a[0], c.b[0]), Math.max(c.a[0], c.b[0])] as [number, number]);
		if (touched.length === 0) return p;
		p.focus = rng.pick(touched);
	}
	return p;
}

function suits(p: Params, classId: string, answer: string, grade: string): boolean {
	const direct = allPairs(p).filter((pair) => !forbiddenPairs(p, RIGHT).has(pair)).length;
	const reachable = required(p, RIGHT).length;
	// Middle: every pair the constraints allow is reachable — the chains are the senior's subject.
	if (grade === 'middle' && direct !== reachable) return false;
	if (grade === 'senior' && direct === reachable) return false;
	switch (classId) {
		case 'redundant':
			return answer !== '-';
		case 'pair-table':
			return p.focus !== null && answer !== '-';
		case 'min-additional':
			return !answer.endsWith('never') && !answer.startsWith(' |');
		default:
			return true;
	}
}

function constraintText(p: Params, c: Constraint): string {
	const name = (i: number): string => `**${p.parameters[i]?.name ?? ''}**`;
	const value = (i: number, v: number): string => `\`${p.parameters[i]?.values[v] ?? ''}\``;
	const [pa, va] = c.a;
	const [pb, vbs] = c.b;
	const rule =
		c.kind === 'forbid'
			? `${name(pa)} = ${value(pa, va)} несовместимо с ${name(pb)} = ${vbs.map((v) => value(pb, v)).join(' или ')}`
			: `${name(pa)} = ${value(pa, va)} допустимо только при ${name(pb)} = ${vbs.map((v) => value(pb, v)).join(' или ')}`;
	return `- ${rule} (${c.text}).`;
}

function table(p: Params): string[] {
	const headers = ['тест', ...p.parameters.map((x) => x.name)];
	const rows = p.tests.map((t, k) => [String(k + 1), ...t.map((v, i) => p.parameters[i]?.values[v] ?? '')]);
	const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)) + 2);
	const line = (cells: string[]): string =>
		cells
			.map((cell, c) => cell.padEnd(widths[c] ?? 0))
			.join('')
			.trimEnd();
	return ['```', line(headers), ...rows.map(line), '```'];
}

function describe(p: Params, classId: string, grade: string): string {
	const out = [
		'Конфигурации для проверки задаются параметрами:',
		'',
		...p.parameters.map((x) => `- **${x.name}**: ${x.values.map((v) => `\`${v}\``).join(', ')}`),
		'',
		'Ограничения (правило «только при» действует в одну сторону: оно ограничивает только названное первым значение):',
		'',
		...p.constraints.map((c) => constraintText(p, c)),
		'',
		'Пара — два значения разных параметров; тест — по одному значению каждого параметра, он покрывает все пары своих значений. Тест, нарушающий хоть одно ограничение, недопустим: его не выполняют, и он ничего не покрывает.'
	];
	out.push(
		'',
		grade === 'middle'
			? 'Допустимая пара — пара, которую ограничения не запрещают; покрывать нужно только допустимые пары.'
			: 'Достижимая пара — пара, которая встречается хотя бы в одном допустимом тесте; покрывать нужно только достижимые пары.'
	);
	if (p.tests.length > 0) out.push('', 'Набор тестов:', '', ...table(p));
	out.push('');
	switch (classId) {
		case 'uncovered':
			out.push(
				'Введите через пробел два числа: сколько всего допустимых пар и сколько из них набор не покрывает. Например: `41 12`.'
			);
			break;
		case 'invalid-tests':
		case 'uncovered-reachable':
			out.push(
				`Введите через пробел номера недопустимых тестов по возрастанию (если таких нет — \`-\`), затем знак \`|\` и число ${grade === 'middle' ? 'допустимых' : 'достижимых'} пар, которые не покрыты выполняемыми тестами. Например: \`2 6 | 9\`.`
			);
			break;
		case 'redundant':
			out.push(
				'Выполняемый тест избыточен, если каждую допустимую пару, которую он покрывает, покрывает и какой-то другой выполняемый тест набора. Введите через пробел номера избыточных тестов по возрастанию. Например: `3 7`.'
			);
			break;
		case 'pair-table': {
			const [i, j] = p.focus ?? [0, 1];
			const a = p.parameters[i]?.name ?? '';
			const b = p.parameters[j]?.name ?? '';
			out.push(
				`Найдите допустимые пары значений параметров **${a}** и **${b}**, которые набор не покрывает. Запишите каждую как \`значение${a}+значение${b}\` и введите через пробел: сначала по порядку значений **${a}**, затем **${b}**, как они перечислены выше. Например: \`${p.parameters[i]?.values[0] ?? ''}+${p.parameters[j]?.values[1] ?? ''} ${p.parameters[i]?.values[1] ?? ''}+${p.parameters[j]?.values[0] ?? ''}\`.`
			);
			break;
		}
		case 'unreachable':
			out.push(
				'Введите число достижимых пар, затем знак `|` и пары, которые ограничения прямо не запрещают, но которые не встречаются ни в одном допустимом тесте. Каждую пару запишите как `значение+значение` — сначала значение параметра, перечисленного выше раньше; пары упорядочьте по порядку параметров, затем по порядку значений. Например: `38 | Safari+телефон`.'
			);
			break;
		case 'min-additional':
			out.push(
				'Набор дополняют допустимыми тестами так, чтобы покрыть все достижимые пары. Введите через пробел достижимые пары, которые набор сейчас не покрывает, затем знак `|` и наименьшее число допустимых тестов, которое нужно добавить. Каждую пару запишите как `значение+значение` — сначала значение параметра, перечисленного выше раньше; пары упорядочьте по порядку параметров, затем по порядку значений. Например: `Chrome+Linux Safari+телефон | 2`.'
			);
			break;
		case 'valid-combinations':
			out.push(
				'Введите через пробел два числа: сколько существует допустимых тестов (полных комбинаций значений всех параметров) и сколько достижимых пар. Например: `52 47`.'
			);
			break;
	}
	return out.join('\n');
}

const PYTHON_REFERENCE = `import json
from itertools import combinations, product

p = json.loads(input())
params = p["parameters"]
cls = p["classId"]
k = len(params)


def allowed(test):
    for c in p["constraints"]:
        (pa, va), (pb, vbs) = c["a"], c["b"]
        if test[pa] != va:
            continue
        if c["kind"] == "forbid" and test[pb] in vbs:
            return False
        if c["kind"] == "only" and test[pb] not in vbs:
            return False
    return True


def pairs(test):
    return {(i, test[i], j, test[j]) for i, j in combinations(range(k), 2)}


def pair_forbidden(i, vi, j, vj):
    for c in p["constraints"]:
        (pa, va), (pb, vbs) = c["a"], c["b"]
        for (x, vx), (y, vy) in (((i, vi), (j, vj)), ((j, vj), (i, vi))):
            if x == pa and vx == va and y == pb:
                if c["kind"] == "forbid" and vy in vbs:
                    return True
                if c["kind"] == "only" and vy not in vbs:
                    return True
    return False


every = [(i, vi, j, vj) for i, j in combinations(range(k), 2) for vi in range(len(params[i]["values"])) for vj in range(len(params[j]["values"]))]
direct = [q for q in every if not pair_forbidden(*q)]
space = [t for t in product(*[range(len(x["values"])) for x in params]) if allowed(t)]
reachable = set()
for t in space:
    reachable |= pairs(t)
need = direct if p["grade"] == "middle" else [q for q in every if q in reachable]
tests = [tuple(t) for t in p["tests"]]
runs = [n for n, t in enumerate(tests) if allowed(t)]
covered = set()
for n in runs:
    covered |= pairs(tests[n])
uncovered = [q for q in need if q not in covered]


def name(q):
    i, vi, j, vj = q
    return params[i]["values"][vi] + "+" + params[j]["values"][vj]


def ids(xs):
    return " ".join(str(x + 1) for x in xs) or "-"


if cls == "uncovered":
    out = f"{len(need)} {len(uncovered)}"
elif cls in ("invalid-tests", "uncovered-reachable"):
    out = ids([n for n in range(len(tests)) if n not in runs]) + f" | {len(uncovered)}"
elif cls == "redundant":
    extra = []
    for n in runs:
        rest = set()
        for m in runs:
            if m != n:
                rest |= pairs(tests[m])
        if all(q in rest or q not in need for q in pairs(tests[n])):
            extra.append(n)
    out = ids(extra)
elif cls == "pair-table":
    i, j = p["focus"]
    out = " ".join(name(q) for q in uncovered if q[0] == i and q[2] == j) or "-"
elif cls == "unreachable":
    lost = [q for q in direct if q not in reachable]
    out = f"{len(need)} | " + (" ".join(name(q) for q in lost) or "-")
elif cls == "min-additional":
    left = set(uncovered)
    out = None
    for size in range(1, 5):
        pool = [pairs(t) & left for t in space if pairs(t) & left]
        if any(set().union(*pick) >= left for pick in combinations(pool, size)):
            out = " ".join(name(q) for q in uncovered) + f" | {size}"
            break
elif cls == "valid-combinations":
    out = f"{len(space)} {len(need)}"
print(out)
`;

const WRONG: Record<string, Partial<Rules>> = {
	'count-forbidden': { forbidden: false },
	'implication-symmetric': { symmetric: true },
	'keep-invalid': { keepInvalid: true },
	'direct-only': { reachable: false }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	'middle/uncovered': ['count-forbidden'],
	'middle/invalid-tests': ['keep-invalid'],
	'middle/redundant': ['keep-invalid'],
	'middle/pair-table': ['count-forbidden'],
	'senior/unreachable': ['direct-only'],
	'senior/uncovered-reachable': ['keep-invalid', 'direct-only'],
	'senior/min-additional': ['direct-only'],
	'senior/valid-combinations': ['direct-only', 'implication-symmetric']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { grade, classId } = input;
	// Scenarios are drawn until the question is well posed and every misconception the class must expose changes
	// the answer.
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = scenario(rng, grade, classId);
		const rules = grade === 'middle' ? { ...RIGHT, reachable: false } : RIGHT;
		const answer = solve(p, classId, rules);
		if (!suits(p, classId, answer, grade)) continue;
		const wrong: Record<string, string | null> = {};
		for (const [id, change] of Object.entries(WRONG)) {
			const value = solve(p, classId, { ...rules, ...change });
			wrong[id] = value === answer ? null : value;
		}
		if ((REQUIRED[`${grade}/${classId}`] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p, classId, grade), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({
			classId,
			grade,
			parameters: p.parameters,
			constraints: p.constraints.map((c) => ({ kind: c.kind, a: c.a, b: c.b })),
			tests: p.tests,
			focus: p.focus
		});
		return {
			instance,
			reference: () => ({ kind: 'output', source: PYTHON_REFERENCE, stdin }),
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
