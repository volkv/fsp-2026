import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';
import { handlerRegistry, JobFailure, type AnyJobHandler, type JobResult } from '$lib/server/jobs/handler';
import { JOB_HANDLERS } from '$lib/server/jobs/handlers';
import { createLogger, type LogLevel } from '$lib/server/jobs/log';
import { withJobOwner } from '$lib/server/jobs/insert';
import { claimJob, enqueueJob } from '$lib/server/jobs/queue';
import type { JobPayload, JobType } from '$lib/server/jobs/registry';
import { LOCK_NAMESPACE, PERIODIC_JOBS, schedulePeriodicJob } from '$lib/server/jobs/scheduler';
import { startWorker, type Worker, type WorkerOptions } from '$lib/server/jobs/worker';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

let database: TestDatabase;
const started: Worker[] = [];

beforeAll(async () => {
	database = await createTestDatabase();
});

afterEach(async () => {
	await Promise.all(started.splice(0).map((worker) => worker.stop()));
	// Every test starts from an empty queue.
	await database.db.delete(jobs);
});

afterAll(async () => {
	await database.drop();
});

const system = { kind: 'system' as const };
const logLines: { level: LogLevel; line: string }[] = [];
const quietLog = createLogger({}, (level, line) => {
	logLines.push({ level, line });
});

/** Fast timings; everything else from the caller. */
function launch(options: Omit<WorkerOptions, 'db' | 'log'>): Worker {
	const worker = startWorker({
		db: database.db,
		log: quietLog,
		pollIntervalMs: 20,
		recoveryIntervalMs: 50,
		scheduleIntervalMs: 50,
		shutdownGraceMs: 2_000,
		...options
	});
	started.push(worker);
	return worker;
}

async function enqueue<T extends JobType>(db: Database, type: T, payload: JobPayload<T>): Promise<string> {
	const { jobId } = await db.transaction((tx) =>
		enqueueJob(tx, type, payload, { inputVersion: '1', createdBy: system })
	);
	return jobId;
}

async function jobRow(id: string) {
	const [row] = await database.db
		.select({
			status: jobs.status,
			attempts: jobs.attempts,
			leaseOwner: jobs.leaseOwner,
			lastError: jobs.lastError,
			dueInSeconds: sql<number>`extract(epoch from ${jobs.runAfter} - now())::float8`
		})
		.from(jobs)
		.where(eq(jobs.id, id));
	if (!row) throw new Error(`job ${id} not found`);
	return row;
}

async function waitFor(what: string, condition: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const done: JobResult = { isCurrent: () => Promise.resolve(true), write: () => Promise.resolve() };

/** A handler that records every run and succeeds after `delayMs`. */
function recordingHandler(type: JobType, runs: string[], delayMs = 0, concurrency = 1): AnyJobHandler {
	return {
		type,
		concurrency,
		run: async ({ job }) => {
			runs.push(job.id);
			if (delayMs > 0) await sleep(delayMs);
			return done;
		}
	};
}

describe('worker', () => {
	it('captures due jobs by priority and writes their results', async () => {
		const order: string[] = [];
		const written: string[] = [];
		const handler = (type: JobType): AnyJobHandler => ({
			type,
			concurrency: 1,
			run: ({ job }) => {
				order.push(job.type);
				return Promise.resolve({
					isCurrent: () => Promise.resolve(true),
					write: () => {
						written.push(job.id);
						return Promise.resolve();
					}
				});
			}
		});
		const { db } = database;
		// Lower priority first in the queue; the worker takes the higher one first.
		const low = await enqueue(db, 'profile.embed', { candidate_id: randomUUID() });
		const high = await enqueue(db, 'evidence.compute', { candidate_id: randomUUID() });
		const worker = launch({
			handlers: handlerRegistry([handler('profile.embed'), handler('evidence.compute')]),
			types: ['profile.embed', 'evidence.compute']
		});
		await waitFor(
			'both jobs',
			async () => (await jobRow(low)).status === 'succeeded' && (await jobRow(high)).status === 'succeeded'
		);
		expect(order[0]).toBe('evidence.compute');
		expect(written.sort()).toEqual([low, high].sort());
		expect(await jobRow(high)).toMatchObject({ attempts: 1, leaseOwner: null });
		expect(worker.metrics().types['profile.embed']).toMatchObject({ claimed: 1, succeeded: 1, inFlight: 0 });
		expect(worker.healthy()).toBe(true);
	});

	it('retries a failing job with growing backoff and fails it after the last attempt', async () => {
		const { db } = database;
		const id = await enqueue(db, 'evidence.compute', { candidate_id: randomUUID() });
		const worker = launch({
			handlers: handlerRegistry([
				{
					type: 'evidence.compute',
					concurrency: 1,
					run: () => Promise.reject(new JobFailure('model_unavailable', 'model timed out', { retryable: true }))
				}
			]),
			types: ['evidence.compute']
		});
		// Attempt 1 → back in the queue for 5 s, attempt 2 → 10 s: the worker does not touch it before that.
		for (const [attempt, backoff] of [
			[1, 5],
			[2, 10]
		] as const) {
			await waitFor(`attempt ${attempt}`, async () => {
				const row = await jobRow(id);
				return row.status === 'queued' && row.attempts === attempt;
			});
			await sleep(200);
			const row = await jobRow(id);
			expect(row).toMatchObject({ status: 'queued', attempts: attempt, leaseOwner: null });
			expect(row.lastError).toEqual({ code: 'model_unavailable', retryable: true, message: 'model timed out' });
			expect(row.dueInSeconds).toBeGreaterThan(backoff - 1);
			expect(row.dueInSeconds).toBeLessThanOrEqual(backoff);
			// Time passes.
			await db
				.update(jobs)
				.set({ runAfter: sql`now()` })
				.where(eq(jobs.id, id));
		}
		await waitFor('failed', async () => (await jobRow(id)).status === 'failed');
		expect(await jobRow(id)).toMatchObject({ attempts: 3, leaseOwner: null });
		expect(worker.metrics().types['evidence.compute']).toMatchObject({ claimed: 3, retried: 2, failed: 1 });
	});

	it('fails at once on a permanent failure and keeps only the class of an unexpected error', async () => {
		const { db } = database;
		const permanent = await enqueue(db, 'resume.parse', { resume_document_id: randomUUID() });
		const unexpected = await enqueue(db, 'profile.embed', { candidate_id: randomUUID() });
		launch({
			handlers: handlerRegistry([
				{
					type: 'resume.parse',
					concurrency: 1,
					run: () => Promise.reject(new JobFailure('unsupported_format', 'file is not a resume', { retryable: false }))
				},
				{
					type: 'profile.embed',
					concurrency: 1,
					run: () => Promise.reject(new TypeError('cannot read name of ivan@example.org'))
				}
			]),
			types: ['resume.parse', 'profile.embed']
		});
		await waitFor('permanent failure', async () => (await jobRow(permanent)).status === 'failed');
		expect(await jobRow(permanent)).toMatchObject({ attempts: 1 });
		await waitFor('unexpected failure', async () => (await jobRow(unexpected)).attempts === 1);
		await waitFor('unexpected failure recorded', async () => (await jobRow(unexpected)).status === 'queued');
		expect((await jobRow(unexpected)).lastError).toEqual({
			code: 'unexpected_error',
			retryable: true,
			message: 'TypeError'
		});
	});

	it('returns a job whose lease expired in a crashed worker and runs it', async () => {
		const { db } = database;
		const id = await enqueue(db, 'profile.embed', { candidate_id: randomUUID() });
		const crashed = await claimJob(db, 'crashed-worker', ['profile.embed']);
		expect(crashed?.id).toBe(id);
		await db
			.update(jobs)
			.set({ leaseExpiresAt: sql`now() - interval '1 second'` })
			.where(eq(jobs.id, id));
		const runs: string[] = [];
		const worker = launch({
			handlers: handlerRegistry([recordingHandler('profile.embed', runs)]),
			types: ['profile.embed']
		});
		// Recovery puts it back with the retry backoff; time passes.
		await waitFor('recovery', async () => (await jobRow(id)).status === 'queued');
		await db
			.update(jobs)
			.set({ runAfter: sql`now()` })
			.where(eq(jobs.id, id));
		await waitFor('rerun', async () => (await jobRow(id)).status === 'succeeded');
		expect(runs).toEqual([id]);
		expect(await jobRow(id)).toMatchObject({ attempts: 2 });
		expect(worker.metrics().recoveredLeases).toBe(1);
	});

	it('gives the lease back on shutdown without charging the attempt, and another worker finishes the job', async () => {
		const { db } = database;
		const id = await enqueue(db, 'resume.parse', { resume_document_id: randomUUID() });
		let aborted = false;
		const stopping = launch({
			handlers: handlerRegistry([
				{
					type: 'resume.parse',
					concurrency: 1,
					// Never finishes on its own.
					run: ({ signal }) =>
						new Promise<JobResult>((_, reject) => {
							signal.addEventListener('abort', () => {
								aborted = true;
								reject(new Error('aborted'));
							});
						})
				}
			]),
			types: ['resume.parse'],
			shutdownGraceMs: 200
		});
		await waitFor('running', async () => (await jobRow(id)).status === 'running');
		await stopping.stop();
		expect(aborted).toBe(true);
		expect(await jobRow(id)).toMatchObject({ status: 'queued', attempts: 0, leaseOwner: null });
		expect(stopping.metrics()).toMatchObject({ status: 'stopped', types: { 'resume.parse': { released: 1 } } });
		expect(stopping.healthy()).toBe(false);

		const runs: string[] = [];
		launch({ handlers: handlerRegistry([recordingHandler('resume.parse', runs)]), types: ['resume.parse'] });
		await waitFor('finished by the next worker', async () => (await jobRow(id)).status === 'succeeded');
		expect(runs).toEqual([id]);
		expect(await jobRow(id)).toMatchObject({ attempts: 1 });
	});

	it('lets a running job finish within the shutdown grace period', async () => {
		const { db } = database;
		const id = await enqueue(db, 'resume.parse', { resume_document_id: randomUUID() });
		const runs: string[] = [];
		const worker = launch({
			handlers: handlerRegistry([recordingHandler('resume.parse', runs, 300)]),
			types: ['resume.parse']
		});
		await waitFor('running', () => runs.length === 1);
		await worker.stop();
		expect(await jobRow(id)).toMatchObject({ status: 'succeeded', attempts: 1 });
		expect(worker.metrics().types['resume.parse']).toMatchObject({ succeeded: 1, released: 0 });
	});

	it('never runs one job in two workers', async () => {
		const { db } = database;
		const ids = await Promise.all(
			Array.from({ length: 60 }, () => enqueue(db, 'profile.embed', { candidate_id: randomUUID() }))
		);
		const runs: string[] = [];
		const handlers = handlerRegistry([recordingHandler('profile.embed', runs, 5, 6)]);
		const first = launch({ handlers, types: ['profile.embed'], workerId: 'worker-1', pollIntervalMs: 1 });
		const second = launch({ handlers, types: ['profile.embed'], workerId: 'worker-2', pollIntervalMs: 1 });
		await waitFor('all jobs', async () => {
			const [row] = await db
				.select({ count: sql<number>`count(*)::int` })
				.from(jobs)
				.where(eq(jobs.status, 'succeeded'));
			return row?.count === ids.length;
		});
		expect(runs).toHaveLength(ids.length);
		expect(new Set(runs)).toEqual(new Set(ids));
		const claimed = [first, second].map((worker) => worker.metrics().types['profile.embed']?.claimed ?? 0);
		expect(claimed.reduce((sum, count) => sum + count, 0)).toBe(ids.length);
	});

	it('refuses to start with a type that is unknown or has no handler', () => {
		const attempt =
			(types: string[], concurrency?: Record<string, number>, handlers = JOB_HANDLERS) =>
			() =>
				startWorker({ db: database.db, handlers, types, concurrency, log: quietLog });
		expect(attempt(['resume.parce'])).toThrow(/unknown job type resume\.parce/);
		// Every registered type has its handler in the application; a registry without one stands for a deployment
		// whose `--types` runs ahead of its code.
		const withoutReconcile = handlerRegistry([recordingHandler('retention.sweep', [])]);
		expect(attempt(['retention.sweep', 'derivations.reconcile'], undefined, withoutReconcile)).toThrow(
			/derivations\.reconcile has no handler/
		);
		expect(attempt([])).toThrow(/no job types enabled/);
		expect(attempt(['retention.sweep', 'retention.sweep'])).toThrow(/listed twice/);
		expect(attempt(['retention.sweep'], { 'resume.parse': 2 })).toThrow(/not enabled/);
	});
});

describe('owned line of the queue', () => {
	const ownerOf = async (id: string) =>
		(await database.db.select({ owner: jobs.owner }).from(jobs).where(eq(jobs.id, id)))[0]?.owner;

	it("keeps the owner's jobs, their follow-ups included, away from a worker of the stand", async () => {
		const { db } = database;
		const standRuns: string[] = [];
		const seedRuns: string[] = [];
		const followUps: string[] = [];
		const standJob = await enqueue(db, 'evidence.compute', { candidate_id: randomUUID() });
		const ownedJob = await withJobOwner('demo_seed', ['evidence.compute', 'match.refresh'], async () => {
			const id = await enqueue(db, 'evidence.compute', { candidate_id: randomUUID() });
			// The worker of the owner, started inside its line: the follow-up its handler enqueues stays in the line.
			launch({
				owner: 'demo_seed',
				handlers: handlerRegistry([
					{
						type: 'evidence.compute',
						concurrency: 1,
						run: ({ job }) => {
							seedRuns.push(job.id);
							return Promise.resolve({
								isCurrent: () => Promise.resolve(true),
								write: async (tx) => {
									const next = await enqueueJob(
										tx,
										'match.refresh',
										{ scope: 'candidate', candidate_id: randomUUID() },
										{ inputVersion: '1', createdBy: system }
									);
									followUps.push(next.jobId);
								}
							});
						}
					},
					recordingHandler('match.refresh', seedRuns)
				]),
				types: ['evidence.compute', 'match.refresh']
			});
			return id;
		});
		launch({
			handlers: handlerRegistry([
				recordingHandler('evidence.compute', standRuns),
				recordingHandler('match.refresh', standRuns)
			]),
			types: ['evidence.compute', 'match.refresh']
		});
		await waitFor('the follow-up of the owned job', async () => {
			const [followUp] = followUps;
			return followUp !== undefined && (await jobRow(followUp)).status === 'succeeded';
		});
		await waitFor('the job of the stand', async () => (await jobRow(standJob)).status === 'succeeded');
		expect(standRuns).toEqual([standJob]);
		expect(seedRuns).toEqual([ownedJob, ...followUps]);
		expect(await ownerOf(standJob)).toBeNull();
		expect(await ownerOf(ownedJob)).toBe('demo_seed');
		expect(await ownerOf(followUps[0] ?? '')).toBe('demo_seed');
	});

	it('takes over the waiting job it joins and leaves types outside the line to the stand', async () => {
		const { db } = database;
		const candidate = randomUUID();
		const waiting = await enqueue(db, 'evidence.compute', { candidate_id: candidate });
		const [joined, other] = await withJobOwner('demo_seed', ['evidence.compute'], async () => [
			await enqueue(db, 'evidence.compute', { candidate_id: candidate }),
			await enqueue(db, 'profile.embed', { candidate_id: candidate })
		]);
		expect(joined).toBe(waiting);
		expect(await ownerOf(waiting)).toBe('demo_seed');
		expect(await ownerOf(other)).toBeNull();
		// A later change of the stand joins it and leaves it with the owner.
		expect(await enqueue(db, 'evidence.compute', { candidate_id: candidate })).toBe(waiting);
		expect(await ownerOf(waiting)).toBe('demo_seed');
		expect(await claimJob(db, 'stand', ['evidence.compute'])).toBeNull();
		expect((await claimJob(db, 'seed', ['evidence.compute'], 'demo_seed'))?.id).toBe(waiting);
	});
});

describe('periodic jobs', () => {
	const retention = PERIODIC_JOBS.find((entry) => entry.type === 'retention.sweep');
	if (!retention) throw new Error('retention.sweep is not periodic');
	const at = new Date('2026-10-07T03:00:00Z');

	async function retentionJobs(date: string) {
		return database.db
			.select({ id: jobs.id, status: jobs.status })
			.from(jobs)
			.where(and(eq(jobs.type, 'retention.sweep'), eq(jobs.dedupKey, `retention:${date}`)));
	}

	it('enqueues and runs the job of a period once across workers and ticks', async () => {
		const runs: string[] = [];
		const handlers = handlerRegistry([recordingHandler('retention.sweep', runs)]);
		const options = { handlers, types: ['retention.sweep'], scheduleIntervalMs: 5, now: () => at };
		launch({ ...options, workerId: 'worker-1' });
		launch({ ...options, workerId: 'worker-2' });
		launch({ ...options, workerId: 'worker-3' });
		await waitFor('the job of the day', async () => (await retentionJobs('2026-10-07'))[0]?.status === 'succeeded');
		// Many more ticks of all three workers after the job has finished.
		await sleep(500);
		expect(await retentionJobs('2026-10-07')).toHaveLength(1);
		expect(runs).toHaveLength(1);
	});

	it('leaves the decision to the worker that holds the lock of the type', async () => {
		const { db } = database;
		// Another worker is between its check and its enqueue: it holds the advisory lock of the type.
		const outcome = await database.sql.begin(async (other) => {
			await other`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext('retention.sweep'))`;
			return schedulePeriodicJob(db, retention, at);
		});
		expect(outcome).toBe('busy');
		expect(await retentionJobs('2026-10-07')).toEqual([]);

		expect(await schedulePeriodicJob(db, retention, at)).toBe('enqueued');
		expect(await schedulePeriodicJob(db, retention, at)).toBe('exists');
		expect(await schedulePeriodicJob(db, retention, new Date('2026-10-08T00:00:01Z'))).toBe('enqueued');
		expect(await retentionJobs('2026-10-08')).toHaveLength(1);
	});

	it('refreshes the market once per UTC day', async () => {
		const market = PERIODIC_JOBS.find((entry) => entry.type === 'market.refresh');
		if (!market) throw new Error('market.refresh is not periodic');
		const { db } = database;
		expect(await schedulePeriodicJob(db, market, at)).toBe('enqueued');
		expect(await schedulePeriodicJob(db, market, new Date('2026-10-07T23:59:59Z'))).toBe('exists');
		expect(await schedulePeriodicJob(db, market, new Date('2026-10-08T00:00:00Z'))).toBe('enqueued');
		const rows = await db
			.select({ dedupKey: jobs.dedupKey, inputVersion: jobs.inputVersion })
			.from(jobs)
			.where(eq(jobs.type, 'market.refresh'))
			.orderBy(jobs.dedupKey);
		expect(rows).toEqual([
			{ dedupKey: 'market:2026-10-07', inputVersion: '2026-10-07' },
			{ dedupKey: 'market:2026-10-08', inputVersion: '2026-10-08' }
		]);
	});

	it('schedules only the periodic types the worker runs', async () => {
		launch({
			handlers: handlerRegistry([recordingHandler('profile.embed', [])]),
			types: ['profile.embed'],
			now: () => at
		});
		await sleep(300);
		const periodic = await database.db
			.select({ id: jobs.id })
			.from(jobs)
			.where(sql`${jobs.type} in ('retention.sweep', 'derivations.reconcile', 'market.refresh')`);
		expect(periodic).toEqual([]);
	});

	it('ticks the schedules with their own timetables of the types it runs, and only them', async () => {
		const calls: string[] = [];
		const ticks = [
			{
				type: 'candidate.majority_transition' as const,
				tick: (_db: Database, now: Date) => {
					calls.push(now.toISOString());
					return Promise.resolve(0);
				}
			}
		];
		launch({ handlers: handlerRegistry([recordingHandler('profile.embed', [])]), types: ['profile.embed'], ticks });
		await sleep(300);
		expect(calls).toEqual([]);
		launch({
			handlers: handlerRegistry([recordingHandler('candidate.majority_transition', [])]),
			types: ['candidate.majority_transition'],
			ticks,
			now: () => at
		});
		await waitFor('two ticks', () => calls.length >= 2);
		expect(new Set(calls)).toEqual(new Set([at.toISOString()]));
	});
});
