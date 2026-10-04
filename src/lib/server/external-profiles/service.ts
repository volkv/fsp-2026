// The candidate links a public profile of Codeforces or GitHub (docs/domain.md, section 9.4). Ownership is proven
// without an OAuth application: the platform gives a one-time code with a deadline, the candidate puts it where only
// the account's owner can — a name or organization field of Codeforces, a public gist or the profile README of GitHub
// — and the server finds it through the public API. A verified profile is read at once and then daily; its facts
// carry `public_verifiable`. Unlinking withdraws them. Every step is in the journal; a source that does not answer is
// a stated status, never a substitute answer.
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import { requireProcessingConsent } from '$lib/server/consent/processing';
import type { Executor, Transaction } from '$lib/server/db';
import { candidates, externalProfiles, users } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { LOCK_NAMESPACE } from '$lib/server/jobs/scheduler';
import { lockCandidate } from '$lib/server/resumes/revision';
import { selfCandidate } from '$lib/server/resumes/deps';
import { codeforcesHasCode, codeforcesReading, codeforcesUser, type CodeforcesUser } from './codeforces';
import type { ExternalProfileDeps } from './deps';
import { applyReading, type EvidenceContext, type FactChange, type ProfileReading } from './facts';
import { githubHasCode, githubReading, githubUser, githubUserById, type GithubUser } from './github';
import { challengeCode, parseHandle } from './handles';
import { SourceUnavailable, type SourceFailure } from './http';
import {
	CHALLENGE_TTL_MS,
	MANUAL_REFRESH_INTERVAL_MS,
	MAX_CHALLENGE_ATTEMPTS,
	PLATFORM_NAMES,
	type ExternalPlatform
} from './types';

type ProfileRow = typeof externalProfiles.$inferSelect;

type Account = { platform: 'codeforces'; user: CodeforcesUser } | { platform: 'github'; user: GithubUser };

/** Second key of the advisory lock of a handle among the locks of the scheduler namespace. */
const handleLockKey = (platform: ExternalPlatform, handle: string) =>
	`external_profile:${platform}:${handle.toLowerCase()}`;

// --- Reading the source ----------------------------------------------------------------------------------------------

/** The account under the handle as the platform names it now, if the code stands in it. */
async function checkOwnership(
	deps: ExternalProfileDeps,
	platform: ExternalPlatform,
	handle: string,
	code: string
): Promise<{ kind: 'confirmed'; account: Account } | { kind: 'handle_not_found' } | { kind: 'code_not_found' }> {
	if (platform === 'codeforces') {
		const user = await codeforcesUser(deps.codeforces, handle, { historic: false });
		if (user === null) return { kind: 'handle_not_found' };
		if (!codeforcesHasCode(user, code)) return { kind: 'code_not_found' };
		return { kind: 'confirmed', account: { platform, user } };
	}
	const user = await githubUser(deps.github, handle);
	if (user === null) return { kind: 'handle_not_found' };
	if (!(await githubHasCode(deps.github, user.login, code))) return { kind: 'code_not_found' };
	return { kind: 'confirmed', account: { platform, user } };
}

/** The account of a verified profile: Codeforces by its handle, including a changed one, GitHub by its stable id. */
async function locateAccount(deps: ExternalProfileDeps, profile: ProfileRow): Promise<Account | null> {
	if (profile.platform === 'codeforces') {
		const user = await codeforcesUser(deps.codeforces, profile.handle, { historic: true });
		return user === null ? null : { platform: 'codeforces', user };
	}
	const user =
		profile.externalId === null
			? await githubUser(deps.github, profile.handle)
			: await githubUserById(deps.github, profile.externalId);
	return user === null ? null : { platform: 'github', user };
}

/** The public data of an account. `null` — the account disappeared while it was read. */
async function readAccount(deps: ExternalProfileDeps, account: Account): Promise<ProfileReading | null> {
	if (account.platform === 'codeforces') {
		const reading = await codeforcesReading(deps.codeforces, account.user);
		return reading === null ? null : { platform: 'codeforces', reading };
	}
	return { platform: 'github', reading: await githubReading(deps.github, account.user) };
}

const handleOf = (account: Account) => (account.platform === 'codeforces' ? account.user.handle : account.user.login);
const externalIdOf = (account: Account) => (account.platform === 'github' ? String(account.user.id) : null);

// --- Guards ------------------------------------------------------------------------------------------------------------

/**
 * Whether another candidate holds the account verified. Accounts of demo sessions and of the demo seed do not count:
 * they are not people of the stand, and a real person's profile must not be taken by a demonstration.
 */
async function takenByAnother(
	executor: Executor,
	candidateId: string,
	platform: ExternalPlatform,
	handle: string,
	externalId: string | null
): Promise<boolean> {
	const same = sql`lower(${externalProfiles.handle}) = ${handle.toLowerCase()}`;
	const [row] = await executor
		.select({ id: externalProfiles.id })
		.from(externalProfiles)
		.innerJoin(candidates, eq(candidates.id, externalProfiles.candidateId))
		.innerJoin(users, eq(users.id, candidates.userId))
		.where(
			and(
				eq(externalProfiles.platform, platform),
				eq(externalProfiles.ownershipStatus, 'verified'),
				ne(externalProfiles.candidateId, candidateId),
				externalId === null ? same : or(same, eq(externalProfiles.externalId, externalId)),
				isNull(users.demoSessionId),
				isNull(users.seedBatchId)
			)
		)
		.limit(1);
	return row !== undefined;
}

const HANDLE_TAKEN_MESSAGE = 'Этот профиль уже подтверждён другим пользователем платформы';

async function ownProfile(executor: Executor, candidateId: string, profileId: string): Promise<ProfileRow> {
	const [row] = await executor
		.select()
		.from(externalProfiles)
		.where(and(eq(externalProfiles.id, profileId), eq(externalProfiles.candidateId, candidateId)));
	if (!row) throw new ApiError('not_found');
	return row;
}

async function lockOwnProfile(tx: Transaction, candidateId: string, profileId: string): Promise<ProfileRow | null> {
	if (!(await lockCandidate(tx, candidateId))) throw new ApiError('not_found');
	const [row] = await tx
		.select()
		.from(externalProfiles)
		.where(and(eq(externalProfiles.id, profileId), eq(externalProfiles.candidateId, candidateId)))
		.for('update');
	return row ?? null;
}

// --- Link: a one-time code ---------------------------------------------------------------------------------------------

export interface LinkRequest {
	platform: ExternalPlatform;
	handle: string;
}

/**
 * Starts linking a profile: remembers the handle and gives a one-time code with a deadline. A profile already verified
 * on the platform is unlinked first; an unverified one takes the new handle and a new code.
 */
export async function startLink(
	deps: ExternalProfileDeps,
	subject: AccessSubject,
	request: LinkRequest,
	meta: RequestMeta
): Promise<{ profileId: string; code: string; expiresAt: Date }> {
	const { candidateId } = selfCandidate(subject);
	const handle = parseHandle(request.platform, request.handle);
	if (handle === null) {
		throw new ApiError('validation_failed', {
			details: [
				{
					path: 'handle',
					code: 'invalid_handle',
					message:
						request.platform === 'codeforces'
							? 'Хэндл Codeforces — 3–24 латинские буквы, цифры, «_», «.» или «-», или ссылка на профиль'
							: 'Логин GitHub — до 39 латинских букв, цифр и дефисов, или ссылка на профиль'
				}
			]
		});
	}
	const now = deps.now();
	await requireProcessingConsent(deps.db, candidateId, now);
	if (await takenByAnother(deps.db, candidateId, request.platform, handle, null)) {
		throw new ApiError('conflict', {
			message: HANDLE_TAKEN_MESSAGE,
			details: [{ path: 'handle', code: 'handle_taken', message: HANDLE_TAKEN_MESSAGE }]
		});
	}
	const code = challengeCode();
	const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
	const profileId = await deps.db.transaction(async (tx) => {
		if (!(await lockCandidate(tx, candidateId))) throw new ApiError('not_found');
		const [existing] = await tx
			.select({ id: externalProfiles.id, status: externalProfiles.ownershipStatus })
			.from(externalProfiles)
			.where(and(eq(externalProfiles.candidateId, candidateId), eq(externalProfiles.platform, request.platform)))
			.for('update');
		if (existing?.status === 'verified') {
			throw new ApiError('conflict', {
				message: `Профиль ${PLATFORM_NAMES[request.platform]} уже привязан: отвяжи его, чтобы привязать другой`
			});
		}
		const challenge = {
			handle,
			externalId: null,
			challengeCode: code,
			challengeExpiresAt: expiresAt,
			challengeAttempts: 0
		};
		let id: string;
		if (existing) {
			await tx.update(externalProfiles).set(challenge).where(eq(externalProfiles.id, existing.id));
			id = existing.id;
		} else {
			const [row] = await tx
				.insert(externalProfiles)
				.values({ candidateId, platform: request.platform, ownershipStatus: 'unverified', ...challenge })
				.returning({ id: externalProfiles.id });
			if (!row) throw new Error('external profile was not inserted');
			id = row.id;
		}
		await recordAuditEvent(tx, {
			action: 'external_profile.challenge_issued',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'external_profile', id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { platform: request.platform }
		});
		return id;
	});
	return { profileId, code, expiresAt };
}

// --- Confirm: the code in the profile ----------------------------------------------------------------------------------

export type ConfirmOutcome =
	| { kind: 'verified'; sync: 'ok' | 'source_unavailable' | 'not_found'; reason: SourceFailure | null }
	| { kind: 'code_not_found' }
	| { kind: 'handle_not_found' }
	| { kind: 'handle_taken' }
	| { kind: 'expired' }
	| { kind: 'attempts_exhausted' }
	| { kind: 'source_unavailable'; reason: SourceFailure };

/** The code may be checked: it exists, has not expired and has checks left; one check is spent atomically. */
async function spendAttempt(deps: ExternalProfileDeps, profile: ProfileRow, now: Date): Promise<ConfirmOutcome | null> {
	if (profile.challengeCode === null || profile.challengeExpiresAt === null) return { kind: 'expired' };
	if (profile.challengeExpiresAt <= now) return { kind: 'expired' };
	const [spent] = await deps.db
		.update(externalProfiles)
		.set({ challengeAttempts: sql`${externalProfiles.challengeAttempts} + 1` })
		.where(
			and(
				eq(externalProfiles.id, profile.id),
				eq(externalProfiles.challengeCode, profile.challengeCode),
				sql`${externalProfiles.challengeAttempts} < ${MAX_CHALLENGE_ATTEMPTS}`
			)
		)
		.returning({ id: externalProfiles.id });
	return spent ? null : { kind: 'attempts_exhausted' };
}

/**
 * Looks for the code in the profile. Found — the profile becomes verified, the code is spent, the public data is read
 * and becomes a fact of the profile; the reading failing does not undo the proven ownership, it is its status.
 */
export async function confirmLink(
	deps: ExternalProfileDeps,
	subject: AccessSubject,
	profileId: string,
	meta: RequestMeta
): Promise<ConfirmOutcome> {
	const { candidateId, userId } = selfCandidate(subject);
	const now = deps.now();
	await requireProcessingConsent(deps.db, candidateId, now);
	const profile = await ownProfile(deps.db, candidateId, profileId);
	if (profile.ownershipStatus === 'verified') {
		throw new ApiError('conflict', { message: 'Профиль уже подтверждён' });
	}
	const actor = auditActor(subject, meta, 'candidate');
	const journal = async (executor: Executor, outcome: ConfirmOutcome) => {
		await recordAuditEvent(executor, {
			action: outcome.kind === 'verified' ? 'external_profile.verified' : 'external_profile.verification_failed',
			outcome: outcome.kind === 'verified' ? 'success' : outcome.kind === 'handle_taken' ? 'denied' : 'failure',
			actor,
			object: { type: 'external_profile', id: profile.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: {
				platform: profile.platform,
				result: outcome.kind === 'verified' ? outcome.sync : outcome.kind,
				...(outcome.kind === 'source_unavailable' || outcome.kind === 'verified' ? { reason: outcome.reason } : {})
			}
		});
	};

	const refused = await spendAttempt(deps, profile, now);
	if (refused) {
		await journal(deps.db, refused);
		return refused;
	}
	const code = profile.challengeCode;
	if (code === null) throw new Error('a checked challenge has a code');

	let account: Account;
	try {
		const ownership = await checkOwnership(deps, profile.platform, profile.handle, code);
		if (ownership.kind !== 'confirmed') {
			await journal(deps.db, ownership);
			return ownership;
		}
		account = ownership.account;
	} catch (cause) {
		if (!(cause instanceof SourceUnavailable)) throw cause;
		const outcome: ConfirmOutcome = { kind: 'source_unavailable', reason: cause.reason };
		await journal(deps.db, outcome);
		return outcome;
	}

	let reading: ProfileReading | null = null;
	let failure: SourceFailure | null = null;
	try {
		reading = await readAccount(deps, account);
	} catch (cause) {
		if (!(cause instanceof SourceUnavailable)) throw cause;
		failure = cause.reason;
	}

	const handle = handleOf(account);
	const externalId = externalIdOf(account);
	return deps.db.transaction(async (tx) => {
		const locked = await lockOwnProfile(tx, candidateId, profileId);
		// Relinked or unlinked while the source was read: this code no longer stands for the profile.
		if (locked?.ownershipStatus !== 'unverified' || locked.challengeCode !== code) {
			throw new ApiError('conflict');
		}
		await tx.execute(
			sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${handleLockKey(profile.platform, handle)}))`
		);
		if (await takenByAnother(tx, candidateId, profile.platform, handle, externalId)) {
			const outcome: ConfirmOutcome = { kind: 'handle_taken' };
			await journal(tx, outcome);
			return outcome;
		}
		const sync = failure !== null ? 'source_unavailable' : reading === null ? 'not_found' : 'ok';
		await tx
			.update(externalProfiles)
			.set({
				handle,
				externalId,
				ownershipStatus: 'verified',
				ownershipMethod: 'handle_challenge',
				verifiedAt: now,
				challengeCode: null,
				challengeExpiresAt: null,
				syncStatus: sync,
				syncError: failure,
				syncCheckedAt: now,
				syncedAt: failure === null ? now : null
			})
			.where(eq(externalProfiles.id, profileId));
		if (failure === null) {
			await applyReading(
				tx,
				{
					candidateId,
					profileId,
					platform: profile.platform,
					reading,
					withdrawReason: 'source_profile_not_found',
					now
				},
				{ actor, requestId: meta.requestId, createdBy: { kind: 'user', id: userId }, signer: deps.signer }
			);
		}
		const outcome: ConfirmOutcome = { kind: 'verified', sync, reason: failure };
		await journal(tx, outcome);
		return outcome;
	});
}

// --- Refresh: a new reading of a verified profile ----------------------------------------------------------------------

export type RefreshOutcome =
	| { kind: 'synced'; change: FactChange; sync: 'ok' | 'not_found' }
	| { kind: 'source_unavailable'; reason: SourceFailure; retryAfterSeconds: number | undefined }
	| { kind: 'stale' };

/** What a reading found, ready to be written: the account (or its absence) and the data. */
export interface PreparedReading {
	profile: ProfileRow;
	account: Account | null;
	reading: ProfileReading | null;
}

/**
 * Reads the source for a verified profile outside any transaction. A source that does not answer is recorded on the
 * profile at once — its status and the reason — and returned; the facts stay as they were.
 */
export async function readProfile(
	deps: ExternalProfileDeps,
	profileId: string,
	context: EvidenceContext
): Promise<PreparedReading | Extract<RefreshOutcome, { kind: 'source_unavailable' | 'stale' }>> {
	const [profile] = await deps.db.select().from(externalProfiles).where(eq(externalProfiles.id, profileId));
	if (profile?.ownershipStatus !== 'verified') return { kind: 'stale' };
	const now = deps.now();
	await deps.db.update(externalProfiles).set({ syncCheckedAt: now }).where(eq(externalProfiles.id, profileId));
	try {
		const account = await locateAccount(deps, profile);
		const reading = account === null ? null : await readAccount(deps, account);
		return { profile, account: reading === null ? null : account, reading };
	} catch (cause) {
		if (!(cause instanceof SourceUnavailable)) throw cause;
		await deps.db.transaction(async (tx) => {
			await tx
				.update(externalProfiles)
				.set({ syncStatus: 'source_unavailable', syncError: cause.reason })
				.where(and(eq(externalProfiles.id, profileId), eq(externalProfiles.ownershipStatus, 'verified')));
			await recordAuditEvent(tx, {
				action: 'external_profile.sync_failed',
				outcome: 'failure',
				actor: context.actor,
				object: { type: 'external_profile', id: profileId },
				subjectCandidateId: profile.candidateId,
				requestId: context.requestId,
				details: { platform: profile.platform, reason: cause.reason }
			});
		});
		return { kind: 'source_unavailable', reason: cause.reason, retryAfterSeconds: cause.retryAfterSeconds };
	}
}

/** Whether the profile a reading was made for is still the same verified profile (the candidate row locked). */
export async function readingIsCurrent(tx: Transaction, prepared: PreparedReading): Promise<boolean> {
	const locked = await lockOwnProfile(tx, prepared.profile.candidateId, prepared.profile.id);
	return (
		locked !== null &&
		locked.ownershipStatus === 'verified' &&
		locked.handle === prepared.profile.handle &&
		locked.verifiedAt?.getTime() === prepared.profile.verifiedAt?.getTime()
	);
}

/** Writes a reading in the caller's transaction, after `readingIsCurrent`. */
export async function writeReading(
	tx: Transaction,
	prepared: PreparedReading,
	now: Date,
	context: EvidenceContext
): Promise<Extract<RefreshOutcome, { kind: 'synced' }>> {
	const { profile, account, reading } = prepared;
	const change = await applyReading(
		tx,
		{
			candidateId: profile.candidateId,
			profileId: profile.id,
			platform: profile.platform,
			reading,
			withdrawReason: 'source_profile_not_found',
			now
		},
		context
	);
	const sync = reading === null ? 'not_found' : 'ok';
	await tx
		.update(externalProfiles)
		.set({
			// A renamed account keeps being the same profile under its new name.
			...(account === null ? {} : { handle: handleOf(account) }),
			syncStatus: sync,
			syncError: null,
			syncedAt: now
		})
		.where(eq(externalProfiles.id, profile.id));
	await recordAuditEvent(tx, {
		action: 'external_profile.synced',
		outcome: 'success',
		actor: context.actor,
		object: { type: 'external_profile', id: profile.id },
		subjectCandidateId: profile.candidateId,
		requestId: context.requestId,
		details: {
			platform: profile.platform,
			result: sync,
			inserted: change.inserted,
			superseded: change.superseded,
			withdrawn: change.withdrawn
		}
	});
	return { kind: 'synced', change, sync };
}

/** The candidate asks to read a verified profile again now; at most once in `MANUAL_REFRESH_INTERVAL_MS`. */
export async function refreshOwnProfile(
	deps: ExternalProfileDeps,
	subject: AccessSubject,
	profileId: string,
	meta: RequestMeta
): Promise<RefreshOutcome> {
	const { candidateId, userId } = selfCandidate(subject);
	const now = deps.now();
	await requireProcessingConsent(deps.db, candidateId, now);
	const profile = await ownProfile(deps.db, candidateId, profileId);
	if (profile.ownershipStatus !== 'verified') throw new ApiError('conflict', { message: 'Профиль ещё не подтверждён' });
	const last = profile.syncCheckedAt?.getTime();
	if (last !== undefined && now.getTime() - last < MANUAL_REFRESH_INTERVAL_MS) {
		const seconds = Math.ceil((last + MANUAL_REFRESH_INTERVAL_MS - now.getTime()) / 1000);
		throw new ApiError('rate_limited', {
			message: `Профиль сверялся только что: повтори через ${Math.ceil(seconds / 60)} мин.`,
			retryAfterSeconds: seconds
		});
	}
	const context: EvidenceContext = {
		actor: auditActor(subject, meta, 'candidate'),
		requestId: meta.requestId,
		createdBy: { kind: 'user', id: userId },
		signer: deps.signer
	};
	const prepared = await readProfile(deps, profileId, context);
	if ('kind' in prepared) return prepared;
	return deps.db.transaction(async (tx) => {
		if (!(await readingIsCurrent(tx, prepared))) return { kind: 'stale' } as const;
		return writeReading(tx, prepared, now, context);
	});
}

// --- Unlink ------------------------------------------------------------------------------------------------------------

/**
 * Unlinks a profile: the row with the handle is removed, the facts it brought are withdrawn and, if they counted, the
 * profile revision and the evidence floor move and the category is recalculated.
 */
export async function unlinkProfile(
	deps: ExternalProfileDeps,
	subject: AccessSubject,
	profileId: string,
	meta: RequestMeta
): Promise<{ withdrawn: number }> {
	const { candidateId, userId } = selfCandidate(subject);
	const actor: AuditActor = auditActor(subject, meta, 'candidate');
	return deps.db.transaction(async (tx) => {
		const profile = await lockOwnProfile(tx, candidateId, profileId);
		if (!profile) throw new ApiError('not_found');
		const change = await applyReading(
			tx,
			{
				candidateId,
				profileId,
				platform: profile.platform,
				reading: null,
				withdrawReason: 'profile_unlinked',
				now: deps.now()
			},
			{ actor, requestId: meta.requestId, createdBy: { kind: 'user', id: userId }, signer: deps.signer }
		);
		await tx.delete(externalProfiles).where(eq(externalProfiles.id, profileId));
		await recordAuditEvent(tx, {
			action: 'external_profile.unlinked',
			outcome: 'success',
			actor,
			object: { type: 'external_profile', id: profileId },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: {
				platform: profile.platform,
				was_verified: profile.ownershipStatus === 'verified',
				withdrawn: change.withdrawn
			}
		});
		return { withdrawn: change.withdrawn };
	});
}
