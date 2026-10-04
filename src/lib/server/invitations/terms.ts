// Terms of an invitation version (docs/domain.md, section 13.5): what the vacancy was at the version, the offered range
// in the currency, period and tax base of the vacancy, and the differences from the previous version. Pure functions.
import type { vacancies } from '$lib/server/db/schema';
import { compareSalary, type SalaryComparison, type SalaryTerms } from '$lib/server/salary/compare';

type VacancyRow = typeof vacancies.$inferSelect;

/** `invitation_terms.vacancy_snapshot`: the vacancy as the candidate is offered it at this version. */
export interface VacancySnapshot {
	title: string;
	role_key: string | null;
	grade_min: string | null;
	grade_max: string | null;
	work_format: string | null;
	employment_form: string | null;
	contract_types: string[] | null;
	city_id: string | null;
	timezone_overlap_hours: number | null;
	required_skill_keys: string[];
	nice_skill_keys: string[];
	min_age: number | null;
	revision: number;
}

export function vacancySnapshotOf(vacancy: VacancyRow): VacancySnapshot {
	return {
		title: vacancy.title,
		role_key: vacancy.roleKey,
		grade_min: vacancy.gradeMin,
		grade_max: vacancy.gradeMax,
		work_format: vacancy.workFormat,
		employment_form: vacancy.employmentForm,
		contract_types: vacancy.contractTypes,
		city_id: vacancy.cityId,
		timezone_overlap_hours: vacancy.timezoneOverlapHours,
		required_skill_keys: vacancy.requiredSkillKeys,
		nice_skill_keys: vacancy.niceSkillKeys,
		min_age: vacancy.minAge,
		revision: vacancy.revision
	};
}

/** A full offered range: both bounds and the unit of the vacancy with a known tax base. */
export interface OfferedSalary {
	min: number;
	max: number;
	currency: string;
	period: 'month' | 'year' | 'hour' | 'project';
	taxBase: 'gross' | 'net';
}

/**
 * The offered bounds in the unit of the vacancy: currency, period and tax base are copied from the vacancy and are not
 * chosen separately. `null` — the vacancy has no full unit, which `isInvitable` has already refused.
 */
export function offeredSalary(vacancy: VacancyRow, min: number, max: number): OfferedSalary | null {
	const { salaryCurrency: currency, salaryPeriod: period, salaryTaxBase: taxBase } = vacancy;
	if (currency === null || period === null || (taxBase !== 'gross' && taxBase !== 'net')) return null;
	return { min, max, currency, period, taxBase };
}

export const salaryTerms = (salary: OfferedSalary): SalaryTerms => ({ ...salary });

/** One stored version as the difference is computed from. */
export interface TermsVersionFacts {
	version: number;
	snapshot: VacancySnapshot;
	salary: OfferedSalary;
	message: string | null;
}

export interface FieldChange {
	field: string;
	from: unknown;
	to: unknown;
}

/** `invitation_terms.changes` of a version after the first. */
export interface TermsChanges {
	previous_version: number;
	fields: FieldChange[];
	/** `compareSalary(this version, previous version)`: `not_comparable` when the unit changed. */
	salary_comparison: SalaryComparison;
	/** Lower than any earlier version of the same unit: «below a previous offer of this company». */
	salary_lowered: boolean;
	lowered_against_versions: number[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function flatten(terms: Omit<TermsVersionFacts, 'version'>): Record<string, unknown> {
	return {
		...Object.fromEntries(Object.entries(terms.snapshot).map(([key, value]) => [`vacancy.${key}`, value])),
		salary_min: terms.salary.min,
		salary_max: terms.salary.max,
		salary_currency: terms.salary.currency,
		salary_period: terms.salary.period,
		salary_tax_base: terms.salary.taxBase,
		message: terms.message
	};
}

/**
 * A lower offer than version `earlier`: the same unit (otherwise ranges are not compared at all) and a lower bound
 * or an upper bound below the earlier one.
 */
function lowerThan(next: OfferedSalary, earlier: OfferedSalary): boolean {
	if (compareSalary(salaryTerms(next), salaryTerms(earlier)) === 'not_comparable') return false;
	return next.min < earlier.min || next.max < earlier.max;
}

/**
 * Differences of the next version from the last of `history` (ordered by version), with the salary compared by
 * `compareSalary` and the lowering marked against every earlier version, so «withdraw and send lower» shows as lower.
 */
export function termsChanges(
	next: Omit<TermsVersionFacts, 'version'>,
	history: readonly TermsVersionFacts[]
): TermsChanges {
	const previous = history.at(-1);
	if (!previous) throw new Error('changes are computed against at least one earlier version');
	const before = flatten(previous);
	const after = flatten(next);
	const fields = Object.keys(after)
		.filter((field) => !same(before[field], after[field]))
		.map((field) => ({ field, from: before[field] ?? null, to: after[field] ?? null }));
	const loweredAgainst = history.filter((earlier) => lowerThan(next.salary, earlier.salary)).map((e) => e.version);
	return {
		previous_version: previous.version,
		fields,
		salary_comparison: compareSalary(salaryTerms(next.salary), salaryTerms(previous.salary)),
		salary_lowered: loweredAgainst.length > 0,
		lowered_against_versions: loweredAgainst
	};
}
