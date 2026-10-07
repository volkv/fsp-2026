// Webhooks of external systems under `/api/v1/integrations` (contracts 1.5, 7.2). Their route files serve them with the
// FSP and notification modules; here they are only described, so the document covers every route of the version.
import { z } from 'zod';
import { webhookEventSchema } from '$lib/server/fsp/schema';
import type { ExternalRoute } from '../openapi';

export const fspWebhook: ExternalRoute = {
	id: 'receiveFspWebhook',
	method: 'POST',
	path: '/integrations/fsp/webhooks',
	tag: 'Интеграции',
	summary: 'Вебхук ФСП «достижения обновились»',
	description:
		'Вне сессий и ключей: подпись `X-FSP-Signature: sha256=` HMAC-SHA-256 от `{timestamp}.{rawBody}`, время ' +
		'`X-FSP-Timestamp` (расхождение больше 5 минут — отказ), идентификатор `X-FSP-Event-Id`. Повтор события — `202` ' +
		'без действий; синхронизация идёт заданием.',
	security: 'fspSignature',
	body: webhookEventSchema,
	responses: {
		202: { description: 'Событие принято', schema: z.object({ accepted: z.literal(true) }) },
		401: { description: 'Подпись или время не прошли проверку' }
	}
};

export const telegramWebhook: ExternalRoute = {
	id: 'receiveTelegramUpdate',
	method: 'POST',
	path: '/integrations/telegram/webhook',
	tag: 'Интеграции',
	summary: 'Вебхук бота уведомлений',
	description:
		'Обновления Bot API; секрет — заголовок `X-Telegram-Bot-Api-Secret-Token`. `/start {token}` привязывает чат по ' +
		'одноразовой ссылке, `/stop` отвязывает.',
	security: 'telegramSecret',
	body: z.looseObject({ update_id: z.int() }).describe('Update Telegram Bot API'),
	responses: {
		200: { description: 'Обработано; ответ в чат — методом `sendMessage` в теле ответа' },
		401: { description: 'Нет секрета или он неверен' }
	}
};
