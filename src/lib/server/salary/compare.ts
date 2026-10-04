// Salary range comparison (docs/domain.md, section 0).

export interface SalaryTerms {
	min: number | null;
	max: number | null;
	currency: string | null;
	period: 'month' | 'year' | 'hour' | 'project' | null;
	taxBase: 'gross' | 'net' | 'unknown' | null;
}

export type SalaryComparison = 'lower' | 'equal' | 'higher' | 'overlap' | 'not_comparable';

/**
 * Compares range `a` with range `b`: `lower` — `a` lies entirely below `b`, `higher` — entirely above, `equal` — the same
 * bounds, `overlap` — the ranges intersect. An unknown bound is an open end («from 200 000» is [200 000, ∞)).
 * Ranges are comparable only with the same currency, period and a known identical tax base; a range without
 * both bounds is not comparable. No conversion between gross and net, currencies or periods is attempted.
 */
export function compareSalary(a: SalaryTerms, b: SalaryTerms): SalaryComparison {
	if (a.min === null && a.max === null) return 'not_comparable';
	if (b.min === null && b.max === null) return 'not_comparable';
	if (a.currency === null || a.currency !== b.currency) return 'not_comparable';
	if (a.period === null || a.period !== b.period) return 'not_comparable';
	if (a.taxBase === null || a.taxBase === 'unknown' || a.taxBase !== b.taxBase) return 'not_comparable';

	const aLow = a.min ?? Number.NEGATIVE_INFINITY;
	const aHigh = a.max ?? Number.POSITIVE_INFINITY;
	const bLow = b.min ?? Number.NEGATIVE_INFINITY;
	const bHigh = b.max ?? Number.POSITIVE_INFINITY;

	if (aLow === bLow && aHigh === bHigh) return 'equal';
	if (aHigh < bLow) return 'lower';
	if (aLow > bHigh) return 'higher';
	return 'overlap';
}
