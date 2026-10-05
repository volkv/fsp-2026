// The candidate deletes a resume (docs/domain.md, sections 17.3, 19): the object leaves the bucket, and one transaction
// removes the document with everything derived from it — the extraction text, the model envelopes with their rejected
// items, the fact, the claims, the experience entries and the suggestions of profile fields (values the candidate
// accepted stay in the profile: they are the candidate's own now). Personal data is deleted physically, not flagged. When the
// resume still counted in the profile, the removal is a withdrawal: the revision and the evidence floor move, the
// published category is blocked and the recalculation is enqueued.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import {
	claims,
	documentExtractions,
	experienceEntries,
	files,
	mlResults,
	resumeDocuments,
	sourceFacts
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { deleteSuggestionsOf } from '$lib/server/profile/suggestions';
import { cancelResumeJobs, lockCandidate, recordEvidenceChange, resumeRecordRef } from './revision';
import { selfCandidate, type ResumeDeps } from './deps';

export async function deleteResume(
	deps: ResumeDeps,
	subject: AccessSubject,
	resumeDocumentId: string,
	meta: RequestMeta
): Promise<void> {
	const { candidateId, userId } = selfCandidate(subject);
	const [document] = await deps.db
		.select({ fileId: resumeDocuments.fileId, storageKey: files.storageKey })
		.from(resumeDocuments)
		.innerJoin(files, eq(files.id, resumeDocuments.fileId))
		.where(and(eq(resumeDocuments.id, resumeDocumentId), eq(resumeDocuments.candidateId, candidateId)));
	if (!document) throw new ApiError('not_found');

	// The object goes first: removing it again is harmless, while a row without its object could not be repeated.
	await deps.store.delete(document.storageKey);

	await deps.db.transaction(async (tx) => {
		if (!(await lockCandidate(tx, candidateId))) throw new ApiError('not_found');
		const [still] = await tx
			.select({ id: resumeDocuments.id })
			.from(resumeDocuments)
			.where(eq(resumeDocuments.id, resumeDocumentId))
			.for('update');
		if (!still) return;
		await cancelResumeJobs(tx, resumeDocumentId);

		const facts = await tx
			.select({ id: sourceFacts.id, status: sourceFacts.status })
			.from(sourceFacts)
			.where(
				and(
					eq(sourceFacts.candidateId, candidateId),
					eq(sourceFacts.sourceRecordRef, resumeRecordRef(resumeDocumentId))
				)
			);
		const factIds = facts.map((fact) => fact.id);
		const counted = facts.some((fact) => fact.status === 'active');
		const extractionIds = (
			await tx
				.select({ id: documentExtractions.id })
				.from(documentExtractions)
				.where(eq(documentExtractions.resumeDocumentId, resumeDocumentId))
		).map((row) => row.id);

		if (factIds.length > 0) {
			await tx.delete(claims).where(inArray(claims.factId, factIds));
			await tx.delete(experienceEntries).where(inArray(experienceEntries.factId, factIds));
		}
		if (extractionIds.length > 0) {
			await tx
				.delete(mlResults)
				.where(
					and(
						sql`${mlResults.inputRef} ->> 'type' = 'document_extraction'`,
						inArray(sql`${mlResults.inputRef} ->> 'id'`, extractionIds)
					)
				);
		}
		if (factIds.length > 0) await tx.delete(sourceFacts).where(inArray(sourceFacts.id, factIds));
		await deleteSuggestionsOf(tx, extractionIds);
		await tx.delete(documentExtractions).where(eq(documentExtractions.resumeDocumentId, resumeDocumentId));
		await tx.delete(resumeDocuments).where(eq(resumeDocuments.id, resumeDocumentId));
		await tx.delete(files).where(eq(files.id, document.fileId));

		if (counted) {
			await recordEvidenceChange(tx, {
				candidateId,
				withdrawal: true,
				reason: 'resume_deleted',
				requestId: meta.requestId,
				actor: auditActor(subject, meta, 'candidate'),
				createdBy: { kind: 'user', id: userId }
			});
		}
	});
}
