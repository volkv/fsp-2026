// Worker loop over the job queue (docs/domain.md, section 17.1): captures due jobs of the enabled types by priority
// within per-type concurrency, keeps their leases alive, writes results conditionally, retries failures with the
// backoff of the queue, returns jobs of crashed workers, ticks the periodic schedule and stops gracefully.
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Database } from '$lib/server/db';
import type { JobOwner } from '$lib/server/db/schema';
import { JobFailure, type AnyJobHandler, type HandlerRegistry } from './handler';
import { createLogger, type JobLogger } from './log';
import {
	claimJob,
	completeJob,
	failJob,
	heartbeat,
	recoverExpiredLeases,
	releaseJob,
	returnsToQueue,
	type ClaimedJob,
	type JobError
} from './queue';
import { isJobType, jobSpec, type JobType } from './registry';
import { periodicJobsFor, schedulePeriodicJob, type ScheduleTick } from './scheduler';

export interface WorkerOptions {
	db: Database;
	handlers: HandlerRegistry;
	/** Types this worker runs; each must be registered and have a handler, otherwise the worker does not start. */
	types: readonly string[];
	/** The line of the queue this worker captures from (`claimJob`); absent — the stand's jobs, those without an owner. */
	owner?: JobOwner;
	/** Per-type overrides of the handler's concurrency. */
	concurrency?: Readonly<Record<string, number>>;
	workerId?: string;
	/** Pause of the capture loop when nothing is due. */
	pollIntervalMs?: number;
	/** Period of returning jobs with expired leases. */
	recoveryIntervalMs?: number;
	/** Period of the schedule tick. */
	scheduleIntervalMs?: number;
	/** Schedules with their own timetables; those of the enabled types run on every schedule tick. */
	ticks?: readonly ScheduleTick[];
	/** How long a stopping worker lets running jobs finish before giving their leases back. */
	shutdownGraceMs?: number;
	log?: JobLogger;
	/** Clock of the schedule. */
	now?: () => Date;
}

export interface TypeMetrics {
	concurrency: number;
	inFlight: number;
	claimed: number;
	succeeded: number;
	discardedStale: number;
	retried: number;
	failed: number;
	leaseLost: number;
	released: number;
}

export interface WorkerMetrics {
	workerId: string;
	status: 'running' | 'stopping' | 'stopped';
	startedAt: string;
	/** Last successful round trip to the database (capture or lease recovery). */
	lastDatabaseOkAt: string | null;
	recoveredLeases: number;
	scheduled: number;
	types: Record<string, TypeMetrics>;
}

export interface Worker {
	readonly id: string;
	/** Stops capturing, lets running jobs finish within the grace period, then gives the remaining leases back. */
	stop: () => Promise<void>;
	metrics: () => WorkerMetrics;
	/** Alive and talking to the database recently. */
	healthy: () => boolean;
}

const DEFAULTS = {
	pollIntervalMs: 1_000,
	recoveryIntervalMs: 15_000,
	scheduleIntervalMs: 30_000,
	shutdownGraceMs: 20_000
};

/** After the grace period and the lease release, how long to wait for aborted handlers to return. */
const ABORT_WAIT_MS = 5_000;

interface EnabledType {
	type: JobType;
	handler: AnyJobHandler;
	concurrency: number;
}

/** Checks the start configuration; every problem is reported at once. */
function resolveTypes(options: WorkerOptions): EnabledType[] {
	const problems: string[] = [];
	if (options.types.length === 0) problems.push('no job types enabled');
	const seen = new Set<string>();
	const enabled: EnabledType[] = [];
	for (const type of options.types) {
		if (seen.has(type)) {
			problems.push(`job type ${type} is listed twice`);
			continue;
		}
		seen.add(type);
		if (!isJobType(type)) {
			problems.push(`unknown job type ${type}`);
			continue;
		}
		const handler = options.handlers.get(type);
		if (!handler) {
			problems.push(`job type ${type} has no handler`);
			continue;
		}
		const override = options.concurrency?.[type];
		if (override !== undefined && (!Number.isInteger(override) || override < 1)) {
			problems.push(`concurrency of ${type} must be a positive integer`);
			continue;
		}
		enabled.push({ type, handler, concurrency: override ?? handler.concurrency });
	}
	for (const type of Object.keys(options.concurrency ?? {})) {
		if (!seen.has(type)) problems.push(`concurrency is set for ${type}, which is not enabled`);
	}
	if (problems.length > 0) throw new Error(`worker configuration is invalid: ${problems.join('; ')}`);
	return enabled;
}

function defaultWorkerId(): string {
	return `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
}

/** Sleeps until the timeout or an explicit wake-up; one sleeper at a time (the capture loop). */
function createWaker() {
	let wakeUp: (() => void) | undefined;
	return {
		sleep(ms: number): Promise<void> {
			return new Promise((resolve) => {
				const timer = setTimeout(done, ms);
				function done() {
					clearTimeout(timer);
					wakeUp = undefined;
					resolve();
				}
				wakeUp = done;
			});
		},
		wake() {
			wakeUp?.();
		}
	};
}

const delay = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

/** Runs `task` now and then every `ms` after the previous run finished; a failed run is logged and the loop goes on. */
function repeat(ms: number, task: () => Promise<void>, onError: (error: unknown) => void) {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let current: Promise<void> | undefined;
	const tick = () => {
		current = task()
			.catch(onError)
			.finally(() => {
				current = undefined;
				if (!stopped) timer = setTimeout(tick, ms);
			});
	};
	tick();
	return {
		async stop() {
			stopped = true;
			clearTimeout(timer);
			await current;
		}
	};
}

function toJobError(error: unknown): { error: JobError; retryAfterSeconds?: number } {
	if (error instanceof JobFailure) {
		return {
			error: { code: error.code, retryable: error.retryable, message: error.message },
			retryAfterSeconds: error.retryAfterSeconds
		};
	}
	// The message of an unexpected error may quote data; `last_error` keeps only its class, the log keeps the rest.
	const name = error instanceof Error ? error.name : 'NonErrorThrown';
	return { error: { code: 'unexpected_error', retryable: true, message: name } };
}

/**
 * The line of a failed attempt. A failure the handler understood and marked retryable, with attempts left, is a routine
 * retry — a busy parser, a source asking to come back later — and is a warning; an unexpected error, a permanent failure
 * and the last attempt are errors.
 */
export function logFailedAttempt(
	jobLog: JobLogger,
	job: Pick<ClaimedJob, 'attempt' | 'maxAttempts'>,
	thrown: unknown,
	error: JobError
): void {
	const fields = { code: error.code, retryable: error.retryable };
	if (thrown instanceof JobFailure && returnsToQueue(error, job.attempt, job.maxAttempts)) {
		jobLog.warn('job attempt failed, it will be retried', { ...fields, error_message: error.message });
		return;
	}
	jobLog.error('job attempt failed', fields, thrown);
}

interface RunningJob {
	job: ClaimedJob;
	controller: AbortController;
	done: Promise<void>;
}

export function startWorker(options: WorkerOptions): Worker {
	const enabled = resolveTypes(options);
	const settings = { ...DEFAULTS, ...definedOnly(options) };
	const { db } = options;
	const workerId = options.workerId ?? defaultWorkerId();
	const log = (options.log ?? createLogger()).child({ worker_id: workerId });
	const now = options.now ?? (() => new Date());
	const startedAt = new Date();
	const byType = new Map(enabled.map((entry) => [entry.type, entry]));
	const metrics = new Map<JobType, TypeMetrics>(
		enabled.map((entry) => [
			entry.type,
			{
				concurrency: entry.concurrency,
				inFlight: 0,
				claimed: 0,
				succeeded: 0,
				discardedStale: 0,
				retried: 0,
				failed: 0,
				leaseLost: 0,
				released: 0
			}
		])
	);
	const running = new Map<string, RunningJob>();
	const waker = createWaker();
	let status: WorkerMetrics['status'] = 'running';
	// A function, not a comparison in place: `stop()` changes the status while the loop awaits.
	const isRunning = () => status === 'running';
	let lastDatabaseOkAt: Date | null = null;
	let recoveredLeases = 0;
	let scheduled = 0;

	const metricsOf = (type: JobType): TypeMetrics => {
		const entry = metrics.get(type);
		if (!entry) throw new Error(`job type ${type} is not enabled in this worker`);
		return entry;
	};

	/** Extends the lease every third of its duration until the job ends; a lost lease aborts the handler. */
	function keepLease(job: ClaimedJob, controller: AbortController, jobLog: JobLogger): () => void {
		const periodMs = (jobSpec(job.type).leaseSeconds * 1000) / 3;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let ended = false;
		const beat = async () => {
			try {
				if (!(await heartbeat(db, job))) {
					jobLog.warn('lease lost, stopping the job');
					controller.abort('lease_lost');
					return;
				}
			} catch (error) {
				// The next beat retries; if the lease expires meanwhile, the write check refuses the result.
				jobLog.error('lease heartbeat failed', {}, error);
			}
			if (!ended) timer = setTimeout(() => void beat(), periodMs);
		};
		timer = setTimeout(() => void beat(), periodMs);
		return () => {
			ended = true;
			clearTimeout(timer);
		};
	}

	/** A handler that returned or threw after its abort: the lease is gone or was given back on shutdown. */
	function stopped(controller: AbortController, counters: TypeMetrics, jobLog: JobLogger) {
		const reason = String(controller.signal.reason);
		if (reason === 'lease_lost') counters.leaseLost += 1;
		jobLog.info('job stopped', { reason });
	}

	async function execute(job: ClaimedJob, controller: AbortController): Promise<void> {
		const entry = byType.get(job.type);
		if (!entry) throw new Error(`captured job of type ${job.type}, which is not enabled`);
		const counters = metricsOf(job.type);
		const requestId = `job:${job.id}`;
		const jobLog = log.child({
			job_id: job.id,
			job_type: job.type,
			attempt: job.attempt,
			max_attempts: job.maxAttempts,
			request_id: requestId
		});
		const startedMs = Date.now();
		jobLog.info('job started', { input_version: job.inputVersion });
		const endLease = keepLease(job, controller, jobLog);
		try {
			const result = await entry.handler.run({ job, db, signal: controller.signal, requestId, log: jobLog });
			if (controller.signal.aborted) {
				stopped(controller, counters, jobLog);
				return;
			}
			const outcome = await completeJob(db, job, result);
			const fields = { outcome, duration_ms: Date.now() - startedMs, ...result.describe?.() };
			if (outcome === 'succeeded') counters.succeeded += 1;
			else if (outcome === 'discarded_stale') counters.discardedStale += 1;
			else counters.leaseLost += 1;
			if (outcome === 'lease_lost') jobLog.warn('job finished after its lease was lost; result dropped', fields);
			else jobLog.info('job finished', fields);
		} catch (thrown) {
			if (controller.signal.aborted) {
				stopped(controller, counters, jobLog);
				return;
			}
			const { error, retryAfterSeconds } = toJobError(thrown);
			logFailedAttempt(jobLog, job, thrown, error);
			const outcome = await failJob(db, job, error, retryAfterSeconds);
			if (outcome === 'queued') counters.retried += 1;
			else if (outcome === 'failed') counters.failed += 1;
			else if (outcome === 'discarded_stale') counters.discardedStale += 1;
			else counters.leaseLost += 1;
			if (outcome === 'failed') jobLog.error('job failed for good', { outcome, code: error.code });
			else jobLog.info('job attempt recorded', { outcome, code: error.code });
		} finally {
			endLease();
		}
	}

	function launch(job: ClaimedJob) {
		const counters = metricsOf(job.type);
		counters.claimed += 1;
		counters.inFlight += 1;
		const controller = new AbortController();
		const done = execute(job, controller)
			.catch((error: unknown) => {
				// Reporting the outcome failed (database unreachable): the lease expires and recovery returns the job.
				log.error('job outcome was not recorded', { job_id: job.id, job_type: job.type }, error);
			})
			.finally(() => {
				counters.inFlight -= 1;
				running.delete(job.id);
				waker.wake();
			});
		running.set(job.id, { job, controller, done });
	}

	async function captureLoop(): Promise<void> {
		while (isRunning()) {
			const free = enabled.filter((entry) => metricsOf(entry.type).inFlight < entry.concurrency).map((e) => e.type);
			if (free.length === 0) {
				await waker.sleep(settings.pollIntervalMs);
				continue;
			}
			let job: ClaimedJob | null;
			try {
				job = await claimJob(db, workerId, free, options.owner ?? null);
				lastDatabaseOkAt = new Date();
			} catch (error) {
				log.error('job capture failed', {}, error);
				await waker.sleep(settings.pollIntervalMs);
				continue;
			}
			if (!job) {
				await waker.sleep(settings.pollIntervalMs);
				continue;
			}
			if (!isRunning()) {
				// Stopped while capturing: the job has not started, give it back at once.
				await releaseJob(db, job);
				break;
			}
			launch(job);
		}
	}

	const recovery = repeat(
		settings.recoveryIntervalMs,
		async () => {
			const count = await recoverExpiredLeases(db);
			lastDatabaseOkAt = new Date();
			if (count > 0) {
				recoveredLeases += count;
				log.warn('returned jobs with expired leases', { count });
				waker.wake();
			}
		},
		(error) => {
			log.error('lease recovery failed', {}, error);
		}
	);

	const periodic = periodicJobsFor(enabled.map((entry) => entry.type));
	const ticks = (options.ticks ?? []).filter((entry) => byType.has(entry.type));
	const schedule = repeat(
		settings.scheduleIntervalMs,
		async () => {
			const at = now();
			for (const entry of periodic) {
				const outcome = await schedulePeriodicJob(db, entry, at);
				if (outcome === 'enqueued') {
					scheduled += 1;
					log.info('periodic job enqueued', { job_type: entry.type });
					waker.wake();
				}
			}
			for (const entry of ticks) {
				const count = await entry.tick(db, at);
				if (count > 0) {
					scheduled += count;
					log.info('scheduled jobs enqueued', { job_type: entry.type, count });
					waker.wake();
				}
			}
		},
		(error) => {
			log.error('schedule tick failed', {}, error);
		}
	);

	const loop = captureLoop();
	log.info('worker started', {
		...(options.owner ? { owner: options.owner } : {}),
		types: enabled.map((entry) => `${entry.type}=${entry.concurrency}`).join(','),
		periodic: [...periodic, ...ticks].map((entry) => entry.type).join(',')
	});

	let stopping: Promise<void> | undefined;

	async function shutdown(): Promise<void> {
		status = 'stopping';
		log.info('worker stopping', { running: running.size });
		waker.wake();
		await Promise.all([loop, recovery.stop(), schedule.stop()]);
		const all = () => Promise.allSettled([...running.values()].map((entry) => entry.done));
		await Promise.race([all(), delay(settings.shutdownGraceMs)]);
		for (const entry of [...running.values()]) {
			const fields = { job_id: entry.job.id, job_type: entry.job.type };
			try {
				const outcome = await releaseJob(db, entry.job);
				if (outcome !== 'lease_lost') metricsOf(entry.job.type).released += 1;
				log.warn('job lease given back on shutdown', { ...fields, outcome });
			} catch (error) {
				// The lease expires on its own and recovery returns the job, charging the attempt.
				log.error('giving the lease back failed', fields, error);
			}
			entry.controller.abort('shutdown');
		}
		await Promise.race([all(), delay(ABORT_WAIT_MS)]);
		status = 'stopped';
		log.info('worker stopped');
	}

	return {
		id: workerId,
		stop() {
			stopping ??= shutdown();
			return stopping;
		},
		metrics() {
			return {
				workerId,
				status,
				startedAt: startedAt.toISOString(),
				lastDatabaseOkAt: lastDatabaseOkAt?.toISOString() ?? null,
				recoveredLeases,
				scheduled,
				types: Object.fromEntries([...metrics].map(([type, counters]) => [type, { ...counters }]))
			};
		},
		healthy() {
			if (status !== 'running' || !lastDatabaseOkAt) return false;
			const staleAfterMs = Math.max(3 * settings.recoveryIntervalMs, 5 * settings.pollIntervalMs);
			return Date.now() - lastDatabaseOkAt.getTime() < staleAfterMs;
		}
	};
}

/** Timing options the caller set, so that an explicit `undefined` does not override a default. */
function definedOnly(options: WorkerOptions): Partial<typeof DEFAULTS> {
	const result: Partial<typeof DEFAULTS> = {};
	for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
		const value = options[key];
		if (value !== undefined) result[key] = value;
	}
	return result;
}
