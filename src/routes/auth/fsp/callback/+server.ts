import { redirect } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { fspIdClient } from '$lib/server/auth/fsp-id';
import {
	clearFlowCookie,
	FSP_FLOW_COOKIE,
	requestMeta,
	sessionOf,
	setSessionCookie,
	setSignupCookie
} from '$lib/server/auth/http';
import { completeFspSignIn } from '$lib/server/auth/identities';
import { config } from '$lib/server/config';
import { visitorDemoSessionOf } from '$lib/server/demo/visit';
import { objectStore } from '$lib/server/storage/object-store';
import type { RequestHandler } from './$types';

/** `redirect_uri` of FSP ID (contracts 2.1): completes the flow and signs in, registers or links. */
export const GET: RequestHandler = async (event) => {
	// Over the rate limit the hook lets the request through; the provider is not called. A signed-in person was
	// linking: the account page explains; a visitor goes back to the sign-in page.
	if (event.locals.rateLimited) {
		if (sessionOf(event)) redirect(303, '/account?fsp=failed');
		redirect(303, '/login?error=fsp_rate_limited');
	}
	const client = await fspIdClient();
	if (!client) redirect(303, '/login?error=fsp_not_configured');
	const browserState = event.cookies.get(FSP_FLOW_COOKIE);
	clearFlowCookie(event.cookies);
	const completed = client.ok
		? await client.value.completeAuthorization({ callbackUrl: event.url, browserState })
		: client;
	if (!completed.ok) {
		const { code, message } = completed.error;
		console.error(`[fsp-id] request ${event.locals.requestId}: sign-in not completed: ${code} ${message}`);
		// A signed-in person was linking: the account page explains; a visitor goes back to the sign-in page.
		if (sessionOf(event)) redirect(303, '/account?fsp=failed');
		const reason = code === 'unavailable' || code === 'access_denied' || code === 'state_invalid' ? code : 'failed';
		redirect(303, `/login?error=fsp_${reason}`);
	}

	const current = sessionOf(event);
	const meta = requestMeta(event);
	let outcome;
	try {
		const deps = await authDeps();
		// On a demonstration stand an athlete without an account signs in within the browser's demo session (domain 19.3).
		const demoSession =
			config().demo === null
				? null
				: visitorDemoSessionOf(
						{ ...deps, store: objectStore() },
						{ cookies: event.cookies, address: event.getClientAddress(), meta }
					);
		outcome = await completeFspSignIn(deps, meta, completed.value, current, demoSession);
	} catch (cause) {
		// The provider has answered, but the account could not be read or written: the browser goes back with an
		// explanation, the cause stays in the log under the request id.
		console.error(`[fsp-id] request ${event.locals.requestId}: sign-in not completed: storage failed`, cause);
		if (current) redirect(303, '/account?fsp=failed');
		redirect(303, '/login?error=fsp_failed');
	}
	if (outcome.kind === 'signed_in') {
		setSessionCookie(event.cookies, outcome.sessionId);
		redirect(303, outcome.returnTo);
	}
	if (outcome.kind === 'signup') {
		setSignupCookie(event.cookies, outcome.pendingToken);
		redirect(303, '/register');
	}
	if (outcome.kind === 'linked') redirect(303, '/account?fsp=linked');
	if (outcome.reason === 'account_inactive') redirect(303, '/login?error=fsp_account_inactive');
	// The heroes of the demo scenario and their clones are entered at `/demo`, which explains why; it explains as well
	// why the demo session to sign in within was not opened.
	switch (outcome.reason) {
		case 'demo_account':
		case 'address_budget':
		case 'stand_full':
		case 'not_seeded':
			redirect(303, `/demo?fsp=${outcome.reason}`);
	}
	redirect(303, `/account?fsp=${outcome.reason}`);
};
