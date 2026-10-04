// Invitations (contracts 5.5; domain 13.5–13.6): the company offers a vacancy and a salary to a candidate it sees in
// the context of that vacancy; every offer is an immutable version of terms; the candidate answers a concrete version;
// contacts are disclosed to that company only after acceptance and only as the candidate chose.
import { z } from 'zod';
import { DISCLOSURE_FIELDS } from '$lib/server/consent/kinds';
import { ApiError } from '$lib/server/errors/api-error';
import { currentDisclosureDocument } from '$lib/server/invitations/consent';
import { recipientContacts, sendDisclosureLetter } from '$lib/server/invitations/disclosure';
import { getInvitation, listInvitations, type InvitationView } from '$lib/server/invitations/read';
import { markInvitationViewed, respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation, reviseInvitation, withdrawInvitation } from '$lib/server/invitations/send';
import type { OfferedSalary } from '$lib/server/invitations/terms';
import { defineOperation } from '../operation';
import { candidateOfPseudonym } from '../read/pseudonyms';
import { dateTime, id, iso, isoOrNull, offeredSalary, page, pageOf, pageQuery, pseudonym } from '../schemas';
import { invitationDeps } from '../services';
import { activeMembership, invitationMeta, type BaseContext } from './context';

const TAG = 'Приглашения';

const invitationParams = z.strictObject({ invitation_id: id('Приглашение') });

const INVITATION_STATUSES = ['sent', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn'] as const;
const status = z.enum(INVITATION_STATUSES);

const salaryView = (salary: OfferedSalary) => ({
	min: salary.min,
	max: salary.max,
	currency: salary.currency,
	period: salary.period,
	tax_base: salary.taxBase
});

const versionSchema = z
	.object({
		id: z.uuid().describe('`terms_id` для ответа'),
		version: z.int(),
		vacancy: z.record(z.string(), z.unknown()).describe('Вакансия, как она предложена в этой версии'),
		salary: offeredSalary,
		message: z.string().nullable(),
		response_due_at: dateTime,
		changes: z
			.object({
				previous_version: z.int(),
				fields: z.array(z.object({ field: z.string(), from: z.unknown(), to: z.unknown() })),
				salary_comparison: z.enum(['lower', 'equal', 'higher', 'overlap', 'not_comparable']),
				salary_lowered: z.boolean().describe('Ниже прежнего предложения этой компании'),
				lowered_against_versions: z.array(z.int())
			})
			.nullable()
			.describe('Отличия от предыдущей версии; у первой — `null`'),
		created_at: dateTime,
		response: z
			.object({
				decision: z.enum(['accept', 'decline']),
				reason_code: z.string().nullable(),
				reason_text: z.string().nullable(),
				responded_at: dateTime
			})
			.nullable()
	})
	.meta({ id: 'InvitationTerms', description: 'Версия условий приглашения' });

const invitationSchema = z
	.object({
		id: z.uuid(),
		viewer: z.enum(['company', 'candidate']),
		status,
		vacancy_id: z.uuid(),
		company_id: z.uuid(),
		company_name: z.string(),
		candidate_pseudonym: pseudonym.nullable().describe('Кандидат для компании; кандидату — `null`'),
		sent_at: dateTime,
		viewed_at: dateTime.nullable(),
		closed_at: dateTime.nullable(),
		reopen_count: z.int(),
		current_terms_id: z.uuid(),
		accepted_terms_id: z.uuid().nullable(),
		versions: z.array(versionSchema),
		hiring_process_id: z.uuid().nullable(),
		other_offers: z
			.array(
				z.object({
					invitation_id: z.uuid(),
					vacancy_title: z.string(),
					status,
					salary: offeredSalary,
					comparison: z.enum(['lower', 'equal', 'higher', 'overlap', 'not_comparable'])
				})
			)
			.describe('Кандидату: предложения той же компании по другим вакансиям'),
		disclosure_document_id: z
			.uuid()
			.nullable()
			.describe('Кандидату: действующая редакция согласия на раскрытие контактов — её id передаётся при принятии')
	})
	.meta({ id: 'Invitation', description: 'Приглашение с версиями условий и отличиями' });

async function invitationView(ctx: BaseContext, view: InvitationView) {
	const disclosure =
		view.viewer === 'candidate' ? await currentDisclosureDocument(ctx.services.db, ctx.services.now()) : null;
	return {
		id: view.id,
		viewer: view.viewer,
		status: view.status,
		vacancy_id: view.vacancyId,
		company_id: view.companyId,
		company_name: view.companyName,
		candidate_pseudonym: view.candidatePseudonym,
		sent_at: iso(view.sentAt),
		viewed_at: isoOrNull(view.viewedAt),
		closed_at: isoOrNull(view.closedAt),
		reopen_count: view.reopenCount,
		current_terms_id: view.currentTermsId,
		accepted_terms_id: view.acceptedTermsId,
		versions: view.versions.map((version) => ({
			id: version.id,
			version: version.version,
			vacancy: { ...version.vacancy },
			salary: salaryView(version.salary),
			message: version.message,
			response_due_at: iso(version.responseDueAt),
			changes: version.changes,
			created_at: iso(version.createdAt),
			response: version.response && {
				decision: version.response.decision,
				reason_code: version.response.reasonCode,
				reason_text: version.response.reasonText,
				responded_at: iso(version.response.respondedAt)
			}
		})),
		hiring_process_id: view.hiringProcessId,
		other_offers: view.otherOffers.map((offer) => ({
			invitation_id: offer.invitationId,
			vacancy_title: offer.vacancyTitle,
			status: offer.status,
			salary: salaryView(offer.salary),
			comparison: offer.comparison
		})),
		disclosure_document_id: disclosure?.id ?? null
	};
}

async function loadInvitationView(ctx: BaseContext, invitationId: string) {
	return invitationView(ctx, await getInvitation(invitationDeps(ctx.services), await ctx.subject(), invitationId));
}

export const listMyInvitations = defineOperation({
	id: 'listInvitations',
	method: 'GET',
	path: '/invitations',
	tag: TAG,
	summary: 'Приглашения',
	description: 'Кандидату — приглашения к нему; участнику компании и ключу API — приглашения компании. Новые первыми.',
	auth: 'account',
	permission: 'invitation.read',
	query: z.strictObject(pageQuery),
	errors: [],
	response: {
		status: 200,
		description: 'Страница приглашений',
		schema: page(
			z.object({
				id: z.uuid(),
				status,
				vacancy_id: z.uuid(),
				company_id: z.uuid(),
				candidate_pseudonym: pseudonym.nullable(),
				version: z.int().describe('Номер текущей версии условий'),
				salary: offeredSalary,
				response_due_at: dateTime,
				sent_at: dateTime
			})
		)
	},
	async handle(ctx) {
		const subject = await ctx.subject();
		const side = subject.via === 'session' && subject.candidate !== null ? 'candidate' : 'company';
		const summaries = await listInvitations(invitationDeps(ctx.services), subject, side);
		return pageOf(
			summaries.map((summary) => ({
				id: summary.id,
				status: summary.status,
				vacancy_id: summary.vacancyId,
				company_id: summary.companyId,
				candidate_pseudonym: summary.candidatePseudonym,
				version: summary.version,
				salary: salaryView(summary.salary),
				response_due_at: iso(summary.responseDueAt),
				sent_at: iso(summary.sentAt)
			})),
			ctx.query,
			{ op: 'invitations', side, user: subject.userId }
		);
	}
});

export const sendInvitation = defineOperation({
	id: 'createInvitation',
	method: 'POST',
	path: '/invitations',
	tag: TAG,
	summary: 'Пригласить кандидата',
	description:
		'Первая версия условий по собственной опубликованной вакансии проверенной компании кандидату, которого компания ' +
		'видит в контексте этой вакансии. Валюта, период и налоговая база берутся из вакансии и отдельно не принимаются; ' +
		'нижняя граница — не ниже вилки вакансии. Внешняя вакансия — `422 vacancy_not_invitable`; кандидат, которого ' +
		'компания не видит, — `404`.',
	auth: 'account',
	permission: 'invitation.create',
	idempotent: true,
	body: z
		.strictObject({
			vacancy_id: z.uuid(),
			candidate_pseudonym: pseudonym,
			salary_min: z.int(),
			salary_max: z.int(),
			message: z.string().nullable().optional().describe('Сообщение кандидату, до 4000 символов')
		})
		.meta({
			examples: [
				{
					vacancy_id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
					candidate_pseudonym: 'k7q2x4m5n6p7r2s3t4v5w6x7yz',
					salary_min: 280000,
					salary_max: 330000,
					message: 'Здравствуйте! Нам близок ваш опыт с Go и высоконагруженными сервисами.'
				}
			]
		}),
	errors: ['not_found', 'conflict', 'policy_violation'],
	response: { status: 201, description: 'Приглашение отправлено', schema: invitationSchema },
	async handle(ctx) {
		const subject = await ctx.subject();
		const membership = activeMembership(subject);
		if (membership === null) throw new ApiError('forbidden');
		const candidateId = await candidateOfPseudonym(
			ctx.services.db,
			ctx.services.crypto,
			membership.companyId,
			ctx.body.candidate_pseudonym
		);
		if (candidateId === null) throw new ApiError('not_found');
		const sent = await createInvitation(invitationDeps(ctx.services), subject, invitationMeta(ctx), {
			vacancyId: ctx.body.vacancy_id,
			candidateId,
			salaryMin: ctx.body.salary_min,
			salaryMax: ctx.body.salary_max,
			...(ctx.body.message === undefined ? {} : { message: ctx.body.message })
		});
		return loadInvitationView(ctx, sent.invitationId);
	}
});

export const getOneInvitation = defineOperation({
	id: 'getInvitation',
	method: 'GET',
	path: '/invitations/{invitation_id}',
	tag: TAG,
	summary: 'Приглашение',
	description: 'Стороне приглашения — все версии условий с отличиями. Чужое приглашение — `404`.',
	auth: 'account',
	permission: 'invitation.read',
	params: invitationParams,
	errors: ['not_found'],
	response: { status: 200, description: 'Приглашение', schema: invitationSchema },
	handle: (ctx) => loadInvitationView(ctx, ctx.params.invitation_id)
});

export const reviseInvitationTerms = defineOperation({
	id: 'reviseInvitationTerms',
	method: 'POST',
	path: '/invitations/{invitation_id}/terms',
	tag: TAG,
	summary: 'Новая версия условий',
	description:
		'Пересмотр открытого или принятого приглашения либо возобновление закрытого после паузы политики. Прежняя ' +
		'версия перестаёт приниматься к ответу; ответ содержит отличия от неё, снижение вилки отмечается.',
	auth: 'account',
	permission: 'invitation.revise',
	idempotent: true,
	params: invitationParams,
	body: z.strictObject({
		salary_min: z.int(),
		salary_max: z.int(),
		message: z.string().nullable().optional()
	}),
	errors: ['not_found', 'conflict', 'policy_violation'],
	response: {
		status: 201,
		description: 'Версия отправлена',
		schema: z.object({ reopened: z.boolean(), terms_id: z.uuid(), invitation: invitationSchema })
	},
	async handle(ctx) {
		const revised = await reviseInvitation(
			invitationDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.invitation_id,
			{
				salaryMin: ctx.body.salary_min,
				salaryMax: ctx.body.salary_max,
				...(ctx.body.message === undefined ? {} : { message: ctx.body.message })
			}
		);
		return {
			reopened: revised.reopened,
			terms_id: revised.termsId,
			invitation: await loadInvitationView(ctx, revised.invitationId)
		};
	}
});

export const respondInvitation = defineOperation({
	id: 'respondToInvitation',
	method: 'POST',
	path: '/invitations/{invitation_id}/response',
	tag: TAG,
	summary: 'Ответить на приглашение',
	description:
		'Ответ кандидата на конкретную версию условий. Версия, заменённая пересмотром, — `409 conflict` с отличиями. ' +
		'Принятие раскрывает компании выбранные поля (ФИО и почта — всегда) по согласию в редакции ' +
		'`disclosure_document_id`. Кандидату 14–17 лет раскрытие нужно и от законного представителя: принятие ждёт его ' +
		'согласия (`awaiting_representative`), письмо со ссылкой уходит представителю.',
	auth: 'session',
	permission: 'invitation.respond',
	idempotent: true,
	params: invitationParams,
	body: z.discriminatedUnion('decision', [
		z.strictObject({
			terms_id: z.uuid(),
			decision: z.literal('accept'),
			disclose_fields: z.array(z.enum(DISCLOSURE_FIELDS)).describe('Что раскрыть компании'),
			disclosure_document_id: z.uuid().describe('Показанная редакция согласия на раскрытие')
		}),
		z.strictObject({
			terms_id: z.uuid(),
			decision: z.literal('decline'),
			reason_code: z.string().optional(),
			reason_text: z.string().optional()
		})
	]),
	errors: ['not_found', 'conflict'],
	response: {
		status: 200,
		description: 'Ответ записан',
		schema: z.object({
			status,
			process_id: z.uuid().nullable().describe('Процесс найма, открытый принятием'),
			disclosed_fields: z.array(z.enum(DISCLOSURE_FIELDS)),
			awaiting_representative: z
				.boolean()
				.describe('Принятие кандидата 14–17 лет ждёт согласия законного представителя до срока ответа')
		})
	},
	async handle(ctx) {
		const body = ctx.body;
		const result = await respondToInvitation(
			invitationDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.invitation_id,
			body.decision === 'accept'
				? {
						termsId: body.terms_id,
						decision: 'accept',
						discloseFields: body.disclose_fields,
						disclosureDocumentId: body.disclosure_document_id
					}
				: {
						termsId: body.terms_id,
						decision: 'decline',
						...(body.reason_code === undefined ? {} : { reasonCode: body.reason_code }),
						...(body.reason_text === undefined ? {} : { reasonText: body.reason_text })
					}
		);
		if (result.awaitingRepresentative) {
			const subject = await ctx.subject();
			if (subject.userId === null) throw new Error('an answer is given by a signed-in candidate');
			await sendDisclosureLetter(
				ctx.services,
				invitationMeta(ctx),
				{ kind: 'user', userId: subject.userId },
				ctx.params.invitation_id
			);
		}
		return {
			status: result.status,
			process_id: result.processId,
			disclosed_fields: result.disclosedFields,
			awaiting_representative: result.awaitingRepresentative
		};
	}
});

export const markViewed = defineOperation({
	id: 'markInvitationViewed',
	method: 'POST',
	path: '/invitations/{invitation_id}/viewed',
	tag: TAG,
	summary: 'Отметить просмотр',
	description: 'Кандидат открыл приглашение: `sent → viewed`; повтор ничего не меняет.',
	auth: 'session',
	permission: 'invitation.read',
	params: invitationParams,
	errors: ['not_found'],
	response: { status: 200, description: 'Статус после отметки', schema: z.object({ status }) },
	async handle(ctx) {
		return {
			status: await markInvitationViewed(invitationDeps(ctx.services), await ctx.subject(), ctx.params.invitation_id)
		};
	}
});

export const withdraw = defineOperation({
	id: 'withdrawInvitation',
	method: 'POST',
	path: '/invitations/{invitation_id}/withdrawal',
	tag: TAG,
	summary: 'Отозвать приглашение',
	description: 'Компания отзывает приглашение, на которое кандидат ещё не ответил.',
	auth: 'account',
	permission: 'invitation.revise',
	params: invitationParams,
	errors: ['not_found', 'conflict'],
	response: { status: 204, description: 'Приглашение отозвано' },
	async handle(ctx) {
		await withdrawInvitation(
			invitationDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.invitation_id
		);
	}
});

export const disclosedContacts = defineOperation({
	id: 'getInvitationContacts',
	method: 'GET',
	path: '/invitations/{invitation_id}/contacts',
	tag: TAG,
	summary: 'Контакты кандидата',
	description:
		'Проекция получателя: только компании приглашения, только после принятия и пока действует согласие кандидата на ' +
		'раскрытие; только поля, которые он выбрал. Каждое чтение журналируется. Иначе — `404`.',
	auth: 'account',
	permission: 'invitation.read',
	params: invitationParams,
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Раскрытые контакты',
		schema: z.object({
			candidate_id: z.uuid(),
			pseudonym,
			fields: z.array(z.enum(DISCLOSURE_FIELDS)),
			full_name: z
				.object({ last: z.string().nullable(), first: z.string().nullable(), middle: z.string().nullable() })
				.optional(),
			email: z.string().optional(),
			phone: z.string().nullable().optional(),
			resume_file_id: z.uuid().nullable().optional()
		})
	},
	async handle(ctx) {
		const contacts = await recipientContacts(
			invitationDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.invitation_id
		);
		return {
			candidate_id: contacts.candidateId,
			pseudonym: contacts.pseudonym,
			fields: contacts.fields,
			...(contacts.fullName === undefined ? {} : { full_name: contacts.fullName }),
			...(contacts.email === undefined ? {} : { email: contacts.email }),
			...(contacts.phone === undefined ? {} : { phone: contacts.phone }),
			...(contacts.resumeFileId === undefined ? {} : { resume_file_id: contacts.resumeFileId })
		};
	}
});
