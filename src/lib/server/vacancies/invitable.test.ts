import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { isInvitable } = await import('./invitable');
const { companyGate } = await import('$lib/server/companies/gate');

const own = {
	origin: 'own' as const,
	status: 'published',
	company: companyGate('verified'),
	salaryMin: 200_000,
	salaryMax: 300_000,
	salaryTaxBase: 'gross' as const
};

describe('isInvitable', () => {
	it('accepts a published own vacancy of a verified company with a full range', () => {
		expect(isInvitable(own)).toEqual({ invitable: true });
	});

	it('refuses an external vacancy even with a full range', () => {
		expect(isInvitable({ ...own, origin: 'external', company: companyGate(null), status: 'active' })).toEqual({
			invitable: false,
			reason: 'external_vacancy'
		});
	});

	it('refuses a company that may not act right now, whatever closed it', () => {
		for (const status of ['draft', 'submitted', 'suspended', 'rejected'] as const) {
			expect(isInvitable({ ...own, company: companyGate(status) })).toEqual({
				invitable: false,
				reason: 'company_not_verified'
			});
		}
	});

	it('refuses an unpublished vacancy', () => {
		expect(isInvitable({ ...own, status: 'paused' })).toEqual({ invitable: false, reason: 'not_published' });
	});

	it('refuses a one-sided range and an unknown tax base', () => {
		expect(isInvitable({ ...own, salaryMax: null })).toEqual({ invitable: false, reason: 'incomplete_salary' });
		expect(isInvitable({ ...own, salaryTaxBase: 'unknown' })).toEqual({
			invitable: false,
			reason: 'incomplete_salary'
		});
	});
});
