// Glue between the administrator cabinet and SvelteKit requests: the access subject read on this request and the
// administrator gate of every page. Roles are read from the database each time (domain 4.2), so a revoked
// administrator loses the cabinet on the next request.
import { error, type RequestEvent } from '@sveltejs/kit';
import { rolesOf, type AccessSubject } from '$lib/server/access/permissions';
import { requestMeta, requireSession } from '$lib/server/auth/http';
import type { RequestMeta } from '$lib/server/auth/context';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { config } from '$lib/server/config';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { checkHealth } from '$lib/server/health';
import { modelModes } from '$lib/server/ml';
import type { IntegrationsDeps } from './integrations';
import type { ModelsDeps } from './models';
import type { SourcesDeps } from './sources';
import type { StaffDeps } from './staff';

export interface AdminRequest {
	subject: AccessSubject;
	meta: RequestMeta;
}

/**
 * The signed-in administrator; without a session — a redirect to the sign-in page, without the administrator role —
 * `403`. Each action still checks its own permission with `can`: the gate only keeps other people out of the cabinet.
 */
export async function adminRequest(event: RequestEvent): Promise<AdminRequest> {
	requireSession(event);
	const { actor } = event.locals;
	if (actor.kind !== 'session') throw new Error('a required session is not a session actor');
	const subject = await loadAccessSubject(db(), actor);
	if (!rolesOf(subject).has('admin')) {
		error(403, {
			message: 'Кабинет администратора доступен только администраторам',
			requestId: event.locals.requestId
		});
	}
	return { subject, meta: requestMeta(event) };
}

export function modelsDeps(): ModelsDeps {
	return { db: db(), modes: modelModes(), models: config().models, now: () => new Date() };
}

export function integrationsDeps(): IntegrationsDeps {
	return { db: db(), config: config(), health: checkHealth, fetch };
}

export function sourcesDeps(): SourcesDeps {
	return { db: db(), now: () => new Date() };
}

export function staffDeps(): StaffDeps {
	return { db: db(), crypto: fieldCrypto(), now: () => new Date() };
}
