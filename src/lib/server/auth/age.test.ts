import { describe, expect, it } from 'vitest';
import { addYears, decideAge, parseBirthDate } from './age';

const now = new Date('2026-09-25T10:00:00Z');

describe('age on the registration path', () => {
	it('accepts only real past dates', () => {
		expect(parseBirthDate('2000-02-29', now)).toBe('2000-02-29');
		expect(parseBirthDate('2001-02-29', now)).toBeNull();
		expect(parseBirthDate('2027-01-01', now)).toBeNull();
		expect(parseBirthDate('1890-01-01', now)).toBeNull();
		expect(parseBirthDate('25.09.2000', now)).toBeNull();
	});

	it('moves 29 February to 1 March in a year without it', () => {
		expect(addYears('2012-02-29', 14)).toBe('2026-03-01');
		expect(addYears('2012-02-28', 14)).toBe('2026-02-28');
	});

	it('refuses under 14 until the 14th birthday and keeps 14–17 when minors are allowed', () => {
		expect(decideAge('2012-09-26', now, true)).toEqual({ kind: 'ineligible', eligibleFrom: '2026-09-26' });
		expect(decideAge('2012-09-25', now, true)).toEqual({ kind: 'eligible', band: 14 });
		expect(decideAge('2008-09-26', now, true)).toEqual({ kind: 'eligible', band: 17 });
		expect(decideAge('2008-09-25', now, true)).toEqual({ kind: 'eligible', band: 'adult' });
	});

	it('treats 14–17 like under 14 until majority when the minor policy is off', () => {
		expect(decideAge('2010-01-01', now, false)).toEqual({ kind: 'ineligible', eligibleFrom: '2028-01-01' });
		expect(decideAge('2000-01-01', now, false)).toEqual({ kind: 'eligible', band: 'adult' });
	});
});
