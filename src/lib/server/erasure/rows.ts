// The rows of one person the deletion and the purge work over (docs/domain.md, section 19): identifiers only, read in
// the caller's transaction, and the waiting jobs that name any of them.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '$lib/server/db';
import {
	athleteLinks,
	candidates,
	confirmationRequests,
	documentExtractions,
	hiringProcesses,
	invitations,
	notifications,
	representations,
	resumeDocuments,
	testArtifacts,
	testAttempts
} from '$lib/server/db/schema';

export interface PersonIds {
	userId: string;
	/** The profile that is not a tombstone yet; `null` — the account has none. */
	candidateId: string | null;
	athleteLinkIds: string[];
	resumeIds: string[];
	extractionIds: string[];
	attemptIds: string[];
	artifactIds: string[];
	invitationIds: string[];
	processIds: string[];
	representationIds: string[];
	notificationIds: string[];
	/** Requests of a confirmation to the candidate: their expiry jobs go with them. */
	confirmationRequestIds: string[];
}

const idsOf = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

/** The identifiers of the person's rows; the profile row is locked. */
export async function personIds(tx: Transaction, userId: string): Promise<PersonIds> {
	const [candidate] = await tx
		.select({ id: candidates.id })
		.from(candidates)
		.where(eq(candidates.userId, userId))
		.for('update');
	const candidateId = candidate?.id ?? null;
	const athleteLinkIds = idsOf(
		await tx.select({ id: athleteLinks.id }).from(athleteLinks).where(eq(athleteLinks.userId, userId))
	);
	const notificationIds = idsOf(
		await tx.select({ id: notifications.id }).from(notifications).where(eq(notifications.userId, userId))
	);
	if (candidateId === null) {
		return {
			userId,
			candidateId,
			athleteLinkIds,
			resumeIds: [],
			extractionIds: [],
			attemptIds: [],
			artifactIds: [],
			invitationIds: [],
			processIds: [],
			representationIds: [],
			notificationIds,
			confirmationRequestIds: []
		};
	}
	const resumeIds = idsOf(
		await tx
			.select({ id: resumeDocuments.id })
			.from(resumeDocuments)
			.where(eq(resumeDocuments.candidateId, candidateId))
	);
	const extractionIds =
		resumeIds.length === 0
			? []
			: idsOf(
					await tx
						.select({ id: documentExtractions.id })
						.from(documentExtractions)
						.where(inArray(documentExtractions.resumeDocumentId, resumeIds))
				);
	const attemptIds = idsOf(
		await tx.select({ id: testAttempts.id }).from(testAttempts).where(eq(testAttempts.candidateId, candidateId))
	);
	const artifactIds =
		attemptIds.length === 0
			? []
			: idsOf(
					await tx
						.select({ id: testArtifacts.id })
						.from(testArtifacts)
						.where(inArray(testArtifacts.attemptId, attemptIds))
				);
	const invitationIds = idsOf(
		await tx
			.select({ id: invitations.id })
			.from(invitations)
			.where(and(eq(invitations.candidateId, candidateId), sql`${invitations.purgedAt} is null`))
	);
	const processIds = idsOf(
		await tx
			.select({ id: hiringProcesses.id })
			.from(hiringProcesses)
			.where(eq(hiringProcesses.candidateId, candidateId))
	);
	const representationIds = idsOf(
		await tx
			.select({ id: representations.id })
			.from(representations)
			.where(eq(representations.candidateId, candidateId))
	);
	const confirmationRequestIds = idsOf(
		await tx
			.select({ id: confirmationRequests.id })
			.from(confirmationRequests)
			.where(eq(confirmationRequests.candidateId, candidateId))
	);
	return {
		userId,
		candidateId,
		athleteLinkIds,
		resumeIds,
		extractionIds,
		attemptIds,
		artifactIds,
		invitationIds,
		processIds,
		representationIds,
		notificationIds,
		confirmationRequestIds
	};
}

/**
 * Cancels the waiting jobs whose payload names any of the person's rows: parses, extractions, imports, recalculations,
 * test runs, reminders about their invitations, deliveries of their notifications. A running one is stopped by the
 * check of its write. The purge of the account itself is not cancelled. Returns how many were cancelled.
 */
export async function cancelJobsOfPerson(tx: Transaction, ids: PersonIds): Promise<number> {
	const named = [
		ids.userId,
		...(ids.candidateId === null ? [] : [ids.candidateId]),
		...ids.athleteLinkIds,
		...ids.resumeIds,
		...ids.extractionIds,
		...ids.artifactIds,
		...ids.invitationIds,
		...ids.processIds,
		...ids.notificationIds,
		...ids.confirmationRequestIds
	];
	const cancelled = await tx.execute<{ id: string }>(sql`
		update jobs set status = 'cancelled', finished_at = now()
		where status = 'queued' and type <> 'account.purge' and exists (
			select 1 from jsonb_each_text(jobs.payload) p where p.value in (${sql.join(
				named.map((id) => sql`${id}`),
				sql`, `
			)}))
		returning id`);
	return cancelled.length;
}
