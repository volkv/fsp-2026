// Reads of the company row shared by the services of this module.
import { eq } from 'drizzle-orm';
import type { Transaction } from '$lib/server/db';
import { companies } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';

export type CompanyRow = typeof companies.$inferSelect;

/**
 * The company under a row lock: every change of its status, its members and its keys takes this lock first, so the
 * checks of a change (last owner, status of the company) see the state the change is committed against.
 */
export async function lockCompany(tx: Transaction, companyId: string): Promise<CompanyRow> {
	const [row] = await tx.select().from(companies).where(eq(companies.id, companyId)).for('update');
	if (!row) throw new ApiError('not_found');
	return row;
}
