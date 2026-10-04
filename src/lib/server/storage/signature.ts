// File type by content signature, never by the file name or the type the browser sent (docs/domain.md, section 15.1).
// The formats are those the parser reads (docs/contracts.md, section 4.1); the parser checks the structure again.

export const DOCUMENT_FORMATS = ['pdf', 'docx', 'doc', 'rtf', 'odt', 'txt', 'png', 'jpeg'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const FORMAT_MIME: Readonly<Record<DocumentFormat, string>> = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	doc: 'application/msword',
	rtf: 'application/rtf',
	odt: 'application/vnd.oasis.opendocument.text',
	txt: 'text/plain; charset=utf-8',
	png: 'image/png',
	jpeg: 'image/jpeg'
};

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

function startsWith(bytes: Uint8Array, prefix: Uint8Array, at = 0): boolean {
	if (bytes.byteLength < at + prefix.byteLength) return false;
	return prefix.every((byte, index) => bytes[at + index] === byte);
}

function indexOf(bytes: Uint8Array, needle: Uint8Array, limit = bytes.byteLength): number {
	const end = Math.min(limit, bytes.byteLength) - needle.byteLength;
	outer: for (let i = 0; i <= end; i++) {
		for (let j = 0; j < needle.byteLength; j++) if (bytes[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

const PDF = ascii('%PDF-');
const ZIP = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
const OLE = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const RTF = ascii('{\\rtf');
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff);
const DOCX_PART = ascii('word/document.xml');
// ODF puts an uncompressed `mimetype` entry first (ODF 1.2, part 3, section 3.3), so its value sits in the first bytes.
const ODT_MIMETYPE = ascii('mimetypeapplication/vnd.oasis.opendocument.text');

/** A document without a text layer or a declared format is text only if it decodes as UTF-8 and has no NUL bytes. */
function isText(bytes: Uint8Array): boolean {
	if (bytes.includes(0)) return false;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/** The format of the content, or `null` when it is none the parser reads. */
export function detectFormat(bytes: Uint8Array): DocumentFormat | null {
	if (startsWith(bytes, PDF)) return 'pdf';
	if (startsWith(bytes, PNG)) return 'png';
	if (startsWith(bytes, JPEG)) return 'jpeg';
	if (startsWith(bytes, OLE)) return 'doc';
	if (startsWith(bytes, RTF)) return 'rtf';
	if (startsWith(bytes, ZIP)) {
		if (indexOf(bytes, ODT_MIMETYPE, 128) >= 0) return 'odt';
		// Entry names are stored uncompressed in the local and central headers.
		if (indexOf(bytes, DOCX_PART) >= 0) return 'docx';
		return null;
	}
	return isText(bytes) ? 'txt' : null;
}
