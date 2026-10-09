// Job queue over the `jobs` table (docs/domain.md, section 17.1): enqueue in the transaction of the change,
// deduplication among waiting jobs, capture with a lease, conditional result write, retries and lease recovery.
import { and, eq, inArray, isNull, lte, not, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Executor, Transaction } from '$lib/server/db';
import { isUniqueViolation } from '$lib/server/db/errors';
import { jobs, type JobOwner } from '$lib/server/db/schema';
import { insertJob, type EnqueueOptions, type EnqueueResult } from './insert';
import { JOB_TYPES, isJobType, jobSpec, type JobPayload, type JobType } from './registry';

export type { JobCreator } from './insert';

/**
 * Enqueues a job in the caller's transaction (`jobs/insert.ts`): `INSERT … ON CONFLICT (dedup_key) WHERE status =
 * 'queued' DO UPDATE`. A change without its job, or a job without its change, cannot be committed.
 */
export function enqueueJob<T extends JobType>(
	tx: Transaction,
	type: T,
	payload: JobPayload<T>,
	options: EnqueueOptions
): Promise<EnqueueResult> {
	return insertJob((statement) => tx.execute(statement), type, payload, options);
}

export interface ClaimedJob<T extends JobType = JobType> {
	id: string;
	type: T;
	payload: JobPayload<T>;
	inputVersion: string;
	attempt: number;
	maxAttempts: number;
	leaseOwner: string;
}

const registeredVersions = () =>
	or(
		...Object.entries(JOB_TYPES).map(([type, spec]) => and(eq(jobs.type, type), eq(jobs.typeVersion, spec.typeVersion)))
	);

/** The line of the queue a worker of `owner` captures from: its own jobs, or, without an owner, the stand's jobs only. */
export function ownedBy(owner: JobOwner | null): SQL {
	return owner === null ? isNull(jobs.owner) : eq(jobs.owner, owner);
}

/**
 * Captures the next due job of the worker's line (`ownedBy`): `FOR UPDATE SKIP LOCKED` among queued jobs whose key has
 * no running job, then sets the lease. At most one job per key runs at a time; the database enforces it with a unique
 * index as well.
 */
export async function claimJob(
	executor: Executor,
	workerId: string,
	types?: readonly JobType[],
	owner: JobOwner | null = null
): Promise<ClaimedJob | null> {
	return executor.transaction(async (tx) => {
		const running = sql`exists (select 1 from ${jobs} r where r.status = 'running' and r.dedup_key = ${jobs.dedupKey})`;
		const [candidate] = await tx
			.select({ id: jobs.id, type: jobs.type })
			.from(jobs)
			.where(
				and(
					eq(jobs.status, 'queued'),
					ownedBy(owner),
					lte(jobs.runAfter, sql`now()`),
					registeredVersions(),
					types ? inArray(jobs.type, [...types]) : undefined,
					sql`(${jobs.dedupKey} is null or not ${running})`
				)
			)
			.orderBy(sql`${jobs.priority} desc`, jobs.runAfter, jobs.id)
			.limit(1)
			.for('update', { skipLocked: true });
		if (!candidate) return null;
		if (!isJobType(candidate.type)) throw new Error(`captured unregistered job type ${candidate.type}`);
		const spec = jobSpec(candidate.type);
		const [row] = await tx
			.update(jobs)
			.set({
				status: 'running',
				leaseOwner: workerId,
				leaseExpiresAt: sql`now() + make_interval(secs => ${spec.leaseSeconds})`,
				attempts: sql`${jobs.attempts} + 1`
			})
			.where(eq(jobs.id, candidate.id))
			.returning();
		if (!row) throw new Error(`job ${candidate.id} disappeared while locked`);
		return {
			id: row.id,
			type: candidate.type,
			payload: spec.payload.parse(row.payload) as JobPayload<JobType>,
			inputVersion: row.inputVersion,
			attempt: row.attempts,
			maxAttempts: row.maxAttempts,
			leaseOwner: workerId
		};
	});
}

/** Locks the job row if the lease is still held by this capture and has not expired. */
async function lockOwnedLease(tx: Transaction, job: ClaimedJob): Promise<boolean> {
	const [row] = await tx
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(
				eq(jobs.id, job.id),
				eq(jobs.status, 'running'),
				eq(jobs.leaseOwner, job.leaseOwner),
				sql`${jobs.leaseExpiresAt} > now()`
			)
		)
		.for('update');
	return row !== undefined;
}

/** Extends the lease of a running job; `false` — the lease was lost and the job must stop. */
export async function heartbeat(executor: Executor, job: ClaimedJob): Promise<boolean> {
	const spec = jobSpec(job.type);
	const updated = await executor
		.update(jobs)
		.set({ leaseExpiresAt: sql`now() + make_interval(secs => ${spec.leaseSeconds})` })
		.where(
			and(
				eq(jobs.id, job.id),
				eq(jobs.status, 'running'),
				eq(jobs.leaseOwner, job.leaseOwner),
				sql`${jobs.leaseExpiresAt} > now()`
			)
		)
		.returning({ id: jobs.id });
	return updated.length === 1;
}

export type CompletionOutcome = 'succeeded' | 'discarded_stale' | 'lease_lost';

/**
 * Conditional result write in one transaction: the lease is still ours, and `isCurrent` confirms that the input
 * the job read is still the current one and its grounds still hold (for example `profile_revision` did not move,
 * the document is still current, the consent is still effective). Otherwise the result is dropped: the job
 * becomes `discarded_stale`, which is not an error.
 */
export async function completeJob(
	executor: Executor,
	job: ClaimedJob,
	result: { isCurrent: (tx: Transaction) => Promise<boolean>; write: (tx: Transaction) => Promise<void> }
): Promise<CompletionOutcome> {
	return executor.transaction(async (tx) => {
		if (!(await lockOwnedLease(tx, job))) return 'lease_lost';
		const current = await result.isCurrent(tx);
		if (current) await result.write(tx);
		const status = current ? 'succeeded' : 'discarded_stale';
		await tx
			.update(jobs)
			.set({ status, leaseOwner: null, leaseExpiresAt: null, finishedAt: sql`now()` })
			.where(eq(jobs.id, job.id));
		return status;
	});
}

export interface JobError {
	code: string;
	retryable: boolean;
	/** Without personal data. */
	message: string;
}

const MAX_BACKOFF_SECONDS = 600;

function backoffSeconds(attempt: number): number {
	return Math.min(MAX_BACKOFF_SECONDS, 5 * 2 ** (attempt - 1));
}

/**
 * A job leaving `running` for the queue is superseded when another job with the same key is already waiting: that one
 * will process the latest input, so this one is finished as `discarded_stale` (two waiting jobs of one key cannot
 * exist). Returns whether it was.
 */
async function finishIfSuperseded(
	tx: Transaction,
	id: string,
	dedupKey: string | null,
	/** Stored as `last_error`; `undefined` keeps the previous one. */
	lastError: Record<string, unknown> | undefined
): Promise<boolean> {
	if (dedupKey === null) return false;
	const [waiting] = await tx
		.select({ id: jobs.id })
		.from(jobs)
		.where(and(eq(jobs.dedupKey, dedupKey), eq(jobs.status, 'queued')));
	if (!waiting) return false;
	await tx
		.update(jobs)
		.set({ status: 'discarded_stale', leaseOwner: null, leaseExpiresAt: null, lastError, finishedAt: sql`now()` })
		.where(eq(jobs.id, id));
	return true;
}

/**
 * Puts a job leaving `running` back to the queue, or finishes it as `discarded_stale` when another job of its key is
 * waiting (`finishIfSuperseded`). A job of the key enqueued at the same moment is not seen by that check until it
 * commits, but the unique index of waiting jobs waits for it and refuses the second waiting one: the update is undone to
 * its savepoint and the job is superseded after all. The waiting one may be captured in between; then the update goes on.
 */
async function backToQueue(
	tx: Transaction,
	id: string,
	dedupKey: string | null,
	/** The columns of the queued job besides its status and lease. */
	queued: PgUpdateSetSource<typeof jobs>,
	/** Stored as `last_error` of a superseded job; `undefined` keeps the previous one. */
	lastError: Record<string, unknown> | undefined
): Promise<'queued' | 'discarded_stale'> {
	for (let attempt = 1; ; attempt++) {
		if (await finishIfSuperseded(tx, id, dedupKey, lastError)) return 'discarded_stale';
		try {
			await tx.transaction(async (savepoint) => {
				await savepoint
					.update(jobs)
					.set({ status: 'queued', leaseOwner: null, leaseExpiresAt: null, ...queued })
					.where(eq(jobs.id, id));
			});
			return 'queued';
		} catch (error) {
			if (!isUniqueViolation(error, 'jobs_dedup_queued') || attempt >= 3) throw error;
		}
	}
}

/** Whether a failed attempt goes back to the queue: the error is retryable and the attempts are not exhausted. */
export function returnsToQueue(error: JobError, attempt: number, maxAttempts: number): boolean {
	return error.retryable && attempt < maxAttempts;
}

/**
 * Returns the job to the queue after `job` with the given error, or finishes it as `failed` when the error is
 * permanent or attempts are exhausted. When another job with the same key is already waiting, it will process
 * the latest input, so this one is finished as `discarded_stale`.
 */
async function releaseWithError(
	tx: Transaction,
	id: string,
	attempt: number,
	maxAttempts: number,
	dedupKey: string | null,
	error: JobError,
	delaySeconds?: number
): Promise<'queued' | 'failed' | 'discarded_stale'> {
	const lastError = { code: error.code, retryable: error.retryable, message: error.message };
	if (!returnsToQueue(error, attempt, maxAttempts)) {
		await tx
			.update(jobs)
			.set({ status: 'failed', leaseOwner: null, leaseExpiresAt: null, lastError, finishedAt: sql`now()` })
			.where(eq(jobs.id, id));
		return 'failed';
	}
	return backToQueue(
		tx,
		id,
		dedupKey,
		{ lastError, runAfter: sql`now() + make_interval(secs => ${delaySeconds ?? backoffSeconds(attempt)})` },
		lastError
	);
}

/** Reports a failed attempt; `retryAfterSeconds` honours `Retry-After` of a source. */
export async function failJob(
	executor: Executor,
	job: ClaimedJob,
	error: JobError,
	retryAfterSeconds?: number
): Promise<'queued' | 'failed' | 'discarded_stale' | 'lease_lost'> {
	return executor.transaction(async (tx) => {
		if (!(await lockOwnedLease(tx, job))) return 'lease_lost';
		const [row] = await tx.select({ dedupKey: jobs.dedupKey }).from(jobs).where(eq(jobs.id, job.id));
		return releaseWithError(tx, job.id, job.attempt, job.maxAttempts, row?.dedupKey ?? null, error, retryAfterSeconds);
	});
}

/**
 * Gives the lease back without charging the attempt: the worker is stopping and the job did not finish. The job is
 * due immediately; when another job with the same key is already waiting, that one will process the latest input and
 * this one is finished as `discarded_stale`.
 */
export async function releaseJob(
	executor: Executor,
	job: ClaimedJob
): Promise<'queued' | 'discarded_stale' | 'lease_lost'> {
	return executor.transaction(async (tx) => {
		if (!(await lockOwnedLease(tx, job))) return 'lease_lost';
		const [row] = await tx.select({ dedupKey: jobs.dedupKey }).from(jobs).where(eq(jobs.id, job.id));
		return backToQueue(
			tx,
			job.id,
			row?.dedupKey ?? null,
			{ attempts: sql`${jobs.attempts} - 1`, runAfter: sql`now()` },
			undefined
		);
	});
}

/** Returns jobs of crashed workers (expired leases) to the queue; returns how many were handled. */
export async function recoverExpiredLeases(executor: Executor): Promise<number> {
	return executor.transaction(async (tx) => {
		const expired = await tx
			.select({ id: jobs.id, attempts: jobs.attempts, maxAttempts: jobs.maxAttempts, dedupKey: jobs.dedupKey })
			.from(jobs)
			.where(and(eq(jobs.status, 'running'), sql`${jobs.leaseExpiresAt} <= now()`))
			.for('update', { skipLocked: true });
		for (const row of expired) {
			await releaseWithError(tx, row.id, row.attempts, row.maxAttempts, row.dedupKey, {
				code: 'lease_expired',
				retryable: true,
				message: 'worker lease expired before the job finished'
			});
		}
		return expired.length;
	});
}

/** Cancels waiting jobs of a type and key when their grounds are withdrawn; a running one is stopped by its write check. */
export async function cancelWaitingJobs<T extends JobType>(
	tx: Transaction,
	type: T,
	payload: JobPayload<T>
): Promise<number> {
	const dedupKey = jobSpec(type).dedupKey(payload);
	const cancelled = await tx
		.update(jobs)
		.set({ status: 'cancelled', finishedAt: sql`now()` })
		.where(and(eq(jobs.type, type), eq(jobs.dedupKey, dedupKey), eq(jobs.status, 'queued')))
		.returning({ id: jobs.id });
	return cancelled.length;
}

/**
 * Stops the queue for the rest of the caller's transaction: `jobs` is locked `EXCLUSIVE`, so no job is enqueued,
 * captured, extended or finished until the transaction ends (reads go on). The waiting jobs of types other than
 * `except` are cancelled, and so are the running ones whose lease has expired (their worker is gone). Returns the jobs
 * still running under a lease: the caller commits and waits for them, since their own transactions may hold the rows it
 * is about to take.
 */
export async function haltJobs(
	tx: Transaction,
	except: readonly JobType[]
): Promise<{ cancelled: number; running: { id: string; type: string }[] }> {
	await tx.execute(sql`lock table ${jobs} in exclusive mode`);
	const others = not(inArray(jobs.type, [...except]));
	const cancelled = await tx
		.update(jobs)
		.set({ status: 'cancelled', leaseOwner: null, leaseExpiresAt: null, finishedAt: sql`now()` })
		.where(
			and(others, or(eq(jobs.status, 'queued'), and(eq(jobs.status, 'running'), sql`${jobs.leaseExpiresAt} <= now()`)))
		)
		.returning({ id: jobs.id });
	const running = await tx
		.select({ id: jobs.id, type: jobs.type })
		.from(jobs)
		.where(and(others, eq(jobs.status, 'running')))
		.orderBy(jobs.id);
	return { cancelled: cancelled.length, running };
}
