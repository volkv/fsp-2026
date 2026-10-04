// Glue between the employer cabinet and SvelteKit requests: the access subject of the session, the services built
// from the configured infrastructure; page errors and form failures come from `$lib/server/http/page`.
import { error, type RequestEvent } from '@sveltejs/kit';
import type { AccessSubject } from '$lib/server/access/permissions';
import { requestMeta, requireSession } from '$lib/server/auth/http';
import type { RequestMeta } from '$lib/server/auth/context';
import { configuredRegistry } from '$lib/server/companies/registry';
import { auditActorOf, requirePermission, type CompanyDeps } from '$lib/server/companies/context';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { config } from '$lib/server/config';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { mailer } from '$lib/server/mail/mailer';
import type { VacancyAuthor } from '$lib/server/vacancies/own';

export interface EmployerRequest {
	subject: AccessSubject;
	meta: RequestMeta;
	/** SHA-256 of the session id: consent evidence and the journal of invitation actions. */
	sessionHash: string;
}

/**
 * The signed-in person with roles read on this request; without a session — a redirect to the sign-in page. A catalog
 * page over the rate limit of its account is refused here with `429`: the hook lets it through to render the refusal in
 * the layout of the site.
 */
export async function employerRequest(event: RequestEvent): Promise<EmployerRequest> {
	if (event.locals.rateLimited) {
		error(429, { message: 'Слишком много запросов подряд. Повторите через минуту', requestId: event.locals.requestId });
	}
	requireSession(event);
	const { actor } = event.locals;
	if (actor.kind !== 'session') throw new Error('a required session is not a session actor');
	return {
		subject: await loadAccessSubject(db(), actor),
		meta: requestMeta(event),
		sessionHash: actor.sessionHash
	};
}

/** The active membership of the subject; the cabinet pages of a company need one. */
export function membershipOf(event: RequestEvent, subject: AccessSubject): NonNullable<AccessSubject['membership']> {
	const membership = subject.membership;
	if (membership?.status !== 'active') {
		error(403, { message: 'Вы не состоите в команде компании', requestId: event.locals.requestId });
	}
	return membership;
}

export function companyDeps(): CompanyDeps {
	const settings = config();
	return {
		db: db(),
		crypto: fieldCrypto(),
		mailer: mailer(),
		registry: configuredRegistry(settings.companyRegistry),
		appOrigin: settings.appOrigin,
		now: () => new Date()
	};
}

/** The member acting on the vacancies of its company, after `vacancy.write` of an own vacancy of that company. */
export function vacancyAuthor(subject: AccessSubject, meta: RequestMeta): VacancyAuthor {
	const membership = subject.membership;
	requirePermission(subject, 'vacancy.write', { origin: 'own', companyId: membership?.companyId ?? null });
	if (!membership) throw new Error('vacancy.write granted without a membership');
	return {
		memberId: membership.memberId,
		companyId: membership.companyId,
		audit: auditActorOf(subject),
		requestId: meta.requestId
	};
}
