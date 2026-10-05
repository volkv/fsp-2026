// Hiring needs (contracts 10.2; domain 13.10): the employer writes who they look for, the text is parsed by the model or
// by the rules into a suggested form with quotes, the employer confirms the form, and the need gives the categories
// recommended for it with the numbers of candidates the company sees.
import { z } from 'zod';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import { OFFER_WORK_FORMATS } from '$lib/server/invitations/terms';
import { createNeed, getNeed, listNeeds, needCategories, updateNeed, type NeedView } from '$lib/server/needs/service';
import { defineOperation } from '../operation';
import { dateTime, id, iso, key } from '../schemas';
import { needDeps } from '../services';
import { invitationMeta } from './context';

const TAG = 'Потребности';

const needParams = z.strictObject({ need_id: id('Потребность') });

const needForm = z
	.object({
		specialization: z.enum(SPECIALIZATION_KEYS).optional(),
		grade: z.enum(GRADE_KEYS).optional(),
		skill_keys: z.array(key).describe('Обязательные навыки — ключи таксономии'),
		nice_skill_keys: z.array(key).describe('Желательные навыки'),
		team: z.string().optional().describe('О команде, до 500 символов'),
		work_format: z.enum(OFFER_WORK_FORMATS).optional(),
		region_code: z.string().optional().describe('Код региона из справочника `seeds/regions.json`'),
		salary: z
			.object({
				min: z.int(),
				max: z.int(),
				currency: z.string().describe('Только `RUB`; другая валюта — `422 salary_not_rub`'),
				period: z.literal('month'),
				tax_base: z.enum(['gross', 'net'])
			})
			.optional(),
		fsp_relevant: z.boolean().optional().describe('Результаты ФСП важны для потребности')
	})
	.meta({ id: 'NeedForm', description: 'Форма потребности' });

const needSchema = z
	.object({
		id: z.uuid(),
		text: z.string().nullable(),
		form: needForm,
		parse: z
			.object({
				mode: z.enum(['model', 'rules']).describe('`rules` — разобрано правилами, модель не отвечала'),
				ml_result_id: z.uuid(),
				rules_version: z.string(),
				model_failure: z.string().nullable(),
				fields: z.array(
					z.object({
						path: z.string(),
						value: z.unknown(),
						quote: z.string().describe('Слова текста, на которых держится поле')
					})
				)
			})
			.nullable()
			.describe('Разбор текста; поля — подсказка, работодатель их подтверждает'),
		text_check: z
			.object({
				result: z.enum(['clean', 'warnings', 'blocked']),
				phrases: z.array(
					z.object({
						field: z.string(),
						severity: z.enum(['block', 'warning']),
						text: z.string(),
						explanation: z.string()
					})
				)
			})
			.describe('Проверка текста на дискриминационные требования; предупреждения сохраняются'),
		status: z.enum(['draft', 'active', 'closed']),
		created_at: dateTime,
		updated_at: dateTime
	})
	.meta({ id: 'HiringNeed', description: 'Потребность компании' });

const needView = (need: NeedView) => ({
	id: need.id,
	text: need.text,
	form: need.form,
	parse: need.parse,
	text_check: {
		result: need.textCheck.result,
		phrases: need.textCheck.phrases.map((phrase) => ({
			field: phrase.field,
			severity: phrase.severity,
			text: phrase.text,
			explanation: phrase.explanation
		}))
	},
	status: need.status,
	created_at: iso(need.createdAt),
	updated_at: iso(need.updatedAt)
});

export const createHiringNeed = defineOperation({
	id: 'createNeed',
	method: 'POST',
	path: '/needs',
	tag: TAG,
	summary: 'Создать потребность',
	description:
		'Текст, форма или оба. Текст разбирается моделью или правилами (путь без модели полный) в предложенную форму с ' +
		'цитатами; заполненные поля формы сохраняются поверх подсказки. Потребность — черновик, пока работодатель не ' +
		'подтвердит форму. Недопустимое требование в тексте — `422 text_blocked`; вилка не в рублях — `422 salary_not_rub`.',
	auth: 'account',
	permission: 'need.manage',
	idempotent: true,
	body: z
		.strictObject({
			text: z.string().nullable().optional().describe('Кого ищем, чем занимается команда; до 5000 символов'),
			form: needForm.optional()
		})
		.meta({
			examples: [
				{
					text: 'Ищем бэкенд-разработчика уровня middle в команду платежей. Нужны Go и PostgreSQL, Kafka будет плюсом. Удалённо.'
				}
			]
		}),
	errors: ['forbidden', 'policy_violation'],
	response: { status: 201, description: 'Потребность создана', schema: needSchema },
	async handle(ctx) {
		return needView(
			await createNeed(
				needDeps(ctx.services),
				await ctx.subject(),
				invitationMeta(ctx),
				{
					...(ctx.body.text === undefined ? {} : { text: ctx.body.text }),
					...(ctx.body.form === undefined ? {} : { form: ctx.body.form })
				},
				ctx.signal
			)
		);
	}
});

export const listHiringNeeds = defineOperation({
	id: 'listNeeds',
	method: 'GET',
	path: '/needs',
	tag: TAG,
	summary: 'Потребности компании',
	description: 'Потребности компании, новые первыми.',
	auth: 'account',
	permission: 'need.manage',
	errors: ['forbidden'],
	response: { status: 200, description: 'Потребности', schema: z.object({ items: z.array(needSchema) }) },
	async handle(ctx) {
		return { items: (await listNeeds(needDeps(ctx.services), await ctx.subject())).map(needView) };
	}
});

export const getHiringNeed = defineOperation({
	id: 'getNeed',
	method: 'GET',
	path: '/needs/{need_id}',
	tag: TAG,
	summary: 'Потребность',
	description: 'Потребность своей компании; чужая — `404`.',
	auth: 'account',
	permission: 'need.manage',
	params: needParams,
	errors: ['forbidden', 'not_found'],
	response: { status: 200, description: 'Потребность', schema: needSchema },
	async handle(ctx) {
		return needView(await getNeed(needDeps(ctx.services), await ctx.subject(), ctx.params.need_id));
	}
});

export const updateHiringNeed = defineOperation({
	id: 'updateNeed',
	method: 'PATCH',
	path: '/needs/{need_id}',
	tag: TAG,
	summary: 'Подтвердить или изменить потребность',
	description:
		'Подтверждение и правка формы, перевод в `active` или `closed`. Чужая — `404`; закрытая — `409 need_closed`.',
	auth: 'account',
	permission: 'need.manage',
	params: needParams,
	body: z.strictObject({ form: needForm.optional(), status: z.enum(['active', 'closed']).optional() }),
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
	response: { status: 200, description: 'Потребность после изменения', schema: needSchema },
	async handle(ctx) {
		return needView(
			await updateNeed(needDeps(ctx.services), await ctx.subject(), invitationMeta(ctx), ctx.params.need_id, {
				...(ctx.body.form === undefined ? {} : { form: ctx.body.form }),
				...(ctx.body.status === undefined ? {} : { status: ctx.body.status })
			})
		);
	}
});

const cell = z
	.union([z.object({ value: z.int() }), z.object({ below: z.int().describe('Меньше этого порога: «< 5»') })])
	.meta({ id: 'SmallCount', description: 'Число или «меньше порога»' });

export const needRecommendedCategories = defineOperation({
	id: 'getNeedCategories',
	method: 'GET',
	path: '/needs/{need_id}/categories',
	tag: TAG,
	summary: 'Рекомендованные категории',
	description:
		'Пара формы и соседние грейды той же специализации; без специализации — специализации, чьи блоки подтверждают ' +
		'обязательные навыки. У каждой — число кандидатов с действующей категорией, которых компания видит в каталоге, ' +
		'и из них — с результатами ФСП, относящимися к потребности; меньше порога — `{below}`.',
	auth: 'account',
	permission: 'need.manage',
	params: needParams,
	errors: ['forbidden', 'not_found'],
	response: {
		status: 200,
		description: 'Рекомендованные категории',
		schema: z.object({
			need_id: z.uuid(),
			categories: z.array(
				z.object({
					specialization: z.enum(SPECIALIZATION_KEYS),
					grade: z.enum(GRADE_KEYS),
					basis: z
						.enum(['form', 'neighbour_grade', 'skills'])
						.describe('`form` — пара формы, `neighbour_grade` — соседний грейд, `skills` — по навыкам'),
					covered_skills: z.array(z.string()).describe('Обязательные навыки, которые подтверждают блоки'),
					candidates: cell,
					with_fsp: cell
				})
			)
		})
	},
	async handle(ctx) {
		const { need, categories } = await needCategories(needDeps(ctx.services), await ctx.subject(), ctx.params.need_id);
		return {
			need_id: need.id,
			categories: categories.map((category) => ({
				specialization: category.specialization,
				grade: category.grade,
				basis: category.basis,
				covered_skills: category.coveredSkills,
				candidates: category.candidates,
				with_fsp: category.withFsp
			}))
		};
	}
});
