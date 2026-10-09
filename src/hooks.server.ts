import { dev } from '$app/environment';
import type { Handle, HandleServerError, RequestEvent, ServerInit } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { CSRF_FIELD } from '$lib/components/shell/viewer';
import { annulStaleAttempts } from '$lib/server/assessments/annul';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { withTimeout } from '$lib/server/async/timeout';
import { authenticateSession } from '$lib/server/auth/authenticate';
import { clearSessionCookie } from '$lib/server/auth/http';
import { authenticateApiKey } from '$lib/server/companies/api-keys';
import { config } from '$lib/server/config';
import { closeDb, db } from '$lib/server/db';
import { ApiError, errorResponse } from '$lib/server/errors/api-error';
import {
	checkRequestOrigin,
	csrfTokenMatches,
	CSRF_HEADER,
	isUnsafeMethod,
	SESSION_COOKIE,
	SIGNED_WEBHOOK_PREFIX
} from '$lib/server/http/csrf';
import { rateLimitHandles, redisRateLimitStore } from '$lib/server/http/rate-limit';
import { newRequestId } from '$lib/server/http/request-id';
import { applySecurityHeaders } from '$lib/server/http/security-headers';
import { closeRedis, redis } from '$lib/server/redis';
import { loggedError } from '$lib/server/db/errors';

/**
 * Before the first request: attempts still running on a bank release whose code is no longer on disk are annulled
 * (domain 10.5) — the release script of this start withdrew or replaced it, and the attempt cannot go on.
 */
async function annulAttemptsOnStaleReleases(): Promise<void> {
	for (const stale of await annulStaleAttempts(db(), OWNER_STANDING, new Date())) {
		console.warn(
			`[bank] release ${stale.releaseId} is not the code of the bank tree (${stale.drift.join('; ')}): ` +
				`${stale.annulled.length} attempts in progress annulled for version_defect, a free retake`
		);
	}
}

export const init: ServerInit = async () => {
	await annulAttemptsOnStaleReleases();
	if (dev) return;
	// adapter-node emits this after the HTTP server has stopped accepting connections.
	process.on('sveltekit:shutdown', () => {
		closeRedis();
		closeDb().catch((error: unknown) => {
			console.error('[shutdown] failed to close database connections', loggedError(error));
			process.exitCode = 1;
		});
	});
};

/** How long a request waits for Redis before it is answered with `503 degraded`. */
const REDIS_WAIT_MS = 1_000;

/** Request id and security headers on every response, including errors of the later steps. */
const identifyRequest: Handle = async ({ event, resolve }) => {
	event.locals.requestId = newRequestId();
	const response = await resolve(event);
	response.headers.set('x-request-id', event.locals.requestId);
	applySecurityHeaders(response.headers, {
		https: config().appOrigin.startsWith('https:'),
		api: event.url.pathname.startsWith('/api/')
	});
	return response;
};

/**
 * Limits of the request rate (src/lib/server/http/rate-limit.ts), counted in Redis: per address before anything else,
 * per account once the actor is known.
 */
const rateLimits = rateLimitHandles({
	store: async () => redisRateLimitStore(await withTimeout(redis(), REDIS_WAIT_MS, 'redis')),
	waitMs: REDIS_WAIT_MS
});

/** State-changing requests come from the application origin (docs/contracts.md, section 5.2). */
const checkOrigin: Handle = ({ event, resolve }) => {
	const check = checkRequestOrigin({
		method: event.request.method,
		pathname: event.url.pathname,
		origin: event.request.headers.get('origin'),
		hasSessionCookie: event.cookies.get(SESSION_COOKIE) !== undefined,
		appOrigin: config().appOrigin
	});
	if (!check.ok) {
		return errorResponse(new ApiError('csrf_failed'), event.locals.requestId);
	}
	return resolve(event);
};

const BEARER = /^Bearer (\S+)$/;

/** Routes a key may call: the public API, except the webhooks, which are authenticated by the caller's signature. */
function acceptsApiKey(pathname: string): boolean {
	return pathname.startsWith('/api/v1/') && !pathname.startsWith(SIGNED_WEBHOOK_PREFIX);
}

/**
 * A request of the public API with `Authorization` is authenticated by the key alone (contracts 5.2): the key, its
 * creator's membership and the company are checked on every request, and the actor carries the key's permissions,
 * which the operation checks. A header that is not a valid key is `401` without saying why; a session cookie next to
 * it is not consulted.
 */
async function authenticateBearer(event: RequestEvent, header: string): Promise<Response | null> {
	const token = BEARER.exec(header)?.[1];
	const actor = token === undefined ? null : await authenticateApiKey(db(), token, new Date());
	if (!actor) {
		const response = errorResponse(
			new ApiError('unauthenticated', { message: 'Ключ API не принят' }),
			event.locals.requestId
		);
		response.headers.set('www-authenticate', 'Bearer');
		return response;
	}
	event.locals.actor = actor;
	return null;
}

/**
 * Establishes `locals.actor` from the API key of a public API request or from the session cookie (domain 3.4). A
 * cookie whose session is gone is dropped; the account behind a live session is checked on every request.
 */
const authenticate: Handle = async ({ event, resolve }) => {
	event.locals.actor = { kind: 'anonymous' };
	const authorization = event.request.headers.get('authorization');
	if (authorization !== null && acceptsApiKey(event.url.pathname)) {
		const refused = await authenticateBearer(event, authorization);
		return refused ?? resolve(event);
	}
	const sessionId = event.cookies.get(SESSION_COOKIE);
	if (sessionId === undefined) return resolve(event);
	let actor;
	try {
		const client = await withTimeout(redis(), REDIS_WAIT_MS, 'redis');
		actor = await withTimeout(
			authenticateSession({ db: db(), redis: client, now: () => new Date() }, sessionId),
			REDIS_WAIT_MS * 3,
			'session lookup'
		);
	} catch (cause) {
		console.error(`[auth] request ${event.locals.requestId}: session store unavailable`, loggedError(cause));
		return errorResponse(new ApiError('degraded', { cause, retryAfterSeconds: 5 }), event.locals.requestId);
	}
	if (actor) event.locals.actor = actor;
	else clearSessionCookie(event.cookies);
	return resolve(event);
};

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data'];

/** The token of a request: the `X-CSRF-Token` header, or the hidden field of a form post. */
async function presentedCsrfToken(request: Request): Promise<string | null> {
	const header = request.headers.get(CSRF_HEADER);
	if (header !== null) return header;
	const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
	if (!FORM_TYPES.includes(type)) return null;
	// The body is read from a copy: the route reads the original.
	let form: FormData;
	try {
		form = await request.clone().formData();
	} catch (error) {
		// A body that is not a form carries no token: the request is refused as one without it.
		if (error instanceof TypeError) return null;
		throw error;
	}
	const field = form.get(CSRF_FIELD);
	return typeof field === 'string' ? field : null;
}

/** A session-authenticated state-changing request echoes the session CSRF token. */
const checkCsrfToken: Handle = async ({ event, resolve }) => {
	const { actor } = event.locals;
	if (
		actor.kind === 'session' &&
		isUnsafeMethod(event.request.method) &&
		!csrfTokenMatches(actor.csrfToken, await presentedCsrfToken(event.request))
	) {
		return errorResponse(new ApiError('csrf_failed'), event.locals.requestId);
	}
	return resolve(event);
};

export const handle: Handle = sequence(
	identifyRequest,
	rateLimits.byAddress,
	checkOrigin,
	authenticate,
	rateLimits.byAccount,
	checkCsrfToken
);

export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const requestId = (event.locals as Partial<App.Locals>).requestId ?? 'unassigned';
	if (status >= 500) {
		console.error(`[server] request ${requestId} failed`, loggedError(error));
		return { message: 'Внутренняя ошибка', requestId };
	}
	return { message, requestId };
};
