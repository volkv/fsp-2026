// Client of the file parsing service `docparse` (docs/contracts.md, section 4): sends the bytes of a stored file and
// returns the text with addressable blocks and the tables built of them, or the service's error code. The answer is
// validated against the shape of `contracts/docparse/v1.schema.json` and its invariants before anything is stored;
// exceptions do not cross the client.
import { z } from 'zod';
import { config } from '$lib/server/config';
import { codePointLength, sliceByCodePoints } from '$lib/text/offsets';

const DETECTED_FORMATS = ['pdf', 'docx', 'doc', 'rtf', 'odt', 'txt', 'png', 'jpeg'] as const;
const BLOCK_KINDS = ['heading', 'paragraph', 'list_item', 'table_cell', 'line'] as const;
const INCOMPLETE_REASONS = [
	'page_limit',
	'ocr_low_confidence',
	'unsupported_element',
	'encrypted_part',
	'embedded_object_skipped'
] as const;

export const DOCPARSE_ERROR_CODES = [
	'unsupported_format',
	'too_large',
	'unpacked_too_large',
	'encrypted',
	'corrupt',
	'no_text',
	'timeout',
	'memory_exceeded',
	'busy',
	'internal',
	'bad_request'
] as const;

export type DocparseErrorCode = (typeof DOCPARSE_ERROR_CODES)[number];

const extractor = z.strictObject({ name: z.string().min(1), version: z.string().min(1) });

const BLOCK_ID = /^(p[1-9][0-9]*|d)-b[0-9]{3,}$/;

const block = z.strictObject({
	id: z.string().regex(BLOCK_ID),
	page: z.int().min(1).nullable(),
	kind: z.enum(BLOCK_KINDS),
	column: z.int().min(1).nullable(),
	start: z.int().min(0),
	end: z.int().min(1)
});

const tableCell = z.strictObject({
	/** Grid column of the cell's left edge, from 0; its row is the one it is listed in. */
	col: z.int().min(0),
	rowSpan: z.int().min(2).optional(),
	colSpan: z.int().min(2).optional(),
	/** The text of its blocks joined by \n; empty for an empty cell. */
	text: z.string(),
	blockIds: z.array(z.string().regex(BLOCK_ID))
});

const table = z.strictObject({
	id: z.string().regex(/^(p[1-9][0-9]*|d)-t[0-9]{3,}$/),
	page: z.int().min(1).nullable(),
	/** x0, top, x1, bottom in PDF points from the top-left corner of the page. */
	bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
	columnCount: z.int().min(1),
	/** Grid rows from the top; a row lists the cells whose top-left corner is in it, ordered by column. */
	rows: z.array(z.array(tableCell)).min(1),
	/** The table on the previous page this one continues, with the same columns. */
	continues: z
		.string()
		.regex(/^p[1-9][0-9]*-t[0-9]{3,}$/)
		.optional(),
	/** Leading rows repeating the first rows of the table it continues: the header on every page. */
	repeatedHeaderRows: z.int().min(1).optional()
});

/**
 * What the schema cannot say about tables: cells lie on the grid without overlapping, a cell's text is the text of
 * its blocks (of kind table_cell, on the table's page), a block belongs to one cell, a continuation follows a table
 * of the previous page with the same columns.
 */
function checkTables(
	value: { text: string; blocks: z.infer<typeof block>[]; tables?: z.infer<typeof table>[] | undefined },
	problem: (message: string) => void
): void {
	const blocks = new Map(value.blocks.map((b) => [b.id, b]));
	const claimed = new Set<string>();
	const seen = new Map<string, z.infer<typeof table>>();
	for (const t of value.tables ?? []) {
		if (seen.has(t.id)) problem(`table ${t.id} repeats`);
		if (!t.id.startsWith(`${t.page === null ? 'd' : `p${t.page}`}-`)) problem(`table ${t.id} is not on its page`);
		if ((t.bbox === null) !== (t.page === null)) problem(`table ${t.id} has a box without a page or the reverse`);
		const covered = new Set<string>();
		t.rows.forEach((row, r) => {
			let previousCol = -1;
			for (const cell of row) {
				if (cell.col <= previousCol) problem(`cells of table ${t.id} are out of order`);
				previousCol = cell.col;
				const rowEnd = r + (cell.rowSpan ?? 1);
				const colEnd = cell.col + (cell.colSpan ?? 1);
				if (rowEnd > t.rows.length || colEnd > t.columnCount) problem(`a cell of table ${t.id} leaves the grid`);
				for (let rr = r; rr < rowEnd; rr++) {
					for (let cc = cell.col; cc < colEnd; cc++) {
						if (covered.has(`${rr}:${cc}`)) problem(`cells of table ${t.id} overlap`);
						covered.add(`${rr}:${cc}`);
					}
				}
				const texts: string[] = [];
				for (const id of cell.blockIds) {
					const b = blocks.get(id);
					if (!b || b.kind !== 'table_cell' || b.page !== t.page) {
						problem(`a cell of table ${t.id} refers to a block that is not its cell block`);
						continue;
					}
					if (claimed.has(id)) problem(`block ${id} is in two cells`);
					claimed.add(id);
					texts.push(sliceByCodePoints(value.text, b));
				}
				if (texts.join('\n') !== cell.text) problem(`a cell of table ${t.id} differs from its blocks`);
			}
		});
		if (t.continues !== undefined) {
			const before = seen.get(t.continues);
			if (!before || t.page === null || before.page !== t.page - 1 || before.columnCount !== t.columnCount) {
				problem(`table ${t.id} does not continue a table of the previous page with its columns`);
			}
		}
		if (t.repeatedHeaderRows !== undefined && (t.continues === undefined || t.repeatedHeaderRows >= t.rows.length)) {
			problem(`table ${t.id} repeats a header it cannot have`);
		}
		seen.set(t.id, t);
	}
}

const parseResponse = z
	.strictObject({
		schemaVersion: z.literal('docparse/v1'),
		extractor,
		input: z.strictObject({
			sha256: z.string().regex(/^[0-9a-f]{64}$/),
			sizeBytes: z.int().min(1),
			detectedFormat: z.enum(DETECTED_FORMATS),
			pageCount: z.int().min(1).nullable()
		}),
		status: z.enum(['complete', 'partial']),
		text: z.string().min(1),
		blocks: z.array(block).min(1),
		/** Absent in answers of extractors that did not report tables. */
		tables: z.array(table).optional(),
		flags: z.strictObject({
			ocrUsed: z.boolean(),
			ocrPages: z.array(z.int().min(1)),
			incompleteReasons: z.array(z.enum(INCOMPLETE_REASONS)),
			externalResourcesIgnored: z.boolean()
		}),
		stats: z.strictObject({ durationMs: z.int().min(0) })
	})
	.superRefine((value, context) => {
		const problem = (message: string) => {
			context.addIssue({ code: 'custom', message });
		};
		if ((value.status === 'partial') !== value.flags.incompleteReasons.length > 0) {
			problem('status partial goes with incomplete reasons and only with them');
		}
		if (value.flags.ocrUsed !== value.flags.ocrPages.length > 0) problem('ocrUsed goes with OCR pages');
		if (new Set(value.flags.ocrPages).size !== value.flags.ocrPages.length) problem('OCR pages repeat');
		if (new Set(value.flags.incompleteReasons).size !== value.flags.incompleteReasons.length) {
			problem('incomplete reasons repeat');
		}
		const length = codePointLength(value.text);
		let previousEnd = 0;
		const ids = new Set<string>();
		for (const b of value.blocks) {
			if (ids.has(b.id)) problem(`block ${b.id} repeats`);
			ids.add(b.id);
			if (b.start < previousEnd || b.end <= b.start || b.end > length) {
				problem(`block ${b.id} overlaps, is empty or lies outside the text`);
			}
			previousEnd = b.end;
		}
		checkTables(value, problem);
	});

export type ParseResponse = z.infer<typeof parseResponse>;
export type ParseBlock = ParseResponse['blocks'][number];
export type ParseTable = z.infer<typeof table>;
export type ParseTableCell = z.infer<typeof tableCell>;

const errorResponse = z.strictObject({
	error: z.strictObject({ code: z.enum(DOCPARSE_ERROR_CODES), retryable: z.boolean(), message: z.string().min(1) })
});

/**
 * - one of the service's codes (section 4.4);
 * - `unavailable` — no connection to the gateway or the connection broke;
 * - `invalid_response` — the answer does not follow the contract (a defect of the service, not of the file);
 * - `cancelled` — the caller aborted.
 */
export type DocparseFailureCode = DocparseErrorCode | 'unavailable' | 'invalid_response' | 'cancelled';

export interface DocparseFailure {
	code: DocparseFailureCode;
	retryable: boolean;
	/** Without document content. */
	message: string;
}

export type DocparseResult = { ok: true; value: ParseResponse } | { ok: false; error: DocparseFailure };

const failure = (code: DocparseFailureCode, retryable: boolean, message: string): DocparseResult => ({
	ok: false,
	error: { code, retryable, message }
});

/** Longest the client waits: the service gives up at 90 s with OCR, the gateway at 120 s. */
const REQUEST_TIMEOUT_MS = 125_000;
/** A parse answer carries at most the text of 30 pages with its blocks. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ParseRequest {
	bytes: Uint8Array<ArrayBuffer>;
	declaredName: string;
	requestId: string;
	signal?: AbortSignal;
}

export interface Docparse {
	parse(request: ParseRequest): Promise<DocparseResult>;
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new SyntaxError('response is too large');
	return JSON.parse(text);
}

export class DocparseClient implements Docparse {
	readonly #url: string;

	constructor(baseUrl: string) {
		this.#url = `${baseUrl.replace(/\/+$/, '')}/v1/parse`;
	}

	async parse(request: ParseRequest): Promise<DocparseResult> {
		const form = new FormData();
		form.append('file', new Blob([request.bytes]), 'upload');
		form.append('declared_name', request.declaredName);
		form.append('request_id', request.requestId);
		const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(request.signal ? [request.signal] : [])];
		let response: Response;
		let body: unknown;
		try {
			response = await fetch(this.#url, { method: 'POST', body: form, signal: AbortSignal.any(signals) });
			body = await readJson(response);
		} catch (error) {
			if (request.signal?.aborted) return failure('cancelled', false, 'the caller cancelled the parse');
			if (error instanceof SyntaxError) return failure('invalid_response', false, 'the answer is not JSON');
			if (error instanceof DOMException && error.name === 'TimeoutError') {
				return failure('timeout', true, 'no answer from the parser in time');
			}
			// fetch reports a refused, reset or broken connection as a TypeError.
			if (error instanceof TypeError) return failure('unavailable', true, 'the parser is unreachable');
			throw error;
		}
		if (response.status === 200) {
			const parsed = parseResponse.safeParse(body);
			if (!parsed.success) return failure('invalid_response', false, 'the answer does not follow docparse/v1');
			return { ok: true, value: parsed.data };
		}
		const parsed = errorResponse.safeParse(body);
		if (!parsed.success) {
			return failure('invalid_response', false, `status ${response.status} without a docparse/v1 error body`);
		}
		const { code, retryable, message } = parsed.data.error;
		return failure(code, retryable, message);
	}
}

let client: Docparse | undefined;

/** The configured parser, created on first use so that `vite build` does not need the environment. */
export function docparse(): Docparse {
	client ??= new DocparseClient(config().docparse.url);
	return client;
}
