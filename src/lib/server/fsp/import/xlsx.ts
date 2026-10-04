// XLSX (Office Open XML spreadsheet) of a results export: one worksheet read as text cells. Shared and inline strings,
// numbers as written in the file, booleans; a cell holding a spreadsheet error (#N/A, #REF!) is marked so that a row
// using it is reported, not read as text. Formatting is not applied: a date column is interpreted by the mapping,
// which knows the workbook's date epoch.
import { XMLParser } from 'fast-xml-parser';
import { BatchFormatError, TABLE_LIMITS, type SourceRow, type SourceTable } from './table';
import { ZipArchive } from './zip';

const ARRAYS = new Set(['sheet', 'Relationship', 'si', 'r', 'row', 'c']);
const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: false,
	isArray: (name) => ARRAYS.has(name)
});

type Node = Record<string, unknown>;

const count = new Intl.NumberFormat('ru-RU');

/**
 * Tags one tree may be built of: a part of the workbook's structure, a row of a sheet, an item of its strings. A tree
 * costs tens of times its text, so no part is parsed whole; a sheet and its strings are read an item at a time.
 */
const MAX_TREE_TAGS = 16_384;

function markup(name: string, xml: string): string {
	// Spreadsheet parts have no document type; one is where entity expansion attacks come from.
	if (/<!DOCTYPE/i.test(xml)) throw new BatchFormatError('unsupported_format', `часть книги ${name} объявляет DTD`);
	return xml;
}

function tree(name: string, xml: string): Node {
	let tags = 0;
	for (let at = xml.indexOf('<'); at >= 0; at = xml.indexOf('<', at + 1)) {
		if (++tags > MAX_TREE_TAGS) {
			throw new BatchFormatError(
				'limit_exceeded',
				`в части книги ${name} строка или запись размечена больше чем ${count.format(MAX_TREE_TAGS)} тегами`
			);
		}
	}
	const parsed: unknown = parser.parse(xml);
	if (typeof parsed !== 'object' || parsed === null) {
		throw new BatchFormatError('unsupported_format', `часть книги ${name} — не XML`);
	}
	return parsed as Node;
}

function parseXml(archive: ZipArchive, name: string): Node {
	return tree(name, markup(name, archive.read(name).toString('utf8')));
}

/**
 * Elements `tag` directly inside the `container` of a part, each parsed as a tree of its own, at most `limit` of them.
 * Only whitespace may lie between them, which also refuses a text that would end an element early (a CDATA section
 * holding its end tag) instead of reading it wrong.
 */
function* items(
	archive: ZipArchive,
	name: string,
	path: { container: string; tag: string },
	limit: { count: number; refusal: string }
): Generator<Node> {
	const xml = markup(name, archive.read(name).toString('utf8'));
	const { container, tag } = path;
	const open = new RegExp(`<${container}(?:\\s[^>]*?)?(/?)>`).exec(xml);
	if (!open || open[1] === '/') return;
	const end = xml.lastIndexOf(`</${container}>`);
	const element = new RegExp(`<${tag}(?:\\s[^>]*?)?(?:/>|>[\\s\\S]*?</${tag}>)`, 'y');
	let at = open.index + open[0].length;
	if (end < at) throw new BatchFormatError('unsupported_format', `часть книги ${name} — не XML`);
	let n = 0;
	for (;;) {
		while (at < end && /\s/.test(xml.charAt(at))) at++;
		if (at >= end) return;
		element.lastIndex = at;
		const match = element.exec(xml);
		if (!match || element.lastIndex > end) {
			throw new BatchFormatError('unsupported_format', `часть книги ${name} устроена неожиданно`);
		}
		if (++n > limit.count) throw new BatchFormatError('limit_exceeded', limit.refusal);
		const item = children(tree(name, match[0]), tag)[0];
		if (!item) throw new BatchFormatError('unsupported_format', `часть книги ${name} устроена неожиданно`);
		yield item;
		at = element.lastIndex;
	}
}

function child(node: unknown, name: string): Node | undefined {
	if (typeof node !== 'object' || node === null) return undefined;
	const value = (node as Node)[name];
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Node) : undefined;
}

function children(node: unknown, name: string): Node[] {
	if (typeof node !== 'object' || node === null) return [];
	const value = (node as Node)[name];
	if (!Array.isArray(value)) return [];
	return (value as unknown[]).map((v) => (typeof v === 'object' && v !== null ? (v as Node) : { '#text': v }));
}

function attr(node: Node, name: string): string | undefined {
	const value = node[`@_${name}`];
	return typeof value === 'string' ? value : undefined;
}

/**
 * Text of an element: a string, an element with attributes (`<t xml:space="preserve">`) and its text, or an empty
 * element. Values are not parsed, so anything else is a structure a cell does not have.
 */
function text(value: unknown): string {
	if (value === undefined || value === '') return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const content = (value as Node)['#text'];
		if (content === undefined) return '';
		if (typeof content === 'string') return content;
	}
	throw new BatchFormatError('unsupported_format', 'ячейка книги устроена неожиданно');
}

/** A shared or inline string: plain `<t>` or rich text runs `<r><t>`; phonetic hints (`<rPh>`) are not text. */
function stringItem(item: Node): string {
	if ('t' in item) return text(item.t);
	return children(item, 'r')
		.map((run) => text(run.t))
		.join('');
}

function columnIndex(ref: string): number {
	const letters = /^([A-Z]{1,3})\d+$/.exec(ref)?.[1];
	if (!letters) throw new BatchFormatError('unsupported_format', `неверная ссылка на ячейку ${ref}`);
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
	if (n > TABLE_LIMITS.columns) throw beyondColumns(ref);
	return n - 1;
}

function columnName(index: number): string {
	let name = '';
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	return name;
}

const LAST_COLUMN = columnName(TABLE_LIMITS.columns - 1);

function beyondColumns(ref: string) {
	return new BatchFormatError(
		'limit_exceeded',
		`ячейка ${ref} за пределами ${TABLE_LIMITS.columns} колонок (A–${LAST_COLUMN})`
	);
}

function resolveTarget(target: string): string {
	return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

export function readXlsx(bytes: Uint8Array, options: { sheet?: string; headerRow: number }): SourceTable {
	const archive = new ZipArchive(bytes);
	if (!archive.has('xl/workbook.xml')) throw new BatchFormatError('unsupported_format', 'файл — не книга XLSX');
	const workbook = child(parseXml(archive, 'xl/workbook.xml'), 'workbook');
	const properties = child(workbook, 'workbookPr');
	const date1904 = properties !== undefined && ['1', 'true'].includes(attr(properties, 'date1904') ?? '');
	const sheets = children(child(workbook, 'sheets'), 'sheet');
	const sheet = options.sheet === undefined ? sheets[0] : sheets.find((s) => attr(s, 'name') === options.sheet);
	if (!sheet) {
		throw new BatchFormatError(
			'mapping_required',
			options.sheet === undefined
				? 'в книге нет листов'
				: `в книге нет листа «${options.sheet}» (проверьте xlsx.sheet профиля)`
		);
	}
	const relations = children(child(parseXml(archive, 'xl/_rels/workbook.xml.rels'), 'Relationships'), 'Relationship');
	const relationId = attr(sheet, 'r:id');
	const target = relations.find((r) => attr(r, 'Id') === relationId);
	const targetPath = target && attr(target, 'Target');
	if (!targetPath) throw new BatchFormatError('unsupported_format', 'у листа нет части в книге');

	const shared = archive.has('xl/sharedStrings.xml')
		? Array.from(
				items(
					archive,
					'xl/sharedStrings.xml',
					{ container: 'sst', tag: 'si' },
					{
						count: TABLE_LIMITS.cells,
						refusal: `в книге больше ${count.format(TABLE_LIMITS.cells)} строк текста: разделите пакет на части`
					}
				),
				stringItem
			)
		: [];
	const sheetRows = items(
		archive,
		resolveTarget(targetPath),
		{ container: 'sheetData', tag: 'row' },
		{
			count: TABLE_LIMITS.rows,
			refusal: `в листе больше ${count.format(TABLE_LIMITS.rows)} строк: разделите пакет на части`
		}
	);

	const rows: (SourceRow & { cellErrors: number[] })[] = [];
	/** Cells the rows hold, the empty ones before a row's last cell included. */
	let held = 0;
	let rowNumber = 0;
	for (const row of sheetRows) {
		const declared = attr(row, 'r');
		rowNumber = declared === undefined ? rowNumber + 1 : Number(declared);
		if (!Number.isInteger(rowNumber) || rowNumber < 1) {
			throw new BatchFormatError('unsupported_format', `неверный номер строки ${declared ?? ''}`);
		}
		const cells: string[] = [];
		const cellErrors: number[] = [];
		let column = -1;
		for (const cell of children(row, 'c')) {
			const ref = attr(cell, 'r');
			column = ref === undefined ? column + 1 : columnIndex(ref);
			const type = attr(cell, 't') ?? 'n';
			let value: string;
			switch (type) {
				case 's': {
					const index = Number(text(cell.v));
					const item = shared[index];
					if (!Number.isInteger(index) || item === undefined) {
						throw new BatchFormatError(
							'unsupported_format',
							`ячейка ${ref ?? ''} ссылается на отсутствующую строку книги`
						);
					}
					value = item;
					break;
				}
				case 'inlineStr':
					value = stringItem(child(cell, 'is') ?? {});
					break;
				case 'b':
					value = text(cell.v) === '1' ? 'true' : 'false';
					break;
				case 'e':
					value = '';
					cellErrors.push(column);
					break;
				default:
					// n, str (a formula's text), d (ISO date): the stored value as written.
					value = text(cell.v);
			}
			if (value.length > TABLE_LIMITS.cellChars) {
				throw new BatchFormatError(
					'limit_exceeded',
					`в ячейке ${ref ?? `${columnName(column)}${rowNumber}`} больше ${count.format(TABLE_LIMITS.cellChars)} символов`
				);
			}
			if (column >= TABLE_LIMITS.columns) throw beyondColumns(`${columnName(column)}${rowNumber}`);
			if (held + column + 1 > TABLE_LIMITS.cells) {
				throw new BatchFormatError(
					'limit_exceeded',
					`в листе больше ${count.format(TABLE_LIMITS.cells)} ячеек: разделите пакет на части`
				);
			}
			while (cells.length < column) cells.push('');
			cells[column] = value;
		}
		held += cells.length;
		rows.push({ number: rowNumber, cells, cellErrors });
	}
	const headerRow = rows.find((r) => r.number === options.headerRow);
	if (!headerRow || headerRow.cells.every((c) => c.trim() === '')) {
		throw new BatchFormatError(
			'mapping_required',
			`в строке ${options.headerRow} листа нет заголовка (проверьте headerRow профиля)`
		);
	}
	return {
		header: headerRow.cells,
		rows: rows
			.filter((r) => r.number > options.headerRow)
			.filter((r) => r.cellErrors.length > 0 || r.cells.some((c) => c.trim() !== ''))
			.map(({ cellErrors, ...r }) => (cellErrors.length > 0 ? { ...r, cellErrors } : r)),
		serialDates: { date1904 }
	};
}
