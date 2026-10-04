// Submitting the solution of a code task (docs/domain.md, 10.4; docs/contracts.md, 6.4): the code is stored as the
// `code_submission` artifact before any run, the attempt becomes `submitted`, and `assessment.run` is enqueued in the
// same transaction. One attempt is judged by one submission.
import { eq } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Database } from '$lib/server/db';
import { assessmentAttempts } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { uuidv7 } from '$lib/server/ids';
import { enqueueJob } from '$lib/server/jobs/queue';
import { codeSubmissionArtifact } from '$lib/server/sandbox/artifacts';
import { MAX_SOURCE_BYTES } from '$lib/server/sandbox/request';
import { expireOverdue, lockOwnStartedAttempt, ownCandidateId } from './attempts';
import { assessmentPolicy, retentionUntil } from './policy';
import { appendArtifacts } from './scoring';
import { appendSignal, type ClientSignals } from './signals';
import { loadVersion } from './versions';

export interface CodeSubmission {
	language: string;
	source: string;
	signals: ClientSignals | null;
}

function invalidField(path: string, message: string): ApiError {
	return new ApiError('validation_failed', { message, details: [{ path, code: 'invalid', message }] });
}

export async function submitCode(
	database: Database,
	subject: AccessSubject,
	attemptId: string,
	submission: CodeSubmission,
	now: Date
): Promise<{ artifactId: string }> {
	const candidateId = ownCandidateId(subject, 'write');
	if (submission.source.trim() === '') throw invalidField('source', 'Решение пустое');
	if (Buffer.byteLength(submission.source, 'utf8') > MAX_SOURCE_BYTES) {
		throw invalidField('source', `Решение больше ${MAX_SOURCE_BYTES / 1024} КБ`);
	}
	await expireOverdue(database, candidateId, now);
	return database.transaction(async (tx) => {
		const attempt = await lockOwnStartedAttempt(tx, candidateId, attemptId, now);
		const version = await loadVersion(tx, attempt.versionId);
		if (version?.kind !== 'code_task') throw new ApiError('not_found');
		if (!(version.scorer.languages as string[]).includes(submission.language)) {
			throw invalidField('language', 'Этот язык для задания недоступен');
		}
		const artifactId = uuidv7();
		const draft = codeSubmissionArtifact({
			requestId: artifactId,
			language: submission.language,
			source: submission.source
		});
		const policy = await assessmentPolicy(tx, now);
		await appendArtifacts(
			tx,
			attempt.id,
			[{ id: artifactId, kind: draft.kind, content: draft.content }],
			now,
			retentionUntil(policy, now)
		);
		await tx
			.update(assessmentAttempts)
			.set({
				status: 'submitted',
				submittedAt: now,
				integritySignals: appendSignal(attempt.integritySignals, {
					at: now.toISOString(),
					stage: 'code_submission',
					client: submission.signals
				})
			})
			.where(eq(assessmentAttempts.id, attempt.id));
		await enqueueJob(
			tx,
			'assessment.run',
			{ artifact_id: artifactId },
			{ inputVersion: artifactId, createdBy: { kind: 'user', id: subject.userId ?? undefined } }
		);
		return { artifactId };
	});
}
