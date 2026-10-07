// What a notification is about at the moment of delivery (docs/domain.md, section 3.7): whether the recipient still
// has access to the object, on which side of it they are, and the current data a letter to them may name. A withdrawn
// or purged invitation, or a recipient who left the company, makes the object not visible: no letter about it. The same
// holds for the operator's decisions: a company or a vacancy decision reaches only an active member of the company, a
// decision on an objection, a change of the category or a representation decision only the candidate it concerns, and
// so do the representative's revocation, the verified birth date and an annulled attempt of a test. The deadline of an objection reaches the FSP staff while the
// objection is still open and the recipient still holds a staff role; it names no candidate data.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { testTitle } from '$lib/server/assessments/titles';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Executor } from '$lib/server/db';
import {
	applications,
	assessmentObjections,
	candidates,
	challengeDeliveries,
	companyChallenges,
	confirmationRequests,
	companies,
	companyMembers,
	hiringProcesses,
	invitationComplaints,
	invitations,
	testAttempts,
	invitationTerms,
	representations,
	staffRoles,
	vacancies
} from '$lib/server/db/schema';
import { categoryOwner } from '$lib/server/categories/read';
import { isObjectionDeadline, type NotificationType } from './types';

export type RecipientSide = 'candidate' | 'company';

export interface InvitationFacts {
	object: 'invitation';
	side: RecipientSide;
	/** The company's display name: the candidate's own data about their invitation. */
	companyName: string;
	/** The title of the current terms version of the offer. */
	offerTitle: string;
	/** How the company side calls the candidate: the pseudonym for this company, never the name (domain 14). */
	candidatePseudonym: string;
}

export type NotificationFacts =
	| InvitationFacts
	/** A decision on the company's verification request, to a member of the company. */
	| { object: 'company'; side: 'company'; companyName: string }
	/** A moderation decision on the company's own vacancy, to a member of the company. */
	| { object: 'vacancy'; side: 'company'; vacancyTitle: string }
	/** The operator's answer to the candidate's own objection to a test result. */
	| { object: 'assessment_objection'; side: 'candidate' }
	/**
	 * The answer to an objection is due soon or overdue, to a member of the FSP staff: an operator answers it, an admin
	 * sees to it that someone does. `dueOn` — the UTC date of `due_at`.
	 */
	| { object: 'assessment_objection'; side: 'staff'; role: 'operator' | 'admin'; dueOn: string }
	/** The candidate's own category was assigned or revoked. */
	| { object: 'candidate_category'; side: 'candidate' }
	/** The operator's decision on the authority of the candidate's representative, to the candidate. */
	| { object: 'representation'; side: 'candidate' }
	/** About the candidate's own profile: majority, the coming removal for inactivity, the verified birth date. */
	| { object: 'candidate'; side: 'candidate' }
	/** The operator annulled the candidate's own attempt; `title` — of the test, the candidate's own data. */
	| { object: 'assessment_attempt'; side: 'candidate'; title: string }
	/** A company asks the candidate to confirm a block: the company is named to the candidate, as in an offer. */
	| { object: 'confirmation_request'; side: 'candidate'; companyName: string; blockTitle: string }
	/** The result of the block test reached the company that asked: the candidate by pseudonym. */
	| { object: 'confirmation_request'; side: 'company'; candidatePseudonym: string; blockTitle: string }
	/** A call of a company delivered to the candidate. */
	| { object: 'challenge_delivery'; side: 'candidate'; companyName: string; challengeTitle: string }
	/** The candidate's own application: the company of the vacancy decided on it. */
	| { object: 'application'; side: 'candidate'; companyName: string; vacancyTitle: string }
	/** An application to the company's own vacancy: the candidate by pseudonym. */
	| { object: 'application'; side: 'company'; candidatePseudonym: string; vacancyTitle: string }
	/** The operator decided the candidate's own complaint about an offer; `companyName` — of the offer, theirs to know. */
	| { object: 'invitation_complaint'; side: 'candidate'; companyName: string };

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
async function objectionDeadlineFacts(
	executor: Executor,
	objectionId: string,
	userId: string
): Promise<NotificationFacts | null> {
	const [objection] = await executor
		.select({ dueAt: assessmentObjections.dueAt })
		.from(assessmentObjections)
		.where(and(eq(assessmentObjections.id, objectionId), inArray(assessmentObjections.status, ['open', 'in_review'])));
	if (!objection) return null;
	const role = await activeStaffRole(executor, userId);
	if (role === null) return null;
	return { object: 'assessment_objection', side: 'staff', role, dueOn: objection.dueAt.toISOString().slice(0, 10) };
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
				.where(eq(vacancies.id, notification.objectId));
			if (!vacancy || !(await isActiveMember(executor, vacancy.companyId, notification.userId))) {
				return null;
			}
			return { object: 'vacancy', side: 'company', vacancyTitle: vacancy.title };
		}
		case 'assessment_objection': {
			if (isObjectionDeadline(notification.type)) {
				return objectionDeadlineFacts(executor, notification.objectId, notification.userId);
			}
			const [objection] = await executor
				.select({ candidateId: assessmentObjections.candidateId })
				.from(assessmentObjections)
				.where(eq(assessmentObjections.id, notification.objectId));
			if (!objection || !(await isCandidateUser(executor, objection.candidateId, notification.userId))) return null;
			return { object: 'assessment_objection', side: 'candidate' };
		}
		case 'candidate_category': {
			const candidateId = await categoryOwner(executor, notification.objectId);
			if (candidateId === null || !(await isCandidateUser(executor, candidateId, notification.userId))) return null;
			return { object: 'candidate_category', side: 'candidate' };
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
		case 'invitation_complaint': {
			const [complaint] = await executor
				.select({ candidateId: invitationComplaints.candidateId, companyName: companies.displayName })
				.from(invitationComplaints)
				.innerJoin(companies, eq(companies.id, invitationComplaints.companyId))
				.where(eq(invitationComplaints.id, notification.objectId));
			if (!complaint || !(await isCandidateUser(executor, complaint.candidateId, notification.userId))) return null;
			return { object: 'invitation_complaint', side: 'candidate', companyName: complaint.companyName };
		}
		case 'assessment_attempt': {
			const [attempt] = await executor
				.select({
					candidateId: testAttempts.candidateId,
					specialization: testAttempts.specialization,
					grade: testAttempts.grade
				})
				.from(testAttempts)
				.where(eq(testAttempts.id, notification.objectId));
			if (!attempt || !(await isCandidateUser(executor, attempt.candidateId, notification.userId))) return null;
			return {
				object: 'assessment_attempt',
				side: 'candidate',
				title: testTitle(attempt.specialization, attempt.grade)
			};
		}
		case 'confirmation_request':
			return confirmationFacts(executor, crypto, notification);
		case 'challenge_delivery': {
			const [delivery] = await executor
				.select({
					candidateId: challengeDeliveries.candidateId,
					title: companyChallenges.title,
					companyName: companies.displayName
				})
				.from(challengeDeliveries)
				.innerJoin(companyChallenges, eq(companyChallenges.id, challengeDeliveries.challengeId))
				.innerJoin(companies, eq(companies.id, companyChallenges.companyId))
				.where(eq(challengeDeliveries.id, notification.objectId));
			if (!delivery || !(await isCandidateUser(executor, delivery.candidateId, notification.userId))) return null;
			return {
				object: 'challenge_delivery',
				side: 'candidate',
				companyName: delivery.companyName,
				challengeTitle: delivery.title
			};
		}
		case 'application': {
			const [application] = await executor
				.select({
					candidateId: applications.candidateId,
					companyId: applications.companyId,
					purgedAt: applications.purgedAt,
					vacancyTitle: vacancies.title,
					companyName: companies.displayName
				})
				.from(applications)
				.innerJoin(vacancies, eq(vacancies.id, applications.vacancyId))
				.innerJoin(companies, eq(companies.id, applications.companyId))
				.where(eq(applications.id, notification.objectId));
			if (!application || application.purgedAt !== null) return null;
			if (await isCandidateUser(executor, application.candidateId, notification.userId)) {
				return {
					object: 'application',
					side: 'candidate',
					companyName: application.companyName,
					vacancyTitle: application.vacancyTitle
				};
			}
			if (!(await isActiveMember(executor, application.companyId, notification.userId))) return null;
			return {
				object: 'application',
				side: 'company',
				candidatePseudonym: crypto.pseudonym(application.candidateId, application.companyId),
				vacancyTitle: application.vacancyTitle
			};
		}
	}
	return invitationFacts(executor, crypto, notification);
}

async function confirmationFacts(
	executor: Executor,
	crypto: FieldCrypto,
	notification: { objectId: string; userId: string }
): Promise<NotificationFacts | null> {
	const [request] = await executor
		.select({
			candidateId: confirmationRequests.candidateId,
			companyId: confirmationRequests.companyId,
			block: confirmationRequests.block,
			companyName: companies.displayName
		})
		.from(confirmationRequests)
		.innerJoin(companies, eq(companies.id, confirmationRequests.companyId))
		.where(eq(confirmationRequests.id, notification.objectId));
	if (!request) return null;
	const blockTitle = CATALOG.blocks.find((block) => block.code === request.block)?.title ?? request.block;
	if (await isCandidateUser(executor, request.candidateId, notification.userId)) {
		return { object: 'confirmation_request', side: 'candidate', companyName: request.companyName, blockTitle };
	}
	if (!(await isActiveMember(executor, request.companyId, notification.userId))) return null;
	return {
		object: 'confirmation_request',
		side: 'company',
		candidatePseudonym: crypto.pseudonym(request.candidateId, request.companyId),
		blockTitle
	};
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
		.select({ title: invitationTerms.title })
		.from(invitationTerms)
		.where(eq(invitationTerms.id, invitation.currentTermsId));
	if (!company || !terms) throw new Error(`invitation ${target.invitationId} lacks its company or terms`);
	return {
		object: 'invitation',
		side,
		companyName: company.displayName,
		offerTitle: terms.title,
		candidatePseudonym: crypto.pseudonym(invitation.candidateId, invitation.companyId)
	};
}
