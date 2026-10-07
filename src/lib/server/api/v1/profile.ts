// The candidate's own profile (contracts 9.1; domain 7.1, 12.9): the fields typed by hand — the name, the contacts,
// the headline, the soft skills — with the suggestions of the resume for them, the experience stated by hand, and the
// list of blocked companies. Browser session only. The PDF profile is a file of the cabinet (`/me/profile/pdf`).
import { z } from 'zod';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { invitationMeta } from './context';
import {
	blockCompany,
	findCompaniesToBlock,
	listBlockedCompanies,
	unblockCompany
} from '$lib/server/profile/company-blocks';
import {
	addManualExperience,
	experienceInputSchema,
	removeManualExperience,
	updateManualExperience
} from '$lib/server/profile/experience';
import { decideSuggestion, profileInputSchema, updateOwnProfile } from '$lib/server/profile/fields';
import { PROFILE_SUGGESTION_FIELDS } from '$lib/server/db/schema';
import { ownProfileView, type OwnProfileView } from '$lib/server/profile/view';
import { ApiError } from '$lib/server/errors/api-error';
import { defineOperation } from '../operation';
import { dateTime, iso, key } from '../schemas';
import type { BaseContext } from './context';

const TAG = 'Профиль кандидата';

async function candidateSubject(ctx: BaseContext) {
	const subject = await ctx.subject();
	if (subject.candidate === null) throw new ApiError('forbidden');
	return subject;
}

/** The candidate of the subject allowed to read their own profile. */
function candidateIdOf(subject: AccessSubject): string {
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined || !can(subject, 'candidate.self.read', { candidateId }).allowed) {
		throw new ApiError('forbidden');
	}
	return candidateId;
}

const deps = (ctx: BaseContext) => ({ db: ctx.services.db, crypto: ctx.services.crypto, now: ctx.services.now });

const quoteSchema = z
	.object({
		extraction_id: z.uuid(),
		block_id: z.string(),
		start: z.int().describe('Начало цитаты в кодовых точках от начала блока'),
		end: z.int(),
		text: z.string()
	})
	.describe('Цитата из распознанного текста резюме');

const profileSchema = z
	.object({
		last_name: z.string().nullable(),
		first_name: z.string().nullable(),
		middle_name: z.string().nullable(),
		phone: z.string().nullable().describe('+<цифры>'),
		telegram: z.string().nullable().describe('@name'),
		email: z.string().describe('Почта аккаунта: контактная почта профиля, меняется в настройках аккаунта'),
		headline: z.string().nullable(),
		soft_skill_keys: z.array(key),
		desired_role_keys: z.array(key).describe('Желаемые роли: меняются в предпочтениях'),
		manual_experience: z.array(
			z.object({
				id: z.uuid(),
				position_title: z.string(),
				organization_name: z.string().nullable(),
				role_key: key.nullable(),
				period_from: z.string().describe('YYYY-MM'),
				period_to: z.string().nullable().describe('YYYY-MM; `null` — работа продолжается'),
				skill_keys: z.array(key),
				description: z.string().nullable()
			})
		),
		manual_experience_months: z.int().describe('Стаж по местам работы, указанным вручную: пересечения — один раз'),
		suggestions: z
			.array(
				z.object({
					id: z.uuid(),
					field: z.enum(PROFILE_SUGGESTION_FIELDS),
					value: z.string().describe('Нормализованное значение: контакт, ключ мягкого навыка или ФИО'),
					status: z.enum(['pending', 'accepted', 'rejected']),
					quote: quoteSchema
				})
			)
			.describe('Что разбор текущего резюме нашёл для полей профиля — каждое значение с цитатой'),
		attestations: z.array(
			z.object({
				handle: z.string().describe('Публичный идентификатор подтверждения категории (QR PDF-профиля)'),
				category_id: z.uuid(),
				status: z.enum(['valid', 'superseded', 'annulled']),
				holder_code: z
					.string()
					.describe('Код владельца: с ним и ФИО предъявитель доказывает, что подтверждение его. Секрет кандидата'),
				issued_at: dateTime
			})
		)
	})
	.meta({ id: 'OwnProfile', description: 'Профиль кандидата под его контролем' });

function profileBody(view: OwnProfileView): z.input<typeof profileSchema> {
	const { profile } = view;
	return {
		last_name: profile.fullName?.last ?? null,
		first_name: profile.fullName?.first ?? null,
		middle_name: profile.fullName?.middle ?? null,
		phone: profile.phone,
		telegram: profile.telegram,
		email: profile.email,
		headline: profile.headline,
		soft_skill_keys: profile.softSkillKeys,
		desired_role_keys: profile.desiredRoleKeys,
		manual_experience: view.experience.map((entry) => ({
			id: entry.id,
			position_title: entry.positionTitle,
			organization_name: entry.organizationName,
			role_key: entry.roleKey,
			period_from: entry.periodFrom,
			period_to: entry.periodTo,
			skill_keys: entry.skillKeys,
			description: entry.description
		})),
		manual_experience_months: view.experienceMonths,
		suggestions: view.suggestions.map((suggestion) => ({
			id: suggestion.id,
			field: suggestion.field,
			value: suggestion.label,
			status: suggestion.status,
			quote: {
				extraction_id: suggestion.quote.extractionId,
				block_id: suggestion.quote.blockId,
				start: suggestion.quote.start,
				end: suggestion.quote.end,
				text: suggestion.quote.text
			}
		})),
		attestations: view.attestations.map((attestation) => ({
			handle: attestation.handle,
			category_id: attestation.categoryId,
			status: attestation.status,
			holder_code: attestation.holderCode,
			issued_at: iso(attestation.issuedAt)
		}))
	};
}

export const getMyProfile = defineOperation({
	id: 'getMyProfile',
	method: 'GET',
	path: '/me/profile',
	tag: TAG,
	summary: 'Мой профиль',
	description:
		'Поля профиля, которые кандидат ведёт сам: ФИО, телефон, Telegram, желаемая должность, мягкие навыки, опыт, ' +
		'указанный вручную, со стажем; что разбор текущего резюме нашёл для этих полей — с цитатами и решением ' +
		'кандидата; подтверждения категорий с их статусом и кодом владельца.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: ['forbidden'],
	response: { status: 200, description: 'Профиль', schema: profileSchema },
	async handle(ctx) {
		return profileBody(await ownProfileView(deps(ctx), await candidateSubject(ctx)));
	}
});

export const updateMyProfile = defineOperation({
	id: 'updateMyProfile',
	method: 'PUT',
	path: '/me/profile',
	tag: TAG,
	summary: 'Сохранить поля профиля',
	description:
		'Все поля формы сразу: пустое значение очищает поле. Фамилия и имя указываются вместе. ФИО и контакты ' +
		'хранятся зашифрованными; компания видит их только после раскрытия по принятому предложению. Без действующего ' +
		'согласия на обработку — `422 policy_violation`.',
	auth: 'session',
	permission: 'candidate.self.write',
	body: profileInputSchema,
	errors: ['forbidden', 'policy_violation'],
	response: { status: 200, description: 'Профиль после сохранения', schema: profileSchema },
	async handle(ctx) {
		const subject = await candidateSubject(ctx);
		await updateOwnProfile(deps(ctx), subject, invitationMeta(ctx), ctx.body);
		return profileBody(await ownProfileView(deps(ctx), subject));
	}
});

export const decideProfileSuggestion = defineOperation({
	id: 'decideProfileSuggestion',
	method: 'POST',
	path: '/me/profile/suggestions/{suggestion_id}/decision',
	tag: TAG,
	summary: 'Принять или отклонить значение из резюме',
	description:
		'`accepted` записывает значение в поле профиля, как если бы его ввели вручную (мягкий навык добавляется к ' +
		'списку); `rejected` только отмечает решение. Почта из резюме не принимается: контактная почта — почта ' +
		'аккаунта (`409`). Решённое значение — `409`.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ suggestion_id: z.uuid() }),
	body: z.strictObject({ decision: z.enum(['accepted', 'rejected']) }),
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
	response: { status: 204, description: 'Решение записано' },
	async handle(ctx) {
		const subject = await candidateSubject(ctx);
		await decideSuggestion(deps(ctx), subject, invitationMeta(ctx), ctx.params.suggestion_id, ctx.body.decision);
	}
});

const experienceCreated = z.object({ id: z.uuid() });

export const addMyExperience = defineOperation({
	id: 'addMyExperience',
	method: 'POST',
	path: '/me/profile/experience',
	tag: TAG,
	summary: 'Добавить место работы вручную',
	description:
		'Опыт со слов кандидата: в профиле и PDF-профиле он помечен «указано кандидатом» и не входит в подсказку ' +
		'грейда, категорию и подбор — они опираются на резюме и тесты. До 20 мест работы.',
	auth: 'session',
	permission: 'candidate.self.write',
	idempotent: true,
	body: experienceInputSchema,
	errors: ['forbidden', 'conflict', 'policy_violation'],
	response: { status: 201, description: 'Место работы добавлено', schema: experienceCreated },
	async handle(ctx) {
		const subject = await candidateSubject(ctx);
		return { id: await addManualExperience(deps(ctx), subject, invitationMeta(ctx), ctx.body) };
	}
});

export const updateMyExperience = defineOperation({
	id: 'updateMyExperience',
	method: 'PUT',
	path: '/me/profile/experience/{entry_id}',
	tag: TAG,
	summary: 'Изменить место работы, указанное вручную',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ entry_id: z.uuid() }),
	body: experienceInputSchema,
	errors: ['forbidden', 'not_found', 'policy_violation'],
	response: { status: 204, description: 'Сохранено' },
	async handle(ctx) {
		const subject = await candidateSubject(ctx);
		await updateManualExperience(deps(ctx), subject, invitationMeta(ctx), ctx.params.entry_id, ctx.body);
	}
});

export const removeMyExperience = defineOperation({
	id: 'removeMyExperience',
	method: 'DELETE',
	path: '/me/profile/experience/{entry_id}',
	tag: TAG,
	summary: 'Удалить место работы, указанное вручную',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ entry_id: z.uuid() }),
	errors: ['forbidden', 'not_found'],
	response: { status: 204, description: 'Удалено' },
	async handle(ctx) {
		const subject = await candidateSubject(ctx);
		await removeManualExperience(deps(ctx), subject, invitationMeta(ctx), ctx.params.entry_id);
	}
});

const blockedCompany = z
	.object({ company_id: z.uuid(), display_name: z.string(), blocked_at: dateTime })
	.meta({ id: 'BlockedCompany', description: 'Компания, которой кандидат не показывается' });

export const listMyCompanyBlocks = defineOperation({
	id: 'listMyCompanyBlocks',
	method: 'GET',
	path: '/me/company-blocks',
	tag: TAG,
	summary: 'Заблокированные компании',
	description:
		'Компании, которым кандидат не показывается: ни в каталоге и поиске, ни в подборках и соответствиях ' +
		'вакансий, ни по прямой ссылке на карточку. Правило читается при каждом запросе компании.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: ['forbidden'],
	response: {
		status: 200,
		description: 'Заблокированные компании',
		schema: z.object({ items: z.array(blockedCompany) })
	},
	async handle(ctx) {
		const candidateId = candidateIdOf(await candidateSubject(ctx));
		const blocked = await listBlockedCompanies(ctx.services.db, candidateId);
		return {
			items: blocked.map((item) => ({
				company_id: item.companyId,
				display_name: item.displayName,
				blocked_at: iso(item.blockedAt)
			}))
		};
	}
});

export const searchCompaniesToBlock = defineOperation({
	id: 'searchCompaniesToBlock',
	method: 'GET',
	path: '/me/company-blocks/search',
	tag: TAG,
	summary: 'Найти компанию, чтобы скрыть себя от неё',
	description: 'Компании платформы по названию (от двух букв), ещё не в блок-листе; до 20.',
	auth: 'session',
	permission: 'candidate.self.read',
	query: z.strictObject({ q: z.string().max(100).describe('Часть названия компании') }),
	errors: ['forbidden'],
	response: {
		status: 200,
		description: 'Найденные компании',
		schema: z.object({ items: z.array(z.object({ company_id: z.uuid(), display_name: z.string() })) })
	},
	async handle(ctx) {
		const candidateId = candidateIdOf(await candidateSubject(ctx));
		const found = await findCompaniesToBlock(ctx.services.db, candidateId, ctx.query.q);
		return { items: found.map((item) => ({ company_id: item.companyId, display_name: item.displayName })) };
	}
});

export const blockMyCompany = defineOperation({
	id: 'blockMyCompany',
	method: 'PUT',
	path: '/me/company-blocks/{company_id}',
	tag: TAG,
	summary: 'Скрыть себя от компании',
	description: 'Добавляет компанию в блок-лист; повтор ничего не меняет.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ company_id: z.uuid() }),
	errors: ['forbidden', 'not_found'],
	response: { status: 204, description: 'Компания в блок-листе' },
	async handle(ctx) {
		await blockCompany(deps(ctx), await candidateSubject(ctx), invitationMeta(ctx), ctx.params.company_id);
	}
});

export const unblockMyCompany = defineOperation({
	id: 'unblockMyCompany',
	method: 'DELETE',
	path: '/me/company-blocks/{company_id}',
	tag: TAG,
	summary: 'Убрать компанию из блок-листа',
	auth: 'session',
	permission: 'candidate.self.write',
	params: z.strictObject({ company_id: z.uuid() }),
	errors: ['forbidden', 'not_found'],
	response: { status: 204, description: 'Компания убрана из блок-листа' },
	async handle(ctx) {
		await unblockCompany(deps(ctx), await candidateSubject(ctx), invitationMeta(ctx), ctx.params.company_id);
	}
});
