// A first sign-in through FSP ID waiting for the registration form (contracts 2.3, steps 2–3). The provider result is
// held in Redis for ten minutes under a random key the browser keeps in a cookie; nothing is written to accounts until
// the person finishes the form.
import { z } from 'zod';
import type { Redis } from '$lib/server/redis';
import type { ProfileClaims } from './oidc';
import { newSecret, sha256Hex } from './secrets';

export const PENDING_SIGNUP_TTL_SECONDS = 600;

const pendingSchema = z.object({
	issuer: z.string().min(1),
	subject: z.string().min(1),
	authTime: z.number().int(),
	claims: z.object({
		name: z.string().optional(),
		given_name: z.string().optional(),
		family_name: z.string().optional(),
		preferred_username: z.string().optional(),
		email: z.string().optional()
	}),
	/** The address of the token belongs to an existing account: the person chooses a path first (step 3). */
	emailConflict: z.boolean(),
	/** On a demonstration stand, the visitor's demo session the account is created in (docs/domain.md, 19.3). */
	demoSessionId: z.uuid().nullable()
});

export type PendingSignup = z.infer<typeof pendingSchema>;

const pendingKey = (token: string) => `fsp_signup:${sha256Hex(token)}`;

export async function holdPendingSignup(redis: Redis, pending: PendingSignup): Promise<string> {
	const token = newSecret();
	await redis.set(pendingKey(token), JSON.stringify(pending), {
		expiration: { type: 'EX', value: PENDING_SIGNUP_TTL_SECONDS }
	});
	return token;
}

export async function readPendingSignup(redis: Redis, token: string): Promise<PendingSignup | null> {
	const raw = await redis.get(pendingKey(token));
	return raw === null ? null : pendingSchema.parse(JSON.parse(raw));
}

export async function dropPendingSignup(redis: Redis, token: string): Promise<void> {
	await redis.del(pendingKey(token));
}

/** Name to prefill: the full name, or given and family names, or the username. */
export function displayNameOf(claims: ProfileClaims): string {
	const full = claims.name ?? [claims.given_name, claims.family_name].filter(Boolean).join(' ');
	return full.trim() !== '' ? full.trim() : (claims.preferred_username ?? '');
}
