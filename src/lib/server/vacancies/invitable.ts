// `isInvitable(vacancy)` — the only check whether a company may invite by a vacancy (docs/domain.md, section 13.1).
import { eq } from 'drizzle-orm';
import { companyGate, type CompanyGate } from '$lib/server/companies/gate';
import type { Executor } from '$lib/server/db';
import { companies, vacancies } from '$lib/server/db/schema';

export interface InvitabilityFacts {
	origin: 'own' | 'external';
	status: string;
	/** Whether the vacancy's company may act now (`companies/gate.ts`); an external vacancy has no company. */
	company: CompanyGate;
	salaryMin: number | null;
	salaryMax: number | null;
	salaryTaxBase: 'gross' | 'net' | 'unknown' | null;
}

export type InvitabilityDenial = 'external_vacancy' | 'company_not_verified' | 'not_published' | 'incomplete_salary';

export type Invitability = { invitable: true } | { invitable: false; reason: InvitabilityDenial };

/**
 * An own vacancy of a verified company, published, with both salary bounds and a known tax base. An external
 * vacancy is never invitable, including one with an approved «this is our vacancy» claim.
 */
export function isInvitable(vacancy: InvitabilityFacts): Invitability {
	if (vacancy.origin !== 'own') return { invitable: false, reason: 'external_vacancy' };
	if (!vacancy.company.allowed) return { invitable: false, reason: 'company_not_verified' };
	if (vacancy.status !== 'published') return { invitable: false, reason: 'not_published' };
	if (
		vacancy.salaryMin === null ||
		vacancy.salaryMax === null ||
		vacancy.salaryTaxBase === null ||
		vacancy.salaryTaxBase === 'unknown'
	) {
		return { invitable: false, reason: 'incomplete_salary' };
	}
	return { invitable: true };
}

/** Reads the vacancy and the status of its company at this moment; `null` — no such vacancy. */
export async function loadInvitability(executor: Executor, vacancyId: string): Promise<Invitability | null> {
	const [row] = await executor
		.select({
			origin: vacancies.origin,
			status: vacancies.status,
			companyStatus: companies.status,
			salaryMin: vacancies.salaryMin,
			salaryMax: vacancies.salaryMax,
			salaryTaxBase: vacancies.salaryTaxBase
		})
		.from(vacancies)
		.leftJoin(companies, eq(companies.id, vacancies.companyId))
		.where(eq(vacancies.id, vacancyId));
	if (!row) return null;
	const { companyStatus, ...vacancy } = row;
	return isInvitable({ ...vacancy, company: companyGate(companyStatus) });
}
