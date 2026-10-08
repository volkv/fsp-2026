/**
 * Wording of the FSP operator cabinet: statuses of the queues, the registry hint, the ways a representative's authority
 * is checked, the stages of the career funnel and the small-number cells. Official register, no sport slang.
 */
import { FSP_LEVELS } from '$lib/components/candidate/model.js';
import { pluralize } from '$lib/components/product/model.js';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const REGISTRY_STATES: Record<string, { label: string; tone: Tone }> = {
	found: { label: 'Найдена в реестре', tone: 'success' },
	not_found: { label: 'Не найдена в реестре', tone: 'danger' },
	unavailable: { label: 'Реестр не ответил', tone: 'warning' },
	not_configured: { label: 'Источник реестра не подключён', tone: 'neutral' },
	pending: { label: 'Проверка реестра ещё идёт', tone: 'info' }
};

export const REGISTRY_SOURCES: Record<string, string> = {
	egrul: 'ЕГРЮЛ/ЕГРИП, поиск ФНС (egrul.nalog.ru)'
};

export const REGISTRY_UNAVAILABLE: Record<string, string> = {
	network: 'сеть недоступна',
	http_status: 'сервис ответил ошибкой',
	captcha: 'сервис запросил капчу',
	malformed: 'ответ не распознан',
	timeout: 'истекло время ожидания'
};

export const SUSPENSION_REASONS: Record<string, string> = {
	authority_revoked: 'Полномочия заявителя отозваны',
	registry_inactive: 'Организация ликвидирована или не действует',
	terms_violation: 'Нарушение условий платформы',
	complaint: 'Обоснованная жалоба кандидата',
	company_request: 'По просьбе компании'
};

export const DECISIONS: Record<'approved' | 'rejected' | 'needs_info', { label: string; tone: Tone }> = {
	approved: { label: 'Подтверждена', tone: 'success' },
	rejected: { label: 'Отклонена', tone: 'danger' },
	needs_info: { label: 'Возвращена на уточнение', tone: 'warning' }
};

/** Statuses of an objection to a test result in the operator's queue (domain 12.5). */
export const OBJECTION_STATUSES: Record<string, { label: string; tone: Tone }> = {
	open: { label: 'Ждёт оператора', tone: 'info' },
	in_review: { label: 'На рассмотрении', tone: 'info' },
	resolved: { label: 'Рассмотрено', tone: 'success' },
	withdrawn: { label: 'Отозвано кандидатом', tone: 'neutral' }
};

/** Outcomes of an objection: what the answer did to the decision of the test. */
export const OBJECTION_OUTCOMES: Record<string, { label: string; tone: Tone }> = {
	upheld: { label: 'Решение оставлено', tone: 'neutral' },
	annulled: { label: 'Попытка аннулирована', tone: 'warning' },
	rescored: { label: 'Решение пересчитано', tone: 'success' }
};

export const RELATIONS: Record<string, string> = {
	parent: 'Родитель',
	adoptive_parent: 'Усыновитель',
	guardian: 'Опекун',
	custodian: 'Попечитель'
};

export const REPRESENTATION_STATUSES: Record<string, { label: string; tone: Tone }> = {
	invited: { label: 'Письмо отправлено', tone: 'neutral' },
	contact_confirmed: { label: 'Почта подтверждена, полномочия не проверены', tone: 'warning' },
	authority_pending: { label: 'Выбран способ проверки, ждёт оператора', tone: 'warning' },
	authority_verified: { label: 'Полномочия подтверждены', tone: 'success' },
	ended: { label: 'Связь завершена', tone: 'neutral' }
};

export const END_REASONS: Record<string, string> = {
	majority: 'кандидату исполнилось 18',
	revoked_by_representative: 'представитель отозвал',
	authority_rejected: 'полномочия не подтверждены',
	operator_revoked: 'отозвано оператором',
	candidate_deleted: 'кандидат удалил профиль',
	invitation_expired: 'срок ссылки истёк'
};

export const AUTHORITY_CHECK_METHODS: Record<string, { label: string; hint: string }> = {
	document_presented: {
		label: 'Документ предъявлен на встрече или видеозвонке',
		hint: 'Копия не хранится: вы сверяете документ с человеком и записываете только, что сверено.'
	},
	in_person: {
		label: 'Личная встреча',
		hint: 'Представитель пришёл лично с документом; копия не хранится.'
	},
	document_upload: {
		label: 'Копия документа',
		hint: 'Хранится со своим сроком, отдельно от профиля.'
	},
	esia: { label: 'Госуслуги (ЕСИА)', hint: 'Дорожная карта.' }
};

export const AUTHORITY_BASES: Record<string, string> = {
	birth_certificate: 'Свидетельство о рождении',
	adoption_decision: 'Решение суда об усыновлении',
	guardianship_act: 'Акт об опеке',
	custodianship_act: 'Акт о попечительстве'
};

export const PARTNERSHIP_KINDS: Record<string, string> = {
	case_provider: 'Кейсодатель',
	sponsor: 'Спонсор',
	organizer_partner: 'Партнёр организатора'
};

export const POOL_AWARDS: Record<string, string> = {
	winner: 'победители',
	prize: 'призёры и выше',
	finalist: 'финалисты и выше',
	participant: 'все участники'
};

export const POOL_STAGES: Record<string, string> = {
	final: 'финал',
	qualifier: 'отборочный этап',
	single: 'единственный этап'
};

/** Age of a candidate by band (`visibility/age.ts`): a minor's exact age, or the band in words. */
export function ageText(age: string | number): string {
	if (typeof age === 'number') return `${age} ${pluralize(age, ['год', 'года', 'лет'])}`;
	if (age === 'adult') return '18 лет и старше';
	if (age === 'under_14') return 'младше 14 лет';
	return 'возраст не подтверждён';
}

/** A count or «fewer than N» of an aggregate (the career funnel, the feedback, the pools). */
export type Cell = { value: number } | { below: number };

export function cellText(cell: Cell): string {
	return 'below' in cell ? `< ${cell.below}` : new Intl.NumberFormat('ru-RU').format(cell.value);
}

export function cellValue(cell: Cell): number | null {
	return 'below' in cell ? null : cell.value;
}

const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 });

export function shareText(share: number | null): string {
	return share === null ? '—' : percent.format(share);
}

/** Time left to a due date in words: «осталось 3 дня», «просрочено на 2 дня». */
export function dueText(dueAt: Date, now: Date): string {
	const ms = dueAt.getTime() - now.getTime();
	const hours = Math.round(Math.abs(ms) / 3_600_000);
	const span =
		hours < 48
			? `${hours} ${pluralize(hours, ['час', 'часа', 'часов'])}`
			: `${Math.round(hours / 24)} ${pluralize(Math.round(hours / 24), ['день', 'дня', 'дней'])}`;
	return ms <= 0 ? `просрочено на ${span}` : `осталось ${span}`;
}

/** A group of the career funnel as the service returns it (`hiring/funnel.ts`). */
export interface FunnelGroupView {
	key: string;
	/** Groups pooled into this row; 0 — a group of its own. */
	pooled: number;
	synthetic: boolean;
	invited: Cell;
	contact: Cell;
	interview: { total: Cell; bySource: Record<'company' | 'candidate' | 'both', Cell> };
	offer: { total: Cell; bySource: Record<'company' | 'candidate' | 'both', Cell> };
	hired: { confirmed: Cell; singleParty: Record<'company' | 'candidate', Cell>; diverged: Cell };
	notHired: Cell;
	unknown: Cell;
	children: FunnelGroupView[];
}

export const FUNNEL_DIMENSIONS: Record<string, string> = {
	fsp_discipline: 'Дисциплина ФСП',
	fsp_level: 'Уровень ФСП',
	competition: 'Соревнование ФСП',
	specialization: 'Категория: специализация',
	grade: 'Категория: грейд',
	region: 'Регион',
	month: 'Месяц приглашения',
	fsp_participant: 'Участник ФСП или нет'
};

/** Dimensions where one candidate can be in several groups: the rows do not sum to the total. */
export const MULTI_GROUP_DIMENSIONS: Readonly<Record<string, string>> = {
	fsp_discipline: 'в каждой своей дисциплине',
	fsp_level: 'на каждом своём уровне (уровень ставится по дисциплине)',
	competition: 'в каждом соревновании, где у него есть результат',
	month: 'в каждом месяце, когда его приглашали'
};

/** The key of the row that pools the small groups (`SMALL_GROUPS` of the service). */
export const SMALL_GROUPS = '__small__';

const monthFormat = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** What the funnel page names its keys with. */
export interface FunnelNames {
	specializations: Readonly<Record<string, string>>;
	grades: Readonly<Record<string, string>>;
	competitions: Readonly<Record<string, { title: string; startDate: string | null }>>;
	discipline: (code: string) => string;
}

/** The name of a group of a funnel dimension. */
export function funnelGroupName(
	dimension: string,
	group: Pick<FunnelGroupView, 'key' | 'pooled'>,
	names: FunnelNames
): string {
	const { key } = group;
	if (key === SMALL_GROUPS)
		return `Малые группы (${group.pooled} ${pluralize(group.pooled, ['группа', 'группы', 'групп'])}), вместе`;
	switch (dimension) {
		case 'month':
			return /^\d{4}-\d{2}$/.test(key) ? monthFormat.format(new Date(`${key}-01T00:00:00Z`)) : key;
		case 'specialization':
			return key === 'none' ? 'Категория не подтверждена' : (names.specializations[key] ?? key);
		case 'grade':
			return key === 'none' ? 'Категория не подтверждена' : (names.grades[key] ?? key);
		case 'fsp_participant':
			return key === 'fsp' ? 'Участники ФСП' : 'Без результатов ФСП';
		case 'fsp_discipline':
			return key === 'none' ? 'Без уровня ФСП' : names.discipline(key);
		case 'fsp_level':
			return key === 'none' ? 'Без уровня ФСП' : FSP_LEVELS[key] ? `${key} — ${FSP_LEVELS[key]}` : key;
		case 'competition': {
			if (key === 'none') return 'Без результатов соревнований';
			const competition = names.competitions[key];
			return competition
				? `${competition.title}${competition.startDate ? `, ${competition.startDate.slice(0, 4)}` : ''}`
				: key;
		}
		case 'region':
			return key === 'none' ? 'Регион не указан' : key;
		default:
			return key;
	}
}

/** How long a case waits: «ждёт 5 часов», «ждёт 3 дня». */
export function waitText(since: Date, now: Date): string {
	const hours = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 3_600_000));
	if (hours < 1) return 'ждёт меньше часа';
	if (hours < 48) return `ждёт ${hours} ${pluralize(hours, ['час', 'часа', 'часов'])}`;
	const days = Math.floor(hours / 24);
	return `ждёт ${days} ${pluralize(days, ['день', 'дня', 'дней'])}`;
}

/** Categories of the check of vacancy texts for discriminatory requirements (`vacancies/text-check.ts`). */
export const TEXT_CHECK_CATEGORIES: Record<string, string> = {
	sex: 'Пол',
	age: 'Возраст',
	citizenship: 'Гражданство',
	marital_status: 'Семейное положение',
	nationality: 'Национальность',
	appearance: 'Внешность'
};

export const TEXT_FIELDS: Record<string, string> = { title: 'Название', description: 'Описание' };

/** The operator's decisions on a vacancy in moderation. */
export const MODERATION_OUTCOMES: Record<'published' | 'returned' | 'rejected', { label: string; tone: Tone }> = {
	published: { label: 'Опубликована оператором', tone: 'success' },
	returned: { label: 'Возвращена на правку', tone: 'warning' },
	rejected: { label: 'Отклонена', tone: 'danger' }
};

/** Events of a moderation case as its history reads them. */
export const MODERATION_HISTORY: Record<string, string> = {
	'vacancy.blocked_text_check': 'Проверка текста отправила вакансию на модерацию',
	'vacancy.moderation_decided': 'Решение оператора',
	'vacancy.moderation_cleared': 'Компания исправила текст — вакансия вышла из модерации',
	'vacancy.published': 'Вакансия опубликована',
	'vacancy.closed': 'Вакансия закрыта'
};

/** Reasons of a candidate's complaint about an offer (domain 13.13), as the operator reads them. */
export const COMPLAINT_REASONS: Record<string, string> = {
	terms_mismatch: 'Условия на деле не совпали с предложением',
	no_real_job: 'Работы, которую описывает предложение, нет',
	contact_harvesting: 'Предложение использовали, чтобы получить контакты',
	payment_demanded: 'От кандидата требовали оплату',
	discrimination: 'Дискриминирующие требования или вопросы',
	other: 'Другое'
};

export const COMPLAINT_DECISIONS: Record<string, { label: string; tone: Tone }> = {
	no_action: { label: 'Без последствий', tone: 'neutral' },
	warning: { label: 'Предупреждение', tone: 'warning' },
	suspension: { label: 'Компания приостановлена', tone: 'danger' }
};
