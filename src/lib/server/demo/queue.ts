// The seed runs the product's jobs the way the worker does: the chain «FSP sync → facts → claims → categorization →
// matches» and the parse of resumes go through their handlers, captured from the queue by an in-process worker until
// no job of those types is left. A worker of the stand running at the same time takes its share of the same queue.
import { randomUUID } from 'node:crypto';
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';
import { JobFailure, type AnyJobHandler, type HandlerRegistry, type JobHandler } from '$lib/server/jobs/handler';
import type { JobLogger } from '$lib/server/jobs/log';
import { completeJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { jobSpec, type JobPayload, type JobType } from '$lib/server/jobs/registry';
import { startWorker } from '$lib/server/jobs/worker';

class DemoJobsFailed extends Error {
	override name = 'DemoJobsFailed';
}

const POLL_MS = 500;
const PROGRESS_MS = 15_000;

/**
 * Runs the queued jobs of `types` with the handlers of `registry` until none is queued or running, then checks that
 * none of them failed since `since`. A failed job of the chain is a broken seed, never a skipped one.
 */
export async function drainJobs(
	db: Database,
	registry: HandlerRegistry,
	types: readonly JobType[],
	options: { since: Date; log: JobLogger; label: string }
): Promise<void> {
	const worker = startWorker({
		db,
		handlers: registry,
		types,
		workerId: `demo-seed:${randomUUID().slice(0, 8)}`,
		pollIntervalMs: 200,
		log: options.log
	});
	const waiting = async () => {
		const [row] = await db
			.select({ n: count() })
			.from(jobs)
			.where(and(inArray(jobs.type, [...types]), inArray(jobs.status, ['queued', 'running'])));
		return row?.n ?? 0;
	};
	try {
		let lastProgress = Date.now();
		for (let left = await waiting(); left > 0; left = await waiting()) {
			if (Date.now() - lastProgress >= PROGRESS_MS) {
				options.log.info(`${options.label}: ${left} jobs left`);
				lastProgress = Date.now();
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	} finally {
		await worker.stop();
	}
	const failed = await db
		.select({ type: jobs.type, code: sql<string>`${jobs.lastError}->>'code'`, n: count() })
		.from(jobs)
		.where(and(inArray(jobs.type, [...types]), eq(jobs.status, 'failed'), gte(jobs.createdAt, options.since)))
		.groupBy(jobs.type, sql`${jobs.lastError}->>'code'`);
	if (failed.length > 0) {
		throw new DemoJobsFailed(
			`${options.label}: jobs failed — ${failed.map((f) => `${f.type} ${f.code} ×${f.n}`).join(', ')}`
		);
	}
}

/**
 * Runs one job of a type now, in this process: the row is inserted already captured by the seed, so no worker takes
 * it, and the result is written conditionally as the worker writes it. Used where the seed's own dependencies must run
 * the job (the synthetic vacancy sources have an adapter only here).
 */
export async function runJobInline<T extends JobType>(
	db: Database,
	handler: JobHandler<T>,
	payload: JobPayload<T>,
	options: { inputVersion: string; log: JobLogger; before?: Parameters<Database['transaction']>[0] }
): Promise<void> {
	const type = handler.type;
	const spec = jobSpec(type);
	const parsed = spec.payload.parse(payload) as JobPayload<T>;
	const leaseOwner = `demo-seed:${randomUUID().slice(0, 8)}`;
	const id = await db.transaction(async (tx) => {
		if (options.before) await options.before(tx);
		const [row] = await tx
			.insert(jobs)
			.values({
				type,
				typeVersion: spec.typeVersion,
				payload: parsed,
				inputVersion: options.inputVersion,
				dedupKey: spec.dedupKey(parsed),
				status: 'running',
				priority: spec.priority,
				attempts: 1,
				maxAttempts: spec.maxAttempts,
				leaseOwner,
				leaseExpiresAt: sql`now() + make_interval(secs => ${spec.leaseSeconds})`,
				createdBy: { kind: 'system', id: 'demo-seed' }
			})
			.returning({ id: jobs.id });
		if (!row) throw new Error(`inline job ${type} was not inserted`);
		return row.id;
	});
	const job: ClaimedJob<T> = {
		id,
		type,
		payload: parsed,
		inputVersion: options.inputVersion,
		attempt: 1,
		maxAttempts: spec.maxAttempts,
		leaseOwner
	};
	const anyHandler = handler as unknown as AnyJobHandler;
	try {
		const result = await anyHandler.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${id}`,
			log: options.log
		});
		const outcome = await completeJob(db, job, result);
		if (outcome !== 'succeeded') throw new DemoJobsFailed(`inline job ${type} ended ${outcome}`);
	} catch (error) {
		// The row must not stay captured: after its lease a worker of the stand would retry it without the seed's
		// dependencies. It fails for good, and the seed stops with the cause.
		const code = error instanceof JobFailure ? error.code : error instanceof Error ? error.name : 'unknown';
		await failJob(db, job, { code, retryable: false, message: `the demo seed ran ${type} inline and stopped` });
		throw error;
	}
}
