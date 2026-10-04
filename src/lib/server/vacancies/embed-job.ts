// Job `vacancy.embed` (docs/domain.md, sections 16, 17.2; contracts 3.3): the vector of a vacancy at its current revision
// in the active embedding space. A vector is stored with the revision it was computed from; matching joins it only while
// that revision is current. A model that is off or refuses the request is an explicit mode — the envelope records the
// failure and search runs without the semantic component — never a made-up vector.
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '$lib/server/db';
import { embeddings, mlResults, vacancies } from '$lib/server/db/schema';
import { fitText } from '$lib/server/embeddings/text';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { loadActiveSpace, type ActiveSpace } from '$lib/server/matching/semantic';
import { modelAdapter } from '$lib/server/ml';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import { enqueueMatchRefresh } from './derivations';

export type EmbedModels = Pick<ModelAdapter, 'embed'>;

type VacancyRow = typeof vacancies.$inferSelect;

/** The document text of a vacancy: what the candidate side is compared with. */
export function vacancyDocument(
	v: Pick<VacancyRow, 'title' | 'roleKey' | 'requiredSkillKeys' | 'niceSkillKeys' | 'description'>
): string {
	const parts = [
		v.title,
		v.roleKey === null ? null : `Роль: ${v.roleKey}`,
		v.requiredSkillKeys.length > 0 ? `Обязательные навыки: ${v.requiredSkillKeys.join(', ')}` : null,
		v.niceSkillKeys.length > 0 ? `Желательные навыки: ${v.niceSkillKeys.join(', ')}` : null,
		v.description
	];
	return parts.filter((p): p is string => p !== null && p.trim() !== '').join('\n');
}

/**
 * The document cut to the runtime's input limit (embeddings/text.ts): what the embedder actually receives here. A
 * longer input is refused as a server error; a reindex (embeddings/vectors.ts) applies the same cut on its own path.
 */
export function vacancyEmbedText(
	v: Pick<VacancyRow, 'title' | 'roleKey' | 'requiredSkillKeys' | 'niceSkillKeys' | 'description'>
): string {
	return fitText(vacancyDocument(v));
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const stale: JobResult = { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };

async function run(
	models: EmbedModels,
	db: Database,
	vacancyId: string,
	jobId: string,
	signal: AbortSignal
): Promise<JobResult> {
	const [vacancy] = await db.select().from(vacancies).where(eq(vacancies.id, vacancyId));
	if (!vacancy) return stale;
	const space = await loadActiveSpace(db);
	if (space === null) {
		return {
			isCurrent: () => Promise.resolve(true),
			write: () => Promise.resolve(),
			describe: () => ({ mode: 'no_active_space' })
		};
	}
	const text = vacancyEmbedText(vacancy);
	const revision = vacancy.revision;
	const response = await models.embed(
		{ spaceId: space.id, inputs: [{ id: vacancyId, kind: 'document', text }] },
		{ priority: 'background', signal }
	);
	if (!response.ok && response.error.retryable) {
		throw new JobFailure(`embed_${response.error.code}`, response.error.message, { retryable: true });
	}
	const vector = response.ok ? response.value.vectors[0]?.vector : undefined;
	if (response.ok && vector === undefined) throw new Error('embed returned no vector for the vacancy');

	const isCurrent = async (tx: Parameters<JobResult['write']>[0]) => {
		const [row] = await tx
			.select({ revision: vacancies.revision })
			.from(vacancies)
			.where(eq(vacancies.id, vacancyId))
			.for('share');
		const active: ActiveSpace | null = await loadActiveSpace(tx);
		return row?.revision === revision && active?.id === space.id;
	};
	const envelope = {
		operation: 'embed' as const,
		jobId,
		inputRef: { type: 'vacancy', id: vacancyId, revision },
		inputSha256: sha256(text),
		inputVersion: String(revision),
		schemaVersion: 'embed/v1',
		embeddingSpaceId: space.id
	};
	return {
		isCurrent,
		write: async (tx) => {
			if (!response.ok || vector === undefined) {
				await tx
					.insert(mlResults)
					.values({
						...envelope,
						processingMode: 'failed',
						failure: {
							code: response.ok ? 'invalid_output' : response.error.code,
							...(!response.ok && typeof response.error.details?.reason === 'string'
								? { reason: response.error.details.reason }
								: {})
						}
					})
					.onConflictDoNothing();
				return;
			}
			await tx
				.insert(mlResults)
				.values({
					...envelope,
					processingMode: 'model',
					model: { endpoint_profile: 'embed', space_id: space.id },
					latencyMs: response.value.latencyMs
				})
				.onConflictDoNothing();
			await tx
				.delete(embeddings)
				.where(
					and(eq(embeddings.spaceId, space.id), eq(embeddings.ownerType, 'vacancy'), eq(embeddings.ownerId, vacancyId))
				);
			await tx.insert(embeddings).values({
				ownerType: 'vacancy',
				ownerId: vacancyId,
				inputSha256: envelope.inputSha256,
				inputVersion: String(revision),
				spaceId: space.id,
				vector
			});
			// The semantic component of the matches becomes computable.
			await enqueueMatchRefresh(tx, vacancyId, revision, { kind: 'system' });
		},
		describe: () => ({ mode: response.ok ? 'model' : response.error.code, space: space.id })
	};
}

export function createVacancyEmbedHandler(models: () => EmbedModels): JobHandler<'vacancy.embed'> {
	return defineHandler({
		type: 'vacancy.embed',
		concurrency: 2,
		run: ({ job, db, signal }) => run(models(), db, job.payload.vacancy_id, job.id, signal)
	});
}

/** Handler of `vacancy.embed` for the job registry. */
export const vacancyEmbed = createVacancyEmbedHandler(modelAdapter);
