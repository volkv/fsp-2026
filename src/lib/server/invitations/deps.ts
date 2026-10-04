// Dependencies of the invitation and hiring entry points: the database, field crypto (pseudonyms and disclosed
// contacts) and the clock. Routes take the configured ones; tests pass their own.
import type { AccessSubject } from '$lib/server/access/permissions';
import type { AuditActor } from '$lib/server/audit/record';
import { fieldCrypto, type FieldCrypto } from '$lib/server/crypto/fields';
import { db, type Database } from '$lib/server/db';

export interface InvitationDeps {
	db: Database;
	crypto: FieldCrypto;
	now: () => Date;
}

export function invitationDeps(): InvitationDeps {
	return { db: db(), crypto: fieldCrypto(), now: () => new Date() };
}

/** What the request adds to the journal and to consent evidence. */
export interface RequestMeta {
	requestId: string;
	ip?: string | null;
	userAgent?: string | null;
	/** SHA-256 of the session id, recorded as consent evidence (domain 6.3). */
	sessionHash?: string | null;
	/** The key of a request authenticated by an API key. */
	apiKeyId?: string;
}

/** The journal actor of the subject; on the company side a member acts on behalf of its company. */
export function auditActor(subject: AccessSubject, meta: RequestMeta, side: 'company' | 'candidate'): AuditActor {
	if (subject.userId === null) return { kind: 'anonymous' };
	const companyId = side === 'company' ? subject.membership?.companyId : undefined;
	if (subject.via === 'api_key') {
		if (meta.apiKeyId === undefined || companyId === undefined) {
			throw new Error('a request by an API key carries the key and its company');
		}
		return { kind: 'api_key', apiKeyId: meta.apiKeyId, userId: subject.userId, companyId };
	}
	return { kind: 'user', userId: subject.userId, ...(companyId === undefined ? {} : { companyId }) };
}

/** Channel of a disclosure (`disclosures.channel`) by how the request was authenticated. */
export function channelOf(subject: AccessSubject): 'ui' | 'api' {
	return subject.via === 'api_key' ? 'api' : 'ui';
}
