import { DOCS_CSP, DOCS_HTML } from '$lib/server/api/docs';
import type { RequestHandler } from './$types';

/** Swagger UI of the public API (docs/contracts.md, section 5.1). */
export const GET: RequestHandler = () =>
	new Response(DOCS_HTML, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'content-security-policy': DOCS_CSP,
			'cache-control': 'no-cache'
		}
	});
