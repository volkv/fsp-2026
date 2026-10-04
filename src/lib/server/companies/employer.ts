// Who may take a place in a company (domain 4.1, 5.3): a user is active in at most one company, and the roles of
// candidate and employer are not combined in one account (MVP policy, not the schema).
import { and, eq, ne } from 'drizzle-orm';
import type { Transaction } from '$lib/server/db';
import { candidates, users } from '$lib/server/db/schema';
import { conflict } from './context';
import { activeMembershipOf } from './subject';

/**
 * Checks the user under a row lock, so two concurrent joins of one user are ordered and the second sees the first.
 * Throws `409 conflict` with `already_candidate` or `already_employer`.
 */
export async function assertMayBecomeEmployer(tx: Transaction, userId: string): Promise<void> {
	const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
	if (!user) throw new Error(`user ${userId} does not exist`);
	const [candidate] = await tx
		.select({ id: candidates.id })
		.from(candidates)
		.where(and(eq(candidates.userId, userId), ne(candidates.status, 'deleted')));
	if (candidate) {
		throw conflict('already_candidate', 'Учётная запись кандидата не может представлять работодателя');
	}
	if (await activeMembershipOf(tx, userId)) {
		throw conflict('already_employer', 'Вы уже состоите в команде другой компании');
	}
}
