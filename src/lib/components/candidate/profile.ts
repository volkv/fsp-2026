// The candidate's own profile fields on the cabinet pages (docs/domain.md, sections 7.1, 12.9): the suggestions of the
// resume for them, the confirmations of the categories, and what an employer sees of each field before and after a
// disclosure.

export type SuggestionField = 'full_name' | 'phone' | 'email' | 'telegram' | 'soft_skill';
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

export interface ProfileSuggestionView {
	id: string;
	field: SuggestionField;
	/** The normalized value: a contact, a soft skill key, the JSON of the name parts. */
	value: string;
	/** The value in words. */
	label: string;
	status: SuggestionStatus;
	quote: { extractionId: string; blockId: string; start: number; end: number; text: string };
	/** The key its quote is marked with in the resume text. */
	sourceKey: string;
}

export const SUGGESTION_FIELDS: Record<SuggestionField, string> = {
	full_name: 'ФИО',
	phone: 'Телефон',
	email: 'Почта',
	telegram: 'Telegram',
	soft_skill: 'Мягкие навыки'
};

export const SUGGESTION_STATUSES: Record<
	SuggestionStatus,
	{ label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
> = {
	pending: { label: 'Из резюме — ждёт решения', tone: 'info' },
	accepted: { label: 'Принято', tone: 'success' },
	rejected: { label: 'Отклонено', tone: 'neutral' }
};

/** A place of work the candidate stated by hand. */
export interface ManualExperienceEntry {
	id: string;
	positionTitle: string;
	organizationName: string | null;
	roleKey: string | null;
	/** `YYYY-MM`. */
	periodFrom: string;
	periodTo: string | null;
	isCurrent: boolean;
	skillKeys: string[];
	description: string | null;
}

export type AttestationStatus = 'valid' | 'superseded' | 'annulled';

export const ATTESTATION_STATUSES: Record<
	AttestationStatus,
	{ label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
> = {
	valid: { label: 'Действует', tone: 'success' },
	superseded: { label: 'Заменено новым грейдом', tone: 'neutral' },
	annulled: { label: 'Аннулировано', tone: 'danger' }
};

/**
 * What a company sees of each field of the profile in the catalog card (with the catalog consent; under 18 — only in
 * the context of a fitting internship) and in the card of the company whose offer the candidate accepted, with the
 * fields the candidate chose to disclose (domain 6.5, 14). The PDF profile is what the candidate hands over themselves.
 */
export const FIELD_PRIVACY: readonly { field: string; before: string; after: string }[] = [
	{ field: 'ФИО', before: 'Не видно: в каталоге — псевдоним', after: 'Если вы отметили его при раскрытии' },
	{ field: 'Телефон', before: 'Не видно', after: 'Если вы отметили его при раскрытии' },
	{ field: 'Почта аккаунта', before: 'Не видно', after: 'Если вы отметили её при раскрытии' },
	{ field: 'Файл резюме', before: 'Не видно', after: 'Если вы отметили его при раскрытии' },
	{ field: 'Telegram', before: 'Не видно', after: 'Если вы отметили его при раскрытии' },
	{ field: 'Категория, навыки, желаемые роли', before: 'Видно', after: 'Видно' },
	{
		field: 'Достижения ФСП',
		before: 'Обобщённо: дисциплина, уровень, сезон, итог; точно — если вы добавили это к карточке',
		after: 'Точно: соревнование, этап, место, команда'
	},
	{ field: 'Публичные профили', before: 'Если вы добавили их к карточке', after: 'Видно' },
	{
		field: 'Опыт из резюме',
		before: 'Роли, длительность и навыки — без должностей и компаний',
		after: 'Полностью: должности, компании, периоды'
	},
	{ field: 'Опыт, указанный вручную', before: 'Не видно', after: 'Не видно: только в вашем PDF-профиле' },
	{ field: 'Мягкие навыки', before: 'Не видно', after: 'Не видно: только в вашем PDF-профиле' },
	{ field: 'Желаемая должность', before: 'Не видно', after: 'Не видно: только в вашем PDF-профиле' }
];
