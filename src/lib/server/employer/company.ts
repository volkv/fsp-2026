// The company of the signed-in member as every page of the cabinet shows it: its name and status, read on each request
// (domain 4.2), so a suspension shows at once. Requisites and the verification request are the owner's
// (`companyOverview` of the companies module).
import { eq } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { companies } from '$lib/server/db/schema';
import type { CompanyStatus } from '$lib/server/companies/gate';

export interface CompanyHeader {
	id: string;
	displayName: string;
	status: CompanyStatus;
}

export async function companyHeader(executor: Executor, companyId: string): Promise<CompanyHeader> {
	const [row] = await executor
		.select({ id: companies.id, displayName: companies.displayName, status: companies.status })
		.from(companies)
		.where(eq(companies.id, companyId));
	if (!row) throw new Error(`company ${companyId} of an active membership does not exist`);
	return row;
}
