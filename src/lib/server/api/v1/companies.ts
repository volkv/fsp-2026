// Companies (contracts 5.5; domain 5): the draft and its verification, the team and the API keys. Operations of the
// owner in a browser session: API keys never manage companies, members or keys (contracts 5.2).
import { z } from 'zod';
import { createApiKey, listApiKeys, revokeApiKey } from '$lib/server/companies/api-keys';
import { requirePermission } from '$lib/server/companies/context';
import { inviteMember, listMembers, removeMember, setMemberRole } from '$lib/server/companies/members';
import { companyOverview, createCompanyDraft, updateCompanyDraft } from '$lib/server/companies/profile';
import { submitForVerification, type AuthorityMethod } from '$lib/server/companies/verification';
import { defineOperation } from '../operation';
import { dateTime, id, iso, isoOrNull, page, pageOf, pageQuery } from '../schemas';
import { companyDeps } from '../services';
import { actionContext, type BaseContext } from './context';

const TAG = 'Компании';

const companyParams = z.strictObject({ company_id: id('Компания') });

/** Every method of the database enum, with what it means; a new method fails to compile until it is described. */
const AUTHORITY_METHODS = {
	director_self: 'заявитель — руководитель по реестру и подтверждает это документом',
	power_of_attorney: 'доверенность',
	corporate_email_domain: 'почта заявителя на домене организации; оператор проверяет её без файла',
	signed_letter: 'подписанное письмо организации',
	esign: 'документ с электронной подписью'
} as const satisfies Record<AuthorityMethod, string>;

const authorityMethod = z.enum(Object.keys(AUTHORITY_METHODS) as [AuthorityMethod, ...AuthorityMethod[]]).describe(
	'Способ подтверждения полномочий заявителя: ' +
		Object.entries(AUTHORITY_METHODS)
			.map(([method, meaning]) => `\`${method}\` — ${meaning}`)
			.join('; ')
);

const companySchema = z
	.object({
		id: z.uuid(),
		inn: z.string(),
		ogrn: z.string().nullable(),
		kpp: z.string().nullable(),
		legal_name: z.string(),
		display_name: z.string(),
		status: z.enum(['draft', 'submitted', 'verified', 'rejected', 'suspended']),
		verified_at: dateTime.nullable(),
		verification: z
			.object({
				id: z.uuid(),
				state: z.enum(['pending', 'approved', 'rejected', 'needs_info']),
				reason: z.string().nullable().describe('Сообщение оператора владельцу при отказе или запросе уточнения'),
				submitted_at: dateTime,
				decided_at: dateTime.nullable()
			})
			.nullable()
			.describe('Последняя заявка на проверку и её исход')
	})
	.meta({ id: 'Company', description: 'Компания глазами её владельца' });

export const createCompany = defineOperation({
	id: 'createCompany',
	method: 'POST',
	path: '/companies',
	tag: TAG,
	summary: 'Создать черновик компании',
	description:
		'Создаёт компанию в статусе `draft` с вызывающим как владельцем. Вызывающий — не кандидат и не действующий ' +
		'участник другой компании; принимает показанную редакцию условий для работодателя.',
	auth: 'session',
	permission: 'company.create',
	idempotent: true,
	body: z.strictObject({
		inn: z.string().describe('ИНН: 10 цифр для организации, 12 для ИП'),
		display_name: z.string().describe('Название для интерфейса'),
		legal_name: z.string().optional().describe('Полное наименование; по умолчанию — название для интерфейса'),
		employer_terms_id: z.uuid().describe('Версия условий для работодателя, показанная на форме')
	}),
	errors: ['conflict'],
	response: {
		status: 201,
		description: 'Черновик создан',
		schema: z.object({ company_id: z.uuid(), member_id: z.uuid() })
	},
	async handle(ctx) {
		const created = await createCompanyDraft(companyDeps(ctx.services), await actionContext(ctx), {
			inn: ctx.body.inn,
			displayName: ctx.body.display_name,
			...(ctx.body.legal_name === undefined ? {} : { legalName: ctx.body.legal_name }),
			employerTermsId: ctx.body.employer_terms_id
		});
		return { company_id: created.companyId, member_id: created.memberId };
	}
});

async function companyView(ctx: BaseContext, companyId: string) {
	const company = await companyOverview(companyDeps(ctx.services), await actionContext(ctx), companyId);
	return {
		id: company.id,
		inn: company.inn,
		ogrn: company.ogrn,
		kpp: company.kpp,
		legal_name: company.legalName,
		display_name: company.displayName,
		status: company.status,
		verified_at: isoOrNull(company.verifiedAt),
		verification: company.verification && {
			id: company.verification.id,
			state: company.verification.state,
			reason: company.verification.reason,
			submitted_at: iso(company.verification.submittedAt),
			decided_at: isoOrNull(company.verification.decidedAt)
		}
	};
}

export const getCompany = defineOperation({
	id: 'getCompany',
	method: 'GET',
	path: '/companies/{company_id}',
	tag: TAG,
	summary: 'Профиль компании',
	description: 'Реквизиты и состояние проверки. Чужая компания — `404`.',
	auth: 'session',
	permission: 'company.profile.manage',
	params: companyParams,
	errors: ['not_found'],
	response: { status: 200, description: 'Компания', schema: companySchema },
	handle: (ctx) => companyView(ctx, ctx.params.company_id)
});

export const updateCompany = defineOperation({
	id: 'updateCompany',
	method: 'PATCH',
	path: '/companies/{company_id}',
	tag: TAG,
	summary: 'Изменить реквизиты',
	description: 'Реквизиты меняются в статусах `draft` и `rejected`; `null` очищает ОГРН или КПП.',
	auth: 'session',
	permission: 'company.profile.manage',
	params: companyParams,
	body: z.strictObject({
		inn: z.string().optional(),
		display_name: z.string().optional(),
		legal_name: z.string().optional(),
		ogrn: z.string().nullable().optional(),
		kpp: z.string().nullable().optional()
	}),
	errors: ['not_found', 'conflict'],
	response: { status: 200, description: 'Компания после изменения', schema: companySchema },
	async handle(ctx) {
		const { inn, display_name, legal_name, ogrn, kpp } = ctx.body;
		await updateCompanyDraft(companyDeps(ctx.services), await actionContext(ctx), ctx.params.company_id, {
			...(inn === undefined ? {} : { inn }),
			...(display_name === undefined ? {} : { displayName: display_name }),
			...(legal_name === undefined ? {} : { legalName: legal_name }),
			...(ogrn === undefined ? {} : { ogrn }),
			...(kpp === undefined ? {} : { kpp })
		});
		return companyView(ctx, ctx.params.company_id);
	}
});

export const submitCompanyVerification = defineOperation({
	id: 'submitCompanyVerification',
	method: 'POST',
	path: '/companies/{company_id}/verification',
	tag: TAG,
	summary: 'Подать компанию на проверку',
	description:
		'Владелец подаёт `draft` или `rejected` компанию на проверку оператором ФСП. Кроме способа ' +
		'`corporate_email_domain`, нужен загруженный файл подтверждения полномочий (назначение `company_authority_evidence`).',
	auth: 'session',
	permission: 'company.profile.manage',
	idempotent: true,
	params: companyParams,
	body: z.strictObject({
		authority_method: authorityMethod,
		authority_evidence_file_id: z.uuid().nullable().describe('Файл, подтверждающий полномочия')
	}),
	errors: ['not_found', 'conflict'],
	response: { status: 202, description: 'Заявка принята к проверке', schema: z.object({ verification_id: z.uuid() }) },
	async handle(ctx) {
		const { verificationId } = await submitForVerification(
			companyDeps(ctx.services),
			await actionContext(ctx),
			ctx.params.company_id,
			{ authorityMethod: ctx.body.authority_method, authorityEvidenceFileId: ctx.body.authority_evidence_file_id }
		);
		return { verification_id: verificationId };
	}
});

const memberSchema = z
	.object({
		member_id: z.uuid(),
		role: z.enum(['owner', 'recruiter']),
		status: z.enum(['invited', 'active']),
		user_id: z.uuid().nullable().describe('`null` — приглашение ещё не принято'),
		display_name: z.string().nullable(),
		joined_at: dateTime.nullable(),
		invited_at: dateTime
	})
	.meta({ id: 'CompanyMember', description: 'Участник команды или открытое приглашение' });

export const listCompanyMembers = defineOperation({
	id: 'listCompanyMembers',
	method: 'GET',
	path: '/companies/{company_id}/members',
	tag: TAG,
	summary: 'Команда',
	description: 'Действующие участники и открытые приглашения.',
	auth: 'session',
	permission: 'company.members.manage',
	params: companyParams,
	query: z.strictObject(pageQuery),
	errors: ['not_found'],
	response: { status: 200, description: 'Страница команды', schema: page(memberSchema) },
	async handle(ctx) {
		const members = await listMembers(companyDeps(ctx.services), await actionContext(ctx), ctx.params.company_id);
		return pageOf(
			members.map((member) => ({
				member_id: member.memberId,
				role: member.role,
				status: member.status,
				user_id: member.userId,
				display_name: member.displayName,
				joined_at: isoOrNull(member.joinedAt),
				invited_at: iso(member.invitedAt)
			})),
			ctx.query,
			{ op: 'members', company: ctx.params.company_id }
		);
	}
});

export const inviteCompanyMember = defineOperation({
	id: 'inviteCompanyMember',
	method: 'POST',
	path: '/companies/{company_id}/members',
	tag: TAG,
	summary: 'Пригласить в команду',
	description:
		'Письмо со ссылкой уходит на указанный адрес; повторное приглашение того же адреса выдаёт новую ссылку. ' +
		'`letter_sent: false` — письмо не отправилось, приглашение можно повторить.',
	auth: 'session',
	permission: 'company.members.manage',
	idempotent: true,
	params: companyParams,
	body: z.strictObject({ email: z.string(), role: z.enum(['owner', 'recruiter']) }),
	errors: ['not_found', 'conflict'],
	response: {
		status: 201,
		description: 'Приглашение создано',
		schema: z.object({ member_id: z.uuid(), letter_sent: z.boolean() })
	},
	async handle(ctx) {
		const invited = await inviteMember(companyDeps(ctx.services), await actionContext(ctx), ctx.params.company_id, {
			email: ctx.body.email,
			role: ctx.body.role
		});
		return { member_id: invited.memberId, letter_sent: invited.letterSent };
	}
});

const memberParams = companyParams.extend({ member_id: id('Участник команды') });

export const updateCompanyMember = defineOperation({
	id: 'updateCompanyMember',
	method: 'PATCH',
	path: '/companies/{company_id}/members/{member_id}',
	tag: TAG,
	summary: 'Сменить роль участника',
	description: 'Последнего действующего владельца понизить нельзя.',
	auth: 'session',
	permission: 'company.members.manage',
	params: memberParams,
	body: z.strictObject({ role: z.enum(['owner', 'recruiter']) }),
	errors: ['not_found', 'conflict'],
	response: { status: 204, description: 'Роль изменена' },
	async handle(ctx) {
		const action = await actionContext(ctx);
		requirePermission(action.subject, 'company.members.manage', { companyId: ctx.params.company_id });
		await setMemberRole(companyDeps(ctx.services), action, ctx.params.member_id, ctx.body.role);
	}
});

export const removeCompanyMember = defineOperation({
	id: 'removeCompanyMember',
	method: 'DELETE',
	path: '/companies/{company_id}/members/{member_id}',
	tag: TAG,
	summary: 'Исключить участника или отозвать приглашение',
	description:
		'Исключённый теряет доступ сразу; ключи API, которые он создал, отзываются в той же транзакции. Последнего ' +
		'действующего владельца исключить нельзя.',
	auth: 'session',
	permission: 'company.members.manage',
	params: memberParams,
	errors: ['not_found', 'conflict'],
	response: { status: 204, description: 'Участник исключён' },
	async handle(ctx) {
		const action = await actionContext(ctx);
		requirePermission(action.subject, 'company.members.manage', { companyId: ctx.params.company_id });
		await removeMember(companyDeps(ctx.services), action, ctx.params.member_id);
	}
});

const apiKeySchema = z
	.object({
		id: z.uuid(),
		name: z.string(),
		prefix: z.string().describe('Открытая часть ключа: `fspk_<prefix>_…`'),
		permissions: z.array(z.string()),
		created_by_member_id: z.uuid(),
		created_at: dateTime,
		expires_at: dateTime.nullable(),
		last_used_at: dateTime.nullable(),
		revoked_at: dateTime.nullable()
	})
	.meta({ id: 'ApiKey', description: 'Ключ API без секрета' });

type KeySummary = Awaited<ReturnType<typeof listApiKeys>>[number];

const keyView = (key: KeySummary) => ({
	id: key.id,
	name: key.name,
	prefix: key.prefix,
	permissions: key.permissions,
	created_by_member_id: key.createdByMemberId,
	created_at: iso(key.createdAt),
	expires_at: isoOrNull(key.expiresAt),
	last_used_at: isoOrNull(key.lastUsedAt),
	revoked_at: isoOrNull(key.revokedAt)
});

export const listCompanyApiKeys = defineOperation({
	id: 'listCompanyApiKeys',
	method: 'GET',
	path: '/companies/{company_id}/api-keys',
	tag: TAG,
	summary: 'Ключи API',
	description: 'Ключи компании без секретов, новые первыми.',
	auth: 'session',
	permission: 'api_key.manage',
	params: companyParams,
	query: z.strictObject(pageQuery),
	errors: ['not_found'],
	response: { status: 200, description: 'Страница ключей', schema: page(apiKeySchema) },
	async handle(ctx) {
		const keys = await listApiKeys(companyDeps(ctx.services), await actionContext(ctx), ctx.params.company_id);
		return pageOf(keys.map(keyView), ctx.query, { op: 'api-keys', company: ctx.params.company_id });
	}
});

export const createCompanyApiKey = defineOperation({
	id: 'createCompanyApiKey',
	method: 'POST',
	path: '/companies/{company_id}/api-keys',
	tag: TAG,
	summary: 'Выпустить ключ API',
	description:
		'Только проверенной компании. Права ключа — подмножество прав создателя из тех, что доступны ключам. ' +
		'Секрет (`token`) показывается один раз и не хранится: повтор запроса выпускает новый ключ.',
	auth: 'session',
	permission: 'api_key.manage',
	params: companyParams,
	body: z.strictObject({
		name: z.string(),
		permissions: z.array(z.string()).describe('Права из реестра, например `catalog.search`, `invitation.create`'),
		expires_at: z.iso.datetime().nullable().describe('Срок действия; `null` — бессрочно')
	}),
	errors: ['not_found', 'conflict'],
	response: {
		status: 201,
		description: 'Ключ выпущен',
		schema: z.object({ key: apiKeySchema, token: z.string().describe('Ключ целиком; больше не показывается') })
	},
	async handle(ctx) {
		const created = await createApiKey(companyDeps(ctx.services), await actionContext(ctx), ctx.params.company_id, {
			name: ctx.body.name,
			permissions: ctx.body.permissions,
			expiresAt: ctx.body.expires_at === null ? null : new Date(ctx.body.expires_at)
		});
		return { key: keyView(created.key), token: created.token };
	}
});

export const revokeCompanyApiKey = defineOperation({
	id: 'revokeCompanyApiKey',
	method: 'DELETE',
	path: '/companies/{company_id}/api-keys/{key_id}',
	tag: TAG,
	summary: 'Отозвать ключ API',
	description: 'Отзыв действует со следующего запроса; повторный отзыв ничего не меняет.',
	auth: 'session',
	permission: 'api_key.manage',
	params: companyParams.extend({ key_id: id('Ключ API') }),
	errors: ['not_found'],
	response: { status: 204, description: 'Ключ отозван' },
	async handle(ctx) {
		const action = await actionContext(ctx);
		requirePermission(action.subject, 'api_key.manage', { companyId: ctx.params.company_id });
		await revokeApiKey(companyDeps(ctx.services), action, ctx.params.key_id);
	}
});
