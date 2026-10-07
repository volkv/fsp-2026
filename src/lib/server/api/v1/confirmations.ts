// Requests of a missing confirmation and the results of block tests (contracts 9.1, 9.2; domain 13.11): the employer
// asks a candidate it sees to confirm a block of the candidate's specialization; the candidate takes the block test or
// declines; the result is evidence of its own, never a change of the category.
import { z } from 'zod';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import {
	acceptRequest,
	candidateConfirmations,
	companyRequests,
	declineRequest,
	requestConfirmation,
	setResultVisibility,
	type BlockResultView,
	type ConfirmationRequestView
} from '$lib/server/confirmations/requests';
import { defineOperation } from '../operation';
import { dateTime, id, iso, isoOrNull, pseudonym } from '../schemas';
import { contactDeps } from '../services';
import { candidateOfPseudonymFor, invitationMeta } from './context';

const TAG = 'Запросы подтверждения';

const resultSchema = z
	.object({
		id: z.uuid(),
		specialization: z.enum(SPECIALIZATION_KEYS),
		block: z.string(),
		block_title: z.string(),
		checks: z.string().describe('Что проверяет блок'),
		skill_keys: z.array(z.string()).describe('Навыки, которые покрывает блок: область результата'),
		grade: z.enum(GRADE_KEYS),
		verdict: z.enum(['confirmed', 'not_confirmed']),
		score_sum: z.int().describe('Сумма баллов четырёх кластеров в двадцатых'),
		cut_sum: z.int().describe('Сумма порогов (Angoff) четырёх кластеров в двадцатых'),
		status: z.enum(['valid', 'annulled']),
		visibility: z.enum(['requester', 'all_companies']),
		bank_release_id: z.string(),
		decided_at: dateTime
	})
	.meta({
		id: 'BlockConfirmation',
		description: 'Результат блок-теста: отдельное доказательство, категорию не меняет'
	});

const requestSchema = z
	.object({
		id: z.uuid(),
		company: z.object({ id: z.uuid(), display_name: z.string() }),
		candidate_pseudonym: pseudonym.nullable().describe('Кандидат для компании; кандидату — `null`'),
		specialization: z.enum(SPECIALIZATION_KEYS),
		block: z.string(),
		block_title: z.string(),
		grade: z.enum(GRADE_KEYS).describe('Грейд действующей категории кандидата, без неё — заявленный'),
		status: z.enum(['requested', 'accepted', 'declined', 'completed', 'expired']),
		invitation_id: z.uuid().nullable(),
		need_id: z.uuid().nullable(),
		expires_at: dateTime,
		created_at: dateTime,
		answered_at: dateTime.nullable(),
		attempt_id: z.uuid().nullable().describe('Идущий блок-тест по запросу'),
		result: resultSchema.nullable()
	})
	.meta({ id: 'ConfirmationRequest', description: 'Запрос подтверждения блока' });

const resultOut = (result: BlockResultView) => ({
	id: result.id,
	specialization: result.specialization,
	block: result.block,
	block_title: result.blockTitle,
	checks: result.checks,
	skill_keys: [...result.skillKeys],
	grade: result.grade,
	verdict: result.verdict,
	score_sum: result.scoreSum,
	cut_sum: result.cutSum,
	status: result.status,
	visibility: result.visibility,
	bank_release_id: result.bankReleaseId,
	decided_at: iso(result.decidedAt)
});

const requestOut = (request: ConfirmationRequestView) => ({
	id: request.id,
	company: { id: request.companyId, display_name: request.companyName },
	candidate_pseudonym: request.candidatePseudonym,
	specialization: request.specialization,
	block: request.block,
	block_title: request.blockTitle,
	grade: request.grade,
	status: request.status,
	invitation_id: request.invitationId,
	need_id: request.needId,
	expires_at: iso(request.expiresAt),
	created_at: iso(request.createdAt),
	answered_at: isoOrNull(request.answeredAt),
	attempt_id: request.attemptId,
	result: request.result && resultOut(request.result)
});

export const createConfirmationRequest = defineOperation({
	id: 'createConfirmationRequest',
	method: 'POST',
	path: '/confirmation-requests',
	tag: TAG,
	summary: 'Запросить подтверждение блока',
	description:
		'Разрешённая пара «блок × грейд» специализации кандидата, кроме определяющих блоков его действующей категории; ' +
		'грейд — действующей категории, без неё — заявленный. Повтор открытого запроса возвращает его (`outcome: ' +
		'existing`); действующий результат того же блока на том же или более высоком грейде, который компания видит, ' +
		'возвращается вместо запроса (`outcome: result`). Кандидат, которого компания не видит, — `404`; определяющий ' +
		'блок категории — `422 confirmation_block_confirmed`; пара без блок-теста — `422 block_not_testable`.',
	auth: 'account',
	permission: 'confirmation.request',
	idempotent: true,
	body: z
		.strictObject({
			candidate_pseudonym: pseudonym,
			block: z.string().describe('Код блока справочника категорий, например `be.api`'),
			invitation_id: z.uuid().nullable().optional().describe('Предложение, из которого запрос'),
			need_id: z.uuid().nullable().optional().describe('Потребность, из которой запрос')
		})
		.meta({ examples: [{ candidate_pseudonym: 'k7q2x4m5n6p7r2s3t4v5w6x7yz', block: 'be.api' }] }),
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
	response: {
		status: 201,
		description: 'Запрос или результат',
		schema: z.object({
			outcome: z.enum(['created', 'existing', 'result']),
			request: requestSchema.nullable(),
			result: resultSchema.nullable()
		})
	},
	async handle(ctx) {
		const { subject, candidateId } = await candidateOfPseudonymFor(ctx, ctx.body.candidate_pseudonym);
		const outcome = await requestConfirmation(contactDeps(ctx.services), subject, invitationMeta(ctx), {
			candidateId,
			block: ctx.body.block,
			invitationId: ctx.body.invitation_id ?? null,
			needId: ctx.body.need_id ?? null
		});
		return outcome.kind === 'result'
			? { outcome: 'result' as const, request: null, result: resultOut(outcome.result) }
			: {
					outcome: outcome.created ? ('created' as const) : ('existing' as const),
					request: requestOut(outcome.request),
					result: null
				};
	}
});

export const listConfirmationRequests = defineOperation({
	id: 'listConfirmationRequests',
	method: 'GET',
	path: '/confirmation-requests',
	tag: TAG,
	summary: 'Запросы подтверждения компании',
	description: 'Запросы своей компании с результатами, новые первыми; `candidate_pseudonym` — одного кандидата.',
	auth: 'account',
	permission: 'confirmation.request',
	query: z.strictObject({ candidate_pseudonym: pseudonym.optional() }),
	errors: ['forbidden', 'not_found'],
	response: { status: 200, description: 'Запросы', schema: z.object({ items: z.array(requestSchema) }) },
	async handle(ctx) {
		const subject = await ctx.subject();
		let candidateId: string | null = null;
		if (ctx.query.candidate_pseudonym !== undefined) {
			candidateId = (await candidateOfPseudonymFor(ctx, ctx.query.candidate_pseudonym)).candidateId;
		}
		return {
			items: (await companyRequests(contactDeps(ctx.services), subject, candidateId)).map(requestOut)
		};
	}
});

const requestParams = z.strictObject({ request_id: id('Запрос подтверждения') });

export const myConfirmationRequests = defineOperation({
	id: 'listMyConfirmationRequests',
	method: 'GET',
	path: '/me/confirmation-requests',
	tag: TAG,
	summary: 'Мои запросы подтверждения',
	description: 'Запросы компаний и результаты своих блок-тестов с тем, кому они видны.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: ['forbidden'],
	response: {
		status: 200,
		description: 'Запросы и результаты',
		schema: z.object({ requests: z.array(requestSchema), results: z.array(resultSchema) })
	},
	async handle(ctx) {
		const own = await candidateConfirmations(contactDeps(ctx.services), await ctx.subject());
		return { requests: own.requests.map(requestOut), results: own.results.map(resultOut) };
	}
});

export const acceptConfirmationRequest = defineOperation({
	id: 'acceptConfirmationRequest',
	method: 'POST',
	path: '/me/confirmation-requests/{request_id}/accept',
	tag: TAG,
	summary: 'Пройти блок-тест по запросу',
	description:
		'Начинает блок-тест (4 кластера блока, резервные классы, без практики): `outcome: started` с попыткой — её ' +
		'проходят методами `/me/tests/{attempt_id}`. Действующий подтверждённый результат того же блока на том же или ' +
		'более высоком грейде закрывает запрос без нового теста (`outcome: completed`). Срок истёк или уже отвечено — ' +
		'`409`; блок-тест этой пары уже проходился в окне форм — `409 block_test_window`; заданий не хватает — ' +
		'`409 bank_capacity_exhausted`. Категория не меняется ни при каком исходе.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: requestParams,
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
	response: {
		status: 200,
		description: 'Блок-тест начат или запрос закрыт результатом',
		schema: z.object({
			outcome: z.enum(['started', 'completed']),
			attempt_id: z.uuid().nullable(),
			confirmation_id: z.uuid().nullable()
		})
	},
	async handle(ctx) {
		const accepted = await acceptRequest(
			contactDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.request_id
		);
		return accepted.kind === 'started'
			? { outcome: 'started' as const, attempt_id: accepted.attemptId, confirmation_id: null }
			: { outcome: 'completed' as const, attempt_id: null, confirmation_id: accepted.confirmationId };
	}
});

export const declineConfirmationRequest = defineOperation({
	id: 'declineConfirmationRequest',
	method: 'POST',
	path: '/me/confirmation-requests/{request_id}/decline',
	tag: TAG,
	summary: 'Отказаться от запроса',
	description: 'Отказ ни на что не влияет. Срок истёк или уже отвечено — `409`.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: requestParams,
	errors: ['forbidden', 'not_found', 'conflict'],
	response: { status: 204, description: 'Отказ записан' },
	async handle(ctx) {
		await declineRequest(contactDeps(ctx.services), await ctx.subject(), invitationMeta(ctx), ctx.params.request_id);
	}
});

export const setBlockConfirmationVisibility = defineOperation({
	id: 'setBlockConfirmationVisibility',
	method: 'PUT',
	path: '/me/block-confirmations/{confirmation_id}/visibility',
	tag: TAG,
	summary: 'Кому виден результат блок-теста',
	description: '`requester` — только компании запроса, `all_companies` — всем компаниям, которые видят кандидата.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ confirmation_id: id('Результат блок-теста') }),
	body: z.strictObject({ visibility: z.enum(['requester', 'all_companies']) }),
	errors: ['forbidden', 'not_found'],
	response: { status: 200, description: 'Результат', schema: resultSchema },
	async handle(ctx) {
		return resultOut(
			await setResultVisibility(
				contactDeps(ctx.services),
				await ctx.subject(),
				invitationMeta(ctx),
				ctx.params.confirmation_id,
				ctx.body.visibility
			)
		);
	}
});
