// Pairwise testing: how many value pairs a configuration space has and how many full combinations, with forbidden
// pairs and the smallest pairwise suite of three parameters; how many pairs a given suite leaves uncovered, which of its
// tests can be dropped one at a time without losing a covered pair, and how many new pairs each test adds.
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

interface Param {
	name: string;
	values: string[];
}

/** A pair of values that never goes together: parameter index and value index on both sides. */
type Forbidden = [number, number, number, number];

type Question = 'pairs-combos' | 'pairs-combos-min' | 'total-uncovered' | 'removable' | 'increments';

interface Params {
	params: Param[];
	forbidden: Forbidden[];
	/** Junior: the suite, a value index per parameter in every test. */
	tests: number[][];
	question: Question;
}

interface Rules {
	adjacentOnly: boolean;
	withinParam: boolean;
	pairsAsCombos: boolean;
	constraintIgnored: boolean;
	constraintOneCombo: boolean;
	minAsMax: boolean;
	eachValue: boolean;
	countTotal: boolean;
}

const RIGHT: Rules = {
	adjacentOnly: false,
	withinParam: false,
	pairsAsCombos: false,
	constraintIgnored: false,
	constraintOneCombo: false,
	minAsMax: false,
	eachValue: false,
	countTotal: false
};

const pairKey = (i: number, a: number, j: number, b: number): string => `${i}:${a}|${j}:${b}`;

function isForbidden(p: Params, i: number, a: number, j: number, b: number, rules: Rules): boolean {
	if (rules.constraintIgnored) return false;
	return p.forbidden.some(
		([fi, fa, fj, fb]) =>
			(fi === i && fa === a && fj === j && fb === b) || (fi === j && fa === b && fj === i && fb === a)
	);
}

/** The parameter pairs a misconception looks at. */
function paramPairs(p: Params, rules: Rules): [number, number][] {
	const k = p.params.length;
	const out: [number, number][] = [];
	for (let i = 0; i < k; i += 1)
		for (let j = i + 1; j < k; j += 1) if (!rules.adjacentOnly || j === i + 1) out.push([i, j]);
	return out;
}

/** Every value pair to cover, as keys. */
function allPairs(p: Params, rules: Rules): string[] {
	const out: string[] = [];
	for (const [i, j] of paramPairs(p, rules)) {
		const ni = p.params[i]?.values.length ?? 0;
		const nj = p.params[j]?.values.length ?? 0;
		for (let a = 0; a < ni; a += 1)
			for (let b = 0; b < nj; b += 1) if (!isForbidden(p, i, a, j, b, rules)) out.push(pairKey(i, a, j, b));
	}
	return out;
}

const choose2 = (n: number): number => (n * (n - 1)) / 2;

/** The value pairs a test covers. */
function pairsOf(p: Params, test: readonly number[], rules: Rules): string[] {
	return paramPairs(p, rules).map(([i, j]) => pairKey(i, test[i] ?? 0, j, test[j] ?? 0));
}

function solve(p: Params, rules: Rules): string {
	const sizes = p.params.map((x) => x.values.length);
	const within = rules.withinParam ? sizes.reduce((s, n) => s + choose2(n), 0) : 0;
	if (p.question === 'pairs-combos' || p.question === 'pairs-combos-min') {
		const product = sizes.reduce((s, n) => s * n, 1);
		const pairs = rules.pairsAsCombos ? product : allPairs(p, rules).length + within;
		let combos = product;
		if (!rules.constraintIgnored && p.forbidden.length > 0) {
			// Forbidden pairs of one pair of parameters: the full combinations that hold one of them.
			const [fi = 0, , fj = 0] = p.forbidden[0] ?? [];
			const rest = product / ((sizes[fi] ?? 1) * (sizes[fj] ?? 1));
			combos -= p.forbidden.length * (rules.constraintOneCombo ? 1 : rest);
		}
		const parts = [pairs, combos];
		if (p.question === 'pairs-combos-min') {
			const sorted = [...sizes].sort((a, b) => b - a);
			parts.push(rules.minAsMax ? (sorted[0] ?? 0) : (sorted[0] ?? 0) * (sorted[1] ?? 0));
		}
		return parts.join(' ');
	}
	if (p.question === 'total-uncovered') {
		const all = allPairs(p, rules);
		const covered = new Set(p.tests.flatMap((t) => pairsOf(p, t, rules)));
		return `${all.length + within} ${all.filter((k) => !covered.has(k)).length + within}`;
	}
	if (p.question === 'removable') {
		const out: number[] = [];
		p.tests.forEach((test, t) => {
			const others = p.tests.filter((_, u) => u !== t);
			const removable = rules.eachValue
				? test.every((v, i) => others.some((o) => o[i] === v))
				: pairsOf(p, test, rules).every((k) => others.some((o) => pairsOf(p, o, rules).includes(k)));
			if (removable) out.push(t + 1);
		});
		return out.join(' ');
	}
	const seen = new Set<string>();
	return p.tests
		.map((test) => {
			const pairs = pairsOf(p, test, rules);
			const fresh = rules.countTotal ? pairs.length : pairs.filter((k) => !seen.has(k)).length;
			for (const k of pairs) seen.add(k);
			return fresh;
		})
		.join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios.

const POOL: readonly Param[] = [
	{
		name: 'Браузер',
		values: ['Chrome', 'Firefox', 'Safari', 'Edge', 'Opera', 'Яндекс Браузер', 'Vivaldi', 'Brave']
	},
	{ name: 'ОС', values: ['Windows 10', 'Windows 11', 'macOS', 'Ubuntu', 'Astra Linux', 'Android', 'iOS', 'HarmonyOS'] },
	{ name: 'Язык интерфейса', values: ['ru', 'en', 'kk', 'uz', 'de', 'tr', 'zh', 'ar'] },
	{
		name: 'Роль пользователя',
		values: ['гость', 'клиент', 'менеджер', 'администратор', 'аудитор', 'оператор', 'партнёр', 'модератор']
	},
	{
		name: 'Способ оплаты',
		values: ['карта', 'СБП', 'бонусы', 'счёт', 'рассрочка', 'кошелёк', 'подарочная карта', 'наличные курьеру']
	},
	{ name: 'Сеть', values: ['Wi-Fi', '5G', '4G', '3G', 'Ethernet', 'VPN', 'прокси', 'спутник'] },
	{
		name: 'Тема',
		values: ['светлая', 'тёмная', 'контрастная', 'системная', 'сепия', 'ночная', 'крупный шрифт', 'без анимаций']
	},
	{
		name: 'Экран',
		values: ['телефон', 'планшет', 'ноутбук', 'монитор 4K', 'ТВ', 'часы', 'складной телефон', 'ультраширокий монитор']
	}
];

function pickParams(rng: Rng, k: number, lo: number, hi: number): Param[] {
	return rng.sample(POOL, k).map((param) => ({
		name: param.name,
		values: rng.sample(param.values, Math.min(param.values.length, rng.int(lo, hi)))
	}));
}

/** Forbidden pairs between two parameters: one value of the first with one or two values of the second. */
function forbid(rng: Rng, params: readonly Param[], count: number): Forbidden[] {
	const [i = 0, j = 1] = rng
		.sample(
			params.map((_, n) => n),
			2
		)
		.sort((a, b) => a - b);
	const a = rng.int(0, (params[i]?.values.length ?? 1) - 1);
	const bs = rng.sample(
		(params[j]?.values ?? []).map((_, n) => n),
		Math.min(count, (params[j]?.values.length ?? 1) - 1)
	);
	return bs.map((b): Forbidden => [i, a, j, b]);
}

function randomTest(rng: Rng, p: Pick<Params, 'params' | 'forbidden'>): number[] {
	for (let tries = 0; tries < 100; tries += 1) {
		const test = p.params.map((x) => rng.int(0, x.values.length - 1));
		if (!p.forbidden.some(([i, a, j, b]) => test[i] === a && test[j] === b)) return test;
	}
	throw new Error('pairwise-count: no allowed test');
}

function scenario(rng: Rng, grade: string, classId: string): Params {
	if (grade === 'intern') {
		if (classId === 'pairs-3')
			return { params: pickParams(rng, 3, 2, 8), forbidden: [], tests: [], question: 'pairs-combos' };
		if (classId === 'pairs-many')
			return { params: pickParams(rng, rng.int(4, 5), 2, 5), forbidden: [], tests: [], question: 'pairs-combos' };
		if (classId === 'constraint') {
			const params = pickParams(rng, rng.int(3, 4), 2, 5);
			return { params, forbidden: forbid(rng, params, rng.int(1, 2)), tests: [], question: 'pairs-combos' };
		}
		return { params: pickParams(rng, 3, 2, 8), forbidden: [], tests: [], question: 'pairs-combos-min' };
	}
	const k = classId === 'increments' ? rng.int(3, 4) : 4;
	const params = pickParams(rng, k, 2, classId === 'removable' ? 3 : 4);
	const forbidden = classId === 'constraint' ? forbid(rng, params, rng.int(1, 2)) : [];
	const count = classId === 'increments' ? rng.int(5, 7) : rng.int(6, 9);
	const tests: number[][] = [];
	for (let t = 0; t < count; t += 1) {
		// Now and then a test repeats most of an earlier one: suites grow like that.
		const base = tests.length > 0 && rng.bool(0.35) ? rng.pick(tests) : null;
		const fresh = randomTest(rng, { params, forbidden });
		const keep = rng.int(0, k - 1);
		const test = base ? base.map((v, i) => (i === keep ? (fresh[i] ?? v) : v)) : fresh;
		tests.push(forbidden.some(([i, a, j, b]) => test[i] === a && test[j] === b) ? fresh : test);
	}
	const question: Question =
		classId === 'removable' ? 'removable' : classId === 'increments' ? 'increments' : 'total-uncovered';
	return { params, forbidden, tests, question };
}

function constraintText(p: Params): string[] {
	if (p.forbidden.length === 0) return [];
	const [i = 0, a = 0, j = 0] = p.forbidden[0] ?? [];
	const pi = p.params[i];
	const pj = p.params[j];
	const values = p.forbidden.map(([, , , b]) => `«${pj?.values[b] ?? ''}»`).join(' и ');
	return [
		`Ограничение: значение «${pi?.values[a] ?? ''}» параметра «${pi?.name ?? ''}» не сочетается со значением ${values} параметра «${pj?.name ?? ''}». Такие пары не покрываются, а тесты и комбинации с ними невозможны.`,
		''
	];
}

function suiteLines(p: Params): string[] {
	const header = ['№', ...p.params.map((x) => x.name)];
	const rows = p.tests.map((test, t) => [String(t + 1), ...test.map((v, i) => p.params[i]?.values[v] ?? '')]);
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
	const line = (cells: readonly string[]): string =>
		cells
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join('   ')
			.trimEnd();
	return ['```', line(header), ...rows.map(line), '```'];
}

function describe(p: Params): string {
	const head = [
		'Веб-приложение тестируется на разных конфигурациях. Параметры и их значения:',
		'',
		...p.params.map((x) => `- ${x.name}: ${x.values.join(', ')}`),
		'',
		'Попарное тестирование (pairwise) требует, чтобы каждая пара значений двух разных параметров встретилась хотя бы в одном тесте; тест — одно значение каждого параметра.',
		'',
		...constraintText(p)
	];
	if (p.question === 'pairs-combos')
		return [
			...head,
			'Сколько всего пар значений нужно покрыть и сколько тестов в полном переборе всех допустимых комбинаций? Введите два числа через пробел: число пар, затем число комбинаций. Например: `20 36`.'
		].join('\n');
	if (p.question === 'pairs-combos-min')
		return [
			...head,
			'Сколько всего пар значений нужно покрыть, сколько тестов в полном переборе всех комбинаций и из скольких тестов состоит самый короткий набор, покрывающий все пары? Введите три числа через пробел в этом порядке. Например: `20 36 9`.'
		].join('\n');
	const suite = ['Готовый набор тестов:', '', ...suiteLines(p), ''];
	if (p.question === 'total-uncovered')
		return [
			...head,
			...suite,
			'Сколько всего пар значений нужно покрыть и сколько из них этот набор не покрывает? Введите два числа через пробел: всего пар, затем непокрытых. Например: `54 17`.'
		].join('\n');
	if (p.question === 'removable')
		return [
			...head,
			...suite,
			'Тест можно удалить, если каждая пара значений, которую он покрывает, покрыта и каким-то другим тестом этого набора (тесты рассматриваются по одному: удаляется только этот тест, остальные остаются). Какие тесты можно удалить? Введите их номера через пробел по возрастанию. Например: `2 6`.'
		].join('\n');
	return [
		...head,
		...suite,
		'Тесты выполняются по порядку. Сколько новых пар значений (не покрытых предыдущими тестами) добавляет каждый тест? Введите числа через пробел в порядке тестов. Например: `3 2 2 0 1`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import itertools
import json

p = json.loads(input())
sizes = [len(v) for v in p["values"]]
k = len(sizes)
banned = {tuple(f) for f in p["forbidden"]}


def allowed(i, a, j, b):
    return (i, a, j, b) not in banned and (j, b, i, a) not in banned


def pairs_of(test):
    return {(i, test[i], j, test[j]) for i, j in itertools.combinations(range(k), 2)}


pairs = {
    (i, a, j, b)
    for i, j in itertools.combinations(range(k), 2)
    for a in range(sizes[i])
    for b in range(sizes[j])
    if allowed(i, a, j, b)
}
q = p["question"]
if q in ("pairs-combos", "pairs-combos-min"):
    combos = sum(
        1
        for t in itertools.product(*[range(n) for n in sizes])
        if all(allowed(i, t[i], j, t[j]) for i, j in itertools.combinations(range(k), 2))
    )
    out = [len(pairs), combos]
    if q == "pairs-combos-min":
        a, b, c = sizes
        out.append(max(a * b, a * c, b * c))
    print(*out)
elif q == "total-uncovered":
    covered = set().union(*(pairs_of(t) for t in p["tests"]))
    print(len(pairs), len(pairs - covered))
elif q == "removable":
    out = []
    for n, t in enumerate(p["tests"]):
        others = set().union(*(pairs_of(o) for m, o in enumerate(p["tests"]) if m != n))
        if pairs_of(t) <= others:
            out.append(n + 1)
    print(*out)
else:
    seen = set()
    out = []
    for t in p["tests"]:
        new = pairs_of(t) - seen
        out.append(len(new))
        seen |= new
    print(*out)
`;

const WRONG: Record<string, Partial<Rules>> = {
	'adjacent-only': { adjacentOnly: true },
	'within-param': { withinParam: true },
	'pairs-as-combos': { pairsAsCombos: true },
	'constraint-ignored': { constraintIgnored: true },
	'constraint-one-combo': { constraintOneCombo: true },
	'min-as-max': { minAsMax: true },
	'each-value': { eachValue: true },
	'count-total': { countTotal: true }
};

/** The misconceptions every instance of a class must expose. */
const REQUIRED: Record<string, string[]> = {
	'intern/pairs-3': ['adjacent-only', 'within-param', 'pairs-as-combos'],
	'intern/pairs-many': ['adjacent-only', 'within-param', 'pairs-as-combos'],
	'intern/constraint': ['constraint-ignored', 'constraint-one-combo'],
	'intern/minimum': ['min-as-max', 'adjacent-only'],
	'junior/uncovered': ['adjacent-only', 'within-param'],
	'junior/removable': ['each-value'],
	'junior/constraint': ['constraint-ignored', 'within-param'],
	'junior/increments': ['count-total', 'adjacent-only']
};

function fits(p: Params, answer: string): boolean {
	const parts = answer.split(' ').filter(Boolean).map(Number);
	if (p.question === 'total-uncovered') return (parts[1] ?? 0) > 0;
	if (p.question === 'removable') return parts.length >= 1 && parts.length <= p.tests.length - 2;
	if (p.question === 'increments') return parts.filter((n) => n === 0).length <= 2;
	return true;
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	for (let tries = 0; tries < 1000; tries += 1) {
		const p = scenario(rng, input.grade, input.classId);
		const answer = solve(p, RIGHT);
		if (!fits(p, answer)) continue;
		const wrong = Object.fromEntries(
			Object.entries(WRONG).map(([id, change]) => {
				const value = solve(p, { ...RIGHT, ...change });
				return [id, value === answer ? null : value];
			})
		);
		const required = REQUIRED[`${input.grade}/${input.classId}`] ?? [];
		if (required.some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: describe(p), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({
			values: p.params.map((x) => x.values),
			forbidden: p.forbidden,
			tests: p.tests,
			question: p.question
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${input.classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
