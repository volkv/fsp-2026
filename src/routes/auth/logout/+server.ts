import { redirect } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { clearSessionCookie, requestMeta, sessionOf } from '$lib/server/auth/http';
import { signOut } from '$lib/server/auth/signout';
import type { RequestHandler } from './$types';

/** Sign-out of this browser; the CSRF token of the form is checked by the hook. */
export const POST: RequestHandler = async (event) => {
	const session = sessionOf(event);
	if (session) await signOut(await authDeps(), requestMeta(event), session);
	clearSessionCookie(event.cookies);
	redirect(303, '/');
};
