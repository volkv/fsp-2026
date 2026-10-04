import type { Actor } from '$lib/server/access/actor';
import type { Executor } from '$lib/server/db';
import { auditEvents } from '$lib/server/db/schema';
import { parseAuditDetails, type AuditAction } from './events';

export type AuditActor =
	| { kind: 'user'; userId: string; companyId?: string }
	| { kind: 'api_key'; apiKeyId: string; userId: string; companyId: string }
	| { kind: 'system' }
	| { kind: 'anonymous' };

export interface AuditEventInput {
	action: AuditAction;
	outcome: 'success' | 'denied' | 'failure';
	actor: AuditActor;
	object?: { type: string; id: string };
	subjectCandidateId?: string;
	requestId: string;
	ip?: string | null;
	userAgent?: string | null;
	details?: Record<string, unknown> | null;
	occurredAt?: Date;
}

export function auditActorOf(actor: Actor): AuditActor {
	switch (actor.kind) {
		case 'anonymous':
			return { kind: 'anonymous' };
		case 'session':
			return { kind: 'user', userId: actor.userId };
		case 'api_key':
			return { kind: 'api_key', apiKeyId: actor.apiKeyId, userId: actor.userId, companyId: actor.companyId };
	}
}

/**
 * Appends one event to the journal. Called inside the transaction of the action it records,
 * so the action and its record are committed together.
 */
export async function recordAuditEvent(executor: Executor, event: AuditEventInput): Promise<void> {
	const details = parseAuditDetails(event.action, event.details ?? null);
	const actor = event.actor;
	await executor.insert(auditEvents).values({
		occurredAt: event.occurredAt ?? new Date(),
		action: event.action,
		outcome: event.outcome,
		actorKind: actor.kind,
		actorUserId: actor.kind === 'user' || actor.kind === 'api_key' ? actor.userId : null,
		actorCompanyId: actor.kind === 'user' || actor.kind === 'api_key' ? (actor.companyId ?? null) : null,
		apiKeyId: actor.kind === 'api_key' ? actor.apiKeyId : null,
		objectType: event.object?.type ?? null,
		objectId: event.object?.id ?? null,
		subjectCandidateId: event.subjectCandidateId ?? null,
		requestId: event.requestId,
		ip: event.ip ?? null,
		userAgent: event.userAgent ?? null,
		details
	});
}
