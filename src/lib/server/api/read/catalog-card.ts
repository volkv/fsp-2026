// The candidate card in the catalog projection as the API shows it (domain 14): the one DTO of the company's view with
// the fields renamed, shared by the catalog and the pool of a competition partner. Fact ids are not part of it.
import { z } from 'zod';
import type { CategoryExplanationView, EmployerCard } from '$lib/server/employer/card';
import { date, key, pseudonym, salaryRange } from '../schemas';

const insufficient = z.object({ status: z.literal('insufficient_data') });

const categorySchema = z
	.object({
		rank: z.enum(['primary', 'secondary']),
		role: z.union([z.object({ status: z.literal('established'), key }), insufficient]),
		grade: z.union([z.object({ status: z.literal('established'), min: key, max: key }), insufficient]),
		stack: z.union([z.object({ status: z.literal('established'), skill_keys: z.array(key) }), insufficient]),
		explanation: z.object({
			role: z.union([
				z.object({
					score: z.number(),
					unconfirmed_core_groups: z.array(z.array(key)).describe('Группы ключевых навыков роли без подтверждения')
				}),
				z.object({ missing: z.array(z.string()) })
			]),
			grade: z.object({
				confidence: z.number().nullable(),
				signals: z.array(z.string()).describe('Производственные сигналы, на которых стоит грейд'),
				ignored: z
					.array(z.string())
					.describe('Доказательства, которые по правилам не двигают грейд: результаты ФСП, разряды, роли в команде'),
				missing: z.array(z.string()),
				next_grade: z.object({ target: key, requirements: z.array(z.string()) }).nullable()
			}),
			stack: z.object({ missing: z.array(z.string()) })
		})
	})
	.meta({
		id: 'CatalogCategory',
		description: 'Категория по трём независимым осям; неустановленная ось — «недостаточно данных»'
	});

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
		category_state: z
			.enum(['available', 'recalculating', 'none'])
			.describe('`recalculating` — доказательства изменились, категория пересчитывается; `none` — категории нет'),
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
		categories: z.array(categorySchema),
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
		category_state: loaded.categoryState,
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
		categories: card.categories.map((category) => {
			const explanation = category.explanation as CategoryExplanationView;
			return {
				rank: category.rank,
				role: category.role,
				grade: category.grade,
				stack:
					category.stack.status === 'established'
						? { status: category.stack.status, skill_keys: category.stack.skillKeys }
						: category.stack,
				explanation: {
					role:
						'missing' in explanation.role
							? { missing: explanation.role.missing }
							: {
									score: explanation.role.score,
									unconfirmed_core_groups: explanation.role.unconfirmedCoreGroups
								},
					grade: {
						confidence: explanation.grade.confidence,
						signals: explanation.grade.signals,
						ignored: explanation.grade.ignored,
						missing: explanation.grade.missing,
						next_grade: explanation.grade.nextGrade
					},
					stack: explanation.stack
				}
			};
		}),
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
			const { discipline, competitionLevel, season, resultGroup, format, computedIndicator } = achievement.generalized;
			if (discipline === undefined || competitionLevel === undefined) {
				throw new Error('a catalog achievement lacks its discipline or competition level');
			}
			return {
				generalized: {
					discipline,
					competition_level: competitionLevel,
					season,
					result_group: resultGroup,
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
