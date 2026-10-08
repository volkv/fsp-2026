// Wording of the grade policy for the candidate (docs/domain.md, section 12.3): why a test is closed and when it opens,
// what kind of test an open one is. One source for the cabinet, the registration path and the error messages of the API;
// the numbers come from the policy data, never restated here.
import { CATALOG } from '$lib/server/assessments/contract/catalog';
import { GRADE_POLICY, type BlockReason } from '$lib/server/assessments/contract/policy';
import { formatDate, pluralize } from '$lib/components/product/model';
import type { GradeOffer, OfferKind } from './policy';

const days = (count: number) => `${count} ${pluralize(count, ['день', 'дня', 'дней'])}`;
const { gradeChangeIntervalDays, retakeIntervalDays, maxAttemptsPerGrade, formWindowDays } = GRADE_POLICY;

const REASONS: Record<BlockReason, string> = {
	attempt_in_progress: 'Идёт другая попытка теста — сначала завершите её',
	not_declared: 'Сначала заявите грейд',
	above_declared: 'Выше заявленного грейда: сначала заявите этот грейд',
	lower_requires_failure: 'Тест ниже открывается после неудачи на грейде выше',
	below_confirmed: 'Ниже подтверждённого грейда: подтверждённый грейд не понижается',
	already_confirmed: 'Этот грейд уже подтверждён',
	above_next_grade: 'Доступен только тест следующего грейда после подтверждённого',
	grade_change_interval: `Подтверждённый грейд меняется не чаще раза в ${days(gradeChangeIntervalDays)} от подтверждения`,
	retake_interval: `Повтор того же грейда — через ${days(retakeIntervalDays)} от конца неудачной попытки, на другой форме`,
	attempt_limit: `Не больше ${maxAttemptsPerGrade} ${pluralize(maxAttemptsPerGrade, ['засчитанной попытки', 'засчитанных попыток', 'засчитанных попыток'])} на грейд за ${days(formWindowDays)} от их начала`
};

const KINDS: Record<OfferKind, string> = {
	declared: 'Тест заявленного грейда',
	lower_after_failure: 'Тест грейда ниже — открыт после неудачи на грейде выше',
	upgrade_confident: 'Тест следующего грейда — открыт уверенным результатом',
	upgrade_interval: `Тест следующего грейда — прошло ${days(gradeChangeIntervalDays)} с подтверждения`,
	upgrade_retake: `Повтор теста следующего грейда — через ${days(retakeIntervalDays)} после неудачи, без ожидания ${days(gradeChangeIntervalDays)}`,
	demo_session: `Открыт демо-режимом: интервалы политики сняты, в эксплуатации — повтор через ${days(retakeIntervalDays)} после неудачи, смена подтверждённого грейда раз в ${days(gradeChangeIntervalDays)}`
};

/** The note of the screens of tests in a demo session with the intervals lifted: what is lifted and what is kept. */
export const DEMO_INTERVALS_LIFTED_NOTE =
	`Демо-режим: сняты только интервалы политики — повтор после неудачи (в эксплуатации через ${days(retakeIntervalDays)}, ` +
	`на другой форме) и смена подтверждённого грейда (в эксплуатации раз в ${days(gradeChangeIntervalDays)}) доступны сразу. ` +
	'Порядок грейдов, заявленный грейд и решение о грейде — как в эксплуатации; лимит тоже: не больше ' +
	`${maxAttemptsPerGrade} попыток на грейд за ${days(formWindowDays)}. Интервалы включаются на странице демо-сессии: ` +
	'«Политика как в эксплуатации».';

/** The note of the screens of tests in a demo session that turned the production policy on. */
export const DEMO_PRODUCTION_POLICY_NOTE =
	'Демо-сессия с политикой как в эксплуатации: интервалы включены — повтор после неудачи через ' +
	`${days(retakeIntervalDays)}, смена подтверждённого грейда раз в ${days(gradeChangeIntervalDays)} от подтверждения ` +
	'(кроме одного шага после уверенного результата). Снять интервалы — на странице демо-сессии.';

const gradeTitle = (key: string) => CATALOG.grades.find((g) => g.key === key)?.title ?? key;

/** Why a test is closed, with the day it opens when it opens by itself. */
export function blockReasonText(reason: BlockReason, availableFrom: Date | string | null | undefined): string {
	const text = REASONS[reason];
	return availableFrom ? `${text}. Откроется ${formatDate(availableFrom)}` : text;
}

/**
 * What an open test is. A test below a failed grade says in advance when the failed grade can be retaken: that date
 * does not depend on the result of the test below, so taking it never postpones the retake.
 */
export function openOptionText(option: Extract<GradeOffer, { available: true }>): string {
	const text = KINDS[option.kind];
	if (!option.failedRetake) return text;
	const { grade, availableFrom } = option.failedRetake;
	return `${text}. Повтор ${gradeTitle(grade)} откроется ${formatDate(availableFrom)} при любом результате этого теста`;
}

/** What an option says: why it is open, or why it is closed and when it opens. */
export function optionText(option: GradeOffer): string {
	return option.available ? openOptionText(option) : blockReasonText(option.reason, option.availableFrom);
}
