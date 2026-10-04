// What follows a change of a vacancy (docs/domain.md, sections 13.3, 13.4, 17): the vector and the matches are derived
// from `vacancies.revision`, so every change that raises it — and every publication — enqueues their recalculation in
// the transaction of the change.
import type { Transaction } from '$lib/server/db';
import { loadCompanyGate } from '$lib/server/companies/gate';
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
 * Whether the company may publish right now (`companyGate` of the companies module), read with the company row locked
 * so that a concurrent suspension is ordered with the publication. The single place vacancies read company status.
 */
export async function companyIsVerified(tx: Transaction, companyId: string): Promise<boolean> {
	return (await loadCompanyGate(tx, companyId, { forUpdate: true })).allowed;
}
