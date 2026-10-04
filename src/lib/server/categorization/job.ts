// Job `categorization.compute` (docs/domain.md 12.1, 17.1–17.3): read one snapshot at the current profile revision,
// compute outside any transaction, then write conditionally — only while the revision is still current, not below the
// evidence floor and every input still active. The written run is published at once and the previous published or
// blocked run becomes superseded, so a revision that arrived during the run is left to the job waiting behind it.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import type { Transaction } from '$lib/server/db';
import { publishedRun } from '$lib/server/db/conditions';
import {
	candidates,
	categorizationRuns,
	categoryAssignments,
	fspLevelAssignments,
	skillInferences
} from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { enqueueJob, type JobCreator } from '$lib/server/jobs/queue';
import { categorize } from './categorize';
import {
	inputRefs,
	inputsStillActive,
	loadLatestRules,
	loadSnapshot,
	RulesetUnsupported,
	snapshotSha256
} from './snapshot';
import type {
	AssignmentExplanation,
	AssignmentResult,
	CategorizationResult,
	CategorizationSnapshot,
	ManualOverrideExplanation,
	RulesContext
} from './types';

const system: AuditActor = { kind: 'system' };

/**
 * What a category is decided over (domain 12.3): the desired roles and the exact facts, claims and experience entries
 * behind the run — never preferences, work format or catalog visibility, which move `profile_revision` too (domain
 * 13.4) but are not grounds of the category. Stored inside `input_refs` (`desired_role_keys` beside the existing
 * `facts`/`claims`/`experience_entries`) on every run, automatic or `manual_override`, so a later run — including one
 * disputed again — can tell whether the grounds it stands on are still the current ones.
 */
export interface OverrideBasis {
	desiredRoleKeys: string[];
	facts: string[];
	claims: string[];
	experienceEntries: string[];
}

/** The basis of the current snapshot, in the shape stored in `input_refs`. */
export function overrideBasisOf(snapshot: CategorizationSnapshot): OverrideBasis {
	const refs = inputRefs(snapshot);
	return {
		desiredRoleKeys: [...snapshot.desiredRoleKeys].sort(),
		facts: [...refs.facts].sort(),
		claims: [...refs.claims].sort(),
		experienceEntries: [...refs.experience_entries].sort()
	};
}

function sameStrings(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Whether a run's stored `input_refs` still matches the given basis. `false` for a run published before this basis
 * existed (no `desired_role_keys` recorded): its grounds cannot be verified, so it is treated as changed.
 */
export function matchesBasis(storedInputRefs: unknown, basis: OverrideBasis): boolean {
	if (typeof storedInputRefs !== 'object' || storedInputRefs === null) return false;
	const stored = storedInputRefs as Record<string, unknown>;
	const strings = (value: unknown): string[] | null =>
		Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value].sort() : null;
	const desiredRoleKeys = strings(stored.desired_role_keys);
	const facts = strings(stored.facts);
	const claims = strings(stored.claims);
	const experienceEntries = strings(stored.experience_entries);
	if (!desiredRoleKeys || !facts || !claims || !experienceEntries) return false;
	return (
		sameStrings(desiredRoleKeys, basis.desiredRoleKeys) &&
		sameStrings(facts, basis.facts) &&
		sameStrings(claims, basis.claims) &&
		sameStrings(experienceEntries, basis.experienceEntries)
	);
}

/** A run to store, whatever produced it: the calculation or an operator's decision. */
interface RunHeader {
	candidateId: string;
	inputRevision: number;
	inputSnapshotSha256: string;
	inputRefs: unknown;
	taxonomyVersionId: string;
	taxonomyLabel: string;
	rulesetId: string;
	rulesetVersion: number;
	asOf: Date;
	jobId: string | null;
	origin: { kind: 'automatic' } | { kind: 'manual_override'; by: string; reason: string };
	outcome: CategorizationResult['outcome'];
	missing: unknown;
	experienceSummary: unknown;
}

export type StoredAssignment = Omit<AssignmentResult, 'explanation'> & {
	explanation: AssignmentExplanation | ManualOverrideExplanation;
};

/** Who asked for the jobs a change of the category enqueues. */
function creatorOf(actor: AuditActor, jobId: string | null): JobCreator {
	if (jobId !== null) return { kind: 'system', id: jobId };
	return actor.kind === 'user' || actor.kind === 'api_key' ? { kind: 'user', id: actor.userId } : { kind: 'system' };
}

/**
 * The candidate's matches follow the published category (domain 13.3, 17.3): a published, replaced or blocked category
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
 * Stores a run with its axes as the published category of the candidate; the previous published or blocked run
 * becomes superseded, and the candidate's matches are enqueued for recalculation. Called inside the transaction that
 * checked the grounds.
 */
export async function insertPublishedRun(
	tx: Transaction,
	header: RunHeader,
	assignments: readonly StoredAssignment[],
	journal: { requestId: string; actor: AuditActor }
): Promise<string> {
	const { candidateId } = header;
	await tx
		.update(categorizationRuns)
		.set({ status: 'superseded' })
		.where(
			and(eq(categorizationRuns.candidateId, candidateId), inArray(categorizationRuns.status, ['published', 'blocked']))
		);
	const [run] = await tx
		.insert(categorizationRuns)
		.values({
			candidateId,
			inputRevision: header.inputRevision,
			inputSnapshotSha256: header.inputSnapshotSha256,
			inputRefs: header.inputRefs,
			taxonomyVersionId: header.taxonomyVersionId,
			rulesetId: header.rulesetId,
			asOf: header.asOf,
			computedAt: sql`now()`,
			jobId: header.jobId,
			origin: header.origin.kind,
			overrideBy: header.origin.kind === 'manual_override' ? header.origin.by : null,
			overrideReason: header.origin.kind === 'manual_override' ? header.origin.reason : null,
			outcome: header.outcome,
			missing: header.missing,
			experienceSummary: header.experienceSummary,
			status: 'published'
		})
		.returning({ id: categorizationRuns.id });
	if (!run) throw new Error('categorization run was not inserted');

	if (assignments.length > 0) {
		await tx.insert(categoryAssignments).values(
			assignments.map((a) => ({
				runId: run.id,
				rank: a.rank,
				roleStatus: a.roleStatus,
				roleKey: a.roleKey,
				score: a.score === null ? null : a.score.toFixed(3),
				gradeStatus: a.gradeStatus,
				gradeMin: a.gradeMin,
				gradeMax: a.gradeMax,
				gradeConfidence: a.gradeConfidence === null ? null : a.gradeConfidence.toFixed(2),
				stackStatus: a.stackStatus,
				stackSkillKeys: a.stackSkillKeys,
				explanation: a.explanation
			}))
		);
	}
	await recordAuditEvent(tx, {
		action: 'category.published',
		outcome: 'success',
		actor: journal.actor,
		object: { type: 'categorization_run', id: run.id },
		subjectCandidateId: candidateId,
		requestId: journal.requestId,
		details: {
			outcome: header.outcome,
			origin: header.origin.kind,
			input_revision: header.inputRevision,
			ruleset_version: header.rulesetVersion,
			taxonomy_version: header.taxonomyLabel
		}
	});
	await enqueueMatchRefresh(tx, candidateId, header.inputRevision, creatorOf(journal.actor, header.jobId));
	return run.id;
}

/** Stores a computed run: its axes, FSP levels and skill inferences (layer 3). */
async function publishComputedRun(
	tx: Transaction,
	computed: {
		snapshot: CategorizationSnapshot;
		rules: RulesContext;
		result: CategorizationResult;
		asOf: Date;
		jobId: string | null;
	},
	journal: { requestId: string; actor: AuditActor }
): Promise<string> {
	const { snapshot, rules, result } = computed;
	const runId = await insertPublishedRun(
		tx,
		{
			candidateId: snapshot.candidateId,
			inputRevision: snapshot.revision,
			inputSnapshotSha256: snapshotSha256(snapshot),
			inputRefs: {
				...inputRefs(snapshot),
				desired_role_keys: overrideBasisOf(snapshot).desiredRoleKeys,
				unused: result.unused
			},
			taxonomyVersionId: rules.taxonomyVersionId,
			taxonomyLabel: rules.taxonomyLabel,
			rulesetId: rules.rulesetId,
			rulesetVersion: rules.rulesetVersion,
			asOf: computed.asOf,
			jobId: computed.jobId,
			origin: { kind: 'automatic' },
			outcome: result.outcome,
			missing: result.missing,
			experienceSummary: result.experienceSummary
		},
		result.assignments,
		journal
	);
	if (result.fspLevels.length > 0) {
		await tx.insert(fspLevelAssignments).values(
			result.fspLevels.map((l) => ({
				runId,
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
				runId,
				candidateId: snapshot.candidateId,
				skillKey: i.skillKey,
				strength: i.strength.toFixed(3),
				strengthBand: i.band,
				attestation: i.attestation,
				badgeTrust: i.badgeTrust,
				contributions: i.contributions
			}))
		);
	}
	return runId;
}

/**
 * Takes the published category off the card at once when a ground of it is withdrawn (domain 12.1, 17.3): the run
 * becomes `blocked` in the transaction of the withdrawal, which also raises the evidence floor and enqueues the
 * recalculation of the category. The candidate's matches are enqueued here: they are recomputed without the withdrawn
 * ground at the revision the withdrawal made current. Returns the blocked run ids.
 */
export async function blockPublishedCategory(
	tx: Transaction,
	candidateId: string,
	journal: { requestId: string; actor: AuditActor; reason: string }
): Promise<string[]> {
	const blocked = await tx
		.update(categorizationRuns)
		.set({ status: 'blocked' })
		.where(and(eq(categorizationRuns.candidateId, candidateId), publishedRun(categorizationRuns)))
		.returning({ id: categorizationRuns.id });
	for (const run of blocked) {
		await recordAuditEvent(tx, {
			action: 'category.blocked',
			outcome: 'success',
			actor: journal.actor,
			object: { type: 'categorization_run', id: run.id },
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
	await enqueueMatchRefresh(tx, candidateId, candidate.revision, creatorOf(journal.actor, null));
	return blocked.map((r) => r.id);
}

const stale: JobResult = { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };

/** Builds the handler with a clock for `as_of`; the registered handler uses the system clock. */
export function createCategorizationHandler(now: () => Date = () => new Date()): JobHandler<'categorization.compute'> {
	return defineHandler({
		type: 'categorization.compute',
		concurrency: 4,
		run: async ({ job, db, requestId }) => {
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
			const result = categorize(snapshot, rules, asOf);
			let runId: string | null = null;
			let keptOverride = false;
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
					// An operator's decision on a dispute stands until the desired roles or the grounds behind it change
					// (domain 12.3) — not until any profile field moves `profile_revision` (domain 13.4): preferences, work
					// format and catalog visibility are not grounds of a category.
					const [published] = await tx
						.select({ origin: categorizationRuns.origin, inputRefs: categorizationRuns.inputRefs })
						.from(categorizationRuns)
						.where(and(eq(categorizationRuns.candidateId, candidateId), publishedRun(categorizationRuns)));
					if (published?.origin === 'manual_override' && matchesBasis(published.inputRefs, overrideBasisOf(snapshot))) {
						keptOverride = true;
						return;
					}
					runId = await publishComputedRun(
						tx,
						{ snapshot, rules, result, asOf, jobId: job.id },
						{ requestId, actor: system }
					);
				},
				describe: () => ({
					run_id: runId,
					outcome: result.outcome,
					revision: snapshot.revision,
					ruleset_version: rules.rulesetVersion,
					assignments: result.assignments.length,
					inferences: result.inferences.length,
					kept_manual_override: keptOverride
				})
			};
			return current;
		}
	});
}

/** Handler of `categorization.compute` for the job registry. */
export const categorizationCompute = createCategorizationHandler();
