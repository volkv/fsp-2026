// QA practice: the candidate reads the access rules of an API handler — who may do what with a resource in which
// state — and writes 5–8 test cases: a request (role, method, ownership, state of the resource, body size) and the
// expected status code. The rules are an ordered decision table: the first rule whose conditions all hold gives the
// code, so a strong set reaches every rule, both sides of every size limit and the requests where two rules collide
// and the order decides (401 before 404, 403 before 409, …). Then the step «измени своё решение»: the contract gets a
// new rule, and the candidate adapts the set to the changed specification and its own mutants.
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
	rulesHolding,
	rulesText,
	type Field,
	type Point,
	type Pred,
	type Rule,
	type RuleMutant,
	type RuleProgram
} from '../../_lib/qa-rules.ts';
import type { Rng } from '../../_lib/rng.ts';

const descriptor = readDescriptor(import.meta.url);
const STEP_WEIGHT = descriptor.changeStep?.weight ?? 0;

const words = (name: string, title: string, values: readonly string[]): Field => ({
	name,
	title,
	kind: 'enum',
	values
});

const is = (field: string, ...values: string[]): Pred => ({ field, op: 'in', values });
const not = (field: string, ...values: string[]): Pred => ({ field, op: 'notin', values });

/** An API: its resource, the fields of a request and the pool of rules in the order of priority. */
interface Api {
	resource: string;
	fields: Field[];
	pool: Rule[];
}

function makeApi(rng: Rng, classId: string): Api {
	const method = words('method', 'метод', ['GET', 'PUT', 'DELETE']);
	const owner = words('owner', 'владелец ресурса (`own` — сам пользователь, `other` — другой)', ['own', 'other']);
	const size = { name: 'size', title: 'размер тела запроса, КБ', kind: 'int' as const, min: 0, max: 20 };
	const limit = rng.int(6, 15);
	const big: Pred = { field: 'size', op: rng.pick(['>', '>='] as const), c: limit };
	if (classId === 'articles') {
		return {
			resource: 'статья',
			fields: [
				words('role', 'роль', ['guest', 'reader', 'author', 'editor']),
				method,
				owner,
				words('state', 'состояние статьи', ['draft', 'published', 'archived']),
				size
			],
			pool: [
				{ when: [is('role', 'guest'), not('method', 'GET')], out: '401' },
				{ when: [is('state', 'draft'), is('role', 'guest', 'reader')], out: '404' },
				{ when: [is('role', 'reader'), not('method', 'GET')], out: '403' },
				{ when: [is('role', 'author'), is('owner', 'other'), not('method', 'GET')], out: '403' },
				{ when: [is('state', 'archived'), not('method', 'GET')], out: '409' },
				{ when: [is('method', 'PUT'), big], out: '413' },
				{ when: [is('method', 'DELETE'), is('state', 'published'), not('role', 'editor')], out: '403' }
			]
		};
	}
	if (classId === 'files') {
		const memberLimit = rng.int(4, 14);
		return {
			resource: 'файл',
			fields: [
				words('role', 'роль', ['viewer', 'member', 'admin']),
				method,
				owner,
				words('state', 'состояние файла', ['active', 'locked', 'trash']),
				size
			],
			pool: [
				{ when: [is('role', 'viewer'), not('method', 'GET')], out: '403' },
				{ when: [is('state', 'trash'), not('role', 'admin')], out: '404' },
				{ when: [is('state', 'locked'), is('method', 'PUT')], out: '423' },
				{ when: [is('role', 'member'), is('owner', 'other'), is('method', 'DELETE')], out: '403' },
				{ when: [is('method', 'PUT'), is('role', 'member'), { field: 'size', op: '>', c: memberLimit }], out: '413' },
				{ when: [is('method', 'DELETE'), is('state', 'locked')], out: '423' }
			]
		};
	}
	if (classId === 'tickets') {
		return {
			resource: 'заявка в поддержку',
			fields: [
				words('role', 'роль', ['customer', 'agent', 'lead']),
				method,
				owner,
				words('state', 'состояние заявки', ['open', 'resolved', 'closed']),
				size
			],
			pool: [
				{ when: [is('role', 'customer'), is('owner', 'other')], out: '404' },
				{ when: [is('role', 'customer'), is('method', 'DELETE')], out: '403' },
				{ when: [is('state', 'closed'), is('method', 'PUT'), not('role', 'lead')], out: '409' },
				{ when: [is('method', 'DELETE'), not('role', 'lead')], out: '403' },
				{ when: [is('method', 'PUT'), big], out: '413' },
				{ when: [is('method', 'PUT'), { field: 'size', op: '<', c: rng.int(1, 3) }], out: '400' },
				{ when: [is('state', 'resolved'), is('method', 'DELETE')], out: '409' }
			]
		};
	}
	return {
		resource: 'событие календаря',
		fields: [
			words('role', 'роль', ['guest', 'member', 'organizer']),
			method,
			owner,
			words('state', 'состояние события', ['upcoming', 'ongoing', 'past']),
			size
		],
		pool: [
			{ when: [is('role', 'guest'), not('method', 'GET')], out: '401' },
			{ when: [is('role', 'member'), is('owner', 'other'), not('method', 'GET')], out: '403' },
			{ when: [is('state', 'past'), not('method', 'GET')], out: '409' },
			{ when: [is('state', 'ongoing'), is('method', 'DELETE')], out: '409' },
			{ when: [is('role', 'member'), not('state', 'upcoming'), is('method', 'PUT')], out: '409' },
			{ when: [is('method', 'PUT'), big], out: '413' },
			{
				when: [is('method', 'PUT'), is('role', 'member'), { field: 'size', op: '>', c: rng.int(2, limit - 2) }],
				out: '413'
			}
		]
	};
}

/** One part of the cluster: the program, its mutants with their equivalence, the kill matrix and the author's cover. */
interface Part {
	program: RuleProgram;
	list: RuleMutant[];
	mutants: (RuleMutant & { equivalent: boolean })[];
	live: string[];
	points: Point[];
	expected: string[];
	kills: Set<string>[];
	cover: number[];
}

function solvePart(rng: Rng, program: RuleProgram): Part | null {
	const list = ruleMutants(rng, program);
	const points = domainPoints(program.fields);
	const matrix = killMatrix(program, list, points);
	const kills = matrix.kills.map((k) => new Set(k));
	const killed = new Set(matrix.kills.flat());
	const mutants = list.map((m) => ({ ...m, equivalent: !killed.has(m.id) }));
	const live = mutants.filter((m) => !m.equivalent).map((m) => m.id);
	if (live.length < 6) return null;
	const cover = coverIndices(kills, live);
	if (!cover || cover.length > QA_BUDGET.max) return null;
	return { program, list, mutants, live, points, expected: matrix.expected, kills, cover };
}

const program = (fields: readonly Field[], rules: readonly Rule[]): RuleProgram => ({
	fields,
	rules: [...rules, { when: [], out: '200' }]
});

function specification(api: Api, p: RuleProgram): string {
	return [
		`Обработчик API проверяет запрос к ресурсу «${api.resource}». Программа читает одну строку — поля запроса через пробел, в таком порядке:`,
		'',
		...fieldsText(p.fields),
		'',
		'и печатает код ответа. Правила проверяются по порядку; срабатывает первое правило, все условия которого выполнены:',
		'',
		...rulesText(p)
	].join('\n');
}

function casesOf(part: Part, indices: readonly number[]): QaCase[] {
	return indices.map((i) => ({ input: pointLine(part.points[i] as Point), expected: part.expected[i] as string }));
}

function withMinimum(rng: Rng, part: Part, indices: readonly number[]): number[] {
	const out = [...indices];
	while (out.length < QA_BUDGET.min) out.push(rng.int(0, part.points.length - 1));
	return out;
}

const killsAll = (part: Part, indices: readonly number[]): boolean => {
	const hit = new Set(indices.flatMap((i) => [...(part.kills[i] ?? [])]));
	return part.live.every((id) => hit.has(id));
};

const toPrograms = (x: { program: RuleProgram; list: readonly RuleMutant[] }): QaPrograms =>
	rulePrograms(x.program, x.list);

export function build(input: GenerateInput): Built {
	levelAndClass(descriptor, input);
	const rng = instanceRng(descriptor, input);
	const senior = input.grade === 'senior';
	for (let tries = 0; tries < 80; tries += 1) {
		const drawn = makeApi(rng, input.classId);
		// The order of the fields in the input line is surface: the rules name the fields.
		const api: Api = { ...drawn, fields: rng.shuffle(drawn.fields) };
		// The rules in force: a subset of the pool in its order; one rule left out arrives with the change step.
		// The rules in force: a subset of the pool in its order. The change step brings a rule of the pool left out:
		// Middle adds it, Senior puts it in place of one of the rules in force (the table keeps its size).
		const chosen = new Set(rng.sample([...api.pool.keys()], senior ? 5 : 4));
		const extra = rng.pick([...api.pool.keys()].filter((i) => !chosen.has(i)));
		const dropped = senior ? rng.pick([...chosen]) : null;
		const before = api.pool.filter((_, i) => chosen.has(i));
		const after = api.pool.filter((_, i) => (chosen.has(i) && i !== dropped) || i === extra);
		const task = solvePart(rng, program(api.fields, before));
		if (!task) continue;
		const step = solvePart(rng, program(api.fields, after));
		if (!step) continue;
		// Weak sets of the misconceptions must leave a mutant of the task alive.
		const far = task.points.flatMap((p, i) => (farFromThresholds(task.program, p, 3) ? [i] : []));
		const typical = Array.from({ length: QA_BUDGET.min }, () => rng.pick(far.length > 0 ? far : [0]));
		const holding = rulesHolding(task.program);
		const single = task.points.flatMap((p, i) => (holding(p) <= 1 ? [i] : []));
		const singleCover = coverIndices(
			single.map((i) => task.kills[i] ?? new Set<string>()),
			task.live.filter((id) => single.some((i) => task.kills[i]?.has(id)))
		);
		const singleFault = withMinimum(
			rng,
			task,
			(singleCover ?? []).map((k) => single[k] as number).slice(0, QA_BUDGET.max)
		);
		if (killsAll(task, typical) || killsAll(task, singleFault)) continue;
		const cases = casesOf(task, withMinimum(rng, task, task.cover));
		const stepCases = casesOf(step, withMinimum(rng, step, step.cover));
		const codes = [...new Set(task.program.rules.map((r) => r.out))];
		const wrongExpected = cases.map((c, i) =>
			i === 0 ? { ...c, expected: codes.find((o) => o !== c.expected) ?? c.expected } : c
		);
		const exhaustive = casesOf(
			task,
			Array.from({ length: QA_BUDGET.max + rng.int(4, 12) }, () => rng.int(0, task.points.length - 1))
		);
		const position = after.findIndex((r) => r === api.pool[extra]) + 1;
		const ruleText = (p: RuleProgram, rule: Rule | undefined): string =>
			rulesText(p)[p.rules.findIndex((r) => r === rule)]?.replace(/^\d+\. /, '') ?? '';
		const change = [
			...(dropped === null
				? []
				: [
						`Правило ${before.findIndex((r) => r === api.pool[dropped]) + 1} больше не действует:`,
						'',
						`- ${ruleText(task.program, api.pool[dropped])}`,
						''
					]),
			`Добавлено правило — в новой спецификации оно идёт под номером ${position}:`,
			'',
			`- ${ruleText(step.program, api.pool[extra])}`
		];
		const instance = makeInstance(descriptor, input, {
			statement: { markdown: QA_TASK_TEXT, code: null },
			answer: null,
			qa: {
				budget: QA_BUDGET,
				specification: specification(api, task.program),
				mutants: task.mutants.map((m) => ({ id: m.id, operator: m.operator, equivalent: m.equivalent }))
			},
			changeStep: {
				markdown: [
					'Контракт обработчика изменился.',
					'',
					...change,
					'',
					'Остальные правила и их порядок прежние. Измените свой набор тест-кейсов под новую спецификацию — от 5 до 8 кейсов: он',
					'запускается на программе с новым правилом и на её мутантах так же, как первый набор.'
				].join('\n'),
				weight: STEP_WEIGHT,
				answer: null,
				groups: [],
				qa: {
					specification: specification(api, step.program),
					mutants: step.mutants.map((m) => ({ id: m.id, operator: m.operator, equivalent: m.equivalent }))
				}
			}
		});
		return qaBuilt(
			instance,
			toPrograms,
			{ source: { program: task.program, list: task.list }, cases },
			{ source: { program: step.program, list: step.list }, cases: stepCases },
			{
				'typical-only': casesOf(task, typical),
				'single-fault': casesOf(task, singleFault),
				'wrong-expected': wrongExpected,
				exhaustive
			}
		);
	}
	throw new Error(`${descriptor.key}: no API for ${input.grade}/${input.classId} after 80 tries`);
}

export function generate(input: GenerateInput): ItemInstance {
	return build(input).instance;
}

/** The harness the engine runs for an instance and a part. */
export const harness = qaHarnessOf(descriptor.key, build);
