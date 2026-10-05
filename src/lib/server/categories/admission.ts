// Which categories a vacancy admits, and which candidates hold one (docs/domain.md, sections 12.7, 12.10, 13.10): the
// category path of the product — a vacancy or a need → the categories it admits → the candidates with a category in
// force among them → the ranking. A candidate without a category is not among the admitted ones: it stays in the base
// and is listed apart («категория не подтверждена»), never ranked in a category output.
import { sql } from 'drizzle-orm';
import { GRADE_KEYS, type GradeKey, type SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type { Executor } from '$lib/server/db';
import { categoryPredicate } from './read';
import { specializationsOfRole } from './roles';

/** The categories a vacancy admits: its role's specializations and the catalog grades of its range. */
export interface AdmittedCategories {
	specializations: readonly SpecializationKey[];
	/** `null` — the vacancy states no grade: every grade of the specializations. */
	grades: readonly GradeKey[] | null;
}

/**
 * The categories of a vacancy: the specializations of its role (domain 12.10) and the grades of the catalog inside its
 * range of the taxonomy scale. `null` — the vacancy has no role, its role is of no specialization, or its range holds
 * no grade a test confirms (a Lead vacancy): no category admits anybody.
 */
export function admittedCategories(
	vacancy: { roleKey: string | null; grade: { min: string; max: string } | null },
	gradeOrdinals: ReadonlyMap<string, number>
): AdmittedCategories | null {
	if (vacancy.roleKey === null) return null;
	const specializations = specializationsOfRole(vacancy.roleKey);
	if (specializations.length === 0) return null;
	if (vacancy.grade === null) return { specializations, grades: null };
	const ordinal = (key: string) => {
		const value = gradeOrdinals.get(key);
		if (value === undefined) throw new Error(`grade ${key} is not in the taxonomy version`);
		return value;
	};
	const low = ordinal(vacancy.grade.min);
	const high = ordinal(vacancy.grade.max);
	const grades = GRADE_KEYS.filter((grade) => {
		const value = gradeOrdinals.get(grade);
		return value !== undefined && value >= low && value <= high;
	});
	return grades.length === 0 ? null : { specializations, grades };
}

export interface Admission {
	/** Candidates with a category in force the vacancy admits, in the order asked. */
	admitted: string[];
	/** Candidates without any category in force: in the base, «категория не подтверждена». */
	unconfirmed: string[];
}

/**
 * Splits the candidates by the admitted categories: those holding one of them, and those holding none at all. A
 * candidate with only categories the vacancy does not admit is in neither list.
 */
export async function admitCandidates(
	executor: Executor,
	candidateIds: readonly string[],
	admitted: AdmittedCategories | null
): Promise<Admission> {
	if (candidateIds.length === 0) return { admitted: [], unconfirmed: [] };
	const ids = sql`array[${sql.join(
		candidateIds.map((id) => sql`${id}::uuid`),
		sql`, `
	)}]`;
	const fits =
		admitted === null
			? sql`false`
			: categoryPredicate(sql`c.id`, {
					specializations: admitted.specializations,
					...(admitted.grades === null ? {} : { grades: admitted.grades })
				});
	const rows = await executor.execute<{ id: string; fits: boolean; categorized: boolean }>(sql`
		select c.id::text as id, ${fits} as fits, ${categoryPredicate(sql`c.id`)} as categorized
		from unnest(${ids}) as c(id)
	`);
	const state = new Map(rows.map((row) => [row.id, row]));
	return {
		admitted: candidateIds.filter((id) => state.get(id)?.fits === true),
		unconfirmed: candidateIds.filter((id) => state.get(id)?.categorized === false)
	};
}
