import { describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { navPermissions } from './viewer';

const staff = (
	roles: { operator?: boolean; admin?: boolean },
	extraPermissions: readonly string[] = []
): AccessSubject => ({
	userId: 'u-s',
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: roles.operator ?? false, admin: roles.admin ?? false, extraPermissions }
});

describe('navPermissions', () => {
	it('gives the journal to an operator only with the explicit grant', () => {
		expect(navPermissions(staff({ operator: true }), false)).toEqual([]);
		expect(navPermissions(staff({ operator: true }, ['audit.read']), false)).toEqual(['audit.read']);
	});

	it('gives the journal to an administrator by the role', () => {
		expect(navPermissions(staff({ admin: true }), false)).toEqual(['audit.read']);
	});

	it('gives nothing to a person without a staff role, whatever the stored grants say', () => {
		expect(navPermissions(staff({}, ['audit.read']), false)).toEqual([]);
	});

	it('gives the pools of a partner to a member of a verified company only while it has an open partnership', () => {
		const member = (companyStatus: 'verified' | 'suspended'): AccessSubject => ({
			userId: 'u-m',
			via: 'session',
			candidate: null,
			membership: { memberId: 'm-1', companyId: 'c-1', role: 'recruiter', status: 'active', companyStatus },
			staff: { operator: false, admin: false, extraPermissions: [] }
		});
		expect(navPermissions(member('verified'), true)).toEqual(['partner_pool.read']);
		expect(navPermissions(member('verified'), false)).toEqual([]);
		expect(navPermissions(member('suspended'), true)).toEqual([]);
		expect(navPermissions(staff({ admin: true }), true)).toEqual(['audit.read']);
	});
});
