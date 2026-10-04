// Glue between the sign-in module and SvelteKit requests: cookies, request metadata and the session of the request.
import { redirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/http/csrf';
import { sessionOfActor } from './authenticate';
import type { RequestMeta } from './context';
import { PENDING_SIGNUP_TTL_SECONDS } from './fsp-signup';
import { FLOW_TTL_SECONDS } from './oidc';
import { SESSION_ABSOLUTE_SECONDS, type SessionRef } from './sessions';

/** Binds an FSP ID flow to the browser that started it (contracts 2.1: state bound to the client). */
export const FSP_FLOW_COOKIE = '__Host-fsp_flow';
/** The held result of a first FSP ID sign-in on its way to the registration form (contracts 2.3). */
export const FSP_SIGNUP_COOKIE = '__Host-fsp_signup';

/**
 * `__Host-` cookies: secure, path `/`, no domain. `lax` keeps them on the top-level return from FSP ID and away from
 * cross-site subrequests.
 */
function options(maxAge: number) {
	return { path: '/', httpOnly: true, secure: true, sameSite: 'lax' as const, maxAge };
}

export function setSessionCookie(cookies: Cookies, sessionId: string): void {
	cookies.set(SESSION_COOKIE, sessionId, options(SESSION_ABSOLUTE_SECONDS));
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, options(0));
}

export function setFlowCookie(cookies: Cookies, state: string): void {
	cookies.set(FSP_FLOW_COOKIE, state, options(FLOW_TTL_SECONDS));
}

export function clearFlowCookie(cookies: Cookies): void {
	cookies.delete(FSP_FLOW_COOKIE, options(0));
}

export function setSignupCookie(cookies: Cookies, token: string): void {
	cookies.set(FSP_SIGNUP_COOKIE, token, options(PENDING_SIGNUP_TTL_SECONDS));
}

export function clearSignupCookie(cookies: Cookies): void {
	cookies.delete(FSP_SIGNUP_COOKIE, options(0));
}

export function requestMeta(event: RequestEvent): RequestMeta {
	return {
		requestId: event.locals.requestId,
		ip: event.getClientAddress(),
		userAgent: event.request.headers.get('user-agent')
	};
}

export function sessionOf(event: RequestEvent): SessionRef | null {
	return sessionOfActor(event.locals.actor);
}

/** The session of the request, or a redirect to the sign-in page that brings the person back here. */
export function requireSession(event: RequestEvent): SessionRef {
	const session = sessionOf(event);
	if (!session) redirect(303, `/login?returnTo=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	return session;
}

/** A text field of a form; a missing field or a file reads as an empty string. */
export function formText(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
}
