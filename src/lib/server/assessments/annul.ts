// Annulment of an attempt by the operator of FSP (docs/domain.md 10.2, 10.3, 19.1): `submitted | scored → annulled`
// with the reason and the operator. The facts the scores of the attempt became leave the profile as `annulled` — the
// candidate sees what was annulled and why, a receipt of such a fact answers `annulled` — their claims and experience
// entries are invalidated, and the change of the evidence raises the floor of derivatives, blocks the published
// category and enqueues its recalculation and the profile vectors. A waiting run of a submission is cancelled; a
// running one finds the attempt no longer `submitted` and writes nothing. An attempt annulled for a technical failure
// or a defect of the version does not count toward the limit of attempts (`attempts.ts`). The candidate is notified
// (`assessment.annulled`): the test and whether the attempt still counts, the reason as a code; the page of the attempt
// tells the candidate the same (`ownAttemptAnnulment`).
import { and, eq } from 'drizzle-orm';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import { auditActorOf, conflict, invalid, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { Database, Executor } from '$lib/server/db';
import { assessmentArtifacts, assessmentAttempts, candidates, sourceFacts } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { cancelWaitingJobs } from '$lib/server/jobs/queue';
import { notify } from '$lib/server/notifications/notify';
import { recordEvidenceChange, retireFacts } from '$lib/server/resumes/revision';
import { ownCandidateId } from './attempts';

export const ANNUL_REASONS = assessmentAttempts.annulReason.enumValues;
export type AnnulReason = (typeof ANNUL_REASONS)[number];

/** The `status_reason` of a fact whose attempt was annulled; the reason itself stays with the attempt. */
const ANNULLED_ATTEMPT = 'attempt_annulled';

/** Annulments for a failure on the platform's side: the attempt does not count toward the limit of attempts. */
export const UNCOUNTED_REASONS: readonly AnnulReason[] = ['technical_failure', 'version_defect'];

/** What the candidate is told about the annulment of their attempt. */
export interface OwnAnnulment {
	reason: AnnulReason;
	annulledAt: Date;
	countsTowardLimit: boolean;
}

/** The annulment of the candidate's own attempt; `null` — the attempt is not annulled. */
export async function ownAttemptAnnulment(
	executor: Executor,
	subject: AccessSubject,
	attemptId: string
): Promise<OwnAnnulment | null> {
	const candidateId = ownCandidateId(subject, 'read');
	const [row] = await executor
		.select({ reason: assessmentAttempts.annulReason, annulledAt: assessmentAttempts.annulledAt })
		.from(assessmentAttempts)
		.where(and(eq(assessmentAttempts.id, attemptId), eq(assessmentAttempts.candidateId, candidateId)));
	if (!row) throw new ApiError('not_found');
	if (row.reason === null || row.annulledAt === null) return null;
	return {
		reason: row.reason,
		annulledAt: row.annulledAt,
		countsTowardLimit: !UNCOUNTED_REASONS.includes(row.reason)
	};
}

export interface AnnulOutcome {
	/** `false` — the attempt was already annulled: nothing changed. */
	annulled: boolean;
	factsAnnulled: number;
}

export async function annulAttempt(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	attemptId: string,
	reason: AnnulReason,
	now: Date
): Promise<AnnulOutcome> {
	requirePermission(subject, 'assessment.review', null);
	const operatorId = sessionUserId(subject);
	if (!ANNUL_REASONS.includes(reason)) {
		throw invalid([{ path: 'reason', code: 'invalid', message: 'Выберите причину аннулирования' }]);
	}
	const reach = await StaffReach.of(db, subject);
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({
				attempt: assessmentAttempts,
				demoSessionId: candidates.demoSessionId,
				candidateUserId: candidates.userId
			})
			.from(assessmentAttempts)
			.innerJoin(candidates, eq(candidates.id, assessmentAttempts.candidateId))
			.where(eq(assessmentAttempts.id, attemptId))
			.for('update', { of: assessmentAttempts });
		if (!row) throw new ApiError('not_found');
		reach.require(row.demoSessionId);
		const { attempt } = row;
		if (attempt.status === 'annulled') return { annulled: false, factsAnnulled: 0 };
		if (attempt.status !== 'submitted' && attempt.status !== 'scored') {
			throw conflict('attempt_not_sent', 'Аннулировать можно только отправленную попытку');
		}
		const previousStatus = attempt.status;
		await tx
			.update(assessmentAttempts)
			.set({ status: 'annulled', annulledBy: operatorId, annulledAt: now, annulReason: reason })
			.where(eq(assessmentAttempts.id, attempt.id));
		if (previousStatus === 'submitted') {
			const submissions = await tx
				.select({ id: assessmentArtifacts.id })
				.from(assessmentArtifacts)
				.where(and(eq(assessmentArtifacts.attemptId, attempt.id), eq(assessmentArtifacts.kind, 'code_submission')));
			for (const submission of submissions) {
				await cancelWaitingJobs(tx, 'assessment.run', { artifact_id: submission.id });
			}
		}

		const factIds = await retireFacts(
			tx,
			[
				eq(sourceFacts.source, 'platform_test'),
				eq(sourceFacts.ownershipBasis, 'own_attempt'),
				eq(sourceFacts.ownershipRef, attempt.id),
				eq(sourceFacts.status, 'active')
			],
			'annulled',
			ANNULLED_ATTEMPT
		);
		if (factIds.length > 0) {
			await recordEvidenceChange(tx, {
				candidateId: attempt.candidateId,
				withdrawal: true,
				reason: 'assessment_annulled',
				requestId: meta.requestId,
				actor: auditActorOf(subject),
				createdBy: { kind: 'user', id: operatorId }
			});
		}
		await recordAuditEvent(tx, {
			action: 'assessment.annulled',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'assessment_attempt', id: attempt.id },
			subjectCandidateId: attempt.candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			occurredAt: now,
			details: { reason, previous_status: previousStatus, facts_annulled: factIds.length }
		});
		await notify(tx, {
			userId: row.candidateUserId,
			type: 'assessment.annulled',
			objectId: attempt.id,
			payload: { attempt_id: attempt.id, reason }
		});
		return { annulled: true, factsAnnulled: factIds.length };
	});
}
