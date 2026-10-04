// Job `demo.reset` (docs/domain.md, section 19.2): the nightly return of the demonstration stand to its seeded state,
// and the first seed of a new stand or of new seed data (`ensure` at the start of the application enqueues it). The
// reset and the seed commit in their own transactions as they go, so the job's result has nothing left to write.
import { asc, eq } from 'drizzle-orm';
import { config } from '$lib/server/config';
import type { Database } from '$lib/server/db';
import { embeddingSpaces } from '$lib/server/db/schema';
import { spaceDefinition } from '$lib/server/embeddings/definitions';
import { defineHandler, JobFailure, type JobHandler } from '$lib/server/jobs/handler';
import type { JobLogger } from '$lib/server/jobs/log';
import { enqueueJob } from '$lib/server/jobs/queue';
import { loadActiveSpace } from '$lib/server/matching/semantic';
import { configuredDemoServices } from './configured';
import { resetDemo } from './reset';
import { seedDemo } from './seed';
import type { DemoServices } from './services';

/**
 * Enqueues `embedding.reindex` for the spaces the seeded data need vectors in: the space search uses now, so a reset
 * that emptied its vectors (reset.ts) gets them back for every seeded candidate and vacancy without waiting for a later
 * change to notice the gap, and a space of a known definition still being built — the start of the application
 * enqueued its reindex, and the reset emptied the queue together with that job. The spaces enqueued, the active one
 * first; none without either.
 */
export async function enqueueDemoReindex(db: Database): Promise<string[]> {
	const activeSpace = await loadActiveSpace(db);
	const building = await db
		.select({ id: embeddingSpaces.id })
		.from(embeddingSpaces)
		.where(eq(embeddingSpaces.status, 'building'))
		.orderBy(asc(embeddingSpaces.id));
	const spaces = [
		...(activeSpace ? [activeSpace.id] : []),
		...building.map((space) => space.id).filter((id) => spaceDefinition(id) !== null)
	];
	if (spaces.length === 0) return spaces;
	await db.transaction(async (tx) => {
		for (const space of spaces) {
			await enqueueJob(
				tx,
				'embedding.reindex',
				{ space_id: space },
				{ inputVersion: space, createdBy: { kind: 'system' } }
			);
		}
	});
	return spaces;
}

function createDemoResetHandler(services: (log: JobLogger) => Promise<DemoServices>): JobHandler<'demo.reset'> {
	return defineHandler({
		type: 'demo.reset',
		concurrency: 1,
		run: async ({ requestId, log }) => {
			// Checked before anything is touched: a job left in the queue of a stand that left demonstration mode fails.
			if (config().demo === null) {
				throw new JobFailure('demo_mode_off', 'DEMO_MODE is not true on this stand', { retryable: false });
			}
			const demo = await services(log);
			const reset = await resetDemo(
				{
					db: demo.db,
					redis: demo.redis,
					store: demo.store,
					fspMock: { origin: demo.fspMockOrigin, controlToken: demo.settings.fspMockControlToken }
				},
				{ requestId }
			);
			const seeded = await seedDemo(demo);
			const reindexSpaces = await enqueueDemoReindex(demo.db);
			return {
				isCurrent: () => Promise.resolve(true),
				write: () => Promise.resolve(),
				describe: () => ({
					tables_cleared: reset.tablesCleared,
					files_removed: reset.filesRemoved,
					batch: seeded.batch,
					candidates: seeded.counts.candidates,
					vacancies: seeded.counts.vacancies,
					seed_ms: seeded.durationMs,
					reindex_spaces: reindexSpaces.join(',')
				})
			};
		}
	});
}

/** Handler of `demo.reset` for the job registry. */
export const demoReset = createDemoResetHandler(configuredDemoServices);
