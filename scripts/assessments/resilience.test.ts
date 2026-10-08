// The instrument of the resilience report: an attempt with asynchronous scores follows the engine's path exactly, a
// pasted answer is checked as the candidate would type it, and the solver's reply is read only from its marked part.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureFamilies } from '../../tests/helpers/families.ts';
import type { ItemInstance } from '../../src/lib/server/assessments/contract/bank.ts';
import { loadSpecializationFamilies } from '../../src/lib/server/assessments/families.ts';
import { labelRandom, runAttempt } from '../../src/lib/server/assessments/simulate.ts';
import { otherInstance, pastedScore, playAttempt, replyAnswer, replyProgram } from './resilience.ts';

const BANK = fileURLToPath(new URL('../../assessments/families', import.meta.url));

/** A score fixed by the instance: the same cluster scores the same whoever asks. */
const fixedScore = (instance: ItemInstance): number => {
	const draw = labelRandom(instance.seed)();
	return instance.practice ? (draw < 0.8 ? 1 : 0.2) : draw < 0.6 ? 1 : 0;
};

describe('an attempt with asynchronous scores', () => {
	it('serves the clusters and reaches the decision of the engine with the same scores', async () => {
		const families = fixtureFamilies('backend');
		for (const grade of ['junior', 'middle', 'senior'] as const) {
			for (let i = 0; i < 20; i += 1) {
				const spec = {
					families,
					specialization: 'backend' as const,
					grade,
					form: 'A' as const,
					seen: new Set<string>(),
					attemptSeed: `play:${grade}:${i}`
				};
				const engine = runAttempt({ ...spec, score: (instance) => fixedScore(instance) });
				const played = await playAttempt(spec, ({ instance }) => Promise.resolve(fixedScore(instance)));
				expect(played.served).toEqual(engine.served);
				expect(played.decision).toEqual(engine.decision);
				expect(played.clusters.map((c) => c.seq)).toEqual(engine.served.map((_, k) => k + 1));
			}
		}
	});
});

describe('a pasted answer', () => {
	it('of the instance itself is right in every class of the released bank, as the candidate types it', async () => {
		const families = await loadSpecializationFamilies(BANK, 'backend');
		let checked = 0;
		for (const family of families) {
			if (family.descriptor.practice) continue;
			for (const level of family.descriptor.levels)
				for (const cls of level.classes) {
					const instance = family.module.generate({ seed: `paste:${cls.id}`, grade: level.grade, classId: cls.id });
					expect(pastedScore(instance, instance), `${family.descriptor.key} ${level.grade} ${cls.id}`).toBe(1);
					const other = otherInstance(family, instance, 'test');
					expect([other.classId, other.grade, other.seed === instance.seed]).toEqual([cls.id, level.grade, false]);
					checked += 1;
				}
		}
		expect(checked).toBeGreaterThan(200);
	});
});

describe("the solver's reply", () => {
	it('gives the answer of the last marked part and the last Python block, nothing without them', () => {
		expect(replyAnswer('думаю <answer>1</answer>, нет: <answer>\n a\n b \n</answer>')).toBe('a\n b');
		expect(replyAnswer('ответ: 42')).toBeNull();
		expect(replyProgram('```python\nprint(1)\n```\nлучше\n```python\nprint(2)\n```')).toBe('print(2)\n');
		expect(replyProgram('print(2)')).toBeNull();
	});
});
