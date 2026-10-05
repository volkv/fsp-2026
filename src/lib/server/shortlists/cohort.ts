// The second axis of a shortlist — whether the offer suits the candidate (docs/domain.md, section 13.10). What the
// company sees on the card (the work formats, the region) is answered by name: yes, no or unknown, without values. The
// salary expectations are hidden from the company, so the range is answered only as an aggregate of a fixed cohort —
// every candidate of a category of the shortlist the company sees, never the marked ones or another chosen set —
// brought to the intervals of `catalog_policy.salary_bins`, the counts rounded down to a multiple of the small-count
// threshold, and taken once a day: one candidate coming or leaving between two answers of a day changes nothing, and
// moving the range inside its interval changes nothing.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { categoryPredicate } from '$lib/server/categories/read';
import type { PolicyParams } from '$lib/server/consent/kinds';
import type { Database } from '$lib/server/db';
import { candidateAt, listedInCatalog } from '$lib/server/db/conditions';
import { candidates, salaryCohortSnapshots } from '$lib/server/db/schema';
import { requiredPolicy } from '$lib/server/invitations/policies';
import type { MatchingDeps } from '$lib/server/matching/deps';
import { visibleAmong } from '$lib/server/matching/search';
import { parsePreferences } from '$lib/server/candidates/preferences';
import type { NeedWorkFormat } from '$lib/server/matching/score';
import { z } from 'zod';

type SalaryBins = Extract<PolicyParams<'catalog_policy'>, { salary_bins: unknown }>['salary_bins'];
type TaxBase = 'gross' | 'net';

export interface SalaryInterval {
	index: number;
	from: number;
	/** Exclusive; `null` — the open last interval. */
	to: number | null;
}

/** The interval of the scale an amount of roubles per month falls into. */
export function intervalOf(bins: SalaryBins, amount: number): SalaryInterval {
	if (!Number.isFinite(amount) || amount < 0) throw new Error(`amount ${amount} is not on the scale`);
	let index = 0;
	let from = 0;
	for (const part of bins) {
		if (part.until === null || amount < part.until) {
			const steps = Math.floor((amount - from) / part.step);
			const start = from + steps * part.step;
			const end = start + part.step;
			return { index: index + steps, from: start, to: part.until === null || end <= part.until ? end : part.until };
		}
		index += (part.until - from) / part.step;
		from = part.until;
	}
	throw new Error('the scale of salary intervals has no open end');
}

/** A cohort as it is kept: counts of stated expectations by the interval of their lower bound, per tax base. */
const cohortSchema = z.strictObject({
	size: z.int().nonnegative(),
	stated: z.strictObject({ gross: z.int().nonnegative(), net: z.int().nonnegative() }),
	bins: z.strictObject({ gross: z.array(z.int().nonnegative()), net: z.array(z.int().nonnegative()) })
});

export type Cohort = z.infer<typeof cohortSchema>;

/** A count of an answer: a multiple of the threshold, or «fewer than the threshold». */
export type CohortCount = { value: number } | { below: number };

function rounded(count: number, threshold: number): CohortCount {
	return count < threshold ? { below: threshold } : { value: Math.floor(count / threshold) * threshold };
}

export interface SalaryAnswer {
	specialization: SpecializationKey;
	grade: GradeKey;
	tax_base: TaxBase;
	/** The interval the upper bound of the range falls into: the answer is the same anywhere inside it. */
	interval: { from: number; to: number | null };
	/** «Your range is not below the expectations of N of M»: M — candidates of the cohort who stated comparable ones. */
	not_below: CohortCount;
	of: CohortCount;
	/** The day of the snapshot the answer is from. */
	snapshot_date: string;
}

/** The answer of a cohort for a range; pure, so the test can try any series of ranges against one cohort. */
export function salaryAnswerOf(
	cohort: Cohort,
	bins: SalaryBins,
	threshold: number,
	range: { max: number; tax_base: TaxBase }
): Pick<SalaryAnswer, 'interval' | 'not_below' | 'of'> {
	const interval = intervalOf(bins, range.max);
	const counts = cohort.bins[range.tax_base];
	const notBelow = counts.slice(0, interval.index + 1).reduce((sum, count) => sum + count, 0);
	const of = cohort.stated[range.tax_base];
	return {
		interval: { from: interval.from, to: interval.to },
		// With fewer than the threshold stated, neither number is shown.
		not_below: of < threshold ? { below: threshold } : rounded(notBelow, threshold),
		of: rounded(of, threshold)
	};
}

const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/** The salary scale and the threshold in force; a catalog policy without the scale is a deployment defect. */
export async function salaryScale(
	executor: Database,
	now: Date
): Promise<{ bins: SalaryBins; threshold: number; version: number }> {
	const policy = await requiredPolicy(executor, 'catalog_policy', now);
	if (!('salary_bins' in policy.params)) {
		throw new Error(`catalog_policy version ${policy.version} has no salary_bins (domain 13.10)`);
	}
	return { bins: policy.params.salary_bins, threshold: policy.params.small_count_threshold, version: policy.version };
}

/**
 * The cohort of a category for the company on the day of `now`: read if taken, otherwise taken now from the candidates
 * of the category the company sees and kept for the day. Two requests taking it at once keep the first.
 */
export async function cohortOf(
	deps: MatchingDeps & { db: Database },
	subject: AccessSubject,
	companyId: string,
	category: { specialization: SpecializationKey; grade: GradeKey },
	now: Date
): Promise<{ cohort: Cohort; date: string }> {
	const date = utcDay(now);
	const key = and(
		eq(salaryCohortSnapshots.companyId, companyId),
		eq(salaryCohortSnapshots.specialization, category.specialization),
		eq(salaryCohortSnapshots.grade, category.grade),
		eq(salaryCohortSnapshots.snapshotDate, date)
	);
	const [kept] = await deps.db.select({ cohort: salaryCohortSnapshots.cohort }).from(salaryCohortSnapshots).where(key);
	if (kept) return { cohort: cohortSchema.parse(kept.cohort), date };

	const { bins, version } = await salaryScale(deps.db, now);
	const c = candidateAt('c');
	const members = await deps.db.execute<{ id: string }>(
		sql`select c.id::text as id from ${candidates} c where ${listedInCatalog(c)}
			and ${categoryPredicate(sql`c.id`, { specializations: [category.specialization], grades: [category.grade] })}`
	);
	const visible = [
		...(
			await visibleAmong(
				deps,
				subject,
				members.map((row) => row.id)
			)
		).keys()
	];
	const cohort: Cohort = { size: visible.length, stated: { gross: 0, net: 0 }, bins: { gross: [], net: [] } };
	if (visible.length > 0) {
		const rows = await deps.db
			.select({ id: candidates.id, preferences: candidates.preferences })
			.from(candidates)
			.where(inArray(candidates.id, visible));
		for (const row of rows) {
			const expectation = parsePreferences(row.id, row.preferences).salary_expectation;
			if (!expectation || expectation.currency !== 'RUB' || expectation.period !== 'month') continue;
			if (expectation.tax_base !== 'gross' && expectation.tax_base !== 'net') continue;
			const lower = expectation.min ?? expectation.max;
			if (lower === null) continue;
			const index = intervalOf(bins, lower).index;
			const counts = cohort.bins[expectation.tax_base];
			while (counts.length <= index) counts.push(0);
			counts[index] = (counts[index] ?? 0) + 1;
			cohort.stated[expectation.tax_base]++;
		}
	}
	await deps.db
		.insert(salaryCohortSnapshots)
		.values({ companyId, ...category, snapshotDate: date, policyVersion: version, cohort })
		.onConflictDoNothing();
	const [stored] = await deps.db
		.select({ cohort: salaryCohortSnapshots.cohort })
		.from(salaryCohortSnapshots)
		.where(key);
	if (!stored) throw new Error('the cohort snapshot was not kept');
	return { cohort: cohortSchema.parse(stored.cohort), date };
}

/** The range of the need against the cohort of each category of the shortlist. */
export async function salaryAnswers(
	deps: MatchingDeps & { db: Database },
	subject: AccessSubject,
	companyId: string,
	categories: readonly { specialization: SpecializationKey; grade: GradeKey }[],
	range: { max: number; tax_base: TaxBase },
	now: Date
): Promise<SalaryAnswer[]> {
	const { bins, threshold } = await salaryScale(deps.db, now);
	const answers: SalaryAnswer[] = [];
	for (const category of categories) {
		const { cohort, date } = await cohortOf(deps, subject, companyId, category, now);
		answers.push({
			...category,
			tax_base: range.tax_base,
			...salaryAnswerOf(cohort, bins, threshold, range),
			snapshot_date: date
		});
	}
	return answers;
}

/** Whether the offer suits the candidate by what the card shows (domain 13.10): yes, no or unknown, never values. */
export interface OfferFit {
	/** `null` — the need names no format. */
	format: 'yes' | 'no' | 'unknown' | null;
	/** `null` — the need names no region, or works remotely. */
	region: 'yes' | 'relocation' | 'no' | 'unknown' | null;
}

export function offerFit(
	need: { workFormat: NeedWorkFormat | null; regionCode: string | null },
	preferences: { workFormats: readonly string[]; regionCode: string | null; relocation: boolean | null }
): OfferFit {
	const format =
		need.workFormat === null
			? null
			: preferences.workFormats.length === 0
				? 'unknown'
				: preferences.workFormats.includes(need.workFormat)
					? 'yes'
					: 'no';
	let region: OfferFit['region'] = null;
	if (need.regionCode !== null && need.workFormat !== 'remote') {
		if (preferences.regionCode === need.regionCode) region = 'yes';
		else if (preferences.relocation === true) region = 'relocation';
		else if (preferences.regionCode === null) region = 'unknown';
		else region = 'no';
	}
	return { format, region };
}
