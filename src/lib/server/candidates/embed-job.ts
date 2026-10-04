// Job `profile.embed` (docs/domain.md, sections 16, 17.2; contracts 3.3, 3.5): the section vectors of a candidate at
// the current `profile_revision` in the configured embedding space, while that space is being built or is active. The
// texts are the catalog view of the profile (embeddings/text.ts). A model that is off or refuses the request is an
// explicit mode — the envelope records the failure and the candidate is found by words only — never a made-up vector;
// a runtime that is down is retried with backoff. A profile without `pd_processing` in effect has no vectors
// (embeddings/profile.ts): its texts are not sent to the model and the vectors it had are removed; vectors computed
// while the consent lapsed are not written.
import { and, eq, inArray } from 'drizzle-orm';
import { config } from '$lib/server/config';
import { processingAllowed } from '$lib/server/consent/processing';
import type { Database, Transaction } from '$lib/server/db';
import { embeddingSpaces, mlResults } from '$lib/server/db/schema';
import { loadCandidateProfiles, loadTaxonomyLabels } from '$lib/server/embeddings/profile';
import {
	embedDocuments,
	lockedRevisions,
	planCandidates,
	sha256,
	writeCandidatePlan,
	type EmbedModels
} from '$lib/server/embeddings/vectors';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { enqueueJob, type JobCreator } from '$lib/server/jobs/queue';
import { modelAdapter } from '$lib/server/ml';

/** `profile.embed` of a new revision of the profile, in the transaction of the change. */
export async function enqueueProfileEmbed(
	tx: Transaction,
	candidateId: string,
	revision: number,
	createdBy: JobCreator
): Promise<void> {
	await enqueueJob(tx, 'profile.embed', { candidate_id: candidateId }, { inputVersion: String(revision), createdBy });
}

export interface ProfileEmbedDeps {
	models: () => EmbedModels;
	/** `EMBED_SPACE_ID`, or `null` when the operation is not configured. */
	spaceId: () => string | null;
	now: () => Date;
}

/** The space vectors are written to: the configured one, while it is being built or is active. */
async function targetSpace(executor: Database | Transaction, spaceId: string) {
	const [row] = await executor
		.select({ id: embeddingSpaces.id, status: embeddingSpaces.status })
		.from(embeddingSpaces)
		.where(and(eq(embeddingSpaces.id, spaceId), inArray(embeddingSpaces.status, ['building', 'active'])));
	return row ?? null;
}

const idle = (mode: string): JobResult => ({
	isCurrent: () => Promise.resolve(true),
	write: () => Promise.resolve(),
	describe: () => ({ mode })
});

async function run(
	deps: ProfileEmbedDeps,
	db: Database,
	candidateId: string,
	jobId: string,
	signal: AbortSignal
): Promise<JobResult> {
	const spaceId = deps.spaceId();
	if (spaceId === null) return idle('not_configured');
	const space = await targetSpace(db, spaceId);
	if (space === null) return idle('no_space');

	const labels = await loadTaxonomyLabels(db);
	const profile = (await loadCandidateProfiles(db, [candidateId], labels, deps.now())).get(candidateId);
	if (!profile) return { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };
	const [plan] = await planCandidates(db, space.id, [profile]);
	if (!plan) return idle('up_to_date');

	const embedded = await embedDocuments(deps.models(), space.id, plan.embed, signal);
	if (!embedded.ok && embedded.error.retryable) {
		throw new JobFailure(`embed_${embedded.error.code}`, embedded.error.message, { retryable: true });
	}

	const isCurrent = async (tx: Transaction) => {
		const revision = (await lockedRevisions(tx, [candidateId])).get(candidateId);
		const current = await targetSpace(tx, space.id);
		return (
			revision === profile.revision &&
			current?.status === space.status &&
			(!profile.embedded || (await processingAllowed(tx, candidateId, deps.now())))
		);
	};
	const envelope = {
		operation: 'embed' as const,
		jobId,
		inputRef: { type: 'candidate', id: candidateId, revision: profile.revision },
		inputSha256: sha256(profile.sections.map((s) => `${s.section}\n${s.text}`).join('\n\n')),
		inputVersion: String(profile.revision),
		schemaVersion: 'embed/v1',
		embeddingSpaceId: space.id
	};
	return {
		isCurrent,
		write: async (tx) => {
			if (!embedded.ok) {
				await tx
					.insert(mlResults)
					.values({
						...envelope,
						processingMode: 'failed',
						failure: {
							code: embedded.error.code,
							...(typeof embedded.error.details?.reason === 'string' ? { reason: embedded.error.details.reason } : {})
						}
					})
					.onConflictDoNothing();
				return;
			}
			if (plan.embed.length > 0) {
				await tx
					.insert(mlResults)
					.values({
						...envelope,
						processingMode: 'model',
						model: { endpoint_profile: 'embed', space_id: space.id },
						latencyMs: embedded.latencyMs
					})
					.onConflictDoNothing();
			}
			await writeCandidatePlan(tx, space.id, plan, embedded.vectors);
			// The semantic component of the candidate's matches becomes computable in the space search uses.
			if (space.status === 'active') {
				await enqueueJob(
					tx,
					'match.refresh',
					{ scope: 'candidate', candidate_id: candidateId },
					{ inputVersion: String(profile.revision), createdBy: { kind: 'system' } }
				);
			}
		},
		describe: () => ({
			mode: embedded.ok ? 'model' : embedded.error.code,
			space: space.id,
			embedded: plan.embed.length,
			kept: plan.keep.length,
			removed: plan.remove.length
		})
	};
}

export function createProfileEmbedHandler(deps: ProfileEmbedDeps): JobHandler<'profile.embed'> {
	return defineHandler({
		type: 'profile.embed',
		concurrency: 1,
		run: ({ job, db, signal }) => run(deps, db, job.payload.candidate_id, job.id, signal)
	});
}

/** Handler of `profile.embed` for the job registry. */
export const profileEmbed = createProfileEmbedHandler({
	models: modelAdapter,
	spaceId: () => config().models.embed?.spaceId ?? null,
	now: () => new Date()
});
