// «This is our vacancy» (docs/domain.md, section 13.3): a company claims an external vacancy; the claim waits for the
// company to be verified, then for an operator. Approval lets the company create its own vacancy from the external one
// (`createOwnVacancy` with `derivedFromVacancyId`). It never makes the external vacancy invitable: invitations go only
// through the company's own vacancy.
//
// External vacancies are shared by every demo session (domain 19.3), so an approval holds within the place of the
// claiming company: a company outside sessions records itself on the vacancy (`claimed_company_id`) for everybody, a
// company of a demo session only in its approved claim, which carries the session. Whether a vacancy is claimed, and by
// whom, is therefore a question of the viewer's place (`claimHolders`).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import type { AuditActor } from '$lib/server/audit/record';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database, Executor, Transaction } from '$lib/server/db';
import { companies, vacancies, vacancyClaims, vacancyPostings } from '$lib/server/db/schema';
import { auditActorOf } from '$lib/server/companies/context';
import { demoScope } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import { organizationKey } from './clusters';
import { companyIsVerified } from './derivations';
import { invalid, refuse, violation } from './errors';

export interface ClaimDeps {
	db: Database;
	now: () => Date;
}

type ClaimRow = typeof vacancyClaims.$inferSelect;

const OPEN = ['awaiting_company_verification', 'pending_review'] as const;

const isUuid = (value: string) => z.uuid().safeParse(value).success;

export interface ClaimEvidence {
	/** INN of the postings compared with the INN of the company: `match`, `mismatch` or `unknown` (no INN published). */
	inn: 'match' | 'mismatch' | 'unknown';
	posting_inns: string[];
	/** Share of common words between the organization names of the postings and the company names, 0…1. */
	name_similarity: number;
}

function words(name: string): Set<string> {
	return new Set(
		organizationKey(name)
			.split(' ')
			.filter((w) => w.length > 1)
	);
}

/** Jaccard similarity of the word sets of two organization names. */
export function nameSimilarity(a: string, b: string): number {
	const x = words(a);
	const y = words(b);
	if (x.size === 0 || y.size === 0) return 0;
	let common = 0;
	for (const word of x) if (y.has(word)) common++;
	return Math.round((common / (x.size + y.size - common)) * 100) / 100;
}

async function evidenceFor(
	tx: Transaction,
	vacancyId: string,
	company: { inn: string; legalName: string; displayName: string }
): Promise<ClaimEvidence> {
	const postings = await tx
		.select({ organization: vacancyPostings.organization })
		.from(vacancyPostings)
		.where(eq(vacancyPostings.vacancyId, vacancyId));
	const orgs = postings.map((p) => p.organization as { name: string; inn?: string | null });
	const inns = [...new Set(orgs.map((o) => o.inn ?? null).filter((v): v is string => v !== null))];
	const similarity = Math.max(
		0,
		...orgs.flatMap((o) => [nameSimilarity(o.name, company.legalName), nameSimilarity(o.name, company.displayName)])
	);
	return {
		inn: inns.length === 0 ? 'unknown' : inns.includes(company.inn) ? 'match' : 'mismatch',
		posting_inns: inns,
		name_similarity: similarity
	};
}

/**
 * The company holding each of the vacancies as a viewer of demo session `session` sees it (`null` — outside sessions;
 * domain 13.3, 19.3): the approved claim of that session, else the company outside sessions recorded on the vacancy —
 * except an original of the scenario cast, which is not shown inside a session. Vacancies nobody holds are absent.
 */
export async function claimHolders(
	executor: Executor,
	vacancyIds: readonly string[],
	session: string | null
): Promise<Map<string, string>> {
	if (vacancyIds.length === 0) return new Map();
	const ofSession =
		session === null
			? sql`null::uuid`
			: sql`(select held.company_id from vacancy_claims held where held.vacancy_id = ${vacancies.id}
				and held.status = 'approved' and held.demo_session_id = ${session}::uuid)`;
	const holder = { demoSessionId: sql`holder.demo_session_id`, demoOriginal: sql`holder.demo_original` };
	const outside = sql`(select holder.id from companies holder where holder.id = ${vacancies.claimedCompanyId}
		and ${demoScope(holder, session)})`;
	const rows = await executor
		.select({ id: vacancies.id, holder: sql<string | null>`coalesce(${ofSession}, ${outside})` })
		.from(vacancies)
		.where(inArray(vacancies.id, [...vacancyIds]));
	return new Map(rows.flatMap((row) => (row.holder === null ? [] : [[row.id, row.holder] as const])));
}

/** The company holds an approved claim on the external vacancy: it may create its own vacancy from it. */
export async function holdsApprovedClaim(executor: Executor, vacancyId: string, companyId: string): Promise<boolean> {
	const [claim] = await executor
		.select({ id: vacancyClaims.id })
		.from(vacancyClaims)
		.where(
			and(
				eq(vacancyClaims.vacancyId, vacancyId),
				eq(vacancyClaims.companyId, companyId),
				eq(vacancyClaims.status, 'approved')
			)
		);
	return claim !== undefined;
}

export interface ClaimRequester {
	userId: string;
	/** The company the requester acts for; the companies module creates it by INN when it does not exist. */
	companyId: string;
	audit: AuditActor;
	requestId: string;
}

/** Files a claim on an external vacancy. */
export async function submitVacancyClaim(
	deps: ClaimDeps,
	requester: ClaimRequester,
	vacancyId: string
): Promise<ClaimRow> {
	if (!isUuid(vacancyId)) throw refuse('not_found', 'vacancy_not_found');
	return deps.db.transaction(async (tx) => {
		const [vacancy] = await tx
			.select({ origin: vacancies.origin, status: vacancies.status })
			.from(vacancies)
			.where(eq(vacancies.id, vacancyId))
			.for('update');
		if (!vacancy || vacancy.origin !== 'external' || vacancy.status === 'hidden') {
			throw refuse('not_found', 'vacancy_not_found');
		}
		const [company] = await tx
			.select({
				id: companies.id,
				status: companies.status,
				inn: companies.inn,
				legalName: companies.legalName,
				displayName: companies.displayName,
				demoSessionId: companies.demoSessionId
			})
			.from(companies)
			.where(eq(companies.id, requester.companyId))
			.for('share');
		if (!company) throw refuse('not_found', 'company_not_found');
		if ((await claimHolders(tx, [vacancyId], company.demoSessionId)).has(vacancyId)) {
			throw violation('claim_already_approved');
		}
		if (company.status === 'rejected' || company.status === 'suspended') throw violation('claim_company_not_verified');
		const [open] = await tx
			.select({ id: vacancyClaims.id })
			.from(vacancyClaims)
			.where(
				and(
					eq(vacancyClaims.vacancyId, vacancyId),
					eq(vacancyClaims.companyId, company.id),
					inArray(vacancyClaims.status, [...OPEN])
				)
			);
		if (open) throw violation('claim_exists');
		const [claim] = await tx
			.insert(vacancyClaims)
			.values({
				vacancyId,
				companyId: company.id,
				requestedByUserId: requester.userId,
				status: company.status === 'verified' ? 'pending_review' : 'awaiting_company_verification',
				matchEvidence: await evidenceFor(tx, vacancyId, company),
				demoSessionId: company.demoSessionId
			})
			.returning();
		if (!claim) throw new Error('claim was not inserted');
		await recordAuditEvent(tx, {
			action: 'vacancy_claim.submitted',
			outcome: 'success',
			actor: requester.audit,
			object: { type: 'vacancy_claim', id: claim.id },
			requestId: requester.requestId,
			details: { vacancy_id: vacancyId, status: claim.status }
		});
		return claim;
	});
}

/**
 * Moves the open claims of a company after its verification decision: verified → the claims go to the operator;
 * rejected → the claims are rejected. Called by the companies module in the transaction of the decision.
 */
export async function onCompanyVerificationDecided(
	tx: Transaction,
	companyId: string,
	decision: 'verified' | 'rejected',
	now: Date
): Promise<number> {
	const moved =
		decision === 'verified'
			? await tx
					.update(vacancyClaims)
					.set({ status: 'pending_review' })
					.where(and(eq(vacancyClaims.companyId, companyId), eq(vacancyClaims.status, 'awaiting_company_verification')))
					.returning({ id: vacancyClaims.id })
			: await tx
					.update(vacancyClaims)
					.set({ status: 'rejected', reason: 'company_rejected', decidedAt: now })
					.where(and(eq(vacancyClaims.companyId, companyId), inArray(vacancyClaims.status, [...OPEN])))
					.returning({ id: vacancyClaims.id });
	return moved.length;
}

/**
 * The requester of a claim action with the rule of filing one (contracts 5.5): a session member of a company that is
 * neither rejected nor suspended (`vacancy_claim.create`). Filing from the API or the cabinet and withdrawing a claim
 * all take the requester from here.
 */
export function claimRequesterOf(subject: AccessSubject, requestId: string): ClaimRequester {
	const decision = can(subject, 'vacancy_claim.create', null);
	const membership = subject.membership;
	if (!decision.allowed || subject.userId === null || membership === null) {
		throw new ApiError(decision.allowed || decision.reason !== 'unauthenticated' ? 'forbidden' : 'unauthenticated');
	}
	return { userId: subject.userId, companyId: membership.companyId, audit: auditActorOf(subject), requestId };
}

/**
 * The company takes back its open claim (`awaiting_company_verification | pending_review → withdrawn`): the operator no
 * longer sees it, and the company may file a new one. A claim of another company, or on another vacancy, is not found.
 */
export async function withdrawVacancyClaim(
	deps: ClaimDeps,
	requester: ClaimRequester,
	vacancyId: string,
	claimId: string
): Promise<ClaimRow> {
	if (!isUuid(vacancyId) || !isUuid(claimId)) throw refuse('not_found', 'claim_not_found');
	return deps.db.transaction(async (tx) => {
		const [claim] = await tx.select().from(vacancyClaims).where(eq(vacancyClaims.id, claimId)).for('update');
		if (claim?.companyId !== requester.companyId || claim.vacancyId !== vacancyId) {
			throw refuse('not_found', 'claim_not_found');
		}
		if (!(OPEN as readonly string[]).includes(claim.status)) throw violation('claim_not_open');
		const [row] = await tx
			.update(vacancyClaims)
			.set({ status: 'withdrawn' })
			.where(eq(vacancyClaims.id, claimId))
			.returning();
		if (!row) throw new Error('claim disappeared while locked');
		await recordAuditEvent(tx, {
			action: 'vacancy_claim.withdrawn',
			outcome: 'success',
			actor: requester.audit,
			object: { type: 'vacancy_claim', id: claimId },
			requestId: requester.requestId,
			details: { vacancy_id: vacancyId, from_status: claim.status }
		});
		return row;
	});
}

export interface ClaimDecision {
	operatorUserId: string;
	decision: 'approved' | 'rejected';
	/** Required to reject, and to approve against an INN mismatch. */
	reason: string | null;
	requestId: string;
}

/** The operator's decision on a claim waiting for review. */
export async function decideVacancyClaim(deps: ClaimDeps, claimId: string, decision: ClaimDecision): Promise<ClaimRow> {
	const reason = decision.reason?.trim() ?? '';
	return deps.db.transaction(async (tx) => {
		const [claim] = await tx.select().from(vacancyClaims).where(eq(vacancyClaims.id, claimId)).for('update');
		if (!claim) throw refuse('not_found', 'claim_not_found');
		if (claim.status !== 'pending_review') throw violation('claim_not_open');
		if (decision.decision === 'rejected' && reason === '') throw invalid('reason', 'a rejection needs a reason');
		const now = deps.now();
		if (decision.decision === 'approved') {
			if (!(await companyIsVerified(tx, claim.companyId))) throw violation('claim_company_not_verified');
			const evidence = claim.matchEvidence as Partial<ClaimEvidence>;
			if (evidence.inn === 'mismatch' && reason === '') throw violation('claim_inn_mismatch_reason_required', 'reason');
			const [vacancy] = await tx
				.select({ id: vacancies.id })
				.from(vacancies)
				.where(eq(vacancies.id, claim.vacancyId))
				.for('update');
			if (!vacancy) throw new Error('claimed vacancy is missing');
			if ((await claimHolders(tx, [claim.vacancyId], claim.demoSessionId)).has(claim.vacancyId)) {
				throw violation('claim_already_approved');
			}
			// Outside sessions the approval is recorded on the shared vacancy; a session keeps it in its claim.
			if (claim.demoSessionId === null) {
				await tx.update(vacancies).set({ claimedCompanyId: claim.companyId }).where(eq(vacancies.id, claim.vacancyId));
			}
		}
		const [row] = await tx
			.update(vacancyClaims)
			.set({
				status: decision.decision,
				decidedBy: decision.operatorUserId,
				decidedAt: now,
				reason: reason === '' ? null : reason
			})
			.where(eq(vacancyClaims.id, claimId))
			.returning();
		if (!row) throw new Error('claim disappeared while locked');
		await recordAuditEvent(tx, {
			action: 'vacancy_claim.decided',
			outcome: 'success',
			actor: { kind: 'user', userId: decision.operatorUserId },
			object: { type: 'vacancy_claim', id: claimId },
			requestId: decision.requestId,
			details: { vacancy_id: claim.vacancyId, decision: decision.decision }
		});
		return row;
	});
}
