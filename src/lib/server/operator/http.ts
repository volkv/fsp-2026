// Glue between the FSP operator cabinet and SvelteKit requests: the access subject read on this request, the operator
// gate of every page and the context the services take. Roles are read from the database each time (domain 4.2), so a
// revoked operator loses the cabinet on the next request.
import { error, type RequestEvent } from '@sveltejs/kit';
import { rolesOf, type AccessSubject } from '$lib/server/access/permissions';
import { requestMeta, requireSession } from '$lib/server/auth/http';
import type { RequestMeta } from '$lib/server/auth/context';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { db } from '$lib/server/db';

export interface OperatorRequest {
	subject: AccessSubject;
	meta: RequestMeta;
	/** The operator's user id: the author of decisions and of the journal events. */
	operatorId: string;
}

/**
 * The signed-in FSP operator; without a session — a redirect to the sign-in page, without the operator role — `403`.
 * Each action still checks its own permission with `can`: the gate only keeps other people out of the cabinet.
 */
export async function operatorRequest(event: RequestEvent): Promise<OperatorRequest> {
	requireSession(event);
	const { actor } = event.locals;
	if (actor.kind !== 'session') throw new Error('a required session is not a session actor');
	const subject = await loadAccessSubject(db(), actor);
	if (!rolesOf(subject).has('operator')) {
		error(403, { message: 'Кабинет оператора ФСП доступен только операторам', requestId: event.locals.requestId });
	}
	return { subject, meta: requestMeta(event), operatorId: actor.userId };
}
