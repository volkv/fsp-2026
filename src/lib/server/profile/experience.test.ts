import { describe, expect, it } from 'vitest';
import { experienceMonths } from './experience';

describe('stated experience length', () => {
	const asOf = new Date('2026-10-05T12:00:00Z');

	it('counts both end months and an ongoing job to the current month', () => {
		expect(experienceMonths([{ periodFrom: '2024-01', periodTo: '2024-12' }], asOf)).toBe(12);
		expect(experienceMonths([{ periodFrom: '2026-01', periodTo: null }], asOf)).toBe(10);
	});

	it('counts months of two jobs at once once, and a gap not at all', () => {
		const entries = [
			{ periodFrom: '2020-01', periodTo: '2020-12' },
			{ periodFrom: '2020-06', periodTo: '2021-03' },
			{ periodFrom: '2022-01', periodTo: '2022-02' }
		];
		expect(experienceMonths(entries, asOf)).toBe(15 + 2);
		expect(experienceMonths([], asOf)).toBe(0);
	});
});
