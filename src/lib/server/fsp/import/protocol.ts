// A competition protocol parsed by `docparse` (docs/contracts.md, section 4) → the table of results and what the
// heading says about the competition. The parser reports tables as grids of cells: ruled tables by their lines, others
// by the alignment of their columns. A table continued on the next page is read on as one table without the header
// rows it repeats there. Grid rows tied together by a cell spanning them (a result over two lines: verdicts above,
// times below) are one row of results; the header is the row (or up to three rows) naming the profile's columns.
// A protocol without a table layer — a scan read by OCR — is read line by line with the profile's row pattern instead.
import type { ParseResponse, ParseTable } from '$lib/server/documents/docparse';
import { sliceByCodePoints } from '$lib/text/offsets';
import { normalizeHeader, patternFields, type MappingProfile, type RowField } from './profile';
import { codeOf, type CompetitionHints, type RowIssue } from './rows';
import { BatchFormatError, type SourceRow, type SourceTable } from './table';

interface ProtocolTable {
	table: SourceTable;
	/** In the row pattern mode the header is the fields themselves. */
	columns?: Partial<Record<RowField, number>>;
	/** Lines that look like rows of the table but could not be read as one. */
	issues: RowIssue[];
	hints: CompetitionHints;
}

/** A cell of a row as read: its grid columns and its text. */
interface RowCell {
	col: number;
	span: number;
	text: string;
}

/** One row of a table as a person reads it: the grid rows tied together by cells spanning them. */
interface TableRow {
	page: number | null;
	cells: RowCell[];
}

const pageOf = (row: { page: number | null }) => (row.page === null ? {} : { page: row.page });

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Grid rows of a table from `skip` on → rows as read. A grid row starts a new row unless a cell of an earlier grid
 * row still covers it; cells of one row in the same columns (a cell split by a line inside it) are joined.
 */
function tableRows(table: ParseTable, skip: number): TableRow[] {
	const rows: TableRow[] = [];
	let reach = 0;
	table.rows.forEach((gridRow, r) => {
		if (r < skip) return;
		if (r >= reach || rows.length === 0) rows.push({ page: table.page, cells: [] });
		const row = rows[rows.length - 1] as TableRow;
		for (const cell of gridRow) {
			reach = Math.max(reach, r + (cell.rowSpan ?? 1));
			const span = cell.colSpan ?? 1;
			const same = row.cells.find((c) => c.col === cell.col && c.span === span);
			if (same) same.text = [same.text, cell.text].filter((t) => t !== '').join('\n');
			else row.cells.push({ col: cell.col, span, text: cell.text });
		}
	});
	for (const row of rows) row.cells.sort((a, b) => a.col - b.col);
	return rows;
}

/** Joins the cells of `next` into `row` column by column. */
function joinRow(row: TableRow, next: TableRow): void {
	for (const cell of next.cells) {
		const same = row.cells.find((c) => c.col === cell.col && c.span === cell.span);
		if (same) same.text = [same.text, cell.text].filter((t) => t !== '').join('\n');
		else row.cells.push({ ...cell });
	}
	row.cells.sort((a, b) => a.col - b.col);
}

/** A table as read, over all the pages it continues on. */
interface ProtocolGrid {
	rows: TableRow[];
}

const filled = (row: TableRow) => new Set(row.cells.filter((c) => c.text !== '').map((c) => c.col));

/**
 * A row that broke across the page: the first row of a continuation with nothing in the first column and without
 * at least half of the cells the last row of the page before has (a row with only its place missing is a row).
 */
function brokenAcross(last: TableRow, head: TableRow): boolean {
	const before = filled(last);
	const after = filled(head);
	if (after.has(0)) return false;
	const missing = [...before].filter((col) => !after.has(col)).length;
	return missing * 2 >= before.size;
}

/**
 * Tables of the protocol, a table continued on following pages read as one: its rows without the header rows the
 * continuations repeat, a row broken across a page joined back.
 */
function protocolTables(parsed: ParseResponse): ProtocolGrid[] {
	if (parsed.tables === undefined) {
		throw new BatchFormatError('protocol_error', 'сервис разбора не вернул таблицы протокола');
	}
	const grids: ProtocolGrid[] = [];
	const gridOf = new Map<string, ProtocolGrid>();
	for (const table of parsed.tables) {
		const grid = table.continues === undefined ? undefined : gridOf.get(table.continues);
		const rows = tableRows(table, table.repeatedHeaderRows ?? 0);
		if (!grid) {
			const created = { rows };
			grids.push(created);
			gridOf.set(table.id, created);
			continue;
		}
		const [head, ...rest] = rows;
		const last = grid.rows[grid.rows.length - 1];
		if (head && last && brokenAcross(last, head)) {
			joinRow(last, head);
			grid.rows.push(...rest);
		} else {
			grid.rows.push(...rows);
		}
		gridOf.set(table.id, grid);
	}
	return grids;
}

/** Header cells of `span` rows starting at `at`, joined cell by cell, when every mapped column is found in it once. */
function headerAt(rows: TableRow[], at: number, span: number, wanted: string[][]): RowCell[] | null {
	const first = rows[at];
	if (!first) return null;
	const shape = first.cells.map((c) => `${c.col}:${c.span}`).join(' ');
	const cells = first.cells.map((c) => ({ ...c, text: '' }));
	for (let i = at; i < at + span; i++) {
		const row = rows[i];
		if (!row || row.cells.map((c) => `${c.col}:${c.span}`).join(' ') !== shape) return null;
		row.cells.forEach((cell, n) => {
			const target = cells[n] as RowCell;
			target.text = [target.text, cell.text].filter((t) => t !== '').join(' ');
		});
	}
	const keys = cells.map((c) => normalizeHeader(c.text));
	const fits = wanted.every((aliases) => keys.filter((k) => aliases.includes(k)).length === 1);
	return fits ? cells : null;
}

/** A header cell may wrap onto up to three rows of a table without rulings («Результат» / «(баллы)»). */
const HEADER_SPANS = [1, 2, 3];

/** A line that starts like a numbered row of a results table. */
const ROW_LIKE = /^\d{1,4}(?:[.)]?[\s\t])/u;

/**
 * A row under the header → its cells by the header's columns: the text of the row's cells that lie within each header
 * cell. `null` when a cell with text crosses the header's columns (a caption across the table, a row of another shape).
 */
function alignRow(row: TableRow, header: RowCell[]): string[] | null {
	const values = header.map(() => [] as string[]);
	for (const cell of row.cells) {
		if (cell.text === '') continue;
		const at = header.findIndex((h) => cell.col >= h.col && cell.col + cell.span <= h.col + h.span);
		if (at < 0) return null;
		values[at]?.push(flat(cell.text));
	}
	return values.map((v) => v.join(' '));
}

function tableByHeader(parsed: ParseResponse, profile: MappingProfile): { table: SourceTable; issues: RowIssue[] } {
	const wanted = Object.values(profile.columns).map((ref) =>
		(typeof ref === 'string' ? [ref] : ref).map(normalizeHeader)
	);
	if (wanted.length === 0) throw new BatchFormatError('mapping_required', 'в профиле не сопоставлено ни одной колонки');
	let header: string[] | null = null;
	const rows: SourceRow[] = [];
	const issues: RowIssue[] = [];
	let number = 0;
	// Every table with the profile's columns holds results: a protocol may give each group its own table.
	for (const grid of protocolTables(parsed)) {
		let found: { cells: RowCell[]; next: number } | null = null;
		for (let at = 0; at < grid.rows.length && !found; at++) {
			for (const span of HEADER_SPANS) {
				const cells = headerAt(grid.rows, at, span, wanted);
				if (cells) {
					found = { cells, next: at + span };
					break;
				}
			}
		}
		if (!found) continue;
		const names = found.cells.map((c) => flat(c.text));
		header ??= names;
		if (names.map(normalizeHeader).join('\t') !== header.map(normalizeHeader).join('\t')) {
			throw new BatchFormatError('protocol_error', 'таблицы протокола различаются колонками');
		}
		const headerKey = header.map(normalizeHeader).join('\t');
		for (const row of grid.rows.slice(found.next)) {
			const cells = alignRow(row, found.cells);
			if (cells === null) {
				const text = row.cells.map((c) => flat(c.text)).join('\t');
				// A caption across the table («Юниоры») is not a row; something shaped like one is reported.
				if (ROW_LIKE.test(`${text}\t`)) {
					number++;
					issues.push({
						row: number,
						...pageOf(row),
						column: null,
						code: 'row_shape',
						message: 'строка не совпадает с колонками заголовка'
					});
				}
				continue;
			}
			if (cells.every((c) => c === '')) continue;
			// The header repeated at the top of a page the parser did not see as a continuation.
			if (cells.map(normalizeHeader).join('\t') === headerKey) continue;
			number++;
			rows.push({ number, ...pageOf(row), cells });
		}
	}
	if (header === null) {
		throw new BatchFormatError(
			'mapping_required',
			'в протоколе нет таблицы с колонками профиля (скан без таблиц читается по pdf.rowPattern)'
		);
	}
	return { table: { header, rows }, issues };
}

/**
 * The protocol as lines for the row pattern: the rows of its tables, each as a line of its cells (a cell's lines joined
 * by a space); a protocol without tables (a scan read by OCR) — its text line by line.
 */
function protocolLines(parsed: ParseResponse): { page: number | null; cells: string[] }[] {
	const grids = protocolTables(parsed);
	if (grids.length > 0) {
		return grids.flatMap((grid) =>
			grid.rows.map((row) => ({ page: row.page, cells: row.cells.map((c) => flat(c.text)) }))
		);
	}
	return parsed.blocks.flatMap((block) =>
		sliceByCodePoints(parsed.text, block)
			.split('\n')
			.filter((line) => line.trim() !== '')
			.map((line) => ({ page: block.page, cells: [line] }))
	);
}

function tableByPattern(parsed: ParseResponse, pattern: string): { table: SourceTable; issues: RowIssue[] } {
	const fields = patternFields(pattern);
	const expression = new RegExp(`^(?:${pattern})$`, 'u');
	const rows: SourceRow[] = [];
	const issues: RowIssue[] = [];
	let number = 0;
	for (const line of protocolLines(parsed)) {
		const text = line.cells.join('\t');
		const match = expression.exec(text);
		if (match) {
			number++;
			rows.push({ number, ...pageOf(line), cells: fields.map((f) => match.groups?.[f] ?? '') });
		} else if (ROW_LIKE.test(text)) {
			number++;
			issues.push({
				row: number,
				...pageOf(line),
				column: null,
				code: 'row_shape',
				message: 'строка похожа на результат, но не подходит под pdf.rowPattern'
			});
		}
	}
	return { table: { header: fields, rows }, issues };
}

const LEVEL_WORDS: readonly [RegExp, string][] = [
	[/кубк\p{L}* россии/iu, 'russian_cup'],
	[/чемпионат\p{L}* россии/iu, 'russian_championship'],
	[/первенств\p{L}* россии/iu, 'russian_youth_championship']
];
const STAGE_WORDS: readonly [RegExp, string][] = [
	[/отборочн/iu, 'qualifier'],
	[/финал/iu, 'final']
];
const AGE_GROUPS: Record<string, string> = { 'мужчины, женщины': 'adults', 'женщины, мужчины': 'adults' };

function isoOf(dotted: string | undefined): string | undefined {
	const m = dotted && /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(dotted);
	return m ? `${m[3]}-${(m[2] ?? '').padStart(2, '0')}-${(m[1] ?? '').padStart(2, '0')}` : undefined;
}

/** What the heading of an FSP protocol states: title, EKP number, dates, place, discipline, stage and age group. */
function protocolHints(parsed: ParseResponse, profile: MappingProfile): CompetitionHints {
	const text = parsed.text;
	const flat = text.replace(/\s+/g, ' ');
	const hints: CompetitionHints = {};
	const raw: Record<string, string> = {};
	const unmappable = (): never => {
		throw new Error('a Known field never fails');
	};

	// The title: the block naming the protocol and the heading blocks right after it.
	const blocks = parsed.blocks.map((b) => ({ kind: b.kind, text: sliceByCodePoints(text, b) }));
	const first = blocks.findIndex((b) => /п\s?р\s?о\s?т\s?о\s?к\s?о\s?л/iu.test(b.text));
	if (first >= 0) {
		const titleBlocks = [blocks[first]?.text ?? ''];
		for (let i = first + 1; blocks[i]?.kind === 'heading'; i++) titleBlocks.push(blocks[i]?.text ?? '');
		// Letter-spaced words of a heading («И Т О Г О В Ы Й») are joined back.
		hints.title = titleBlocks
			.join('\n')
			.split('\n')
			.map((line) => (/^(\p{L} )+\p{L}$/u.test(line) ? line.replaceAll(' ', '') : line))
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();
	}
	const ekp = /ЕКП\s*№?\s*(\d{16})/u.exec(flat)?.[1];
	if (ekp) hints.ekpNumber = ekp;
	const dates =
		/Срок проведения:?\s*(\d{1,2}\.\d{1,2}\.\d{4})(?:\s*г\.?)?(?:\s*[–—-]\s*(\d{1,2}\.\d{1,2}\.\d{4}))?/u.exec(flat);
	const start = isoOf(dates?.[1]);
	const end = isoOf(dates?.[2]);
	if (start) hints.startDate = start;
	if (end) hints.endDate = end;
	const location = /Место проведения:?[ \t]*([^\n]+)/u.exec(text)?.[1]?.trim();
	if (location) {
		hints.location = location;
		const online = Object.entries(profile.values.online ?? {}).find(
			([name]) => normalizeHeader(name) === normalizeHeader(location)
		)?.[1];
		if (online !== undefined) hints.online = online;
	}
	const discipline = /дисциплин\p{L}*\s*«([^»]+)»/u.exec(flat)?.[1];
	if (discipline) hints.discipline = codeOf('discipline', discipline.trim(), profile, raw, unmappable);
	const heading = hints.title ?? '';
	const level = LEVEL_WORDS.find(([words]) => words.test(heading))?.[1];
	if (level) hints.level = level;
	const stage = STAGE_WORDS.find(([words]) => words.test(heading))?.[1];
	if (stage) hints.stage = stage;
	const age = /Возрастная группа:?[ \t]*([^\n]+)/u.exec(text)?.[1]?.trim();
	if (age) {
		const builtin = AGE_GROUPS[normalizeHeader(age)];
		hints.ageGroup = builtin ?? codeOf('ageGroup', age, profile, raw, unmappable);
	}
	if (Object.keys(raw).length > 0) hints.rawValues = raw;
	return hints;
}

export function readProtocol(parsed: ParseResponse, profile: MappingProfile): ProtocolTable {
	const hints = protocolHints(parsed, profile);
	const pattern = profile.pdf.rowPattern;
	if (pattern !== undefined) {
		const { table, issues } = tableByPattern(parsed, pattern);
		const columns = Object.fromEntries(table.header.map((field, i) => [field, i])) as Partial<Record<RowField, number>>;
		return { table, columns, issues, hints };
	}
	return { ...tableByHeader(parsed, profile), hints };
}
