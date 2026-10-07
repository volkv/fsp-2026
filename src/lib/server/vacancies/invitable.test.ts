import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { isInvitable } = await import('./invitable');

const vacancy = {
	status: 'published',
	salaryMin: 200_000,
	salaryMax: 300_000,
	salaryCurrency: 'RUB',
	salaryTaxBase: 'gross' as const
};

describe('isInvitable', () => {
	it('accepts a published vacancy with a full range in roubles', () => {
		expect(isInvitable(vacancy)).toEqual({ invitable: true });
	});

	it('refuses an unpublished vacancy', () => {
		expect(isInvitable({ ...vacancy, status: 'paused' })).toEqual({ invitable: false, reason: 'not_published' });
	});

	it('refuses a one-sided range, an unknown tax base and a range not in roubles', () => {
		expect(isInvitable({ ...vacancy, salaryMax: null })).toEqual({ invitable: false, reason: 'incomplete_salary' });
		expect(isInvitable({ ...vacancy, salaryTaxBase: 'unknown' })).toEqual({
			invitable: false,
			reason: 'incomplete_salary'
		});
		expect(isInvitable({ ...vacancy, salaryCurrency: 'USD' })).toEqual({
			invitable: false,
			reason: 'incomplete_salary'
		});
	});
});
