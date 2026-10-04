/**
 * Wording of the employer cabinet: statuses of the company, its vacancies and team, the reasons a model component is
 * unavailable, and the view models built from the answers of the services. HR language, never the sport register.
 */
import { inScore } from '$lib/matching/evidence-components.js';
import {
	DISCIPLINES,
	type CategoryView as CategoryAxesView,
	type DisciplineCode,
	type FspLevel,
	type MatchComponentKey,
	type MatchComponentStatus,
	type MatchView,
	type TrustMark
} from '$lib/components/product/model.js';

export type CompanyStatus = 'draft' | 'submitted' | 'verified' | 'rejected' | 'suspended';

export const COMPANY_STATUSES: Record<
	CompanyStatus,
	{ label: string; tone: 'neutral' | 'info' | 'success' | 'danger' }
> = {
	draft: { label: 'Черновик: не подана на проверку', tone: 'neutral' },
	submitted: { label: 'На проверке у оператора ФСП', tone: 'info' },
	verified: { label: 'Проверена', tone: 'success' },
	rejected: { label: 'Отклонена', tone: 'danger' },
	suspended: { label: 'Приостановлена', tone: 'danger' }
};

export type VacancyStatus = 'draft' | 'pending_moderation' | 'published' | 'paused' | 'closed';

export const VACANCY_STATUSES: Record<VacancyStatus, string> = {
	draft: 'Черновик',
	pending_moderation: 'На модерации',
	published: 'Опубликована',
	paused: 'Приостановлена',
	closed: 'Закрыта'
};

export const CLAIM_STATUSES: Record<string, string> = {
	awaiting_company_verification: 'Ждёт проверки компании',
	pending_review: 'На проверке у оператора',
	approved: 'Подтверждена',
	rejected: 'Отклонена',
	withdrawn: 'Отозвана'
};

export const MEMBER_ROLES: Record<'owner' | 'recruiter', string> = {
	owner: 'Владелец',
	recruiter: 'Рекрутер'
};

export const AUTHORITY_METHODS: Record<string, string> = {
	director_self: 'Заявитель — руководитель организации',
	power_of_attorney: 'Доверенность',
	corporate_email_domain: 'Рабочая почта на домене компании',
	signed_letter: 'Письмо за подписью руководителя',
	esign: 'Электронная подпись'
};

/** Reasons a search or a match component ran without a model (contracts 3.5), as the employer reads them. */
const MODEL_REASONS: Record<string, string> = {
	disabled: 'модель выключена настройкой',
	switched_off: 'модель выключена настройкой',
	timeout: 'модель не ответила вовремя',
	unavailable: 'модель недоступна',
	no_active_space: 'векторный поиск не настроен',
	no_vector: 'векторы профилей ещё не посчитаны',
	no_query: 'нет текста запроса',
	not_ranked: 'кандидат не ранжировался уточняющей моделью'
};

export function modelReason(reason: string | null | undefined): string {
	if (!reason) return 'причина не указана';
	return MODEL_REASONS[reason] ?? reason;
}

/** The fields as the form holds them: strings, so a refused post comes back exactly as typed. */
export interface VacancyFormValues {
	title: string;
	description: string;
	roleKey: string;
	gradeMin: string;
	gradeMax: string;
	requiredSkills: string;
	niceSkills: string;
	workFormat: string;
	employmentForm: string;
	contractTypes: string[];
	cityId: string;
	timezoneOverlapHours: string;
	/** `''` — adults only; `14`, `15`, `16` — a vacancy for minors from this age. */
	minAge: string;
	salaryMin: string;
	salaryMax: string;
	currency: string;
	period: string;
	taxBase: string;
}

// View models from the answers of the matching service.

interface MatchComponentData<Details> {
	value: number | null;
	weight: number;
	status: MatchComponentStatus;
	details: Details & { reason?: string };
}

/** Details of the role component: the vacancy's role, the candidate's established ones and why the role fits. */
export interface RoleDetails {
	vacancy?: string;
	candidate?: string[];
	basis?: 'primary' | 'secondary' | 'desired' | 'none';
}

/**
 * Details of the trust component: required skills confirmed by FSP or a platform test, those only a public profile
 * attests (they do not add to the trust), and the agreement of the grades; a trust that is not computed carries only
 * its reason.
 */
export type TrustDetails =
	| {
			direct: number;
			total: number;
			public_profile: number;
			confirmed_coverage: number;
			grade_agreement: number | null;
			grade_agreement_reason?: 'candidate_grade_not_established' | 'vacancy_grade_unknown';
	  }
	| { reason: string };

/** The explanation of a match as the company receives it (`CompanyMatch` of the matching service). */
export interface CompanyMatchData {
	score: number;
	coverage: number;
	components: Record<Exclude<MatchComponentKey, 'role' | 'trust'>, MatchComponentData<Record<string, unknown>>> & {
		role: MatchComponentData<RoleDetails>;
		trust: MatchComponentData<TrustDetails>;
	};
	explanation: {
		matches: (
			| {
					kind: 'skill';
					requirement: 'required' | 'nice';
					skill_key: string;
					band: 'weak' | 'moderate' | 'strong';
					attestation: 'direct' | 'derived' | 'claimed';
					badge_trust: 'fsp_verified' | 'platform_verified' | 'public_verifiable' | 'claimed' | null;
			  }
			| { kind: 'role'; role_key: string }
			| { kind: 'grade'; vacancy: { min: string; max: string }; candidate: { min: string; max: string } }
			| { kind: 'salary'; comparison: 'lower' | 'equal' | 'overlap' }
		)[];
		unknown: { component: MatchComponentKey; status: string; reason: string }[];
		to_verify: ({ code: string; skill_key?: string } & Record<string, unknown>)[];
		gaps: ({ code: string; skill_key?: string; steps?: number } & Record<string, unknown>)[];
	};
}

export interface Labels {
	roles: Record<string, string>;
	grades: Record<string, string>;
	skills: Record<string, string>;
}

const label = (map: Record<string, string>, key: string) => map[key] ?? key;

const BANDS: Record<'weak' | 'moderate' | 'strong', string> = {
	weak: 'слабое основание',
	moderate: 'среднее основание',
	strong: 'сильное основание'
};

const SALARY_MATCH: Record<'lower' | 'equal' | 'overlap', string> = {
	lower: 'ожидания кандидата ниже вилки вакансии',
	equal: 'ожидания совпадают с вилкой',
	overlap: 'ожидания пересекаются с вилкой'
};

function trustOf(attestation: 'direct' | 'derived' | 'claimed', badge: TrustMark | null): TrustMark {
	if (attestation === 'derived') return 'derived';
	if (attestation === 'claimed') return 'claimed';
	return badge ?? 'claimed';
}

const UNKNOWN_REASONS: Record<string, string> = {
	no_published_run: 'у кандидата нет действующей категории',
	run_below_evidence_floor: 'профиль пересчитывается после изменения доказательств',
	vacancy_grade_unknown: 'у вакансии не указан грейд',
	candidate_grade_not_established: 'грейд кандидата не установлен',
	vacancy_role_unknown: 'у вакансии не указана роль',
	candidate_role_not_established: 'роль кандидата не установлена — мало оснований',
	candidate_expectation_missing: 'кандидат не указал ожидания по зарплате',
	vacancy_salary_missing: 'у вакансии нет вилки',
	different_terms: 'разные валюта, период или налоговая база',
	no_required_skills: 'у вакансии нет обязательных навыков',
	no_nice_skills: 'у вакансии нет желательных навыков'
};

function unknownReason(reason: string): string {
	return UNKNOWN_REASONS[reason] ?? MODEL_REASONS[reason] ?? reason;
}

function verifyText(item: { code: string; skill_key?: string }, labels: Labels): string {
	const skill = item.skill_key === undefined ? '' : label(labels.skills, item.skill_key);
	switch (item.code) {
		case 'skill_claimed':
			return `${skill}: навык только заявлен — проверьте на собеседовании`;
		case 'skill_derived':
			return `${skill}: навык выведен из других фактов, прямого подтверждения нет`;
		case 'skill_weak_evidence':
			return `${skill}: основание слабое — уточните глубину`;
		case 'grade_not_established':
			return 'Грейд не установлен: оцените уровень на собеседовании';
		case 'role_not_established':
			return 'Роль кандидата не установлена: уточните, какой работой он занимался';
		case 'role_desired_only':
			return 'Роль вакансии кандидат указал желаемой, но основания её пока не подтверждают — уточните опыт';
		case 'salary_not_comparable':
			return 'Ожидания по зарплате в другой валюте, периоде или налоговой базе — уточните';
		case 'salary_expectation_missing':
			return 'Ожидания по зарплате не указаны — уточните';
		case 'profile_recalculating':
			return 'Профиль пересчитывается — объяснение может измениться';
		case 'profile_insufficient_data':
			return 'Недостаточно данных: у кандидата нет действующей категории — навыки не подтверждены и в счёт идут как неподтверждённые, проверьте их на собеседовании';
		default:
			return item.code;
	}
}

function gapText(item: { code: string; skill_key?: string; steps?: number }, labels: Labels): string {
	const skill = item.skill_key === undefined ? '' : label(labels.skills, item.skill_key);
	switch (item.code) {
		case 'required_skill_missing':
			return `Обязательный навык не подтверждён: ${skill}`;
		case 'nice_skill_missing':
			return `Желательный навык не подтверждён: ${skill}`;
		case 'grade_below':
			return `Грейд ниже требуемого на ${item.steps ?? '?'} ступ.`;
		case 'role_other':
			return 'Основания кандидата говорят о другой роли';
		default:
			return item.code;
	}
}

const percentOf = (value: number) => `${Math.round(value * 100)} %`;

/** What the role component rests on. */
function roleNote(details: RoleDetails, labels: Labels): string | undefined {
	const vacancy = details.vacancy === undefined ? '' : label(labels.roles, details.vacancy);
	switch (details.basis) {
		case 'primary':
			return `${vacancy} — основная роль кандидата`;
		case 'secondary':
			return `${vacancy} — дополнительная роль кандидата`;
		case 'desired':
			return `${vacancy} — желаемая роль кандидата, основаниями не подтверждена`;
		case 'none': {
			const own = details.candidate?.[0];
			return own === undefined ? undefined : `роль кандидата — ${label(labels.roles, own)}`;
		}
		default:
			return undefined;
	}
}

/** Who reads a note: the company (HR language) or the candidate («ты»). */
export type Reader = 'company' | 'candidate';

/** What the trust in the score rests on: confirmations of the required skills and the grade agreement. */
export function trustNote(details: TrustDetails, reader: Reader): string | undefined {
	if (!('direct' in details)) return undefined;
	const confirmed =
		(details.direct === 0
			? 'обязательные навыки не подтверждены ФСП или тестом'
			: `подтверждено ФСП или тестом: ${details.direct} из ${details.total}`) +
		(details.public_profile > 0 ? `; по публичному профилю: ${details.public_profile}` : '');
	if (details.grade_agreement_reason === 'candidate_grade_not_established') {
		return `${confirmed}; ${reader === 'company' ? 'грейд' : 'твой грейд'} не установлен — доверие снижено`;
	}
	if (typeof details.grade_agreement === 'number' && details.grade_agreement < 1) {
		const range = reader === 'company' ? 'диапазон грейда' : 'твой диапазон грейда';
		return `${confirmed}; ${range} совпадает с требуемым на ${percentOf(details.grade_agreement)}`;
	}
	return confirmed;
}

/** The match of the matching service as the product component shows it. */
export function matchView(match: CompanyMatchData, labels: Labels): MatchView {
	const keys = Object.keys(match.components) as MatchComponentKey[];
	const scoredWeight = keys
		.filter((key) => inScore(key, match.components[key]))
		.reduce((sum, key) => sum + match.components[key].weight, 0);
	return {
		score: match.score,
		components: keys.map((key) => {
			const component = match.components[key];
			if (component.status === 'computed' && component.value !== null) {
				const note =
					key === 'role'
						? roleNote(match.components.role.details, labels)
						: key === 'trust'
							? trustNote(match.components.trust.details, 'company')
							: undefined;
				return {
					key,
					status: 'computed',
					value: component.value,
					weight: scoredWeight > 0 ? component.weight / scoredWeight : 0,
					...(note === undefined ? {} : { note })
				};
			}
			return {
				key,
				status: component.status,
				...(inScore(key, component) && scoredWeight > 0 ? { weight: component.weight / scoredWeight } : {}),
				...(component.details.reason ? { reason: unknownReason(component.details.reason) } : {})
			};
		}),
		matches: match.explanation.matches.map((item) => {
			switch (item.kind) {
				case 'skill':
					return {
						requirement: `${label(labels.skills, item.skill_key)} · ${item.requirement === 'required' ? 'обязательный' : 'желательный'}`,
						evidence: BANDS[item.band],
						trust: trustOf(item.attestation, item.badge_trust)
					};
				case 'role':
					return { requirement: 'Роль', evidence: label(labels.roles, item.role_key), trust: 'derived' };
				case 'grade':
					return {
						requirement: 'Грейд',
						evidence: `${label(labels.grades, item.candidate.min)}–${label(labels.grades, item.candidate.max)} в диапазоне вакансии`,
						trust: 'derived'
					};
				case 'salary':
					return { requirement: 'Зарплата', evidence: SALARY_MATCH[item.comparison], trust: 'claimed' };
			}
		}),
		unknown: match.explanation.unknown.map(
			(item) => `${componentLabel(item.component)}: ${unknownReason(item.reason)}`
		),
		toVerify: match.explanation.to_verify.map((item) => verifyText(item, labels)),
		gaps: match.explanation.gaps.map((item) => gapText(item, labels))
	};
}

const COMPONENT_LABELS: Record<MatchComponentKey, string> = {
	required: 'Обязательные навыки',
	nice: 'Желательные навыки',
	role: 'Роль',
	trust: 'Доверие к оценке',
	grade: 'Грейд',
	salary: 'Зарплата',
	semantic: 'Смысловая близость',
	reranker: 'Уточняющая модель'
};

function componentLabel(key: MatchComponentKey): string {
	return COMPONENT_LABELS[key];
}

/** A category of the card (catalog projection) as the axes component shows it. */
export interface CardCategory {
	rank: 'primary' | 'secondary';
	role: { status: 'established'; key: string } | { status: 'insufficient_data' };
	grade: { status: 'established'; min: string; max: string } | { status: 'insufficient_data' };
	stack: { status: 'established'; skillKeys: string[] } | { status: 'insufficient_data' };
}

const DISCIPLINE_CODES: readonly string[] = ['algorithmic', 'product', 'uas', 'robotics', 'infosec'];
const FSP_LEVELS: readonly string[] = ['L1', 'L2', 'L3', 'L4', 'L5'];

export function categoryAxesView(
	category: CardCategory & { explanation: { grade: { confidence: number | null } } },
	grades: readonly { key: string; name: string }[],
	labels: Labels,
	fspLevels: readonly { discipline: string; level: string }[],
	desiredRole: string | null
): CategoryAxesView {
	const scale = grades.map((grade) => grade.name);
	const indexOf = (key: string) => grades.findIndex((grade) => grade.key === key);
	return {
		role:
			category.role.status === 'established'
				? { status: 'established', label: label(labels.roles, category.role.key) }
				: { status: 'insufficient_data', hint: 'Роль не установлена: мало подтверждённых навыков роли' },
		grade:
			category.grade.status === 'established' &&
			indexOf(category.grade.min) >= 0 &&
			category.explanation.grade.confidence !== null
				? {
						status: 'established',
						scale,
						min: indexOf(category.grade.min),
						max: indexOf(category.grade.max),
						confidence: category.explanation.grade.confidence
					}
				: {
						status: 'insufficient_data',
						hint: 'Грейд устанавливается только по коммерческому опыту и тестам уровня, не по соревнованиям'
					},
		stack:
			category.stack.status === 'established'
				? { status: 'established', skills: category.stack.skillKeys.map((key) => label(labels.skills, key)) }
				: { status: 'insufficient_data' },
		...(desiredRole ? { desiredRole } : {}),
		fspLevels: fspLevels
			.filter((item) => DISCIPLINE_CODES.includes(item.discipline) && FSP_LEVELS.includes(item.level))
			.map((item) => ({ discipline: item.discipline as DisciplineCode, level: item.level as FspLevel }))
	};
}

export interface NamedKey {
	key: string;
	name: string;
}

/** The taxonomy names a vacancy form offers. */
export interface VocabularyView {
	roles: NamedKey[];
	grades: NamedKey[];
	terms: Record<'work_format' | 'employment_form' | 'contract_type', NamedKey[]>;
}

export const CURRENCIES: NamedKey[] = [
	{ key: 'RUB', name: '₽ — рубли' },
	{ key: 'USD', name: '$ — доллары США' },
	{ key: 'EUR', name: '€ — евро' }
];

export const PERIODS: NamedKey[] = [
	{ key: 'month', name: 'в месяц' },
	{ key: 'year', name: 'в год' },
	{ key: 'hour', name: 'в час' },
	{ key: 'project', name: 'за проект' }
];

/** A hiring report as the process view of the service gives it. */
export interface HiringReportData {
	id: string;
	party: 'company' | 'candidate';
	kind: 'stage' | 'outcome';
	stage: string | null;
	outcome: string | null;
	supersedesReportId: string | null;
}

/** The stages and outcome reports in force (not corrected by a later report of the same side). */
export function hiringView(
	outcomeState: 'pending' | 'single_party' | 'confirmed' | 'diverged' | 'unknown',
	reports: readonly HiringReportData[]
): {
	stages: Partial<
		Record<'interview_scheduled' | 'interview_done' | 'offer_made' | 'offer_accepted', ('company' | 'candidate')[]>
	>;
	outcome: {
		state: typeof outcomeState;
		reports: {
			party: 'company' | 'candidate';
			outcome: 'hired' | 'not_hired' | 'candidate_withdrew' | 'company_stopped' | 'no_contact';
		}[];
	};
} {
	const superseded = new Set(
		reports.flatMap((report) => (report.supersedesReportId ? [report.supersedesReportId] : []))
	);
	const inForce = reports.filter((report) => !superseded.has(report.id));
	const stages: Partial<
		Record<'interview_scheduled' | 'interview_done' | 'offer_made' | 'offer_accepted', ('company' | 'candidate')[]>
	> = {};
	for (const report of inForce) {
		if (report.kind !== 'stage' || report.stage === null) continue;
		const key = report.stage as 'interview_scheduled' | 'interview_done' | 'offer_made' | 'offer_accepted';
		const parties = stages[key] ?? [];
		if (!parties.includes(report.party)) parties.push(report.party);
		stages[key] = parties;
	}
	return {
		stages,
		outcome: {
			state: outcomeState,
			reports: inForce.flatMap((report) =>
				report.kind === 'outcome' && report.outcome !== null
					? [
							{
								party: report.party,
								outcome: report.outcome as
									'hired' | 'not_hired' | 'candidate_withdrew' | 'company_stopped' | 'no_contact'
							}
						]
					: []
			)
		}
	};
}

export const DISCLOSURE_FIELD_LABELS: Record<string, string> = {
	full_name: 'ФИО',
	email: 'почта',
	phone: 'телефон',
	resume: 'резюме'
};

/** Names of fields that differ between versions of invitation terms (`invitation_terms.changes`). */
export const TERMS_FIELD_LABELS: Record<string, string> = {
	salary_min: 'Зарплата от',
	salary_max: 'Зарплата до',
	salary_currency: 'Валюта',
	salary_period: 'Период',
	salary_tax_base: 'Налоговая база',
	message: 'Сообщение',
	'vacancy.title': 'Название вакансии',
	'vacancy.role_key': 'Роль',
	'vacancy.grade_min': 'Грейд от',
	'vacancy.grade_max': 'Грейд до',
	'vacancy.work_format': 'Формат',
	'vacancy.employment_form': 'Занятость',
	'vacancy.contract_types': 'Договор',
	'vacancy.city_id': 'Город',
	'vacancy.timezone_overlap_hours': 'Пересечение по времени',
	'vacancy.required_skill_keys': 'Обязательные навыки',
	'vacancy.nice_skill_keys': 'Желательные навыки',
	'vacancy.min_age': 'Минимальный возраст',
	'vacancy.revision': 'Версия вакансии'
};

/** The label of a key in a vocabulary of the product components; a key the vocabulary lacks is shown as it is. */
export function labelOf(map: Readonly<Record<string, string>>, key: string | null | undefined): string {
	if (key === null || key === undefined) return 'не передано';
	return Object.hasOwn(map, key) ? (map[key] ?? key) : key;
}

/** The name of an FSP discipline code. */
export function disciplineName(code: string | null | undefined, form: 'name' | 'short' = 'short'): string {
	if (code === null || code === undefined) return 'Дисциплина не передана';
	const entries: Readonly<Record<string, { name: string; short: string }>> = DISCIPLINES;
	return Object.hasOwn(entries, code) ? (entries[code]?.[form] ?? code) : code;
}
