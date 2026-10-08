// `GET /api/v1/verify/{handle}` (contracts 5.5; domain 9.6): anyone checks a receipt without signing in and learns what
// was verified, with which source and when — never who the person is. `GET /api/v1/verify/categories/{handle}` and
// `POST …/holder` (contracts 9.3; domain 12.9) check a confirmation of a category the same way, and whether it belongs
// to the person presenting it. The rate of requests per address is limited by
// the hooks (`receipt.verify` is enumerable).
import { z } from 'zod';
import { GRADE_KEYS } from '$lib/server/assessments/contract/catalog';
import { attestationStatementSchema } from '$lib/server/attestations/statement';
import { ATTESTATION_HANDLE, checkHolder, verifyAttestation } from '$lib/server/attestations/verify';
import type { AuditActor } from '$lib/server/audit/record';
import { auditActorOf, recordAuditEvent } from '$lib/server/audit/record';
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

const attestationHandle = z
	.string()
	.regex(ATTESTATION_HANDLE)
	.describe('Публичный идентификатор подтверждения: адрес QR-кода PDF-профиля')
	.meta({ examples: ['nbswy3dpeb3w64tmmqqgc3tfmf'] });

export const verifyCategoryAttestationOperation = defineOperation({
	id: 'verifyCategoryAttestation',
	method: 'GET',
	path: '/verify/categories/{handle}',
	tag: 'Квитанции',
	summary: 'Проверить подтверждение категории',
	description:
		'Подписанное платформой заявление о назначении категории (QR-код PDF-профиля) и его статус на момент запроса: ' +
		'`valid` — категория действует; `superseded` — назначение заменено другим, это прошлый результат, а не ' +
		'действующая категория (действующий грейд — в `current_grade`), или, при `reissued`, категория действует, но ' +
		'владелец сменил ФИО и подтверждение выпущено заново; `annulled` — решение теста аннулировано или ' +
		'категория отозвана по возражению. `statement.judgement` — как проверены задания попытки: рубрики только ' +
		'моделями, предварительные пороги, рецензент того же поставщика, что автор, и подпись об этом. Подпись Ed25519 — над каноническим JSON заявления, ключи те же, что у ' +
		'квитанций (`/.well-known/receipt-keys.json`). ФИО, контактов, псевдонима и идентификатора кандидата в ответе ' +
		'нет; принадлежность предъявителю проверяет `POST …/holder`. Удалённый аккаунт или неизвестный идентификатор — ' +
		'`404`.',
	auth: 'public',
	params: z.strictObject({ handle: attestationHandle }),
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Подтверждение категории',
		schema: z
			.object({
				status: z.enum(['valid', 'superseded', 'annulled']),
				statement: attestationStatementSchema,
				signature: z.string().describe('Ed25519, base64url'),
				signing_key_id: z.string(),
				ended_on: z.iso.date().nullable().describe('Когда назначение перестало действовать'),
				annul_reason: z
					.enum(['decision_annulled', 'objection_annulled', 'objection_rescored'])
					.nullable()
					.describe('Почему аннулировано: решение теста аннулировано или пересмотрено по возражению'),
				current_grade: z
					.object({ grade: z.enum(GRADE_KEYS), assigned_on: z.iso.date() })
					.nullable()
					.describe('При `superseded` — грейд, действующий сейчас в той же специализации; `null` — его нет'),
				reissued: z
					.boolean()
					.describe(
						'`superseded` при действующей категории: владелец сменил ФИО, и новое подтверждение того же назначения ' +
							'заменило это (`ended_on` — с какого дня); `false` во всех остальных случаях'
					)
			})
			.meta({ id: 'CategoryAttestationVerification' })
	},
	async handle(ctx) {
		const verified = await verifyAttestation(ctx.services.db, ctx.params.handle);
		await recordAuditEvent(ctx.services.db, {
			action: 'attestation.verified',
			outcome: verified ? 'success' : 'denied',
			actor: auditActorOf(ctx.actor),
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			details: { handle: ctx.params.handle, result: verified?.status ?? 'not_found' }
		});
		if (!verified) throw new ApiError('not_found');
		return {
			status: verified.status,
			statement: attestationStatementSchema.parse(verified.statement),
			signature: verified.signature,
			signing_key_id: verified.signingKeyId,
			ended_on: verified.endedAt === null ? null : verified.endedAt.toISOString().slice(0, 10),
			annul_reason: verified.annulReason,
			current_grade:
				verified.currentGrade === null
					? null
					: { grade: verified.currentGrade.grade, assigned_on: verified.currentGrade.assignedOn },
			reissued: verified.reissued
		};
	}
});

export const checkAttestationHolderOperation = defineOperation({
	id: 'checkAttestationHolder',
	method: 'POST',
	path: '/verify/categories/{handle}/holder',
	tag: 'Квитанции',
	summary: 'Проверить, что подтверждение принадлежит предъявителю',
	description:
		'Предъявитель называет ФИО и код владельца, который кандидат видит в своём кабинете и передаёт по своей воле; ' +
		'платформа пересчитывает обязательство владельца из заявления и отвечает, совпадает ли оно. ФИО и код не ' +
		'сохраняются и в журнал не пишутся. Публичная страница по ФИО не ищет.',
	auth: 'public',
	params: z.strictObject({ handle: attestationHandle }),
	body: z.strictObject({
		full_name: z.string().min(1).max(300).describe('Фамилия Имя Отчество владельца — в этом порядке'),
		nonce: z.string().min(1).max(64).describe('Код владельца из кабинета кандидата')
	}),
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Результат сверки',
		schema: z.object({ matches: z.boolean().describe('`true` — ФИО и код дают обязательство из заявления') })
	},
	async handle(ctx) {
		const matches = await checkHolder(ctx.services.db, ctx.params.handle, {
			fullName: ctx.body.full_name,
			holderCode: ctx.body.nonce
		});
		await recordAuditEvent(ctx.services.db, {
			action: 'attestation.holder_checked',
			outcome: matches === null ? 'denied' : 'success',
			actor: auditActorOf(ctx.actor),
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			details: { handle: ctx.params.handle, result: matches === null ? 'not_found' : matches ? 'matches' : 'differs' }
		});
		if (matches === null) throw new ApiError('not_found');
		return { matches };
	}
});
