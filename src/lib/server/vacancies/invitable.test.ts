import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { isInvitable } = await import('./invitable');

const own = {
	origin: 'own' as const,
	status: 'published',
	salaryMin: 200_000,
	salaryMax: 300_000,
	salaryCurrency: 'RUB',
	salaryTaxBase: 'gross' as const
};

describe('isInvitable', () => {
	it('accepts a published own vacancy with a full range in roubles', () => {
		expect(isInvitable(own)).toEqual({ invitable: true });
	});

	it('refuses an external vacancy even with a full range', () => {
		expect(isInvitable({ ...own, origin: 'external', status: 'active' })).toEqual({
			invitable: false,
			reason: 'external_vacancy'
		});
	});

	it('refuses an unpublished vacancy', () => {
		expect(isInvitable({ ...own, status: 'paused' })).toEqual({ invitable: false, reason: 'not_published' });
	});

	it('refuses a one-sided range, an unknown tax base and a range not in roubles', () => {
		expect(isInvitable({ ...own, salaryMax: null })).toEqual({ invitable: false, reason: 'incomplete_salary' });
		expect(isInvitable({ ...own, salaryTaxBase: 'unknown' })).toEqual({
			invitable: false,
			reason: 'incomplete_salary'
		});
		expect(isInvitable({ ...own, salaryCurrency: 'USD' })).toEqual({ invitable: false, reason: 'incomplete_salary' });
	});
});
