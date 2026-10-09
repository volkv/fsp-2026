// The seed runs the product's jobs the way the worker does: the chain «FSP sync → facts → claims → categorization →
// matches» and the parse of resumes go through their handlers, captured from the queue by an in-process worker until
// no job of those types is left. The jobs of the chain belong to the seed (`withJobOwner`, owner `demo_seed`): only its
// worker captures them, with the seed's handlers, and a worker of the stand running at the same time leaves them alone.
// The same wait runs the stand's line (owner `null`) where nothing else captures it: the test of a pipeline.
import { randomUUID } from 'node:crypto';
import { and, count, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '$lib/server/db';
import { jobs, type JobOwner } from '$lib/server/db/schema';
import type { HandlerRegistry } from '$lib/server/jobs/handler';
import { jobOwnerFor } from '$lib/server/jobs/insert';
import type { JobLogger } from '$lib/server/jobs/log';
import type { JobType } from '$lib/server/jobs/registry';
import { startWorker } from '$lib/server/jobs/worker';

/** Owner of the seed's line of the queue. */
export const SEED_JOBS: JobOwner = 'demo_seed';

class DemoJobsFailed extends Error {
	override name = 'DemoJobsFailed';
}

const POLL_MS = 500;
const PROGRESS_MS = 15_000;

/**
 * Runs the queued jobs of `types` on the line of `owner` (`null` — the stand's) with the handlers of `registry` until
 * none is queued or running, then checks that none of them failed since `since`. A failed job of the chain is a broken
 * seed, never a skipped one.
 */
export async function drainJobs(
	db: Database,
	registry: HandlerRegistry,
	types: readonly JobType[],
	options: { owner: JobOwner | null; since: Date; log: JobLogger; label: string }
): Promise<void> {
	const { owner } = options;
	const foreign = types.filter((type) => jobOwnerFor(type) !== owner);
	if (foreign.length > 0) {
		// Their jobs, enqueued here, would go to another line of the queue: this wait would not see them.
		throw new Error(`drainJobs runs outside the ${owner ?? 'stand'}'s line of the queue for ${foreign.join(', ')}`);
	}
	const ofLine = owner === null ? isNull(jobs.owner) : eq(jobs.owner, owner);
	const worker = startWorker({
		db,
		handlers: registry,
		types,
		...(owner === null ? {} : { owner }),
		workerId: `drain-${owner ?? 'stand'}:${randomUUID().slice(0, 8)}`,
		pollIntervalMs: 200,
		log: options.log
	});
	const waiting = async () => {
		const [row] = await db
			.select({ n: count() })
			.from(jobs)
			.where(and(ofLine, inArray(jobs.type, [...types]), inArray(jobs.status, ['queued', 'running'])));
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
		.where(and(ofLine, inArray(jobs.type, [...types]), eq(jobs.status, 'failed'), gte(jobs.createdAt, options.since)))
		.groupBy(jobs.type, sql`${jobs.lastError}->>'code'`);
	if (failed.length > 0) {
		throw new DemoJobsFailed(
			`${options.label}: jobs failed — ${failed.map((f) => `${f.type} ${f.code} ×${f.n}`).join(', ')}`
		);
	}
}
