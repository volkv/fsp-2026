// Job `demo.purge` (docs/domain.md, section 19.3): hourly on a demonstration stand, removes the demo sessions whose
// time is over or that nobody has used for the idle time of the terms of the stand (`terms.ts`) — the clones of the cast with everything they own and
// the visitors' own resumes with every result derived from them. Each session goes in its own transaction; a session
// whose rows are named from outside it stays and fails the job with the references named, the others are removed.
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { defineHandler, JobFailure, type JobHandler } from '$lib/server/jobs/handler';
import { redis } from '$lib/server/redis';
import { objectStore } from '$lib/server/storage/object-store';
import { purgeExpiredDemoSessions, type PurgeDeps } from './purge';

export function createDemoPurgeHandler(deps: () => Promise<PurgeDeps>): JobHandler<'demo.purge'> {
	return defineHandler({
		type: 'demo.purge',
		concurrency: 1,
		run: async ({ requestId }) => {
			if (config().demo === null) {
				throw new JobFailure('demo_mode_off', 'DEMO_MODE is not true on this stand', { retryable: false });
			}
			const outcome = await purgeExpiredDemoSessions(await deps(), new Date(), requestId);
			if (outcome.failed.length > 0) {
				throw new JobFailure(
					'demo_isolation_leak',
					`${outcome.failed.length} demo sessions were kept: ${outcome.failed.map((f) => f.reason).join('; ')}`,
					{ retryable: false }
				);
			}
			return {
				isCurrent: () => Promise.resolve(true),
				write: () => Promise.resolve(),
				describe: () => ({
					sessions_idle: outcome.idle.length,
					sessions_removed: outcome.purged.length,
					rows_removed: outcome.purged.reduce((sum, p) => sum + p.rowsRemoved, 0),
					files_removed: outcome.purged.reduce((sum, p) => sum + p.filesRemoved, 0),
					jobs_cancelled: outcome.purged.reduce((sum, p) => sum + p.jobsCancelled, 0)
				})
			};
		}
	});
}

/** Handler of `demo.purge` for the job registry. */
export const demoPurge = createDemoPurgeHandler(async () => ({ db: db(), redis: await redis(), store: objectStore() }));
