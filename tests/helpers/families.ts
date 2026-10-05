// A fixture bank for the tests of the test engine — not the bank of the product: for one specialization, the fewest
// family-levels per block and grade the capacity check accepts (quotas, four for a block-test pair, more where the
// histories of the window run out), classes A, B and a reserve X, two anchors per grade, every admission gate met, and
// generators that return small valid instances. Computed answers are derived from the seed; a practice task has five
// groups of hidden tests (and two of its step from Middle up); a QA task has six mutants, one of them equivalent, and a
// working Python harness of a clamp function (its step: the bounds may come in reverse order).
import { createHash } from 'node:crypto';
import {
	blockTestPairs,
	capacityChecks,
	familySourceSha256,
	type BankRelease,
	type FamilyDescriptor,
	type FamilyModule,
	type HarnessMode,
	type ItemInstance,
	type Reviewer
} from '../../src/lib/server/assessments/contract/bank.ts';
import {
	CATALOG,
	gradeDefinition,
	type GradeKey,
	type SpecializationKey
} from '../../src/lib/server/assessments/contract/catalog.ts';
import { PROCEDURE } from '../../src/lib/server/assessments/contract/procedure.ts';
import type { LoadedFamily } from '../../src/lib/server/assessments/families.ts';

const hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The number a generator derives from its seed: the key of a computed answer and the data of a practice test. */
export const seedNumber = (seed: string): number => parseInt(hex(seed).slice(0, 6), 16) % 1000;

const GATES: FamilyDescriptor['gates'] = {
	reference: { seeds: 200, failures: 0 },
	wrongSolutions: { mustBeCaught: 3, caught: 3 },
	hiddenTestsMutationScore: null,
	answerCollision: 0.01,
	transfer: null,
	bruteForceInputs: null,
	rubricReviews: []
};

/** Two independent reviewers: models of different lineages, or a person of the team. */
const SIGNERS: Record<'models' | 'person', readonly Reviewer[]> = {
	models: [
		{ kind: 'model', model: 'reviewer-one', lineage: 'lineage-one' },
		{ kind: 'model', model: 'reviewer-two', lineage: 'lineage-two' }
	],
	person: [
		{ kind: 'person', name: 'Рецензент А' },
		{ kind: 'person', name: 'Рецензент Б' }
	]
};

const MUTANTS = ['high-boundary', 'swap-bounds', 'drop-low', 'drop-high', 'low-off-by-one', 'same-as-reference'];

export interface FixtureOptions {
	/** Angoff estimate of every computed family-level (on the 0.05 scale); 0.6 by default. */
	angoff?: number;
	/** Angoff estimate of the practice family-levels: a gate the borderline passes, 0.75–0.9; 0.8 by default. */
	practiceAngoff?: number;
	/** Who approved the rubrics and rated the levels: models of two lineages (by default) or persons. */
	signedBy?: 'models' | 'person';
}

const signers = (options: FixtureOptions): readonly Reviewer[] => SIGNERS[options.signedBy ?? 'models'];

/** The text a fixture family's generator stands for: its hash is the generator's, and part of the family's sources. */
const generatorText = (family: FamilyDescriptor): string => `fixture generator ${family.key}`;

/** The family approved and rated on its current sources. */
function signed(family: FamilyDescriptor, options: FixtureOptions): FamilyDescriptor {
	const sourceSha256 = familySourceSha256(family, generatorText(family));
	return {
		...family,
		levels: family.levels.map((level) => ({
			...level,
			angoff: { ...level.angoff, ratings: level.angoff.ratings.map((r) => ({ ...r, sourceSha256 })) }
		})),
		gates: {
			...family.gates,
			rubricReviews: signers(options).map((reviewer) => ({
				reviewer,
				reviewedAt: '2026-10-06',
				verdict: 'approved' as const,
				remarks: [],
				sourceSha256
			}))
		}
	};
}

function descriptor(
	block: string,
	name: string,
	grade: GradeKey,
	anchor: boolean,
	options: FixtureOptions
): FamilyDescriptor {
	const blockSpec = CATALOG.blocks.find((b) => b.code === block);
	if (!blockSpec) throw new Error(`unknown block ${block}`);
	const spec = blockSpec.specialization;
	const isQa = blockSpec.formats.includes('qa_mutation');
	const isPractice = blockSpec.practice;
	const angoff = isPractice ? (options.practiceAngoff ?? 0.8) : (options.angoff ?? 0.6);
	const changeStep = isPractice && gradeDefinition(spec, grade).practice.changeStep;
	const format = isPractice ? (isQa ? 'qa_mutation' : 'practice_code') : (blockSpec.formats[0] ?? 'compute');
	return {
		key: `${block}.${name}`,
		version: 1,
		specialization: spec,
		block,
		format,
		answerKind: isPractice ? (isQa ? 'test_cases' : 'code') : 'exact',
		levels: [
			{
				grade,
				angoff: {
					round: 1,
					ratings: [Math.round((angoff - 0.05) * 100) / 100, Math.round((angoff + 0.05) * 100) / 100].map((p, i) => ({
						rater: signers(options)[i] as Reviewer,
						p,
						ratedAt: '2026-10-06',
						// Set by `signed` once the sources are known: the hash leaves the ratings out.
						sourceSha256: ''
					})),
					mean: angoff
				},
				constructive: { depth: 2 },
				constructiveRank: 1,
				timeNormSec: isPractice ? 900 : 120,
				classes: [
					{ id: 'a', form: 'A', description: 'граница включена' },
					{ id: 'b', form: 'B', description: 'граница исключена' },
					{ id: 'x', form: 'X', description: 'резерв: граница на переполнении' },
					...(anchor ? [{ id: 'k', form: 'anchor' as const, description: 'опорный класс' }] : [])
				]
			}
		],
		surfaceParams: [{ name: 'names', description: 'имена и сюжет' }],
		essentialParams: [{ name: 'boundary', description: 'включительность границы' }],
		language: null,
		practice:
			isPractice && !isQa
				? {
						languages: [CATALOG.specializations.find((s) => s.key === spec)?.practiceLanguages[0] ?? 'python3'],
						hiddenTestGroups: 5
					}
				: null,
		qa: isQa ? { budget: { min: 5, max: 8 }, mutants: MUTANTS.map((id) => ({ id, operator: id })) } : null,
		changeStep: changeStep ? { description: 'новое ограничение на входные данные', weight: 0.3 } : null,
		rubric: isQa
			? {
					kind: 'mutants',
					levels: [
						{ minKillRatio: 0.5, score: 0.5 },
						{ minKillRatio: 0.8, score: 1 }
					]
				}
			: isPractice
				? { kind: 'groups' }
				: { kind: 'binary' },
		coverage: { checks: ['граничные значения'], doesNotCheck: ['скорость работы'] },
		wrongSolutions: ['a', 'b', 'c'].map((id) => ({ id, defect: `дефект ${id}`, mustBeCaught: true })),
		authorship: { draftedBy: 'team', authors: ['Автор А'] },
		gates: {
			...GATES,
			hiddenTestsMutationScore: isPractice && !isQa ? 0.95 : null,
			transfer: isPractice && !isQa ? 0 : null
		}
	};
}

/** Hidden tests of a practice instance: the program prints twice the number it reads. */
function doubling(prefix: string, base: number, groups: number) {
	return Array.from({ length: groups }, (_, g) => ({
		id: `${prefix}${g + 1}`,
		tests: [0, 1].map((t) => {
			const n = base + g * 10 + t;
			return { stdin: `${n}\n`, expected: `${2 * n}\n` };
		})
	}));
}

/** The QA harness of the fixture: `clamp(x, lo, hi)` and its mutants, the last one equivalent. */
export function clampHarness(
	instance: ItemInstance,
	mode: HarnessMode,
	part: 'task' | 'change_step' = 'task'
): { language: 'python3'; source: string } {
	if (!instance.qa) throw new Error('not a QA instance');
	// The step: the bounds may come in either order; the reference orders them, the mutants do not.
	const order = part === 'change_step' ? '    lo, hi = min(lo, hi), max(lo, hi)\n' : '';
	return {
		language: 'python3',
		source: `import json, sys

def reference(x, lo, hi):
${order}    return max(lo, min(x, hi))

MUTANTS = [
    lambda x, lo, hi: lo if x < lo else (hi if x >= hi - 1 else x),
    lambda x, lo, hi: max(hi, min(x, lo)),
    lambda x, lo, hi: min(x, hi),
    lambda x, lo, hi: max(lo, x),
    lambda x, lo, hi: max(lo + 1, min(x, hi)),
    lambda x, lo, hi: min(hi, max(x, lo)),
]

def run(fn, case):
    x, lo, hi = (int(v) for v in case["input"].split())
    try:
        return str(fn(x, lo, hi)) == case["expected"].strip()
    except Exception:
        return False

cases = json.loads(sys.stdin.read())
if ${JSON.stringify(mode)} == "reference":
    print("".join("1" if run(reference, c) else "0" for c in cases))
else:
    print("".join("1" if any(not run(m, c) for c in cases) else "0" for m in MUTANTS))
`
	};
}

function generator(family: FamilyDescriptor): FamilyModule {
	const generate: FamilyModule['generate'] = ({ seed, grade, classId }) => {
		const n = seedNumber(seed);
		const base = {
			family: family.key,
			familyVersion: family.version,
			grade,
			classId,
			seed,
			format: family.format,
			answerKind: family.answerKind,
			timeNormSec: family.levels[0]?.timeNormSec ?? 120,
			practice: null,
			qa: null,
			changeStep: null
		} satisfies Partial<ItemInstance>;
		if (family.format === 'practice_code') {
			return {
				...base,
				statement: { markdown: `Прочитайте число и выведите его удвоенным (класс ${classId}).`, code: null },
				answer: null,
				practice: {
					languages: family.practice?.languages ?? ['python3'],
					groups: doubling('g', n, 5),
					checker: { kind: 'tokens' }
				},
				changeStep: family.changeStep
					? {
							markdown: 'Теперь число может быть отрицательным: выведите удвоенное значение.',
							weight: family.changeStep.weight,
							answer: null,
							groups: doubling('s', -n - 50, 2),
							qa: null
						}
					: null
			};
		}
		if (family.format === 'qa_mutation') {
			return {
				...base,
				statement: { markdown: 'Функция `clamp(x, lo, hi)` прижимает x к отрезку [lo, hi].', code: null },
				answer: null,
				qa: {
					budget: { min: 5, max: 8 },
					specification: 'clamp(x, lo, hi) = lo, если x < lo; hi, если x > hi; иначе x. Вход: «x lo hi».',
					mutants: MUTANTS.map((id) => ({ id, operator: id, equivalent: id === 'same-as-reference' }))
				},
				changeStep: family.changeStep
					? {
							markdown: 'Теперь границы могут прийти в любом порядке: проверь это новыми кейсами.',
							weight: family.changeStep.weight,
							answer: null,
							groups: [],
							qa: {
								specification: 'clamp(x, a, b) прижимает x к отрезку между a и b, в каком бы порядке они ни пришли.',
								mutants: MUTANTS.map((id) => ({ id, operator: id, equivalent: false }))
							}
						}
					: null
			};
		}
		return {
			...base,
			statement: { markdown: `Сколько будет ${n} + ${grade.length}?`, code: null },
			answer: { kind: 'exact', value: String(n + grade.length) }
		};
	};
	return family.format === 'qa_mutation' ? { generate, harness: clampHarness } : { generate };
}

function release(specialization: SpecializationKey, families: readonly FamilyDescriptor[]): BankRelease {
	return {
		id: `${specialization}@${CATALOG.version}-0`,
		specialization,
		catalogVersion: CATALOG.version,
		procedureVersion: PROCEDURE.version,
		families,
		sharedSha256: hex(''),
		familySources: Object.fromEntries(families.map((f) => [f.key, familySourceSha256(f, generatorText(f))]))
	};
}

function build(
	specialization: SpecializationKey,
	counts: ReadonlyMap<string, number>,
	options: FixtureOptions
): FamilyDescriptor[] {
	const families: FamilyDescriptor[] = [];
	const anchors = new Map<string, number>();
	for (const [key, n] of counts) {
		const [grade, block] = key.split('|') as [GradeKey, string];
		const practice = gradeDefinition(specialization, grade).practice.block === block;
		for (let i = 0; i < n; i += 1) {
			const anchor = !practice && (anchors.get(grade) ?? 0) < 2;
			if (anchor) anchors.set(grade, (anchors.get(grade) ?? 0) + 1);
			families.push(signed(descriptor(block, `${grade}-${i}`, grade, anchor, options), options));
		}
	}
	return families;
}

/**
 * The fixture bank of a specialization: the fewest family-levels per block × grade that serve every extreme history of
 * the window (`capacityChecks`), two anchors per grade.
 */
export function fixtureFamilies(specialization: SpecializationKey, options: FixtureOptions = {}): LoadedFamily[] {
	const counts = new Map<string, number>();
	for (const d of CATALOG.definitions.filter((x) => x.specialization === specialization)) {
		for (const q of d.blocks) counts.set(`${d.grade}|${q.block}`, q.items);
	}
	for (const pair of blockTestPairs(specialization)) {
		const key = `${pair.grade}|${pair.block}`;
		counts.set(key, Math.max(counts.get(key) ?? 0, 4));
	}
	for (let round = 0; ; round += 1) {
		if (round > 20) throw new Error(`no fixture bank serves ${specialization}`);
		const short = capacityChecks(release(specialization, build(specialization, counts, options)), PROCEDURE).flatMap(
			(c) => c.shortages.map((s) => `${c.grade}|${s.block}`)
		);
		if (short.length === 0) break;
		for (const key of new Set(short)) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return build(specialization, counts, options).map((family) => ({
		descriptor: family,
		generatorSha256: hex(generatorText(family)),
		sourceSha256: familySourceSha256(family, generatorText(family)),
		module: generator(family)
	}));
}
