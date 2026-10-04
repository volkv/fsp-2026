// Deleting an account (docs/domain.md, sections 3.1, 3.4, 5.3, 7.1, 19.1): a fresh authentication, then in one
// transaction `deletion_pending` for the account and its profile — the profile leaves every search, count and
// recalculation at once, the processing consent of a candidate is revoked (for a candidate the deletion and the
// revocation of `pd_processing` are one act, domain 19.1), unanswered invitations are withdrawn, the representation of
// a minor ends, the team memberships end with their API keys, waiting jobs are cancelled — and `account.purge` is
// enqueued. The last active owner of a company and an account with a staff role in force are refused with the reason.
// Sessions are revoked after the commit; the request itself already denies them, since authentication reads the
// status of the account on every request.
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import type { AuthDeps } from '$lib/server/auth/context';
import { isFreshAuth, revokeUserSessions, type SessionRef } from '$lib/server/auth/sessions';
import { endMembershipsOfDeletedAccount } from '$lib/server/companies/members';
import type { Transaction } from '$lib/server/db';
import {
	candidates,
	consentEvents,
	emailTokens,
	erasureLedger,
	matchScores,
	representations,
	staffRoles,
	users,
	vacancies
} from '$lib/server/db/schema';
import { withdrawOpenInvitations } from '$lib/server/invitations/send';
import { enqueueJob } from '$lib/server/jobs/queue';
import { accountDeletionLetter } from '$lib/server/notifications/account';
import { cancelJobsOfPerson, personIds } from './rows';

/**
 * Why the deletion begins: the person deleted the account, the candidate revoked the processing consent (the same act
 * for a candidate, recorded as the one it was), the profile stood inactive past `inactive_candidate_purge_days`, or a
 * restore from a backup brought back an account the erasure ledger names as deleted (replay/ledger.ts).
 */
export type DeletionCause = 'account_deleted' | 'processing_revoked' | 'inactive' | 'ledger_replay';

/** The person's own act; the other causes are the system's. */
const byThePerson = (cause: DeletionCause) => cause === 'account_deleted' || cause === 'processing_revoked';

export type DeletionRefusal =
	| { reason: 'already_requested' }
	/** Staff roles are taken away by an administrator first (domain 4.1). */
	| { reason: 'staff_role' }
	/** The company must keep an active owner (domain 5.3). */
	| { reason: 'last_owner'; companyName: string };

export interface DeletionStart {
	userId: string;
	cause: DeletionCause;
	actor: AuditActor;
	requestId: string;
	ip?: string | null;
	userAgent?: string | null;
	/** SHA-256 of the session the person acted in: evidence of the revocation (domain 6.3). */
	sessionHash?: string | null;
	/** The person's own words about the revocation, if any. */
	reason?: string | null;
	at: Date;
}

const utcDate = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The processing consent stops at once (domain 19.1): the person's own deletion revokes it with the person as the
 * signer; a deletion for inactivity or by the replay of the ledger is not the person's act at that moment, so the
 * consent lapses by the system.
 */
async function endProcessingConsent(tx: Transaction, candidateId: string, start: DeletionStart): Promise<void> {
	const [last] = await tx
		.select({ action: consentEvents.action, documentId: consentEvents.documentId })
		.from(consentEvents)
		.where(and(eq(consentEvents.subjectCandidateId, candidateId), eq(consentEvents.kind, 'pd_processing')))
		.orderBy(desc(consentEvents.occurredAt), desc(consentEvents.id))
		.limit(1);
	if (last?.action !== 'grant') return;
	const byPerson = byThePerson(start.cause);
	const [event] = await tx
		.insert(consentEvents)
		.values({
			subjectCandidateId: candidateId,
			kind: 'pd_processing',
			documentId: last.documentId,
			action: byPerson ? 'revoke' : 'lapse',
			signerKind: byPerson ? 'subject' : 'system',
			signerUserId: byPerson ? start.userId : null,
			method: byPerson ? 'separate_screen_button' : 'system',
			evidence: byPerson
				? { ip: start.ip ?? null, user_agent: start.userAgent ?? null, session_hash: start.sessionHash ?? null }
				: { cause: start.cause },
			reason: byPerson ? (start.reason?.trim() ? start.reason.trim() : null) : start.cause,
			occurredAt: start.at
		})
		.returning({ id: consentEvents.id });
	if (!event) throw new Error('consent event was not inserted');
	await recordAuditEvent(tx, {
		action: byPerson ? 'consent.revoked' : 'consent.lapsed',
		outcome: 'success',
		actor: start.actor,
		object: { type: 'consent_event', id: event.id },
		subjectCandidateId: candidateId,
		requestId: start.requestId,
		ip: start.ip ?? null,
		userAgent: start.userAgent ?? null,
		details: { kind: 'pd_processing', cause: start.cause },
		occurredAt: start.at
	});
}

/** The representation of a minor ends with the profile; the unused links of the representative stop working. */
async function endRepresentations(tx: Transaction, candidateId: string, start: DeletionStart): Promise<void> {
	const ended = await tx
		.update(representations)
		.set({ status: 'ended', endedAt: start.at, endReason: 'candidate_deleted' })
		.where(and(eq(representations.candidateId, candidateId), ne(representations.status, 'ended')))
		.returning({ id: representations.id });
	for (const representation of ended) {
		await tx.delete(emailTokens).where(and(eq(emailTokens.targetRef, representation.id), isNull(emailTokens.usedAt)));
		await recordAuditEvent(tx, {
			action: 'representation.ended',
			outcome: 'success',
			actor: start.actor,
			object: { type: 'representation', id: representation.id },
			subjectCandidateId: candidateId,
			requestId: start.requestId,
			details: { end_reason: 'candidate_deleted' },
			occurredAt: start.at
		});
	}
}

/** The pools of the vacancies the candidate counted in are counted again without them (domain 13.3). */
async function recountPools(tx: Transaction, candidateId: string): Promise<void> {
	const rows = await tx
		.selectDistinct({ id: vacancies.id, revision: vacancies.revision })
		.from(matchScores)
		.innerJoin(vacancies, eq(vacancies.id, matchScores.vacancyId))
		.where(eq(matchScores.candidateId, candidateId));
	for (const vacancy of rows) {
		await enqueueJob(
			tx,
			'match.refresh',
			{ scope: 'vacancy', vacancy_id: vacancy.id },
			{ inputVersion: String(vacancy.revision), createdBy: { kind: 'system', id: 'account_deletion' } }
		);
	}
}

/**
 * Begins the deletion in the caller's transaction; `null` — begun, and `account.purge` is enqueued. Nothing changes
 * when it is refused.
 */
export async function beginAccountDeletion(tx: Transaction, start: DeletionStart): Promise<DeletionRefusal | null> {
	const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, start.userId)).for('update');
	if (!user) throw new Error(`user ${start.userId} does not exist`);
	if (user.status === 'deletion_pending' || user.status === 'deleted') return { reason: 'already_requested' };
	const [staff] = await tx
		.select({ id: staffRoles.id })
		.from(staffRoles)
		.where(and(eq(staffRoles.userId, start.userId), isNull(staffRoles.revokedAt)))
		.limit(1);
	if (staff) return { reason: 'staff_role' };
	const lastOwner = await endMembershipsOfDeletedAccount(tx, start.userId, {
		requestId: start.requestId,
		at: start.at
	});
	if (lastOwner) return { reason: 'last_owner', companyName: lastOwner.companyName };

	const ids = await personIds(tx, start.userId);
	const candidateId = ids.candidateId;
	if (candidateId !== null) {
		const [profile] = await tx
			.select({ status: candidates.status })
			.from(candidates)
			.where(eq(candidates.id, candidateId));
		if (profile && profile.status !== 'deleted') {
			await endProcessingConsent(tx, candidateId, start);
			await tx
				.update(candidates)
				.set({ status: 'deletion_pending', visibility: 'hidden', purgeAfter: utcDate(start.at) })
				.where(eq(candidates.id, candidateId));
			await withdrawOpenInvitations(tx, { candidateId }, 'account_deleted', {
				requestId: start.requestId,
				at: start.at
			});
			await endRepresentations(tx, candidateId, start);
			await recountPools(tx, candidateId);
		}
	}
	const cancelled = await cancelJobsOfPerson(tx, ids);
	await tx
		.update(users)
		.set({ status: 'deletion_pending', deletionRequestedAt: start.at })
		.where(eq(users.id, start.userId));
	await tx
		.insert(erasureLedger)
		.values({ userId: start.userId, requestedAt: start.at })
		.onConflictDoUpdate({ target: erasureLedger.userId, set: { requestedAt: start.at, purgedAt: null } });
	await recordAuditEvent(tx, {
		action: 'account.deletion_requested',
		outcome: 'success',
		actor: start.actor,
		object: { type: 'user', id: start.userId },
		...(candidateId === null ? {} : { subjectCandidateId: candidateId }),
		requestId: start.requestId,
		ip: start.ip ?? null,
		userAgent: start.userAgent ?? null,
		details: { cause: start.cause, jobs_cancelled: cancelled },
		occurredAt: start.at
	});
	await enqueueJob(
		tx,
		'account.purge',
		{ user_id: start.userId },
		{ inputVersion: start.userId, createdBy: { kind: 'system', id: start.cause }, runAfter: start.at }
	);
	return null;
}

export type DeletionResult =
	{ ok: true; letterSent: boolean } | { ok: false; refusal: DeletionRefusal | { reason: 'stale_auth' } };

/**
 * The signed-in person deletes the account, or a candidate revokes the processing consent (`processing_revoked`):
 * sensitive, so the authentication must be fresh (domain 3.4). After the commit every session of the account is
 * revoked and the confirmation letter leaves.
 */
export async function requestAccountDeletion(
	deps: AuthDeps,
	meta: { requestId: string; ip: string | null; userAgent: string | null },
	session: SessionRef,
	input: { cause: Exclude<DeletionCause, 'inactive' | 'ledger_replay'>; reason?: string | null }
): Promise<DeletionResult> {
	const at = deps.now();
	if (!isFreshAuth(session.authTime, at)) return { ok: false, refusal: { reason: 'stale_auth' } };
	const outcome = await deps.db.transaction(async (tx) => {
		const [account] = await tx.select({ emailEnc: users.emailEnc }).from(users).where(eq(users.id, session.userId));
		const refusal = await beginAccountDeletion(tx, {
			userId: session.userId,
			cause: input.cause,
			actor: { kind: 'user', userId: session.userId },
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			sessionHash: session.hash,
			reason: input.reason ?? null,
			at
		});
		if (refusal) return { begun: false, refusal } as const;
		const [profile] = await tx
			.select({ id: candidates.id })
			.from(candidates)
			.where(and(eq(candidates.userId, session.userId), sql`${candidates.status} = 'deletion_pending'`));
		return { begun: true, emailEnc: account?.emailEnc ?? null, candidate: profile !== undefined } as const;
	});
	if (!outcome.begun) return { ok: false, refusal: outcome.refusal };
	await revokeUserSessions(deps.redis, session.userId);
	if (outcome.emailEnc === null) return { ok: true, letterSent: false };
	const sent = await deps.mailer.send(
		accountDeletionLetter(deps.crypto.decrypt(outcome.emailEnc, 'users.email'), { candidate: outcome.candidate })
	);
	return { ok: true, letterSent: sent.ok };
}
