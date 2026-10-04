import { describe, expect, it } from 'vitest';
import {
	aggregate,
	categoryKeyId,
	categoryKeysOf,
	gradeKeysBetween,
	quantile,
	salaryPoint,
	type MarketInput
} from './aggregate';

const window = { from: '2026-09-01', to: '2026-09-25' };
const options = {
	threshold: { candidate_expectations: 5, vacancy_ranges: 3 },
	geography: 'ru',
	window,
	computedAt: new Date('2026-09-25T00:00:00Z')
};

function vacancy(value: number, taxBase: 'gross' | 'net' | 'unknown', synthetic = false): MarketInput {
	return {
		indicator: 'vacancy_ranges',
		keys: [{ role_key: 'backend' }],
		point: { value, currency: 'RUB', period: 'month', taxBase, method: 'observed_median' },
		synthetic
	};
}

describe('categoryKeysOf', () => {
	it('counts a record in its role, each grade of its range, each stack subset and their combinations', () => {
		const ids = categoryKeysOf({ roleKey: 'backend', gradeKeys: ['middle'], stackSkillKeys: ['python', 'go'] }).map(
			categoryKeyId
		);
		expect(ids.sort()).toEqual(
			[
				'backend||',
				'backend|middle|',
				'backend||go',
				'backend||python',
				'backend||go,python',
				'backend|middle|go',
				'backend|middle|python',
				'backend|middle|go,python'
			].sort()
		);
	});

	it('puts a record without an established grade in no grade', () => {
		const ids = categoryKeysOf({ roleKey: 'backend', gradeKeys: [], stackSkillKeys: [] }).map(categoryKeyId);
		expect(ids).toEqual(['backend||']);
	});
});

describe('gradeKeysBetween', () => {
	const ordinals = new Map([
		['junior', 1],
		['middle', 2],
		['senior', 3]
	]);
	it('expands an ordinal range and refuses unknown or inverted bounds', () => {
		expect(gradeKeysBetween(ordinals, 'junior', 'middle')).toEqual(['junior', 'middle']);
		expect(gradeKeysBetween(ordinals, 'senior', 'junior')).toEqual([]);
		expect(gradeKeysBetween(ordinals, 'junior', null)).toEqual([]);
		expect(gradeKeysBetween(ordinals, 'lead', 'lead')).toEqual([]);
	});
});

describe('salaryPoint', () => {
	it('takes the midpoint of a full range and keeps one-sided ranges apart', () => {
		const terms = { currency: 'RUB', period: 'month', taxBase: 'gross' } as const;
		expect(salaryPoint({ min: 200_000, max: 300_000, ...terms })).toMatchObject({
			value: 250_000,
			method: 'observed_median'
		});
		expect(salaryPoint({ min: 200_000, max: null, ...terms })).toMatchObject({
			value: 200_000,
			method: 'observed_median_from'
		});
		expect(salaryPoint({ min: null, max: 300_000, ...terms })).toMatchObject({ method: 'observed_median_to' });
		expect(salaryPoint({ min: null, max: null, ...terms })).toBeNull();
	});

	it('expresses a year per month and leaves hours and currencies as they are', () => {
		expect(
			salaryPoint({ min: 2_400_000, max: 3_600_000, currency: 'RUB', period: 'year', taxBase: 'net' })
		).toMatchObject({ value: 250_000, period: 'month', taxBase: 'net' });
		expect(salaryPoint({ min: 50, max: 50, currency: 'USD', period: 'hour', taxBase: 'gross' })).toMatchObject({
			value: 50,
			period: 'hour',
			currency: 'USD'
		});
	});
});

describe('quantile', () => {
	it('interpolates between order statistics', () => {
		expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
		expect(quantile([10], 0.25)).toBe(10);
		expect(quantile([100, 200, 300, 400, 500], 0.25)).toBe(200);
	});
});

describe('aggregate', () => {
	it('never puts gross, net and unknown into one row', () => {
		const rows = aggregate(
			[
				vacancy(300_000, 'gross'),
				vacancy(310_000, 'gross'),
				vacancy(320_000, 'gross'),
				vacancy(100_000, 'net'),
				vacancy(110_000, 'net'),
				vacancy(120_000, 'net'),
				vacancy(900_000, 'unknown')
			],
			options
		);
		const byBase = Object.fromEntries(rows.map((row) => [row.taxBase, row]));
		expect(byBase.gross).toMatchObject({ sampleSize: 3, median: 310_000, status: 'ok' });
		expect(byBase.net).toMatchObject({ sampleSize: 3, median: 110_000, status: 'ok' });
		expect(byBase.unknown).toMatchObject({ sampleSize: 1, median: null, status: 'insufficient_data' });
	});

	it('keeps demonstration records in their own synthetic rows', () => {
		const rows = aggregate(
			[
				vacancy(300_000, 'gross'),
				vacancy(300_000, 'gross'),
				vacancy(300_000, 'gross'),
				vacancy(5_000_000, 'gross', true)
			],
			options
		);
		expect(rows.find((row) => row.provenance === 'live')).toMatchObject({ sampleSize: 3, median: 300_000 });
		expect(rows.find((row) => row.provenance === 'synthetic')).toMatchObject({
			sampleSize: 1,
			status: 'insufficient_data'
		});
		expect(rows.some((row) => row.provenance === 'mixed')).toBe(false);
	});
});
