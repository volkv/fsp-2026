// Closing a request of a confirmation by a result (docs/domain.md, 13.11): the request becomes `completed` with the
// result that closed it, the requesting company is told the verdict. Called by the block test when its four clusters are
// scored and by the candidate's acceptance when a result of the block on the same or a higher grade already exists.
import { eq } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Transaction } from '$lib/server/db';
import { confirmationRequests } from '$lib/server/db/schema';
import { companyRecipients } from '$lib/server/invitations/notifications';
import { cancelWaitingJobs } from '$lib/server/jobs/queue';
import { notify } from '$lib/server/notifications/notify';

export async function completeRequest(
	tx: Transaction,
	requestId: string,
	confirmationId: string,
	context: { now: Date; requestId: string; verdict: 'confirmed' | 'not_confirmed' }
): Promise<void> {
	const [request] = await tx
		.update(confirmationRequests)
		.set({ status: 'completed', confirmationId, answeredAt: context.now })
		.where(eq(confirmationRequests.id, requestId))
		.returning();
	if (!request) throw new Error(`confirmation request ${requestId} is missing`);
	await cancelWaitingJobs(tx, 'confirmation.expire', { request_id: request.id });
	for (const userId of await companyRecipients(tx, {
		companyId: request.companyId,
		sentByMemberId: request.requestedByMemberId
	})) {
		await notify(tx, {
			userId,
			type: 'confirmation.completed',
			objectId: request.id,
			stage: userId,
			payload: { request_id: request.id, verdict: context.verdict }
		});
	}
	await recordAuditEvent(tx, {
		action: 'confirmation.completed',
		outcome: 'success',
		actor: { kind: 'system' },
		object: { type: 'confirmation_request', id: request.id },
		subjectCandidateId: request.candidateId,
		requestId: context.requestId,
		details: { verdict: context.verdict, confirmation_id: confirmationId },
		occurredAt: context.now
	});
}
