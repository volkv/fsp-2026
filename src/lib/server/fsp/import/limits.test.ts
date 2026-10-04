// Limits of an export file: a small crafted file must not make the process read, expand or allocate beyond what a
// results table needs. Each crafted file is refused with `limit_exceeded` before the work it asks for is done, so the
// refusal is quick and the process does not grow.
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readCsv } from './csv';
import { BatchFormatError, TABLE_LIMITS } from './table';
import { readXlsx } from './xlsx';

interface Member {
	name: string;
	content: string | Buffer;
	/** Stored size in the directory, when a test declares another one than the content has. */
	declaredSize?: number;
}

/** A ZIP of deflated members, as an office suite writes an XLSX. */
function zip(members: Member[]): Uint8Array {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const member of members) {
		const content = typeof member.content === 'string' ? Buffer.from(member.content, 'utf8') : member.content;
		const data = deflateRawSync(content, { level: 9 });
		const name = Buffer.from(member.name, 'utf8');
		const size = member.declaredSize ?? content.length;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc32(content), 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(size, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, data);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(8, 10);
		entry.writeUInt32LE(crc32(content), 16);
		entry.writeUInt32LE(data.length, 20);
		entry.writeUInt32LE(size, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, name);
		offset += local.length + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(members.length, 8);
	end.writeUInt16LE(members.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

function workbook(sheetXml: string, extra: Member[] = []): Uint8Array {
	return zip([
		{
			name: 'xl/workbook.xml',
			content:
				'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Результаты" sheetId="1" r:id="rId1"/></sheets></workbook>'
		},
		{
			name: 'xl/_rels/workbook.xml.rels',
			content:
				'<?xml version="1.0" encoding="UTF-8"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
		},
		{ name: 'xl/worksheets/sheet1.xml', content: sheetXml },
		...extra
	]);
}

const sheet = (rows: string) =>
	`<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
const header =
	'<row r="1"><c r="A1" t="inlineStr"><is><t>ФСП ID</t></is></c><c r="B1" t="inlineStr"><is><t>Место</t></is></c></row>';

function columnName(index: number): string {
	let name = '';
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	return name;
}

/**
 * Runs `read` and tells how long it took and how far the process grew above its peak so far (`maxRSS` never goes
 * down, so a growth below the earlier peak shows as none — the check is against a file that would add hundreds of
 * megabytes).
 */
function measured(read: () => unknown): { error: unknown; ms: number; growthMb: number } {
	const before = process.resourceUsage().maxRSS;
	const started = performance.now();
	let error: unknown = null;
	try {
		read();
	} catch (caught) {
		error = caught;
	}
	const ms = performance.now() - started;
	const growthMb = (process.resourceUsage().maxRSS - before) / 1024;
	return { error, ms, growthMb };
}

function expectLimit(error: unknown, message: RegExp) {
	expect(error).toBeInstanceOf(BatchFormatError);
	expect(error).toMatchObject({ code: 'limit_exceeded', message: expect.stringMatching(message) as unknown });
}

describe('XLSX limits', () => {
	it('refuses a sheet whose cells lie far to the right, quickly and without growing', () => {
		// Every row holds one cell in column ZZZ: 25 KB of file that a reader padding rows to their last column turns
		// into 90 million cells, a gigabyte of process.
		const rows = Array.from(
			{ length: 5_000 },
			(_, i) => `<row r="${i + 2}"><c r="ZZZ${i + 2}"><v>1</v></c></row>`
		).join('');
		const bytes = workbook(sheet(header + rows));
		expect(bytes.byteLength).toBeLessThan(32_000);
		const { error, ms, growthMb } = measured(() => readXlsx(bytes, { headerRow: 1 }));
		expectLimit(error, /ZZZ2 за пределами 256 колонок/);
		expect(ms).toBeLessThan(2_000);
		expect(growthMb).toBeLessThan(64);
	});

	it('refuses a sheet padded to its last allowed column in every row', () => {
		const last = columnName(TABLE_LIMITS.columns - 1);
		const rows = Array.from(
			{ length: TABLE_LIMITS.rows - 1 },
			(_, i) => `<row r="${i + 2}"><c r="${last}${i + 2}"><v>1</v></c></row>`
		).join('');
		const { error, ms, growthMb } = measured(() => readXlsx(workbook(sheet(header + rows)), { headerRow: 1 }));
		expectLimit(error, /ячеек/);
		expect(ms).toBeLessThan(2_000);
		expect(growthMb).toBeLessThan(64);
	});

	it('refuses more rows, columns or markup than a results table has', () => {
		const rows = '<row/>'.repeat(TABLE_LIMITS.rows + 1);
		const { error, ms, growthMb } = measured(() => readXlsx(workbook(sheet(header + rows)), { headerRow: 1 }));
		expectLimit(error, /больше 50\s000 строк/);
		expect(ms).toBeLessThan(1_000);
		expect(growthMb).toBeLessThan(64);
		// Cells without references take the next column.
		const wide = `<row r="2">${'<c><v>1</v></c>'.repeat(TABLE_LIMITS.columns + 1)}</row>`;
		expectLimit(measured(() => readXlsx(workbook(sheet(header + wide)), { headerRow: 1 })).error, /IW2 за пределами/);
		// A row of empty elements is refused before its tree is built.
		const dense = `<row r="2">${'<c/>'.repeat(TABLE_LIMITS.cells + 1)}</row>`;
		const refused = measured(() => readXlsx(workbook(sheet(header + dense)), { headerRow: 1 }));
		expectLimit(refused.error, /размечена больше чем/);
		expect(refused.growthMb).toBeLessThan(64);
	});

	it('refuses a part that expands beyond the limit without expanding it', () => {
		const big = 'x'.repeat(TABLE_LIMITS.partBytes + 1);
		const { error, ms, growthMb } = measured(() =>
			readXlsx(workbook(sheet(header), [{ name: 'xl/sharedStrings.xml', content: big }]), { headerRow: 1 })
		);
		expectLimit(error, /sharedStrings\.xml/);
		expect(ms).toBeLessThan(500);
		expect(growthMb).toBeLessThan(64);
	});

	it('refuses a cell longer than a spreadsheet allows', () => {
		const long = 'я'.repeat(TABLE_LIMITS.cellChars + 1);
		const row = `<row r="2"><c r="A2" t="inlineStr"><is><t>${long}</t></is></c></row>`;
		expectLimit(measured(() => readXlsx(workbook(sheet(header + row)), { headerRow: 1 })).error, /A2/);
	});

	it('reads a table within the limits, a far cell of a row included', () => {
		const last = columnName(TABLE_LIMITS.columns - 1);
		const row = `<row r="2"><c r="A2" t="inlineStr"><is><t>FSP-000101</t></is></c><c r="${last}2"><v>7</v></c></row>`;
		const table = readXlsx(workbook(sheet(header + row)), { headerRow: 1 });
		expect(table.header).toEqual(['ФСП ID', 'Место']);
		expect(table.rows).toHaveLength(1);
		expect(table.rows[0]?.cells[0]).toBe('FSP-000101');
		expect(table.rows[0]?.cells[TABLE_LIMITS.columns - 1]).toBe('7');
	});
});

describe('CSV limits', () => {
	const csv = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
	const read = (text: string) => () => readCsv(csv(text), { encoding: 'utf-8', delimiter: ';', headerRow: 1 });

	it('refuses a record with more columns than allowed', () => {
		expectLimit(measured(read(`ФСП ID;Место\n${';'.repeat(TABLE_LIMITS.columns)}\n`)).error, /строка 2.*колонок/);
	});

	it('refuses more rows than allowed, quickly and without growing', () => {
		const { error, ms, growthMb } = measured(read(`ФСП ID;Место\n${'\n'.repeat(TABLE_LIMITS.rows + 1)}`));
		expectLimit(error, /строк/);
		expect(ms).toBeLessThan(2_000);
		expect(growthMb).toBeLessThan(64);
	});

	it('refuses more cells than allowed', () => {
		const row = `${';'.repeat(TABLE_LIMITS.columns - 1)}\n`;
		const rows = row.repeat(Math.ceil(TABLE_LIMITS.cells / TABLE_LIMITS.columns) + 1);
		expectLimit(measured(read(`ФСП ID;Место\n${rows}`)).error, /ячеек/);
	});

	it('refuses a cell longer than a spreadsheet allows', () => {
		expectLimit(measured(read(`ФСП ID;Место\n${'1'.repeat(TABLE_LIMITS.cellChars + 1)};1\n`)).error, /строка 2/);
	});
});
