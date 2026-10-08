import { describe, expect, it } from 'vitest';
import { candidateCode, candidateLabel } from './candidate-label';

describe('candidate label', () => {
	it('names a candidate by a short code of the pseudonym, the same on every screen', () => {
		expect(candidateLabel('cryuvdolc5vcuvwnmjzfblilf4')).toBe('Кандидат CRYUVD');
		expect(candidateCode('cryuvdolc5vcuvwnmjzfblilf4')).toBe('CRYUVD');
	});

	it('refuses a view without the pseudonym and a value too short to be one', () => {
		expect(() => candidateLabel(null)).toThrow();
		expect(() => candidateCode('abc')).toThrow();
	});
});
