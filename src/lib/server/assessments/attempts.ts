// Attempts of platform assessments (docs/domain.md, section 10.2): who may start one, the limits of
// `assessment_policy`, the deadline, and the lazy transition `started → expired` once the deadline has passed. The
// answers are the candidate's data: an attempt starts and takes answers only with `pd_processing` in effect.
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { requireProcessingConsent } from '$lib/server/consent/processing';
import type { Database, Executor, Transaction } from '$lib/server/db';
import { assessmentAttempts, assessmentVersions, candidates } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { UNCOUNTED_REASONS } from './annul';
import { assessmentPolicy } from './policy';
import { publishedVersions } from './versions';

export type AttemptRow = typeof assessmentAttempts.$inferSelect;

/** The candidate acting on their own tests; anyone else — even an operator — is refused here (domain 10.4). */
export function ownCandidateId(subject: AccessSubject, mode: 'read' | 'write'): string {
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined) throw new ApiError(subject.userId === null ? 'unauthenticated' : 'forbidden');
	const access = can(subject, mode === 'read' ? 'candidate.self.read' : 'candidate.self.write', { candidateId });
	if (!access.allowed) throw new ApiError(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	return candidateId;
}

/** A refusal the candidate can act on: the message says why and, for a pause, until when. */
function refusal(code: 'attempt_active' | 'attempts_exhausted' | 'retake_interval', message: string): ApiError {
	return new ApiError('conflict', { message, details: [{ code, message }] });
}

/** `started → expired` for every attempt of the candidate whose deadline has passed. */
export async function expireOverdue(executor: Executor, candidateId: string, now: Date): Promise<void> {
	await executor
		.update(assessmentAttempts)
		.set({ status: 'expired' })
		.where(
			and(
				eq(assessmentAttempts.candidateId, candidateId),
				eq(assessmentAttempts.status, 'started'),
				lte(assessmentAttempts.deadlineAt, now)
			)
		);
}

/** Attempts of the candidate on every version of the assessment, oldest first. */
export async function attemptsOf(executor: Executor, candidateId: string, assessmentId: string): Promise<AttemptRow[]> {
	const versions = executor
		.select({ id: assessmentVersions.id })
		.from(assessmentVersions)
		.where(eq(assessmentVersions.assessmentId, assessmentId));
	return executor
		.select()
		.from(assessmentAttempts)
		.where(and(eq(assessmentAttempts.candidateId, candidateId), inArray(assessmentAttempts.versionId, versions)))
		.orderBy(asc(assessmentAttempts.startedAt));
}

export interface AttemptAllowance {
	used: number;
	max: number;
	/** The attempt in progress: started, or submitted and waiting for its score. */
	activeAttemptId: string | null;
	/** When the pause after the last attempt ends; `null` — no pause now. */
	nextAt: Date | null;
	/** Why a new attempt cannot start now; `null` — it can. */
	blocked: 'attempt_active' | 'attempts_exhausted' | 'retake_interval' | null;
}

export function allowanceOf(
	attempts: readonly AttemptRow[],
	policy: { max_attempts: number; retake_interval_days: number },
	now: Date
): AttemptAllowance {
	// Attempts annulled through no fault of the candidate do not count toward the limit (domain 10.2).
	const counted = attempts.filter(
		(attempt) =>
			attempt.status !== 'annulled' || attempt.annulReason === null || !UNCOUNTED_REASONS.includes(attempt.annulReason)
	);
	const active = attempts.find((attempt) => attempt.status === 'started' || attempt.status === 'submitted') ?? null;
	const last = counted.at(-1);
	const lastEnd = last ? (last.submittedAt ?? last.deadlineAt) : null;
	const pauseEnd = lastEnd ? new Date(lastEnd.getTime() + policy.retake_interval_days * 86_400_000) : null;
	const nextAt = pauseEnd && pauseEnd > now ? pauseEnd : null;
	let blocked: AttemptAllowance['blocked'] = null;
	if (active) blocked = 'attempt_active';
	else if (counted.length >= policy.max_attempts) blocked = 'attempts_exhausted';
	else if (nextAt) blocked = 'retake_interval';
	return { used: counted.length, max: policy.max_attempts, activeAttemptId: active?.id ?? null, nextAt, blocked };
}

async function lockCandidate(tx: Transaction, candidateId: string): Promise<void> {
	const [row] = await tx
		.select({ id: candidates.id })
		.from(candidates)
		.where(eq(candidates.id, candidateId))
		.for('update');
	if (!row) throw new ApiError('not_found');
}

const dateTimeRu = new Intl.DateTimeFormat('ru-RU', {
	dateStyle: 'long',
	timeStyle: 'short',
	timeZone: 'Europe/Moscow'
});

/**
 * Starts an attempt on the published version of the assessment. Attempts of one candidate start one at a time (the
 * candidate row is locked), so two clicks cannot open two attempts or pass the limit together.
 */
export async function startAttempt(
	database: Database,
	subject: AccessSubject,
	assessmentId: string,
	now: Date
): Promise<{ attemptId: string }> {
	const candidateId = ownCandidateId(subject, 'write');
	return database.transaction(async (tx) => {
		await lockCandidate(tx, candidateId);
		await requireProcessingConsent(tx, candidateId, now);
		const [version] = await publishedVersions(tx, assessmentId);
		if (!version) throw new ApiError('not_found', { message: 'Задание не найдено или снято с публикации' });
		await expireOverdue(tx, candidateId, now);
		const policy = await assessmentPolicy(tx, now);
		const allowance = allowanceOf(await attemptsOf(tx, candidateId, assessmentId), policy.params, now);
		switch (allowance.blocked) {
			case 'attempt_active':
				throw refusal('attempt_active', 'У тебя уже есть незавершённая попытка этого задания');
			case 'attempts_exhausted':
				throw refusal('attempts_exhausted', `Попытки закончились: использовано ${allowance.used} из ${allowance.max}`);
			case 'retake_interval':
				throw refusal(
					'retake_interval',
					`Следующая попытка откроется ${dateTimeRu.format(allowance.nextAt ?? now)} по Москве`
				);
			case null:
				break;
		}
		const [attempt] = await tx
			.insert(assessmentAttempts)
			.values({
				candidateId,
				versionId: version.id,
				startedAt: now,
				deadlineAt: new Date(now.getTime() + version.scorer.timeLimitMinutes * 60_000),
				status: 'started'
			})
			.returning({ id: assessmentAttempts.id });
		if (!attempt) throw new Error('attempt was not inserted');
		return { attemptId: attempt.id };
	});
}

/**
 * The candidate's own attempt, locked for a change, with `pd_processing` in effect. Another candidate's attempt is
 * `not_found`: its existence is not disclosed. An attempt past its deadline is refused; the caller expires overdue
 * attempts before its transaction, so the transition survives the refusal.
 */
export async function lockOwnStartedAttempt(
	tx: Transaction,
	candidateId: string,
	attemptId: string,
	now: Date
): Promise<AttemptRow> {
	const [attempt] = await tx
		.select()
		.from(assessmentAttempts)
		.where(and(eq(assessmentAttempts.id, attemptId), eq(assessmentAttempts.candidateId, candidateId)))
		.for('update');
	if (!attempt) throw new ApiError('not_found');
	if (attempt.status === 'expired' || (attempt.status === 'started' && attempt.deadlineAt <= now)) {
		throw new ApiError('conflict', {
			message: 'Время попытки истекло',
			details: [{ code: 'attempt_expired', message: 'Время попытки истекло' }]
		});
	}
	if (attempt.status !== 'started') {
		throw new ApiError('conflict', {
			message: 'Попытка уже завершена',
			details: [{ code: 'attempt_closed', message: 'Попытка уже завершена' }]
		});
	}
	await requireProcessingConsent(tx, candidateId, now);
	return attempt;
}
