import { describe, expect, it } from 'vitest';
import { compareSalary, type SalaryTerms } from './compare';

const rub = (min: number | null, max: number | null, taxBase: SalaryTerms['taxBase'] = 'gross'): SalaryTerms => ({
	min,
	max,
	currency: 'RUB',
	period: 'month',
	taxBase
});

describe('compareSalary', () => {
	it('orders disjoint ranges', () => {
		expect(compareSalary(rub(100_000, 150_000), rub(200_000, 250_000))).toBe('lower');
		expect(compareSalary(rub(300_000, 350_000), rub(200_000, 250_000))).toBe('higher');
	});

	it('recognizes equal and overlapping ranges', () => {
		expect(compareSalary(rub(200_000, 250_000), rub(200_000, 250_000))).toBe('equal');
		expect(compareSalary(rub(200_000, 260_000), rub(250_000, 300_000))).toBe('overlap');
		expect(compareSalary(rub(200_000, 250_000), rub(250_000, 300_000))).toBe('overlap');
	});

	it('treats an unknown bound as an open end', () => {
		expect(compareSalary(rub(200_000, null), rub(100_000, 150_000))).toBe('higher');
		expect(compareSalary(rub(200_000, null), rub(100_000, 250_000))).toBe('overlap');
		expect(compareSalary(rub(null, 150_000), rub(200_000, null))).toBe('lower');
		expect(compareSalary(rub(200_000, null), rub(200_000, null))).toBe('equal');
	});

	it('does not compare gross with net, even when the numbers differ a lot', () => {
		expect(compareSalary(rub(100_000, 120_000, 'gross'), rub(300_000, 350_000, 'net'))).toBe('not_comparable');
	});

	it('does not compare an unknown tax base, other currencies or periods', () => {
		expect(compareSalary(rub(100_000, 120_000, 'unknown'), rub(100_000, 120_000, 'unknown'))).toBe('not_comparable');
		expect(compareSalary(rub(100_000, 120_000), { ...rub(100_000, 120_000), currency: 'USD' })).toBe('not_comparable');
		expect(compareSalary(rub(100_000, 120_000), { ...rub(100_000, 120_000), period: 'year' })).toBe('not_comparable');
	});

	it('does not compare a range without both bounds', () => {
		expect(compareSalary(rub(null, null), rub(100_000, 120_000))).toBe('not_comparable');
		expect(compareSalary(rub(100_000, 120_000), rub(null, null))).toBe('not_comparable');
	});
});
