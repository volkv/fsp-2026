import { API_ERRORS, POLICY_VIOLATION_CODES, type ApiErrorCode, type PolicyViolationCode } from './codes';
import { loggedError } from '$lib/server/db/errors';

export interface ErrorDetail {
	/** Field path in the request, when the detail is about a field. */
	path?: string;
	code: string;
	message: string;
}

export interface ErrorEnvelope {
	error: {
		code: ApiErrorCode;
		message: string;
		request_id: string;
		details?: ErrorDetail[];
	};
}

/** An error the API reports to the client as is: code, HTTP status and a message without internal detail. */
export class ApiError extends Error {
	override name = 'ApiError';
	readonly code: ApiErrorCode;
	readonly details: ErrorDetail[] | undefined;
	/** Seconds for `Retry-After` of `rate_limited` and `degraded`. */
	readonly retryAfterSeconds: number | undefined;

	constructor(
		code: ApiErrorCode,
		options: { message?: string; details?: ErrorDetail[]; retryAfterSeconds?: number; cause?: unknown } = {}
	) {
		super(options.message ?? API_ERRORS[code].message, { cause: options.cause });
		this.code = code;
		this.details = options.details;
		this.retryAfterSeconds = options.retryAfterSeconds;
	}

	get status(): number {
		return API_ERRORS[this.code].status;
	}
}

/** `422 policy_violation` with one detail from the registry. */
export function policyViolation(code: PolicyViolationCode, path?: string): ApiError {
	return new ApiError('policy_violation', {
		details: [{ ...(path === undefined ? {} : { path }), code, message: POLICY_VIOLATION_CODES[code] }]
	});
}

export function errorEnvelope(error: ApiError, requestId: string): ErrorEnvelope {
	return {
		error: {
			code: error.code,
			message: error.message,
			request_id: requestId,
			...(error.details === undefined ? {} : { details: error.details })
		}
	};
}

/**
 * JSON response for an error raised while serving an API request. An `ApiError` is reported with its code;
 * anything else is an internal error: it is logged with the request id and the client sees only `internal`.
 */
export function errorResponse(error: unknown, requestId: string): Response {
	const apiError = error instanceof ApiError ? error : new ApiError('internal', { cause: error });
	if (apiError.code === 'internal') {
		console.error(`[api] request ${requestId} failed`, loggedError(error));
	}
	const headers = new Headers({
		'content-type': 'application/json',
		'cache-control': 'no-store',
		'x-request-id': requestId
	});
	if (apiError.retryAfterSeconds !== undefined) {
		headers.set('retry-after', String(apiError.retryAfterSeconds));
	}
	return new Response(JSON.stringify(errorEnvelope(apiError, requestId)), { status: apiError.status, headers });
}
