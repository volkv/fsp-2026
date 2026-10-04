// Vacancies as their company sees them (docs/domain.md, sections 13.1–13.3): its own vacancies with status, text check
// and the pool counter, and the external vacancies it claimed («this is our vacancy») with the state of each claim.
// Another company's vacancy is indistinguishable from a missing one.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { vacancies, vacancyClaims } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { loadPoolCounter, type PoolCounter } from '$lib/server/vacancies/pool';
import { textCheckSchema, type TextCheck } from '$lib/server/vacancies/text-check';

type VacancyRow = typeof vacancies.$inferSelect;
export type OwnVacancyStatus = 'draft' | 'pending_moderation' | 'published' | 'paused' | 'closed';

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

const OWN_STATUSES: readonly string[] = ['draft', 'pending_moderation', 'published', 'paused', 'closed'];

/** The stored own vacancy; the schema guarantees the fields an own vacancy must have (`vacancies_own_fields`). */
function ownView(row: VacancyRow, pool: PoolCounter): OwnVacancyView {
	const {
		roleKey,
		gradeMin,
		gradeMax,
		description,
		workFormat,
		employmentForm,
		contractTypes,
		salaryMin,
		salaryMax,
		salaryCurrency,
		salaryPeriod,
		salaryTaxBase
	} = row;
	if (
		!OWN_STATUSES.includes(row.status) ||
		roleKey === null ||
		gradeMin === null ||
		gradeMax === null ||
		description === null ||
		workFormat === null ||
		employmentForm === null ||
		contractTypes === null ||
		salaryMin === null ||
		salaryMax === null ||
		salaryCurrency === null ||
		salaryPeriod === null ||
		(salaryTaxBase !== 'gross' && salaryTaxBase !== 'net')
	) {
		throw new Error(`own vacancy ${row.id} breaks the stored shape of an own vacancy`);
	}
	return {
		id: row.id,
		status: row.status as OwnVacancyStatus,
		revision: row.revision,
		title: row.title,
		description,
		taxonomyVersionId: row.taxonomyVersionId,
		roleKey,
		gradeMin,
		gradeMax,
		requiredSkillKeys: row.requiredSkillKeys,
		niceSkillKeys: row.niceSkillKeys,
		workFormat,
		employmentForm,
		contractTypes,
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
		.where(and(eq(vacancies.origin, 'own'), eq(vacancies.companyId, companyId)))
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

/** One own vacancy of the company; anything else is `not_found`. */
export async function getOwnVacancy(
	executor: Executor,
	companyId: string,
	vacancyId: string,
	now: Date
): Promise<OwnVacancyView> {
	const [row] = await executor
		.select()
		.from(vacancies)
		.where(and(eq(vacancies.id, vacancyId), eq(vacancies.origin, 'own'), eq(vacancies.companyId, companyId)));
	if (!row) throw new ApiError('not_found');
	return ownView(row, await poolOf(executor, row.id, now));
}

export interface ClaimedVacancyView {
	claimId: string;
	status: (typeof vacancyClaims.$inferSelect)['status'];
	/** The operator's reason of a rejection. */
	reason: string | null;
	requestedAt: Date;
	decidedAt: Date | null;
	vacancy: {
		id: string;
		title: string;
		status: string;
	};
}

/** «This is our vacancy» claims of the company with the external vacancy of each, newest first. */
export async function listVacancyClaims(executor: Executor, companyId: string): Promise<ClaimedVacancyView[]> {
	const rows = await executor
		.select({
			claimId: vacancyClaims.id,
			status: vacancyClaims.status,
			reason: vacancyClaims.reason,
			requestedAt: vacancyClaims.createdAt,
			decidedAt: vacancyClaims.decidedAt,
			vacancyId: vacancies.id,
			title: vacancies.title,
			vacancyStatus: vacancies.status
		})
		.from(vacancyClaims)
		.innerJoin(vacancies, eq(vacancies.id, vacancyClaims.vacancyId))
		.where(eq(vacancyClaims.companyId, companyId))
		.orderBy(desc(vacancyClaims.createdAt));
	return rows.map((row) => ({
		claimId: row.claimId,
		status: row.status,
		reason: row.status === 'rejected' ? row.reason : null,
		requestedAt: row.requestedAt,
		decidedAt: row.decidedAt,
		vacancy: {
			id: row.vacancyId,
			title: row.title,
			status: row.vacancyStatus
		}
	}));
}

export interface VacancyOption {
	id: string;
	title: string;
	status: OwnVacancyStatus;
}

/** Vacancies a search can be ranked for: own vacancies of the company that are not closed. */
export async function searchableVacancies(executor: Executor, companyId: string): Promise<VacancyOption[]> {
	const rows = await executor
		.select({ id: vacancies.id, title: vacancies.title, status: vacancies.status })
		.from(vacancies)
		.where(
			and(
				eq(vacancies.origin, 'own'),
				eq(vacancies.companyId, companyId),
				inArray(vacancies.status, ['draft', 'pending_moderation', 'published', 'paused'])
			)
		)
		.orderBy(desc(vacancies.updatedAt));
	return rows.map((row) => ({ id: row.id, title: row.title, status: row.status as OwnVacancyStatus }));
}
