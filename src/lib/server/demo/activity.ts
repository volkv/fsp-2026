// When a demo session was last used (docs/domain.md, section 19.3). Every authenticated request of a clone and every
// visit of the demo screen with the session touches it; a session nobody uses is ended early — by `demo.purge` once it
// has been idle for the idle time of the terms (`terms.ts`), or when the stand is full and a new visitor needs its
// place after the quiet time of the terms. The times live in Redis beside the sign-in sessions they come from: a
// session with no time recorded counts from its opening.
import { config } from '$lib/server/config';
import type { Redis } from '$lib/server/redis';

const ACTIVITY_KEY = 'demo:activity';

export interface DemoActivity {
	/** The session was used at `at`. */
	touch(sessionId: string, at: Date): Promise<void>;
	/** The last recorded use of each session that has one. */
	lastUsed(sessionIds: readonly string[]): Promise<Map<string, Date>>;
	/** Drops the times of removed sessions. */
	forget(sessionIds: readonly string[]): Promise<void>;
}

export function redisDemoActivity(redis: Redis): DemoActivity {
	return {
		async touch(sessionId, at) {
			// `GT`: a request that finishes late never moves the time back.
			await redis.zAdd(ACTIVITY_KEY, { score: at.getTime(), value: sessionId }, { comparison: 'GT' });
		},
		async lastUsed(sessionIds) {
			if (sessionIds.length === 0) return new Map();
			const scores = await redis.zmScore(ACTIVITY_KEY, [...sessionIds]);
			const used = new Map<string, Date>();
			sessionIds.forEach((id, index) => {
				const score = scores[index];
				if (score !== null && score !== undefined) used.set(id, new Date(score));
			});
			return used;
		},
		async forget(sessionIds) {
			if (sessionIds.length > 0) await redis.zRem(ACTIVITY_KEY, [...sessionIds]);
		}
	};
}

/** The last use of a session: the recorded one, or its opening when none is recorded. */
export function lastUseOf(session: { id: string; createdAt: Date }, used: ReadonlyMap<string, Date>): Date {
	return used.get(session.id) ?? session.createdAt;
}

/**
 * The next nightly reset of the demonstration stand (domain 19.2), which removes every demo session with the rest of
 * the demonstration data: 00:00 UTC, when the job `demo.reset` of the night runs (`jobs/scheduler.ts`).
 */
export function nextStandReset(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * When a session goes at the latest whatever its use: its own end or the nightly reset of the stand, the earlier. With
 * `DEMO_NIGHTLY_RESET` off nothing resets the stand, and the session's own end is the last one.
 */
export function lastEndOf(expiresAt: Date, now: Date): Date {
	if (config().demo?.nightlyReset === false) return expiresAt;
	return new Date(Math.min(expiresAt.getTime(), nextStandReset(now).getTime()));
}

/**
 * When a session in use goes at the latest if nobody comes back: the idle end from now, never after its last end. What
 * the visitor is shown as the time left.
 */
export function idleEndOf(expiresAt: Date, now: Date, idleMinutes: number): Date {
	return new Date(Math.min(lastEndOf(expiresAt, now).getTime(), now.getTime() + idleMinutes * 60_000));
}
