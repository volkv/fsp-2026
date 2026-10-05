// «Вакансии для меня» (docs/domain.md, section 13.4; CONCEPT, promise 4): vacancies ranked by the same `matchScore` the
// companies use, with what the candidate sees of each vacancy — title, company or organization, range, format and
// grade — and the invitation of this vacancy if a company already sent one. There is no «apply»: contact starts with
// the company.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import { companies, invitations, invitationTerms, vacancies } from '$lib/server/db/schema';
import type { MatchingDeps } from '$lib/server/matching/deps';
import {
	recommendVacancies,
	type VacancyRecommendationQuery,
	type VacancyRecommendations
} from '$lib/server/matching/recommendations';
import type { MatchResult } from '$lib/server/matching/score';

export interface RecommendedVacancy {
	vacancyId: string;
	origin: 'own' | 'external';
	title: string;
	/** The company of an own vacancy, or the organization an external posting names. */
	organization: string | null;
	/** The label of the check of the company of an own vacancy (domain 5.1); `null` — an external vacancy. */
	companyVerification: 'verified' | 'unverified' | null;
	salary: {
		min: number | null;
		max: number | null;
		currency: string | null;
		period: 'month' | 'year' | 'hour' | 'project' | null;
		taxBase: 'gross' | 'net' | 'unknown' | null;
	};
	roleKey: string | null;
	gradeMin: string | null;
	gradeMax: string | null;
	workFormat: string | null;
	requiredSkillKeys: string[];
	match: MatchResult;
	invitation: { id: string; status: (typeof invitations.$inferSelect)['status'] } | null;
}

export interface RecommendedPage {
	items: RecommendedVacancy[];
	nextCursor: string | null;
	mode: VacancyRecommendations['mode'];
}

const PAGE_SIZE = 20;

/** The organization an external vacancy names in `external_org`. */
export function organizationOf(externalOrg: unknown): string | null {
	if (typeof externalOrg !== 'object' || externalOrg === null) return null;
	const name = (externalOrg as { name?: unknown }).name;
	return typeof name === 'string' ? name : null;
}

/** The search of the page: the same filters as `GET /api/v1/me/matches`; an empty filter is no filter. */
export type RecommendedQuery = Omit<VacancyRecommendationQuery, 'limit'>;

export async function recommendedVacancies(
	deps: Pick<MatchingDeps, 'db'>,
	subject: AccessSubject,
	query: RecommendedQuery
): Promise<RecommendedPage> {
	const page = await recommendVacancies(deps, subject, { ...query, limit: PAGE_SIZE });
	const ids = page.items.map((item) => item.vacancyId);
	const executor: Executor = deps.db;
	const rows = ids.length
		? await executor
				.select({
					id: vacancies.id,
					companyName: companies.displayName,
					companyStatus: companies.status,
					externalOrg: vacancies.externalOrg,
					salaryMin: vacancies.salaryMin,
					salaryMax: vacancies.salaryMax,
					salaryCurrency: vacancies.salaryCurrency,
					salaryPeriod: vacancies.salaryPeriod,
					salaryTaxBase: vacancies.salaryTaxBase,
					roleKey: vacancies.roleKey,
					gradeMin: vacancies.gradeMin,
					gradeMax: vacancies.gradeMax,
					workFormat: vacancies.workFormat,
					requiredSkillKeys: vacancies.requiredSkillKeys
				})
				.from(vacancies)
				.leftJoin(companies, eq(companies.id, vacancies.companyId))
				.where(inArray(vacancies.id, ids))
		: [];
	const candidateId = subject.candidate?.id;
	const sent =
		ids.length && candidateId !== undefined
			? await executor
					.select({ id: invitations.id, vacancyId: invitationTerms.vacancyId, status: invitations.status })
					.from(invitations)
					.innerJoin(invitationTerms, eq(invitationTerms.id, invitations.currentTermsId))
					.where(
						and(
							eq(invitations.candidateId, candidateId),
							inArray(invitationTerms.vacancyId, ids),
							isNull(invitations.purgedAt)
						)
					)
			: [];
	const byId = new Map(rows.map((row) => [row.id, row]));
	return {
		items: page.items.map((item) => {
			const row = byId.get(item.vacancyId);
			if (!row) throw new Error(`recommended vacancy ${item.vacancyId} disappeared`);
			const invitation = sent.find((entry) => entry.vacancyId === item.vacancyId);
			return {
				vacancyId: item.vacancyId,
				origin: item.origin,
				title: item.title,
				organization: row.companyName ?? organizationOf(row.externalOrg),
				companyVerification:
					row.companyStatus === null ? null : row.companyStatus === 'verified' ? 'verified' : 'unverified',
				salary: {
					min: row.salaryMin,
					max: row.salaryMax,
					currency: row.salaryCurrency,
					period: row.salaryPeriod,
					taxBase: row.salaryTaxBase
				},
				roleKey: row.roleKey,
				gradeMin: row.gradeMin,
				gradeMax: row.gradeMax,
				workFormat: row.workFormat,
				requiredSkillKeys: row.requiredSkillKeys,
				match: item.match,
				invitation: invitation ? { id: invitation.id, status: invitation.status } : null
			};
		}),
		nextCursor: page.nextCursor,
		mode: page.mode
	};
}
