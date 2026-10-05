// Job `evidence.compute` (docs/domain.md 12.6, 17.1–17.3): read one snapshot at the current profile revision, compute
// outside any transaction, then write conditionally — only while the revision is still current, not below the evidence
// floor and every input still active. The written run is published at once and the previous published or blocked run
// becomes superseded, so a revision that arrived during the run is left to the job waiting behind it. The run carries
// the skill inferences, the FSP levels and the experience of the profile; the category is not its business (12.4).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import type { Transaction } from '$lib/server/db';
import { publishedRun } from '$lib/server/db/conditions';
import { candidates, evidenceRuns, fspLevelAssignments, skillInferences } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { enqueueJob, type JobCreator } from '$lib/server/jobs/queue';
import { computeEvidence } from './compute';
import {
	inputRefs,
	inputsStillActive,
	loadLatestRules,
	loadSnapshot,
	RulesetUnsupported,
	snapshotSha256
} from './snapshot';
import type { EvidenceResult, EvidenceSnapshot, RulesContext } from './types';

/**
 * The candidate's matches follow the evidence in force (domain 13.3, 17.3): a published, replaced or blocked run
 * enqueues their recalculation at the revision the change leaves in force.
 */
async function enqueueMatchRefresh(
	tx: Transaction,
	candidateId: string,
	revision: number,
	createdBy: JobCreator
): Promise<void> {
	await enqueueJob(
		tx,
		'match.refresh',
		{ scope: 'candidate', candidate_id: candidateId },
		{ inputVersion: String(revision), createdBy }
	);
}

/**
 * Stores a computed run with its skill inferences (layer 3) and FSP levels as the published one of the candidate; the
 * previous published or blocked run becomes superseded, and the candidate's matches are enqueued for recalculation.
 */
async function publishRun(
	tx: Transaction,
	computed: {
		snapshot: EvidenceSnapshot;
		rules: RulesContext;
		result: EvidenceResult;
		asOf: Date;
		jobId: string;
	}
): Promise<string> {
	const { snapshot, rules, result } = computed;
	const candidateId = snapshot.candidateId;
	await tx
		.update(evidenceRuns)
		.set({ status: 'superseded' })
		.where(and(eq(evidenceRuns.candidateId, candidateId), inArray(evidenceRuns.status, ['published', 'blocked'])));
	const [run] = await tx
		.insert(evidenceRuns)
		.values({
			candidateId,
			inputRevision: snapshot.revision,
			inputSnapshotSha256: snapshotSha256(snapshot),
			inputRefs: { ...inputRefs(snapshot), unused: result.unused },
			taxonomyVersionId: rules.taxonomyVersionId,
			rulesetId: rules.rulesetId,
			asOf: computed.asOf,
			computedAt: sql`now()`,
			jobId: computed.jobId,
			experienceSummary: result.experienceSummary,
			status: 'published'
		})
		.returning({ id: evidenceRuns.id });
	if (!run) throw new Error('evidence run was not inserted');
	if (result.fspLevels.length > 0) {
		await tx.insert(fspLevelAssignments).values(
			result.fspLevels.map((l) => ({
				runId: run.id,
				discipline: l.discipline,
				level: l.level,
				basisFactIds: l.basisFactIds,
				lastResultOn: l.lastResultOn
			}))
		);
	}
	if (result.inferences.length > 0) {
		await tx.insert(skillInferences).values(
			result.inferences.map((i) => ({
				runId: run.id,
				candidateId,
				skillKey: i.skillKey,
				strength: i.strength.toFixed(3),
				strengthBand: i.band,
				attestation: i.attestation,
				badgeTrust: i.badgeTrust,
				contributions: i.contributions
			}))
		);
	}
	await enqueueMatchRefresh(tx, candidateId, snapshot.revision, { kind: 'system', id: computed.jobId });
	return run.id;
}

/**
 * Takes the published evidence off the card at once when a ground of it is withdrawn (domain 12.6, 17.3): the run
 * becomes `blocked` in the transaction of the withdrawal, which also raises the evidence floor and enqueues the
 * recalculation. The candidate's category is untouched: it rests on a test, not on this evidence (domain 12.4). The
 * candidate's matches are enqueued here: they are recomputed without the withdrawn ground at the revision the
 * withdrawal made current. The blocking is journaled as the consequence of the withdrawal that caused it; the runs
 * themselves are the journal of the calculation (domain 18.2). Returns the blocked run ids.
 */
export async function blockPublishedEvidence(
	tx: Transaction,
	candidateId: string,
	journal: { requestId: string; actor: AuditActor; reason: string; createdBy: JobCreator }
): Promise<string[]> {
	const blocked = await tx
		.update(evidenceRuns)
		.set({ status: 'blocked' })
		.where(and(eq(evidenceRuns.candidateId, candidateId), publishedRun(evidenceRuns)))
		.returning({ id: evidenceRuns.id });
	for (const run of blocked) {
		await recordAuditEvent(tx, {
			action: 'evidence.blocked',
			outcome: 'success',
			actor: journal.actor,
			object: { type: 'evidence_run', id: run.id },
			subjectCandidateId: candidateId,
			requestId: journal.requestId,
			details: { reason: journal.reason }
		});
	}
	const [candidate] = await tx
		.select({ revision: candidates.profileRevision })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!candidate) throw new Error(`candidate ${candidateId} is missing`);
	await enqueueMatchRefresh(tx, candidateId, candidate.revision, journal.createdBy);
	return blocked.map((r) => r.id);
}

const stale: JobResult = { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };

/** Builds the handler with a clock for `as_of`; the registered handler uses the system clock. */
export function createEvidenceHandler(now: () => Date = () => new Date()): JobHandler<'evidence.compute'> {
	return defineHandler({
		type: 'evidence.compute',
		concurrency: 4,
		run: async ({ job, db }) => {
			const candidateId = job.payload.candidate_id;
			let rules: RulesContext | null;
			try {
				rules = await loadLatestRules(db);
			} catch (error) {
				if (error instanceof RulesetUnsupported) {
					throw new JobFailure('ruleset_unsupported', error.message, { retryable: false });
				}
				throw error;
			}
			if (!rules)
				throw new JobFailure('taxonomy_missing', 'no published taxonomy with a rule set', { retryable: true });
			const loaded = await loadSnapshot(db, candidateId);
			if (!loaded) return stale;
			const { snapshot } = loaded;
			if (snapshot.revision < loaded.evidenceFloorRevision) return stale;

			const asOf = now();
			const result = computeEvidence(snapshot, rules, asOf);
			let runId: string | null = null;
			const current: JobResult = {
				isCurrent: async (tx) => {
					// Serializes with any change of the profile: the revision cannot move until this transaction ends.
					const [row] = await tx
						.select({
							revision: candidates.profileRevision,
							floor: candidates.evidenceFloorRevision
						})
						.from(candidates)
						.where(eq(candidates.id, candidateId))
						.for('update');
					return (
						row !== undefined &&
						row.revision === snapshot.revision &&
						snapshot.revision >= row.floor &&
						(await inputsStillActive(tx, snapshot))
					);
				},
				write: async (tx) => {
					runId = await publishRun(tx, { snapshot, rules, result, asOf, jobId: job.id });
				},
				describe: () => ({
					run_id: runId,
					revision: snapshot.revision,
					ruleset_version: rules.rulesetVersion,
					inferences: result.inferences.length,
					fsp_levels: result.fspLevels.length
				})
			};
			return current;
		}
	});
}

/** Handler of `evidence.compute` for the job registry. */
export const evidenceCompute = createEvidenceHandler();
