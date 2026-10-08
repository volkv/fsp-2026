// What deleting an account means for the signed-in person before they confirm it (docs/domain.md, sections 3.1, 19):
// whether a candidate profile goes with it, what blocks the deletion (a staff role, the last owner of a company), how
// many companies already hold the candidate's contacts, and the words of a refusal. The cabinet page and the public API
// read the same overview and tell the same refusals.
import { and, count, eq, isNull, ne } from 'drizzle-orm';
import { FRESH_AUTH_SECONDS, isFreshAuth } from '$lib/server/auth/sessions';
import type { Executor } from '$lib/server/db';
import { candidates, companies, companyMembers, disclosures, staffRoles } from '$lib/server/db/schema';
import type { DeletionResult } from './request';

export interface DeletionOverview {
	/** A candidate profile is deleted with the account; for a candidate it is also the revocation of `pd_processing`. */
	candidate: boolean;
	/** A staff role in force: an administrator takes it away first. */
	staff: boolean;
	/** The active membership; the last owner hands the company over first. */
	membership: { companyName: string; role: (typeof companyMembers.$inferSelect)['role'] } | null;
	/** The company whose only active owner the person is: ownership is handed over first; `null` — none. */
	lastOwnerOf: string | null;
	/** Companies that received the candidate's contacts: they keep them after the deletion. */
	companiesWithContacts: number;
	/** The sign-in is recent enough to confirm the deletion; otherwise the person signs in again first. */
	freshAuth: boolean;
	/** Until when the confirmation is accepted without signing in again; `null` — not now. */
	freshAuthUntil: Date | null;
}

export async function deletionOverview(
	executor: Executor,
	session: { userId: string; authTime: Date },
	now: Date
): Promise<DeletionOverview> {
	const [profile] = await executor
		.select({ id: candidates.id })
		.from(candidates)
		.where(and(eq(candidates.userId, session.userId), ne(candidates.status, 'deleted')));
	const [staff] = await executor
		.select({ id: staffRoles.id })
		.from(staffRoles)
		.where(and(eq(staffRoles.userId, session.userId), isNull(staffRoles.revokedAt)))
		.limit(1);
	const [membership] = await executor
		.select({ companyId: companies.id, companyName: companies.displayName, role: companyMembers.role })
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(and(eq(companyMembers.userId, session.userId), eq(companyMembers.status, 'active')))
		.limit(1);
	const handedOver = profile
		? await executor
				.selectDistinct({ companyId: disclosures.companyId })
				.from(disclosures)
				.where(eq(disclosures.candidateId, profile.id))
		: [];
	let lastOwnerOf: string | null = null;
	if (membership?.role === 'owner') {
		const [owners] = await executor
			.select({ n: count() })
			.from(companyMembers)
			.where(
				and(
					eq(companyMembers.companyId, membership.companyId),
					eq(companyMembers.role, 'owner'),
					eq(companyMembers.status, 'active')
				)
			);
		if ((owners?.n ?? 0) <= 1) lastOwnerOf = membership.companyName;
	}
	const freshAuth = isFreshAuth(session.authTime, now);
	return {
		candidate: profile !== undefined,
		staff: staff !== undefined,
		membership: membership ? { companyName: membership.companyName, role: membership.role } : null,
		lastOwnerOf,
		companiesWithContacts: handedOver.length,
		freshAuth,
		freshAuthUntil: freshAuth ? new Date(session.authTime.getTime() + FRESH_AUTH_SECONDS * 1000) : null
	};
}

/** What the person is told when the deletion is refused. */
export function deletionRefusalMessage(refusal: Extract<DeletionResult, { ok: false }>['refusal']): string {
	switch (refusal.reason) {
		case 'stale_auth':
			return 'Подтвердите вход ещё раз: удаление учётной записи требует свежего входа.';
		case 'already_requested':
			return 'Учётная запись уже удаляется.';
		case 'staff_role':
			return 'У учётной записи есть роль сотрудника платформы: сначала администратор снимает роль, затем учётную запись можно удалить.';
		case 'last_owner':
			return `Вы единственный владелец компании «${refusal.companyName}»: передайте владение другому участнику команды на странице команды, затем удалите учётную запись.`;
	}
}
