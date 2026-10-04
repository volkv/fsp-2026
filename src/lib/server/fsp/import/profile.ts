// Mapping profile of a results batch (docs/contracts.md 1.7): which columns of a table (CSV, XLSX) or of a PDF protocol
// hold which field of the results model, how source values map to its codes, and what is fixed for the whole batch.
// A profile is JSON written for one export format; it names columns by their headers, never by position.
import { z } from 'zod';
import { AWARDS } from '$lib/fsp/awards';
import {
	AGE_GROUPS,
	COMPETITION_LEVELS,
	DISCIPLINE_CODES,
	EVSK_RANKS,
	RESULT_STATUSES,
	STAGES,
	TEAM_ROLES
} from '../types';

/** Fields a column can hold. `fspId` is the only one that ties a row to a person of the platform. */
const ROW_FIELDS = [
	'fspId',
	'fullName',
	'birthYear',
	'region',
	'resultId',
	'competitionId',
	'competitionTitle',
	'ekpNumber',
	'discipline',
	'level',
	'stage',
	'ageGroup',
	'format',
	'online',
	'startDate',
	'endDate',
	'location',
	'protocolUrl',
	'place',
	'placeOf',
	'score',
	'solved',
	'penaltyMinutes',
	'status',
	'award',
	'evskFulfilled',
	'team',
	'teamId',
	'role',
	'specialization',
	'publishedAt'
] as const;
export type RowField = (typeof ROW_FIELDS)[number];

/**
 * Fields whose source values are mapped to codes through `values`, with the codes each accepts; a source value maps
 * to one of them or, for `Known` fields, to `unknown`.
 */
export const FIELD_CODES = {
	discipline: DISCIPLINE_CODES,
	level: COMPETITION_LEVELS,
	stage: STAGES,
	ageGroup: AGE_GROUPS,
	format: ['individual', 'team'],
	online: ['true', 'false'],
	status: RESULT_STATUSES,
	award: AWARDS,
	evskFulfilled: EVSK_RANKS,
	role: TEAM_ROLES
} as const;
export type CodedField = keyof typeof FIELD_CODES;

/** Coded fields that are `Known<…>` in the model: an unmapped value becomes `unknown` and is kept in `rawValues`. */
export const KNOWN_FIELDS: ReadonlySet<CodedField> = new Set([
	'discipline',
	'level',
	'stage',
	'ageGroup',
	'award',
	'role'
]);

const header = z.string().trim().min(1);
const columnRef = z.union([header, z.array(header).min(1)]);

const competitionFixed = z.strictObject({
	id: z.string().min(1).optional(),
	title: z.string().min(1).optional(),
	ekpNumber: z
		.string()
		.regex(/^\d{16}$/)
		.optional(),
	discipline: z.enum(DISCIPLINE_CODES).optional(),
	level: z.enum(COMPETITION_LEVELS).optional(),
	stage: z.enum(STAGES).optional(),
	ageGroup: z.enum(AGE_GROUPS).optional(),
	format: z.enum(['individual', 'team']).optional(),
	online: z.boolean().optional(),
	startDate: z.iso.date().optional(),
	endDate: z.iso.date().optional(),
	location: z.string().min(1).optional(),
	protocolUrl: z.url().optional()
});
export type CompetitionFixed = z.infer<typeof competitionFixed>;

const codeMap = <const T extends readonly [string, ...string[]]>(codes: T) =>
	z.record(header, z.enum(codes)).optional();

/** Source values of coded fields mapped to codes; a code itself is always accepted as is. */
const valueMaps = z.strictObject({
	discipline: codeMap(DISCIPLINE_CODES),
	level: codeMap(COMPETITION_LEVELS),
	stage: codeMap(STAGES),
	ageGroup: codeMap(AGE_GROUPS),
	format: codeMap(['individual', 'team']),
	online: z.record(header, z.boolean()).optional(),
	status: codeMap(RESULT_STATUSES),
	award: codeMap(AWARDS),
	evskFulfilled: codeMap(EVSK_RANKS),
	role: codeMap(TEAM_ROLES)
});

/** Names of the capture groups of a row pattern: the fields they hold. */
const PATTERN_GROUP = /\(\?<([A-Za-z][A-Za-z0-9]*)>/g;

const profileSchema = z
	.strictObject({
		/** Name of the export format, reported with the batch. */
		name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
		columns: z.partialRecord(z.enum(ROW_FIELDS), columnRef),
		values: valueMaps.default({}),
		/** Values of the whole batch: a protocol or an export of one competition. A column, when mapped, wins. */
		competition: competitionFixed.default({}),
		defaults: z.strictObject({ status: z.enum(RESULT_STATUSES).optional() }).default({}),
		/** Cell values that stand for an empty cell in any column, such as a dash. */
		blank: z.array(header).default([]),
		/** Cell values meaning «no place assigned» (out of competition, disqualified); an empty cell means it too. */
		noPlace: z.array(header).default([]),
		csv: z
			.strictObject({
				delimiter: z.enum([';', ',', '\t']).optional(),
				encoding: z.enum(['utf-8', 'windows-1251']).default('utf-8')
			})
			.default({ encoding: 'utf-8' }),
		/** 1-based row of the header in a CSV or XLSX; rows above it are titles and are not read. */
		headerRow: z.int().min(1).default(1),
		xlsx: z.strictObject({ sheet: header.optional() }).default({}),
		pdf: z
			.strictObject({
				/**
				 * A row of a protocol as a regular expression, for protocols whose table the header names of `columns`
				 * do not find: over the cells of a table row joined by a tab, or, when the parser found no tables (a scan
				 * read by OCR), over a line of text. Named groups are fields (`(?<place>\d+)\t(?<fspId>\S+)`).
				 */
				rowPattern: z.string().min(1).optional()
			})
			.default({})
	})
	.superRefine((profile, context) => {
		const problem = (message: string, path: (string | number)[]) => {
			context.addIssue({ code: 'custom', message, path });
		};
		const pattern = profile.pdf.rowPattern;
		if (pattern !== undefined) {
			try {
				new RegExp(pattern, 'u');
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				problem('rowPattern — не регулярное выражение', ['pdf', 'rowPattern']);
			}
			for (const [, name] of pattern.matchAll(PATTERN_GROUP)) {
				if (!(ROW_FIELDS as readonly string[]).includes(name ?? '')) {
					problem(`группа ${name} в rowPattern — не поле модели`, ['pdf', 'rowPattern']);
				}
			}
		}
		const headers = new Map<string, string>();
		for (const [field, ref] of Object.entries(profile.columns)) {
			for (const name of typeof ref === 'string' ? [ref] : ref) {
				const key = normalizeHeader(name);
				const other = headers.get(key);
				if (other !== undefined && other !== field) {
					problem(`заголовок «${name}» сопоставлен сразу полям ${other} и ${field}`, ['columns', field]);
				}
				headers.set(key, field);
			}
		}
	});

export type MappingProfile = z.infer<typeof profileSchema>;

/** Row fields a profile reads from the batch: its mapped columns, or the named groups of its row pattern. */
export function patternFields(pattern: string): RowField[] {
	return [...pattern.matchAll(PATTERN_GROUP)].map(([, name]) => name as RowField);
}

/** The key under which headers and source values are compared: case, «ё» and spacing do not matter. */
export function normalizeHeader(value: string): string {
	return value.normalize('NFC').toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();
}

type ProfileParse = { ok: true; profile: MappingProfile } | { ok: false; issues: string[] };

const ru = z.locales.ru();

/** Parses a profile from its JSON value; every problem is reported with its path, in the operator's language. */
export function parseProfile(value: unknown): ProfileParse {
	const parsed = profileSchema.safeParse(value, { error: ru.localeError });
	if (parsed.success) return { ok: true, profile: parsed.data };
	return {
		ok: false,
		issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(профиль)'}: ${issue.message}`)
	};
}
