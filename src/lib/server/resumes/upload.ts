// A candidate uploads a resume (docs/domain.md, sections 15.1, 15.2, 19.1): the file is checked by content and stored,
// then one transaction records it as the current resume, archives the previous one with its evidence and enqueues the
// parse. The object is stored first; a failed transaction removes it again. A resume is taken only on the ground of
// `pd_processing` in effect (for ages 14–17 with the representative's signature), and a demo clone needs the consent
// to upload a resume of one's own.
import { and, desc, eq } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { requireProcessingConsent } from '$lib/server/consent/processing';
import { resumeDocuments } from '$lib/server/db/schema';
import { ownResumeGate } from '$lib/server/demo/own-resume-gate';
import { assertResumeSize } from '$lib/server/documents/limits';
import { ApiError } from '$lib/server/errors/api-error';
import { uuidv7 } from '$lib/server/ids';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { enqueueJob } from '$lib/server/jobs/queue';
import { discardUpload, insertFile, prepareUpload, putUpload } from '$lib/server/storage/files';
import { DOCUMENT_FORMATS } from '$lib/server/storage/signature';
import { selfCandidate, type ResumeDeps } from './deps';
import { cancelResumeJobs, lockCandidate, recordEvidenceChange, withdrawResumeFact } from './revision';

export interface UploadedResume {
	resumeDocumentId: string;
	fileId: string;
	seq: number;
	parseJobId: string;
}

export async function uploadResume(
	deps: ResumeDeps,
	subject: AccessSubject,
	input: { bytes: Uint8Array<ArrayBuffer>; declaredName: string },
	meta: RequestMeta
): Promise<UploadedResume> {
	const { candidateId, userId } = selfCandidate(subject);
	assertResumeSize(input.bytes.byteLength);
	const upload = prepareUpload({
		purpose: 'resume',
		bytes: input.bytes,
		declaredName: input.declaredName,
		formats: DOCUMENT_FORMATS
	});
	// Not even stored without the ground; the transaction checks it again under the candidate's lock.
	await requireProcessingConsent(deps.db, candidateId, deps.now());
	await putUpload(deps.store, upload);
	try {
		return await deps.db.transaction(async (tx) => {
			if (!(await lockCandidate(tx, candidateId))) throw new Error(`candidate ${candidateId} is missing`);
			await requireProcessingConsent(tx, candidateId, deps.now());
			// A demo clone carries a real person's resume only under the separate consent of the demo screen (domain 19.3).
			if ((await ownResumeGate(tx, candidateId, deps.now())) === 'consent_missing') {
				throw new ApiError('policy_violation', {
					message: 'В демо-сессии своё резюме загружается со страницы «Демо → своё резюме» с отдельным согласием'
				});
			}
			await insertFile(tx, upload, userId);

			const [latest] = await tx
				.select({ seq: resumeDocuments.seq })
				.from(resumeDocuments)
				.where(eq(resumeDocuments.candidateId, candidateId))
				.orderBy(desc(resumeDocuments.seq))
				.limit(1);
			const [previous] = await tx
				.update(resumeDocuments)
				.set({ isCurrent: false })
				.where(and(eq(resumeDocuments.candidateId, candidateId), eq(resumeDocuments.isCurrent, true)))
				.returning({ id: resumeDocuments.id });
			if (previous) await cancelResumeJobs(tx, previous.id);
			if (previous && (await withdrawResumeFact(tx, candidateId, previous.id, 'superseded', 'resume_replaced'))) {
				// The previous resume leaves the profile now; the category is recomputed without it (domain 19.1).
				await recordEvidenceChange(tx, {
					candidateId,
					withdrawal: true,
					reason: 'resume_replaced',
					requestId: meta.requestId,
					actor: auditActor(subject, meta, 'candidate'),
					createdBy: { kind: 'user', id: userId }
				});
			}

			const resumeDocumentId = uuidv7();
			const seq = (latest?.seq ?? 0) + 1;
			await tx.insert(resumeDocuments).values({
				id: resumeDocumentId,
				candidateId,
				fileId: upload.fileId,
				seq,
				isCurrent: true,
				parseStatus: 'pending'
			});
			const job = await enqueueJob(
				tx,
				'resume.parse',
				{ resume_document_id: resumeDocumentId },
				{ inputVersion: resumeDocumentId, createdBy: { kind: 'user', id: userId } }
			);
			return { resumeDocumentId, fileId: upload.fileId, seq, parseJobId: job.jobId };
		});
	} catch (error) {
		return discardUpload(deps.store, upload, error);
	}
}
