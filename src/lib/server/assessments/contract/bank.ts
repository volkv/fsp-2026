// The bank of item families (docs/domain.md, sections 23.7–23.8): what a family declares, what its generator returns
// for a seed, how the slots of a test are laid out by the blueprint of a grade and whether a released version of the
// bank can serve every extreme trajectory without running out or showing a candidate a family-level class twice.
//
// Types and pure functions; the families themselves (descriptor + generator code) live in the bank tree and are
// checked by the validator of this contract. Plain erasable TypeScript without `$lib`.
import {
	CATALOG,
	gradeDefinition,
	type GradeDefinition,
	type GradeKey,
	type ItemFormat,
	type SandboxLanguageKey,
	type SpecializationKey
} from './catalog.ts';
import { maxLength, type ProcedureParams } from './procedure.ts';

/** How the answer of an item is compared; every expected answer is computed by the generator. */
export const ANSWER_KINDS = [
	'exact',
	'tokens',
	'float_eps',
	'set',
	'sequence',
	'line_no',
	'code',
	'test_cases'
] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

/** A form of the test: an attempt is served in one; an anchor class is common to both forms. */
export type FormTag = 'A' | 'B' | 'anchor';

export interface EssentialClass {
	/** Unique within the family-level. */
	id: string;
	form: FormTag;
	/** Which essential parameters take which values and how the path of the solution differs from other classes. */
	description: string;
}

export interface AngoffRating {
	/** A named author of the team (the rating is «эталонная разметка команды», not an expert's). */
	rater: string;
	/** Probability that the borderline candidate of the grade scores the cluster, in steps of 0.05. */
	p: number;
}

export interface FamilyLevel {
	grade: GradeKey;
	angoff: {
		/** 1 — blind independent ratings; 2 — after the discussion of a gap above 0.2. */
		round: 1 | 2;
		ratings: readonly AngoffRating[];
		/** Mean of the ratings; the cut of the level. */
		mean: number;
	};
	/** Explicit generator parameters that set the constructive difficulty of the level (radicals). */
	constructive: Readonly<Record<string, string | number | boolean>>;
	/** Rank by constructive difficulty within the grade, for the Bookmark check; 1 — easiest. */
	constructiveRank: number;
	timeNormSec: number;
	/** At least one class of form A and one of form B; an anchor class is optional. */
	classes: readonly EssentialClass[];
}

export interface ParameterSpec {
	name: string;
	description: string;
}

export type Rubric =
	/** A computed answer: 1 when it matches, 0 otherwise. */
	| { kind: 'binary' }
	/** Parts of one answer scored separately; weights sum to 1. */
	| { kind: 'parts'; parts: readonly { id: string; weight: number }[] }
	/** A program: the share of hidden test groups passed in full; a group passes when all of its tests pass. */
	| { kind: 'groups' }
	/** QA test cases: the kill ratio mapped to a score by the highest level reached. */
	| { kind: 'mutants'; levels: readonly { minKillRatio: number; score: number }[] };

export interface WrongSolution {
	id: string;
	/** The defect or misconception it embodies. */
	defect: string;
	/** `true` — the hidden tests (or the answer check) must catch it; `false` — listed in `coverage.doesNotCheck`. */
	mustBeCaught: boolean;
}

export interface FamilyGateReport {
	/** The reference answer or program verified for every class on this many seeds, with this many failures. */
	reference: { seeds: number; failures: number };
	/** Wrong solutions run against the checks: how many of those that must be caught were caught. */
	wrongSolutions: { mustBeCaught: number; caught: number };
	/** Practice code: the share of template mutants our hidden tests kill. */
	hiddenTestsMutationScore: number | null;
	/** Share of pairs of instances (different seeds) with the same expected answer. */
	answerCollision: number;
	/** Practice code: share of hidden tests of class j a reference of class i passes (i ≠ j). */
	transfer: number | null;
	/** A brute-force reference agreed on this many random inputs; `null` — the family has none. */
	bruteForceInputs: number | null;
	/** A person read the rubric and the reference: who and when. */
	rubricReview: { reviewer: string; reviewedAt: string } | null;
}

export interface FamilyDescriptor {
	/** `<block>.<name>`, stable across versions. */
	key: string;
	version: number;
	specialization: SpecializationKey;
	block: string;
	format: ItemFormat;
	answerKind: AnswerKind;
	/** One grade or two adjacent grades; each level is its own unit of the bank. */
	levels: readonly FamilyLevel[];
	/** Incidental parameters: names, data, plot, order — they never change the path of a solution. */
	surfaceParams: readonly ParameterSpec[];
	/** Parameters that change the path of a solution; their value sets are the essential classes. */
	essentialParams: readonly ParameterSpec[];
	/** Language of the code an item shows: a sandbox language, a language the generator models, or none. */
	language: string | null;
	practice: {
		languages: readonly SandboxLanguageKey[];
		/** Groups of hidden tests; each group is one aspect of the specification. */
		hiddenTestGroups: number;
	} | null;
	qa: {
		budget: { min: number; max: number };
		/** Mutants instantiated with the instance; equivalent ones are known from differential runs and excluded. */
		mutants: readonly { id: string; operator: string }[];
	} | null;
	/** The step «измени своё решение»: a new essential condition after the answer; one cluster with the task. */
	changeStep: { description: string; weight: number } | null;
	rubric: Rubric;
	coverage: { checks: readonly string[]; doesNotCheck: readonly string[] };
	wrongSolutions: readonly WrongSolution[];
	authorship: { draftedBy: 'team' | 'model'; authors: readonly string[] };
	gates: FamilyGateReport;
}

/** An expected computed answer; never sent to the candidate. */
export type ComputedAnswer =
	| { kind: 'exact' | 'tokens'; value: string }
	| { kind: 'float_eps'; value: number; eps: number }
	| { kind: 'set' | 'sequence'; value: readonly string[] }
	| { kind: 'line_no'; value: number };

export interface HiddenTestGroup {
	id: string;
	tests: readonly { stdin: string; expected: string }[];
}

/** What a generator returns for (seed, grade, class): deterministic, the same input gives the same instance. */
export interface ItemInstance {
	family: string;
	familyVersion: number;
	grade: GradeKey;
	classId: string;
	seed: string;
	format: ItemFormat;
	answerKind: AnswerKind;
	statement: { markdown: string; code: { language: string; source: string } | null };
	answer: ComputedAnswer | null;
	practice: {
		languages: readonly SandboxLanguageKey[];
		groups: readonly HiddenTestGroup[];
		checker: { kind: 'exact' } | { kind: 'tokens' } | { kind: 'float_eps'; eps: number };
	} | null;
	qa: {
		budget: { min: number; max: number };
		/** The specification the candidate tests; the reference program is never shown. */
		specification: string;
		mutants: readonly { id: string; operator: string; equivalent: boolean }[];
	} | null;
	changeStep: {
		markdown: string;
		weight: number;
		answer: ComputedAnswer | null;
		groups: readonly HiddenTestGroup[];
	} | null;
	timeNormSec: number;
}

/** The thresholds of the admission of a family (domain 23.7): only a family that meets all of them is released. */
export interface FamilyGates {
	referenceSeedsMin: number;
	hiddenTestsMutationScoreMin: number;
	answerCollisionMax: number;
	transferMax: number;
	bruteForceInputsMin: number;
	wrongSolutionsMin: Readonly<Partial<Record<ItemFormat, number>>>;
	angoffRatersMin: number;
	/** A gap between two ratings above this needs the second round. */
	angoffGapMax: number;
	practiceGroupsMin: number;
	qaBudget: { min: number; max: number };
	qaMutantsMin: number;
	/** Anchor family-levels per grade in a release. */
	anchorsPerGrade: number;
}

export const FAMILY_GATES: FamilyGates = {
	referenceSeedsMin: 200,
	hiddenTestsMutationScoreMin: 0.9,
	answerCollisionMax: 0.05,
	transferMax: 0.02,
	bruteForceInputsMin: 10_000,
	wrongSolutionsMin: {
		bug_locate: 2,
		practice_code: 3,
		qa_mutation: 3,
		code_trace: 1,
		sql_trace: 1,
		compute: 1,
		config_eval: 1
	},
	angoffRatersMin: 2,
	angoffGapMax: 0.2,
	practiceGroupsMin: 3,
	qaBudget: { min: 5, max: 8 },
	qaMutantsMin: 6,
	anchorsPerGrade: 2
};

/** A released version of the bank of one specialization. */
export interface BankRelease {
	/** `<specialization>@<catalog version>-<n>`. */
	id: string;
	specialization: SpecializationKey;
	catalogVersion: string;
	procedureVersion: string;
	families: readonly FamilyDescriptor[];
}

export interface Slot {
	/** 1-based position on the longest trajectory. */
	position: number;
	block: string;
	practice: boolean;
}

/**
 * The slots of a grade's test in order: the trajectory of length n uses the first n. The practice slot sits at its
 * position; the other blocks are interleaved by smooth weighted round robin over their items (ties — the order of the
 * definition), so every prefix keeps the blocks near their proportions.
 */
export function slotSequence(definition: GradeDefinition): Slot[] {
	const others = definition.blocks.filter((b) => b.block !== definition.practice.block);
	const total = others.reduce((sum, b) => sum + b.items, 0);
	const current = others.map(() => 0);
	const remaining = others.map((b) => b.items);
	const order: string[] = [];
	for (let step = 0; step < total; step += 1) {
		let best = -1;
		for (let i = 0; i < others.length; i += 1) {
			if ((remaining[i] ?? 0) === 0) continue;
			current[i] = (current[i] ?? 0) + (others[i]?.items ?? 0);
			if (best === -1 || (current[i] ?? 0) > (current[best] ?? 0)) best = i;
		}
		const chosen = others[best];
		if (!chosen) throw new Error('slot sequence: no block left');
		current[best] = (current[best] ?? 0) - total;
		remaining[best] = (remaining[best] ?? 0) - 1;
		order.push(chosen.block);
	}
	order.splice(definition.practice.position - 1, 0, definition.practice.block);
	return order.map((block, i) => ({ position: i + 1, block, practice: block === definition.practice.block }));
}

export interface CapacityShortage {
	position: number;
	block: string;
}

export interface CapacityCheck {
	grade: GradeKey;
	/** The attempts of one candidate in order: the form of each and its length. */
	scenario: readonly { form: 'A' | 'B'; length: number }[];
	ok: boolean;
	/** Slots of the last attempt of the scenario no unseen family-level could fill. */
	shortages: CapacityShortage[];
}

const isPracticeFormat = (format: ItemFormat): boolean => format === 'practice_code' || format === 'qa_mutation';

interface Unit {
	family: string;
	block: string;
	practice: boolean;
	classes: readonly EssentialClass[];
}

/**
 * Serves one attempt in the given form: for every slot, the first family-level (in the stable order of the release)
 * of the slot's block and kind not used in this attempt with a class not seen by the candidate — the anchor class
 * first, then a class of the form. The engine chooses at random among the eligible; capacity holds for any choice,
 * because a family-level of a release has a class of each form and each attempt uses a family once.
 */
function serve(units: readonly Unit[], slots: readonly Slot[], form: 'A' | 'B', seen: Set<string>): CapacityShortage[] {
	const used = new Set<string>();
	const shortages: CapacityShortage[] = [];
	for (const slot of slots) {
		let served = false;
		for (const unit of units) {
			if (unit.block !== slot.block || unit.practice !== slot.practice || used.has(unit.family)) continue;
			const cls =
				unit.classes.find((c) => c.form === 'anchor' && !seen.has(`${unit.family}#${c.id}`)) ??
				unit.classes.find((c) => c.form === form && !seen.has(`${unit.family}#${c.id}`));
			if (!cls) continue;
			used.add(unit.family);
			seen.add(`${unit.family}#${cls.id}`);
			served = true;
			break;
		}
		if (!served) shortages.push({ position: slot.position, block: slot.block });
	}
	return shortages;
}

/**
 * Generates every extreme trajectory the policy allows within one window of forms — a first attempt of either form
 * stopping at the minimum, at the end of the main part or after the extension, and the retake on the other form after
 * a longest first attempt — and checks that each can be served from the release without exhausting a block and without
 * a family-level class the candidate has seen. Family-levels are units: a family serves a grade only by its level.
 */
export function capacityChecks(release: BankRelease, params: ProcedureParams): CapacityCheck[] {
	const checks: CapacityCheck[] = [];
	for (const definition of CATALOG.definitions.filter((d) => d.specialization === release.specialization)) {
		const grade = definition.grade;
		const slots = slotSequence(gradeDefinition(release.specialization, grade));
		const units: Unit[] = release.families.flatMap((family) =>
			family.levels
				.filter((level) => level.grade === grade)
				.map((level) => ({
					family: family.key,
					block: family.block,
					practice: isPracticeFormat(family.format),
					classes: level.classes
				}))
		);
		const { nMin, nMax } = params.grades[grade];
		const longest = maxLength(params, grade);
		const scenarios: { form: 'A' | 'B'; length: number }[][] = [];
		for (const first of ['A', 'B'] as const) {
			for (const length of [nMin, nMax, longest]) scenarios.push([{ form: first, length }]);
			scenarios.push([
				{ form: first, length: longest },
				{ form: first === 'A' ? 'B' : 'A', length: longest }
			]);
		}
		for (const scenario of scenarios) {
			const seen = new Set<string>();
			let shortages: CapacityShortage[] = [];
			for (const attempt of scenario) shortages = serve(units, slots.slice(0, attempt.length), attempt.form, seen);
			checks.push({ grade, scenario, ok: shortages.length === 0, shortages });
		}
	}
	return checks;
}
