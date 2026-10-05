// QA practice over an ordered table of rules — a decision table with priorities: the program reads fields (integers in
// ranges and words from closed lists), checks the rules in order and prints the outcome of the first rule whose
// conditions all hold; the last rule has no conditions. Field validation with error codes and the status codes of an
// API handler are such tables. Here: the model the generators compute with, its one-place mutants, the kill matrix
// over the whole input domain, the Python of the reference and the mutants, and the text of the specification.
import type { QaPrograms } from './qa.ts';
import type { Rng } from './rng.ts';

export type Field =
	| { name: string; title: string; kind: 'int'; min: number; max: number }
	| { name: string; title: string; kind: 'enum'; values: readonly string[] };

export type Cmp = '<' | '<=' | '>' | '>=';

/** A word of the field is (`in`) or is not (`notin`) in the list. */
export interface ListPred {
	field: string;
	op: 'in' | 'notin';
	values: readonly string[];
}

/** An integer field compared with a constant. */
export interface CmpPred {
	field: string;
	op: Cmp;
	c: number;
}

export type Pred = ListPred | CmpPred;

const isList = (p: Pred): p is ListPred => p.op === 'in' || p.op === 'notin';

/** A rule: when every condition holds, the program prints `out`; no conditions — always. */
export interface Rule {
	when: readonly Pred[];
	out: string;
}

export interface RuleProgram {
	fields: readonly Field[];
	/** In order of priority; the last one has no conditions. */
	rules: readonly Rule[];
}

/** An input: the values of the fields in their order. */
export type Point = readonly (number | string)[];

export interface RuleMutant {
	id: string;
	operator: string;
	program: RuleProgram;
}

const FLIP: Record<Cmp, Cmp> = { '<': '<=', '<=': '<', '>': '>=', '>=': '>' };
const CMP_TEXT: Record<Cmp, string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥' };

/** The program as a function of a point: the outcome of the first rule that holds. */
export function compileRules(program: RuleProgram): (point: Point) => string {
	const index = new Map(program.fields.map((f, i) => [f.name, i]));
	const tests = program.rules.map((rule) => {
		const preds = rule.when.map((p): ((point: Point) => boolean) => {
			const i = index.get(p.field);
			if (i === undefined) throw new Error(`rule over an unknown field ${p.field}`);
			if (isList(p)) {
				const set = new Set(p.values);
				const inside = p.op === 'in';
				return (point) => set.has(point[i] as string) === inside;
			}
			const c = p.c;
			switch (p.op) {
				case '<':
					return (point) => (point[i] as number) < c;
				case '<=':
					return (point) => (point[i] as number) <= c;
				case '>':
					return (point) => (point[i] as number) > c;
				case '>=':
					return (point) => (point[i] as number) >= c;
			}
		});
		return { preds, out: rule.out };
	});
	return (point) => {
		for (const t of tests) if (t.preds.every((p) => p(point))) return t.out;
		throw new Error('no rule holds: the last rule must have no conditions');
	};
}

/** Every point of the input domain, the first field varying slowest (the order of `itertools.product`). */
export function domainPoints(fields: readonly Field[]): Point[] {
	let points: (number | string)[][] = [[]];
	for (const f of fields) {
		const values: (number | string)[] =
			f.kind === 'int' ? Array.from({ length: f.max - f.min + 1 }, (_, i) => f.min + i) : [...f.values];
		points = points.flatMap((p) => values.map((v) => [...p, v]));
	}
	return points;
}

/** The input line of a point: values through a space. */
export const pointLine = (point: Point): string => point.join(' ');

const conditional = (program: RuleProgram): number => program.rules.length - 1;

function replaceRule(program: RuleProgram, r: number, rule: Rule): RuleProgram {
	return { fields: program.fields, rules: program.rules.map((x, i) => (i === r ? rule : x)) };
}

function enumValues(program: RuleProgram, field: string): readonly string[] {
	const f = program.fields.find((x) => x.name === field);
	return f?.kind === 'enum' ? f.values : [];
}

/**
 * Every one-place mutant of the program: a comparison made strict or not strict, a word dropped from or added to one list of a rule,
 * a condition of a rule lost, two neighbouring rules swapped, a rule skipped, a rule printing another outcome. The words
 * dropped and added and the wrong outcome come from the seed.
 */
export function ruleMutants(rng: Rng, program: RuleProgram): RuleMutant[] {
	const out: RuleMutant[] = [];
	const n = conditional(program);
	const outcomes = [...new Set(program.rules.map((r) => r.out))];
	for (let r = 0; r < n; r += 1) {
		const rule = program.rules[r] as Rule;
		const no = r + 1;
		const setPred = (k: number, pred: Pred): RuleProgram =>
			replaceRule(program, r, { ...rule, when: rule.when.map((x, j) => (j === k ? pred : x)) });
		// One change of a list per rule: a word dropped from it or added to it.
		const listChanges: RuleMutant[] = [];
		rule.when.forEach((p, k) => {
			if (isList(p)) {
				const members = p.values;
				const others = enumValues(program, p.field).filter((v) => !members.includes(v));
				if (members.length >= 2) {
					const drop = rng.pick(members);
					listChanges.push({
						id: `l${no}`,
						operator: `правило ${no}: из списка \`${p.field}\` пропало \`${drop}\``,
						program: setPred(k, { ...p, values: members.filter((v) => v !== drop) })
					});
				}
				if (others.length >= 1) {
					const add = rng.pick(others);
					listChanges.push({
						id: `l${no}`,
						operator: `правило ${no}: в список \`${p.field}\` попало \`${add}\``,
						program: setPred(k, { ...p, values: [...members, add] })
					});
				}
			} else {
				out.push({
					id: `b${no}_${k + 1}`,
					operator: `правило ${no}: \`${p.field} ${CMP_TEXT[p.op]} ${p.c}\` → \`${CMP_TEXT[FLIP[p.op]]}\``,
					program: setPred(k, { ...p, op: FLIP[p.op] })
				});
			}
		});
		if (listChanges.length > 0) out.push(rng.pick(listChanges));
		if (rule.when.length >= 2) {
			const k = rng.int(0, rule.when.length - 1);
			out.push({
				id: `d${no}`,
				operator: `правило ${no}: потеряно условие на \`${rule.when[k]?.field ?? ''}\``,
				program: replaceRule(program, r, { ...rule, when: rule.when.filter((_, j) => j !== k) })
			});
		}
		if (r + 1 < n) {
			const rules = [...program.rules];
			[rules[r], rules[r + 1]] = [rules[r + 1] as Rule, rule];
			out.push({ id: `x${no}`, operator: `правила ${no} и ${no + 1} переставлены`, program: { ...program, rules } });
		}
		out.push({
			id: `s${no}`,
			operator: `правило ${no} не проверяется`,
			program: { fields: program.fields, rules: program.rules.filter((_, i) => i !== r) }
		});
		const others = outcomes.filter((o) => o !== rule.out);
		if (others.length > 0) {
			const wrong = rng.pick(others);
			out.push({
				id: `o${no}`,
				operator: `правило ${no}: вывод \`${rule.out}\` → \`${wrong}\``,
				program: replaceRule(program, r, { ...rule, out: wrong })
			});
		}
	}
	return out;
}

/** Outcomes of the program and of every mutant over a set of points: which mutants each point kills. */
export function killMatrix(
	program: RuleProgram,
	mutants: readonly RuleMutant[],
	points: readonly Point[]
): { expected: string[]; kills: string[][] } {
	const reference = compileRules(program);
	const runs = mutants.map((m) => ({ id: m.id, run: compileRules(m.program) }));
	const expected = points.map(reference);
	const kills = points.map((p, i) => runs.filter((m) => m.run(p) !== expected[i]).map((m) => m.id));
	return { expected, kills };
}

const pyValue = (v: string | number): string => (typeof v === 'number' ? String(v) : JSON.stringify(v));

function pyPred(p: Pred): string {
	if (isList(p)) return `${p.field} ${p.op === 'in' ? 'in' : 'not in'} (${p.values.map(pyValue).join(', ')},)`;
	return `${p.field} ${p.op} ${p.c}`;
}

function pyFunction(name: string, program: RuleProgram): string {
	const lines = [`def ${name}(${program.fields.map((f) => f.name).join(', ')}):`];
	for (const rule of program.rules) {
		if (rule.when.length === 0) lines.push(`    return ${JSON.stringify(rule.out)}`);
		else {
			lines.push(`    if ${rule.when.map(pyPred).join(' and ')}:`, `        return ${JSON.stringify(rule.out)}`);
		}
	}
	return lines.join('\n');
}

/** The Python of the harness: the input line is the fields' values through spaces, the output one line of words. */
export function rulePrograms(program: RuleProgram, mutants: readonly RuleMutant[]): QaPrograms {
	const spec = program.fields.map((f) =>
		f.kind === 'int' ? `("int", ${f.min}, ${f.max})` : `("enum", (${f.values.map(pyValue).join(', ')},))`
	);
	return {
		io: [
			`FIELDS = [${spec.join(', ')}]`,
			'',
			'def parse(text):',
			'    words = text.split()',
			'    if len(words) != len(FIELDS):',
			'        return None',
			'    args = []',
			'    for word, field in zip(words, FIELDS):',
			'        if field[0] == "int":',
			'            if not word.isascii() or not word.isdigit():',
			'                return None',
			'            value = int(word)',
			'            if not field[1] <= value <= field[2]:',
			'                return None',
			'        elif word in field[1]:',
			'            value = word',
			'        else:',
			'            return None',
			'        args.append(value)',
			'    return tuple(args)',
			'',
			'def expect(text):',
			'    value = " ".join(text.split())',
			'    return value or None'
		].join('\n'),
		reference: pyFunction('reference', program),
		mutants: mutants.map((m) => ({ id: m.id, source: pyFunction(`mutant_${m.id}`, m.program) })),
		domain: [
			'import itertools',
			`DOMAIN = itertools.product(${program.fields
				.map((f) => (f.kind === 'int' ? `range(${f.min}, ${f.max + 1})` : `(${f.values.map(pyValue).join(', ')},)`))
				.join(', ')})`
		].join('\n')
	};
}

function predText(p: Pred): string {
	if (!isList(p)) return `\`${p.field} ${CMP_TEXT[p.op]} ${p.c}\``;
	const list = p.values.map((v) => `\`${v}\``);
	if (p.op === 'in')
		return p.values.length === 1
			? `\`${p.field}\` равно ${list[0] ?? ''}`
			: `\`${p.field}\` — одно из ${list.join(', ')}`;
	return p.values.length === 1
		? `\`${p.field}\` не равно ${list[0] ?? ''}`
		: `\`${p.field}\` — не из ${list.join(', ')}`;
}

/** The rules as a numbered Markdown list: «Если … и …, вывод `X`.», the last one «Иначе — вывод `X`.» */
export function rulesText(program: RuleProgram): string[] {
	return program.rules.map((rule, i) =>
		rule.when.length === 0
			? `${i + 1}. Иначе — вывод \`${rule.out}\`.`
			: `${i + 1}. Если ${rule.when.map(predText).join(' и ')}, вывод \`${rule.out}\`.`
	);
}

/** The fields as a Markdown list: name, meaning and every allowed value. */
export function fieldsText(fields: readonly Field[]): string[] {
	return fields.map((f) =>
		f.kind === 'int'
			? `- \`${f.name}\` — ${f.title}, целое от ${f.min} до ${f.max};`
			: `- \`${f.name}\` — ${f.title}: ${f.values.map((v) => `\`${v}\``).join(', ')};`
	);
}

/** Whether a point is far (by `margin` and more) from every threshold on its integer fields. */
export function farFromThresholds(program: RuleProgram, point: Point, margin: number): boolean {
	return program.fields.every((f, i) => {
		if (f.kind !== 'int') return true;
		const value = point[i] as number;
		return program.rules.every((r) =>
			r.when.every((p) => p.field !== f.name || isList(p) || Math.abs(value - p.c) >= margin)
		);
	});
}

/** How many conditional rules hold at a point: one «fault» per case leaves the priorities of the rules untested. */
export function rulesHolding(program: RuleProgram): (point: Point) => number {
	const single = program.rules.slice(0, conditional(program)).map((rule) =>
		compileRules({
			fields: program.fields,
			rules: [
				{ ...rule, out: '1' },
				{ when: [], out: '0' }
			]
		})
	);
	return (point) => single.filter((run) => run(point) === '1').length;
}
