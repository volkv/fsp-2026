// Result and error shapes of the model adapter (docs/contracts.md, sections 0 and 3.5).
// Exceptions do not cross the adapter boundary: every failure is a value with a code and a retry hint.

export type ModelOperation = 'extract' | 'embed' | 'rerank';

export const MODEL_OPERATIONS: readonly ModelOperation[] = ['extract', 'embed', 'rerank'];

/**
 * - `disabled` — the operation is not configured or switched off by an administrator (`details.reason`);
 * - `unavailable` — no connection, connection dropped, 5xx, or the mode store cannot be read;
 * - `timeout` — the operation deadline passed;
 * - `rate_limited` — 429;
 * - `invalid_output` — the response failed validation (for `extract`, after the one allowed retry);
 * - `context_too_long` — the input exceeds the model context;
 * - `space_mismatch` — the model or the vector dimension does not match the embedding space;
 * - `request_rejected` — any other 4xx: the runtime refused the request (credentials, unknown model), or the model
 *   refused to answer (`details.cause: content_filter`);
 * - `cancelled` — the caller aborted the call.
 */
export type ModelErrorCode =
	| 'disabled'
	| 'unavailable'
	| 'timeout'
	| 'rate_limited'
	| 'invalid_output'
	| 'context_too_long'
	| 'space_mismatch'
	| 'request_rejected'
	| 'cancelled';

const RETRYABLE: Record<ModelErrorCode, boolean> = {
	disabled: false,
	unavailable: true,
	timeout: true,
	rate_limited: true,
	invalid_output: false,
	context_too_long: false,
	space_mismatch: false,
	request_rejected: false,
	cancelled: false
};

export interface ModelError {
	code: ModelErrorCode;
	retryable: boolean;
	/** Never contains resume text or other personal data. */
	message: string;
	details?: Record<string, unknown>;
}

export type ModelResult<T> = { ok: true; value: T } | { ok: false; error: ModelError };

export function ok<T>(value: T): ModelResult<T> {
	return { ok: true, value };
}

export function fail(
	code: ModelErrorCode,
	message: string,
	details?: Record<string, unknown>
): { ok: false; error: ModelError } {
	return { ok: false, error: { code, retryable: RETRYABLE[code], message, ...(details ? { details } : {}) } };
}
