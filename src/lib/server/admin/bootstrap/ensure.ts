// The bootstrap administrator (docs/domain.md, section 4.1): the first administrator of a stand comes from the
// environment (`BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`); every other one is granted by an administrator.
// `build/admin/main.js ensure` runs it at every start of the application, so the step is idempotent:
// - no account at the address — an active account with the confirmed address, the password and the administrator role;
//   the password is required here;
// - a real active account at the address — the role is granted if it is missing, the password stays as it is: the
//   administrator may have changed it since, and the environment need not hold it any more (it is removed after the
//   first start, so the secret does not live in the container for good); `resetPassword` (the command's
//   `--reset-password`) sets it from the environment again, which then must hold it, lifts a lockout and ends every
//   session of the account;
// - an account of the demo seed or of a demo session, or an account that is not active — refused: the address is not a
//   staff account the environment may claim.
// It is an ordinary account: the address encrypted with its keyed lookup, the password as Argon2id, sign-in by password
// as for anyone. Only the actions are journaled, never the password.
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import { hashPassword, passwordProblems } from '$lib/server/auth/password';
import { revokeUserSessions } from '$lib/server/auth/sessions';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Transaction } from '$lib/server/db';
import { passwordCredentials, staffRoles, users } from '$lib/server/db/schema';
import { ensureEmailChannel } from '$lib/server/notifications/notify';
import type { Redis } from '$lib/server/redis';

export interface BootstrapAdminDeps {
	db: Database;
	crypto: FieldCrypto;
	/** Connected only when sessions are to be ended (`resetPassword` of an existing account). */
	redis: () => Promise<Redis>;
	now: () => Date;
}

export interface BootstrapAdminInput {
	email: string;
	/** `null` — not in the environment: enough to confirm the role of an existing account, not to create or reset. */
	password: string | null;
	/** Sets the password of an existing account from the environment again. */
	resetPassword: boolean;
	requestId: string;
}

export interface BootstrapAdminOutcome {
	userId: string;
	created: boolean;
	roleGranted: boolean;
	passwordSet: boolean;
	/** Sessions ended by a password reset. */
	sessionsRevoked: number;
}

/** The environment names an address or a password the bootstrap administrator cannot have. */
export class BootstrapAdminRefused extends Error {
	override name = 'BootstrapAdminRefused';
}

export const BOOTSTRAP_ADMIN_DISPLAY_NAME = 'Администратор';

const journal = (requestId: string) => ({ outcome: 'success', actor: { kind: 'system' }, requestId }) as const;

async function grantAdmin(tx: Transaction, userId: string, now: Date, requestId: string): Promise<boolean> {
	const [granted] = await tx
		.select({ id: staffRoles.id })
		.from(staffRoles)
		.where(and(eq(staffRoles.userId, userId), eq(staffRoles.role, 'admin'), isNull(staffRoles.revokedAt)));
	if (granted) return false;
	await tx.insert(staffRoles).values({ userId, role: 'admin', extraPermissions: [], grantedBy: null, grantedAt: now });
	await recordAuditEvent(tx, {
		...journal(requestId),
		action: 'staff.role_granted',
		object: { type: 'user', id: userId },
		details: { role: 'admin', extra_permissions: [], via: 'environment' }
	});
	return true;
}

export async function ensureBootstrapAdmin(
	deps: BootstrapAdminDeps,
	input: BootstrapAdminInput
): Promise<BootstrapAdminOutcome> {
	const email = input.email.trim();
	if (input.password === null && input.resetPassword) {
		throw new BootstrapAdminRefused('--reset-password needs BOOTSTRAP_ADMIN_PASSWORD in the environment');
	}
	if (input.password !== null) {
		const problems = passwordProblems(input.password, email);
		if (problems.length > 0) {
			// The rules, never the value: the message goes to the log of the start.
			throw new BootstrapAdminRefused(`BOOTSTRAP_ADMIN_PASSWORD is not acceptable: ${problems.join('; ')}`);
		}
	}
	const emailHmac = deps.crypto.lookupHmac('email', email);
	// Hashing costs tens of milliseconds: done before the transaction, which holds the lock.
	const hash = input.password === null ? null : await hashPassword(input.password);
	const now = deps.now();

	const outcome = await deps.db.transaction(async (tx) => {
		// Two starts at once (a restart during a deployment) create one account.
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext('admin.bootstrap'))`);
		const [existing] = await tx
			.select({
				id: users.id,
				status: users.status,
				seedBatchId: users.seedBatchId,
				demoSessionId: users.demoSessionId
			})
			.from(users)
			.where(and(eq(users.emailHmac, emailHmac), ne(users.status, 'deleted')));

		if (!existing) {
			if (hash === null) {
				throw new BootstrapAdminRefused(
					'BOOTSTRAP_ADMIN_PASSWORD is required to create the account of BOOTSTRAP_ADMIN_EMAIL: no account has the address'
				);
			}
			const [user] = await tx
				.insert(users)
				.values({
					status: 'active',
					emailEnc: deps.crypto.encrypt(email, 'users.email'),
					emailHmac,
					emailVerifiedAt: now,
					displayName: BOOTSTRAP_ADMIN_DISPLAY_NAME
				})
				.returning({ id: users.id });
			if (!user) throw new Error('bootstrap administrator was not inserted');
			await tx.insert(passwordCredentials).values({ userId: user.id, hash, changedAt: now });
			await ensureEmailChannel(tx, user.id, now);
			await recordAuditEvent(tx, {
				...journal(input.requestId),
				action: 'auth.registered',
				object: { type: 'user', id: user.id },
				details: { method: 'password', via: 'environment' }
			});
			await grantAdmin(tx, user.id, now, input.requestId);
			return { userId: user.id, created: true, roleGranted: true, passwordSet: true };
		}

		if (existing.seedBatchId !== null || existing.demoSessionId !== null) {
			throw new BootstrapAdminRefused(
				'BOOTSTRAP_ADMIN_EMAIL belongs to an account of the demo data: name an address of a real person'
			);
		}
		if (existing.status !== 'active') {
			// An unconfirmed address may be somebody else's registration; a suspended or leaving account stays so.
			throw new BootstrapAdminRefused(
				`BOOTSTRAP_ADMIN_EMAIL belongs to an account in status ${existing.status}, not an active one`
			);
		}
		const roleGranted = await grantAdmin(tx, existing.id, now, input.requestId);
		if (!input.resetPassword) return { userId: existing.id, created: false, roleGranted, passwordSet: false };
		if (hash === null) throw new Error('a password reset without the password passed the check above');
		await tx
			.insert(passwordCredentials)
			.values({ userId: existing.id, hash, changedAt: now })
			.onConflictDoUpdate({ target: passwordCredentials.userId, set: { hash, changedAt: now } });
		await tx.update(users).set({ lockedUntil: null }).where(eq(users.id, existing.id));
		await recordAuditEvent(tx, {
			...journal(input.requestId),
			action: 'auth.password_reset',
			object: { type: 'user', id: existing.id },
			details: { via: 'environment' }
		});
		return { userId: existing.id, created: false, roleGranted, passwordSet: true };
	});

	// After the commit: a session ended before the new password is in place could be opened again with the old one.
	const sessionsRevoked =
		outcome.passwordSet && !outcome.created ? await revokeUserSessions(await deps.redis(), outcome.userId) : 0;
	return { ...outcome, sessionsRevoked };
}
