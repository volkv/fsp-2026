// Records the category market is computed from (docs/domain.md, section 12.8): salary expectations of catalog
// candidates by their categories in force, salary ranges of own published and fresh external vacancies by the
// specializations of their roles (domain 12.10), and the external salary reference of the published taxonomy version. Clones of demo sessions and the
// vacancies of their companies are not counted: they copy the cast, which is counted already (domain 19.3).
import { eq, sql } from 'drizzle-orm';
import { parsePreferences, salaryExpectation } from '$lib/server/candidates/preferences';
import type { Executor } from '$lib/server/db';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import { activeCategoryRows } from '$lib/server/categories/read';
import { specializationsOfRole } from '$lib/server/categories/roles';
import { candidateAt, listedInCatalog } from '$lib/server/db/conditions';
import { salaryReferences } from '$lib/server/db/schema';
import { companySession, outsideDemoSessions } from '$lib/server/demo/scope';
import { loadGradeOrdinals } from '$lib/server/matching/evidence';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';
import type { SalaryTerms } from '$lib/server/salary/compare';
import { catalogGradesBetween, categoryKeysOf, type CategoryKey } from './aggregate';

export interface CandidateRecord {
	candidateId: string;
	synthetic: boolean;
	salary: SalaryTerms;
	/** Keys of every category in force of the candidate. */
	keys: CategoryKey[];
}

interface CategoryRow extends Record<string, unknown> {
	candidate_id: string;
	preferences: unknown;
	seed_batch_id: string | null;
	specialization: SpecializationKey;
	grade: GradeKey;
}

/**
 * Candidates the catalog may show at all (active, in the catalog, looking) with a salary expectation, each with the
 * keys of their categories in force (domain 12.8); a candidate without a category counts in no market. Whether a given
 * viewer sees them is decided by the caller with `canShow`. `specialization` narrows the read to one specialization.
 */
export async function loadCandidateRecords(
	executor: Executor,
	specialization?: SpecializationKey
): Promise<CandidateRecord[]> {
	const rows = await executor.execute<CategoryRow>(sql`
		select c.id::text as candidate_id, c.preferences, c.seed_batch_id, k.specialization, k.grade
		from candidates c
		join ${activeCategoryRows} k on k.candidate_id = c.id
		where ${listedInCatalog(candidateAt('c'))}
			and c.preferences ? 'salary_expectation' and ${outsideDemoSessions(sql`c.demo_session_id`)}
			${specialization === undefined ? sql`` : sql`and k.specialization = ${specialization}`}
	`);
	const records = new Map<string, CandidateRecord>();
	for (const row of rows) {
		const salary = salaryExpectation(parsePreferences(row.candidate_id, row.preferences));
		if (salary === null) continue;
		const record = records.get(row.candidate_id) ?? {
			candidateId: row.candidate_id,
			synthetic: row.seed_batch_id !== null,
			salary,
			keys: []
		};
		record.keys.push(...categoryKeysOf({ specializations: [row.specialization], grades: [row.grade] }));
		records.set(row.candidate_id, record);
	}
	return [...records.values()];
}

export interface VacancyRecord {
	vacancyId: string;
	origin: 'own' | 'external';
	synthetic: boolean;
	salary: SalaryTerms;
	keys: CategoryKey[];
}

interface VacancyRow extends Record<string, unknown> {
	id: string;
	origin: 'own' | 'external';
	seed_batch_id: string | null;
	taxonomy_version_id: string;
	role_key: string;
	grade_min: string | null;
	grade_max: string | null;
	salary_min: number | null;
	salary_max: number | null;
	salary_currency: string | null;
	salary_period: SalaryTerms['period'];
	salary_tax_base: SalaryTerms['taxBase'];
}

/**
 * Vacancies of the market window with a role of some specialization and a salary: own vacancies published now, and
 * external ones in search (active or stale, not replaced by an own vacancy) with a posting confirmed within the window.
 * An external vacancy hidden by the text check or by an operator does not count (domain 13.1).
 */
export async function loadVacancyRecords(executor: Executor, windowFrom: Date): Promise<VacancyRecord[]> {
	const rows = await executor.execute<VacancyRow>(sql`
		select v.id::text as id, v.origin, v.seed_batch_id, v.taxonomy_version_id::text as taxonomy_version_id,
			v.role_key, v.grade_min, v.grade_max,
			v.salary_min, v.salary_max, v.salary_currency, v.salary_period, v.salary_tax_base
		from vacancies v
		where v.role_key is not null and ${outsideDemoSessions(companySession(sql`v.company_id`))}
			and (v.salary_min is not null or v.salary_max is not null)
			and (
				(v.origin = 'own' and v.status = 'published')
				or (v.origin = 'external' and v.status in ('active', 'stale') and v.superseded_by_vacancy_id is null
					and exists (select 1 from vacancy_postings p where p.vacancy_id = v.id and p.freshness <> 'gone'
						and p.last_checked_at >= ${windowFrom.toISOString()}))
			)
	`);
	const ordinals = await loadGradeOrdinals(
		executor,
		rows.map((row) => row.taxonomy_version_id)
	);
	return rows.flatMap((row) => {
		const specializations = specializationsOfRole(row.role_key);
		if (specializations.length === 0) return [];
		return [
			{
				vacancyId: row.id,
				origin: row.origin,
				synthetic: row.seed_batch_id !== null,
				salary: {
					min: row.salary_min,
					max: row.salary_max,
					currency: row.salary_currency,
					period: row.salary_period,
					taxBase: row.salary_tax_base
				},
				keys: categoryKeysOf({
					specializations,
					grades: catalogGradesBetween(ordinals.get(row.taxonomy_version_id) ?? new Map(), row.grade_min, row.grade_max)
				})
			}
		];
	});
}

export type SalaryReferenceRow = typeof salaryReferences.$inferSelect;

/** Salary references of the latest published taxonomy version; none — no version is published yet. */
export async function loadSalaryReferences(executor: Executor): Promise<SalaryReferenceRow[]> {
	const version = await latestPublishedVersion(executor);
	if (!version) return [];
	return executor.select().from(salaryReferences).where(eq(salaryReferences.taxonomyVersionId, version.id));
}
