import { describe, expect, it } from 'vitest';
import { base32, fromBase32 } from './encoding';

describe('base32', () => {
	it('matches the RFC 4648 test vectors in lowercase without padding', () => {
		const vectors: [string, string][] = [
			['', ''],
			['f', 'my'],
			['fo', 'mzxq'],
			['foo', 'mzxw6'],
			['foob', 'mzxw6yq'],
			['fooba', 'mzxw6ytb'],
			['foobar', 'mzxw6ytboi']
		];
		for (const [input, expected] of vectors) expect(base32(Buffer.from(input))).toBe(expected);
	});

	it('encodes 128 bits into 26 characters', () => {
		expect(base32(Buffer.alloc(16, 0xff))).toHaveLength(26);
	});
});

describe('fromBase32', () => {
	it('reads back what base32 writes, in any letter case', () => {
		for (const input of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
			const text = base32(Buffer.from(input));
			expect(Buffer.from(fromBase32(text) ?? []).toString()).toBe(input);
			expect(Buffer.from(fromBase32(text.toUpperCase()) ?? []).toString()).toBe(input);
		}
		const random = Uint8Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256);
		expect(fromBase32(base32(random))).toEqual(random);
	});

	it('refuses characters outside the alphabet and a tail that is not padding', () => {
		expect(fromBase32('mzxw1')).toBeNull();
		expect(fromBase32('mzxw6z')).toBeNull();
		expect(fromBase32('m')).toBeNull();
	});
});
