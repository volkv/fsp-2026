// A read table through a mapping profile → competitions and result rows of the model (docs/contracts.md 1.3, 1.7).
// Every row either becomes a result or is reported with its number, the column and the reason: nothing is dropped
// quietly. Unknown values of `Known` fields become `unknown` with the source string in `rawValues`, as in the API
// variant; values of other coded fields must map.
import { canonicalJson } from '$lib/server/json/canonical';
import { sha256Hex } from '../projection';
import type { Competition, Result, ResultTeam } from '../types';
import {
	FIELD_CODES,
	KNOWN_FIELDS,
	normalizeHeader,
	type CodedField,
	type CompetitionFixed,
	type MappingProfile,
	type RowField
} from './profile';
import { BatchFormatError, type SourceRow, type SourceTable } from './table';

type RowIssueCode =
	| 'required'
	| 'invalid_number'
	| 'invalid_date'
	| 'invalid_value'
	| 'unknown_value'
	| 'cell_error'
	| 'no_participant'
	| 'duplicate_result'
	| 'competition_conflict'
	| 'athlete_conflict'
	| 'row_shape';

/** A problem of one row. The message names the column and the rule, never a person's data from the cell. */
export interface RowIssue {
	row: number;
	page?: number;
	column: string | null;
	code: RowIssueCode;
	message: string;
}

export interface BatchRow {
	/** ID of the result record at the source (contracts 1.7). */
	recordId: string;
	rowNumber: number;
	page?: number;
	competitionId: string;
	/** Who the row is about. Only `fspId` ties it to a person of the platform; the rest is never stored. */
	participant: { fspId?: string; fullName?: string; birthYear?: number | null; region?: string };
	result: Omit<Result, 'id' | 'competitionId'>;
}

export interface MappedRows {
	competitions: Competition[];
	rows: BatchRow[];
	issues: RowIssue[];
	/** Data rows the table had: mapped and reported together. */
	rowsRead: number;
}

/**
 * What the batch says about its competition outside the table, such as the heading of a protocol: codes (or
 * `unknown` with the source string in `rawValues`) and texts by the fields of `CompetitionFixed`.
 */
export type CompetitionHints = Partial<Record<Exclude<keyof CompetitionFixed, 'online'>, string>> & {
	online?: boolean;
	rawValues?: Record<string, string>;
};

interface MappingInput {
	table: SourceTable;
	profile: MappingProfile;
	/**
	 * How a row without its own result ID is keyed: an export row by the athlete and the competition (stable across
	 * exports), a protocol row by the protocol edition and the row (contracts 1.7). An export row without the FSP ID
	 * reaches no one and is keyed by the file and the row.
	 */
	recordKey: { kind: 'athlete' | 'protocol'; sha256: string };
	hints?: CompetitionHints;
	/** A column per field, when the table's header already is the fields (a protocol read by a row pattern). */
	columns?: Partial<Record<RowField, number>>;
}

/** Fields without which a result cannot be stated: from a column, the profile or the batch itself. */
const REQUIRED: readonly { field: RowField; fixed: keyof CompetitionFixed | 'status' }[] = [
	{ field: 'competitionTitle', fixed: 'title' },
	{ field: 'startDate', fixed: 'startDate' },
	{ field: 'discipline', fixed: 'discipline' },
	{ field: 'level', fixed: 'level' },
	{ field: 'status', fixed: 'status' }
];

class RowFailure extends Error {
	readonly issue: Omit<RowIssue, 'row' | 'page'>;
	constructor(issue: Omit<RowIssue, 'row' | 'page'>) {
		super(issue.message);
		this.issue = issue;
	}
}

function resolveColumns(table: SourceTable, profile: MappingProfile): Partial<Record<RowField, number>> {
	const index = new Map<string, number>();
	table.header.forEach((name, i) => {
		const key = normalizeHeader(name);
		if (key === '') return;
		if (index.has(key)) throw new BatchFormatError('mapping_required', `заголовок «${name}» повторяется`);
		index.set(key, i);
	});
	const columns: Partial<Record<RowField, number>> = {};
	const missing: string[] = [];
	for (const [field, ref] of Object.entries(profile.columns) as [RowField, string | string[]][]) {
		const names = typeof ref === 'string' ? [ref] : ref;
		const found = names.map((n) => index.get(normalizeHeader(n))).filter((i) => i !== undefined);
		if (found.length === 0) missing.push(`${field} («${names.join('» / «')}»)`);
		else if (found.length > 1) {
			throw new BatchFormatError('mapping_required', `поле ${field} подходит к нескольким заголовкам таблицы`);
		} else columns[field] = found[0];
	}
	if (missing.length > 0) {
		throw new BatchFormatError('mapping_required', `в таблице нет колонок: ${missing.join(', ')}`);
	}
	return columns;
}

const DAY_MS = 86_400_000;

function isoDate(year: number, month: number, day: number): string | null {
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date.toISOString().slice(0, 10);
}

class RowReader {
	readonly #row: SourceRow;
	readonly #table: SourceTable;
	readonly #columns: Partial<Record<RowField, number>>;
	readonly #profile: MappingProfile;
	readonly #blank: ReadonlySet<string>;

	constructor(row: SourceRow, table: SourceTable, columns: Partial<Record<RowField, number>>, profile: MappingProfile) {
		this.#row = row;
		this.#table = table;
		this.#columns = columns;
		this.#profile = profile;
		this.#blank = new Set(profile.blank.map(normalizeHeader));
	}

	/** The header of the field's column; `null` when the value came from elsewhere (the profile, the batch). */
	header(field: RowField): string | null {
		const index = this.#columns[field];
		return index === undefined ? null : (this.#table.header[index] ?? null);
	}

	fail(field: RowField | null, code: RowIssueCode, message: string): never {
		throw new RowFailure({ column: field === null ? null : this.header(field), code, message });
	}

	/** The trimmed cell of a field, or `undefined` when the field has no column or the cell is empty. */
	get(field: RowField): string | undefined {
		const index = this.#columns[field];
		if (index === undefined) return undefined;
		if (this.#row.cellErrors?.includes(index)) this.fail(field, 'cell_error', 'в ячейке ошибка формулы таблицы');
		const value = (this.#row.cells[index] ?? '').replace(/\u00a0/g, ' ').trim();
		return value === '' || this.#blank.has(normalizeHeader(value)) ? undefined : value;
	}

	int(field: RowField, min: number): number | undefined {
		const value = this.get(field);
		if (value === undefined) return undefined;
		const digits = value.replace(/\.$/, '');
		if (!/^\d{1,9}$/.test(digits) || Number(digits) < min) {
			this.fail(field, 'invalid_number', `нужно целое число не меньше ${min}`);
		}
		return Number(digits);
	}

	number(field: RowField): number | undefined {
		const value = this.get(field);
		if (value === undefined) return undefined;
		const text = value.replace(/\s/g, '').replace(',', '.');
		if (!/^-?\d+(\.\d+)?$/.test(text)) this.fail(field, 'invalid_number', 'нужно число');
		return Number(text);
	}

	date(field: RowField): string | undefined {
		const value = this.get(field);
		if (value === undefined) return undefined;
		let date: string | null = null;
		const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
		const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(\s*г\.?)?$/.exec(value);
		if (iso) date = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
		else if (dotted) date = isoDate(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]));
		else if (this.#table.serialDates && /^\d{1,6}(\.\d+)?$/.test(value)) {
			// Serial day of a spreadsheet: days since 1899-12-30 (the 1900 epoch, past its phantom leap day) or 1904-01-01.
			const epoch = this.#table.serialDates.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
			const serial = Math.floor(Number(value));
			if (this.#table.serialDates.date1904 || serial > 60) {
				date = new Date(epoch + serial * DAY_MS).toISOString().slice(0, 10);
			}
		}
		if (date === null) this.fail(field, 'invalid_date', 'нужна существующая дата: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ');
		return date;
	}

	/** A coded value: the code itself or a value of the profile's map; unknown ones by the rules of the field. */
	coded(field: CodedField, raw: Record<string, string>): string | undefined {
		const value = this.get(field);
		if (value === undefined) return undefined;
		return codeOf(field, value, this.#profile, raw, (message) => this.fail(field, 'unknown_value', message));
	}
}

/** The code of a source value by the profile; `fail` is called for an unmapped value of a field that is not `Known`. */
export function codeOf(
	field: CodedField,
	value: string,
	profile: MappingProfile,
	raw: Record<string, string>,
	fail: (message: string) => never
): string {
	const key = normalizeHeader(value);
	const codes: readonly string[] = FIELD_CODES[field];
	const direct = codes.find((code) => code.toLowerCase() === key);
	if (direct !== undefined) return direct;
	const map = profile.values[field] as Record<string, string | boolean> | undefined;
	const mapped = map && Object.entries(map).find(([name]) => normalizeHeader(name) === key)?.[1];
	if (mapped !== undefined) return String(mapped);
	if (KNOWN_FIELDS.has(field)) {
		raw[field] = value;
		return 'unknown';
	}
	// Coded values are the source's vocabulary, not a person's data: the value is named for the operator.
	return fail(`значение «${value}» не сопоставлено (добавьте его в values.${field} профиля)`);
}

/** Stable identifier of a competition the source does not number: its EKP number, or its title and start. */
function derivedCompetitionId(ekpNumber: string | null, title: string, startDate: string): string {
	if (ekpNumber !== null) return `ekp:${ekpNumber}`;
	return `title:${sha256Hex(`${normalizeHeader(title)}|${startDate}`).slice(0, 24)}`;
}

function readRow(
	reader: RowReader,
	row: SourceRow,
	input: MappingInput
): { competition: Competition; batchRow: BatchRow } {
	const { profile, hints = {} } = input;
	const fixed: CompetitionHints = { ...hints, ...profile.competition };
	const rawCompetition: Record<string, string> = { ...(hints.rawValues ?? {}) };
	const rawResult: Record<string, string> = {};

	const title = reader.get('competitionTitle') ?? fixed.title;
	if (title === undefined) reader.fail('competitionTitle', 'required', 'не указано название соревнования');
	const startDate = reader.date('startDate') ?? fixed.startDate;
	if (startDate === undefined) reader.fail('startDate', 'required', 'не указана дата начала');
	const endDate = reader.date('endDate') ?? fixed.endDate;
	if (endDate !== undefined && endDate < startDate)
		reader.fail('endDate', 'invalid_date', 'дата окончания раньше даты начала');
	const ekpRaw = reader.get('ekpNumber');
	if (ekpRaw !== undefined && !/^\d{16}$/.test(ekpRaw)) {
		reader.fail('ekpNumber', 'invalid_value', 'номер ЕКП — 16 цифр (храните колонку как текст)');
	}
	const ekpNumber = ekpRaw ?? fixed.ekpNumber ?? null;
	const discipline = reader.coded('discipline', rawCompetition) ?? fixed.discipline;
	if (discipline === undefined) reader.fail('discipline', 'required', 'не указана дисциплина');
	const level = reader.coded('level', rawCompetition) ?? fixed.level;
	if (level === undefined) reader.fail('level', 'required', 'не указан статус соревнования');
	const stage = reader.coded('stage', rawCompetition) ?? fixed.stage;
	const ageGroup = reader.coded('ageGroup', rawCompetition) ?? fixed.ageGroup;
	const format = reader.coded('format', rawCompetition) ?? fixed.format;
	const onlineCode = reader.coded('online', rawCompetition);
	const online = onlineCode === undefined ? fixed.online : onlineCode === 'true';
	const location = reader.get('location') ?? fixed.location;
	const protocolUrl = reader.get('protocolUrl') ?? fixed.protocolUrl;
	if (protocolUrl !== undefined && !URL.canParse(protocolUrl)) {
		reader.fail('protocolUrl', 'invalid_value', 'нужна полная ссылка (https://…)');
	}
	const competitionId = reader.get('competitionId') ?? fixed.id ?? derivedCompetitionId(ekpNumber, title, startDate);
	// What the batch said outside the table stays raw only where its value is the one the competition keeps.
	const kept: Record<string, unknown> = { discipline, level, stage, ageGroup };
	for (const key of Object.keys(hints.rawValues ?? {})) {
		if (kept[key] !== 'unknown') Reflect.deleteProperty(rawCompetition, key);
	}

	const competition: Competition = {
		id: competitionId,
		ekpNumber,
		title,
		discipline: discipline as Competition['discipline'],
		level: level as Competition['level'],
		...(stage !== undefined ? { stage: stage as NonNullable<Competition['stage']> } : {}),
		...(ageGroup !== undefined ? { ageGroup: ageGroup as NonNullable<Competition['ageGroup']> } : {}),
		...(format !== undefined ? { format: format as 'individual' | 'team' } : {}),
		startDate,
		...(endDate !== undefined ? { endDate } : {}),
		...(location !== undefined ? { location } : {}),
		...(online !== undefined ? { online } : {}),
		...(protocolUrl !== undefined ? { protocolUrl } : {}),
		...(Object.keys(rawCompetition).length > 0 ? { rawValues: rawCompetition } : {})
	};

	const fspId = reader.get('fspId');
	const fullName = reader.get('fullName');
	// A team protocol may list teams only: the team is the participant then.
	if (fspId === undefined && fullName === undefined && reader.get('team') === undefined) {
		reader.fail('fspId', 'no_participant', 'в строке нет участника: ни ФСП ID, ни ФИО, ни команды');
	}
	const birthYear = reader.int('birthYear', 1900);
	if (birthYear !== undefined && birthYear > new Date().getUTCFullYear()) {
		reader.fail('birthYear', 'invalid_number', 'год рождения в будущем');
	}
	const region = reader.get('region');

	const placeRaw = reader.get('place');
	const noPlace = new Set(profile.noPlace.map(normalizeHeader));
	const place =
		placeRaw === undefined || noPlace.has(normalizeHeader(placeRaw)) ? null : (reader.int('place', 1) ?? null);
	const status = reader.coded('status', rawResult) ?? profile.defaults.status;
	if (status === undefined) reader.fail('status', 'required', 'не указан статус результата');
	const award = reader.coded('award', rawResult);
	const evsk = reader.coded('evskFulfilled', rawResult);
	const placeOf = reader.int('placeOf', 1);
	const score = reader.number('score');
	const solved = reader.int('solved', 0);
	const penaltyMinutes = reader.number('penaltyMinutes');
	const publishedAt = reader.get('publishedAt');
	if (publishedAt !== undefined && Number.isNaN(Date.parse(publishedAt))) {
		reader.fail('publishedAt', 'invalid_date', 'нужно время в формате ISO 8601');
	}

	const teamName = reader.get('team');
	const teamId = reader.get('teamId');
	const role = reader.coded('role', rawResult);
	const specialization = reader.get('specialization');
	let team: ResultTeam | undefined;
	if (teamName !== undefined) {
		team = {
			id: teamId ?? `team:${sha256Hex(`${competitionId}|${normalizeHeader(teamName)}`).slice(0, 24)}`,
			name: teamName,
			...(role !== undefined ? { role: role as NonNullable<ResultTeam['role']> } : {}),
			...(specialization !== undefined ? { specialization } : {})
		};
	} else if (teamId !== undefined || role !== undefined || specialization !== undefined) {
		reader.fail('team', 'required', 'роль или состав команды указаны без названия команды');
	}

	const recordKey = input.recordKey;
	const resultId = reader.get('resultId');
	const recordId =
		resultId ??
		(recordKey.kind === 'protocol'
			? `pdf:${recordKey.sha256}:${row.number}`
			: fspId !== undefined
				? `${competitionId}:${fspId}`
				: `row:${recordKey.sha256}:${row.number}`);

	const result: BatchRow['result'] = {
		place,
		...(placeOf !== undefined ? { placeOf } : {}),
		...(score !== undefined ? { score } : {}),
		...(solved !== undefined ? { solved } : {}),
		...(penaltyMinutes !== undefined ? { penaltyMinutes } : {}),
		...(team !== undefined ? { team } : {}),
		...(award !== undefined ? { award: award as NonNullable<Result['award']> } : {}),
		...(evsk !== undefined ? { evskFulfilled: evsk as NonNullable<Result['evskFulfilled']> } : {}),
		status: status as Result['status'],
		...(publishedAt !== undefined ? { publishedAt } : {}),
		...(Object.keys(rawResult).length > 0 ? { rawValues: rawResult } : {})
	};
	return {
		competition,
		batchRow: {
			recordId,
			rowNumber: row.number,
			...(row.page !== undefined ? { page: row.page } : {}),
			competitionId,
			participant: {
				...(fspId !== undefined ? { fspId } : {}),
				...(fullName !== undefined ? { fullName } : {}),
				...(birthYear !== undefined ? { birthYear } : {}),
				...(region !== undefined ? { region } : {})
			},
			result
		}
	};
}

/** Maps every data row of the table; the table must have the profile's columns. */
export function mapRows(input: MappingInput): MappedRows {
	const { table, profile } = input;
	const columns = input.columns ?? resolveColumns(table, profile);
	const hints = { ...input.hints, ...profile.competition };
	const missing = REQUIRED.filter(
		({ field, fixed }) =>
			columns[field] === undefined &&
			(fixed === 'status' ? profile.defaults.status === undefined : hints[fixed] === undefined)
	).map(({ field }) => field);
	if (missing.length > 0) {
		throw new BatchFormatError(
			'mapping_required',
			`ни колонка, ни значение профиля не дают поля: ${missing.join(', ')}`
		);
	}

	const competitions = new Map<string, { competition: Competition; row: number }>();
	const records = new Map<string, number>();
	const birthYears = new Map<string, { year: number; row: number }>();
	const rows: BatchRow[] = [];
	const issues: RowIssue[] = [];
	for (const row of table.rows) {
		const at = { row: row.number, ...(row.page !== undefined ? { page: row.page } : {}) };
		const reader = new RowReader(row, table, columns, profile);
		try {
			const extra = row.cells.slice(table.header.length).some((c) => c.trim() !== '');
			if (extra) reader.fail(null, 'row_shape', 'в строке больше ячеек, чем в заголовке');
			const { competition, batchRow } = readRow(reader, row, input);
			const known = competitions.get(competition.id);
			if (known && canonicalJson(known.competition) !== canonicalJson(competition)) {
				reader.fail(
					'competitionTitle',
					'competition_conflict',
					`соревнование описано иначе, чем в строке ${known.row}`
				);
			}
			const earlier = records.get(batchRow.recordId);
			if (earlier !== undefined) {
				reader.fail('resultId', 'duplicate_result', `тот же результат, что в строке ${earlier}`);
			}
			const { fspId, birthYear } = batchRow.participant;
			if (fspId !== undefined && birthYear != null) {
				const stated = birthYears.get(fspId);
				if (stated && stated.year !== birthYear) {
					reader.fail('birthYear', 'athlete_conflict', `год рождения расходится со строкой ${stated.row}`);
				}
				if (!stated) birthYears.set(fspId, { year: birthYear, row: row.number });
			}
			if (!known) competitions.set(competition.id, { competition, row: row.number });
			records.set(batchRow.recordId, row.number);
			rows.push(batchRow);
		} catch (error) {
			if (!(error instanceof RowFailure)) throw error;
			issues.push({ ...at, ...error.issue });
		}
	}
	return {
		competitions: [...competitions.values()].map((c) => c.competition),
		rows,
		issues,
		rowsRead: table.rows.length
	};
}
