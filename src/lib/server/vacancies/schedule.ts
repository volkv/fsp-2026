// Imports by the schedule of each source (`vacancy_sources.schedule`, docs/domain.md 13.2): a full import every
// `full_every_hours`, an incremental one every `incremental_every_hours`. Called on every scheduler tick of a worker that
// runs `vacancies.import`; a transaction-scoped advisory lock makes the decision one step among workers.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '$lib/server/db';
import { jobs, vacancyImportRuns, vacancySources } from '$lib/server/db/schema';
import { enqueueJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { LOCK_NAMESPACE } from '$lib/server/jobs/scheduler';
import { sourceScheduleSchema } from './sources/definitions';

export interface ScheduledImport {
	source: string;
	mode: 'full' | 'incremental';
}

/** Enqueues the imports that are due; returns them. */
export async function scheduleVacancyImports(db: Database, now: Date): Promise<ScheduledImport[]> {
	return db.transaction(async (tx) => {
		const [lock] = await tx.execute<{ locked: boolean }>(
			sql`select pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext('vacancies.import')) as locked`
		);
		if (!lock?.locked) return [];
		const sources = await tx
			.select({ key: vacancySources.key, schedule: vacancySources.schedule })
			.from(vacancySources)
			.where(eq(vacancySources.enabled, true));
		const scheduled: ScheduledImport[] = [];
		for (const source of sources) {
			const schedule = sourceScheduleSchema.parse(source.schedule);
			const plan: [ScheduledImport['mode'], number | null][] = [
				['full', schedule.full_every_hours],
				['incremental', schedule.incremental_every_hours]
			];
			for (const [mode, everyHours] of plan) {
				if (everyHours === null) continue;
				const payload = { source: source.key, mode };
				const dedupKey = JOB_TYPES['vacancies.import'].dedupKey(payload);
				const [pending] = await tx
					.select({ id: jobs.id })
					.from(jobs)
					.where(and(eq(jobs.dedupKey, dedupKey), inArray(jobs.status, ['queued', 'running'])))
					.limit(1);
				if (pending) continue;
				const [last] = await tx
					.select({ startedAt: vacancyImportRuns.startedAt })
					.from(vacancyImportRuns)
					.where(and(eq(vacancyImportRuns.source, source.key), eq(vacancyImportRuns.mode, mode)))
					.orderBy(desc(vacancyImportRuns.startedAt))
					.limit(1);
				if (last && now.getTime() - last.startedAt.getTime() < everyHours * 3_600_000) continue;
				await enqueueJob(tx, 'vacancies.import', payload, {
					inputVersion: `${mode}:${now.toISOString().slice(0, 13)}`,
					createdBy: { kind: 'system', id: 'scheduler' }
				});
				scheduled.push(payload);
			}
		}
		return scheduled;
	});
}
