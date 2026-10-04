import { redirect } from '@sveltejs/kit';
import { fspIdClient } from '$lib/server/auth/fsp-id';
import { setFlowCookie } from '$lib/server/auth/http';
import { safeReturnTo } from '$lib/server/auth/redirect';
import type { RequestHandler } from './$types';

/**
 * «Войти через ФСП ID» (contracts 2.3): starts the authorization and sends the browser to the provider.
 * `?reauth=1` asks the provider for a new login — the fresh authentication of a sensitive operation.
 */
export const GET: RequestHandler = async ({ url, cookies, locals }) => {
	// Over the rate limit the hook lets the request through: the sign-in page explains the refusal in the layout.
	if (locals.rateLimited) redirect(303, '/login?error=fsp_rate_limited');
	const client = await fspIdClient();
	if (!client) redirect(303, '/login?error=fsp_not_configured');
	const started = client.ok
		? await client.value.startAuthorization({
				intent: 'login',
				returnTo: safeReturnTo(url.searchParams.get('returnTo')) ?? '/onboarding',
				reauthenticate: url.searchParams.get('reauth') === '1'
			})
		: client;
	if (!started.ok) {
		const { code, message } = started.error;
		console.error(`[fsp-id] request ${locals.requestId}: sign-in not started: ${code} ${message}`);
		// The provider is blamed only when it is the provider that failed; a failure of ours reads as one to retry.
		redirect(303, `/login?error=${code === 'store_unavailable' ? 'fsp_failed' : 'fsp_unavailable'}`);
	}
	setFlowCookie(cookies, started.value.state);
	redirect(303, started.value.redirectUrl);
};
