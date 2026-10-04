// Whether a company may act towards candidates right now: publish own vacancies, invite, search the catalog and read
// partner pools (domain 4.2, 5.1). Only a verified company may; `suspended` and `rejected` close all of it at once.
// Vacancies and invitations call this predicate instead of comparing statuses themselves.
import { eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { companies } from '$lib/server/db/schema';

export type CompanyStatus = (typeof companies.$inferSelect)['status'];

export type CompanyGateDenial = 'company_not_found' | 'company_not_verified' | 'company_suspended' | 'company_rejected';

export type CompanyGate = { allowed: true } | { allowed: false; reason: CompanyGateDenial };

/** Pure form: the status read by the caller in its own query. `null` — no such company. */
export function companyGate(status: CompanyStatus | null): CompanyGate {
	switch (status) {
		case 'verified':
			return { allowed: true };
		case 'suspended':
			return { allowed: false, reason: 'company_suspended' };
		case 'rejected':
			return { allowed: false, reason: 'company_rejected' };
		case 'draft':
		case 'submitted':
			return { allowed: false, reason: 'company_not_verified' };
		case null:
			return { allowed: false, reason: 'company_not_found' };
	}
}

/**
 * Reads the status at this moment. Inside a transaction that publishes or invites, pass the transaction and lock the
 * company row with `forUpdate` so a concurrent suspension is ordered with the action.
 */
export async function loadCompanyGate(
	executor: Executor,
	companyId: string,
	options: { forUpdate?: boolean } = {}
): Promise<CompanyGate> {
	const query = executor.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
	const [row] = options.forUpdate ? await query.for('update') : await query;
	return companyGate(row?.status ?? null);
}
