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
	// Writing in the conversation of an accepted offer (domain 13.15); reading it is `invitation.read`.
	'invitation.message': { roles: [...EMPLOYER, 'candidate'], apiKey: true },
	'hiring.report': { roles: [...EMPLOYER, 'candidate'], apiKey: true },
	// Hiring needs of the company and the categories recommended for them (domain 13.10).
	'need.manage': { roles: EMPLOYER, apiKey: true },
	// Calls of the company and the solutions to them (domain 13.12).
	'challenge.manage': { roles: EMPLOYER, apiKey: true },
	// A request of a missing confirmation to a candidate the company sees (domain 13.11).
	'confirmation.request': { roles: EMPLOYER, apiKey: true },
	// Applications of candidates to the company's own vacancies (domain 13.5, 13.6).
	'application.manage': { roles: EMPLOYER, apiKey: true },
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
	// The public profile of the company (description, line of business, contacts) as its members read it (domain 5.1).
	'company.profile.read': { roles: EMPLOYER, apiKey: true },
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
	'jobs.manage': { roles: ['admin'], apiKey: false },
	// A candidate's complaint about an offer and its review by an operator (domain 13.14).
	'complaint.create': { roles: ['candidate'], apiKey: false },
	'complaint.review': { roles: ['operator'], apiKey: false },
	// Subscriptions of the company to its outgoing events (domain 5.7): the owner, or a key the owner granted it — the
	// integration that receives the events registers itself and rotates its secret.
	'company.events.manage': { roles: ['owner'], apiKey: true }
} as const satisfies Record<string, PermissionSpec>;

export type Permission = keyof typeof PERMISSIONS;

/** Permissions that a staff grant adds on top of roles; kept in sync with `staff_roles.extra_permissions`. */
export const STAFF_EXTRA_PERMISSIONS = ['audit.read'] as const satisfies readonly Permission[];

export type CompanyStatus = 'draft' | 'submitted' | 'verified' | 'rejected' | 'suspended';

/**
 * The one admission policy of a company (domain 5.1), asked by every action of a company towards candidates: catalog,
 * card, market, needs, offers and their revisions, vacancies, API keys. A company in `draft`, `submitted` or `verified`
 * is admitted, labelled `verified` or `unverified` for the candidate; `suspended` and `rejected` are refused. The check
 * by an operator is not required: it gives the label, not the admission.
 */
export type CompanyAdmission =
	| { admitted: true; label: 'verified' | 'unverified' }
	| { admitted: false; reason: 'company_suspended' | 'company_rejected' };

/** Statuses the admission policy lets act: the same rule as `companyAdmission`, for queries over many companies. */
export const ADMITTED_COMPANY_STATUSES = ['draft', 'submitted', 'verified'] as const satisfies readonly CompanyStatus[];

export function companyAdmission(status: CompanyStatus): CompanyAdmission {
	switch (status) {
		case 'verified':
			return { admitted: true, label: 'verified' };
		case 'draft':
		case 'submitted':
			return { admitted: true, label: 'unverified' };
		case 'suspended':
			return { admitted: false, reason: 'company_suspended' };
		case 'rejected':
			return { admitted: false, reason: 'company_rejected' };
	}
}

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
	'vacancy.write': { companyId: string | null };
	/** `invitability` — of the vacancy the version names; `null` — an offer without a vacancy (domain 13.5). */
	/** `ownApplication` — the candidate applied to this company (domain 13.14): the offer needs no catalog visibility. */
	'invitation.create': { invitability: Invitability | null; show: ShowDecision; ownApplication?: boolean };
	'invitation.revise': { companyId: string; revisable: boolean };
	'invitation.read': { companyId: string; candidateId: string };
	'invitation.respond': { candidateId: string };
	'invitation.message': { companyId: string; candidateId: string };
	'hiring.report': { companyId: string; candidateId: string };
	'need.manage': { companyId: string };
	'challenge.manage': { companyId: string };
	'confirmation.request': { show: ShowDecision };
	'application.manage': { companyId: string };
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
	'company.profile.read': { companyId: string };
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
	'complaint.create': { candidateId: string };
	'complaint.review': null;
	'company.events.manage': { companyId: string };
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

/** Active membership in a company the admission policy lets act right now (domain 5.1). */
function admittedMember(subject: AccessSubject): boolean {
	return subject.membership?.status === 'active' && companyAdmission(subject.membership.companyStatus).admitted;
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
		case 'complaint.create':
			return subject.candidate?.id === (o as { candidateId: string }).candidateId;
		case 'catalog.search':
			return admittedMember(subject);
		case 'candidate.card.read':
			return (o as PermissionObjects['candidate.card.read']).show.allowed;
		case 'vacancy.write': {
			const vacancy = o as PermissionObjects['vacancy.write'];
			return ownCompany(subject, vacancy.companyId);
		}
		case 'invitation.create': {
			const facts = o as PermissionObjects['invitation.create'];
			return (
				admittedMember(subject) &&
				(facts.invitability?.invitable ?? true) &&
				(facts.show.allowed || facts.ownApplication === true)
			);
		}
		case 'invitation.revise': {
			const facts = o as PermissionObjects['invitation.revise'];
			return admittedMember(subject) && ownCompany(subject, facts.companyId) && facts.revisable;
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
		case 'invitation.message': {
			const facts = o as PermissionObjects['invitation.message'];
			// A company the admission policy stops (`suspended`, `rejected`) writes no more; its history stays readable.
			const companySide =
				(roles.has('owner') || roles.has('recruiter')) &&
				admittedMember(subject) &&
				ownCompany(subject, facts.companyId);
			const candidateSide = roles.has('candidate') && subject.candidate?.id === facts.candidateId;
			return companySide || candidateSide;
		}
		case 'match.read': {
			const facts = o as PermissionObjects['match.read'];
			const companySide =
				(roles.has('owner') || roles.has('recruiter')) &&
				admittedMember(subject) &&
				ownCompany(subject, facts.vacancyCompanyId) &&
				facts.show?.allowed === true;
			const candidateSide = roles.has('candidate') && subject.candidate?.id === facts.candidateId;
			return companySide || candidateSide;
		}
		case 'market.read': {
			const facts = o as PermissionObjects['market.read'];
			return admittedMember(subject) || (roles.has('candidate') && facts.ownCategory);
		}
		case 'partner_pool.read': {
			const facts = o as PermissionObjects['partner_pool.read'];
			return admittedMember(subject) && ownCompany(subject, facts.partnershipCompanyId) && facts.partnershipActive;
		}
		case 'notification.channel.manage':
			return subject.userId === (o as PermissionObjects['notification.channel.manage']).ownerUserId;
		case 'need.manage':
		case 'challenge.manage':
		case 'application.manage':
			return admittedMember(subject) && ownCompany(subject, (o as { companyId: string }).companyId);
		case 'confirmation.request':
			return admittedMember(subject) && (o as PermissionObjects['confirmation.request']).show.allowed;
		case 'company.profile.manage':
		case 'company.profile.read':
		case 'company.members.manage':
		case 'api_key.manage':
			return ownCompany(subject, (o as { companyId: string }).companyId);
		case 'company.events.manage':
			// Events are sent only while the admission policy lets the company act: a closed company configures none.
			return admittedMember(subject) && ownCompany(subject, (o as { companyId: string }).companyId);
		case 'company.review':
			return (o as PermissionObjects['company.review']).companyStatus === 'submitted';
		case 'company.moderate': {
			// A company acting without a check is moderated as well: the operator suspends it as any working company.
			const status = (o as PermissionObjects['company.moderate']).companyStatus;
			return companyAdmission(status).admitted || status === 'suspended';
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
