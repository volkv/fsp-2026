// Browser sessions in Redis (domain 3.4). The cookie carries only a random id; Redis keys hold its SHA-256, so a dump
// of Redis gives no usable cookie. Rights are not cached here: they are read from the database on every request.
import { z } from 'zod';
import type { Redis } from '$lib/server/redis';
import { newSecret, sha256Hex } from './secrets';

export const SESSION_IDLE_SECONDS = 7 * 24 * 3600;
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 3600;
/** Sensitive operations need an authentication not older than this (domain 3.4). */
export const FRESH_AUTH_SECONDS = 10 * 60;
/** The idle expiry is extended at most this often: every request would be a write otherwise. */
const TOUCH_INTERVAL_MS = 60_000;

export type AuthMethod = 'password' | 'fsp_id';

const recordSchema = z.object({
	userId: z.uuid(),
	createdAt: z.iso.datetime(),
	lastSeenAt: z.iso.datetime(),
	authTime: z.iso.datetime(),
	authMethod: z.enum(['password', 'fsp_id']),
	ip: z.string().nullable(),
	ua: z.string().nullable(),
	csrfToken: z.string().min(32)
});

export type SessionRecord = z.infer<typeof recordSchema>;

export interface Session {
	/** SHA-256 of the session id: the Redis key and the reference in consent evidence. */
	hash: string;
	record: SessionRecord;
}

/** What an operation needs to know about the session it runs in (the request actor carries the same). */
export interface SessionRef {
	hash: string;
	userId: string;
	authTime: Date;
}

export function sessionRef(session: Session): SessionRef {
	return { hash: session.hash, userId: session.record.userId, authTime: new Date(session.record.authTime) };
}

const sessionKey = (hash: string) => `session:${hash}`;
const userSessionsKey = (userId: string) => `user_sessions:${userId}`;

function remainingSeconds(record: SessionRecord, now: Date): number {
	const expiresAt = Date.parse(record.createdAt) + SESSION_ABSOLUTE_SECONDS * 1000;
	return Math.ceil((expiresAt - now.getTime()) / 1000);
}

export async function createSession(
	redis: Redis,
	input: { userId: string; authMethod: AuthMethod; authTime: Date; ip: string | null; ua: string | null },
	now: Date
): Promise<{ sessionId: string; session: Session }> {
	const sessionId = newSecret();
	const hash = sha256Hex(sessionId);
	const record: SessionRecord = {
		userId: input.userId,
		createdAt: now.toISOString(),
		lastSeenAt: now.toISOString(),
		authTime: input.authTime.toISOString(),
		authMethod: input.authMethod,
		ip: input.ip,
		// A user agent is bounded: it is evidence, not an arbitrary blob.
		ua: input.ua === null ? null : input.ua.slice(0, 512),
		csrfToken: newSecret()
	};
	await redis
		.multi()
		.set(sessionKey(hash), JSON.stringify(record), {
			expiration: { type: 'EX', value: Math.min(SESSION_IDLE_SECONDS, SESSION_ABSOLUTE_SECONDS) }
		})
		.sAdd(userSessionsKey(input.userId), hash)
		// The set lives as long as the longest session it can hold.
		.expire(userSessionsKey(input.userId), SESSION_ABSOLUTE_SECONDS)
		.exec();
	return { sessionId, session: { hash, record } };
}

/**
 * Reads the session of a cookie and extends its idle expiry. `null` — no such session, idle expiry passed or the
 * absolute lifetime is over.
 */
export async function readSession(redis: Redis, sessionId: string, now: Date): Promise<Session | null> {
	const hash = sha256Hex(sessionId);
	const raw = await redis.get(sessionKey(hash));
	if (raw === null) return null;
	const parsed = recordSchema.safeParse(JSON.parse(raw));
	if (!parsed.success) {
		// A record this code did not write: the session is not trusted.
		console.error(`[auth] session record ${hash.slice(0, 12)} is malformed; destroying it`);
		await redis.del(sessionKey(hash));
		return null;
	}
	const record = parsed.data;
	const remaining = remainingSeconds(record, now);
	if (remaining <= 0) {
		await destroySession(redis, { hash, userId: record.userId });
		return null;
	}
	if (now.getTime() - Date.parse(record.lastSeenAt) >= TOUCH_INTERVAL_MS) {
		const touched: SessionRecord = { ...record, lastSeenAt: now.toISOString() };
		await redis.set(sessionKey(hash), JSON.stringify(touched), {
			expiration: { type: 'EX', value: Math.min(SESSION_IDLE_SECONDS, remaining) },
			// A session revoked between the read and this write stays revoked.
			condition: 'XX'
		});
		return { hash, record: touched };
	}
	return { hash, record };
}

export async function destroySession(redis: Redis, session: { hash: string; userId: string }): Promise<void> {
	await redis.multi().del(sessionKey(session.hash)).sRem(userSessionsKey(session.userId), session.hash).exec();
}

/** Revokes every session of the user except `keep`; returns how many were revoked. */
export async function revokeUserSessions(redis: Redis, userId: string, keep?: string): Promise<number> {
	const hashes = (await redis.sMembers(userSessionsKey(userId))).filter((hash) => hash !== keep);
	if (hashes.length === 0) return 0;
	const deleted = await redis.del(hashes.map(sessionKey));
	await redis.sRem(userSessionsKey(userId), hashes);
	return deleted;
}

/** Sessions of the user that still exist; stale members of the set are dropped on the way. */
export async function countUserSessions(redis: Redis, userId: string): Promise<number> {
	const hashes = await redis.sMembers(userSessionsKey(userId));
	if (hashes.length === 0) return 0;
	const present = await Promise.all(hashes.map((hash) => redis.exists(sessionKey(hash))));
	const stale = hashes.filter((_, index) => present[index] === 0);
	if (stale.length > 0) await redis.sRem(userSessionsKey(userId), stale);
	return hashes.length - stale.length;
}

/** Whether the authentication behind the session is recent enough for a sensitive operation. */
export function isFreshAuth(authTime: Date, now: Date): boolean {
	return now.getTime() - authTime.getTime() <= FRESH_AUTH_SECONDS * 1000;
}
