import { describe, expect, it } from 'vitest';
import { CATALOG, GRADE_KEYS, gradeDefinition, type GradeKey, type SpecializationKey } from './catalog';
import { capacityChecks, slotSequence, type BankRelease, type FamilyDescriptor, type ItemInstance } from './bank';
import { PROCEDURE, maxLength } from './procedure';
import { familyProblems, instanceProblems, levelsByBlock, releaseProblems } from './validate';

const GATES_MET: FamilyDescriptor['gates'] = {
	reference: { seeds: 200, failures: 0 },
	wrongSolutions: { mustBeCaught: 2, caught: 2 },
	hiddenTestsMutationScore: null,
	answerCollision: 0.01,
	transfer: null,
	bruteForceInputs: null,
	rubricReview: { reviewer: 'Автор Б', reviewedAt: '2026-10-06' }
};

/** A computed-answer family of one level that meets every gate. */
function computedFamily(block: string, name: string, grade: GradeKey, anchor = false): FamilyDescriptor {
	const blockSpec = CATALOG.blocks.find((b) => b.code === block);
	if (!blockSpec) throw new Error(block);
	return {
		key: `${block}.${name}`,
		version: 1,
		specialization: blockSpec.specialization,
		block,
		format: blockSpec.formats.includes('bug_locate') ? 'bug_locate' : (blockSpec.formats[0] ?? 'compute'),
		answerKind: blockSpec.formats.includes('bug_locate') ? 'line_no' : 'exact',
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
				classes: [
					{ id: 'a', form: 'A', description: 'граница включена' },
					{ id: 'b', form: 'B', description: 'граница исключена' },
					...(anchor ? [{ id: 'k', form: 'anchor' as const, description: 'опорный класс' }] : [])
				]
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

/** A practice family of one level; from Middle up it carries the change step. */
function practiceFamily(block: string, name: string, grade: GradeKey, anchor = false): FamilyDescriptor {
	const base = computedFamily(block, name, grade, anchor);
	const spec = CATALOG.blocks.find((b) => b.code === block)?.specialization ?? 'backend';
	const changeStep = gradeDefinition(spec, grade).practice.changeStep;
	const isQa = block === 'qa.mutants';
	return {
		...base,
		key: `${block}.${name}`,
		specialization: spec,
		block,
		format: isQa ? 'qa_mutation' : 'practice_code',
		answerKind: isQa ? 'test_cases' : 'code',
		practice: isQa
			? null
			: {
					languages: [CATALOG.specializations.find((s) => s.key === spec)?.practiceLanguages[0] ?? 'python3'],
					hiddenTestGroups: 4
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

/** A release that fills every slot of every grade exactly, with two anchors per grade. */
function exactRelease(specialization: SpecializationKey): BankRelease {
	const families: FamilyDescriptor[] = [];
	for (const grade of GRADE_KEYS) {
		const definition = gradeDefinition(specialization, grade);
		let anchors = 0;
		for (const quota of definition.blocks) {
			for (let i = 0; i < quota.items; i += 1) {
				const anchor = anchors < 2 && quota.block !== definition.practice.block;
				if (anchor) anchors += 1;
				const name = `${grade}-${String(i)}`;
				families.push(
					quota.block === definition.practice.block
						? practiceFamily(quota.block, name, grade, anchor)
						: computedFamily(quota.block, name, grade, anchor)
				);
			}
		}
	}
	return {
		id: `${specialization}@${CATALOG.version}-1`,
		specialization,
		catalogVersion: CATALOG.version,
		procedureVersion: PROCEDURE.version,
		families
	};
}

describe('slot sequence', () => {
	it.each(CATALOG.definitions.map((d) => [`${d.specialization} × ${d.grade}`, d] as const))(
		'%s fills the longest trajectory with the practice at its position',
		(_, definition) => {
			const slots = slotSequence(definition);
			expect(slots).toHaveLength(maxLength(PROCEDURE, definition.grade));
			expect(slots.filter((s) => s.practice)).toEqual([
				{ position: definition.practice.position, block: definition.practice.block, practice: true }
			]);
			for (const quota of definition.blocks) {
				expect(slots.filter((s) => s.block === quota.block)).toHaveLength(quota.items);
			}
		}
	);

	it('keeps every block of a quota of three or more inside the main part', () => {
		const definition = gradeDefinition('backend', 'middle');
		const main = slotSequence(definition).slice(0, PROCEDURE.grades.middle.nMax);
		for (const quota of definition.blocks.filter((q) => q.items >= 3)) {
			expect(
				main.some((s) => s.block === quota.block),
				quota.block
			).toBe(true);
		}
	});
});

describe('bank release', () => {
	it('accepts a release that serves every extreme trajectory', () => {
		const release = exactRelease('backend');
		expect(releaseProblems(release, PROCEDURE)).toEqual([]);
		expect(capacityChecks(release, PROCEDURE).every((check) => check.ok)).toBe(true);
		expect(levelsByBlock(release, 'middle').get('be.db')).toBe(4);
	});

	it('runs out when a block lacks one family-level, on every longest trajectory', () => {
		const release = exactRelease('qa');
		const lacking = { ...release, families: release.families.filter((f) => f.key !== 'qa.design.junior-4') };
		expect(releaseProblems(lacking, PROCEDURE)).toEqual([
			'release qa@2026.10.1-1: junior A18 runs out in qa.design',
			'release qa@2026.10.1-1: junior A18→B18 runs out in qa.design',
			'release qa@2026.10.1-1: junior B18 runs out in qa.design',
			'release qa@2026.10.1-1: junior B18→A18 runs out in qa.design'
		]);
	});

	it('runs out on the retake when a family-level has no class of the other form', () => {
		const release = exactRelease('backend');
		const families = release.families.map((f) =>
			f.key === 'be.algo.junior-0'
				? { ...f, levels: f.levels.map((l) => ({ ...l, classes: l.classes.filter((c) => c.form !== 'B') })) }
				: f
		);
		const problems = releaseProblems({ ...release, families }, PROCEDURE);
		expect(problems).toContain('family be.algo.junior-0@junior: needs an essential class of form A and of form B');
		expect(problems).toContain('release backend@2026.10.1-1: junior A18→B18 runs out in be.algo');
	});

	it('requires two anchors per grade', () => {
		const release = exactRelease('frontend');
		const families = release.families.map((f) =>
			f.levels[0]?.grade === 'senior'
				? { ...f, levels: f.levels.map((l) => ({ ...l, classes: l.classes.filter((c) => c.form !== 'anchor') })) }
				: f
		);
		expect(releaseProblems({ ...release, families }, PROCEDURE)).toEqual([
			'release frontend@2026.10.1-1: senior has 0 anchor family-levels, 2 required'
		]);
	});
});

describe('family descriptor', () => {
	const valid = computedFamily('be.db', 'null-aggregate', 'junior');

	it('accepts a valid family', () => {
		expect(familyProblems(valid)).toEqual([]);
		expect(familyProblems(practiceFamily('qa.mutants', 'boundaries', 'middle'))).toEqual([]);
	});

	it('refuses Angoff without two raters, a wrong mean and a large gap without the second round', () => {
		const level = valid.levels[0];
		if (!level) throw new Error('level');
		const broken: FamilyDescriptor = {
			...valid,
			levels: [
				{
					...level,
					angoff: {
						round: 1,
						ratings: [
							{ rater: 'Автор А', p: 0.3 },
							{ rater: 'Автор Б', p: 0.62 }
						],
						mean: 0.5
					}
				}
			]
		};
		expect(familyProblems(broken)).toEqual([
			'family be.db.null-aggregate@junior: Angoff rating 0.62 is not on the 0.05 scale',
			'family be.db.null-aggregate@junior: Angoff mean 0.5 is not 0.4600',
			'family be.db.null-aggregate@junior: ratings differ by more than 0.2 — the second round is required'
		]);
		const single: FamilyDescriptor = {
			...valid,
			levels: [{ ...level, angoff: { round: 1, ratings: [{ rater: 'Автор А', p: 0.6 }], mean: 0.6 } }]
		};
		expect(familyProblems(single)).toEqual(['family be.db.null-aggregate@junior: Angoff needs 2 distinct raters']);
	});

	it('refuses a QA budget outside 5–8, a missing change step and a failed gate', () => {
		const qa = practiceFamily('qa.mutants', 'boundaries', 'middle');
		expect(familyProblems({ ...qa, qa: qa.qa && { ...qa.qa, budget: { min: 5, max: 50 } } })).toEqual([
			'family qa.mutants.boundaries: the QA budget is 5–8 test cases'
		]);
		expect(familyProblems({ ...qa, changeStep: null })).toEqual([
			'family qa.mutants.boundaries@middle: the practice of middle needs the step «измени своё решение»'
		]);
		expect(familyProblems({ ...valid, gates: { ...valid.gates, answerCollision: 0.2, rubricReview: null } })).toEqual([
			'family be.db.null-aggregate: gate answer collision 0.2',
			'family be.db.null-aggregate: gate rubric not reviewed by a person'
		]);
	});

	it('refuses a block of another specialization, a format the block does not take and non-adjacent levels', () => {
		const level = valid.levels[0];
		if (!level) throw new Error('level');
		expect(familyProblems({ ...valid, specialization: 'qa' })).toContain(
			'family be.db.null-aggregate: block be.db is not of qa'
		);
		expect(familyProblems({ ...valid, format: 'config_eval' })).toContain(
			'family be.db.null-aggregate: block be.db does not take config_eval'
		);
		expect(familyProblems({ ...valid, levels: [level, { ...level, grade: 'senior' }] })).toContain(
			'family be.db.null-aggregate: two levels must be adjacent grades'
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
