import { describe, expect, it } from 'vitest';
import { base32 } from './encoding';

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
