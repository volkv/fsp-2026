// `GET /api/v1/verify/{handle}` (contracts 5.5; domain 9.6): anyone checks a receipt without signing in and learns what
// was verified, with which source and when — never who the person is. The rate of requests per address is limited by
// the hooks (`receipt.verify` is enumerable).
import { z } from 'zod';
import type { AuditActor } from '$lib/server/audit/record';
import { recordAuditEvent } from '$lib/server/audit/record';
import { ApiError } from '$lib/server/errors/api-error';
import { fromSimulator, receiptStatementSchema, verifyReceipt } from '$lib/server/fsp/receipts';
import { defineOperation } from '../operation';

export const verifyReceiptOperation = defineOperation({
	id: 'verifyReceipt',
	method: 'GET',
	path: '/verify/{handle}',
	tag: 'Квитанции',
	summary: 'Проверить квитанцию',
	description:
		'Подписанное платформой заявление о факте и его статус на момент запроса. Подпись Ed25519 — над каноническим ' +
		'JSON заявления (ключи отсортированы на всех уровнях). Персональных данных, псевдонима и идентификатора ' +
		'кандидата в ответе нет. Квитанция демонстрационного стенда говорит, что её источник — имитатор ФСП ' +
		'(`source_simulator`), а не сама федерация. Удалённая или неизвестная квитанция — `404`.',
	auth: 'public',
	params: z.strictObject({
		handle: z
			.string()
			.regex(/^[a-z2-7]{26}$/u)
			.describe('Публичный идентификатор квитанции')
			.meta({ examples: ['mfrggzdfmztwq2lknnwg23tpob'] })
	}),
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Квитанция',
		schema: z
			.object({
				status: z
					.enum(['valid', 'superseded', 'annulled', 'not_valid'])
					.describe(
						'`valid` — факт действует в этой версии; `superseded` — источник прислал новую версию; ' +
							'`annulled` — источник аннулировал; `not_valid` — факт изъят'
					),
				statement: receiptStatementSchema,
				source_simulator: z
					.boolean()
					.describe(
						'`true` — факт получен от демонстрационного имитатора ФСП, а не от федерации (то же, что ' +
							'`statement.source_simulator`, под подписью)'
					),
				signature: z.string().describe('Ed25519, base64url'),
				signing_key_id: z.string()
			})
			.meta({ id: 'ReceiptVerification' })
	},
	async handle(ctx) {
		const receipt = await verifyReceipt(ctx.services.db, ctx.params.handle);
		const actor: AuditActor =
			ctx.actor.kind === 'anonymous'
				? { kind: 'anonymous' }
				: ctx.actor.kind === 'session'
					? { kind: 'user', userId: ctx.actor.userId }
					: { kind: 'api_key', apiKeyId: ctx.actor.apiKeyId, userId: ctx.actor.userId, companyId: ctx.actor.companyId };
		await recordAuditEvent(ctx.services.db, {
			action: 'receipt.verified',
			outcome: receipt ? 'success' : 'denied',
			actor,
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			details: { handle: ctx.params.handle, result: receipt?.status ?? 'not_found' }
		});
		if (!receipt) throw new ApiError('not_found');
		const statement = receiptStatementSchema.parse(receipt.statement);
		return {
			status: receipt.status,
			statement,
			source_simulator: fromSimulator(statement),
			signature: receipt.signature,
			signing_key_id: receipt.signingKeyId
		};
	}
});
