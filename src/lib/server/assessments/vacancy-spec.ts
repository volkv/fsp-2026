// The specification of the test of a vacancy (docs/domain.md, 13.11): what a vacancy or a need asks for, read against
// the catalog and the released banks. The base is the test of the category of the vacancy — its specialization and
// grade, one for all candidates; a required skill whose block the grade allows a block test of (`blockTestPairs`) adds
// that block test, four clusters apart from the grade decision; a skill the test of the grade does not confirm, a skill
// of another specialization and a requirement outside the taxonomy are named as such. The example set of items is
// drawn by the same choice the engine serves an attempt with (`chooseForSlot`, `attemptForm`, `blockTestSlots`) over the
// release in force, for a candidate who has seen nothing, by a seed of the vacancy. Only blocks, formats and time norms
// come out: no family, class, seed or instance — the specification never generates an item.
import { blockTestAllowed, blockTestDurationMs, blockTestSlots } from './block-test';
import type { FamilyDescriptor } from './contract/bank';
import {
	CATALOG,
	GRADE_KEYS,
	PRACTICE_LANGUAGE_SKILLS,
	blockDefinition,
	gradeDefinition,
	practiceWritesCode,
	type GradeKey,
	type ItemFormat,
	type SpecializationKey
} from './contract/catalog';
import { PROCEDURE } from './contract/procedure';
import { attemptDurationMs, attemptForm, chooseForSlot, slotsOf, type AttemptForm, type SlotChoice } from './select';
import { testTitle } from './titles';

/** What an item of a format asks of the candidate, for the employer: the kind of the task, never its condition. */
const FORMAT_TITLES: Readonly<Record<ItemFormat, string>> = {
	code_trace: 'Чтение кода: что вернёт или выведет фрагмент',
	sql_trace: 'Чтение SQL: результат запроса',
	bug_locate: 'Поиск строки с ошибкой',
	compute: 'Расчёт по условию задачи',
	config_eval: 'Разбор конфигурации',
	practice_code: 'Программа на выбранном языке, проверка скрытыми тестами',
	qa_mutation: 'Тест-кейсы к спецификации, проверка на заложенных ошибках'
};

/** A requirement of a vacancy or a need: a skill of the taxonomy, or a name the taxonomy does not know. */
export interface SpecRequirement {
	/** `null` — outside the taxonomy («Hugging Face»): no block can check it. */
	skillKey: string | null;
	name: string;
	requirement: 'required' | 'nice';
}

/**
 * How the test of a pair covers a requirement: `base_stack` — a defining block of the grade, confirmed by the test of
 * the category; `base_practice` — the language of the practice program the candidate writes; `vacancy_block` — the block
 * test the vacancy adds; `block_on_request` — a nice-to-have skill whose block test the employer may ask for, outside
 * the set of the vacancy; `not_at_grade` — the block of the skill is not tested at this grade on its own (not in the plan
 * or a quota under the block-test minimum); `other_specialization` — a block of another open specialization checks it;
 * `not_tested` — no block of an open specialization confirms the skill, or it is outside the taxonomy.
 */
export type RequirementCoverage =
	| { kind: 'base_stack'; block: string; blockTitle: string }
	| { kind: 'base_practice' }
	| { kind: 'vacancy_block'; block: string; blockTitle: string }
	| { kind: 'block_on_request'; block: string; blockTitle: string }
	| { kind: 'not_at_grade'; block: string; blockTitle: string; itemsInPlan: number }
	| { kind: 'other_specialization'; specialization: SpecializationKey; block: string; title: string }
	| { kind: 'not_tested'; reason: 'no_block' | 'outside_taxonomy' };

export interface CoveredRequirement extends SpecRequirement {
	coverage: RequirementCoverage;
	/** Whether the test of the vacancy (the base and its block tests) gives a confirmation of it. */
	tested: boolean;
}

/** One slot of the example set: the block and the kind of the item, never the item. */
export interface SampleSlot {
	position: number;
	block: string;
	blockTitle: string;
	format: ItemFormat;
	formatTitle: string;
	practice: boolean;
	timeNormSec: number;
}

export interface BasePlan {
	title: string;
	blocks: {
		block: string;
		title: string;
		checks: string;
		/** Items of the block on the longest trajectory. */
		items: number;
		defining: boolean;
		practice: boolean;
	}[];
	/** Skills the confirmed category gives: of the defining blocks; the practice language comes on top of them. */
	stackSkillKeys: string[];
	/** Skills of the practice languages the candidate chooses from, when the practice is a program they write. */
	practiceLanguageSkillKeys: string[];
	/** Slots of the shortest and the longest trajectory, the practice included. */
	shortestSlots: number;
	longestSlots: number;
	/** The form the example is drawn on; a real attempt takes its own by the rule of forms. */
	form: AttemptForm;
	/** The example set along the longest trajectory; a slot the release cannot serve is absent and named in `unserved`. */
	sample: SampleSlot[];
	unserved: number[];
	/** Time norms of the example set: the shortest and the longest trajectory, seconds. */
	normShortestSec: number;
	normLongestSec: number;
	/** The deadline of an attempt (`attemptDurationMs`). */
	deadlineMs: number;
	doesNotCheck: string[];
}

export interface VacancyBlockPlan {
	block: string;
	title: string;
	checks: string;
	/** Required skills of the vacancy the block test confirms. */
	skillKeys: string[];
	clusters: number;
	sample: SampleSlot[];
	/** Whether the release serves all clusters to a candidate who has seen nothing (`blockTestServable`). */
	servable: boolean;
	normSec: number;
	/** The deadline of the block test (`blockTestDurationMs`). */
	deadlineMs: number;
}

export interface OpenPlan {
	status: 'open';
	specialization: SpecializationKey;
	grade: GradeKey;
	base: BasePlan;
	vacancyBlocks: VacancyBlockPlan[];
	requirements: CoveredRequirement[];
}

export interface ClosedPlan {
	status: 'closed';
	specialization: SpecializationKey;
	grade: GradeKey;
	title: string;
	/** `disabled` — switched off in the catalog; `not_released` — its bank has no release in force. */
	reason: 'disabled' | 'not_released';
}

export type PairPlan = OpenPlan | ClosedPlan;

/**
 * Why there is no pair: `no_specialization` — the role is one no test of the catalog checks, or nothing names it;
 * `no_grade` — the vacancy or the need names no grade of the catalog (Lead is outside it).
 */
export type SpecGap = 'no_specialization' | 'no_grade';

export interface VacancyTestSpec {
	specializations: SpecializationKey[];
	grades: GradeKey[];
	plans: PairPlan[];
	gaps: SpecGap[];
	/** Without an open pair: the requirements against the open specializations, for the employer to see. */
	requirements: CoveredRequirement[];
}

export interface SpecInput {
	/** The specializations of the role of the vacancy, or the one of the form of the need. */
	specializations: readonly SpecializationKey[];
	/** Grades of the range, as the taxonomy writes them; those outside the catalog are dropped. */
	grades: readonly string[];
	requirements: readonly SpecRequirement[];
	/** The seed of the example set: the vacancy and its revision, so the same vacancy shows the same set. */
	seed: string;
}

/** The families of the release in force of every open specialization: what the engine serves now. */
export type OpenBanks = ReadonlyMap<SpecializationKey, readonly FamilyDescriptor[]>;

const isGrade = (value: string): value is GradeKey => (GRADE_KEYS as readonly string[]).includes(value);

function slotOf(choice: SlotChoice, position: number, practice: boolean): SampleSlot {
	return {
		position,
		block: choice.family.block,
		blockTitle: blockDefinition(choice.family.block).title,
		format: choice.family.format,
		formatTitle: FORMAT_TITLES[choice.family.format],
		practice,
		timeNormSec: choice.level.timeNormSec
	};
}

/**
 * The choices of a grade attempt along its longest trajectory, slot by slot as the engine serves them: the families
 * already used are not taken again, the seed of slot `seq` is the attempt's seed and `seq`. `null` — the slot cannot be
 * served. Exported for the check that the example is the engine's choice.
 */
export function gradeSampleChoices(
	families: readonly FamilyDescriptor[],
	specialization: SpecializationKey,
	grade: GradeKey,
	seed: string
): { form: AttemptForm; choices: (SlotChoice | null)[] } {
	const seen = new Set<string>();
	const form = attemptForm(families, grade, seen, seed);
	const used = new Set<string>();
	const choices = slotsOf(specialization, grade).map((slot, index) => {
		const choice = chooseForSlot({
			families,
			grade,
			slot,
			want: { kind: 'grade', form },
			usedFamilies: used,
			seen,
			attemptSeed: seed,
			seq: index + 1
		});
		if (choice) used.add(choice.family.key);
		return choice;
	});
	return { form, choices };
}

/** The choices of a block test, cluster by cluster as the engine serves it: reserve classes `X`, a family each. */
export function blockSampleChoices(
	families: readonly FamilyDescriptor[],
	grade: GradeKey,
	block: string,
	seed: string
): (SlotChoice | null)[] {
	const used = new Set<string>();
	return blockTestSlots(block).map((slot) => {
		const choice = chooseForSlot({
			families,
			grade,
			slot,
			want: { kind: 'reserve' },
			usedFamilies: used,
			seen: new Set(),
			attemptSeed: seed,
			seq: slot.position
		});
		if (choice) used.add(choice.family.key);
		return choice;
	});
}

function basePlan(
	families: readonly FamilyDescriptor[],
	specialization: SpecializationKey,
	grade: GradeKey,
	seed: string
): BasePlan {
	const definition = gradeDefinition(specialization, grade);
	const { form, choices } = gradeSampleChoices(families, specialization, grade, `${seed}:${specialization}:${grade}`);
	const slots = slotsOf(specialization, grade);
	const sample: SampleSlot[] = [];
	const unserved: number[] = [];
	choices.forEach((choice, index) => {
		const slot = slots[index];
		if (!slot) throw new Error(`no slot ${index + 1} of ${specialization} ${grade}`);
		if (choice) sample.push(slotOf(choice, slot.position, slot.practice));
		else unserved.push(slot.position);
	});
	const lengths = PROCEDURE.grades[grade];
	const shortestSlots = lengths.nMin + 1;
	const norm = (upTo: number) => sample.filter((s) => s.position <= upTo).reduce((sum, s) => sum + s.timeNormSec, 0);
	const languages = practiceWritesCode(definition)
		? (CATALOG.specializations.find((s) => s.key === specialization)?.practiceLanguages ?? []).map(
				(language) => PRACTICE_LANGUAGE_SKILLS[language]
			)
		: [];
	return {
		title: testTitle(specialization, grade),
		blocks: definition.blocks.map((quota) => {
			const block = blockDefinition(quota.block);
			return {
				block: quota.block,
				title: block.title,
				checks: block.checks,
				items: quota.items,
				defining: definition.defining.includes(quota.block),
				practice: quota.block === definition.practice.block
			};
		}),
		stackSkillKeys: [...new Set(definition.defining.flatMap((code) => blockDefinition(code).skillKeys))].sort(),
		practiceLanguageSkillKeys: [...new Set(languages)],
		shortestSlots,
		longestSlots: slots.length,
		form,
		sample,
		unserved,
		normShortestSec: norm(shortestSlots),
		normLongestSec: norm(slots.length),
		deadlineMs: attemptDurationMs(families, specialization, grade),
		doesNotCheck: [...definition.doesNotCheck, ...CATALOG.commonDoesNotCheck]
	};
}

/** Non-practice blocks of a specialization that confirm a skill, in the order of the catalog. */
function blocksOfSkill(specialization: SpecializationKey, skillKey: string) {
	return CATALOG.blocks.filter(
		(b) => b.specialization === specialization && !b.practice && b.skillKeys.includes(skillKey)
	);
}

/** A block of another open specialization that confirms the skill: the first by the order of the catalog. */
function otherSpecialization(
	skillKey: string,
	own: SpecializationKey | null,
	open: ReadonlySet<SpecializationKey>
): RequirementCoverage | null {
	for (const block of CATALOG.blocks) {
		if (block.practice || block.specialization === own || !open.has(block.specialization)) continue;
		if (!block.skillKeys.includes(skillKey)) continue;
		const title = CATALOG.specializations.find((s) => s.key === block.specialization)?.title ?? block.specialization;
		return {
			kind: 'other_specialization',
			specialization: block.specialization,
			block: block.code,
			title: `${title}: ${block.title}`
		};
	}
	return null;
}

const TESTED: ReadonlySet<RequirementCoverage['kind']> = new Set(['base_stack', 'base_practice', 'vacancy_block']);

/** The coverage of a requirement by the test of a pair; the strongest basis first. */
function coverageAt(
	requirement: SpecRequirement,
	specialization: SpecializationKey,
	grade: GradeKey,
	open: ReadonlySet<SpecializationKey>,
	languages: readonly string[]
): RequirementCoverage {
	const skill = requirement.skillKey;
	if (skill === null) return { kind: 'not_tested', reason: 'outside_taxonomy' };
	const definition = gradeDefinition(specialization, grade);
	const blocks = blocksOfSkill(specialization, skill);
	const defining = blocks.find((b) => definition.defining.includes(b.code));
	if (defining) return { kind: 'base_stack', block: defining.code, blockTitle: defining.title };
	if (languages.includes(skill)) return { kind: 'base_practice' };
	const testable = blocks.find((b) => blockTestAllowed(specialization, b.code, grade));
	if (testable) {
		return {
			kind: requirement.requirement === 'required' ? 'vacancy_block' : 'block_on_request',
			block: testable.code,
			blockTitle: testable.title
		};
	}
	const [first] = blocks;
	if (first) {
		const quota = definition.blocks.find((q) => q.block === first.code);
		return { kind: 'not_at_grade', block: first.code, blockTitle: first.title, itemsInPlan: quota?.items ?? 0 };
	}
	return otherSpecialization(skill, specialization, open) ?? { kind: 'not_tested', reason: 'no_block' };
}

const covered = (requirement: SpecRequirement, coverage: RequirementCoverage): CoveredRequirement => ({
	...requirement,
	coverage,
	tested: TESTED.has(coverage.kind)
});

/** Whether a specialization takes tests now: switched on and with its bank released (`specializationOpen`). */
function closedReason(specialization: SpecializationKey, banks: OpenBanks): 'disabled' | 'not_released' | null {
	if (CATALOG.specializations.find((s) => s.key === specialization)?.availability !== 'enabled') return 'disabled';
	return banks.has(specialization) ? null : 'not_released';
}

/**
 * The specification of the test of a vacancy or a need: a plan for every specialization × grade of its range, with
 * the coverage of each requirement. A pure function of the input and the banks: the same vacancy gives the same plan.
 */
export function vacancyTestSpec(input: SpecInput, banks: OpenBanks): VacancyTestSpec {
	const open = new Set(banks.keys());
	const specializations = [...new Set(input.specializations)];
	const grades = GRADE_KEYS.filter((grade) => input.grades.some((g) => isGrade(g) && g === grade));
	const gaps: SpecGap[] = [];
	if (specializations.length === 0) gaps.push('no_specialization');
	if (grades.length === 0) gaps.push('no_grade');
	const plans: PairPlan[] = [];
	for (const specialization of specializations) {
		for (const grade of grades) {
			const reason = closedReason(specialization, banks);
			const families = banks.get(specialization);
			if (reason !== null || families === undefined) {
				plans.push({
					status: 'closed',
					specialization,
					grade,
					title: testTitle(specialization, grade),
					reason: reason ?? 'not_released'
				});
				continue;
			}
			const base = basePlan(families, specialization, grade, input.seed);
			const requirements = input.requirements.map((r) =>
				covered(r, coverageAt(r, specialization, grade, open, base.practiceLanguageSkillKeys))
			);
			const byBlock = new Map<string, string[]>();
			for (const r of requirements) {
				if (r.coverage.kind !== 'vacancy_block' || r.skillKey === null) continue;
				byBlock.set(r.coverage.block, [...(byBlock.get(r.coverage.block) ?? []), r.skillKey]);
			}
			const vacancyBlocks = [...byBlock].map(([code, skillKeys]): VacancyBlockPlan => {
				const block = blockDefinition(code);
				const choices = blockSampleChoices(families, grade, code, `${input.seed}:${specialization}:${grade}:${code}`);
				const sample = choices.flatMap((choice, index) => (choice ? [slotOf(choice, index + 1, false)] : []));
				return {
					block: code,
					title: block.title,
					checks: block.checks,
					skillKeys,
					clusters: choices.length,
					sample,
					servable: sample.length === choices.length,
					normSec: sample.reduce((sum, s) => sum + s.timeNormSec, 0),
					deadlineMs: blockTestDurationMs(families, grade, code)
				};
			});
			plans.push({ status: 'open', specialization, grade, base, vacancyBlocks, requirements });
		}
	}
	const requirements = plans.some((p) => p.status === 'open')
		? []
		: input.requirements.map((r) =>
				covered(
					r,
					r.skillKey === null
						? { kind: 'not_tested', reason: 'outside_taxonomy' }
						: (otherSpecialization(r.skillKey, null, open) ?? { kind: 'not_tested', reason: 'no_block' })
				)
			);
	return { specializations, grades, plans, gaps, requirements };
}
