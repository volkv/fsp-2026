// Records the category market is computed from (docs/domain.md, section 12.5): salary expectations of catalog
// candidates by the categories of their valid published run, salary ranges of own published and fresh external
// vacancies, and the external salary reference of the published taxonomy version. Clones of demo sessions and the
// vacancies of their companies are not counted: they copy the cast, which is counted already (domain 19.3).
import { eq, sql } from 'drizzle-orm';
import { parsePreferences, salaryExpectation } from '$lib/server/candidates/preferences';
import type { Executor } from '$lib/server/db';
import { candidateAt, listedInCatalog, runAt, runInForce } from '$lib/server/db/conditions';
import { salaryReferences } from '$lib/server/db/schema';
import { companySession, outsideDemoSessions } from '$lib/server/demo/scope';
import { loadGradeOrdinals } from '$lib/server/matching/evidence';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';
import type { SalaryTerms } from '$lib/server/salary/compare';
import { categoryKeysOf, gradeKeysBetween, type CategoryKey } from './aggregate';

export interface CandidateRecord {
	candidateId: string;
	synthetic: boolean;
	salary: SalaryTerms;
	/** Category keys of every established role of the valid published run. */
	keys: CategoryKey[];
}

interface AssignmentRow extends Record<string, unknown> {
	candidate_id: string;
	preferences: unknown;
	seed_batch_id: string | null;
	taxonomy_version_id: string;
	role_key: string;
	grade_status: string;
	grade_min: string | null;
	grade_max: string | null;
	stack_status: string;
	stack_skill_keys: string[];
}

/**
 * Candidates the catalog may show at all (active, in the catalog, looking) with a salary expectation, each with the
 * categories of its valid published run. Whether a given viewer sees them is decided by the caller with `canShow`.
 * `roleKey` narrows the read to one role.
 */
export async function loadCandidateRecords(executor: Executor, roleKey?: string): Promise<CandidateRecord[]> {
	const rows = await executor.execute<AssignmentRow>(sql`
		select c.id::text as candidate_id, c.preferences, c.seed_batch_id, r.taxonomy_version_id::text as taxonomy_version_id,
			a.role_key, a.grade_status, a.grade_min, a.grade_max, a.stack_status, a.stack_skill_keys
		from candidates c
		join categorization_runs r on r.candidate_id = c.id and ${runInForce(runAt('r'), candidateAt('c'))}
		join category_assignments a on a.run_id = r.id and a.role_status = 'established' and a.role_key is not null
		where ${listedInCatalog(candidateAt('c'))}
			and c.preferences ? 'salary_expectation' and ${outsideDemoSessions(sql`c.demo_session_id`)}
			${roleKey === undefined ? sql`` : sql`and a.role_key = ${roleKey}`}
	`);
	const ordinals = await loadGradeOrdinals(
		executor,
		rows.map((row) => row.taxonomy_version_id)
	);
	const records = new Map<string, CandidateRecord>();
	for (const row of rows) {
		const salary = salaryExpectation(parsePreferences(row.candidate_id, row.preferences));
		if (salary === null) continue;
		const grades =
			row.grade_status === 'established'
				? gradeKeysBetween(ordinals.get(row.taxonomy_version_id) ?? new Map(), row.grade_min, row.grade_max)
				: [];
		const keys = categoryKeysOf({
			roleKey: row.role_key,
			gradeKeys: grades,
			stackSkillKeys: row.stack_status === 'established' ? row.stack_skill_keys : []
		});
		const record = records.get(row.candidate_id) ?? {
			candidateId: row.candidate_id,
			synthetic: row.seed_batch_id !== null,
			salary,
			keys: []
		};
		record.keys.push(...keys);
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
	required_skill_keys: string[];
	salary_min: number | null;
	salary_max: number | null;
	salary_currency: string | null;
	salary_period: SalaryTerms['period'];
	salary_tax_base: SalaryTerms['taxBase'];
}

/**
 * Vacancies of the market window with a recognized role and a salary: own vacancies published now, and external
 * ones in search (active or stale, not replaced by an own vacancy) with a posting confirmed within the window. An
 * external vacancy hidden by the text check or by an operator does not count (domain 13.1).
 */
export async function loadVacancyRecords(
	executor: Executor,
	windowFrom: Date,
	roleKey?: string
): Promise<VacancyRecord[]> {
	const rows = await executor.execute<VacancyRow>(sql`
		select v.id::text as id, v.origin, v.seed_batch_id, v.taxonomy_version_id::text as taxonomy_version_id,
			v.role_key, v.grade_min, v.grade_max, v.required_skill_keys,
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
			${roleKey === undefined ? sql`` : sql`and v.role_key = ${roleKey}`}
	`);
	const ordinals = await loadGradeOrdinals(
		executor,
		rows.map((row) => row.taxonomy_version_id)
	);
	return rows.map((row) => ({
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
			roleKey: row.role_key,
			gradeKeys: gradeKeysBetween(ordinals.get(row.taxonomy_version_id) ?? new Map(), row.grade_min, row.grade_max),
			stackSkillKeys: row.required_skill_keys
		})
	}));
}

export type SalaryReferenceRow = typeof salaryReferences.$inferSelect;

/** Salary references of the latest published taxonomy version; none — no version is published yet. */
export async function loadSalaryReferences(executor: Executor): Promise<SalaryReferenceRow[]> {
	const version = await latestPublishedVersion(executor);
	if (!version) return [];
	return executor.select().from(salaryReferences).where(eq(salaryReferences.taxonomyVersionId, version.id));
}
