// Deleting the account (docs/domain.md, sections 3.1, 3.4, 19): what the deletion takes and what blocks it, and the
// request itself after a fresh sign-in — the same overview and the same act as the page «Удаление учётной записи».
// Any signed-in person, not only a candidate. Browser session only.
import { z } from 'zod';
import { deletionOverview, deletionRefusalMessage } from '$lib/server/erasure/overview';
import { requestAccountDeletion } from '$lib/server/erasure/request';
import { ApiError } from '$lib/server/errors/api-error';
import { defineOperation } from '../operation';
import { dateTime, isoOrNull } from '../schemas';
import { authDepsOf } from '../services';
import { requestMetaOf, sessionOf } from './context';

const TAG = 'Учётная запись';

export const getMyAccountDeletion = defineOperation({
	id: 'getMyAccountDeletion',
	method: 'GET',
	path: '/me/account/deletion',
	tag: TAG,
	summary: 'Что будет при удалении учётной записи',
	description:
		'Удаляется ли с учётной записью профиль кандидата, сколько компаний уже получили контакты (они остаются у них), ' +
		'что мешает удалению — роль сотрудника платформы или единственный владелец компании — и действует ли ещё ' +
		'свежий вход, без которого удаление не подтверждается.',
	auth: 'session',
	errors: [],
	response: {
		status: 200,
		description: 'Последствия и препятствия удаления',
		schema: z.object({
			candidate: z
				.boolean()
				.describe('Профиль кандидата удаляется вместе с учётной записью; это и отзыв согласия на обработку'),
			companies_with_contacts: z.int().describe('Компании, получившие контакты: они остаются у них'),
			blockers: z
				.array(
					z.object({
						code: z.enum(['staff_role', 'last_owner']),
						message: z.string()
					})
				)
				.describe('Что сделать до удаления; пусто — удалить можно'),
			fresh_auth: z.boolean().describe('Вход достаточно свежий, чтобы подтвердить удаление'),
			fresh_auth_until: dateTime.nullable().describe('До какого момента подтверждение принимается без нового входа')
		})
	},
	async handle(ctx) {
		const session = sessionOf(ctx);
		const overview = await deletionOverview(ctx.services.db, session, ctx.services.now());
		const blockers: { code: 'staff_role' | 'last_owner'; message: string }[] = [];
		if (overview.staff) {
			blockers.push({ code: 'staff_role', message: deletionRefusalMessage({ reason: 'staff_role' }) });
		}
		if (overview.lastOwnerOf !== null) {
			blockers.push({
				code: 'last_owner',
				message: deletionRefusalMessage({ reason: 'last_owner', companyName: overview.lastOwnerOf })
			});
		}
		return {
			candidate: overview.candidate,
			companies_with_contacts: overview.companiesWithContacts,
			blockers,
			fresh_auth: overview.freshAuth,
			fresh_auth_until: isoOrNull(overview.freshAuthUntil)
		};
	}
});

export const requestMyAccountDeletion = defineOperation({
	id: 'requestMyAccountDeletion',
	method: 'POST',
	path: '/me/account/deletion',
	tag: TAG,
	summary: 'Удалить учётную запись',
	description:
		'Требует свежего входа (не старше 10 минут), иначе `403` с `details[].code = stale_auth`: войдите заново и ' +
		'повторите. В одной транзакции учётная запись и профиль переходят в удаление: профиль сразу уходит из ' +
		'каталога и подборов, согласие на обработку отзывается, неотвеченные приглашения отзываются, участие в команде ' +
		'завершается с ключами API; данные стираются фоновой задачей. Затем завершаются все сеансы — повторный запрос ' +
		'той же сессией получает `401` — и уходит письмо. Роль сотрудника платформы или единственный владелец ' +
		'компании — `409` с причиной. `cause = processing_revoked` — то же действие, записанное как отзыв согласия на ' +
		'обработку персональных данных.',
	auth: 'session',
	body: z.strictObject({
		confirm: z.literal(true).describe('Человек понимает последствия удаления'),
		cause: z
			.enum(['account_deleted', 'processing_revoked'])
			.default('account_deleted')
			.describe('Удаление учётной записи или отзыв согласия на обработку'),
		reason: z.string().max(500).optional().describe('Своими словами, по желанию')
	}),
	errors: ['forbidden', 'conflict'],
	response: {
		status: 202,
		description: 'Удаление начато; сеансы завершены',
		schema: z.object({
			status: z.literal('deletion_pending'),
			letter_sent: z.boolean().describe('Письмо о начале удаления ушло на почту учётной записи')
		})
	},
	async handle(ctx) {
		const result = await requestAccountDeletion(await authDepsOf(ctx.services), requestMetaOf(ctx), sessionOf(ctx), {
			cause: ctx.body.cause,
			reason: ctx.body.reason ?? null
		});
		if (!result.ok) {
			const { refusal } = result;
			const message = deletionRefusalMessage(refusal);
			throw new ApiError(refusal.reason === 'stale_auth' ? 'forbidden' : 'conflict', {
				message,
				details: [{ code: refusal.reason, message }]
			});
		}
		return { status: 'deletion_pending' as const, letter_sent: result.letterSent };
	}
});
