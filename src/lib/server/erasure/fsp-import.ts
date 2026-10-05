// Revocation of `fsp_import` (docs/domain.md, sections 6.3, 17.3, 19.1). In the transaction of the revocation the
// imports stop — the athlete links end and their waiting `fsp.sync` jobs are cancelled, a running one is refused by its
// write check — and every fact the revoked grants brought leaves the profile as `withdrawn` with its claims, so their
// receipts answer `not_valid`; the evidence floor rises, the published evidence run is blocked and the recalculations
// are enqueued — the category, confirmed by a test, stays (domain 12.4). `consent.revocation_cleanup` then removes
// physically what the revoked grants brought: the facts with their payload, claims and receipts, and the derivatives
// computed from them — vectors, matches, model results and evidence runs of revisions below the evidence floor that
// nothing else refers to. The unlinking of FSP ID
// (`$lib/server/auth/identities`) ends its athlete links and withdraws every fact imported through them — superseded
// and annulled versions too — with the same `retireFacts` and `recordEvidenceChange`, and enqueues the same cleanup for
// each ended link.
import { and, eq, inArray, lt, lte, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import type { Database, Transaction } from '$lib/server/db';
import {
	athleteLinks,
	candidates,
	claims,
	consentEvents,
	embeddings,
	evidenceRuns,
	experienceEntries,
	fspLevelAssignments,
	matchScores,
	mlResults,
	skillInferences,
	sourceFacts,
	verificationReceipts
} from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { cancelWaitingJobs, enqueueJob, type JobCreator } from '$lib/server/jobs/queue';
import { recordEvidenceChange, retireFacts } from '$lib/server/resumes/revision';

export interface FspImportRevocation {
	candidateId: string;
	userId: string;
	/** The `revoke` event just recorded. */
	revocationId: string;
	at: Date;
	actor: AuditActor;
	requestId: string;
	createdBy: JobCreator;
}

/** The grants of `fsp_import` a revocation at `at` ends: every grant of the candidate up to it. */
function revokedGrants(tx: Transaction, candidateId: string, at: Date) {
	return tx
		.select({ id: consentEvents.id })
		.from(consentEvents)
		.where(
			and(
				eq(consentEvents.subjectCandidateId, candidateId),
				eq(consentEvents.kind, 'fsp_import'),
				eq(consentEvents.action, 'grant'),
				lte(consentEvents.occurredAt, at)
			)
		);
}

/**
 * The immediate part of the revocation, in its transaction. Returns how many facts left the profile. A later grant
 * links the athlete anew and imports again: the withdrawn facts do not come back.
 */
export async function withdrawFspImport(tx: Transaction, revocation: FspImportRevocation): Promise<number> {
	const { candidateId, userId, at } = revocation;
	const links = await tx
		.update(athleteLinks)
		.set({ status: 'unlinked', unlinkedAt: at })
		.where(and(eq(athleteLinks.userId, userId), eq(athleteLinks.status, 'active')))
		.returning({ id: athleteLinks.id });
	for (const link of links) await cancelWaitingJobs(tx, 'fsp.sync', { athlete_link_id: link.id });

	const factIds = await retireFacts(
		tx,
		[
			eq(sourceFacts.candidateId, candidateId),
			eq(sourceFacts.source, 'fsp'),
			inArray(sourceFacts.consentEventId, revokedGrants(tx, candidateId, at)),
			ne(sourceFacts.status, 'withdrawn')
		],
		'withdrawn',
		'consent_revoked'
	);
	// The revocation takes a ground away even when nothing was imported yet: a running import ends stale.
	await recordEvidenceChange(tx, {
		candidateId,
		withdrawal: true,
		reason: 'fsp_import_revoked',
		requestId: revocation.requestId,
		actor: revocation.actor,
		createdBy: revocation.createdBy
	});
	await enqueueJob(
		tx,
		'consent.revocation_cleanup',
		{ consent_event_id: revocation.revocationId },
		{ inputVersion: revocation.revocationId, createdBy: revocation.createdBy }
	);
	return factIds.length;
}

interface CleanupSummary {
	facts: number;
	receipts: number;
	claims: number;
	derived: number;
}

/**
 * Physical removal of withdrawn FSP facts — those of the grants a revocation ended, or those imported through an
 * unlinked athlete link — with their receipts, claims and experience entries, and the candidate's derivatives below the
 * evidence floor. The journal gets `facts.purged` with the number of facts and the source, without their content.
 */
async function cleanUpFspFacts(
	tx: Transaction,
	withdrawal: { candidateId: string; facts: SQL; cause: { type: 'consent_event' | 'athlete_link'; id: string } },
	requestId: string
): Promise<CleanupSummary> {
	const { candidateId } = withdrawal;
	const [candidate] = await tx
		.select({ floor: candidates.evidenceFloorRevision })
		.from(candidates)
		.where(eq(candidates.id, candidateId))
		.for('update');
	if (!candidate) return { facts: 0, receipts: 0, claims: 0, derived: 0 };
	const facts = await tx
		.select({ id: sourceFacts.id })
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.candidateId, candidateId),
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.status, 'withdrawn'),
				withdrawal.facts
			)
		);
	const factIds = facts.map((fact) => fact.id);
	let receipts = 0;
	let claimCount = 0;
	if (factIds.length > 0) {
		receipts = (
			await tx
				.delete(verificationReceipts)
				.where(inArray(verificationReceipts.factId, factIds))
				.returning({ id: verificationReceipts.id })
		).length;
		claimCount = (await tx.delete(claims).where(inArray(claims.factId, factIds)).returning({ id: claims.id })).length;
		await tx.delete(experienceEntries).where(inArray(experienceEntries.factId, factIds));
		await tx.delete(sourceFacts).where(inArray(sourceFacts.id, factIds));
	}

	// Derivatives of the revisions below the floor were computed from the withdrawn facts and are never used again.
	const floor = candidate.floor;
	let derived = 0;
	derived += (
		await tx
			.delete(embeddings)
			.where(
				and(
					eq(embeddings.ownerType, 'candidate_section'),
					eq(embeddings.ownerId, candidateId),
					sql`${embeddings.inputVersion}::bigint < ${floor}`
				)
			)
			.returning({ id: embeddings.id })
	).length;
	derived += (
		await tx
			.delete(mlResults)
			.where(
				and(
					sql`${mlResults.inputRef} ->> 'type' = 'candidate'`,
					sql`${mlResults.inputRef} ->> 'id' = ${candidateId}`,
					sql`(${mlResults.inputRef} ->> 'revision')::bigint < ${floor}`
				)
			)
			.returning({ id: mlResults.id })
	).length;
	derived += (
		await tx
			.delete(matchScores)
			.where(and(eq(matchScores.candidateId, candidateId), lt(matchScores.candidateRevision, floor)))
			.returning({ id: matchScores.id })
	).length;
	// Runs of those revisions go unless a kept match refers to them.
	const runs = await tx
		.select({ id: evidenceRuns.id })
		.from(evidenceRuns)
		.where(
			and(
				eq(evidenceRuns.candidateId, candidateId),
				ne(evidenceRuns.status, 'published'),
				lt(evidenceRuns.inputRevision, floor),
				notInArray(
					evidenceRuns.id,
					tx
						.select({ id: sql<string>`${matchScores.evidenceRunId}` })
						.from(matchScores)
						.where(and(eq(matchScores.candidateId, candidateId), sql`${matchScores.evidenceRunId} is not null`))
				)
			)
		);
	const runIds = runs.map((run) => run.id);
	if (runIds.length > 0) {
		await tx.delete(skillInferences).where(inArray(skillInferences.runId, runIds));
		await tx.delete(fspLevelAssignments).where(inArray(fspLevelAssignments.runId, runIds));
		derived += (
			await tx.delete(evidenceRuns).where(inArray(evidenceRuns.id, runIds)).returning({ id: evidenceRuns.id })
		).length;
	}
	await recordAuditEvent(tx, {
		action: 'facts.purged',
		outcome: 'success',
		actor: { kind: 'system' },
		object: withdrawal.cause,
		subjectCandidateId: candidateId,
		requestId,
		details: { count: factIds.length, source: 'fsp', receipts, derived }
	});
	return { facts: factIds.length, receipts, claims: claimCount, derived };
}

const describeCleanup = (summary: CleanupSummary | undefined) => ({
	facts: summary?.facts,
	receipts: summary?.receipts,
	claims: summary?.claims,
	derived: summary?.derived
});

/** The cleanup after an unlinked FSP ID: the facts imported through the ended link (domain 19.1). */
async function linkCleanup(db: Database, linkId: string, requestId: string): Promise<JobResult> {
	const [link] = await db
		.select({ candidateId: candidates.id, status: athleteLinks.status })
		.from(athleteLinks)
		.innerJoin(candidates, eq(candidates.userId, athleteLinks.userId))
		.where(eq(athleteLinks.id, linkId));
	// The account was purged meanwhile: the purge removed everything this job would.
	if (!link) return { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };
	if (link.status !== 'unlinked') {
		throw new JobFailure('link_active', 'the athlete link of the cleanup is still active', { retryable: false });
	}
	let summary: CleanupSummary | undefined;
	return {
		isCurrent: () => Promise.resolve(true),
		write: async (tx) => {
			summary = await cleanUpFspFacts(
				tx,
				{
					candidateId: link.candidateId,
					facts: sql`${sourceFacts.ownershipBasis} = 'athlete_link' and ${sourceFacts.ownershipRef} = ${linkId}`,
					cause: { type: 'athlete_link', id: linkId }
				},
				requestId
			);
		},
		describe: () => describeCleanup(summary)
	};
}

/** Enqueues the cleanup after an unlinked FSP ID, in the transaction of the unlinking. */
export async function enqueueUnlinkCleanup(tx: Transaction, linkId: string, createdBy: JobCreator): Promise<void> {
	await enqueueJob(tx, 'consent.revocation_cleanup', { athlete_link_id: linkId }, { inputVersion: linkId, createdBy });
}

/** Job `consent.revocation_cleanup`: after a revoked `fsp_import` or an unlinked FSP ID. */
export const consentRevocationCleanup: JobHandler<'consent.revocation_cleanup'> = defineHandler({
	type: 'consent.revocation_cleanup',
	concurrency: 2,
	run: async ({ job, db, requestId }) => {
		const payload = job.payload;
		if ('athlete_link_id' in payload) return linkCleanup(db, payload.athlete_link_id, requestId);
		const [event] = await db
			.select({
				id: consentEvents.id,
				kind: consentEvents.kind,
				action: consentEvents.action,
				candidateId: consentEvents.subjectCandidateId,
				at: consentEvents.occurredAt
			})
			.from(consentEvents)
			.where(eq(consentEvents.id, payload.consent_event_id));
		// The account was purged meanwhile, and the revocation with it: the purge removed everything this job would.
		if (!event) return { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };
		if (event.kind !== 'fsp_import' || event.action !== 'revoke') {
			throw new JobFailure('unsupported_revocation', `no cleanup for ${event.action} of ${event.kind}`, {
				retryable: false
			});
		}
		let summary: CleanupSummary | undefined;
		return {
			isCurrent: () => Promise.resolve(true),
			write: async (tx) => {
				summary = await cleanUpFspFacts(
					tx,
					{
						candidateId: event.candidateId,
						facts: inArray(sourceFacts.consentEventId, revokedGrants(tx, event.candidateId, event.at)),
						cause: { type: 'consent_event', id: event.id }
					},
					requestId
				);
			},
			describe: () => describeCleanup(summary)
		};
	}
});
