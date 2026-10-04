// Offsets of `docparse` blocks and claim quotes are Unicode code points (docs/contracts.md, section 4.2), while
// JavaScript strings are indexed by UTF-16 code units: a character outside the BMP (an emoji) takes two units.
// Every conversion between the two, on the server and in the browser (quote highlighting), goes through this module;
// `String.slice` with code point offsets is a bug.

export interface CodePointRange {
	/** Inclusive start, code points. */
	start: number;
	/** Exclusive end, code points. */
	end: number;
}

function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
	return unit >= 0xdc00 && unit <= 0xdfff;
}

/** Number of code points in `text`; a lone surrogate counts as one. */
export function codePointLength(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (isHighSurrogate(text.charCodeAt(i)) && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) i++;
		count++;
	}
	return count;
}

/** UTF-16 index of the code point offset `offset`; `offset` equal to the length maps to `text.length`. */
export function codePointToUtf16(text: string, offset: number): number {
	if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`invalid code point offset ${offset}`);
	let index = 0;
	for (let seen = 0; seen < offset; seen++) {
		if (index >= text.length) throw new RangeError(`code point offset ${offset} is past the end of the text`);
		const unit = text.charCodeAt(index);
		index += isHighSurrogate(unit) && index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1)) ? 2 : 1;
	}
	return index;
}

/** Code point offset of the UTF-16 index `index`; an index inside a surrogate pair is an error. */
export function utf16ToCodePoint(text: string, index: number): number {
	if (!Number.isInteger(index) || index < 0 || index > text.length) {
		throw new RangeError(`invalid UTF-16 index ${index}`);
	}
	if (
		index > 0 &&
		index < text.length &&
		isLowSurrogate(text.charCodeAt(index)) &&
		isHighSurrogate(text.charCodeAt(index - 1))
	) {
		throw new RangeError(`UTF-16 index ${index} splits a surrogate pair`);
	}
	return codePointLength(text.slice(0, index));
}

/** The substring between code point offsets. */
export function sliceByCodePoints(text: string, range: CodePointRange): string {
	if (range.end < range.start) throw new RangeError(`range end ${range.end} is before start ${range.start}`);
	return text.slice(codePointToUtf16(text, range.start), codePointToUtf16(text, range.end));
}
