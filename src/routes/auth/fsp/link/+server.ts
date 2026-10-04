import { redirect } from '@sveltejs/kit';
import { fspIdClient } from '$lib/server/auth/fsp-id';
import { requireSession, setFlowCookie } from '$lib/server/auth/http';
import { isFreshAuth } from '$lib/server/auth/sessions';
import type { RequestHandler } from './$types';

/**
 * Linking FSP ID to the signed-in account (contracts 2.4): the local side is a fresh authentication, the external
 * side a new login at the provider; the user id travels with the flow and is compared on return.
 */
export const POST: RequestHandler = async (event) => {
	const session = requireSession(event);
	if (!isFreshAuth(session.authTime, new Date())) redirect(303, '/account/reauth?returnTo=%2Faccount');
	const client = await fspIdClient();
	if (!client) redirect(303, '/account');
	const started = client.ok
		? await client.value.startAuthorization({ intent: 'link', forUserId: session.userId, returnTo: '/account' })
		: client;
	if (!started.ok) {
		const { code, message } = started.error;
		console.error(`[fsp-id] request ${event.locals.requestId}: linking not started: ${code} ${message}`);
		redirect(303, '/account?fsp=failed');
	}
	setFlowCookie(event.cookies, started.value.state);
	redirect(303, started.value.redirectUrl);
};
