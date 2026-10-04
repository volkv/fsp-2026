// Glue between the candidate cabinet and SvelteKit requests: the access subject of the session with its candidate
// profile and the request metadata that consents and the journal record; page errors and form failures come from
// `$lib/server/http/page`.
import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import type { AccessSubject } from '$lib/server/access/permissions';
import { requestMeta, requireSession } from '$lib/server/auth/http';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { db } from '$lib/server/db';
import type { RequestMeta } from '$lib/server/invitations/deps';

export interface CandidateRequest {
	subject: AccessSubject;
	candidateId: string;
	userId: string;
	/** With the session hash: consent events keep it as evidence (domain 6.3). */
	meta: RequestMeta & { requestId: string; sessionHash: string };
}

/**
 * The signed-in candidate with roles read on this request. Without a session — the sign-in page; a profile still on
 * its registration path — the registration steps; a person without a candidate profile or one being deleted — `403`.
 */
export async function candidateRequest(event: RequestEvent): Promise<CandidateRequest> {
	requireSession(event);
	const { actor, requestId } = event.locals;
	if (actor.kind !== 'session') throw new Error('a required session is not a session actor');
	const subject = await loadAccessSubject(db(), actor);
	const candidate = subject.candidate;
	if (!candidate) {
		error(403, { message: 'Кабинет кандидата открывается профилю соискателя', requestId });
	}
	if (candidate.status === 'onboarding' || candidate.status === 'ineligible_age') redirect(303, '/onboarding');
	if (candidate.status !== 'active') {
		error(403, { message: 'Профиль удаляется: кабинет кандидата недоступен', requestId });
	}
	const base = requestMeta(event);
	return {
		subject,
		candidateId: candidate.id,
		userId: actor.userId,
		meta: { requestId, ip: base.ip, userAgent: base.userAgent, sessionHash: actor.sessionHash }
	};
}
