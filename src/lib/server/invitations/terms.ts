// Terms of an offer version (docs/domain.md, section 13.5): what the company offers — the title, the description, the
// range in roubles per month with the tax base it chose, the work format, how to reach the company and «why you» with
// the source of each point; the vacancy is optional and, when named, is copied into the version as it was. Sent terms
// never change: the differences of a later version are computed here. Pure functions and the shapes of the stored JSON.
import type { vacancies } from '$lib/server/db/schema';
import { canonicalJson } from '$lib/server/json/canonical';
import { compareSalary, type SalaryComparison, type SalaryTerms } from '$lib/server/salary/compare';

type VacancyRow = typeof vacancies.$inferSelect;

export const TITLE_MAX = 120;
export const DESCRIPTION_MIN = 50;
export const DESCRIPTION_MAX = 5000;
export const MESSAGE_MAX = 2000;
export const WHY_YOU_MIN = 1;
export const WHY_YOU_MAX = 5;
export const WHY_YOU_TEXT_MAX = 300;

/** Keys of the `work_format` dimension of the taxonomy: office, hybrid, remote. */
export const OFFER_WORK_FORMATS = ['office', 'hybrid', 'remote'] as const;

export const CONTACT_KINDS = ['email', 'phone', 'telegram', 'other'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** The contact of the company the candidate sees at once (`invitation_terms.contact_method`). */
export interface ContactMethod {
	kind: ContactKind;
	value: string;
	note: string | null;
}

export const WHY_YOU_SOURCES = [
	'test_block',
	'fsp_fact',
	'confirmation',
	'challenge_solution',
	'declared_skill',
	'preference'
] as const;
export type WhyYouSourceKind = (typeof WHY_YOU_SOURCES)[number];

/**
 * Preferences of the candidate a company sees on the card and may name as the source of a point; the salary
 * expectation is not among them — the company never sees it (domain 13.10).
 */
export const PREFERENCE_REFS = ['work_formats', 'employment_forms', 'region_code', 'relocation'] as const;

/** A point of «why you»: what the company saw in the profile and where (`invitation_terms.why_you`). */
export interface WhyYouPoint {
	text: string;
	source: { kind: WhyYouSourceKind; ref: string; receipt_handle?: string };
}

/** `invitation_terms.vacancy_snapshot`: the vacancy as the offer names it at this version. */
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

/** `invitation_terms.category`: the candidate's category at the version; `null` — no confirmed category. */
export interface CategorySnapshot {
	specialization: string;
	grade: string;
}

/** The offered range: both bounds in roubles per month and the tax base the employer chose. */
export interface OfferedSalary {
	min: number;
	max: number;
	currency: 'RUB';
	period: 'month';
	taxBase: 'gross' | 'net';
}

export const salaryTerms = (salary: OfferedSalary): SalaryTerms => ({ ...salary });

/** Everything a version offers; the stored row holds the same with its version number. */
export interface TermsContent {
	title: string;
	description: string;
	vacancy: { id: string; snapshot: VacancySnapshot } | null;
	category: CategorySnapshot | null;
	salary: OfferedSalary;
	workFormat: string;
	contactMethod: ContactMethod;
	whyYou: WhyYouPoint[];
	message: string | null;
}

export interface TermsVersionFacts extends TermsContent {
	version: number;
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
	/** `compareSalary(this version, previous version)`: `not_comparable` when the tax base changed. */
	salary_comparison: SalaryComparison;
	/** Lower than any earlier version of the same tax base: «below a previous offer of this company». */
	salary_lowered: boolean;
	lowered_against_versions: number[];
}

/** Equal values whatever the order of keys: a version read back from `jsonb` has its keys in the database's order. */
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** The compared fields of a version; the category is a fact about the candidate, not a term the company changes. */
function flatten(terms: TermsContent): Record<string, unknown> {
	return {
		title: terms.title,
		description: terms.description,
		vacancy_id: terms.vacancy?.id ?? null,
		...(terms.vacancy
			? Object.fromEntries(Object.entries(terms.vacancy.snapshot).map(([key, value]) => [`vacancy.${key}`, value]))
			: {}),
		salary_min: terms.salary.min,
		salary_max: terms.salary.max,
		salary_tax_base: terms.salary.taxBase,
		work_format: terms.workFormat,
		contact_method: terms.contactMethod,
		why_you: terms.whyYou,
		message: terms.message
	};
}

/**
 * A lower offer than version `earlier`: the same tax base (otherwise ranges are not compared at all) and a lower bound
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
export function termsChanges(next: TermsContent, history: readonly TermsVersionFacts[]): TermsChanges {
	const previous = history.at(-1);
	if (!previous) throw new Error('changes are computed against at least one earlier version');
	const before = flatten(previous);
	const after = flatten(next);
	const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
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
