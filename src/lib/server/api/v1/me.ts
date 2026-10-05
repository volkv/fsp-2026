// The candidate's own side (contracts 5.5; domain 13.4, 18.2): the match with vacancies with the gaps and what to
// improve, and everything the platform keeps about the candidate («Мои данные»). Categories and objections are in
// `categories.ts`. Browser session only.
import { z } from 'zod';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { DATA_EXPORT_FORMAT, exportOwnData } from '$lib/server/candidates/data-export';
import { ApiError } from '$lib/server/errors/api-error';
import { recommendVacancies } from '$lib/server/matching/recommendations';
import { defineOperation } from '../operation';
import { candidateMatch, dateTime, key, pageQuery } from '../schemas';
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
		'уведомлений; анкета; резюме с распознанным текстом; факты с утверждениями, опытом и квитанциями; опросы и ' +
		'заявления грейда с подсказкой; вся история ' +
		'расчётов категории с навыками и уровнями ФСП; возражения и ответы на них; заблокированные компании; ' +
		'опыт, указанный вручную; предложения полей профиля из резюме с решениями; подтверждения категорий с кодом ' +
		'владельца; ' +
		'соответствия видимым кандидату вакансиям; согласия с подписантами и принятые соглашения; представитель с ' +
		'проверками полномочий; приглашения с условиями и ответами, кому и что передано, процессы найма; тесты с ' +
		'артефактами; запросы подтверждения и результаты блок-тестов; доставленные вызовы с решениями; собственные ' +
		'отклики; уведомления с доставками и журнал действий с данными кандидата. Сотрудники компаний и платформы ' +
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
			surveys: records,
			grade_declarations: records,
			evidence: records,
			categories: records,
			objections: records,
			company_blocks: records,
			manual_experience: records,
			profile_suggestions: records,
			category_attestations: records,
			matches: records,
			consents: records,
			document_acceptances: records,
			representatives: records,
			invitations: records,
			disclosures: records,
			hiring: records,
			tests: records,
			confirmation_requests: records,
			block_confirmations: records,
			challenges: records,
			applications: records,
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
