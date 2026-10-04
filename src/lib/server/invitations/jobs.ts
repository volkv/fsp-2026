// Jobs of terms versions (docs/domain.md, sections 13.5, 17.2): `invitation.expire` closes an unanswered invitation at
// the deadline of its current version, `invitation.remind_due` reminds the candidate before it. A version that was
// replaced or answered meanwhile makes the job stale: nothing is written.
import { eq } from 'drizzle-orm';
import type { Transaction } from '$lib/server/db';
import { candidates, invitationResponses, invitations, invitationTerms } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { notify } from '$lib/server/notifications/notify';
import { companyRecipients } from './notifications';
import { reminderHours, reminderSlots, scheduleNextReminder } from './schedule';

interface Clock {
	now: () => Date;
}

type InvitationRow = typeof invitations.$inferSelect;
type TermsRow = typeof invitationTerms.$inferSelect;

/** The version, its invitation and whether it is still waiting for an answer, locked for the write. */
async function awaitingAnswer(
	tx: Transaction,
	termsId: string
): Promise<{ invitation: InvitationRow; terms: TermsRow } | null> {
	const [terms] = await tx.select().from(invitationTerms).where(eq(invitationTerms.id, termsId));
	if (!terms) return null;
	const [invitation] = await tx.select().from(invitations).where(eq(invitations.id, terms.invitationId)).for('update');
	if (!invitation || invitation.purgedAt !== null || invitation.currentTermsId !== termsId) return null;
	const [answered] = await tx
		.select({ id: invitationResponses.id })
		.from(invitationResponses)
		.where(eq(invitationResponses.termsId, termsId));
	if (answered) return null;
	const waiting =
		invitation.status === 'sent' ||
		invitation.status === 'viewed' ||
		(invitation.status === 'accepted' && invitation.acceptedTermsId !== termsId);
	return waiting ? { invitation, terms } : null;
}

async function candidateUser(tx: Transaction, candidateId: string): Promise<string> {
	const [row] = await tx.select({ userId: candidates.userId }).from(candidates).where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} does not exist`);
	return row.userId;
}

/**
 * The deadline of the current version passed without an answer: an open invitation expires. A revision of an accepted
 * invitation left unanswered changes nothing — the accepted version stays in force.
 */
export function createInvitationExpireHandler(clock: Clock): JobHandler<'invitation.expire'> {
	return defineHandler({
		type: 'invitation.expire',
		concurrency: 4,
		async run({ job, db }): Promise<JobResult> {
			const termsId = job.payload.terms_id;
			const [terms] = await db
				.select({ responseDueAt: invitationTerms.responseDueAt })
				.from(invitationTerms)
				.where(eq(invitationTerms.id, termsId));
			// Captured before the deadline by the clock of the application: back to the queue until it passes.
			const early = terms ? terms.responseDueAt.getTime() - clock.now().getTime() : 0;
			if (early > 0) {
				throw new JobFailure('not_due', 'the response deadline has not passed yet', {
					retryable: true,
					retryAfterSeconds: Math.ceil(early / 1000)
				});
			}
			let pending: { invitation: InvitationRow; terms: TermsRow } | null = null;
			return {
				isCurrent: async (tx) => {
					pending = await awaitingAnswer(tx, termsId);
					return pending !== null && pending.invitation.status !== 'accepted';
				},
				write: async (tx) => {
					if (!pending) throw new Error('write without a checked version');
					const { invitation, terms } = pending;
					const now = clock.now();
					await tx
						.update(invitations)
						.set({ status: 'expired', closedAt: now })
						.where(eq(invitations.id, invitation.id));
					const recipients = [
						await candidateUser(tx, invitation.candidateId),
						...(await companyRecipients(tx, invitation))
					];
					for (const userId of recipients) {
						await notify(tx, {
							userId,
							type: 'invitation.expired',
							objectId: invitation.id,
							stage: `v${terms.version}:${userId}`,
							payload: { invitation_id: invitation.id, terms_id: terms.id }
						});
					}
				},
				describe: () => ({ terms_id: termsId })
			};
		}
	});
}

/** Reminds the candidate of every reminder slot that has come, then schedules the next slot. */
export function createInvitationRemindDueHandler(clock: Clock): JobHandler<'invitation.remind_due'> {
	return defineHandler({
		type: 'invitation.remind_due',
		concurrency: 4,
		run({ job }): Promise<JobResult> {
			const termsId = job.payload.terms_id;
			let pending: { invitation: InvitationRow; terms: TermsRow } | null = null;
			let sent = 0;
			return Promise.resolve({
				isCurrent: async (tx) => {
					pending = await awaitingAnswer(tx, termsId);
					return pending !== null && pending.terms.responseDueAt > clock.now();
				},
				write: async (tx) => {
					if (!pending) throw new Error('write without a checked version');
					const { invitation, terms } = pending;
					const now = clock.now();
					const hours = await reminderHours(tx, now);
					const userId = await candidateUser(tx, invitation.candidateId);
					for (const slot of reminderSlots(terms.responseDueAt, hours).filter((s) => s.at <= now)) {
						const created = await notify(tx, {
							userId,
							type: 'invitation.response_due_soon',
							objectId: invitation.id,
							stage: `v${terms.version}:${slot.hours}h`,
							payload: { invitation_id: invitation.id, terms_id: terms.id, hours_left: slot.hours }
						});
						if (created) sent++;
					}
					await scheduleNextReminder(tx, terms, hours, now);
				},
				describe: () => ({ terms_id: termsId, reminders: sent })
			});
		}
	});
}

export const invitationExpire = createInvitationExpireHandler({ now: () => new Date() });
export const invitationRemindDue = createInvitationRemindDueHandler({ now: () => new Date() });
