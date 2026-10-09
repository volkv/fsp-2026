// The client refuses an answer whose tables break the invariants of docs/contracts.md 4.2: cells on the grid without
// overlapping, the text of a cell equal to its blocks, a block in one cell of its page, a continuation of a table of
// the previous page with the same columns, repeated header rows only on a continuation. One client sends no more parses
// at once than it is given slots: a parse beyond them waits for a slot instead of reaching the service.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocparseClient, type ParseResponse } from './docparse';
import { codePointLength } from '$lib/text/offsets';

type Table = NonNullable<ParseResponse['tables']>[number];

/**
 * A parse answer of two pages, each with a 2×2 table of one block per cell: the text is the cells in order, one per
 * line; the table of page 2 continues the one of page 1.
 */
function answer(): ParseResponse {
	const cells = [
		['Место', 'Участник', '1', 'Пример А.'],
		['2', 'Пример Б.', '3', 'Пример В.']
	];
	let text = '';
	const blocks: ParseResponse['blocks'] = [];
	const tables: Table[] = [];
	cells.forEach((pageCells, p) => {
		const page = p + 1;
		const ids = pageCells.map((cell, i) => {
			const start = codePointLength(text);
			text += `${cell}\n`;
			const id = `p${page}-b${String(i + 1).padStart(3, '0')}`;
			blocks.push({ id, page, kind: 'table_cell', column: null, start, end: start + codePointLength(cell) });
			return id;
		});
		const cell = (i: number, col: number) => ({ col, text: pageCells[i] as string, blockIds: [ids[i] as string] });
		tables.push({
			id: `p${page}-t001`,
			page,
			bbox: [40, 100, 560, 200],
			columnCount: 2,
			rows: [
				[cell(0, 0), cell(1, 1)],
				[cell(2, 0), cell(3, 1)]
			],
			...(page === 2 ? { continues: 'p1-t001' } : {})
		});
	});
	return {
		schemaVersion: 'docparse/v1',
		extractor: { name: 'docparse', version: '1.0.0' },
		input: { sha256: 'a'.repeat(64), sizeBytes: 100, detectedFormat: 'pdf', pageCount: 2 },
		status: 'complete',
		text,
		blocks,
		tables,
		flags: { ocrUsed: false, ocrPages: [], incompleteReasons: [], externalResourcesIgnored: false },
		stats: { durationMs: 1 }
	};
}

function tableOf(value: ParseResponse, index: number): Table {
	const table = value.tables?.[index];
	if (!table) throw new Error(`no table ${index}`);
	return table;
}

async function parse(body: unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
	);
	return new DocparseClient('http://docparse.test', 2).parse({
		bytes: new Uint8Array(new ArrayBuffer(1)),
		declaredName: 'protocol.pdf',
		requestId: 'test'
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

const refused = { ok: false, error: { code: 'invalid_response', retryable: false } };

describe('docparse tables', () => {
	it('accepts tables that keep the invariants, a continuation with its repeated header too', async () => {
		const valid = answer();
		tableOf(valid, 1).repeatedHeaderRows = 1;
		const result = await parse(valid);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.tables?.map((t) => t.id)).toEqual(['p1-t001', 'p2-t001']);
	});

	it('accepts an answer without tables and a grid position no cell covers', async () => {
		const without = answer();
		delete without.tables;
		expect((await parse(without)).ok).toBe(true);
		const gap = answer();
		// The second row of page 1 loses its first cell: its block stays a table cell block of no cell.
		tableOf(gap, 0).rows[1]?.shift();
		expect((await parse(gap)).ok).toBe(true);
	});

	it('refuses overlapping cells and a cell leaving the grid', async () => {
		const overlap = answer();
		const first = tableOf(overlap, 0).rows[0]?.[0];
		if (!first) throw new Error('no cell');
		first.rowSpan = 2;
		expect(await parse(overlap)).toMatchObject(refused);

		const outside = answer();
		const last = tableOf(outside, 0).rows[1]?.[1];
		if (!last) throw new Error('no cell');
		last.colSpan = 2;
		expect(await parse(outside)).toMatchObject(refused);
	});

	it('refuses a cell whose text is not the text of its blocks, and a block in two cells', async () => {
		const differs = answer();
		const cell = tableOf(differs, 0).rows[1]?.[1];
		if (!cell) throw new Error('no cell');
		cell.text = 'Пример Г.';
		expect(await parse(differs)).toMatchObject(refused);

		const shared = answer();
		const [left, right] = tableOf(shared, 0).rows[1] ?? [];
		if (!left || !right) throw new Error('no cells');
		right.blockIds = [...left.blockIds];
		right.text = left.text;
		expect(await parse(shared)).toMatchObject(refused);
	});

	it('refuses a cell of blocks from another page', async () => {
		const foreign = answer();
		const [pageOne, pageTwo] = [tableOf(foreign, 0), tableOf(foreign, 1)];
		const cell = pageTwo.rows[0]?.[0];
		const other = pageOne.rows[0]?.[0];
		if (!cell || !other) throw new Error('no cells');
		pageOne.rows[0]?.shift();
		cell.blockIds = other.blockIds;
		cell.text = other.text;
		expect(await parse(foreign)).toMatchObject(refused);
	});

	it('refuses a continuation of a table that is not on the previous page or has other columns', async () => {
		const self = answer();
		tableOf(self, 0).continues = 'p1-t001';
		expect(await parse(self)).toMatchObject(refused);

		const columns = answer();
		tableOf(columns, 1).columnCount = 3;
		expect(await parse(columns)).toMatchObject(refused);
	});

	it('refuses repeated header rows without a continuation or covering the whole table', async () => {
		const first = answer();
		tableOf(first, 0).repeatedHeaderRows = 1;
		expect(await parse(first)).toMatchObject(refused);

		const all = answer();
		tableOf(all, 1).repeatedHeaderRows = 2;
		expect(await parse(all)).toMatchObject(refused);
	});
});

describe('docparse slots', () => {
	const request = (signal?: AbortSignal) => ({
		bytes: new Uint8Array(new ArrayBuffer(1)),
		declaredName: 'resume.pdf',
		requestId: 'test',
		...(signal ? { signal } : {})
	});

	it('sends a parse beyond its slots only when an earlier one is answered', async () => {
		const answers: ((response: Response) => void)[] = [];
		const fetch = vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve)));
		vi.stubGlobal('fetch', fetch);
		const client = new DocparseClient('http://docparse.test', 1);
		const first = client.parse(request());
		const second = client.parse(request());
		await vi.waitFor(() => {
			expect(fetch).toHaveBeenCalledTimes(1);
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fetch).toHaveBeenCalledTimes(1);
		answers[0]?.(new Response(JSON.stringify(answer()), { status: 200 }));
		expect((await first).ok).toBe(true);
		await vi.waitFor(() => {
			expect(fetch).toHaveBeenCalledTimes(2);
		});
		answers[1]?.(new Response(JSON.stringify(answer()), { status: 200 }));
		expect((await second).ok).toBe(true);
	});

	it('gives up a waiting parse when its caller cancels it', async () => {
		const fetch = vi.fn(() => new Promise<Response>(() => {}));
		vi.stubGlobal('fetch', fetch);
		const client = new DocparseClient('http://docparse.test', 1);
		void client.parse(request());
		const cancel = new AbortController();
		const waiting = client.parse(request(cancel.signal));
		cancel.abort();
		expect(await waiting).toMatchObject({ ok: false, error: { code: 'cancelled', retryable: false } });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
