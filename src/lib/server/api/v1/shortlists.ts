// Shortlists of hiring needs (contracts 10.2; domain 13.10): a need gives a shortlist ranked by the fit to it and the
// strength of the confirmed profile, with 3–5 reasons and their sources; refinements are steps that lose nothing;
// marks; «what if» by one condition; the range of the need only as an aggregate of a fixed cohort; the blind
// comparison with a keyword search («Оцените подбор»). Cards are shown through `canShow` at every opening.
import { z } from 'zod';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import { ApiError } from '$lib/server/errors/api-error';
import type { CompanyNeedMatch, SearchMode } from '$lib/server/matching/search';
import { NEED_COMPONENT_KEYS } from '$lib/server/matching/score';
import {
	evaluationSummary,
	judgeEvaluation,
	startEvaluation,
	type EvaluationResult
} from '$lib/server/shortlists/evaluation';
import type { SalaryAnswer } from '$lib/server/shortlists/cohort';
import {
	createShortlist,
	listShortlists,
	markCandidate,
	openShortlist,
	reviseShortlist,
	unmarkCandidate,
	whatIf,
	type WhatIfCandidate
} from '$lib/server/shortlists/service';
import { defineOperation } from '../operation';
import { dateTime, id, iso, key, pageQuery, pseudonym } from '../schemas';
import { shortlistDeps } from '../services';
import { invitationMeta } from './context';

const TAG = 'Подборки';

const needParams = z.strictObject({ need_id: id('Потребность') });
const shortlistParams = z.strictObject({ shortlist_id: id('Подборка') });
const category = z.object({ specialization: z.enum(SPECIALIZATION_KEYS), grade: z.enum(GRADE_KEYS) });

const component = z.object({
	level: z
		.enum(['need', 'strength'])
		.describe('`need` — соответствие потребности, `strength` — сила подтверждённого профиля'),
	applicable: z.boolean().describe('`false` — потребность этого не спрашивает: компонент вне счёта всех кандидатов'),
	status: z.enum(['computed', 'unknown', 'unavailable']),
	value: z.number(),
	weight: z.number(),
	contribution: z.number().describe('Точный вклад в счёт: вес × значение / сумма весов потребности'),
	reason: z.string().nullable()
});

const reasonSource = z
	.object({
		kind: z.enum(['test_block', 'fsp_fact', 'evidence', 'declared_skill', 'preference']),
		ref: z
			.string()
			.optional()
			.describe('Блок теста, ключ навыка или предпочтение; результат ФСП — квитанцией карточки'),
		specialization: z.enum(SPECIALIZATION_KEYS).optional(),
		grade: z.enum(GRADE_KEYS).optional()
	})
	.describe('Источник пункта; пункты `test_block`, `fsp_fact`, `declared_skill`, `preference` переходят в «почему вы»');

const reason = z
	.object({
		code: z.enum([
			'skills_test',
			'skills_fsp',
			'skills_platform',
			'skills_public_profile',
			'skills_claimed_untestable',
			'skills_claimed',
			'test_result',
			'fsp_related',
			'format_fits',
			'confirmed_recently'
		]),
		skill_keys: z.array(key).optional(),
		specialization: z.enum(SPECIALIZATION_KEYS).optional(),
		grade: z.enum(GRADE_KEYS).optional(),
		margin: z.number().optional().describe('Средний запас над порогом по блокам на задание (0 — ровно на пороге)'),
		format: z.enum(['office', 'hybrid', 'remote']).optional(),
		days: z.int().optional(),
		contribution: z.number(),
		source: reasonSource
	})
	.meta({ id: 'ShortlistReason' });

const needMatchSchema = z
	.object({
		coverage: z
			.object({
				group: z
					.enum(['covers', 'gaps'])
					.describe('`covers` — все обязательные навыки подтверждены; `gaps` — часть не подтверждена'),
				required: z.int().describe('Обязательных навыков потребности'),
				unconfirmed: z
					.array(
						z.object({
							skill_key: key,
							state: z
								.enum(['public_profile', 'claimed', 'missing', 'unknown'])
								.describe(
									'`public_profile` — только публичный профиль, `claimed` — заявлено, `missing` — нет, ' +
										'`unknown` — профиль сейчас не прочитан'
								)
						})
					)
					.describe('Обязательные навыки, которые не подтвердили ни тест, ни ФСП, ни платформа')
			})
			.describe('Первый уровень порядка: меньше неподтверждённых обязательных — выше; внутри — по `score`'),
		score: z.number().describe('Порядок внутри группы покрытия'),
		levels: z.object({ need: z.number(), strength: z.number() }),
		components: z.object(
			Object.fromEntries(NEED_COMPONENT_KEYS.map((k) => [k, component])) as Record<
				(typeof NEED_COMPONENT_KEYS)[number],
				typeof component
			>
		),
		skills: z.array(
			z.object({
				skill_key: key,
				requirement: z.enum(['required', 'nice']),
				basis: z
					.enum(['test', 'fsp', 'platform', 'public_profile', 'claimed_untestable', 'claimed', 'missing', 'unknown'])
					.describe(
						'`claimed` — заявлено, тест кандидата навык проверял и не подтвердил: полоса × низкий потолок; ' +
							'`claimed_untestable` — заявлено, тест кандидата навык не проверяет: полоса × потолок выше; ' +
							'`missing` — нет; `unknown` — профиль сейчас не прочитан'
					),
				value: z.number(),
				band: z.enum(['weak', 'moderate', 'strong']).nullable(),
				block: z.string().nullable()
			})
		),
		reasons: z.array(reason).describe('3–5 сильнейших положительных вкладов с источником'),
		gaps: z.array(key).describe('Обязательные навыки без основания'),
		to_verify: z.array(key).describe('Навыки потребности, которые кандидат только заявил'),
		category: category.nullable(),
		semantic: z.number().nullable(),
		tie_broken_by_semantic: z.boolean().describe('Порядок среди почти равных решила смысловая близость'),
		position: z.int(),
		position_without_fsp: z.int().describe('Позиция кандидата, если бы его результатов ФСП не было')
	})
	.meta({ id: 'ShortlistMatch' });

function needMatchView(match: CompanyNeedMatch) {
	return {
		coverage: match.coverage,
		score: match.score,
		levels: match.levels,
		components: match.components,
		skills: match.skills,
		reasons: match.reasons,
		gaps: match.gaps,
		to_verify: match.toVerify,
		category: match.category,
		semantic: match.semantic,
		tie_broken_by_semantic: match.tieBrokenBySemantic,
		position: match.position,
		position_without_fsp: match.positionWithoutFsp
	};
}

const count = z.union([z.object({ value: z.int() }), z.object({ below: z.int() })]);

const salaryAnswerSchema = z
	.object({
		specialization: z.enum(SPECIALIZATION_KEYS),
		grade: z.enum(GRADE_KEYS),
		tax_base: z.enum(['gross', 'net']),
		interval: z.object({ from: z.int(), to: z.int().nullable() }),
		not_below: count.describe('Вилка не ниже ожиданий у стольких кандидатов когорты (кратно порогу или «< порога»)'),
		of: count.describe('Кандидатов когорты, указавших сравнимые ожидания'),
		snapshot_date: z.iso.date()
	})
	.meta({ id: 'CohortSalaryAnswer', description: 'Агрегат по фиксированной когорте категории, снимок раз в сутки' });

const salaryView = (answer: SalaryAnswer) => answer;

const modeSchema = z.object({
	search_mode: z.enum(['hybrid', 'fts_only']),
	semantic_reason: z.string().nullable().describe('Почему смысловой близости нет: почти равные упорядочены по силе')
});
const modeView = (mode: SearchMode) => ({ search_mode: mode.searchMode, semantic_reason: mode.semanticReason });

const queryDiff = z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() }));

const shortlistSchema = z
	.object({
		id: z.uuid(),
		need_id: z.uuid(),
		status: z.enum(['open', 'archived']),
		created_at: dateTime,
		revision: z.object({
			seq: z.int(),
			query: z.unknown().describe('Категории, фильтры и форма потребности шага — без кандидатов'),
			change: queryDiff,
			created_at: dateTime
		}),
		latest_revision: z.int(),
		history: z.array(z.object({ seq: z.int(), change: queryDiff, created_at: dateTime })),
		items: z.array(
			z.object({
				pseudonym,
				match: needMatchSchema,
				offer_fit: z
					.object({
						format: z.enum(['yes', 'no', 'unknown']).nullable(),
						region: z.enum(['yes', 'relocation', 'no', 'unknown']).nullable()
					})
					.describe('Подходит ли предложение кандидату по тому, что видно в карточке; без значений'),
				marked: z.object({ note: z.string().nullable(), marked_at: dateTime }).nullable(),
				has_fsp: z.boolean()
			})
		),
		next_cursor: z.string().nullable(),
		total: z.int(),
		marked: z.array(
			z.object({
				pseudonym: pseudonym.nullable().describe('`null` — кандидат больше недоступен, данных нет'),
				state: z.enum(['in_results', 'not_matching', 'unavailable']),
				position: z.int().nullable(),
				note: z.string().nullable(),
				marked_at: dateTime
			})
		),
		salary: z.array(salaryAnswerSchema).nullable(),
		exposure: z
			.object({
				top10: z.object({ without_fsp: z.int(), of: z.int() }),
				pool: z.object({ without_fsp: z.int(), of: z.int() })
			})
			.describe('Кандидаты без результатов ФСП в первой десятке и во всей выдаче'),
		mode: modeSchema,
		coverage: z
			.object({
				basis: z
					.enum(['form', 'role', 'unsupported_role', 'closed', 'no_basis'])
					.describe(
						'Откуда категории потребности: `unsupported_role` — роль не проверяет ни один тест, `closed` — ' +
							'специализация закрыта, `no_basis` — нет ни роли, ни специализации'
					),
				role_key: key.nullable(),
				closed: z.array(z.enum(SPECIALIZATION_KEYS)),
				suggestions: z
					.array(
						z.object({
							specialization: z.enum(SPECIALIZATION_KEYS),
							grade: z.enum(GRADE_KEYS),
							covered_skills: z.array(key)
						})
					)
					.describe('Шаг без категорий: категории, чьи блоки подтверждают обязательные навыки, — на выбор'),
				neighbours: z
					.array(
						z.object({
							specialization: z.enum(SPECIALIZATION_KEYS),
							grade: z.enum(GRADE_KEYS),
							direction: z.enum(['below', 'above']),
							candidates: count.describe('Кандидаты категории, которых нет в выдаче шага')
						})
					)
					.describe('Соседние грейды, которые шаг не берёт: расширение — только уточнением'),
				other_requirements: z
					.array(z.object({ name: z.string(), requirement: z.enum(['required', 'nice']) }))
					.describe('Требования вне таксономии: платформа их не подтверждает')
			})
			.describe('Что подборка говорит о своих категориях: пустая выдача объясняется, а не возвращается ошибкой'),
		groups: z
			.object({ covers: z.int(), gaps: z.int() })
			.describe('Кандидатов всей выдачи, закрывающих все обязательные навыки, и с неподтверждёнными')
	})
	.meta({ id: 'Shortlist' });

export const createNeedShortlist = defineOperation({
	id: 'createShortlist',
	method: 'POST',
	path: '/needs/{need_id}/shortlists',
	tag: TAG,
	summary: 'Подборка по потребности',
	description:
		'Первый шаг берёт форму потребности и категории — переданные или свои категории потребности (пара формы; без ' +
		'специализации — специализации роли). У потребности без своей категории (роль не проверяет ни один тест) первый ' +
		'шаг — без категорий: выдача пуста, `coverage` подборки объясняет почему и предлагает категории по навыкам. ' +
		'Закрытая потребность — `409 need_closed`; закрытая специализация — `422 specialization_closed`.',
	auth: 'account',
	permission: 'need.manage',
	idempotent: true,
	params: needParams,
	body: z.strictObject({ categories: z.array(category).min(1).max(12).optional() }),
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
	response: {
		status: 201,
		description: 'Подборка создана',
		schema: z.object({ shortlist_id: z.uuid(), revision: z.int() })
	},
	async handle(ctx) {
		const created = await createShortlist(
			shortlistDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.need_id,
			ctx.body.categories === undefined ? {} : { categories: ctx.body.categories }
		);
		return { shortlist_id: created.id, revision: created.revision };
	}
});

export const listNeedShortlists = defineOperation({
	id: 'listNeedShortlists',
	method: 'GET',
	path: '/needs/{need_id}/shortlists',
	tag: TAG,
	summary: 'Подборки потребности',
	auth: 'account',
	permission: 'need.manage',
	params: needParams,
	errors: ['forbidden'],
	response: {
		status: 200,
		description: 'Подборки, новые первыми',
		schema: z.object({
			items: z.array(
				z.object({ id: z.uuid(), status: z.enum(['open', 'archived']), created_at: dateTime, revisions: z.int() })
			)
		})
	},
	async handle(ctx) {
		const items = await listShortlists(shortlistDeps(ctx.services), await ctx.subject(), ctx.params.need_id);
		return {
			items: items.map((item) => ({
				id: item.id,
				status: item.status,
				created_at: iso(item.createdAt),
				revisions: item.steps
			}))
		};
	}
});

export const getShortlist = defineOperation({
	id: 'getShortlist',
	method: 'GET',
	path: '/shortlists/{shortlist_id}',
	tag: TAG,
	summary: 'Подборка',
	description:
		'Выдача шага, ранжированная заново при каждом открытии и через `canShow`: соответствие потребности и сила ' +
		'подтверждённого профиля с точным вкладом, 3–5 пунктов «почему» с источником, «без ФСП — позиция N». Отмеченные — ' +
		'с признаком «не проходит новое условие» или «кандидат больше недоступен» (без данных). `?revision=` — выдача ' +
		'по запросу прошлого шага. Вилка потребности — только агрегатом когорты категории.',
	auth: 'account',
	permission: 'need.manage',
	params: shortlistParams,
	query: z.strictObject({ revision: z.coerce.number().int().positive().optional(), ...pageQuery }),
	errors: ['forbidden', 'not_found'],
	response: { status: 200, description: 'Подборка', schema: shortlistSchema },
	async handle(ctx) {
		const view = await openShortlist(shortlistDeps(ctx.services), await ctx.subject(), ctx.params.shortlist_id, {
			...(ctx.query.revision === undefined ? {} : { revision: ctx.query.revision }),
			limit: ctx.query.limit,
			...(ctx.query.cursor === undefined ? {} : { cursor: ctx.query.cursor }),
			signal: ctx.signal
		});
		return {
			id: view.id,
			need_id: view.needId,
			status: view.status,
			created_at: iso(view.createdAt),
			revision: {
				seq: view.revision.seq,
				query: view.revision.query,
				change: view.revision.change,
				created_at: iso(view.revision.createdAt)
			},
			latest_revision: view.latestSeq,
			history: view.history.map((step) => ({ seq: step.seq, change: step.change, created_at: iso(step.createdAt) })),
			items: view.items.map((item) => ({
				pseudonym: item.pseudonym,
				match: needMatchView(item.needMatch),
				offer_fit: item.offerFit,
				marked: item.mark && { note: item.mark.note, marked_at: iso(item.mark.markedAt) },
				has_fsp: item.hasFsp
			})),
			next_cursor: view.nextCursor,
			total: view.total,
			marked: view.marked.map((mark) => ({
				pseudonym: mark.pseudonym,
				state: mark.state,
				position: mark.position,
				note: mark.note,
				marked_at: iso(mark.markedAt)
			})),
			salary: view.salary?.map(salaryView) ?? null,
			exposure: {
				top10: { without_fsp: view.exposure.top.withoutFsp, of: view.exposure.top.of },
				pool: { without_fsp: view.exposure.pool.withoutFsp, of: view.exposure.pool.of }
			},
			mode: modeView(view.mode),
			coverage: {
				basis: view.coverage.basis,
				role_key: view.coverage.roleKey,
				closed: view.coverage.closed,
				suggestions: view.coverage.suggestions.map((c) => ({
					specialization: c.specialization,
					grade: c.grade,
					covered_skills: c.coveredSkills
				})),
				neighbours: view.coverage.neighbours,
				other_requirements: view.coverage.otherRequirements
			},
			groups: view.groups
		};
	}
});

export const createShortlistRevision = defineOperation({
	id: 'reviseShortlist',
	method: 'POST',
	path: '/shortlists/{shortlist_id}/revisions',
	tag: TAG,
	summary: 'Уточнить подборку',
	description:
		'Новый шаг из текущего: меняются только названные поля (`null` снимает необязательное). Отмеченные сохраняются. ' +
		'Уточнение, которое ничего не меняет, — `400 no_change`.',
	auth: 'account',
	permission: 'need.manage',
	idempotent: true,
	params: shortlistParams,
	body: z.strictObject({
		change: z
			.object({
				categories: z.array(category).optional(),
				skill_keys: z.array(key).optional(),
				nice_skill_keys: z.array(key).optional(),
				work_format: z.enum(['office', 'hybrid', 'remote']).nullable().optional(),
				region_code: z.string().nullable().optional(),
				salary: z
					.object({
						min: z.int(),
						max: z.int(),
						currency: z.literal('RUB'),
						period: z.literal('month'),
						tax_base: z.enum(['gross', 'net'])
					})
					.nullable()
					.optional(),
				fsp_relevant: z.boolean().optional(),
				fsp_only: z.boolean().optional().describe('Только с подтверждёнными результатами ФСП'),
				work_formats: z.array(z.enum(['office', 'hybrid', 'remote'])).optional(),
				confirmed_skill_keys: z.array(key).optional().describe('Навыки, подтверждённые тестом')
			})
			.describe('Что уточняется')
	}),
	errors: ['forbidden', 'not_found', 'conflict', 'policy_violation'],
	response: {
		status: 201,
		description: 'Новый шаг',
		schema: z.object({ revision: z.int(), change: queryDiff })
	},
	async handle(ctx) {
		return reviseShortlist(
			shortlistDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.shortlist_id,
			ctx.body.change
		);
	}
});

const markParams = z.strictObject({ shortlist_id: id('Подборка'), pseudonym });

export const markShortlistCandidate = defineOperation({
	id: 'markShortlistCandidate',
	method: 'PUT',
	path: '/shortlists/{shortlist_id}/marks/{pseudonym}',
	tag: TAG,
	summary: 'Отметить кандидата',
	description:
		'Отметка с заметкой (до 500 символов, видна только компании). Кандидат, которого компания не видит, — `404`.',
	auth: 'account',
	permission: 'need.manage',
	params: markParams,
	body: z.strictObject({ note: z.string().nullable().optional() }),
	errors: ['forbidden', 'not_found'],
	response: {
		status: 200,
		description: 'Отмечен',
		schema: z.object({ pseudonym, note: z.string().nullable(), marked_at: dateTime })
	},
	async handle(ctx) {
		const marked = await markCandidate(
			shortlistDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.shortlist_id,
			ctx.params.pseudonym,
			ctx.body.note ?? null
		);
		return { pseudonym: ctx.params.pseudonym, note: marked.note, marked_at: iso(marked.markedAt) };
	}
});

export const unmarkShortlistCandidate = defineOperation({
	id: 'unmarkShortlistCandidate',
	method: 'DELETE',
	path: '/shortlists/{shortlist_id}/marks/{pseudonym}',
	tag: TAG,
	summary: 'Снять отметку',
	auth: 'account',
	permission: 'need.manage',
	params: markParams,
	errors: ['forbidden', 'not_found'],
	response: { status: 204, description: 'Отметка снята' },
	async handle(ctx) {
		await unmarkCandidate(
			shortlistDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.shortlist_id,
			ctx.params.pseudonym
		);
	}
});

const whatIfCandidate = z.object({
	pseudonym,
	position: z.int(),
	reason: z
		.object({
			code: z.enum([
				'format_accepted',
				'format_not_accepted',
				'formats_unknown',
				'category',
				'skill_confirmed',
				'skill_not_confirmed',
				'fsp_present',
				'fsp_absent',
				'other_condition'
			]),
			format: z.string().optional(),
			specialization: z.enum(SPECIALIZATION_KEYS).optional(),
			grade: z.enum(GRADE_KEYS).optional(),
			skill_key: key.optional()
		})
		.describe('Почему вошёл или выпал — только по тому, что видно в карточке')
});
const whatIfCandidateView = (entry: WhatIfCandidate) => ({
	pseudonym: entry.pseudonym,
	position: entry.position,
	reason: entry.reason
});

export const shortlistWhatIf = defineOperation({
	id: 'shortlistWhatIf',
	method: 'GET',
	path: '/shortlists/{shortlist_id}/what-if',
	tag: TAG,
	summary: '«Что если»',
	description:
		'Изменение одного условия текущего шага (`change` — JSON): `{"work_format": "remote"}`, `{"grade": "senior"}`, ' +
		'`{"confirmed_skill": {"skill_key": "kafka", "required": true}}`, `{"fsp_only": true}` — поимённо, кто вошёл и кто ' +
		'выпал и почему; `{"salary": {"min", "max", "tax_base"}}` — только агрегат по фиксированной когорте категории ' +
		'(суточный снимок, интервалы политики каталога). Больше одного условия — `400 one_condition`.',
	auth: 'account',
	permission: 'need.manage',
	params: shortlistParams,
	query: z.strictObject({ change: z.string().min(2).max(2000).describe('Одно изменённое условие, JSON') }),
	errors: ['forbidden', 'not_found'],
	response: {
		status: 200,
		description: 'Кто стал доступен и кто выпал',
		schema: z.object({
			change: z.record(z.string(), z.unknown()),
			entered: z.array(whatIfCandidate),
			left: z.array(whatIfCandidate),
			before: z.int(),
			after: z.int(),
			salary: z.object({ before: z.array(salaryAnswerSchema), after: z.array(salaryAnswerSchema) }).nullable()
		})
	},
	async handle(ctx) {
		let change: unknown;
		try {
			change = JSON.parse(ctx.query.change);
		} catch {
			throw new ApiError('validation_failed', {
				details: [{ path: 'change', code: 'invalid_json', message: 'Условие — объект JSON' }]
			});
		}
		const view = await whatIf(
			shortlistDeps(ctx.services),
			await ctx.subject(),
			ctx.params.shortlist_id,
			change,
			ctx.signal
		);
		return {
			change: view.change,
			entered: view.entered.map(whatIfCandidateView),
			left: view.left.map(whatIfCandidateView),
			before: view.before,
			after: view.after,
			salary: view.salary
		};
	}
});

const evaluationResultSchema = z
	.object({
		selected: z.int(),
		precision_at_10: z
			.object({ product: z.number(), keywords: z.number() })
			.describe('Доля отмеченных среди десяти позиций каждой системы (знаменатель — 10)'),
		preference: z.object({
			product: z.int(),
			keywords: z.int(),
			winner: z.enum(['product', 'keywords', 'tie'])
		}),
		without_fsp_top10: z.object({ product: z.number().nullable(), keywords: z.number().nullable() }),
		overlap: z.int()
	})
	.meta({ id: 'BlindEvaluationResult' });

const evaluationResultView = (result: EvaluationResult) => result;

export const startShortlistEvaluation = defineOperation({
	id: 'startShortlistEvaluation',
	method: 'POST',
	path: '/shortlists/{shortlist_id}/evaluations',
	tag: TAG,
	summary: '«Оцените подбор»: начать',
	description:
		'Первая десятка подборки и первая десятка поиска по ключевым словам на той же потребности, смешанные ' +
		'чередованием команд и перемешанные: какая система выбрала карточку — не указано. Нечего сравнивать — `409`.',
	auth: 'session',
	params: shortlistParams,
	errors: ['forbidden', 'not_found', 'conflict'],
	response: {
		status: 201,
		description: 'Карточки для слепой оценки',
		schema: z.object({ evaluation_id: z.uuid(), cards: z.array(z.object({ position: z.int(), pseudonym })) })
	},
	async handle(ctx) {
		const started = await startEvaluation(
			shortlistDeps(ctx.services),
			await ctx.subject(),
			invitationMeta(ctx),
			ctx.params.shortlist_id,
			ctx.signal
		);
		return {
			evaluation_id: started.id,
			cards: started.cards.map((card) => ({ position: card.position, pseudonym: card.pseudonym }))
		};
	}
});

export const judgeShortlistEvaluation = defineOperation({
	id: 'judgeShortlistEvaluation',
	method: 'POST',
	path: '/shortlists/{shortlist_id}/evaluations/{evaluation_id}/judgement',
	tag: TAG,
	summary: '«Оцените подбор»: отметить подходящих',
	description:
		'Позиции подходящих карточек → Precision@10 каждой системы, предпочтение по чередованию и доля без ФСП. После ' +
		'оценки псевдонимы стираются из сохранённой оценки. Повтор — `409 already_judged`.',
	auth: 'session',
	params: z.strictObject({ shortlist_id: id('Подборка'), evaluation_id: id('Оценка') }),
	body: z.strictObject({ selected: z.array(z.int().positive()).max(20) }),
	errors: ['forbidden', 'not_found', 'conflict'],
	response: { status: 200, description: 'Результат', schema: evaluationResultSchema },
	async handle(ctx) {
		return evaluationResultView(
			await judgeEvaluation(
				shortlistDeps(ctx.services),
				await ctx.subject(),
				invitationMeta(ctx),
				ctx.params.shortlist_id,
				ctx.params.evaluation_id,
				ctx.body.selected
			)
		);
	}
});

export const listShortlistEvaluations = defineOperation({
	id: 'listShortlistEvaluations',
	method: 'GET',
	path: '/shortlists/{shortlist_id}/evaluations',
	tag: TAG,
	summary: '«Оцените подбор»: результаты',
	auth: 'account',
	permission: 'need.manage',
	params: shortlistParams,
	errors: ['forbidden', 'not_found'],
	response: {
		status: 200,
		description: 'Сохранённые оценки и средние',
		schema: z.object({
			judged: z.array(
				z.object({ id: z.uuid(), revision: z.int(), judged_at: dateTime, result: evaluationResultSchema })
			),
			mean: z
				.object({
					precision_at_10: z.object({ product: z.number(), keywords: z.number() }),
					product_wins: z.int(),
					keyword_wins: z.int()
				})
				.nullable()
		})
	},
	async handle(ctx) {
		const summary = await evaluationSummary(shortlistDeps(ctx.services), await ctx.subject(), ctx.params.shortlist_id);
		return {
			judged: summary.judged.map((j) => ({
				id: j.id,
				revision: j.revision,
				judged_at: iso(j.judgedAt),
				result: j.result
			})),
			mean: summary.mean
		};
	}
});
