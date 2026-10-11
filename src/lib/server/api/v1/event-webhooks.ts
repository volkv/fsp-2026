// The outgoing events of a company as the API document describes them (`webhooks`): one request per event type, its
// body built from the very schemas that type the emitting code (`events/payloads.ts`), and the signature scheme.
import { z } from 'zod';
import { COMPANY_EVENT_TYPES } from '$lib/server/db/schema';
import { EVENT_DATA, INVITATION_EVENTS, PING_DATA } from '$lib/server/events/payloads';
import type { OutgoingWebhook } from '../openapi';
import { dateTime, pseudonym } from '../schemas';

export const EVENT_MEANINGS = {
	'invitation.sent': 'компания отправила предложение или новую версию его условий',
	'invitation.viewed': 'кандидат открыл предложение',
	'invitation.accepted': 'кандидат принял версию условий предложения',
	'invitation.declined': 'кандидат отклонил версию условий (с кодом причины)',
	'invitation.expired': 'срок ответа на предложение истёк',
	'invitation.withdrawn': 'предложение отозвано: компанией, закрытием вакансии или приостановкой компании',
	'contacts.disclosed': 'кандидат раскрыл компании контакты (поля — в событии, значения — по API)',
	'hiring.reported': 'сторона сообщила этап или исход найма',
	'application.received': 'кандидат откликнулся на вакансию компании',
	'application.status_changed': 'отклик сменил статус: просмотрен, приглашён, отклонён, отозван кандидатом',
	'vacancy.published': 'вакансия опубликована (впервые, после модерации или после паузы)',
	'vacancy.closed': 'вакансия закрыта'
} as const satisfies Record<(typeof COMPANY_EVENT_TYPES)[number], string>;

/** How a receiver checks a request: the text of the API document and of the interface. */
export const SIGNATURE_DESCRIPTION = [
	'Подпись — по спецификации Standard Webhooks. Заголовки: `webhook-id` (id события; одинаков при повторах и ручном ',
	'повторе — по нему получатель отбрасывает дубли), `webhook-timestamp` (секунды Unix), `webhook-signature` — ',
	'`v1,<base64(HMAC-SHA-256(ключ, "{webhook-id}.{webhook-timestamp}.{тело}"))>`, где ключ — байты base64-части ',
	'секрета `whsec_…`. Во время ротации секрета подписей две, через пробел: подходит любая. Получатель сравнивает ',
	'подпись за постоянное время и отвергает расхождение времени больше 5 минут.\n\n',
	'Проверка на Node.js:\n\n',
	'```js\n',
	"import { createHmac, timingSafeEqual } from 'node:crypto';\n",
	'function verify(secret, headers, rawBody) {\n',
	"  const id = headers['webhook-id'], ts = headers['webhook-timestamp'];\n",
	'  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;\n',
	"  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');\n",
	"  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();\n",
	"  return headers['webhook-signature'].split(' ').some((s) => {\n",
	"    const given = Buffer.from(s.slice(s.indexOf(',') + 1), 'base64');\n",
	"    return s.startsWith('v1,') && given.length === expected.length && timingSafeEqual(given, expected);\n",
	'  });\n',
	'}\n',
	'```\n\n',
	'Подходят и готовые библиотеки Standard Webhooks (`standardwebhooks` для JS, Python, Go, PHP и других).'
].join('');

const HEADERS = {
	'webhook-id': 'Id события: один и тот же при повторах доставки',
	'webhook-timestamp': 'Момент отправки, секунды Unix',
	'webhook-signature': 'Подписи `v1,<base64>` через пробел'
};

function envelope(type: string, data: z.ZodObject, withPseudonym: boolean) {
	return z
		.object({
			id: z.uuid().describe('Id события, равен `webhook-id`'),
			type: z.literal(type),
			occurred_at: dateTime.describe('Когда произошло событие'),
			company_id: z.uuid().describe('Компания-получатель'),
			data: withPseudonym ? data.extend({ candidate_pseudonym: pseudonym }) : data
		})
		.meta({ id: `Event_${type.replace('.', '_')}` });
}

const isInvitationEvent = (type: string) => (INVITATION_EVENTS as readonly string[]).includes(type);

export const OUTGOING_WEBHOOKS: readonly OutgoingWebhook[] = [
	...COMPANY_EVENT_TYPES.map((type) => ({
		name: type,
		summary: EVENT_MEANINGS[type],
		description:
			'Только идентификаторы, статусы и моменты; контакты кандидата событие не переносит — раскрытые компании ' +
			'читаются по API ключом с правом `invitation.read` или `application.manage`, с проверкой согласия и журналом.' +
			(isInvitationEvent(type) ? ' Кандидат назван псевдонимом для вашей компании.' : '') +
			'\n\n' +
			SIGNATURE_DESCRIPTION,
		headers: HEADERS,
		body: envelope(type, EVENT_DATA[type], isInvitationEvent(type))
	})),
	{
		name: 'ping',
		summary: 'проверочное событие из кабинета или API',
		description: SIGNATURE_DESCRIPTION,
		headers: HEADERS,
		body: envelope('ping', PING_DATA, false)
	}
];
