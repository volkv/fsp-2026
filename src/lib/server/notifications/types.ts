// Registry of notification types (docs/domain.md, section 3.7): the category a type belongs to, the object it is about
// and the name of the event a foreign channel may carry. Modules add their types here.
import type { NOTIFICATION_CATEGORIES } from '$lib/server/db/schema';

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
type NotificationObjectType =
	| 'invitation'
	| 'hiring_process'
	| 'company'
	| 'vacancy'
	| 'assessment_objection'
	| 'candidate_category'
	| 'representation'
	| 'candidate'
	| 'assessment_attempt'
	| 'confirmation_request'
	| 'challenge_delivery'
	| 'application';

interface TypeSpec {
	category: NotificationCategory;
	objectType: NotificationObjectType;
	/**
	 * The kind of the event in a few words: the whole content of a Telegram message besides the link (domain 3.7). No
	 * names, companies, vacancies or amounts.
	 */
	title: string;
}

export const NOTIFICATION_TYPES = {
	'invitation.received': { category: 'invitations', objectType: 'invitation', title: 'Новое приглашение' },
	'invitation.terms_revised': {
		category: 'invitations',
		objectType: 'invitation',
		title: 'Изменились условия приглашения'
	},
	'invitation.answered': { category: 'invitations', objectType: 'invitation', title: 'Ответ на приглашение' },
	'invitation.expired': { category: 'invitations', objectType: 'invitation', title: 'Срок приглашения истёк' },
	'invitation.withdrawn': { category: 'invitations', objectType: 'invitation', title: 'Приглашение отозвано' },
	'invitation.representative_answered': {
		category: 'invitations',
		objectType: 'invitation',
		title: 'Ответ законного представителя'
	},
	'invitation.response_due_soon': {
		category: 'deadlines',
		objectType: 'invitation',
		title: 'Скоро истекает срок ответа на приглашение'
	},
	'hiring.outcome_requested': { category: 'hiring', objectType: 'hiring_process', title: 'Сообщите исход найма' },
	'hiring.outcome_reminder': {
		category: 'hiring',
		objectType: 'hiring_process',
		title: 'Напоминание: сообщите исход найма'
	},
	'hiring.reports_diverged': {
		category: 'hiring',
		objectType: 'hiring_process',
		title: 'Сообщения об исходе найма расходятся'
	},
	'company.verification_decided': {
		category: 'account',
		objectType: 'company',
		title: 'Решение по проверке компании'
	},
	'vacancy.moderation_decided': {
		category: 'account',
		objectType: 'vacancy',
		title: 'Решение модерации по вакансии'
	},
	'objection.decided': {
		category: 'account',
		objectType: 'assessment_objection',
		title: 'Ответ на возражение по результату теста'
	},
	'objection.due_soon': {
		category: 'objections',
		objectType: 'assessment_objection',
		title: 'Скоро истекает срок ответа на возражение'
	},
	'objection.overdue': {
		category: 'objections',
		objectType: 'assessment_objection',
		title: 'Просрочен ответ на возражение'
	},
	'category.assigned': {
		category: 'account',
		objectType: 'candidate_category',
		title: 'Категория подтверждена тестом'
	},
	'category.revoked': {
		category: 'account',
		objectType: 'candidate_category',
		title: 'Категория отозвана'
	},
	'representation.decided': {
		category: 'account',
		objectType: 'representation',
		title: 'Решение по полномочиям представителя'
	},
	'representation.consents_signed': {
		category: 'account',
		objectType: 'representation',
		title: 'Законный представитель подписал согласия'
	},
	'representation.consents_revoked': {
		category: 'account',
		objectType: 'representation',
		title: 'Законный представитель отозвал согласия'
	},
	'candidate.age_verified': {
		category: 'account',
		objectType: 'candidate',
		title: 'Дата рождения проверена'
	},
	'assessment.annulled': {
		category: 'account',
		objectType: 'assessment_attempt',
		title: 'Результат теста аннулирован'
	},
	'candidate.majority_reached': {
		category: 'account',
		objectType: 'candidate',
		title: 'Совершеннолетие: подтвердите согласия сами'
	},
	'candidate.inactive_purge_scheduled': {
		category: 'account',
		objectType: 'candidate',
		title: 'Профиль будет удалён за неактивность'
	},
	// Requests of a confirmation, calls of companies, applications (domain 13.11, 13.12).
	'confirmation.requested': {
		category: 'invitations',
		objectType: 'confirmation_request',
		title: 'Компания просит подтвердить навык'
	},
	'confirmation.completed': {
		category: 'invitations',
		objectType: 'confirmation_request',
		title: 'Результат по запросу подтверждения'
	},
	'challenge.delivered': { category: 'invitations', objectType: 'challenge_delivery', title: 'Новый вызов компании' },
	'challenge.reminder': {
		category: 'deadlines',
		objectType: 'challenge_delivery',
		title: 'Напоминание о вызове компании'
	},
	'application.received': { category: 'invitations', objectType: 'application', title: 'Новый отклик на вакансию' },
	'application.decided': { category: 'invitations', objectType: 'application', title: 'Ответ компании на отклик' }
} as const satisfies Record<string, TypeSpec>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export function isNotificationType(value: string): value is NotificationType {
	return Object.hasOwn(NOTIFICATION_TYPES, value);
}

/** The deadline of an objection, to the FSP staff (domain 12.5): the responsible operator or the operators, and admins. */
export function isObjectionDeadline(type: NotificationType): type is 'objection.due_soon' | 'objection.overdue' {
	return type === 'objection.due_soon' || type === 'objection.overdue';
}
