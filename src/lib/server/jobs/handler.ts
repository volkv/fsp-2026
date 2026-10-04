// Handler interface of background jobs: a module that owns a job type provides one handler per type and registers
// it in `handlers.ts`. The worker captures a job, calls `run`, and writes the returned result conditionally
// (docs/domain.md, section 17.1).
import type { Database, Transaction } from '$lib/server/db';
import type { JobLogger, LogFields } from './log';
import { isJobType, type JobType } from './registry';
import type { ClaimedJob } from './queue';

export interface JobContext<T extends JobType> {
	job: ClaimedJob<T>;
	db: Database;
	/**
	 * Aborted when the job must stop: its lease was lost or the worker is shutting down and the grace period is over.
	 * A long handler passes it to HTTP calls and checks it between steps.
	 */
	signal: AbortSignal;
	/** Identifier of the job run for the journal (`audit_events.request_id`) and the logs: `job:<id>`. */
	requestId: string;
	log: JobLogger;
}

/**
 * Result of a run, written in one transaction that also checks the lease. `isCurrent` confirms that the input the
 * run read is still current and its grounds still hold; otherwise the result is dropped as `discarded_stale`.
 */
export interface JobResult {
	isCurrent: (tx: Transaction) => Promise<boolean>;
	write: (tx: Transaction) => Promise<void>;
	/** Counters of the written result for the completion log line; identifiers and codes only. */
	describe?: () => LogFields;
}

export interface JobHandler<T extends JobType> {
	type: T;
	/** Jobs of this type one worker runs at once, unless the worker is started with another value. */
	concurrency: number;
	// Method syntax on purpose: its parameter is checked bivariantly, so a handler of one type is a handler of
	// `JobType` for the registry, which pairs it with jobs of its own type only.
	run(context: JobContext<T>): Promise<JobResult>;
}

/** A handler of any type, as the registry and the worker hold it. */
export type AnyJobHandler = JobHandler<JobType>;

export const defineHandler = <T extends JobType>(handler: JobHandler<T>): JobHandler<T> => handler;

/**
 * A failure the handler understands: `retryable` failures go back to the queue with backoff until the attempts of
 * the type are exhausted, the others finish the job as `failed`. `message` is stored in `jobs.last_error` and must not
 * contain personal data. `retryAfterSeconds` honours `Retry-After` of a source instead of the backoff.
 */
export class JobFailure extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly retryAfterSeconds: number | undefined;

	constructor(code: string, message: string, options: { retryable: boolean; retryAfterSeconds?: number }) {
		super(message);
		this.name = 'JobFailure';
		this.code = code;
		this.retryable = options.retryable;
		this.retryAfterSeconds = options.retryAfterSeconds;
	}
}

export type HandlerRegistry = ReadonlyMap<JobType, AnyJobHandler>;

/** Builds the registry of handlers; a duplicate type, an unknown type or a bad concurrency is a programming error. */
export function handlerRegistry(handlers: readonly AnyJobHandler[]): HandlerRegistry {
	const registry = new Map<JobType, AnyJobHandler>();
	for (const handler of handlers) {
		if (!isJobType(handler.type)) throw new Error(`handler for unknown job type ${String(handler.type)}`);
		if (registry.has(handler.type)) throw new Error(`job type ${handler.type} has two handlers`);
		if (!Number.isInteger(handler.concurrency) || handler.concurrency < 1) {
			throw new Error(`handler of ${handler.type} must have a positive integer concurrency`);
		}
		registry.set(handler.type, handler);
	}
	return registry;
}
