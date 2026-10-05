// The candidate's list of blocked companies (docs/domain.md, sections 7.1, 7.4): a company on it does not see the
// candidate — not in the catalog, not in its shortlists and matches, not by a direct address. The rule itself lives in
// the visibility of the catalog (`canShow` and the search condition read `candidate_company_blocks` at every request),
// so a block takes effect at the next request of the company; here the candidate keeps the list.
import { and, asc, eq, ilike, notExists, sql } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database, Executor } from '$lib/server/db';
import { candidateCompanyBlocks, candidates, companies } from '$lib/server/db/schema';
import { demoScope } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { selfCandidate } from '$lib/server/resumes/deps';

export interface BlockedCompany {
	companyId: string;
	displayName: string;
	blockedAt: Date;
}

export interface CompanyOption {
	companyId: string;
	displayName: string;
}

/** Most companies one search offers. */
const SEARCH_LIMIT = 20;
const QUERY_MIN = 2;

export interface CompanyBlockDeps {
	db: Database;
	now: () => Date;
}

async function candidateSession(executor: Executor, candidateId: string): Promise<string | null> {
	const [row] = await executor
		.select({ session: candidates.demoSessionId })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new ApiError('not_found');
	return row.session;
}

export async function listBlockedCompanies(executor: Executor, candidateId: string): Promise<BlockedCompany[]> {
	return executor
		.select({
			companyId: candidateCompanyBlocks.companyId,
			displayName: companies.displayName,
			blockedAt: candidateCompanyBlocks.createdAt
		})
		.from(candidateCompanyBlocks)
		.innerJoin(companies, eq(companies.id, candidateCompanyBlocks.companyId))
		.where(eq(candidateCompanyBlocks.candidateId, candidateId))
		.orderBy(asc(companies.displayName));
}

const escapeLike = (value: string) => value.replace(/[\\%_]/gu, (char) => `\\${char}`);

/**
 * Companies by their name the candidate can block: the companies of the platform the candidate's place sees (a demo
 * session sees its own), not on the list already. A query shorter than two letters finds nothing.
 */
export async function findCompaniesToBlock(
	executor: Executor,
	candidateId: string,
	query: string
): Promise<CompanyOption[]> {
	const text = query.trim();
	if (text.length < QUERY_MIN) return [];
	const session = await candidateSession(executor, candidateId);
	return executor
		.select({ companyId: companies.id, displayName: companies.displayName })
		.from(companies)
		.where(
			and(
				ilike(companies.displayName, `%${escapeLike(text)}%`),
				demoScope(companies, session),
				notExists(
					executor
						.select({ one: sql`1` })
						.from(candidateCompanyBlocks)
						.where(
							and(
								eq(candidateCompanyBlocks.candidateId, candidateId),
								eq(candidateCompanyBlocks.companyId, companies.id)
							)
						)
				)
			)
		)
		.orderBy(asc(companies.displayName))
		.limit(SEARCH_LIMIT);
}

async function journal(
	executor: Executor,
	deps: CompanyBlockDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	candidateId: string,
	action: 'company_block.added' | 'company_block.removed',
	companyId: string
) {
	await recordAuditEvent(executor, {
		action,
		outcome: 'success',
		actor: auditActor(subject, meta, 'candidate'),
		object: { type: 'company', id: companyId },
		subjectCandidateId: candidateId,
		requestId: meta.requestId,
		ip: meta.ip ?? null,
		userAgent: meta.userAgent ?? null,
		details: { company_id: companyId },
		occurredAt: deps.now()
	});
}

/** Puts a company on the list; a company already there stays as it was. A company the candidate cannot see is `404`. */
export async function blockCompany(
	deps: CompanyBlockDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	companyId: string
): Promise<void> {
	const { candidateId } = selfCandidate(subject);
	await deps.db.transaction(async (tx) => {
		const session = await candidateSession(tx, candidateId);
		const [company] = await tx
			.select({ id: companies.id })
			.from(companies)
			.where(and(eq(companies.id, companyId), demoScope(companies, session)));
		if (!company) throw new ApiError('not_found');
		const inserted = await tx
			.insert(candidateCompanyBlocks)
			.values({ candidateId, companyId, createdAt: deps.now() })
			.onConflictDoNothing()
			.returning({ companyId: candidateCompanyBlocks.companyId });
		if (inserted.length > 0) await journal(tx, deps, subject, meta, candidateId, 'company_block.added', companyId);
	});
}

/** Takes a company off the list; a company not on it is `404`. */
export async function unblockCompany(
	deps: CompanyBlockDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	companyId: string
): Promise<void> {
	const { candidateId } = selfCandidate(subject);
	await deps.db.transaction(async (tx) => {
		const removed = await tx
			.delete(candidateCompanyBlocks)
			.where(and(eq(candidateCompanyBlocks.candidateId, candidateId), eq(candidateCompanyBlocks.companyId, companyId)))
			.returning({ companyId: candidateCompanyBlocks.companyId });
		if (removed.length === 0) throw new ApiError('not_found');
		await journal(tx, deps, subject, meta, candidateId, 'company_block.removed', companyId);
	});
}
