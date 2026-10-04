// What the companies module works with: services built from the configured infrastructure, the subject read on this
// request and the request metadata for the journal. Routes build them; tests pass their own.
import {
	can,
	type AccessDecision,
	type AccessSubject,
	type Permission,
	type PermissionObjects
} from '$lib/server/access/permissions';
import type { AuditActor } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database } from '$lib/server/db';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import type { Mailer } from '$lib/server/mail/mailer';
import type { CompanyRegistry } from './registry';

export interface CompanyDeps {
	db: Database;
	crypto: FieldCrypto;
	mailer: Mailer;
	registry: CompanyRegistry;
	/** Origin of links in letters. */
	appOrigin: string;
	now: () => Date;
}

export interface ActionContext {
	subject: AccessSubject;
	meta: RequestMeta;
}

/**
 * `can` or an error: a missing role is `forbidden` (`unauthenticated` without a sign-in); a failed object rule is
 * `not_found`, because the actor is not entitled to know about another company's objects (contracts 5.3).
 */
export function requirePermission<P extends Permission>(
	subject: AccessSubject,
	permission: P,
	object: PermissionObjects[P]
): void {
	const decision: AccessDecision = can(subject, permission, object);
	if (decision.allowed) return;
	if (decision.reason === 'unauthenticated') throw new ApiError('unauthenticated');
	if (decision.reason === 'object') throw new ApiError('not_found');
	throw new ApiError('forbidden');
}

/** The journal actor of a session subject; the company is the one of an active membership. */
export function auditActorOf(subject: AccessSubject): AuditActor {
	if (subject.userId === null) return { kind: 'anonymous' };
	const companyId = subject.membership?.status === 'active' ? subject.membership.companyId : undefined;
	return companyId === undefined
		? { kind: 'user', userId: subject.userId }
		: { kind: 'user', userId: subject.userId, companyId };
}

/** The session user of the subject; company actions are never taken with an API key. */
export function sessionUserId(subject: AccessSubject): string {
	if (subject.userId === null) throw new ApiError('unauthenticated');
	if (subject.via !== 'session') throw new ApiError('forbidden');
	return subject.userId;
}

/** `409 conflict` with one machine-readable detail. */
export function conflict(code: string, message: string, path?: string): ApiError {
	const detail: ErrorDetail = { ...(path === undefined ? {} : { path }), code, message };
	return new ApiError('conflict', { message, details: [detail] });
}

/** `400 validation_failed` with field details. */
export function invalid(details: ErrorDetail[]): ApiError {
	return new ApiError('validation_failed', { details });
}

/** SQLSTATE of a database error, looking through the query wrapper. */
function sqlState(error: unknown): { code: string | undefined; constraint: string | undefined } {
	let current: unknown = error;
	for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
		const fields = current as Error & { code?: unknown; constraint_name?: unknown };
		if (typeof fields.code === 'string') {
			return {
				code: fields.code,
				constraint: typeof fields.constraint_name === 'string' ? fields.constraint_name : undefined
			};
		}
		current = current.cause;
	}
	return { code: undefined, constraint: undefined };
}

/** Whether the error is a violation of the named unique constraint. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
	const state = sqlState(error);
	return state.code === '23505' && state.constraint === constraint;
}
