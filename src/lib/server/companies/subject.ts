// The access subject of a request, read from the database every time (domain 4.2): membership and company status are
// never cached in a session or a key, so a removed member or a suspended company loses access on the next request.
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Actor } from '$lib/server/access/actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import { candidates, companies, companyMembers, staffRoles } from '$lib/server/db/schema';

const NO_STAFF: AccessSubject['staff'] = { operator: false, admin: false, extraPermissions: [] };

type Membership = NonNullable<AccessSubject['membership']>;

const membershipColumns = {
	memberId: companyMembers.id,
	companyId: companyMembers.companyId,
	role: companyMembers.role,
	status: companyMembers.status,
	companyStatus: companies.status
};

/** The active membership of a user; a user is active in at most one company (domain 5.3). */
export async function activeMembershipOf(executor: Executor, userId: string): Promise<Membership | null> {
	const rows = await executor
		.select(membershipColumns)
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(and(eq(companyMembers.userId, userId), eq(companyMembers.status, 'active')))
		.limit(2);
	if (rows.length > 1) throw new Error(`user ${userId} is active in more than one company`);
	return rows[0] ?? null;
}

async function membershipById(executor: Executor, memberId: string): Promise<Membership | null> {
	const [row] = await executor
		.select(membershipColumns)
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(eq(companyMembers.id, memberId));
	return row ?? null;
}

async function staffOf(executor: Executor, userId: string): Promise<AccessSubject['staff']> {
	const rows = await executor
		.select({ role: staffRoles.role, extra: staffRoles.extraPermissions })
		.from(staffRoles)
		.where(and(eq(staffRoles.userId, userId), isNull(staffRoles.revokedAt)));
	return {
		operator: rows.some((row) => row.role === 'operator'),
		admin: rows.some((row) => row.role === 'admin'),
		extraPermissions: rows.filter((row) => row.role === 'operator').flatMap((row) => row.extra)
	};
}

export async function loadAccessSubject(executor: Executor, actor: Actor): Promise<AccessSubject> {
	switch (actor.kind) {
		case 'anonymous':
			return { userId: null, via: 'anonymous', candidate: null, membership: null, staff: NO_STAFF };
		case 'api_key':
			// The key acts on behalf of its creator's membership only: no candidate or staff roles (contracts 5.2).
			return {
				userId: actor.userId,
				via: 'api_key',
				apiKeyPermissions: actor.permissions,
				candidate: null,
				membership: await membershipById(executor, actor.memberId),
				staff: NO_STAFF
			};
		case 'session': {
			const [candidate] = await executor
				.select({ id: candidates.id, status: candidates.status })
				.from(candidates)
				.where(and(eq(candidates.userId, actor.userId), ne(candidates.status, 'deleted')));
			return {
				userId: actor.userId,
				via: 'session',
				candidate: candidate ?? null,
				membership: await activeMembershipOf(executor, actor.userId),
				staff: await staffOf(executor, actor.userId)
			};
		}
	}
}
