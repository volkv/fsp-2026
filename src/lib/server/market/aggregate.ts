// Category market indicators (docs/domain.md, section 12.5) as pure functions: which category keys a record counts
// in, which salary value it contributes, and the quantiles of each group. Three indicators of different origin are
// never mixed: a group is one indicator, one category key, one currency, period and tax base, one method and one
// provenance. `gross`, `net` and `unknown` are separate groups; demonstration records form their own `synthetic`
// groups and never enter a `live` one.
import type { marketSnapshots } from '$lib/server/db/schema';
import type { SalaryTerms } from '$lib/server/salary/compare';

export const MARKET_INDICATORS = ['candidate_expectations', 'vacancy_ranges', 'external_reference'] as const;
export type MarketIndicator = (typeof MARKET_INDICATORS)[number];

/** The combination the data was collected for, as stored in `market_snapshots.category_key`. */
export interface CategoryKey {
	role_key: string;
	grade_key?: string;
	/** Sorted, without duplicates; absent — any stack. */
	stack_skill_keys?: string[];
}

/** Stacks of up to this many skills get their own key: a record with a larger stack counts in each subset. */
export const MAX_STACK_KEY_SIZE = 2;

export function categoryKey(input: { roleKey: string; gradeKey?: string | null; stackSkillKeys?: readonly string[] }) {
	const stack = [...new Set(input.stackSkillKeys ?? [])].sort();
	const key: CategoryKey = { role_key: input.roleKey };
	if (input.gradeKey) key.grade_key = input.gradeKey;
	if (stack.length > 0) key.stack_skill_keys = stack;
	return key;
}

/** Text identity of a key: two keys are the same combination exactly when their ids are equal. */
export function categoryKeyId(key: CategoryKey): string {
	return `${key.role_key}|${key.grade_key ?? ''}|${(key.stack_skill_keys ?? []).join(',')}`;
}

function subsets(items: readonly string[], maxSize: number): string[][] {
	const sorted = [...new Set(items)].sort();
	const result: string[][] = [];
	const walk = (start: number, current: string[]) => {
		if (current.length > 0) result.push(current);
		if (current.length === maxSize) return;
		for (let i = start; i < sorted.length; i++) walk(i + 1, [...current, sorted[i] as string]);
	};
	walk(0, []);
	return result;
}

/**
 * Every key a record counts in: the role alone, the role with each grade of its established range, the role with each
 * stack subset, and both. An axis the record does not establish (grade unknown, empty stack) yields no keys on that
 * axis: the record counts only where its data says something, never in a guessed grade.
 */
export function categoryKeysOf(record: {
	roleKey: string;
	gradeKeys: readonly string[];
	stackSkillKeys: readonly string[];
}): CategoryKey[] {
	const stacks = subsets(record.stackSkillKeys, MAX_STACK_KEY_SIZE);
	const grades = [...new Set(record.gradeKeys)];
	const keys: CategoryKey[] = [categoryKey({ roleKey: record.roleKey })];
	for (const gradeKey of grades) keys.push(categoryKey({ roleKey: record.roleKey, gradeKey }));
	for (const stack of stacks) {
		keys.push(categoryKey({ roleKey: record.roleKey, stackSkillKeys: stack }));
		for (const gradeKey of grades) keys.push(categoryKey({ roleKey: record.roleKey, gradeKey, stackSkillKeys: stack }));
	}
	return keys;
}

/** Grade keys of an ordinal range `[min, max]`; unknown bounds or an inverted range give none. */
export function gradeKeysBetween(
	ordinals: ReadonlyMap<string, number>,
	min: string | null,
	max: string | null
): string[] {
	if (min === null || max === null) return [];
	const from = ordinals.get(min);
	const to = ordinals.get(max);
	if (from === undefined || to === undefined || from > to) return [];
	return [...ordinals].filter(([, ordinal]) => ordinal >= from && ordinal <= to).map(([key]) => key);
}

/**
 * How a record's range enters a statistic: the midpoint of a full range, or the known bound of a one-sided one.
 * One-sided ranges are kept apart from full ones (domain 12.5), so each shape is its own method.
 */
export const RANGE_METHODS = {
	full: 'observed_median',
	from: 'observed_median_from',
	to: 'observed_median_to'
} as const;

export type Period = NonNullable<SalaryTerms['period']>;
export type TaxBase = NonNullable<SalaryTerms['taxBase']>;

export interface SalaryPoint {
	value: number;
	currency: string;
	period: Period;
	taxBase: TaxBase;
	method: string;
}

/**
 * The value a salary range contributes, in the unit it is compared in. A yearly amount is expressed per month (a
 * twelfth, the same money in another unit); hourly and per-project amounts stay in their own unit, since turning
 * them into a month needs an assumption about hours or duration. Currencies are never converted. `null` — no salary.
 */
export function salaryPoint(terms: SalaryTerms): SalaryPoint | null {
	const { min, max, currency, period, taxBase } = terms;
	if (min === null && max === null) return null;
	if (currency === null || period === null || taxBase === null) {
		throw new Error('a salary with a bound has a currency, a period and a tax base (domain 0)');
	}
	const shape = min !== null && max !== null ? 'full' : min !== null ? 'from' : 'to';
	const raw = shape === 'full' ? ((min as number) + (max as number)) / 2 : ((min ?? max) as number);
	const yearly = period === 'year';
	return {
		value: Math.round(yearly ? raw / 12 : raw),
		currency,
		period: yearly ? 'month' : period,
		taxBase,
		method: RANGE_METHODS[shape]
	};
}

/** The same unit transformation for a range as a whole: a yearly range per month, anything else as it is. */
export function normalizedRange(terms: SalaryTerms): SalaryTerms {
	if (terms.period !== 'year') return terms;
	const month = (value: number | null) => (value === null ? null : Math.round(value / 12));
	return { ...terms, min: month(terms.min), max: month(terms.max), period: 'month' };
}

/** Quantile of sorted values by linear interpolation between order statistics (Hyndman–Fan type 7). */
export function quantile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) throw new Error('quantile of an empty sample');
	const position = (sorted.length - 1) * q;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	const low = sorted[lower] as number;
	const high = sorted[upper] as number;
	return low + (high - low) * (position - lower);
}

export interface MarketInput {
	indicator: Exclude<MarketIndicator, 'external_reference'>;
	keys: readonly CategoryKey[];
	point: SalaryPoint;
	/** The record comes from a demonstration seed (`seed_batch_id`). */
	synthetic: boolean;
}

export type SnapshotRow = Omit<typeof marketSnapshots.$inferInsert, 'id'>;

export interface AggregateOptions {
	/** Minimal sample of each indicator; below it no number is stored. */
	threshold: Record<MarketInput['indicator'], number>;
	geography: string;
	window: { from: string; to: string };
	computedAt: Date;
}

/**
 * One snapshot row per group of observed records. A group below the threshold is `insufficient_data` with its
 * sample size and no numbers.
 */
export function aggregate(inputs: readonly MarketInput[], options: AggregateOptions): SnapshotRow[] {
	const groups = new Map<string, { input: MarketInput; key: CategoryKey; values: number[] }>();
	for (const input of inputs) {
		const { point } = input;
		const provenance = input.synthetic ? 'synthetic' : 'live';
		for (const key of input.keys) {
			const id = [
				input.indicator,
				categoryKeyId(key),
				point.currency,
				point.period,
				point.taxBase,
				point.method,
				provenance
			].join('\u0000');
			const group = groups.get(id) ?? { input, key, values: [] };
			group.values.push(point.value);
			groups.set(id, group);
		}
	}
	return [...groups.values()].map(({ input, key, values }) => {
		const sorted = [...values].sort((a, b) => a - b);
		const enough = sorted.length >= options.threshold[input.indicator];
		return {
			indicator: input.indicator,
			categoryKey: key,
			geography: options.geography,
			currency: input.point.currency,
			period: input.point.period,
			taxBase: input.point.taxBase,
			sampleSize: sorted.length,
			median: enough ? Math.round(quantile(sorted, 0.5)) : null,
			p25: enough ? Math.round(quantile(sorted, 0.25)) : null,
			p75: enough ? Math.round(quantile(sorted, 0.75)) : null,
			windowFrom: options.window.from,
			windowTo: options.window.to,
			method: input.point.method,
			estimated: false,
			status: enough ? 'ok' : 'insufficient_data',
			provenance: input.synthetic ? 'synthetic' : 'live',
			computedAt: options.computedAt
		};
	});
}
