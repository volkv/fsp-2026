// Confirmation of the address by our link (domain 3.1: an address from a provider is not confirmed for the platform).
import { eq, sql } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import { users } from '$lib/server/db/schema';
import { verifyEmailLetter } from '$lib/server/mail/templates';
import { ensureEmailChannel } from '$lib/server/notifications/notify';
import type { AuthDeps, RequestMeta } from './context';
import { consumeEmailToken, issueEmailToken } from './email-tokens';

/** One more letter per account at most this often. */
export const RESEND_INTERVAL_SECONDS = 60;

export function verificationLink(appOrigin: string, token: string): string {
	return `${appOrigin}/verify-email?token=${encodeURIComponent(token)}`;
}

/** Sends the letter; `false` when the mail server did not take it (the failure is logged without the address). */
export async function sendVerificationLetter(deps: AuthDeps, email: string, token: string): Promise<boolean> {
	const sent = await deps.mailer.send(verifyEmailLetter(email, verificationLink(deps.appOrigin, token)));
	if (!sent.ok) console.error(`[auth] verification letter not sent: ${sent.error.code} ${sent.error.message}`);
	return sent.ok;
}

export type VerifyResult = { ok: true; userId: string } | { ok: false; reason: 'invalid_token' };

export async function verifyEmail(deps: AuthDeps, meta: RequestMeta, token: string): Promise<VerifyResult> {
	const now = deps.now();
	return deps.db.transaction(async (tx) => {
		const consumed = await consumeEmailToken(tx, 'verify_email', token, now);
		if (consumed?.userId == null) return { ok: false, reason: 'invalid_token' } as const;
		const [user] = await tx
			.update(users)
			.set({
				emailVerifiedAt: now,
				status: sql`case when ${users.status} = 'pending_email' then 'active' else ${users.status} end`
			})
			.where(eq(users.id, consumed.userId))
			.returning({ id: users.id, status: users.status });
		if (!user) return { ok: false, reason: 'invalid_token' } as const;
		// A confirmed address is a delivery channel from now on (domain 3.7).
		await ensureEmailChannel(tx, user.id, now);
		await recordAuditEvent(tx, {
			action: 'auth.email_verified',
			outcome: 'success',
			actor: { kind: 'user', userId: user.id },
			object: { type: 'user', id: user.id },
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent
		});
		return { ok: true, userId: user.id } as const;
	});
}

export type ResendResult = { ok: true } | { ok: false; reason: 'already_verified' | 'too_soon' | 'not_sent' };

export async function resendVerification(deps: AuthDeps, userId: string): Promise<ResendResult> {
	const now = deps.now();
	const [user] = await deps.db
		.select({ emailEnc: users.emailEnc, verifiedAt: users.emailVerifiedAt })
		.from(users)
		.where(eq(users.id, userId));
	if (!user?.emailEnc) throw new Error(`user ${userId} has no address`);
	if (user.verifiedAt !== null) return { ok: false, reason: 'already_verified' };
	const throttled = await deps.redis.set(`verify_resend:${userId}`, '1', {
		expiration: { type: 'EX', value: RESEND_INTERVAL_SECONDS },
		condition: 'NX'
	});
	if (throttled === null) return { ok: false, reason: 'too_soon' };
	const token = await deps.db.transaction((tx) => issueEmailToken(tx, 'verify_email', { userId }, now));
	const sent = await sendVerificationLetter(deps, deps.crypto.decrypt(user.emailEnc, 'users.email'), token);
	return sent ? { ok: true } : { ok: false, reason: 'not_sent' };
}
