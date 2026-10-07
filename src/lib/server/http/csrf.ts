import { timingSafeEqual } from 'node:crypto';

/** Cookie of the browser session (docs/contracts.md, section 5.2). */
export const SESSION_COOKIE = '__Host-session';
export const CSRF_HEADER = 'x-csrf-token';

/** Routes authenticated by a signature of the caller instead of a browser session (contracts 1.5, 7.2). */
export const SIGNED_WEBHOOK_PREFIX = '/api/v1/integrations/';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isUnsafeMethod(method: string): boolean {
	return !SAFE_METHODS.has(method.toUpperCase());
}

export type OriginCheck = { ok: true } | { ok: false; reason: 'origin_mismatch' | 'origin_missing' };

/**
 * Origin check of a state-changing request. A request carrying the session cookie must come from the application
 * origin; a request from another origin is refused even without the cookie (login and registration forms).
 * Webhook routes are authenticated by signature and are not browser requests.
 */
export function checkRequestOrigin(input: {
	method: string;
	pathname: string;
	origin: string | null;
	hasSessionCookie: boolean;
	appOrigin: string;
}): OriginCheck {
	if (!isUnsafeMethod(input.method) || input.pathname.startsWith(SIGNED_WEBHOOK_PREFIX)) return { ok: true };
	if (input.origin === null) {
		return input.hasSessionCookie ? { ok: false, reason: 'origin_missing' } : { ok: true };
	}
	return input.origin === input.appOrigin ? { ok: true } : { ok: false, reason: 'origin_mismatch' };
}

/** Constant-time comparison of the session CSRF token with the `X-CSRF-Token` header. */
export function csrfTokenMatches(expected: string, provided: string | null): boolean {
	if (provided === null) return false;
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(provided, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}
