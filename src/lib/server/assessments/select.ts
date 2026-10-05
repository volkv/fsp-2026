// Which family-level, class and seed serve a slot of an attempt (docs/domain.md, 10.4). The slots of a grade come from
// the plan (`slotSequence` of the contract: the defining blocks first); a slot takes a family-level of the release with
// the grade of the attempt, the block of the slot and its kind (practice or not), whose family the attempt has not used
// and which has a class the candidate has not seen within the window of forms — a grade attempt the anchor class first,
// then a class of its form; a block test or a recheck only a reserve class `X`. Among those,
// the five with the Angoff estimate nearest to 0.6, one of them by the seed of the attempt and the slot. The seed of the
// instance is SHA-256 of the attempt's seed and the slot. Pure functions: the engine, the simulation and the seed of
// the demo share them.
import { chooseForm, slotSequence, type FamilyDescriptor, type FamilyLevel, type Slot } from './contract/bank.ts';
import {
	PRACTICE_FORMATS,
	gradeDefinition,
	type GradeKey,
	type ItemFormat,
	type SpecializationKey
} from './contract/catalog.ts';
import { PROCEDURE, type ProcedureParams } from './contract/procedure.ts';
import { sha256Hex } from './families.ts';

export type AttemptForm = 'A' | 'B';

/** The Angoff estimate the procedure is most informative around. */
export const INFORMATIVE_ANGOFF = 0.6;
/** How many of the nearest family-levels the seed chooses among. */
export const CHOICE_POOL = 5;

export const isPracticeFormat = (format: ItemFormat): boolean =>
	(PRACTICE_FORMATS as readonly ItemFormat[]).includes(format);

/** The slots of a grade's test in order; a trajectory of length n uses the first n. */
export function slotsOf(
	specialization: SpecializationKey,
	grade: GradeKey,
	params: ProcedureParams = PROCEDURE
): Slot[] {
	return slotSequence(gradeDefinition(specialization, grade), params);
}

/** The key under which a served class counts as seen: `(family, grade, class)`. */
export const seenKey = (family: string, grade: GradeKey, classId: string): string => `${family}#${grade}#${classId}`;

/** The seed of the instance of slot `seq`: SHA-256 of the attempt's seed and the slot number. */
export const instanceSeed = (attemptSeed: string, seq: number): string => sha256Hex(`${attemptSeed}:${seq}`);

/** A deterministic integer in [0, n) from a seed and a label. */
export function seededIndex(seed: string, label: string, n: number): number {
	if (n <= 0) throw new Error('seededIndex: empty range');
	return Number(BigInt(`0x${sha256Hex(`${seed}:${label}`).slice(0, 12)}`) % BigInt(n));
}

/**
 * The form of a grade attempt (`chooseForm` of the contract): the form of fewer classes the candidate has seen at the
 * grade within the window, a tie by the attempt's seed. `seen` are `seenKey`s; their form is read from the release.
 */
export function attemptForm(
	families: readonly FamilyDescriptor[],
	grade: GradeKey,
	seen: ReadonlySet<string>,
	attemptSeed: string
): AttemptForm {
	const count = { A: 0, B: 0 };
	for (const family of families) {
		const level = family.levels.find((l) => l.grade === grade);
		for (const cls of level?.classes ?? []) {
			if ((cls.form === 'A' || cls.form === 'B') && seen.has(seenKey(family.key, grade, cls.id))) count[cls.form] += 1;
		}
	}
	return chooseForm(count, seededIndex(attemptSeed, 'form', 2) === 0 ? 0 : 1);
}

/** What classes a test takes: a grade attempt its form (anchor first), a block test or a recheck the reserve `X`. */
export type ClassWant = { kind: 'grade'; form: AttemptForm } | { kind: 'reserve' };

export interface SlotChoice {
	family: FamilyDescriptor;
	level: FamilyLevel;
	classId: string;
	seed: string;
}

export interface ChoiceInput {
	families: readonly FamilyDescriptor[];
	grade: GradeKey;
	slot: Pick<Slot, 'block' | 'practice'>;
	want: ClassWant;
	/** Keys of the families this attempt already used. */
	usedFamilies: ReadonlySet<string>;
	/** `seenKey`s of every class served to the candidate within the window of forms. */
	seen: ReadonlySet<string>;
	attemptSeed: string;
	seq: number;
}

/** The family-level, class and instance seed of a slot; `null` — nothing eligible: the bank is exhausted for it. */
export function chooseForSlot(input: ChoiceInput): SlotChoice | null {
	const { grade, slot, want, usedFamilies, seen } = input;
	const eligible: { family: FamilyDescriptor; level: FamilyLevel; classId: string }[] = [];
	for (const family of input.families) {
		if (family.block !== slot.block || isPracticeFormat(family.format) !== slot.practice) continue;
		if (usedFamilies.has(family.key)) continue;
		const level = family.levels.find((l) => l.grade === grade);
		if (!level) continue;
		const unseen = (form: 'A' | 'B' | 'anchor' | 'X') =>
			level.classes
				.filter((c) => c.form === form && !seen.has(seenKey(family.key, grade, c.id)))
				.sort((a, b) => (a.id < b.id ? -1 : 1))[0];
		const cls = want.kind === 'grade' ? (unseen('anchor') ?? unseen(want.form)) : unseen('X');
		if (cls) eligible.push({ family, level, classId: cls.id });
	}
	if (eligible.length === 0) return null;
	eligible.sort(
		(a, b) =>
			Math.abs(a.level.angoff.mean - INFORMATIVE_ANGOFF) - Math.abs(b.level.angoff.mean - INFORMATIVE_ANGOFF) ||
			(a.family.key < b.family.key ? -1 : 1)
	);
	const pool = eligible.slice(0, CHOICE_POOL);
	const chosen = pool[seededIndex(input.attemptSeed, `slot:${input.seq}`, pool.length)];
	if (!chosen) throw new Error('chooseForSlot: index outside the pool');
	return { ...chosen, seed: instanceSeed(input.attemptSeed, input.seq) };
}

/** Upper bound of a slot's time norm: the slowest family-level that could serve it. */
function slotTimeNorm(families: readonly FamilyDescriptor[], grade: GradeKey, slot: Slot): number {
	let norm = 0;
	for (const family of families) {
		if (family.block !== slot.block || isPracticeFormat(family.format) !== slot.practice) continue;
		const level = family.levels.find((l) => l.grade === grade);
		if (level) norm = Math.max(norm, level.timeNormSec);
	}
	return norm;
}

/** The deadline of an attempt: the time norms of the longest trajectory times 1.5 (domain 10.7). */
export function attemptDurationMs(
	families: readonly FamilyDescriptor[],
	specialization: SpecializationKey,
	grade: GradeKey
): number {
	const total = slotsOf(specialization, grade).reduce((sum, slot) => sum + slotTimeNorm(families, grade, slot), 0);
	return Math.round(total * 1.5 * 1000);
}
