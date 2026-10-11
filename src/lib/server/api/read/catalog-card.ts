// The candidate card in the catalog projection as the API shows it (domain 14): the one DTO of the company's view with
// the fields renamed, shared by the catalog and the pool of a competition partner. Fact ids are not part of it.
import { z } from 'zod';
import { GRADE_KEYS, SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import type { CategorySignals, SignalSummary } from '$lib/server/assessments/signals';
import type { EmployerCard } from '$lib/server/employer/card';
import type { CategoryView } from '$lib/server/visibility/projections';
import { date, key, pseudonym, salaryRange } from '../schemas';

const count = z.int().min(0);

/** The totals of the signal journal of the attempt behind a category (domain 10.7); no entries, no item timings. */
const testSignalsSchema = z
	.object({
		entries: count.describe('Записей журнала: ответы, отправки решений и шаги «измени своё решение»'),
		pastes: count.describe('Вставок из буфера обмена за попытку'),
		pasted_chars: count.describe('Вставлено символов за попытку'),
		departures: count.describe('Уходов со страницы теста за попытку'),
		silent: count.describe('Записей, к которым страница не передала сигналы (скрипты отключены)'),
		foreign_answers: count.describe(
			'Неверных ответов, которые верны для экземпляра того же семейства у другого кандидата'
		)
	})
	.meta({
		id: 'TestSignals',
		description:
			'Сводка журнала сигналов попытки, назначившей категорию. Не приговор: повод уточнить на собеседовании; ' +
			'тест сигналы не учитывает, категория назначена по баллам заданий. Это не обнаружение заимствованного кода'
	});

function testSignalsView(summary: SignalSummary) {
	return {
		entries: summary.entries,
		pastes: summary.pastes,
		pasted_chars: summary.pastedChars,
		departures: summary.departures,
		silent: summary.silent,
		foreign_answers: summary.foreignAnswers
	};
}

/** A category in force as the API shows it (domain 12.4). */
export const categorySchema = z
	.object({
		specialization: z.enum(SPECIALIZATION_KEYS),
		grade: z.enum(GRADE_KEYS),
		confirmed_blocks: z.array(z.string()).describe('Определяющие блоки грейда, подтверждённые тестом'),
		confirmed_skill_keys: z
			.array(key)
			.describe(
				'Подтверждённый стек: навыки определяющих блоков грейда и язык практики; заявленный стек сюда не входит'
			),
		assigned_on: date,
		bank_release_id: z.string().describe('Выпуск банка заданий решения — версия основания'),
		test_signals: testSignalsSchema
	})
	.meta({
		id: 'Category',
		description: 'Действующая категория: специализация и грейд, подтверждённые тестом'
	});

/** The API form of a category of a card, with the signal totals of its attempt. */
function categoryView(category: CategoryView, signals: readonly CategorySignals[]) {
	const own = signals.find((entry) => entry.specialization === category.specialization);
	if (!own) throw new Error(`card category ${category.specialization} has no signal totals`);
	return {
		specialization: category.specialization,
		grade: category.grade,
		confirmed_blocks: category.confirmedBlocks,
		confirmed_skill_keys: category.confirmedSkillKeys,
		assigned_on: category.assignedOn,
		bank_release_id: category.bankReleaseId,
		test_signals: testSignalsView(own.summary)
	};
}

const receiptSchema = z
	.object({
		handle: z.string().describe('Публичный идентификатор: проверка — `GET /api/v1/verify/{handle}`'),
		level: z.enum(['generalized', 'exact']),
		status: z.enum(['valid', 'superseded', 'annulled', 'not_valid']),
		verified_at: z.string(),
		asserts: z.record(z.string(), z.union([z.string(), z.number()])),
		does_not_assert: z.array(z.string()),
		signing_key_id: z.string(),
		source_simulator: z
			.boolean()
			.describe(
				'`true` — факт получен от демонстрационного имитатора ФСП, а не от федерации (под подписью — ' +
					'`statement.source_simulator` в `GET /api/v1/verify/{handle}`)'
			)
	})
	.meta({ id: 'CardReceipt', description: 'Квитанция проверки, выданная вашей компании' });

const monthsRange = z.object({ min_months: z.int(), max_months: z.int() });

export const cardSchema = z
	.object({
		pseudonym,
		projection: z.literal('catalog'),
		evidence_state: z
			.enum(['available', 'recalculating', 'none'])
			.describe(
				'Доказательства профиля (навыки, уровни ФСП): `recalculating` — изменились и пересчитываются; `none` — ' +
					'расчёта ещё не было. Категорию не затрагивает'
			),
		is_minor: z.boolean(),
		region: z
			.string()
			.nullable()
			.describe('Код субъекта РФ из справочника регионов (ISO 3166-2:RU); его принимает фильтр `region_code`'),
		region_name: z.string().nullable().describe('Название субъекта РФ по тому же справочнику'),
		preferences: z.object({
			work_formats: z.array(key),
			employment_forms: z.array(key),
			relocation: z.boolean().nullable(),
			search_status: z.enum(['active', 'open_to_offers', 'not_looking']),
			salary_expectation: salaryRange.nullable()
		}),
		categories: z
			.array(categorySchema)
			.describe('Действующие категории; пусто — категория не подтверждена (кандидат найден поиском по всей базе)'),
		desired_role_keys: z.array(key),
		fsp_levels: z.array(z.object({ discipline: z.string(), level: z.string(), last_result_on: date.nullable() })),
		skills: z.array(
			z.object({
				skill_key: key,
				strength_band: z.enum(['weak', 'moderate', 'strong']),
				attestation: z.enum(['direct', 'derived', 'claimed']),
				badge_trust: z.string().nullable()
			})
		),
		fsp_achievements: z.array(
			z.object({
				generalized: z
					.object({
						discipline: z.string(),
						competition_level: z.string(),
						season: z.int().optional(),
						result_group: z.string().optional(),
						team_result: z
							.boolean()
							.optional()
							.describe('Результат команды, а не личный: командная победа не подтверждает личный вклад'),
						format: z.string().optional(),
						computed_indicator: z.string().nullable().optional()
					})
					.describe('Обобщённо: для 14–17 лет — только дисциплина и уровень соревнования'),
				exact: z
					.object({
						competition_ref: z.string(),
						competition_title: z.string(),
						stage: z.string().nullable(),
						place: z.int().nullable(),
						team: z.object({ name: z.string(), role: z.string().nullable() }).nullable(),
						protocol_url: z.string().nullable()
					})
					.optional()
					.describe('Точно — только если кандидат 18+ открыл точные достижения'),
				preliminary: z
					.boolean()
					.describe('Предварительный результат: ФСП опубликовала его, но он ещё не официальный — пока не достижение'),
				receipt_handles: z.array(z.string()).describe('Квитанции этого достижения из `receipts`')
			})
		),
		receipts: z.array(receiptSchema),
		experience: z.array(
			z.object({
				role_key: key.nullable(),
				duration: monthsRange.nullable(),
				applied_skill_keys: z.array(key)
			})
		),
		experience_summary: z.object({ total: monthsRange, by_role: z.record(z.string(), monthsRange) }).nullable(),
		external_profiles: z.array(
			z.object({ platform: z.enum(['codeforces', 'github']), handle: z.string(), verified: z.boolean() })
		)
	})
	.meta({ id: 'CatalogCard', description: 'Карточка кандидата в проекции каталога (domain 14)' });

type Card = EmployerCard['card'];

const catalogBlocks = [
	'pseudonym',
	'isMinor',
	'region',
	'regionName',
	'preferences',
	'categories',
	'desiredRoleKeys',
	'fspLevels',
	'skills',
	'fspAchievements',
	'experience',
	'experienceSummary',
	'externalProfiles'
] as const;

type CatalogExperience = Required<
	Pick<NonNullable<Card['experience']>[number], 'roleKey' | 'duration' | 'appliedSkillKeys'>
>;

/** The blocks the catalog projection always fills (`projectCandidate`); a card without one of them is a defect. */
type CatalogCard = Required<Pick<Card, Exclude<(typeof catalogBlocks)[number], 'experience'>>> & {
	experience: CatalogExperience[];
};

function catalogCard(card: Card): CatalogCard {
	const lacking = catalogBlocks.filter((block) => card[block] === undefined);
	if (card.projection !== 'catalog' || lacking.length > 0) {
		throw new Error(`a ${card.projection} card lacks the catalog blocks: ${lacking.join(', ')}`);
	}
	const incomplete = card.experience?.some(
		(entry) => entry.roleKey === undefined || entry.duration === undefined || entry.appliedSkillKeys === undefined
	);
	if (incomplete) throw new Error('a catalog experience entry lacks its role, duration or applied skills');
	return card as CatalogCard;
}

export function cardView(loaded: EmployerCard) {
	const card = catalogCard(loaded.card);
	const preferences = card.preferences;
	const salary = preferences.salaryExpectation;
	return {
		pseudonym: card.pseudonym,
		projection: 'catalog' as const,
		evidence_state: loaded.evidenceState,
		is_minor: card.isMinor,
		region: card.region,
		region_name: card.regionName,
		preferences: {
			work_formats: preferences.workFormats,
			employment_forms: preferences.employmentForms,
			relocation: preferences.relocation,
			search_status: preferences.searchStatus,
			salary_expectation: salary && {
				min: salary.min,
				max: salary.max,
				currency: salary.currency,
				period: salary.period,
				tax_base: salary.taxBase
			}
		},
		categories: card.categories.map((category) => categoryView(category, loaded.signals)),
		desired_role_keys: card.desiredRoleKeys,
		fsp_levels: card.fspLevels.map((level) => ({
			discipline: level.discipline,
			level: level.level,
			last_result_on: level.lastResultOn
		})),
		skills: card.skills.map((skill) => ({
			skill_key: skill.skillKey,
			strength_band: skill.strengthBand,
			attestation: skill.attestation,
			badge_trust: skill.badgeTrust
		})),
		fsp_achievements: card.fspAchievements.map((achievement) => {
			const { discipline, competitionLevel, season, resultGroup, teamResult, format, computedIndicator } =
				achievement.generalized;
			if (discipline === undefined || competitionLevel === undefined) {
				throw new Error('a catalog achievement lacks its discipline or competition level');
			}
			return {
				generalized: {
					discipline,
					competition_level: competitionLevel,
					season,
					result_group: resultGroup,
					team_result: teamResult,
					format,
					computed_indicator: computedIndicator
				},
				...('exact' in achievement
					? {
							exact: {
								competition_ref: achievement.exact.competitionRef,
								competition_title: achievement.exact.competitionTitle,
								stage: achievement.exact.stage,
								place: achievement.exact.place,
								team: achievement.exact.team,
								protocol_url: achievement.exact.protocolUrl
							}
						}
					: {}),
				preliminary: achievement.preliminary,
				receipt_handles: achievement.receiptHandles
			};
		}),
		receipts: loaded.receipts.map((receipt) => ({
			handle: receipt.handle,
			level: receipt.level,
			status: receipt.status,
			verified_at: receipt.verifiedAt,
			asserts: receipt.asserts,
			does_not_assert: receipt.doesNotAssert,
			signing_key_id: receipt.signingKeyId,
			source_simulator: receipt.simulator
		})),
		experience: card.experience.map((entry) => ({
			role_key: entry.roleKey,
			duration: entry.duration ? { min_months: entry.duration.minMonths, max_months: entry.duration.maxMonths } : null,
			applied_skill_keys: entry.appliedSkillKeys
		})),
		experience_summary: card.experienceSummary
			? {
					total: {
						min_months: card.experienceSummary.total.minMonths,
						max_months: card.experienceSummary.total.maxMonths
					},
					by_role: Object.fromEntries(
						Object.entries(card.experienceSummary.byRole).map(([role, range]) => [
							role,
							{ min_months: range.minMonths, max_months: range.maxMonths }
						])
					)
				}
			: null,
		external_profiles: card.externalProfiles
	};
}
