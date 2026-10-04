// Job `vacancies.freshness_check` (docs/domain.md, sections 13.2, 17.2; contracts 7.2): ask the source about one
// posting. An explicit «no such record» takes the posting off; a found record confirms it (its content is refreshed by
// the import, not here: a page and a feed of one source describe a record differently). A failed check leaves the
// posting `unknown`, never gone.
import { eq } from 'drizzle-orm';
import type { Database } from '$lib/server/db';
import { vacancyPostings, vacancySources } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { loadStaleAfterDays, recomputeCluster } from './clusters';
import { enqueueRevisionDerivations } from './derivations';
import { productionSourceDeps, type ImportDeps } from './import-job';
import { disableRefusedSource } from './source-state';
import { createVacancySource } from './sources/catalog';

const stale: JobResult = { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };

async function run(
	deps: ImportDeps,
	db: Database,
	postingId: string,
	signal: AbortSignal,
	requestId: string
): Promise<JobResult> {
	const [posting] = await db
		.select({
			id: vacancyPostings.id,
			source: vacancyPostings.source,
			externalId: vacancyPostings.externalId,
			vacancyId: vacancyPostings.vacancyId,
			freshness: vacancyPostings.freshness,
			enabled: vacancySources.enabled
		})
		.from(vacancyPostings)
		.innerJoin(vacancySources, eq(vacancySources.key, vacancyPostings.source))
		.where(eq(vacancyPostings.id, postingId));
	if (!posting?.enabled || posting.freshness === 'gone') return stale;
	const adapter = deps.source(posting.source, signal);
	if (!adapter) throw new JobFailure('adapter_missing', 'the source has no available adapter', { retryable: false });

	const answer = await adapter.get(posting.externalId);
	let freshness: 'active' | 'gone' | 'unknown';
	if (answer.ok) {
		freshness = 'gone' in answer.value ? 'gone' : 'active';
	} else if (answer.error.code === 'forbidden') {
		await db.transaction((tx) =>
			disableRefusedSource(tx, {
				source: posting.source,
				via: { kind: 'freshness_check', postingId: posting.id },
				requestId
			})
		);
		throw new JobFailure('source_forbidden', answer.error.message, { retryable: false });
	} else if (answer.error.retryable) {
		const retryAfter = answer.error.details?.retry_after_seconds;
		throw new JobFailure(`source_${answer.error.code}`, answer.error.message, {
			retryable: true,
			...(typeof retryAfter === 'number' ? { retryAfterSeconds: retryAfter } : {})
		});
	} else {
		freshness = 'unknown';
	}

	let revised = false;
	return {
		isCurrent: async (tx) => {
			const [row] = await tx
				.select({ freshness: vacancyPostings.freshness })
				.from(vacancyPostings)
				.where(eq(vacancyPostings.id, postingId))
				.for('update');
			return row !== undefined && row.freshness !== 'gone';
		},
		write: async (tx) => {
			const now = deps.now();
			await tx
				.update(vacancyPostings)
				.set(
					freshness === 'unknown'
						? { freshness }
						: { freshness, lastCheckedAt: now, goneAt: freshness === 'gone' ? now : null }
				)
				.where(eq(vacancyPostings.id, postingId));
			const change = await recomputeCluster(tx, posting.vacancyId, {
				taxonomyVersionId: null,
				now,
				staleAfterDays: await loadStaleAfterDays(tx, now)
			});
			revised = change.revised;
			if (change.revised) await enqueueRevisionDerivations(tx, posting.vacancyId, change.revision, { kind: 'system' });
		},
		describe: () => ({ freshness, revised })
	};
}

export function createFreshnessCheckHandler(deps: () => ImportDeps): JobHandler<'vacancies.freshness_check'> {
	return defineHandler({
		type: 'vacancies.freshness_check',
		concurrency: 2,
		run: ({ job, db, signal, requestId }) => run(deps(), db, job.payload.posting_id, signal, requestId)
	});
}

/** Handler of `vacancies.freshness_check` for the job registry. */
export const vacanciesFreshnessCheck = createFreshnessCheckHandler(() => {
	const sourceDeps = productionSourceDeps();
	return { source: (key, signal) => createVacancySource(key, sourceDeps, signal), now: sourceDeps.now };
});
