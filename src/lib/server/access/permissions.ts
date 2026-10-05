// Registry of permissions and their object rules (docs/domain.md, section 4.2). `can` combines a role with the
// object rule: a role alone never grants access to an object.
import type { ShowDecision } from '$lib/server/visibility/can-show';
import type { Invitability } from '$lib/server/vacancies/invitable';

export type Role = 'anonymous' | 'user' | 'candidate' | 'owner' | 'recruiter' | 'operator' | 'admin';

interface PermissionSpec {
	roles: readonly Role[];
	/** Whether a company API key may hold the permission (contracts 5.2: never candidate, staff or key operations). */
	apiKey: boolean;
}

const EMPLOYER = ['owner', 'recruiter'] as const;
const EVERYONE = ['anonymous', 'user', 'candidate', 'owner', 'recruiter', 'operator', 'admin'] as const;

export const PERMISSIONS = {
	'candidate.self.read': { roles: ['candidate'], apiKey: false },
	'candidate.self.write': { roles: ['candidate'], apiKey: false },
	'catalog.search': { roles: EMPLOYER, apiKey: true },
	'candidate.card.read': { roles: [...EMPLOYER, 'operator'], apiKey: true },
	'vacancy.write': { roles: EMPLOYER, apiKey: true },
	'invitation.create': { roles: EMPLOYER, apiKey: true },
	'invitation.revise': { roles: EMPLOYER, apiKey: true },
	'invitation.read': { roles: [...EMPLOYER, 'candidate'], apiKey: true },
	'invitation.respond': { roles: ['candidate'], apiKey: false },
	'hiring.report': { roles: [...EMPLOYER, 'candidate'], apiKey: true },
	'vacancy.external.read': { roles: EVERYONE, apiKey: true },
	'vacancy_claim.create': { roles: EMPLOYER, apiKey: false },
	'vacancy_claim.review': { roles: ['operator'], apiKey: false },
	'match.read': { roles: [...EMPLOYER, 'candidate'], apiKey: true },
	'market.read': { roles: [...EMPLOYER, 'candidate'], apiKey: true },
	'partner_pool.read': { roles: EMPLOYER, apiKey: true },
	'partnership.manage': { roles: ['operator'], apiKey: false },
	'fsp_analytics.read': { roles: ['operator'], apiKey: false },
	// Loading a batch of FSP results (an export or a protocol) and reading its source file.
	'fsp.import': { roles: ['operator'], apiKey: false },
	'receipt.verify': { roles: EVERYONE, apiKey: true },
	'notification.channel.manage': {
		roles: ['user', 'candidate', 'owner', 'recruiter', 'operator', 'admin'],
		apiKey: false
	},
	'company.create': { roles: ['user'], apiKey: false },
	'company.profile.manage': { roles: ['owner'], apiKey: false },
	'company.members.manage': { roles: ['owner'], apiKey: false },
	'api_key.manage': { roles: ['owner'], apiKey: false },
	'company.review': { roles: ['operator'], apiKey: false },
	'company.moderate': { roles: ['operator'], apiKey: false },
	// Decisions on own vacancies the text check sent to moderation (domain 13.1).
	'vacancy.moderate': { roles: ['operator'], apiKey: false },
	'representation.review': { roles: ['operator'], apiKey: false },
	// Objections to test results (domain 12.5).
	'objection.manage': { roles: ['operator'], apiKey: false },
	// Reading an attempt in full and annulling it (domain 10.2, 10.4).
	'assessment.review': { roles: ['operator'], apiKey: false },
	// Resolving a conflict of the birth date by a document (domain 7.2).
	'age.review': { roles: ['operator'], apiKey: false },
	// An administrator reads the journal by the role; an operator only by an explicit grant
	// (`staff_roles.extra_permissions`).
	'audit.read': { roles: ['admin'], apiKey: false },
	'staff.manage': { roles: ['admin'], apiKey: false },
	'taxonomy.manage': { roles: ['admin'], apiKey: false },
	'policy.manage': { roles: ['admin'], apiKey: false },
	'jobs.manage': { roles: ['admin'], apiKey: false }
} as const satisfies Record<string, PermissionSpec>;

export type Permission = keyof typeof PERMISSIONS;

/** Permissions that a staff grant adds on top of roles; kept in sync with `staff_roles.extra_permissions`. */
export const STAFF_EXTRA_PERMISSIONS = ['audit.read'] as const satisfies readonly Permission[];

type CompanyStatus = 'draft' | 'submitted' | 'verified' | 'rejected' | 'suspended';

/** Who acts, with roles and memberships read from the database on this request (never cached in the session). */
export interface AccessSubject {
	userId: string | null;
	via: 'anonymous' | 'session' | 'api_key';
	/** Permissions of the API key; a subset of the creator's permissions. */
	apiKeyPermissions?: readonly Permission[];
	candidate: { id: string; status: 'onboarding' | 'active' | 'ineligible_age' | 'deletion_pending' | 'deleted' } | null;
	membership: {
		memberId: string;
		companyId: string;
		role: 'owner' | 'recruiter';
		status: 'invited' | 'active' | 'removed';
		companyStatus: CompanyStatus;
	} | null;
	staff: { operator: boolean; admin: boolean; extraPermissions: readonly string[] };
}

/** Facts of the object each permission is checked against; `null` — the permission has no object rule. */
export interface PermissionObjects {
	'candidate.self.read': { candidateId: string };
	'candidate.self.write': { candidateId: string };
	'catalog.search': null;
	'candidate.card.read': { show: ShowDecision };
	'vacancy.write': { origin: 'own' | 'external'; companyId: string | null };
	'invitation.create': { invitability: Invitability; show: ShowDecision };
	'invitation.revise': { companyId: string; revisable: boolean };
	'invitation.read': { companyId: string; candidateId: string };
	'invitation.respond': { candidateId: string };
	'hiring.report': { companyId: string; candidateId: string };
	'vacancy.external.read': null;
	'vacancy_claim.create': null;
	'vacancy_claim.review': { status: string };
	'match.read': { vacancyCompanyId: string | null; candidateId: string; show: ShowDecision | null };
	'market.read': { ownCategory: boolean };
	'partner_pool.read': { partnershipCompanyId: string; partnershipActive: boolean };
	'partnership.manage': null;
	'fsp_analytics.read': null;
	'fsp.import': null;
	'receipt.verify': null;
	'notification.channel.manage': { ownerUserId: string };
	'company.create': null;
	'company.profile.manage': { companyId: string };
	'company.members.manage': { companyId: string };
	'api_key.manage': { companyId: string };
	'company.review': { companyStatus: CompanyStatus };
	'company.moderate': { companyStatus: CompanyStatus };
	'vacancy.moderate': null;
	'representation.review': null;
	'objection.manage': null;
	'assessment.review': null;
	'age.review': null;
	'audit.read': null;
	'staff.manage': null;
	'taxonomy.manage': null;
	'policy.manage': null;
	'jobs.manage': null;
}

export type AccessDecision =
	{ allowed: true } | { allowed: false; reason: 'unauthenticated' | 'api_key_scope' | 'role' | 'object' };

const allowed: AccessDecision = { allowed: true };
const denied = (reason: 'unauthenticated' | 'api_key_scope' | 'role' | 'object'): AccessDecision => ({
	allowed: false,
	reason
});

/** Roles of the subject at this moment. Removed or invited members and inactive candidates hold no role. */
export function rolesOf(subject: AccessSubject): Set<Role> {
	const roles = new Set<Role>();
	if (subject.userId === null) {
		roles.add('anonymous');
		return roles;
	}
	if (subject.via === 'session') roles.add('user');
	if (subject.via === 'session' && subject.candidate?.status === 'active') roles.add('candidate');
	if (subject.membership?.status === 'active') roles.add(subject.membership.role);
	if (subject.via === 'session' && subject.staff.operator) roles.add('operator');
	if (subject.via === 'session' && subject.staff.admin) roles.add('admin');
	return roles;
}

/** Active membership in a company that is verified right now. */
function verifiedMember(subject: AccessSubject): boolean {
	return subject.membership?.status === 'active' && subject.membership.companyStatus === 'verified';
}

function ownCompany(subject: AccessSubject, companyId: string | null): boolean {
	return companyId !== null && subject.membership?.status === 'active' && subject.membership.companyId === companyId;
}

function objectRule<P extends Permission>(
	subject: AccessSubject,
	roles: Set<Role>,
	permission: P,
	object: PermissionObjects[P]
): boolean {
	const o = object;
	switch (permission) {
		case 'candidate.self.read':
		case 'candidate.self.write':
		case 'invitation.respond':
			return subject.candidate?.id === (o as { candidateId: string }).candidateId;
		case 'catalog.search':
			return verifiedMember(subject);
		case 'candidate.card.read':
			return (o as PermissionObjects['candidate.card.read']).show.allowed;
		case 'vacancy.write': {
			const vacancy = o as PermissionObjects['vacancy.write'];
			return vacancy.origin === 'own' && ownCompany(subject, vacancy.companyId);
		}
		case 'invitation.create': {
			const facts = o as PermissionObjects['invitation.create'];
			return verifiedMember(subject) && facts.invitability.invitable && facts.show.allowed;
		}
		case 'invitation.revise': {
			const facts = o as PermissionObjects['invitation.revise'];
			return verifiedMember(subject) && ownCompany(subject, facts.companyId) && facts.revisable;
		}
		case 'invitation.read':
		case 'hiring.report': {
			const facts = o as { companyId: string; candidateId: string };
			// A company in `suspended` no longer reports; the candidate always may (domain 13.7).
			const companySide =
				(roles.has('owner') || roles.has('recruiter')) &&
				ownCompany(subject, facts.companyId) &&
				(permission === 'invitation.read' || subject.membership?.companyStatus !== 'suspended');
			const candidateSide = roles.has('candidate') && subject.candidate?.id === facts.candidateId;
			return companySide || candidateSide;
		}
		case 'vacancy_claim.create':
			return (
				subject.membership !== null &&
				subject.membership.status !== 'removed' &&
				subject.membership.companyStatus !== 'rejected' &&
				subject.membership.companyStatus !== 'suspended'
			);
		case 'vacancy_claim.review':
			return (o as PermissionObjects['vacancy_claim.review']).status === 'pending_review';
		case 'match.read': {
			const facts = o as PermissionObjects['match.read'];
			const companySide =
				(roles.has('owner') || roles.has('recruiter')) &&
				verifiedMember(subject) &&
				ownCompany(subject, facts.vacancyCompanyId) &&
				facts.show?.allowed === true;
			const candidateSide = roles.has('candidate') && subject.candidate?.id === facts.candidateId;
			return companySide || candidateSide;
		}
		case 'market.read': {
			const facts = o as PermissionObjects['market.read'];
			return verifiedMember(subject) || (roles.has('candidate') && facts.ownCategory);
		}
		case 'partner_pool.read': {
			const facts = o as PermissionObjects['partner_pool.read'];
			return verifiedMember(subject) && ownCompany(subject, facts.partnershipCompanyId) && facts.partnershipActive;
		}
		case 'notification.channel.manage':
			return subject.userId === (o as PermissionObjects['notification.channel.manage']).ownerUserId;
		case 'company.profile.manage':
		case 'company.members.manage':
		case 'api_key.manage':
			return ownCompany(subject, (o as { companyId: string }).companyId);
		case 'company.review':
			return (o as PermissionObjects['company.review']).companyStatus === 'submitted';
		case 'company.moderate': {
			const status = (o as PermissionObjects['company.moderate']).companyStatus;
			return status === 'verified' || status === 'suspended';
		}
		case 'audit.read':
			return roles.has('admin') || (roles.has('operator') && subject.staff.extraPermissions.includes('audit.read'));
		default:
			return true;
	}
}

/**
 * `can(actor, permission, object)`: the subject holds a role of the permission (for `audit.read`, an operator also
 * qualifies and the object rule asks for the explicit grant), an API key holds the permission in its scope, and the object rule passes.
 */
export function can<P extends Permission>(
	subject: AccessSubject,
	permission: P,
	object: PermissionObjects[P]
): AccessDecision {
	const spec: PermissionSpec = PERMISSIONS[permission];
	const roles = rolesOf(subject);
	if (subject.via === 'api_key') {
		if (!spec.apiKey || !subject.apiKeyPermissions?.includes(permission)) return denied('api_key_scope');
	}
	const roleGranted =
		spec.roles.some((role) => roles.has(role)) || (permission === 'audit.read' && roles.has('operator'));
	if (!roleGranted) return denied(subject.userId === null ? 'unauthenticated' : 'role');
	return objectRule(subject, roles, permission, object) ? allowed : denied('object');
}
