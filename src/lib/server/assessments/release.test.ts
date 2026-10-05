import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clampHarness, fixtureFamilies } from '../../../../tests/helpers/families';
import { familyModule, GeneratorMismatch } from './bank-store';
import { familySourceSha256 } from './contract/bank';
import { familyProblems } from './contract/validate';
import { loadBankTree, loadSpecializationFamilies, sharedCodeSha256 } from './families';
import { assembleRelease, releaseContentSha256, releaseId } from './release';

const FIXTURE_TREE = fileURLToPath(new URL('../../../../tests/fixtures/families', import.meta.url));

describe('bank tree', () => {
	it('loads a family directory: the descriptor, the hash of the generator and a working generate()', async () => {
		const [family, ...rest] = await loadSpecializationFamilies(FIXTURE_TREE, 'backend');
		expect(rest).toEqual([]);
		if (!family) throw new Error('no family');
		expect(family.descriptor.key).toBe('be.lang.fixture-sum');
		expect(family.generatorSha256).toMatch(/^[0-9a-f]{64}$/);
		// The reviews and ratings of the descriptor were made on exactly these sources: the descriptor and the generator.
		const generator = await readFile(join(FIXTURE_TREE, 'backend', 'be.lang.fixture-sum', 'generator.ts'), 'utf8');
		expect(family.sourceSha256).toBe(familySourceSha256(family.descriptor, generator));
		expect(familyProblems(family.descriptor, family.sourceSha256)).toEqual([]);
		const instance = family.module.generate({ seed: 's1', grade: 'junior', classId: 'inclusive' });
		expect(instance.answer?.kind).toBe('exact');
		expect(family.module.generate({ seed: 's1', grade: 'junior', classId: 'inclusive' })).toEqual(instance);
		expect([...(await loadBankTree(FIXTURE_TREE)).keys()]).toEqual(['backend']);
	});

	it('serves a generator only with the hash its release recorded', async () => {
		const [family] = await loadSpecializationFamilies(FIXTURE_TREE, 'backend');
		if (!family) throw new Error('no family');
		const recorded = { descriptor: family.descriptor, generatorSha256: family.generatorSha256 };
		const release = {
			specialization: 'backend' as const,
			sharedSha256: await sharedCodeSha256(FIXTURE_TREE, 'backend')
		};
		const module = await familyModule(recorded, release, FIXTURE_TREE);
		expect(module.generate({ seed: 's2', grade: 'junior', classId: 'exclusive' }).classId).toBe('exclusive');
		await expect(
			familyModule({ ...recorded, generatorSha256: '0'.repeat(64) }, release, FIXTURE_TREE)
		).rejects.toBeInstanceOf(GeneratorMismatch);
		await expect(
			familyModule(recorded, { ...release, sharedSha256: '0'.repeat(64) }, FIXTURE_TREE)
		).rejects.toBeInstanceOf(GeneratorMismatch);
	});

	it('has nothing for a specialization without a directory', async () => {
		expect(await loadSpecializationFamilies(FIXTURE_TREE, 'devops')).toEqual([]);
	});
});

const SHARED = '0'.repeat(64);

describe('release assembly', () => {
	it('admits a fixture bank: capacity, anchors, block tests and the trajectory report within the acceptance', () => {
		const assembled = assembleRelease('backend', fixtureFamilies('backend'), SHARED, 1);
		expect(assembled.problems).toEqual([]);
		expect(assembled.release).toMatchObject({ id: releaseId('backend', 1), sharedSha256: SHARED });
		expect(assembled.manifest.capacityChecks.every((check) => check.ok)).toBe(true);
		expect(assembled.manifest.anchors.junior).toHaveLength(2);
		const report = assembled.manifest.trajectories;
		expect(report?.grades.map((g) => g.grade)).toEqual(['intern', 'junior', 'middle', 'senior']);
		expect(report?.grades.every((g) => g.points.every((p) => p.runs >= 1000))).toBe(true);
		expect(assembled.contentSha256).toBe(releaseContentSha256(assembled.manifest.families, SHARED));
		expect(releaseContentSha256(assembled.manifest.families, 'f'.repeat(64))).not.toBe(assembled.contentSha256);
		expect(assembled.release.familySources).toEqual(
			Object.fromEntries(fixtureFamilies('backend').map((f) => [f.descriptor.key, f.sourceSha256]))
		);
		expect(assembled.manifest.familySources).toEqual(assembled.release.familySources);
		// Reviewed and rated by models only: every family-level of every grade rests on models.
		for (const j of Object.values(assembled.manifest.judgement)) {
			expect(j.levels).toBeGreaterThan(0);
			expect(j).toEqual({ levels: j.levels, rubricByModelsOnly: j.levels, angoffProvisional: j.levels });
		}
	}, 60_000);

	it('counts reviews only on the current sources and tells a bank signed by a person from one signed by models', () => {
		const families = fixtureFamilies('qa');
		// An edit of the generator after the reviews: the sources changed, every review and rating is reset.
		const edited = families.map((f, i) => (i === 0 ? { ...f, sourceSha256: 'e'.repeat(64) } : f));
		const key = families[0]?.descriptor.key ?? '';
		const problems = assembleRelease('qa', edited, SHARED, 1).problems;
		expect(problems.some((p) => p.includes(key) && p.includes('rate again'))).toBe(true);
		expect(problems.some((p) => p.includes(key) && p.includes('on the current sources'))).toBe(true);

		const signed = assembleRelease('qa', fixtureFamilies('qa', { signedBy: 'person' }), SHARED, 1);
		expect(signed.problems).toEqual([]);
		for (const j of Object.values(signed.manifest.judgement)) {
			expect(j).toEqual({ levels: j.levels, rubricByModelsOnly: 0, angoffProvisional: 0 });
		}
	}, 120_000);

	it('refuses a bank that runs out, a generator that is not deterministic and QA without a harness', () => {
		const families = fixtureFamilies('qa');
		const lacking = families.filter((f) => f.descriptor.key !== 'qa.design.junior-0');
		expect(
			assembleRelease('qa', lacking, SHARED, 1).problems.some((p) => /junior .* runs out: .*qa\.design/.test(p))
		).toBe(true);
		let calls = 0;
		const drifting = families.map((f) =>
			f.descriptor.key === 'qa.design.intern-0'
				? {
						...f,
						module: {
							generate: (input: Parameters<typeof f.module.generate>[0]) => {
								calls += 1;
								return { ...f.module.generate(input), timeNormSec: 100 + calls };
							}
						}
					}
				: f
		);
		expect(assembleRelease('qa', drifting, SHARED, 1).problems).toContain(
			'family qa.design.intern-0@intern/a: generate is not deterministic'
		);
		const noHarness = families.map((f) =>
			f.descriptor.format === 'qa_mutation' && f.descriptor.levels[0]?.grade === 'junior'
				? { ...f, module: { generate: f.module.generate } }
				: f
		);
		expect(assembleRelease('qa', noHarness, SHARED, 1).problems).toContain(
			'family qa.mutants.junior-0: QA needs harness()'
		);
		expect(clampHarness).toBeTypeOf('function');
	}, 120_000);

	it('checks the trajectory report it makes: too few runs per point keep the release out', () => {
		const assembled = assembleRelease('frontend', fixtureFamilies('frontend'), SHARED, 1, { runs: 200 });
		expect(assembled.problems.some((p) => p.includes('has 200 runs, 1000 required'))).toBe(true);
	}, 60_000);
});
