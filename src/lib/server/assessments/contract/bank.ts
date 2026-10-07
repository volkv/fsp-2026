// The bank of item families (docs/domain.md, sections 10.1–10.5): what a family declares, what its generator module
// exports, how the slots of a test are laid out by the plan of a grade, which form an attempt takes and whether a
// released version of the bank can serve every extreme history of a candidate the policy allows — two grade attempts,
// the block tests of employers' requests and a recheck — without running out or showing a family-level class twice.
//
// The bank tree: `assessments/families/<specialization>/<family key>/` with `descriptor.json` (a `FamilyDescriptor`)
// and `generator.ts` (a `FamilyModule`); shared code lives in directories whose name starts with `_` and is hashed into
// the release separately (`BankRelease.sharedSha256`). Types and pure functions; plain erasable TypeScript without `$lib`.
import { createHash } from 'node:crypto';
import {
	CATALOG,
	type GradeDefinition,
	type GradeKey,
	type ItemFormat,
	type PracticeLanguageKey,
	type SpecializationKey
} from './catalog.ts';
import { PROCEDURE, maxLength, type ProcedureParams } from './procedure.ts';

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

/**
 * A form of the test: a grade attempt is served in `A` or `B`; an `anchor` class is common to both forms; a reserve class
 * `X` is never in a grade attempt — block tests and rechecks use it first.
 */
export type FormTag = 'A' | 'B' | 'anchor' | 'X';

export interface EssentialClass {
	/** Unique within the family-level. */
	id: string;
	form: FormTag;
	/** Which essential parameters take which values and how the path of the solution differs from other classes. */
	description: string;
}

/**
 * Who reviewed a family or rated a level: an independent model (never the family's author), named by the model and its
 * lineage — the provider's family of models — or a person of the team. Two reviews are independent only from different
 * lineages (or a person).
 */
export type Reviewer = { kind: 'model'; model: string; lineage: string } | { kind: 'person'; name: string };

/** A review of a family: on the sources whose hash it names; any edit of the family changes the hash and resets it. */
export interface FamilyReview {
	reviewer: Reviewer;
	/** ISO date. */
	reviewedAt: string;
	verdict: 'approved' | 'changes_requested';
	/** What the reviewer found; empty for a clean approval. */
	remarks: readonly string[];
	/** `familySourceSha256` of the family the review was made on. */
	sourceSha256: string;
}

export interface AngoffRating {
	/** A blind independent rater: a model of its own lineage (a provisional rating) or a person of the team. */
	rater: Reviewer;
	/** Probability that the borderline candidate of the grade scores the cluster, in steps of 0.05. */
	p: number;
	/** ISO date. */
	ratedAt: string;
	/** `familySourceSha256` of the family rated; an edit of the family resets the rating. */
	sourceSha256: string;
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
	/**
	 * Reviews of the rubric and the reference. A release needs, on the current sources and with no request for changes,
	 * two approvals by models of different lineages or one by a person (domain 10.2).
	 */
	rubricReviews: readonly FamilyReview[];
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
		languages: readonly PracticeLanguageKey[];
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
	/**
	 * The line of a defect. `alternatives` — other lines where a one-instruction replacement also restores the contract
	 * (each found and proven by the factory); any of them is a right answer.
	 */
	| { kind: 'line_no'; value: number; alternatives?: readonly number[] };

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
		languages: readonly PracticeLanguageKey[];
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
		/** QA: the changed specification and mutants; the harness runs them with `part = 'change_step'`. */
		qa: { specification: string; mutants: readonly { id: string; operator: string; equivalent: boolean }[] } | null;
	} | null;
	timeNormSec: number;
}

/** What `generate` of a family takes. */
export interface GenerateInput {
	seed: string;
	grade: GradeKey;
	classId: string;
}

/**
 * A QA harness run: `reference` — the candidate's cases (JSON `[{"input": …, "expected": …}]` on standard input) against
 * the correct program, one line with a character per case (`1` passes, `0` fails); `mutants` — against every mutant in
 * the order of `qa.mutants` (of the task or of the change step), one line with a character per mutant (`1` killed).
 */
export type HarnessMode = 'reference' | 'mutants';

export interface HarnessProgram {
	language: 'python3';
	/** The program with the reference and the mutants inside; never shown to the candidate. */
	source: string;
}

/** What `generator.ts` of a family exports: `generate` always, `harness` for a `qa_mutation` family. */
export interface FamilyModule {
	generate: (input: GenerateInput) => ItemInstance;
	harness?: (instance: ItemInstance, mode: HarnessMode, part?: 'task' | 'change_step') => HarnessProgram;
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
	/** Approved reviews on the current sources a release needs: models of distinct lineages, or persons. */
	reviewsNeeded: { models: number; persons: number };
	/** A gap between two ratings above this needs the second round. */
	angoffGapMax: number;
	practiceGroupsMin: number;
	/** The Angoff estimate of a practice family-level: the borderline candidate passes the gate (domain 10.6). */
	practiceAngoff: { min: number; max: number };
	/** Distinct family-levels of a block × grade a block test may draw from. */
	blockTestFamiliesMin: number;
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
	reviewsNeeded: { models: 2, persons: 1 },
	angoffGapMax: 0.2,
	practiceGroupsMin: 5,
	practiceAngoff: { min: 0.75, max: 0.9 },
	blockTestFamiliesMin: 4,
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
	/** SHA-256 of the shared code (`_*` directories) the generators import: a change of it is a new release. */
	sharedSha256: string;
	/** `familySourceSha256` of every family by key: reviews and ratings count only on these sources. */
	familySources: Readonly<Record<string, string>>;
}

export interface Slot {
	/** 1-based position on the longest trajectory. */
	position: number;
	block: string;
	practice: boolean;
}

/**
 * The slots of a grade's test in order: a trajectory uses a prefix. The two defining blocks come first, alternating,
 * `definingMinItems` items each, so every decision sees them in full; the practice sits at its position; the rest of the
 * quotas are interleaved by smooth weighted round robin (ties — the order of the definition).
 */
export function slotSequence(definition: GradeDefinition, params: ProcedureParams = PROCEDURE): Slot[] {
	const remaining = new Map(
		definition.blocks.filter((b) => b.block !== definition.practice.block).map((b) => [b.block, b.items])
	);
	const order: string[] = [];
	for (let round = 0; round < params.definingMinItems; round += 1) {
		for (const block of definition.defining) {
			const left = remaining.get(block) ?? 0;
			if (left === 0)
				throw new Error(`slot sequence: defining block ${block} has fewer than ${params.definingMinItems} items`);
			remaining.set(block, left - 1);
			order.push(block);
		}
	}
	const blocks = [...remaining.entries()].filter(([, items]) => items > 0);
	const total = blocks.reduce((sum, [, items]) => sum + items, 0);
	const current = blocks.map(() => 0);
	const left = blocks.map(([, items]) => items);
	for (let step = 0; step < total; step += 1) {
		let best = -1;
		for (let i = 0; i < blocks.length; i += 1) {
			if ((left[i] ?? 0) === 0) continue;
			current[i] = (current[i] ?? 0) + (blocks[i]?.[1] ?? 0);
			if (best === -1 || (current[i] ?? 0) > (current[best] ?? 0)) best = i;
		}
		const chosen = blocks[best];
		if (!chosen) throw new Error('slot sequence: no block left');
		current[best] = (current[best] ?? 0) - total;
		left[best] = (left[best] ?? 0) - 1;
		order.push(chosen[0]);
	}
	order.splice(definition.practice.position - 1, 0, definition.practice.block);
	return order.map((block, i) => ({ position: i + 1, block, practice: block === definition.practice.block }));
}

/** Tests besides the grade attempt that also draw instances from the bank (domain 13.11, 10.7). */
export interface AdditionalTests {
	/** A block test of an employer's request: this many clusters of one block, each of a different family. */
	blockTest: { clusters: number; minQuota: number; perBlockGradeInWindow: number };
	/** A recheck on a call: one fresh cluster of a defining block, of a family the candidate solved, in another class. */
	recheck: { clusters: number; perWindow: number };
}

export const ADDITIONAL_TESTS: AdditionalTests = {
	blockTest: { clusters: 4, minQuota: 3, perBlockGradeInWindow: 1 },
	recheck: { clusters: 1, perWindow: 2 }
};

/**
 * The block × grade pairs a block test may be requested for: a non-practice block with at least `minQuota` items in the
 * grade's plan. Other pairs have no bank behind them; a vacancy skill that maps only to them is shown as «тестом не
 * проверяется».
 */
export function blockTestPairs(specialization: SpecializationKey): { block: string; grade: GradeKey }[] {
	return CATALOG.definitions
		.filter((d) => d.specialization === specialization)
		.flatMap((d) =>
			d.blocks
				.filter((q) => q.block !== d.practice.block && q.items >= ADDITIONAL_TESTS.blockTest.minQuota)
				.map((q) => ({ block: q.block, grade: d.grade }))
		);
}

/**
 * The form of the next grade attempt: the one with fewer of the candidate's seen classes at this grade within the window
 * of forms; a tie — by the attempt's seed. A first attempt is therefore A or B by the seed, a retake the other one.
 */
export function chooseForm(seen: { A: number; B: number }, seedBit: 0 | 1): 'A' | 'B' {
	if (seen.A !== seen.B) return seen.A < seen.B ? 'A' : 'B';
	return seedBit === 0 ? 'A' : 'B';
}

export interface CapacityShortage {
	step: string;
	position: number;
	block: string;
}

export interface CapacityCheck {
	grade: GradeKey;
	/** The tests of one candidate in order. */
	scenario: readonly string[];
	ok: boolean;
	shortages: CapacityShortage[];
}

const isPracticeFormat = (format: ItemFormat): boolean => format === 'practice_code' || format === 'qa_mutation';

interface Unit {
	family: string;
	block: string;
	practice: boolean;
	classes: readonly EssentialClass[];
}

type Want = 'grade' | 'reserve';

/**
 * Serves `slots` for one test: for every slot, the first family-level (in the stable order of the release) of the slot's
 * block and kind not used in this test with a class the candidate has not seen. A grade attempt takes the anchor class
 * first, then a class of its form; a block test or a recheck takes only reserve classes (`X`). The classes of the two
 * kinds never overlap and every family-level has a class of each form, so the result does not depend on which eligible
 * family-level the engine picks at random: the check holds for any choice.
 */
function serve(
	units: readonly Unit[],
	slots: readonly { block: string; practice: boolean; position: number }[],
	want: Want,
	form: 'A' | 'B',
	seen: Set<string>,
	step: string,
	preferSeenFamilies = false
): CapacityShortage[] {
	const used = new Set<string>();
	const shortages: CapacityShortage[] = [];
	const solved = new Set([...seen].map((key) => key.split('#')[0]));
	for (const slot of slots) {
		const candidates = units.filter(
			(u) => u.block === slot.block && u.practice === slot.practice && !used.has(u.family)
		);
		const ordered = preferSeenFamilies
			? [...candidates.filter((u) => solved.has(u.family)), ...candidates.filter((u) => !solved.has(u.family))]
			: candidates;
		let served = false;
		for (const unit of ordered) {
			const unseen = unit.classes.filter((c) => !seen.has(`${unit.family}#${c.id}`));
			const cls =
				want === 'grade'
					? (unseen.find((c) => c.form === 'anchor') ?? unseen.find((c) => c.form === form))
					: unseen.find((c) => c.form === 'X');
			if (!cls) continue;
			used.add(unit.family);
			seen.add(`${unit.family}#${cls.id}`);
			served = true;
			break;
		}
		if (!served) shortages.push({ step, position: slot.position, block: slot.block });
	}
	return shortages;
}

/**
 * Generates every extreme history the policy allows within one window of forms and checks that the release serves it:
 * a first attempt of either form stopping at the minimum, at the end of the main part or after the extension; then the
 * longest first attempt, the retake on the form `chooseForm` gives, a block test of every allowed block of the grade and
 * the rechecks of the window. Family-levels are units: a family serves a grade only by its level.
 */
export function capacityChecks(release: BankRelease, params: ProcedureParams): CapacityCheck[] {
	const checks: CapacityCheck[] = [];
	for (const definition of CATALOG.definitions.filter((d) => d.specialization === release.specialization)) {
		const grade = definition.grade;
		const slots = slotSequence(definition, params);
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
		const slotsUpToItems = (items: number): Slot[] => {
			let count = 0;
			const prefix: Slot[] = [];
			for (const slot of slots) {
				prefix.push(slot);
				if (!slot.practice) count += 1;
				if (count === items) break;
			}
			return prefix;
		};
		const { nMin, nMax } = params.grades[grade];
		const longest = maxLength(params, grade);
		for (const first of ['A', 'B'] as const) {
			for (const items of [nMin, nMax]) {
				const seen = new Set<string>();
				const shortages = serve(units, slotsUpToItems(items), 'grade', first, seen, `${first}${items}`);
				checks.push({ grade, scenario: [`${first}${items}`], ok: shortages.length === 0, shortages });
			}
			const seen = new Set<string>();
			const scenario: string[] = [];
			const shortages: CapacityShortage[] = [];
			const attempt = (form: 'A' | 'B') => {
				scenario.push(`${form}${longest}`);
				shortages.push(...serve(units, slots, 'grade', form, seen, `${form}${longest}`));
			};
			attempt(first);
			const count = (form: 'A' | 'B') =>
				units.reduce(
					(sum, u) => sum + u.classes.filter((c) => c.form === form && seen.has(`${u.family}#${c.id}`)).length,
					0
				);
			attempt(chooseForm({ A: count('A'), B: count('B') }, first === 'A' ? 1 : 0));
			const blockTests = blockTestPairs(release.specialization).filter((p) => p.grade === grade);
			for (const { block } of blockTests) {
				const step = `block:${block}`;
				scenario.push(step);
				const clusters = Array.from({ length: ADDITIONAL_TESTS.blockTest.clusters }, (_, i) => ({
					block,
					practice: false,
					position: i + 1
				}));
				shortages.push(...serve(units, clusters, 'reserve', first, seen, step));
			}
			for (let i = 0; i < ADDITIONAL_TESTS.recheck.perWindow; i += 1) {
				const block = definition.defining[i % definition.defining.length] ?? '';
				const step = `recheck:${block}`;
				scenario.push(step);
				shortages.push(...serve(units, [{ block, practice: false, position: 1 }], 'reserve', first, seen, step, true));
			}
			checks.push({ grade, scenario, ok: shortages.length === 0, shortages });
		}
	}
	return checks;
}

/** The identity of a reviewer: a model is one per lineage (two models of one provider are not independent). */
export function reviewerIdentity(reviewer: Reviewer): string {
	return reviewer.kind === 'model' ? `model:${reviewer.lineage}` : `person:${reviewer.name}`;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

/**
 * The hash of what a review and a rating judge: the descriptor without its gate report and Angoff ratings (they are the
 * judgements, not the sources), and the text of `generator.ts`. Any edit of the family's content or code changes it and
 * resets every review and rating made before.
 */
export function familySourceSha256(family: FamilyDescriptor, generatorSource: string): string {
	const sources = {
		...family,
		gates: undefined,
		levels: family.levels.map((level) => ({ ...level, angoff: undefined }))
	};
	return createHash('sha256').update(canonical(sources)).update('\n').update(generatorSource).digest('hex');
}

/**
 * An entry of `authorship.authors`: a model written as `<model> (<vendor>)`, otherwise a person or a group by name.
 */
export type FamilyAuthor = { kind: 'model'; model: string; vendor: string } | { kind: 'person'; name: string };

export function parseAuthor(entry: string): FamilyAuthor {
	const match = /^(.+?)\s*\(([^()]+)\)$/.exec(entry.trim());
	return match?.[1] && match[2]
		? { kind: 'model', model: match[1].trim(), vendor: match[2].trim() }
		: { kind: 'person', name: entry.trim() };
}

/** Whether a judge is the author itself: the same person, or the same model (another model of the vendor is not). */
export function isAuthor(judge: Reviewer, family: FamilyDescriptor): boolean {
	return family.authorship.authors
		.map(parseAuthor)
		.some((author) =>
			judge.kind === 'person'
				? author.kind === 'person' && author.name.toLowerCase() === judge.name.toLowerCase()
				: author.kind === 'model' && author.model.toLowerCase() === judge.model.toLowerCase()
		);
}

/** How a family-level was judged, for the labels of the product (domain 10.8). */
export interface JudgementProvenance {
	/** The rubric and the reference were approved by models only. */
	rubricByModelsOnly: boolean;
	/** The Angoff cut rests on model ratings only: a provisional cut. */
	angoffProvisional: boolean;
	/** One of the approving or rating models is another model of the vendor of the model that wrote the family. */
	sameVendorReviewer: boolean;
}

export function judgementProvenance(family: FamilyDescriptor, grade: GradeKey): JudgementProvenance {
	const approved = family.gates.rubricReviews.filter((r) => r.verdict === 'approved');
	const level = family.levels.find((l) => l.grade === grade);
	const vendors = new Set(
		family.authorship.authors.map(parseAuthor).flatMap((a) => (a.kind === 'model' ? [a.vendor.toLowerCase()] : []))
	);
	const judges = [...approved.map((r) => r.reviewer), ...(level?.angoff.ratings.map((r) => r.rater) ?? [])];
	return {
		rubricByModelsOnly: !approved.some((r) => r.reviewer.kind === 'person'),
		angoffProvisional: !level || level.angoff.ratings.every((r) => r.rater.kind === 'model'),
		sameVendorReviewer: judges.some((j) => j.kind === 'model' && vendors.has(j.lineage.toLowerCase()))
	};
}
