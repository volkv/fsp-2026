import { describe, expect, it } from 'vitest';
import { cosineSimilarity, l2Normalize } from './spaces';

describe('vector comparison', () => {
	it('compares vectors of one space', () => {
		const result = cosineSimilarity({ spaceId: 's1', vector: [1, 0] }, { spaceId: 's1', vector: [1, 1] });
		expect(result.ok && result.value).toBeCloseTo(Math.SQRT1_2);
	});

	it('refuses vectors of different spaces even with the same dimension', () => {
		const result = cosineSimilarity({ spaceId: 's1', vector: [1, 0] }, { spaceId: 's2', vector: [1, 0] });
		expect(result).toMatchObject({ ok: false, error: { code: 'space_mismatch', retryable: false } });
	});

	it('refuses vectors of different lengths', () => {
		const result = cosineSimilarity({ spaceId: 's1', vector: [1, 0] }, { spaceId: 's1', vector: [1, 0, 0] });
		expect(result).toMatchObject({ ok: false, error: { code: 'space_mismatch' } });
	});

	it('normalises to unit length and refuses a zero vector', () => {
		expect(l2Normalize([3, 4])).toEqual([0.6, 0.8]);
		expect(l2Normalize([0, 0])).toBeNull();
	});
});
