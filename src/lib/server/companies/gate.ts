// The admission of a company read at this moment (domain 5.1): the one policy is `companyAdmission` of the access
// module; this file only reads the status, optionally under a row lock, for the actions that order themselves with a
// suspension running at the same time (publication, offers).
import { eq } from 'drizzle-orm';
import { companyAdmission, type CompanyAdmission, type CompanyStatus } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import { companies } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';

export type { CompanyStatus };

/**
 * The admission of the company now. Inside a transaction that publishes or sends an offer, pass the transaction and
 * lock the company row with `forUpdate`. A missing company is a defect of the caller, who holds its id from a membership.
 */
export async function loadCompanyAdmission(
	executor: Executor,
	companyId: string,
	options: { forUpdate?: boolean } = {}
): Promise<CompanyAdmission> {
	const query = executor.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
	const [row] = options.forUpdate ? await query.for('update') : await query;
	if (!row) throw new Error(`company ${companyId} does not exist`);
	return companyAdmission(row.status);
}

const REFUSAL_MESSAGES = {
	company_suspended: 'Действия компании приостановлены оператором платформы',
	company_rejected: 'Проверка компании отклонена: действия компании закрыты'
} as const;

/** `403 forbidden` of the admission policy with its detail code (contracts 5.3). */
export function admissionRefusal(reason: keyof typeof REFUSAL_MESSAGES): ApiError {
	return new ApiError('forbidden', { details: [{ code: reason, message: REFUSAL_MESSAGES[reason] }] });
}

/** The admission now, or `403` with `company_suspended` / `company_rejected`; returns the label of an admitted company. */
export async function requireAdmission(
	executor: Executor,
	companyId: string,
	options: { forUpdate?: boolean } = {}
): Promise<'verified' | 'unverified'> {
	const admission = await loadCompanyAdmission(executor, companyId, options);
	if (!admission.admitted) throw admissionRefusal(admission.reason);
	return admission.label;
}
