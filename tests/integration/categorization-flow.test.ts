// Job `categorization.compute` against the database: full cycle from facts to a published category, the race of
// profile revisions, a withdrawn ground that blocks the category until the recalculation, a new rule set version,
// and objections answered by an operator.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, asc, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '$lib/server/db';
import {
	auditEvents,
	candidates,
	categorizationRulesets,
	categorizationRuns,
	categoryAssignments,
	categoryDisputes,
	claims,
	experienceEntries,
	fspLevelAssignments,
	jobs,
	skillInferences,
	sourceFacts,
	taxonomyVersions
} from '$lib/server/db/schema';
import {
	assignDispute,
	changeCategory,
	disputeQueue,
	openDispute,
	upholdCategory,
	withdrawDispute
} from '$lib/server/categorization/disputes';
import { blockPublishedCategory, createCategorizationHandler } from '$lib/server/categorization/job';
import { ApiError } from '$lib/server/errors/api-error';
import { factClaims, loadProjectionTaxonomy, snapshotFacts, type ProjectionTaxonomy } from '$lib/server/fsp/projection';
import type { AchievementsSnapshot, Competition } from '$lib/server/fsp/types';
import { JobFailure, type JobResult } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createUser, randomSha256 } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const AS_OF = new Date('2026-09-25T12:00:00Z');

let database: TestDatabase;
let projection: ProjectionTaxonomy;
/** Parameters of the rule set the release ships. */
let shipped: Record<string, Record<string, unknown>>;
/** Version of the rule set the release ships. */
let shippedVersion: number;
let taxonomyVersionId: string;
const handler = createCategorizationHandler(() => AS_OF);

/** A later rule set version: the shipped parameters with another role threshold. */
async function addRuleset(version: number, overrides: { minScore: number }) {
	await database.db.insert(categorizationRulesets).values({
		version,
		taxonomyVersionId,
		params: { ...shipped, role: { ...shipped.role, minScore: overrides.minScore } }
	});
}

beforeAll(async () => {
	database = await createTestDatabase();
	const release = buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR));
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, release);
	} finally {
		await client.end({ timeout: 5 });
	}
	const loaded = await loadProjectionTaxonomy(database.db);
	if (!loaded) throw new Error('taxonomy not published');
	projection = loaded;
	const [ruleset] = await database.db
		.select()
		.from(categorizationRulesets)
		.where(eq(categorizationRulesets.version, release.ruleset.version));
	if (!ruleset) throw new Error('shipped rule set not published');
	shipped = ruleset.params as Record<string, Record<string, unknown>>;
	shippedVersion = ruleset.version;
	taxonomyVersionId = ruleset.taxonomyVersionId;
	const [version] = await database.db.select().from(taxonomyVersions).where(eq(taxonomyVersions.id, taxonomyVersionId));
	expect(version?.status).toBe('published');
});

afterAll(async () => {
	await database.drop();
});

// --- Fixtures -----------------------------------------------------------------------------------------------------------

/** FSP achievements of a candidate as the synchronization stores them, confirmed by an operator. */
async function addFspFacts(
	tx: Transaction,
	candidateId: string,
	snapshot: Omit<AchievementsSnapshot, 'athlete' | 'generatedAt' | 'completeness'>
) {
	const full: AchievementsSnapshot = {
		...snapshot,
		athlete: {
			fspId: `athlete-${randomBytes(4).toString('hex')}`,
			lastName: 'Иванов',
			firstName: 'Иван',
			birthYear: 2003
		},
		generatedAt: '2026-09-20T00:00:00Z',
		completeness: { complete: true, sourceVersion: 'v1', pages: { fetched: 1, total: 1 } }
	};
	const ids: string[] = [];
	for (const draft of snapshotFacts(full)) {
		const [fact] = await tx
			.insert(sourceFacts)
			.values({
				candidateId,
				source: 'fsp',
				factType: draft.factType,
				sourceRecordRef: draft.sourceRecordRef,
				eventKey: draft.eventKey,
				trustLevel: 'fsp_verified',
				ownershipBasis: 'operator_confirmed',
				payload: draft.payload,
				payloadSha256: draft.payloadSha256,
				observedAt: new Date(),
				lastVerifiedAt: new Date(),
				occurredOn: draft.occurredOn,
				status: draft.status
			})
			.returning({ id: sourceFacts.id });
		if (!fact) throw new Error('fact not inserted');
		ids.push(fact.id);
		const drafted = factClaims(draft, full.athlete.birthYear, projection);
		if (drafted.length > 0) {
			await tx.insert(claims).values(
				drafted.map((claim) => ({
					candidateId,
					factId: fact.id,
					claimType: claim.claimType,
					rawText: claim.rawText,
					polarity: 'asserted' as const,
					skillKey: claim.skillKey,
					value: claim.value,
					extractor: 'source_mapping' as const,
					status: 'active' as const
				}))
			);
		}
	}
	return ids;
}

const quote = { extraction_id: '00000000-0000-7000-8000-000000000001', block_id: 'b1', start: 0, end: 2, text: 'Go' };

async function addResume(
	tx: Transaction,
	candidateId: string,
	input: { mentions: string[]; entries: { from: string; role: string; skills: string[] }[] }
) {
	const [fact] = await tx
		.insert(sourceFacts)
		.values({
			candidateId,
			source: 'resume',
			factType: 'resume_document',
			sourceRecordRef: `resume:${randomBytes(8).toString('hex')}`,
			trustLevel: 'claimed',
			ownershipBasis: 'self_upload',
			payload: {},
			payloadSha256: randomSha256(),
			observedAt: new Date(),
			lastVerifiedAt: new Date(),
			status: 'active'
		})
		.returning({ id: sourceFacts.id });
	if (!fact) throw new Error('resume fact not inserted');
	for (const skill of input.mentions) {
		await tx.insert(claims).values({
			candidateId,
			factId: fact.id,
			claimType: 'skill_mention',
			rawText: skill,
			polarity: 'asserted',
			skillKey: skill,
			quote,
			extractor: 'rules',
			candidateReview: 'confirmed',
			status: 'active'
		});
	}
	for (const entry of input.entries) {
		await tx.insert(experienceEntries).values({
			candidateId,
			factId: fact.id,
			roleKey: entry.role,
			periodFrom: entry.from,
			periodFromPrecision: 'month',
			isCurrent: true,
			appliedSkillKeys: entry.skills,
			quotes: [quote],
			periodStatus: 'valid',
			candidateReview: 'confirmed',
			status: 'active'
		});
	}
	return fact.id;
}

/** A change of the profile: the revision moves and the recalculation is enqueued in the same transaction. */
async function changeProfile(candidateId: string, change: (tx: Transaction) => Promise<unknown>): Promise<number> {
	return database.db.transaction(async (tx) => {
		await change(tx);
		const [row] = await tx
			.update(candidates)
			.set({ profileRevision: sql`${candidates.profileRevision} + 1` })
			.where(eq(candidates.id, candidateId))
			.returning({ revision: candidates.profileRevision });
		if (!row) throw new Error('candidate missing');
		await enqueueJob(
			tx,
			'categorization.compute',
			{ candidate_id: candidateId },
			{
				inputVersion: String(row.revision),
				createdBy: { kind: 'system' }
			}
		);
		return row.revision;
	});
}

/** Withdrawal of a ground (domain 17.3): facts leave, the floor rises, the category is blocked, the recalculation queued. */
async function withdrawFact(candidateId: string, factId: string) {
	await database.db.transaction(async (tx) => {
		await tx.update(sourceFacts).set({ status: 'withdrawn', statusReason: 'test' }).where(eq(sourceFacts.id, factId));
		await tx.update(claims).set({ status: 'invalidated' }).where(eq(claims.factId, factId));
		await tx.update(experienceEntries).set({ status: 'invalidated' }).where(eq(experienceEntries.factId, factId));
		const [row] = await tx
			.update(candidates)
			.set({
				profileRevision: sql`${candidates.profileRevision} + 1`,
				evidenceFloorRevision: sql`${candidates.profileRevision} + 1`
			})
			.where(eq(candidates.id, candidateId))
			.returning({ revision: candidates.profileRevision });
		if (!row) throw new Error('candidate missing');
		await blockPublishedCategory(tx, candidateId, {
			requestId: 'test',
			actor: { kind: 'system' },
			reason: 'consent_revoked'
		});
		await enqueueJob(
			tx,
			'categorization.compute',
			{ candidate_id: candidateId },
			{
				inputVersion: String(row.revision),
				createdBy: { kind: 'system' }
			}
		);
	});
}

type Captured = { job: ClaimedJob<'categorization.compute'>; result: JobResult };
/** The job the last capture claimed, for reporting a failure of its run. */
let failing: ClaimedJob | null = null;

/** Captures the next categorization job and runs it up to the conditional write. */
async function capture(): Promise<Captured> {
	const claimed = await claimJob(database.db, `worker-${randomBytes(3).toString('hex')}`, ['categorization.compute']);
	if (claimed?.type !== 'categorization.compute') throw new Error('no categorization job to run');
	const job: ClaimedJob<'categorization.compute'> = {
		...claimed,
		type: 'categorization.compute',
		payload: JOB_TYPES['categorization.compute'].payload.parse(claimed.payload)
	};
	failing = job;
	const result = await handler.run({
		job,
		db: database.db,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log: createLogger({ service: 'test' }).child({ job_id: job.id })
	});
	return { job, result };
}

const complete = (captured: Captured) => completeJob(database.db, captured.job, captured.result);

/** Runs the next categorization job to its end, as the worker does: a handled failure goes back through the queue. */
async function runNext() {
	let captured: Captured;
	try {
		captured = await capture();
	} catch (error) {
		if (!(error instanceof JobFailure) || !failing) throw error;
		return failJob(database.db, failing, { code: error.code, retryable: error.retryable, message: error.message });
	}
	return complete(captured);
}

const runsOf = (candidateId: string) =>
	database.db
		.select()
		.from(categorizationRuns)
		.where(eq(categorizationRuns.candidateId, candidateId))
		.orderBy(asc(categorizationRuns.computedAt), asc(categorizationRuns.id));

async function published(candidateId: string) {
	const [run] = await database.db
		.select()
		.from(categorizationRuns)
		.where(and(eq(categorizationRuns.candidateId, candidateId), eq(categorizationRuns.status, 'published')));
	return run;
}

async function olympiad(tx: Transaction, candidateId: string) {
	const final: Competition = {
		id: `rc-${randomBytes(3).toString('hex')}`,
		ekpNumber: null,
		title: 'Чемпионат России',
		discipline: 'algorithmic',
		level: 'russian_championship',
		stage: 'final',
		ageGroup: 'adults',
		format: 'individual',
		startDate: '2026-03-10',
		online: false
	};
	return addFspFacts(tx, candidateId, {
		competitions: [final],
		results: [],
		qualifications: [
			{ id: `q-${randomBytes(3).toString('hex')}`, rank: 'KMS', discipline: 'algorithmic', assignedAt: '2026-05-01' }
		]
	});
}

// --- Scenarios ----------------------------------------------------------------------------------------------------------

describe('full cycle', () => {
	it('publishes a category with axes, FSP levels and skill inferences from facts in the database', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		await changeProfile(candidate.id, async (tx) => {
			await olympiad(tx, candidate.id);
			await addResume(tx, candidate.id, {
				mentions: ['cpp'],
				entries: [{ from: '2025-02-01', role: 'algo_engineer', skills: ['cpp', 'algorithms'] }]
			});
		});

		expect(await runNext()).toBe('succeeded');
		const run = await published(candidate.id);
		expect(run).toMatchObject({ inputRevision: 1, origin: 'automatic', outcome: 'complete', status: 'published' });
		expect(run?.asOf).toEqual(AS_OF);
		const assignments = await db
			.select()
			.from(categoryAssignments)
			.where(eq(categoryAssignments.runId, run?.id ?? ''));
		expect(assignments.find((a) => a.rank === 'primary')).toMatchObject({
			roleStatus: 'established',
			roleKey: 'algo_engineer',
			gradeStatus: 'established',
			gradeMin: 'junior',
			gradeMax: 'middle',
			stackStatus: 'established'
		});
		const levels = await db
			.select()
			.from(fspLevelAssignments)
			.where(eq(fspLevelAssignments.runId, run?.id ?? ''));
		expect(levels).toEqual([expect.objectContaining({ discipline: 'algorithmic', level: 'L4' })]);
		const inferences = await db
			.select()
			.from(skillInferences)
			.where(eq(skillInferences.runId, run?.id ?? ''));
		expect(inferences.find((i) => i.skillKey === 'algorithms')).toMatchObject({
			attestation: 'direct',
			badgeTrust: 'fsp_verified',
			strengthBand: 'strong'
		});
		const [event] = await db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'category.published'), eq(auditEvents.objectId, run?.id ?? '')));
		expect(event?.details).toMatchObject({ outcome: 'complete', ruleset_version: shippedVersion, input_revision: 1 });
	});
});

describe('race of profile revisions', () => {
	it('drops the result of revision 1 and publishes revision 2 computed by the waiting job', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		await changeProfile(candidate.id, (tx) =>
			addResume(tx, candidate.id, {
				mentions: [],
				entries: [{ from: '2024-01-01', role: 'backend', skills: ['go', 'sql'] }]
			})
		);
		const first = await capture();
		// Revision 2 arrives while revision 1 is computed: its job waits under the same key.
		await changeProfile(candidate.id, (tx) => addResume(tx, candidate.id, { mentions: ['kafka'], entries: [] }));
		expect(await complete(first)).toBe('discarded_stale');
		expect(await runsOf(candidate.id)).toEqual([]);

		expect(await runNext()).toBe('succeeded');
		const runs = await runsOf(candidate.id);
		expect(runs.map((r) => [r.inputRevision, r.status])).toEqual([[2, 'published']]);
		const inferences = await db
			.select()
			.from(skillInferences)
			.where(eq(skillInferences.runId, runs[0]?.id ?? ''));
		expect(inferences.map((i) => i.skillKey)).toContain('kafka');
	});
});

describe('withdrawn ground', () => {
	it('blocks the category at once, discards a result computed before, and publishes the recalculation', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		let fspFactIds: string[] = [];
		await changeProfile(candidate.id, async (tx) => {
			fspFactIds = await olympiad(tx, candidate.id);
			await addResume(tx, candidate.id, { mentions: ['python'], entries: [] });
		});
		expect(await runNext()).toBe('succeeded');
		const before = await published(candidate.id);
		expect(before).toBeDefined();

		// A recalculation of the same revision is in flight when the ground is withdrawn.
		await changeProfile(candidate.id, () => Promise.resolve());
		const inFlight = await capture();
		const [factId] = fspFactIds;
		if (!factId) throw new Error('no FSP fact');
		await withdrawFact(candidate.id, factId);

		const blocked = await db
			.select()
			.from(categorizationRuns)
			.where(eq(categorizationRuns.id, before?.id ?? ''));
		expect(blocked[0]?.status).toBe('blocked');
		expect(await published(candidate.id)).toBeUndefined();
		const [event] = await db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'category.blocked'), eq(auditEvents.objectId, before?.id ?? '')));
		expect(event?.details).toEqual({ reason: 'consent_revoked' });

		expect(await complete(inFlight)).toBe('discarded_stale');
		expect(await published(candidate.id)).toBeUndefined();

		expect(await runNext()).toBe('succeeded');
		const after = await published(candidate.id);
		expect(after?.inputRevision).toBe(3);
		const [old] = await db
			.select()
			.from(categorizationRuns)
			.where(eq(categorizationRuns.id, before?.id ?? ''));
		expect(old?.status).toBe('superseded');
		const inferences = await db
			.select()
			.from(skillInferences)
			.where(eq(skillInferences.runId, after?.id ?? ''));
		expect(inferences.map((i) => i.skillKey)).not.toContain('algorithms');
		expect(
			await db
				.select()
				.from(fspLevelAssignments)
				.where(eq(fspLevelAssignments.runId, after?.id ?? ''))
		).toEqual([]);
	});
});

describe('objections', () => {
	async function categorized() {
		const { db } = database;
		const candidate = await createCandidate(db);
		await changeProfile(candidate.id, (tx) => olympiad(tx, candidate.id));
		expect(await runNext()).toBe('succeeded');
		const run = await published(candidate.id);
		if (!run) throw new Error('no published run');
		const operator = await createUser(db);
		return { candidate, run, operator };
	}

	it('opens with a 30-day deadline and a deadline watch, one at a time per category', async () => {
		const { db } = database;
		const { candidate, run } = await categorized();
		const dispute = await openDispute(db, {
			candidateId: candidate.id,
			userId: candidate.userId,
			runId: run.id,
			reason: '  Я работаю бэкендером три года  ',
			requestId: 'req-1'
		});
		expect(dispute).toMatchObject({ status: 'open', reason: 'Я работаю бэкендером три года', assigneeId: null });
		expect(dispute.dueAt.getTime() - dispute.openedAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
		const [watch] = await db
			.select()
			.from(jobs)
			.where(eq(jobs.dedupKey, `dispute:${dispute.id}`));
		expect(watch?.runAfter.getTime()).toBe(dispute.dueAt.getTime() - 5 * 24 * 60 * 60 * 1000);
		await expect(
			openDispute(db, {
				candidateId: candidate.id,
				userId: candidate.userId,
				runId: run.id,
				reason: 'ещё',
				requestId: 'r'
			})
		).rejects.toMatchObject({ code: 'conflict' });
		const other = await createCandidate(db);
		await expect(
			openDispute(db, { candidateId: other.id, userId: other.userId, runId: run.id, reason: 'чужая', requestId: 'r' })
		).rejects.toBeInstanceOf(ApiError);
		const queue = await disputeQueue(db, new Date(dispute.dueAt.getTime() - 60_000));
		expect(queue.find((q) => q.dispute.id === dispute.id)).toMatchObject({ overdue: false, dueSoon: true });
	});

	it('is answered only by the operator who took it into review; the candidate may withdraw it', async () => {
		const { db } = database;
		const { candidate, run, operator } = await categorized();
		const dispute = await openDispute(db, {
			candidateId: candidate.id,
			userId: candidate.userId,
			runId: run.id,
			reason: 'не согласен',
			requestId: 'r'
		});
		await expect(
			upholdCategory(db, { disputeId: dispute.id, operatorId: operator.id, resolution: 'верно', requestId: 'r' })
		).rejects.toMatchObject({ code: 'conflict' });
		await assignDispute(db, { disputeId: dispute.id, operatorId: operator.id, requestId: 'r' });
		const assigned = await db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'dispute.assigned'), eq(auditEvents.objectId, dispute.id)));
		expect(assigned.map((e) => [e.actorUserId, e.details])).toEqual([[operator.id, null]]);
		const other = await createUser(db);
		await expect(
			upholdCategory(db, { disputeId: dispute.id, operatorId: other.id, resolution: 'верно', requestId: 'r' })
		).rejects.toMatchObject({ code: 'conflict' });
		const upheld = await upholdCategory(db, {
			disputeId: dispute.id,
			operatorId: operator.id,
			resolution: 'Категория верна',
			requestId: 'r'
		});
		expect(upheld).toMatchObject({ status: 'resolved_upheld', resolution: 'Категория верна' });
		expect(upheld.resolvedAt).not.toBeNull();

		const second = await openDispute(db, {
			candidateId: candidate.id,
			userId: candidate.userId,
			runId: run.id,
			reason: 'снова',
			requestId: 'r'
		});
		const withdrawn = await withdrawDispute(db, {
			disputeId: second.id,
			candidateId: candidate.id,
			userId: candidate.userId,
			requestId: 'r'
		});
		expect(withdrawn.status).toBe('withdrawn');
		await expect(
			withdrawDispute(db, { disputeId: second.id, candidateId: candidate.id, userId: candidate.userId, requestId: 'r' })
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('replaces the category by a manual decision that stands until the profile changes', async () => {
		const { db } = database;
		const { candidate, run, operator } = await categorized();
		const dispute = await openDispute(db, {
			candidateId: candidate.id,
			userId: candidate.userId,
			runId: run.id,
			reason: 'я бэкенд',
			requestId: 'r'
		});
		await assignDispute(db, { disputeId: dispute.id, operatorId: operator.id, requestId: 'r' });
		await expect(
			changeCategory(db, {
				disputeId: dispute.id,
				operatorId: operator.id,
				resolution: 'Подтверждено документами',
				axes: { roleKey: 'no_such_role', grade: null, stackSkillKeys: [] },
				requestId: 'r'
			})
		).rejects.toMatchObject({ code: 'validation_failed' });
		const { dispute: resolved, runId } = await changeCategory(db, {
			disputeId: dispute.id,
			operatorId: operator.id,
			resolution: 'Подтверждено документами',
			axes: { roleKey: 'backend', grade: { min: 'junior', max: 'middle', confidence: 0.6 }, stackSkillKeys: ['cpp'] },
			requestId: 'r'
		});
		expect(resolved).toMatchObject({ status: 'resolved_changed', resultingRunId: runId });
		const manual = await published(candidate.id);
		expect(manual).toMatchObject({
			id: runId,
			origin: 'manual_override',
			overrideBy: operator.id,
			outcome: 'complete',
			inputRevision: run.inputRevision
		});
		const inferences = await db.select().from(skillInferences).where(eq(skillInferences.runId, runId));
		expect(inferences.map((i) => i.skillKey)).toContain('algorithms');

		// A recalculation at the same revision keeps the operator's decision.
		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'categorization.compute',
				{ candidate_id: candidate.id },
				{ inputVersion: '1', createdBy: { kind: 'system' } }
			)
		);
		expect(await runNext()).toBe('succeeded');
		expect((await published(candidate.id))?.id).toBe(runId);

		// A change of the profile returns the automatic calculation.
		await changeProfile(candidate.id, (tx) => addResume(tx, candidate.id, { mentions: ['go'], entries: [] }));
		expect(await runNext()).toBe('succeeded');
		expect(await published(candidate.id)).toMatchObject({ origin: 'automatic', inputRevision: 2 });
		const [dbDispute] = await db.select().from(categoryDisputes).where(eq(categoryDisputes.id, dispute.id));
		expect(dbDispute?.status).toBe('resolved_changed');
	});
});

// Rule sets are immutable from insertion: these scenarios add versions and run last.
describe('rule set versions', () => {
	it('computes a new run at the same revision under a new rule set version', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		await changeProfile(candidate.id, (tx) =>
			addResume(tx, candidate.id, {
				mentions: [],
				entries: [{ from: '2023-01-01', role: 'backend', skills: ['go', 'sql'] }]
			})
		);
		expect(await runNext()).toBe('succeeded');
		const first = await published(candidate.id);

		await addRuleset(shippedVersion + 1, { minScore: 0.99 });
		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'categorization.compute',
				{ candidate_id: candidate.id },
				{
					inputVersion: '1',
					createdBy: { kind: 'system' }
				}
			)
		);
		expect(await runNext()).toBe('succeeded');
		const second = await published(candidate.id);
		expect(second?.id).not.toBe(first?.id);
		expect(second?.inputRevision).toBe(first?.inputRevision);
		expect(second?.inputSnapshotSha256).toBe(first?.inputSnapshotSha256);
		const [ruleset] = await db
			.select()
			.from(categorizationRulesets)
			.where(eq(categorizationRulesets.id, second?.rulesetId ?? ''));
		expect(ruleset?.version).toBe(shippedVersion + 1);
		const [primary] = await db
			.select()
			.from(categoryAssignments)
			.where(eq(categoryAssignments.runId, second?.id ?? ''));
		expect(primary?.roleStatus).toBe('insufficient_data');
		const [old] = await db
			.select()
			.from(categorizationRuns)
			.where(eq(categorizationRuns.id, first?.id ?? ''));
		expect(old?.status).toBe('superseded');
	});

	it('fails the job without retries when the latest rule set has parameters it does not read', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		await changeProfile(candidate.id, (tx) => olympiad(tx, candidate.id));
		// Parameters of an earlier version: no weights for evidence the FSP projection does not weigh.
		const evidence = Object.fromEntries(
			Object.entries(shipped.evidence ?? {}).filter(([key]) => key !== 'claimWeights')
		);
		await db
			.insert(categorizationRulesets)
			.values({ version: 90, taxonomyVersionId, params: { ...shipped, evidence } });
		expect(await runNext()).toBe('failed');
		const [job] = await db
			.select()
			.from(jobs)
			.where(and(eq(jobs.dedupKey, `categorization:${candidate.id}`), eq(jobs.status, 'failed')));
		expect(job?.lastError).toMatchObject({ code: 'ruleset_unsupported', retryable: false });
		expect(await runsOf(candidate.id)).toEqual([]);
	});
});
