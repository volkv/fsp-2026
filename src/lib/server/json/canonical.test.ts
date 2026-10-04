import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical';

describe('canonicalJson', () => {
	it('sorts object keys at every level and drops undefined members', () => {
		expect(canonicalJson({ b: [{ d: 1, c: null }], a: 'x', skipped: undefined })).toBe(
			'{"a":"x","b":[{"c":null,"d":1}]}'
		);
	});

	it('gives the same text for content read back in another key order', () => {
		const written = { stage: 'test', verdict: 'accepted', engine: { version: '1.12.3', name: 'go-judge' } };
		const readBack: unknown = JSON.parse(
			'{"engine":{"name":"go-judge","version":"1.12.3"},"verdict":"accepted","stage":"test"}'
		);
		expect(canonicalJson(readBack)).toBe(canonicalJson(written));
	});

	it('writes strings and numbers as JSON.stringify does', () => {
		expect(canonicalJson(['ё\n"', 1.5, -0, 1e21, true])).toBe(JSON.stringify(['ё\n"', 1.5, -0, 1e21, true]));
	});

	it('refuses values jsonb would not keep as they are', () => {
		expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
		expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
		expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
		expect(() => canonicalJson([undefined])).toThrow(TypeError);
	});
});
