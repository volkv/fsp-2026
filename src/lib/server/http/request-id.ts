import { uuidv7 } from '$lib/server/ids';

/**
 * Identifier of one request: returned in `X-Request-Id`, in the error envelope and in journal records.
 * Always generated here; a client-supplied value is not trusted.
 */
export function newRequestId(): string {
	return uuidv7();
}
