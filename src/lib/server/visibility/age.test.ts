import { describe, expect, it } from 'vitest';
import { ageBand } from './age';

const at = new Date('2026-10-05T12:00:00Z');
const day = (birthDate: string) => ({ birthDate, precision: 'day' as const, status: 'unverified' as const });
const year = (y: number) => ({ birthDate: `${y}-01-01`, precision: 'year' as const, status: 'unverified' as const });

describe('ageBand', () => {
	it('computes full years at the moment of the request', () => {
		expect(ageBand(day('2008-10-05'), at)).toBe('adult');
		expect(ageBand(day('2008-10-06'), at)).toBe(17);
		expect(ageBand(day('2012-10-05'), at)).toBe(14);
		expect(ageBand(day('2012-10-06'), at)).toBe('under_14');
	});

	it('is unknown without a date or with a conflict', () => {
		expect(ageBand({ birthDate: null, precision: null, status: 'unknown' }, at)).toBe('unknown');
		expect(ageBand({ ...day('2000-01-01'), status: 'conflict' }, at)).toBe('unknown');
	});

	it('with year precision is unknown only when the possible ages cross a regime boundary', () => {
		// Born in 2008: 17 or 18 on 2026-10-05 — crosses majority.
		expect(ageBand(year(2008), at)).toBe('unknown');
		// Born in 2012: 13 or 14 — crosses 14.
		expect(ageBand(year(2012), at)).toBe('unknown');
		// Born in 2009: 16 or 17 — no boundary between them.
		expect(ageBand(year(2009), at)).toBe(16);
		expect(ageBand(year(1990), at)).toBe('adult');
	});
});
