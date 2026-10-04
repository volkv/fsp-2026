// Resolution of the session cookie on every request (hooks.server.ts). The account is read from the database each time:
// a suspended or deleted account loses its sessions at once, whatever Redis still holds. A clone of a demo session
// signs in no longer than its demo session lives (docs/domain.md, section 19.3): once `demo_sessions.expires_at` has
// passed, or the session is gone, its sign-in sessions are ended on their next request; a live one is marked as used.
import { eq } from 'drizzle-orm';
import type { Actor } from '$lib/server/access/actor';
import type { Database } from '$lib/server/db';
import { demoSessions, users } from '$lib/server/db/schema';
import { redisDemoActivity } from '$lib/server/demo/activity';
import type { Redis } from '$lib/server/redis';
import { destroySession, readSession, type SessionRef } from './sessions';

const MAY_ACT = new Set(['active', 'pending_email']);

export type SessionActor = Extract<Actor, { kind: 'session' }>;

export async function authenticateSession(
	deps: { db: Database; redis: Redis; now: () => Date },
	sessionId: string
): Promise<SessionActor | null> {
	const now = deps.now();
	const session = await readSession(deps.redis, sessionId, now);
	if (!session) return null;
	const [user] = await deps.db
		.select({ status: users.status, demoSessionId: users.demoSessionId, demoEndsAt: demoSessions.expiresAt })
		.from(users)
		.leftJoin(demoSessions, eq(demoSessions.id, users.demoSessionId))
		.where(eq(users.id, session.record.userId));
	const demoOver = (row: { demoSessionId: string | null; demoEndsAt: Date | null }) =>
		row.demoSessionId !== null && (row.demoEndsAt === null || row.demoEndsAt.getTime() <= now.getTime());
	if (!user || !MAY_ACT.has(user.status) || demoOver(user)) {
		await destroySession(deps.redis, { hash: session.hash, userId: session.record.userId });
		return null;
	}
	if (user.demoSessionId !== null) await redisDemoActivity(deps.redis).touch(user.demoSessionId, now);
	return {
		kind: 'session',
		userId: session.record.userId,
		sessionHash: session.hash,
		authTime: new Date(session.record.authTime),
		authMethod: session.record.authMethod,
		csrfToken: session.record.csrfToken
	};
}

/** The session of a request actor, or `null` for an anonymous request or an API key. */
export function sessionOfActor(actor: Actor): SessionRef | null {
	return actor.kind === 'session' ? { hash: actor.sessionHash, userId: actor.userId, authTime: actor.authTime } : null;
}
