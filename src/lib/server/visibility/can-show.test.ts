import { describe, expect, it } from 'vitest';
import { canShow, catalogVisibleToAnyVerifiedCompany, type Viewer, type VisibilityFacts } from './can-show';

const now = new Date('2026-10-05T12:00:00Z');
const COMPANY = 'company-a';
const OTHER_COMPANY = 'company-b';

const member: Viewer = {
	kind: 'member',
	userId: 'u-m',
	memberId: 'm-1',
	companyId: COMPANY,
	via: 'session',
	demoSessionId: null
};
const otherMember: Viewer = {
	kind: 'member',
	userId: 'u-o',
	memberId: 'm-2',
	companyId: OTHER_COMPANY,
	via: 'session',
	demoSessionId: null
};

function adultFacts(overrides: Partial<VisibilityFacts> = {}): VisibilityFacts {
	return {
		now,
		policyVersion: 'catalog_policy@1',
		minorsEnabled: true,
		publicDistributionAvailable: false,
		candidate: {
			id: 'c-1',
			userId: 'u-c',
			status: 'active',
			birth: { birthDate: '1999-03-01', precision: 'day', status: 'unverified' },
			visibility: 'catalog',
			searchStatus: 'active',
			blockedCompanyIds: [],
			demoSessionId: null,
			demoOriginal: false
		},
		consents: { pdProcessing: true, catalogVisibility: { scopeFields: [] }, publicDistribution: false },
		representativeVerified: false,
		viewerCompany: {
			membershipActive: true,
			companyVerified: true,
			hasCardReadPermission: true,
			minorTermsAccepted: false
		},
		...overrides
	};
}

function teenFacts(overrides: Partial<VisibilityFacts> = {}): VisibilityFacts {
	const base = adultFacts();
	return {
		...base,
		candidate: { ...base.candidate, birth: { birthDate: '2010-06-01', precision: 'day', status: 'unverified' } },
		representativeVerified: true,
		viewerCompany: {
			membershipActive: true,
			companyVerified: true,
			hasCardReadPermission: true,
			minorTermsAccepted: true
		},
		vacancy: { id: 'v-teen', companyId: COMPANY, origin: 'own', status: 'published', minAge: 16 },
		...overrides
	};
}

describe('canShow: catalog of an adult', () => {
	it('shows a consenting adult to a member of a verified company', () => {
		expect(canShow(adultFacts(), member, { kind: 'catalog' })).toEqual({
			allowed: true,
			projection: 'catalog',
			extras: [],
			policyVersion: 'catalog_policy@1'
		});
	});

	it('adds the extras the adult chose in scope_fields', () => {
		const facts = adultFacts({
			consents: {
				pdProcessing: true,
				catalogVisibility: { scopeFields: ['fsp_achievements_exact', 'external_profiles'] },
				publicDistribution: false
			}
		});
		expect(canShow(facts, member, { kind: 'catalog' })).toMatchObject({
			allowed: true,
			extras: ['fsp_achievements_exact', 'external_profiles']
		});
	});

	it('hides a candidate whose catalog consent is revoked, keeping the profile itself', () => {
		const facts = adultFacts({ consents: { pdProcessing: true, catalogVisibility: null, publicDistribution: false } });
		expect(canShow(facts, member, { kind: 'catalog' })).toEqual({ allowed: false, reason: 'no_catalog_consent' });
		expect(canShow(facts, { kind: 'user', userId: 'u-c' }, { kind: 'self' })).toMatchObject({
			allowed: true,
			projection: 'self'
		});
	});

	it('hides everyone once the processing consent is gone', () => {
		const facts = adultFacts({
			consents: { pdProcessing: false, catalogVisibility: { scopeFields: [] }, publicDistribution: false }
		});
		expect(canShow(facts, member, { kind: 'catalog' })).toEqual({ allowed: false, reason: 'no_processing_consent' });
	});

	it('refuses an unverified company, a removed member and a blocked company', () => {
		const unverified = adultFacts({
			viewerCompany: {
				membershipActive: true,
				companyVerified: false,
				hasCardReadPermission: true,
				minorTermsAccepted: false
			}
		});
		expect(canShow(unverified, member, { kind: 'catalog' })).toEqual({
			allowed: false,
			reason: 'company_not_verified'
		});
		const removed = adultFacts({
			viewerCompany: {
				membershipActive: false,
				companyVerified: true,
				hasCardReadPermission: true,
				minorTermsAccepted: false
			}
		});
		expect(canShow(removed, member, { kind: 'catalog' })).toEqual({ allowed: false, reason: 'not_member' });
		const base = adultFacts();
		const blocked = adultFacts({ candidate: { ...base.candidate, blockedCompanyIds: [COMPANY] } });
		expect(canShow(blocked, member, { kind: 'catalog' })).toEqual({ allowed: false, reason: 'blocked_by_candidate' });
	});

	it('respects the hidden setting and «not looking»', () => {
		const base = adultFacts();
		expect(
			canShow(adultFacts({ candidate: { ...base.candidate, visibility: 'hidden' } }), member, { kind: 'catalog' })
		).toEqual({
			allowed: false,
			reason: 'hidden_by_candidate'
		});
		expect(
			canShow(adultFacts({ candidate: { ...base.candidate, searchStatus: 'not_looking' } }), member, {
				kind: 'catalog'
			})
		).toEqual({ allowed: false, reason: 'hidden_by_candidate' });
	});

	it('never shows a candidate to an anonymous viewer or a plain user', () => {
		expect(canShow(adultFacts(), { kind: 'anonymous' }, { kind: 'catalog' })).toEqual({
			allowed: false,
			reason: 'not_member'
		});
		expect(canShow(adultFacts(), { kind: 'user', userId: 'x' }, { kind: 'catalog' })).toEqual({
			allowed: false,
			reason: 'not_member'
		});
	});
});

describe('canShow: teenager 14–17', () => {
	it('is invisible in the catalog without a vacancy', () => {
		expect(canShow(teenFacts(), member, { kind: 'catalog' })).toEqual({
			allowed: false,
			reason: 'minor_requires_vacancy'
		});
	});

	it('is visible only in the context of an eligible vacancy of the viewer company, without extras', () => {
		const facts = teenFacts({
			consents: {
				pdProcessing: true,
				catalogVisibility: { scopeFields: ['fsp_achievements_exact'] },
				publicDistribution: false
			}
		});
		expect(canShow(facts, member, { kind: 'catalog', vacancyId: 'v-teen' })).toMatchObject({
			allowed: true,
			projection: 'catalog',
			extras: []
		});
	});

	it('is not opened by a vacancy with a higher minimum age, of another company, or closed', () => {
		const base = teenFacts();
		const vacancy = base.vacancy ?? {
			id: 'v-teen',
			companyId: COMPANY,
			origin: 'own' as const,
			status: 'published',
			minAge: 16
		};
		expect(
			canShow(teenFacts({ vacancy: { ...vacancy, minAge: null } }), member, { kind: 'catalog', vacancyId: 'v-teen' })
		).toEqual({
			allowed: false,
			reason: 'vacancy_not_eligible'
		});
		expect(canShow(teenFacts(), otherMember, { kind: 'catalog', vacancyId: 'v-teen' })).toEqual({
			allowed: false,
			reason: 'vacancy_not_eligible'
		});
		expect(
			canShow(teenFacts({ vacancy: { ...vacancy, status: 'closed' } }), member, {
				kind: 'catalog',
				vacancyId: 'v-teen'
			})
		).toEqual({
			allowed: false,
			reason: 'vacancy_not_eligible'
		});
		const younger = teenFacts({
			candidate: { ...base.candidate, birth: { birthDate: '2011-06-01', precision: 'day', status: 'unverified' } }
		});
		expect(canShow(younger, member, { kind: 'catalog', vacancyId: 'v-teen' })).toEqual({
			allowed: false,
			reason: 'vacancy_not_eligible'
		});
	});

	it('needs the company offer on chapter 42 of the Labour Code and a verified representative', () => {
		expect(
			canShow(
				teenFacts({
					viewerCompany: {
						membershipActive: true,
						companyVerified: true,
						hasCardReadPermission: true,
						minorTermsAccepted: false
					}
				}),
				member,
				{ kind: 'catalog', vacancyId: 'v-teen' }
			)
		).toEqual({ allowed: false, reason: 'vacancy_not_eligible' });
		expect(
			canShow(teenFacts({ representativeVerified: false }), member, { kind: 'catalog', vacancyId: 'v-teen' })
		).toEqual({
			allowed: false,
			reason: 'representative_not_verified'
		});
	});

	it('is treated as ineligible when the minor policy is off', () => {
		expect(canShow(teenFacts({ minorsEnabled: false }), member, { kind: 'catalog', vacancyId: 'v-teen' })).toEqual({
			allowed: false,
			reason: 'age_ineligible'
		});
	});

	it('never enters a partner pool', () => {
		const facts = teenFacts({ partnership: { id: 'p-1', companyId: COMPANY, active: true, candidateInPool: true } });
		expect(canShow(facts, member, { kind: 'partner_pool', partnershipId: 'p-1' })).toEqual({
			allowed: false,
			reason: 'not_in_pool'
		});
	});
});

describe('canShow: age', () => {
	it('closes the profile with an unknown or ineligible age', () => {
		const base = adultFacts();
		expect(
			canShow(
				adultFacts({
					candidate: { ...base.candidate, birth: { birthDate: null, precision: null, status: 'unknown' } }
				}),
				member,
				{
					kind: 'catalog'
				}
			)
		).toEqual({ allowed: false, reason: 'age_unknown' });
		expect(
			canShow(
				adultFacts({
					candidate: { ...base.candidate, birth: { birthDate: '2013-01-01', precision: 'day', status: 'unverified' } }
				}),
				member,
				{ kind: 'catalog' }
			)
		).toEqual({ allowed: false, reason: 'age_ineligible' });
	});
});

describe('canShow: invitation', () => {
	const invitation = {
		id: 'i-1',
		companyId: COMPANY,
		candidateId: 'c-1',
		vacancyId: 'v-1',
		status: 'accepted' as const,
		disclosureConsentActive: true
	};

	it('gives the recipient projection after acceptance with a disclosure consent', () => {
		expect(canShow(adultFacts({ invitation }), member, { kind: 'invitation', invitationId: 'i-1' })).toMatchObject({
			allowed: true,
			projection: 'recipient'
		});
	});

	it('falls back to the catalog after the disclosure consent is revoked', () => {
		expect(
			canShow(adultFacts({ invitation: { ...invitation, disclosureConsentActive: false } }), member, {
				kind: 'invitation',
				invitationId: 'i-1'
			})
		).toMatchObject({ allowed: true, projection: 'catalog' });
	});

	it('gives another company nothing through someone else’s invitation', () => {
		expect(canShow(adultFacts({ invitation }), otherMember, { kind: 'invitation', invitationId: 'i-1' })).toEqual({
			allowed: false,
			reason: 'not_visible'
		});
	});
});

describe('canShow: partner pool, public page, cases', () => {
	const partnership = { id: 'p-1', companyId: COMPANY, active: true, candidateInPool: true };

	it('shows a pool member regardless of the visibility setting, with the competition result', () => {
		const base = adultFacts();
		const facts = adultFacts({ partnership, candidate: { ...base.candidate, visibility: 'hidden' } });
		expect(canShow(facts, member, { kind: 'partner_pool', partnershipId: 'p-1' })).toMatchObject({
			allowed: true,
			projection: 'catalog',
			extras: ['partner_competition_result']
		});
	});

	it('refuses an ended partnership and a candidate outside the pool', () => {
		expect(
			canShow(adultFacts({ partnership: { ...partnership, active: false } }), member, {
				kind: 'partner_pool',
				partnershipId: 'p-1'
			})
		).toEqual({
			allowed: false,
			reason: 'not_partner'
		});
		expect(
			canShow(adultFacts({ partnership: { ...partnership, candidateInPool: false } }), member, {
				kind: 'partner_pool',
				partnershipId: 'p-1'
			})
		).toEqual({ allowed: false, reason: 'not_in_pool' });
	});

	it('keeps the public page off while the kind is unavailable', () => {
		const facts = adultFacts({ consents: { pdProcessing: true, catalogVisibility: null, publicDistribution: true } });
		expect(canShow(facts, { kind: 'anonymous' }, { kind: 'public' })).toEqual({
			allowed: false,
			reason: 'not_visible'
		});
		expect(
			canShow({ ...facts, publicDistributionAvailable: true }, { kind: 'anonymous' }, { kind: 'public' })
		).toMatchObject({
			allowed: true,
			projection: 'public'
		});
	});

	it('gives staff the operator projection only within a case', () => {
		const staff: Viewer = { kind: 'staff', userId: 'u-s', role: 'operator', demoSessionId: null };
		expect(
			canShow(adultFacts({ caseAccess: true }), staff, { kind: 'case', caseType: 'dispute', caseId: 'd-1' })
		).toMatchObject({
			allowed: true,
			projection: 'operator'
		});
		expect(canShow(adultFacts(), staff, { kind: 'case', caseType: 'dispute', caseId: 'd-1' })).toEqual({
			allowed: false,
			reason: 'no_case_access'
		});
		expect(canShow(adultFacts(), staff, { kind: 'catalog' })).toEqual({ allowed: false, reason: 'not_member' });
	});
});

describe('demo sessions', () => {
	const SESSION = 'session-a';
	const inSession = (session: string | null) => {
		const base = adultFacts();
		return adultFacts({ candidate: { ...base.candidate, demoSessionId: session }, caseAccess: true });
	};
	const memberIn = (session: string | null): Viewer => ({
		kind: 'member',
		userId: 'u-m',
		memberId: 'm-1',
		companyId: COMPANY,
		via: 'session',
		demoSessionId: session
	});
	const staffIn = (session: string | null): Viewer => ({
		kind: 'staff',
		userId: 'u-s',
		role: 'operator',
		demoSessionId: session
	});
	const dispute = { kind: 'case', caseType: 'dispute', caseId: 'd-1' } as const;

	it('shows a profile of a session inside that session only', () => {
		expect(canShow(inSession(SESSION), memberIn(SESSION), { kind: 'catalog' })).toMatchObject({ allowed: true });
		expect(canShow(inSession(SESSION), memberIn('session-b'), { kind: 'catalog' })).toEqual({
			allowed: false,
			reason: 'not_visible'
		});
		expect(canShow(inSession(SESSION), memberIn(null), { kind: 'catalog' })).toEqual({
			allowed: false,
			reason: 'not_visible'
		});
		expect(canShow(inSession(SESSION), staffIn('session-b'), dispute)).toEqual({
			allowed: false,
			reason: 'not_visible'
		});
		expect(canShow(inSession(SESSION), staffIn(SESSION), dispute)).toMatchObject({ projection: 'operator' });
	});

	it('shows a profile outside sessions to viewers inside and outside them', () => {
		expect(canShow(inSession(null), memberIn(SESSION), { kind: 'catalog' })).toMatchObject({ allowed: true });
		expect(canShow(inSession(null), memberIn(null), { kind: 'catalog' })).toMatchObject({ allowed: true });
	});

	it('hides an original of the scenario heroes inside every session and shows it outside them', () => {
		const base = adultFacts();
		const original = adultFacts({ candidate: { ...base.candidate, demoOriginal: true }, caseAccess: true });
		expect(canShow(original, memberIn(SESSION), { kind: 'catalog' })).toEqual({
			allowed: false,
			reason: 'not_visible'
		});
		expect(canShow(original, staffIn(SESSION), dispute)).toEqual({ allowed: false, reason: 'not_visible' });
		expect(canShow(original, memberIn(null), { kind: 'catalog' })).toMatchObject({ allowed: true });
		expect(canShow(original, staffIn(null), dispute)).toMatchObject({ projection: 'operator' });
		expect(canShow(original, { kind: 'user', userId: 'u-c' }, { kind: 'self' })).toMatchObject({ projection: 'self' });
	});

	it('lets a clone see itself', () => {
		expect(canShow(inSession(SESSION), { kind: 'user', userId: 'u-c' }, { kind: 'self' })).toMatchObject({
			projection: 'self'
		});
	});
});

describe('catalogVisibleToAnyVerifiedCompany', () => {
	it('counts consenting adults and never teenagers', () => {
		expect(catalogVisibleToAnyVerifiedCompany(adultFacts())).toBe(true);
		expect(catalogVisibleToAnyVerifiedCompany(teenFacts())).toBe(false);
	});
});
