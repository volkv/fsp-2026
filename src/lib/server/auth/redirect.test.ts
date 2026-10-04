import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './redirect';

describe('safeReturnTo', () => {
	it('keeps a path of the application with its query', () => {
		expect(safeReturnTo('/account?fsp=linked')).toBe('/account?fsp=linked');
	});

	it('refuses anything that leaves the origin or splits a header', () => {
		for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', 'account', '/a\r\nb', '', null]) {
			expect(safeReturnTo(value)).toBeNull();
		}
	});
});
