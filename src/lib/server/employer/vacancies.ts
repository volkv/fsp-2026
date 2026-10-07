// Vacancies as their company sees them (docs/domain.md, sections 13.1, 13.3): status, text check and the pool counter.
// Another company's vacancy is indistinguishable from a missing one.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { vacancies } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { loadPoolCounter, type PoolCounter } from '$lib/server/vacancies/pool';
import { textCheckSchema, type TextCheck } from '$lib/server/vacancies/text-check';

type VacancyRow = typeof vacancies.$inferSelect;
export type OwnVacancyStatus = VacancyRow['status'];

export interface OwnVacancySalary {
	min: number;
	max: number;
	currency: string;
	period: 'month' | 'year' | 'hour' | 'project';
	taxBase: 'gross' | 'net';
}

export interface OwnVacancyView {
	id: string;
	status: OwnVacancyStatus;
	revision: number;
	title: string;
	description: string;
	taxonomyVersionId: string;
	roleKey: string;
	gradeMin: string;
	gradeMax: string;
	requiredSkillKeys: string[];
	niceSkillKeys: string[];
	workFormat: string;
	employmentForm: string;
	contractTypes: string[];
	cityId: string | null;
	timezoneOverlapHours: number | null;
	salary: OwnVacancySalary;
	minAge: number | null;
	textCheck: TextCheck;
	pool: PoolCounter;
	/** Built from pasted text. */
	fromText: boolean;
	publishedAt: Date | null;
	closedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

/** The stored vacancy; the schema guarantees a full range with a known tax base (`vacancies_full_salary`). */
function ownView(row: VacancyRow, pool: PoolCounter): OwnVacancyView {
	const { salaryMin, salaryMax, salaryCurrency, salaryPeriod, salaryTaxBase } = row;
	if (
		salaryMin === null ||
		salaryMax === null ||
		salaryCurrency === null ||
		salaryPeriod === null ||
		(salaryTaxBase !== 'gross' && salaryTaxBase !== 'net')
	) {
		throw new Error(`vacancy ${row.id} breaks the stored shape of a vacancy`);
	}
	return {
		id: row.id,
		status: row.status,
		revision: row.revision,
		title: row.title,
		description: row.description,
		taxonomyVersionId: row.taxonomyVersionId,
		roleKey: row.roleKey,
		gradeMin: row.gradeMin,
		gradeMax: row.gradeMax,
		requiredSkillKeys: row.requiredSkillKeys,
		niceSkillKeys: row.niceSkillKeys,
		workFormat: row.workFormat,
		employmentForm: row.employmentForm,
		contractTypes: row.contractTypes,
		cityId: row.cityId,
		timezoneOverlapHours: row.timezoneOverlapHours,
		salary: { min: salaryMin, max: salaryMax, currency: salaryCurrency, period: salaryPeriod, taxBase: salaryTaxBase },
		minAge: row.minAge,
		textCheck: textCheckSchema.parse(row.textCheck),
		pool,
		fromText: row.draftMlResultId !== null,
		publishedAt: row.publishedAt,
		closedAt: row.closedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

/** The pool counter as `vacancies/pool` shows it: with the small-count threshold of the policy in force. */
async function poolOf(executor: Executor, vacancyId: string, now: Date): Promise<PoolCounter> {
	const pool = await loadPoolCounter(executor, vacancyId, now);
	if (!pool) throw new Error(`vacancy ${vacancyId} disappeared while read`);
	return pool;
}

/** Own vacancies of the company, open ones first, newest first inside a status. */
export async function listOwnVacancies(executor: Executor, companyId: string, now: Date): Promise<OwnVacancyView[]> {
	const rows = await executor
		.select()
		.from(vacancies)
		.where(eq(vacancies.companyId, companyId))
		.orderBy(desc(vacancies.updatedAt), desc(vacancies.id));
	const views = await Promise.all(rows.map(async (row) => ownView(row, await poolOf(executor, row.id, now))));
	const order: Record<OwnVacancyStatus, number> = {
		published: 0,
		pending_moderation: 1,
		draft: 2,
		paused: 3,
		closed: 4
	};
	return views.sort((a, b) => order[a.status] - order[b.status]);
}

/** One vacancy of the company; anything else is `not_found`. */
export async function getOwnVacancy(
	executor: Executor,
	companyId: string,
	vacancyId: string,
	now: Date
): Promise<OwnVacancyView> {
	const [row] = await executor
		.select()
		.from(vacancies)
		.where(and(eq(vacancies.id, vacancyId), eq(vacancies.companyId, companyId)));
	if (!row) throw new ApiError('not_found');
	return ownView(row, await poolOf(executor, row.id, now));
}

export interface VacancyOption {
	id: string;
	title: string;
	status: OwnVacancyStatus;
}

/** Vacancies a search can be ranked for: vacancies of the company that are not closed. */
export async function searchableVacancies(executor: Executor, companyId: string): Promise<VacancyOption[]> {
	const rows = await executor
		.select({ id: vacancies.id, title: vacancies.title, status: vacancies.status })
		.from(vacancies)
		.where(
			and(
				eq(vacancies.companyId, companyId),
				inArray(vacancies.status, ['draft', 'pending_moderation', 'published', 'paused'])
			)
		)
		.orderBy(desc(vacancies.updatedAt));
	return rows.map((row) => ({ id: row.id, title: row.title, status: row.status }));
}
