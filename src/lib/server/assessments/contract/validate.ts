// The validator of the frozen contract (docs/domain.md, sections 10 and 12): the shape of every kind of data — the catalog,
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
	PRACTICE_LANGUAGE_KEYS,
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
	blockTestPairs,
	isAuthor,
	reviewerIdentity,
	capacityChecks,
	type BankRelease,
	type FamilyDescriptor,
	type FamilyGates,
	type ItemInstance
} from './bank.ts';
import { SCALE, maxLength, type ProcedureParams, type TrajectoryModel } from './procedure.ts';
import type { GradePolicy } from './policy.ts';

const text = z.string().trim().min(1);
const share = z.number().gt(0).lt(1);
const positiveInt = z.int().positive();
const specialization = z.enum(SPECIALIZATION_KEYS);
const grade = z.enum(GRADE_KEYS);
const format = z.enum(ITEM_FORMATS);
const practiceLanguage = z.enum(PRACTICE_LANGUAGE_KEYS);
/** A share on the scale of the procedure: a multiple of 1/20. */
const onScale = (x: number): boolean => Math.abs(x * SCALE - Math.round(x * SCALE)) < 1e-9;
const scaledShare = z.number().min(0).max(1).refine(onScale, 'not a multiple of 1/20');
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
			practiceLanguages: z.array(practiceLanguage).min(1)
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
			defining: z.array(blockCode).length(2),
			practice: z.strictObject({
				block: blockCode,
				position: positiveInt,
				changeStep: z.boolean(),
				gateMinScore: scaledShare.refine((x) => x > 0, 'gate must be positive')
			}),
			doesNotCheck: z.array(text)
		})
	),
	commonDoesNotCheck: z.array(text).min(1)
});

const lengthsSchema = z
	.strictObject({ nMin: positiveInt, nMax: positiveInt, extension: positiveInt })
	.refine((l) => l.nMin <= l.nMax, 'nMin > nMax');

const byGrade = z.strictObject({ intern: share, junior: share, middle: share, senior: share });
const acceptanceSchema = { falseConfirmMax: byGrade, trueConfirmMin: byGrade, undeterminedMax: share };
const errorsAtEnds = z.strictObject({ atP0Confirmed: share, atP1NotConfirmed: share });
const consistency = z.array(z.strictObject({ shift: z.number(), min: share })).min(1);

const procedureSchema = z.strictObject({
	version: text,
	delta: z.number().positive(),
	alpha: z.number().gt(0).lt(0.5),
	beta: z.number().gt(0).lt(0.5),
	bands: z.strictObject({ atMax: positiveInt, final: positiveInt }),
	confidentMargin: positiveInt,
	blockVerdictMargin: positiveInt,
	definingMinItems: positiveInt,
	definingFailMargin: positiveInt,
	grades: z.strictObject({
		intern: lengthsSchema,
		junior: lengthsSchema,
		middle: lengthsSchema,
		senior: lengthsSchema
	}),
	homogeneousAcceptance: z.strictObject({
		...acceptanceSchema,
		cuts: z.array(scaledShare).min(1),
		indifferenceErrorsMax: z.strictObject({
			intern: errorsAtEnds,
			junior: errorsAtEnds,
			middle: errorsAtEnds,
			senior: errorsAtEnds
		}),
		biasSensitivity: z
			.array(z.strictObject({ bias: z.number().min(-0.3).max(0.3), falseConfirmMax: share, trueConfirmMin: share }))
			.min(1),
		consistencyMin: consistency
	}),
	trajectoryAcceptance: z.strictObject({
		...acceptanceSchema,
		model: z.strictObject({
			itemAngoff: scaledShare,
			practiceAngoff: scaledShare,
			practiceGroups: positiveInt,
			rho: share,
			changeStepWeight: scaledShare
		}),
		weakDefiningBlockConfirmMax: share,
		consistencyMin: consistency
	})
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

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const reviewerSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('model'), model: text, lineage: text }),
	z.strictObject({ kind: z.literal('person'), name: text })
]);

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
					ratings: z.array(
						z.strictObject({
							rater: reviewerSchema,
							p: z.number().min(0.05).max(0.95),
							ratedAt: z.iso.date(),
							sourceSha256: sha256
						})
					),
					mean: share
				}),
				constructive: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
				constructiveRank: positiveInt,
				timeNormSec: positiveInt,
				classes: z.array(z.strictObject({ id: text, form: z.enum(['A', 'B', 'anchor', 'X']), description: text }))
			})
		)
		.min(1)
		.max(2),
	surfaceParams: z.array(z.strictObject({ name: text, description: text })).min(1),
	essentialParams: z.array(z.strictObject({ name: text, description: text })).min(1),
	language: z.string().nullable(),
	practice: z.strictObject({ languages: z.array(practiceLanguage).min(1), hiddenTestGroups: positiveInt }).nullable(),
	qa: z
		.strictObject({
			budget: z.strictObject({ min: positiveInt, max: positiveInt }),
			mutants: z.array(z.strictObject({ id: text, operator: text }))
		})
		.nullable(),
	changeStep: z
		.strictObject({ description: text, weight: scaledShare.refine((w) => w > 0 && w < 1, 'weight in (0, 1)') })
		.nullable(),
	rubric: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('binary') }),
		z.strictObject({
			kind: z.literal('parts'),
			parts: z.array(z.strictObject({ id: text, weight: scaledShare })).min(2)
		}),
		z.strictObject({ kind: z.literal('groups') }),
		z.strictObject({
			kind: z.literal('mutants'),
			levels: z.array(z.strictObject({ minKillRatio: z.number().min(0).max(1), score: scaledShare })).min(2)
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
		rubricReviews: z.array(
			z.strictObject({
				reviewer: reviewerSchema,
				reviewedAt: z.iso.date(),
				verdict: z.enum(['approved', 'changes_requested']),
				remarks: z.array(text),
				sourceSha256: sha256
			})
		)
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
			languages: z.array(practiceLanguage).min(1),
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
			weight: scaledShare.refine((w) => w > 0 && w < 1, 'weight in (0, 1)'),
			answer: answerSchema.nullable(),
			groups: z.array(groupSchema),
			qa: z
				.strictObject({
					specification: text,
					mutants: z.array(z.strictObject({ id: text, operator: text, equivalent: z.boolean() })).min(1)
				})
				.nullable()
		})
		.nullable(),
	timeNormSec: positiveInt
});

/**
 * A problem of the bank's data. `defect` — the data is wrong and must be fixed; `awaiting_raters` — a level waits for its
 * independent Angoff ratings on the current sources (its `mean` is the authors' provisional cut meanwhile);
 * `awaiting_reviews` — the family waits for the approvals of its rubric. Consumers tell a pending judgement from a defect
 * by the code, never by the text.
 */
export type ProblemCode = 'defect' | 'awaiting_raters' | 'awaiting_reviews';

export interface ValidationProblem {
	code: ProblemCode;
	message: string;
}

const defects = (messages: readonly string[]): ValidationProblem[] =>
	messages.map((message) => ({ code: 'defect', message }));

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
		const missing = spec.practiceLanguages.filter((l) => !(SANDBOX_LANGUAGE_KEYS as readonly string[]).includes(l));
		if (spec.availability === 'enabled' && missing.length) {
			problems.push(`catalog: ${spec.key} is enabled, but the sandbox image lacks ${missing.join(', ')}`);
		}
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
		if (definition.practice.position > lengths.nMin + 1) {
			problems.push(
				`catalog: ${pair} practice at slot ${definition.practice.position}, after the minimum of ${lengths.nMin} items`
			);
		}
		if (definition.defining.length === 2 && definition.defining[0] === definition.defining[1]) {
			problems.push(`catalog: ${pair} names the same defining block twice`);
		}
		for (const code of definition.defining) {
			const quota = definition.blocks.find((q) => q.block === code);
			if (!quota || blocks.get(code)?.practice !== false) {
				problems.push(`catalog: ${pair} defining block ${code} is not a non-practice block of the plan`);
			} else if (quota.items < procedure.definingMinItems) {
				problems.push(
					`catalog: ${pair} defining block ${code} has ${quota.items} items, ${procedure.definingMinItems} required`
				);
			}
		}
		if (definition.defining.length * procedure.definingMinItems > lengths.nMin) {
			problems.push(`catalog: ${pair} defining blocks do not fit the minimum of ${lengths.nMin} items`);
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
export function familyProblems(
	family: FamilyDescriptor,
	sourceSha256: string,
	gates: FamilyGates = FAMILY_GATES
): ValidationProblem[] {
	const where = `family ${family.key}`;
	const problems = shapeProblems(familySchema, family, where);
	if (problems.length) return defects(problems);
	const block = CATALOG.blocks.find((b) => b.code === family.block);
	if (!block) return defects([`${where}: unknown block ${family.block}`]);
	const awaiting: ValidationProblem[] = [];
	for (const conflict of authorConflicts(family))
		problems.push(`${where}: ${conflict} is an author of the family and cannot judge it`);
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
		const ratings = level.angoff.ratings;
		const raters = ratings.map((r) => reviewerIdentity(r.rater));
		if (duplicates(raters).length) problems.push(`${lw}: a rater (or a model lineage) rated twice`);
		for (const rating of ratings) {
			if (!onAngoffScale(rating.p)) problems.push(`${lw}: Angoff rating ${rating.p} is not on the 0.05 scale`);
		}
		// The cut in force: the mean of the current ratings once enough independent raters judged the sources; until then
		// `mean` is the authors' provisional cut — only its scale and, for a practice, its range are checked.
		const current = ratings.filter((r) => r.sourceSha256 === sourceSha256 && !isAuthor(r.rater, family));
		const rated = new Set(current.map((r) => reviewerIdentity(r.rater))).size >= gates.angoffRatersMin;
		if (!rated && !onScale(level.angoff.mean))
			problems.push(`${lw}: Angoff mean ${level.angoff.mean} is not on the 1/20 scale`);
		if (
			isPractice(family.format) &&
			(level.angoff.mean < gates.practiceAngoff.min - 1e-9 || level.angoff.mean > gates.practiceAngoff.max + 1e-9)
		) {
			problems.push(
				`${lw}: a practice cluster is a gate the borderline candidate passes: Angoff ${gates.practiceAngoff.min}–${gates.practiceAngoff.max}`
			);
		}
		const gap =
			rated && Math.max(...current.map((r) => r.p)) - Math.min(...current.map((r) => r.p)) > gates.angoffGapMax + 1e-9;
		if (!rated) {
			awaiting.push({
				code: 'awaiting_raters',
				message: `${lw}: awaits ${gates.angoffRatersMin} independent Angoff ratings on the current sources (provisional cut ${level.angoff.mean})`
			});
		} else if (gap && level.angoff.round !== 2) {
			awaiting.push({
				code: 'awaiting_raters',
				message: `${lw}: ratings differ by more than ${gates.angoffGapMax} — awaits the second round`
			});
		} else if (gap) {
			problems.push(
				`${lw}: ratings still differ by more than ${gates.angoffGapMax} after the second round — not admitted`
			);
		} else {
			const mean = current.reduce((sum, r) => sum + r.p, 0) / current.length;
			// The cut of the level is the mean on the procedure's scale, ties rounded up (the stricter cut).
			const scaled = Math.floor(mean * SCALE + 0.5 + 1e-9) / SCALE;
			if (Math.abs(scaled - level.angoff.mean) > 1e-9)
				problems.push(
					`${lw}: Angoff mean ${level.angoff.mean} is not ${scaled.toFixed(2)} (mean ${mean.toFixed(3)} on the 1/20 scale)`
				);
		}
		const ids = level.classes.map((c) => c.id);
		for (const id of duplicates(ids)) problems.push(`${lw}: class ${id} twice`);
		const forms = new Set(level.classes.map((c) => c.form));
		if (!forms.has('A') || !forms.has('B')) problems.push(`${lw}: needs an essential class of form A and of form B`);
		if (level.classes.filter((c) => c.form === 'anchor').length > 1) problems.push(`${lw}: at most one anchor class`);
		if (definition && isPractice(family.format) && definition.practice.block !== family.block) {
			problems.push(`${lw}: ${family.block} is not the practice block of ${level.grade}`);
		}
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
		if (family.practice) problems.push(`${where}: QA has no practice particulars`);
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
	const gate = gateProblems(family, sourceSha256, gates);
	return [...defects([...problems, ...gate.defects]), ...awaiting, ...gate.awaiting];
}

/**
 * Judges who are authors of the family (`isAuthor`): the same person, or the same model as an author entry
 * `<model> (<vendor>)`. Another model of the author's vendor may judge; the product says so (`sameVendorReviewer`).
 */
function authorConflicts(family: FamilyDescriptor): string[] {
	const judges = [
		...family.gates.rubricReviews.map((r) => r.reviewer),
		...family.levels.flatMap((l) => l.angoff.ratings.map((r) => r.rater))
	];
	return [
		...new Set(
			judges
				.filter((judge) => isAuthor(judge, family))
				.map((judge) => (judge.kind === 'person' ? judge.name : `${judge.model} (${judge.lineage})`))
		)
	];
}

/** The admission gates of a family: reference, wrong solutions, hidden tests, collisions, transfer, rubric review. */
function gateProblems(
	family: FamilyDescriptor,
	sourceSha256: string,
	gates: FamilyGates
): { defects: string[]; awaiting: ValidationProblem[] } {
	const where = `family ${family.key}: gate`;
	const report = family.gates;
	const problems: string[] = [];
	const awaiting: ValidationProblem[] = [];
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
	const current = report.rubricReviews.filter((review) => review.sourceSha256 === sourceSha256);
	if (current.some((review) => review.verdict === 'changes_requested'))
		problems.push(`${where} a review of the current sources requests changes`);
	// The author's own judgements never count (they are a defect besides).
	const approved = current.filter((review) => review.verdict === 'approved' && !isAuthor(review.reviewer, family));
	const persons = new Set(
		approved.filter((x) => x.reviewer.kind === 'person').map((x) => reviewerIdentity(x.reviewer))
	);
	const lineages = new Set(
		approved.filter((x) => x.reviewer.kind === 'model').map((x) => reviewerIdentity(x.reviewer))
	);
	if (persons.size < gates.reviewsNeeded.persons && lineages.size < gates.reviewsNeeded.models) {
		awaiting.push({
			code: 'awaiting_reviews',
			message: `${where} rubric needs ${gates.reviewsNeeded.models} approvals by models of different lineages or ${gates.reviewsNeeded.persons} by a person on the current sources`
		});
	}
	return { defects: problems, awaiting };
}

/** A generated instance against its descriptor: the same family, level, class, format and answer kind, a usable answer. */
export function instanceProblems(instance: ItemInstance, family: FamilyDescriptor): ValidationProblem[] {
	return defects(instanceDefects(instance, family));
}

function instanceDefects(instance: ItemInstance, family: FamilyDescriptor): string[] {
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
	if (instance.changeStep) {
		const qaStep = instance.changeStep.qa !== null;
		if (qaStep !== (family.format === 'qa_mutation'))
			problems.push(`${where}: a QA change step carries its specification and mutants, others none`);
		if (family.format === 'practice_code' && instance.changeStep.groups.length === 0)
			problems.push(`${where}: the change step of a program needs its groups`);
	}
	if (instance.practice) {
		for (const language of instance.practice.languages) {
			if (!family.practice?.languages.includes(language))
				problems.push(`${where}: language ${language} is not the family's`);
		}
	}
	if (
		instance.statement.code &&
		![...SANDBOX_LANGUAGE_KEYS, ...GENERATOR_LANGUAGE_KEYS].includes(instance.statement.code.language as never)
	) {
		problems.push(`${where}: code in unknown language ${instance.statement.code.language}`);
	}
	return problems;
}

/**
 * The engine's simulation of whole trajectories on the families of a release (domain 10.6): per grade, the points of
 * the curve at given shifts of the true share from the cut and the consistency of a retake on the other form.
 */
export interface TrajectoryReport {
	releaseId: string;
	procedureVersion: string;
	/** The answer model the simulation ran under; its named assumptions go into the report text. */
	model: Pick<TrajectoryModel, 'rho' | 'practiceGroups'>;
	grades: readonly {
		grade: GradeKey;
		points: readonly { shift: number; runs: number; confirmed: number; undetermined: number; notConfirmed: number }[];
		consistency: readonly { shift: number; value: number }[];
	}[];
}

const RUNS_MIN = 1000;

/** The release's trajectory report against `trajectoryAcceptance`: every grade, every bound, enough runs. */
export function trajectoryReportProblems(
	report: TrajectoryReport,
	release: BankRelease,
	procedure: ProcedureParams
): ValidationProblem[] {
	return defects(trajectoryDefects(report, release, procedure));
}

function trajectoryDefects(report: TrajectoryReport, release: BankRelease, procedure: ProcedureParams): string[] {
	const where = `trajectory report of ${release.id}`;
	const acceptance = procedure.trajectoryAcceptance;
	const problems: string[] = [];
	if (report.releaseId !== release.id) problems.push(`${where}: made for ${report.releaseId}`);
	if (report.procedureVersion !== procedure.version) problems.push(`${where}: procedure ${report.procedureVersion}`);
	const at = (points: TrajectoryReport['grades'][number]['points'], shift: number) =>
		points.find((p) => Math.abs(p.shift - shift) < 1e-9);
	for (const g of GRADE_KEYS) {
		const entry = report.grades.find((e) => e.grade === g);
		if (!entry) {
			problems.push(`${where}: no ${g}`);
			continue;
		}
		const low = at(entry.points, -0.15);
		const high = at(entry.points, 0.15);
		if (!low || !high) problems.push(`${where}: ${g} lacks the points at −0.15 and +0.15`);
		if (low && low.confirmed > acceptance.falseConfirmMax[g])
			problems.push(`${where}: ${g} false confirmation ${low.confirmed} > ${acceptance.falseConfirmMax[g]}`);
		if (high && high.confirmed < acceptance.trueConfirmMin[g])
			problems.push(`${where}: ${g} true confirmation ${high.confirmed} < ${acceptance.trueConfirmMin[g]}`);
		for (const point of entry.points) {
			if (point.runs < RUNS_MIN)
				problems.push(`${where}: ${g} at ${point.shift} has ${point.runs} runs, ${RUNS_MIN} required`);
			if (point.undetermined > acceptance.undeterminedMax)
				problems.push(`${where}: ${g} at ${point.shift} undetermined ${point.undetermined}`);
		}
		for (const { shift, min } of acceptance.consistencyMin) {
			const value = entry.consistency.find((c) => Math.abs(c.shift - shift) < 1e-9)?.value;
			if (value === undefined || value < min)
				problems.push(`${where}: ${g} consistency at ${shift} is ${value ?? 'missing'}, ${min} required`);
		}
	}
	return problems;
}

/**
 * A bank release of one specialization: every family valid, unique and of the specialization, the anchors of every
 * grade, every extreme history served (`capacityChecks`) and the trajectory report within the acceptance.
 */
export function releaseProblems(
	release: BankRelease,
	procedure: ProcedureParams,
	report: TrajectoryReport,
	gates: FamilyGates = FAMILY_GATES
): ValidationProblem[] {
	const where = `release ${release.id}`;
	const problems: string[] = [];
	const judged: ValidationProblem[] = [];
	if (release.catalogVersion !== CATALOG.version)
		problems.push(`${where}: catalog ${release.catalogVersion}, current ${CATALOG.version}`);
	if (release.procedureVersion !== procedure.version)
		problems.push(`${where}: procedure ${release.procedureVersion}, current ${procedure.version}`);
	if (!release.id.startsWith(`${release.specialization}@${release.catalogVersion}-`))
		problems.push(`${where}: id must be ${release.specialization}@${release.catalogVersion}-<n>`);
	if (!/^[0-9a-f]{64}$/.test(release.sharedSha256)) problems.push(`${where}: sharedSha256 is not a SHA-256`);
	for (const key of duplicates(release.families.map((f) => f.key))) problems.push(`${where}: family ${key} twice`);
	for (const family of release.families) {
		if (family.specialization !== release.specialization)
			problems.push(`${where}: ${family.key} is of ${family.specialization}`);
		const source = release.familySources[family.key];
		if (source === undefined) problems.push(`${where}: no source hash of ${family.key}`);
		else judged.push(...familyProblems(family, source, gates));
	}
	for (const g of GRADE_KEYS) {
		const anchors = release.families.filter((f) =>
			f.levels.some((l) => l.grade === g && l.classes.some((c) => c.form === 'anchor'))
		).length;
		if (anchors < gates.anchorsPerGrade)
			problems.push(`${where}: ${g} has ${anchors} anchor family-levels, ${gates.anchorsPerGrade} required`);
	}
	for (const g of GRADE_KEYS) {
		for (const { block } of blockTestPairs(release.specialization).filter((p) => p.grade === g)) {
			const families = release.families.filter((f) => f.block === block && f.levels.some((l) => l.grade === g)).length;
			if (families < gates.blockTestFamiliesMin)
				problems.push(
					`${where}: ${block}@${g} has ${families} families, a block test needs ${gates.blockTestFamiliesMin}`
				);
		}
	}
	for (const check of capacityChecks(release, procedure)) {
		if (check.ok) continue;
		const steps = [...new Set(check.shortages.map((s) => `${s.step} in ${s.block}`))].join(', ');
		problems.push(`${where}: ${check.grade} ${check.scenario.join('→')} runs out: ${steps}`);
	}
	return [...defects(problems), ...judged, ...trajectoryReportProblems(report, release, procedure)];
}

/** The family-levels of a grade a release has, by block: what the factory reports against the quotas. */
export function levelsByBlock(release: BankRelease, g: GradeKey): Map<string, number> {
	const counts = new Map<string, number>();
	for (const family of release.families) {
		if (family.levels.some((l) => l.grade === g)) counts.set(family.block, (counts.get(family.block) ?? 0) + 1);
	}
	return counts;
}
