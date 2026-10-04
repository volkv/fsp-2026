// Recipients of the company side of invitation and hiring notifications (docs/domain.md, section 3.7). Notifications
// themselves are created by `$lib/server/notifications/notify`.
import { and, eq } from 'drizzle-orm';
import type { Transaction } from '$lib/server/db';
import { companyMembers } from '$lib/server/db/schema';

/**
 * Users who receive the company side of an invitation: the member who sent it while active, otherwise the active
 * owners of the company.
 */
export async function companyRecipients(
	tx: Transaction,
	invitation: { companyId: string; sentByMemberId: string }
): Promise<string[]> {
	const [sender] = await tx
		.select({ userId: companyMembers.userId, status: companyMembers.status })
		.from(companyMembers)
		.where(eq(companyMembers.id, invitation.sentByMemberId));
	if (sender?.status === 'active' && sender.userId !== null) return [sender.userId];
	const owners = await tx
		.select({ userId: companyMembers.userId })
		.from(companyMembers)
		.where(
			and(
				eq(companyMembers.companyId, invitation.companyId),
				eq(companyMembers.role, 'owner'),
				eq(companyMembers.status, 'active')
			)
		);
	return owners.flatMap((owner) => (owner.userId === null ? [] : [owner.userId]));
}
