// The catalog of categories and the candidate's way to a test (contracts 10.1; domain 12.1–12.3): the catalog of the
// current version, the survey, the grade hint, the declaration and what the grade policy opens now.
import { z } from 'zod';
import {
	CATALOG,
	DIRECTION_KEYS,
	GRADE_KEYS,
	SPECIALIZATION_KEYS,
	specializationOpen
} from '$lib/server/assessments/contract/catalog';
import { candidatePreferencesSchema } from '$lib/server/candidates/preferences';
import { declareGrade, hintForSelf } from '$lib/server/grades/declarations';
import type { GradeHint } from '$lib/server/grades/hint';
import { loadGradeOptions } from '$lib/server/grades/policy';
import { selfCandidate } from '$lib/server/grades/self';
import { gradeSources } from '$lib/server/grades/sources';
import { latestSurvey, submitSurvey } from '$lib/server/grades/surveys';
import { optionText } from '$lib/server/grades/texts';
import { ApiError } from '$lib/server/errors/api-error';
import { defineOperation } from '../operation';
import { dateTime, iso, key } from '../schemas';

const TAG = 'Категория и грейд';

const specialization = z.enum(SPECIALIZATION_KEYS);
const grade = z.enum(GRADE_KEYS);

const hintSchema = z
	.object({
		version: z.int().describe('Версия правил подсказки'),
		suggested: grade.nullable().describe('Какой грейд заявить; `null` — оснований нет, выберите сами'),
		bases: z.array(
			z.object({
				source: z.enum(['resume', 'fsp', 'public_profile']),
				text: z.string(),
				fact_id: z.uuid().optional().describe('Факт профиля, на котором держится основание')
			})
		),
		caveats: z.array(z.string()).describe('Оговорки: чего подсказка не учитывает и что будет после теста')
	})
	.meta({ id: 'GradeHint', description: 'Подсказка грейда: совет с основаниями, не решение' });

const hintView = (hint: GradeHint) => ({
	version: hint.version,
	suggested: hint.suggested,
	bases: hint.bases,
	caveats: hint.caveats
});

export const getCategoryCatalog = defineOperation({
	id: 'getCategoryCatalog',
	method: 'GET',
	path: '/catalog/categories',
	tag: TAG,
	summary: 'Справочник категорий',
	description:
		'Справочник текущей версии: направления, специализации с признаком «открыта» (включена и выпущен банк теста), ' +
		'грейды, блоки компетенций с тем, что они проверяют, и определения грейдов: пограничный кандидат, что ожидается, ' +
		'блоки теста и чего тест не проверяет.',
	auth: 'public',
	errors: [],
	response: {
		status: 200,
		description: 'Справочник категорий',
		schema: z.object({
			version: z.string(),
			directions: z.array(z.object({ key: z.enum(DIRECTION_KEYS), title: z.string() })),
			specializations: z.array(
				z.object({
					key: specialization,
					title: z.string(),
					direction: z.enum(DIRECTION_KEYS),
					summary: z.string(),
					open: z.boolean().describe('Можно выбрать в опросе и пройти тест'),
					practice_languages: z.array(key)
				})
			),
			grades: z.array(z.object({ key: grade, ordinal: z.int(), title: z.string() })),
			blocks: z.array(
				z.object({
					code: z.string(),
					specialization,
					title: z.string(),
					checks: z.string(),
					skill_keys: z.array(key).describe('Навыки, которые подтверждает пройденный блок'),
					practice: z.boolean()
				})
			),
			definitions: z.array(
				z.object({
					specialization,
					grade,
					borderline: z.string(),
					expects: z.array(z.string()),
					blocks: z.array(z.string()).describe('Блоки теста этого грейда'),
					does_not_check: z.array(z.string())
				})
			),
			common_does_not_check: z.array(z.string())
		})
	},
	async handle({ services }) {
		const released = await gradeSources.releasedSpecializations(services.db);
		return {
			version: CATALOG.version,
			directions: CATALOG.directions.map((d) => ({ key: d.key, title: d.title })),
			specializations: CATALOG.specializations.map((s) => ({
				key: s.key,
				title: s.title,
				direction: s.direction,
				summary: s.summary,
				open: specializationOpen(s.key, released),
				practice_languages: [...s.practiceLanguages]
			})),
			grades: CATALOG.grades.map((g) => ({ key: g.key, ordinal: g.ordinal, title: g.title })),
			blocks: CATALOG.blocks.map((b) => ({
				code: b.code,
				specialization: b.specialization,
				title: b.title,
				checks: b.checks,
				skill_keys: [...b.skillKeys],
				practice: b.practice
			})),
			definitions: CATALOG.definitions.map((d) => ({
				specialization: d.specialization,
				grade: d.grade,
				borderline: d.borderline,
				expects: [...d.expects],
				blocks: d.blocks.map((b) => b.block),
				does_not_check: [...d.doesNotCheck]
			})),
			common_does_not_check: [...CATALOG.commonDoesNotCheck]
		};
	}
});

export const submitMySurvey = defineOperation({
	id: 'submitMySurvey',
	method: 'POST',
	path: '/me/surveys',
	tag: TAG,
	summary: 'Пройти опрос',
	description:
		'Новая версия опроса: направление, специализация (только открытые), заявленный стек — от 1 до 10 навыков ' +
		'таксономии — и формат и ожидания (зарплата — в рублях). Формат и ожидания записываются в предпочтения профиля. ' +
		'Прежние версии остаются в истории.',
	auth: 'session',
	permission: 'candidate.self.write',
	idempotent: true,
	body: z.strictObject({
		direction: z.enum(DIRECTION_KEYS),
		specialization,
		declared_skill_keys: z.array(key).min(1).max(10),
		preferences: candidatePreferencesSchema
	}),
	errors: ['forbidden', 'policy_violation', 'degraded'],
	response: {
		status: 201,
		description: 'Опрос сохранён',
		schema: z.object({ survey_id: z.uuid(), version: z.int() })
	},
	async handle(ctx) {
		const result = await submitSurvey(
			ctx.services.db,
			gradeSources,
			await ctx.subject(),
			{
				direction: ctx.body.direction,
				specialization: ctx.body.specialization,
				declaredSkillKeys: ctx.body.declared_skill_keys,
				preferences: ctx.body.preferences
			},
			{ requestId: ctx.meta.requestId, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent }
		);
		return { survey_id: result.surveyId, version: result.version };
	}
});

export const getMyGradeHint = defineOperation({
	id: 'getMyGradeHint',
	method: 'GET',
	path: '/me/grade-hint',
	tag: TAG,
	summary: 'Подсказка грейда',
	description:
		'Совет, какой грейд заявить в специализации действующего опроса, по действующим доказательствам профиля: стаж и ' +
		'маркеры ответственности из резюме, достижения ФСП, подтверждённые публичные профили. Не решение: грейд ' +
		'подтверждает только тест. `409 not_declared` — опроса ещё нет.',
	auth: 'session',
	permission: 'candidate.self.read',
	errors: ['forbidden', 'conflict', 'degraded'],
	response: {
		status: 200,
		description: 'Подсказка',
		schema: z.object({ specialization, hint: hintSchema })
	},
	async handle(ctx) {
		const { survey, hint } = await hintForSelf(ctx.services.db, await ctx.subject(), ctx.services.now());
		return { specialization: survey.specialization, hint: hintView(hint) };
	}
});

export const declareMyGrade = defineOperation({
	id: 'declareMyGrade',
	method: 'POST',
	path: '/me/grade-declarations',
	tag: TAG,
	summary: 'Заявить грейд',
	description:
		'Заявление грейда в специализации действующего опроса со снимком подсказки. Заявить другой грейд можно в любой ' +
		'момент, кроме идущей попытки теста (`409`, `details[].code = attempt_in_progress`); на подтверждённый грейд ' +
		'заявление не влияет.',
	auth: 'session',
	permission: 'candidate.self.write',
	idempotent: true,
	body: z.strictObject({ specialization, grade }),
	errors: ['forbidden', 'conflict', 'policy_violation', 'degraded'],
	response: {
		status: 201,
		description: 'Заявление принято',
		schema: z.object({
			declaration_id: z.uuid(),
			survey_id: z.uuid(),
			specialization,
			grade,
			hint: hintSchema,
			declared_at: dateTime
		})
	},
	async handle(ctx) {
		const declaration = await declareGrade(
			ctx.services.db,
			gradeSources,
			await ctx.subject(),
			ctx.body,
			{ requestId: ctx.meta.requestId, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent },
			ctx.services.now()
		);
		return {
			declaration_id: declaration.id,
			survey_id: declaration.surveyId,
			specialization: declaration.specialization,
			grade: declaration.grade,
			hint: hintView(declaration.hint),
			declared_at: iso(declaration.declaredAt)
		};
	}
});

export const getMyGradeOptions = defineOperation({
	id: 'getMyGradeOptions',
	method: 'GET',
	path: '/me/grade-options',
	tag: TAG,
	summary: 'Какой тест доступен',
	description:
		'По каждому грейду специализации: можно ли начать тест сейчас и какой это тест, или почему нельзя и с какой ' +
		'даты станет можно. Без `specialization` — специализация действующего опроса.',
	auth: 'session',
	permission: 'candidate.self.read',
	query: z.strictObject({ specialization: specialization.optional() }),
	errors: ['forbidden', 'conflict'],
	response: {
		status: 200,
		description: 'Грейды и их доступность',
		schema: z.object({
			specialization,
			options: z.array(
				z.object({
					grade,
					available: z.boolean(),
					kind: z
						.enum(['declared', 'lower_after_failure', 'upgrade_confident', 'upgrade_interval', 'upgrade_retake'])
						.nullable(),
					reason: z.string().nullable().describe('Код причины политики (`BlockReason`), когда тест закрыт'),
					available_from: dateTime
						.nullable()
						.describe(
							'Когда тест откроется сам — наибольшая дата всех закрывающих причин; `null` — нужно другое событие'
						),
					failed_retake: z
						.object({ grade, available_from: dateTime })
						.nullable()
						.describe(
							'Для теста ниже после неудачи: когда откроется повтор проваленного грейда — при любом результате этого теста'
						),
					explanation: z.string()
				})
			)
		})
	},
	async handle(ctx) {
		const { candidateId } = selfCandidate(await ctx.subject());
		let chosen = ctx.query.specialization;
		if (chosen === undefined) {
			const survey = await latestSurvey(ctx.services.db, candidateId);
			if (!survey) {
				throw new ApiError('conflict', {
					message: 'Сначала пройдите опрос',
					details: [{ code: 'not_declared', message: 'Сначала пройдите опрос' }]
				});
			}
			chosen = survey.specialization;
		}
		const options = await loadGradeOptions(ctx.services.db, gradeSources, {
			candidateId,
			specialization: chosen,
			now: ctx.services.now()
		});
		return {
			specialization: chosen,
			options: options.map((option) =>
				option.available
					? {
							grade: option.grade,
							available: true,
							kind: option.kind,
							reason: null,
							available_from: null,
							failed_retake: option.failedRetake
								? { grade: option.failedRetake.grade, available_from: iso(option.failedRetake.availableFrom) }
								: null,
							explanation: optionText(option)
						}
					: {
							grade: option.grade,
							available: false,
							kind: null,
							reason: option.reason,
							available_from: option.availableFrom ? iso(option.availableFrom) : null,
							failed_retake: null,
							explanation: optionText(option)
						}
			)
		};
	}
});
