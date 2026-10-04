// The market of a category as a viewer reads it (docs/domain.md, section 12.5; contracts `GET /catalog/market`) and
// the position of a vacancy's salary range against it. Each indicator keeps its own sample, window, geography, tax
// base and method; a number is shown only for the exact combination it was collected for and only at or above the
// threshold; demonstration data is labelled as such.
import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { marketSnapshots } from '$lib/server/db/schema';
import type { CatalogViewer } from '$lib/server/matching/visibility';
import { loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { compareSalary, type SalaryComparison, type SalaryTerms } from '$lib/server/salary/compare';
import { canShow } from '$lib/server/visibility/can-show';
import {
	aggregate,
	categoryKey,
	categoryKeyId,
	MARKET_INDICATORS,
	normalizedRange,
	RANGE_METHODS,
	type CategoryKey,
	type MarketIndicator,
	type SnapshotRow
} from './aggregate';
import { loadCandidateRecords } from './inputs';
import { loadMarketPolicy } from './policy';
import { candidateInputs, ESTIMATED_METHOD, MARKET_GEOGRAPHY } from './refresh';

interface FigureCommon {
	indicator: MarketIndicator;
	categoryKey: CategoryKey;
	geography: string;
	currency: string;
	period: NonNullable<SalaryTerms['period']>;
	taxBase: NonNullable<SalaryTerms['taxBase']>;
	method: string;
	/** A calculated adjustment, not an observation of this combination: shown with the label «оценка». */
	estimated: boolean;
	/** `synthetic` — collected on demonstration data and never presented as the market. */
	provenance: 'live' | 'synthetic' | 'mixed';
	window: { from: string; to: string };
	computedAt: Date;
}

export type MarketFigure = FigureCommon &
	(
		| { status: 'ok'; sampleSize: number; median: number; p25: number; p75: number }
		| {
				status: 'insufficient_data';
				/** `null` — a count of candidates below the threshold is not shown, only «< threshold». */
				sampleSize: number | null;
				threshold: number;
		  }
	);

export interface CategoryMarket {
	categoryKey: CategoryKey;
	/** An empty list — the indicator has no data for this combination at all («недостаточно данных»). */
	indicators: Record<MarketIndicator, MarketFigure[]>;
}

type StoredRow = SnapshotRow | typeof marketSnapshots.$inferSelect;

function figureOf(row: StoredRow, threshold: number, hideSmallSample: boolean): MarketFigure {
	const common: FigureCommon = {
		indicator: row.indicator,
		categoryKey: row.categoryKey as CategoryKey,
		geography: row.geography,
		currency: row.currency,
		period: row.period,
		taxBase: row.taxBase,
		method: row.method,
		estimated: row.estimated,
		provenance: row.provenance,
		window: { from: row.windowFrom, to: row.windowTo },
		computedAt: row.computedAt
	};
	if (row.status === 'ok') {
		const { median, p25, p75 } = row;
		if (median == null || p25 == null || p75 == null) throw new Error('an ok market row without quantiles');
		return { ...common, status: 'ok', sampleSize: row.sampleSize, median, p25, p75 };
	}
	return {
		...common,
		status: 'insufficient_data',
		sampleSize: hideSmallSample ? null : row.sampleSize,
		threshold
	};
}

const PROVENANCE_ORDER = { live: 0, mixed: 1, synthetic: 2 } as const;

/** Observed before estimated, live before demonstration, numbers before «insufficient data». */
function byRelevance(a: MarketFigure, b: MarketFigure): number {
	return (
		PROVENANCE_ORDER[a.provenance] - PROVENANCE_ORDER[b.provenance] ||
		Number(a.estimated) - Number(b.estimated) ||
		Number(a.status !== 'ok') - Number(b.status !== 'ok') ||
		a.method.localeCompare(b.method) ||
		a.taxBase.localeCompare(b.taxBase)
	);
}

async function storedRows(executor: Executor, key: CategoryKey): Promise<(typeof marketSnapshots.$inferSelect)[]> {
	return executor
		.select()
		.from(marketSnapshots)
		.where(
			and(
				sql`${marketSnapshots.categoryKey} = ${JSON.stringify(key)}::jsonb`,
				eq(marketSnapshots.geography, MARKET_GEOGRAPHY)
			)
		);
}

/**
 * Candidate expectations over the candidates this company sees in its catalog right now: the same `canShow` as the
 * search, in the catalog context without a vacancy.
 */
async function viewerCandidateRows(
	executor: Executor,
	key: CategoryKey,
	viewer: CatalogViewer,
	threshold: number,
	now: Date
): Promise<SnapshotRow[]> {
	const id = categoryKeyId(key);
	const records = (await loadCandidateRecords(executor, key.role_key))
		.map((record) => ({ ...record, keys: record.keys.filter((k) => categoryKeyId(k) === id) }))
		.filter((record) => record.keys.length > 0);
	const facts = await loadVisibilityFacts(
		executor,
		records.map((record) => record.candidateId),
		{
			now,
			policy: await loadVisibilityPolicy(executor, now),
			viewerCompanyId: viewer.viewer.companyId,
			viewerCompany: viewer.company
		}
	);
	const visible = (candidateId: string) => {
		const fact = facts.get(candidateId);
		if (!fact) return false;
		const show = canShow(fact, viewer.viewer, { kind: 'catalog' });
		return show.allowed && show.projection === 'catalog';
	};
	const today = now.toISOString().slice(0, 10);
	return aggregate(candidateInputs(records, visible), {
		threshold: { candidate_expectations: threshold, vacancy_ranges: threshold },
		geography: MARKET_GEOGRAPHY,
		window: { from: today, to: today },
		computedAt: now
	});
}

/**
 * The three indicators of one category. With a company viewer the candidate indicator counts the candidates that
 * company sees; without one (a candidate reading the market of their own category) — those any verified company
 * could see, as `market.refresh` stored them.
 */
export async function loadCategoryMarket(
	executor: Executor,
	input: {
		category: { roleKey: string; gradeKey?: string | null; stackSkillKeys?: readonly string[] };
		viewer: CatalogViewer | null;
		now: Date;
	}
): Promise<CategoryMarket> {
	const key = categoryKey(input.category);
	const policy = await loadMarketPolicy(executor, input.now);
	const stored = await storedRows(executor, key);
	const candidateRows =
		input.viewer === null
			? stored.filter((row) => row.indicator === 'candidate_expectations')
			: await viewerCandidateRows(executor, key, input.viewer, policy.threshold.candidate_expectations, input.now);
	const rows: StoredRow[] = [...candidateRows, ...stored.filter((row) => row.indicator !== 'candidate_expectations')];
	const indicators = Object.fromEntries(
		MARKET_INDICATORS.map((indicator) => [indicator, [] as MarketFigure[]])
	) as Record<MarketIndicator, MarketFigure[]>;
	for (const row of rows) {
		const candidates = row.indicator === 'candidate_expectations';
		indicators[row.indicator].push(figureOf(row, policy.threshold[row.indicator], candidates));
	}
	for (const figures of Object.values(indicators)) figures.sort(byRelevance);
	return { categoryKey: key, indicators };
}

// --- Position of a vacancy's range ------------------------------------------------------------------------------

export interface VacancyForPosition {
	roleKey: string | null;
	gradeMin: string | null;
	gradeMax: string | null;
	requiredSkillKeys: readonly string[];
	salary: SalaryTerms;
}

export type NotComparableReason = 'no_salary' | 'vacancy_tax_base_unknown' | 'tax_base' | 'currency' | 'period';

export type IndicatorPosition =
	| {
			indicator: 'vacancy_ranges' | 'external_reference';
			status: 'compared';
			/** The combination the figure was collected for: a broader one than the vacancy's is labelled as such. */
			categoryKey: CategoryKey;
			figure: Extract<MarketFigure, { status: 'ok' }>;
			/** The vacancy range against the interquartile range of the figure. */
			comparison: Exclude<SalaryComparison, 'not_comparable'>;
			/** Midpoint of a full range against the median, in percent; `null` for a one-sided range. */
			percentToMedian: number | null;
	  }
	| {
			indicator: 'vacancy_ranges' | 'external_reference';
			status: 'not_comparable';
			reason: NotComparableReason;
			categoryKey: CategoryKey;
			/** The unit of the figure the range could not be compared with. */
			market: { currency: string; period: string; taxBase: string } | null;
	  }
	| { indicator: 'vacancy_ranges' | 'external_reference'; status: 'insufficient_data' };

export type VacancyMarketPosition = { status: 'no_role' } | { status: 'evaluated'; positions: IndicatorPosition[] };

/**
 * Keys from the vacancy's own combination to broader ones: the role with the grade (only a single-grade vacancy has
 * one) and each required skill, the role with the grade, the role alone.
 */
function positionKeys(vacancy: VacancyForPosition & { roleKey: string }): CategoryKey[] {
	const grade = vacancy.gradeMin !== null && vacancy.gradeMin === vacancy.gradeMax ? vacancy.gradeMin : null;
	const keys = [...new Set(vacancy.requiredSkillKeys)]
		.sort()
		.map((skill) => categoryKey({ roleKey: vacancy.roleKey, gradeKey: grade, stackSkillKeys: [skill] }));
	if (grade !== null) keys.push(categoryKey({ roleKey: vacancy.roleKey, gradeKey: grade }));
	keys.push(categoryKey({ roleKey: vacancy.roleKey }));
	return keys;
}

/** The figure a range is compared with: full-range vacancies or an observed reference before an estimate. */
function comparableMethod(indicator: IndicatorPosition['indicator'], figure: MarketFigure): boolean {
	return indicator === 'vacancy_ranges'
		? figure.method === RANGE_METHODS.full
		: figure.method === 'observed_median' || figure.method === ESTIMATED_METHOD;
}

function positionAgainst(
	indicator: IndicatorPosition['indicator'],
	key: CategoryKey,
	figures: readonly MarketFigure[],
	range: SalaryTerms
): IndicatorPosition | null {
	const candidates = figures.filter(
		(figure): figure is Extract<MarketFigure, { status: 'ok' }> =>
			figure.status === 'ok' && comparableMethod(indicator, figure)
	);
	if (candidates.length === 0) return null;
	const sameUnit = candidates.find(
		(figure) => figure.currency === range.currency && figure.period === range.period && figure.taxBase === range.taxBase
	);
	if (!sameUnit) {
		const other = candidates[0] as (typeof candidates)[number];
		const reason: NotComparableReason =
			range.taxBase === 'unknown'
				? 'vacancy_tax_base_unknown'
				: other.currency !== range.currency
					? 'currency'
					: other.period !== range.period
						? 'period'
						: 'tax_base';
		return {
			indicator,
			status: 'not_comparable',
			reason,
			categoryKey: key,
			market: { currency: other.currency, period: other.period, taxBase: other.taxBase }
		};
	}
	const comparison = compareSalary(range, {
		min: sameUnit.p25,
		max: sameUnit.p75,
		currency: sameUnit.currency,
		period: sameUnit.period,
		taxBase: sameUnit.taxBase
	});
	if (comparison === 'not_comparable') {
		return {
			indicator,
			status: 'not_comparable',
			reason: range.taxBase === 'unknown' ? 'vacancy_tax_base_unknown' : 'tax_base',
			categoryKey: key,
			market: { currency: sameUnit.currency, period: sameUnit.period, taxBase: sameUnit.taxBase }
		};
	}
	const midpoint = range.min !== null && range.max !== null ? (range.min + range.max) / 2 : null;
	return {
		indicator,
		status: 'compared',
		categoryKey: key,
		figure: sameUnit,
		comparison,
		percentToMedian: midpoint === null ? null : Math.round(((midpoint - sameUnit.median) / sameUnit.median) * 100)
	};
}

/**
 * «Положение вилки относительно рынка» of a vacancy (from text or stored): against the vacancy ranges and the
 * external reference, at the most specific combination that has a figure. Comparison only in the same currency,
 * period and a known tax base (`compareSalary`); otherwise the reason is named. Demonstration figures are used only
 * when no live one exists, and carry their provenance.
 */
export async function vacancyMarketPosition(
	executor: Executor,
	vacancy: VacancyForPosition,
	now: Date
): Promise<VacancyMarketPosition> {
	if (vacancy.roleKey === null) return { status: 'no_role' };
	const range = normalizedRange(vacancy.salary);
	const positions: IndicatorPosition[] = [];
	const figuresOf = new Map<string, CategoryMarket>();
	const keys = positionKeys({ ...vacancy, roleKey: vacancy.roleKey });
	for (const indicator of ['vacancy_ranges', 'external_reference'] as const) {
		if (range.min === null && range.max === null) {
			positions.push({
				indicator,
				status: 'not_comparable',
				reason: 'no_salary',
				categoryKey: keys[keys.length - 1] as CategoryKey,
				market: null
			});
			continue;
		}
		let position: IndicatorPosition | null = null;
		for (const key of keys) {
			const id = categoryKeyId(key);
			let market = figuresOf.get(id);
			if (!market) {
				market = await loadCategoryMarket(executor, {
					category: {
						roleKey: key.role_key,
						gradeKey: key.grade_key ?? null,
						stackSkillKeys: key.stack_skill_keys ?? []
					},
					viewer: null,
					now
				});
				figuresOf.set(id, market);
			}
			const figures = market.indicators[indicator];
			const live = figures.filter((figure) => figure.provenance === 'live');
			position = positionAgainst(indicator, key, live, range) ?? positionAgainst(indicator, key, figures, range);
			if (position) break;
		}
		positions.push(position ?? { indicator, status: 'insufficient_data' });
	}
	return { status: 'evaluated', positions };
}

const TAX_BASE_TEXT = { gross: 'до вычета НДФЛ', net: 'на руки', unknown: 'без указания налога' } as const;
const INDICATOR_TEXT = { vacancy_ranges: 'медианы вилок вакансий', external_reference: 'внешнего ориентира' } as const;
const INDICATOR_NAME = { vacancy_ranges: 'вилки вакансий', external_reference: 'внешний ориентир' } as const;

function taxBaseText(value: string): string {
	return value in TAX_BASE_TEXT ? TAX_BASE_TEXT[value as keyof typeof TAX_BASE_TEXT] : value;
}

function notComparableText(
	position: Extract<IndicatorPosition, { status: 'not_comparable' }>,
	vacancyTaxBase: SalaryTerms['taxBase']
): string {
	const market = position.market;
	switch (position.reason) {
		case 'no_salary':
			return 'несравнимо — зарплата не указана';
		case 'vacancy_tax_base_unknown':
			return 'несравнимо — у вилки не указано, до вычета НДФЛ она или на руки';
		case 'tax_base':
			return `несравнимо — вилка указана ${taxBaseText(vacancyTaxBase ?? 'unknown')}, показатель — ${taxBaseText(market?.taxBase ?? 'unknown')}`;
		case 'currency':
			return `несравнимо — показатель в другой валюте (${market?.currency ?? '—'})`;
		case 'period':
			return 'несравнимо — показатель за другой период';
	}
}

/** The position in words for the interface, with «оценка» and «демо-данные» where they apply. */
export function positionText(position: IndicatorPosition, vacancyTaxBase: SalaryTerms['taxBase']): string {
	if (position.status === 'insufficient_data') return `${INDICATOR_NAME[position.indicator]}: недостаточно данных`;
	if (position.status === 'not_comparable') {
		return `${INDICATOR_NAME[position.indicator]}: ${notComparableText(position, vacancyTaxBase)}`;
	}
	const { figure, percentToMedian } = position;
	const labels = [figure.estimated ? 'оценка' : null, figure.provenance === 'synthetic' ? 'демо-данные' : null]
		.filter((label) => label !== null)
		.join(', ');
	const suffix = labels ? ` (${labels})` : '';
	if (percentToMedian === null) {
		const where =
			position.comparison === 'lower'
				? 'ниже межквартильного диапазона'
				: position.comparison === 'higher'
					? 'выше межквартильного диапазона'
					: 'пересекается с межквартильным диапазоном';
		return `Вилка ${where} ${INDICATOR_TEXT[position.indicator]}${suffix}`;
	}
	if (percentToMedian === 0) return `Середина вилки на уровне ${INDICATOR_TEXT[position.indicator]}${suffix}`;
	const direction = percentToMedian > 0 ? 'выше' : 'ниже';
	return `Середина вилки на ${Math.abs(percentToMedian)} % ${direction} ${INDICATOR_TEXT[position.indicator]}${suffix}`;
}
