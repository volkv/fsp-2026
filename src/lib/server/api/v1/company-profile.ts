// The profile of the caller's company (contracts 9.2; domain 5.1): the description, the line of business and the
// contacts the candidate reads in an offer, with the label of the check — read-only here. Members read it by a session
// or an API key; the owner edits it in a session while the admission policy lets the company act.
import { z } from 'zod';
import {
	companyProfileFor,
	updateCompanyProfile,
	type CompanyPublicProfile
} from '$lib/server/companies/public-profile';
import { companyTrust } from '$lib/server/companies/trust';
import { requirePermission } from '$lib/server/companies/context';
import { ApiError } from '$lib/server/errors/api-error';
import { defineOperation } from '../operation';
import { companyTrust as companyTrustSchema, companyTrustView } from '../schemas';
import { companyDeps } from '../services';
import { actionContext, activeMembership } from './context';

const TAG = 'Компании';

const contacts = z
	.object({
		website: z.string().optional().describe('Сайт, `https://…`'),
		email: z.string().optional(),
		phone: z.string().optional(),
		telegram: z.string().optional().describe('`@имя` или `https://t.me/имя`')
	})
	.describe('Контакты организации, не сотрудника');

const profileSchema = z
	.object({
		company_id: z.uuid(),
		display_name: z.string(),
		description: z.string().nullable().describe('Описание организации, до 3000 символов'),
		activity: z.string().nullable().describe('Направление деятельности, до 200 символов'),
		contacts,
		verification: z
			.enum(['verified', 'unverified'])
			.describe('Метка проверки оператором — только чтение; проверка не обязательна для работы'),
		complete: z.boolean().describe('Описание и направление заполнены: компания может отправлять предложения')
	})
	.meta({ id: 'CompanyProfile', description: 'Профиль компании, который кандидат видит в предложении' });

const view = (profile: CompanyPublicProfile) => ({
	company_id: profile.id,
	display_name: profile.displayName,
	description: profile.description,
	activity: profile.activity,
	contacts: profile.contacts,
	verification: profile.verification,
	complete: profile.complete
});

export const getCompanyProfile = defineOperation({
	id: 'getCompanyProfile',
	method: 'GET',
	path: '/company/profile',
	tag: TAG,
	summary: 'Профиль своей компании',
	description: 'Описание, направление деятельности и контакты компании вызывающего; метка проверки — только чтение.',
	auth: 'account',
	permission: 'company.profile.read',
	errors: ['forbidden'],
	response: { status: 200, description: 'Профиль', schema: profileSchema },
	async handle(ctx) {
		const subject = await ctx.subject();
		const membership = activeMembership(subject);
		if (membership === null) throw new ApiError('forbidden');
		return view(await companyProfileFor(ctx.services.db, subject, membership.companyId));
	}
});

export const patchCompanyProfile = defineOperation({
	id: 'updateCompanyProfile',
	method: 'PATCH',
	path: '/company/profile',
	tag: TAG,
	summary: 'Изменить профиль компании',
	description:
		'Владелец меняет описание, направление и контакты; `null` очищает поле, `contacts` заменяются целиком. ' +
		'Компания `suspended` или `rejected` — `403` с кодом `company_suspended` / `company_rejected`.',
	auth: 'session',
	permission: 'company.profile.manage',
	body: z.strictObject({
		description: z.string().nullable().optional(),
		activity: z.string().nullable().optional(),
		contacts: contacts.optional()
	}),
	errors: ['forbidden'],
	response: { status: 200, description: 'Профиль после изменения', schema: profileSchema },
	async handle(ctx) {
		const action = await actionContext(ctx);
		const membership = activeMembership(action.subject);
		if (membership === null) throw new ApiError('forbidden');
		const { description, activity, contacts: given } = ctx.body;
		return view(
			await updateCompanyProfile(companyDeps(ctx.services), action, membership.companyId, {
				...(description === undefined ? {} : { description }),
				...(activity === undefined ? {} : { activity }),
				...(given === undefined ? {} : { contacts: given })
			})
		);
	}
});

export const getCompanyTrust = defineOperation({
	id: 'getCompanyTrust',
	method: 'GET',
	path: '/company/trust',
	tag: TAG,
	summary: 'Факты доверия к своей компании',
	description:
		'Те же факты, что кандидат видит в предложении компании: каждый — «столько из стольких» с числом наблюдений за год, ' +
		'меньше порога — «нет данных». Общего индекса или рейтинга нет.',
	auth: 'account',
	permission: 'company.profile.read',
	errors: ['forbidden'],
	response: { status: 200, description: 'Факты доверия', schema: companyTrustSchema },
	async handle(ctx) {
		const subject = await ctx.subject();
		const membership = activeMembership(subject);
		if (membership === null) throw new ApiError('forbidden');
		requirePermission(subject, 'company.profile.read', { companyId: membership.companyId });
		return companyTrustView(await companyTrust(ctx.services.db, membership.companyId, ctx.services.now()));
	}
});
