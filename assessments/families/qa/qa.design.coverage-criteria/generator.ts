// Combinatorial coverage criteria over a classification of inputs: how many tests each-choice, base-choice and all
// combinations need under constraints, the smallest subset that keeps each-choice, what each-choice and base-choice
// leave uncovered compared with pairwise coverage, values no valid test can reach — and cause-effect graphs whose
// constraints E, I, O, R and M cut the combinations of causes.
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

type Value = [number, number];

interface CombParams {
	kind: 'comb';
	parameters: Parameter[];
	/** Pairs of values of two parameters that never meet in a valid test. */
	forbids: [Value, Value][];
	base: number[] | null;
	/** The second base test of multiple base-choice. */
	base2: number[] | null;
	tests: number[][];
}

interface CeConstraint {
	type: 'E' | 'I' | 'O' | 'R' | 'M';
	members: number[];
}

interface CeParams {
	kind: 'ce';
	causes: string[];
	effect: string;
	constraints: CeConstraint[];
	/** The effect over cause values, in Python syntax with names C1, C2, … */
	expr: string;
}

type Params = CombParams | CeParams;

interface Rules {
	noBaseSubtract: boolean;
	ignoreConstraints: boolean;
	greedy: boolean;
	eachSum: boolean;
	keepDuplicates: boolean;
	countForbidden: boolean;
	eAsO: boolean;
	oAsE: boolean;
	rSymmetric: boolean;
}

const RIGHT: Rules = {
	noBaseSubtract: false,
	ignoreConstraints: false,
	greedy: false,
	eachSum: false,
	keepDuplicates: false,
	countForbidden: false,
	eAsO: false,
	oAsE: false,
	rSymmetric: false
};

const DOMAINS: Parameter[][] = [
	[
		{ name: 'Способ', values: ['курьер', 'пункт', 'почта', 'дрон'] },
		{ name: 'Оплата', values: ['карта', 'наличные', 'СБП'] },
		{ name: 'Срок', values: ['сегодня', 'завтра', 'неделя'] },
		{ name: 'Упаковка', values: ['пакет', 'коробка'] },
		{ name: 'Страховка', values: ['без_страховки', 'страховка'] }
	],
	[
		{ name: 'Формат', values: ['PDF', 'XLSX', 'CSV', 'HTML'] },
		{ name: 'Период', values: ['день', 'месяц', 'квартал', 'год'] },
		{ name: 'Кодировка', values: ['UTF-8', 'CP1251'] },
		{ name: 'Сжатие', values: ['ZIP', 'без_сжатия'] },
		{ name: 'Подпись', values: ['ЭЦП', 'без_подписи', 'штамп'] }
	],
	[
		{ name: 'Устройство', values: ['ноутбук', 'телефон', 'планшет', 'ТВ'] },
		{ name: 'Сеть', values: ['Wi-Fi', '4G', 'Ethernet'] },
		{ name: 'Камера', values: ['камера_вкл', 'камера_выкл'] },
		{ name: 'Режим', values: ['звонок', 'конференция', 'трансляция'] },
		{ name: 'Запись', values: ['с_записью', 'без_записи'] }
	],
	[
		{ name: 'Роль', values: ['гость', 'клиент', 'менеджер', 'админ'] },
		{ name: 'Вход', values: ['пароль', 'SSO', 'ключ'] },
		{ name: 'Язык', values: ['ru', 'en', 'tt'] },
		{ name: 'Тема', values: ['светлая', 'тёмная'] },
		{ name: 'Клиент', values: ['веб', 'iOS', 'Android'] }
	]
];

const CE_DOMAINS: { effect: string; causes: string[] }[] = [
	{
		effect: 'заявка уходит на ручную проверку',
		causes: [
			'сумма больше 1 млн ₽',
			'клиент новый',
			'клиент из списка VIP',
			'есть залог',
			'есть поручитель',
			'кредитная история пустая'
		]
	},
	{
		effect: 'заказу назначается экспресс-доставка',
		causes: [
			'оплата картой',
			'оплата наличными',
			'оплата бонусами',
			'адрес в пределах МКАД',
			'вес больше 20 кг',
			'выбран подарочный набор'
		]
	},
	{
		effect: 'платёж блокируется антифродом',
		causes: [
			'новое устройство',
			'вход по паролю',
			'вход по биометрии',
			'получатель в чёрном списке',
			'сумма выше дневного лимита',
			'перевод за границу'
		]
	}
];

// --- Combinations of parameter values -------------------------------------------------------------------------

function allTests(p: CombParams): number[][] {
	let out: number[][] = [[]];
	for (const parameter of p.parameters) out = out.flatMap((t) => parameter.values.map((_, v) => [...t, v]));
	return out;
}

function isValid(p: CombParams, test: readonly number[], rules: Rules): boolean {
	if (rules.ignoreConstraints) return true;
	return p.forbids.every(([[i, vi], [j, vj]]) => !(test[i] === vi && test[j] === vj));
}

const valueName = (p: CombParams, [i, v]: Value): string => p.parameters[i]?.values[v] ?? '';

function everyValue(p: CombParams): Value[] {
	return p.parameters.flatMap((x, i) => x.values.map((_, v) => [i, v] as Value));
}

/** The base-choice set: the base test, then each non-base value in turn with the other parameters at their base. */
function baseChoice(
	p: CombParams,
	rules: Rules,
	base: readonly number[] = p.base ?? []
): { tests: number[][]; lost: Value[]; count: number } {
	const tests: number[][] = [[...base]];
	const lost: Value[] = [];
	for (let i = 0; i < p.parameters.length; i += 1) {
		for (let v = 0; v < (p.parameters[i]?.values.length ?? 0); v += 1) {
			if (v === base[i]) continue;
			const test = base.map((x, k) => (k === i ? v : x));
			if (isValid(p, test, rules)) tests.push(test);
			else lost.push([i, v]);
		}
	}
	// The misconception counts a test for every value of every parameter, the base ones included.
	const count = rules.noBaseSubtract ? tests.length + p.parameters.length : tests.length;
	return { tests, lost, count };
}

const pairKey = (i: number, vi: number, j: number, vj: number): string => `${i}:${vi}|${j}:${vj}`;

function pairsOf(test: readonly number[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < test.length; i += 1)
		for (let j = i + 1; j < test.length; j += 1) out.push(pairKey(i, test[i] ?? 0, j, test[j] ?? 0));
	return out;
}

/** The pairs a valid test can contain: a pair the constraints rule out, directly or together, cannot be covered. */
function allowedPairs(p: CombParams, rules: Rules): string[] {
	const pool = rules.countForbidden ? allTests(p) : allTests(p).filter((t) => isValid(p, t, rules));
	return [...new Set(pool.flatMap(pairsOf))];
}

const valueKey = ([i, v]: Value): string => `${i}:${v}`;

/** The fewest tests of `pool` that together contain every value of `need`: exact search on the first uncovered value. */
function fewestCovering(pool: readonly (readonly number[])[], need: readonly Value[]): number {
	let best = Infinity;
	const walk = (chosen: number, covered: Set<string>): void => {
		if (chosen >= best) return;
		const open = need.find((v) => !covered.has(valueKey(v)));
		if (!open) {
			best = chosen;
			return;
		}
		for (const test of pool) {
			if (test[open[0]] !== open[1]) continue;
			const next = new Set(covered);
			test.forEach((v, i) => next.add(`${i}:${v}`));
			walk(chosen + 1, next);
		}
	};
	walk(0, new Set());
	return best;
}

/** Values that appear in at least one test of `pool`. */
function reachableValues(p: CombParams, pool: readonly (readonly number[])[]): Value[] {
	return everyValue(p).filter(([i, v]) => pool.some((t) => t[i] === v));
}

function combinations<T>(items: readonly T[], size: number): T[][] {
	if (size === 0) return [[]];
	const out: T[][] = [];
	items.forEach((item, k) => {
		for (const rest of combinations(items.slice(k + 1), size - 1)) out.push([item, ...rest]);
	});
	return out;
}

/** The smallest subsets of the tests that keep every value the whole set has; positions, in lexicographic order. */
function smallestSubsets(p: CombParams): number[][] {
	const need = reachableValues(p, p.tests);
	const positions = p.tests.map((_, k) => k);
	for (let size = 1; size <= p.tests.length; size += 1) {
		const found = combinations(positions, size).filter((pick) =>
			need.every(([i, v]) => pick.some((k) => p.tests[k]?.[i] === v))
		);
		if (found.length > 0) return found;
	}
	return [];
}

/** Greedy: the test adding most new values first, ties by number. */
function greedySubset(p: CombParams): number[] {
	const need = new Set(reachableValues(p, p.tests).map(valueKey));
	const chosen: number[] = [];
	while (need.size > 0) {
		let best = -1;
		let gain = 0;
		p.tests.forEach((t, k) => {
			const g = t.filter((v, i) => need.has(`${i}:${v}`)).length;
			if (g > gain) {
				best = k;
				gain = g;
			}
		});
		chosen.push(best);
		(p.tests[best] ?? []).forEach((v, i) => need.delete(`${i}:${v}`));
	}
	return chosen.sort((a, b) => a - b);
}

function solveComb(p: CombParams, classId: string, rules: Rules): string {
	const valid = allTests(p).filter((t) => isValid(p, t, rules));
	const sum = p.parameters.reduce((s, x) => s + x.values.length, 0);
	const names = (values: readonly Value[]): string =>
		values.length ? values.map((v) => valueName(p, v)).join(' ') : '-';
	switch (classId) {
		case 'base-choice': {
			const b = baseChoice(p, rules);
			return `${b.count} | ${names(b.lost)}`;
		}
		case 'each-choice-subset': {
			const pick = rules.greedy ? greedySubset(p) : (smallestSubsets(p)[0] ?? []);
			return pick.map((k) => String(k + 1)).join(' ');
		}
		case 'criteria-counts': {
			const each = rules.eachSum ? sum : fewestCovering(valid, reachableValues(p, valid));
			return `${each} ${baseChoice(p, rules).count} ${valid.length}`;
		}
		case 'multi-base': {
			const first = baseChoice(p, rules);
			const second = baseChoice(p, rules, p.base2 ?? []);
			const union = new Set([...first.tests, ...second.tests].map((t) => t.join(',')));
			const generated = first.count + second.count;
			const count = rules.keepDuplicates
				? generated
				: union.size + (generated - first.tests.length - second.tests.length);
			return `${count} ${generated - count} ${first.lost.length + second.lost.length}`;
		}
		case 'base-vs-pairwise': {
			const b = baseChoice(p, rules);
			const covered = new Set(b.tests.flatMap(pairsOf));
			const left = allowedPairs(p, rules).filter((pair) => !covered.has(pair)).length;
			return `${b.count} ${left}`;
		}
		case 'dead-values': {
			const reach = reachableValues(p, valid);
			const dead = everyValue(p).filter(([i, v]) => !reach.some(([a, b]) => a === i && b === v));
			const each = rules.eachSum ? sum - dead.length : fewestCovering(valid, reach);
			return `${names(dead)} | ${each}`;
		}
	}
	throw new Error(`${descriptor.key}: unknown class ${classId}`);
}

// --- Cause-effect graphs ----------------------------------------------------------------------------------------

function holds(c: CeConstraint, values: readonly boolean[], rules: Rules): boolean {
	const on = c.members.filter((m) => values[m]).length;
	const [a = 0, b = 0] = c.members;
	switch (c.type) {
		case 'E':
			return rules.eAsO ? on === 1 : on <= 1;
		case 'I':
			return on >= 1;
		case 'O':
			return rules.oAsE ? on <= 1 : on === 1;
		case 'R':
			return rules.rSymmetric ? values[a] === values[b] : !values[a] || Boolean(values[b]);
		case 'M':
			return !values[a] || !values[b];
	}
}

type Node = { kind: 'leaf'; index: number; neg: boolean } | { kind: 'op'; op: 'and' | 'or'; kids: Node[] };

function buildTree(rng: Rng, leaves: readonly number[]): Node {
	if (leaves.length === 1) return { kind: 'leaf', index: leaves[0] ?? 0, neg: rng.bool(0.3) };
	const split = rng.int(1, leaves.length - 1);
	const op = rng.pick(['and', 'or'] as const);
	const kids: Node[] = [];
	for (const kid of [buildTree(rng, leaves.slice(0, split)), buildTree(rng, leaves.slice(split))]) {
		if (kid.kind === 'op' && kid.op === op) kids.push(...kid.kids);
		else kids.push(kid);
	}
	return { kind: 'op', op, kids };
}

function render(node: Node): string {
	if (node.kind === 'leaf') return `${node.neg ? 'not ' : ''}C${node.index + 1}`;
	return node.kids.map((kid) => (kid.kind === 'op' ? `(${render(kid)})` : render(kid))).join(` ${node.op} `);
}

function evaluate(node: Node, values: readonly boolean[]): boolean {
	if (node.kind === 'leaf') return node.neg !== Boolean(values[node.index]);
	return node.op === 'and' ? node.kids.every((k) => evaluate(k, values)) : node.kids.some((k) => evaluate(k, values));
}

const TREES = new WeakMap<CeParams, Node>();

function solveCe(p: CeParams, rules: Rules): string {
	const tree = TREES.get(p);
	if (!tree) throw new Error(`${descriptor.key}: a graph without its effect`);
	let valid = 0;
	let effect = 0;
	const n = p.causes.length;
	for (let mask = 0; mask < 1 << n; mask += 1) {
		const values = Array.from({ length: n }, (_, i) => ((mask >> i) & 1) === 1);
		if (!rules.ignoreConstraints && !p.constraints.every((c) => holds(c, values, rules))) continue;
		valid += 1;
		if (evaluate(tree, values)) effect += 1;
	}
	return `${valid} ${effect}`;
}

// --- Scenarios ----------------------------------------------------------------------------------------------------

interface CombShape {
	params: [number, number];
	maxValues: number;
	forbids: [number, number];
}

const SHAPES: Record<string, CombShape> = {
	'base-choice': { params: [4, 5], maxValues: 4, forbids: [2, 3] },
	'each-choice-subset': { params: [3, 4], maxValues: 4, forbids: [0, 0] },
	'criteria-counts': { params: [3, 4], maxValues: 3, forbids: [1, 3] },
	'multi-base': { params: [4, 5], maxValues: 4, forbids: [1, 3] },
	'base-vs-pairwise': { params: [4, 4], maxValues: 4, forbids: [1, 3] },
	'dead-values': { params: [3, 4], maxValues: 3, forbids: [2, 4] }
};

function combScenario(rng: Rng, classId: string, shape: CombShape): CombParams {
	const domain = rng.pick(DOMAINS);
	const chosen = rng
		.sample(
			domain.map((_, k) => k),
			rng.int(...shape.params)
		)
		.sort((a, b) => a - b)
		.map((k) => domain[k] as Parameter);
	const parameters = chosen.map((x) => {
		const count = Math.min(x.values.length, shape.maxValues, rng.int(2, x.values.length));
		return { name: x.name, values: x.values.slice(0, count) };
	});
	const p: CombParams = { kind: 'comb', parameters, forbids: [], base: null, base2: null, tests: [] };
	const values = everyValue(p);
	const forbidCount = rng.int(...shape.forbids);
	for (let guard = 0; p.forbids.length < forbidCount && guard < 50; guard += 1) {
		const [a, b] = rng.sample(values, 2) as [Value, Value];
		if (a[0] === b[0]) continue;
		const [x, y] = a[0] < b[0] ? [a, b] : [b, a];
		if (p.forbids.some(([u, w]) => valueKey(u) === valueKey(x) && valueKey(w) === valueKey(y))) continue;
		p.forbids.push([x, y]);
	}
	if (classId === 'dead-values') {
		// One value is incompatible with every value of another parameter: no valid test can carry it.
		const [i, j] = rng.sample(
			parameters.map((_, k) => k),
			2
		) as [number, number];
		const v = rng.int(0, (parameters[i]?.values.length ?? 1) - 1);
		for (let w = 0; w < (parameters[j]?.values.length ?? 0); w += 1) {
			const pair: [Value, Value] =
				i < j
					? [
							[i, v],
							[j, w]
						]
					: [
							[j, w],
							[i, v]
						];
			if (!p.forbids.some(([u, x]) => valueKey(u) === valueKey(pair[0]) && valueKey(x) === valueKey(pair[1])))
				p.forbids.push(pair);
		}
		p.forbids.sort((x, y) => x[0][0] - y[0][0] || x[0][1] - y[0][1] || x[1][0] - y[1][0] || x[1][1] - y[1][1]);
	}
	const valid = allTests(p).filter((t) => isValid(p, t, RIGHT));
	if (classId !== 'each-choice-subset' && classId !== 'dead-values') p.base = valid.length > 0 ? rng.pick(valid) : null;
	if (classId === 'each-choice-subset') p.tests = rng.sample(valid, Math.min(valid.length, rng.int(6, 8)));
	if (classId === 'multi-base' && p.base) {
		// The second base differs from the first in one to three parameters: their sets share tests or not.
		const first = p.base;
		const differ = rng.int(1, 3);
		p.base2 = valid.find((t) => t.filter((v, i) => v !== first[i]).length === differ && rng.bool(0.3)) ?? null;
	}
	return p;
}

function ceScenario(rng: Rng, classId: string): CeParams {
	const domain = rng.pick(CE_DOMAINS);
	const n = rng.int(5, 6);
	const causes = domain.causes.slice(0, n);
	const indexes = causes.map((_, i) => i);
	const constraints: CeConstraint[] = [];
	const used = new Set<number>();
	const take = (count: number): number[] => {
		const free = indexes.filter((i) => !used.has(i));
		const picked = rng.sample(free, Math.min(count, free.length)).sort((a, b) => a - b);
		for (const i of picked) used.add(i);
		return picked;
	};
	if (classId === 'cause-effect') {
		constraints.push({ type: 'E', members: take(rng.int(2, 3)) });
		constraints.push({ type: 'R', members: rng.shuffle(take(2)) });
		if (rng.bool()) constraints.push({ type: 'I', members: take(2) });
	} else {
		constraints.push({ type: 'O', members: take(rng.int(2, 3)) });
		constraints.push({ type: rng.pick(['R', 'M'] as const), members: rng.shuffle(take(2)) });
		if (rng.bool()) constraints.push({ type: 'R', members: [rng.pick(indexes), rng.pick(indexes)] });
	}
	const leaves = rng.sample(indexes, rng.int(3, Math.min(5, n))).sort((a, b) => a - b);
	const tree = buildTree(rng, leaves);
	const p: CeParams = {
		kind: 'ce',
		causes,
		effect: domain.effect,
		constraints: constraints.filter((c) => c.type !== 'R' || c.members[0] !== c.members[1]),
		expr: render(tree)
	};
	TREES.set(p, tree);
	return p;
}

function solve(p: Params, classId: string, rules: Rules): string {
	return p.kind === 'ce' ? solveCe(p, rules) : solveComb(p, classId, rules);
}

function suits(p: Params, classId: string, answer: string): boolean {
	if (p.kind === 'ce') {
		const [valid = 0, effect = 0] = answer.split(' ').map(Number);
		return effect > 0 && effect < valid;
	}
	switch (classId) {
		case 'base-choice':
			return p.base !== null && !answer.endsWith('| -');
		case 'each-choice-subset':
			return smallestSubsets(p).length === 1 && answer.split(' ').length < p.tests.length;
		case 'criteria-counts':
		case 'base-vs-pairwise':
			return p.base !== null;
		case 'multi-base':
			return p.base !== null && p.base2 !== null;
		case 'dead-values':
			return !answer.startsWith('-');
		default:
			return true;
	}
}

// --- Statements -----------------------------------------------------------------------------------------------------

function parameterList(p: CombParams): string[] {
	return p.parameters.map((x) => `- **${x.name}**: ${x.values.map((v) => `\`${v}\``).join(', ')}`);
}

function forbidList(p: CombParams): string[] {
	if (p.forbids.length === 0) return [];
	return [
		'',
		'Несовместимые значения — тест, в котором они встречаются вместе, недопустим (его нельзя выполнить):',
		'',
		...p.forbids.map(([a, b]) => `- \`${valueName(p, a)}\` и \`${valueName(p, b)}\``)
	];
}

const testText = (p: CombParams, t: readonly number[]): string =>
	t.map((v, i) => `\`${p.parameters[i]?.values[v] ?? ''}\``).join(', ');

function testTable(p: CombParams): string[] {
	return p.tests.map((t, k) => `${k + 1}. ${testText(p, t)}`);
}

const BASE_CHOICE =
	'Набор base-choice: базовый тест и для каждого параметра и каждого его небазового значения ещё один тест, где это значение заменяет базовое, а остальные параметры остаются базовыми. Недопустимый тест в набор не входит.';

function describeComb(p: CombParams, classId: string): string {
	const out = ['Входы функции разбиты на параметры и их значения (классы эквивалентности):', '', ...parameterList(p)];
	out.push(...forbidList(p));
	const base = p.base ? [`Базовый тест: ${testText(p, p.base)}.`] : [];
	out.push('');
	switch (classId) {
		case 'base-choice':
			out.push(
				...base,
				'',
				BASE_CHOICE,
				'',
				'Введите число тестов в наборе base-choice (вместе с базовым), затем знак `|` и значения, которые не попали в набор из-за недопустимости своего теста, — в порядке параметров и значений, как они перечислены выше. Например: `9 | CSV тёмная`.'
			);
			break;
		case 'each-choice-subset':
			out.push(
				'Есть набор тестов (значения в порядке параметров):',
				'',
				...testTable(p),
				'',
				'Критерий each-choice: каждое значение каждого параметра встречается хотя бы в одном тесте. Нужно оставить как можно меньше тестов из набора так, чтобы оставшиеся покрывали все значения, которые покрывает весь набор. Гарантируется, что такое наименьшее подмножество одно.',
				'',
				'Введите через пробел номера оставленных тестов по возрастанию. Например: `1 4 6`.'
			);
			break;
		case 'criteria-counts':
			out.push(
				...base,
				'',
				`Критерий each-choice: каждое значение, которое встречается хотя бы в одном допустимом тесте, есть хотя бы в одном тесте набора. ${BASE_CHOICE}`,
				'',
				'Введите через пробел три числа: наименьшее число допустимых тестов для each-choice, число тестов в наборе base-choice (вместе с базовым) и число всех допустимых комбинаций значений. Например: `4 8 31`.'
			);
			break;
		case 'multi-base':
			out.push(
				...base,
				`Второй базовый тест: ${testText(p, p.base2 ?? [])}.`,
				'',
				`Набор multiple base-choice строят так: для каждого базового теста — свой набор base-choice. ${BASE_CHOICE} Затем оба набора объединяют, и одинаковые тесты оставляют по одному разу.`,
				'',
				'Введите через пробел три числа: сколько тестов в объединённом наборе, сколько тестов выброшено при объединении как повторы и сколько тестов выброшено как недопустимые при построении двух наборов (по каждому набору отдельно, до объединения). Например: `15 2 3`.'
			);
			break;
		case 'base-vs-pairwise':
			out.push(
				...base,
				'',
				BASE_CHOICE,
				'',
				'Команда решает, переходить ли с base-choice на попарное покрытие. Пара — два значения разных параметров; тест покрывает все пары своих значений; покрывать нужно только пары, которые встречаются хотя бы в одном допустимом тесте: пару, которую ограничения исключают — прямо или в сочетании друг с другом, — покрыть нельзя.',
				'',
				'Введите через пробел два числа: число тестов в наборе base-choice (вместе с базовым) и число допустимых пар, которые этот набор не покрывает. Например: `10 23`.'
			);
			break;
		case 'dead-values':
			out.push(
				'Критерий each-choice: каждое значение, которое встречается хотя бы в одном допустимом тесте, есть хотя бы в одном тесте набора.',
				'',
				'Введите через пробел значения, которые не встречаются ни в одном допустимом тесте, в порядке параметров и значений, как они перечислены выше, затем знак `|` и наименьшее число допустимых тестов для each-choice. Например: `ZIP | 4`.'
			);
			break;
	}
	return out.join('\n');
}

const CE_RULES: Record<CeConstraint['type'], (m: string[]) => string> = {
	E: (m) => `E(${m.join(', ')}) — истинной может быть не больше одной из причин`,
	I: (m) => `I(${m.join(', ')}) — истинна хотя бы одна из причин`,
	O: (m) => `O(${m.join(', ')}) — истинна ровно одна из причин`,
	R: ([a = '', b = '']) => `R(${a}, ${b}) — если ${a} истинна, то и ${b} истинна`,
	M: ([a = '', b = '']) => `M(${a}, ${b}) — если ${a} истинна, то ${b} ложна`
};

function describeCe(p: CeParams): string {
	return [
		'Требование задано графом причин и следствий. Причины:',
		'',
		...p.causes.map((c, i) => `- C${i + 1} — ${c};`),
		'',
		`Следствие «${p.effect}» наступает, когда истинно выражение:`,
		'',
		'```',
		p.expr,
		'```',
		'',
		'Ограничения между причинами (комбинация причин, нарушающая любое из них, невозможна):',
		'',
		...p.constraints.map((c) => `- ${CE_RULES[c.type](c.members.map((m) => `C${m + 1}`))};`),
		'',
		'Для таблицы решений перебираются все возможные комбинации значений причин.',
		'',
		'Введите через пробел два числа: сколько комбинаций причин возможно и в скольких из них следствие наступает. Например: `20 7`.'
	].join('\n');
}

const PYTHON_REFERENCE = `import json
from itertools import combinations, product

p = json.loads(input())
cls = p["classId"]

if p["kind"] == "ce":
    n = len(p["causes"])
    valid = effect = 0
    for vals in product([False, True], repeat=n):
        ok = True
        for c in p["constraints"]:
            on = sum(vals[m] for m in c["members"])
            a, b = (c["members"] + [0, 0])[:2]
            if c["type"] == "E":
                ok &= on <= 1
            elif c["type"] == "I":
                ok &= on >= 1
            elif c["type"] == "O":
                ok &= on == 1
            elif c["type"] == "R":
                ok &= (not vals[a]) or vals[b]
            elif c["type"] == "M":
                ok &= not (vals[a] and vals[b])
        if ok:
            valid += 1
            effect += bool(eval(p["expr"], {}, {f"C{i + 1}": vals[i] for i in range(n)}))
    print(valid, effect)
else:
    params = p["parameters"]
    sizes = [len(x["values"]) for x in params]
    k = len(params)
    bad = {(tuple(a), tuple(b)) for a, b in p["forbids"]}


    def ok(t):
        return not any(((i, t[i]), (j, t[j])) in bad for i, j in combinations(range(k), 2))


    def pairs(t):
        return {(i, t[i], j, t[j]) for i, j in combinations(range(k), 2)}


    space = [t for t in product(*[range(s) for s in sizes]) if ok(t)]
    values = [(i, v) for i in range(k) for v in range(sizes[i])]
    reach = [(i, v) for i, v in values if any(t[i] == v for t in space)]
    name = lambda iv: params[iv[0]]["values"][iv[1]]


    def base_choice():
        base = tuple(p["base"])
        tests, lost = [base], []
        for i, v in values:
            if v != base[i]:
                t = base[:i] + (v,) + base[i + 1:]
                (tests if ok(t) else lost).append(t if ok(t) else (i, v))
        return tests, lost


    def fewest(pool, need):
        # Breadth-first over the sets of values covered so far.
        need = frozenset(need)
        level = {frozenset()}
        steps = 0
        while not any(need <= s for s in level):
            level = {s | {(i, t[i]) for i in range(k)} for s in level for t in pool}
            steps += 1
        return steps


    allowed = set().union(*(pairs(t) for t in space))
    if cls == "base-choice":
        tests, lost = base_choice()
        out = f"{len(tests)} | " + (" ".join(name(x) for x in lost) or "-")
    elif cls == "each-choice-subset":
        tests = [tuple(t) for t in p["tests"]]
        need = {(i, t[i]) for t in tests for i in range(k)}
        out = None
        for size in range(1, len(tests) + 1):
            for pick in combinations(range(len(tests)), size):
                if {(i, tests[m][i]) for m in pick for i in range(k)} == need:
                    out = " ".join(str(m + 1) for m in pick)
                    break
            if out:
                break
    elif cls == "criteria-counts":
        out = f"{fewest(space, reach)} {len(base_choice()[0])} {len(space)}"
    elif cls == "multi-base":
        first, lost1 = base_choice()
        p["base"] = p["base2"]
        second, lost2 = base_choice()
        union = set(first) | set(second)
        out = f"{len(union)} {len(first) + len(second) - len(union)} {len(lost1) + len(lost2)}"
    elif cls == "base-vs-pairwise":
        tests, _ = base_choice()
        got = set()
        for t in tests:
            got |= pairs(t)
        out = f"{len(tests)} {len([q for q in allowed if q not in got])}"
    elif cls == "dead-values":
        dead = [x for x in values if x not in reach]
        out = (" ".join(name(x) for x in dead) or "-") + f" | {fewest(space, reach)}"
    print(out)
`;

const WRONG: Record<string, Partial<Rules>> = {
	'no-base-subtract': { noBaseSubtract: true },
	'ignore-constraints': { ignoreConstraints: true },
	'greedy-cover': { greedy: true },
	'each-sum': { eachSum: true },
	'keep-duplicates': { keepDuplicates: true },
	'count-forbidden': { countForbidden: true },
	'e-as-o': { eAsO: true },
	'o-as-e': { oAsE: true },
	'r-symmetric': { rSymmetric: true }
};

/** The misconceptions every instance of a class must expose; the others apply where they change the answer. */
const REQUIRED: Record<string, string[]> = {
	'base-choice': ['no-base-subtract', 'ignore-constraints'],
	'each-choice-subset': ['greedy-cover'],
	'criteria-counts': ['each-sum', 'no-base-subtract', 'ignore-constraints'],
	'multi-base': ['keep-duplicates', 'ignore-constraints'],
	'cause-effect': ['ignore-constraints', 'e-as-o', 'r-symmetric'],
	'base-vs-pairwise': ['count-forbidden', 'ignore-constraints'],
	'dead-values': ['ignore-constraints', 'each-sum'],
	'cause-effect-om': ['ignore-constraints', 'o-as-e']
};

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const { classId } = input;
	const shape = SHAPES[classId];
	// Scenarios are drawn until the question is well posed and every misconception the class must expose changes
	// the answer.
	for (let tries = 0; tries < 1000; tries += 1) {
		const p: Params = shape ? combScenario(rng, classId, shape) : ceScenario(rng, classId);
		const answer = solve(p, classId, RIGHT);
		if (!suits(p, classId, answer)) continue;
		const wrong: Record<string, string | null> = {};
		for (const [id, change] of Object.entries(WRONG)) {
			const value = solve(p, classId, { ...RIGHT, ...change });
			wrong[id] = value === answer ? null : value;
		}
		if ((REQUIRED[classId] ?? []).some((id) => wrong[id] === null)) continue;
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: p.kind === 'ce' ? describeCe(p) : describeComb(p, classId), code: null },
			answer: { kind: 'tokens', value: answer }
		});
		const stdin = JSON.stringify({ classId, ...p });
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
	throw new Error(`${descriptor.key}: no scenario for ${input.grade}/${classId} after 1000 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}
