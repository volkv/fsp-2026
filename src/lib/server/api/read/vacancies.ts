// Vacancies as the API shows them (docs/domain.md, sections 13.1, 13.3; contracts 5.5): the general search over
// published vacancies of the companies the admission policy lets act, and the vacancies of a company in every status.
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { companies, vacancies } from '$lib/server/db/schema';
import { vacancyDocuments } from '$lib/server/matching/documents';
import { matchableVacancyFor } from '$lib/server/matching/evidence';
import { loadPoolCount, type PoolCount } from '$lib/server/vacancies/pool';

export type VacancyRow = typeof vacancies.$inferSelect;

export interface VacancyView {
	row: VacancyRow;
	companyName: string;
	pool: PoolCount;
}

export interface VacancySearch {
	text?: string | undefined;
	roleKeys?: readonly string[] | undefined;
	workFormats?: readonly string[] | undefined;
}

/** A vacancy of the general search seen from demo session `viewerSession` (`null` — outside sessions, domain 19.3). */
const searchable = (viewerSession: string | null): SQL[] => [matchableVacancyFor(viewerSession)];

/**
 * Ids of the searchable vacancies in the order of the answer: by relevance of the text when it is given (the same
 * search document as matching uses), else newest first. Vacancies of demo companies are seen from their own session
 * only, and inside a session the vacancies of the originals of the scenario companies are not (domain 19.3).
 */
export async function searchVacancyIds(
	executor: Executor,
	search: VacancySearch,
	viewerSession: string | null
): Promise<string[]> {
	const conditions: SQL[] = searchable(viewerSession);
	if (search.roleKeys?.length) conditions.push(inArray(vacancies.roleKey, [...search.roleKeys]));
	if (search.workFormats?.length) conditions.push(inArray(vacancies.workFormat, [...search.workFormats]));
	const rows = await executor
		.select({ id: vacancies.id })
		.from(vacancies)
		.where(and(...conditions))
		.orderBy(desc(sql`coalesce(${vacancies.publishedAt}, ${vacancies.createdAt})`), desc(vacancies.id));
	const ids = rows.map((row) => row.id);
	const text = search.text?.trim();
	if (!text) return ids;
	const documents = await vacancyDocuments(executor, ids, text);
	const matched = ids.filter((id) => documents.get(id)?.matched === true);
	const rank = (id: string) => documents.get(id)?.rank ?? 0;
	// The sort is stable: equal relevance keeps the newest-first order.
	return matched.sort((a, b) => rank(b) - rank(a));
}

/** Full views of the vacancies, in the order of `ids`. */
export async function vacancyViews(executor: Executor, ids: readonly string[], now: Date): Promise<VacancyView[]> {
	if (ids.length === 0) return [];
	const rows = await executor
		.select()
		.from(vacancies)
		.where(inArray(vacancies.id, [...ids]));
	const byId = new Map(rows.map((row) => [row.id, row]));
	const companyIds = [...new Set(rows.map((row) => row.companyId))];
	const names = new Map(
		(
			await executor
				.select({ id: companies.id, name: companies.displayName })
				.from(companies)
				.where(inArray(companies.id, companyIds))
		).map((row) => [row.id, row.name])
	);
	const views: VacancyView[] = [];
	for (const id of ids) {
		const row = byId.get(id);
		if (!row) throw new Error(`vacancy ${id} disappeared between the search and the read`);
		const pool = await loadPoolCount(executor, id, now);
		if (!pool) throw new Error(`vacancy ${id} has no pool counter`);
		const companyName = names.get(row.companyId);
		if (companyName === undefined) throw new Error(`company ${row.companyId} of vacancy ${id} is missing`);
		views.push({ row, companyName, pool });
	}
	return views;
}

/**
 * A vacancy by id for a viewer: one the viewer's search would find, a vacancy in any status for an active member of
 * its company. `null` — nothing the viewer may see.
 */
export async function visibleVacancyId(
	executor: Executor,
	vacancyId: string,
	viewer: { companyId: string | null; demoSessionId: string | null }
): Promise<string | null> {
	const [row] = await executor
		.select({
			id: vacancies.id,
			searchable: sql<boolean>`${sql.join(searchable(viewer.demoSessionId), sql` and `)}`,
			companyId: vacancies.companyId
		})
		.from(vacancies)
		.where(eq(vacancies.id, vacancyId));
	if (!row) return null;
	if (row.searchable) return row.id;
	return viewer.companyId !== null && row.companyId === viewer.companyId ? row.id : null;
}

/** Vacancies of a company, every status, newest first. */
export async function companyVacancyIds(executor: Executor, companyId: string): Promise<string[]> {
	const rows = await executor
		.select({ id: vacancies.id })
		.from(vacancies)
		.where(eq(vacancies.companyId, companyId))
		.orderBy(desc(vacancies.createdAt), desc(vacancies.id));
	return rows.map((row) => row.id);
}
