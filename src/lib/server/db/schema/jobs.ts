// Background jobs with input versions, deduplication among waiting jobs, leases and conditional results (domain 17).
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { enumCheck, id, timestamps, ts } from './_columns';

const JOB_STATUSES = ['queued', 'running', 'succeeded', 'discarded_stale', 'failed', 'cancelled'] as const;

/**
 * Owners of a separate line of the queue: a job with an owner is captured only by the worker of that owner, a job
 * without one only by the workers of the stand. `demo_seed` — the jobs of the demo seed's chain, run by the seed's own
 * worker with the seed's handlers (demo/queue.ts).
 */
export const JOB_OWNERS = ['demo_seed'] as const;
export type JobOwner = (typeof JOB_OWNERS)[number];

export const jobs = pgTable(
	'jobs',
	{
		id: id(),
		type: text().notNull(),
		typeVersion: integer().notNull(),
		payload: jsonb().notNull(),
		inputVersion: text().notNull(),
		dedupKey: text(),
		status: text({ enum: JOB_STATUSES }).notNull(),
		priority: integer().notNull().default(0),
		runAfter: ts().notNull().defaultNow(),
		attempts: integer().notNull().default(0),
		maxAttempts: integer().notNull(),
		leaseOwner: text(),
		leaseExpiresAt: ts(),
		lastError: jsonb(),
		createdBy: jsonb().notNull(),
		owner: text({ enum: JOB_OWNERS }),
		finishedAt: ts(),
		...timestamps()
	},
	(t) => [
		enumCheck('jobs', 'status', t.status, JOB_STATUSES),
		enumCheck('jobs', 'owner', t.owner, JOB_OWNERS),
		check('jobs_type_version_positive', sql`${t.typeVersion} >= 1`),
		check('jobs_attempts', sql`${t.maxAttempts} >= 1 and ${t.attempts} >= 0 and ${t.attempts} <= ${t.maxAttempts}`),
		check(
			'jobs_lease',
			sql`(${t.status} = 'running') = (${t.leaseOwner} is not null) and (${t.leaseOwner} is null) = (${t.leaseExpiresAt} is null)`
		),
		check(
			'jobs_finished_at',
			sql`(${t.status} in ('succeeded', 'discarded_stale', 'failed', 'cancelled')) = (${t.finishedAt} is not null)`
		),
		check('jobs_created_by', sql`${t.createdBy}->>'kind' in ('user', 'system', 'webhook')`),
		// A key is unique among waiting jobs: later changes join the waiting job (domain 17.1).
		uniqueIndex('jobs_dedup_queued')
			.on(t.dedupKey)
			.where(sql`${t.status} = 'queued'`),
		// At most one running job per key: the capture rule, guaranteed by the database as well.
		uniqueIndex('jobs_dedup_running')
			.on(t.dedupKey)
			.where(sql`${t.status} = 'running'`),
		index('jobs_capture')
			.on(t.priority.desc(), t.runAfter)
			.where(sql`${t.status} = 'queued'`),
		index('jobs_expired_leases')
			.on(t.leaseExpiresAt)
			.where(sql`${t.status} = 'running'`)
	]
);
