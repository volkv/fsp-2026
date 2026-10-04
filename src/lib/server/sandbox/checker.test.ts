import { describe, expect, it } from 'vitest';
import { outputMatches } from './checker';
import { truncateUtf8 } from './text';

describe('outputMatches', () => {
	it('exact: ignores line endings, trailing spaces and trailing empty lines only', () => {
		const exact = { kind: 'exact' } as const;
		expect(outputMatches(exact, '1 2\r\n3  \n\n\n', '1 2\n3')).toBe(true);
		expect(outputMatches(exact, '1  2\n3', '1 2\n3')).toBe(false);
		expect(outputMatches(exact, '\n1 2\n3', '1 2\n3')).toBe(false);
		expect(outputMatches(exact, '', '\n')).toBe(true);
	});

	it('tokens: compares whitespace-separated tokens', () => {
		const tokens = { kind: 'tokens' } as const;
		expect(outputMatches(tokens, '1\n2   3\t\n', ' 1 2 3')).toBe(true);
		expect(outputMatches(tokens, '1 2', '1 2 3')).toBe(false);
		expect(outputMatches(tokens, '01', '1')).toBe(false);
	});

	it('float_eps: absolute or relative difference within eps, other tokens exact', () => {
		const floats = { kind: 'float_eps', eps: 1e-6 } as const;
		expect(outputMatches(floats, '0.3333333 yes', '0.33333333 yes')).toBe(true);
		expect(outputMatches(floats, '1000000.5', '1000000.0')).toBe(true);
		expect(outputMatches(floats, '0.34', '0.33')).toBe(false);
		expect(outputMatches(floats, '0.3333333 no', '0.3333333 yes')).toBe(false);
		expect(outputMatches(floats, 'nan', '0')).toBe(false);
		expect(outputMatches(floats, '1e3', '1000')).toBe(true);
	});
});

describe('truncateUtf8', () => {
	it('keeps whole characters within the byte limit', () => {
		expect(truncateUtf8('abc', 3)).toBe('abc');
		expect(truncateUtf8('привет', 5)).toBe('пр');
		expect(truncateUtf8('a😀b', 4)).toBe('a');
	});
});
