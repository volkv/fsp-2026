// The candidate's own applications (domain 13.5, 13.6; CONCEPT 4 — the secondary way to contact): the showcase is the
// published vacancies of the companies of the platform (`GET /me/matches`); an application carries the
// match of the pair and discloses the chosen contacts to that company; the candidate sees the statuses, the company sees
// the applications to its vacancies by pseudonym and declines or invites by an offer.
import { z } from 'zod';
import {
	applyToVacancy,
	companyApplications,
	getApplication,
	myApplications,
	rejectApplication,
	withdrawApplication,
	type ApplicationContacts,
	type ApplicationView
} from '$lib/server/applications/service';
import { DISCLOSURE_FIELDS } from '$lib/server/consent/kinds';
import { APPLICATION_STATUSES } from '$lib/server/db/schema';
import { defineOperation } from '../operation';
import { dateTime, id, iso, isoOrNull, pseudonym } from '../schemas';
import { contactDeps } from '../services';
import { invitationMeta } from './context';

const TAG = 'Отклики';

const applicationSchema = z
	.object({
		id: z.uuid(),
		status: z.enum(APPLICATION_STATUSES),
		vacancy: z.object({ id: z.uuid(), title: z.string() }),
		company: z.object({ id: z.uuid(), display_name: z.string() }),
		candidate_pseudonym: pseudonym.nullable().describe('Кандидат для компании; кандидату — `null`'),
		message: z
			.string()
			.nullable()
			.describe('Сопроводительное сообщение; компании — с контактами, скрытыми до раскрытия ей контактов кандидата'),
		match: z
			.object({
				score: z.number(),
				coverage: z.number(),
				ruleset_version: z.int(),
				components: z.record(z.string(), z.object({ value: z.number().nullable(), status: z.string() })),
				matches: z.array(z.record(z.string(), z.unknown())),
				gaps: z.array(z.record(z.string(), z.unknown())),
				to_verify: z.array(z.record(z.string(), z.unknown())),
				unknown: z.array(z.object({ component: z.string(), status: z.string(), reason: z.string() }))
			})
			.describe('Соответствие пары на момент отклика, без внутренних идентификаторов фактов'),
		invitation_id: z.uuid().nullable().describe('Предложение компании по отклику'),
		submitted_at: dateTime,
		viewed_at: dateTime.nullable(),
		decided_at: dateTime.nullable(),
		closed_at: dateTime.nullable(),
		disclosed_fields: z.array(z.enum(DISCLOSURE_FIELDS)).describe('Что компания получает по согласию отклика сейчас')
	})
	.meta({ id: 'Application', description: 'Собственный отклик кандидата на вакансию' });

const applicationOut = (view: ApplicationView) => ({
	id: view.id,
	status: view.status,
	vacancy: view.vacancy,
	company: { id: view.companyId, display_name: view.companyName },
	candidate_pseudonym: view.candidatePseudonym,
	message: view.message,
	match: view.match,
	invitation_id: view.invitationId,
	submitted_at: iso(view.submittedAt),
	viewed_at: isoOrNull(view.viewedAt),
	decided_at: isoOrNull(view.decidedAt),
	closed_at: isoOrNull(view.closedAt),
	disclosed_fields: view.disclosedFields
});

const contactsSchema = z
	.object({
		fields: z.array(z.enum(DISCLOSURE_FIELDS)),
		full_name: z
			.object({ last: z.string().nullable(), first: z.string().nullable(), middle: z.string().nullable() })
			.optional(),
		email: z.string().optional(),
		phone: z.string().nullable().optional(),
		telegram: z.string().nullable().optional(),
		resume_file_id: z.uuid().nullable().optional()
	})
	.meta({ id: 'ApplicationContacts', description: 'Контакты, раскрытые кандидатом по отклику' });

const contactsOut = (contacts: ApplicationContacts) => ({
	fields: contacts.fields,
	...(contacts.fullName === undefined ? {} : { full_name: contacts.fullName }),
	...(contacts.email === undefined ? {} : { email: contacts.email }),
	...(contacts.phone === undefined ? {} : { phone: contacts.phone }),
	...(contacts.telegram === undefined ? {} : { telegram: contacts.telegram }),
	...(contacts.resumeFileId === undefined ? {} : { resume_file_id: contacts.resumeFileId })
});

const applicationParams = z.strictObject({ application_id: id('Отклик') });

export const createApplication = defineOperation({
	id: 'createApplication',
	method: 'POST',
	path: '/me/applications',
	tag: TAG,
	summary: 'Откликнуться на вакансию',
	description:
		'Только на опубликованную вакансию компании платформы (витрина — `GET /me/matches`); ' +
		'чужой демо-сессии или несуществующая — `404`, закрытая — `409 vacancy_closed`, повтор — ' +
		'`409 already_applied`. С откликом кандидат даёт согласие на раскрытие выбранных контактов этой компании (ФИО и ' +
		'почта — минимум) по тексту `disclosure_document_id`; изменившийся текст — `409 disclosure_document_changed`. ' +
		'Отклик — с 18 лет (`422 application_adult_only`).',
	auth: 'session',
	permission: 'candidate.self.write',
	idempotent: true,
	body: z.strictObject({
		vacancy_id: z.uuid(),
		message: z.string().nullable().optional().describe('Сопроводительное сообщение, до 2000 символов'),
		disclose_fields: z.array(z.enum(DISCLOSURE_FIELDS)),
		disclosure_document_id: z.uuid().describe('Версия текста согласия на раскрытие, показанная кандидату')
	}),
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
	response: { status: 201, description: 'Отклик отправлен', schema: applicationSchema },
	async handle(ctx) {
		return applicationOut(
			await applyToVacancy(contactDeps(ctx.services), await ctx.subject(), invitationMeta(ctx), {
				vacancyId: ctx.body.vacancy_id,
				message: ctx.body.message ?? null,
				discloseFields: ctx.body.disclose_fields,
				disclosureDocumentId: ctx.body.disclosure_document_id
			})
		);
	}
});

export const listMyApplications = defineOperation({
	id: 'listMyApplications',
	method: 'GET',
	path: '/me/applications',
	tag: TAG,
	summary: 'Мои отклики',
	description: 'Отклики кандидата со статусами: отправлен, просмотрен, приглашение, отказ, отозван.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: ['forbidden'],
	response: { status: 200, description: 'Отклики', schema: z.object({ items: z.array(applicationSchema) }) },
	async handle(ctx) {
		return { items: (await myApplications(contactDeps(ctx.services), await ctx.subject())).map(applicationOut) };
	}
});

export const withdrawMyApplication = defineOperation({
	id: 'withdrawApplication',
	method: 'POST',
	path: '/me/applications/{application_id}/withdrawal',
	tag: TAG,
	summary: 'Отозвать отклик',
	description:
		'Отклик закрывается, согласие на раскрытие по нему отзывается: компания теряет дальнейший доступ к контактам ' +
		'через платформу, уже переданное остаётся у неё. Закрытый — `409`.',
	auth: 'session',
	permission: 'candidate.self.write',
	params: applicationParams,
	errors: ['forbidden', 'not_found', 'conflict'],
	response: { status: 200, description: 'Отклик', schema: applicationSchema },
	async handle(ctx) {
		return applicationOut(
			await withdrawApplication(
				contactDeps(ctx.services),
				await ctx.subject(),
				invitationMeta(ctx),
				ctx.params.application_id
			)
		);
	}
});

export const listCompanyApplications = defineOperation({
	id: 'listApplications',
	method: 'GET',
	path: '/applications',
	tag: TAG,
	summary: 'Входящие отклики',
	description: 'Отклики на собственные вакансии компании по псевдонимам, новые первыми.',
	auth: 'account',
	permission: 'application.manage',
	query: z.strictObject({
		vacancy_id: z.uuid().optional(),
		status: z.enum(APPLICATION_STATUSES).optional()
	}),
	errors: ['forbidden'],
	response: { status: 200, description: 'Отклики', schema: z.object({ items: z.array(applicationSchema) }) },
	async handle(ctx) {
		return {
			items: (
				await companyApplications(contactDeps(ctx.services), await ctx.subject(), {
					...(ctx.query.vacancy_id === undefined ? {} : { vacancyId: ctx.query.vacancy_id }),
					...(ctx.query.status === undefined ? {} : { status: ctx.query.status })
				})
			).map(applicationOut)
		};
	}
});

export const getCompanyApplication = defineOperation({
	id: 'getApplication',
	method: 'GET',
	path: '/applications/{application_id}',
	tag: TAG,
	summary: 'Отклик с контактами',
	description:
		'Отклик и контакты, раскрытые по нему, пока действует согласие (`contacts: null` — отозвано). Первое открытие ' +
		'отмечает отклик просмотренным; чтение контактов записывается в журнал. Чужой — `404`.',
	auth: 'account',
	permission: 'application.manage',
	params: applicationParams,
	errors: ['forbidden', 'not_found'],
	response: {
		status: 200,
		description: 'Отклик',
		schema: z.object({ application: applicationSchema, contacts: contactsSchema.nullable() })
	},
	async handle(ctx) {
		const found = await getApplication(
			contactDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.application_id
		);
		return {
			application: applicationOut(found.application),
			contacts: found.contacts && contactsOut(found.contacts)
		};
	}
});

export const rejectCompanyApplication = defineOperation({
	id: 'rejectApplication',
	method: 'POST',
	path: '/applications/{application_id}/rejection',
	tag: TAG,
	summary: 'Отказать по отклику',
	description:
		'Кандидат получает уведомление. Пригласить — отправить предложение (`POST /invitations`): отклик станет ' +
		'`invited`. Закрытый — `409`.',
	auth: 'account',
	permission: 'application.manage',
	params: applicationParams,
	errors: ['forbidden', 'not_found', 'conflict'],
	response: { status: 200, description: 'Отклик', schema: applicationSchema },
	async handle(ctx) {
		return applicationOut(
			await rejectApplication(
				contactDeps(ctx.services),
				await ctx.subject(),
				invitationMeta(ctx),
				ctx.params.application_id
			)
		);
	}
});
