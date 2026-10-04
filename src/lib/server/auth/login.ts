// Sign-in by password (domain 3.2–3.4): Argon2id, per-account lockout into `users.locked_until`, per-address limit,
// a new session id on every sign-in. A refusal is an outcome, not an exception; its text does not tell whether the
// address is registered. An account of the demo seed — an original of the scenario cast, the background, the operator and
// the administrator of the seed — and a clone of the cast exist on a demonstration stand only and are not signed in to
// by password: visitors enter the scenario at `/demo`, in clones of their own (docs/domain.md, section 19.3). The refusal
// comes before the password is checked, so the published addresses of the cast neither lock the accounts nor count
// failures. An account a visitor registered within their demo session is signed in to from that session only: the
// address typed is looked up within the session first, then outside sessions (`account-lookup.ts`).
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { recordAuditEvent } from '$lib/server/audit/record';
import { passwordCredentials, users } from '$lib/server/db/schema';
import { accountByAddress, type AddressedAccount } from './account-lookup';
import type { AuthDeps, RequestMeta } from './context';
import { addressBlocked, clearAccountFailures, LOCKOUT_SECONDS, registerFailure } from './lockout';
import { hashPassword, needsRehash, PASSWORD_MAX_LENGTH, verifyPassword } from './password';
import { createSession, destroySession, type SessionRef } from './sessions';

export type LoginRefusal = 'invalid_credentials' | 'locked' | 'address_limited' | 'account_inactive' | 'demo_account';

export type LoginResult =
	| { ok: true; userId: string; sessionId: string }
	| { ok: false; reason: LoginRefusal; retryAfterSeconds: number | null };

/** Statuses that may sign in: an unconfirmed address still continues the registration path. */
const MAY_SIGN_IN = new Set(['active', 'pending_email']);

const emailSchema = z.email().max(254);

/** The account reached the failure limit: sign-in by password is closed for `LOCKOUT_SECONDS`. */
async function lockAccount(deps: AuthDeps, meta: RequestMeta, userId: string, now: Date): Promise<void> {
	await deps.db.transaction(async (tx) => {
		await tx
			.update(users)
			.set({ lockedUntil: new Date(now.getTime() + LOCKOUT_SECONDS * 1000) })
			.where(eq(users.id, userId));
		await recordAuditEvent(tx, {
			action: 'auth.lockout',
			outcome: 'success',
			actor: { kind: 'system' },
			object: { type: 'user', id: userId },
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { locked_seconds: LOCKOUT_SECONDS }
		});
	});
}

export async function loginWithPassword(
	deps: AuthDeps,
	meta: RequestMeta,
	input: {
		email: string;
		password: string;
		/** On a demonstration stand, the live demo session of the browser; `null` — none, or not a demonstration stand. */
		demoSessionId: string | null;
	},
	previous: SessionRef | null
): Promise<LoginResult> {
	const now = deps.now();
	const ip = meta.ip ?? 'unknown';
	const journal = async (
		outcome: 'success' | 'failure' | 'denied',
		userId: string | null,
		details: Record<string, string | boolean>
	) =>
		recordAuditEvent(deps.db, {
			action: 'auth.login',
			outcome,
			actor: userId === null ? { kind: 'anonymous' } : { kind: 'user', userId },
			...(userId === null ? {} : { object: { type: 'user', id: userId } }),
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { method: 'password', ...details }
		});

	const address = await addressBlocked(deps.redis, ip);
	if (address.blocked) {
		await journal('denied', null, { reason: 'address_limited' });
		return { ok: false, reason: 'address_limited', retryAfterSeconds: address.retryAfterSeconds };
	}

	const email = input.email.trim();
	const password = input.password.slice(0, PASSWORD_MAX_LENGTH + 1);
	const account: AddressedAccount | null = emailSchema.safeParse(email).success
		? await accountByAddress(deps.db, deps.crypto, email, input.demoSessionId)
		: null;

	if (account?.seeded) {
		await journal('denied', account.id, { reason: 'demo_account' });
		return { ok: false, reason: 'demo_account', retryAfterSeconds: null };
	}

	if (account?.lockedUntil && account.lockedUntil.getTime() > now.getTime()) {
		await journal('denied', account.id, { reason: 'locked' });
		return {
			ok: false,
			reason: 'locked',
			retryAfterSeconds: Math.ceil((account.lockedUntil.getTime() - now.getTime()) / 1000)
		};
	}

	const matches = await verifyPassword(account?.passwordHash ?? null, password);
	if (!account || !matches) {
		const { lock } = await registerFailure(deps.redis, { emailHmac: account?.emailHmac ?? null, ip });
		if (account && lock) {
			await lockAccount(deps, meta, account.id, now);
			await journal('failure', account.id, { reason: 'invalid_credentials', locked: true });
			return { ok: false, reason: 'locked', retryAfterSeconds: LOCKOUT_SECONDS };
		}
		await journal('failure', account?.id ?? null, { reason: 'invalid_credentials' });
		return { ok: false, reason: 'invalid_credentials', retryAfterSeconds: null };
	}

	if (!MAY_SIGN_IN.has(account.status)) {
		await journal('denied', account.id, { reason: 'account_inactive' });
		return { ok: false, reason: 'account_inactive', retryAfterSeconds: null };
	}

	await clearAccountFailures(deps.redis, account.emailHmac);
	if (account.passwordHash !== null && needsRehash(account.passwordHash)) {
		// Parameters of the stored hash are below the current ones: recomputed while the password is at hand.
		await deps.db
			.update(passwordCredentials)
			.set({ hash: await hashPassword(password) })
			.where(eq(passwordCredentials.userId, account.id));
	}
	await deps.db.update(users).set({ lastLoginAt: now, lockedUntil: null }).where(eq(users.id, account.id));
	await journal('success', account.id, {});
	if (previous) await destroySession(deps.redis, previous);
	const { sessionId } = await createSession(
		deps.redis,
		{ userId: account.id, authMethod: 'password', authTime: now, ip: meta.ip, ua: meta.userAgent },
		now
	);
	return { ok: true, userId: account.id, sessionId };
}

/** Confirms the password of the signed-in user for a sensitive operation and rotates the session (domain 3.4). */
export async function reauthenticate(
	deps: AuthDeps,
	meta: RequestMeta,
	session: SessionRef,
	password: string
): Promise<{ ok: true; sessionId: string } | { ok: false; reason: 'invalid_credentials' | 'locked' | 'no_password' }> {
	const [row] = await deps.db
		.select({ emailHmac: users.emailHmac, hash: passwordCredentials.hash, lockedUntil: users.lockedUntil })
		.from(users)
		.leftJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
		.where(eq(users.id, session.userId));
	if (!row?.emailHmac) throw new Error(`session user ${session.userId} has no account`);
	const now = deps.now();
	if (row.lockedUntil && row.lockedUntil.getTime() > now.getTime()) return { ok: false, reason: 'locked' };
	if (row.hash === null) return { ok: false, reason: 'no_password' };
	if (!(await verifyPassword(row.hash, password.slice(0, PASSWORD_MAX_LENGTH + 1)))) {
		const { lock } = await registerFailure(deps.redis, { emailHmac: row.emailHmac, ip: meta.ip ?? 'unknown' });
		if (lock) {
			await lockAccount(deps, meta, session.userId, now);
			return { ok: false, reason: 'locked' };
		}
		return { ok: false, reason: 'invalid_credentials' };
	}
	await clearAccountFailures(deps.redis, row.emailHmac);
	await destroySession(deps.redis, session);
	const { sessionId } = await createSession(
		deps.redis,
		{ userId: session.userId, authMethod: 'password', authTime: now, ip: meta.ip, ua: meta.userAgent },
		now
	);
	return { ok: true, sessionId };
}
