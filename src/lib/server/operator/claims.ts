// «This is our vacancy» claims as the operator reviews them (docs/domain.md 13.3): the claims waiting for review with the
// hint gathered at submission — INN of the postings against the company, similarity of names — and the decision of
// `vacancies/claims.ts` behind `vacancy_claim.review`. Approval never makes the external vacancy invitable. The
// operator sees the claims of the companies within its reach: a clone operator of a demo session — of its session only
// (domain 19.3).
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { RequestMeta } from '$lib/server/auth/context';
import { conflict, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { CompanyStatus } from '$lib/server/companies/gate';
import type { Database, Executor } from '$lib/server/db';
import { companies, users, vacancies, vacancyClaims } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { decideVacancyClaim } from '$lib/server/vacancies/claims';

/** `vacancy_claims.match_evidence` as `submitVacancyClaim` writes it. */
const evidenceSchema = z.strictObject({
	inn: z.enum(['match', 'mismatch', 'unknown']),
	posting_inns: z.array(z.string()),
	name_similarity: z.number().min(0).max(1)
});

export type ClaimEvidenceView = z.infer<typeof evidenceSchema>;

const externalOrgSchema = z.looseObject({ name: z.string(), inn: z.string().optional() });

export interface ClaimQueueItem {
	id: string;
	submittedAt: Date;
	vacancy: { id: string; title: string; organization: string | null; status: string };
	company: { id: string; displayName: string; legalName: string; inn: string; status: CompanyStatus };
	requesterName: string | null;
	evidence: ClaimEvidenceView;
}

export interface DecidedClaim {
	id: string;
	status: string;
	decidedAt: Date | null;
	vacancyTitle: string;
	companyName: string;
	reason: string | null;
}

/** Claims waiting for the operator, oldest first; how many still wait for their company; the latest decisions. */
export async function claimQueue(
	executor: Executor,
	subject: AccessSubject
): Promise<{ items: ClaimQueueItem[]; awaitingCompany: number; decided: DecidedClaim[] }> {
	requirePermission(subject, 'vacancy_claim.review', { status: 'pending_review' });
	const reach = await StaffReach.of(executor, subject);
	const scope = reach.rows(companies.demoSessionId);
	const rows = await executor
		.select({
			id: vacancyClaims.id,
			submittedAt: vacancyClaims.createdAt,
			evidence: vacancyClaims.matchEvidence,
			vacancyId: vacancies.id,
			vacancyTitle: vacancies.title,
			vacancyStatus: vacancies.status,
			externalOrg: vacancies.externalOrg,
			companyId: companies.id,
			displayName: companies.displayName,
			legalName: companies.legalName,
			inn: companies.inn,
			companyStatus: companies.status,
			requesterName: users.displayName
		})
		.from(vacancyClaims)
		.innerJoin(vacancies, eq(vacancies.id, vacancyClaims.vacancyId))
		.innerJoin(companies, eq(companies.id, vacancyClaims.companyId))
		.leftJoin(users, eq(users.id, vacancyClaims.requestedByUserId))
		.where(and(eq(vacancyClaims.status, 'pending_review'), scope))
		.orderBy(asc(vacancyClaims.createdAt), asc(vacancyClaims.id));
	const [awaiting] = await executor
		.select({ n: count() })
		.from(vacancyClaims)
		.where(and(eq(vacancyClaims.status, 'awaiting_company_verification'), reach.company(vacancyClaims.companyId)));
	const decided = await executor
		.select({
			id: vacancyClaims.id,
			status: vacancyClaims.status,
			decidedAt: vacancyClaims.decidedAt,
			vacancyTitle: vacancies.title,
			companyName: companies.displayName,
			reason: vacancyClaims.reason
		})
		.from(vacancyClaims)
		.innerJoin(vacancies, eq(vacancies.id, vacancyClaims.vacancyId))
		.innerJoin(companies, eq(companies.id, vacancyClaims.companyId))
		.where(and(inArray(vacancyClaims.status, ['approved', 'rejected']), scope))
		.orderBy(desc(vacancyClaims.decidedAt))
		.limit(20);
	return {
		items: rows.map((row) => ({
			id: row.id,
			submittedAt: row.submittedAt,
			vacancy: {
				id: row.vacancyId,
				title: row.vacancyTitle,
				organization: row.externalOrg === null ? null : externalOrgSchema.parse(row.externalOrg).name,
				status: row.vacancyStatus
			},
			company: {
				id: row.companyId,
				displayName: row.displayName,
				legalName: row.legalName,
				inn: row.inn,
				status: row.companyStatus
			},
			requesterName: row.requesterName,
			evidence: evidenceSchema.parse(row.evidence)
		})),
		awaitingCompany: awaiting?.n ?? 0,
		decided
	};
}

/** The operator's decision on a claim waiting for review; a refusal and an approval against an INN mismatch need a reason. */
export async function decideClaim(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	claimId: string,
	decision: 'approved' | 'rejected',
	reason: string
): Promise<void> {
	if (!z.uuid().safeParse(claimId).success) throw new ApiError('not_found');
	const [claim] = await db
		.select({
			status: vacancyClaims.status,
			demoSessionId: companies.demoSessionId
		})
		.from(vacancyClaims)
		.innerJoin(companies, eq(companies.id, vacancyClaims.companyId))
		.where(eq(vacancyClaims.id, claimId));
	if (!claim) throw new ApiError('not_found');
	(await StaffReach.of(db, subject)).require(claim.demoSessionId);
	requirePermission(subject, 'vacancy_claim.review', { status: 'pending_review' });
	// Another operator may have answered first: the claim exists, it is just no longer open.
	if (claim.status !== 'pending_review') throw conflict('claim_not_open', 'Заявка уже рассмотрена или отозвана');
	await decideVacancyClaim({ db, now: () => new Date() }, claimId, {
		operatorUserId: sessionUserId(subject),
		decision,
		reason: reason.trim() === '' ? null : reason,
		requestId: meta.requestId
	});
}
