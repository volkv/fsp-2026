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
	slotSequence,
	type BankRelease,
	type EssentialClass,
	type FamilyDescriptor,
	type ItemInstance
} from './bank';
import { PROCEDURE, maxLength } from './procedure';
import { familyProblems, instanceProblems, levelsByBlock, releaseProblems, type TrajectoryReport } from './validate';

const GATES_MET: FamilyDescriptor['gates'] = {
	reference: { seeds: 200, failures: 0 },
	wrongSolutions: { mustBeCaught: 2, caught: 2 },
	hiddenTestsMutationScore: null,
	answerCollision: 0.01,
	transfer: null,
	bruteForceInputs: null,
	rubricReview: { reviewer: 'Автор Б', reviewedAt: '2026-10-06' }
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
					ratings: [
						{ rater: 'Автор А', p: 0.55 },
						{ rater: 'Автор Б', p: 0.65 }
					],
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
					ratings: [
						{ rater: 'Автор А', p: 0.8 },
						{ rater: 'Автор Б', p: 0.8 }
					],
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
		families,
		sharedSha256: 'a'.repeat(64)
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
				{ shift: -0.15, runs: 2000, confirmed: 0.07, undetermined: 0.06, notConfirmed: 0.87 },
				{ shift: 0.15, runs: 2000, confirmed: 0.79, undetermined: 0.06, notConfirmed: 0.15 }
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
			frontend: [18, 23, 21, 21],
			mobile: [19, 21, 24, 19],
			data_ml: [17, 23, 22, 19],
			qa: [18, 21, 22, 21],
			devops: [17, 23, 21, 19]
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
		expect(problems).toContain('release backend@2026.10.2-1: be.algo@intern has 3 families, a block test needs 4');
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
			'release backend@2026.10.2-1: sharedSha256 is not a SHA-256',
			'trajectory report of backend@2026.10.2-1: middle true confirmation 0.6 < 0.75',
			'trajectory report of backend@2026.10.2-1: middle at 0.15 has 500 runs, 1000 required'
		]);
	});
});

describe('family descriptor', () => {
	const valid = computedFamily('be.db', 'null-aggregate', 'junior');

	it('accepts a valid family', () => {
		expect(familyProblems(valid)).toEqual([]);
		expect(familyProblems(practiceFamily('qa.mutants', 'boundaries', 'middle'))).toEqual([]);
		expect(familyProblems(practiceFamily('be.code', 'handler', 'senior'))).toEqual([]);
	});

	it('takes as the cut the mean of the ratings on the 1/20 scale, ties up', () => {
		const level = valid.levels[0];
		if (!level) throw new Error('level');
		const at = (ratings: number[], mean: number): FamilyDescriptor => ({
			...valid,
			levels: [{ ...level, angoff: { round: 1, ratings: ratings.map((p, i) => ({ rater: `Автор ${i}`, p })), mean } }]
		});
		expect(familyProblems(at([0.55, 0.6], 0.6))).toEqual([]);
		expect(familyProblems(at([0.55, 0.6], 0.575))).toEqual([
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
						ratings: [
							{ rater: 'А', p: 0.3 },
							{ rater: 'Б', p: 0.6 }
						],
						mean: 0.45
					}
				}
			]
		};
		expect(familyProblems(gap)).toEqual([
			'family be.db.null-aggregate@junior: ratings differ by more than 0.2 — the second round is required'
		]);
		const single: FamilyDescriptor = {
			...valid,
			levels: [{ ...level, angoff: { round: 1, ratings: [{ rater: 'А', p: 0.6 }], mean: 0.6 } }]
		};
		expect(familyProblems(single)).toEqual(['family be.db.null-aggregate@junior: Angoff needs 2 distinct raters']);
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
						ratings: [
							{ rater: 'А', p: 0.6 },
							{ rater: 'Б', p: 0.6 }
						],
						mean: 0.6
					}
				}
			],
			practice: { languages: ['python3'], hiddenTestGroups: 4 }
		};
		expect(familyProblems(hard)).toEqual([
			'family be.code.handler@junior: a practice cluster is a gate the borderline candidate passes: Angoff 0.75–0.9',
			'family be.code.handler: fewer than 5 hidden test groups'
		]);
		const qa = practiceFamily('qa.mutants', 'boundaries', 'middle');
		expect(familyProblems({ ...qa, qa: qa.qa && { ...qa.qa, budget: { min: 5, max: 50 } } })).toEqual([
			'family qa.mutants.boundaries: the QA budget is 5–8 test cases'
		]);
	});

	it('refuses a block of another specialization and a format the block does not take', () => {
		expect(familyProblems({ ...valid, specialization: 'qa' })).toContain(
			'family be.db.null-aggregate: block be.db is not of qa'
		);
		expect(familyProblems({ ...valid, format: 'config_eval' })).toContain(
			'family be.db.null-aggregate: block be.db does not take config_eval'
		);
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
