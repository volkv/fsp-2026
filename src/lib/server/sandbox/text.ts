import { createHash } from 'node:crypto';

export function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The longest prefix of `text` that fits into `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, 'utf8');
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return text.slice(0, end);
}
