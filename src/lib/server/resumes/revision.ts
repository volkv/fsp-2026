// How a change of the resume evidence reaches the categorization and the profile vectors (docs/domain.md, sections
// 7.1, 16, 17.1, 17.3): every change of the input moves `profile_revision` and enqueues the recalculations in the same
// transaction; a change that takes a ground away also raises `evidence_floor_revision` and takes the published category
// off the card at once.
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AuditActor } from '$lib/server/audit/record';
import { enqueueProfileEmbed } from '$lib/server/candidates/embed-job';
import { blockPublishedCategory } from '$lib/server/categorization/job';
import type { Transaction } from '$lib/server/db';
import { candidates, claims, documentExtractions, experienceEntries, sourceFacts } from '$lib/server/db/schema';
import { cancelWaitingJobs, enqueueJob, type JobCreator } from '$lib/server/jobs/queue';

export interface RevisionChange {
	candidateId: string;
	/** The change removes or weakens a ground: derivatives of earlier revisions stop counting (domain 17.3). */
	withdrawal: boolean;
	/** Why the published category is blocked, for the journal. */
	reason: string;
	requestId: string;
	actor: AuditActor;
	createdBy: JobCreator;
}

/** Moves the revision, raises the floor on a withdrawal, and enqueues `categorization.compute` and `profile.embed`. */
export async function recordEvidenceChange(tx: Transaction, change: RevisionChange): Promise<number> {
	const [row] = await tx
		.update(candidates)
		.set({
			profileRevision: sql`${candidates.profileRevision} + 1`,
			...(change.withdrawal ? { evidenceFloorRevision: sql`${candidates.profileRevision} + 1` } : {})
		})
		.where(eq(candidates.id, change.candidateId))
		.returning({ profileRevision: candidates.profileRevision });
	if (!row) throw new Error(`candidate ${change.candidateId} is missing`);
	if (change.withdrawal) {
		await blockPublishedCategory(tx, change.candidateId, {
			requestId: change.requestId,
			actor: change.actor,
			reason: change.reason
		});
	}
	await enqueueJob(
		tx,
		'categorization.compute',
		{ candidate_id: change.candidateId },
		{ inputVersion: String(row.profileRevision), createdBy: change.createdBy }
	);
	await enqueueProfileEmbed(tx, change.candidateId, row.profileRevision, change.createdBy);
	return row.profileRevision;
}

/** Locks the candidate row: uploads, parse results and edits of one candidate are applied one at a time. */
export async function lockCandidate(tx: Transaction, candidateId: string): Promise<boolean> {
	const [row] = await tx
		.select({ id: candidates.id })
		.from(candidates)
		.where(eq(candidates.id, candidateId))
		.for('update');
	return row !== undefined;
}

export const resumeRecordRef = (resumeDocumentId: string) => `resume:${resumeDocumentId}`;

/** The statuses of a fact that has left the profile (docs/domain.md, section 9.1). */
export type RetiredFactStatus = 'superseded' | 'withdrawn' | 'annulled';

/**
 * Takes facts out of the profile: every fact matching all conditions of `which` becomes `status` with `reason`, the
 * active claims and experience entries resting on them become `invalidated`. One statement selects and updates the
 * facts, so a fact another transaction retired meanwhile is judged by its current status. Returns the facts retired;
 * the caller moves the revision (`recordEvidenceChange`).
 */
export async function retireFacts(
	tx: Transaction,
	which: readonly [SQL, ...SQL[]],
	status: RetiredFactStatus,
	reason: string
): Promise<string[]> {
	const facts = await tx
		.update(sourceFacts)
		.set({ status, statusReason: reason })
		.where(and(...which))
		.returning({ id: sourceFacts.id });
	const ids = facts.map((f) => f.id);
	if (ids.length === 0) return ids;
	await tx
		.update(claims)
		.set({ status: 'invalidated' })
		.where(and(inArray(claims.factId, ids), eq(claims.status, 'active')));
	await tx
		.update(experienceEntries)
		.set({ status: 'invalidated' })
		.where(and(inArray(experienceEntries.factId, ids), eq(experienceEntries.status, 'active')));
	return ids;
}

/**
 * Takes the evidence of a resume out of the profile: its active fact becomes `status`, the claims and experience
 * entries of the fact become `invalidated`. Returns whether there was an active fact.
 */
export async function withdrawResumeFact(
	tx: Transaction,
	candidateId: string,
	resumeDocumentId: string,
	status: 'superseded' | 'withdrawn',
	reason: string
): Promise<boolean> {
	const retired = await retireFacts(
		tx,
		[
			eq(sourceFacts.candidateId, candidateId),
			eq(sourceFacts.sourceRecordRef, resumeRecordRef(resumeDocumentId)),
			eq(sourceFacts.status, 'active')
		],
		status,
		reason
	);
	return retired.length > 0;
}

/** Cancels the waiting parse and extraction of a resume that is no longer needed; a running one ends stale. */
export async function cancelResumeJobs(tx: Transaction, resumeDocumentId: string): Promise<void> {
	await cancelWaitingJobs(tx, 'resume.parse', { resume_document_id: resumeDocumentId });
	const extractions = await tx
		.select({ id: documentExtractions.id })
		.from(documentExtractions)
		.where(eq(documentExtractions.resumeDocumentId, resumeDocumentId));
	for (const extraction of extractions) {
		await cancelWaitingJobs(tx, 'resume.extract', { extraction_id: extraction.id });
	}
}
