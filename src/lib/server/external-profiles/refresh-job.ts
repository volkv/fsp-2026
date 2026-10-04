// Job `external_profile.refresh` and its daily schedule (docs/domain.md, sections 9.4, 17.2): a verified profile is
// read again once a day — a rating changes after every contest, repositories after every push. The source is read in
// `run`; the facts are written in the conditional write, which re-checks that the profile is still the same verified
// profile. A source that does not answer leaves its status on the profile and the job retries later, at the moment
// the source names for a rate limit.
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '$lib/server/db';
import { externalProfiles, jobs } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler } from '$lib/server/jobs/handler';
import { enqueueJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { LOCK_NAMESPACE } from '$lib/server/jobs/scheduler';
import { externalProfileDeps, type ExternalProfileDeps } from './deps';
import type { EvidenceContext, FactChange } from './facts';
import { readingIsCurrent, readProfile, writeReading } from './service';
import { REFRESH_PERIOD_MS } from './types';

const system = { kind: 'system' } as const;

export function createExternalProfileRefreshHandler(
	deps: () => ExternalProfileDeps
): JobHandler<'external_profile.refresh'> {
	return defineHandler({
		type: 'external_profile.refresh',
		// One at a time: the public APIs limit calls per address.
		concurrency: 1,
		run: async ({ job, requestId }) => {
			const current = deps();
			const context: EvidenceContext = {
				actor: system,
				requestId,
				createdBy: { kind: 'system', id: job.id },
				signer: current.signer
			};
			const prepared = await readProfile(current, job.payload.external_profile_id, context);
			if ('kind' in prepared) {
				if (prepared.kind === 'stale') {
					return { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };
				}
				throw new JobFailure(`source_${prepared.reason}`, `source unavailable: ${prepared.reason}`, {
					retryable: true,
					...(prepared.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: prepared.retryAfterSeconds })
				});
			}
			let change: FactChange | undefined;
			let sync: string | undefined;
			return {
				isCurrent: (tx) => readingIsCurrent(tx, prepared),
				write: async (tx) => {
					const written = await writeReading(tx, prepared, current.now(), context);
					change = written.change;
					sync = written.sync;
				},
				describe: () => ({
					sync,
					inserted: change?.inserted,
					unchanged: change?.unchanged,
					superseded: change?.superseded,
					withdrawn: change?.withdrawn
				})
			};
		}
	});
}

/** Handler of `external_profile.refresh` for the job registry. */
export const externalProfileRefresh = createExternalProfileRefreshHandler(externalProfileDeps);

/** Profiles enqueued per tick at most: the public APIs allow a few dozen calls an hour without a token. */
const BATCH = 20;
/** Spacing of the jobs of one tick, so that they do not hit the source at once. */
const SPACING_MS = 2 * 60 * 1000;

/**
 * Enqueues the reading of verified profiles not read for a day (the moment of the last attempt counts, so a source that
 * is down is not asked again before the next day). Returns how many jobs it enqueued.
 */
export async function scheduleExternalProfileRefreshes(db: Database, now: Date): Promise<number> {
	return db.transaction(async (tx) => {
		const [lock] = await tx.execute<{ locked: boolean }>(
			sql`select pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext('external_profile.refresh')) as locked`
		);
		if (!lock?.locked) return 0;
		const due = await tx
			.select({ id: externalProfiles.id })
			.from(externalProfiles)
			.where(
				and(
					eq(externalProfiles.ownershipStatus, 'verified'),
					or(
						isNull(externalProfiles.syncCheckedAt),
						lt(externalProfiles.syncCheckedAt, new Date(now.getTime() - REFRESH_PERIOD_MS))
					)
				)
			)
			.orderBy(asc(externalProfiles.syncCheckedAt), asc(externalProfiles.id))
			.limit(BATCH);
		let enqueued = 0;
		for (const profile of due) {
			const payload = { external_profile_id: profile.id };
			const [pending] = await tx
				.select({ id: jobs.id })
				.from(jobs)
				.where(
					and(
						eq(jobs.dedupKey, JOB_TYPES['external_profile.refresh'].dedupKey(payload)),
						inArray(jobs.status, ['queued', 'running'])
					)
				)
				.limit(1);
			if (pending) continue;
			await enqueueJob(tx, 'external_profile.refresh', payload, {
				inputVersion: now.toISOString().slice(0, 10),
				createdBy: { kind: 'system', id: 'scheduler' },
				runAfter: new Date(now.getTime() + enqueued * SPACING_MS)
			});
			enqueued++;
		}
		return enqueued;
	});
}
