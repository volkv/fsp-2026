// Adapters from the request context of an operation to the contexts the domain modules take.
import type { AccessSubject } from '$lib/server/access/permissions';
import type { ActionContext } from '$lib/server/companies/context';
import type { RequestMeta as InvitationMeta } from '$lib/server/invitations/deps';
import type { OperationContext } from '../operation';

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
