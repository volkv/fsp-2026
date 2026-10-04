// What a notification is about at the moment of delivery (docs/domain.md, section 3.7): whether the recipient still
// has access to the object, on which side of it they are, and the current data a letter to them may name. A withdrawn
// or purged invitation, or a recipient who left the company, makes the object not visible: no letter about it. The same
// holds for the operator's decisions: a company or a vacancy decision reaches only an active member of the company, a
// dispute or a representation decision only the candidate it concerns, and so do the representative's revocation, the
// verified birth date and an annulled attempt of a test. The deadline of an objection reaches the FSP staff while the
// objection is still open and the recipient still holds a staff role; it names no candidate data.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Executor } from '$lib/server/db';
import {
	assessmentAttempts,
	assessments,
	assessmentVersions,
	candidates,
	categoryDisputes,
	companies,
	companyMembers,
	hiringProcesses,
	invitations,
	invitationTerms,
	representations,
	staffRoles,
	vacancies
} from '$lib/server/db/schema';
import type { VacancySnapshot } from '$lib/server/invitations/terms';
import { isDisputeDeadline, type NotificationType } from './types';

export type RecipientSide = 'candidate' | 'company';

export interface InvitationFacts {
	object: 'invitation';
	side: RecipientSide;
	/** The company's display name: the candidate's own data about their invitation. */
	companyName: string;
	/** The vacancy title of the current terms version. */
	vacancyTitle: string;
	/** How the company side calls the candidate: the pseudonym for this company, never the name (domain 14). */
	candidatePseudonym: string;
}

export type NotificationFacts =
	| InvitationFacts
	/** A decision on the company's verification request, to a member of the company. */
	| { object: 'company'; side: 'company'; companyName: string }
	/** A moderation decision on the company's own vacancy, to a member of the company. */
	| { object: 'vacancy'; side: 'company'; vacancyTitle: string }
	/** The operator's answer to the candidate's own objection. */
	| { object: 'category_dispute'; side: 'candidate' }
	/**
	 * The answer to an objection is due soon or overdue, to a member of the FSP staff: an operator answers it, an admin
	 * sees to it that someone does. `dueOn` — the UTC date of `due_at`.
	 */
	| { object: 'category_dispute'; side: 'staff'; role: 'operator' | 'admin'; dueOn: string }
	/** The operator's decision on the authority of the candidate's representative, to the candidate. */
	| { object: 'representation'; side: 'candidate' }
	/** About the candidate's own profile: majority, the coming removal for inactivity, the verified birth date. */
	| { object: 'candidate'; side: 'candidate' }
	/** The operator annulled the candidate's own attempt; `title` — of the test, the candidate's own data. */
	| { object: 'assessment_attempt'; side: 'candidate'; title: string };

async function isActiveMember(executor: Executor, companyId: string, userId: string): Promise<boolean> {
	const [member] = await executor
		.select({ id: companyMembers.id })
		.from(companyMembers)
		.where(
			and(
				eq(companyMembers.companyId, companyId),
				eq(companyMembers.userId, userId),
				eq(companyMembers.status, 'active')
			)
		);
	return member !== undefined;
}

/** The candidate's own object: the recipient is the candidate's account. */
async function isCandidateUser(executor: Executor, candidateId: string, userId: string): Promise<boolean> {
	const [candidate] = await executor
		.select({ userId: candidates.userId })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	return candidate?.userId === userId;
}

/** The staff role the user holds now, the operator's first; `null` — none. */
export async function activeStaffRole(executor: Executor, userId: string): Promise<'operator' | 'admin' | null> {
	const rows = await executor
		.select({ role: staffRoles.role })
		.from(staffRoles)
		.where(and(eq(staffRoles.userId, userId), isNull(staffRoles.revokedAt)));
	const roles = rows.map((row) => row.role);
	if (roles.includes('operator')) return 'operator';
	return roles.includes('admin') ? 'admin' : null;
}

/** The deadline facts of an objection still waiting for its answer, for a member of the staff. */
async function disputeDeadlineFacts(
	executor: Executor,
	disputeId: string,
	userId: string
): Promise<NotificationFacts | null> {
	const [dispute] = await executor
		.select({ dueAt: categoryDisputes.dueAt })
		.from(categoryDisputes)
		.where(and(eq(categoryDisputes.id, disputeId), inArray(categoryDisputes.status, ['open', 'in_review'])));
	if (!dispute) return null;
	const role = await activeStaffRole(executor, userId);
	if (role === null) return null;
	return { object: 'category_dispute', side: 'staff', role, dueOn: dispute.dueAt.toISOString().slice(0, 10) };
}

interface Target {
	invitationId: string;
}

async function targetOf(executor: Executor, objectType: string, objectId: string): Promise<Target | null> {
	if (objectType === 'invitation') return { invitationId: objectId };
	if (objectType === 'hiring_process') {
		const [process] = await executor
			.select({ invitationId: hiringProcesses.invitationId })
			.from(hiringProcesses)
			.where(eq(hiringProcesses.id, objectId));
		return process ? { invitationId: process.invitationId } : null;
	}
	throw new Error(`notifications about ${objectType} are not supported`);
}

/**
 * Facts of the notification for its recipient, or `null` when the recipient no longer has access to the object:
 * the object is gone or purged, the recipient is neither the candidate nor an active member of the company, or the
 * invitation was withdrawn and the notification is not the one about the withdrawal.
 * An operator's decision is visible to an active member of the company it concerns (its own vacancy included), or to
 * the candidate it concerns.
 */
export async function notificationFacts(
	executor: Executor,
	crypto: FieldCrypto,
	notification: { type: NotificationType; objectType: string; objectId: string; userId: string }
): Promise<NotificationFacts | null> {
	switch (notification.objectType) {
		case 'company': {
			const [company] = await executor
				.select({ displayName: companies.displayName })
				.from(companies)
				.where(eq(companies.id, notification.objectId));
			if (!company || !(await isActiveMember(executor, notification.objectId, notification.userId))) return null;
			return { object: 'company', side: 'company', companyName: company.displayName };
		}
		case 'vacancy': {
			const [vacancy] = await executor
				.select({ companyId: vacancies.companyId, title: vacancies.title })
				.from(vacancies)
				.where(and(eq(vacancies.id, notification.objectId), eq(vacancies.origin, 'own')));
			if (
				!vacancy ||
				vacancy.companyId === null ||
				!(await isActiveMember(executor, vacancy.companyId, notification.userId))
			) {
				return null;
			}
			return { object: 'vacancy', side: 'company', vacancyTitle: vacancy.title };
		}
		case 'category_dispute': {
			if (isDisputeDeadline(notification.type)) {
				return disputeDeadlineFacts(executor, notification.objectId, notification.userId);
			}
			const [dispute] = await executor
				.select({ candidateId: categoryDisputes.candidateId })
				.from(categoryDisputes)
				.where(eq(categoryDisputes.id, notification.objectId));
			if (!dispute || !(await isCandidateUser(executor, dispute.candidateId, notification.userId))) return null;
			return { object: 'category_dispute', side: 'candidate' };
		}
		case 'representation': {
			const [representation] = await executor
				.select({ candidateId: representations.candidateId })
				.from(representations)
				.where(eq(representations.id, notification.objectId));
			if (!representation || !(await isCandidateUser(executor, representation.candidateId, notification.userId))) {
				return null;
			}
			return { object: 'representation', side: 'candidate' };
		}
		case 'candidate':
			return (await isCandidateUser(executor, notification.objectId, notification.userId))
				? { object: 'candidate', side: 'candidate' }
				: null;
		case 'assessment_attempt': {
			const [attempt] = await executor
				.select({ candidateId: assessmentAttempts.candidateId, title: assessments.title })
				.from(assessmentAttempts)
				.innerJoin(assessmentVersions, eq(assessmentVersions.id, assessmentAttempts.versionId))
				.innerJoin(assessments, eq(assessments.id, assessmentVersions.assessmentId))
				.where(eq(assessmentAttempts.id, notification.objectId));
			if (!attempt || !(await isCandidateUser(executor, attempt.candidateId, notification.userId))) return null;
			return { object: 'assessment_attempt', side: 'candidate', title: attempt.title };
		}
	}
	return invitationFacts(executor, crypto, notification);
}

async function invitationFacts(
	executor: Executor,
	crypto: FieldCrypto,
	notification: { type: NotificationType; objectType: string; objectId: string; userId: string }
): Promise<InvitationFacts | null> {
	const target = await targetOf(executor, notification.objectType, notification.objectId);
	if (!target) return null;
	const [invitation] = await executor
		.select({
			companyId: invitations.companyId,
			candidateId: invitations.candidateId,
			status: invitations.status,
			currentTermsId: invitations.currentTermsId,
			purgedAt: invitations.purgedAt
		})
		.from(invitations)
		.where(eq(invitations.id, target.invitationId));
	if (!invitation || invitation.purgedAt !== null || invitation.currentTermsId === null) return null;
	if (invitation.status === 'withdrawn' && notification.type !== 'invitation.withdrawn') return null;

	let side: RecipientSide;
	if (await isCandidateUser(executor, invitation.candidateId, notification.userId)) {
		side = 'candidate';
	} else {
		if (!(await isActiveMember(executor, invitation.companyId, notification.userId))) return null;
		side = 'company';
	}

	const [company] = await executor
		.select({ displayName: companies.displayName })
		.from(companies)
		.where(eq(companies.id, invitation.companyId));
	const [terms] = await executor
		.select({ vacancySnapshot: invitationTerms.vacancySnapshot })
		.from(invitationTerms)
		.where(eq(invitationTerms.id, invitation.currentTermsId));
	if (!company || !terms) throw new Error(`invitation ${target.invitationId} lacks its company or terms`);
	return {
		object: 'invitation',
		side,
		companyName: company.displayName,
		vacancyTitle: (terms.vacancySnapshot as VacancySnapshot).title,
		candidatePseudonym: crypto.pseudonym(invitation.candidateId, invitation.companyId)
	};
}
