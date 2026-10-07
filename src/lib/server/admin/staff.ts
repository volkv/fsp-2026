// Users and staff roles for the administrator (domain 4.1). A person is found by the exact address (its keyed hash,
// the same lookup as sign-in, without decrypting anybody's address) or by the account id. Staff roles are granted and
// revoked under `staff.manage`, each change journaled in the same transaction. `staff_roles` is append-only in meaning:
// a changed grant is the old row revoked and a new row granted. The administrator finds and lists the accounts within
// its reach — a clone of a demo session, those of its session only — and a demo account changes no staff role: the
// roles are shared by every visitor of the stand (domain 19.3).
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { requireStandChange, StaffReach } from '$lib/server/access/demo-actor';
import { STAFF_EXTRA_PERMISSIONS } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { formText } from '$lib/server/http/form';
import type { ActionContext } from '$lib/server/companies/context';
import { conflict, invalid, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor, Transaction } from '$lib/server/db';
import { candidates, companies, companyMembers, staffRoles, users } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';

export interface StaffDeps {
	db: Database;
	crypto: FieldCrypto;
	now: () => Date;
}

export type StaffRole = 'operator' | 'admin';
const STAFF_ROLES: readonly StaffRole[] = ['operator', 'admin'];

export interface StaffGrant {
	role: StaffRole;
	extraPermissions: string[];
	grantedAt: Date;
	grantedBy: string | null;
}

export interface UserCard {
	id: string;
	status: (typeof users.$inferSelect)['status'];
	displayName: string | null;
	createdAt: Date;
	lastLoginAt: Date | null;
	/** The account has a candidate profile; its contents stay closed to the administrator (domain 4.1). */
	isCandidate: boolean;
	membership: { companyName: string; role: string; status: string } | null;
	staff: StaffGrant[];
	/** The administrator is looking at their own account: its staff roles are changed by another administrator. */
	isSelf: boolean;
}

const emailSchema = z.email().max(254);
const idSchema = z.uuid();

async function grantsOf(executor: Executor, userId: string): Promise<StaffGrant[]> {
	return executor
		.select({
			role: staffRoles.role,
			extraPermissions: staffRoles.extraPermissions,
			grantedAt: staffRoles.grantedAt,
			grantedBy: staffRoles.grantedBy
		})
		.from(staffRoles)
		.where(and(eq(staffRoles.userId, userId), isNull(staffRoles.revokedAt)))
		.orderBy(asc(staffRoles.role));
}

/**
 * The account behind an exact address or an account id; `null` — nobody. Anything else is not a search the page
 * offers: there is no partial search over addresses, which are stored encrypted.
 */
export async function findUser(deps: StaffDeps, ctx: ActionContext, query: string): Promise<UserCard | null> {
	requirePermission(ctx.subject, 'staff.manage', null);
	const text = query.trim();
	let where;
	if (idSchema.safeParse(text).success) where = eq(users.id, text);
	else if (emailSchema.safeParse(text).success) where = eq(users.emailHmac, deps.crypto.lookupHmac('email', text));
	else
		throw invalid([{ path: 'q', code: 'invalid', message: 'Введите адрес почты целиком или идентификатор аккаунта' }]);
	const [user] = await deps.db
		.select({
			id: users.id,
			status: users.status,
			displayName: users.displayName,
			createdAt: users.createdAt,
			lastLoginAt: users.lastLoginAt
		})
		.from(users)
		.where(
			and(where, ne(users.status, 'deleted'), (await StaffReach.of(deps.db, ctx.subject)).rows(users.demoSessionId))
		);
	if (!user) return null;
	const [[candidate], [membership], staff] = await Promise.all([
		deps.db
			.select({ id: candidates.id })
			.from(candidates)
			.where(and(eq(candidates.userId, user.id), ne(candidates.status, 'deleted'))),
		deps.db
			.select({ companyName: companies.displayName, role: companyMembers.role, status: companyMembers.status })
			.from(companyMembers)
			.innerJoin(companies, eq(companies.id, companyMembers.companyId))
			.where(and(eq(companyMembers.userId, user.id), ne(companyMembers.status, 'removed')))
			.limit(1),
		grantsOf(deps.db, user.id)
	]);
	return {
		...user,
		isCandidate: candidate !== undefined,
		membership: membership ?? null,
		staff,
		isSelf: user.id === ctx.subject.userId
	};
}

export interface StaffMember {
	userId: string;
	displayName: string | null;
	/** Addresses of staff only: the list is short and the administrator needs to know who holds a role. */
	email: string;
	status: (typeof users.$inferSelect)['status'];
	grants: StaffGrant[];
	isSelf: boolean;
}

/** Everyone who holds a staff role now. */
export async function staffList(deps: StaffDeps, ctx: ActionContext): Promise<StaffMember[]> {
	requirePermission(ctx.subject, 'staff.manage', null);
	const rows = await deps.db
		.select({
			userId: users.id,
			displayName: users.displayName,
			emailEnc: users.emailEnc,
			status: users.status,
			role: staffRoles.role,
			extraPermissions: staffRoles.extraPermissions,
			grantedAt: staffRoles.grantedAt,
			grantedBy: staffRoles.grantedBy
		})
		.from(staffRoles)
		.innerJoin(users, eq(users.id, staffRoles.userId))
		.where(and(isNull(staffRoles.revokedAt), (await StaffReach.of(deps.db, ctx.subject)).rows(users.demoSessionId)))
		.orderBy(asc(users.displayName), asc(users.id), asc(staffRoles.role));
	const members = new Map<string, StaffMember>();
	for (const row of rows) {
		let member = members.get(row.userId);
		if (!member) {
			if (!row.emailEnc) throw new Error(`staff user ${row.userId} has no address`);
			member = {
				userId: row.userId,
				displayName: row.displayName,
				email: deps.crypto.decrypt(row.emailEnc, 'users.email'),
				status: row.status,
				grants: [],
				isSelf: row.userId === ctx.subject.userId
			};
			members.set(row.userId, member);
		}
		member.grants.push({
			role: row.role,
			extraPermissions: row.extraPermissions,
			grantedAt: row.grantedAt,
			grantedBy: row.grantedBy
		});
	}
	return [...members.values()];
}

export interface GrantInput {
	userId: string;
	role: StaffRole;
	/** Only for an operator: the right to read the action journal (domain 4.1). */
	auditRead: boolean;
}

/** The administrator acting on another account; nobody changes their own staff roles (no self-escalation). */
function actingOnOther(ctx: ActionContext, userId: string): string {
	const actorId = sessionUserId(ctx.subject);
	if (actorId === userId) {
		throw conflict('self_change', 'Свои роли персонала меняет другой администратор', 'userId');
	}
	return actorId;
}

/** The target account under a row lock, so concurrent changes of its roles are serialized. */
async function lockUser(tx: Transaction, userId: string): Promise<{ status: string }> {
	const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId)).for('update');
	if (!user) throw new ApiError('not_found');
	return user;
}

async function activeGrant(tx: Transaction, userId: string, role: StaffRole) {
	const [grant] = await tx
		.select({ id: staffRoles.id, extraPermissions: staffRoles.extraPermissions })
		.from(staffRoles)
		.where(and(eq(staffRoles.userId, userId), eq(staffRoles.role, role), isNull(staffRoles.revokedAt)));
	return grant ?? null;
}

function journal(ctx: ActionContext, actorId: string) {
	return {
		outcome: 'success' as const,
		actor: { kind: 'user' as const, userId: actorId },
		requestId: ctx.meta.requestId,
		ip: ctx.meta.ip,
		userAgent: ctx.meta.userAgent
	};
}

export async function grantStaffRole(deps: StaffDeps, ctx: ActionContext, input: GrantInput): Promise<void> {
	requirePermission(ctx.subject, 'staff.manage', null);
	const actorId = actingOnOther(ctx, input.userId);
	await requireStandChange(deps.db, ctx.subject);
	const extraPermissions = input.role === 'operator' && input.auditRead ? [...STAFF_EXTRA_PERMISSIONS] : [];
	await deps.db.transaction(async (tx) => {
		const user = await lockUser(tx, input.userId);
		if (user.status !== 'active') {
			throw conflict('user_not_active', 'Роль выдаётся только активному аккаунту с подтверждённой почтой', 'userId');
		}
		if (await activeGrant(tx, input.userId, input.role)) {
			throw conflict('already_granted', 'Эта роль у пользователя уже есть', 'role');
		}
		await tx.insert(staffRoles).values({
			userId: input.userId,
			role: input.role,
			extraPermissions,
			grantedBy: actorId,
			grantedAt: deps.now()
		});
		await recordAuditEvent(tx, {
			...journal(ctx, actorId),
			action: 'staff.role_granted',
			object: { type: 'user', id: input.userId },
			details: { role: input.role, extra_permissions: extraPermissions }
		});
	});
}

export async function revokeStaffRole(
	deps: StaffDeps,
	ctx: ActionContext,
	input: { userId: string; role: StaffRole }
): Promise<void> {
	requirePermission(ctx.subject, 'staff.manage', null);
	const actorId = actingOnOther(ctx, input.userId);
	await requireStandChange(deps.db, ctx.subject);
	await deps.db.transaction(async (tx) => {
		await lockUser(tx, input.userId);
		const grant = await activeGrant(tx, input.userId, input.role);
		if (!grant) throw conflict('not_granted', 'Этой роли у пользователя нет', 'role');
		await tx.update(staffRoles).set({ revokedAt: deps.now(), revokedBy: actorId }).where(eq(staffRoles.id, grant.id));
		await recordAuditEvent(tx, {
			...journal(ctx, actorId),
			action: 'staff.role_revoked',
			object: { type: 'user', id: input.userId },
			details: { role: input.role }
		});
	});
}

/**
 * Gives or takes the operator's right to read the journal. The grant is replaced, not edited: the old row is revoked
 * and a new one granted with the new permissions, both journaled.
 */
export async function setOperatorAuditRead(
	deps: StaffDeps,
	ctx: ActionContext,
	input: { userId: string; enabled: boolean }
): Promise<{ changed: boolean }> {
	requirePermission(ctx.subject, 'staff.manage', null);
	const actorId = actingOnOther(ctx, input.userId);
	await requireStandChange(deps.db, ctx.subject);
	return deps.db.transaction(async (tx) => {
		await lockUser(tx, input.userId);
		const grant = await activeGrant(tx, input.userId, 'operator');
		if (!grant) throw conflict('not_granted', 'Право выдаётся только оператору', 'role');
		const extraPermissions = input.enabled ? [...STAFF_EXTRA_PERMISSIONS] : [];
		if (grant.extraPermissions.includes('audit.read') === input.enabled) return { changed: false };
		const now = deps.now();
		await tx.update(staffRoles).set({ revokedAt: now, revokedBy: actorId }).where(eq(staffRoles.id, grant.id));
		await tx
			.insert(staffRoles)
			.values({ userId: input.userId, role: 'operator', extraPermissions, grantedBy: actorId, grantedAt: now });
		await recordAuditEvent(tx, {
			...journal(ctx, actorId),
			action: 'staff.role_revoked',
			object: { type: 'user', id: input.userId },
			details: { role: 'operator', reason: 'permissions_changed' }
		});
		await recordAuditEvent(tx, {
			...journal(ctx, actorId),
			action: 'staff.role_granted',
			object: { type: 'user', id: input.userId },
			details: { role: 'operator', extra_permissions: extraPermissions }
		});
		return { changed: true };
	});
}

// --- Forms ---

function formUserId(form: FormData): string {
	const userId = formText(form, 'userId');
	if (!idSchema.safeParse(userId).success) throw new ApiError('not_found');
	return userId;
}

function formRole(form: FormData): StaffRole {
	const role = STAFF_ROLES.find((value) => value === formText(form, 'role'));
	if (role === undefined) throw invalid([{ path: 'role', code: 'invalid', message: 'Выберите роль' }]);
	return role;
}

export function grantFromForm(form: FormData): GrantInput {
	return { userId: formUserId(form), role: formRole(form), auditRead: formText(form, 'auditRead') === 'on' };
}

export function revokeFromForm(form: FormData): { userId: string; role: StaffRole } {
	return { userId: formUserId(form), role: formRole(form) };
}

export function auditReadFromForm(form: FormData): { userId: string; enabled: boolean } {
	const enabled = formText(form, 'enabled');
	if (enabled !== 'true' && enabled !== 'false') {
		throw invalid([{ path: 'enabled', code: 'invalid', message: 'Выберите, выдать право или снять' }]);
	}
	return { userId: formUserId(form), enabled: enabled === 'true' };
}
