// Which variant reads a batch is decided by its content: a document the parser reports tables of (PDF, DOCX, ODT,
// RTF) is a protocol, anything else an export. A protocol without pages (DOCX, ODT, RTF) is read from its tables as
// a PDF one is.
import { describe, expect, it } from 'vitest';
import type { Docparse, ParseRequest, ParseResponse } from '$lib/server/documents/docparse';
import { codePointLength } from '$lib/text/offsets';
import { feedFor } from './feed';
import { parseProfile, type MappingProfile } from './profile';

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

function bytesOf(...parts: (Uint8Array | string)[]): Uint8Array<ArrayBuffer> {
	const chunks = parts.map((part) => (typeof part === 'string' ? ascii(part) : part));
	const out = new Uint8Array(new ArrayBuffer(chunks.reduce((n, c) => n + c.byteLength, 0)));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

const ZIP = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
const DOCUMENTS = {
	docx: bytesOf(ZIP, '....word/document.xml....'),
	odt: bytesOf(ZIP, '..........mimetypeapplication/vnd.oasis.opendocument.text'),
	rtf: bytesOf('{\\rtf1\\ansi protocol}'),
	pdf: bytesOf('%PDF-1.7\n')
} as const;

const profile: MappingProfile = (() => {
	const parsed = parseProfile({
		name: 'test-protocol',
		columns: { place: 'Место', fspId: 'ФСП ID', fullName: 'Участник' },
		competition: {
			title: 'Кубок России по спортивному программированию, финал',
			startDate: '2026-04-26',
			discipline: 'algorithmic',
			level: 'russian_cup'
		},
		defaults: { status: 'official' }
	});
	if (!parsed.ok) throw new Error(parsed.issues.join('; '));
	return parsed.profile;
})();

/** The answer for a document without pages: its only table, one block per cell. */
function pagelessAnswer(format: 'docx' | 'odt' | 'rtf'): ParseResponse {
	const grid = [
		['Место', 'ФСП ID', 'Участник'],
		['1', 'FSP-000201', 'Пример А.'],
		['2', 'FSP-000202', 'Пример Б.']
	];
	let text = '';
	const blocks: ParseResponse['blocks'] = [];
	const rows = grid.map((row) =>
		row.map((cell, col) => {
			const start = codePointLength(text);
			text += `${cell}\n`;
			const id = `d-b${String(blocks.length + 1).padStart(3, '0')}`;
			blocks.push({ id, page: null, kind: 'table_cell', column: null, start, end: start + codePointLength(cell) });
			return { col, text: cell, blockIds: [id] };
		})
	);
	return {
		schemaVersion: 'docparse/v1',
		extractor: { name: 'docparse', version: '1.0.0' },
		input: { sha256: 'b'.repeat(64), sizeBytes: 100, detectedFormat: format, pageCount: null },
		status: 'complete',
		text,
		blocks,
		tables: [{ id: 'd-t001', page: null, bbox: null, columnCount: 3, rows }],
		flags: { ocrUsed: false, ocrPages: [], incompleteReasons: [], externalResourcesIgnored: false },
		stats: { durationMs: 1 }
	};
}

function parserAnswering(value: ParseResponse | null): { parser: () => Docparse; requests: ParseRequest[] } {
	const requests: ParseRequest[] = [];
	const docparse: Docparse = {
		parse(request) {
			requests.push(request);
			if (value === null) throw new Error('an export is not sent to the parser');
			return Promise.resolve({ ok: true, value });
		}
	};
	return { parser: () => docparse, requests };
}

describe('feedFor', () => {
	it('reads DOCX, ODT and RTF protocols from their tables through the parser', async () => {
		for (const format of ['docx', 'odt', 'rtf'] as const) {
			const bytes = DOCUMENTS[format];
			const { parser, requests } = parserAnswering(pagelessAnswer(format));
			const feed = feedFor(bytes, parser);
			expect(feed.variant).toBe('pdf-protocols');
			const read = await feed.readBatch({
				bytes,
				declaredName: `protocol.${format}`,
				profile,
				declaredComplete: false,
				requestId: 'test'
			});
			if (!read.ok) throw new Error(read.error.message);
			expect(requests).toHaveLength(1);
			expect(read.value).toMatchObject({ format, issues: [], rowsRead: 2, completeness: { complete: true } });
			expect(read.value.rows.map((r) => [r.result.place, r.participant.fspId, r.page])).toEqual([
				[1, 'FSP-000201', undefined],
				[2, 'FSP-000202', undefined]
			]);
		}
	});

	it('takes a PDF for a protocol and anything else for an export, never by the name', () => {
		const { parser } = parserAnswering(null);
		expect(feedFor(DOCUMENTS.pdf, parser).variant).toBe('pdf-protocols');
		expect(feedFor(bytesOf('Место;ФСП ID\n1;FSP-1\n'), parser).variant).toBe('file');
		expect(feedFor(bytesOf(ZIP, '....xl/workbook.xml....'), parser).variant).toBe('file');
		// A legacy DOC shares its signature with a legacy XLS export: it is not taken for a protocol.
		expect(feedFor(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), parser).variant).toBe('file');
	});

	it('refuses a document as an export', async () => {
		const { parser, requests } = parserAnswering(null);
		const exportFeed = feedFor(bytesOf('Место;ФСП ID\n'), parser);
		const read = await exportFeed.readBatch({
			bytes: DOCUMENTS.docx,
			declaredName: 'results.csv',
			profile,
			declaredComplete: true,
			requestId: 'test'
		});
		expect(read).toMatchObject({ ok: false, error: { code: 'unsupported_format' } });
		expect(requests).toEqual([]);
	});
});
