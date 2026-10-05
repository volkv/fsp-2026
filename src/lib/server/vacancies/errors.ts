// Refusals of vacancy actions. The client sees the public code of the API (contracts 5.3) with a detail code; the
// reason is internal and goes to the tests and the logs.
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import type { ApiErrorCode } from '$lib/server/errors/codes';

/** Detail codes of `policy_violation` for vacancies, with the message the client sees. */
export const VACANCY_VIOLATIONS = {
	salary_incomplete: 'Для публикации нужна полная вилка: обе границы, период и налоговая база',
	salary_not_rub: 'Вилка указывается только в рублях',
	text_warnings_unconfirmed: 'В тексте вакансии есть формулировки, требующие подтверждения',
	vacancy_not_editable: 'Эту вакансию сейчас нельзя изменить',
	external_vacancy_read_only: 'Внешняя вакансия изменяется только источником',
	claim_not_open: 'Заявка уже рассмотрена или отозвана',
	claim_exists: 'У компании уже есть открытая заявка на эту вакансию',
	claim_already_approved: 'Вакансию уже подтвердила другая компания',
	claim_inn_mismatch_reason_required: 'ИНН в публикации не совпадает с ИНН компании: одобрение требует причины',
	claim_company_not_verified: 'Компания заявителя ещё не проверена',
	minor_terms_not_accepted:
		'Вакансия для несовершеннолетних требует принятой владельцем компании оферты о соблюдении главы 42 ТК РФ'
} as const;

export type VacancyViolation = keyof typeof VACANCY_VIOLATIONS;

export class VacancyRefusal extends ApiError {
	override name = 'VacancyRefusal';
	readonly reason: string;

	constructor(code: ApiErrorCode, reason: string, options: { details?: ErrorDetail[] } = {}) {
		super(code, options);
		this.reason = reason;
	}
}

export const violation = (code: VacancyViolation, path?: string): VacancyRefusal =>
	new VacancyRefusal('policy_violation', code, {
		details: [{ ...(path === undefined ? {} : { path }), code, message: VACANCY_VIOLATIONS[code] }]
	});

export const refuse = (code: ApiErrorCode, reason: string): VacancyRefusal => new VacancyRefusal(code, reason);

export const invalid = (path: string, message: string): VacancyRefusal =>
	new VacancyRefusal('validation_failed', 'validation_failed', { details: [{ path, code: 'invalid', message }] });
