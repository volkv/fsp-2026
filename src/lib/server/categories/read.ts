// Reading the category (docs/domain.md, section 12.4): the one function and the one SQL predicate every other module
// uses. Nobody else reads `candidate_categories`: catalog filters, counters, the market, cards, the export, the
// operator and the quality evaluation all go through here, so «has a category» means the same everywhere — a category
// in force (`active`), whatever happened to the profile evidence since (domain 12.4, 12.6).
import { and, asc, desc, eq, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type { PolicyCategory } from '$lib/server/assessments/contract/policy';
import type { Executor } from '$lib/server/db';
import { candidateCategories, CATEGORY_REVOKE_REASONS, CATEGORY_STATUSES } from '$lib/server/db/schema';
import type { CategoryView } from '$lib/server/visibility/projections';

/** A category in force: a specialization and a grade confirmed by a test, with what the test confirmed. */
export interface ActiveCategory {
	id: string;
	candidateId: string;
	specialization: SpecializationKey;
	grade: GradeKey;
	catalogVersion: string;
	/** The grade decision that assigned the category. */
	decisionId: string;
	bankReleaseId: string;
	/** Defining blocks of the grade the test confirmed. */
	confirmedBlocks: string[];
	/** The confirmed stack: skills of the grade's defining blocks and the practice language (domain 12.4). */
	confirmedSkillKeys: string[];
	/** The right to take the next grade at once (domain 12.3); `null` — none or used. */
	confidentUpgradeUntil: Date | null;
	assignedAt: Date;
}

/** Any category of the candidate, in force or not: the history of the screen «Категория и грейд» and the export. */
export interface CategoryRecord extends ActiveCategory {
	status: (typeof CATEGORY_STATUSES)[number];
	endedAt: Date | null;
	revokeReason: (typeof CATEGORY_REVOKE_REASONS)[number] | null;
}

const recordColumns = {
	id: candidateCategories.id,
	candidateId: candidateCategories.candidateId,
	specialization: candidateCategories.specialization,
	grade: candidateCategories.grade,
	catalogVersion: candidateCategories.catalogVersion,
	decisionId: candidateCategories.decisionId,
	bankReleaseId: candidateCategories.bankReleaseId,
	confirmedBlocks: candidateCategories.confirmedBlocks,
	confirmedSkillKeys: candidateCategories.confirmedSkillKeys,
	confidentUpgradeUntil: candidateCategories.confidentUpgradeUntil,
	assignedAt: candidateCategories.assignedAt
};

/**
 * Categories in force of each candidate asked for, oldest assignment first; a candidate without one is absent from the
 * map. Several categories of one candidate belong to different specializations (domain 12.4).
 */
export async function activeCategories(
	executor: Executor,
	candidateIds: readonly string[]
): Promise<Map<string, ActiveCategory[]>> {
	const result = new Map<string, ActiveCategory[]>();
	const ids = [...new Set(candidateIds)];
	if (ids.length === 0) return result;
	const rows = await executor
		.select(recordColumns)
		.from(candidateCategories)
		.where(and(inArray(candidateCategories.candidateId, ids), eq(candidateCategories.status, 'active')))
		.orderBy(asc(candidateCategories.assignedAt), asc(candidateCategories.id));
	for (const row of rows) {
		const list = result.get(row.candidateId);
		if (list) list.push(row);
		else result.set(row.candidateId, [row]);
	}
	return result;
}

/** Every category of the candidate, the latest assignment first. */
export async function categoryHistory(executor: Executor, candidateId: string): Promise<CategoryRecord[]> {
	return executor
		.select({
			...recordColumns,
			status: candidateCategories.status,
			endedAt: candidateCategories.endedAt,
			revokeReason: candidateCategories.revokeReason
		})
		.from(candidateCategories)
		.where(eq(candidateCategories.candidateId, candidateId))
		.orderBy(desc(candidateCategories.assignedAt), desc(candidateCategories.id));
}

/** Narrows «has a category in force»: any of the specializations, any of the grades, all of the confirmed skills. */
export interface CategoryFilter {
	specializations?: readonly SpecializationKey[];
	grades?: readonly GradeKey[];
	/** All of these skills are in the confirmed stack of one category in force. */
	confirmedSkillKeys?: readonly string[];
}

const textArray = (values: readonly string[]) =>
	sql`array[${sql.join(
		values.map((value) => sql`${value}`),
		sql`, `
	)}]::text[]`;

/**
 * SQL condition «the candidate has a category in force [matching the filter]» over the candidate id of the caller's
 * query — a Drizzle column or the column of a raw query's alias (`sql\`c.id\``). An empty list in the filter is a
 * mistake of the caller and throws: it would match nobody silently.
 */
export function categoryPredicate(candidateId: AnyColumn | SQL, filter: CategoryFilter = {}): SQL<boolean> {
	const conditions: SQL[] = [sql`k.candidate_id = ${candidateId}`, sql`k.status = 'active'`];
	const list = (name: string, values: readonly string[] | undefined) => {
		if (values === undefined) return null;
		if (values.length === 0) throw new Error(`category filter ${name} is empty`);
		return values;
	};
	const specializations = list('specializations', filter.specializations);
	if (specializations) conditions.push(sql`k.specialization = any(${textArray(specializations)})`);
	const grades = list('grades', filter.grades);
	if (grades) conditions.push(sql`k.grade = any(${textArray(grades)})`);
	const skills = list('confirmedSkillKeys', filter.confirmedSkillKeys);
	if (skills) conditions.push(sql`k.confirmed_skill_keys @> ${textArray(skills)}`);
	return sql<boolean>`exists (select 1 from ${candidateCategories} k where ${sql.join(conditions, sql` and `)})`;
}

/**
 * The categories in force as rows of a subquery (`candidate_id`, `specialization`, `grade`, `confirmed_skill_keys`,
 * `assigned_at`) for aggregates that group by category — counters, the market, the funnel. The same rows
 * `activeCategories` reads.
 */
export const activeCategoryRows: SQL = sql`(select candidate_id, specialization, grade, confirmed_skill_keys, assigned_at
	from ${candidateCategories} where status = 'active')`;

/** A category in force as the cards show it (domain 14), latest assignment first. */
export function categoryViews(categories: readonly ActiveCategory[]): CategoryView[] {
	return [...categories]
		.sort((a, b) => b.assignedAt.getTime() - a.assignedAt.getTime() || (a.id < b.id ? -1 : 1))
		.map((category) => ({
			specialization: category.specialization,
			grade: category.grade,
			confirmedBlocks: category.confirmedBlocks,
			confirmedSkillKeys: category.confirmedSkillKeys,
			assignedOn: category.assignedAt.toISOString().slice(0, 10),
			bankReleaseId: category.bankReleaseId
		}));
}

/** The candidate a category belongs to, whatever its status; `null` — no such category (removed with the account). */
export async function categoryOwner(executor: Executor, categoryId: string): Promise<string | null> {
	const [row] = await executor
		.select({ candidateId: candidateCategories.candidateId })
		.from(candidateCategories)
		.where(eq(candidateCategories.id, categoryId));
	return row?.candidateId ?? null;
}

/** The category in force of one specialization as the grade policy sees it (domain 12.3); `null` — none. */
export async function policyCategory(
	executor: Executor,
	candidateId: string,
	specialization: SpecializationKey
): Promise<PolicyCategory | null> {
	const [row] = await executor
		.select({
			grade: candidateCategories.grade,
			assignedAt: candidateCategories.assignedAt,
			confidentUpgradeUntil: candidateCategories.confidentUpgradeUntil
		})
		.from(candidateCategories)
		.where(
			and(
				eq(candidateCategories.candidateId, candidateId),
				eq(candidateCategories.specialization, specialization),
				eq(candidateCategories.status, 'active')
			)
		);
	return row ?? null;
}
