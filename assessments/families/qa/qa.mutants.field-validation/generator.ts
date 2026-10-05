// QA practice: the candidate reads the validation rules of a form — integer fields in ranges and fields with a closed
// list of words — and writes 5–8 test cases (an input line and the expected result code). The rules are checked in
// order and the first one that holds gives the code, so the set has to reach every class of every field: the valid
// words and the invalid ones, both sides of every range, and (Junior) a rule over two fields at once. The cases run on
// the correct program, then on its one-place mutants: a boundary moved, a word lost from or added to a list, a check
// skipped, two checks swapped, a wrong code. The form, the limits and the lists come from the seed.
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
import { coverIndices, QA_BUDGET, QA_TASK_TEXT, qaBuilt, type QaPrograms, qaHarnessOf } from '../../_lib/qa.ts';
import {
	domainPoints,
	farFromThresholds,
	fieldsText,
	killMatrix,
	pointLine,
	ruleMutants,
	rulePrograms,
	rulesText,
	type Field,
	type Point,
	type Rule,
	type RuleMutant,
	type RuleProgram
} from '../../_lib/qa-rules.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);

interface Form {
	title: string;
	program: RuleProgram;
}

const int = (name: string, title: string, min: number, max: number): Field => ({ name, title, kind: 'int', min, max });
const words = (name: string, title: string, values: readonly string[]): Field => ({
	name,
	title,
	kind: 'enum',
	values
});

/** `count` words of the list in the list's order. */
const subset = (rng: Rng, values: readonly string[], count: number): string[] => {
	const chosen = new Set(rng.sample(values, count));
	return values.filter((v) => chosen.has(v));
};

function makeForm(rng: Rng, classId: string, junior: boolean): Form {
	if (classId === 'registration') {
		const docs = ['passport', 'birth_cert', 'foreign', 'student_id', 'none'];
		const fields = [int('age', 'возраст участника, полных лет', 0, 99), words('doc', 'документ', docs)];
		const lo = rng.int(7, 12);
		const hi = rng.int(17, 25);
		const allowed = subset(rng, docs.slice(0, 4), rng.int(2, 3));
		const rules: Rule[] = [
			{ when: [{ field: 'age', op: '<', c: lo }], out: 'E_AGE' },
			{ when: [{ field: 'age', op: '>', c: hi }], out: 'E_AGE' },
			{ when: [{ field: 'doc', op: 'notin', values: allowed }], out: 'E_DOC' }
		];
		if (junior) {
			// A document of children is valid only up to an age within the range.
			const young = allowed.includes('birth_cert') ? 'birth_cert' : (allowed[0] ?? 'passport');
			rules.push({
				when: [
					{ field: 'doc', op: 'in', values: [young] },
					{ field: 'age', op: '>=', c: rng.int(lo + 2, hi - 2) }
				],
				out: 'E_DOC_AGE'
			});
		}
		rules.push({ when: [], out: 'OK' });
		return { title: 'Регистрация участника олимпиады', program: { fields, rules } };
	}
	if (classId === 'loan') {
		const jobs = ['staff', 'contract', 'self', 'student', 'none'];
		const fields = [
			int('age', 'возраст заявителя, полных лет', 0, 80),
			int('income', 'доход в месяц, тыс. руб.', 0, 60),
			words('job', 'занятость', jobs)
		];
		const minIncome = rng.int(2, 6) * 5;
		const rules: Rule[] = [
			{ when: [{ field: 'age', op: rng.pick(['<', '<='] as const), c: rng.int(18, 21) }], out: 'E_AGE' },
			{ when: [{ field: 'job', op: 'in', values: subset(rng, ['student', 'none'], rng.int(1, 2)) }], out: 'E_JOB' },
			{ when: [{ field: 'income', op: '<', c: minIncome }], out: 'E_INCOME' }
		];
		if (junior) {
			rules.push({
				when: [
					{ field: 'job', op: 'in', values: ['self'] },
					{ field: 'income', op: '<', c: minIncome + rng.int(2, 5) * 5 }
				],
				out: 'E_INCOME_SELF'
			});
		}
		rules.push({ when: [], out: 'OK' });
		return { title: 'Проверка заявки на кредит', program: { fields, rules } };
	}
	if (classId === 'shipment') {
		const kinds = ['docs', 'parcel', 'fragile', 'liquid', 'battery'];
		const fields = [
			int('weight', 'вес отправления, кг', 0, 60),
			words('kind', 'вид вложения', kinds),
			words('zone', 'зона доставки', ['city', 'region', 'abroad'])
		];
		const max = rng.int(20, 40);
		const banned = subset(rng, ['liquid', 'battery', 'fragile'], rng.int(1, 2));
		const rules: Rule[] = [
			{ when: [{ field: 'weight', op: '<', c: 1 }], out: 'E_EMPTY' },
			{ when: [{ field: 'weight', op: '>', c: max }], out: 'E_WEIGHT' },
			{
				when: [
					{ field: 'kind', op: 'in', values: banned },
					{ field: 'zone', op: 'in', values: ['abroad'] }
				],
				out: 'E_CUSTOMS'
			}
		];
		if (junior) {
			rules.push({
				when: [
					{ field: 'zone', op: 'notin', values: ['city'] },
					{ field: 'weight', op: '>', c: rng.int(5, max - 5) }
				],
				out: 'E_HEAVY'
			});
		}
		rules.push({ when: [], out: 'OK' });
		return { title: 'Приём отправления в пункте выдачи', program: { fields, rules } };
	}
	const types = ['annual', 'unpaid', 'study', 'sick'];
	const fields = [
		int('days', 'длительность, дней', 0, 45),
		int('notice', 'за сколько дней до начала подана заявка', 0, 45),
		words('type', 'вид отпуска', types)
	];
	const maxDays = rng.int(14, 30);
	const notice = rng.int(5, 14);
	const rules: Rule[] = [
		{ when: [{ field: 'days', op: '<', c: 1 }], out: 'E_DAYS' },
		{
			when: [
				{ field: 'type', op: 'notin', values: ['sick'] },
				{ field: 'days', op: '>', c: maxDays }
			],
			out: 'E_DAYS'
		},
		{
			when: [
				{ field: 'type', op: 'in', values: subset(rng, ['annual', 'unpaid', 'study'], 2) },
				{ field: 'notice', op: '<', c: notice }
			],
			out: 'E_NOTICE'
		}
	];
	if (junior) {
		rules.push({
			when: [
				{ field: 'type', op: 'in', values: ['study'] },
				{ field: 'days', op: '>', c: rng.int(3, maxDays - 4) }
			],
			out: 'E_STUDY'
		});
	}
	rules.push({ when: [], out: 'OK' });
	return { title: 'Заявление на отпуск', program: { fields, rules } };
}

function specification(form: Form): string {
	return [
		`Программа «${form.title}» читает одну строку — значения полей через пробел, в таком порядке:`,
		'',
		...fieldsText(form.program.fields),
		'',
		'и печатает код результата. Правила проверяются по порядку; срабатывает первое правило, все условия которого выполнены:',
		'',
		...rulesText(form.program)
	].join('\n');
}

const toPrograms = (x: { program: RuleProgram; list: readonly RuleMutant[] }): QaPrograms =>
	rulePrograms(x.program, x.list);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const junior = input.grade === 'junior';
	for (let tries = 0; tries < 60; tries += 1) {
		const form = makeForm(rng, input.classId, junior);
		const program = form.program;
		const list = ruleMutants(rng, program);
		const points = domainPoints(program.fields);
		const { expected, kills } = killMatrix(program, list, points);
		const killed = new Set(kills.flat());
		const mutants = list.map((m) => ({ ...m, equivalent: !killed.has(m.id) }));
		const live = mutants.filter((m) => !m.equivalent).map((m) => m.id);
		if (live.length < 6) continue;
		const sets = kills.map((k) => new Set(k));
		const cover = coverIndices(sets, live);
		if (!cover || cover.length > QA_BUDGET.max) continue;
		const casesOf = (indices: readonly number[]): QaCase[] =>
			indices.map((i) => ({ input: pointLine(points[i] as Point), expected: expected[i] as string }));
		const killsAll = (indices: readonly number[]): boolean => {
			const hit = new Set(indices.flatMap((i) => kills[i] ?? []));
			return live.every((id) => hit.has(id));
		};
		const model = [...cover];
		while (model.length < QA_BUDGET.min) model.push(rng.int(0, points.length - 1));
		// Weak sets of the misconceptions: each must leave a mutant alive on this instance.
		const far = points.flatMap((p, i) => (farFromThresholds(program, p, 3) ? [i] : []));
		const typical = Array.from({ length: QA_BUDGET.min }, () => rng.pick(far.length > 0 ? far : [0]));
		const valid = points.flatMap((_, i) => (expected[i] === 'OK' ? [i] : []));
		const validCover = coverIndices(
			valid.map((i) => sets[i] ?? new Set<string>()),
			live.filter((id) => valid.some((i) => sets[i]?.has(id)))
		);
		const validOnly = (validCover ?? []).map((k) => valid[k] as number).slice(0, QA_BUDGET.max);
		while (validOnly.length < QA_BUDGET.min) validOnly.push(rng.pick(valid));
		if (killsAll(typical) || killsAll(validOnly)) continue;
		const cases = casesOf(model);
		const outcomes = [...new Set(program.rules.map((r) => r.out))];
		const wrongExpected = cases.map((c, i) =>
			i === 0 ? { ...c, expected: outcomes.find((o) => o !== c.expected) ?? c.expected } : c
		);
		const exhaustive = casesOf(
			Array.from({ length: QA_BUDGET.max + rng.int(4, 12) }, () => rng.int(0, points.length - 1))
		);
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: QA_TASK_TEXT, code: null },
			answer: null,
			qa: {
				budget: QA_BUDGET,
				specification: specification(form),
				mutants: mutants.map((m) => ({ id: m.id, operator: m.operator, equivalent: m.equivalent }))
			}
		});
		return qaBuilt(instance, toPrograms, { source: { program, list }, cases }, null, {
			'typical-only': casesOf(typical),
			'valid-only': casesOf(validOnly),
			'wrong-expected': wrongExpected,
			exhaustive
		});
	}
	throw new Error(`${descriptor.key}: no form for ${input.grade}/${input.classId} after 60 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}

/** The harness the engine runs for an instance and a part. */
export const harness = qaHarnessOf(descriptor.key, build);
