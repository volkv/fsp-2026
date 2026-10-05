// Periodic jobs (docs/domain.md, sections 17.2, 17.3, 18.1): every worker ticks the schedule of the types it runs, and a
// transaction-scoped advisory lock per type makes the check «is the job of this period already there» and the
// enqueue one step among all workers. A period gets one job of any outcome: a failed job is visible to the
// administrator and is not restarted by the schedule; the next period gets its own.
import { eq, sql } from 'drizzle-orm';
import { config } from '$lib/server/config';
import type { Database } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';
import { nextStandReset } from '$lib/server/demo/activity';
import { enqueueJob } from './queue';
import { jobSpec, type JobPayload, type JobType } from './registry';

export interface PeriodicJob<T extends JobType> {
	type: T;
	/**
	 * The job of the period `now` falls into: its payload names the period and is its input version. `runAfter` — the
	 * job waits for the start of its period (a job of the next night enqueued in advance).
	 */
	due: (now: Date) => { payload: JobPayload<T>; inputVersion: string; runAfter?: Date };
	/** Whether the schedule applies on this stand, read when the worker starts; absent — always. */
	enabled?: () => boolean;
}

type AnyPeriodicJob = { [T in JobType]: PeriodicJob<T> }[JobType];

const utcDate = (now: Date) => now.toISOString().slice(0, 10);
const utcHour = (now: Date) => now.toISOString().slice(0, 13);

export const PERIODIC_JOBS: readonly AnyPeriodicJob[] = [
	{
		// Daily: journal partitions ahead, expired months dropped.
		type: 'retention.sweep',
		due: (now) => ({ payload: { date: utcDate(now) }, inputVersion: utcDate(now) })
	},
	{
		// Hourly safety net for lost recalculations (17.3).
		type: 'derivations.reconcile',
		due: (now) => ({ payload: { period: utcHour(now) }, inputVersion: utcHour(now) })
	},
	{
		// Daily: category market snapshots over the policy window (12.5).
		type: 'market.refresh',
		due: (now) => ({ payload: { period: utcDate(now) }, inputVersion: utcDate(now) })
	},
	{
		// Nightly on a demonstration stand with `DEMO_NIGHTLY_RESET` on: the job of the coming night waits for 00:00 UTC, then the stand returns to its
		// seeded state (domain 19.2). A worker started in the evening does not reset the stand at once.
		type: 'demo.reset',
		due: (now) => {
			const night = nextStandReset(now);
			return { payload: { date: utcDate(night) }, inputVersion: utcDate(night), runAfter: night };
		},
		enabled: () => config().demo?.nightlyReset === true
	},
	{
		// Hourly on a demonstration stand: demo sessions whose time is over are removed (domain 19.3).
		type: 'demo.purge',
		due: (now) => ({ payload: { period: utcHour(now) }, inputVersion: utcHour(now) }),
		enabled: () => config().demo !== null
	}
];

/**
 * A schedule that decides itself what is due on each tick, such as the imports of vacancy sources by their own
 * timetables. `tick` enqueues under its own advisory lock and returns how many jobs it enqueued.
 */
export interface ScheduleTick {
	type: JobType;
	tick: (db: Database, now: Date) => Promise<number>;
}

/** Namespace of the two-key advisory locks of the scheduler (`'jobs'` in ASCII). */
export const LOCK_NAMESPACE = 0x6a6f6273;

export type ScheduleOutcome = 'enqueued' | 'exists' | 'busy';

/**
 * Enqueues the job of the current period of one periodic type unless it already exists. `busy` — another worker
 * holds the lock of this type right now and decides for this tick.
 */
export async function schedulePeriodicJob<T extends JobType>(
	db: Database,
	entry: PeriodicJob<T>,
	now: Date
): Promise<ScheduleOutcome> {
	const { payload, inputVersion, runAfter } = entry.due(now);
	const spec = jobSpec(entry.type);
	const dedupKey = spec.dedupKey(spec.payload.parse(payload));
	return db.transaction(async (tx) => {
		const [lock] = await tx.execute<{ locked: boolean }>(
			sql`select pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${entry.type})) as locked`
		);
		if (!lock?.locked) return 'busy';
		const [existing] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.dedupKey, dedupKey)).limit(1);
		if (existing) return 'exists';
		await enqueueJob(tx, entry.type, payload, {
			inputVersion,
			createdBy: { kind: 'system', id: 'scheduler' },
			...(runAfter ? { runAfter } : {})
		});
		return 'enqueued';
	});
}

/** The periodic entries a worker running `types` schedules on this stand. */
export function periodicJobsFor(types: readonly JobType[]): AnyPeriodicJob[] {
	return PERIODIC_JOBS.filter((entry) => types.includes(entry.type) && (entry.enabled?.() ?? true));
}
