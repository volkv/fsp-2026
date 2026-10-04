// Sign-out of one browser and of every device (domain 3.4, 18.2).
import { recordAuditEvent } from '$lib/server/audit/record';
import type { AuthDeps, RequestMeta } from './context';
import { destroySession, revokeUserSessions, type SessionRef } from './sessions';

export async function signOut(deps: AuthDeps, meta: RequestMeta, session: SessionRef): Promise<void> {
	await destroySession(deps.redis, session);
	await recordAuditEvent(deps.db, {
		action: 'auth.logout',
		outcome: 'success',
		actor: { kind: 'user', userId: session.userId },
		object: { type: 'user', id: session.userId },
		requestId: meta.requestId,
		ip: meta.ip,
		userAgent: meta.userAgent
	});
}

/** Ends every session of the user, the current one included. */
export async function signOutEverywhere(deps: AuthDeps, meta: RequestMeta, session: SessionRef): Promise<number> {
	const revoked = await revokeUserSessions(deps.redis, session.userId);
	await recordAuditEvent(deps.db, {
		action: 'session.revoked_all',
		outcome: 'success',
		actor: { kind: 'user', userId: session.userId },
		object: { type: 'user', id: session.userId },
		requestId: meta.requestId,
		ip: meta.ip,
		userAgent: meta.userAgent,
		details: { count: revoked }
	});
	return revoked;
}
