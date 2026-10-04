// Job `vacancy.normalize` (docs/domain.md, sections 13.2, 17.2): normalize one posting to the current taxonomy, then
// recompute its cluster. The result is written only while the posting still has the record hash the run read; a
// revised cluster gets its vector and its matches recomputed in the same transaction, and the skill tags the taxonomy
// does not know go to the queue of the dictionary (`taxonomy/unknown-mentions.ts`).
import { eq } from 'drizzle-orm';
import type { Database } from '$lib/server/db';
import { vacancyPostings } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { recordUnknownSkillMentions } from '$lib/server/taxonomy/unknown-mentions';
import { loadStaleAfterDays, PENDING_VERSION, recomputeCluster } from './clusters';
import { enqueueRevisionDerivations } from './derivations';
import { normalizationVersion, normalizedPostingSchema, normalizePosting, originalTermsSchema } from './normalize';
import { loadVacancyTaxonomy, TaxonomyUnavailable } from './taxonomy';

const stale: JobResult = { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };

async function run(db: Database, postingId: string, now: () => Date): Promise<JobResult> {
	const [posting] = await db.select().from(vacancyPostings).where(eq(vacancyPostings.id, postingId));
	if (!posting) return stale;
	let taxonomy;
	try {
		taxonomy = await loadVacancyTaxonomy(db);
	} catch (error) {
		if (error instanceof TaxonomyUnavailable)
			throw new JobFailure('taxonomy_missing', error.message, { retryable: true });
		throw error;
	}
	const normalized = normalizePosting(posting.title, originalTermsSchema.parse(posting.originalTerms), taxonomy);
	const version = normalizationVersion(taxonomy);
	let revised = false;
	return {
		isCurrent: async (tx) => {
			const [row] = await tx
				.select({ rawSha256: vacancyPostings.rawSha256, vacancyId: vacancyPostings.vacancyId })
				.from(vacancyPostings)
				.where(eq(vacancyPostings.id, postingId))
				.for('update');
			return row?.rawSha256 === posting.rawSha256;
		},
		write: async (tx) => {
			const [previous] = await tx
				.select({ normalized: vacancyPostings.normalized, version: vacancyPostings.normalizationVersion })
				.from(vacancyPostings)
				.where(eq(vacancyPostings.id, postingId));
			if (!previous) throw new Error('posting disappeared while locked');
			const [row] = await tx
				.update(vacancyPostings)
				.set({ normalized, normalizationVersion: version })
				.where(eq(vacancyPostings.id, postingId))
				.returning({ vacancyId: vacancyPostings.vacancyId });
			if (!row) throw new Error('posting disappeared while locked');
			const at = now();
			const unknownBefore =
				previous.version === PENDING_VERSION ? [] : normalizedPostingSchema.parse(previous.normalized).skills.unknown;
			await recordUnknownSkillMentions(
				tx,
				{ id: postingId, fetchedAt: posting.lastFetchedAt },
				unknownBefore,
				normalized.skills.unknown,
				at
			);
			const change = await recomputeCluster(tx, row.vacancyId, {
				taxonomyVersionId: taxonomy.id,
				now: at,
				staleAfterDays: await loadStaleAfterDays(tx, at)
			});
			revised = change.revised;
			if (change.revised) await enqueueRevisionDerivations(tx, row.vacancyId, change.revision, { kind: 'system' });
		},
		describe: () => ({
			role: normalized.role.key !== null,
			grade: normalized.grade.basis,
			skills: normalized.skills.required.length + normalized.skills.nice.length,
			unknown_skills: normalized.skills.unknown.length,
			salary: normalized.salary.status,
			revised
		})
	};
}

export function createVacancyNormalizeHandler(now: () => Date = () => new Date()): JobHandler<'vacancy.normalize'> {
	return defineHandler({
		type: 'vacancy.normalize',
		concurrency: 4,
		run: ({ job, db }) => run(db, job.payload.posting_id, now)
	});
}

/** Handler of `vacancy.normalize` for the job registry. */
export const vacancyNormalize = createVacancyNormalizeHandler();
