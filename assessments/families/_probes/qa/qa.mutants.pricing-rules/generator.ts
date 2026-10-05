// QA practice: the candidate reads the pricing rules of a program and writes 5–8 test cases (an input line and the
// expected price). The cases run first on the correct program — one failing case makes the set worthless — and then
// on its mutants: one operator changed at one place. The score is the share of mutants killed among those that are
// not equivalent to the program. The rules, the thresholds and the mutants come from the seed.
import {
	instanceRng,
	levelAndClass,
	makeInstance,
	type Built,
	type QaCase,
	readDescriptor,
	type GenerateInput,
	type HarnessMode,
	type HarnessPart,
	type ItemInstance
} from '../../../_lib/family.ts';
import type { Rng } from '../../../_lib/rng.ts';
import type { HarnessProgram } from '../../../../../src/lib/server/assessments/contract/bank.ts';

const BUDGET = { min: 5, max: 8 };

const descriptor = readDescriptor(import.meta.url);

type Op = '<' | '<=' | '>' | '>=';
interface Var {
	name: string;
	title: string;
	min: number;
	max: number;
}
interface Cond {
	v: string;
	op: Op;
	c: number;
}
type Action =
	| { kind: 'set'; value: number }
	| { kind: 'add'; value: number }
	| { kind: 'per'; v: string; over: number; step: number }
	| { kind: 'percent'; value: number };
interface Rule {
	when: Cond[];
	join: 'and' | 'or';
	then: Action;
}
interface Program {
	title: string;
	vars: Var[];
	/** The starting price: a number, or the value of an input. */
	base: number | string;
	rules: Rule[];
}
interface Mutant {
	id: string;
	operator: string;
	program: Program;
}

function run(program: Program, input: Readonly<Record<string, number>>): number {
	let cost = typeof program.base === 'number' ? program.base : (input[program.base] ?? 0);
	for (const rule of program.rules) {
		const results = rule.when.map((c) => compare(input[c.v] ?? 0, c.op, c.c));
		const hit = rule.join === 'and' ? results.every(Boolean) : results.some(Boolean);
		if (!hit) continue;
		const a = rule.then;
		if (a.kind === 'set') cost = a.value;
		else if (a.kind === 'add') cost += a.value;
		else if (a.kind === 'per') cost += a.step * ((input[a.v] ?? 0) - a.over);
		else cost = Math.floor((cost * a.value) / 100);
	}
	return cost;
}

function compare(x: number, op: Op, c: number): boolean {
	return op === '<' ? x < c : op === '<=' ? x <= c : op === '>' ? x > c : x >= c;
}

const FLIP: Record<Op, Op> = { '<': '<=', '<=': '<', '>': '>=', '>=': '>' };
const TEXT: Record<Op, string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥' };

/** Every one-place mutant of a program: boundaries, logic, constants, a skipped rule, the «over» base, the order. */
function mutants(program: Program): Mutant[] {
	const out: Mutant[] = [];
	const clone = (): Program => structuredClone(program);
	program.rules.forEach((rule, r) => {
		rule.when.forEach((cond, k) => {
			const m = clone();
			const target = m.rules[r]?.when[k];
			if (target) target.op = FLIP[cond.op];
			out.push({
				id: `b${r + 1}${k + 1}`,
				operator: `правило ${r + 1}: ${cond.v} ${TEXT[cond.op]} → ${TEXT[FLIP[cond.op]]}`,
				program: m
			});
		});
		if (rule.when.length > 1) {
			const m = clone();
			const target = m.rules[r];
			if (target) target.join = rule.join === 'and' ? 'or' : 'and';
			out.push({
				id: `l${r + 1}`,
				operator: `правило ${r + 1}: «${rule.join === 'and' ? 'и' : 'или'}» → «${rule.join === 'and' ? 'или' : 'и'}»`,
				program: m
			});
		}
		const action = rule.then;
		if (action.kind === 'per') {
			const m = clone();
			const target = m.rules[r]?.then;
			if (target?.kind === 'per') target.over = action.over + 1;
			out.push({ id: `o${r + 1}`, operator: `правило ${r + 1}: отсчёт сверх ${action.over + 1}`, program: m });
		} else if (action.kind !== 'percent') {
			const m = clone();
			const target = m.rules[r]?.then;
			if (target && target.kind !== 'per' && target.kind !== 'percent') target.value = action.value + 10;
			out.push({
				id: `c${r + 1}`,
				operator: `правило ${r + 1}: значение ${action.value} → ${action.value + 10}`,
				program: m
			});
		}
		const skipped = clone();
		skipped.rules.splice(r, 1);
		out.push({ id: `s${r + 1}`, operator: `правило ${r + 1} не применяется`, program: skipped });
	});
	const last = program.rules.length - 1;
	if (last >= 1) {
		const m = clone();
		const [a, b] = [m.rules[last - 1], m.rules[last]];
		if (a && b) [m.rules[last - 1], m.rules[last]] = [b, a];
		out.push({ id: 'x', operator: `правила ${last} и ${last + 1} переставлены`, program: m });
	}
	return out;
}

/** Every input of the domain, in a fixed order. */
function domain(program: Program): Record<string, number>[] {
	let points: Record<string, number>[] = [{}];
	for (const v of program.vars) {
		const next: Record<string, number>[] = [];
		for (const p of points) for (let x = v.min; x <= v.max; x += 1) next.push({ ...p, [v.name]: x });
		points = next;
	}
	return points;
}

const line = (program: Program, input: Readonly<Record<string, number>>): string =>
	program.vars.map((v) => input[v.name] ?? 0).join(' ');

/** Inputs near every threshold, the rest of the variables at random points of their range. */
function boundaryCandidates(rng: Rng, program: Program): Record<string, number>[] {
	const out: Record<string, number>[] = [];
	const random = (): Record<string, number> =>
		Object.fromEntries(program.vars.map((v) => [v.name, rng.int(v.min, v.max)]));
	const thresholds = program.rules.flatMap((r) => r.when);
	for (let round = 0; round < 6; round += 1) {
		for (const cond of thresholds) {
			for (const delta of [-1, 0, 1]) {
				const p = random();
				// Push the other conditions of the same rule both ways, so «and» and «or» can be told apart.
				for (const other of thresholds) if (other !== cond && rng.bool()) p[other.v] = other.c + rng.pick([-1, 0, 1]);
				p[cond.v] = cond.c + delta;
				if (program.vars.every((v) => (p[v.name] ?? v.min - 1) >= v.min && (p[v.name] ?? v.max + 1) <= v.max))
					out.push(p);
			}
		}
	}
	return out;
}

/** A small set of cases that kills every killable mutant: greedy cover over boundary candidates. */
function coverSet(rng: Rng, program: Program, alive: readonly Mutant[]): Record<string, number>[] | null {
	const candidates = boundaryCandidates(rng, program);
	const remaining = new Set(alive.map((m) => m.id));
	const chosen: Record<string, number>[] = [];
	while (remaining.size > 0) {
		let best: Record<string, number> | null = null;
		let bestKills: string[] = [];
		for (const p of candidates) {
			const expected = run(program, p);
			const kills = alive.filter((m) => remaining.has(m.id) && run(m.program, p) !== expected).map((m) => m.id);
			if (kills.length > bestKills.length) [best, bestKills] = [p, kills];
		}
		if (!best) return null;
		chosen.push(best);
		for (const id of bestKills) remaining.delete(id);
	}
	return chosen;
}

const cond = (v: string, op: Op, c: number): Cond => ({ v, op, c });

function makeProgram(rng: Rng, classId: string, junior: boolean): Program {
	if (classId === 'delivery') {
		const vars = [
			{ name: 'weight', title: 'вес посылки, кг', min: 1, max: 60 },
			{ name: 'distance', title: 'расстояние, км', min: 1, max: 400 },
			{ name: 'member', title: 'участник клуба: 1 — да, 0 — нет', min: 0, max: 1 }
		];
		const w1 = rng.int(3, 12);
		const w2 = w1 + rng.int(8, 20);
		const d = rng.int(10, 30) * 10;
		const rules: Rule[] = [
			{
				when: [cond('weight', rng.pick<Op>(['>', '>=']), w1)],
				join: 'and',
				then: { kind: 'set', value: rng.int(40, 60) * 10 }
			},
			{
				when: [cond('weight', '>', w2)],
				join: 'and',
				then: { kind: 'per', v: 'weight', over: w2, step: rng.int(2, 6) * 5 }
			},
			{
				when: [cond('distance', rng.pick<Op>(['>', '>=']), d)],
				join: 'and',
				then: { kind: 'add', value: rng.int(10, 25) * 10 }
			}
		];
		if (junior) {
			rules.push({
				when: [cond('member', '>=', 1), cond('weight', '<=', w2)],
				join: 'and',
				then: { kind: 'percent', value: rng.pick([70, 75, 80, 90]) }
			});
			rules.push({
				when: [cond('distance', '<', rng.int(2, 6) * 10), cond('weight', '<', w1)],
				join: 'and',
				then: { kind: 'set', value: 0 }
			});
		} else {
			rules.push({
				when: [cond('member', '>=', 1)],
				join: 'and',
				then: { kind: 'percent', value: rng.pick([70, 75, 80, 90]) }
			});
		}
		return { title: 'Стоимость доставки', vars, base: rng.int(20, 35) * 10, rules };
	}
	if (classId === 'subscription') {
		const vars = [
			{ name: 'users', title: 'число пользователей', min: 1, max: 60 },
			{ name: 'months', title: 'срок подписки, месяцев', min: 1, max: 36 }
		];
		const included = rng.int(3, 10);
		const bulk = included + rng.int(10, 25);
		const rules: Rule[] = [
			{
				when: [cond('users', '>', included)],
				join: 'and',
				then: { kind: 'per', v: 'users', over: included, step: rng.int(2, 6) * 10 }
			},
			{
				when: [cond('months', rng.pick<Op>(['>=', '>']), 12)],
				join: 'and',
				then: { kind: 'percent', value: rng.pick([80, 85, 90]) }
			},
			{ when: [cond('users', '>=', bulk)], join: 'and', then: { kind: 'add', value: -rng.int(5, 20) * 10 } }
		];
		if (junior) {
			rules.push({
				when: [cond('months', '>=', 24), cond('users', '<', included + rng.int(2, 6))],
				join: rng.pick(['and', 'or'] as const),
				then: { kind: 'add', value: -rng.int(3, 9) * 10 }
			});
		}
		return { title: 'Стоимость подписки', vars, base: rng.int(30, 80) * 10, rules };
	}
	if (classId === 'discount') {
		const vars = [
			{ name: 'total', title: 'сумма корзины, руб.', min: 1, max: 3000 },
			{ name: 'items', title: 'число товаров', min: 1, max: 30 }
		];
		const t1 = rng.int(5, 15) * 100;
		const t2 = t1 + rng.int(5, 10) * 100;
		const n1 = rng.int(3, 10);
		const rules: Rule[] = [
			{
				when: [cond('total', rng.pick<Op>(['>=', '>']), t1)],
				join: 'and',
				then: { kind: 'percent', value: rng.pick([95, 90]) }
			},
			{ when: [cond('items', '>=', n1)], join: 'and', then: { kind: 'add', value: -rng.int(5, 20) * 10 } },
			{
				when: [cond('total', '<', rng.int(3, 8) * 100)],
				join: 'and',
				then: { kind: 'add', value: rng.int(10, 30) * 10 }
			}
		];
		if (junior) {
			rules.splice(1, 1, {
				when: [cond('items', '>=', n1), cond('total', '>=', t2)],
				join: rng.pick(['and', 'or'] as const),
				then: { kind: 'add', value: -rng.int(5, 20) * 10 }
			});
			rules.push({
				when: [cond('items', '>', n1 + rng.int(5, 15)), cond('total', '<', t1)],
				join: 'or',
				then: { kind: 'percent', value: 98 }
			});
		}
		return { title: 'Итог корзины', vars, base: 'total', rules };
	}
	const vars = [
		{ name: 'age', title: 'возраст, полных лет', min: 0, max: 99 },
		{ name: 'hour', title: 'час начала сеанса, 0–23', min: 0, max: 23 }
	];
	const child = rng.int(5, 8);
	const senior = rng.int(60, 70);
	const night = rng.int(21, 23);
	const rules: Rule[] = [
		{ when: [cond('age', '<', child)], join: 'and', then: { kind: 'set', value: 0 } },
		{ when: [cond('age', '>=', senior)], join: 'and', then: { kind: 'percent', value: rng.pick([50, 60, 70]) } },
		{
			when: [cond('hour', '>=', night), cond('hour', '<', rng.int(5, 7))],
			join: 'or',
			then: { kind: 'add', value: rng.int(5, 15) * 10 }
		}
	];
	if (junior) {
		rules.push({
			when: [cond('age', rng.pick<Op>(['<', '<=']), rng.int(14, 18)), cond('hour', '>=', night - rng.int(1, 2))],
			join: 'and',
			then: { kind: 'set', value: 0 }
		});
	}
	return { title: 'Цена билета', vars, base: rng.int(30, 60) * 10, rules };
}

function actionText(a: Action, vars: readonly Var[]): string {
	if (a.kind === 'set') return `цена становится ${a.value}`;
	if (a.kind === 'add') return a.value >= 0 ? `к цене прибавляется ${a.value}` : `из цены вычитается ${-a.value}`;
	if (a.kind === 'per')
		return `к цене прибавляется ${a.step} за каждую единицу величины «${vars.find((v) => v.name === a.v)?.title ?? a.v}» сверх ${a.over}`;
	return `цена умножается на ${a.value} и делится на 100 с округлением вниз`;
}

function specification(program: Program): string {
	const base =
		typeof program.base === 'number'
			? `Начальная цена — ${program.base}.`
			: `Начальная цена равна величине «${program.vars.find((v) => v.name === program.base)?.title ?? program.base}».`;
	return [
		`Программа «${program.title}» читает одну строку — целые числа через пробел:`,
		...program.vars.map((v) => `- \`${v.name}\` — ${v.title}, от ${v.min} до ${v.max};`),
		'',
		`и печатает итоговую цену (целое число). ${base} Затем по порядку применяются правила; каждое правило, чьё условие выполнено, меняет текущую цену:`,
		'',
		...program.rules.map(
			(r, i) =>
				`${i + 1}. Если ${r.when.map((c) => `\`${c.v} ${TEXT[c.op]} ${c.c}\``).join(r.join === 'and' ? ' и ' : ' или ')} — ${actionText(r.then, program.vars)}.`
		)
	].join('\n');
}

function pythonFunction(name: string, program: Program): string {
	const args = program.vars.map((v) => v.name).join(', ');
	const lines = [`def ${name}(${args}):`, `    cost = ${String(program.base)}`];
	for (const r of program.rules) {
		lines.push(`    if ${r.when.map((c) => `${c.v} ${c.op} ${c.c}`).join(` ${r.join} `)}:`);
		const a = r.then;
		if (a.kind === 'set') lines.push(`        cost = ${a.value}`);
		else if (a.kind === 'add') lines.push(`        cost += ${a.value}`);
		else if (a.kind === 'per') lines.push(`        cost += ${a.step} * (${a.v} - ${a.over})`);
		else lines.push(`        cost = cost * ${a.value} // 100`);
	}
	lines.push('    return cost');
	return lines.join('\n');
}

/**
 * The harness of contract 6.5 in one mode: the candidate's cases (JSON `[{input, expected}]`) on standard input, one
 * line out — a character per case on the reference (`1` passes), or a character per mutant in the instance's order
 * (`1` some case kills it).
 */
function harnessSource(program: Program, list: readonly Mutant[], mode: HarnessMode): string {
	const bounds = JSON.stringify(program.vars.map((v) => [v.min, v.max]));
	return [
		'import json',
		'import sys',
		'',
		pythonFunction('reference', program),
		'',
		...list.flatMap((m) => [pythonFunction(`mutant_${m.id}`, m.program), '']),
		`MUTANTS = [${list.map((m) => `("${m.id}", mutant_${m.id})`).join(', ')}]`,
		`BOUNDS = ${bounds}`,
		'',
		'def parse(case):',
		'    try:',
		'        args = [int(x) for x in case["input"].split()]',
		'        expected = int(case["expected"].strip())',
		'    except (ValueError, KeyError, AttributeError):',
		'        return None',
		'    if len(args) != len(BOUNDS) or any(not lo <= a <= hi for a, (lo, hi) in zip(args, BOUNDS)):',
		'        return None',
		'    return args, expected',
		'',
		'cases = [parse(c) for c in json.load(sys.stdin)]',
		...(mode === 'reference'
			? ['print("".join("1" if c is not None and reference(*c[0]) == c[1] else "0" for c in cases))']
			: [
					'print("".join("1" if any(c is not None and fn(*c[0]) != c[1] for c in cases) else "0" for _, fn in MUTANTS))'
				])
	].join('\n');
}

/** The whole domain against the reference: which mutants no input tells apart. */
function differential(program: Program, list: readonly Mutant[]): string {
	return [
		'import itertools',
		'import json',
		'',
		pythonFunction('reference', program),
		'',
		...list.flatMap((m) => [pythonFunction(`mutant_${m.id}`, m.program), '']),
		`MUTANTS = [${list.map((m) => `("${m.id}", mutant_${m.id})`).join(', ')}]`,
		`RANGES = [${program.vars.map((v) => `range(${v.min}, ${v.max + 1})`).join(', ')}]`,
		'points = list(itertools.product(*RANGES))',
		'expected = [reference(*p) for p in points]',
		'print(json.dumps({mid: all(fn(*p) == e for p, e in zip(points, expected)) for mid, fn in MUTANTS}))'
	].join('\n');
}

/**
 * Every mutant compared with the program over the whole input domain: equivalent when no input tells them apart. Kept
 * in its own function, so the domain is not held by the closures of the built instance.
 */
function withEquivalence(program: Program, list: readonly Mutant[]): (Mutant & { equivalent: boolean })[] {
	const points = domain(program);
	const expected = points.map((p) => run(program, p));
	return list.map((m) => ({ ...m, equivalent: points.every((p, i) => run(m.program, p) === expected[i]) }));
}

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	for (let tries = 0; tries < 50; tries += 1) {
		const program = makeProgram(rng, input.classId, junior);
		const list = withEquivalence(program, mutants(program));
		const killable = list.filter((m) => !m.equivalent);
		if (killable.length < 6) continue;
		const cover = coverSet(rng, program, killable);
		if (!cover || cover.length > BUDGET.max) continue;
		const model = [...cover];
		while (model.length < BUDGET.min)
			model.push(Object.fromEntries(program.vars.map((v) => [v.name, rng.int(v.min, v.max)])));
		const cases: QaCase[] = model.map((p) => ({ input: line(program, p), expected: String(run(program, p)) }));
		const typical: QaCase[] = Array.from({ length: BUDGET.min }, () => {
			const p = Object.fromEntries(program.vars.map((v) => [v.name, typicalValue(rng, v, program)]));
			return { input: line(program, p), expected: String(run(program, p)) };
		});
		const exhaustive: QaCase[] = Array.from({ length: BUDGET.max + rng.int(4, 12) }, () => {
			const p = Object.fromEntries(program.vars.map((v) => [v.name, rng.int(v.min, v.max)]));
			return { input: line(program, p), expected: String(run(program, p)) };
		});
		const wrongExpected = cases.map((c, i) => (i === 0 ? { ...c, expected: String(Number(c.expected) + 10) } : c));
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: [
					'Ниже — спецификация программы. Составьте от 5 до 8 тест-кейсов: строку входа и ожидаемый вывод. Кейсы сначала',
					'запускаются на правильной программе — если хоть один не совпадёт с ней, набор не засчитывается. Затем — на',
					'изменённых версиях программы (мутантах): мутант пойман, если хотя бы на одном кейсе его вывод отличается от',
					'ожидаемого. Балл — доля пойманных мутантов. Код программы и мутантов не показывается.'
				].join(' '),
				code: null
			},
			answer: null,
			qa: {
				budget: BUDGET,
				specification: specification(program),
				mutants: list.map((m) => ({ id: m.id, operator: m.operator, equivalent: m.equivalent }))
			}
		});
		return {
			instance,
			reference: () => ({
				kind: 'qa',
				harness: {
					reference: harnessSource(program, list, 'reference'),
					mutants: harnessSource(program, list, 'mutants')
				},
				cases,
				differential: differential(program, list)
			}),
			wrong: () => ({
				'typical-only': { kind: 'cases', cases: typical },
				'wrong-expected': { kind: 'cases', cases: wrongExpected },
				exhaustive: { kind: 'cases', cases: exhaustive }
			})
		};
	}
	throw new Error(`${descriptor.key}: no program for ${input.grade}/${input.classId} after 50 tries`);
}

/**
 * A «typical» value of a variable: at least 3 away from every threshold on it. A flag (0 or 1) has no such value;
 * it takes its lower end, the value a tester who skips the flag's boundary tries.
 */
function typicalValue(rng: Rng, v: Var, program: Program): number {
	const thresholds = program.rules
		.flatMap((r) => r.when)
		.filter((c) => c.v === v.name)
		.map((c) => c.c);
	const far = Array.from({ length: v.max - v.min + 1 }, (_, i) => v.min + i).filter((x) =>
		thresholds.every((c) => Math.abs(x - c) >= 3)
	);
	return far.length > 0 ? rng.pick(far) : v.min;
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}

/** The harness the engine runs for an instance: rebuilt from the instance's seed, grade and class. */
export function harness(instance: ItemInstance, mode: HarnessMode, part: HarnessPart = 'task'): HarnessProgram {
	if (part !== 'task') throw new Error(`${descriptor.key}: no change step at ${instance.grade}`);
	const probe = build({ seed: instance.seed, grade: instance.grade, classId: instance.classId }).reference();
	if (probe.kind !== 'qa') throw new Error(`${descriptor.key}: the reference of a QA instance is not a harness`);
	return { language: 'python3', source: probe.harness[mode] };
}
