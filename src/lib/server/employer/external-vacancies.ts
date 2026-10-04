// External vacancies as an employer finds them (docs/domain.md, sections 13.2–13.3; CONCEPT, promise 5): the general
// search narrowed to vacancies collected from the sources, each with its postings and their attribution, the pool
// counter «in the pool: N confirmed candidates» and the state of the company's «this is our vacancy» claim. The claim
// is filed as the API files it (`POST /api/v1/vacancies/{id}/claims`): a session member of a company that is not
// rejected or suspended; it waits for the verification of the company, then for an FSP operator.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { searchVacancyIds } from '$lib/server/api/read/vacancies';
import type { RequestMeta } from '$lib/server/auth/context';
import type { Database, Executor } from '$lib/server/db';
import { vacancies, vacancyClaims } from '$lib/server/db/schema';
import { demoSessionOfUser } from '$lib/server/demo/scope';
import { paginate, queryFingerprint } from '$lib/server/matching/page';
import { shownPostings, vacancyPostingViews } from '$lib/server/vacancies/attribution';
import { claimHolders, claimRequesterOf, submitVacancyClaim } from '$lib/server/vacancies/claims';
import { loadPoolCounter, type PoolCounter } from '$lib/server/vacancies/pool';

type ClaimStatus = (typeof vacancyClaims.$inferSelect)['status'];

/** The search of the page as its address states it: `?q=&role=&format=&cursor=`. */
export interface ExternalVacancyQuery {
	text: string;
	roleKey: string | null;
	workFormats: string[];
	cursor: string | undefined;
}

export function externalVacancyQuery(url: URL): ExternalVacancyQuery {
	const params = url.searchParams;
	const role = params.get('role')?.trim() ?? '';
	return {
		text: params.get('q')?.trim() ?? '',
		roleKey: role === '' ? null : role,
		workFormats: [...new Set(params.getAll('format').filter((format) => format !== ''))],
		cursor: params.get('cursor') ?? undefined
	};
}

export interface ExternalVacancyCard {
	id: string;
	title: string;
	/** The organization the postings name; the platform does not know it as a company. */
	organization: string | null;
	roleKey: string | null;
	gradeMin: string | null;
	gradeMax: string | null;
	workFormat: string | null;
	requiredSkillKeys: string[];
	salary: {
		min: number | null;
		max: number | null;
		currency: string | null;
		period: 'month' | 'year' | 'hour' | 'project' | null;
		taxBase: 'gross' | 'net' | 'unknown' | null;
	};
	/** Postings with the attribution the terms of each source require and the link to the original. */
	postings: {
		sourceName: string;
		attribution: string;
		url: string;
		freshness: 'active' | 'gone' | 'unknown';
		lastCheckedAt: Date;
	}[];
	pool: PoolCounter;
	/** The latest claim of the viewer's company on this vacancy. */
	claim: { id: string; status: ClaimStatus; reason: string | null; requestedAt: Date } | null;
	/** An approved claim of the viewer's place already tied the vacancy to a company: this one or another (19.3). */
	claimedBy: 'none' | 'this_company' | 'other_company';
}

export interface ExternalVacancyPage {
	items: ExternalVacancyCard[];
	nextCursor: string | null;
}

const PAGE_SIZE = 20;

function organizationOf(externalOrg: unknown): string | null {
	if (typeof externalOrg !== 'object' || externalOrg === null) return null;
	const name = (externalOrg as { name?: unknown }).name;
	return typeof name === 'string' ? name : null;
}

/**
 * A page of external vacancies for a member of `companyId`: the same search as `GET /api/v1/vacancies?origin=external`
 * (`searchVacancyIds`, demo sessions included), newest first or by relevance of the text.
 */
export async function searchExternalVacancies(
	executor: Executor,
	viewer: { userId: string | null; companyId: string },
	query: ExternalVacancyQuery,
	now: Date
): Promise<ExternalVacancyPage> {
	const search = {
		text: query.text === '' ? undefined : query.text,
		origin: 'external' as const,
		roleKeys: query.roleKey === null ? undefined : [query.roleKey],
		workFormats: query.workFormats.length === 0 ? undefined : query.workFormats
	};
	const session = await demoSessionOfUser(executor, viewer.userId);
	const ids = await searchVacancyIds(executor, search, session);
	const page = paginate(
		ids,
		{ limit: PAGE_SIZE, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
		queryFingerprint({ op: 'company.external_vacancies', ...search })
	);
	if (page.items.length === 0) return { items: [], nextCursor: page.nextCursor };

	const rows = await executor.select().from(vacancies).where(inArray(vacancies.id, page.items));
	const byId = new Map(rows.map((row) => [row.id, row]));
	const postingsOf = await vacancyPostingViews(executor, page.items);
	const claims = await executor
		.select({
			id: vacancyClaims.id,
			vacancyId: vacancyClaims.vacancyId,
			status: vacancyClaims.status,
			reason: vacancyClaims.reason,
			createdAt: vacancyClaims.createdAt
		})
		.from(vacancyClaims)
		.where(and(eq(vacancyClaims.companyId, viewer.companyId), inArray(vacancyClaims.vacancyId, page.items)))
		.orderBy(desc(vacancyClaims.createdAt), desc(vacancyClaims.id));
	const holders = await claimHolders(executor, page.items, session);
	const latestClaim = new Map<string, (typeof claims)[number]>();
	for (const claim of claims) if (!latestClaim.has(claim.vacancyId)) latestClaim.set(claim.vacancyId, claim);

	const items: ExternalVacancyCard[] = [];
	for (const id of page.items) {
		const row = byId.get(id);
		if (!row) throw new Error(`vacancy ${id} disappeared between the search and the read`);
		const pool = await loadPoolCounter(executor, id, now);
		if (!pool) throw new Error(`vacancy ${id} has no pool counter`);
		const claim = latestClaim.get(id);
		const holder = holders.get(id);
		items.push({
			id,
			title: row.title,
			organization: organizationOf(row.externalOrg),
			roleKey: row.roleKey,
			gradeMin: row.gradeMin,
			gradeMax: row.gradeMax,
			workFormat: row.workFormat,
			requiredSkillKeys: row.requiredSkillKeys,
			salary: {
				min: row.salaryMin,
				max: row.salaryMax,
				currency: row.salaryCurrency,
				period: row.salaryPeriod,
				taxBase: row.salaryTaxBase
			},
			postings: shownPostings(row, postingsOf).map((posting) => ({
				sourceName: posting.sourceName,
				attribution: posting.attribution,
				url: posting.url,
				freshness: posting.freshness,
				lastCheckedAt: posting.lastCheckedAt
			})),
			pool,
			claim: claim
				? {
						id: claim.id,
						status: claim.status,
						reason: claim.status === 'rejected' ? claim.reason : null,
						requestedAt: claim.createdAt
					}
				: null,
			claimedBy: holder === undefined ? 'none' : holder === viewer.companyId ? 'this_company' : 'other_company'
		});
	}
	return { items, nextCursor: page.nextCursor };
}

/** «This is our vacancy» from the cabinet, with the requester rule of the API (`claimRequesterOf`). */
export async function claimExternalVacancy(
	deps: { db: Database; now: () => Date },
	subject: AccessSubject,
	meta: RequestMeta,
	vacancyId: string
): Promise<{ id: string; status: ClaimStatus }> {
	const claim = await submitVacancyClaim(deps, claimRequesterOf(subject, meta.requestId), vacancyId);
	return { id: claim.id, status: claim.status };
}
