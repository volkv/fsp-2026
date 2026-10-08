// The practice tasks of Backend do not carry over between candidates: each instance states its own constants of the
// specification (only in the text, never in the input), so the reference program of another instance of the same
// class — a solution passed from one candidate to another — stays under the practice gate here. Programs run in the
// Python of the sandbox image, as in the gates of the bank. One gap stays by design: a constant not felt in the plain
// groups (the cap L of the capped sessions on Intern, the term T of the expiring reservations) leaves those two groups of
// five — the gate — to a program that differs only in it, so a few pairs in a hundred may carry; more is a defect.
import { afterAll, describe, expect, it } from 'vitest';
import { gradeDefinition } from '$lib/server/assessments/contract/catalog';
import { PythonRunner, practiceRun } from '../../scripts/assessments/resilience.ts';
import { loadTree } from '../../scripts/assessments/tree.ts';

const FAMILIES = loadTree().families.filter((f) => f.specialization === 'backend' && f.key.startsWith('be.code.'));
const SEEDS = 8;
/** The share of pairs of different instances whose program reaches the gate of the other. */
const CARRIED_MAX = 0.05;

const runner = new PythonRunner(false);
afterAll(() => {
	runner.close();
});

describe('Backend practice of one class across instances', () => {
	it('lists the four practice families', () => {
		expect(FAMILIES.map((f) => f.key).sort()).toEqual([
			'be.code.order-summary',
			'be.code.rate-limiter',
			'be.code.sessionize',
			'be.code.stock-reservations'
		]);
	});

	for (const family of FAMILIES) {
		it(`keeps a program of another instance under the gate: ${family.key}`, { timeout: 240_000 }, async () => {
			const factory = await family.module();
			const carried: string[] = [];
			let pairs = 0;
			for (const level of family.descriptor.levels) {
				const gate = gradeDefinition('backend', level.grade).practice.gateMinScore;
				for (const cls of level.classes) {
					const built = Array.from({ length: SEEDS }, (_, i) =>
						factory.build({ seed: `carry|${i}`, grade: level.grade, classId: cls.id })
					);
					const own = built[0];
					const ownProbe = own?.reference();
					if (!own || ownProbe?.kind !== 'practice') throw new Error(`${family.key}: no practice reference`);
					// The runner is right: an instance's own reference passes all of it.
					expect((await practiceRun(runner, own.instance, ownProbe.source, ownProbe.changeSource)).score).toBe(1);
					for (let i = 0; i < SEEDS; i += 1) {
						const target = built[i];
						const donor = built[(i + 1) % SEEDS];
						const probe = donor?.reference();
						if (!target || !donor || probe?.kind !== 'practice') throw new Error(`${family.key}: no pair`);
						// The same constants drawn twice make the same task: that program rightly passes.
						if (donor.instance.statement.markdown === target.instance.statement.markdown) continue;
						pairs += 1;
						const run = await practiceRun(runner, target.instance, probe.source, probe.changeSource);
						if (run.score >= gate) carried.push(`${level.grade}/${cls.id} #${(i + 1) % SEEDS} → #${i}: ${run.score}`);
					}
				}
			}
			expect(pairs).toBeGreaterThan(0);
			expect(carried.length / pairs, carried.join('; ')).toBeLessThanOrEqual(CARRIED_MAX);
		});
	}
});
