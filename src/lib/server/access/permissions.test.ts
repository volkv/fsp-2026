import { describe, expect, it } from 'vitest';
import { can, companyAdmission, type AccessSubject } from './permissions';

const recruiter = (
	companyStatus: 'draft' | 'verified' | 'submitted' | 'suspended' | 'rejected' = 'verified',
	status: 'active' | 'removed' = 'active'
): AccessSubject => ({
	userId: 'u-r',
	via: 'session',
	candidate: null,
	membership: { memberId: 'm-1', companyId: 'company-a', role: 'recruiter', status, companyStatus },
	staff: { operator: false, admin: false, extraPermissions: [] }
});

const anonymous: AccessSubject = {
	userId: null,
	via: 'anonymous',
	candidate: null,
	membership: null,
	staff: { operator: false, admin: false, extraPermissions: [] }
};

describe('companyAdmission', () => {
	it('admits a company without a check, labels it, and refuses a suspended or rejected one', () => {
		expect(companyAdmission('draft')).toEqual({ admitted: true, label: 'unverified' });
		expect(companyAdmission('submitted')).toEqual({ admitted: true, label: 'unverified' });
		expect(companyAdmission('verified')).toEqual({ admitted: true, label: 'verified' });
		expect(companyAdmission('suspended')).toEqual({ admitted: false, reason: 'company_suspended' });
		expect(companyAdmission('rejected')).toEqual({ admitted: false, reason: 'company_rejected' });
	});
});

describe('can', () => {
	it('opens the catalog to an active member of a company the admission policy lets act, verified or not', () => {
		expect(can(recruiter(), 'catalog.search', null)).toEqual({ allowed: true });
		expect(can(recruiter('submitted'), 'catalog.search', null)).toEqual({ allowed: true });
		expect(can(recruiter('draft'), 'catalog.search', null)).toEqual({ allowed: true });
		expect(can(recruiter('suspended'), 'catalog.search', null)).toEqual({ allowed: false, reason: 'object' });
		expect(can(recruiter('rejected'), 'catalog.search', null)).toEqual({ allowed: false, reason: 'object' });
		expect(can(recruiter('verified', 'removed'), 'catalog.search', null)).toEqual({ allowed: false, reason: 'role' });
		expect(can(anonymous, 'catalog.search', null)).toEqual({ allowed: false, reason: 'unauthenticated' });
	});

	it('lets a company read only its own invitations', () => {
		expect(can(recruiter(), 'invitation.read', { companyId: 'company-a', candidateId: 'c-1' })).toEqual({
			allowed: true
		});
		expect(can(recruiter(), 'invitation.read', { companyId: 'company-b', candidateId: 'c-1' })).toEqual({
			allowed: false,
			reason: 'object'
		});
	});

	it('refuses an invitation by a vacancy that is not invitable', () => {
		const show = { allowed: true as const, projection: 'catalog' as const, extras: [], policyVersion: '1' };
		expect(
			can(recruiter(), 'invitation.create', { invitability: { invitable: false, reason: 'not_published' }, show })
		).toEqual({ allowed: false, reason: 'object' });
		expect(can(recruiter(), 'invitation.create', { invitability: { invitable: true }, show })).toEqual({
			allowed: true
		});
	});

	it('lets an unverified company send an offer without a vacancy and refuses a suspended one', () => {
		const show = { allowed: true as const, projection: 'catalog' as const, extras: [], policyVersion: '1' };
		expect(can(recruiter('draft'), 'invitation.create', { invitability: null, show })).toEqual({ allowed: true });
		expect(can(recruiter('suspended'), 'invitation.create', { invitability: null, show })).toEqual({
			allowed: false,
			reason: 'object'
		});
		expect(
			can(recruiter(), 'invitation.create', { invitability: null, show: { allowed: false, reason: 'not_visible' } })
		).toEqual({ allowed: false, reason: 'object' });
	});

	it('keeps API keys out of candidate, staff and key operations', () => {
		const key: AccessSubject = {
			...recruiter(),
			via: 'api_key',
			apiKeyPermissions: ['catalog.search', 'api_key.manage']
		};
		expect(can(key, 'catalog.search', null)).toEqual({ allowed: true });
		expect(can(key, 'api_key.manage', { companyId: 'company-a' })).toEqual({ allowed: false, reason: 'api_key_scope' });
		expect(can(key, 'vacancy.write', { companyId: 'company-a' })).toEqual({
			allowed: false,
			reason: 'api_key_scope'
		});
	});

	it('grants the journal to an administrator by the role and to an operator only with the explicit grant', () => {
		const operator = (extra: string[]): AccessSubject => ({
			...anonymous,
			userId: 'u-o',
			via: 'session',
			staff: { operator: true, admin: false, extraPermissions: extra }
		});
		expect(can(operator([]), 'audit.read', null)).toEqual({ allowed: false, reason: 'object' });
		expect(can(operator(['audit.read']), 'audit.read', null)).toEqual({ allowed: true });
		const admin: AccessSubject = {
			...anonymous,
			userId: 'u-a',
			via: 'session',
			staff: { operator: false, admin: true, extraPermissions: [] }
		};
		expect(can(admin, 'audit.read', null)).toEqual({ allowed: true });
		const person: AccessSubject = { ...anonymous, userId: 'u-p', via: 'session' };
		expect(can(person, 'audit.read', null)).toEqual({ allowed: false, reason: 'role' });
	});

	it('lets only an operator import FSP results, never by an API key', () => {
		const staff = (role: 'operator' | 'admin'): AccessSubject => ({
			...anonymous,
			userId: `u-${role}`,
			via: 'session',
			staff: { operator: role === 'operator', admin: role === 'admin', extraPermissions: [] }
		});
		expect(can(staff('operator'), 'fsp.import', null)).toEqual({ allowed: true });
		expect(can(staff('admin'), 'fsp.import', null)).toEqual({ allowed: false, reason: 'role' });
		expect(can(recruiter(), 'fsp.import', null)).toEqual({ allowed: false, reason: 'role' });
		expect(can(anonymous, 'fsp.import', null)).toEqual({ allowed: false, reason: 'unauthenticated' });
		const key: AccessSubject = { ...staff('operator'), via: 'api_key', apiKeyPermissions: ['fsp.import'] };
		expect(can(key, 'fsp.import', null)).toEqual({ allowed: false, reason: 'api_key_scope' });
	});

	it('lets only an operator moderate vacancies, never a company or an API key', () => {
		const operator: AccessSubject = {
			...anonymous,
			userId: 'u-o',
			via: 'session',
			staff: { operator: true, admin: false, extraPermissions: [] }
		};
		const admin: AccessSubject = { ...operator, staff: { operator: false, admin: true, extraPermissions: [] } };
		const owner: AccessSubject = {
			...recruiter(),
			membership: {
				memberId: 'm-2',
				companyId: 'company-a',
				role: 'owner',
				status: 'active',
				companyStatus: 'verified'
			}
		};
		expect(can(operator, 'vacancy.moderate', null)).toEqual({ allowed: true });
		expect(can(admin, 'vacancy.moderate', null)).toEqual({ allowed: false, reason: 'role' });
		expect(can(owner, 'vacancy.moderate', null)).toEqual({ allowed: false, reason: 'role' });
		expect(can(anonymous, 'vacancy.moderate', null)).toEqual({ allowed: false, reason: 'unauthenticated' });
		const key: AccessSubject = { ...operator, via: 'api_key', apiKeyPermissions: ['vacancy.moderate'] };
		expect(can(key, 'vacancy.moderate', null)).toEqual({ allowed: false, reason: 'api_key_scope' });
	});

	it('gives the review of attempts and the decision on a birth date to an operator in a session only', () => {
		const operator: AccessSubject = {
			userId: 'u-op',
			via: 'session',
			candidate: null,
			membership: null,
			staff: { operator: true, admin: false, extraPermissions: [] }
		};
		const admin: AccessSubject = { ...operator, staff: { operator: false, admin: true, extraPermissions: [] } };
		const candidate: AccessSubject = {
			...operator,
			candidate: { id: 'c-1', status: 'active' },
			staff: { operator: false, admin: false, extraPermissions: [] }
		};
		for (const permission of ['age.review', 'assessment.review'] as const) {
			expect(can(operator, permission, null)).toEqual({ allowed: true });
			expect(can(admin, permission, null)).toEqual({ allowed: false, reason: 'role' });
			expect(can(candidate, permission, null)).toEqual({ allowed: false, reason: 'role' });
			expect(can(recruiter(), permission, null)).toEqual({ allowed: false, reason: 'role' });
			expect(can(anonymous, permission, null)).toEqual({ allowed: false, reason: 'unauthenticated' });
			const key: AccessSubject = { ...operator, via: 'api_key', apiKeyPermissions: [permission] };
			expect(can(key, permission, null)).toEqual({ allowed: false, reason: 'api_key_scope' });
		}
	});

	it('lets a suspended company read its invitations but not report hiring', () => {
		const facts = { companyId: 'company-a', candidateId: 'c-1' };
		expect(can(recruiter('suspended'), 'invitation.read', facts)).toEqual({ allowed: true });
		expect(can(recruiter('suspended'), 'hiring.report', facts)).toEqual({ allowed: false, reason: 'object' });
	});

	it('lets the two sides of an offer write in its conversation, and nobody else; a suspended company only reads', () => {
		const facts = { companyId: 'company-a', candidateId: 'c-1' };
		const candidate = (id: string): AccessSubject => ({
			userId: 'u-c',
			via: 'session',
			candidate: { id, status: 'active' },
			membership: null,
			staff: { operator: false, admin: false, extraPermissions: [] }
		});
		expect(can(recruiter(), 'invitation.message', facts)).toEqual({ allowed: true });
		expect(can(candidate('c-1'), 'invitation.message', facts)).toEqual({ allowed: true });
		expect(can(candidate('c-2'), 'invitation.message', facts)).toEqual({ allowed: false, reason: 'object' });
		expect(can(recruiter(), 'invitation.message', { ...facts, companyId: 'company-b' })).toEqual({
			allowed: false,
			reason: 'object'
		});
		expect(can(recruiter('suspended'), 'invitation.message', facts)).toEqual({ allowed: false, reason: 'object' });
		expect(can(recruiter('suspended'), 'invitation.read', facts)).toEqual({ allowed: true });
		const operator: AccessSubject = {
			...anonymous,
			userId: 'u-o',
			via: 'session',
			staff: { operator: true, admin: true, extraPermissions: [] }
		};
		expect(can(operator, 'invitation.message', facts)).toEqual({ allowed: false, reason: 'role' });
		const key: AccessSubject = { ...recruiter(), via: 'api_key', apiKeyPermissions: ['invitation.read'] };
		expect(can(key, 'invitation.message', facts)).toEqual({ allowed: false, reason: 'api_key_scope' });
	});
});
