// Schemas shared by the operations of the public API: identifiers, pages, money and the error envelope. Every schema
// that names a reusable object carries an `id`: the document lists it once under `components.schemas`.
import { z } from 'zod';
import { API_ERRORS } from '$lib/server/errors/codes';
import { paginate, queryFingerprint, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '$lib/server/matching/page';
import { SALARY_PERIODS, SALARY_TAX_BASES } from '$lib/server/db/schema/_columns';
import type { MarketFigure } from '$lib/server/market/read';

export const id = (description: string) => z.uuid().describe(description);

/** Candidate pseudonym for one company: 128 bits in base32 (domain 14). */
export const pseudonym = z
	.string()
	.regex(/^[a-z2-7]{26}$/u)
	.describe('Псевдоним кандидата для вашей компании; у разных компаний он разный')
	.meta({ examples: ['k7q2x4m5n6p7r2s3t4v5w6x7yz'] });

export const dateTime = z.iso.datetime().describe('Момент времени, ISO 8601 в UTC');
export const date = z.iso.date().describe('Дата, YYYY-MM-DD');

/** A key of the taxonomy: role, grade, skill, format. */
export const key = z.string().regex(/^[a-z0-9_]+$/u);

export const pageQuery = {
	cursor: z
		.string()
		.min(1)
		.max(1024)
		.optional()
		.describe('Курсор следующей страницы из `next_cursor` предыдущего ответа; выдаётся для того же запроса'),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_PAGE_SIZE)
		.default(DEFAULT_PAGE_SIZE)
		.describe(`Размер страницы, до ${MAX_PAGE_SIZE}`)
};

export const nextCursor = z.string().nullable().describe('Курсор следующей страницы; `null` — страниц больше нет');

export function page<T extends z.ZodType>(item: T) {
	return z.object({ items: z.array(item), next_cursor: nextCursor });
}

/**
 * A page of a list ordered on the server. The cursor is bound to the query it was issued for (the query without its
 * cursor and limit): a cursor from another query is a validation error.
 */
export function pageOf<T>(
	all: readonly T[],
	query: { cursor?: string | undefined; limit: number },
	fingerprintOf: unknown
): { items: T[]; next_cursor: string | null } {
	const result = paginate(
		all,
		{ limit: query.limit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
		queryFingerprint(fingerprintOf)
	);
	return { items: result.items, next_cursor: result.nextCursor };
}

export const salaryPeriod = z.enum(SALARY_PERIODS).describe('Период: месяц, год, час, проект');
export const taxBase = z
	.enum(SALARY_TAX_BASES)
	.describe('Налоговая база: `gross` — до вычета НДФЛ, `net` — на руки, `unknown` — не указано');

/** A range as known: one or both bounds may be unknown («не указано»), never zero in their place. */
export const salaryRange = z
	.object({
		min: z.int().nullable().describe('Нижняя граница; `null` — не указана'),
		max: z.int().nullable().describe('Верхняя граница; `null` — не указана'),
		currency: z.string().nullable().describe('Код валюты ISO 4217'),
		period: salaryPeriod.nullable(),
		tax_base: taxBase.nullable()
	})
	.meta({ id: 'SalaryRange', description: 'Вилка; неизвестные части — `null` («не указано»)' });

/** A full offered range in the unit of the vacancy (domain 13.5). */
export const offeredSalary = z
	.object({
		min: z.int(),
		max: z.int(),
		currency: z.string(),
		period: salaryPeriod,
		tax_base: z.enum(['gross', 'net'])
	})
	.meta({ id: 'OfferedSalary', description: 'Предложенная вилка в единицах вакансии' });

export const errorDetail = z
	.object({
		path: z.string().optional().describe('Поле запроса, к которому относится замечание'),
		code: z.string().describe('Машинный код замечания'),
		message: z.string().describe('Сообщение для человека')
	})
	.meta({ id: 'ErrorDetail' });

export const errorEnvelope = z
	.object({
		error: z.object({
			code: z.enum(Object.keys(API_ERRORS) as [keyof typeof API_ERRORS, ...(keyof typeof API_ERRORS)[]]),
			message: z.string(),
			request_id: z.string().describe('Совпадает с заголовком `X-Request-Id`'),
			details: z.array(errorDetail).optional()
		})
	})
	.meta({
		id: 'Error',
		description: 'Конверт ошибки (раздел 5.3 контракта)',
		examples: [
			{
				error: {
					code: 'validation_failed',
					message: 'Проверьте поля запроса',
					request_id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
					details: [{ path: 'salary_max', code: 'too_small', message: 'Должно быть не меньше salary_min' }]
				}
			}
		]
	});

const gradeRange = z.object({ min: key, max: key });
const band = z.enum(['weak', 'moderate', 'strong']);
const attestation = z.enum(['direct', 'derived', 'claimed']);
const trust = z.enum(['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed']);

/**
 * `matchScore` of a vacancy and a candidate (domain 13.4). `withFacts` — the candidate's own view: a skill match names
 * the facts it rests on. A company never sees fact ids: its schema has no such member, so they are dropped.
 */
function matchSchema(withFacts: boolean) {
	const skillMatch = z.object({
		kind: z.literal('skill'),
		requirement: z.enum(['required', 'nice']),
		skill_key: key,
		band,
		attestation,
		badge_trust: trust.nullable(),
		...(withFacts ? { fact_ids: z.array(z.uuid()) } : {})
	});
	const component = z.object({
		value: z.number().nullable(),
		weight: z.number(),
		status: z.enum(['computed', 'unknown', 'unavailable', 'not_comparable']),
		details: z.unknown().describe('Подробности компонента: навыки, диапазоны, причина недоступности')
	});
	return z
		.object({
			score: z
				.number()
				.describe(
					'Взвешенное среднее посчитанных компонентов; без действующего расчёта категоризации обязательные, желательные навыки и доверие входят как неподтверждённые'
				),
			coverage: z.number().describe('Доля веса правил, которая посчитана'),
			components: z
				.record(z.string(), component)
				.describe('`required`, `nice`, `role`, `trust`, `grade`, `salary`, `semantic`, `reranker`'),
			explanation: z.object({
				matches: z
					.array(
						z.union([
							skillMatch,
							z.object({ kind: z.literal('role'), role_key: key }),
							z.object({ kind: z.literal('grade'), vacancy: gradeRange, candidate: gradeRange }),
							z.object({ kind: z.literal('salary'), comparison: z.enum(['lower', 'equal', 'overlap']) })
						])
					)
					.describe('Что подходит и на чём держится'),
				unknown: z
					.array(z.object({ component: z.string(), status: z.string(), reason: z.string() }))
					.describe('Что неизвестно: не штрафуется, а объясняется'),
				to_verify: z
					.array(z.object({ code: z.string(), skill_key: key.optional() }))
					.describe('Что проверить на собеседовании'),
				gaps: z
					.array(z.object({ code: z.string(), skill_key: key.optional(), steps: z.int().optional() }))
					.describe('Чего не хватает и что подтянуть')
			})
		})
		.meta({
			id: withFacts ? 'OwnMatch' : 'Match',
			description: withFacts
				? 'Соответствие вакансии глазами кандидата — со своими фактами'
				: 'Соответствие вакансии: оценка, компоненты и объяснение (domain 13.4)'
		});
}

export const companyMatch = matchSchema(false);
export const candidateMatch = matchSchema(true);

export const iso = (value: Date): string => value.toISOString();
export const isoOrNull = (value: Date | null): string | null => (value === null ? null : value.toISOString());

// --- Market figures --------------------------------------------------------------------------------------------------

export const marketCategoryKey = z
	.object({ role_key: key, grade_key: key.optional(), stack_skill_keys: z.array(key).optional() })
	.meta({ id: 'MarketCategoryKey', description: 'Комбинация роль × грейд × стек, по которой собраны данные' });

/** The unit, method and origin every market figure carries. */
const figureBasis = {
	geography: z.string().describe('`ru` — вся Россия, код региона или `remote`'),
	currency: z.string(),
	period: salaryPeriod,
	tax_base: taxBase.describe('Налоговая база показателя: у каждой базы своя строка, `gross` и `net` не смешиваются'),
	method: z.string().describe('`observed_median`, `observed_median_from`, `estimated_stack_adjustment`, …'),
	estimated: z.boolean().describe('Расчётная поправка, а не наблюдение по этой комбинации: подпись «оценка»'),
	provenance: z
		.enum(['live', 'synthetic', 'mixed'])
		.describe('`synthetic` — собрано на демо-данных и рынком не является'),
	window: z.object({ from: date, to: date }).describe('Период данных'),
	computed_at: dateTime
};

const observedValues = { sample_size: z.int(), median: z.number(), p25: z.number(), p75: z.number() };

export const marketFigure = z
	.discriminatedUnion('status', [
		z.object({ category_key: marketCategoryKey, ...figureBasis, status: z.literal('ok'), ...observedValues }),
		z.object({
			category_key: marketCategoryKey,
			...figureBasis,
			status: z.literal('insufficient_data').describe('Выборка меньше порога: число не показывается'),
			sample_size: z
				.int()
				.nullable()
				.describe('`null` — число кандидатов ниже порога не раскрывается, только «< threshold»'),
			threshold: z.int()
		})
	])
	.meta({ id: 'MarketFigure', description: 'Показатель рынка со своей выборкой, окном, налоговой базой и методом' });

/** A figure with enough data, without its combination: the comparison that names it states the combination. */
export const observedMarketFigure = z
	.object({ ...observedValues, ...figureBasis })
	.meta({ id: 'ObservedMarketFigure', description: 'Показатель рынка с достаточной выборкой' });

function figureBasisView(figure: MarketFigure) {
	return {
		geography: figure.geography,
		currency: figure.currency,
		period: figure.period,
		tax_base: figure.taxBase,
		method: figure.method,
		estimated: figure.estimated,
		provenance: figure.provenance,
		window: figure.window,
		computed_at: iso(figure.computedAt)
	};
}

export function observedMarketFigureView(figure: Extract<MarketFigure, { status: 'ok' }>) {
	return {
		sample_size: figure.sampleSize,
		median: figure.median,
		p25: figure.p25,
		p75: figure.p75,
		...figureBasisView(figure)
	};
}

export function marketFigureView(figure: MarketFigure) {
	return figure.status === 'ok'
		? { category_key: figure.categoryKey, status: figure.status, ...observedMarketFigureView(figure) }
		: {
				category_key: figure.categoryKey,
				...figureBasisView(figure),
				status: figure.status,
				sample_size: figure.sampleSize,
				threshold: figure.threshold
			};
}
