// The candidate's own side (contracts 5.5; domain 12, 13.4, 18.2): the category with its full explanation and what is
// missing, an objection to it, the match with vacancies with the gaps and what to improve, and everything the platform
// keeps about the candidate («Мои данные»). Browser session only.
import { z } from 'zod';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { DATA_EXPORT_FORMAT, exportOwnData } from '$lib/server/candidates/data-export';
import { openDispute } from '$lib/server/categorization/disputes';
import { ApiError } from '$lib/server/errors/api-error';
import { recommendVacancies } from '$lib/server/matching/recommendations';
import { defineOperation } from '../operation';
import { ownCategory } from '../read/category';
import { candidateMatch, date, dateTime, iso, key, pageQuery } from '../schemas';
import type { BaseContext } from './context';

const TAG = 'Кандидат';

const json = z.record(z.string(), z.unknown());

/** The candidate of the subject holding the permission for their own profile. */
async function selfCandidate(
	ctx: BaseContext,
	permission: 'candidate.self.read' | 'candidate.self.write'
): Promise<{ subject: AccessSubject; candidateId: string; userId: string }> {
	const subject = await ctx.subject();
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined || subject.userId === null) throw new ApiError('forbidden');
	const decision = can(subject, permission, { candidateId });
	if (!decision.allowed) throw new ApiError('forbidden');
	return { subject, candidateId, userId: subject.userId };
}

const disputeSchema = z
	.object({
		id: z.uuid(),
		run_id: z.uuid(),
		status: z.enum(['open', 'in_review', 'resolved_upheld', 'resolved_changed', 'withdrawn']),
		opened_at: dateTime,
		due_at: dateTime.describe('Срок ответа: 30 дней')
	})
	.meta({ id: 'CategoryDispute', description: 'Возражение против категории' });

export const getMyCategory = defineOperation({
	id: 'getMyCategory',
	method: 'GET',
	path: '/me/category',
	tag: TAG,
	summary: 'Моя категория',
	description:
		'Опубликованная категория по осям роли, грейда и стека с полным объяснением, уровни ФСП и чего не хватает. ' +
		'`recalculating` — часть доказательств отозвана, категория пересчитывается и до пересчёта не показывается.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: [],
	response: {
		status: 200,
		description: 'Категория',
		schema: z.object({
			state: z.enum(['available', 'recalculating', 'none']),
			run: z
				.object({
					id: z.uuid().describe('На эту версию подаётся возражение'),
					outcome: z.enum(['complete', 'partial', 'insufficient_data']),
					origin: z.enum(['automatic', 'manual_override']),
					computed_at: dateTime,
					missing: json.describe('Чего не хватает по каждой оси и как это добавить'),
					experience_summary: json
				})
				.nullable(),
			categories: z.array(
				z.object({
					rank: z.enum(['primary', 'secondary']),
					role: z.object({ status: z.enum(['established', 'insufficient_data']), key: key.nullable() }),
					grade: z.object({
						status: z.enum(['established', 'insufficient_data']),
						min: key.nullable(),
						max: key.nullable(),
						confidence: z.number().nullable()
					}),
					stack: z.object({ status: z.enum(['established', 'insufficient_data']), skill_keys: z.array(key) }),
					explanation: json.describe('Объяснение по осям: сигналы, правила, желаемые роли, маркеры ФСП')
				})
			),
			fsp_levels: z.array(z.object({ discipline: z.string(), level: z.string(), last_result_on: date.nullable() })),
			open_dispute: disputeSchema.nullable()
		})
	},
	async handle(ctx) {
		const { candidateId } = await selfCandidate(ctx, 'candidate.self.read');
		const category = await ownCategory(ctx.services.db, candidateId);
		const { run, dispute } = category;
		return {
			state: category.state,
			run: run && {
				id: run.id,
				outcome: run.outcome,
				origin: run.origin,
				computed_at: iso(run.computedAt),
				missing: run.missing as Record<string, unknown>,
				experience_summary: run.experienceSummary as Record<string, unknown>
			},
			categories: category.assignments.map((a) => ({
				rank: a.rank,
				role: { status: a.roleStatus, key: a.roleKey },
				grade: {
					status: a.gradeStatus,
					min: a.gradeMin,
					max: a.gradeMax,
					confidence: a.gradeConfidence === null ? null : Number(a.gradeConfidence)
				},
				stack: { status: a.stackStatus, skill_keys: a.stackSkillKeys },
				explanation: a.explanation as Record<string, unknown>
			})),
			fsp_levels: category.levels.map((level) => ({
				discipline: level.discipline,
				level: level.level,
				last_result_on: level.lastResultOn
			})),
			open_dispute: dispute && {
				id: dispute.id,
				run_id: dispute.runId,
				status: dispute.status,
				opened_at: iso(dispute.openedAt),
				due_at: iso(dispute.dueAt)
			}
		};
	}
});

export const openCategoryDispute = defineOperation({
	id: 'openCategoryDispute',
	method: 'POST',
	path: '/me/category/disputes',
	tag: TAG,
	summary: 'Возразить против категории',
	description:
		'Возражение против опубликованной категории (`run_id` из `GET /me/category`). Оператор ФСП отвечает в течение 30 ' +
		'дней: оставляет категорию или заменяет её решением. Одно открытое возражение на версию.',
	auth: 'session',
	permission: 'candidate.self.write',
	idempotent: true,
	body: z.strictObject({
		run_id: z.uuid(),
		reason: z.string().describe('Почему категория неверна; до 4000 символов')
	}),
	errors: ['not_found', 'conflict'],
	response: { status: 201, description: 'Возражение принято', schema: disputeSchema },
	async handle(ctx) {
		const { candidateId, userId } = await selfCandidate(ctx, 'candidate.self.write');
		const dispute = await openDispute(ctx.services.db, {
			candidateId,
			userId,
			runId: ctx.body.run_id,
			reason: ctx.body.reason,
			requestId: ctx.meta.requestId
		});
		return {
			id: dispute.id,
			run_id: dispute.runId,
			status: dispute.status,
			opened_at: iso(dispute.openedAt),
			due_at: iso(dispute.dueAt)
		};
	}
});

export const listMyMatches = defineOperation({
	id: 'listMyMatches',
	method: 'GET',
	path: '/me/matches',
	tag: TAG,
	summary: 'Мои рекомендации',
	description:
		'Вакансии по соответствию мне — тем же расчётом, что видит работодатель: что подходит и на чём держится, что ' +
		'неизвестно, чего не хватает и что подтянуть.',
	auth: 'session',
	permission: 'match.read',
	query: z.strictObject({
		text: z.string().max(500).optional(),
		origin: z.enum(['own', 'external']).optional(),
		role_key: z.array(key).max(20).optional(),
		work_format: z.array(key).max(10).optional(),
		...pageQuery
	}),
	errors: [],
	response: {
		status: 200,
		description: 'Страница рекомендаций',
		schema: z.object({
			items: z.array(
				z.object({
					vacancy_id: z.uuid(),
					origin: z.enum(['own', 'external']),
					title: z.string(),
					company_id: z.uuid().nullable(),
					status: z.string(),
					match: candidateMatch,
					relevance: z.object({ fts: z.number().nullable() })
				})
			),
			next_cursor: z.string().nullable(),
			search_mode: z.enum(['hybrid', 'fts_only']),
			embedding_space_id: z.string().nullable(),
			semantic_reason: z.string().nullable()
		})
	},
	async handle(ctx) {
		const { subject } = await selfCandidate(ctx, 'candidate.self.read');
		const { cursor, limit, text, origin, role_key: roleKeys, work_format: workFormats } = ctx.query;
		const page = await recommendVacancies({ db: ctx.services.db }, subject, {
			limit,
			...(cursor === undefined ? {} : { cursor }),
			...(text === undefined ? {} : { text }),
			...(origin === undefined ? {} : { origin }),
			...(roleKeys === undefined ? {} : { roleKeys }),
			...(workFormats === undefined ? {} : { workFormats })
		});
		return {
			items: page.items.map((item) => ({
				vacancy_id: item.vacancyId,
				origin: item.origin,
				title: item.title,
				company_id: item.companyId,
				status: item.status,
				match: item.match,
				relevance: item.relevance
			})),
			next_cursor: page.nextCursor,
			search_mode: page.mode.searchMode,
			embedding_space_id: page.mode.embeddingSpaceId,
			semantic_reason: page.mode.semanticReason
		};
	}
});

const records = z.array(json);

export const getMyData = defineOperation({
	id: 'getMyData',
	method: 'GET',
	path: '/me/data',
	tag: TAG,
	summary: 'Мои данные',
	description:
		'Всё, что платформа хранит о кандидате: учётная запись со способами входа, ФСП ID, каналами и настройками ' +
		'уведомлений; анкета; резюме с распознанным текстом; факты с утверждениями, опытом и квитанциями; вся история ' +
		'расчётов категории с навыками и уровнями ФСП; возражения и ответы на них; заблокированные компании; ' +
		'соответствия видимым кандидату вакансиям; согласия с подписантами и принятые соглашения; представитель с ' +
		'проверками полномочий; приглашения с условиями и ответами, кому и что передано, процессы найма; тесты с ' +
		'артефактами; уведомления с доставками и журнал действий с данными кандидата. Сотрудники компаний и платформы ' +
		'названы ролью или компанией, не учётной записью. Каждая выгрузка записывается в журнал (`data.exported`).',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: [],
	response: {
		status: 200,
		description: 'Выгрузка данных кандидата',
		schema: z.object({
			format: z.literal(DATA_EXPORT_FORMAT),
			exported_at: dateTime,
			account: json,
			athlete_links: records,
			notification_channels: records,
			notification_preferences: records,
			profile: json,
			resumes: records,
			facts: records,
			experience: records,
			external_profiles: records,
			category: records,
			category_disputes: records,
			company_blocks: records,
			matches: records,
			consents: records,
			document_acceptances: records,
			representatives: records,
			invitations: records,
			disclosures: records,
			hiring: records,
			tests: records,
			notifications: records,
			journal: records
		})
	},
	async handle(ctx) {
		const { candidateId, userId } = await selfCandidate(ctx, 'candidate.self.read');
		return exportOwnData(ctx.services.db, ctx.services.crypto, {
			userId,
			candidateId,
			actor: { kind: 'user', userId },
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			channel: 'api'
		});
	}
});
