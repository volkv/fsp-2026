// Vacancies (contracts 5.5; domain 13.1, 13.3): the general search, the vacancies of a company from draft to
// publication and a draft from pasted text.
import { z } from 'zod';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { demoSessionOfUser } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import { positionText, type IndicatorPosition, type VacancyMarketPosition } from '$lib/server/market/read';
import { extractVacancyFromText, VACANCY_TEXT_MAX_LENGTH } from '$lib/server/vacancies/from-text';
import { redisTextParseCache } from '$lib/server/vacancies/text-extract';
import {
	closeOwnVacancy,
	createOwnVacancy,
	pauseOwnVacancy,
	publishOwnVacancy,
	resumeOwnVacancy,
	updateOwnVacancy,
	type OwnVacancyInput,
	type VacancyAuthor
} from '$lib/server/vacancies/own';
import { textCheckSchema } from '$lib/server/vacancies/text-check';
import { defineOperation } from '../operation';
import { getOwnVacancy, type OwnVacancyView } from '$lib/server/employer/vacancies';
import {
	companyVacancyIds,
	searchVacancyIds,
	vacancyViews,
	visibleVacancyId,
	type VacancyView
} from '../read/vacancies';
import {
	dateTime,
	id,
	iso,
	isoOrNull,
	key,
	marketCategoryKey,
	observedMarketFigure,
	observedMarketFigureView,
	page,
	pageOf,
	pageQuery,
	salaryPeriod,
	salaryRange
} from '../schemas';
import { activeMembership, type BaseContext } from './context';

const TAG = 'Вакансии';

const vacancyParams = z.strictObject({ vacancy_id: id('Вакансия') });

const poolSchema = z
	.discriminatedUnion('status', [
		z.object({ status: z.literal('counted'), count: z.int(), counted_at: dateTime }),
		z.object({
			status: z.literal('below_threshold'),
			threshold: z.int().describe('Показывается как «< threshold»'),
			counted_at: dateTime
		}),
		z.object({ status: z.literal('insufficient_data') }),
		z.object({ status: z.literal('pending').describe('Ещё не посчитан для текущей редакции вакансии') })
	])
	.meta({ id: 'PoolCounter', description: 'Счётчик «в пуле N подтверждённых кандидатов» (domain 13.3)' });

const vacancyFields = {
	id: z.uuid(),
	status: z.string(),
	title: z.string(),
	description: z.string(),
	company: z.object({ id: z.uuid(), name: z.string() }),
	role_key: key,
	grade_min: key,
	grade_max: key,
	required_skill_keys: z.array(key),
	nice_skill_keys: z.array(key),
	work_format: key,
	employment_form: key,
	contract_types: z.array(key),
	city_id: z.string().nullable(),
	salary: salaryRange,
	published_at: dateTime.nullable(),
	pool: poolSchema
};

const ownBlock = z
	.object({
		revision: z.int().describe('Редакция: растёт при каждом изменении полей'),
		min_age: z.int().nullable().describe('Вакансия для несовершеннолетних с этого возраста; `null` — только 18+'),
		text_check: textCheckSchema.describe('Проверка текста на дискриминационные формулировки'),
		from_text: z.boolean().describe('Черновик собран из вставленного текста'),
		closed_at: dateTime.nullable(),
		created_at: dateTime,
		updated_at: dateTime
	})
	.meta({ id: 'OwnVacancyState', description: 'Состояние вакансии для её компании' });

const vacancySchema = z
	.object({
		...vacancyFields,
		own: ownBlock.optional().describe('Только участникам компании-владельца')
	})
	.meta({ id: 'Vacancy', description: 'Вакансия компании платформы' });

function vacancyView({ row, companyName, pool }: VacancyView, withOwn: boolean) {
	return {
		id: row.id,
		status: row.status,
		title: row.title,
		description: row.description,
		company: { id: row.companyId, name: companyName },
		role_key: row.roleKey,
		grade_min: row.gradeMin,
		grade_max: row.gradeMax,
		required_skill_keys: row.requiredSkillKeys,
		nice_skill_keys: row.niceSkillKeys,
		work_format: row.workFormat,
		employment_form: row.employmentForm,
		contract_types: row.contractTypes,
		city_id: row.cityId,
		salary: {
			min: row.salaryMin,
			max: row.salaryMax,
			currency: row.salaryCurrency,
			period: row.salaryPeriod,
			tax_base: row.salaryTaxBase
		},
		published_at: isoOrNull(row.publishedAt),
		pool:
			pool.status === 'counted'
				? { status: pool.status, count: pool.count, counted_at: iso(pool.countedAt) }
				: pool.status === 'below_threshold'
					? { status: pool.status, threshold: pool.threshold, counted_at: iso(pool.countedAt) }
					: { status: pool.status },
		...(withOwn
			? {
					own: {
						revision: row.revision,
						min_age: row.minAge,
						text_check: textCheckSchema.parse(row.textCheck),
						from_text: row.draftMlResultId !== null,
						closed_at: isoOrNull(row.closedAt),
						created_at: iso(row.createdAt),
						updated_at: iso(row.updatedAt)
					}
				}
			: {})
	};
}

async function ownVacancyView(ctx: BaseContext, vacancyId: string) {
	const [view] = await vacancyViews(ctx.services.db, [vacancyId], ctx.services.now());
	if (!view) throw new Error(`vacancy ${vacancyId} was just written and is missing`);
	return vacancyView(view, true);
}

export const searchVacancies = defineOperation({
	id: 'searchVacancies',
	method: 'GET',
	path: '/vacancies',
	tag: TAG,
	summary: 'Поиск вакансий',
	description: 'Опубликованные вакансии компаний платформы со счётчиком пула.',
	auth: 'public',
	query: z.strictObject({
		text: z.string().max(500).optional().describe('Полнотекстовый запрос'),
		role_key: z.array(key).max(20).optional().describe('Роли (параметр повторяется)'),
		work_format: z.array(key).max(10).optional().describe('Форматы работы (параметр повторяется)'),
		...pageQuery
	}),
	errors: [],
	response: { status: 200, description: 'Страница вакансий', schema: page(vacancySchema) },
	async handle({ services, query, subject }) {
		const { cursor, limit, ...search } = query;
		const ids = await searchVacancyIds(
			services.db,
			{
				text: search.text,
				roleKeys: search.role_key,
				workFormats: search.work_format
			},
			await demoSessionOfUser(services.db, (await subject()).userId)
		);
		const slice = pageOf(ids, { cursor, limit }, { op: 'vacancies', ...search });
		const views = await vacancyViews(services.db, slice.items, services.now());
		return { items: views.map((view) => vacancyView(view, false)), next_cursor: slice.next_cursor };
	}
});

export const getVacancy = defineOperation({
	id: 'getVacancy',
	method: 'GET',
	path: '/vacancies/{vacancy_id}',
	tag: TAG,
	summary: 'Вакансия',
	description:
		'Вакансия из общего поиска — любому; вакансия в любом статусе — участникам её компании (с проверкой ' +
		'текста и редакцией). Иначе — `404`.',
	auth: 'public',
	params: vacancyParams,
	errors: ['not_found'],
	response: { status: 200, description: 'Вакансия', schema: vacancySchema },
	async handle(ctx) {
		const subject = await ctx.subject();
		const membership = activeMembership(subject);
		const visible = await visibleVacancyId(ctx.services.db, ctx.params.vacancy_id, {
			companyId: membership?.companyId ?? null,
			demoSessionId: await demoSessionOfUser(ctx.services.db, subject.userId)
		});
		if (visible === null) throw new ApiError('not_found');
		const [view] = await vacancyViews(ctx.services.db, [visible], ctx.services.now());
		if (!view) throw new ApiError('not_found');
		return vacancyView(view, membership !== null && view.row.companyId === membership.companyId);
	}
});

/** The author of a vacancy action: a member of its company holding `vacancy.write` (the object rule is the service's). */
async function authorOf(ctx: BaseContext): Promise<VacancyAuthor> {
	const subject = await ctx.subject();
	const membership = activeMembership(subject);
	requireVacancyWrite(subject, membership?.companyId ?? null);
	if (subject.userId === null || membership === null) throw new ApiError('forbidden');
	return {
		memberId: membership.memberId,
		companyId: membership.companyId,
		audit:
			ctx.actor.kind === 'api_key'
				? {
						kind: 'api_key',
						apiKeyId: ctx.actor.apiKeyId,
						userId: ctx.actor.userId,
						companyId: ctx.actor.companyId
					}
				: { kind: 'user', userId: subject.userId, companyId: membership.companyId },
		requestId: ctx.meta.requestId
	};
}

function requireVacancyWrite(subject: AccessSubject, companyId: string | null): void {
	const decision = can(subject, 'vacancy.write', { companyId });
	if (decision.allowed) return;
	throw new ApiError(decision.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
}

const salaryInput = z.strictObject({
	min: z.int(),
	max: z.int(),
	currency: z.string().describe('Код валюты ISO 4217, например `RUB`'),
	period: salaryPeriod,
	tax_base: z.enum(['gross', 'net']).describe('У вакансии налоговая база известна всегда')
});

const vacancyInputFields = {
	title: z.string(),
	description: z.string(),
	role_key: key,
	grade_min: key,
	grade_max: key,
	required_skill_keys: z.array(key),
	nice_skill_keys: z.array(key),
	work_format: key,
	employment_form: key,
	contract_types: z.array(key),
	city_id: z.string().nullable(),
	timezone_overlap_hours: z.int().nullable(),
	min_age: z
		.int()
		.nullable()
		.optional()
		.describe(
			'Вакансия для несовершеннолетних с этого возраста: 14, 15 или 16 — при принятой владельцем компании оферте ' +
				'`minor_employment_terms`; `null` или не передано — только 18+'
		),
	salary: salaryInput
};

type VacancyInputBody = z.output<z.ZodObject<typeof vacancyInputFields>>;

function serviceInput(body: VacancyInputBody): OwnVacancyInput {
	return {
		title: body.title,
		description: body.description,
		roleKey: body.role_key,
		gradeMin: body.grade_min,
		gradeMax: body.grade_max,
		requiredSkillKeys: body.required_skill_keys,
		niceSkillKeys: body.nice_skill_keys,
		workFormat: body.work_format,
		employmentForm: body.employment_form,
		contractTypes: body.contract_types,
		cityId: body.city_id,
		timezoneOverlapHours: body.timezone_overlap_hours,
		minAge: body.min_age ?? null,
		salary: {
			min: body.salary.min,
			max: body.salary.max,
			currency: body.salary.currency,
			period: body.salary.period,
			taxBase: body.salary.tax_base
		}
	};
}

const VACANCY_EXAMPLE = {
	title: 'Backend-разработчик на Go',
	description: 'Разрабатываем сервисы расчёта рейтингов соревнований. Код-ревью, CI, дежурства по графику.',
	role_key: 'backend',
	grade_min: 'middle',
	grade_max: 'senior',
	required_skill_keys: ['go', 'postgresql'],
	nice_skill_keys: ['kafka'],
	work_format: 'remote',
	employment_form: 'full_time',
	contract_types: ['employment'],
	city_id: null,
	timezone_overlap_hours: 4,
	salary: { min: 250000, max: 350000, currency: 'RUB', period: 'month', tax_base: 'gross' }
};

export const createVacancy = defineOperation({
	id: 'createVacancy',
	method: 'POST',
	path: '/vacancies',
	tag: TAG,
	summary: 'Создать вакансию',
	description:
		'Сохраняет черновик вакансии компании: роль, грейд, условия и полная вилка с известной налоговой базой. Ответ ' +
		'содержит проверку текста. `from_text` — черновик из разбора вставленного текста.',
	auth: 'account',
	permission: 'vacancy.write',
	idempotent: true,
	body: z
		.strictObject({
			...vacancyInputFields,
			from_text: z.strictObject({ ml_result_id: z.uuid() }).optional().describe('Разбор текста, из которого черновик')
		})
		.meta({ examples: [VACANCY_EXAMPLE] }),
	errors: ['not_found'],
	response: { status: 201, description: 'Черновик сохранён', schema: vacancySchema },
	async handle(ctx) {
		const author = await authorOf(ctx);
		const { from_text: fromText, ...fields } = ctx.body;
		const row = await createOwnVacancy(
			{ db: ctx.services.db, now: ctx.services.now },
			author,
			serviceInput(fields),
			fromText === undefined ? {} : { fromText: { mlResultId: fromText.ml_result_id } }
		);
		return ownVacancyView(ctx, row.id);
	}
});

function currentInput(vacancy: OwnVacancyView): VacancyInputBody {
	return {
		title: vacancy.title,
		description: vacancy.description,
		role_key: vacancy.roleKey,
		grade_min: vacancy.gradeMin,
		grade_max: vacancy.gradeMax,
		required_skill_keys: vacancy.requiredSkillKeys,
		nice_skill_keys: vacancy.niceSkillKeys,
		work_format: vacancy.workFormat,
		employment_form: vacancy.employmentForm,
		contract_types: vacancy.contractTypes,
		city_id: vacancy.cityId,
		timezone_overlap_hours: vacancy.timezoneOverlapHours,
		min_age: vacancy.minAge,
		salary: {
			min: vacancy.salary.min,
			max: vacancy.salary.max,
			currency: vacancy.salary.currency,
			period: vacancy.salary.period,
			tax_base: vacancy.salary.taxBase
		}
	};
}

export const updateVacancy = defineOperation({
	id: 'updateVacancy',
	method: 'PATCH',
	path: '/vacancies/{vacancy_id}',
	tag: TAG,
	summary: 'Изменить вакансию',
	description:
		'Меняет переданные поля (`salary` — целиком) незакрытой вакансии; текст проверяется заново. Новые предупреждения ' +
		'опубликованной вакансии подтверждаются `confirm_warnings`; заблокированный текст уводит её на модерацию.',
	auth: 'account',
	permission: 'vacancy.write',
	params: vacancyParams,
	body: z
		.strictObject(vacancyInputFields)
		.partial()
		.extend({ confirm_warnings: z.boolean().optional().describe('Подтвердить предупреждения проверки текста') }),
	errors: ['not_found', 'policy_violation'],
	response: { status: 200, description: 'Вакансия после изменения', schema: vacancySchema },
	async handle(ctx) {
		const author = await authorOf(ctx);
		const current = await getOwnVacancy(ctx.services.db, author.companyId, ctx.params.vacancy_id, ctx.services.now());
		const { confirm_warnings: confirmWarnings, ...patch } = ctx.body;
		const merged: VacancyInputBody = { ...currentInput(current), ...patch };
		const row = await updateOwnVacancy(
			{ db: ctx.services.db, now: ctx.services.now },
			author,
			current.id,
			serviceInput(merged),
			confirmWarnings === undefined ? {} : { confirmWarnings }
		);
		return ownVacancyView(ctx, row.id);
	}
});

export const publishVacancy = defineOperation({
	id: 'publishVacancy',
	method: 'POST',
	path: '/vacancies/{vacancy_id}/publish',
	tag: TAG,
	summary: 'Опубликовать черновик',
	description:
		'`draft → published` для компании, которую пропускает политика допуска, с полной вилкой и чистым текстом (или подтверждёнными ' +
		'предупреждениями). Заблокированный проверкой текст уходит оператору: `status = pending_moderation`.',
	auth: 'account',
	permission: 'vacancy.write',
	params: vacancyParams,
	body: z.strictObject({ confirm_warnings: z.boolean().optional() }),
	errors: ['not_found', 'policy_violation'],
	response: {
		status: 200,
		description: 'Исход публикации',
		schema: z.object({ status: z.enum(['published', 'pending_moderation']), vacancy: vacancySchema })
	},
	async handle(ctx) {
		const author = await authorOf(ctx);
		const outcome = await publishOwnVacancy(
			{ db: ctx.services.db, now: ctx.services.now },
			author,
			ctx.params.vacancy_id,
			ctx.body.confirm_warnings === undefined ? {} : { confirmWarnings: ctx.body.confirm_warnings }
		);
		return { status: outcome.status, vacancy: await ownVacancyView(ctx, outcome.vacancy.id) };
	}
});

const TRANSITIONS = {
	pause: {
		run: pauseOwnVacancy,
		summary: 'Приостановить',
		description: '`published → paused`: вакансия уходит из поиска.'
	},
	resume: { run: resumeOwnVacancy, summary: 'Возобновить', description: '`paused → published`.' },
	close: {
		run: closeOwnVacancy,
		summary: 'Закрыть',
		description:
			'Закрытие необратимо и сразу убирает вакансию из каталога вместе с видимыми в её контексте подростками.'
	}
} as const;

function transitionOperation(action: keyof typeof TRANSITIONS) {
	const { run, summary, description } = TRANSITIONS[action];
	return defineOperation({
		id: `${action}Vacancy`,
		method: 'POST',
		path: `/vacancies/{vacancy_id}/${action}`,
		tag: TAG,
		summary,
		description,
		auth: 'account',
		permission: 'vacancy.write',
		params: vacancyParams,
		errors: ['not_found', 'policy_violation'],
		response: { status: 200, description: 'Вакансия после перехода', schema: vacancySchema },
		async handle(ctx) {
			const author = await authorOf(ctx);
			const row = await run({ db: ctx.services.db, now: ctx.services.now }, author, ctx.params.vacancy_id);
			return ownVacancyView(ctx, row.id);
		}
	});
}

export const pauseVacancy = transitionOperation('pause');
export const resumeVacancy = transitionOperation('resume');
export const closeVacancy = transitionOperation('close');

export const listCompanyVacancies = defineOperation({
	id: 'listCompanyVacancies',
	method: 'GET',
	path: '/companies/{company_id}/vacancies',
	tag: TAG,
	summary: 'Вакансии своей компании',
	description: 'Собственные вакансии компании во всех статусах, новые первыми. Чужая компания — `404`.',
	auth: 'account',
	permission: 'vacancy.write',
	params: z.strictObject({ company_id: id('Компания') }),
	query: z.strictObject(pageQuery),
	errors: ['not_found'],
	response: { status: 200, description: 'Страница вакансий', schema: page(vacancySchema) },
	async handle(ctx) {
		const subject = await ctx.subject();
		const membership = activeMembership(subject);
		requireVacancyWrite(subject, membership?.companyId ?? null);
		if (membership?.companyId !== ctx.params.company_id) throw new ApiError('not_found');
		const ids = await companyVacancyIds(ctx.services.db, membership.companyId);
		const slice = pageOf(ids, ctx.query, { op: 'company-vacancies', company: membership.companyId });
		const views = await vacancyViews(ctx.services.db, slice.items, ctx.services.now());
		return { items: views.map((view) => vacancyView(view, true)), next_cursor: slice.next_cursor };
	}
});

const quote = z
	.object({
		block_id: z.string(),
		start: z.int().describe('Смещение в кодовых точках от начала блока'),
		end: z.int(),
		text: z.string()
	})
	.meta({ id: 'TextQuote', description: 'Цитата из вставленного текста, на которой основано поле' });

const quoted = <T extends z.ZodType>(value: T) => z.object({ value, quote }).nullable();
const textSkill = z.object({ key: key.nullable().describe('`null` — навык не из таксономии'), raw: z.string(), quote });

type Draft = Awaited<ReturnType<typeof extractVacancyFromText>>;
type Located = { quote: { blockId: string; start: number; end: number; text: string } };

const quoteView = ({ quote: q }: Located) => ({ block_id: q.blockId, start: q.start, end: q.end, text: q.text });
const quotedView = <T, U>(field: ({ value: T } & Located) | null, map: (value: T) => U) =>
	field === null ? null : { value: map(field.value), quote: quoteView(field) };
const skillView = (skill: Draft['fields']['requiredSkills'][number]) => ({
	key: skill.key,
	raw: skill.raw,
	quote: quoteView(skill)
});

const positionIndicator = z
	.enum(['vacancy_ranges', 'external_reference'])
	.describe('`vacancy_ranges` — вилки вакансий категории, `external_reference` — внешний ориентир');
const positionCategory = marketCategoryKey.describe(
	'Комбинация, по которой собран показатель; шире комбинации вакансии — если по ней данных нет'
);
const positionTextSchema = z.string().describe('Положение словами, с пометками «оценка» и «демо-данные»');

const marketPositionSchema = z
	.discriminatedUnion('status', [
		z.object({
			status: z
				.literal('no_specialization')
				.describe('Роль не распознана или не относится ни к одной специализации справочника: рынка категории нет')
		}),
		z.object({
			status: z.literal('evaluated'),
			positions: z.array(
				z.discriminatedUnion('status', [
					z.object({
						indicator: positionIndicator,
						status: z.literal('compared'),
						category_key: positionCategory,
						comparison: z
							.enum(['lower', 'equal', 'higher', 'overlap'])
							.describe('Вилка против межквартильного диапазона показателя'),
						percent_to_median: z
							.int()
							.nullable()
							.describe('Середина вилки против медианы, %; `null` — у вилки одна граница'),
						figure: observedMarketFigure,
						text: positionTextSchema
					}),
					z.object({
						indicator: positionIndicator,
						status: z.literal('not_comparable'),
						reason: z
							.enum(['no_salary', 'vacancy_tax_base_unknown', 'tax_base', 'currency', 'period'])
							.describe('Сравнение только при одинаковых валюте, периоде и известной налоговой базе'),
						category_key: positionCategory,
						market: z
							.object({ currency: z.string(), period: z.string(), tax_base: z.string() })
							.nullable()
							.describe('Единица показателя, с которой вилку сравнить нельзя'),
						text: positionTextSchema
					}),
					z.object({
						indicator: positionIndicator,
						status: z.literal('insufficient_data'),
						text: positionTextSchema
					})
				])
			)
		})
	])
	.meta({
		id: 'VacancyMarketPosition',
		description: 'Положение вилки относительно рынка категории (domain 12.8): каждый показатель отдельно'
	});

function positionView(position: IndicatorPosition, vacancyTaxBase: Draft['fields']['salary']) {
	const text = positionText(position, vacancyTaxBase?.value.taxBase ?? null);
	switch (position.status) {
		case 'insufficient_data':
			return { indicator: position.indicator, status: position.status, text };
		case 'not_comparable':
			return {
				indicator: position.indicator,
				status: position.status,
				reason: position.reason,
				category_key: position.categoryKey,
				market: position.market && {
					currency: position.market.currency,
					period: position.market.period,
					tax_base: position.market.taxBase
				},
				text
			};
		case 'compared': {
			return {
				indicator: position.indicator,
				status: position.status,
				category_key: position.categoryKey,
				comparison: position.comparison,
				percent_to_median: position.percentToMedian,
				figure: observedMarketFigureView(position.figure),
				text
			};
		}
	}
}

function marketPositionView(position: VacancyMarketPosition, salary: Draft['fields']['salary']) {
	return position.status === 'no_specialization'
		? position
		: { status: position.status, positions: position.positions.map((item) => positionView(item, salary)) };
}

export const draftVacancyFromText = defineOperation({
	id: 'draftVacancyFromText',
	method: 'POST',
	path: '/vacancies/drafts/from-text',
	tag: TAG,
	summary: 'Черновик из текста',
	description:
		'Разбирает вставленный текст вакансии: предложенные поля с цитатами, недостающие поля, проверка текста и ' +
		'положение предложенной вилки относительно рынка категории. Ничего ' +
		'не сохраняет; черновик сохраняется `POST /vacancies` с `from_text.ml_result_id`. Без модели (`mode = rules`) ' +
		'поля предлагают детерминированные правила — с теми же цитатами; `model_failure` говорит, почему без модели.',
	auth: 'account',
	permission: 'vacancy.write',
	body: z.strictObject({ text: z.string().max(VACANCY_TEXT_MAX_LENGTH) }),
	errors: [],
	response: {
		status: 200,
		description: 'Предложенный черновик',
		schema: z.object({
			vacancy_id: z.uuid(),
			ml_result_id: z.uuid(),
			mode: z.enum(['model', 'rules']).describe('`rules` — модель недоступна, поля разобраны правилами'),
			model_failure: z.string().nullable().describe('Код отказа модели в режиме `rules`: `disabled`, `timeout`, …'),
			blocks: z.array(z.object({ id: z.string(), text: z.string() })),
			fields: z.object({
				title: quoted(z.string()),
				role_key: key.nullable(),
				grade: quoted(z.object({ min: key.nullable(), max: key.nullable() })),
				required_skills: z.array(textSkill),
				nice_skills: z.array(textSkill),
				negated_skills: z.array(textSkill).describe('Навыки, которые текст называет ненужными'),
				salary: quoted(
					z.object({
						min: z.int().nullable(),
						max: z.int().nullable(),
						currency: z.string().nullable(),
						period: salaryPeriod.nullable(),
						tax_base: z.enum(['gross', 'net', 'unknown'])
					})
				),
				work_format: quoted(z.string()),
				employment_form: quoted(z.string()),
				contract_types: z.array(z.object({ value: z.string(), quote })),
				city: quoted(z.string())
			}),
			missing: z.array(z.string()).describe('Поля, которые нужно заполнить перед сохранением'),
			text_check: textCheckSchema,
			market_position: marketPositionSchema,
			taxonomy_version_id: z.uuid()
		})
	},
	async handle(ctx) {
		const author = await authorOf(ctx);
		const draft = await extractVacancyFromText(
			{ db: ctx.services.db, models: ctx.services.models, parseCache: redisTextParseCache(ctx.services.redis) },
			{ companyId: author.companyId },
			ctx.body.text,
			ctx.signal
		);
		const { fields } = draft;
		return {
			vacancy_id: draft.vacancyId,
			ml_result_id: draft.mlResultId,
			mode: draft.mode,
			model_failure: draft.modelFailure,
			blocks: draft.blocks,
			fields: {
				title: quotedView(fields.title, (value) => value),
				role_key: fields.roleKey,
				grade: quotedView(fields.grade, (value) => value),
				required_skills: fields.requiredSkills.map(skillView),
				nice_skills: fields.niceSkills.map(skillView),
				negated_skills: fields.negatedSkills.map(skillView),
				salary: quotedView(fields.salary, ({ taxBase, ...rest }) => ({ ...rest, tax_base: taxBase })),
				work_format: quotedView(fields.workFormat, (value) => value),
				employment_form: quotedView(fields.employmentForm, (value) => value),
				contract_types: fields.contractTypes.map((field) => ({ value: field.value, quote: quoteView(field) })),
				city: quotedView(fields.city, (value) => value)
			},
			missing: draft.missing,
			text_check: draft.textCheck,
			market_position: marketPositionView(draft.marketPosition, fields.salary),
			taxonomy_version_id: draft.taxonomyVersionId
		};
	}
});
