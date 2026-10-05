// The FSP operator's funnel of career outcomes (contracts 5.5; domain 13.9): counted from live data stage by stage,
// with who confirmed each count; small groups are pooled and small cells are «< N». The moderation of own vacancies
// a blocked text check sent to the operator (domain 13.1): the queue and the decision. Conflicts of the birth date
// (domain 7.2): the queue and the decision by a document. Attempts of the test on a grade (domain 10.7): the list for
// review and the annulment.
import { z } from 'zod';
import { ANNUL_REASONS, OPERATOR_ANNUL_REASONS, annulAttempt } from '$lib/server/assessments/annul';
import { attemptsForReview } from '$lib/server/assessments/review';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { careerFunnel, FUNNEL_DIMENSIONS } from '$lib/server/hiring/funnel';
import { AGE_CHECK_METHODS, AGE_DOCUMENT_KINDS, ageConflictQueue, resolveAgeConflict } from '$lib/server/operator/ages';
import { decideModeration, vacancyModerationQueue } from '$lib/server/operator/vacancies';
import { MODERATION_REASON_MAX } from '$lib/server/vacancies/own';
import { defineOperation } from '../operation';
import { invitationDeps } from '../services';

const cell = z
	.union([z.object({ value: z.int() }), z.object({ below: z.int().describe('Меньше этого числа — малая ячейка') })])
	.meta({ id: 'FunnelCell', description: 'Число или «меньше N» для малой ячейки' });
const sourced = z.object({
	total: cell,
	by_source: z.object({ company: cell, candidate: cell, both: cell }).describe('Кто сообщил: компания, кандидат, обе')
});

const group = z
	.object({
		key: z.string().describe('Значение разреза; `none` — без значения; `__small__` — объединённые малые группы'),
		pooled: z.int().describe('Сколько групп объединено в строку; 0 — группа сама по себе'),
		synthetic: z.boolean(),
		invited: cell,
		contact: cell,
		interview: sourced,
		offer: sourced,
		hired: z.object({
			confirmed: cell,
			single_party: z.object({ company: cell, candidate: cell }),
			diverged: cell
		}),
		not_hired: cell,
		unknown: cell
	})
	.meta({ id: 'FunnelGroup' });

type Group = Awaited<ReturnType<typeof careerFunnel>>['total'];
const groupOut = (item: Group) => ({
	key: item.key,
	pooled: item.pooled,
	synthetic: item.synthetic,
	invited: item.invited,
	contact: item.contact,
	interview: { total: item.interview.total, by_source: item.interview.bySource },
	offer: { total: item.offer.total, by_source: item.offer.bySource },
	hired: {
		confirmed: item.hired.confirmed,
		single_party: item.hired.singleParty,
		diverged: item.hired.diverged
	},
	not_hired: item.notHired,
	unknown: item.unknown
});

const dimension = z.enum(FUNNEL_DIMENSIONS);
const filterValue = z.string().min(1).max(200);

export const getFunnel = defineOperation({
	id: 'getCareerFunnel',
	method: 'GET',
	path: '/operator/funnel',
	tag: 'ФСП',
	summary: 'Воронка карьерных исходов',
	description:
		'Приглашённые, контакт, собеседование, оффер, найм (подтверждённый обеими сторонами, одной стороной, с ' +
		'расхождением), отказ и неизвестный исход — раздельно, по периоду отправки приглашений, до двух разрезов ' +
		'(строки и строки внутри строк) и фильтрам. Группы меньше порога объединяются в строку `__small__`, пока она ' +
		'сама не наберёт порог; группа меньше порога показывает все числа как «меньше N». Кандидат с несколькими ' +
		'дисциплинами, уровнями или соревнованиями учитывается в каждой своей группе: суммы строк не равны итогу. ' +
		'Группы с демо-данными отмечены `synthetic`.',
	auth: 'session',
	permission: 'fsp_analytics.read',
	query: z
		.strictObject({
			from: z.iso.date().optional().describe('Приглашения, отправленные с этой даты (UTC)'),
			to: z.iso.date().optional().describe('…и до этой даты, не включая'),
			dimension: dimension.optional().describe('Разрез строк; без него — только итог'),
			subdimension: dimension.optional().describe('Разрез внутри каждой строки; только вместе с `dimension`'),
			specialization: filterValue
				.optional()
				.describe('Специализация последней действующей категории; `none` — категория не подтверждена'),
			grade: filterValue.optional().describe('Грейд последней действующей категории; `none` — категории нет'),
			fsp_discipline: filterValue.optional().describe('Дисциплина ФСП; `none` — без уровня ФСП'),
			fsp_level: filterValue
				.optional()
				.describe('Уровень ФСП `L1`–`L5` (в той же дисциплине, что и фильтр дисциплины)'),
			competition: filterValue.optional().describe('Идентификатор соревнования в источнике ФСП'),
			region: filterValue.optional().describe('Код региона из предпочтений; `none` — не указан'),
			fsp_participant: z.enum(['fsp', 'not_fsp']).optional().describe('Участник ФСП или нет')
		})
		.refine((query) => query.subdimension === undefined || query.dimension !== undefined, {
			path: ['subdimension'],
			message: 'Разрез внутри строк задаётся вместе с разрезом строк'
		})
		.refine((query) => query.subdimension === undefined || query.subdimension !== query.dimension, {
			path: ['subdimension'],
			message: 'Разрезы должны различаться'
		}),
	errors: [],
	response: {
		status: 200,
		description: 'Воронка',
		schema: z.object({
			dimensions: z.array(dimension),
			threshold: z.int().describe('Порог малой группы и малой ячейки'),
			total: group,
			groups: z.array(group.extend({ children: z.array(group) })),
			competitions: z
				.record(z.string(), z.object({ title: z.string(), start_date: z.string().nullable() }))
				.describe('Названия соревнований среди показанных ключей')
		})
	},
	async handle(ctx) {
		const { from, to, dimension: primary, subdimension, ...where } = ctx.query;
		const dimensions =
			primary === undefined
				? ([] as const)
				: subdimension === undefined
					? ([primary] as const)
					: ([primary, subdimension] as const);
		const funnel = await careerFunnel(invitationDeps(ctx.services), await ctx.subject(), {
			dimensions,
			where,
			...(from === undefined ? {} : { from: new Date(`${from}T00:00:00Z`) }),
			...(to === undefined ? {} : { to: new Date(`${to}T00:00:00Z`) })
		});
		return {
			dimensions: funnel.dimensions,
			threshold: funnel.threshold,
			total: groupOut(funnel.total),
			groups: funnel.groups.map((item) => ({ ...groupOut(item), children: item.children.map(groupOut) })),
			competitions: Object.fromEntries(
				Object.entries(funnel.competitions).map(([id, competition]) => [
					id,
					{ title: competition.title, start_date: competition.startDate }
				])
			)
		};
	}
});

const quote = z
	.object({ before: z.string(), text: z.string(), after: z.string() })
	.describe('Фрагмент в окружении: до, найденная фраза, после');

const moderationItem = z
	.object({
		vacancy_id: z.uuid(),
		title: z.string(),
		company: z.object({
			id: z.uuid(),
			display_name: z.string(),
			inn: z.string(),
			status: z.enum(['draft', 'submitted', 'verified', 'rejected', 'suspended'])
		}),
		revision: z.int().describe('Версия вакансии, к которой относятся фрагменты; её называет решение'),
		opened_at: z.iso.datetime().describe('Когда вакансия ушла на модерацию'),
		resume_to: z
			.enum(['published', 'paused'])
			.describe('Куда вакансия вернётся после публикации оператором или исправления текста'),
		findings: z.array(
			z.object({
				rule: z.string(),
				category: z.enum(['sex', 'age', 'citizenship', 'marital_status', 'nationality', 'appearance']),
				field: z.string().describe('`title` или `description`'),
				explanation: z.string(),
				quote
			})
		)
	})
	.meta({ id: 'VacancyModerationItem' });

export const listVacancyModeration = defineOperation({
	id: 'listVacancyModeration',
	method: 'GET',
	path: '/operator/moderation/vacancies',
	tag: 'ФСП',
	summary: 'Вакансии на модерации',
	description:
		'Собственные вакансии компаний, чей текст проверка отправила оператору (`pending_moderation`), — старые ' +
		'дела первыми, с блокирующими фрагментами в окружении и правилом.',
	auth: 'session',
	permission: 'vacancy.moderate',
	errors: [],
	response: { status: 200, description: 'Очередь модерации', schema: z.object({ items: z.array(moderationItem) }) },
	async handle(ctx) {
		const items = await vacancyModerationQueue(ctx.services.db, await ctx.subject());
		return {
			items: items.map((item) => ({
				vacancy_id: item.vacancyId,
				title: item.title,
				company: {
					id: item.company.id,
					display_name: item.company.displayName,
					inn: item.company.inn,
					status: item.company.status
				},
				revision: item.revision,
				opened_at: item.openedAt.toISOString(),
				resume_to: item.resumeTo,
				findings: item.findings.map((finding) => ({
					rule: finding.rule,
					category: finding.category,
					field: finding.field,
					explanation: finding.explanation,
					quote: finding.quote
				}))
			}))
		};
	}
});

export const decideVacancyModeration = defineOperation({
	id: 'decideVacancyModeration',
	method: 'POST',
	path: '/operator/moderation/vacancies/{vacancy_id}/decision',
	tag: 'ФСП',
	summary: 'Решение по вакансии на модерации',
	description:
		'`publish` — требование законно (например, гражданство для допуска к гостайне): вакансия возвращается в ' +
		'каталог или в паузу, из которой ушла; `return` — черновик на правку; `reject` — вакансия закрывается. ' +
		'Причина обязательна для `return` и `reject` — компания видит её на странице вакансии. `revision` — версия ' +
		'вакансии, которую оператор прочитал (из очереди): компания могла изменить текст, пока вакансия на модерации, ' +
		'и решение по другой версии — `409` (`vacancy_changed`), ничего не меняется. Вакансия уже не на модерации — ' +
		'`409` (`vacancy_not_in_moderation`).',
	auth: 'session',
	permission: 'vacancy.moderate',
	params: z.strictObject({ vacancy_id: z.uuid() }),
	body: z.strictObject({
		decision: z.enum(['publish', 'return', 'reject']),
		revision: z.int().min(1).describe('Версия вакансии, по которой принято решение'),
		reason: z.string().max(MODERATION_REASON_MAX).optional().describe('Причина для компании')
	}),
	errors: ['not_found', 'conflict', 'policy_violation'],
	response: { status: 204, description: 'Решение принято' },
	async handle(ctx) {
		await decideModeration(
			ctx.services.db,
			await ctx.subject(),
			ctx.meta,
			ctx.params.vacancy_id,
			ctx.body.decision,
			ctx.body.reason ?? '',
			ctx.body.revision
		);
	}
});

export const listAgeConflicts = defineOperation({
	id: 'listAgeConflicts',
	method: 'GET',
	path: '/operator/ages',
	tag: 'ФСП',
	summary: 'Конфликты даты рождения',
	description:
		'Профили, закрытые расхождением даты рождения: год из ФСП не согласуется с датой, которую указал кандидат ' +
		'(`birth_date_status = conflict`). Старые дела первыми; в списке нет ни дат, ни имён — они открываются в деле ' +
		'кабинета с записью в журнал.',
	auth: 'session',
	permission: 'age.review',
	errors: [],
	response: {
		status: 200,
		description: 'Очередь конфликтов',
		schema: z.object({
			items: z.array(
				z
					.object({
						candidate_id: z.uuid(),
						opened_at: z.iso.datetime().nullable().describe('Когда источник сообщил расходящийся год'),
						declared_precision: z.enum(['day', 'year']).nullable().describe('Точность указанной даты')
					})
					.meta({ id: 'AgeConflictItem' })
			)
		})
	},
	async handle(ctx) {
		const items = await ageConflictQueue(ctx.services.db, await ctx.subject());
		return {
			items: items.map((item) => ({
				candidate_id: item.candidateId,
				opened_at: item.openedAt?.toISOString() ?? null,
				declared_precision: item.declaredPrecision
			}))
		};
	}
});

export const decideAgeConflict = defineOperation({
	id: 'decideAgeConflict',
	method: 'POST',
	path: '/operator/ages/{candidate_id}/decision',
	tag: 'ФСП',
	summary: 'Решение по дате рождения',
	description:
		'Оператор сверил документ с человеком и записывает дату из документа, способ проверки и вид документа ' +
		'(без номера и реквизитов). Дата становится подтверждённой (`verified`, источник `operator_document`), режим ' +
		'возраста следует из неё сразу: `adult` — взрослый; `minor` — защищённый режим 14–17 лет (профиль без ' +
		'подтверждённого представителя снимается с показа в каталоге). Возраст, в котором профиль вести нельзя (младше ' +
		'14 лет, 14–17 при выключенной политике несовершеннолетних), — `409` (`ineligible_age`), ничего не меняется; ' +
		'расхождения уже нет — `409` (`not_in_conflict`).',
	auth: 'session',
	permission: 'age.review',
	params: z.strictObject({ candidate_id: z.uuid() }),
	body: z.strictObject({
		birth_date: z.iso.date().describe('Дата рождения по документу'),
		method: z
			.enum(AGE_CHECK_METHODS)
			.describe('`document_presented` — документ на встрече или видеозвонке; `in_person` — личный визит'),
		document_kind: z.enum(AGE_DOCUMENT_KINDS)
	}),
	errors: ['not_found', 'conflict'],
	response: {
		status: 200,
		description: 'Решение записано',
		schema: z.object({
			regime: z.enum(['adult', 'minor']),
			matches_declared: z.boolean().describe('Документ подтвердил указанную кандидатом дату'),
			hidden: z.boolean().describe('Профиль подростка без подтверждённого представителя снят с показа в каталоге')
		})
	},
	async handle(ctx) {
		const outcome = await resolveAgeConflict(
			ctx.services.db,
			await ctx.subject(),
			ctx.meta,
			ctx.params.candidate_id,
			{ birthDate: ctx.body.birth_date, method: ctx.body.method, documentKind: ctx.body.document_kind },
			new Date()
		);
		return { regime: outcome.regime, matches_declared: outcome.matchesDeclared, hidden: outcome.hidden };
	}
});

const annulReason = z.enum(ANNUL_REASONS);

export const listAttemptsForReview = defineOperation({
	id: 'listAttemptsForReview',
	method: 'GET',
	path: '/operator/assessments/attempts',
	tag: 'ФСП',
	summary: 'Попытки тестов на пересмотр',
	description:
		'`attention` (по умолчанию) — неаннулированные попытки, в журнале сигналов которых есть вставки или уходы со ' +
		'страницы (сигнал для человека, не вывод о заимствовании), и попытки с кластером, ждущим песочницу дольше 30 ' +
		'минут; `all` — последние попытки, аннулированные тоже. Новые первыми, до 100.',
	auth: 'session',
	permission: 'assessment.review',
	query: z.strictObject({ filter: z.enum(['attention', 'all']).optional() }),
	errors: [],
	response: {
		status: 200,
		description: 'Попытки',
		schema: z.object({
			items: z.array(
				z
					.object({
						attempt_id: z.uuid(),
						title: z.string().describe('Специализация и грейд теста'),
						specialization: z.string(),
						grade: z.string(),
						bank_release_id: z.string(),
						status: z.enum(['in_progress', 'decided', 'expired', 'annulled']),
						started_at: z.iso.datetime(),
						seeded: z.boolean().describe('Синтетика засева'),
						outcome: z
							.enum(['confirmed', 'not_confirmed', 'undetermined'])
							.nullable()
							.describe('Исход действующего решения'),
						signals: z.object({
							pastes: z.int(),
							pasted_chars: z.int(),
							departures: z.int(),
							silent: z.int().describe('Записи, где страница не передала сигналы')
						}),
						stuck: z.boolean().describe('Кластер ждёт песочницу дольше 30 минут'),
						annul_reason: annulReason.nullable()
					})
					.meta({ id: 'AttemptReviewItem' })
			)
		})
	},
	async handle(ctx) {
		const items = await attemptsForReview(
			ctx.services.db,
			await ctx.subject(),
			ctx.query.filter ?? 'attention',
			ctx.services.now()
		);
		return {
			items: items.map((item) => ({
				attempt_id: item.attemptId,
				title: item.title,
				specialization: item.specialization,
				grade: item.grade,
				bank_release_id: item.bankReleaseId,
				status: item.status,
				started_at: item.startedAt.toISOString(),
				seeded: item.seeded,
				outcome: item.outcome,
				signals: {
					pastes: item.signals.pastes,
					pasted_chars: item.signals.pastedChars,
					departures: item.signals.departures,
					silent: item.signals.silent
				},
				stuck: item.stuck,
				annul_reason: item.annulReason
			}))
		};
	}
});

export const annulAssessmentAttempt = defineOperation({
	id: 'annulAssessmentAttempt',
	method: 'POST',
	path: '/operator/assessments/attempts/{attempt_id}/annulment',
	tag: 'ФСП',
	summary: 'Аннулирование попытки',
	description:
		'Попытка `decided` или `expired` становится `annulled` с причиной: решение — `annulled`, владелец категорий ' +
		'приводит категорию и факт теста к оставшимся решениям (отзыв, возврат прежней или без изменений). Повтор по уже аннулированной попытке ничего не меняет (`annulled: false`); идущая попытка — `409` ' +
		'(`attempt_in_progress`), кроме застрявшей с причиной `technical_failure`: её кластер ждёт песочницу дольше 30 минут. Попытка, аннулированная из-за технического сбоя или дефекта версии, не засчитывается ' +
		'в попытки политики грейда.',
	auth: 'session',
	permission: 'assessment.review',
	params: z.strictObject({ attempt_id: z.uuid() }),
	body: z.strictObject({
		reason: z
			.enum(OPERATOR_ANNUL_REASONS)
			.describe('`plagiarism` · `technical_failure` · `version_defect` · `candidate_request`')
	}),
	errors: ['not_found', 'conflict'],
	response: {
		status: 200,
		description: 'Попытка аннулирована или уже была аннулирована',
		schema: z.object({
			annulled: z.boolean().describe('`false` — попытка уже была аннулирована'),
			category: z
				.enum(['assign', 'supersede', 'restore', 'revoke', 'keep'])
				.describe('Что аннулирование сделало с категорией: отозвана, возвращена прежняя или без изменений')
		})
	},
	async handle(ctx) {
		const outcome = await annulAttempt(
			ctx.services.db,
			OWNER_STANDING,
			await ctx.subject(),
			ctx.meta,
			ctx.params.attempt_id,
			ctx.body.reason,
			ctx.services.now()
		);
		return {
			annulled: outcome.annulled,
			category: outcome.category
		};
	}
});
