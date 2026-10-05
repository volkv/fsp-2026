// Job `evidence.compute` against the database: full cycle from facts to a published evidence run, the race of profile
// revisions, a withdrawn ground that blocks the evidence until the recalculation, and a new rule set version.
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
	claims,
	evidenceRuns,
	experienceEntries,
	fspLevelAssignments,
	jobs,
	skillInferences,
	sourceFacts,
	taxonomyVersions
} from '$lib/server/db/schema';
import { blockPublishedEvidence, createEvidenceHandler } from '$lib/server/evidence/job';
import { factClaims, loadProjectionTaxonomy, snapshotFacts, type ProjectionTaxonomy } from '$lib/server/fsp/projection';
import type { AchievementsSnapshot, Competition } from '$lib/server/fsp/types';
import { JobFailure, type JobResult } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, randomSha256 } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const AS_OF = new Date('2026-09-25T12:00:00Z');

let database: TestDatabase;
let projection: ProjectionTaxonomy;
/** Parameters of the rule set the release ships. */
let shipped: Record<string, Record<string, unknown>>;
/** Version of the rule set the release ships. */
let shippedVersion: number;
let taxonomyVersionId: string;
const handler = createEvidenceHandler(() => AS_OF);

/** A later rule set version: the shipped parameters with another weight of a skill applied at work. */
async function addRuleset(version: number, overrides: { resumeAppliedSkill: number }) {
	const evidence = shipped.evidence as { claimWeights: Record<string, number> };
	await database.db.insert(categorizationRulesets).values({
		version,
		taxonomyVersionId,
		params: {
			...shipped,
			evidence: {
				...evidence,
				claimWeights: { ...evidence.claimWeights, resumeAppliedSkill: overrides.resumeAppliedSkill }
			}
		}
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
			'evidence.compute',
			{ candidate_id: candidateId },
			{
				inputVersion: String(row.revision),
				createdBy: { kind: 'system' }
			}
		);
		return row.revision;
	});
}

/** Withdrawal of a ground (domain 17.3): facts leave, the floor rises, the evidence is blocked, the recalculation queued. */
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
		await blockPublishedEvidence(tx, candidateId, {
			requestId: 'test',
			actor: { kind: 'system' },
			reason: 'consent_revoked',
			createdBy: { kind: 'system' }
		});
		await enqueueJob(
			tx,
			'evidence.compute',
			{ candidate_id: candidateId },
			{
				inputVersion: String(row.revision),
				createdBy: { kind: 'system' }
			}
		);
	});
}

type Captured = { job: ClaimedJob<'evidence.compute'>; result: JobResult };
/** The job the last capture claimed, for reporting a failure of its run. */
let failing: ClaimedJob | null = null;

/** Captures the next evidence job and runs it up to the conditional write. */
async function capture(): Promise<Captured> {
	const claimed = await claimJob(database.db, `worker-${randomBytes(3).toString('hex')}`, ['evidence.compute']);
	if (claimed?.type !== 'evidence.compute') throw new Error('no evidence job to run');
	const job: ClaimedJob<'evidence.compute'> = {
		...claimed,
		type: 'evidence.compute',
		payload: JOB_TYPES['evidence.compute'].payload.parse(claimed.payload)
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

/** Runs the next evidence job to its end, as the worker does: a handled failure goes back through the queue. */
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
		.from(evidenceRuns)
		.where(eq(evidenceRuns.candidateId, candidateId))
		.orderBy(asc(evidenceRuns.computedAt), asc(evidenceRuns.id));

async function published(candidateId: string) {
	const [run] = await database.db
		.select()
		.from(evidenceRuns)
		.where(and(eq(evidenceRuns.candidateId, candidateId), eq(evidenceRuns.status, 'published')));
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
	it('publishes an evidence run with FSP levels, skill inferences and experience from facts in the database', async () => {
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
		expect(run).toMatchObject({ inputRevision: 1, status: 'published' });
		expect(run?.asOf).toEqual(AS_OF);
		expect(run?.experienceSummary).toMatchObject({ by_role: { algo_engineer: expect.any(Object) as unknown } });
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
		// The run is the journal of the calculation (domain 18.2): no event copies it, and no category comes of it.
		expect(
			await db
				.select()
				.from(auditEvents)
				.where(and(eq(auditEvents.subjectCandidateId, candidate.id), eq(auditEvents.action, 'category.assigned')))
		).toEqual([]);
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
	it('blocks the evidence at once, discards a result computed before, and publishes the recalculation', async () => {
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
			.from(evidenceRuns)
			.where(eq(evidenceRuns.id, before?.id ?? ''));
		expect(blocked[0]?.status).toBe('blocked');
		expect(await published(candidate.id)).toBeUndefined();
		const [event] = await db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'evidence.blocked'), eq(auditEvents.objectId, before?.id ?? '')));
		expect(event?.details).toEqual({ reason: 'consent_revoked' });

		expect(await complete(inFlight)).toBe('discarded_stale');
		expect(await published(candidate.id)).toBeUndefined();

		expect(await runNext()).toBe('succeeded');
		const after = await published(candidate.id);
		expect(after?.inputRevision).toBe(3);
		const [old] = await db
			.select()
			.from(evidenceRuns)
			.where(eq(evidenceRuns.id, before?.id ?? ''));
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

		await addRuleset(shippedVersion + 1, { resumeAppliedSkill: 0.05 });
		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'evidence.compute',
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
		const strength = async (runId: string | undefined) => {
			const [go] = await db
				.select({ strength: skillInferences.strength })
				.from(skillInferences)
				.where(and(eq(skillInferences.runId, runId ?? ''), eq(skillInferences.skillKey, 'go')));
			return Number(go?.strength);
		};
		expect(await strength(second?.id)).toBeLessThan(await strength(first?.id));
		const [old] = await db
			.select()
			.from(evidenceRuns)
			.where(eq(evidenceRuns.id, first?.id ?? ''));
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
			.where(and(eq(jobs.dedupKey, `evidence:${candidate.id}`), eq(jobs.status, 'failed')));
		expect(job?.lastError).toMatchObject({ code: 'ruleset_unsupported', retryable: false });
		expect(await runsOf(candidate.id)).toEqual([]);
	});
});
