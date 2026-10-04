import { describe, expect, it } from 'vitest';
import { codePointLength, codePointToUtf16, sliceByCodePoints, utf16ToCodePoint } from './offsets';

// «Go 🚀 Rust»: the rocket is one code point and two UTF-16 units.
const text = 'Go 🚀 Rust';

describe('code point offsets', () => {
	it('count a character outside the BMP as one code point', () => {
		expect(text.length).toBe(10);
		expect(codePointLength(text)).toBe(9);
		expect(codePointLength('')).toBe(0);
	});

	it('map code points to UTF-16 indexes past an emoji', () => {
		expect(codePointToUtf16(text, 0)).toBe(0);
		expect(codePointToUtf16(text, 3)).toBe(3);
		expect(codePointToUtf16(text, 4)).toBe(5);
		expect(codePointToUtf16(text, 9)).toBe(10);
		expect(() => codePointToUtf16(text, 10)).toThrow(RangeError);
		expect(() => codePointToUtf16(text, -1)).toThrow(RangeError);
	});

	it('slice the text a code point range names, where String.slice does not', () => {
		// «Rust» is code points 5..9.
		expect(sliceByCodePoints(text, { start: 5, end: 9 })).toBe('Rust');
		expect(text.slice(5, 9)).not.toBe('Rust');
		expect(sliceByCodePoints(text, { start: 3, end: 4 })).toBe('🚀');
		expect(() => sliceByCodePoints(text, { start: 4, end: 3 })).toThrow(RangeError);
	});

	it('map UTF-16 indexes back and refuse one inside a surrogate pair', () => {
		expect(utf16ToCodePoint(text, 5)).toBe(4);
		expect(utf16ToCodePoint(text, 10)).toBe(9);
		expect(() => utf16ToCodePoint(text, 4)).toThrow(/surrogate pair/);
	});

	it('count a lone surrogate as one code point', () => {
		const broken = `a${String.fromCharCode(0xd83d)}b`;
		expect(codePointLength(broken)).toBe(3);
		expect(sliceByCodePoints(broken, { start: 2, end: 3 })).toBe('b');
	});

	it('round-trip every boundary of a mixed string', () => {
		const mixed = 'Привет 👩‍💻 C++ 𝔘 end';
		const points = Array.from(mixed);
		for (let offset = 0; offset <= points.length; offset++) {
			expect(utf16ToCodePoint(mixed, codePointToUtf16(mixed, offset))).toBe(offset);
			expect(sliceByCodePoints(mixed, { start: 0, end: offset })).toBe(points.slice(0, offset).join(''));
		}
	});
});
