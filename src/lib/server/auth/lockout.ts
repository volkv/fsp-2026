// Failed sign-in counters in Redis (domain 3.4). The account counter protects one person from password guessing and
// ends in `users.locked_until`; the address counter protects the service from guessing across accounts from one host.
import type { Redis } from '$lib/server/redis';

/** Failed attempts on one account within the window that lock it. */
export const ACCOUNT_FAILURE_LIMIT = 5;
export const ACCOUNT_WINDOW_SECONDS = 15 * 60;
/** How long a locked account refuses sign-in by password. */
export const LOCKOUT_SECONDS = 15 * 60;
/** Failed attempts from one address within the window after which it is refused before any check. */
export const ADDRESS_FAILURE_LIMIT = 30;
export const ADDRESS_WINDOW_SECONDS = 15 * 60;

const accountKey = (emailHmac: string) => `login_fail:acct:${emailHmac}`;
const addressKey = (ip: string) => `login_fail:ip:${ip}`;

async function count(redis: Redis, key: string, windowSeconds: number): Promise<number> {
	// The window opens with the first failure and is not extended by later ones.
	const [failures] = await redis.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
	if (typeof failures !== 'number') throw new Error(`failure counter ${key}: unexpected reply`);
	return failures;
}

/** Whether the address has used up its failures; seconds until its window ends. */
export async function addressBlocked(
	redis: Redis,
	ip: string
): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
	const [value, ttl] = await Promise.all([redis.get(addressKey(ip)), redis.ttl(addressKey(ip))]);
	const failures = value === null ? 0 : Number(value);
	return { blocked: failures >= ADDRESS_FAILURE_LIMIT, retryAfterSeconds: Math.max(ttl, 0) };
}

/** Counts a failed attempt; `lock` — the account reached the limit and must be locked now. */
export async function registerFailure(
	redis: Redis,
	input: { emailHmac: string | null; ip: string }
): Promise<{ lock: boolean }> {
	await count(redis, addressKey(input.ip), ADDRESS_WINDOW_SECONDS);
	if (input.emailHmac === null) return { lock: false };
	const failures = await count(redis, accountKey(input.emailHmac), ACCOUNT_WINDOW_SECONDS);
	if (failures < ACCOUNT_FAILURE_LIMIT) return { lock: false };
	// The lock itself lives in the database; the counter starts over for the next window.
	await redis.del(accountKey(input.emailHmac));
	return { lock: true };
}

/** A correct password clears the account counter. The address counter stays: it counts guessing, not people. */
export async function clearAccountFailures(redis: Redis, emailHmac: string): Promise<void> {
	await redis.del(accountKey(emailHmac));
}
