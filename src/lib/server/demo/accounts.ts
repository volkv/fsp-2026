// Accounts of the demo stand: the users the seed acts for. An account is found by its address, so a repeated seed
// reuses it; an address taken by an account of another batch or by a real account stops the seed.
import { createHash } from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Actor } from '$lib/server/access/actor';
import { STAFF_EXTRA_PERMISSIONS, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { AuthDeps } from '$lib/server/auth/context';
import type { CurrentDocument } from '$lib/server/auth/documents';
import type { SessionRef } from '$lib/server/auth/sessions';
import { loadAccessSubject } from '$lib/server/companies/subject';
import type { CompanyDeps } from '$lib/server/companies/context';
import type { DocumentKind } from '$lib/server/consent/kinds';
import { documentAcceptances, staffRoles, users } from '$lib/server/db/schema';
import type { InvitationDeps, RequestMeta } from '$lib/server/invitations/deps';
import type { LetterBox, DemoServices } from './services';

/** Everything the seed steps share. */
export interface SeedContext {
	services: DemoServices;
	/** `seed_batch_id` of every row the seed creates. */
	batch: string;
	now: () => Date;
	/** Metadata of the seed's actions: both the sign-in module and the others read it. */
	meta: RequestMeta & { ip: string | null; userAgent: string | null };
	letters: LetterBox;
	auth: AuthDeps;
	companies: CompanyDeps;
	invitations: InvitationDeps;
	/** Current published version of each legal document kind the seed signs or accepts. */
	documents: ReadonlyMap<DocumentKind, CurrentDocument>;
	/** When the people of the stand joined it: their accounts and processing consents date from then. */
	joinedAt: Date;
	taxonomyVersionId: string;
}

export class DemoBatchConflict extends Error {
	override name = 'DemoBatchConflict';
}

export function documentOf(ctx: SeedContext, kind: DocumentKind): CurrentDocument {
	const document = ctx.documents.get(kind);
	if (!document) throw new Error(`legal document ${kind} is not published`);
	return document;
}

interface AccountInput {
	email: string;
	displayName: string;
}

/**
 * The user of the address, created active with a confirmed address and the accepted user agreement at the moment the
 * people of the stand joined it (`SeedContext.joinedAt`). No password: nobody signs in to an account of the seed — the
 * sign-in refuses it (`demo_account`), visitors enter clones of it through `/demo`.
 */
export async function ensureUser(ctx: SeedContext, input: AccountInput): Promise<string> {
	const { db, crypto } = ctx.services;
	const emailHmac = crypto.lookupHmac('email', input.email);
	const [existing] = await db
		.select({ id: users.id, batch: users.seedBatchId })
		.from(users)
		.where(and(eq(users.emailHmac, emailHmac), ne(users.status, 'deleted')));
	if (existing) {
		if (existing.batch !== ctx.batch) {
			throw new DemoBatchConflict(
				`address ${input.email} belongs to an account outside demo batch ${ctx.batch}: reset the demo stand first`
			);
		}
		return existing.id;
	}
	const joined = ctx.joinedAt;
	return db.transaction(async (tx) => {
		const [user] = await tx
			.insert(users)
			.values({
				status: 'active',
				emailEnc: crypto.encrypt(input.email, 'users.email'),
				emailHmac,
				emailVerifiedAt: joined,
				displayName: input.displayName,
				seedBatchId: ctx.batch,
				createdAt: joined,
				updatedAt: joined
			})
			.returning({ id: users.id });
		if (!user) throw new Error('demo user was not inserted');
		await tx.insert(documentAcceptances).values({
			documentId: documentOf(ctx, 'user_agreement').id,
			userId: user.id,
			acceptedAt: joined,
			ip: ctx.meta.ip,
			ua: ctx.meta.userAgent
		});
		return user.id;
	});
}

/**
 * A staff role of a demo account. The administration screen grants roles through a module bound to the HTTP layer,
 * which the worker's bundle cannot carry; the seed writes the grant and its journal event the way that screen does.
 * The first administrator of an empty stand has nobody to grant the role.
 */
export async function ensureStaffRole(
	ctx: SeedContext,
	userId: string,
	role: 'admin' | 'operator',
	grantedBy: string | null
): Promise<void> {
	const { db } = ctx.services;
	const [granted] = await db
		.select({ id: staffRoles.id })
		.from(staffRoles)
		.where(and(eq(staffRoles.userId, userId), eq(staffRoles.role, role), isNull(staffRoles.revokedAt)));
	if (granted) return;
	// An operator of the demo reads the journal as well (domain 4.1).
	const extraPermissions = role === 'operator' ? [...STAFF_EXTRA_PERMISSIONS] : [];
	await db.transaction(async (tx) => {
		await tx.insert(staffRoles).values({ userId, role, extraPermissions, grantedBy, grantedAt: ctx.now() });
		await recordAuditEvent(tx, {
			action: 'staff.role_granted',
			outcome: 'success',
			actor: grantedBy === null ? { kind: 'system' } : { kind: 'user', userId: grantedBy },
			object: { type: 'user', id: userId },
			requestId: ctx.meta.requestId,
			details: { role, extra_permissions: extraPermissions }
		});
	});
}

/** A session reference of the seed acting as the user: consent evidence names it by a hash, like a real session. */
export function sessionOf(ctx: SeedContext, userId: string): SessionRef {
	return {
		hash: createHash('sha256').update(`demo-seed:${ctx.batch}:${userId}`).digest('hex'),
		userId,
		authTime: ctx.now()
	};
}

/** The access subject of the user, read from the database as for a request. */
export async function subjectOf(ctx: SeedContext, userId: string): Promise<AccessSubject> {
	const session = sessionOf(ctx, userId);
	const actor: Actor = {
		kind: 'session',
		userId,
		sessionHash: session.hash,
		authTime: session.authTime,
		authMethod: 'password',
		csrfToken: ''
	};
	return loadAccessSubject(ctx.services.db, actor);
}

/** Request metadata of an action of the user, with the session hash as consent evidence. */
export function metaOf(ctx: SeedContext, userId: string): SeedContext['meta'] {
	return { ...ctx.meta, sessionHash: sessionOf(ctx, userId).hash };
}
