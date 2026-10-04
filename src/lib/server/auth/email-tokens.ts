// Single-use tokens sent by email (domain 3.3): only the SHA-256 is stored, the link carries the token itself.
import { and, eq, gt, isNull, max } from 'drizzle-orm';
import type { Executor } from '$lib/server/db';
import { emailTokens } from '$lib/server/db/schema';
import { newSecret, sha256Hex } from './secrets';

export type EmailTokenPurpose =
	| 'verify_email'
	| 'reset_password'
	| 'member_invite'
	| 'representative_invite'
	| 'representative_consent'
	| 'representative_disclosure';

const LIFETIME_SECONDS: Record<EmailTokenPurpose, number> = {
	verify_email: 24 * 3600,
	reset_password: 3600,
	member_invite: 24 * 3600,
	representative_invite: 24 * 3600,
	// A representative has no account and reads the mail when they read it: a week for the consents, and for an
	// invitation no longer than the deadline of its terms (`notAfter`).
	representative_consent: 7 * 24 * 3600,
	representative_disclosure: 7 * 24 * 3600
};

type Target = { userId: string } | { targetRef: string };

/** When a token of the purpose issued at `now` stops working; `notAfter` shortens it to a moment of the target. */
export function emailTokenExpiry(purpose: EmailTokenPurpose, now: Date, notAfter?: Date): Date {
	return new Date(
		Math.min(now.getTime() + LIFETIME_SECONDS[purpose] * 1000, notAfter?.getTime() ?? Number.POSITIVE_INFINITY)
	);
}

/**
 * Issues a token and withdraws the unused ones of the same purpose and target: only the last letter works.
 * `notAfter` shortens the lifetime of the purpose to a moment of the target (the deadline of an answer).
 * Runs in the caller's transaction.
 */
export async function issueEmailToken(
	executor: Executor,
	purpose: EmailTokenPurpose,
	target: Target,
	now: Date,
	notAfter?: Date
): Promise<string> {
	const targetCondition =
		'userId' in target ? eq(emailTokens.userId, target.userId) : eq(emailTokens.targetRef, target.targetRef);
	await executor
		.delete(emailTokens)
		.where(and(eq(emailTokens.purpose, purpose), targetCondition, isNull(emailTokens.usedAt)));
	const token = newSecret();
	await executor.insert(emailTokens).values({
		purpose,
		tokenHash: sha256Hex(token),
		...('userId' in target ? { userId: target.userId } : { targetRef: target.targetRef }),
		createdAt: now,
		expiresAt: emailTokenExpiry(purpose, now, notAfter)
	});
	return token;
}

export interface ConsumedToken {
	id: string;
	userId: string | null;
	targetRef: string | null;
}

/** Marks a valid token used and returns it; `null` for an unknown, used or expired token. Atomic: one use only. */
export async function consumeEmailToken(
	executor: Executor,
	purpose: EmailTokenPurpose,
	token: string,
	now: Date
): Promise<ConsumedToken | null> {
	const [row] = await executor
		.update(emailTokens)
		.set({ usedAt: now })
		.where(
			and(
				eq(emailTokens.tokenHash, sha256Hex(token)),
				eq(emailTokens.purpose, purpose),
				isNull(emailTokens.usedAt),
				gt(emailTokens.expiresAt, now)
			)
		)
		.returning({ id: emailTokens.id, userId: emailTokens.userId, targetRef: emailTokens.targetRef });
	return row ?? null;
}

/** Whether the token would be accepted now, without using it: the page behind a link shows its form only then. */
export async function emailTokenUsable(
	executor: Executor,
	purpose: EmailTokenPurpose,
	token: string,
	now: Date
): Promise<boolean> {
	return (await usableEmailToken(executor, purpose, token, now)) !== null;
}

/** The token that would be accepted now, without using it; `null` for an unknown, used or expired token. */
export async function usableEmailToken(
	executor: Executor,
	purpose: EmailTokenPurpose,
	token: string,
	now: Date
): Promise<ConsumedToken | null> {
	const [row] = await executor
		.select({ id: emailTokens.id, userId: emailTokens.userId, targetRef: emailTokens.targetRef })
		.from(emailTokens)
		.where(
			and(
				eq(emailTokens.tokenHash, sha256Hex(token)),
				eq(emailTokens.purpose, purpose),
				isNull(emailTokens.usedAt),
				gt(emailTokens.expiresAt, now)
			)
		);
	return row ?? null;
}

/** When the last token of the purpose and target was issued; `null` — never. */
export async function lastEmailTokenIssuedAt(
	executor: Executor,
	purpose: EmailTokenPurpose,
	targetRef: string
): Promise<Date | null> {
	const [row] = await executor
		.select({ at: max(emailTokens.createdAt) })
		.from(emailTokens)
		.where(and(eq(emailTokens.purpose, purpose), eq(emailTokens.targetRef, targetRef)));
	return row?.at ?? null;
}
