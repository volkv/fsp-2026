// The catalog of candidates for a verified company (contracts 5.4–5.5; domain 7.4, 13.4, 14): search with filters, the
// card in the catalog projection chosen by `canShow`, the comparison of chosen candidates, the match with an own
// vacancy and the market of a category (domain 12.5). A candidate the company may not see is `404` whatever the reason;
// fact ids never reach a company.
import { z } from 'zod';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import { findInCatalog, loadCatalogCard, type CatalogCandidate } from '$lib/server/employer/card';
import { ApiError } from '$lib/server/errors/api-error';
import { activeCategories } from '$lib/server/categories/read';
import { categoryKey, categoryKeyId, categoryKeysOf, MARKET_INDICATORS } from '$lib/server/market/aggregate';
import { loadCategoryMarket } from '$lib/server/market/read';
import {
	compareCandidates,
	searchCandidates,
	type CandidateSearchFilters,
	type CompanyMatch,
	type SearchMode
} from '$lib/server/matching/search';
import { loadCatalogViewer } from '$lib/server/matching/visibility';
import { regionReference, type RegionReference } from '$lib/server/regions';
import { defineOperation } from '../operation';
import { cardSchema, cardView } from '../read/catalog-card';
import {
	companyMatch,
	id,
	key,
	marketCategoryKey,
	marketFigure,
	marketFigureView,
	pageQuery,
	pseudonym
} from '../schemas';
import { matchingDeps } from '../services';
import { activeMembership, type BaseContext } from './context';

const TAG = 'Каталог';

const searchModeSchema = {
	search_mode: z.enum(['hybrid', 'fts_only']).describe('`fts_only` — смысловой поиск не использовался'),
	embedding_space_id: z.string().nullable(),
	semantic_reason: z.string().nullable().describe('Почему смыслового компонента нет'),
	reranker: z.object({
		status: z.enum(['used', 'unavailable', 'not_applicable']),
		reason: z.string().nullable()
	})
};

const searchItemSchema = z
	.object({
		pseudonym,
		category_confirmed: z
			.boolean()
			.describe('`false` — категория не подтверждена: кандидат найден поиском по всей базе (без фильтров категории)'),
		relevance: z.object({ fts: z.number().nullable(), semantic: z.number().nullable() }),
		match: companyMatch.nullable().describe('С вакансией — соответствие ей'),
		card: cardSchema
	})
	.meta({ id: 'CatalogItem' });

function modeView(mode: SearchMode) {
	return {
		search_mode: mode.searchMode,
		embedding_space_id: mode.embeddingSpaceId,
		semantic_reason: mode.semanticReason,
		reranker: mode.reranker
	};
}

function matchView(match: CompanyMatch) {
	return { score: match.score, coverage: match.coverage, components: match.components, explanation: match.explanation };
}

/** The member of a verified company acting in the catalog, with the journal actor of the request. */
async function catalogMember(
	ctx: BaseContext
): Promise<{ subject: AccessSubject; companyId: string; audit: AuditActor }> {
	const subject = await ctx.subject();
	const decision = can(subject, 'catalog.search', null);
	if (!decision.allowed) throw new ApiError(decision.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	const membership = activeMembership(subject);
	if (membership === null || subject.userId === null) throw new ApiError('forbidden');
	const audit: AuditActor =
		ctx.actor.kind === 'api_key'
			? { kind: 'api_key', apiKeyId: ctx.actor.apiKeyId, userId: ctx.actor.userId, companyId: ctx.actor.companyId }
			: { kind: 'user', userId: subject.userId, companyId: membership.companyId };
	return { subject, companyId: membership.companyId, audit };
}

async function cardOf(ctx: BaseContext, companyId: string, item: CatalogCandidate) {
	return cardView(
		await loadCatalogCard(ctx.services.db, {
			candidateId: item.candidateId,
			companyId,
			pseudonym: item.pseudonym,
			extras: item.extras,
			now: ctx.services.now(),
			signer: ctx.services.receiptSigner
		})
	);
}

const filterQuery = {
	text: z.string().max(500).optional().describe('Полнотекстовый и смысловой запрос'),
	specialization: z
		.array(z.enum(SPECIALIZATION_KEYS))
		.max(SPECIALIZATION_KEYS.length)
		.optional()
		.describe('Специализация действующей категории (параметр повторяется)'),
	grade: z
		.array(z.enum(GRADE_KEYS))
		.max(GRADE_KEYS.length)
		.optional()
		.describe('Грейд действующей категории; вместе со специализацией — одной категории (параметр повторяется)'),
	confirmed_skill_key: z
		.array(key)
		.max(10)
		.optional()
		.describe('Все эти навыки — в подтверждённом тестом стеке одной действующей категории'),
	fsp_discipline: z.string().max(64).optional().describe('Дисциплина уровня ФСП; вместе с `fsp_min_level`'),
	fsp_min_level: z.enum(['L1', 'L2', 'L3', 'L4', 'L5']).optional(),
	work_format: z.array(key).max(10).optional(),
	region_code: z
		.array(z.string().max(16))
		.max(20)
		.optional()
		.describe('Регион из справочника регионов, код вида `RU-MOW` (параметр повторяется); неизвестный код — отказ'),
	uncategorized: z
		.enum(['true', 'false'])
		.optional()
		.describe('Фасет «категория не подтверждена»: только кандидаты без действующей категории'),
	has_fsp: z
		.enum(['true', 'false'])
		.optional()
		.describe('Только кандидаты с подтверждёнными достижениями ФСП (действующий факт ФСП)')
};

type FilterInput = z.output<z.ZodObject<typeof filterQuery>>;

function filtersOf(query: FilterInput, regions: RegionReference): CandidateSearchFilters {
	const unknownRegions = (query.region_code ?? []).filter((code) => !regions.has(code));
	if (unknownRegions.length > 0) {
		throw new ApiError('validation_failed', {
			details: [
				{
					path: 'region_code',
					code: 'unknown',
					message: `Таких регионов нет в справочнике: ${unknownRegions.join(', ')}`
				}
			]
		});
	}
	if ((query.fsp_discipline === undefined) !== (query.fsp_min_level === undefined)) {
		throw new ApiError('validation_failed', {
			details: [
				{ path: 'fsp_min_level', code: 'required_together', message: 'Дисциплина и уровень ФСП задаются вместе' }
			]
		});
	}
	return {
		...(query.specialization === undefined ? {} : { specializations: query.specialization }),
		...(query.grade === undefined ? {} : { grades: query.grade }),
		...(query.confirmed_skill_key === undefined ? {} : { confirmedSkillKeys: query.confirmed_skill_key }),
		...(query.fsp_discipline === undefined || query.fsp_min_level === undefined
			? {}
			: { fspLevel: { discipline: query.fsp_discipline, minLevel: query.fsp_min_level } }),
		...(query.work_format === undefined ? {} : { workFormats: query.work_format }),
		...(query.region_code === undefined ? {} : { regionCodes: query.region_code }),
		...(query.uncategorized === 'true' ? { uncategorized: true } : {}),
		...(query.has_fsp === 'true' ? { fspConfirmed: true } : {})
	};
}

type SearchQuery = FilterInput & { cursor?: string | undefined; limit: number };

async function runSearch(ctx: BaseContext, query: SearchQuery, vacancyId: string | undefined) {
	const member = await catalogMember(ctx);
	const { cursor, limit, text, ...filters } = query;
	const result = await searchCandidates(
		matchingDeps(ctx.services),
		member.subject,
		{
			...(vacancyId === undefined ? {} : { vacancyId }),
			...(text === undefined ? {} : { text }),
			filters: filtersOf({ text, ...filters }, await regionReference()),
			limit,
			...(cursor === undefined ? {} : { cursor })
		},
		ctx.signal
	);
	const items = await Promise.all(
		result.items.map(async (item) => ({
			pseudonym: item.pseudonym,
			category_confirmed: item.categoryConfirmed,
			relevance: item.relevance,
			match: item.match && matchView(item.match),
			card: await cardOf(ctx, member.companyId, item)
		}))
	);
	await recordAuditEvent(ctx.services.db, {
		action: 'catalog.searched',
		outcome: 'success',
		actor: member.audit,
		requestId: ctx.meta.requestId,
		ip: ctx.meta.ip,
		userAgent: ctx.meta.userAgent,
		details: { result_count: items.length, ...(vacancyId === undefined ? {} : { vacancy_id: vacancyId }) }
	});
	return { items, next_cursor: result.nextCursor, ...modeView(result.mode) };
}

const searchResponse = z.object({
	items: z.array(searchItemSchema),
	next_cursor: z.string().nullable(),
	...searchModeSchema
});

export const searchCatalog = defineOperation({
	id: 'searchCatalog',
	method: 'GET',
	path: '/catalog/candidates',
	tag: TAG,
	summary: 'Поиск кандидатов',
	description:
		'Каталог для участника компании, которую пропускает политика допуска: фильтры по роли, грейду (включая «грейд не установлен»), стеку, ' +
		'уровню ФСП, формату и региону, фасет «без категории», текст. С `vacancy_id` собственной вакансии — ранжирование ' +
		'по соответствию ей и видимость в её контексте. Каждая карточка — в проекции каталога. Выгрузки каталога целиком ' +
		'нет: только страницы запроса.',
	auth: 'account',
	permission: 'catalog.search',
	query: z.strictObject({ ...filterQuery, vacancy_id: z.uuid().optional(), ...pageQuery }),
	errors: ['not_found'],
	response: { status: 200, description: 'Страница каталога', schema: searchResponse },
	handle: (ctx) => {
		const { vacancy_id: vacancyId, ...query } = ctx.query;
		return runSearch(ctx, query, vacancyId);
	}
});

const vacancyParams = z.strictObject({ vacancy_id: id('Собственная вакансия компании') });

export const listVacancyMatches = defineOperation({
	id: 'listVacancyMatches',
	method: 'GET',
	path: '/vacancies/{vacancy_id}/matches',
	tag: TAG,
	summary: 'Кандидаты под вакансию',
	description:
		'Кандидаты под собственную незакрытую вакансию компании с оценкой, компонентами и объяснением соответствия. ' +
		'Фильтры — как у поиска.',
	auth: 'account',
	permission: 'match.read',
	params: vacancyParams,
	query: z.strictObject({ ...filterQuery, ...pageQuery }),
	errors: ['not_found'],
	response: { status: 200, description: 'Страница кандидатов', schema: searchResponse },
	handle: (ctx) => runSearch(ctx, ctx.query, ctx.params.vacancy_id)
});

/** The candidate of a pseudonym visible to the company in the context, or `404`. */
async function visibleCandidate(ctx: BaseContext, candidate: string, vacancyId: string | undefined) {
	const member = await catalogMember(ctx);
	const item = await findInCatalog(matchingDeps(ctx.services), member.subject, candidate, vacancyId, ctx.signal);
	if (!item) throw new ApiError('not_found');
	return { member, item };
}

export const getCandidateCard = defineOperation({
	id: 'getCandidateCard',
	method: 'GET',
	path: '/candidates/{pseudonym}',
	tag: TAG,
	summary: 'Карточка кандидата',
	description:
		'Карточка в проекции каталога по решению `canShow`: без ФИО, контактов, названий компаний и вуза; точные ' +
		'достижения и профили — только если кандидат 18+ их открыл. С `vacancy_id` — в контексте собственной вакансии и ' +
		'с соответствием ей. Кандидат, которого компания не видит, — `404`.',
	auth: 'account',
	permission: 'candidate.card.read',
	params: z.strictObject({ pseudonym }),
	query: z.strictObject({ vacancy_id: z.uuid().optional() }),
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Карточка',
		schema: cardSchema.extend({ match: companyMatch.nullable() })
	},
	async handle(ctx) {
		const { member, item } = await visibleCandidate(ctx, ctx.params.pseudonym, ctx.query.vacancy_id);
		const access = can(member.subject, 'candidate.card.read', {
			show: { allowed: true, projection: item.projection, extras: item.extras, policyVersion: 'catalog' }
		});
		if (!access.allowed) throw new ApiError('forbidden');
		const card = await cardOf(ctx, member.companyId, item);
		await recordAuditEvent(ctx.services.db, {
			action: 'card.viewed',
			outcome: 'success',
			actor: member.audit,
			subjectCandidateId: item.candidateId,
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			details: { pseudonym: item.pseudonym, projection: 'catalog' }
		});
		return { ...card, match: item.match && matchView(item.match) };
	}
});

export const getVacancyMatch = defineOperation({
	id: 'getVacancyMatch',
	method: 'GET',
	path: '/vacancies/{vacancy_id}/matches/{pseudonym}',
	tag: TAG,
	summary: 'Соответствие кандидата вакансии',
	description: 'Разложение соответствия и объяснение по одному кандидату под собственную вакансию.',
	auth: 'account',
	permission: 'match.read',
	params: vacancyParams.extend({ pseudonym }),
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Соответствие',
		schema: z.object({ pseudonym, vacancy_id: z.uuid(), match: companyMatch })
	},
	async handle(ctx) {
		const { member, item } = await visibleCandidate(ctx, ctx.params.pseudonym, ctx.params.vacancy_id);
		if (!item.match) throw new Error('a candidate found for a vacancy has a match');
		await recordAuditEvent(ctx.services.db, {
			action: 'match.viewed',
			outcome: 'success',
			actor: member.audit,
			subjectCandidateId: item.candidateId,
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			details: { pseudonym: item.pseudonym, vacancy_id: ctx.params.vacancy_id }
		});
		return { pseudonym: item.pseudonym, vacancy_id: ctx.params.vacancy_id, match: matchView(item.match) };
	}
});

const componentStatus = z.enum(['computed', 'unknown', 'unavailable', 'not_comparable']);

/**
 * The role component of a pair (domain 13.4): the specializations of the vacancy's role against the specializations of
 * the candidate's categories in force.
 */
const comparedRole = z.object({
	status: componentStatus,
	value: z.number().nullable(),
	details: z.object({
		vacancy: key.optional().describe('Роль вакансии'),
		specializations: z
			.array(z.enum(SPECIALIZATION_KEYS))
			.optional()
			.describe('Специализации справочника, к которым относится роль вакансии'),
		candidate: z
			.array(z.enum(SPECIALIZATION_KEYS))
			.optional()
			.describe('Специализации действующих категорий кандидата'),
		basis: z
			.enum(['same_specialization', 'other_specialization'])
			.optional()
			.describe('Категория специализации вакансии или только другой'),
		reason: z
			.string()
			.optional()
			.describe('`category_not_confirmed` — у кандидата нет действующей категории; роль вакансии не распознана')
	})
});

/**
 * The trust component of a pair (domain 13.4): required skills confirmed by FSP or a platform test, those only a public
 * profile attests, and the grade agreement; a trust that is not computed carries only its reason.
 */
const comparedTrust = z.object({
	status: componentStatus,
	value: z.number().nullable(),
	details: z.union([
		z.object({
			direct: z.int().describe('Обязательных навыков, подтверждённых результатом ФСП или тестом платформы'),
			total: z.int(),
			public_profile: z
				.int()
				.describe('Обязательных навыков, подтверждённых только публичным профилем: в доверие не входят'),
			confirmed_coverage: z.number().describe('Доля обязательных, покрытая подтверждениями ФСП или теста по полосе'),
			grade_agreement: z
				.number()
				.nullable()
				.describe('Подтверждённый грейд категории в диапазоне вакансии: 1 — внутри, 0 — вне'),
			grade_agreement_reason: z.enum(['candidate_grade_not_confirmed', 'vacancy_grade_unknown']).optional()
		}),
		z.object({ reason: z.string().describe('Почему доверие не вычислено') })
	])
});

export const compareCatalogCandidates = defineOperation({
	id: 'compareCatalogCandidates',
	method: 'GET',
	path: '/catalog/comparison',
	tag: TAG,
	summary: 'Сравнение кандидатов',
	description:
		'Выбранные кандидаты (от 1 до 10) по требованиям одной собственной вакансии: строка ячеек на кандидата в порядке ' +
		'требований. Кандидатов, которых компания не видит, в ответе нет — как и в поиске.',
	auth: 'account',
	permission: 'match.read',
	query: z.strictObject({
		vacancy_id: z.uuid(),
		pseudonym: z.array(pseudonym).min(1).max(10).describe('Псевдонимы (параметр повторяется)')
	}),
	errors: ['not_found'],
	response: {
		status: 200,
		description: 'Сравнение',
		schema: z.object({
			vacancy_id: z.uuid(),
			requirements: z.array(
				z.union([
					z.object({ kind: z.literal('skill'), requirement: z.enum(['required', 'nice']), skill_key: key }),
					z.object({ kind: z.enum(['grade', 'salary']) })
				])
			),
			candidates: z.array(
				z.object({
					pseudonym,
					score: z.number(),
					coverage: z.number(),
					cells: z.array(
						z.union([
							z.object({
								kind: z.literal('skill'),
								status: z.enum(['confirmed', 'derived', 'claimed', 'missing', 'unavailable']),
								band: z.string().nullable()
							}),
							z.object({
								kind: z.enum(['grade', 'salary']),
								status: z.string(),
								value: z.number().nullable(),
								detail: z.string().nullable()
							})
						])
					),
					role: comparedRole.describe('Роль вакансии против ролей кандидата'),
					trust: comparedTrust.describe('Доверие к оценке: прямые подтверждения и согласованность грейда')
				})
			),
			...searchModeSchema
		})
	},
	async handle(ctx) {
		const member = await catalogMember(ctx);
		const comparison = await compareCandidates(
			matchingDeps(ctx.services),
			member.subject,
			ctx.query.vacancy_id,
			ctx.query.pseudonym,
			ctx.signal
		);
		return {
			vacancy_id: comparison.vacancyId,
			requirements: comparison.requirements.map((requirement) =>
				requirement.kind === 'skill'
					? { kind: requirement.kind, requirement: requirement.requirement, skill_key: requirement.skillKey }
					: requirement
			),
			candidates: comparison.candidates,
			...modeView(comparison.mode)
		};
	}
});

// --- Market of a category -------------------------------------------------------------------------------------------

const indicatorList = (description: string) =>
	z.array(marketFigure).describe(`${description}; пустой список — данных по этой комбинации нет`);

/** Ids of every combination the candidate's categories in force place them in, as the market counts them. */
async function ownCategoryKeyIds(ctx: BaseContext, candidateId: string): Promise<Set<string>> {
	const categories = (await activeCategories(ctx.services.db, [candidateId])).get(candidateId) ?? [];
	return new Set(
		categories.flatMap((category) =>
			categoryKeysOf({ specializations: [category.specialization], grades: [category.grade] }).map(categoryKeyId)
		)
	);
}

export const getCategoryMarket = defineOperation({
	id: 'getCategoryMarket',
	method: 'GET',
	path: '/catalog/market',
	tag: TAG,
	summary: 'Рынок категории',
	description:
		'Три показателя раздельно — ожидания доступных кандидатов, вилки вакансий и внешний ориентир; они не ' +
		'смешиваются и не усредняются. У каждого — выборка, окно, география, налоговая база, метод, пометка «оценка» и ' +
		'статус: меньше порога — `insufficient_data` без числа. Медиана — только для запрошенной комбинации. Ожидания ' +
		'кандидатов — только с действующей категорией, для компании — по тем, кого она видит в каталоге. Вилки вакансий ' +
		'— по специализациям их ролей, внешний ориентир — по опорной роли специализации. Участник допущенной компании ' +
		'читает любую категорию, кандидат — только свою (иначе `403`).',
	auth: 'account',
	permission: 'market.read',
	query: z.strictObject({
		specialization: z.enum(SPECIALIZATION_KEYS).describe('Специализация категории'),
		grade: z.enum(GRADE_KEYS).optional().describe('Грейд категории; без него — специализация целиком')
	}),
	errors: [],
	response: {
		status: 200,
		description: 'Рынок категории',
		schema: z
			.object({
				category_key: marketCategoryKey,
				candidate_expectations: indicatorList('Ожидания доступных кандидатов'),
				vacancy_ranges: indicatorList('Вилки собственных и внешних вакансий за окно'),
				external_reference: indicatorList('Внешний ориентир версии таксономии')
			})
			.meta({ id: 'CategoryMarket' })
	},
	async handle(ctx) {
		const subject = await ctx.subject();
		const now = ctx.services.now();
		const category = categoryKey({ specialization: ctx.query.specialization, grade: ctx.query.grade ?? null });
		const company = can(subject, 'market.read', { ownCategory: false });
		let viewer = null;
		if (company.allowed) {
			viewer = await loadCatalogViewer(ctx.services.db, subject, now);
			if (viewer === null) throw new Error('a member allowed to read the market is not a catalog viewer');
		} else {
			const own =
				subject.candidate !== null && (await ownCategoryKeyIds(ctx, subject.candidate.id)).has(categoryKeyId(category));
			const decision = can(subject, 'market.read', { ownCategory: own });
			if (!decision.allowed) {
				throw new ApiError(decision.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
			}
		}
		const market = await loadCategoryMarket(ctx.services.db, { category, viewer, now });
		const indicators = Object.fromEntries(
			MARKET_INDICATORS.map((indicator) => [indicator, market.indicators[indicator].map(marketFigureView)])
		) as Record<(typeof MARKET_INDICATORS)[number], ReturnType<typeof marketFigureView>[]>;
		return { category_key: market.categoryKey, ...indicators };
	}
});
