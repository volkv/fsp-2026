// Periods of experience as resumes write them (docs/domain.md, section 9.5): «Март 2021 — настоящее время»,
// «01.2022 – н. в.», «10/2022 – по наст. время», «2019 — 2021». A date is known to the month or to the year; a start
// known to the year is stored as January and an end as December, so a period inside one year stays ordered and the
// length calculation reads the year range from the precision.

export type DatePrecision = 'month' | 'year';

export interface PeriodDate {
	/** ISO date, the first day of the month. */
	date: string;
	precision: DatePrecision;
}

export interface ParsedPeriod {
	from: PeriodDate | null;
	to: PeriodDate | null;
	isCurrent: boolean;
	status: 'valid' | 'missing' | 'invalid';
}

const MONTH_STEMS: readonly [RegExp, number][] = [
	[/^(январ|янв|jan)/u, 1],
	[/^(феврал|фев|feb)/u, 2],
	[/^(март|мар|mar)/u, 3],
	[/^(апрел|апр|apr)/u, 4],
	[/^(ма[йя]|may)/u, 5],
	[/^(июн|jun)/u, 6],
	[/^(июл|jul)/u, 7],
	[/^(август|авг|aug)/u, 8],
	[/^(сентябр|сен|sep)/u, 9],
	[/^(октябр|окт|oct)/u, 10],
	[/^(ноябр|ноя|nov)/u, 11],
	[/^(декабр|дек|dec)/u, 12]
];

const MONTH_WORD =
	'(?:январ[ьяе]|янв|феврал[ьяе]|фев|март[а]?|мар|апрел[ьяе]|апр|ма[йя]|июн[ьяе]|июл[ьяе]|август[а]?|авг|сентябр[ьяе]|сент?|октябр[ьяе]|окт|ноябр[ьяе]|ноя|декабр[ьяе]|дек|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept?|october|oct|november|nov|december|dec)\\.?';
const YEAR = '(?:19|20)\\d{2}';
const DATE = `(?:${MONTH_WORD}\\s+${YEAR}|(?:0?[1-9]|1[0-2])[./](?:${YEAR})|${YEAR}[./-](?:0[1-9]|1[0-2])|${YEAR})`;
const PRESENT =
	'(?:(?:по\\s+)?настоящ\\p{L}*(?:\\s+врем\\p{L}*)?|(?:по\\s+)?наст\\.?\\s*(?:вр\\.?|время)?|н\\.\\s*в\\.?|сейчас|до\\s+сих\\s+пор|present|now|current|today)';
const DASH = '\\s*(?:[—–‒-]+|по|до|to|until)\\s*';

/** A period in running text: a date, a dash and a date or «по настоящее время». */
export const PERIOD_PATTERN = new RegExp(
	`(?<![\\p{L}\\p{N}])(${DATE})${DASH}(${DATE}|${PRESENT})(?![\\p{L}\\p{N}])`,
	'giu'
);

const PRESENT_ONLY = new RegExp(`^${PRESENT}$`, 'iu');
const MONTH_YEAR = new RegExp(`^(${MONTH_WORD})\\s+(${YEAR})$`, 'iu');
const NUMERIC_MONTH_YEAR = new RegExp(`^(0?[1-9]|1[0-2])[./](${YEAR})$`, 'u');
const YEAR_NUMERIC_MONTH = new RegExp(`^(${YEAR})[./-](0[1-9]|1[0-2])$`, 'u');
const YEAR_ONLY = new RegExp(`^(${YEAR})$`, 'u');

const pad = (value: number) => String(value).padStart(2, '0');

function monthOf(word: string): number | null {
	const lower = word.toLocaleLowerCase('ru').replace(/\.$/u, '');
	return MONTH_STEMS.find(([stem]) => stem.test(lower))?.[1] ?? null;
}

/** «по настоящее время», «н. в.», «present». */
export function isPresent(text: string): boolean {
	return PRESENT_ONLY.test(text.trim().replace(/\s+/gu, ' '));
}

/** A single date as written; `end` stores a year-only date as December. `null` — not a date. */
export function parseDate(text: string, end: boolean): PeriodDate | null {
	const value = text.trim().replace(/\s+/gu, ' ');
	let match = MONTH_YEAR.exec(value);
	if (match?.[1] && match[2]) {
		const month = monthOf(match[1]);
		return month === null ? null : { date: `${match[2]}-${pad(month)}-01`, precision: 'month' };
	}
	match = NUMERIC_MONTH_YEAR.exec(value);
	if (match?.[1] && match[2]) return { date: `${match[2]}-${pad(Number(match[1]))}-01`, precision: 'month' };
	match = YEAR_NUMERIC_MONTH.exec(value);
	if (match?.[1] && match[2]) return { date: `${match[1]}-${match[2]}-01`, precision: 'month' };
	match = YEAR_ONLY.exec(value);
	if (match?.[1]) return { date: `${match[1]}-${end ? '12' : '01'}-01`, precision: 'year' };
	return null;
}

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/**
 * A period from its two ends as written. No start — `missing`; an end before the start or a start in the future —
 * `invalid` (domain 9.5). A year-precision end in the current year is not a future date.
 */
export function parsePeriod(fromText: string | null, toText: string | null, asOf: Date): ParsedPeriod {
	const from = fromText === null ? null : parseDate(fromText, false);
	const current = toText !== null && isPresent(toText);
	const to = toText === null || current ? null : parseDate(toText, true);
	if (from === null) return { from: null, to, isCurrent: current, status: 'missing' };
	if (to === null && !current) return { from, to: null, isCurrent: false, status: 'missing' };
	const now = asOf.getUTCFullYear() * 12 + asOf.getUTCMonth();
	const start = monthIndex(from.date);
	const endIndex = to === null ? now : monthIndex(to.date);
	const endLimit = to?.precision === 'year' ? Math.floor(now / 12) * 12 + 11 : now;
	if (start > now || endIndex < start || endIndex > endLimit) {
		return { from, to, isCurrent: current, status: 'invalid' };
	}
	return { from, to, isCurrent: current, status: 'valid' };
}
