import { db } from '$lib/server/db';
import { fspIntegration } from '$lib/server/fsp/integration';
import { receiveFspWebhook } from '$lib/server/fsp/webhook';
import type { RequestHandler } from './$types';

/** Webhook «achievements updated» of the FSP source (docs/contracts.md, section 1.5): authenticated by signature. */
export const POST: RequestHandler = async ({ request, locals, getClientAddress }) =>
	receiveFspWebhook(db(), fspIntegration().source, {
		headers: request.headers,
		rawBody: new Uint8Array(await request.arrayBuffer()),
		requestId: locals.requestId,
		ip: getClientAddress(),
		userAgent: request.headers.get('user-agent')
	});
