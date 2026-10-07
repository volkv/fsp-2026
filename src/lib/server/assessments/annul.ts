// Annulment of an attempt (docs/domain.md, 10.7, 12.4–12.5): by the operator of FSP (`assessment.review`) or by the
// outcome of an objection. `decided | expired → annulled` with the reason — and an attempt still running only for a
// technical failure, when a cluster of it has waited for the sandbox longer than 30 minutes (contracts 6.4), its waiting
// runs cancelled: the decision becomes `annulled`, and the owner of the category brings the category and the fact of the
// test to the remaining decisions (`applyGradeDecisions`: revoke, restore the previous one, or keep). An annulment for a
// reason of `freeRetakeAnnulReasons` does not count as an attempt of the policy. The candidate is notified
// (`assessment.annulled`).
//
// The application annuls by itself, at its start, every attempt still running on a release whose code the bank tree on
// disk no longer has (domain 10.5): the attempt cannot go on — its generators are not there to serve it — and the
// engine never runs other code under its release. The reason is `version_defect`, a free retake.
import { and, eq, inArray, lt } from 'drizzle-orm';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import { auditActorOf, conflict, invalid, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { Database, Executor, Transaction } from '$lib/server/db';
import {
	ANNUL_REASONS,
	candidates,
	gradeDecisions,
	testArtifacts,
	testAttempts,
	testItems
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { cancelWaitingJobs } from '$lib/server/jobs/queue';
import { notify } from '$lib/server/notifications/notify';
import { BANK_ROOT, releaseById, releaseDrift } from './bank-store';
import { annulBlockResults } from './block-test';
import type { SpecializationKey } from './contract/catalog';
import { GRADE_POLICY, type CategoryChange } from './contract/policy';
import { ownCandidateId } from './engine';
import { STUCK_AFTER_MS } from './review';
import type { GradeStanding } from './standing';

export { ANNUL_REASONS };
export type AnnulReason = (typeof ANNUL_REASONS)[number];

/** Reasons the operator gives; `objection_upheld` comes only from the outcome of an objection (domain 12.5). */
export const OPERATOR_ANNUL_REASONS = [
	'plagiarism',
	'technical_failure',
	'version_defect',
	'candidate_request'
] as const;

/** Whether an annulment for this reason counts as an attempt of the grade policy. */
export const countsAsAttempt = (reason: AnnulReason): boolean => !GRADE_POLICY.freeRetakeAnnulReasons.includes(reason);

export interface OwnAnnulment {
	reason: AnnulReason;
	annulledAt: Date;
	countsAsAttempt: boolean;
}

/** The annulment of the candidate's own attempt; `null` — the attempt is not annulled. */
export async function ownAttemptAnnulment(
	executor: Executor,
	subject: AccessSubject,
	attemptId: string
): Promise<OwnAnnulment | null> {
	const candidateId = ownCandidateId(subject, 'read');
	const [row] = await executor
		.select({ reason: testAttempts.annulReason, annulledAt: testAttempts.annulledAt })
		.from(testAttempts)
		.where(and(eq(testAttempts.id, attemptId), eq(testAttempts.candidateId, candidateId)));
	if (!row) throw new ApiError('not_found');
	if (row.reason === null || row.annulledAt === null) return null;
	return { reason: row.reason, annulledAt: row.annulledAt, countsAsAttempt: countsAsAttempt(row.reason) };
}

export interface AnnulOutcome {
	/** `false` — the attempt was already annulled: nothing changed. */
	annulled: boolean;
	/**
	 * What the annulment did to the category, as its owner names it (`categoryChange`); `null` — the caller brings the
	 * category to the decisions itself (the owner of objections).
	 */
	category: CategoryChange['action'] | null;
}

export interface AnnulInput {
	attemptId: string;
	reason: AnnulReason;
	/** The operator who annuls; `null` — the outcome of an objection records its own actor. */
	annulledBy: string | null;
	actor: AuditActor;
	requestId: string;
	ip: string | null;
	userAgent: string | null;
	now: Date;
}

type AttemptRow = typeof testAttempts.$inferSelect;

/** The sandbox runs of an attempt's submissions still waiting are cancelled: their result would land on nothing. */
async function cancelSubmissionRuns(tx: Transaction, attemptId: string): Promise<void> {
	const submissions = await tx
		.select({ id: testArtifacts.id })
		.from(testArtifacts)
		.where(and(eq(testArtifacts.attemptId, attemptId), inArray(testArtifacts.kind, ['code_submission', 'qa_cases'])));
	for (const submission of submissions) {
		await cancelWaitingJobs(tx, 'test.run', { artifact_id: submission.id });
	}
}

/**
 * Annuls an attempt in the caller's transaction; the attempt row is locked here. With `standing` the owner of categories
 * brings the category to the remaining decisions; the owner of objections passes `null` and does it itself.
 */
export async function annulAttemptIn(
	tx: Transaction,
	standing: GradeStanding | null,
	input: AnnulInput
): Promise<AnnulOutcome> {
	const [attempt] = await tx.select().from(testAttempts).where(eq(testAttempts.id, input.attemptId)).for('update');
	if (!attempt) throw new ApiError('not_found');
	if (attempt.status === 'annulled') return { annulled: false, category: standing ? 'keep' : null };
	if (attempt.status === 'in_progress') {
		if (input.reason !== 'technical_failure') {
			throw conflict('attempt_in_progress', 'Идущую попытку можно аннулировать только из-за технического сбоя');
		}
		// A running attempt is the candidate's; only one stuck on a failed sandbox is ended here (contracts 6.4).
		const [stuck] = await tx
			.select({ id: testItems.id })
			.from(testItems)
			.where(
				and(
					eq(testItems.attemptId, attempt.id),
					eq(testItems.status, 'awaiting_sandbox'),
					lt(testItems.answeredAt, new Date(input.now.getTime() - STUCK_AFTER_MS))
				)
			)
			.limit(1);
		if (!stuck) throw conflict('attempt_in_progress', 'Идущую попытку аннулировать нельзя');
		await cancelSubmissionRuns(tx, attempt.id);
	}
	return annulLocked(tx, standing, attempt, input);
}

/** The annulment itself, on the locked row of an attempt that is not annulled yet. */
async function annulLocked(
	tx: Transaction,
	standing: GradeStanding | null,
	attempt: AttemptRow,
	input: AnnulInput
): Promise<AnnulOutcome> {
	const previousStatus = attempt.status;
	await tx
		.update(testAttempts)
		.set({
			status: 'annulled',
			annulledBy: input.annulledBy,
			annulledAt: input.now,
			annulReason: input.reason,
			endedAt: attempt.endedAt ?? input.now
		})
		.where(eq(testAttempts.id, attempt.id));
	// The result of a block test goes with its attempt (domain 13.11); a block test has no grade decision.
	if (attempt.purpose === 'vacancy_block') await annulBlockResults(tx, [attempt.id]);
	const decisions = await tx
		.update(gradeDecisions)
		.set({ status: 'annulled' })
		.where(and(eq(gradeDecisions.attemptId, attempt.id), eq(gradeDecisions.status, 'valid')))
		.returning({ id: gradeDecisions.id });
	const category = !standing
		? null
		: decisions.length > 0
			? (
					await standing.applyGradeDecisions(tx, attempt.candidateId, attempt.specialization as SpecializationKey, {
						requestId: input.requestId,
						actor: input.actor
					})
				).action
			: 'keep';
	await recordAuditEvent(tx, {
		action: 'assessment.annulled',
		outcome: 'success',
		actor: input.actor,
		object: { type: 'test_attempt', id: attempt.id },
		subjectCandidateId: attempt.candidateId,
		requestId: input.requestId,
		ip: input.ip,
		userAgent: input.userAgent,
		occurredAt: input.now,
		details: { reason: input.reason, previous_status: previousStatus }
	});
	const [candidate] = await tx
		.select({ userId: candidates.userId })
		.from(candidates)
		.where(eq(candidates.id, attempt.candidateId));
	if (!candidate) throw new Error(`candidate ${attempt.candidateId} is missing`);
	await notify(tx, {
		userId: candidate.userId,
		type: 'assessment.annulled',
		objectId: attempt.id,
		payload: { attempt_id: attempt.id, reason: input.reason }
	});
	return { annulled: true, category };
}

/** The operator annuls an attempt within the reach of the staff (domain 19.3). */
export async function annulAttempt(
	db: Database,
	standing: GradeStanding,
	subject: AccessSubject,
	meta: RequestMeta,
	attemptId: string,
	reason: AnnulReason,
	now: Date
): Promise<{ annulled: boolean; category: CategoryChange['action'] }> {
	requirePermission(subject, 'assessment.review', null);
	const operatorId = sessionUserId(subject);
	if (!(OPERATOR_ANNUL_REASONS as readonly string[]).includes(reason)) {
		throw invalid([{ path: 'reason', code: 'invalid', message: 'Выберите причину аннулирования' }]);
	}
	const reach = await StaffReach.of(db, subject);
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({ demoSessionId: candidates.demoSessionId })
			.from(testAttempts)
			.innerJoin(candidates, eq(candidates.id, testAttempts.candidateId))
			.where(eq(testAttempts.id, attemptId));
		if (!row) throw new ApiError('not_found');
		reach.require(row.demoSessionId);
		const outcome = await annulAttemptIn(tx, standing, {
			attemptId,
			reason,
			annulledBy: operatorId,
			actor: auditActorOf(subject),
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			now
		});
		if (outcome.category === null) throw new Error('the owner of categories did not answer the annulment');
		return { annulled: outcome.annulled, category: outcome.category };
	});
}

/** A release whose code left the bank tree, and the attempts running on it that its start annulled. */
export interface StaleRelease {
	releaseId: string;
	/** What of its code the tree no longer has (`releaseDrift`). */
	drift: string[];
	annulled: string[];
}

/**
 * Annuls every attempt in progress on a release whose code the bank tree under `root` no longer has, each in its own
 * transaction, for `version_defect` (a free retake): by the system, with the candidate notified. An attempt that ended
 * meanwhile is left as it is. Runs at the start of the application, after the bank release.
 */
export async function annulStaleAttempts(
	db: Database,
	standing: GradeStanding,
	now: Date,
	root: string = BANK_ROOT
): Promise<StaleRelease[]> {
	const running = await db
		.selectDistinct({ releaseId: testAttempts.bankReleaseId })
		.from(testAttempts)
		.where(eq(testAttempts.status, 'in_progress'));
	const stale: StaleRelease[] = [];
	for (const { releaseId } of running) {
		const drift = await releaseDrift(await releaseById(db, releaseId), root);
		if (drift.length === 0) continue;
		const attempts = await db
			.select({ id: testAttempts.id })
			.from(testAttempts)
			.where(and(eq(testAttempts.bankReleaseId, releaseId), eq(testAttempts.status, 'in_progress')));
		const annulled: string[] = [];
		for (const { id } of attempts) {
			const done = await db.transaction(async (tx) => {
				const [attempt] = await tx.select().from(testAttempts).where(eq(testAttempts.id, id)).for('update');
				if (attempt?.status !== 'in_progress') return false;
				await cancelSubmissionRuns(tx, attempt.id);
				await annulLocked(tx, standing, attempt, {
					attemptId: attempt.id,
					reason: 'version_defect',
					annulledBy: null,
					actor: { kind: 'system' },
					requestId: `bank-release:${releaseId}`,
					ip: null,
					userAgent: null,
					now
				});
				return true;
			});
			if (done) annulled.push(id);
		}
		stale.push({ releaseId, drift, annulled });
	}
	return stale;
}
