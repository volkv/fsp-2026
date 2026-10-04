// What the operator reads about companies besides the verification queue of the companies module: the directory of
// companies with their status (moderation and partnerships start there), the moderation card of one company, and the
// facts of a verification case the service does not carry — the registry record behind the hint and the domain of the
// applicant's address for the `corporate_email_domain` method. Decisions stay in `companies/verification.ts`. The
// operator sees the companies within its reach: a clone operator of a demo session — those of its session only
// (domain 19.3).
import { and, asc, count, desc, eq, ilike, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { requirePermission } from '$lib/server/companies/context';
import type { CompanyStatus } from '$lib/server/companies/gate';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Executor } from '$lib/server/db';
import { companies, companyMembers, companyVerifications, users } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';

const STATUSES: readonly CompanyStatus[] = ['draft', 'submitted', 'verified', 'rejected', 'suspended'];

export function parseCompanyStatus(value: string | null): CompanyStatus | null {
	return STATUSES.find((status) => status === value) ?? null;
}

export interface DirectoryQuery {
	status: CompanyStatus | null;
	/** Part of the name or the taxpayer number. */
	q: string;
}

export interface DirectoryItem {
	id: string;
	inn: string;
	displayName: string;
	legalName: string;
	status: CompanyStatus;
	verifiedAt: Date | null;
}

const DIRECTORY_LIMIT = 100;

/** Companies by status and name or INN, newest first; at most 100 rows. */
export async function companyDirectory(
	executor: Executor,
	subject: AccessSubject,
	query: DirectoryQuery
): Promise<{ items: DirectoryItem[]; truncated: boolean; counts: Record<CompanyStatus, number> }> {
	requirePermission(subject, 'company.moderate', { companyStatus: 'verified' });
	const scope = (await StaffReach.of(executor, subject)).rows(companies.demoSessionId);
	const conditions: SQL[] = [scope];
	if (query.status !== null) conditions.push(eq(companies.status, query.status));
	const text = query.q.trim();
	if (text !== '') {
		const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		const byText = or(
			ilike(companies.displayName, pattern),
			ilike(companies.legalName, pattern),
			ilike(companies.inn, pattern)
		);
		if (byText) conditions.push(byText);
	}
	const rows = await executor
		.select({
			id: companies.id,
			inn: companies.inn,
			displayName: companies.displayName,
			legalName: companies.legalName,
			status: companies.status,
			verifiedAt: companies.verifiedAt
		})
		.from(companies)
		.where(and(...conditions))
		.orderBy(desc(companies.createdAt), asc(companies.id))
		.limit(DIRECTORY_LIMIT + 1);
	const byStatus = await executor
		.select({ status: companies.status, n: count() })
		.from(companies)
		.where(scope)
		.groupBy(companies.status);
	const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<CompanyStatus, number>;
	for (const row of byStatus) counts[row.status] = row.n;
	return { items: rows.slice(0, DIRECTORY_LIMIT), truncated: rows.length > DIRECTORY_LIMIT, counts };
}

export interface ModerationCard {
	id: string;
	inn: string;
	ogrn: string | null;
	kpp: string | null;
	legalName: string;
	displayName: string;
	status: CompanyStatus;
	verifiedAt: Date | null;
	activeMembers: { owners: number; recruiters: number };
	/** Every verification request, newest first. */
	verifications: {
		id: string;
		decision: 'approved' | 'rejected' | 'needs_info' | null;
		reason: string | null;
		submittedAt: Date;
		decidedAt: Date | null;
	}[];
}

/** One company as the operator moderates it: status, requisites, team size and the history of its requests. */
export async function moderationCard(
	executor: Executor,
	subject: AccessSubject,
	companyId: string
): Promise<ModerationCard> {
	requirePermission(subject, 'company.moderate', { companyStatus: 'verified' });
	if (!z.uuid().safeParse(companyId).success) throw new ApiError('not_found');
	const [company] = await executor.select().from(companies).where(eq(companies.id, companyId));
	if (!company) throw new ApiError('not_found');
	(await StaffReach.of(executor, subject)).require(company.demoSessionId);
	const members = await executor
		.select({ role: companyMembers.role, n: count() })
		.from(companyMembers)
		.where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.status, 'active')))
		.groupBy(companyMembers.role);
	const verifications = await executor
		.select({
			id: companyVerifications.id,
			decision: companyVerifications.decision,
			reason: companyVerifications.reason,
			submittedAt: companyVerifications.createdAt,
			decidedAt: companyVerifications.decidedAt
		})
		.from(companyVerifications)
		.where(eq(companyVerifications.companyId, companyId))
		.orderBy(desc(companyVerifications.createdAt));
	return {
		id: company.id,
		inn: company.inn,
		ogrn: company.ogrn,
		kpp: company.kpp,
		legalName: company.legalName,
		displayName: company.displayName,
		status: company.status,
		verifiedAt: company.verifiedAt,
		activeMembers: {
			owners: members.find((row) => row.role === 'owner')?.n ?? 0,
			recruiters: members.find((row) => row.role === 'recruiter')?.n ?? 0
		},
		verifications
	};
}

/** `companies.registry_snapshot`: the registry record stored by the lookup job when the INN was found. */
const registryRecordSchema = z.strictObject({
	inn: z.string(),
	kind: z.enum(['organization', 'entrepreneur']),
	name: z.string(),
	shortName: z.string().nullable(),
	ogrn: z.string().nullable(),
	kpp: z.string().nullable(),
	registeredOn: z.string().nullable(),
	endedOn: z.string().nullable(),
	head: z.string().nullable(),
	region: z.string().nullable()
});

export type RegistryRecordView = z.infer<typeof registryRecordSchema>;

/** The stored registry record; `null` — nothing was found or the lookup has not answered. */
export function registryRecordOf(snapshot: unknown): RegistryRecordView | null {
	return snapshot === null ? null : registryRecordSchema.parse(snapshot);
}

/**
 * The domain of the applicant's sign-in address: what the operator compares with the company's site when the authority
 * is confirmed by a corporate address. Only the part after «@» leaves this function. `null` — the applicant has no
 * address any more (a deleted account).
 */
export async function applicantEmailDomain(
	executor: Executor,
	crypto: FieldCrypto,
	applicantMemberId: string
): Promise<string | null> {
	const [row] = await executor
		.select({ emailEnc: users.emailEnc })
		.from(companyMembers)
		.innerJoin(users, eq(users.id, companyMembers.userId))
		.where(eq(companyMembers.id, applicantMemberId));
	if (!row?.emailEnc) return null;
	const email = crypto.decrypt(row.emailEnc, 'users.email');
	const at = email.lastIndexOf('@');
	if (at < 0) throw new Error('a stored address has no domain');
	return email.slice(at + 1).toLowerCase();
}

/** Verified companies by name, for the partnership form. */
export async function verifiedCompanies(
	executor: Executor,
	subject: AccessSubject
): Promise<{ id: string; displayName: string; inn: string }[]> {
	requirePermission(subject, 'partnership.manage', null);
	return executor
		.select({ id: companies.id, displayName: companies.displayName, inn: companies.inn })
		.from(companies)
		.where(
			and(eq(companies.status, 'verified'), (await StaffReach.of(executor, subject)).rows(companies.demoSessionId))
		)
		.orderBy(asc(companies.displayName));
}
