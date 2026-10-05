// The shared code of the generators (`<specialization>/<key>/generator.ts`). A generator reads its `descriptor.json`,
// builds an instance and, for the gate script only, the material that proves the instance's answer. Plain erasable
// TypeScript: the gate script, the release script and the server run it with Node itself.
import { readFileSync } from 'node:fs';
import type {
	ComputedAnswer,
	EssentialClass,
	FamilyDescriptor,
	FamilyLevel,
	GenerateInput,
	HarnessMode,
	HiddenTestGroup,
	ItemInstance
} from '../../../src/lib/server/assessments/contract/bank.ts';
import { Rng } from './rng.ts';

export type { ComputedAnswer, FamilyDescriptor, GenerateInput, HarnessMode, HiddenTestGroup, ItemInstance };

/**
 * The descriptor next to a generator (`descriptor.json`), read once when the module loads. Its shape and its rules are
 * checked by the validator of the contract when the bank is gated and released.
 */
export function readDescriptor(generatorUrl: string): FamilyDescriptor {
	return JSON.parse(readFileSync(new URL('./descriptor.json', generatorUrl), 'utf8')) as FamilyDescriptor;
}

/**
 * How the gate script proves the expected answer of an instance. Every program is Python 3 and runs in the runtime
 * of the sandbox image.
 * - `output` — the program's standard output, read as an answer of the family's kind, equals the instance's answer;
 * - `bug` — the shown program with `check` appended fails, and with the defect line replaced by `fix` passes; `check`
 *   prints `ok` when every check holds;
 * - `practice` — the reference passes every hidden test of the instance, and `changeSource` (the reference after the
 *   new condition) passes every test of the step;
 * - `qa` — the harness of the instance passes the author's cases on the reference and kills every mutant that is not
 *   equivalent with them (the task is solvable within the budget), and `differential` (a program comparing every
 *   mutant with the reference over the whole input domain) prints the equivalence of each mutant as the instance
 *   declares it; `changeStep` — the same proof for the step «измени своё решение» of an instance that has one.
 */
export type ReferenceProbe =
	| { kind: 'output'; source: string; stdin: string }
	| { kind: 'bug'; check: string; fix: string }
	| { kind: 'practice'; source: string; changeSource: string | null }
	| ({ kind: 'qa'; changeStep?: QaProof } & QaProof);

/** The proof of one part of a QA cluster: its two harness programs, the author's cases and the differential run. */
export interface QaProof {
	harness: Readonly<Record<HarnessMode, string>>;
	cases: readonly QaCase[];
	differential: string;
}

/** The part of a QA cluster a harness runs: the task, or the change step with its own specification and mutants. */
export type HarnessPart = 'task' | 'change_step';

/** A test case of a QA candidate: one line of input for the program under test and the expected output. */
export interface QaCase {
	input: string;
	expected: string;
}

/**
 * How a wrong solution fails on an instance:
 * - `answer` — the answer the misconception gives; it must differ from the expected one;
 * - `line` — a plausible but wrong defect line with the change the misconception makes there; the program stays
 *   wrong with that change (the check does not print `ok`);
 * - `program` — a wrong program; it must fail at least one group of hidden tests;
 * - `cases` — a weak set of QA test cases; it must score below the top of the rubric (outside the budget, failing on
 *   the reference or leaving a mutant alive).
 */
export type WrongProbe =
	| { kind: 'answer'; answer: ComputedAnswer }
	| { kind: 'line'; line: number; replacement: string }
	| { kind: 'program'; source: string }
	| { kind: 'cases'; cases: readonly QaCase[] };

/**
 * One built instance with the gate material of the factory. The gate material is computed lazily: the test engine
 * needs only the instance.
 * - `wrong` gives a probe for every wrong solution of the descriptor, by its id; `null` — the misconception does not
 *   apply to the class of this instance (it gives the right answer there by its nature). A wrong solution counts as
 *   caught when it is rejected on every instance it applies to; every wrong solution applies somewhere, and on every
 *   level some wrong solution applies.
 */
export interface Built {
	instance: ItemInstance;
	reference: () => ReferenceProbe;
	wrong: () => Readonly<Record<string, WrongProbe | null>>;
}

/** What the gate script needs of a generator module beyond the contract's `generate` (and `harness` for QA). */
export interface FactoryModule {
	build(input: GenerateInput): Built;
}

/** The level of the grade and the class of a generator input; an input outside the descriptor is an error. */
export function levelAndClass(
	descriptor: FamilyDescriptor,
	input: GenerateInput
): { level: FamilyLevel; cls: EssentialClass } {
	const level = descriptor.levels.find((l) => l.grade === input.grade);
	if (!level) throw new Error(`${descriptor.key} has no level ${input.grade}`);
	const cls = level.classes.find((c) => c.id === input.classId);
	if (!cls) throw new Error(`${descriptor.key}@${input.grade} has no class ${input.classId}`);
	return { level, cls };
}

/** The random stream of one instance: family, version, grade, class and seed all feed it. */
export function instanceRng(descriptor: FamilyDescriptor, input: GenerateInput): Rng {
	return new Rng(`${descriptor.key}@${descriptor.version}|${input.grade}|${input.classId}|${input.seed}`);
}

type InstanceBody = Pick<ItemInstance, 'statement' | 'answer'> &
	Partial<Pick<ItemInstance, 'practice' | 'qa' | 'changeStep'>>;

/** An instance with the fields every family fills the same way. */
export function makeInstance(descriptor: FamilyDescriptor, input: GenerateInput, body: InstanceBody): ItemInstance {
	const { level } = levelAndClass(descriptor, input);
	return {
		family: descriptor.key,
		familyVersion: descriptor.version,
		grade: input.grade,
		classId: input.classId,
		seed: input.seed,
		format: descriptor.format,
		answerKind: descriptor.answerKind,
		statement: body.statement,
		answer: body.answer,
		practice: body.practice ?? null,
		qa: body.qa ?? null,
		changeStep: body.changeStep ?? null,
		timeNormSec: level.timeNormSec
	};
}
