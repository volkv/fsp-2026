// `hiring.outcome_request` (docs/domain.md, sections 13.7, 17.2): at the due date of a process and then on the reminder
// schedule of its `hiring_policy`, the sides that have not reported the outcome are asked for it. Request `0` is
// `hiring.outcome_requested`, the following ones `hiring.outcome_reminder`; after the last one the process becomes
// `unknown` by derivation, nothing is written for it.
import { eq } from 'drizzle-orm';
import type { Transaction } from '$lib/server/db';
import { candidates, companies, hiringProcesses } from '$lib/server/db/schema';
import { defineHandler, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { enqueueJob } from '$lib/server/jobs/queue';
import { notify } from '$lib/server/notifications/notify';
import { policyById } from '$lib/server/invitations/policies';
import { companyRecipientsOfProcess, processReports } from './process';
import { hiringState, outcomeRequestAt, type Party } from './state';

interface Clock {
	now: () => Date;
}

type ProcessRow = typeof hiringProcesses.$inferSelect;

async function recipientsOf(tx: Transaction, process: ProcessRow, party: Party): Promise<string[]> {
	if (party === 'candidate') {
		const [row] = await tx
			.select({ userId: candidates.userId, status: candidates.status })
			.from(candidates)
			.where(eq(candidates.id, process.candidateId));
		return row && row.status === 'active' ? [row.userId] : [];
	}
	// A suspended company no longer reports, so it is not asked to (domain 13.7).
	const [company] = await tx
		.select({ status: companies.status })
		.from(companies)
		.where(eq(companies.id, process.companyId));
	return company?.status === 'verified' ? companyRecipientsOfProcess(tx, process) : [];
}

export function createHiringOutcomeRequestHandler(clock: Clock): JobHandler<'hiring.outcome_request'> {
	return defineHandler({
		type: 'hiring.outcome_request',
		concurrency: 4,
		run({ job }): Promise<JobResult> {
			const { process_id: processId, reminder } = job.payload;
			let process: ProcessRow | null = null;
			let missing: Party[] = [];
			let asked = 0;
			return Promise.resolve({
				isCurrent: async (tx) => {
					const [row] = await tx.select().from(hiringProcesses).where(eq(hiringProcesses.id, processId)).for('update');
					if (!row) return false;
					process = row;
					const policy = await policyById(tx, 'hiring_policy', row.policyId);
					const state = hiringState(row, await processReports(tx, row.id), policy.params, clock.now());
					missing = (['company', 'candidate'] as const).filter((party) => state.reports[party] === null);
					return missing.length > 0;
				},
				write: async (tx) => {
					if (!process) throw new Error('write without a checked process');
					const current = process;
					const type = reminder === 0 ? 'hiring.outcome_requested' : 'hiring.outcome_reminder';
					for (const party of missing) {
						for (const userId of await recipientsOf(tx, current, party)) {
							if (
								await notify(tx, {
									userId,
									type,
									objectId: current.id,
									stage: `${reminder}:${party}:${userId}`,
									payload: { process_id: current.id, reminder, party }
								})
							) {
								asked++;
							}
						}
					}
					const policy = await policyById(tx, 'hiring_policy', current.policyId);
					const next = outcomeRequestAt(current.outcomeDueAt, policy.params, reminder + 1);
					if (next) {
						await enqueueJob(
							tx,
							'hiring.outcome_request',
							{ process_id: current.id, reminder: reminder + 1 },
							{ inputVersion: `${current.id}:${reminder + 1}`, createdBy: { kind: 'system' }, runAfter: next }
						);
					}
				},
				describe: () => ({ process_id: processId, reminder, asked })
			});
		}
	});
}

export const hiringOutcomeRequest = createHiringOutcomeRequestHandler({ now: () => new Date() });
