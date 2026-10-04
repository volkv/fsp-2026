// Embedding spaces (docs/domain.md, section 16.2): a vector is meaningful only inside the space it was computed in.
import { eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { embeddingSpaces } from '$lib/server/db/schema';
import { fail, ok, type ModelResult } from './result';

export type EmbeddingSpace = Pick<
	typeof embeddingSpaces.$inferSelect,
	'id' | 'modelName' | 'modelRevision' | 'dimension' | 'queryPrefix' | 'documentPrefix' | 'normalization' | 'status'
>;

export type SpaceLookup = (spaceId: string) => Promise<EmbeddingSpace | null>;

/**
 * Reads spaces from the database. The description of a space never changes (migration 0002 forbids it), so a found
 * row is cached for the life of the process; `status` in the cached row may be stale and is not used here.
 */
export function databaseSpaceLookup(executor: () => Executor): SpaceLookup {
	const cache = new Map<string, EmbeddingSpace>();
	return async (spaceId) => {
		const cached = cache.get(spaceId);
		if (cached) return cached;
		const [row] = await executor()
			.select({
				id: embeddingSpaces.id,
				modelName: embeddingSpaces.modelName,
				modelRevision: embeddingSpaces.modelRevision,
				dimension: embeddingSpaces.dimension,
				queryPrefix: embeddingSpaces.queryPrefix,
				documentPrefix: embeddingSpaces.documentPrefix,
				normalization: embeddingSpaces.normalization,
				status: embeddingSpaces.status
			})
			.from(embeddingSpaces)
			.where(eq(embeddingSpaces.id, spaceId));
		if (!row) return null;
		cache.set(spaceId, row);
		return row;
	};
}

/** A vector together with the space it belongs to. */
export interface SpaceVector {
	spaceId: string;
	vector: readonly number[];
}

/**
 * Cosine similarity of two vectors of the same space. Vectors of different spaces, or of different lengths, are not
 * comparable: the answer is `space_mismatch`, never a number.
 */
export function cosineSimilarity(a: SpaceVector, b: SpaceVector): ModelResult<number> {
	if (a.spaceId !== b.spaceId) {
		return fail('space_mismatch', 'vectors belong to different embedding spaces', {
			left: a.spaceId,
			right: b.spaceId
		});
	}
	if (a.vector.length !== b.vector.length) {
		return fail('space_mismatch', 'vectors of one space differ in dimension', {
			space_id: a.spaceId,
			left: a.vector.length,
			right: b.vector.length
		});
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.vector.length; i++) {
		const x = a.vector[i] ?? 0;
		const y = b.vector[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (normA === 0 || normB === 0) return fail('invalid_output', 'zero vector has no direction');
	return ok(dot / Math.sqrt(normA * normB));
}

/** Unit-length copy of the vector; a zero vector cannot be normalised. */
export function l2Normalize(vector: readonly number[]): number[] | null {
	let sum = 0;
	for (const value of vector) sum += value * value;
	if (sum === 0) return null;
	const norm = Math.sqrt(sum);
	return vector.map((value) => value / norm);
}
