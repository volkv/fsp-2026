// Registry of public API error codes (docs/contracts.md, section 5.3). Imported by relative path from the schema,
// so the module has no SvelteKit aliases.

export const API_ERRORS = {
	validation_failed: { status: 400, message: 'Проверьте поля запроса' },
	unauthenticated: { status: 401, message: 'Требуется вход' },
	forbidden: { status: 403, message: 'Недостаточно прав для этого действия' },
	csrf_failed: { status: 403, message: 'Запрос отклонён проверкой источника: обновите страницу и повторите' },
	not_found: { status: 404, message: 'Не найдено' },
	conflict: { status: 409, message: 'Состояние изменилось: обновите данные и повторите' },
	idempotency_conflict: { status: 409, message: 'Ключ идемпотентности уже использован с другим запросом' },
	policy_violation: { status: 422, message: 'Действие нарушает правила платформы' },
	rate_limited: { status: 429, message: 'Слишком много запросов: повторите позже' },
	internal: { status: 500, message: 'Внутренняя ошибка: мы уже разбираемся' },
	degraded: { status: 503, message: 'Сервис временно недоступен: повторите позже' }
} as const satisfies Record<string, { status: number; message: string }>;

export type ApiErrorCode = keyof typeof API_ERRORS;

/** `details[].code` of `policy_violation` (contracts 5.3). */
export const POLICY_VIOLATION_CODES = {
	vacancy_not_invitable:
		'Эту вакансию нельзя указать в предложении: нужна своя опубликованная вакансия с полной вилкой в рублях',
	salary_not_rub: 'Вилка указывается только в рублях',
	salary_below_vacancy: 'Нижняя граница предложения ниже вилки вакансии',
	company_profile_incomplete: 'Заполните профиль компании: описание и направление деятельности',
	text_blocked: 'В тексте есть недопустимое требование к кандидату — исправьте его',
	reopen_cooldown: 'Повторное предложение этому кандидату пока недоступно',
	minor_age_mismatch: 'Вакансия не подходит кандидату по возрасту',
	scope_fields_minor: 'Кандидату младше 18 лет расширенный состав карточки недоступен',
	specialization_closed: 'Специализация закрыта: её тест ещё не выпущен или выключен'
} as const;

export type PolicyViolationCode = keyof typeof POLICY_VIOLATION_CODES;
