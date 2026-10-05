// Notifications in the interface (docs/domain.md, section 3.7): the list of the signed-in person, reading one of them
// and where it leads. Every channel carries only the kind of the event and the link `/notifications/{id}`; the object
// itself is opened with the recipient's access checked again, so a withdrawn invitation or a company the person left
// leads nowhere. An operator's decision leads to where its result is read: the company profile, the company's vacancy,
// the category page, the visibility page or, after a refused representative, the step that names one again; the
// consents the representative signed or revoked and the verified birth date lead to the candidate's consents, an
// annulled attempt to the attempt itself. The deadline of an objection leads an operator to the queue of objections
// and an admin to the staff management.
import { and, count, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type { Database } from '$lib/server/db';
import {
	applications,
	assessmentObjections,
	candidates,
	challengeDeliveries,
	companies,
	confirmationRequests,
	companyMembers,
	hiringProcesses,
	invitations,
	notifications,
	representations,
	testAttempts,
	vacancies
} from '$lib/server/db/schema';
import { categoryOwner } from '$lib/server/categories/read';
import { activeStaffRole } from './content';
import { NOTIFICATION_TYPES, isNotificationType, isObjectionDeadline, type NotificationCategory } from './types';

export const INBOX_PAGE_SIZE = 30;

export interface InboxItem {
	id: string;
	/** The kind of the event in a few words; a type unknown to this version reads as a generic notification. */
	title: string;
	category: NotificationCategory;
	createdAt: Date;
	readAt: Date | null;
}

export interface Inbox {
	items: InboxItem[];
	unread: number;
	/** `created_at` and id of the last item: the next page starts after it. */
	nextCursor: string | null;
}

const cursorPattern = /^(\d{13})_([0-9a-f-]{36})$/;

function titleOf(type: string): string {
	return isNotificationType(type) ? NOTIFICATION_TYPES[type].title : 'Уведомление';
}

/** The newest notifications of the user first, with the number of unread ones. */
export async function listNotifications(db: Database, userId: string, cursor: string | null): Promise<Inbox> {
	const match = cursor === null ? null : cursorPattern.exec(cursor);
	const after =
		match?.[1] !== undefined && match[2] !== undefined
			? or(
					lt(notifications.createdAt, new Date(Number(match[1]))),
					and(eq(notifications.createdAt, new Date(Number(match[1]))), lt(notifications.id, match[2]))
				)
			: undefined;
	const rows = await db
		.select({
			id: notifications.id,
			type: notifications.type,
			category: notifications.category,
			createdAt: notifications.createdAt,
			readAt: notifications.readAt
		})
		.from(notifications)
		.where(and(eq(notifications.userId, userId), after))
		.orderBy(desc(notifications.createdAt), desc(notifications.id))
		.limit(INBOX_PAGE_SIZE + 1);
	const [unread] = await db
		.select({ value: count() })
		.from(notifications)
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
	const page = rows.slice(0, INBOX_PAGE_SIZE);
	const last = page.at(-1);
	return {
		items: page.map((row) => ({
			id: row.id,
			title: titleOf(row.type),
			category: row.category,
			createdAt: row.createdAt,
			readAt: row.readAt
		})),
		unread: unread?.value ?? 0,
		nextCursor: rows.length > INBOX_PAGE_SIZE && last ? `${last.createdAt.getTime()}_${last.id}` : null
	};
}

/** Where a notification leads its recipient right now. */
export type NotificationTarget =
	| { kind: 'candidate_invitation'; invitationId: string }
	| { kind: 'company_invitation'; invitationId: string }
	/** The company profile with the verification decision and its reason. */
	| { kind: 'company_profile' }
	/** The company's own vacancy with the moderation decision and its reason. */
	| { kind: 'company_vacancy'; vacancyId: string }
	/** The candidate's page «Категория и грейд»: the answer to an objection, a category assigned or revoked. */
	| { kind: 'candidate_category' }
	/** The candidate's visibility page: the representative's authority is confirmed. */
	| { kind: 'candidate_visibility' }
	/** The onboarding step naming a representative: the authority was not confirmed. */
	| { kind: 'candidate_representative' }
	/**
	 * The candidate's consents: signed or revoked by the representative, signed anew after 18, the regime after the
	 * verified birth date, or where the profile is kept or removed.
	 */
	| { kind: 'candidate_consents' }
	/** The candidate's own attempt of a test: the operator annulled it. */
	| { kind: 'candidate_attempt'; attemptId: string }
	/** The candidate's requests of a confirmation and block results. */
	| { kind: 'candidate_confirmations' }
	/** The requests of a confirmation of the company with their results. */
	| { kind: 'company_confirmations' }
	/** A call delivered to the candidate. */
	| { kind: 'candidate_challenge'; deliveryId: string }
	/** The candidate's own applications. */
	| { kind: 'candidate_applications' }
	/** An application to the company's own vacancy. */
	| { kind: 'company_application'; applicationId: string }
	/** The operator's queue of objections: an answer is due soon or overdue. */
	| { kind: 'operator_objections' }
	/** The admin's staff management: an objection waits for its answer. */
	| { kind: 'admin_staff' }
	/** The object is gone or the recipient no longer has access to it. */
	| { kind: 'unavailable' };

/**
 * Marks the notification read and names where it leads; `null` — the user has no such notification. The side is
 * decided now, not when the notification was created: a member who left the company is led nowhere.
 */
export async function openNotification(
	db: Database,
	userId: string,
	notificationId: string,
	now: Date
): Promise<{ title: string; target: NotificationTarget } | null> {
	const [row] = await db
		.select({
			id: notifications.id,
			type: notifications.type,
			objectType: notifications.objectType,
			objectId: notifications.objectId,
			readAt: notifications.readAt
		})
		.from(notifications)
		.where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
	if (!row) return null;
	if (row.readAt === null) {
		await db.update(notifications).set({ readAt: now }).where(eq(notifications.id, row.id));
	}
	return { title: titleOf(row.type), target: await targetOf(db, userId, row) };
}

async function isActiveMember(db: Database, companyId: string, userId: string): Promise<boolean> {
	const [member] = await db
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

async function candidateUserOf(db: Database, candidateId: string): Promise<string | null> {
	const [candidate] = await db
		.select({ userId: candidates.userId })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	return candidate?.userId ?? null;
}

async function targetOf(
	db: Database,
	userId: string,
	notification: { type: string; objectType: string; objectId: string }
): Promise<NotificationTarget> {
	const { objectType, objectId } = notification;
	switch (objectType) {
		case 'company': {
			const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, objectId));
			return company && (await isActiveMember(db, company.id, userId))
				? { kind: 'company_profile' }
				: { kind: 'unavailable' };
		}
		case 'vacancy': {
			const [vacancy] = await db
				.select({ companyId: vacancies.companyId })
				.from(vacancies)
				.where(and(eq(vacancies.id, objectId), eq(vacancies.origin, 'own')));
			return vacancy && vacancy.companyId !== null && (await isActiveMember(db, vacancy.companyId, userId))
				? { kind: 'company_vacancy', vacancyId: objectId }
				: { kind: 'unavailable' };
		}
		case 'assessment_objection': {
			if (isNotificationType(notification.type) && isObjectionDeadline(notification.type)) {
				// Decided now: a revoked role leads nowhere; an answered objection is read in the queue as well.
				const role = await activeStaffRole(db, userId);
				if (role === null) return { kind: 'unavailable' };
				return role === 'operator' ? { kind: 'operator_objections' } : { kind: 'admin_staff' };
			}
			const [objection] = await db
				.select({ candidateId: assessmentObjections.candidateId })
				.from(assessmentObjections)
				.where(eq(assessmentObjections.id, objectId));
			return objection && (await candidateUserOf(db, objection.candidateId)) === userId
				? { kind: 'candidate_category' }
				: { kind: 'unavailable' };
		}
		case 'candidate_category': {
			const candidateId = await categoryOwner(db, objectId);
			return candidateId !== null && (await candidateUserOf(db, candidateId)) === userId
				? { kind: 'candidate_category' }
				: { kind: 'unavailable' };
		}
		case 'representation': {
			const [representation] = await db
				.select({ candidateId: representations.candidateId, status: representations.status })
				.from(representations)
				.where(eq(representations.id, objectId));
			if (!representation || (await candidateUserOf(db, representation.candidateId)) !== userId) {
				return { kind: 'unavailable' };
			}
			// The signed or revoked consents are read with the consents, whatever became of the representation since.
			if (
				notification.type === 'representation.consents_signed' ||
				notification.type === 'representation.consents_revoked'
			) {
				return { kind: 'candidate_consents' };
			}
			// Decided now, not when notified: a confirmed representation may have ended since.
			return representation.status === 'authority_verified'
				? { kind: 'candidate_visibility' }
				: { kind: 'candidate_representative' };
		}
		case 'candidate':
			return (await candidateUserOf(db, objectId)) === userId
				? { kind: 'candidate_consents' }
				: { kind: 'unavailable' };
		case 'assessment_attempt': {
			const [attempt] = await db
				.select({ candidateId: testAttempts.candidateId })
				.from(testAttempts)
				.where(eq(testAttempts.id, objectId));
			return attempt && (await candidateUserOf(db, attempt.candidateId)) === userId
				? { kind: 'candidate_attempt', attemptId: objectId }
				: { kind: 'unavailable' };
		}
		case 'confirmation_request': {
			const [request] = await db
				.select({ candidateId: confirmationRequests.candidateId, companyId: confirmationRequests.companyId })
				.from(confirmationRequests)
				.where(eq(confirmationRequests.id, objectId));
			if (!request) return { kind: 'unavailable' };
			if ((await candidateUserOf(db, request.candidateId)) === userId) return { kind: 'candidate_confirmations' };
			return (await isActiveMember(db, request.companyId, userId))
				? { kind: 'company_confirmations' }
				: { kind: 'unavailable' };
		}
		case 'challenge_delivery': {
			const [delivery] = await db
				.select({ candidateId: challengeDeliveries.candidateId })
				.from(challengeDeliveries)
				.where(eq(challengeDeliveries.id, objectId));
			return delivery && (await candidateUserOf(db, delivery.candidateId)) === userId
				? { kind: 'candidate_challenge', deliveryId: objectId }
				: { kind: 'unavailable' };
		}
		case 'application': {
			const [application] = await db
				.select({
					candidateId: applications.candidateId,
					companyId: applications.companyId,
					purgedAt: applications.purgedAt
				})
				.from(applications)
				.where(eq(applications.id, objectId));
			if (!application || application.purgedAt !== null) return { kind: 'unavailable' };
			if ((await candidateUserOf(db, application.candidateId)) === userId) return { kind: 'candidate_applications' };
			return (await isActiveMember(db, application.companyId, userId))
				? { kind: 'company_application', applicationId: objectId }
				: { kind: 'unavailable' };
		}
	}
	let invitationId: string | null = null;
	if (objectType === 'invitation') invitationId = objectId;
	else if (objectType === 'hiring_process') {
		const [process] = await db
			.select({ invitationId: hiringProcesses.invitationId })
			.from(hiringProcesses)
			.where(eq(hiringProcesses.id, objectId));
		invitationId = process?.invitationId ?? null;
	}
	if (invitationId === null) return { kind: 'unavailable' };
	const [invitation] = await db
		.select({ companyId: invitations.companyId, candidateUserId: candidates.userId, purgedAt: invitations.purgedAt })
		.from(invitations)
		.innerJoin(candidates, eq(candidates.id, invitations.candidateId))
		.where(eq(invitations.id, invitationId));
	if (!invitation || invitation.purgedAt !== null) return { kind: 'unavailable' };
	if (invitation.candidateUserId === userId) return { kind: 'candidate_invitation', invitationId };
	return (await isActiveMember(db, invitation.companyId, userId))
		? { kind: 'company_invitation', invitationId }
		: { kind: 'unavailable' };
}

/** Marks every notification of the user read. */
export async function markAllRead(db: Database, userId: string, now: Date): Promise<void> {
	await db
		.update(notifications)
		.set({ readAt: now })
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}
