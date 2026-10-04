// The team of a company (domain 5.3): the owner invites by email, the invited person accepts by the link under the same
// address, roles are `owner` and `recruiter`. A company keeps at least one active owner; a removed member loses access
// at once and the API keys they created are revoked in the same transaction.
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { recordAuditEvent } from '$lib/server/audit/record';
import { consumeEmailToken, issueEmailToken } from '$lib/server/auth/email-tokens';
import type { Transaction } from '$lib/server/db';
import { apiKeys, companyMembers, emailTokens, users } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { memberInviteLetter } from '$lib/server/mail/templates';
import {
	auditActorOf,
	conflict,
	invalid,
	requirePermission,
	sessionUserId,
	type ActionContext,
	type CompanyDeps
} from './context';
import { assertMayBecomeEmployer } from './employer';
import type { CompanyStatus } from './gate';
import { lockCompany } from './rows';

export type MemberRole = 'owner' | 'recruiter';
export type MemberStatus = 'invited' | 'active' | 'removed';

/** A company in these statuses takes no one into its team. */
const CLOSED: ReadonlySet<CompanyStatus> = new Set(['rejected', 'suspended']);

const emailSchema = z.email().max(254);

function audit(ctx: ActionContext) {
	return {
		actor: auditActorOf(ctx.subject),
		requestId: ctx.meta.requestId,
		ip: ctx.meta.ip,
		userAgent: ctx.meta.userAgent
	};
}

/** Where the link of an invitation leads: the page accepts it after sign-in or registration. */
export function memberInviteLink(appOrigin: string, token: string): string {
	return new URL(`/company/join?token=${encodeURIComponent(token)}`, appOrigin).toString();
}

export interface TeamMember {
	memberId: string;
	role: MemberRole;
	status: 'invited' | 'active';
	/** `null` for an invitation not accepted yet: the address is kept only as a keyed hash. */
	userId: string | null;
	displayName: string | null;
	joinedAt: Date | null;
	invitedAt: Date;
}

/** Active members and open invitations of the company, for its owner. */
export async function listMembers(deps: CompanyDeps, ctx: ActionContext, companyId: string): Promise<TeamMember[]> {
	requirePermission(ctx.subject, 'company.members.manage', { companyId });
	const rows = await deps.db
		.select({
			memberId: companyMembers.id,
			role: companyMembers.role,
			status: companyMembers.status,
			userId: companyMembers.userId,
			displayName: users.displayName,
			joinedAt: companyMembers.joinedAt,
			invitedAt: companyMembers.createdAt
		})
		.from(companyMembers)
		.leftJoin(users, eq(users.id, companyMembers.userId))
		.where(eq(companyMembers.companyId, companyId))
		.orderBy(asc(companyMembers.createdAt));
	return rows.flatMap((row) => (row.status === 'removed' ? [] : [{ ...row, status: row.status }]));
}

/**
 * The owner invites a person by email. A repeated invitation of the same address to the same company issues a new
 * link and withdraws the old one. The letter leaves after the commit; `letterSent: false` — the owner may resend.
 */
export async function inviteMember(
	deps: CompanyDeps,
	ctx: ActionContext,
	companyId: string,
	input: { email: string; role: MemberRole }
): Promise<{ memberId: string; letterSent: boolean }> {
	requirePermission(ctx.subject, 'company.members.manage', { companyId });
	const inviterId = sessionUserId(ctx.subject);
	const email = input.email.trim();
	if (!emailSchema.safeParse(email).success) {
		throw invalid([{ path: 'email', code: 'invalid_email', message: 'Укажите адрес почты полностью' }]);
	}
	const emailHmac = deps.crypto.lookupHmac('email', email);
	const now = deps.now();

	const invited = await deps.db.transaction(async (tx) => {
		const company = await lockCompany(tx, companyId);
		if (CLOSED.has(company.status)) {
			throw conflict('company_closed', 'Компания отклонена или приостановлена: пригласить в команду нельзя');
		}
		const [alreadyActive] = await tx
			.select({ id: companyMembers.id })
			.from(companyMembers)
			.innerJoin(users, eq(users.id, companyMembers.userId))
			.where(
				and(
					eq(companyMembers.companyId, companyId),
					eq(companyMembers.status, 'active'),
					eq(users.emailHmac, emailHmac)
				)
			);
		if (alreadyActive) throw conflict('already_member', 'Этот человек уже в команде', 'email');

		const [pending] = await tx
			.select({ id: companyMembers.id })
			.from(companyMembers)
			.where(
				and(
					eq(companyMembers.companyId, companyId),
					eq(companyMembers.status, 'invited'),
					eq(companyMembers.invitedEmailHmac, emailHmac)
				)
			);
		let memberId: string;
		if (pending) {
			memberId = pending.id;
			await tx
				.update(companyMembers)
				.set({ role: input.role, invitedBy: inviterId })
				.where(eq(companyMembers.id, memberId));
		} else {
			const [created] = await tx
				.insert(companyMembers)
				.values({ companyId, invitedEmailHmac: emailHmac, role: input.role, status: 'invited', invitedBy: inviterId })
				.returning({ id: companyMembers.id });
			if (!created) throw new Error('invited member not inserted');
			memberId = created.id;
		}
		const token = await issueEmailToken(tx, 'member_invite', { targetRef: memberId }, now);
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'member.invited',
			outcome: 'success',
			object: { type: 'company_member', id: memberId },
			details: { company_id: companyId, role: input.role, repeated: pending !== undefined }
		});
		return { memberId, token, companyName: company.displayName };
	});

	const sent = await deps.mailer.send(
		memberInviteLetter(email, {
			companyName: invited.companyName,
			role: input.role,
			link: memberInviteLink(deps.appOrigin, invited.token)
		})
	);
	return { memberId: invited.memberId, letterSent: sent.ok };
}

/**
 * The invited person accepts under the address the invitation was sent to. The account must be neither a candidate nor
 * an active member of another company. An unknown, used or expired link is `not_found`.
 */
export async function acceptMemberInvite(
	deps: CompanyDeps,
	ctx: ActionContext,
	token: string
): Promise<{ companyId: string; memberId: string; role: MemberRole }> {
	const userId = sessionUserId(ctx.subject);
	const now = deps.now();
	return deps.db.transaction(async (tx) => {
		const consumed = await consumeEmailToken(tx, 'member_invite', token, now);
		if (!consumed?.targetRef) throw new ApiError('not_found', { message: 'Ссылка устарела или уже использована' });
		const [member] = await tx
			.select({
				id: companyMembers.id,
				companyId: companyMembers.companyId,
				role: companyMembers.role,
				status: companyMembers.status,
				invitedEmailHmac: companyMembers.invitedEmailHmac
			})
			.from(companyMembers)
			.where(eq(companyMembers.id, consumed.targetRef));
		if (member?.status !== 'invited') {
			throw new ApiError('not_found', { message: 'Приглашение отозвано' });
		}
		const company = await lockCompany(tx, member.companyId);
		if (CLOSED.has(company.status)) {
			throw conflict('company_closed', 'Компания отклонена или приостановлена: вступить в команду нельзя');
		}
		const [user] = await tx.select({ emailHmac: users.emailHmac }).from(users).where(eq(users.id, userId));
		if (!user || user.emailHmac !== member.invitedEmailHmac) {
			throw new ApiError('forbidden', {
				message: 'Приглашение отправлено на другой адрес: войдите под адресом, на который пришло письмо'
			});
		}
		await assertMayBecomeEmployer(tx, userId);
		await tx
			.update(companyMembers)
			.set({ userId, status: 'active', joinedAt: now, invitedEmailHmac: null })
			.where(eq(companyMembers.id, member.id));
		await recordAuditEvent(tx, {
			actor: { kind: 'user', userId, companyId: member.companyId },
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			action: 'member.joined',
			outcome: 'success',
			object: { type: 'company_member', id: member.id },
			details: { company_id: member.companyId, role: member.role }
		});
		return { companyId: member.companyId, memberId: member.id, role: member.role };
	});
}

async function activeOwners(tx: Transaction, companyId: string): Promise<string[]> {
	const rows = await tx
		.select({ id: companyMembers.id })
		.from(companyMembers)
		.where(
			and(
				eq(companyMembers.companyId, companyId),
				eq(companyMembers.role, 'owner'),
				eq(companyMembers.status, 'active')
			)
		);
	return rows.map((row) => row.id);
}

const LAST_OWNER_MESSAGE = 'В компании должен остаться хотя бы один действующий владелец — сначала передайте владение';

async function memberForChange(tx: Transaction, ctx: ActionContext, memberId: string) {
	const [found] = await tx
		.select({ companyId: companyMembers.companyId })
		.from(companyMembers)
		.where(eq(companyMembers.id, memberId));
	if (!found) throw new ApiError('not_found');
	requirePermission(ctx.subject, 'company.members.manage', { companyId: found.companyId });
	await lockCompany(tx, found.companyId);
	// Read again under the company lock: changes of one team are ordered by it.
	const [member] = await tx
		.select({
			id: companyMembers.id,
			companyId: companyMembers.companyId,
			role: companyMembers.role,
			status: companyMembers.status
		})
		.from(companyMembers)
		.where(eq(companyMembers.id, memberId));
	if (!member) throw new ApiError('not_found');
	return member;
}

/**
 * Removes a member or withdraws an invitation. The last active owner cannot be removed. Keys created by the member are
 * revoked in the same transaction, so no request with them succeeds after the commit.
 */
export async function removeMember(deps: CompanyDeps, ctx: ActionContext, memberId: string): Promise<void> {
	const actorId = sessionUserId(ctx.subject);
	const now = deps.now();
	await deps.db.transaction(async (tx) => {
		const member = await memberForChange(tx, ctx, memberId);
		if (member.status === 'removed') return;
		if (member.status === 'active' && member.role === 'owner') {
			const owners = await activeOwners(tx, member.companyId);
			if (owners.length <= 1) throw conflict('last_owner', LAST_OWNER_MESSAGE);
		}
		await tx
			.update(companyMembers)
			.set({ status: 'removed', removedAt: now, removedBy: actorId })
			.where(eq(companyMembers.id, member.id));
		if (member.status === 'invited') {
			await tx
				.delete(emailTokens)
				.where(
					and(
						eq(emailTokens.purpose, 'member_invite'),
						eq(emailTokens.targetRef, member.id),
						isNull(emailTokens.usedAt)
					)
				);
		}
		const revoked = await tx
			.update(apiKeys)
			.set({ revokedAt: now })
			.where(and(eq(apiKeys.createdByMemberId, member.id), isNull(apiKeys.revokedAt)))
			.returning({ id: apiKeys.id });
		for (const key of revoked) {
			await recordAuditEvent(tx, {
				...audit(ctx),
				action: 'api_key.revoked',
				outcome: 'success',
				object: { type: 'api_key', id: key.id },
				details: { company_id: member.companyId, reason: 'member_removed' }
			});
		}
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'member.removed',
			outcome: 'success',
			object: { type: 'company_member', id: member.id },
			details: { company_id: member.companyId, role: member.role, previous_status: member.status }
		});
	});
}

/** Why an account being deleted cannot leave its company: it is the last active owner there (domain 5.3). */
export interface LastOwnerRefusal {
	companyId: string;
	companyName: string;
}

/**
 * Ends the memberships of an account that is being deleted (domain 5.3, 19.1), in the caller's transaction: every
 * active membership becomes `removed` by the person themselves and the API keys they created are revoked at once. The
 * last active owner of a company is refused before anything changes — the company must keep an owner, so ownership
 * is handed over first. Returns the refusal, or `null` when the memberships are ended.
 */
export async function endMembershipsOfDeletedAccount(
	tx: Transaction,
	userId: string,
	journal: { requestId: string; at: Date }
): Promise<LastOwnerRefusal | null> {
	const memberships = await tx
		.select({ id: companyMembers.id, companyId: companyMembers.companyId, role: companyMembers.role })
		.from(companyMembers)
		.where(and(eq(companyMembers.userId, userId), eq(companyMembers.status, 'active')));
	for (const member of memberships) {
		const company = await lockCompany(tx, member.companyId);
		if (member.role === 'owner' && (await activeOwners(tx, member.companyId)).length <= 1) {
			return { companyId: company.id, companyName: company.displayName };
		}
	}
	const actor = { kind: 'user' as const, userId };
	for (const member of memberships) {
		await tx
			.update(companyMembers)
			.set({ status: 'removed', removedAt: journal.at, removedBy: userId })
			.where(eq(companyMembers.id, member.id));
		const revoked = await tx
			.update(apiKeys)
			.set({ revokedAt: journal.at })
			.where(and(eq(apiKeys.createdByMemberId, member.id), isNull(apiKeys.revokedAt)))
			.returning({ id: apiKeys.id });
		for (const key of revoked) {
			await recordAuditEvent(tx, {
				actor: { ...actor, companyId: member.companyId },
				requestId: journal.requestId,
				action: 'api_key.revoked',
				outcome: 'success',
				object: { type: 'api_key', id: key.id },
				details: { company_id: member.companyId, reason: 'account_deleted' },
				occurredAt: journal.at
			});
		}
		await recordAuditEvent(tx, {
			actor: { ...actor, companyId: member.companyId },
			requestId: journal.requestId,
			action: 'member.removed',
			outcome: 'success',
			object: { type: 'company_member', id: member.id },
			details: {
				company_id: member.companyId,
				role: member.role,
				previous_status: 'active',
				reason: 'account_deleted'
			},
			occurredAt: journal.at
		});
	}
	return null;
}

/** Changes the role of an active member; the last active owner is not demoted. */
export async function setMemberRole(
	deps: CompanyDeps,
	ctx: ActionContext,
	memberId: string,
	role: MemberRole
): Promise<void> {
	sessionUserId(ctx.subject);
	await deps.db.transaction(async (tx) => {
		const member = await memberForChange(tx, ctx, memberId);
		if (member.status !== 'active') throw conflict('not_active', 'Роль меняется только у действующего участника');
		if (member.role === role) return;
		if (member.role === 'owner' && (await activeOwners(tx, member.companyId)).length <= 1) {
			throw conflict('last_owner', LAST_OWNER_MESSAGE);
		}
		await tx.update(companyMembers).set({ role }).where(eq(companyMembers.id, member.id));
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'member.role_changed',
			outcome: 'success',
			object: { type: 'company_member', id: member.id },
			details: { company_id: member.companyId, from: member.role, to: role }
		});
	});
}

/** The acting owner hands ownership to an active recruiter and becomes a recruiter, in one transaction. */
export async function transferOwnership(deps: CompanyDeps, ctx: ActionContext, toMemberId: string): Promise<void> {
	sessionUserId(ctx.subject);
	const own = ctx.subject.membership;
	await deps.db.transaction(async (tx) => {
		const target = await memberForChange(tx, ctx, toMemberId);
		if (own === null || own.companyId !== target.companyId) throw new ApiError('not_found');
		if (target.id === own.memberId) throw conflict('same_member', 'Нельзя передать владение самому себе');
		if (target.status !== 'active') throw conflict('not_active', 'Владение передаётся только действующему участнику');
		const [self] = await tx
			.select({ role: companyMembers.role, status: companyMembers.status })
			.from(companyMembers)
			.where(eq(companyMembers.id, own.memberId));
		if (self?.status !== 'active' || self.role !== 'owner') throw new ApiError('forbidden');
		if (target.role !== 'owner') {
			await tx.update(companyMembers).set({ role: 'owner' }).where(eq(companyMembers.id, target.id));
			await recordAuditEvent(tx, {
				...audit(ctx),
				action: 'member.role_changed',
				outcome: 'success',
				object: { type: 'company_member', id: target.id },
				details: { company_id: target.companyId, from: target.role, to: 'owner', transfer: true }
			});
		}
		await tx.update(companyMembers).set({ role: 'recruiter' }).where(eq(companyMembers.id, own.memberId));
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: 'member.role_changed',
			outcome: 'success',
			object: { type: 'company_member', id: own.memberId },
			details: { company_id: target.companyId, from: 'owner', to: 'recruiter', transfer: true }
		});
	});
}
