import type { RequestEvent } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { requestMeta } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import { requestConsentLetterByRepresentative } from '$lib/server/consent/representative';
import { db } from '$lib/server/db';
import { sessionOfAccount, sessionOfBrowser } from '$lib/server/demo/visit';
import type { Actions } from './$types';

/**
 * The live demo session the browser acts in: that of the signed-in clone, else that of the demo cookie; `null` — none.
 */
async function demoSessionOf(event: RequestEvent, now: Date): Promise<string | null> {
	const { actor } = event.locals;
	if (actor.kind === 'session') {
		const session = await sessionOfAccount(db(), actor.userId, now);
		if (session) return session.id;
	}
	return (await sessionOfBrowser(db(), event.cookies, now))?.id ?? null;
}

/**
 * The legal representative asks for a new letter with the link to the consents (domain 6.4): to sign what is missing or
 * revoke what was given at any time, without waiting for the candidate.
 */
export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		await requestConsentLetterByRepresentative(
			await authDeps(),
			requestMeta(event),
			formText(form, 'email'),
			await demoSessionOf(event, new Date())
		);
		// The same answer for every address: the form does not tell whom the platform knows.
		return { requested: true };
	}
};
