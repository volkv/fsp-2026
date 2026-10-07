import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GRADE_KEYS, SPECIALIZATION_KEYS, type GradeKey } from '$lib/server/assessments/contract/catalog';
import { loadSpecializationFamilies } from '$lib/server/assessments/families';
import { readSeedData, TEST_OUTCOMES, type SeedData, type TestOutcome } from './data';
import { drawOf, findDraw, foresee, type GradeReach, type ReleasedBank } from './foresight';
import { resumePlan } from './generate';

const root = resolve(import.meta.dirname, '../../../..');
let backend: ReleasedBank;
let data: SeedData;

beforeAll(async () => {
	const families = await loadSpecializationFamilies(resolve(root, 'assessments/families'), 'backend');
	backend = {
		release: { id: 'backend@test-1', specialization: 'backend', sharedSha256: '', families: [] },
		families: families.map((family) => ({ descriptor: family.descriptor, module: family.module }))
	};
	data = await readSeedData(resolve(root, 'seeds'));
});

describe('the foresight of a seeded attempt', () => {
	it('finds a draw that gives the outcome asked, and the same draw gives it again', async () => {
		for (const outcome of TEST_OUTCOMES) {
			const found = await findDraw(
				backend,
				'middle',
				new Set(),
				outcome,
				(trial) => `foresight-test:${outcome}:${trial}`
			);
			expect(found, outcome).not.toBeNull();
			if (found) expect(foresee(backend, 'middle', new Set(), found.draw)).toBe(outcome);
		}
		// The draw of a label is fixed: the seed of a batch makes the same attempts every time.
		expect(drawOf('a:b:test:0:3', 'undetermined')).toEqual(drawOf('a:b:test:0:3', 'undetermined'));
	}, 60_000);
});

describe('the plan of a background candidate', () => {
	it('asks a released bank only for the outcomes its grade gives', () => {
		// A bank whose every grade gives only a confirmation without the margin and a failure.
		const given: readonly TestOutcome[] = ['confirmed', 'not_confirmed'];
		const grades: GradeReach = new Map(
			GRADE_KEYS.map((grade): [GradeKey, Set<TestOutcome>] => [grade, new Set(given)])
		);
		const reach = new Map(SPECIALIZATION_KEYS.map((specialization) => [specialization, grades]));
		const asked = new Set<TestOutcome>();
		let tests = 0;
		for (let index = 1; index <= 400; index += 1) {
			const plan = resumePlan(index, data, 'foresight-test', new Date('2026-10-08T00:00:00Z'), new Map(), reach);
			for (const test of plan.assessments) {
				for (const attempt of test.attempts) {
					asked.add(attempt.outcome);
					tests += 1;
				}
			}
		}
		expect(tests).toBeGreaterThan(50);
		expect([...asked].sort()).toEqual([...given].sort());
	});
});
