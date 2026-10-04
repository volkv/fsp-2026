// A results table as read from a batch, before the mapping profile gives its columns a meaning: a header and rows of
// text cells, each row with the number a person finds it under in the source (a line of a CSV, a row of a sheet, the
// n-th row of a protocol).

export interface SourceRow {
	/** Row number in the source: 1-based line or sheet row; for a protocol, the n-th table row. */
	number: number;
	/** Page of a protocol the row is on. */
	page?: number;
	cells: string[];
	/** XLSX: columns whose cell holds a spreadsheet error (#N/A, #REF!) rather than a value. */
	cellErrors?: number[];
}

export interface SourceTable {
	header: string[];
	rows: SourceRow[];
	/** XLSX: a number in a date column is a spreadsheet serial date of this epoch. */
	serialDates?: { date1904: boolean };
}

/**
 * Bounds of an export a results table fits in with room to spare: a competition's protocol has hundreds of rows, the
 * whole FSP rating tens of thousands, a dozen or two columns. A file beyond them is refused before it is read, so a
 * small crafted file cannot make the process allocate for a sheet it only pretends to have.
 */
export const TABLE_LIMITS = {
	/** Columns of a row: A..IV. */
	columns: 256,
	/** Rows of a sheet or records of a CSV, blank ones included. */
	rows: 50_000,
	/** Cells of a table, the empty ones a row holds before its last cell included. */
	cells: 500_000,
	/** Characters of a cell: the most a spreadsheet cell holds. */
	cellChars: 32_767,
	/** Bytes a part of an XLSX (a sheet, its shared strings) expands to. */
	partBytes: 8 * 1024 * 1024
} as const;

/** Why a batch could not be read as a table at all; a problem of one row is a row issue instead. */
export class BatchFormatError extends Error {
	override name = 'BatchFormatError';
	readonly code: 'unsupported_format' | 'mapping_required' | 'protocol_error' | 'limit_exceeded';
	constructor(code: BatchFormatError['code'], message: string) {
		super(message);
		this.code = code;
	}
}
