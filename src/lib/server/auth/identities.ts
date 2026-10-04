// FSP ID as a sign-in method (docs/contracts.md, sections 2.3–2.5): sign-in by an identity `(issuer, subject)`, linking
// from a signed-in account only, unlinking with the fate of imported achievements, and the separate athlete link that
// starts the achievements import under the `fsp_import` consent. An address in the token never links accounts. An
// account of the demo seed or a clone of the cast in a demo session is never reached through FSP ID (docs/domain.md,
// section 19.3): the originals of the cast are the template every demo session copies and a visitor enters the scenario
// at `/demo`. On a demonstration stand an athlete without an account of the seed signs in within the visitor's demo
// session: the identity, the account and everything they make belong to that session, so another visitor signing in as
// the same athlete gets an account of their own in their own session, and both go with their sessions. An account a
// visitor registered by password within their session links FSP ID within that session the same way: the identity is
// taken or free there, whatever other sessions and the accounts outside sessions hold.
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Transaction } from '$lib/server/db';
import { enqueueUnlinkCleanup } from '$lib/server/erasure/fsp-import';
import {
	athleteLinks,
	candidates,
	consentEvents,
	externalIdentities,
	passwordCredentials,
	sourceFacts,
	users
} from '$lib/server/db/schema';
import { cancelWaitingJobs, enqueueJob } from '$lib/server/jobs/queue';
import { recordEvidenceChange, retireFacts } from '$lib/server/resumes/revision';
import type { AuthDeps, RequestMeta } from './context';
import { stillCurrent } from './documents';
import { holdPendingSignup } from './fsp-signup';
import type { FspIdAuthorization } from './oidc';
import { accountAddress, emailInUse } from './registration';
import { createSession, destroySession, isFreshAuth, type SessionRef } from './sessions';

const MAY_SIGN_IN = ['active', 'pending_email'] as const;

/** Why the visitor's demo session could not be had (`demo/visit.ts`). */
export type DemoSessionRefusal = 'address_budget' | 'stand_full' | 'not_seeded';

/**
 * On a demonstration stand: the demo session of the visitor, opened for them when the browser has none. Called only
 * when the identity has no account outside sessions, so a sign-in to such an account opens no session.
 */
export type VisitorDemoSession = () => Promise<
	{ ok: true; sessionId: string } | { ok: false; reason: DemoSessionRefusal }
>;

export type FspSignInOutcome =
	| { kind: 'signed_in'; userId: string; sessionId: string; returnTo: string }
	/** No account has this identity: the registration form continues with the held provider result. */
	| { kind: 'signup'; pendingToken: string; emailConflict: boolean }
	| { kind: 'linked'; returnTo: string }
	| {
			kind: 'refused';
			reason:
				| 'identity_already_linked'
				| 'issuer_already_linked'
				| 'session_mismatch'
				| 'account_inactive'
				| 'demo_account'
				| DemoSessionRefusal;
	  };

function audit(meta: RequestMeta) {
	return { requestId: meta.requestId, ip: meta.ip, userAgent: meta.userAgent };
}

interface IdentityOwner {
	identityId: string;
	userId: string;
	status: string;
	/** The account was seeded, or cloned from a seeded one: an original or a clone of the cast, or the background. */
	seeded: boolean;
}

/** The account of the identity outside demo sessions (`demoSessionId` `null`) or within the demo session. */
async function identityOwner(
	deps: AuthDeps,
	identity: { issuer: string; subject: string },
	demoSessionId: string | null
): Promise<IdentityOwner | null> {
	const [row] = await deps.db
		.select({
			identityId: externalIdentities.id,
			userId: users.id,
			status: users.status,
			seedBatchId: users.seedBatchId
		})
		.from(externalIdentities)
		.innerJoin(users, eq(users.id, externalIdentities.userId))
		.where(
			and(
				eq(externalIdentities.issuer, identity.issuer),
				eq(externalIdentities.subject, identity.subject),
				demoSessionId === null
					? isNull(externalIdentities.demoSessionId)
					: eq(externalIdentities.demoSessionId, demoSessionId)
			)
		);
	if (!row) return null;
	return { identityId: row.identityId, userId: row.userId, status: row.status, seeded: row.seedBatchId !== null };
}

/**
 * Acts on a completed FSP ID authorization: sign-in, registration or linking (contracts 2.3, 2.4). `demoSession` —
 * on a demonstration stand only: an identity without an account outside sessions signs in within the visitor's demo
 * session (docs/domain.md, 19.3).
 */
export async function completeFspSignIn(
	deps: AuthDeps,
	meta: RequestMeta,
	authorization: FspIdAuthorization,
	current: SessionRef | null,
	demoSession: VisitorDemoSession | null
): Promise<FspSignInOutcome> {
	const now = deps.now();
	const { issuer, subject } = authorization.identity;
	const outside = await identityOwner(deps, authorization.identity, null);

	if (authorization.intent === 'link') {
		// The session on return must be the one that started linking (contracts 2.4, step 3).
		if (current === null || authorization.forUserId === null || current.userId !== authorization.forUserId) {
			return { kind: 'refused', reason: 'session_mismatch' };
		}
		const userId = current.userId;
		const [account] = await deps.db
			.select({ seedBatchId: users.seedBatchId, demoSessionId: users.demoSessionId })
			.from(users)
			.where(eq(users.id, userId));
		if (!account) throw new Error(`session user ${userId} does not exist`);
		// An original or a clone of the cast, or an account of the background: never reached through FSP ID.
		if (account.seedBatchId !== null) return { kind: 'refused', reason: 'demo_account' };
		// An account registered within a demo session links the identity within that session, as the sign-in writes it.
		const place = account.demoSessionId;
		const owner = place === null ? outside : await identityOwner(deps, authorization.identity, place);
		if (owner && owner.userId !== userId) {
			await recordAuditEvent(deps.db, {
				action: 'identity.link_refused',
				outcome: 'denied',
				actor: { kind: 'user', userId },
				object: { type: 'external_identity', id: owner.identityId },
				...audit(meta),
				details: { reason: 'identity_already_linked' }
			});
			return { kind: 'refused', reason: 'identity_already_linked' };
		}
		if (owner) return { kind: 'linked', returnTo: authorization.returnTo };
		const linked = await deps.db.transaction(async (tx) => {
			const [sameIssuer] = await tx
				.select({ id: externalIdentities.id })
				.from(externalIdentities)
				.where(and(eq(externalIdentities.userId, userId), eq(externalIdentities.issuer, issuer)));
			// Replacing an FSP ID is unlinking the old one first (contracts 2.5, step 4).
			if (sameIssuer) return false;
			const [identity] = await tx
				.insert(externalIdentities)
				.values({
					userId,
					issuer,
					subject,
					linkedAt: now,
					linkMethod: 'linked_by_user',
					lastLoginAt: now,
					profileClaims: profileClaimsRecord(authorization),
					demoSessionId: place
				})
				.returning({ id: externalIdentities.id });
			if (!identity) throw new Error('external identity was not inserted');
			await recordAuditEvent(tx, {
				action: 'identity.linked',
				outcome: 'success',
				actor: { kind: 'user', userId },
				object: { type: 'external_identity', id: identity.id },
				...audit(meta),
				details: { link_method: 'linked_by_user' }
			});
			return true;
		});
		return linked
			? { kind: 'linked', returnTo: authorization.returnTo }
			: { kind: 'refused', reason: 'issuer_already_linked' };
	}

	let demoSessionId: string | null = null;
	let inSession: IdentityOwner | null = null;
	if (!outside && demoSession) {
		const visit = await demoSession();
		if (!visit.ok) return { kind: 'refused', reason: visit.reason };
		demoSessionId = visit.sessionId;
		inSession = await identityOwner(deps, authorization.identity, demoSessionId);
	}
	const owner = outside ?? inSession;

	if (!owner) {
		// Contracts 2.3, step 3: a matching address never links nor signs in; the person chooses a path.
		const email = authorization.profileClaims.email;
		const emailConflict = email !== undefined && (await emailInUse(deps, accountAddress(email, demoSessionId)));
		const pendingToken = await holdPendingSignup(deps.redis, {
			issuer,
			subject,
			authTime: authorization.authTime,
			claims: authorization.profileClaims,
			emailConflict,
			demoSessionId
		});
		return { kind: 'signup', pendingToken, emailConflict };
	}

	// An original or a clone of the cast, or an account of the background: never entered through FSP ID.
	if (owner.seeded) {
		await recordAuditEvent(deps.db, {
			action: 'auth.login',
			outcome: 'denied',
			actor: { kind: 'user', userId: owner.userId },
			object: { type: 'user', id: owner.userId },
			...audit(meta),
			details: { method: 'fsp_id', reason: 'demo_account' }
		});
		return { kind: 'refused', reason: 'demo_account' };
	}

	if (!(MAY_SIGN_IN as readonly string[]).includes(owner.status)) {
		await recordAuditEvent(deps.db, {
			action: 'auth.login',
			outcome: 'denied',
			actor: { kind: 'user', userId: owner.userId },
			object: { type: 'user', id: owner.userId },
			...audit(meta),
			details: { method: 'fsp_id', reason: 'account_inactive' }
		});
		return { kind: 'refused', reason: 'account_inactive' };
	}

	await deps.db.transaction(async (tx) => {
		await tx
			.update(externalIdentities)
			.set({ lastLoginAt: now, profileClaims: profileClaimsRecord(authorization) })
			.where(eq(externalIdentities.id, owner.identityId));
		await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, owner.userId));
		await recordAuditEvent(tx, {
			action: 'auth.login',
			outcome: 'success',
			actor: { kind: 'user', userId: owner.userId },
			object: { type: 'user', id: owner.userId },
			...audit(meta),
			details: { method: 'fsp_id' }
		});
	});
	if (current) await destroySession(deps.redis, current);
	const { sessionId } = await createSession(
		deps.redis,
		{
			userId: owner.userId,
			authMethod: 'fsp_id',
			// The session is as fresh as the authentication at the provider, not as the redirect.
			authTime: new Date(authorization.authTime * 1000),
			ip: meta.ip,
			ua: meta.userAgent
		},
		now
	);
	return { kind: 'signed_in', userId: owner.userId, sessionId, returnTo: authorization.returnTo };
}

/** Claims kept for prefilling forms only (domain 3.5); the address is not kept here. */
function profileClaimsRecord(authorization: FspIdAuthorization): Record<string, string | null> {
	const c = authorization.profileClaims;
	return {
		name: c.name ?? null,
		given_name: c.given_name ?? null,
		family_name: c.family_name ?? null,
		preferred_username: c.preferred_username ?? null
	};
}

export interface LinkedIdentity {
	id: string;
	issuer: string;
	subject: string;
	linkedAt: Date;
	linkMethod: 'signup_via_provider' | 'linked_by_user';
	athleteLink: { id: string; status: 'active' | 'unlinked' } | null;
}

/** The FSP ID of the user at `issuer`, with its active athlete link. */
export async function fspIdentityOf(deps: AuthDeps, userId: string, issuer: string): Promise<LinkedIdentity | null> {
	const [identity] = await deps.db
		.select({
			id: externalIdentities.id,
			issuer: externalIdentities.issuer,
			subject: externalIdentities.subject,
			linkedAt: externalIdentities.linkedAt,
			linkMethod: externalIdentities.linkMethod
		})
		.from(externalIdentities)
		.where(and(eq(externalIdentities.userId, userId), eq(externalIdentities.issuer, issuer)));
	if (!identity) return null;
	const [link] = await deps.db
		.select({ id: athleteLinks.id, status: athleteLinks.status })
		.from(athleteLinks)
		.where(and(eq(athleteLinks.basisIdentityId, identity.id), eq(athleteLinks.status, 'active')));
	return { ...identity, athleteLink: link ?? null };
}

export type UnlinkResult =
	{ ok: true; withdrawnFacts: number } | { ok: false; reason: 'stale_auth' | 'not_linked' | 'last_sign_in_method' };

/**
 * Unlinks the FSP ID (contracts 2.5): the identity is removed, its athlete links become `unlinked`, waiting imports are
 * cancelled, facts imported through them are withdrawn with their claims, and a published category built on them is
 * blocked until the recalculation; `consent.revocation_cleanup` of each ended link removes the withdrawn facts physically
 * (domain 19.1). A repeated link does not bring the facts back: a new import is needed.
 */
export async function unlinkFspIdentity(
	deps: AuthDeps,
	meta: RequestMeta,
	session: SessionRef,
	issuer: string
): Promise<UnlinkResult> {
	const now = deps.now();
	if (!isFreshAuth(session.authTime, now)) return { ok: false, reason: 'stale_auth' };
	const userId = session.userId;
	return deps.db.transaction(async (tx) => {
		const [identity] = await tx
			.select({ id: externalIdentities.id })
			.from(externalIdentities)
			.where(and(eq(externalIdentities.userId, userId), eq(externalIdentities.issuer, issuer)))
			.for('update');
		if (!identity) return { ok: false, reason: 'not_linked' } as const;
		const [password] = await tx
			.select({ userId: passwordCredentials.userId })
			.from(passwordCredentials)
			.where(eq(passwordCredentials.userId, userId));
		const [other] = await tx
			.select({ id: externalIdentities.id })
			.from(externalIdentities)
			.where(and(eq(externalIdentities.userId, userId), ne(externalIdentities.id, identity.id)));
		// Without a password and another identity the person would lose every way in (contracts 2.5, step 2).
		if (!password && !other) return { ok: false, reason: 'last_sign_in_method' } as const;

		// Serializes with a running import of the same candidate, which re-checks its grounds under this lock.
		const [candidate] = await tx
			.select({ id: candidates.id })
			.from(candidates)
			.where(eq(candidates.userId, userId))
			.for('update');
		const links = await tx
			.update(athleteLinks)
			.set({ status: 'unlinked', unlinkedAt: now })
			.where(and(eq(athleteLinks.basisIdentityId, identity.id), eq(athleteLinks.status, 'active')))
			.returning({ id: athleteLinks.id });
		for (const link of links) {
			await cancelWaitingJobs(tx, 'fsp.sync', { athlete_link_id: link.id });
			// The withdrawn facts are removed physically, as after a revocation of `fsp_import` (domain 19.1).
			await enqueueUnlinkCleanup(tx, link.id, { kind: 'user', id: userId });
		}
		const withdrawn =
			candidate && links.length > 0
				? await withdrawLinkedFacts(
						tx,
						meta,
						userId,
						candidate.id,
						links.map((l) => l.id)
					)
				: 0;

		await tx.delete(externalIdentities).where(eq(externalIdentities.id, identity.id));
		await recordAuditEvent(tx, {
			action: 'identity.unlinked',
			outcome: 'success',
			actor: { kind: 'user', userId },
			object: { type: 'external_identity', id: identity.id },
			...(candidate ? { subjectCandidateId: candidate.id } : {}),
			...audit(meta),
			details: { athlete_links: links.length, withdrawn_facts: withdrawn }
		});
		return { ok: true, withdrawnFacts: withdrawn } as const;
	});
}

/**
 * Every fact imported through the links leaves the profile as `withdrawn` — superseded and annulled versions too, so the
 * cleanup of the ended links removes them all with their payload — and derivatives stop counting before the
 * recalculation (17.3). A running import of the links ends stale even when nothing was imported yet.
 */
async function withdrawLinkedFacts(
	tx: Transaction,
	meta: RequestMeta,
	userId: string,
	candidateId: string,
	linkIds: readonly string[]
): Promise<number> {
	const factIds = await retireFacts(
		tx,
		[
			eq(sourceFacts.candidateId, candidateId),
			eq(sourceFacts.source, 'fsp'),
			eq(sourceFacts.ownershipBasis, 'athlete_link'),
			inArray(sourceFacts.ownershipRef, [...linkIds]),
			ne(sourceFacts.status, 'withdrawn')
		],
		'withdrawn',
		'identity_unlinked'
	);
	await recordEvidenceChange(tx, {
		candidateId,
		withdrawal: true,
		reason: 'fsp_identity_unlinked',
		requestId: meta.requestId,
		actor: { kind: 'user', userId },
		createdBy: { kind: 'user', id: userId }
	});
	return factIds.length;
}

export type AthleteLinkResult =
	| { ok: true; linkId: string; jobId: string }
	| { ok: false; reason: 'not_candidate' | 'no_identity' | 'document_changed' | 'athlete_taken' };

/**
 * «Подтвердить достижения из ФСП» (contracts 2.4, step 5): the `fsp_import` consent on its own screen, the athlete
 * link and the first `fsp.sync` — one transaction, so a link never waits without its import or its grounds.
 * In `fsp-achievements/v1` the athlete key is the FSP ID subject (contracts 1.8, `subject_equals_athlete_id`).
 */
export async function confirmFspAchievements(
	deps: AuthDeps,
	meta: RequestMeta,
	session: SessionRef,
	input: { issuer: string; documentId: string }
): Promise<AthleteLinkResult> {
	try {
		return await confirmInTransaction(deps, meta, session, input);
	} catch (error) {
		// The athlete is linked to another account: the consent given on this screen is rolled back with the rest.
		if (error instanceof AthleteTaken) return { ok: false, reason: 'athlete_taken' };
		throw error;
	}
}

class AthleteTaken extends Error {
	override name = 'AthleteTaken';
}

async function confirmInTransaction(
	deps: AuthDeps,
	meta: RequestMeta,
	session: SessionRef,
	input: { issuer: string; documentId: string }
): Promise<AthleteLinkResult> {
	const now = deps.now();
	const userId = session.userId;
	return deps.db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({ id: candidates.id, status: candidates.status })
			.from(candidates)
			.where(eq(candidates.userId, userId))
			.for('update');
		if (candidate?.status !== 'active') return { ok: false, reason: 'not_candidate' } as const;
		const [identity] = await tx
			.select({
				id: externalIdentities.id,
				subject: externalIdentities.subject,
				demoSessionId: externalIdentities.demoSessionId
			})
			.from(externalIdentities)
			.where(and(eq(externalIdentities.userId, userId), eq(externalIdentities.issuer, input.issuer)));
		if (!identity) return { ok: false, reason: 'no_identity' } as const;
		const document = await stillCurrent(tx, 'fsp_import', input.documentId, now);
		if (!document?.available) return { ok: false, reason: 'document_changed' } as const;

		const [consent] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidate.id,
				kind: 'fsp_import',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: userId,
				method: 'separate_screen_button',
				evidence: {
					ip: meta.ip,
					user_agent: meta.userAgent,
					session_hash: session.hash,
					document_sha256: document.bodySha256
				},
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!consent) throw new Error('consent event was not inserted');
		await recordAuditEvent(tx, {
			action: 'consent.granted',
			outcome: 'success',
			actor: { kind: 'user', userId },
			object: { type: 'consent_event', id: consent.id },
			subjectCandidateId: candidate.id,
			...audit(meta),
			details: { kind: 'fsp_import', document_version: document.version }
		});

		const [existing] = await tx
			.select({ id: athleteLinks.id })
			.from(athleteLinks)
			.where(and(eq(athleteLinks.basisIdentityId, identity.id), eq(athleteLinks.status, 'active')));
		let linkId = existing?.id;
		if (!linkId) {
			const [link] = await tx
				.insert(athleteLinks)
				.values({
					userId,
					source: 'fsp',
					sourceAthleteId: identity.subject,
					basisIdentityId: identity.id,
					resolutionMethod: 'subject_equals_athlete_id',
					status: 'active',
					linkedAt: now,
					// The link of an account signed up within a demo session belongs to that session.
					demoSessionId: identity.demoSessionId
				})
				// One active account per athlete outside demo sessions, and one within each demo session.
				.onConflictDoNothing(
					identity.demoSessionId === null
						? {
								target: [athleteLinks.source, athleteLinks.sourceAthleteId],
								where: sql`status = 'active' and demo_session_id is null`
							}
						: {
								target: [athleteLinks.source, athleteLinks.sourceAthleteId, athleteLinks.demoSessionId],
								where: sql`status = 'active' and demo_session_id is not null`
							}
				)
				.returning({ id: athleteLinks.id });
			if (!link) throw new AthleteTaken('the athlete has an active link to another account');
			linkId = link.id;
		}
		const job = await enqueueJob(
			tx,
			'fsp.sync',
			{ athlete_link_id: linkId },
			{ inputVersion: `${linkId}:${consent.id}`, createdBy: { kind: 'user', id: userId } }
		);
		return { ok: true, linkId, jobId: job.jobId } as const;
	});
}
