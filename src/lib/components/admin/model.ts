// Words of the administrator cabinet for the codes its pages show. A code without a word is shown as the code itself:
// the reference books and the journal grow faster than this list, and a raw code is honest.
import type { DocumentKind } from '$lib/server/consent/kinds';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const MODEL_OPERATIONS: Record<string, { title: string; purpose: string; fallback: string }> = {
	extract: {
		title: 'Извлечение (LLM)',
		purpose: 'Разбор резюме и текста вакансии в поля с цитатами.',
		fallback: 'Без модели разбор идёт правилами: поля помечены «проверьте», цитаты проверяются так же.'
	},
	embed: {
		title: 'Эмбеддинги',
		purpose: 'Векторы для семантического поиска и компонента «семантика» соответствия.',
		fallback: 'Без модели поиск идёт по словам (FTS), семантический компонент отмечен как недоступный.'
	},
	rerank: {
		title: 'Переранжирование',
		purpose: 'Уточнение порядка кандидатов под вакансию.',
		fallback: 'Без модели порядок — по основным компонентам соответствия.'
	}
};

export const EFFECTIVE_MODES: Record<string, { label: string; tone: Tone }> = {
	model: { label: 'Работает с моделью', tone: 'success' },
	switched_off: { label: 'Выключена администратором', tone: 'warning' },
	not_configured: { label: 'Не настроена — путь без модели', tone: 'neutral' },
	no_api_key: { label: 'Нет ключа API (LLM_API_KEY) — путь без модели', tone: 'neutral' },
	mode_unknown: { label: 'Режим не прочитан — вызовы отвечают «недоступно»', tone: 'danger' }
};

export const PROCESSING_MODES: Record<string, string> = {
	model: 'с моделью',
	rules_only: 'правилами без модели',
	partial: 'частично',
	failed: 'ошибка'
};

export const MODEL_ERROR_CODES: Record<string, string> = {
	disabled: 'выключена или не настроена',
	unavailable: 'рантайм недоступен',
	timeout: 'истёк срок',
	rate_limited: 'превышена частота',
	invalid_output: 'ответ не прошёл проверку',
	context_too_long: 'вход длиннее контекста',
	space_mismatch: 'пространство векторов не совпало',
	request_rejected: 'рантайм отклонил запрос',
	cancelled: 'отменено'
};

export const MODEL_ERROR_REASONS: Record<string, string> = {
	switched_off: 'выключена администратором',
	not_configured: 'не настроена',
	no_api_key: 'нет ключа API'
};

export const INPUT_TYPES: Record<string, string> = {
	document_extraction: 'резюме',
	vacancy: 'вакансия',
	candidate: 'профиль кандидата'
};

export const PROBES: Record<'up' | 'down', { label: string; tone: Tone }> = {
	up: { label: 'Отвечает', tone: 'success' },
	down: { label: 'Не отвечает', tone: 'danger' }
};

// --- Quality panel ---

export const METRIC_GROUPS: Record<string, string> = {
	resume: 'Разбор резюме',
	skills: 'Нормализация навыков',
	categorization: 'Категоризация',
	shortlist: 'Подборка по потребности — методика v3',
	matching: 'Соответствие вакансия ↔ кандидат — методика v2, выведена (архивные прогоны)',
	performance: 'Скорость'
};

/**
 * Words for the keys the evaluation harness writes (tools/eval): every key of its reports has one, checked by
 * src/eval/panel-labels.test.ts against the committed reports. The order is the order on the page.
 */
export const METRICS: Record<string, string> = {
	'resume.parse_success_rate': 'Документы разобраны',
	'resume.skills_f1': 'Навыки: F1',
	'resume.skills_precision': 'Навыки: точность',
	'resume.skills_recall': 'Навыки: полнота',
	'resume.skills_recall.unfamiliar': 'Навыки: полнота на написаниях, которых нет в таксономии',
	'resume.fields_f1': 'Поля опыта и резюме: F1',
	'resume.fields_f1.period': 'Периоды работ: F1',
	'resume.fields_f1.role': 'Роль по должности: F1',
	'resume.fields_f1.organization': 'Организации: F1',
	'resume.fields_f1.language': 'Языки с уровнем: F1',
	'resume.fields_f1.education': 'Учебные заведения: F1',
	'resume.fields_f1.marker': 'Маркеры ответственности: F1',
	'resume.quote_validity': 'Цитаты подтверждают утверждения',
	'resume.quote_validity.offsets': 'Цитаты стоят на своих смещениях',
	'resume.quote_refusal_rate': 'Доля элементов, отклонённых из-за цитаты',
	'skills.normalization_accuracy': 'Нормализация: точность',
	'skills.normalization_accuracy.variant': 'Нормализация: написания навыков',
	'skills.normalization_accuracy.unfamiliar': 'Нормализация: написания, которых нет в таксономии',
	'skills.normalization_accuracy.typo': 'Нормализация: опечатки',
	'skills.normalization_accuracy.unknown': 'Нормализация: инструменты вне таксономии («не навык»)',
	'skills.lexicon_overlap': 'Доля написаний выборки, известных таксономии',
	'categorization.role_accuracy': 'Роль определена верно',
	'categorization.grade_in_range': 'Грейд внутри выданного диапазона',
	'categorization.grade_range_width': 'Ширина диапазона грейда, грейдов',
	'categorization.sufficiency_accuracy.role': 'Достаточность оснований для роли',
	'categorization.sufficiency_accuracy.grade': 'Достаточность оснований для грейда',
	'categorization.refusal_rate': 'Доля отказов «недостаточно данных»',
	'categorization.false_refusal_rate': 'Доля ложных отказов',
	'categorization.role_established.without_fsp': 'Люди с записью ФСП: роль установлена — без ФСП',
	'categorization.role_established.with_fsp': 'Люди с записью ФСП: роль установлена — с ФСП',
	'categorization.role_found.without_fsp': 'Люди с записью ФСП: находимость по своей роли — без ФСП',
	'categorization.role_found.with_fsp': 'Люди с записью ФСП: находимость по своей роли — с ФСП',
	'categorization.role_accuracy.without_fsp': 'Люди с записью ФСП: роль верна, где основания есть — без ФСП',
	'categorization.role_accuracy.with_fsp': 'Люди с записью ФСП: роль верна, где основания есть — с ФСП',
	'categorization.role_wrong_rate.without_fsp': 'Люди с записью ФСП: чужая роль — без ФСП',
	'categorization.role_wrong_rate.with_fsp': 'Люди с записью ФСП: чужая роль — с ФСП',
	'categorization.refusal_rate.without_fsp': 'Люди с записью ФСП: отказы по роли — без ФСП',
	'categorization.refusal_rate.with_fsp': 'Люди с записью ФСП: отказы по роли — с ФСП',
	'categorization.grade_established.without_fsp': 'Люди с записью ФСП: грейд установлен — без ФСП',
	'categorization.grade_established.with_fsp': 'Люди с записью ФСП: грейд установлен — с ФСП',
	'categorization.grade_in_range.without_fsp': 'Люди с записью ФСП: грейд в диапазоне — без ФСП',
	'categorization.grade_in_range.with_fsp': 'Люди с записью ФСП: грейд в диапазоне — с ФСП',
	'categorization.fsp_level_accuracy': 'Уровень ФСП по дисциплине верен',
	'categorization.fsp_level_coverage': 'Покрытие уровнем ФСП: у человека с записью есть уровень',
	'shortlist.ndcg_at_10': 'nDCG@10 подборки (базовый — поиск по тому же тексту)',
	'shortlist.ndcg_at_10.keywords_same_text': 'nDCG@10 — поиск по тому же тексту потребности',
	'shortlist.ndcg_at_10.keywords_same_requirements': 'nDCG@10 — поиск по тем же требованиям',
	'shortlist.ndcg_at_10.keywords_manual_query': 'nDCG@10 — ручной запрос по требованиям потребности',
	'shortlist.ndcg_at_10.lift_over_keywords_same_text':
		'nDCG@10 — выигрыш у поиска по тому же тексту, нижняя граница 95 % интервала',
	'shortlist.ndcg_at_10.random': 'nDCG@10 — случайный порядок',
	'shortlist.ndcg_at_10.without_fsp': 'nDCG@10 — подборка без данных ФСП',
	'shortlist.ndcg_at_10.without_semantic': 'nDCG@10 — подборка без смысловой близости',
	'shortlist.ndcg_at_10.ceiling_admitted': 'nDCG@10 — лучший порядок допущенных категориями подборки',
	'shortlist.precision_at_10': 'Precision@10 подборки, из десяти позиций',
	'shortlist.precision_at_10.keywords_same_text': 'Precision@10 — поиск по тому же тексту',
	'shortlist.precision_at_10.keywords_same_requirements': 'Precision@10 — поиск по тем же требованиям',
	'shortlist.precision_at_10.keywords_manual_query': 'Precision@10 — ручной запрос',
	'shortlist.precision_at_10.ceiling': 'Precision@10 — потолок пула',
	'shortlist.recall_at_10': 'Recall@10 подходящих — подборка',
	'shortlist.recall_at_10.keywords_same_text': 'Recall@10 — поиск по тому же тексту',
	'shortlist.recall_at_10.keywords_same_requirements': 'Recall@10 — поиск по тем же требованиям',
	'shortlist.recall_at_10.keywords_manual_query': 'Recall@10 — ручной запрос',
	'shortlist.recall_at_10.ceiling': 'Recall@10 — потолок пула',
	'shortlist.recall_at_10.admitted': 'Доля подходящих внутри категорий подборки',
	'shortlist.mrr': 'MRR первого подходящего — подборка',
	'shortlist.mrr.keywords_same_text': 'MRR — поиск по тому же тексту',
	'shortlist.mrr.keywords_same_requirements': 'MRR — поиск по тем же требованиям',
	'shortlist.mrr.keywords_manual_query': 'MRR — ручной запрос',
	'shortlist.needs_without_suitable': 'Доля потребностей без подходящих в пуле («честно пусто»)',
	'shortlist.inflated_share_top10': 'Доля завышенных резюме в первой десятке (базовый — поиск по тексту)',
	'shortlist.without_fsp_share_top10': 'Доля кандидатов без ФСП в первой десятке (базовый — во всей подборке)',
	'shortlist.unconfirmed_share_top10':
		'Доля группы «грейд не подтверждён» в первой десятке показанного (базовый — во всём показанном)',
	'shortlist.precision_at_10.with_unconfirmed_tail': 'Precision@10 показанного вместе с группой «грейд не подтверждён»',
	'shortlist.sorting.ndcg_at_10': 'Сортировка одного набора: nDCG@10 подборки',
	'shortlist.sorting.ndcg_at_10.keywords_same_requirements':
		'Сортировка одного набора: nDCG@10 поиска по тем же требованиям',
	'shortlist.sorting.ndcg_at_10.lift_over_keywords_same_requirements':
		'Сортировка одного набора: выигрыш nDCG@10, нижняя граница 95 % интервала',
	'shortlist.sorting.precision_at_10': 'Сортировка одного набора: Precision@10 подборки',
	'shortlist.sorting.precision_at_10.keywords_same_requirements':
		'Сортировка одного набора: Precision@10 поиска по тем же требованиям',
	'shortlist.sorting.mrr': 'Сортировка одного набора: MRR подборки',
	'shortlist.sorting.mrr.keywords_same_requirements': 'Сортировка одного набора: MRR поиска по тем же требованиям',
	'shortlist.tz.uncategorized_positions': 'ТЗ: позиции выдачи у кандидатов без подтверждённой категории',
	'shortlist.tz.category_mismatch': 'ТЗ: кандидаты, чья категория не та, что дали их тесты',
	'shortlist.tz.outside_need_categories': 'ТЗ: доля позиций первой десятки вне категорий потребности',
	'shortlist.tz.confirmation_consistency': 'ТЗ: подтверждённые навыки, которые у кандидата на деле есть',
	'shortlist.false_confirmed.ndcg_at_10': 'Сценарий ложных подтверждений: nDCG@10 подборки',
	'shortlist.false_confirmed.share_top10': 'Сценарий ложных подтверждений: их доля в первой десятке',
	'matching.ndcg_at_10': 'nDCG@10 — продукт целиком',
	'matching.ndcg_at_10.lift_over_keywords':
		'nDCG@10 — выигрыш у поиска по ключевым словам, нижняя граница 95 % интервала',
	'matching.ndcg_at_10.keywords': 'nDCG@10 — поиск по ключевым словам (базовый)',
	'matching.ndcg_at_10.random': 'nDCG@10 — случайный порядок (базовый)',
	'matching.ndcg_at_10.resume_only': 'nDCG@10 — продукт только по резюме',
	'matching.ndcg_at_10.without_fsp': 'nDCG@10 — без данных ФСП',
	'matching.ndcg_at_10.without_tests': 'nDCG@10 — без тестов платформы',
	'matching.ndcg_at_10.without_reranker': 'nDCG@10 — без реранкера',
	'matching.ndcg_at_10.without_semantic': 'nDCG@10 — без семантической близости',
	'performance.extract_ms.p50': 'Извлечение из резюме, медиана, мс',
	'performance.extract_ms.p95': 'Извлечение из резюме, 95-й перцентиль, мс'
};

export const METRIC_STATUSES: Record<string, { label: string; tone: Tone }> = {
	pass: { label: 'порог пройден', tone: 'success' },
	fail: { label: 'порог не пройден', tone: 'danger' },
	missing: { label: 'порог задан, не посчитано', tone: 'danger' },
	no_threshold: { label: 'порог не задан', tone: 'neutral' },
	no_value: { label: 'не посчитано', tone: 'warning' }
};

export const PROVENANCES: Record<string, string> = {
	synthetic: 'синтетика',
	manual_labeled: 'ручная разметка',
	customer: 'данные заказчика'
};

/**
 * Part of the dataset an evaluation run measured. The harness writes the split as `<part>-by-<how it was cut>`
 * (tools/eval, run.py): `dev` is the part the product is tuned on, `holdout` the part kept away from tuning.
 */
export const EVAL_SPLITS: Record<string, { label: string; about: string }> = {
	dev: {
		label: 'рабочая часть (dev)',
		about: 'рабочей части выборки (dev), на которой продукт настраивали: это не независимая проверка'
	},
	holdout: {
		label: 'отложенная часть (holdout)',
		about: 'отложенной части выборки (holdout), которую при настройке продукта не использовали'
	}
};

export function evalSplit(split: string): { label: string; about: string } {
	const part = split.split('-by-', 1)[0] ?? split;
	return EVAL_SPLITS[part] ?? { label: split, about: `разбиении «${split}»` };
}

// --- Reference books ---

export const TAXONOMY_STATUSES: Record<string, { label: string; tone: Tone }> = {
	draft: { label: 'черновик', tone: 'neutral' },
	published: { label: 'опубликована', tone: 'success' },
	retired: { label: 'выведена', tone: 'warning' }
};

export const SKILL_KINDS: Record<string, string> = {
	language: 'язык',
	framework: 'фреймворк',
	library: 'библиотека',
	runtime: 'среда выполнения',
	platform: 'платформа',
	database: 'база данных',
	tool: 'инструмент',
	practice: 'практика',
	domain: 'предметная область'
};

/** A label for every kind of legal document: a kind without one fails the type check. */
export const DOCUMENT_KINDS: Record<DocumentKind, string> = {
	user_agreement: 'Пользовательское соглашение',
	pd_processing: 'Согласие на обработку ПДн',
	catalog_visibility: 'Показ карточки в каталоге',
	partner_pool: 'Пул финалистов для партнёров',
	telegram_notifications: 'Уведомления в Telegram',
	fsp_import: 'Получение достижений ФСП',
	contact_disclosure: 'Передача контактов компании',
	public_distribution: 'Публичная страница профиля',
	automated_decision_written: 'Автоматизированные решения (письменно)',
	demo_resume_upload: 'Своё резюме в демо-сессии',
	employer_terms: 'Условия для работодателя',
	minor_employment_terms: 'Оферта о труде несовершеннолетних'
};

export const DOCUMENT_FORMS: Record<string, string> = {
	electronic_separate_screen: 'электронно, отдельный экран',
	electronic_signature: 'электронная подпись (письменная форма)'
};

export const POLICY_KINDS: Record<string, string> = {
	invitation_policy: 'Приглашения',
	hiring_policy: 'Процесс найма',
	notification_policy: 'Уведомления',
	minor_policy: 'Несовершеннолетние',
	catalog_policy: 'Каталог',
	matching_policy: 'Хранение соответствий',
	market_policy: 'Рынок категории',
	assessment_policy: 'Тесты платформы',
	retention_policy: 'Сроки хранения',
	challenge_policy: 'Вызовы компаний'
};

// --- People ---

export const STAFF_ROLES: Record<string, string> = {
	operator: 'Оператор ФСП',
	admin: 'Администратор'
};

export const USER_STATUSES: Record<string, { label: string; tone: Tone }> = {
	pending_email: { label: 'почта не подтверждена', tone: 'warning' },
	active: { label: 'активен', tone: 'success' },
	suspended: { label: 'заблокирован', tone: 'danger' },
	deletion_pending: { label: 'ожидает удаления', tone: 'warning' },
	deleted: { label: 'удалён', tone: 'neutral' }
};

export const MEMBER_ROLES: Record<string, string> = {
	owner: 'владелец',
	recruiter: 'рекрутер'
};

export const OUTCOMES: Record<string, { label: string; tone: Tone }> = {
	success: { label: 'успех', tone: 'success' },
	denied: { label: 'отказ', tone: 'warning' },
	failure: { label: 'ошибка', tone: 'danger' }
};

export const ACTOR_KINDS: Record<string, string> = {
	user: 'пользователь',
	api_key: 'ключ API',
	system: 'система',
	anonymous: 'аноним'
};

/** A number of the quality panel: shares as they are, three digits after the point. */
export function formatMetric(value: number | null): string {
	return value === null ? '—' : value.toLocaleString('ru-RU', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

export function formatDelta(value: number | null): string {
	if (value === null) return '—';
	const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
	return `${sign}${formatMetric(Math.abs(value))}`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} Б`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ`;
	return `${(bytes / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
}
