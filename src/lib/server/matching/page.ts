// Cursor pagination of ranked lists (contracts 5.4: `?cursor=&limit=` up to 100, `next_cursor` in the answer). Ranking
// is computed per request, so the cursor is a position bound to the query it was issued for.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '$lib/server/errors/api-error';
import { canonicalJson } from '$lib/server/json/canonical';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

const cursorSchema = z.strictObject({ offset: z.int().nonnegative(), query: z.string().length(16) });

/** A short fingerprint of the query without its cursor and limit. */
export function queryFingerprint(query: unknown): string {
	return createHash('sha256').update(canonicalJson(query)).digest('hex').slice(0, 16);
}

export interface PageRequest {
	limit?: number;
	cursor?: string;
}

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

function invalid(message: string): ApiError {
	return new ApiError('validation_failed', { details: [{ path: 'cursor', code: 'invalid_cursor', message }] });
}

export function paginate<T>(ranked: readonly T[], request: PageRequest, fingerprint: string): Page<T> {
	const limit = request.limit ?? DEFAULT_PAGE_SIZE;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
		throw new ApiError('validation_failed', {
			details: [{ path: 'limit', code: 'out_of_range', message: `Число от 1 до ${MAX_PAGE_SIZE}` }]
		});
	}
	let offset = 0;
	if (request.cursor !== undefined) {
		let decoded: unknown;
		try {
			decoded = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
		} catch {
			throw invalid('Курсор повреждён');
		}
		const cursor = cursorSchema.safeParse(decoded);
		if (!cursor.success) throw invalid('Курсор повреждён');
		if (cursor.data.query !== fingerprint) throw invalid('Курсор выдан для другого запроса');
		offset = cursor.data.offset;
	}
	const items = ranked.slice(offset, offset + limit);
	const next = offset + limit;
	return {
		items,
		nextCursor:
			next < ranked.length
				? Buffer.from(JSON.stringify({ offset: next, query: fingerprint }), 'utf8').toString('base64url')
				: null
	};
}
