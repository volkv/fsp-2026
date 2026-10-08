// Adapters from the request context of an operation to the contexts the domain modules take.
import { can, type AccessSubject } from '$lib/server/access/permissions';
import type { RequestMeta as AuthMeta } from '$lib/server/auth/context';
import type { SessionRef } from '$lib/server/auth/sessions';
import type { ActionContext } from '$lib/server/companies/context';
import type { RequestMeta as InvitationMeta } from '$lib/server/invitations/deps';
import { ApiError } from '$lib/server/errors/api-error';
import type { OperationContext } from '../operation';
import { candidateOfPseudonym } from '../read/pseudonyms';

type AnyContext = OperationContext<unknown, unknown, unknown>;

/** The part of an operation context that does not depend on its input. */
export type BaseContext = Pick<AnyContext, 'services' | 'actor' | 'subject' | 'meta' | 'signal'>;

/** The context of the companies module. */
export async function actionContext(ctx: Pick<AnyContext, 'subject' | 'meta'>): Promise<ActionContext> {
	return {
		subject: await ctx.subject(),
		meta: { requestId: ctx.meta.requestId, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent }
	};
}

/** The request metadata of the invitation and hiring modules. */
export function invitationMeta(ctx: Pick<AnyContext, 'meta'>): InvitationMeta {
	return {
		requestId: ctx.meta.requestId,
		ip: ctx.meta.ip,
		userAgent: ctx.meta.userAgent,
		sessionHash: ctx.meta.sessionHash,
		...(ctx.meta.apiKeyId === null ? {} : { apiKeyId: ctx.meta.apiKeyId })
	};
}

/** The active membership of the subject, or `null`. */
export function activeMembership(subject: AccessSubject) {
	return subject.membership?.status === 'active' ? subject.membership : null;
}

/** The subject of a company member and the candidate a pseudonym of their company names; `404` — none. */
export async function candidateOfPseudonymFor(
	ctx: Pick<AnyContext, 'services' | 'subject'>,
	pseudonym: string
): Promise<{ subject: AccessSubject; candidateId: string }> {
	const subject = await ctx.subject();
	const membership = activeMembership(subject);
	if (membership === null) throw new ApiError('forbidden');
	const candidateId = await candidateOfPseudonym(ctx.services.db, ctx.services.crypto, membership.companyId, pseudonym);
	if (candidateId === null) throw new ApiError('not_found');
	return { subject, candidateId };
}

/** The signed-in candidate holding the permission over their own profile; anyone else — `403`. */
export async function ownCandidate(
	ctx: Pick<AnyContext, 'subject'>,
	permission: 'candidate.self.read' | 'candidate.self.write'
): Promise<{ subject: AccessSubject; candidateId: string; userId: string }> {
	const subject = await ctx.subject();
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined || subject.userId === null) throw new ApiError('forbidden');
	if (!can(subject, permission, { candidateId }).allowed) throw new ApiError('forbidden');
	return { subject, candidateId, userId: subject.userId };
}

/** The browser session of a session-only operation, as the sign-in module takes it. */
export function sessionOf(ctx: Pick<AnyContext, 'actor'>): SessionRef {
	const { actor } = ctx;
	if (actor.kind !== 'session') throw new ApiError('forbidden');
	return { hash: actor.sessionHash, userId: actor.userId, authTime: actor.authTime };
}

/** The request metadata of the sign-in module. */
export function requestMetaOf(ctx: Pick<AnyContext, 'meta'>): AuthMeta {
	return { requestId: ctx.meta.requestId, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent };
}
