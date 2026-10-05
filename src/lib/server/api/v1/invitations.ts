// Offers (contracts 5.5, 10.2; domain 13.5–13.6): the company writes first — a description, a range in roubles, its
// profile, a way to reach it, a deadline and «why you» with sources; a vacancy is optional. Every offer is an immutable
// version of terms; the candidate answers a concrete version; contacts are disclosed to that company only after
// acceptance and only as the candidate chose.
import { z } from 'zod';
import { DISCLOSURE_FIELDS } from '$lib/server/consent/kinds';
import { ApiError } from '$lib/server/errors/api-error';
import { currentDisclosureDocument } from '$lib/server/invitations/consent';
import { recipientContacts, sendDisclosureLetter } from '$lib/server/invitations/disclosure';
import { getInvitation, listInvitations, type InvitationView } from '$lib/server/invitations/read';
import { markInvitationViewed, respondToInvitation } from '$lib/server/invitations/respond';
import { createInvitation, reviseInvitation, withdrawInvitation, type OfferInput } from '$lib/server/invitations/send';
import { CONTACT_KINDS, OFFER_WORK_FORMATS, WHY_YOU_SOURCES, type OfferedSalary } from '$lib/server/invitations/terms';
import { defineOperation } from '../operation';
import { candidateOfPseudonym } from '../read/pseudonyms';
import {
	companyTrust,
	companyTrustView,
	dateTime,
	id,
	iso,
	isoOrNull,
	offeredSalary,
	page,
	pageOf,
	pageQuery,
	pseudonym
} from '../schemas';
import { invitationDeps } from '../services';
import { activeMembership, invitationMeta, type BaseContext } from './context';

const TAG = 'Приглашения';

const invitationParams = z.strictObject({ invitation_id: id('Приглашение') });

const INVITATION_STATUSES = ['sent', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn'] as const;
const status = z.enum(INVITATION_STATUSES);
const verification = z
	.enum(['verified', 'unverified'])
	.describe('Метка проверки компании оператором: `verified` — «проверена», `unverified` — «не проверена»');

const salaryView = (salary: OfferedSalary) => ({
	min: salary.min,
	max: salary.max,
	currency: salary.currency,
	period: salary.period,
	tax_base: salary.taxBase
});

const contactMethod = z
	.object({
		kind: z.enum(CONTACT_KINDS),
		value: z.string().describe('Контакт компании: адрес, телефон, имя в Telegram или ссылка'),
		note: z.string().nullable().optional().describe('Пояснение: кому писать, в какое время')
	})
	.meta({ id: 'OfferContactMethod', description: 'Способ связи с компанией; кандидат видит его сразу' });

const whyYouPoint = z
	.object({
		text: z.string().describe('Что компания увидела в профиле, до 300 символов'),
		source: z
			.object({
				kind: z.enum(WHY_YOU_SOURCES),
				ref: z.string().describe('Что в профиле: ключ навыка, предпочтение, ссылка на результат'),
				receipt_handle: z.string().optional().describe('Квитанция результата ФСП, выданная компании')
			})
			.describe('Источник пункта; пункт без источника не сохраняется')
	})
	.meta({ id: 'WhyYouPoint', description: 'Пункт «почему вы» с источником' });

/** What the employer sends in every version: the body of `POST /invitations` and `POST /invitations/{id}/terms`. */
const offerTerms = {
	title: z.string().describe('Короткое название предложения, до 120 символов'),
	description: z.string().describe('Описание: задачи, команда, условия; 50–5000 символов'),
	salary_min: z.int(),
	salary_max: z.int(),
	salary_currency: z.string().describe('Только `RUB`; другая валюта — `422 salary_not_rub`'),
	salary_tax_base: z.enum(['gross', 'net']).describe('`gross` — до вычета НДФЛ, `net` — на руки'),
	work_format: z.enum(OFFER_WORK_FORMATS),
	contact_method: contactMethod,
	why_you: z.array(whyYouPoint).describe('1–5 пунктов «почему вы»'),
	vacancy_id: z.uuid().nullable().optional().describe('Своя опубликованная вакансия — по желанию'),
	message: z.string().nullable().optional().describe('Личное сообщение кандидату, до 2000 символов')
};

const offerInput = (body: {
	title: string;
	description: string;
	salary_min: number;
	salary_max: number;
	salary_currency: string;
	salary_tax_base: 'gross' | 'net';
	work_format: string;
	contact_method: { kind: string; value: string; note?: string | null | undefined };
	why_you: { text: string; source: { kind: string; ref: string; receipt_handle?: string | undefined } }[];
	vacancy_id?: string | null | undefined;
	message?: string | null | undefined;
}): OfferInput => ({
	title: body.title,
	description: body.description,
	salaryMin: body.salary_min,
	salaryMax: body.salary_max,
	salaryCurrency: body.salary_currency,
	salaryTaxBase: body.salary_tax_base,
	workFormat: body.work_format,
	contactMethod: {
		kind: body.contact_method.kind,
		value: body.contact_method.value,
		note: body.contact_method.note ?? null
	},
	whyYou: body.why_you.map((point) => ({
		text: point.text,
		source: {
			kind: point.source.kind,
			ref: point.source.ref,
			...(point.source.receipt_handle === undefined ? {} : { receipt_handle: point.source.receipt_handle })
		}
	})),
	vacancyId: body.vacancy_id ?? null,
	message: body.message ?? null
});

const OFFER_EXAMPLE = {
	title: 'Go-разработчик в платёжную команду',
	description:
		'Развиваем платёжный шлюз: Go, PostgreSQL, Kafka. Команда из шести инженеров, релизы каждую неделю, код-ревью и дежурства по очереди.',
	salary_min: 280000,
	salary_max: 330000,
	salary_currency: 'RUB',
	salary_tax_base: 'gross',
	work_format: 'remote',
	contact_method: { kind: 'telegram', value: '@severny_kod_hr' },
	why_you: [{ text: 'Подтверждённый навык Go', source: { kind: 'declared_skill', ref: 'go' } }],
	message: 'Здравствуйте! Нам близок ваш опыт с высоконагруженными сервисами.'
};

const versionSchema = z
	.object({
		id: z.uuid().describe('`terms_id` для ответа'),
		version: z.int(),
		title: z.string(),
		description: z.string(),
		vacancy_id: z.uuid().nullable().describe('Вакансия версии; `null` — предложение без вакансии'),
		vacancy: z
			.record(z.string(), z.unknown())
			.nullable()
			.describe('Вакансия, как она была на момент версии; `null` — без вакансии'),
		category: z
			.object({ specialization: z.string(), grade: z.string() })
			.nullable()
			.describe('Категория кандидата на момент версии; `null` — «категория не подтверждена»'),
		salary: offeredSalary,
		work_format: z.enum(OFFER_WORK_FORMATS),
		contact_method: contactMethod,
		why_you: z.array(whyYouPoint),
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
	.meta({ id: 'InvitationTerms', description: 'Версия условий предложения' });

const companyProfileSchema = z
	.object({
		id: z.uuid(),
		display_name: z.string(),
		description: z.string().nullable(),
		activity: z.string().nullable(),
		contacts: z.object({
			website: z.string().optional(),
			email: z.string().optional(),
			phone: z.string().optional(),
			telegram: z.string().optional()
		}),
		verification,
		trust: companyTrust
	})
	.meta({ id: 'OfferCompany', description: 'Компания предложения с профилем, меткой проверки и фактами доверия' });

const invitationSchema = z
	.object({
		id: z.uuid(),
		viewer: z.enum(['company', 'candidate']),
		status,
		company: companyProfileSchema,
		need_id: z.uuid().nullable().describe('Потребность, из которой отправлено предложение'),
		candidate_pseudonym: pseudonym.nullable().describe('Кандидат для компании; кандидату — `null`'),
		sent_at: dateTime,
		viewed_at: dateTime.nullable(),
		closed_at: dateTime.nullable(),
		reopen_count: z.int(),
		current_terms_id: z.uuid(),
		accepted_terms_id: z.uuid().nullable(),
		versions: z.array(versionSchema),
		hiring_process_id: z.uuid().nullable(),
		disclosure_document_id: z
			.uuid()
			.nullable()
			.describe('Кандидату: действующая редакция согласия на раскрытие контактов — её id передаётся при принятии')
	})
	.meta({ id: 'Invitation', description: 'Предложение с версиями условий и отличиями' });

async function invitationView(ctx: BaseContext, view: InvitationView) {
	const disclosure =
		view.viewer === 'candidate' ? await currentDisclosureDocument(ctx.services.db, ctx.services.now()) : null;
	return {
		id: view.id,
		viewer: view.viewer,
		status: view.status,
		company: {
			id: view.company.id,
			display_name: view.company.displayName,
			description: view.company.description,
			activity: view.company.activity,
			contacts: view.company.contacts,
			verification: view.company.verification,
			trust: companyTrustView(view.companyTrust)
		},
		need_id: view.needId,
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
			title: version.title,
			description: version.description,
			vacancy_id: version.vacancy?.id ?? null,
			vacancy: version.vacancy ? { ...version.vacancy.snapshot } : null,
			category: version.category,
			salary: salaryView(version.salary),
			work_format: version.workFormat as (typeof OFFER_WORK_FORMATS)[number],
			contact_method: version.contactMethod,
			why_you: version.whyYou,
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
	summary: 'Предложения',
	description:
		'Кандидату — предложения к нему; участнику компании и ключу API — предложения компании. Новые первыми. ' +
		'Обе стороны видят актуальный статус.',
	auth: 'account',
	permission: 'invitation.read',
	query: z.strictObject(pageQuery),
	errors: [],
	response: {
		status: 200,
		description: 'Страница предложений',
		schema: page(
			z.object({
				id: z.uuid(),
				status,
				company_id: z.uuid(),
				company_name: z.string(),
				company_verification: verification,
				candidate_pseudonym: pseudonym.nullable(),
				version: z.int().describe('Номер текущей версии условий'),
				title: z.string(),
				vacancy_id: z.uuid().nullable(),
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
				company_id: summary.companyId,
				company_name: summary.companyName,
				company_verification: summary.companyVerification,
				candidate_pseudonym: summary.candidatePseudonym,
				version: summary.version,
				title: summary.title,
				vacancy_id: summary.vacancyId,
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
	summary: 'Предложить работу кандидату',
	description:
		'Первая версия условий предложения кандидату, которого компания видит в каталоге. Вакансия не нужна; если ' +
		'указана — своя опубликованная с полной вилкой в рублях, иначе `422 vacancy_not_invitable`. Вилка «от–до» — ' +
		'только в рублях в месяц (`422 salary_not_rub`). Компании нужен заполненный профиль ' +
		'(`422 company_profile_incomplete`); проверка компании оператором не требуется, непроверенная получает метку. ' +
		'Текст с недопустимым требованием — `422 text_blocked`. Открытое или принятое предложение этой компании этому ' +
		'кандидату — `409 offer_open` (его пересматривают); после отказа, срока или отзыва — возобновление той же линии ' +
		'не раньше паузы политики (`422 reopen_cooldown`). Кандидат, которого компания не видит, — `404`.',
	auth: 'account',
	permission: 'invitation.create',
	idempotent: true,
	body: z
		.strictObject({
			candidate_pseudonym: pseudonym,
			...offerTerms,
			need_id: z.uuid().nullable().optional().describe('Потребность компании, из которой отправлено')
		})
		.meta({ examples: [{ candidate_pseudonym: 'k7q2x4m5n6p7r2s3t4v5w6x7yz', ...OFFER_EXAMPLE }] }),
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
	response: { status: 201, description: 'Предложение отправлено', schema: invitationSchema },
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
			...offerInput(ctx.body),
			candidateId,
			needId: ctx.body.need_id ?? null
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
		'Пересмотр открытого или принятого предложения либо возобновление закрытого после паузы политики. Отправленные ' +
		'условия не меняются: это новая версия, прежняя перестаёт приниматься к ответу; ответ содержит отличия от неё, ' +
		'снижение вилки отмечается. Те же проверки, что у первой версии.',
	auth: 'account',
	permission: 'invitation.revise',
	idempotent: true,
	params: invitationParams,
	body: z.strictObject(offerTerms).meta({ examples: [OFFER_EXAMPLE] }),
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
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
			offerInput(ctx.body)
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
			telegram: z.string().nullable().optional().describe('Telegram кандидата `@name`; `null` — не указан'),
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
			...(contacts.telegram === undefined ? {} : { telegram: contacts.telegram }),
			...(contacts.resumeFileId === undefined ? {} : { resume_file_id: contacts.resumeFileId })
		};
	}
});
