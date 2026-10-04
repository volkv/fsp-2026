import { describe, expect, it } from 'vitest';
import { detectFormat } from './signature';

const bytes = (...parts: (string | number[])[]) =>
	Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? Array.from(Buffer.from(part, 'latin1')) : part)));

describe('detectFormat', () => {
	it('reads the format from the content, not from a name', () => {
		expect(detectFormat(bytes('%PDF-1.7\n'))).toBe('pdf');
		expect(detectFormat(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
		expect(detectFormat(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
		expect(detectFormat(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe('doc');
		expect(detectFormat(bytes('{\\rtf1\\ansi'))).toBe('rtf');
		expect(detectFormat(new TextEncoder().encode('Резюме: Go, PostgreSQL'))).toBe('txt');
	});

	it('tells a Word document from an ODF text and from other archives', () => {
		const zip = [0x50, 0x4b, 0x03, 0x04];
		expect(detectFormat(bytes(zip, 'xxxx[Content_Types].xml....word/document.xml'))).toBe('docx');
		expect(detectFormat(bytes(zip, '.'.repeat(26), 'mimetypeapplication/vnd.oasis.opendocument.text'))).toBe('odt');
		expect(detectFormat(bytes(zip, 'xl/workbook.xml'))).toBeNull();
	});

	it('refuses binary content it does not know', () => {
		expect(detectFormat(bytes([0x00, 0x01, 0x02, 0xfe]))).toBeNull();
		expect(detectFormat(bytes([0xc3, 0x28]))).toBeNull();
	});
});
