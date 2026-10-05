// Categories and objections (contracts 10.1, 10.3; domain 12.4, 12.5): the candidate's categories with their history,
// an objection to a test result and its withdrawal; the FSP operator's queue of objections, taking one into review and
// the answer. The decision objected to belongs to the engine of the test (`OBJECTION_DECISIONS`). Browser session only.
import { z } from 'zod';
import { can } from '$lib/server/access/permissions';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import {
	OBJECTION_DECISIONS,
	OBJECTION_REASON_MAX_LENGTH,
	candidateObjections,
	openObjection,
	withdrawObjection,
	type AssessmentObjection
} from '$lib/server/categories/objections';
import { categoryHistory } from '$lib/server/categories/read';
import { ApiError } from '$lib/server/errors/api-error';
import { answerObjection, objectionQueueView, takeObjection } from '$lib/server/operator/objections';
import { defineOperation } from '../operation';
import { date, dateTime, iso, key } from '../schemas';
import type { BaseContext } from './context';

const CANDIDATE = 'Кандидат';
const STAFF = 'ФСП';

/** The candidate of the subject holding the permission for their own profile. */
async function selfCandidate(
	ctx: BaseContext,
	permission: 'candidate.self.read' | 'candidate.self.write'
): Promise<{ candidateId: string; userId: string }> {
	const subject = await ctx.subject();
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined || subject.userId === null) throw new ApiError('forbidden');
	if (!can(subject, permission, { candidateId }).allowed) throw new ApiError('forbidden');
	return { candidateId, userId: subject.userId };
}

const objectionSchema = z
	.object({
		id: z.uuid(),
		decision_id: z.uuid().describe('Оспариваемое решение теста'),
		status: z.enum(['open', 'in_review', 'resolved', 'withdrawn']),
		outcome: z
			.enum(['upheld', 'annulled', 'rescored'])
			.nullable()
			.describe('`upheld` — решение оставлено; `annulled` — попытка аннулирована; `rescored` — решение пересчитано'),
		resolution: z.string().nullable().describe('Объяснение оператора ФСП'),
		resulting_decision_id: z.uuid().nullable().describe('Новое решение после пересчёта'),
		opened_at: dateTime,
		due_at: dateTime.describe('Срок ответа: 30 дней (ч. 4 ст. 16 152-ФЗ)'),
		resolved_at: dateTime.nullable()
	})
	.meta({ id: 'AssessmentObjection', description: 'Возражение против результата теста' });

function objectionView(objection: AssessmentObjection) {
	return {
		id: objection.id,
		decision_id: objection.decisionId,
		status: objection.status,
		outcome: objection.outcome,
		resolution: objection.resolution,
		resulting_decision_id: objection.resultingDecisionId,
		opened_at: iso(objection.openedAt),
		due_at: iso(objection.dueAt),
		resolved_at: objection.resolvedAt === null ? null : iso(objection.resolvedAt)
	};
}

const categoryRecord = z
	.object({
		id: z.uuid(),
		specialization: z.enum(SPECIALIZATION_KEYS),
		grade: z.enum(GRADE_KEYS),
		status: z
			.enum(['active', 'superseded', 'revoked'])
			.describe('`superseded` — заменена следующим грейдом; `revoked` — решение теста аннулировано или пересчитано'),
		revoke_reason: z.enum(['decision_annulled', 'objection_annulled', 'objection_rescored']).nullable(),
		decision_id: z.uuid(),
		bank_release_id: z.string(),
		catalog_version: z.string(),
		confirmed_blocks: z.array(z.string()).describe('Определяющие блоки грейда, подтверждённые тестом'),
		confirmed_skill_keys: z
			.array(key)
			.describe('Подтверждённый стек: навыки определяющих блоков грейда и язык практики'),
		confident_upgrade_until: dateTime
			.nullable()
			.describe('До этого момента тест следующего грейда доступен сразу (уверенный результат)'),
		assigned_on: date,
		ended_at: dateTime.nullable()
	})
	.meta({ id: 'CategoryRecord', description: 'Категория кандидата: действующая или из истории' });

export const listMyCategories = defineOperation({
	id: 'listMyCategories',
	method: 'GET',
	path: '/me/categories',
	tag: CANDIDATE,
	summary: 'Мои категории',
	description:
		'Действующие и прошлые категории — специализация и грейд, подтверждённые тестом, — с определяющими блоками грейда, ' +
		'подтверждённым стеком и статусом, и возражения против результатов тестов. Замена резюме и изменения ' +
		'результатов ФСП категорию не меняют: её меняет только решение теста.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: [],
	response: {
		status: 200,
		description: 'Категории и возражения',
		schema: z.object({ categories: z.array(categoryRecord), objections: z.array(objectionSchema) })
	},
	async handle(ctx) {
		const { candidateId } = await selfCandidate(ctx, 'candidate.self.read');
		const [categories, objections] = await Promise.all([
			categoryHistory(ctx.services.db, candidateId),
			candidateObjections(ctx.services.db, candidateId)
		]);
		return {
			categories: categories.map((category) => ({
				id: category.id,
				specialization: category.specialization,
				grade: category.grade,
				status: category.status,
				revoke_reason: category.revokeReason,
				decision_id: category.decisionId,
				bank_release_id: category.bankReleaseId,
				catalog_version: category.catalogVersion,
				confirmed_blocks: category.confirmedBlocks,
				confirmed_skill_keys: category.confirmedSkillKeys,
				confident_upgrade_until: category.confidentUpgradeUntil === null ? null : iso(category.confidentUpgradeUntil),
				assigned_on: category.assignedAt.toISOString().slice(0, 10),
				ended_at: category.endedAt === null ? null : iso(category.endedAt)
			})),
			objections: objections.map(objectionView)
		};
	}
});

export const openTestObjection = defineOperation({
	id: 'openTestObjection',
	method: 'POST',
	path: '/me/tests/decisions/{decision_id}/objections',
	tag: CANDIDATE,
	summary: 'Возразить против результата теста',
	description:
		'Возражение против решения о грейде (ч. 3 ст. 16 152-ФЗ) — пока хранятся артефакты попытки. Рассматривает ' +
		'оператор ФСП, ответ — в течение 30 дней: решение оставлено, попытка аннулирована (повтор сразу и не ' +
		'засчитывается) или балл заданий исправлен и решение пересчитано. Одно открытое возражение на решение — ' +
		'повтор `409`.',
	auth: 'session',
	permission: 'candidate.self.write',
	idempotent: true,
	params: z.strictObject({ decision_id: z.uuid() }),
	body: z.strictObject({
		reason: z.string().max(OBJECTION_REASON_MAX_LENGTH).describe('С чем вы не согласны и почему'),
		items: z.array(z.uuid()).max(30).optional().describe('Задания попытки, с оценкой которых вы не согласны')
	}),
	errors: ['not_found', 'conflict'],
	response: { status: 201, description: 'Возражение принято', schema: objectionSchema },
	async handle(ctx) {
		const { candidateId, userId } = await selfCandidate(ctx, 'candidate.self.write');
		const objection = await openObjection(ctx.services.db, OBJECTION_DECISIONS, {
			candidateId,
			userId,
			decisionId: ctx.params.decision_id,
			reason: ctx.body.reason,
			...(ctx.body.items ? { items: ctx.body.items } : {}),
			requestId: ctx.meta.requestId,
			now: new Date()
		});
		return objectionView(objection);
	}
});

export const withdrawMyObjection = defineOperation({
	id: 'withdrawMyObjection',
	method: 'POST',
	path: '/me/objections/{objection_id}/withdrawal',
	tag: CANDIDATE,
	summary: 'Отозвать возражение',
	description: 'Кандидат отзывает своё возражение, пока оно не рассмотрено. Решённое или отозванное — `409`.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ objection_id: z.uuid() }),
	errors: ['not_found', 'conflict'],
	response: { status: 200, description: 'Возражение отозвано', schema: objectionSchema },
	async handle(ctx) {
		const { candidateId, userId } = await selfCandidate(ctx, 'candidate.self.write');
		const objection = await withdrawObjection(ctx.services.db, {
			objectionId: ctx.params.objection_id,
			candidateId,
			userId,
			requestId: ctx.meta.requestId
		});
		return objectionView(objection);
	}
});

export const listObjections = defineOperation({
	id: 'listObjections',
	method: 'GET',
	path: '/operator/objections',
	tag: STAFF,
	summary: 'Очередь возражений',
	description:
		'Открытые и взятые в работу возражения против результатов тестов — по сроку ответа, с просроченными и ' +
		'истекающими в ближайшие 5 дней, — и недавно решённые. Данные кандидата открываются только в деле кабинета ' +
		'оператора с записью в журнал.',
	auth: 'session',
	permission: 'objection.manage',
	errors: [],
	response: {
		status: 200,
		description: 'Очередь',
		schema: z.object({
			items: z.array(
				z
					.object({
						id: z.uuid(),
						status: z.enum(['open', 'in_review', 'resolved', 'withdrawn']),
						opened_at: dateTime,
						due_at: dateTime,
						overdue: z.boolean(),
						due_soon: z.boolean(),
						assigned: z.boolean(),
						mine: z.boolean().describe('Возражение взято вами'),
						is_minor: z.boolean()
					})
					.meta({ id: 'ObjectionQueueItem' })
			),
			resolved: z.array(
				z.object({
					id: z.uuid(),
					outcome: z.enum(['upheld', 'annulled', 'rescored']).nullable(),
					resolved_at: dateTime.nullable()
				})
			)
		})
	},
	async handle(ctx) {
		const queue = await objectionQueueView(ctx.services.db, await ctx.subject(), new Date());
		return {
			items: queue.items.map((item) => ({
				id: item.id,
				status: item.status,
				opened_at: iso(item.openedAt),
				due_at: iso(item.dueAt),
				overdue: item.overdue,
				due_soon: item.dueSoon,
				assigned: item.assignee !== null,
				mine: item.mine,
				is_minor: item.isMinor
			})),
			resolved: queue.resolved.map((item) => ({
				id: item.id,
				outcome: item.outcome,
				resolved_at: item.resolvedAt === null ? null : iso(item.resolvedAt)
			}))
		};
	}
});

export const assignObjectionToMe = defineOperation({
	id: 'assignObjection',
	method: 'POST',
	path: '/operator/objections/{objection_id}/assign',
	tag: STAFF,
	summary: 'Взять возражение в работу',
	description: 'Оператор становится ответственным за ответ; взятое другим возражение можно переназначить на себя.',
	auth: 'session',
	permission: 'objection.manage',
	params: z.strictObject({ objection_id: z.uuid() }),
	errors: ['not_found', 'conflict'],
	response: { status: 204, description: 'Возражение взято в работу' },
	async handle(ctx) {
		await takeObjection(ctx.services.db, await ctx.subject(), ctx.meta, ctx.params.objection_id);
	}
});

export const resolveObjectionByOperator = defineOperation({
	id: 'resolveObjection',
	method: 'POST',
	path: '/operator/objections/{objection_id}/resolution',
	tag: STAFF,
	summary: 'Ответ на возражение',
	description:
		'Ответ ответственного оператора: `upheld` — решение оставлено; `annulled` — попытка аннулирована как ' +
		'незасчитываемая, категория этого решения отозвана; `rescored` — исправленные баллы кластеров с обоснованием ' +
		'по сохранённым артефактам, процедура пересчитывает решение на тех же кластерах. Кандидату приходит ' +
		'уведомление с исходом; объяснение — в продукте.',
	auth: 'session',
	permission: 'objection.manage',
	params: z.strictObject({ objection_id: z.uuid() }),
	body: z.discriminatedUnion('outcome', [
		z.strictObject({ outcome: z.literal('upheld'), resolution: z.string().max(4000) }),
		z.strictObject({ outcome: z.literal('annulled'), resolution: z.string().max(4000) }),
		z.strictObject({
			outcome: z.literal('rescored'),
			resolution: z.string().max(4000),
			rescored_items: z
				.array(z.strictObject({ seq: z.int().min(1), score: z.number().min(0).max(1), reason: z.string().max(2000) }))
				.min(1)
		})
	]),
	errors: ['not_found', 'conflict'],
	response: { status: 200, description: 'Ответ записан', schema: objectionSchema },
	async handle(ctx) {
		const body = ctx.body;
		const objection = await answerObjection(
			ctx.services.db,
			OBJECTION_DECISIONS,
			await ctx.subject(),
			ctx.meta,
			ctx.params.objection_id,
			body.outcome === 'rescored'
				? { outcome: 'rescored', resolution: body.resolution, items: body.rescored_items }
				: { outcome: body.outcome, resolution: body.resolution }
		);
		return objectionView(objection);
	}
});
