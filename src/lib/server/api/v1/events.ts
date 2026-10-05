// Outgoing events of a company (domain 5.7; contracts 13): webhook subscriptions with HMAC signatures, the Huntflow
// adapter, the rotation of secrets, a test delivery and the journal of deliveries. Operations of the owner in a browser
// session: keys never manage subscriptions, which hold secrets.
import { z } from 'zod';
import { config } from '$lib/server/config';
import { COMPANY_EVENT_TYPES } from '$lib/server/db/schema';
import {
	connectHuntflow,
	createWebhook,
	deleteSubscription,
	listDeliveries,
	listSubscriptions,
	rotateSecret,
	sendPing,
	updateSubscription,
	type DeliveryView,
	type SubscriptionDeps,
	type SubscriptionSummary
} from '$lib/server/events/subscriptions';
import { defineOperation } from '../operation';
import { dateTime, id, iso, isoOrNull } from '../schemas';
import type { ApiServices } from '../services';
import { actionContext } from './context';

const TAG = 'События для ATS';

const EVENT_MEANINGS = {
	'invitation.accepted': 'кандидат принял версию условий предложения',
	'invitation.declined': 'кандидат отклонил версию условий (с кодом причины)',
	'invitation.expired': 'срок ответа на предложение истёк',
	'contacts.disclosed': 'кандидат раскрыл компании контакты (поля — в событии, значения — по API)',
	'hiring.reported': 'сторона сообщила этап или исход найма',
	'application.received': 'кандидат откликнулся на вакансию компании'
} as const satisfies Record<(typeof COMPANY_EVENT_TYPES)[number], string>;

const eventType = z.enum(COMPANY_EVENT_TYPES).describe(
	'Событие: ' +
		Object.entries(EVENT_MEANINGS)
			.map(([key, meaning]) => `\`${key}\` — ${meaning}`)
			.join('; ')
);

const deps = (s: ApiServices): SubscriptionDeps => ({
	db: s.db,
	crypto: s.crypto,
	now: s.now,
	huntflowApiUrl: config().huntflowApiUrl
});

const statusId = z.int().positive();
const huntflowSettings = z
	.strictObject({
		account_id: z.int().positive().describe('Аккаунт организации в Хантфлоу'),
		vacancy_id: z.int().positive().describe('Вакансия Хантфлоу, на которую попадают кандидаты'),
		statuses: z
			.strictObject({
				accepted: statusId.describe('Статус кандидата после принятия предложения'),
				interview_scheduled: statusId.optional(),
				interview_done: statusId.optional(),
				offer_made: statusId.optional(),
				offer_accepted: statusId.optional(),
				hired: statusId.optional(),
				not_hired: statusId.optional()
			})
			.describe('Статусы Хантфлоу для этапов платформы; этап без статуса в Хантфлоу не передаётся')
	})
	.meta({ id: 'HuntflowSettings', description: 'Сопоставление компании с её аккаунтом Хантфлоу' });

const subscriptionSchema = z
	.object({
		id: z.uuid(),
		target: z.enum(['webhook', 'huntflow']),
		name: z.string(),
		url: z.string().nullable().describe('Адрес вебхука; у Хантфлоу — `null`'),
		events: z.array(eventType),
		status: z.enum(['active', 'paused']),
		secret_hint: z.string().describe('Последние символы секрета или токена'),
		previous_secret_until: dateTime.nullable().describe('До этого момента подпись идёт и прежним секретом'),
		huntflow: huntflowSettings.nullable(),
		created_at: dateTime
	})
	.meta({ id: 'EventSubscription', description: 'Подписка компании на события без секрета' });

const view = (s: SubscriptionSummary) => ({
	id: s.id,
	target: s.target,
	name: s.name,
	url: s.url,
	events: s.events,
	status: s.status,
	secret_hint: s.secretHint,
	previous_secret_until: isoOrNull(s.previousSecretUntil),
	huntflow: s.huntflow,
	created_at: iso(s.createdAt)
});

const deliverySchema = z
	.object({
		id: z.uuid(),
		event_id: z.uuid(),
		event_type: z.string(),
		status: z.enum(['queued', 'delivered', 'failed', 'skipped']),
		attempts: z.int(),
		last_status: z.int().nullable().describe('HTTP-статус последнего ответа'),
		last_error: z.string().nullable(),
		occurred_at: dateTime,
		delivered_at: dateTime.nullable()
	})
	.meta({ id: 'EventDelivery', description: 'Доставка события подписке' });

const deliveryView = (d: DeliveryView) => ({
	id: d.id,
	event_id: d.eventId,
	event_type: d.eventType,
	status: d.status,
	attempts: d.attempts,
	last_status: d.lastStatus,
	last_error: d.lastError,
	occurred_at: iso(d.occurredAt),
	delivered_at: isoOrNull(d.deliveredAt)
});

const companyParams = z.strictObject({ company_id: id('Компания') });
const subscriptionParams = companyParams.extend({ subscription_id: id('Подписка') });

export const listEventSubscriptions = defineOperation({
	id: 'listEventSubscriptions',
	method: 'GET',
	path: '/companies/{company_id}/event-subscriptions',
	tag: TAG,
	summary: 'Подписки на события',
	auth: 'session',
	permission: 'company.events.manage',
	params: companyParams,
	errors: ['not_found'],
	response: { status: 200, description: 'Подписки', schema: z.object({ items: z.array(subscriptionSchema) }) },
	async handle(ctx) {
		const items = await listSubscriptions(deps(ctx.services), await actionContext(ctx), ctx.params.company_id);
		return { items: items.map(view) };
	}
});

export const createEventWebhook = defineOperation({
	id: 'createEventWebhook',
	method: 'POST',
	path: '/companies/{company_id}/event-subscriptions',
	tag: TAG,
	summary: 'Зарегистрировать вебхук',
	description:
		'Платформа отправляет `POST` с телом `{id, type, occurred_at, company_id, data}` — только идентификаторы и коды, ' +
		'данные интеграция читает по API своим ключом. Заголовки: `X-Event-Id`, `X-Event-Type`, `X-Timestamp` (секунды ' +
		'Unix), `X-Signature: sha256=<HMAC-SHA-256 секретом от "{timestamp}.{тело}">` — во время ротации через запятую ' +
		'две подписи. Получатель отвергает расхождение времени больше 5 минут и повторный `X-Event-Id`. Ответ `2xx` — ' +
		'доставлено; сеть, `429` и `5xx` — повторы через 1, 5, 15 минут, 1, 2, 4 и 6 часов; другой `4xx` — отказ. ' +
		'Адрес — `https://` во внешней сети. Секрет возвращается один раз.',
	auth: 'session',
	permission: 'company.events.manage',
	params: companyParams,
	body: z.strictObject({ name: z.string(), url: z.string(), events: z.array(eventType).min(1) }),
	errors: ['not_found'],
	response: {
		status: 201,
		description: 'Вебхук зарегистрирован',
		schema: z.object({
			subscription: subscriptionSchema,
			secret: z.string().describe('Секрет подписи; больше не показывается')
		})
	},
	async handle(ctx) {
		const created = await createWebhook(deps(ctx.services), await actionContext(ctx), ctx.params.company_id, ctx.body);
		return { subscription: view(created.subscription), secret: created.secret };
	}
});

export const connectEventHuntflow = defineOperation({
	id: 'connectEventHuntflow',
	method: 'POST',
	path: '/companies/{company_id}/event-subscriptions/huntflow',
	tag: TAG,
	summary: 'Подключить Хантфлоу',
	description:
		'Адаптер Хантфлоу: по `invitation.accepted` создаёт кандидата в аккаунте компании из раскрытых ей контактов и ' +
		'ставит его на вакансию в статус `statuses.accepted`; по этапу или исходу, о котором сообщила компания, переводит в ' +
		'сопоставленный статус. Токен API Хантфлоу хранится зашифрованным. Стенд без `HUNTFLOW_API_URL` — `409` ' +
		'(`huntflow_disabled`).',
	auth: 'session',
	permission: 'company.events.manage',
	params: companyParams,
	body: z.strictObject({ name: z.string(), token: z.string(), settings: huntflowSettings }),
	errors: ['not_found', 'conflict'],
	response: { status: 201, description: 'Хантфлоу подключён', schema: subscriptionSchema },
	async handle(ctx) {
		return view(await connectHuntflow(deps(ctx.services), await actionContext(ctx), ctx.params.company_id, ctx.body));
	}
});

export const updateEventSubscription = defineOperation({
	id: 'updateEventSubscription',
	method: 'PATCH',
	path: '/companies/{company_id}/event-subscriptions/{subscription_id}',
	tag: TAG,
	summary: 'Изменить подписку',
	description: 'Название, пауза; у вебхука — адрес и события. На паузе события не отправляются (доставки — `skipped`).',
	auth: 'session',
	permission: 'company.events.manage',
	params: subscriptionParams,
	body: z.strictObject({
		name: z.string().optional(),
		url: z.string().optional(),
		events: z.array(eventType).min(1).optional(),
		status: z.enum(['active', 'paused']).optional()
	}),
	errors: ['not_found'],
	response: { status: 200, description: 'Подписка', schema: subscriptionSchema },
	async handle(ctx) {
		const { name, url, events, status } = ctx.body;
		return view(
			await updateSubscription(
				deps(ctx.services),
				await actionContext(ctx),
				ctx.params.company_id,
				ctx.params.subscription_id,
				{
					...(name === undefined ? {} : { name }),
					...(url === undefined ? {} : { url }),
					...(events === undefined ? {} : { events }),
					...(status === undefined ? {} : { status })
				}
			)
		);
	}
});

export const deleteEventSubscription = defineOperation({
	id: 'deleteEventSubscription',
	method: 'DELETE',
	path: '/companies/{company_id}/event-subscriptions/{subscription_id}',
	tag: TAG,
	summary: 'Удалить подписку',
	description: 'Вместе с журналом доставок.',
	auth: 'session',
	permission: 'company.events.manage',
	params: subscriptionParams,
	errors: ['not_found'],
	response: { status: 204, description: 'Удалена' },
	async handle(ctx) {
		await deleteSubscription(
			deps(ctx.services),
			await actionContext(ctx),
			ctx.params.company_id,
			ctx.params.subscription_id
		);
	}
});

export const rotateEventSecret = defineOperation({
	id: 'rotateEventSecret',
	method: 'POST',
	path: '/companies/{company_id}/event-subscriptions/{subscription_id}/secret',
	tag: TAG,
	summary: 'Сменить секрет',
	description:
		'Вебхук получает новый секрет (возвращается один раз); прежний ещё сутки подписывает события вместе с новым. ' +
		'Хантфлоу — новый токен в `token`, прежний перестаёт использоваться сразу.',
	auth: 'session',
	permission: 'company.events.manage',
	params: subscriptionParams,
	body: z.strictObject({ token: z.string().optional().describe('Новый токен Хантфлоу') }),
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Секрет сменён',
		schema: z.object({ subscription: subscriptionSchema, secret: z.string().nullable() })
	},
	async handle(ctx) {
		const rotated = await rotateSecret(
			deps(ctx.services),
			await actionContext(ctx),
			ctx.params.company_id,
			ctx.params.subscription_id,
			ctx.body.token === undefined ? {} : { token: ctx.body.token }
		);
		return { subscription: view(rotated.subscription), secret: rotated.secret };
	}
});

export const pingEventSubscription = defineOperation({
	id: 'pingEventSubscription',
	method: 'POST',
	path: '/companies/{company_id}/event-subscriptions/{subscription_id}/ping',
	tag: TAG,
	summary: 'Проверочная доставка',
	description: 'Событие `ping` с той же подписью: результат — в журнале доставок.',
	auth: 'session',
	permission: 'company.events.manage',
	params: subscriptionParams,
	errors: ['not_found'],
	response: { status: 202, description: 'Поставлено в очередь', schema: z.object({ delivery_id: z.uuid() }) },
	async handle(ctx) {
		return {
			delivery_id: await sendPing(
				deps(ctx.services),
				await actionContext(ctx),
				ctx.params.company_id,
				ctx.params.subscription_id
			)
		};
	}
});

export const listEventDeliveries = defineOperation({
	id: 'listEventDeliveries',
	method: 'GET',
	path: '/companies/{company_id}/event-subscriptions/{subscription_id}/deliveries',
	tag: TAG,
	summary: 'Журнал доставок',
	description: 'Последние 50 доставок подписки: статус, число попыток, последний ответ.',
	auth: 'session',
	permission: 'company.events.manage',
	params: subscriptionParams,
	errors: ['not_found'],
	response: { status: 200, description: 'Доставки', schema: z.object({ items: z.array(deliverySchema) }) },
	async handle(ctx) {
		const items = await listDeliveries(
			deps(ctx.services),
			await actionContext(ctx),
			ctx.params.company_id,
			ctx.params.subscription_id
		);
		return { items: items.map(deliveryView) };
	}
});
