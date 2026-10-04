// Job `account.purge` (docs/domain.md, section 19.2): the rows of a deleted account leave PostgreSQL, its objects leave
// the bucket, its sessions and counters leave Redis. The objects go first and the rows only after every object is
// gone: a failed removal of an object fails the attempt with the rows still in place, and the next attempt finds the
// same keys again — nothing is left in the bucket without the row that names it. The rows go in one transaction, which
// checks that no new object of the person appeared meanwhile.
//
// What stays, each with its own ground and period: the journal (identifiers and codes only); disclosures and the consent
// events they refer to, until `disclosure_retention_months` (`retention.sweep`); invitations as tombstones of id,
// company and status, since disclosures refer to them; the copy of a representative's authority document until its
// own `evidence_retention_until` — the purge enqueues itself for the day after it; the account and the profile as
// tombstones without personal data; the entry of the erasure ledger, which a restore from a backup applies again.
import { and, eq, inArray, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import { clearAccountFailures } from '$lib/server/auth/lockout';
import { revokeUserSessions } from '$lib/server/auth/sessions';
import { db, type Database, type Executor, type Transaction } from '$lib/server/db';
import {
	assessmentArtifacts,
	assessmentScores,
	assessmentAttempts,
	athleteLinks,
	authorityChecks,
	candidateCompanyBlocks,
	candidates,
	categorizationRuns,
	categoryAssignments,
	categoryDisputes,
	claims,
	consentEvents,
	disclosures,
	documentAcceptances,
	documentExtractions,
	emailTokens,
	embeddings,
	erasureLedger,
	experienceEntries,
	externalIdentities,
	externalProfiles,
	files,
	fspLevelAssignments,
	hiringProcesses,
	hiringReports,
	invitationResponses,
	invitations,
	invitationTerms,
	legalRepresentatives,
	matchScores,
	mlResults,
	notificationChannels,
	notificationDeliveries,
	notificationPreferences,
	notifications,
	passwordCredentials,
	representations,
	resumeDocuments,
	skillInferences,
	sourceFacts,
	telegramLinkTokens,
	users,
	verificationReceipts
} from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler } from '$lib/server/jobs/handler';
import { enqueueJob } from '$lib/server/jobs/queue';
import { redis, type Redis } from '$lib/server/redis';
import { objectStore, StorageError, type ObjectStore } from '$lib/server/storage/object-store';
import { cancelJobsOfPerson, personIds, type PersonIds } from './rows';

export interface AccountPurgeDeps {
	db: Database;
	redis: Redis;
	store: ObjectStore;
}

export interface AccountPurgeSummary {
	rowsRemoved: number;
	filesRemoved: number;
	/** Facts removed, by source. */
	facts: Record<string, number>;
	/** The day after which the kept authority evidence goes; `null` — nothing is kept. */
	evidenceKeptUntil: string | null;
}

const utcDate = (at: Date) => at.toISOString().slice(0, 10);

const nextDay = (date: string) => {
	const day = new Date(`${date}T00:00:00Z`);
	day.setUTCDate(day.getUTCDate() + 1);
	return day;
};

/** Authority checks whose copy of the document is still inside its own retention period on `today` (domain 6.4). */
function evidenceInRetention(today: string): SQL {
	return sql`${authorityChecks.evidenceRetentionUntil} is not null and ${authorityChecks.evidenceRetentionUntil} >= ${today}`;
}

interface FileRow {
	id: string;
	storageKey: string;
}

/**
 * The files of the person the purge removes: those the account uploaded, the resumes, the attempt artifacts and the
 * authority documents of the profile — except the evidence of a company's verification (the company's own, with its
 * retention) and an authority document inside its retention period.
 */
async function erasableFiles(executor: Executor, ids: PersonIds, today: string): Promise<FileRow[]> {
	const referenced: SQL[] = [
		sql`${files.ownerUserId} = ${ids.userId} and ${files.purpose} <> 'company_authority_evidence'`
	];
	if (ids.resumeIds.length > 0) {
		referenced.push(
			inArray(
				files.id,
				executor
					.select({ id: resumeDocuments.fileId })
					.from(resumeDocuments)
					.where(inArray(resumeDocuments.id, ids.resumeIds))
			)
		);
	}
	if (ids.artifactIds.length > 0) {
		referenced.push(
			inArray(
				files.id,
				executor
					.select({ id: sql<string>`${assessmentArtifacts.fileId}` })
					.from(assessmentArtifacts)
					.where(and(inArray(assessmentArtifacts.id, ids.artifactIds), sql`${assessmentArtifacts.fileId} is not null`))
			)
		);
	}
	if (ids.representationIds.length > 0) {
		referenced.push(
			inArray(
				files.id,
				executor
					.select({ id: sql<string>`${authorityChecks.evidenceFileId}` })
					.from(authorityChecks)
					.where(
						and(
							inArray(authorityChecks.representationId, ids.representationIds),
							sql`${authorityChecks.evidenceFileId} is not null`
						)
					)
			)
		);
	}
	const keptEvidence =
		ids.representationIds.length === 0
			? sql`false`
			: inArray(
					files.id,
					executor
						.select({ id: sql<string>`${authorityChecks.evidenceFileId}` })
						.from(authorityChecks)
						.where(
							and(
								inArray(authorityChecks.representationId, ids.representationIds),
								sql`${authorityChecks.evidenceFileId} is not null`,
								evidenceInRetention(today)
							)
						)
				);
	return executor
		.select({ id: files.id, storageKey: files.storageKey })
		.from(files)
		.where(and(or(...referenced), sql`not (${keptEvidence})`));
}

/** Deletes from an append-only table: only the retention role may, and only by identifiers (migration 0002). */
async function asRetentionRole<T>(tx: Transaction, work: () => Promise<T>): Promise<T> {
	await tx.execute(sql`set local role fsp_retention`);
	const result = await work();
	await tx.execute(sql`reset role`);
	return result;
}

class Removal {
	rows = 0;
	add(removed: readonly unknown[]): void {
		this.rows += removed.length;
	}
}

/** Everything the account itself holds: sign-in, notifications and channels, identities, personal agreements. */
async function eraseAccountRows(tx: Transaction, ids: PersonIds, removal: Removal): Promise<void> {
	const { userId } = ids;
	removal.add(
		await tx.delete(notifications).where(eq(notifications.userId, userId)).returning({ id: notifications.id })
	);
	const channels = await tx
		.select({ id: notificationChannels.id })
		.from(notificationChannels)
		.where(eq(notificationChannels.userId, userId));
	if (channels.length > 0) {
		removal.add(
			await tx
				.delete(notificationDeliveries)
				.where(
					inArray(
						notificationDeliveries.channelId,
						channels.map((c) => c.id)
					)
				)
				.returning({ id: notificationDeliveries.id })
		);
	}
	removal.add(
		await tx
			.delete(notificationChannels)
			.where(eq(notificationChannels.userId, userId))
			.returning({ id: notificationChannels.id })
	);
	removal.add(
		await tx
			.delete(notificationPreferences)
			.where(eq(notificationPreferences.userId, userId))
			.returning({ category: notificationPreferences.category })
	);
	removal.add(
		await tx
			.delete(telegramLinkTokens)
			.where(eq(telegramLinkTokens.userId, userId))
			.returning({ userId: telegramLinkTokens.userId })
	);
	removal.add(await tx.delete(emailTokens).where(eq(emailTokens.userId, userId)).returning({ id: emailTokens.id }));
	removal.add(
		await tx
			.delete(passwordCredentials)
			.where(eq(passwordCredentials.userId, userId))
			.returning({ userId: passwordCredentials.userId })
	);
	removal.add(await tx.delete(athleteLinks).where(eq(athleteLinks.userId, userId)).returning({ id: athleteLinks.id }));
	removal.add(
		await tx
			.delete(externalIdentities)
			.where(eq(externalIdentities.userId, userId))
			.returning({ id: externalIdentities.id })
	);
	// Agreements accepted on behalf of a company stay with the company; the person's own go.
	const personal = await tx
		.select({ id: documentAcceptances.id })
		.from(documentAcceptances)
		.where(and(eq(documentAcceptances.userId, userId), isNull(documentAcceptances.companyId)));
	if (personal.length > 0) {
		removal.add(
			await asRetentionRole(tx, () =>
				tx
					.delete(documentAcceptances)
					.where(
						inArray(
							documentAcceptances.id,
							personal.map((row) => row.id)
						)
					)
					.returning({ id: documentAcceptances.id })
			)
		);
	}
}

/** The evidence layers, the category, the vectors and the matches of the profile, with the model results behind them. */
async function eraseEvidence(
	tx: Transaction,
	candidateId: string,
	ids: PersonIds,
	removal: Removal
): Promise<Record<string, number>> {
	const facts = await tx
		.select({ id: sourceFacts.id, source: sourceFacts.source })
		.from(sourceFacts)
		.where(eq(sourceFacts.candidateId, candidateId));
	const factIds = facts.map((fact) => fact.id);
	if (factIds.length > 0) {
		removal.add(
			await tx
				.delete(verificationReceipts)
				.where(inArray(verificationReceipts.factId, factIds))
				.returning({ id: verificationReceipts.id })
		);
	}
	removal.add(await tx.delete(claims).where(eq(claims.candidateId, candidateId)).returning({ id: claims.id }));
	removal.add(
		await tx
			.delete(experienceEntries)
			.where(eq(experienceEntries.candidateId, candidateId))
			.returning({ id: experienceEntries.id })
	);
	const inputs: SQL[] = [
		sql`(${mlResults.inputRef} ->> 'type' = 'candidate' and ${mlResults.inputRef} ->> 'id' = ${candidateId})`
	];
	if (ids.extractionIds.length > 0) {
		inputs.push(
			sql`(${mlResults.inputRef} ->> 'type' = 'document_extraction' and ${inArray(sql`${mlResults.inputRef} ->> 'id'`, ids.extractionIds)})`
		);
	}
	removal.add(
		await tx
			.delete(mlResults)
			.where(or(...inputs))
			.returning({ id: mlResults.id })
	);
	removal.add(
		await tx.delete(matchScores).where(eq(matchScores.candidateId, candidateId)).returning({ id: matchScores.id })
	);
	removal.add(
		await tx
			.delete(skillInferences)
			.where(eq(skillInferences.candidateId, candidateId))
			.returning({ id: skillInferences.id })
	);
	removal.add(
		await tx
			.delete(categoryDisputes)
			.where(eq(categoryDisputes.candidateId, candidateId))
			.returning({ id: categoryDisputes.id })
	);
	const runs = tx
		.select({ id: categorizationRuns.id })
		.from(categorizationRuns)
		.where(eq(categorizationRuns.candidateId, candidateId));
	removal.add(
		await tx
			.delete(categoryAssignments)
			.where(inArray(categoryAssignments.runId, runs))
			.returning({ runId: categoryAssignments.runId })
	);
	removal.add(
		await tx
			.delete(fspLevelAssignments)
			.where(inArray(fspLevelAssignments.runId, runs))
			.returning({ runId: fspLevelAssignments.runId })
	);
	removal.add(
		await tx
			.delete(categorizationRuns)
			.where(eq(categorizationRuns.candidateId, candidateId))
			.returning({ id: categorizationRuns.id })
	);
	removal.add(
		await tx
			.delete(embeddings)
			.where(and(eq(embeddings.ownerType, 'candidate_section'), eq(embeddings.ownerId, candidateId)))
			.returning({ id: embeddings.id })
	);
	removal.add(
		await tx.delete(sourceFacts).where(eq(sourceFacts.candidateId, candidateId)).returning({ id: sourceFacts.id })
	);
	if (ids.resumeIds.length > 0) {
		removal.add(
			await tx
				.delete(documentExtractions)
				.where(inArray(documentExtractions.resumeDocumentId, ids.resumeIds))
				.returning({ id: documentExtractions.id })
		);
	}
	removal.add(
		await tx
			.delete(resumeDocuments)
			.where(eq(resumeDocuments.candidateId, candidateId))
			.returning({ id: resumeDocuments.id })
	);
	if (ids.attemptIds.length > 0) {
		const attempts = ids.attemptIds;
		removal.add(
			await asRetentionRole(tx, async () => [
				...(await tx
					.delete(assessmentArtifacts)
					.where(inArray(assessmentArtifacts.attemptId, attempts))
					.returning({ id: assessmentArtifacts.id })),
				...(await tx
					.delete(assessmentScores)
					.where(inArray(assessmentScores.attemptId, attempts))
					.returning({ id: assessmentScores.id }))
			])
		);
		removal.add(
			await tx
				.delete(assessmentAttempts)
				.where(inArray(assessmentAttempts.id, attempts))
				.returning({ id: assessmentAttempts.id })
		);
	}
	removal.add(
		await tx
			.delete(externalProfiles)
			.where(eq(externalProfiles.candidateId, candidateId))
			.returning({ id: externalProfiles.id })
	);
	removal.add(
		await tx
			.delete(candidateCompanyBlocks)
			.where(eq(candidateCompanyBlocks.candidateId, candidateId))
			.returning({ companyId: candidateCompanyBlocks.companyId })
	);
	const bySource: Record<string, number> = {};
	for (const fact of facts) bySource[fact.source] = (bySource[fact.source] ?? 0) + 1;
	return bySource;
}

/**
 * Invitations become tombstones of id, company and status (disclosures refer to them); their terms, the answers and
 * the hiring processes with the reports of both sides go.
 */
async function eraseInvitations(tx: Transaction, candidateId: string, ids: PersonIds, at: Date, removal: Removal) {
	if (ids.processIds.length > 0) {
		const processes = ids.processIds;
		removal.add(
			await asRetentionRole(tx, () =>
				tx.delete(hiringReports).where(inArray(hiringReports.processId, processes)).returning({ id: hiringReports.id })
			)
		);
		removal.add(
			await tx
				.delete(hiringProcesses)
				.where(inArray(hiringProcesses.id, processes))
				.returning({ id: hiringProcesses.id })
		);
	}
	if (ids.invitationIds.length === 0) return;
	const invited = ids.invitationIds;
	removal.add(
		await tx
			.delete(invitationResponses)
			.where(inArray(invitationResponses.invitationId, invited))
			.returning({ id: invitationResponses.id })
	);
	await tx
		.update(invitations)
		.set({ currentTermsId: null, acceptedTermsId: null, purgedAt: at })
		.where(and(eq(invitations.candidateId, candidateId), inArray(invitations.id, invited)));
	const terms = await tx
		.select({ id: invitationTerms.id })
		.from(invitationTerms)
		.where(inArray(invitationTerms.invitationId, invited));
	if (terms.length > 0) {
		removal.add(
			await asRetentionRole(tx, () =>
				tx
					.delete(invitationTerms)
					.where(
						inArray(
							invitationTerms.id,
							terms.map((row) => row.id)
						)
					)
					.returning({ id: invitationTerms.id })
			)
		);
	}
}

/**
 * Consents go except the events a disclosure refers to; representations go with their links and the representative's
 * data unless an authority document inside its retention period or a kept consent event still refers to them.
 * Returns the last day of retention of the kept authority evidence, if any.
 */
async function eraseConsents(
	tx: Transaction,
	candidateId: string,
	ids: PersonIds,
	today: string,
	removal: Removal
): Promise<string | null> {
	const proving = tx
		.select({ id: disclosures.consentEventId })
		.from(disclosures)
		.where(eq(disclosures.candidateId, candidateId));
	const erasable = await tx
		.select({ id: consentEvents.id })
		.from(consentEvents)
		.where(and(eq(consentEvents.subjectCandidateId, candidateId), notInArray(consentEvents.id, proving)));
	if (erasable.length > 0) {
		removal.add(
			await asRetentionRole(tx, () =>
				tx
					.delete(consentEvents)
					.where(
						inArray(
							consentEvents.id,
							erasable.map((row) => row.id)
						)
					)
					.returning({ id: consentEvents.id })
			)
		);
	}
	if (ids.representationIds.length === 0) return null;
	const represented = ids.representationIds;
	removal.add(
		await tx.delete(emailTokens).where(inArray(emailTokens.targetRef, represented)).returning({ id: emailTokens.id })
	);
	removal.add(
		await tx
			.delete(authorityChecks)
			.where(and(inArray(authorityChecks.representationId, represented), sql`not (${evidenceInRetention(today)})`))
			.returning({ id: authorityChecks.id })
	);
	const people = await tx
		.selectDistinct({ id: representations.representativeId })
		.from(representations)
		.where(inArray(representations.id, represented));
	removal.add(
		await tx
			.delete(representations)
			.where(
				and(
					inArray(representations.id, represented),
					notInArray(
						representations.id,
						tx
							.select({ id: authorityChecks.representationId })
							.from(authorityChecks)
							.where(inArray(authorityChecks.representationId, represented))
					),
					notInArray(
						representations.id,
						tx
							.select({ id: sql<string>`${consentEvents.representationId}` })
							.from(consentEvents)
							.where(
								and(
									eq(consentEvents.subjectCandidateId, candidateId),
									sql`${consentEvents.representationId} is not null`
								)
							)
					)
				)
			)
			.returning({ id: representations.id })
	);
	if (people.length > 0) {
		removal.add(
			await tx
				.delete(legalRepresentatives)
				.where(
					and(
						inArray(
							legalRepresentatives.id,
							people.map((row) => row.id)
						),
						notInArray(
							legalRepresentatives.id,
							tx.select({ id: representations.representativeId }).from(representations)
						)
					)
				)
				.returning({ id: legalRepresentatives.id })
		);
	}
	const [kept] = await tx
		.select({ until: sql<string | null>`max(${authorityChecks.evidenceRetentionUntil})::text` })
		.from(authorityChecks)
		.where(and(inArray(authorityChecks.representationId, represented), evidenceInRetention(today)));
	return kept?.until ?? null;
}

/** The profile keeps its id and status only: disclosures and the journal refer to it (domain 3.1, 19.2). */
async function tombstoneProfile(tx: Transaction, candidateId: string): Promise<void> {
	await tx
		.update(candidates)
		.set({
			status: 'deleted',
			lastNameEnc: null,
			firstNameEnc: null,
			middleNameEnc: null,
			phoneEnc: null,
			birthDate: null,
			birthDatePrecision: null,
			birthDateSource: null,
			birthDateStatus: 'unknown',
			birthDateVerifiedBy: null,
			birthDateVerifiedAt: null,
			eligibleFrom: null,
			visibility: 'hidden',
			headline: null,
			desiredRoleKeys: [],
			preferences: {},
			purgeAfter: null
		})
		.where(eq(candidates.id, candidateId));
}

/** The rows of the account in the transaction of the job; `deletedKeys` are the objects already removed. */
async function eraseAccount(
	tx: Transaction,
	input: { userId: string; deletedKeys: ReadonlySet<string>; at: Date; requestId: string }
): Promise<AccountPurgeSummary> {
	const { userId, at } = input;
	const today = utcDate(at);
	const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId)).for('update');
	if (user?.status !== 'deletion_pending' && user?.status !== 'deleted') {
		throw new JobFailure('not_requested', 'the account is not being deleted', { retryable: false });
	}
	const ids = await personIds(tx, userId);
	const pending = await erasableFiles(tx, ids, today);
	const appeared = pending.filter((file) => !input.deletedKeys.has(file.storageKey));
	if (appeared.length > 0) {
		// A file of the person appeared after the objects were removed: the next attempt removes its object first.
		throw new JobFailure('objects_appeared', `${appeared.length} objects of the account appeared during the purge`, {
			retryable: true
		});
	}
	await cancelJobsOfPerson(tx, ids);
	const removal = new Removal();
	await eraseAccountRows(tx, ids, removal);
	let facts: Record<string, number> = {};
	let evidenceKeptUntil: string | null = null;
	const { candidateId } = ids;
	if (candidateId !== null) {
		facts = await eraseEvidence(tx, candidateId, ids, removal);
		await eraseInvitations(tx, candidateId, ids, at, removal);
		evidenceKeptUntil = await eraseConsents(tx, candidateId, ids, today, removal);
	}
	if (pending.length > 0) {
		removal.add(
			await tx
				.delete(files)
				.where(
					inArray(
						files.id,
						pending.map((file) => file.id)
					)
				)
				.returning({ id: files.id })
		);
	}
	if (candidateId !== null) await tombstoneProfile(tx, candidateId);
	await tx
		.update(users)
		.set({
			status: 'deleted',
			emailEnc: null,
			emailHmac: null,
			emailVerifiedAt: null,
			displayName: null,
			lockedUntil: null,
			lastLoginAt: null,
			deletionRequestedAt: null,
			deletedAt: at
		})
		.where(and(eq(users.id, userId), ne(users.status, 'deleted')));
	await tx
		.insert(erasureLedger)
		.values({ userId, requestedAt: at, purgedAt: at })
		.onConflictDoUpdate({ target: erasureLedger.userId, set: { purgedAt: at } });
	const journal = {
		outcome: 'success' as const,
		actor: { kind: 'system' as const },
		...(candidateId === null ? {} : { subjectCandidateId: candidateId }),
		requestId: input.requestId,
		occurredAt: at
	};
	for (const [source, count] of Object.entries(facts)) {
		await recordAuditEvent(tx, { ...journal, action: 'facts.purged', details: { count, source } });
	}
	await recordAuditEvent(tx, {
		...journal,
		action: 'account.purged',
		object: { type: 'user', id: userId },
		details: {
			rows_removed: removal.rows,
			files_removed: pending.length,
			evidence_kept_until: evidenceKeptUntil
		}
	});
	if (evidenceKeptUntil !== null) {
		await enqueueJob(
			tx,
			'account.purge',
			{ user_id: userId },
			{
				inputVersion: `${userId}:${evidenceKeptUntil}`,
				createdBy: { kind: 'system', id: 'evidence_retention' },
				runAfter: nextDay(evidenceKeptUntil)
			}
		);
	}
	return { rowsRemoved: removal.rows, filesRemoved: pending.length, facts, evidenceKeptUntil };
}

/**
 * Everything of the purge outside PostgreSQL, before the rows: the objects of the account, then its sessions and
 * counters. Returns the keys of the removed objects; `null` — there is no account (the removal of a demo session took the
 * clone with all its rows).
 */
async function releaseOutside(deps: AccountPurgeDeps, userId: string, at: Date): Promise<string[] | null> {
	const [user] = await deps.db
		.select({ status: users.status, emailHmac: users.emailHmac })
		.from(users)
		.where(eq(users.id, userId));
	if (!user) return null;
	if (user.status !== 'deletion_pending' && user.status !== 'deleted') {
		throw new JobFailure('not_requested', 'the account is not being deleted', { retryable: false });
	}
	const keys = await deps.db.transaction(async (tx) =>
		(await erasableFiles(tx, await personIds(tx, userId), utcDate(at))).map((file) => file.storageKey)
	);
	for (const key of keys) {
		try {
			await deps.store.delete(key);
		} catch (error) {
			if (!(error instanceof StorageError)) throw error;
			throw new JobFailure('storage_unavailable', 'an object of the account could not be removed', {
				retryable: error.retryable
			});
		}
	}
	await revokeUserSessions(deps.redis, userId);
	if (user.emailHmac !== null) await clearAccountFailures(deps.redis, user.emailHmac);
	return keys;
}

export function createAccountPurgeHandler(deps: () => Promise<AccountPurgeDeps>): JobHandler<'account.purge'> {
	return defineHandler({
		type: 'account.purge',
		concurrency: 1,
		run: async ({ job, requestId }) => {
			const userId = job.payload.user_id;
			const at = new Date();
			const keys = await releaseOutside(await deps(), userId, at);
			if (keys === null) return { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };
			let summary: AccountPurgeSummary | undefined;
			return {
				// The purge reads the rows inside its write transaction under the account lock: there is no stale input.
				isCurrent: () => Promise.resolve(true),
				write: async (tx) => {
					summary = await eraseAccount(tx, { userId, deletedKeys: new Set(keys), at, requestId });
				},
				describe: () => ({
					rows_removed: summary?.rowsRemoved,
					files_removed: summary?.filesRemoved,
					evidence_kept_until: summary?.evidenceKeptUntil
				})
			};
		}
	});
}

/**
 * The purge of `account.purge` at once, outside the job queue: the objects, the sessions and the rows of an account whose
 * deletion is requested or done — the replay of the erasure ledger after a restore (replay/ledger.ts) waits for it.
 * `null` — there is no account.
 */
export async function purgeAccountNow(
	deps: AccountPurgeDeps,
	userId: string,
	requestId: string
): Promise<AccountPurgeSummary | null> {
	const at = new Date();
	const keys = await releaseOutside(deps, userId, at);
	if (keys === null) return null;
	return deps.db.transaction((tx) => eraseAccount(tx, { userId, deletedKeys: new Set(keys), at, requestId }));
}

/** Handler of `account.purge` for the job registry. */
export const accountPurge = createAccountPurgeHandler(async () => ({
	db: db(),
	redis: await redis(),
	store: objectStore()
}));
