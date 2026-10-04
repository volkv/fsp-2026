// Refusals of invitation and hiring actions. The client sees the public code of the API (contracts 5.3); the reason
// is internal: it goes to the journal and to the tests, never to the response (a `canShow` refusal is `404` for
// any reason, domain 7.4).
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { POLICY_VIOLATION_CODES, type ApiErrorCode, type PolicyViolationCode } from '$lib/server/errors/codes';

export class Refusal extends ApiError {
	override name = 'Refusal';
	readonly reason: string;

	constructor(code: ApiErrorCode, reason: string, options: { details?: ErrorDetail[] } = {}) {
		super(code, options);
		this.reason = reason;
	}
}

export const refuse = (code: ApiErrorCode, reason: string, details?: ErrorDetail[]): Refusal =>
	new Refusal(code, reason, details === undefined ? {} : { details });

/** `422 policy_violation` with one detail of the registry; the detail code is the reason. */
export const violation = (code: PolicyViolationCode, path?: string): Refusal =>
	new Refusal('policy_violation', code, {
		details: [{ ...(path === undefined ? {} : { path }), code, message: POLICY_VIOLATION_CODES[code] }]
	});

export const invalid = (path: string, message: string): Refusal =>
	new Refusal('validation_failed', 'validation_failed', { details: [{ path, code: 'invalid', message }] });
