/**
 * Wording of the candidate cabinet: the codes the services store (fact sources, statuses of objections, reasons) and
 * the words the candidate reads. The cabinet speaks to the candidate on «ты»; the sport register is allowed here and
 * nowhere else (CONCEPT).
 */
import {
	AWARDS,
	COMPETITION_FORMATS,
	COMPETITION_LEVELS,
	DISCIPLINES,
	EVSK_RANKS,
	type Award,
	type CompetitionLevel,
	type DisciplineCode,
	type EvskRank
} from '$lib/components/product/model.js';

/** Key → name maps of the taxonomy version the page shows (roles, grades, skills, work terms). */
export interface Labels {
	roles: Record<string, string>;
	/** Specializations of the catalog of categories. */
	specializations: Record<string, string>;
	grades: Record<string, string>;
	skills: Record<string, string>;
	workFormats: Record<string, string>;
	employmentForms: Record<string, string>;
}

const nameOr = (map: Record<string, string>, key: string) => map[key] ?? key;

export const skillName = (labels: Labels, key: string) => nameOr(labels.skills, key);
export const roleName = (labels: Labels, key: string) => nameOr(labels.roles, key);
export const gradeName = (labels: Labels, key: string) => nameOr(labels.grades, key);

// --- Facts and their sources --------------------------------------------------------------------------------------

export type FactSource = 'fsp' | 'platform_test' | 'codeforces' | 'github' | 'resume';

export const FACT_SOURCES: Record<FactSource, string> = {
	fsp: 'Федерация спортивного программирования',
	platform_test: 'Тест платформы',
	codeforces: 'Codeforces',
	github: 'GitHub',
	resume: 'Резюме'
};

/** `source_facts.ownership_basis`: how the fact is tied to you. */
export const OWNERSHIP_BASES: Record<string, string> = {
	athlete_link: 'спортсмен связан через ФСП ID, импорт — по твоему согласию',
	operator_confirmed: 'связь со спортсменом подтвердил оператор ФСП',
	protocol_self_claim: 'заявка по протоколу соревнования',
	own_attempt: 'твоя попытка теста на платформе',
	oauth_account: 'вход в аккаунт платформы',
	handle_challenge: 'проверка владения профилем',
	self_upload: 'загружено тобой',
	self_declared: 'указано тобой'
};

export type FactStatus = 'active' | 'superseded' | 'withdrawn' | 'annulled';

export const ATTESTATIONS: Record<'direct' | 'derived' | 'claimed', string> = {
	direct: 'прямое подтверждение',
	derived: 'вывод по правилу',
	claimed: 'заявлено, не проверено'
};

export const CONTRIBUTION_BASES: Record<string, string> = {
	fsp_projection: 'результат ФСП по правилу проекции',
	resume_mention: 'упоминание в резюме',
	resume_experience: 'опыт из резюме',
	platform_test: 'тест платформы',
	public_profile: 'подтверждённый публичный профиль',
	child_skill: 'через более узкий навык'
};

export const STRENGTH_BANDS: Record<'weak' | 'moderate' | 'strong', string> = {
	weak: 'слабые основания',
	moderate: 'умеренные основания',
	strong: 'сильные основания'
};

export const STAGES: Record<string, string> = {
	qualifier: 'отборочный этап',
	final: 'финал',
	single: 'единый этап',
	unknown: 'этап не передан'
};

export const TEAM_ROLES: Record<string, string> = {
	captain: 'капитан',
	athlete: 'участник команды',
	reserve: 'запасной',
	trainer: 'тренер',
	unknown: 'роль не передана'
};

export const SQUADS: Record<'main' | 'reserve', string> = { main: 'основной состав', reserve: 'резерв' };

const QUALIFICATION_RANKS: Record<string, string> = {
	ZMS: 'ЗМС',
	MSMK: 'МСМК',
	...EVSK_RANKS,
	unknown: 'разряд не передан'
};

export const rankName = (rank: string) => QUALIFICATION_RANKS[rank] ?? rank;

const isKey = <T extends string>(map: Record<T, unknown>, key: string): key is T => Object.hasOwn(map, key);

export const disciplineName = (code: string) =>
	isKey(DISCIPLINES, code) ? DISCIPLINES[code].name : DISCIPLINES.unknown.name;
export const disciplineShort = (code: string) =>
	isKey(DISCIPLINES, code) ? DISCIPLINES[code].short : DISCIPLINES.unknown.short;
export const levelName = (code: string) =>
	isKey(COMPETITION_LEVELS, code) ? COMPETITION_LEVELS[code] : COMPETITION_LEVELS.unknown;
export const awardName = (code: string) => (isKey(AWARDS, code) ? AWARDS[code] : AWARDS.unknown);

export function asDiscipline(code: string): DisciplineCode | 'unknown' {
	return isKey(DISCIPLINES, code) ? code : 'unknown';
}
export function asLevel(code: string): CompetitionLevel | 'unknown' {
	return isKey(COMPETITION_LEVELS, code) ? code : 'unknown';
}
export function asAward(code: string): Award | 'unknown' {
	return isKey(AWARDS, code) ? code : 'unknown';
}
export function asEvsk(code: string | null): EvskRank | null {
	return code !== null && isKey(EVSK_RANKS, code) ? code : null;
}

/** Labels and values of what a receipt asserts (receipt templates, domain 9.6). */
const ASSERT_LABELS: Record<string, string> = {
	discipline: 'Дисциплина',
	competitionLevel: 'Уровень соревнования',
	competition: 'Соревнование',
	season: 'Сезон',
	stage: 'Этап',
	place: 'Место',
	resultGroup: 'Результат',
	format: 'Формат',
	rank: 'Разряд',
	assignedYear: 'Год присвоения',
	squad: 'Состав',
	platform: 'Платформа',
	ratingBand: 'Уровень рейтинга',
	handle: 'Хэндл',
	rating: 'Рейтинг',
	maxRating: 'Максимальный рейтинг',
	languages: 'Языки репозиториев',
	repositories: 'Своих репозиториев'
};

/** Codeforces titles by rating, as a generalized receipt names the level of a peak rating. */
const RATING_BANDS: Record<string, string> = {
	unrated: 'без рейтинга',
	newbie: 'newbie (до 1200)',
	pupil: 'pupil (1200–1399)',
	specialist: 'specialist (1400–1599)',
	expert: 'expert (1600–1899)',
	candidate_master: 'candidate master (1900–2099)',
	master: 'master (2100–2299)',
	international_master: 'international master (2300–2399)',
	grandmaster: 'grandmaster (2400–2599)',
	international_grandmaster: 'international grandmaster (2600–2999)',
	legendary_grandmaster: 'legendary grandmaster (3000+)'
};

export function assertion(key: string, value: string | number): { label: string; value: string } {
	const text = String(value);
	const formatted =
		key === 'discipline'
			? disciplineName(text)
			: key === 'competitionLevel'
				? levelName(text)
				: key === 'resultGroup'
					? awardName(text)
					: key === 'format'
						? COMPETITION_FORMATS[isKey(COMPETITION_FORMATS, text) ? text : 'unknown']
						: key === 'rank'
							? rankName(text)
							: key === 'squad' && (text === 'main' || text === 'reserve')
								? SQUADS[text]
								: key === 'stage'
									? (STAGES[text] ?? text)
									: key === 'ratingBand'
										? (RATING_BANDS[text] ?? text)
										: key === 'platform'
											? isKey(FACT_SOURCES, text)
												? FACT_SOURCES[text]
												: text
											: text;
	return { label: ASSERT_LABELS[key] ?? key, value: formatted };
}

// --- Category ----------------------------------------------------------------------------------------------------

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export const FSP_LEVELS: Record<string, string> = {
	L5: 'МС или основной состав сборной',
	L4: 'КМС или резерв сборной',
	L3: 'I разряд или расчётный показатель не ниже',
	L2: 'III разряд или расчётный показатель не ниже',
	L1: 'официальный результат в дисциплине'
};

export type ObjectionStatus = 'open' | 'in_review' | 'resolved' | 'withdrawn';

/** Statuses of an objection to a test result (domain 12.5), as the candidate reads them. */
export const OBJECTION_STATUSES: Record<
	ObjectionStatus,
	{ label: string; tone: 'info' | 'success' | 'neutral' | 'warning' }
> = {
	open: { label: 'Подано, ждёт оператора', tone: 'info' },
	in_review: { label: 'На рассмотрении у оператора ФСП', tone: 'info' },
	resolved: { label: 'Рассмотрено', tone: 'success' },
	withdrawn: { label: 'Отозвано тобой', tone: 'neutral' }
};

// --- Search, visibility, consents -------------------------------------------------------------------------------

export type SearchStatus = 'active' | 'open_to_offers' | 'not_looking';

export const SEARCH_STATUSES: Record<SearchStatus, { label: string; hint: string }> = {
	active: {
		label: 'Активно ищу',
		hint: 'Работодатели видят, что ты в поиске, и могут пригласить с вакансией и зарплатой.'
	},
	open_to_offers: {
		label: 'Открыт к предложениям',
		hint: 'Не ищешь активно, но интересные приглашения рассмотришь.'
	},
	not_looking: {
		label: 'Не ищу',
		hint: 'Профиль уходит из каталога работодателей; полученные приглашения остаются.'
	}
};

export const HIDDEN_REASONS: Record<string, string> = {
	hidden_by_candidate: 'Показ в каталоге выключен.',
	not_looking: 'Статус поиска «Не ищу»: профиль не показывается в каталоге.',
	no_catalog_consent: 'Нет согласия на показ профиля работодателям.',
	representative_consent_missing: 'Твоё согласие дано, нужно ещё согласие законного представителя.',
	minor_vacancy_context:
		'До 18 лет профиль виден только в контексте конкретной подходящей вакансии (стажировки), не всему каталогу.',
	minors_disabled: 'Показ профилей до 18 лет на платформе сейчас выключен.',
	age_unknown: 'Возраст не подтверждён: профиль закрыт до решения оператора.'
};

export const CATALOG_SCOPE: Record<'fsp_achievements_exact' | 'external_profiles', { label: string; hint: string }> = {
	fsp_achievements_exact: {
		label: 'Точные достижения ФСП',
		hint: 'Соревнование, этап, место, команда и ссылка на протокол. По ним тебя можно узнать.'
	},
	external_profiles: {
		label: 'Публичные профили',
		hint: 'Ссылки на подтверждённые профили Codeforces и GitHub.'
	}
};

/** Consents a legal representative signs for a candidate aged 14–17 (domain 6.3). */
export const REPRESENTATIVE_CONSENTS: Record<
	'pd_processing' | 'catalog_visibility' | 'fsp_import',
	{ label: string; hint: string }
> = {
	pd_processing: { label: 'Обработка персональных данных', hint: 'без него профиль не ведётся' },
	catalog_visibility: {
		label: 'Показ профиля работодателям',
		hint: 'обезличенная карточка, только в контексте подходящей вакансии'
	},
	fsp_import: { label: 'Достижения из систем ФСП', hint: 'результаты соревнований по привязанному ФСП ID' }
};

/** Where the legal representative stands (`representations.status`, domain 6.4). */
export const REPRESENTATION_STATES: Record<
	'invited' | 'contact_confirmed' | 'authority_pending' | 'authority_verified',
	{ label: string; hint: string; tone: 'neutral' | 'info' | 'success' | 'warning' }
> = {
	invited: {
		label: 'Ждём подтверждения почты',
		hint: 'Представитель ещё не перешёл по ссылке из письма.',
		tone: 'warning'
	},
	contact_confirmed: {
		label: 'Ждём проверки полномочий',
		hint: 'Оператор ФСП свяжется с представителем и сверит документ.',
		tone: 'info'
	},
	authority_pending: {
		label: 'Ждём проверки полномочий',
		hint: 'Оператор ФСП свяжется с представителем и сверит документ.',
		tone: 'info'
	},
	authority_verified: {
		label: 'Полномочия подтверждены',
		hint: 'Представитель подписывает согласия по ссылке из письма.',
		tone: 'success'
	}
};

export type DisclosureField = 'full_name' | 'email' | 'phone' | 'telegram' | 'resume';

export const DISCLOSURE_FIELDS: Record<DisclosureField, string> = {
	full_name: 'ФИО',
	email: 'Почта',
	phone: 'Телефон',
	telegram: 'Telegram',
	resume: 'Файл резюме'
};

export const REQUIRED_DISCLOSURE: readonly DisclosureField[] = ['full_name', 'email'];

/** Reason codes of the invitation and hiring policies; a code this version does not know is shown as is. */
const REASONS: Record<string, string> = {
	salary: 'Не устраивает зарплата',
	format: 'Не подходит формат работы',
	stack: 'Не мой стек',
	location: 'Не подходит город',
	not_looking: 'Не ищу работу сейчас',
	other_offer: 'Принял другое предложение',
	other: 'Другое',
	representative_declined: 'Законный представитель не дал согласия на раскрытие контактов'
};

export const reasonText = (code: string) => REASONS[code] ?? `Причина «${code}»`;

export const NOTIFICATION_CATEGORIES: Record<string, { label: string; hint: string }> = {
	invitations: { label: 'Приглашения', hint: 'новые приглашения, изменения условий, ответы' },
	deadlines: { label: 'Сроки', hint: 'напоминания о сроке ответа' },
	hiring: { label: 'Процесс найма', hint: 'просьбы сообщить исход, расхождения' },
	objections: { label: 'Возражения', hint: 'сроки ответа на возражения по результатам тестов — сотрудникам ФСП' },
	account: { label: 'Учётная запись', hint: 'безопасность и вход — всегда на почту' }
};

/** Field names of the differences between versions of invitation terms (`invitation_terms.changes`). */
const TERMS_FIELDS: Record<string, string> = {
	'vacancy.title': 'Название вакансии',
	'vacancy.role_key': 'Роль',
	'vacancy.grade_min': 'Грейд от',
	'vacancy.grade_max': 'Грейд до',
	'vacancy.work_format': 'Формат работы',
	'vacancy.employment_form': 'Занятость',
	'vacancy.contract_types': 'Тип договора',
	'vacancy.city_id': 'Город',
	'vacancy.timezone_overlap_hours': 'Пересечение часовых поясов',
	'vacancy.required_skill_keys': 'Обязательные навыки',
	'vacancy.nice_skill_keys': 'Желательные навыки',
	'vacancy.min_age': 'Минимальный возраст',
	'vacancy.revision': 'Редакция вакансии',
	title: 'Название',
	description: 'Описание',
	vacancy_id: 'Вакансия',
	salary_min: 'Зарплата от',
	salary_max: 'Зарплата до',
	salary_tax_base: 'Налоговая база',
	work_format: 'Формат работы',
	contact_method: 'Способ связи',
	why_you: 'Почему вы',
	message: 'Сообщение'
};

export const termsFieldName = (field: string) => TERMS_FIELDS[field] ?? field;

/** A value of a changed field in words; lists of keys are named by the taxonomy. */
export function termsValue(field: string, value: unknown, labels: Labels): string {
	if (value === null || value === undefined || value === '') return 'не указано';
	if (field.endsWith('skill_keys'))
		return (
			strings(value)
				.map((key) => skillName(labels, key))
				.join(', ') || 'нет'
		);
	if (field === 'vacancy.role_key' && typeof value === 'string') return roleName(labels, value);
	if ((field === 'vacancy.grade_min' || field === 'vacancy.grade_max') && typeof value === 'string')
		return gradeName(labels, value);
	if ((field === 'vacancy.work_format' || field === 'work_format') && typeof value === 'string') {
		return nameOr(labels.workFormats, value);
	}
	if (field === 'salary_tax_base' && (value === 'gross' || value === 'net')) {
		return value === 'gross' ? 'до вычета НДФЛ' : 'на руки';
	}
	if (field === 'contact_method' && typeof value === 'object' && 'value' in value && typeof value.value === 'string') {
		return value.value;
	}
	if (field === 'why_you' && Array.isArray(value)) {
		return value
			.map((point: unknown) =>
				typeof point === 'object' && point !== null && 'text' in point && typeof point.text === 'string'
					? point.text
					: ''
			)
			.join('; ');
	}
	if (field === 'vacancy.employment_form' && typeof value === 'string') return nameOr(labels.employmentForms, value);
	if (typeof value === 'number') return new Intl.NumberFormat('ru-RU').format(value);
	if (Array.isArray(value)) return strings(value).join(', ');
	return typeof value === 'string' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

// --- View models of the cabinet components -----------------------------------------------------------------------

export type TrustLevel = 'fsp_verified' | 'platform_verified' | 'public_verifiable' | 'claimed';
export type Attestation = 'direct' | 'derived' | 'claimed';

export type FactDetailView =
	| {
			kind: 'competition_result';
			competition: string;
			discipline: string;
			level: string;
			stage: string | null;
			format: 'onsite' | 'online' | 'unknown';
			season: number;
			award: string;
			place: number | null;
			placeOf: number | null;
			team: { name: string; role: string | null; specialization: string | null } | null;
			evskIndicator: string | null;
			resultStatus: string;
			protocolUrl: string | null;
	  }
	| { kind: 'qualification'; discipline: string; rank: string; assignedAt: string }
	| { kind: 'national_team'; discipline: string; squad: 'main' | 'reserve'; season: number }
	| { kind: 'platform_rating'; platform: string; login: string; rating: number | null }
	| {
			kind: 'test_score';
			title: string;
			attemptId: string;
			decisionId: string;
			blocks: string[];
			bankReleaseId: string;
			decidedOn: string;
	  }
	| { kind: 'test_block'; title: string; skillKeys: string[]; bankReleaseId: string; decidedOn: string }
	| { kind: 'other'; factType: string };

export interface ReceiptData {
	handle: string;
	status: 'valid' | 'superseded' | 'annulled' | 'not_valid';
	verifiedAt: string;
	asserts: Record<string, string | number>;
	doesNotAssert: string[];
	signingKeyId: string;
	/** The statement says its source is the simulator of FSP on a demonstration stand (`source_simulator`). */
	simulator: boolean;
}

export interface FactView {
	id: string;
	source: FactSource;
	trustLevel: TrustLevel;
	ownershipBasis: string;
	status: FactStatus;
	statusReason: string | null;
	observedAt: Date;
	lastVerifiedAt: Date;
	occurredOn: string | null;
	detail: FactDetailView;
	receipt: ReceiptData | null;
	supports: { skillKey: string; attestation: Attestation }[];
}

export interface SkillView {
	skillKey: string;
	strength: number;
	band: 'weak' | 'moderate' | 'strong';
	attestation: Attestation;
	badgeTrust: TrustLevel | null;
	sources: {
		factId: string;
		source: FactSource;
		trustLevel: TrustLevel;
		attestation: Attestation;
		basis: string;
		claimId: string | null;
		experienceEntryId: string | null;
		viaSkill: string | null;
		contribution: number;
	}[];
}

/** The mark a skill shows: the badge of a direct attestation, otherwise an inference or a claim without a badge. */
export function skillMark(skill: Pick<SkillView, 'attestation' | 'badgeTrust'>): TrustLevel | 'derived' {
	if (skill.attestation === 'direct' && skill.badgeTrust !== null) return skill.badgeTrust;
	return skill.attestation === 'claimed' ? 'claimed' : 'derived';
}

/** A short title of a fact for lists and receipts. */
export function factTitle(detail: FactDetailView): string {
	switch (detail.kind) {
		case 'competition_result':
			return `${detail.competition}, ${detail.season}`;
		case 'qualification':
			return `${rankName(detail.rank)} · ${disciplineShort(detail.discipline)}`;
		case 'national_team':
			return `Сборная России · ${disciplineShort(detail.discipline)}, ${detail.season}`;
		case 'platform_rating':
			return `Аккаунт ${detail.platform}`;
		case 'test_score':
			return `Тест на грейд ${detail.title}`;
		case 'test_block':
			return detail.title;
		case 'other':
			return detail.factType === 'resume_document' ? 'Резюме' : 'Факт профиля';
	}
}

// --- Public profiles ------------------------------------------------------------------------------------------------

export type ExternalPlatform = 'codeforces' | 'github';

export const EXTERNAL_PLATFORMS: Record<ExternalPlatform, { name: string; profileUrl: (handle: string) => string }> = {
	codeforces: {
		name: 'Codeforces',
		profileUrl: (handle) => `https://codeforces.com/profile/${encodeURIComponent(handle)}`
	},
	github: { name: 'GitHub', profileUrl: (handle) => `https://github.com/${encodeURIComponent(handle)}` }
};

/** Why the last reading of a profile failed (`external_profiles.sync_error`). */
export const SOURCE_FAILURES: Record<string, string> = {
	timeout: 'не ответил вовремя',
	network: 'недоступен по сети',
	rate_limited: 'ограничил частоту запросов',
	server_error: 'ответил ошибкой сервера',
	protocol_error: 'ответил в неожиданном формате'
};

/** A linked public profile as its owner sees it. */
export interface ExternalProfileView {
	id: string;
	platform: ExternalPlatform;
	handle: string;
	status: 'unverified' | 'verified';
	verifiedAt: Date | null;
	challenge: { code: string; expiresAt: Date; attemptsLeft: number } | null;
	syncStatus: 'pending' | 'ok' | 'source_unavailable' | 'not_found' | null;
	syncError: string | null;
	syncCheckedAt: Date | null;
	syncedAt: Date | null;
	factId: string | null;
	receipt: {
		handle: string;
		status: 'valid' | 'superseded' | 'annulled' | 'not_valid';
		verifiedAt: string;
		asserts: Record<string, string | number>;
		doesNotAssert: string[];
		signingKeyId: string;
	} | null;
	summary:
		| {
				kind: 'codeforces';
				data: {
					account: { rating: number | null };
					maxRating: number | null;
					rank: string | null;
					solvedCount: number;
					ratedContests: number;
					lastRatedOn: string | null;
				};
		  }
		| {
				kind: 'github';
				data: {
					publicRepos: number;
					ownRepos: number;
					reposRead: number;
					languages: { name: string; share: number; repos: number }[];
					lastPushMonth: string | null;
					reposPushedLastYear: number;
				};
		  }
		| null;
}
