// Registration of the configured embedding space (docs/domain.md, section 16.2), run at every application start
// (main.ts): the row of `EMBED_SPACE_ID` is written from its definition once and compared with it afterwards; a space
// still being built gets its `embedding.reindex`, which switches search to it when every vector is computed; the active
// space gets one too, which only fills gaps. Idempotent: a second start finds the row and the waiting job.
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '$lib/server/db';
import { embeddingSpaces, jobs } from '$lib/server/db/schema';
import { enqueueJob } from '$lib/server/jobs/queue';
import { spaceDefinition, type SpaceDefinition } from './definitions';

export type EnsureOutcome =
	| { status: 'not_configured' }
	| { status: 'registered' | 'building' | 'active'; spaceId: string; reindex: 'enqueued' | 'already_waiting' };

export class SpaceConfigurationError extends Error {
	override name = 'SpaceConfigurationError';
}

/** Columns of the row that must equal the definition. */
function differences(row: typeof embeddingSpaces.$inferSelect, definition: SpaceDefinition): string[] {
	const expected: Record<string, unknown> = {
		modelName: definition.modelName,
		modelRevision: definition.modelRevision,
		dimension: definition.dimension,
		queryPrefix: definition.queryPrefix,
		documentPrefix: definition.documentPrefix,
		pooling: definition.pooling,
		normalization: definition.normalization,
		maxInputTokens: definition.maxInputTokens,
		chunkingVersion: definition.chunkingVersion
	};
	return Object.entries(expected)
		.filter(([column, value]) => row[column as keyof typeof row] !== value)
		.map(([column]) => column);
}

export async function ensureEmbeddingSpace(
	db: Database,
	embed: { model: string; spaceId: string } | null
): Promise<EnsureOutcome> {
	if (embed === null) return { status: 'not_configured' };
	const definition = spaceDefinition(embed.spaceId);
	if (definition === null) {
		throw new SpaceConfigurationError(`EMBED_SPACE_ID names no known embedding space: ${embed.spaceId}`);
	}
	if (definition.modelName !== embed.model) {
		throw new SpaceConfigurationError(
			`EMBED_MODEL must be ${definition.modelName} for the space ${definition.id}, got ${embed.model}`
		);
	}
	return db.transaction(async (tx) => {
		const inserted = await tx
			.insert(embeddingSpaces)
			.values({ ...definition, status: 'building' })
			.onConflictDoNothing({ target: embeddingSpaces.id })
			.returning({ id: embeddingSpaces.id });
		const [row] = await tx.select().from(embeddingSpaces).where(eq(embeddingSpaces.id, definition.id));
		if (!row) throw new Error('embedding space row is missing after its insert');
		const changed = differences(row, definition);
		if (changed.length > 0) {
			throw new SpaceConfigurationError(
				`embedding space ${definition.id} is registered with other ${changed.join(', ')}; a changed space needs a new identifier`
			);
		}
		if (row.status === 'retired') {
			throw new SpaceConfigurationError(
				`embedding space ${definition.id} is retired; a retired space never becomes active again`
			);
		}
		const [waiting] = await tx
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.dedupKey, `reindex:${definition.id}`), inArray(jobs.status, ['queued', 'running'])))
			.limit(1);
		if (!waiting) {
			await enqueueJob(
				tx,
				'embedding.reindex',
				{ space_id: definition.id },
				{ inputVersion: definition.id, createdBy: { kind: 'system', id: 'embedding-space-ensure' } }
			);
		}
		return {
			status: inserted.length > 0 ? 'registered' : row.status,
			spaceId: definition.id,
			reindex: waiting ? 'already_waiting' : 'enqueued'
		};
	});
}
