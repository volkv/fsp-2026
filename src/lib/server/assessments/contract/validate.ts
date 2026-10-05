// The validator of the frozen contract (docs/domain.md, section 23): the shape of every kind of data — the catalog,
// the procedure, the grade policy, a family descriptor, a generated instance, a bank release — and the rules that tie
// them together. Each check returns the problems as readable lines; an empty list means the data is valid. The bank
// tree, the release script and the unit tests call it; nothing is released with a problem.
//
// Plain erasable TypeScript without `$lib`.
import { z } from 'zod';
import {
	CATALOG,
	DIRECTION_KEYS,
	GENERATOR_LANGUAGE_KEYS,
	GRADE_KEYS,
	ITEM_FORMATS,
	PRACTICE_FORMATS,
	SANDBOX_LANGUAGE_KEYS,
	SPECIALIZATION_KEYS,
	gradeOrdinal,
	type Catalog,
	type GradeKey,
	type ItemFormat
} from './catalog.ts';
import {
	ANSWER_KINDS,
	FAMILY_GATES,
	capacityChecks,
	type BankRelease,
	type FamilyDescriptor,
	type FamilyGates,
	type ItemInstance
} from './bank.ts';
import { maxLength, type ProcedureParams } from './procedure.ts';
import type { GradePolicy } from './policy.ts';

const text = z.string().trim().min(1);
const share = z.number().gt(0).lt(1);
const positiveInt = z.int().positive();
const specialization = z.enum(SPECIALIZATION_KEYS);
const grade = z.enum(GRADE_KEYS);
const format = z.enum(ITEM_FORMATS);
const sandboxLanguage = z.enum(SANDBOX_LANGUAGE_KEYS);
const blockCode = z.string().regex(/^[a-z]+\.[a-z0-9_]+$/);

const catalogSchema = z.strictObject({
	version: z.string().regex(/^\d{4}\.\d{2}\.\d+$/),
	directions: z.array(z.strictObject({ key: z.enum(DIRECTION_KEYS), title: text })),
	specializations: z.array(
		z.strictObject({
			key: specialization,
			title: text,
			direction: z.enum(DIRECTION_KEYS),
			availability: z.enum(['enabled', 'disabled']),
			summary: text,
			practiceLanguages: z.array(sandboxLanguage).min(1)
		})
	),
	grades: z.array(z.strictObject({ key: grade, ordinal: z.int().min(0), title: text })),
	blocks: z.array(
		z.strictObject({
			code: blockCode,
			specialization,
			title: text,
			checks: text,
			skillKeys: z.array(text),
			formats: z.array(format).min(1),
			practice: z.boolean()
		})
	),
	definitions: z.array(
		z.strictObject({
			specialization,
			grade,
			borderline: text,
			expects: z.array(text).min(2),
			blocks: z.array(z.strictObject({ block: blockCode, items: positiveInt })).min(3),
			practice: z.strictObject({
				block: blockCode,
				position: positiveInt,
				changeStep: z.boolean(),
				gateMinScore: z.number().gt(0).max(1)
			}),
			doesNotCheck: z.array(text)
		})
	),
	commonDoesNotCheck: z.array(text).min(1)
});

const lengthsSchema = z
	.strictObject({ nMin: positiveInt, nMax: positiveInt, extension: positiveInt })
	.refine((l) => l.nMin <= l.nMax, 'nMin > nMax');

const acceptanceSchema = {
	shift: share,
	falseConfirmMax: z.strictObject({ intern: share, junior: share, middle: share, senior: share }),
	trueConfirmMin: share,
	undeterminedMax: share
};

const procedureSchema = z.strictObject({
	version: text,
	delta: z.number().positive(),
	alpha: z.number().gt(0).lt(0.5),
	beta: z.number().gt(0).lt(0.5),
	bands: z.strictObject({ atMax: share, final: share }),
	confidentMargin: share,
	blockVerdictMargin: z.number().positive(),
	blockMinItems: positiveInt,
	grades: z.strictObject({
		intern: lengthsSchema,
		junior: lengthsSchema,
		middle: lengthsSchema,
		senior: lengthsSchema
	}),
	homogeneousAcceptance: z.strictObject({ ...acceptanceSchema, cuts: z.array(share).min(1) }),
	trajectoryAcceptance: z.strictObject({ ...acceptanceSchema, consistencyMin: share })
});

const policySchema = z.strictObject({
	version: positiveInt,
	gradeChangeIntervalDays: positiveInt,
	retakeIntervalDays: positiveInt,
	confidentUpgradeValidDays: positiveInt,
	maxAttemptsPerGrade: positiveInt,
	formWindowDays: positiveInt,
	freeRetakeAnnulReasons: z.array(text)
});

const ANGOFF_STEP = 0.05;
const onAngoffScale = (p: number): boolean => Math.abs(p / ANGOFF_STEP - Math.round(p / ANGOFF_STEP)) < 1e-9;

const familySchema = z.strictObject({
	key: z.string().regex(/^[a-z]+\.[a-z0-9_]+\.[a-z0-9_-]+$/),
	version: positiveInt,
	specialization,
	block: blockCode,
	format,
	answerKind: z.enum(ANSWER_KINDS),
	levels: z
		.array(
			z.strictObject({
				grade,
				angoff: z.strictObject({
					round: z.union([z.literal(1), z.literal(2)]),
					ratings: z.array(z.strictObject({ rater: text, p: z.number().min(0.05).max(0.95) })),
					mean: share
				}),
				constructive: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
				constructiveRank: positiveInt,
				timeNormSec: positiveInt,
				classes: z.array(z.strictObject({ id: text, form: z.enum(['A', 'B', 'anchor']), description: text }))
			})
		)
		.min(1)
		.max(2),
	surfaceParams: z.array(z.strictObject({ name: text, description: text })).min(1),
	essentialParams: z.array(z.strictObject({ name: text, description: text })).min(1),
	language: z.string().nullable(),
	practice: z.strictObject({ languages: z.array(sandboxLanguage).min(1), hiddenTestGroups: positiveInt }).nullable(),
	qa: z
		.strictObject({
			budget: z.strictObject({ min: positiveInt, max: positiveInt }),
			mutants: z.array(z.strictObject({ id: text, operator: text }))
		})
		.nullable(),
	changeStep: z.strictObject({ description: text, weight: z.number().gt(0).lt(1) }).nullable(),
	rubric: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('binary') }),
		z.strictObject({
			kind: z.literal('parts'),
			parts: z.array(z.strictObject({ id: text, weight: share })).min(2)
		}),
		z.strictObject({ kind: z.literal('groups') }),
		z.strictObject({
			kind: z.literal('mutants'),
			levels: z
				.array(z.strictObject({ minKillRatio: z.number().min(0).max(1), score: z.number().min(0).max(1) }))
				.min(2)
		})
	]),
	coverage: z.strictObject({ checks: z.array(text).min(1), doesNotCheck: z.array(text).min(1) }),
	wrongSolutions: z.array(z.strictObject({ id: text, defect: text, mustBeCaught: z.boolean() })),
	authorship: z.strictObject({ draftedBy: z.enum(['team', 'model']), authors: z.array(text).min(1) }),
	gates: z.strictObject({
		reference: z.strictObject({ seeds: z.int().min(0), failures: z.int().min(0) }),
		wrongSolutions: z.strictObject({ mustBeCaught: z.int().min(0), caught: z.int().min(0) }),
		hiddenTestsMutationScore: z.number().min(0).max(1).nullable(),
		answerCollision: z.number().min(0).max(1),
		transfer: z.number().min(0).max(1).nullable(),
		bruteForceInputs: z.int().min(0).nullable(),
		rubricReview: z.strictObject({ reviewer: text, reviewedAt: z.iso.date() }).nullable()
	})
});

const answerSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.enum(['exact', 'tokens']), value: z.string() }),
	z.strictObject({ kind: z.literal('float_eps'), value: z.number(), eps: z.number().gt(0).max(1) }),
	z.strictObject({ kind: z.enum(['set', 'sequence']), value: z.array(z.string()).min(1) }),
	z.strictObject({ kind: z.literal('line_no'), value: positiveInt })
]);

const groupSchema = z.strictObject({
	id: text,
	tests: z.array(z.strictObject({ stdin: z.string(), expected: z.string() })).min(1)
});

const instanceSchema = z.strictObject({
	family: text,
	familyVersion: positiveInt,
	grade,
	classId: text,
	seed: text,
	format,
	answerKind: z.enum(ANSWER_KINDS),
	statement: z.strictObject({
		markdown: text,
		code: z.strictObject({ language: text, source: text }).nullable()
	}),
	answer: answerSchema.nullable(),
	practice: z
		.strictObject({
			languages: z.array(sandboxLanguage).min(1),
			groups: z.array(groupSchema).min(1),
			checker: z.discriminatedUnion('kind', [
				z.strictObject({ kind: z.literal('exact') }),
				z.strictObject({ kind: z.literal('tokens') }),
				z.strictObject({ kind: z.literal('float_eps'), eps: z.number().gt(0).max(1) })
			])
		})
		.nullable(),
	qa: z
		.strictObject({
			budget: z.strictObject({ min: positiveInt, max: positiveInt }),
			specification: text,
			mutants: z.array(z.strictObject({ id: text, operator: text, equivalent: z.boolean() })).min(1)
		})
		.nullable(),
	changeStep: z
		.strictObject({
			markdown: text,
			weight: z.number().gt(0).lt(1),
			answer: answerSchema.nullable(),
			groups: z.array(groupSchema)
		})
		.nullable(),
	timeNormSec: positiveInt
});

/** Problems of a parse as `path: message` lines. */
function shapeProblems(schema: z.ZodType, value: unknown, prefix: string): string[] {
	const parsed = schema.safeParse(value);
	if (parsed.success) return [];
	return parsed.error.issues.map(
		(issue) => `${prefix}${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`
	);
}

const duplicates = (values: readonly string[]): string[] => [
	...new Set(values.filter((value, i) => values.indexOf(value) !== i))
];

const isPractice = (f: ItemFormat): boolean => (PRACTICE_FORMATS as readonly ItemFormat[]).includes(f);

/**
 * The catalog against its own rules, the procedure's lengths and the skills of the taxonomy: six specializations, four
 * grades, one definition per pair, blocks of the pair's specialization, quotas that fill the longest trajectory, the
 * practice slot not after the minimum length, the step «измени своё решение» from Middle up.
 */
export function catalogProblems(catalog: Catalog, procedure: ProcedureParams, skills: ReadonlySet<string>): string[] {
	const problems = shapeProblems(catalogSchema, catalog, 'catalog');
	if (problems.length) return problems;
	const specs = catalog.specializations.map((s) => s.key);
	if (specs.length !== SPECIALIZATION_KEYS.length || duplicates(specs).length) {
		problems.push(`catalog: specializations must be exactly ${SPECIALIZATION_KEYS.join(', ')}`);
	}
	catalog.grades.forEach((g, i) => {
		if (g.key !== GRADE_KEYS[i] || g.ordinal !== i)
			problems.push(`catalog: grade ${i} must be ${GRADE_KEYS[i] ?? '?'}`);
	});
	if (catalog.grades.length !== GRADE_KEYS.length) problems.push('catalog: four grades');
	const directions = new Set(catalog.directions.map((d) => d.key));
	for (const spec of catalog.specializations) {
		if (!directions.has(spec.direction)) problems.push(`catalog: ${spec.key} has unknown direction ${spec.direction}`);
	}
	for (const code of duplicates(catalog.blocks.map((b) => b.code))) problems.push(`catalog: block ${code} twice`);
	const blocks = new Map(catalog.blocks.map((b) => [b.code, b]));
	const prefixes = new Map<string, string>();
	for (const block of catalog.blocks) {
		const prefix = block.code.split('.')[0] ?? '';
		const owner = prefixes.get(prefix);
		if (owner !== undefined && owner !== block.specialization) {
			problems.push(`catalog: prefix ${prefix} of ${block.code} belongs to ${owner}`);
		}
		prefixes.set(prefix, block.specialization);
		for (const skill of block.skillKeys) {
			if (!skills.has(skill)) problems.push(`catalog: ${block.code} names skill ${skill} unknown to the taxonomy`);
		}
		const practiceFormats = block.formats.filter(isPractice);
		if (block.practice && practiceFormats.length !== block.formats.length) {
			problems.push(`catalog: practice block ${block.code} has a format that is not practice`);
		}
		if (!block.practice && practiceFormats.length) {
			problems.push(`catalog: block ${block.code} is not practice but has ${practiceFormats.join(', ')}`);
		}
	}
	for (const spec of SPECIALIZATION_KEYS) {
		for (const g of GRADE_KEYS) {
			const found = catalog.definitions.filter((d) => d.specialization === spec && d.grade === g);
			if (found.length !== 1) problems.push(`catalog: ${spec} × ${g} has ${found.length} definitions`);
		}
	}
	for (const definition of catalog.definitions) {
		const pair = `${definition.specialization} × ${definition.grade}`;
		const lengths = procedure.grades[definition.grade];
		const total = definition.blocks.reduce((sum, b) => sum + b.items, 0);
		if (total !== maxLength(procedure, definition.grade)) {
			problems.push(
				`catalog: ${pair} quotas sum to ${total}, the longest trajectory is ${maxLength(procedure, definition.grade)}`
			);
		}
		for (const code of duplicates(definition.blocks.map((b) => b.block)))
			problems.push(`catalog: ${pair} lists ${code} twice`);
		for (const quota of definition.blocks) {
			const block = blocks.get(quota.block);
			if (!block) problems.push(`catalog: ${pair} names unknown block ${quota.block}`);
			else if (block.specialization !== definition.specialization) {
				problems.push(`catalog: ${pair} names ${quota.block} of ${block.specialization}`);
			}
		}
		const practiceQuotas = definition.blocks.filter((q) => blocks.get(q.block)?.practice === true);
		const practiceQuota = practiceQuotas[0];
		if (
			practiceQuotas.length !== 1 ||
			practiceQuota?.block !== definition.practice.block ||
			practiceQuota.items !== 1
		) {
			problems.push(`catalog: ${pair} must have exactly one practice slot, of block ${definition.practice.block}`);
		}
		if (definition.practice.position > lengths.nMin) {
			problems.push(
				`catalog: ${pair} practice at ${definition.practice.position}, after the minimum length ${lengths.nMin}`
			);
		}
		const needsChangeStep = gradeOrdinal(definition.grade) >= gradeOrdinal('middle');
		if (definition.practice.changeStep !== needsChangeStep) {
			problems.push(`catalog: ${pair} change step must be ${needsChangeStep ? 'on' : 'off'}`);
		}
	}
	return problems;
}

export function procedureProblems(procedure: ProcedureParams): string[] {
	return shapeProblems(procedureSchema, procedure, 'procedure');
}

export function policyProblems(policy: GradePolicy): string[] {
	const problems = shapeProblems(policySchema, policy, 'policy');
	if (problems.length) return problems;
	if (policy.retakeIntervalDays >= policy.formWindowDays)
		problems.push('policy: the retake interval is not shorter than the window of forms');
	return problems;
}

/**
 * A family descriptor against the catalog and the admission gates: the block of its specialization, the format the
 * block allows, adjacent levels the block serves, two blind Angoff ratings with a mean, a class of each form, the
 * practice and QA particulars, the step «измени своё решение» where the grade needs it, and every gate met.
 */
export function familyProblems(family: FamilyDescriptor, gates: FamilyGates = FAMILY_GATES): string[] {
	const where = `family ${family.key}`;
	const problems = shapeProblems(familySchema, family, where);
	if (problems.length) return problems;
	const block = CATALOG.blocks.find((b) => b.code === family.block);
	if (!block) return [`${where}: unknown block ${family.block}`];
	if (block.specialization !== family.specialization)
		problems.push(`${where}: block ${family.block} is not of ${family.specialization}`);
	if (!family.key.startsWith(`${family.block}.`)) problems.push(`${where}: key must start with its block`);
	if (!block.formats.includes(family.format))
		problems.push(`${where}: block ${family.block} does not take ${family.format}`);
	const ordinals = family.levels.map((l) => gradeOrdinal(l.grade));
	if (ordinals.length === 2 && Math.abs((ordinals[0] ?? 0) - (ordinals[1] ?? 0)) !== 1) {
		problems.push(`${where}: two levels must be adjacent grades`);
	}
	for (const level of family.levels) {
		const lw = `${where}@${level.grade}`;
		const definition = CATALOG.definitions.find(
			(d) => d.specialization === family.specialization && d.grade === level.grade
		);
		if (!definition?.blocks.some((q) => q.block === family.block)) {
			problems.push(`${lw}: the ${level.grade} test of ${family.specialization} has no ${family.block} slots`);
		}
		const raters = level.angoff.ratings.map((r) => r.rater);
		if (new Set(raters).size < gates.angoffRatersMin)
			problems.push(`${lw}: Angoff needs ${gates.angoffRatersMin} distinct raters`);
		if (duplicates(raters).length) problems.push(`${lw}: a rater rated twice`);
		for (const rating of level.angoff.ratings) {
			if (!onAngoffScale(rating.p)) problems.push(`${lw}: Angoff rating ${rating.p} is not on the 0.05 scale`);
		}
		const ps = level.angoff.ratings.map((r) => r.p);
		const mean = ps.reduce((sum, p) => sum + p, 0) / Math.max(ps.length, 1);
		if (Math.abs(mean - level.angoff.mean) > 1e-9)
			problems.push(`${lw}: Angoff mean ${level.angoff.mean} is not ${mean.toFixed(4)}`);
		if (Math.max(...ps) - Math.min(...ps) > gates.angoffGapMax + 1e-9 && level.angoff.round !== 2) {
			problems.push(`${lw}: ratings differ by more than ${gates.angoffGapMax} — the second round is required`);
		}
		const ids = level.classes.map((c) => c.id);
		for (const id of duplicates(ids)) problems.push(`${lw}: class ${id} twice`);
		const forms = new Set(level.classes.map((c) => c.form));
		if (!forms.has('A') || !forms.has('B')) problems.push(`${lw}: needs an essential class of form A and of form B`);
		if (level.classes.filter((c) => c.form === 'anchor').length > 1) problems.push(`${lw}: at most one anchor class`);
		if (definition && isPractice(family.format) && definition.practice.changeStep && family.changeStep === null) {
			problems.push(`${lw}: the practice of ${level.grade} needs the step «измени своё решение»`);
		}
	}
	if (family.essentialParams.length === 0) problems.push(`${where}: no essential parameters`);
	if (family.language !== null) {
		const known = [...SANDBOX_LANGUAGE_KEYS, ...GENERATOR_LANGUAGE_KEYS] as readonly string[];
		if (!known.includes(family.language))
			problems.push(`${where}: language ${family.language} is neither in the sandbox nor modelled`);
	}
	const spec = CATALOG.specializations.find((s) => s.key === family.specialization);
	if (family.format === 'practice_code') {
		if (!family.practice) problems.push(`${where}: practice code needs practice particulars`);
		else {
			for (const language of family.practice.languages) {
				if (!spec?.practiceLanguages.includes(language))
					problems.push(`${where}: ${language} is not a practice language of ${family.specialization}`);
			}
			if (family.practice.hiddenTestGroups < gates.practiceGroupsMin)
				problems.push(`${where}: fewer than ${gates.practiceGroupsMin} hidden test groups`);
		}
		if (family.answerKind !== 'code' || family.rubric.kind !== 'groups')
			problems.push(`${where}: practice code is answered by code and scored by groups`);
		if (family.gates.hiddenTestsMutationScore === null || family.gates.transfer === null) {
			problems.push(
				`${where}: practice code reports the mutation score of its hidden tests and the transfer between classes`
			);
		}
	} else if (family.practice) problems.push(`${where}: practice particulars on a ${family.format} family`);
	if (family.format === 'qa_mutation') {
		if (!family.qa) problems.push(`${where}: QA needs its budget and mutants`);
		else {
			if (family.qa.budget.min !== gates.qaBudget.min || family.qa.budget.max !== gates.qaBudget.max) {
				problems.push(`${where}: the QA budget is ${gates.qaBudget.min}–${gates.qaBudget.max} test cases`);
			}
			if (family.qa.mutants.length < gates.qaMutantsMin)
				problems.push(`${where}: fewer than ${gates.qaMutantsMin} mutants`);
		}
		if (family.answerKind !== 'test_cases' || family.rubric.kind !== 'mutants')
			problems.push(`${where}: QA is answered by test cases and scored by mutants`);
	} else if (family.qa) problems.push(`${where}: QA particulars on a ${family.format} family`);
	if (!isPractice(family.format) && (family.answerKind === 'code' || family.answerKind === 'test_cases')) {
		problems.push(`${where}: ${family.format} has a computed answer, not ${family.answerKind}`);
	}
	if (!isPractice(family.format) && family.changeStep)
		problems.push(`${where}: the change step belongs to the practice cluster`);
	if (family.rubric.kind === 'parts') {
		const sum = family.rubric.parts.reduce((total, part) => total + part.weight, 0);
		if (Math.abs(sum - 1) > 1e-9) problems.push(`${where}: part weights sum to ${sum}`);
	}
	if (family.rubric.kind === 'mutants') {
		const levels = family.rubric.levels;
		if (
			levels.some(
				(l, i) =>
					i > 0 && (l.minKillRatio <= (levels[i - 1]?.minKillRatio ?? 0) || l.score <= (levels[i - 1]?.score ?? 0))
			)
		) {
			problems.push(`${where}: mutant levels must grow in kill ratio and score`);
		}
	}
	const minimum = gates.wrongSolutionsMin[family.format] ?? 0;
	if (family.wrongSolutions.length < minimum) problems.push(`${where}: fewer than ${minimum} wrong solutions`);
	for (const id of duplicates(family.wrongSolutions.map((w) => w.id)))
		problems.push(`${where}: wrong solution ${id} twice`);
	problems.push(...gateProblems(family, gates));
	return problems;
}

/** The admission gates of a family: reference, wrong solutions, hidden tests, collisions, transfer, rubric review. */
function gateProblems(family: FamilyDescriptor, gates: FamilyGates): string[] {
	const where = `family ${family.key}: gate`;
	const report = family.gates;
	const problems: string[] = [];
	if (report.reference.seeds < gates.referenceSeedsMin || report.reference.failures > 0) {
		problems.push(`${where} reference on ${report.reference.seeds} seeds with ${report.reference.failures} failures`);
	}
	const mustBeCaught = family.wrongSolutions.filter((w) => w.mustBeCaught).length;
	if (report.wrongSolutions.mustBeCaught !== mustBeCaught || report.wrongSolutions.caught < mustBeCaught) {
		problems.push(`${where} wrong solutions caught ${report.wrongSolutions.caught} of ${mustBeCaught}`);
	}
	if (report.hiddenTestsMutationScore !== null && report.hiddenTestsMutationScore < gates.hiddenTestsMutationScoreMin) {
		problems.push(`${where} hidden tests kill ${report.hiddenTestsMutationScore} of mutants`);
	}
	if (report.answerCollision > gates.answerCollisionMax)
		problems.push(`${where} answer collision ${report.answerCollision}`);
	if (report.transfer !== null && report.transfer > gates.transferMax)
		problems.push(`${where} transfer ${report.transfer}`);
	if (report.bruteForceInputs !== null && report.bruteForceInputs < gates.bruteForceInputsMin) {
		problems.push(`${where} brute force on ${report.bruteForceInputs} inputs`);
	}
	if (!report.rubricReview) problems.push(`${where} rubric not reviewed by a person`);
	return problems;
}

/** A generated instance against its descriptor: the same family, level, class, format and answer kind, a usable answer. */
export function instanceProblems(instance: ItemInstance, family: FamilyDescriptor): string[] {
	const where = `instance ${instance.family}/${instance.seed}`;
	const problems = shapeProblems(instanceSchema, instance, where);
	if (problems.length) return problems;
	if (instance.family !== family.key || instance.familyVersion !== family.version)
		problems.push(`${where}: not of ${family.key} v${family.version}`);
	const level = family.levels.find((l) => l.grade === instance.grade);
	if (!level) problems.push(`${where}: family has no level ${instance.grade}`);
	else if (!level.classes.some((c) => c.id === instance.classId))
		problems.push(`${where}: unknown class ${instance.classId}`);
	if (instance.format !== family.format || instance.answerKind !== family.answerKind)
		problems.push(`${where}: format or answer kind differs`);
	if (isPractice(family.format)) {
		if (instance.answer !== null) problems.push(`${where}: a practice instance has no computed answer`);
	} else if (instance.answer?.kind !== family.answerKind)
		problems.push(`${where}: computed answer of kind ${family.answerKind} required`);
	if (family.format === 'practice_code') {
		if (!instance.practice || instance.practice.groups.length !== family.practice?.hiddenTestGroups) {
			problems.push(`${where}: ${family.practice?.hiddenTestGroups ?? 0} hidden test groups required`);
		}
	} else if (instance.practice) problems.push(`${where}: practice tests on a ${family.format} instance`);
	if (family.format === 'qa_mutation') {
		if (!instance.qa) problems.push(`${where}: QA particulars required`);
		else {
			if (instance.qa.budget.min !== family.qa?.budget.min || instance.qa.budget.max !== family.qa.budget.max)
				problems.push(`${where}: QA budget differs from the family`);
			if (instance.qa.mutants.every((m) => m.equivalent)) problems.push(`${where}: every mutant is equivalent`);
		}
	} else if (instance.qa) problems.push(`${where}: QA particulars on a ${family.format} instance`);
	if ((instance.changeStep === null) !== (family.changeStep === null))
		problems.push(`${where}: the change step must follow the family`);
	if (
		instance.statement.code &&
		![...SANDBOX_LANGUAGE_KEYS, ...GENERATOR_LANGUAGE_KEYS].includes(instance.statement.code.language as never)
	) {
		problems.push(`${where}: code in unknown language ${instance.statement.code.language}`);
	}
	return problems;
}

/**
 * A bank release of one specialization: every family valid, unique and of the specialization, the anchors of every
 * grade, and every extreme trajectory of every grade served (`capacityChecks`).
 */
export function releaseProblems(
	release: BankRelease,
	procedure: ProcedureParams,
	gates: FamilyGates = FAMILY_GATES
): string[] {
	const where = `release ${release.id}`;
	const problems: string[] = [];
	if (release.catalogVersion !== CATALOG.version)
		problems.push(`${where}: catalog ${release.catalogVersion}, current ${CATALOG.version}`);
	if (release.procedureVersion !== procedure.version)
		problems.push(`${where}: procedure ${release.procedureVersion}, current ${procedure.version}`);
	if (!release.id.startsWith(`${release.specialization}@${release.catalogVersion}-`))
		problems.push(`${where}: id must be ${release.specialization}@${release.catalogVersion}-<n>`);
	for (const key of duplicates(release.families.map((f) => f.key))) problems.push(`${where}: family ${key} twice`);
	for (const family of release.families) {
		if (family.specialization !== release.specialization)
			problems.push(`${where}: ${family.key} is of ${family.specialization}`);
		problems.push(...familyProblems(family, gates));
	}
	for (const g of GRADE_KEYS) {
		const anchors = release.families.filter((f) =>
			f.levels.some((l) => l.grade === g && l.classes.some((c) => c.form === 'anchor'))
		).length;
		if (anchors < gates.anchorsPerGrade)
			problems.push(`${where}: ${g} has ${anchors} anchor family-levels, ${gates.anchorsPerGrade} required`);
	}
	for (const check of capacityChecks(release, procedure)) {
		if (check.ok) continue;
		const scenario = check.scenario.map((a) => `${a.form}${a.length}`).join('→');
		const blocks = [...new Set(check.shortages.map((s) => s.block))].join(', ');
		problems.push(`${where}: ${check.grade} ${scenario} runs out in ${blocks}`);
	}
	return problems;
}

/** The family-levels of a grade a release has, by block: what the factory reports against the quotas. */
export function levelsByBlock(release: BankRelease, g: GradeKey): Map<string, number> {
	const counts = new Map<string, number>();
	for (const family of release.families) {
		if (family.levels.some((l) => l.grade === g)) counts.set(family.block, (counts.get(family.block) ?? 0) + 1);
	}
	return counts;
}
