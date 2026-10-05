// What follows a change of a vacancy (docs/domain.md, sections 13.3, 13.4, 17): the vector and the matches are derived
// from `vacancies.revision`, so every change that raises it — and every publication — enqueues their recalculation in
// the transaction of the change.
import { eq } from 'drizzle-orm';
import type { Transaction } from '$lib/server/db';
import { companies } from '$lib/server/db/schema';
import { loadCompanyAdmission } from '$lib/server/companies/gate';
import { enqueueJob, type JobCreator } from '$lib/server/jobs/queue';

/** `match.refresh` of the vacancy: its matches and its pool counter at this revision. */
export async function enqueueMatchRefresh(tx: Transaction, vacancyId: string, revision: number, createdBy: JobCreator) {
	await enqueueJob(
		tx,
		'match.refresh',
		{ scope: 'vacancy', vacancy_id: vacancyId },
		{ inputVersion: String(revision), createdBy }
	);
}

/** `vacancy.embed` and `match.refresh` of a new revision of the vacancy. */
export async function enqueueRevisionDerivations(
	tx: Transaction,
	vacancyId: string,
	revision: number,
	createdBy: JobCreator
) {
	await enqueueJob(tx, 'vacancy.embed', { vacancy_id: vacancyId }, { inputVersion: String(revision), createdBy });
	await enqueueMatchRefresh(tx, vacancyId, revision, createdBy);
}

/**
 * Whether the company may publish right now — the admission policy (domain 5.1), read with the company row locked so
 * that a concurrent suspension is ordered with the publication.
 */
export async function companyAdmitted(tx: Transaction, companyId: string): Promise<boolean> {
	return (await loadCompanyAdmission(tx, companyId, { forUpdate: true })).admitted;
}

/**
 * Whether an operator has verified the company, under the same row lock: a «this is our vacancy» claim goes to review
 * only for a verified company (domain 13.3) — a property of the claim, not of the admission.
 */
export async function companyIsVerified(tx: Transaction, companyId: string): Promise<boolean> {
	const [row] = await tx
		.select({ status: companies.status })
		.from(companies)
		.where(eq(companies.id, companyId))
		.for('update');
	if (!row) throw new Error(`company ${companyId} does not exist`);
	return row.status === 'verified';
}
