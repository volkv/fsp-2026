/**
 * View-model vocabulary of the product components: the enumerations of docs/domain.md and docs/contracts.md
 * with their interface wording. Components receive domain values and never invent their own labels.
 */
import type { Award } from '$lib/fsp/awards';

/** Trust level of a source fact (domain §9.1). */
export type TrustLevel = 'fsp_verified' | 'platform_verified' | 'public_verifiable' | 'claimed';

/** What a skill mark shows: a fact trust level, or an inference without a badge (domain §9.3, `attestation = derived`). */
export type TrustMark = TrustLevel | 'derived';

/** Wording register: employers get HR language, the candidate cabinet may use the sport register (CONCEPT). */
export type Register = 'hr' | 'sport';

export interface TrustMeta {
	label: string;
	/** Label in the candidate cabinet, where competitive-programming slang is appropriate. */
	sportLabel: string;
	short: string;
	/** Filled nodes of the three-node signal. */
	nodes: 0 | 1 | 2 | 3;
	asserts: string;
	doesNotAssert: string;
}

export const TRUST: Record<TrustMark, TrustMeta> = {
	fsp_verified: {
		label: 'Подтверждено ФСП',
		sportLabel: 'AC · ФСП',
		short: 'ФСП',
		nodes: 3,
		asserts:
			'Результат или разряд из данных Федерации спортивного программирования, привязанный к спортсмену через ФСП ID.',
		doesNotAssert: 'Личный вклад в командное решение, владение конкретным языком, коммерческий опыт.'
	},
	platform_verified: {
		label: 'Подтверждено платформой',
		sportLabel: 'Тест платформы',
		short: 'Тест',
		nodes: 2,
		asserts: 'Задание платформы выполнено в изолированной песочнице; сохранены версия задания, попытка и артефакты.',
		doesNotAssert: 'Самостоятельность выполнения и навыки за пределами покрытия задания.'
	},
	public_verifiable: {
		label: 'Публичный профиль',
		sportLabel: 'Публичный профиль',
		short: 'Профиль',
		nodes: 1,
		asserts: 'Данные публичного профиля (Codeforces, GitHub), владение которым подтверждено.',
		doesNotAssert: 'Авторство каждого решения или коммита и коммерческий опыт.'
	},
	claimed: {
		label: 'Заявлено',
		sportLabel: 'Заявлено',
		short: 'Заявлено',
		nodes: 0,
		asserts: 'Указано кандидатом или извлечено из резюме с цитатой из документа.',
		doesNotAssert: 'Источник не проверен: это слова кандидата, а не подтверждение.'
	},
	derived: {
		label: 'Вывод',
		sportLabel: 'Вывод',
		short: 'Вывод',
		nodes: 0,
		asserts: 'Навык выведен правилом из других фактов профиля, например из специализации в командном соревновании.',
		doesNotAssert: 'Отдельного прямого подтверждения навыка нет, поэтому бейдж не ставится.'
	}
};

/** Discipline codes of the FSP achievements contract (contracts §1.3). */
export type DisciplineCode = 'algorithmic' | 'product' | 'uas' | 'robotics' | 'infosec';

export const DISCIPLINES: Record<DisciplineCode | 'unknown', { name: string; short: string }> = {
	algorithmic: { name: 'Программирование алгоритмическое', short: 'Алгоритмическое' },
	product: { name: 'Программирование продуктовое', short: 'Продуктовое' },
	infosec: { name: 'Программирование систем информационной безопасности', short: 'Информационная безопасность' },
	robotics: { name: 'Программирование робототехники', short: 'Робототехника' },
	uas: { name: 'Программирование беспилотных авиационных систем', short: 'БАС' },
	unknown: { name: 'Дисциплина не передана', short: 'Дисциплина не передана' }
};

export type CompetitionLevel =
	| 'world_championship'
	| 'european_championship'
	| 'international_ekp'
	| 'russian_championship'
	| 'russian_cup'
	| 'russian_youth_championship'
	| 'all_russian_ekp'
	| 'all_russian_sport_event'
	| 'universiade'
	| 'federal_district'
	| 'interregional_ekp'
	| 'regional_championship'
	| 'regional_cup'
	| 'regional_youth'
	| 'regional_other'
	| 'municipal'
	| 'accredited'
	| 'unofficial';

export const COMPETITION_LEVELS: Record<CompetitionLevel | 'unknown', string> = {
	world_championship: 'Чемпионат мира',
	european_championship: 'Чемпионат Европы',
	international_ekp: 'Международное соревнование ЕКП',
	russian_championship: 'Чемпионат России',
	russian_cup: 'Кубок России',
	russian_youth_championship: 'Первенство России',
	all_russian_ekp: 'Всероссийское соревнование ЕКП',
	all_russian_sport_event: 'Всероссийское физкультурное мероприятие',
	universiade: 'Универсиада',
	federal_district: 'Соревнование федерального округа',
	interregional_ekp: 'Межрегиональное соревнование ЕКП',
	regional_championship: 'Чемпионат субъекта',
	regional_cup: 'Кубок субъекта',
	regional_youth: 'Первенство субъекта',
	regional_other: 'Региональное соревнование',
	municipal: 'Муниципальное соревнование',
	accredited: 'Аккредитованное соревнование',
	unofficial: 'Неофициальное соревнование',
	unknown: 'Уровень не передан'
};

export type { Award };

export const AWARDS: Record<Award | 'unknown', string> = {
	winner: 'Победитель',
	prize: 'Призёр',
	finalist: 'Финалист',
	participant: 'Участник',
	unknown: 'Результат не передан'
};

/** Competition format: on-site finals weigh more than online qualifiers (domain §9.3). */
export type CompetitionFormat = 'onsite' | 'online' | 'unknown';

export const COMPETITION_FORMATS: Record<CompetitionFormat, string> = {
	onsite: 'Очно',
	online: 'Онлайн',
	unknown: 'Формат не передан'
};

export type EvskRank = 'MS' | 'KMS' | 'I' | 'II' | 'III' | 'Y1' | 'Y2' | 'Y3';

export const EVSK_RANKS: Record<EvskRank, string> = {
	MS: 'МС',
	KMS: 'КМС',
	I: 'I разряд',
	II: 'II разряд',
	III: 'III разряд',
	Y1: 'I юношеский',
	Y2: 'II юношеский',
	Y3: 'III юношеский'
};

/** FSP level facet (domain §12.2): separate from grade. */
export type FspLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

/** Receipt of a verified fact (domain §9.6). Status is computed at check time. */
export type ReceiptStatus = 'valid' | 'superseded' | 'annulled' | 'not_valid';

export const RECEIPT_STATUSES: Record<ReceiptStatus, string> = {
	valid: 'Действительна',
	superseded: 'Источник прислал новую версию',
	annulled: 'Аннулирована источником',
	not_valid: 'Недействительна'
};

export type ReceiptSource = 'fsp' | 'platform_test' | 'codeforces' | 'github';

export const RECEIPT_SOURCES: Record<ReceiptSource, string> = {
	fsp: 'Федерация спортивного программирования',
	platform_test: 'Тест платформы',
	codeforces: 'Codeforces',
	github: 'GitHub'
};

export const RECEIPT_SOURCE_TRUST: Record<ReceiptSource, TrustLevel> = {
	fsp: 'fsp_verified',
	platform_test: 'platform_verified',
	codeforces: 'public_verifiable',
	github: 'public_verifiable'
};

export type DisclosureLevel = 'generalized' | 'exact';

/** Match components (domain §13.4). */
export type MatchComponentKey = 'required' | 'nice' | 'role' | 'trust' | 'grade' | 'salary' | 'semantic' | 'reranker';
export type MatchComponentStatus = 'computed' | 'unknown' | 'unavailable' | 'not_comparable';

export const MATCH_COMPONENTS: Record<MatchComponentKey, string> = {
	required: 'Обязательные навыки',
	nice: 'Желательные навыки',
	role: 'Роль',
	trust: 'Доверие к оценке',
	grade: 'Грейд',
	salary: 'Зарплата',
	semantic: 'Смысловая близость',
	reranker: 'Уточняющая модель'
};

export const MATCH_COMPONENT_STATUSES: Record<Exclude<MatchComponentStatus, 'computed'>, string> = {
	unknown: 'неизвестно',
	unavailable: 'недоступно',
	not_comparable: 'несравнимо'
};

/** Salary block (domain §0). */
export type SalaryPeriod = 'month' | 'year' | 'hour' | 'project';
export type TaxBase = 'gross' | 'net' | 'unknown';

export const SALARY_PERIODS: Record<SalaryPeriod, string> = {
	month: 'в месяц',
	year: 'в год',
	hour: 'в час',
	project: 'за проект'
};

export const TAX_BASES: Record<TaxBase, string> = {
	gross: 'до вычета НДФЛ',
	net: 'на руки',
	unknown: 'налоговая база не указана'
};

/** Invitation status (domain §13.5). */
export type InvitationStatus = 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'withdrawn';

export const INVITATION_STATUSES: Record<InvitationStatus, string> = {
	sent: 'Отправлено',
	viewed: 'Просмотрено',
	accepted: 'Принято',
	declined: 'Отклонено',
	expired: 'Срок ответа истёк',
	withdrawn: 'Отозвано'
};

/** Hiring stages and outcome state (domain §13.7). */
export type HiringStage = 'interview_scheduled' | 'interview_done' | 'offer_made' | 'offer_accepted';

export const HIRING_STAGES: { key: HiringStage; label: string }[] = [
	{ key: 'interview_scheduled', label: 'Собеседование назначено' },
	{ key: 'interview_done', label: 'Собеседование прошло' },
	{ key: 'offer_made', label: 'Предложение сделано' },
	{ key: 'offer_accepted', label: 'Предложение принято' }
];

export type HiringOutcomeState = 'pending' | 'single_party' | 'confirmed' | 'diverged' | 'unknown';
export type HiringOutcome = 'hired' | 'not_hired' | 'candidate_withdrew' | 'company_stopped' | 'no_contact';
export type HiringParty = 'company' | 'candidate';

export const HIRING_OUTCOMES: Record<HiringOutcome, string> = {
	hired: 'Выход на работу',
	not_hired: 'Не нанят',
	candidate_withdrew: 'Кандидат отказался',
	company_stopped: 'Компания остановила найм',
	no_contact: 'Связь не состоялась'
};

export const HIRING_PARTIES: Record<HiringParty, string> = {
	company: 'компания',
	candidate: 'кандидат'
};

/** Operations of the model adapter that can be down independently (contracts §3.5). */
export type ModelOperation = 'extract' | 'embed' | 'rerank';

const plural = new Intl.PluralRules('ru-RU');

/** Russian plural form: `pluralize(5, ['день', 'дня', 'дней'])`. */
export function pluralize(count: number, forms: readonly [one: string, few: string, many: string]): string {
	const rule = plural.select(count);
	if (rule === 'one') return forms[0];
	if (rule === 'few') return forms[1];
	return forms[2];
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
	timeZone: 'Europe/Moscow'
});

const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
	day: 'numeric',
	month: 'long',
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'Europe/Moscow',
	timeZoneName: 'short'
});

/** Calendar date in the product time zone: «20.09.2026». */
export function formatDate(value: Date | string): string {
	return dateFormat.format(typeof value === 'string' ? new Date(value) : value);
}

/** Moment with time in the product time zone. */
export function formatDateTime(value: Date | string): string {
	return dateTimeFormat.format(typeof value === 'string' ? new Date(value) : value);
}

// View models of the product components.

export interface ReceiptView {
	/** Public receipt identifier (domain §9.6); verifiable without revealing the candidate. */
	handle: string;
	source: ReceiptSource;
	title: string;
	/** Last reconciliation with the source. */
	verifiedAt: string;
	status: ReceiptStatus;
	disclosure: DisclosureLevel;
	asserts: { label: string; value: string }[];
	doesNotAssert: string[];
	signingKeyId: string;
}

/**
 * An FSP competition result as the catalog projection shows it (domain §14): generalized by default, exact only
 * when the candidate (18+) disclosed it or for the recipient after consent.
 */
export interface AchievementView {
	discipline: DisciplineCode | 'unknown';
	level: CompetitionLevel | 'unknown';
	award: Award | 'unknown';
	format: CompetitionFormat;
	season: number;
	team: boolean;
	/** Norm the result corresponds to by the EVSK table — a computed indicator, not an assigned rank. */
	evskIndicator?: EvskRank | null;
	exact?: {
		competition: string;
		place: number | null;
		placeOf?: number;
		teamName?: string;
	};
}

/** An axis that is either established by its own evidence or honestly unknown (domain §12.2). */
export type Axis<T> = ({ status: 'established' } & T) | { status: 'insufficient_data'; hint?: string };

export interface CategoryView {
	role: Axis<{ label: string }>;
	grade: Axis<{
		/** Grade scale of the taxonomy, lowest first; the range is inclusive indices into it. */
		scale: string[];
		min: number;
		max: number;
		/** 0…1 */
		confidence: number;
	}>;
	stack: Axis<{ skills: string[] }>;
	/** Role the candidate wants, when it differs from the inferred one. */
	desiredRole?: string;
	fspLevels?: { discipline: DisciplineCode; level: FspLevel }[];
}

/** Stored match result with its decomposition (domain §13.4). */
export interface MatchView {
	/** Weighted sum of the computed components, 0…1. */
	score: number;
	components: {
		key: MatchComponentKey;
		status: MatchComponentStatus;
		/** 0…1, present when computed. */
		value?: number;
		/** The rule set's share for this component, 0…1 — kept even for one counted without its own computation (a
		 * candidate with no usable categorization run — domain §13.4). */
		weight?: number;
		/** Why the component was not computed. */
		reason?: string;
		/** What the computed value rests on, in words: which role fits, how much of the requirements is confirmed. */
		note?: string;
	}[];
	matches: { requirement: string; evidence: string; trust: TrustMark }[];
	unknown: string[];
	toVerify: string[];
	gaps: string[];
}

/** Salary block (domain §0): a missing bound is an open end, both missing — salary not stated. */
export interface SalaryView {
	min: number | null;
	max: number | null;
	/** ISO 4217 */
	currency?: string;
	period?: SalaryPeriod;
	taxBase?: TaxBase;
}

export type SalaryComparison = 'lower' | 'equal' | 'higher' | 'overlap' | 'not_comparable';

/** Derived hiring state (domain §13.7): each party reports on its own, silence is not an outcome. */
export interface HiringView {
	/** Who reported each stage. */
	stages: Partial<Record<HiringStage, HiringParty[]>>;
	outcome: {
		state: HiringOutcomeState;
		reports: { party: HiringParty; outcome: HiringOutcome }[];
	};
}
