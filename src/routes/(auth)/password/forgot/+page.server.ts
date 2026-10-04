import { authDeps } from '$lib/server/auth/context';
import { formText } from '$lib/server/auth/http';
import { requestPasswordReset } from '$lib/server/auth/recovery';
import { config } from '$lib/server/config';
import { sessionOfBrowser } from '$lib/server/demo/visit';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const deps = await authDeps();
		// On a demonstration stand an account registered within the browser's demo session is found there (domain 19.3).
		const demoSession = config().demo === null ? null : await sessionOfBrowser(deps.db, event.cookies, deps.now());
		await requestPasswordReset(deps, formText(form, 'email'), demoSession?.id ?? null);
		// The same answer for every address: the form does not tell which ones are registered. A browser with a demo
		// session is told where the letter of an account of the session is read: the letters page of the session.
		return { requested: true, inDemoSession: demoSession !== null };
	}
};
