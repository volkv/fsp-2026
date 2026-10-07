// The declarations in force (docs/domain.md, section 12.2): of each specialization the candidate declared a grade in,
// the latest declaration. A declaration is the candidate's own word: the shortlist reads it only as a filter and a
// label of the group «грейд не подтверждён» (13.10), never as evidence of the grade.
import { inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { categoryPredicate } from '$lib/server/categories/read';
import type { Executor } from '$lib/server/db';
import { gradeDeclarations } from '$lib/server/db/schema';

export interface DeclaredCategory {
	specialization: SpecializationKey;
	grade: GradeKey;
}

/** Candidate id → the declaration in force of each specialization, by specialization. */
export async function currentDeclarations(
	executor: Executor,
	candidateIds: readonly string[]
): Promise<Map<string, DeclaredCategory[]>> {
	const result = new Map<string, DeclaredCategory[]>();
	if (candidateIds.length === 0) return result;
	const rows = await executor
		.selectDistinctOn([gradeDeclarations.candidateId, gradeDeclarations.specialization], {
			candidateId: gradeDeclarations.candidateId,
			specialization: gradeDeclarations.specialization,
			grade: gradeDeclarations.grade
		})
		.from(gradeDeclarations)
		.where(inArray(gradeDeclarations.candidateId, [...new Set(candidateIds)]))
		.orderBy(
			gradeDeclarations.candidateId,
			gradeDeclarations.specialization,
			sql`${gradeDeclarations.declaredAt} desc`,
			sql`${gradeDeclarations.id} desc`
		);
	for (const row of rows) {
		const list = result.get(row.candidateId) ?? [];
		list.push({ specialization: row.specialization, grade: row.grade });
		result.set(row.candidateId, list);
	}
	return result;
}

/**
 * SQL condition «the declaration in force of the specialization names one of the grades» over the candidate id of the
 * caller's query. An empty list of grades is a mistake of the caller and throws.
 */
function declaredPredicate(
	candidateId: AnyColumn | SQL,
	specialization: SpecializationKey,
	grades: readonly GradeKey[]
): SQL<boolean> {
	if (grades.length === 0) throw new Error('a declaration predicate names no grade');
	return sql<boolean>`exists (select 1 from (select d.grade from ${gradeDeclarations} d
		where d.candidate_id = ${candidateId} and d.specialization = ${specialization}
		order by d.declared_at desc, d.id desc limit 1) latest
		where latest.grade in (${sql.join(
			grades.map((grade) => sql`${grade}`),
			sql`, `
		)}))`;
}

/**
 * SQL condition of the group «грейд не подтверждён» of these categories (domain 13.10): for a specialization of the
 * pairs, no category in force of it and the declaration in force of it naming one of the pairs. A category of another
 * grade of the same specialization keeps the candidate out: their grade there is confirmed.
 */
export function declaredWithoutCategory(
	candidateId: AnyColumn | SQL,
	pairs: readonly DeclaredCategory[]
): SQL<boolean> {
	if (pairs.length === 0) throw new Error('the group «грейд не подтверждён» is of no category');
	const specializations = [...new Set(pairs.map((pair) => pair.specialization))];
	return sql<boolean>`(${sql.join(
		specializations.map(
			(specialization) =>
				sql`(${declaredPredicate(
					candidateId,
					specialization,
					pairs.filter((pair) => pair.specialization === specialization).map((pair) => pair.grade)
				)} and not ${categoryPredicate(candidateId, { specializations: [specialization] })})`
		),
		sql` or `
	)})`;
}

/** SQL expression: the moment of the latest declaration of the candidate, any specialization; `null` — none. */
export function lastDeclaredAt(candidateId: AnyColumn | SQL): SQL<string | null> {
	return sql<string | null>`(select max(d.declared_at)::text from ${gradeDeclarations} d
		where d.candidate_id = ${candidateId})`;
}
