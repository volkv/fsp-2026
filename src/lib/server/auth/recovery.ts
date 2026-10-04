// Password reset by a letter and password change (domain 3.2–3.4): a new password revokes every other session.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordAuditEvent } from '$lib/server/audit/record';
import { passwordCredentials, users } from '$lib/server/db/schema';
import { keepSessionLetter } from '$lib/server/demo/letters';
import { passwordChangedLetter, resetPasswordLetter } from '$lib/server/mail/templates';
import { ensureEmailChannel } from '$lib/server/notifications/notify';
import { accountByAddress } from './account-lookup';
import type { AuthDeps, RequestMeta } from './context';
import { consumeEmailToken, issueEmailToken } from './email-tokens';
import { hashPassword, passwordProblems, verifyPassword, PASSWORD_MAX_LENGTH } from './password';
import { createSession, destroySession, isFreshAuth, revokeUserSessions, type SessionRef } from './sessions';

/** One reset letter per address at most this often. */
export const RESET_INTERVAL_SECONDS = 60;

const emailSchema = z.email().max(254);

export function resetLink(appOrigin: string, token: string): string {
	return `${appOrigin}/password/reset?token=${encodeURIComponent(token)}`;
}

/** Statuses a reset letter is sent to: an unconfirmed address is confirmed by the letter itself. */
const MAY_RESET = new Set(['active', 'pending_email']);

/**
 * Sends a reset letter when a live account uses the address. The answer is the same either way, so the form does not
 * tell which addresses are registered. On a demonstration stand the account is looked for as the sign-in by password
 * looks for it (`account-lookup.ts`): within the live demo session of the browser (`demoSessionId`) first, then outside
 * sessions. The letter of an account of a session goes to the session's form of its address, the mailbox of the stand,
 * and is kept with the session for its letters page, the only place the visitor reads it (docs/domain.md, 19.3). An
 * account of the demo seed is never signed in to by password, so it gets no letter either.
 */
export async function requestPasswordReset(deps: AuthDeps, email: string, demoSessionId: string | null): Promise<void> {
	const typed = email.trim();
	if (!emailSchema.safeParse(typed).success) return;
	const account = await accountByAddress(deps.db, deps.crypto, typed, demoSessionId);
	if (!account || account.seeded || !MAY_RESET.has(account.status)) return;
	const throttled = await deps.redis.set(`password_reset:${account.emailHmac}`, '1', {
		expiration: { type: 'EX', value: RESET_INTERVAL_SECONDS },
		condition: 'NX'
	});
	if (throttled === null) return;
	const now = deps.now();
	const userId = account.id;
	const letter = await deps.db.transaction(async (tx) => {
		const token = await issueEmailToken(tx, 'reset_password', { userId }, now);
		const message = resetPasswordLetter(account.address, resetLink(deps.appOrigin, token));
		if (account.demoSessionId !== null) {
			await keepSessionLetter(tx, deps.crypto, {
				demoSessionId: account.demoSessionId,
				kind: 'password_reset',
				object: { type: 'user', id: userId },
				message
			});
		}
		return message;
	});
	const sent = await deps.mailer.send(letter);
	if (!sent.ok) console.error(`[auth] reset letter not sent: ${sent.error.code} ${sent.error.message}`);
}

async function notifyPasswordChanged(deps: AuthDeps, emailEnc: Uint8Array): Promise<void> {
	const sent = await deps.mailer.send(
		passwordChangedLetter(deps.crypto.decrypt(emailEnc, 'users.email'), `${deps.appOrigin}/login`)
	);
	if (!sent.ok) console.error(`[auth] password change notice not sent: ${sent.error.code} ${sent.error.message}`);
}

export type ResetResult =
	{ ok: true } | { ok: false; reason: 'invalid_token' } | { ok: false; reason: 'weak'; problems: string[] };

class WeakPassword extends Error {
	readonly problems: string[];
	constructor(problems: string[]) {
		super('weak password');
		this.problems = problems;
	}
}

/**
 * Sets the password from a reset letter. The letter came to the address, so it also confirms the address and lifts
 * a lockout; every session of the account ends.
 */
export async function resetPassword(
	deps: AuthDeps,
	meta: RequestMeta,
	token: string,
	password: string
): Promise<ResetResult> {
	const now = deps.now();
	const hash = password.length > PASSWORD_MAX_LENGTH ? null : await hashPassword(password);
	let outcome: { userId: string; emailEnc: Uint8Array } | null;
	try {
		outcome = await deps.db.transaction(async (tx) => {
			const consumed = await consumeEmailToken(tx, 'reset_password', token, now);
			if (consumed?.userId == null) return null;
			const [user] = await tx
				.select({ id: users.id, emailEnc: users.emailEnc })
				.from(users)
				.where(and(eq(users.id, consumed.userId), inArray(users.status, ['active', 'pending_email'])));
			if (!user?.emailEnc) return null;
			// Rolled back together with the token: a weak password does not use the letter up.
			const problems = passwordProblems(password, deps.crypto.decrypt(user.emailEnc, 'users.email'));
			if (problems.length > 0 || hash === null) throw new WeakPassword(problems);
			await tx
				.insert(passwordCredentials)
				.values({ userId: user.id, hash, changedAt: now })
				.onConflictDoUpdate({ target: passwordCredentials.userId, set: { hash, changedAt: now } });
			await tx
				.update(users)
				.set({
					lockedUntil: null,
					emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now.toISOString()}::timestamptz)`,
					status: sql`case when ${users.status} = 'pending_email' then 'active' else ${users.status} end`
				})
				.where(eq(users.id, user.id));
			await ensureEmailChannel(tx, user.id, now);
			await recordAuditEvent(tx, {
				action: 'auth.password_reset',
				outcome: 'success',
				actor: { kind: 'user', userId: user.id },
				object: { type: 'user', id: user.id },
				requestId: meta.requestId,
				ip: meta.ip,
				userAgent: meta.userAgent
			});
			return { userId: user.id, emailEnc: user.emailEnc };
		});
	} catch (error) {
		if (error instanceof WeakPassword) return { ok: false, reason: 'weak', problems: error.problems };
		throw error;
	}
	if (!outcome) return { ok: false, reason: 'invalid_token' };
	await revokeUserSessions(deps.redis, outcome.userId);
	await notifyPasswordChanged(deps, outcome.emailEnc);
	return { ok: true };
}

export type ChangeResult =
	| { ok: true; sessionId: string }
	| { ok: false; reason: 'wrong_current' | 'stale_auth' }
	| { ok: false; reason: 'weak'; problems: string[] };

/**
 * Changes the password of the signed-in user, or sets one for an account created through FSP ID. The current password
 * proves the person; without one the session must be fresh (domain 3.4). Other sessions end, this one is rotated.
 */
export async function changePassword(
	deps: AuthDeps,
	meta: RequestMeta,
	session: SessionRef,
	input: { current: string | null; next: string }
): Promise<ChangeResult> {
	const now = deps.now();
	const userId = session.userId;
	const [user] = await deps.db
		.select({ emailEnc: users.emailEnc, hash: passwordCredentials.hash })
		.from(users)
		.leftJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
		.where(eq(users.id, userId));
	if (!user?.emailEnc) throw new Error(`session user ${userId} has no account`);
	if (user.hash !== null) {
		if (input.current === null || !(await verifyPassword(user.hash, input.current.slice(0, PASSWORD_MAX_LENGTH + 1)))) {
			return { ok: false, reason: 'wrong_current' };
		}
	} else if (!isFreshAuth(session.authTime, now)) {
		return { ok: false, reason: 'stale_auth' };
	}
	const problems = passwordProblems(input.next, deps.crypto.decrypt(user.emailEnc, 'users.email'));
	if (problems.length > 0) return { ok: false, reason: 'weak', problems };
	const hash = await hashPassword(input.next);
	await deps.db.transaction(async (tx) => {
		await tx
			.insert(passwordCredentials)
			.values({ userId, hash, changedAt: now })
			.onConflictDoUpdate({ target: passwordCredentials.userId, set: { hash, changedAt: now } });
		await recordAuditEvent(tx, {
			action: 'auth.password_changed',
			outcome: 'success',
			actor: { kind: 'user', userId },
			object: { type: 'user', id: userId },
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { first_password: user.hash === null }
		});
	});
	await destroySession(deps.redis, session);
	await revokeUserSessions(deps.redis, userId);
	const { sessionId } = await createSession(
		deps.redis,
		{ userId, authMethod: 'password', authTime: now, ip: meta.ip, ua: meta.userAgent },
		now
	);
	await notifyPasswordChanged(deps, user.emailEnc);
	return { ok: true, sessionId };
}
