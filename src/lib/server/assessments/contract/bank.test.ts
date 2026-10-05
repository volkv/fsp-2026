import { describe, expect, it } from 'vitest';
import {
	CATALOG,
	GRADE_KEYS,
	SPECIALIZATION_KEYS,
	blockDefinition,
	gradeDefinition,
	type GradeKey,
	type SpecializationKey
} from './catalog';
import {
	blockTestPairs,
	capacityChecks,
	chooseForm,
	familySourceSha256,
	judgementProvenance,
	slotSequence,
	type AngoffRating,
	type BankRelease,
	type Reviewer,
	type EssentialClass,
	type FamilyDescriptor,
	type ItemInstance
} from './bank';
import { PROCEDURE, maxLength } from './procedure';
import {
	familyProblems as familyCoded,
	instanceProblems as instanceCoded,
	levelsByBlock,
	releaseProblems as releaseCoded,
	type TrajectoryReport,
	type ValidationProblem
} from './validate';

const text = (problems: ValidationProblem[]) => problems.map((p) => p.message);
const familyProblems = (...args: Parameters<typeof familyCoded>) => text(familyCoded(...args));
const instanceProblems = (...args: Parameters<typeof instanceCoded>) => text(instanceCoded(...args));
const releaseProblems = (...args: Parameters<typeof releaseCoded>) => text(releaseCoded(...args));

const GENERATOR = 'export function generate() {}';
const STALE = '0'.repeat(64);
const MODEL_A: Reviewer = { kind: 'model', model: 'codex', lineage: 'openai' };
const MODEL_B: Reviewer = { kind: 'model', model: 'claude-sonnet', lineage: 'anthropic' };
const rate = (rater: Reviewer, p: number): AngoffRating => ({ rater, p, ratedAt: '2026-10-06', sourceSha256: STALE });
const person = (name: string): Reviewer => ({ kind: 'person', name });

/** The family with every review and rating made on its current sources. */
function seal(family: FamilyDescriptor): FamilyDescriptor {
	const hash = familySourceSha256(family, GENERATOR);
	return {
		...family,
		levels: family.levels.map((l) => ({
			...l,
			angoff: { ...l.angoff, ratings: l.angoff.ratings.map((x) => ({ ...x, sourceSha256: hash })) }
		})),
		gates: { ...family.gates, rubricReviews: family.gates.rubricReviews.map((x) => ({ ...x, sourceSha256: hash })) }
	};
}

const check = (family: FamilyDescriptor) => familyProblems(seal(family), familySourceSha256(family, GENERATOR));

const GATES_MET: FamilyDescriptor['gates'] = {
	reference: { seeds: 200, failures: 0 },
	wrongSolutions: { mustBeCaught: 2, caught: 2 },
	hiddenTestsMutationScore: null,
	answerCollision: 0.01,
	transfer: null,
	bruteForceInputs: null,
	rubricReviews: [
		{ reviewer: MODEL_A, reviewedAt: '2026-10-06', verdict: 'approved', remarks: [], sourceSha256: STALE },
		{ reviewer: MODEL_B, reviewedAt: '2026-10-06', verdict: 'approved', remarks: [], sourceSha256: STALE }
	]
};

const CLASSES: EssentialClass[] = [
	{ id: 'a', form: 'A', description: 'граница включена' },
	{ id: 'b', form: 'B', description: 'граница исключена' },
	{ id: 'x', form: 'X', description: 'резерв: граница на переполнении' }
];

/** A computed-answer family of one level that meets every gate. */
function computedFamily(block: string, name: string, grade: GradeKey, anchor = false): FamilyDescriptor {
	const spec = blockDefinition(block);
	const bug = spec.formats.includes('bug_locate');
	return {
		key: `${block}.${name}`,
		version: 1,
		specialization: spec.specialization,
		block,
		format: bug ? 'bug_locate' : (spec.formats[0] ?? 'compute'),
		answerKind: bug ? 'line_no' : 'exact',
		levels: [
			{
				grade,
				angoff: {
					round: 1,
					ratings: [rate(MODEL_A, 0.55), rate(MODEL_B, 0.65)],
					mean: 0.6
				},
				constructive: { depth: 2 },
				constructiveRank: 1,
				timeNormSec: 180,
				classes: [...CLASSES, ...(anchor ? [{ id: 'k', form: 'anchor' as const, description: 'опорный класс' }] : [])]
			}
		],
		surfaceParams: [{ name: 'names', description: 'имена переменных и сюжет' }],
		essentialParams: [{ name: 'boundary', description: 'включительность границы' }],
		language: null,
		practice: null,
		qa: null,
		changeStep: null,
		rubric: { kind: 'binary' },
		coverage: { checks: ['граничные значения'], doesNotCheck: ['скорость работы'] },
		wrongSolutions: [
			{ id: 'off-by-one', defect: 'граница сдвинута на единицу', mustBeCaught: true },
			{ id: 'order', defect: 'порядок при равенстве', mustBeCaught: true }
		],
		authorship: { draftedBy: 'model', authors: ['Автор А'] },
		gates: GATES_MET
	};
}

/** A practice family of one level: a gate the borderline candidate passes (Angoff 0.8), five groups. */
function practiceFamily(block: string, name: string, grade: GradeKey): FamilyDescriptor {
	const base = computedFamily(block, name, grade);
	const spec = blockDefinition(block).specialization;
	const changeStep = gradeDefinition(spec, grade).practice.changeStep;
	const isQa = block === 'qa.mutants';
	const level = base.levels[0];
	if (!level) throw new Error('level');
	return {
		...base,
		format: isQa ? 'qa_mutation' : 'practice_code',
		answerKind: isQa ? 'test_cases' : 'code',
		levels: [
			{
				...level,
				angoff: {
					round: 1,
					ratings: [rate(MODEL_A, 0.8), rate(MODEL_B, 0.8)],
					mean: 0.8
				}
			}
		],
		practice: isQa
			? null
			: {
					languages: [CATALOG.specializations.find((s) => s.key === spec)?.practiceLanguages[0] ?? 'python3'],
					hiddenTestGroups: 5
				},
		qa: isQa
			? {
					budget: { min: 5, max: 8 },
					mutants: ['lt', 'le', 'skip', 'swap', 'round', 'off'].map((op) => ({ id: op, operator: op }))
				}
			: null,
		changeStep: changeStep ? { description: 'новое ограничение на входные данные', weight: 0.3 } : null,
		rubric: isQa
			? {
					kind: 'mutants',
					levels: [
						{ minKillRatio: 0.5, score: 0.5 },
						{ minKillRatio: 0.8, score: 1 }
					]
				}
			: { kind: 'groups' },
		wrongSolutions: ['a', 'b', 'c'].map((id) => ({ id, defect: `дефект ${id}`, mustBeCaught: true })),
		gates: {
			...GATES_MET,
			wrongSolutions: { mustBeCaught: 3, caught: 3 },
			hiddenTestsMutationScore: isQa ? null : 0.95,
			transfer: isQa ? null : 0
		}
	};
}

/** The fewest family-levels per block × grade the release check accepts, each with classes A, B and X. */
function minimalCounts(specialization: SpecializationKey): Map<string, number> {
	const counts = new Map<string, number>();
	for (const d of CATALOG.definitions.filter((x) => x.specialization === specialization)) {
		for (const q of d.blocks) counts.set(`${d.grade}|${q.block}`, q.items);
	}
	for (const pair of blockTestPairs(specialization)) {
		const key = `${pair.grade}|${pair.block}`;
		counts.set(key, Math.max(counts.get(key) ?? 0, 4));
	}
	for (let round = 0; round < 20; round += 1) {
		const short = capacityChecks(release(specialization, counts), PROCEDURE).flatMap((c) =>
			c.shortages.map((s) => `${c.grade}|${s.block}`)
		);
		if (short.length === 0) return counts;
		for (const key of new Set(short)) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	throw new Error('no minimal release');
}

function release(specialization: SpecializationKey, counts: ReadonlyMap<string, number>): BankRelease {
	const families: FamilyDescriptor[] = [];
	const anchors = new Map<string, number>();
	for (const [key, n] of counts) {
		const [grade, block] = key.split('|') as [GradeKey, string];
		for (let i = 0; i < n; i += 1) {
			const name = `${grade}-${i}`;
			if (blockDefinition(block).practice) families.push(practiceFamily(block, name, grade));
			else {
				const anchor = (anchors.get(grade) ?? 0) < 2;
				if (anchor) anchors.set(grade, (anchors.get(grade) ?? 0) + 1);
				families.push(computedFamily(block, name, grade, anchor));
			}
		}
	}
	return {
		id: `${specialization}@${CATALOG.version}-1`,
		specialization,
		catalogVersion: CATALOG.version,
		procedureVersion: PROCEDURE.version,
		families: families.map(seal),
		sharedSha256: 'a'.repeat(64),
		familySources: Object.fromEntries(families.map((f) => [f.key, familySourceSha256(f, GENERATOR)]))
	};
}

function passingReport(r: BankRelease): TrajectoryReport {
	return {
		releaseId: r.id,
		procedureVersion: PROCEDURE.version,
		model: { rho: 0.5, practiceGroups: 5 },
		grades: GRADE_KEYS.map((grade) => ({
			grade,
			points: [
				{ shift: -0.15, runs: 4000, confirmed: 0.07, undetermined: 0.06, notConfirmed: 0.87 },
				{ shift: 0.15, runs: 4000, confirmed: 0.79, undetermined: 0.06, notConfirmed: 0.15 }
			],
			consistency: [
				{ shift: -0.15, value: 0.81 },
				{ shift: 0.15, value: 0.66 }
			]
		}))
	};
}

const total = (counts: ReadonlyMap<string, number>, grade: GradeKey) =>
	[...counts].filter(([k]) => k.startsWith(`${grade}|`)).reduce((s, [, n]) => s + n, 0);

describe('slot sequence', () => {
	it.each(CATALOG.definitions.map((d) => [`${d.specialization} × ${d.grade}`, d] as const))(
		'%s: defining blocks first, the practice at its position, quotas filled',
		(_, definition) => {
			const slots = slotSequence(definition);
			expect(slots).toHaveLength(maxLength(PROCEDURE, definition.grade));
			expect(slots.filter((s) => s.practice)).toEqual([
				{ position: definition.practice.position, block: definition.practice.block, practice: true }
			]);
			const firstItems = slots.filter((s) => !s.practice).slice(0, PROCEDURE.grades[definition.grade].nMin);
			for (const code of definition.defining) {
				expect(firstItems.filter((s) => s.block === code)).toHaveLength(PROCEDURE.definingMinItems);
			}
			for (const quota of definition.blocks)
				expect(slots.filter((s) => s.block === quota.block)).toHaveLength(quota.items);
		}
	);
});

describe('form choice', () => {
	it('takes the form with fewer seen classes, the seed on a tie', () => {
		expect(chooseForm({ A: 18, B: 0 }, 0)).toBe('B');
		expect(chooseForm({ A: 0, B: 3 }, 1)).toBe('A');
		expect(chooseForm({ A: 0, B: 0 }, 1)).toBe('B');
	});
});

describe('bank release', () => {
	it('publishes the minimal numbers of family-levels per grade (classes A, B and X each)', () => {
		const sizes = Object.fromEntries(
			SPECIALIZATION_KEYS.map((spec) => {
				const counts = minimalCounts(spec);
				return [spec, GRADE_KEYS.map((g) => total(counts, g))];
			})
		);
		expect(sizes).toEqual({
			backend: [20, 23, 23, 21],
			frontend: [20, 23, 21, 21],
			mobile: [21, 21, 24, 19],
			data_ml: [20, 23, 22, 19],
			qa: [18, 21, 22, 21],
			devops: [19, 23, 21, 19]
		});
	});

	it('accepts the minimal release with a trajectory report within the acceptance', () => {
		const r = release('backend', minimalCounts('backend'));
		expect(releaseProblems(r, PROCEDURE, passingReport(r))).toEqual([]);
		expect(levelsByBlock(r, 'middle').get('be.db')).toBe(5);
	});

	it('runs out when a block test of an allowed block has fewer than four families', () => {
		const counts = new Map(minimalCounts('backend'));
		counts.set('intern|be.algo', 3);
		const r = release('backend', counts);
		const problems = releaseProblems(r, PROCEDURE, passingReport(r));
		expect(problems).toContain('release backend@2026.10.3-1: be.algo@intern has 3 families, a block test needs 4');
		expect(problems.some((p) => p.includes('block:be.algo in be.algo'))).toBe(true);
	});

	it('runs out on the block tests and the recheck without reserve classes', () => {
		const r = release('qa', minimalCounts('qa'));
		const noReserve = {
			...r,
			families: r.families.map((f) => ({
				...f,
				levels: f.levels.map((l) => ({ ...l, classes: l.classes.filter((c) => c.form !== 'X') }))
			}))
		};
		const problems = releaseProblems(noReserve, PROCEDURE, passingReport(noReserve));
		expect(problems.some((p) => p.includes('block:qa.design in qa.design'))).toBe(true);
		expect(problems.some((p) => p.includes('recheck:'))).toBe(true);
	});

	it('runs out on the retake when a family-level has no class of the other form', () => {
		const r = release('backend', minimalCounts('backend'));
		const families = r.families.map((f) =>
			f.key === 'be.algo.junior-0'
				? { ...f, levels: f.levels.map((l) => ({ ...l, classes: l.classes.filter((c) => c.form !== 'B') })) }
				: f
		);
		const problems = releaseProblems({ ...r, families }, PROCEDURE, passingReport(r));
		expect(problems).toContain('family be.algo.junior-0@junior: needs an essential class of form A and of form B');
	});

	it('refuses a release without a trajectory report within the acceptance, or without the hash of shared code', () => {
		const r = release('backend', minimalCounts('backend'));
		const report = passingReport(r);
		const bad: TrajectoryReport = {
			...report,
			grades: report.grades.map((g) =>
				g.grade === 'middle'
					? { ...g, points: g.points.map((p) => (p.shift > 0 ? { ...p, confirmed: 0.6, runs: 500 } : p)) }
					: g
			)
		};
		expect(releaseProblems({ ...r, sharedSha256: 'x' }, PROCEDURE, bad)).toEqual([
			'release backend@2026.10.3-1: sharedSha256 is not a SHA-256',
			'trajectory report of backend@2026.10.3-1: middle true confirmation 0.6 < 0.75',
			'trajectory report of backend@2026.10.3-1: middle has 4000, 500 runs per point, one count of 1000, 4000, 16000 required'
		]);
	});
	it('settles a trajectory report by the schedule fixed in advance, not by the seed', () => {
		const r = release('backend', minimalCounts('backend'));
		const report = passingReport(r);
		// False confirmation 0.088 against the bound 0.10: within three standard errors at 1000 and 4000 runs, settled at 16000.
		const at = (runs: number): TrajectoryReport => ({
			...report,
			grades: report.grades.map((g) =>
				g.grade === 'intern'
					? { ...g, points: g.points.map((p) => ({ ...p, runs, ...(p.shift < 0 ? { confirmed: 0.088 } : {}) })) }
					: g
			)
		});
		expect(releaseProblems(r, PROCEDURE, at(1000))).toEqual([
			'trajectory report of backend@2026.10.3-1: intern is within the Monte Carlo error of a bound at 1000 runs, 4000 required'
		]);
		expect(releaseProblems(r, PROCEDURE, at(4000))).toEqual([
			'trajectory report of backend@2026.10.3-1: intern is within the Monte Carlo error of a bound at 4000 runs, 16000 required'
		]);
		expect(releaseProblems(r, PROCEDURE, at(16000))).toEqual([]);
	});
});

describe('family descriptor', () => {
	const valid = computedFamily('be.db', 'null-aggregate', 'junior');

	it('accepts a valid family', () => {
		expect(check(valid)).toEqual([]);
		expect(check(practiceFamily('qa.mutants', 'boundaries', 'middle'))).toEqual([]);
		expect(check(practiceFamily('be.code', 'handler', 'senior'))).toEqual([]);
	});

	it('takes as the cut the mean of the ratings on the 1/20 scale, ties up', () => {
		const level = valid.levels[0];
		if (!level) throw new Error('level');
		const at = (ratings: number[], mean: number): FamilyDescriptor => ({
			...valid,
			levels: [{ ...level, angoff: { round: 1, ratings: ratings.map((p, i) => rate(person(`Автор ${i}`), p)), mean } }]
		});
		expect(check(at([0.55, 0.6], 0.6))).toEqual([]);
		expect(check(at([0.55, 0.6], 0.575))).toEqual([
			'family be.db.null-aggregate@junior: Angoff mean 0.575 is not 0.60 (mean 0.575 on the 1/20 scale)'
		]);
	});

	it('refuses Angoff without two raters and a large gap without the second round', () => {
		const level = valid.levels[0];
		if (!level) throw new Error('level');
		const gap: FamilyDescriptor = {
			...valid,
			levels: [
				{
					...level,
					angoff: {
						round: 1,
						ratings: [rate(person('А'), 0.3), rate(person('Б'), 0.6)],
						mean: 0.45
					}
				}
			]
		};
		expect(check(gap)).toEqual([
			'family be.db.null-aggregate@junior: ratings differ by more than 0.2 — awaits the second round'
		]);
		const stillApart: FamilyDescriptor = {
			...gap,
			levels: gap.levels.map((l) => ({ ...l, angoff: { ...l.angoff, round: 2 } }))
		};
		expect(check(stillApart)).toEqual([
			'family be.db.null-aggregate@junior: ratings still differ by more than 0.2 after the second round — not admitted'
		]);
		const single: FamilyDescriptor = {
			...valid,
			levels: [{ ...level, angoff: { round: 1, ratings: [rate(person('А'), 0.6)], mean: 0.6 } }]
		};
		expect(check(single)).toEqual([
			'family be.db.null-aggregate@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)'
		]);
	});

	it('refuses a practice that is not a gate the borderline passes, too few groups, a wrong QA budget', () => {
		const practice = practiceFamily('be.code', 'handler', 'junior');
		const level = practice.levels[0];
		if (!level) throw new Error('level');
		const hard: FamilyDescriptor = {
			...practice,
			levels: [
				{
					...level,
					angoff: {
						round: 1,
						ratings: [rate(person('А'), 0.6), rate(person('Б'), 0.6)],
						mean: 0.6
					}
				}
			],
			practice: { languages: ['python3'], hiddenTestGroups: 4 }
		};
		expect(check(hard)).toEqual([
			'family be.code.handler@junior: a practice cluster is a gate the borderline candidate passes: Angoff 0.75–0.9',
			'family be.code.handler: fewer than 5 hidden test groups'
		]);
		const qa = practiceFamily('qa.mutants', 'boundaries', 'middle');
		expect(check({ ...qa, qa: qa.qa && { ...qa.qa, budget: { min: 5, max: 50 } } })).toEqual([
			'family qa.mutants.boundaries: the QA budget is 5–8 test cases'
		]);
	});

	it('refuses a block of another specialization and a format the block does not take', () => {
		expect(check({ ...valid, specialization: 'qa' })).toContain(
			'family be.db.null-aggregate: block be.db is not of qa'
		);
		expect(check({ ...valid, format: 'config_eval' })).toContain(
			'family be.db.null-aggregate: block be.db does not take config_eval'
		);
	});
});

describe('independent reviews', () => {
	const valid = computedFamily('be.db', 'null-aggregate', 'junior');
	const hash = familySourceSha256(valid, GENERATOR);
	const withReviews = (reviews: FamilyDescriptor['gates']['rubricReviews']): FamilyDescriptor => ({
		...seal(valid),
		gates: { ...valid.gates, rubricReviews: reviews.map((x) => ({ ...x, sourceSha256: hash })) }
	});
	const review = (reviewer: Reviewer, verdict: 'approved' | 'changes_requested' = 'approved') => ({
		reviewer,
		reviewedAt: '2026-10-06',
		verdict,
		remarks: verdict === 'approved' ? [] : ['ключ неверен для класса b'],
		sourceSha256: hash
	});
	const NEEDS =
		'family be.db.null-aggregate: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources';

	it('accepts two models of different lineages or one person', () => {
		expect(familyProblems(withReviews([review(MODEL_A), review(MODEL_B)]), hash)).toEqual([]);
		expect(familyProblems(withReviews([review(person('Павел'))]), hash)).toEqual([]);
	});

	it('refuses one model, or two models of one lineage', () => {
		expect(familyProblems(withReviews([review(MODEL_A)]), hash)).toEqual([NEEDS]);
		const sameLineage: Reviewer = { kind: 'model', model: 'codex-mini', lineage: 'openai' };
		expect(familyProblems(withReviews([review(MODEL_A), review(sameLineage)]), hash)).toEqual([NEEDS]);
	});

	it('refuses a release while a review of the current sources requests changes', () => {
		expect(
			familyProblems(
				withReviews([review(MODEL_A), review(MODEL_B), review(person('Роман'), 'changes_requested')]),
				hash
			)
		).toEqual(['family be.db.null-aggregate: gate a review of the current sources requests changes']);
	});

	it('resets every review and rating when the family is edited', () => {
		const sealed = seal(valid);
		const edited = { ...sealed, coverage: { ...sealed.coverage, checks: ['граничные значения', 'NULL в агрегате'] } };
		expect(familyProblems(edited, familySourceSha256(edited, GENERATOR))).toEqual([
			'family be.db.null-aggregate@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)',
			NEEDS
		]);
		expect(familySourceSha256(valid, GENERATOR + ' ')).not.toBe(hash);
	});

	it('refuses Angoff ratings of two models of one lineage', () => {
		const level = valid.levels[0];
		if (!level) throw new Error('level');
		const sameLineage: Reviewer = { kind: 'model', model: 'codex-mini', lineage: 'openai' };
		const family: FamilyDescriptor = {
			...valid,
			levels: [{ ...level, angoff: { round: 1, ratings: [rate(MODEL_A, 0.6), rate(sameLineage, 0.6)], mean: 0.6 } }]
		};
		expect(check(family)).toEqual([
			'family be.db.null-aggregate@junior: a rater (or a model lineage) rated twice',
			'family be.db.null-aggregate@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)'
		]);
	});

	it('tells a pending judgement from a defect by its code: no ratings, no reviews', () => {
		const level = valid.levels[0];
		if (!level) throw new Error('level');
		const pending: FamilyDescriptor = {
			...valid,
			levels: [{ ...level, angoff: { round: 1, ratings: [], mean: 0.65 } }],
			gates: { ...valid.gates, rubricReviews: [] }
		};
		expect(familyCoded(pending, hash).map((p) => p.code)).toEqual(['awaiting_raters', 'awaiting_reviews']);
		const practice = practiceFamily('be.code', 'handler', 'junior');
		const practiceLevel = practice.levels[0];
		if (!practiceLevel) throw new Error('level');
		const at = (mean: number): FamilyDescriptor => ({
			...practice,
			levels: [{ ...practiceLevel, angoff: { round: 1, ratings: [], mean } }],
			gates: { ...practice.gates, rubricReviews: [] }
		});
		const practiceHash = familySourceSha256(at(0.8), GENERATOR);
		expect(familyCoded(at(0.8), practiceHash).map((p) => p.code)).toEqual(['awaiting_raters', 'awaiting_reviews']);
		expect(familyCoded(at(0.6), practiceHash)).toContainEqual({
			code: 'defect',
			message:
				'family be.code.handler@junior: a practice cluster is a gate the borderline candidate passes: Angoff 0.75–0.9'
		});
		expect(familyCoded(at(0.83), practiceHash)).toContainEqual({
			code: 'defect',
			message: 'family be.code.handler@junior: Angoff mean 0.83 is not on the 1/20 scale'
		});
	});

	describe('a family written by claude-opus (anthropic)', () => {
		const OPUS: Reviewer = { kind: 'model', model: 'claude-opus', lineage: 'anthropic' };
		const CODEX_MINI: Reviewer = { kind: 'model', model: 'codex-mini', lineage: 'openai' };
		const byOpus: FamilyDescriptor = {
			...valid,
			authorship: { draftedBy: 'model', authors: ['claude-opus (anthropic)'] }
		};
		const opusHash = familySourceSha256(byOpus, GENERATOR);
		const judgedBy = (first: Reviewer, second: Reviewer): FamilyDescriptor => {
			const level = byOpus.levels[0];
			if (!level) throw new Error('level');
			return {
				...byOpus,
				levels: [
					{
						...level,
						angoff: {
							round: 1,
							ratings: [rate(first, 0.55), rate(second, 0.65)].map((x) => ({ ...x, sourceSha256: opusHash })),
							mean: 0.6
						}
					}
				],
				gates: {
					...byOpus.gates,
					rubricReviews: [review(first), review(second)].map((x) => ({ ...x, sourceSha256: opusHash }))
				}
			};
		};
		const codes = (family: FamilyDescriptor) => familyCoded(family, opusHash).map((p) => p.code);

		it('accepts codex and claude-sonnet: another model of the author vendor, and another vendor', () => {
			expect(familyCoded(judgedBy(MODEL_A, MODEL_B), opusHash)).toEqual([]);
			expect(judgementProvenance(judgedBy(MODEL_A, MODEL_B), 'junior')).toEqual({
				rubricByModelsOnly: true,
				angoffProvisional: true,
				sameVendorReviewer: true
			});
		});

		it('refuses claude-sonnet with the author model claude-opus', () => {
			expect(familyCoded(judgedBy(MODEL_B, OPUS), opusHash)).toEqual([
				{
					code: 'defect',
					message: 'family be.db.null-aggregate: claude-opus (anthropic) is an author of the family and cannot judge it'
				},
				{ code: 'defect', message: 'family be.db.null-aggregate@junior: a rater (or a model lineage) rated twice' },
				{
					code: 'awaiting_raters',
					message:
						'family be.db.null-aggregate@junior: awaits 2 independent Angoff ratings on the current sources (provisional cut 0.6)'
				},
				{
					code: 'awaiting_reviews',
					message:
						'family be.db.null-aggregate: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources'
				}
			]);
		});

		it('refuses two models of one vendor (codex and codex-mini)', () => {
			expect(codes(judgedBy(MODEL_A, CODEX_MINI))).toEqual(['defect', 'awaiting_raters', 'awaiting_reviews']);
		});

		it('refuses a person author as a reviewer', () => {
			const byPerson: FamilyDescriptor = {
				...withReviews([review(person('Павел'))]),
				authorship: { draftedBy: 'team', authors: ['Павел'] }
			};
			expect(familyProblems(byPerson, hash)).toEqual([
				'family be.db.null-aggregate: Павел is an author of the family and cannot judge it',
				'family be.db.null-aggregate: gate rubric needs 2 approvals by models of different lineages or 1 by a person on the current sources'
			]);
		});
	});

	it('labels model-only judgements for the product', () => {
		expect(judgementProvenance(seal(valid), 'junior')).toEqual({
			rubricByModelsOnly: true,
			angoffProvisional: true,
			sameVendorReviewer: false
		});
		expect(judgementProvenance(withReviews([review(person('Павел'))]), 'junior')).toEqual({
			rubricByModelsOnly: false,
			angoffProvisional: true,
			sameVendorReviewer: false
		});
	});
});

describe('instance', () => {
	const family = computedFamily('be.db', 'null-aggregate', 'junior');
	const instance: ItemInstance = {
		family: family.key,
		familyVersion: 1,
		grade: 'junior',
		classId: 'a',
		seed: 'seed-1',
		format: family.format,
		answerKind: family.answerKind,
		statement: { markdown: 'Какая строка вызовет ошибку?', code: { language: 'python3', source: 'print(1)' } },
		answer: { kind: 'line_no', value: 3 },
		practice: null,
		qa: null,
		changeStep: null,
		timeNormSec: 180
	};

	it('accepts an instance of its family', () => {
		expect(instanceProblems(instance, family)).toEqual([]);
	});

	it('requires the QA change step to carry its own specification and mutants', () => {
		const qaFamily = practiceFamily('qa.mutants', 'boundaries', 'middle');
		const qaInstance: ItemInstance = {
			...instance,
			family: qaFamily.key,
			grade: 'middle',
			format: 'qa_mutation',
			answerKind: 'test_cases',
			answer: null,
			statement: { markdown: 'Составьте тест-кейсы', code: null },
			qa: {
				budget: { min: 5, max: 8 },
				specification: 'спецификация',
				mutants: [{ id: 'lt', operator: 'lt', equivalent: false }]
			},
			changeStep: { markdown: 'Новое условие', weight: 0.3, answer: null, groups: [], qa: null }
		};
		expect(instanceProblems(qaInstance, qaFamily)).toEqual([
			'instance qa.mutants.boundaries/seed-1: a QA change step carries its specification and mutants, others none'
		]);
		const fixed: ItemInstance = {
			...qaInstance,
			changeStep: {
				markdown: 'Новое условие',
				weight: 0.3,
				answer: null,
				groups: [],
				qa: { specification: 'новая', mutants: [{ id: 'le', operator: 'le', equivalent: false }] }
			}
		};
		expect(instanceProblems(fixed, qaFamily)).toEqual([]);
	});

	it('refuses an unknown class, a missing answer and an unknown language', () => {
		expect(
			instanceProblems(
				{
					...instance,
					classId: 'z',
					answer: null,
					statement: { ...instance.statement, code: { language: 'cobol', source: 'x' } }
				},
				family
			)
		).toEqual([
			'instance be.db.null-aggregate/seed-1: unknown class z',
			'instance be.db.null-aggregate/seed-1: computed answer of kind line_no required',
			'instance be.db.null-aggregate/seed-1: code in unknown language cobol'
		]);
	});
});
