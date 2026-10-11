// Age regime computed at the moment of the request (docs/domain.md, section 7.2).

export type AgeBand = 'unknown' | 'under_14' | 14 | 15 | 16 | 17 | 'adult';

export interface BirthDateInfo {
	/** `YYYY-MM-DD`; with `year` precision only the year is meaningful. */
	birthDate: string | null;
	precision: 'day' | 'year' | null;
	status: 'unknown' | 'unverified' | 'verified' | 'conflict';
}

/** Ages at which the regime changes: 14 (profile), 15 and 16 (`min_age` of vacancies), 18 (majority). */
const BOUNDARIES = [14, 15, 16, 18] as const;

function parseDate(value: string): { year: number; month: number; day: number } {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) throw new Error(`birth date must be YYYY-MM-DD, got a value of length ${value.length}`);
	return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Full years on the UTC calendar date of `at` for a person born on `month`/`day` of `year`. */
function fullYears(year: number, month: number, day: number, at: Date): number {
	const years = at.getUTCFullYear() - year;
	const beforeBirthday = at.getUTCMonth() + 1 < month || (at.getUTCMonth() + 1 === month && at.getUTCDate() < day);
	return beforeBirthday ? years - 1 : years;
}

function band(age: number): AgeBand {
	if (age < 14) return 'under_14';
	if (age >= 18) return 'adult';
	return age as 14 | 15 | 16 | 17;
}

/**
 * `ageBand(candidate, at)`: unknown for an unknown or conflicting date; with year precision the range of possible
 * ages must not cross a regime boundary, otherwise unknown; else the band of the full years at `at`.
 */
export function ageBand(info: BirthDateInfo, at: Date): AgeBand {
	if (info.birthDate === null || info.status === 'unknown' || info.status === 'conflict') return 'unknown';
	const { year, month, day } = parseDate(info.birthDate);
	if (info.precision === 'year') {
		const youngest = fullYears(year, 12, 31, at);
		const oldest = fullYears(year, 1, 1, at);
		if (BOUNDARIES.some((boundary) => youngest < boundary && boundary <= oldest)) return 'unknown';
		return band(youngest);
	}
	if (info.precision !== 'day') throw new Error('birth date without precision');
	return band(fullYears(year, month, day, at));
}

/** `is_minor` as shown to employers: ages 14–17. */
export function isMinorBand(value: AgeBand): value is 14 | 15 | 16 | 17 {
	return typeof value === 'number';
}

/**
 * Age groups of the bias audit of the quality panel: the minors, adults by decade-like bands, and those whose age is
 * not known. Never shown per person — only as counts of a group.
 */
export const AGE_GROUPS = ['minor', '18_24', '25_34', '35_44', '45_plus', 'unknown'] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

const ADULT_BOUNDARIES = [25, 35, 45] as const;

function adultGroup(age: number): AgeGroup {
	if (age < 25) return '18_24';
	if (age < 35) return '25_34';
	if (age < 45) return '35_44';
	return '45_plus';
}

/**
 * The age group at `at`: the regime of `ageBand` first (unknown stays unknown, every band under 18 is `minor`); for an
 * adult with year precision a range of possible ages that crosses a boundary of the groups is `unknown`.
 */
export function ageGroup(info: BirthDateInfo, at: Date): AgeGroup {
	const regime = ageBand(info, at);
	if (regime === 'unknown') return 'unknown';
	if (regime !== 'adult') return 'minor';
	if (info.birthDate === null) throw new Error('an adult band without a birth date');
	const { year, month, day } = parseDate(info.birthDate);
	if (info.precision === 'year') {
		const youngest = fullYears(year, 12, 31, at);
		const oldest = fullYears(year, 1, 1, at);
		if (ADULT_BOUNDARIES.some((boundary) => youngest < boundary && boundary <= oldest)) return 'unknown';
		return adultGroup(youngest);
	}
	return adultGroup(fullYears(year, month, day, at));
}
