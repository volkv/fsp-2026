// See https://svelte.dev/docs/kit/types#app.d.ts
import type { Actor } from '$lib/server/access/actor';

declare global {
	/** Application version from package.json, injected at build time. */
	const __APP_VERSION__: string;
	/** Git commit of the build, injected at build time. */
	const __APP_COMMIT__: string;

	namespace App {
		interface Error {
			message: string;
			/** Identifier of the failed request, as in `X-Request-Id` and the journal. */
			requestId: string;
		}
		interface Locals {
			requestId: string;
			actor: Actor;
			/** The request is over its rate limit and the page renders the refusal itself (`refusedByPage`). */
			rateLimited: boolean;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
