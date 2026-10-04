import { telegramDeps } from '$lib/server/notifications/deps';
import { receiveTelegramUpdate } from '$lib/server/notifications/telegram';
import type { RequestHandler } from './$types';

/** Updates of the notification bot (docs/contracts.md, section 8.2): authenticated by the secret header. */
export const POST: RequestHandler = async ({ request, locals, getClientAddress }) =>
	receiveTelegramUpdate(telegramDeps(), {
		headers: request.headers,
		body: await request.text(),
		meta: { requestId: locals.requestId, ip: getClientAddress(), userAgent: request.headers.get('user-agent') }
	});
