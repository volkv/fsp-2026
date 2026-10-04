import { describe, expect, it, vi } from 'vitest';
import { ApiError, errorEnvelope, errorResponse, policyViolation } from './api-error';
import { API_ERRORS } from './codes';

describe('API error envelope', () => {
	it('maps every code to the status of the contract', () => {
		expect(Object.fromEntries(Object.entries(API_ERRORS).map(([code, spec]) => [code, spec.status]))).toEqual({
			validation_failed: 400,
			unauthenticated: 401,
			forbidden: 403,
			csrf_failed: 403,
			not_found: 404,
			conflict: 409,
			idempotency_conflict: 409,
			policy_violation: 422,
			rate_limited: 429,
			internal: 500,
			degraded: 503
		});
	});

	it('carries code, message, request id and details', () => {
		expect(errorEnvelope(policyViolation('vacancy_not_invitable', 'vacancy_id'), 'req-1')).toEqual({
			error: {
				code: 'policy_violation',
				message: API_ERRORS.policy_violation.message,
				request_id: 'req-1',
				details: [{ path: 'vacancy_id', code: 'vacancy_not_invitable', message: expect.any(String) as string }]
			}
		});
	});

	it('answers an ApiError with its status and Retry-After', async () => {
		const response = errorResponse(new ApiError('rate_limited', { retryAfterSeconds: 30 }), 'req-2');
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('30');
		expect(response.headers.get('x-request-id')).toBe('req-2');
		expect(await response.json()).toMatchObject({ error: { code: 'rate_limited', request_id: 'req-2' } });
	});

	it('hides an unexpected error behind `internal` and logs it', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const response = errorResponse(new Error('connection to 10.0.0.5 refused'), 'req-3');
		expect(response.status).toBe(500);
		const body = JSON.stringify(await response.json());
		expect(body).toContain('"code":"internal"');
		expect(body).not.toContain('10.0.0.5');
		expect(log).toHaveBeenCalledOnce();
		log.mockRestore();
	});
});
