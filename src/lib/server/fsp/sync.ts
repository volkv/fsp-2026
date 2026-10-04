// Job `fsp.sync` (docs/domain.md 17.2; docs/contracts.md 1.2, 1.4, 1.6): fetch the athlete's snapshot under a grant
// formed at run time, then — in the conditional write that re-checks the link and the consent — compare it with the
// current facts: new records become facts and claims, changed ones supersede their previous version, annulled and
// (only from a complete snapshot) absent ones leave the profile at once through `evidence_floor_revision`.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import { recordProfileChange } from '$lib/server/candidates/settings';
import type { Database, Transaction } from '$lib/server/db';
import { athleteLinks, candidates, claims, sourceFacts, users } from '$lib/server/db/schema';
import { recordEvidenceChange, retireFacts, type RetiredFactStatus } from '$lib/server/resumes/revision';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import type { JobCreator } from '$lib/server/jobs/queue';
import { effectiveFspImportConsent } from './consent';
import { fspIntegration, type FspIntegration } from './integration';
import {
	factClaims,
	loadProjectionTaxonomy,
	receiptEligible,
	snapshotFacts,
	snapshotSha256,
	SnapshotInconsistency,
	type FactDraft,
	type ProjectionTaxonomy
} from './projection';
import { issueSelfReceipt, type ReceiptSigner } from './receipts';

const system = { kind: 'system' } as const;

export interface FspSyncSummary {
	facts: number;
	complete: boolean;
	inserted: number;
	unchanged: number;
	superseded: number;
	annulled: number;
	withdrawn: number;
	skippedWithdrawals: number;
	claims: number;
	receipts: number;
	profileRevision: number | null;
}

export interface Grounds {
	linkId: string;
	candidateId: string;
	sourceAthleteId: string;
	consentEventId: string;
}

/** The link is active, belongs to a candidate and the candidate's `fsp_import` consent is in effect now. */
export async function currentGrounds(executor: Database | Transaction, linkId: string): Promise<Grounds | null> {
	const [row] = await executor
		.select({
			status: athleteLinks.status,
			demoSessionId: athleteLinks.demoSessionId,
			seedBatchId: users.seedBatchId,
			sourceAthleteId: athleteLinks.sourceAthleteId,
			candidateId: candidates.id
		})
		.from(athleteLinks)
		.innerJoin(candidates, eq(candidates.userId, athleteLinks.userId))
		.innerJoin(users, eq(users.id, athleteLinks.userId))
		.where(eq(athleteLinks.id, linkId));
	if (row?.status !== 'active') return null;
	// The link of a clone of the cast is active within its session only: it is never synchronized (domain 19.3). An
	// account a visitor signed up within the session imports its achievements as any other.
	if (row.demoSessionId !== null && row.seedBatchId !== null) return null;
	const consentEventId = await effectiveFspImportConsent(executor, row.candidateId, new Date());
	if (consentEventId === null) return null;
	return { linkId, candidateId: row.candidateId, sourceAthleteId: row.sourceAthleteId, consentEventId };
}

const stale: JobResult = { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };

type CurrentFact = {
	id: string;
	factType: string;
	sourceRecordRef: string;
	eventKey: string | null;
	payloadSha256: string;
	status: 'active' | 'superseded' | 'withdrawn' | 'annulled';
};

/** Retires facts of the snapshot comparison by their ids; nothing to retire is no statement. */
async function setFactStatus(
	tx: Transaction,
	ids: readonly string[],
	status: RetiredFactStatus,
	reason: string
): Promise<void> {
	if (ids.length === 0) return;
	await retireFacts(tx, [inArray(sourceFacts.id, [...ids])], status, reason);
}

/**
 * What a source stated about one linked athlete, ready to be compared with the current facts: a snapshot of the API
 * variant, or the rows of a batch (file, PDF protocol) that name the athlete (contracts 1.4, 1.7).
 */
export interface FactsUpdate {
	grounds: Grounds;
	drafts: readonly FactDraft[];
	/** Birth year the source gives for the athlete; `null` or absent — no information. */
	birthYear: number | null | undefined;
	sourceSnapshotSha256: string;
	sourceVersion: string;
	/**
	 * Which of the link's records the source speaks for, so that a record absent from it leaves: all of them for an
	 * athlete snapshot, the results of the named competitions for a batch. Only a complete source withdraws.
	 */
	coverage: { scope: 'link' } | { scope: 'competitions'; eventKeys: ReadonlySet<string> };
	complete: boolean;
	incompleteReason: string | null;
	variant: 'api' | 'file' | 'pdf-protocols';
	taxonomy: ProjectionTaxonomy;
	signer: ReceiptSigner;
	actor: AuditActor;
	requestId: string;
	createdBy: JobCreator;
}

/**
 * Birth year from FSP: fills an empty date with year precision; a disagreeing self-declared date becomes a conflict.
 * Returns whether the date or its status changed.
 */
async function applyBirthYear(tx: Transaction, context: FactsUpdate): Promise<boolean> {
	const birthYear = context.birthYear;
	if (birthYear == null) return false;
	const { candidateId } = context.grounds;
	const [candidate] = await tx
		.select({
			status: candidates.status,
			birthDate: candidates.birthDate,
			source: candidates.birthDateSource,
			birthStatus: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!candidate || candidate.status === 'ineligible_age') return false;
	const date = `${String(birthYear).padStart(4, '0')}-01-01`;
	if (candidate.birthDate === null) {
		await tx
			.update(candidates)
			.set({
				birthDate: date,
				birthDatePrecision: 'year',
				birthDateSource: 'fsp_import',
				birthDateStatus: 'unverified'
			})
			.where(eq(candidates.id, candidateId));
		return true;
	}
	if (Number(candidate.birthDate.slice(0, 4)) === birthYear) return false;
	if (candidate.source === 'fsp_import') {
		await tx.update(candidates).set({ birthDate: date }).where(eq(candidates.id, candidateId));
		return true;
	}
	// A date confirmed by an operator's document stands; a declared one waits for the operator (domain 7.2).
	if (candidate.birthStatus !== 'unverified') return false;
	await tx.update(candidates).set({ birthDateStatus: 'conflict' }).where(eq(candidates.id, candidateId));
	await recordAuditEvent(tx, {
		action: 'age.conflict',
		outcome: 'success',
		actor: context.actor,
		subjectCandidateId: candidateId,
		requestId: context.requestId,
		details: { source: 'fsp_import' }
	});
	return true;
}

/**
 * Compares what the source stated with the link's current facts in the caller's transaction: new records become
 * facts, claims and receipts, changed ones supersede their previous version, annulled ones and — only from a complete
 * source — absent ones leave the profile at once through `evidence_floor_revision`.
 */
export async function applyFacts(tx: Transaction, context: FactsUpdate): Promise<FspSyncSummary> {
	const { grounds, drafts, taxonomy, signer, complete, sourceVersion, coverage } = context;
	const now = new Date();
	const snapshotHash = context.sourceSnapshotSha256;

	const rows: CurrentFact[] = await tx
		.select({
			id: sourceFacts.id,
			factType: sourceFacts.factType,
			sourceRecordRef: sourceFacts.sourceRecordRef,
			eventKey: sourceFacts.eventKey,
			payloadSha256: sourceFacts.payloadSha256,
			status: sourceFacts.status
		})
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.candidateId, grounds.candidateId),
				eq(sourceFacts.source, 'fsp'),
				eq(sourceFacts.ownershipBasis, 'athlete_link'),
				eq(sourceFacts.ownershipRef, grounds.linkId),
				inArray(sourceFacts.status, ['active', 'annulled'])
			)
		)
		.orderBy(asc(sourceFacts.id));
	// The newest row of a record is its current version (ids are time-ordered).
	const current = new Map<string, CurrentFact>();
	for (const row of rows) current.set(row.sourceRecordRef, row);

	const summary: FspSyncSummary = {
		facts: drafts.length,
		complete,
		inserted: 0,
		unchanged: 0,
		superseded: 0,
		annulled: 0,
		withdrawn: 0,
		skippedWithdrawals: 0,
		claims: 0,
		receipts: 0,
		profileRevision: null
	};
	const verified: string[] = [];
	const supersede: string[] = [];
	const annul: string[] = [];
	const insert: FactDraft[] = [];

	for (const fact of drafts) {
		const existing = current.get(fact.sourceRecordRef);
		if (!existing) {
			insert.push(fact);
		} else if (
			existing.payloadSha256 === fact.payloadSha256 ||
			(existing.status === 'annulled' && fact.status === 'annulled')
		) {
			verified.push(existing.id);
		} else if (fact.status === 'annulled') {
			// The record keeps the version it was confirmed in; the annulment is its new status.
			annul.push(existing.id);
		} else {
			if (existing.status === 'active') supersede.push(existing.id);
			insert.push(fact);
		}
	}
	const present = new Set(drafts.map((d) => d.sourceRecordRef));
	const covered = (fact: CurrentFact) =>
		coverage.scope === 'link' ||
		(fact.factType === 'competition_result' && fact.eventKey !== null && coverage.eventKeys.has(fact.eventKey));
	const absent = [...current.values()].filter(
		(f) => f.status === 'active' && !present.has(f.sourceRecordRef) && covered(f)
	);
	const withdraw: string[] = [];
	if (complete) {
		// A batch replaces a competition's rows as a whole: a record absent from a new edition of the protocol whose
		// competition still lists the athlete under a new record is superseded by it, otherwise it is withdrawn.
		const restated = new Set(insert.map((d) => d.eventKey));
		for (const fact of absent) {
			if (coverage.scope === 'competitions' && fact.eventKey !== null && restated.has(fact.eventKey)) {
				supersede.push(fact.id);
			} else {
				withdraw.push(fact.id);
			}
		}
	}
	summary.skippedWithdrawals = complete ? 0 : absent.length;

	const touched = [...verified, ...annul];
	if (touched.length > 0) {
		await tx
			.update(sourceFacts)
			.set({ lastVerifiedAt: now, sourceSnapshotSha256: snapshotHash, sourceVersion })
			.where(inArray(sourceFacts.id, touched));
	}
	await setFactStatus(tx, supersede, 'superseded', 'source_new_version');
	await setFactStatus(tx, annul, 'annulled', 'source_annulled');
	await setFactStatus(
		tx,
		withdraw,
		'withdrawn',
		coverage.scope === 'link' ? 'absent_from_complete_snapshot' : 'absent_from_complete_batch'
	);
	summary.unchanged = verified.length;
	summary.superseded = supersede.length;
	summary.annulled = annul.length;
	summary.withdrawn = withdraw.length;

	for (const fact of insert) {
		const [row] = await tx
			.insert(sourceFacts)
			.values({
				candidateId: grounds.candidateId,
				source: 'fsp',
				factType: fact.factType,
				sourceRecordRef: fact.sourceRecordRef,
				eventKey: fact.eventKey,
				trustLevel: 'fsp_verified',
				ownershipBasis: 'athlete_link',
				ownershipRef: grounds.linkId,
				consentEventId: grounds.consentEventId,
				payload: fact.payload,
				payloadSha256: fact.payloadSha256,
				sourceSnapshotSha256: snapshotHash,
				sourceVersion,
				observedAt: now,
				lastVerifiedAt: now,
				occurredOn: fact.occurredOn,
				status: fact.status
			})
			.returning({ id: sourceFacts.id });
		if (!row) throw new Error('source fact was not inserted');
		summary.inserted++;

		const drafted = factClaims(fact, context.birthYear, taxonomy);
		if (drafted.length > 0) {
			await tx.insert(claims).values(
				drafted.map((claim) => ({
					candidateId: grounds.candidateId,
					factId: row.id,
					claimType: claim.claimType,
					rawText: claim.rawText,
					polarity: 'asserted' as const,
					skillKey: claim.skillKey,
					value: claim.value,
					extractor: 'source_mapping' as const,
					status: 'active' as const
				}))
			);
			summary.claims += drafted.length;
		}

		const template = taxonomy.receiptTemplates.get(fact.factType);
		if (template && receiptEligible(fact)) {
			const outcome = await issueSelfReceipt(tx, signer, template, {
				id: row.id,
				fact,
				sourceRecordRef: fact.sourceRecordRef,
				payloadSha256: fact.payloadSha256,
				sourceSnapshotSha256: snapshotHash,
				lastVerifiedAt: now
			});
			if (outcome === 'issued') summary.receipts++;
		}
	}

	const birthDateChanged = await applyBirthYear(tx, context);

	const removed = supersede.length + annul.length + withdraw.length;
	if (insert.length > 0 || removed > 0) {
		// Any change of the categorization input moves the revision; a removed ground also raises the floor and takes the
		// published category off the card, so every derivative built on the old revision stops counting (domain 17.3).
		summary.profileRevision = await recordEvidenceChange(tx, {
			candidateId: grounds.candidateId,
			withdrawal: removed > 0,
			reason: 'fsp_evidence_removed',
			requestId: context.requestId,
			actor: context.actor,
			createdBy: context.createdBy
		});
	} else if (birthDateChanged) {
		// The age regime decides which vacancies the profile matches: the matches and their counters are recomputed.
		summary.profileRevision = await recordProfileChange(tx, grounds.candidateId, {
			categorizationInput: false,
			createdBy: context.createdBy
		});
	}

	if (summary.skippedWithdrawals > 0) {
		await recordAuditEvent(tx, {
			action: 'fsp.withdrawals_skipped_incomplete',
			outcome: 'success',
			actor: context.actor,
			object: { type: 'athlete_link', id: grounds.linkId },
			subjectCandidateId: grounds.candidateId,
			requestId: context.requestId,
			details: {
				missing_count: summary.skippedWithdrawals,
				reason: context.incompleteReason
			}
		});
	}
	await recordAuditEvent(tx, {
		action: 'fsp.sync_completed',
		outcome: 'success',
		actor: context.actor,
		object: { type: 'athlete_link', id: grounds.linkId },
		subjectCandidateId: grounds.candidateId,
		requestId: context.requestId,
		details: {
			variant: context.variant,
			fact_count: summary.facts,
			complete,
			inserted: summary.inserted,
			superseded: summary.superseded,
			annulled: summary.annulled,
			withdrawn: summary.withdrawn
		}
	});
	return summary;
}

/** Builds the handler over an integration; the registered handler uses the configured one. */
export function createFspSyncHandler(integration: () => FspIntegration): JobHandler<'fsp.sync'> {
	return defineHandler({
		type: 'fsp.sync',
		concurrency: 2,
		run: async ({ job, db, requestId, signal }) => {
			const grounds = await currentGrounds(db, job.payload.athlete_link_id);
			// The link or the consent is gone: the job stops without calling the source (contracts 1.2).
			if (!grounds) return stale;
			const taxonomy = await loadProjectionTaxonomy(db);
			if (!taxonomy) throw new JobFailure('taxonomy_missing', 'no published taxonomy version', { retryable: true });
			const { source, grants, signer } = integration();

			const grant = await grants.issue({
				sourceAthleteId: grounds.sourceAthleteId,
				consentEventId: grounds.consentEventId
			});
			if (!grant.ok) throw new JobFailure(grant.error.code, grant.error.message, { retryable: grant.error.retryable });
			signal.throwIfAborted();

			const snapshot = await source.getAchievements({ sourceAthleteId: grounds.sourceAthleteId, grant: grant.value });
			if (!snapshot.ok) {
				const { error } = snapshot;
				if (error.code === 'grant_mismatch') {
					// A valid grant answered as foreign: the link or the source is wrong — a security event, not a retry.
					await recordAuditEvent(db, {
						action: 'fsp.grant_mismatch',
						outcome: 'denied',
						actor: system,
						object: { type: 'athlete_link', id: grounds.linkId },
						subjectCandidateId: grounds.candidateId,
						requestId
					});
				}
				const retryAfter = error.details?.retryAfterSeconds;
				throw new JobFailure(error.code, error.message, {
					retryable: error.retryable,
					...(typeof retryAfter === 'number' ? { retryAfterSeconds: retryAfter } : {})
				});
			}
			signal.throwIfAborted();

			let drafts: FactDraft[];
			try {
				drafts = snapshotFacts(snapshot.value);
			} catch (error) {
				if (error instanceof SnapshotInconsistency) {
					throw new JobFailure('protocol_error', error.message, { retryable: false });
				}
				throw error;
			}

			let summary: FspSyncSummary | undefined;
			return {
				isCurrent: async (tx) => {
					// Serializes with a revocation or an unlink of the same candidate, then re-checks the grounds (17.1).
					await tx
						.select({ id: candidates.id })
						.from(candidates)
						.where(eq(candidates.id, grounds.candidateId))
						.for('update');
					const now = await currentGrounds(tx, grounds.linkId);
					return (
						now !== null &&
						now.candidateId === grounds.candidateId &&
						now.sourceAthleteId === grounds.sourceAthleteId &&
						now.consentEventId === grounds.consentEventId
					);
				},
				write: async (tx) => {
					const { completeness, athlete } = snapshot.value;
					summary = await applyFacts(tx, {
						grounds,
						drafts,
						birthYear: athlete.birthYear,
						sourceSnapshotSha256: snapshotSha256(snapshot.value),
						sourceVersion: completeness.sourceVersion,
						coverage: { scope: 'link' },
						complete: completeness.complete,
						incompleteReason: completeness.incompleteReason ?? null,
						variant: 'api',
						taxonomy,
						signer,
						actor: system,
						requestId,
						createdBy: { kind: 'system', id: job.id }
					});
				},
				describe: () => ({
					facts: summary?.facts,
					complete: summary?.complete,
					inserted: summary?.inserted,
					superseded: summary?.superseded,
					annulled: summary?.annulled,
					withdrawn: summary?.withdrawn,
					skipped_withdrawals: summary?.skippedWithdrawals,
					claims: summary?.claims,
					receipts: summary?.receipts
				})
			};
		}
	});
}

/** Handler of `fsp.sync` for the job registry. */
export const fspSync = createFspSyncHandler(fspIntegration);
