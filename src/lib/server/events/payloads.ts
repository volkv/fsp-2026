// `data` of every outgoing event (docs/domain.md, section 5.7): identifiers, statuses, codes and moments — never a
// name, an address or a text the candidate wrote. Contacts the candidate disclosed to the company are not carried either:
// `contacts.disclosed` names the fields, and the integration reads the values by the API with its key, under the same
// consent check and journal as the interface. The emitting code is typed by these schemas, and the API document shows
// them, so what is sent and what is described cannot differ.
import { z } from 'zod';
import { APPLICATION_STATUSES, COMPANY_EVENT_TYPES } from '$lib/server/db/schema';

const uuid = z.uuid();
const moment = z.iso.datetime();
const invitationRef = {
	invitation_id: uuid.describe('Предложение'),
	terms_id: uuid.nullable().describe('Версия условий, к которой относится событие')
};
const versionRef = {
	invitation_id: uuid.describe('Предложение'),
	terms_id: uuid.describe('Версия условий'),
	terms_version: z.int().positive().describe('Номер версии условий')
};
const vacancyRef = {
	vacancy_id: uuid.describe('Вакансия'),
	revision: z.int().positive().describe('Редакция вакансии'),
	previous_status: z.string().describe('Статус до события: `draft`, `pending_moderation`, `published`, `paused`')
};

export const EVENT_DATA = {
	'invitation.sent': z.strictObject({
		...versionRef,
		vacancy_id: uuid.nullable().describe('Вакансия, которую называет версия; `null` — предложение без вакансии'),
		response_due_at: moment.describe('Срок ответа кандидата'),
		reopened: z.boolean().describe('Предложение открыто заново после закрытия')
	}),
	'invitation.viewed': z.strictObject(invitationRef),
	'invitation.accepted': z.strictObject({
		...versionRef,
		reason_code: z.string().nullable().describe('У принятия — `null`'),
		by_representative: z.boolean().describe('Ответил законный представитель несовершеннолетнего')
	}),
	'invitation.declined': z.strictObject({
		...versionRef,
		reason_code: z.string().nullable().describe('Код причины отказа'),
		by_representative: z.boolean().describe('Ответил законный представитель несовершеннолетнего')
	}),
	'invitation.expired': z.strictObject(versionRef),
	'invitation.withdrawn': z.strictObject({
		...invitationRef,
		cause: z
			.enum(['company', 'company_suspended', 'company_rejected', 'vacancy_closed'])
			.describe('Почему отозвано: компанией, приостановкой или отказом в проверке компании, закрытием вакансии')
	}),
	'contacts.disclosed': z.strictObject({
		invitation_id: uuid.describe('Предложение'),
		fields: z
			.array(z.string())
			.describe('Какие контакты кандидат раскрыл; значения — `GET /api/v1/invitations/{id}/contacts`')
	}),
	'hiring.reported': z.strictObject({
		invitation_id: uuid.describe('Предложение'),
		hiring_process_id: uuid.describe('Процесс найма'),
		report_id: uuid.describe('Сообщение'),
		party: z.string().describe('Кто сообщил: `company` или `candidate`'),
		kind: z.string().describe('`stage` — этап, `outcome` — исход'),
		value: z.string().describe('Код этапа или исхода'),
		start_date: z.iso.date().nullable().describe('Дата выхода на работу при исходе `hired`'),
		outcome_state: z.string().describe('Исход процесса после сообщения, с учётом расхождения сторон')
	}),
	'application.received': z.strictObject({
		application_id: uuid.describe('Отклик'),
		vacancy_id: uuid.describe('Вакансия'),
		fields: z
			.array(z.string())
			.describe('Какие контакты кандидат раскрыл откликом; значения — `GET /api/v1/applications/{id}`')
	}),
	'application.status_changed': z.strictObject({
		application_id: uuid.describe('Отклик'),
		vacancy_id: uuid.describe('Вакансия'),
		status: z.enum(APPLICATION_STATUSES).describe('Статус отклика теперь'),
		previous_status: z.enum(APPLICATION_STATUSES).describe('Статус до события'),
		invitation_id: uuid.nullable().describe('Предложение, которым компания ответила на отклик')
	}),
	'vacancy.published': z.strictObject(vacancyRef),
	'vacancy.closed': z.strictObject(vacancyRef)
} as const satisfies Record<(typeof COMPANY_EVENT_TYPES)[number], z.ZodObject>;

export type EventDataOf<T extends keyof typeof EVENT_DATA> = z.input<(typeof EVENT_DATA)[T]>;

/** `data` of the check the owner sends from the interface or the API. */
export const PING_DATA = z.strictObject({ subscription_id: uuid.describe('Подписка, которую проверяют') });

/** Events about an offer: the candidate is named by the pseudonym for this company, added when the event is sent. */
export const INVITATION_EVENTS = [
	'invitation.sent',
	'invitation.viewed',
	'invitation.accepted',
	'invitation.declined',
	'invitation.expired',
	'invitation.withdrawn',
	'contacts.disclosed',
	'hiring.reported'
] as const satisfies readonly (typeof COMPANY_EVENT_TYPES)[number][];
