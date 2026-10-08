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
	type ItemInstance
} from '../../_lib/family.ts';
import { greedyCover, QA_BUDGET, QA_TASK_TEXT, qaBuilt, type QaPrograms, qaHarnessOf } from '../../_lib/qa.ts';
import type { Rng } from '../../_lib/rng.ts';

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
	return greedyCover(
		boundaryCandidates(rng, program),
		(p) => String(run(program, p)),
		alive.map((m) => ({ id: m.id, run: (p: Record<string, number>) => String(run(m.program, p)) }))
	);
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

/** The reference and the mutants as Python over the input line: integers within the ranges of the specification. */
function programs(program: Program, list: readonly Mutant[]): QaPrograms {
	return {
		io: [
			`BOUNDS = ${JSON.stringify(program.vars.map((v) => [v.min, v.max]))}`,
			'',
			'def parse(text):',
			'    try:',
			'        args = tuple(int(x) for x in text.split())',
			'    except ValueError:',
			'        return None',
			'    if len(args) != len(BOUNDS) or any(not lo <= a <= hi for a, (lo, hi) in zip(args, BOUNDS)):',
			'        return None',
			'    return args',
			'',
			'def expect(text):',
			'    try:',
			'        return int(text.strip())',
			'    except ValueError:',
			'        return None'
		].join('\n'),
		reference: pythonFunction('reference', program),
		mutants: list.map((m) => ({ id: m.id, source: pythonFunction(`mutant_${m.id}`, m.program) })),
		domain: [
			'import itertools',
			`DOMAIN = itertools.product(${program.vars.map((v) => `range(${v.min}, ${v.max + 1})`).join(', ')})`
		].join('\n')
	};
}

/**
 * Every mutant compared with the program over the whole input domain: equivalent when no input tells them apart;
 * `null` when somewhere in the domain the program prints a negative price or rounds down a negative one (the
 * specification does not define either). Kept in its own function, so the domain is not held by
 * the closures of the built instance.
 */
function withEquivalence(program: Program, list: readonly Mutant[]): (Mutant & { equivalent: boolean })[] | null {
	const reference = compileNumeric(program, true);
	const runs = list.map((m) => compileNumeric(m.program));
	const differs = new Uint8Array(list.length);
	const x = new Float64Array(program.vars.map((v) => v.min));
	// Every point of the domain, the last variable varying fastest, in one reused array.
	for (;;) {
		const expected = reference(x);
		if (Number.isNaN(expected)) return null;
		runs.forEach((r, i) => {
			if (differs[i] === 0 && r(x) !== expected) differs[i] = 1;
		});
		let k = program.vars.length - 1;
		for (; k >= 0; k -= 1) {
			const v = program.vars[k] as Var;
			if ((x[k] as number) < v.max) {
				x[k] = (x[k] as number) + 1;
				break;
			}
			x[k] = v.min;
		}
		if (k < 0) break;
	}
	return list.map((m, i) => ({ ...m, equivalent: differs[i] === 0 }));
}

/**
 * The program over the values of its variables in their order: `run` without lookups by name. `nonNegative` — NaN
 * when the final price is negative or a percent rule meets a negative price.
 */
function compileNumeric(program: Program, nonNegative = false): (x: Float64Array) => number {
	const at = (name: string): number => program.vars.findIndex((v) => v.name === name);
	const base = typeof program.base === 'number' ? -1 : at(program.base);
	const baseValue = typeof program.base === 'number' ? program.base : 0;
	const rules = program.rules.map((r) => ({
		and: r.join === 'and',
		when: r.when.map((c) => ({ i: at(c.v), op: c.op, c: c.c })),
		then: r.then,
		per: r.then.kind === 'per' ? at(r.then.v) : -1
	}));
	return (x) => {
		let cost = base < 0 ? baseValue : (x[base] as number);
		for (const rule of rules) {
			let hit = rule.and;
			for (const c of rule.when) {
				const ok = compare(x[c.i] as number, c.op, c.c);
				if (rule.and ? !ok : ok) {
					hit = !rule.and;
					break;
				}
			}
			if (!hit) continue;
			const a = rule.then;
			if (a.kind === 'set') cost = a.value;
			else if (a.kind === 'add') cost += a.value;
			else if (a.kind === 'per') cost += a.step * ((x[rule.per] as number) - a.over);
			else if (nonNegative && cost < 0) return NaN;
			else cost = Math.floor((cost * a.value) / 100);
		}
		return nonNegative && cost < 0 ? NaN : cost;
	};
}

const toPrograms = (x: { program: Program; list: readonly Mutant[] }): QaPrograms => programs(x.program, x.list);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	for (let tries = 0; tries < 50; tries += 1) {
		const program = makeProgram(rng, input.classId, junior);
		const list = withEquivalence(program, mutants(program));
		if (list === null) continue;
		const killable = list.filter((m) => !m.equivalent);
		if (killable.length < 6) continue;
		const cover = coverSet(rng, program, killable);
		if (!cover || cover.length > QA_BUDGET.max) continue;
		const model = [...cover];
		while (model.length < QA_BUDGET.min)
			model.push(Object.fromEntries(program.vars.map((v) => [v.name, rng.int(v.min, v.max)])));
		const cases: QaCase[] = model.map((p) => ({ input: line(program, p), expected: String(run(program, p)) }));
		const typical: QaCase[] = Array.from({ length: QA_BUDGET.min }, () => {
			const p = Object.fromEntries(program.vars.map((v) => [v.name, typicalValue(rng, v, program)]));
			return { input: line(program, p), expected: String(run(program, p)) };
		});
		const exhaustive: QaCase[] = Array.from({ length: QA_BUDGET.max + rng.int(4, 12) }, () => {
			const p = Object.fromEntries(program.vars.map((v) => [v.name, rng.int(v.min, v.max)]));
			return { input: line(program, p), expected: String(run(program, p)) };
		});
		const wrongExpected = cases.map((c, i) => (i === 0 ? { ...c, expected: String(Number(c.expected) + 10) } : c));
		const instance = makeInstance(descriptor, input, {
			statement: {
				markdown: QA_TASK_TEXT,
				code: null
			},
			answer: null,
			qa: {
				budget: QA_BUDGET,
				specification: specification(program),
				mutants: list.map((m) => ({ id: m.id, operator: m.operator, equivalent: m.equivalent }))
			}
		});
		return qaBuilt(instance, toPrograms, { source: { program, list }, cases }, null, {
			'typical-only': typical,
			'wrong-expected': wrongExpected,
			exhaustive
		});
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

/** The harness the engine runs for an instance and a part. */
export const harness = qaHarnessOf(descriptor.key, build);
