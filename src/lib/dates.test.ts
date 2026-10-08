import { describe, expect, it } from 'vitest';
import { productDay } from './dates';

describe('the day of a moment in the product time zone', () => {
	it('is the Moscow day, not the UTC one', () => {
		expect(productDay(new Date('2026-10-07T22:30:00Z'))).toBe('2026-10-08');
		expect(productDay(new Date('2026-10-07T20:59:59Z'))).toBe('2026-10-07');
	});
});
