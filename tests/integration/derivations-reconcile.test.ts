// `derivations.reconcile` (docs/domain.md, section 17.3): the hourly safety net finds candidates whose category, profile
// vectors or matches lag behind `profile_revision` or the rule set in force and have no waiting or running job, and
// enqueues that job at the current revision; and vacancies whose pool may still be counted on an earlier match rule set.
// What counts as processed: a succeeded job of the derivation created under the rule set in force, or the stored result
// of that rule set — the published category, the vectors, the match rows. A revision is reconciled once per rule set: a
// job the schedule enqueued that failed is not enqueued again until the profile or the rule set moves. A run that finds
// more than it enqueues continues itself until nothing lags.
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	derivationsReconcile,
	MAX_ENQUEUED_PER_RUN,
	RECONCILED_TYPES,
	type ReconciledType
} from '$lib/server/derivations/reconcile';
import { candidates, categorizationRulesets, evidenceRuns, jobs, matchRulesets, users } from '$lib/server/db/schema';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
	createCandidate,
	createCompany,
	createMember,
	createOwnVacancy,
	createTaxonomyVersion,
	randomSha256
} from '../helpers/factories';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterEach(async () => {
	await database.db.delete(evidenceRuns);
	await database.db.delete(jobs);
});

afterAll(async () => {
	await database.drop();
});

const dedupKey = (type: ReconciledType, candidateId: string) =>
	type === 'evidence.compute'
		? `evidence:${candidateId}`
		: type === 'profile.embed'
			? `profile.embed:${candidateId}`
			: `match:candidate:${candidateId}`;

const payloadOf = (type: ReconciledType, candidateId: string) =>
	type === 'match.refresh' ? { scope: 'candidate', candidate_id: candidateId } : { candidate_id: candidateId };

/** A job of the derivation's history, as a change of the profile would have left it. */
async function history(
	type: ReconciledType,
	candidateId: string,
	revision: number,
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'discarded_stale'
): Promise<void> {
	const running = status === 'running';
	const finished = status !== 'queued' && !running;
	await database.db.insert(jobs).values({
		type,
		typeVersion: 1,
		payload: payloadOf(type, candidateId),
		inputVersion: String(revision),
		dedupKey: dedupKey(type, candidateId),
		status,
		maxAttempts: 3,
		attempts: running || finished ? 1 : 0,
		leaseOwner: running ? 'other-worker' : null,
		leaseExpiresAt: running ? new Date(Date.now() + 60_000) : null,
		finishedAt: finished ? new Date() : null,
		createdBy: { kind: 'user', id: candidateId }
	});
}

/** Every derivation of the candidate processed at `revision` by a succeeded job. */
async function upToDate(candidateId: string, revision: number): Promise<void> {
	for (const type of RECONCILED_TYPES) await history(type, candidateId, revision, 'succeeded');
}

/** One hourly run, captured and completed as the worker does it. */
async function reconcile(period: string) {
	await database.db.transaction((tx) =>
		enqueueJob(tx, 'derivations.reconcile', { period }, { inputVersion: period, createdBy: { kind: 'system' } })
	);
	return runWaiting();
}

/** Captures the waiting run and completes it as the worker does it. */
async function runWaiting() {
	const { db } = database;
	const claimed = (await claimJob(db, 'reconcile-test', [
		'derivations.reconcile'
	])) as ClaimedJob<'derivations.reconcile'> | null;
	if (!claimed) throw new Error('reconcile job was not captured');
	const result = await derivationsReconcile.run({
		job: claimed,
		db,
		signal: new AbortController().signal,
		requestId: `job:${claimed.id}`,
		log: createLogger({}, () => undefined)
	});
	expect(await completeJob(db, claimed, result)).toBe('succeeded');
	return result.describe?.();
}

/** The waiting jobs the reconciliation enqueued for the candidates, as `type@revision`. */
async function reconciled(candidateIds: string[]): Promise<Record<string, string[]>> {
	const rows = await database.db
		.select({ type: jobs.type, payload: jobs.payload, inputVersion: jobs.inputVersion })
		.from(jobs)
		.where(
			and(
				sql`${jobs.createdBy} ->> 'id' = 'derivations.reconcile'`,
				eq(jobs.status, 'queued'),
				inArray(sql`${jobs.payload} ->> 'candidate_id'`, candidateIds)
			)
		);
	const result: Record<string, string[]> = Object.fromEntries(candidateIds.map((id) => [id, []]));
	for (const row of rows) {
		const id = (row.payload as { candidate_id: string }).candidate_id;
		result[id]?.push(`${row.type}@${row.inputVersion}`);
	}
	for (const list of Object.values(result)) list.sort();
	return result;
}

const all = (revision: number) => RECONCILED_TYPES.map((type) => `${type}@${revision}`).sort();

describe('derivations.reconcile', () => {
	it('enqueues each lagging derivation without a waiting or running job at the current revision', async () => {
		const { db } = database;
		const untouched = await createCandidate(db, { profileRevision: 3 });
		const current = await createCandidate(db, { profileRevision: 3 });
		await upToDate(current.id, 3);
		const behind = await createCandidate(db, { profileRevision: 3 });
		await upToDate(behind.id, 2);
		const waiting = await createCandidate(db, { profileRevision: 3 });
		await upToDate(waiting.id, 2);
		await history('evidence.compute', waiting.id, 3, 'queued');
		await history('match.refresh', waiting.id, 2, 'running');
		const lost = await createCandidate(db, { profileRevision: 3 });
		await upToDate(lost.id, 3);
		// The job of the change failed after its attempts; a stale result is not a processed one either.
		await history('profile.embed', lost.id, 4, 'failed');
		await history('match.refresh', lost.id, 4, 'discarded_stale');
		await db.update(candidates).set({ profileRevision: 4 }).where(eq(candidates.id, lost.id));
		const empty = await createCandidate(db, { profileRevision: 0 });
		const leaving = await createCandidate(db, { profileRevision: 3, status: 'deletion_pending' });

		const summary = await reconcile('2026-10-06T10');

		expect(await reconciled([untouched.id, current.id, behind.id, waiting.id, lost.id, empty.id, leaving.id])).toEqual({
			[untouched.id]: all(3),
			[current.id]: [],
			[behind.id]: all(3),
			[waiting.id]: ['profile.embed@3'],
			[lost.id]: all(4),
			[empty.id]: [],
			[leaving.id]: []
		});
		expect(summary).toMatchObject({ joined: 0, capped: false });
	});

	it('counts the published evidence run as processed at its input revision', async () => {
		const { db } = database;
		const taxonomy = await createTaxonomyVersion(db);
		const [ruleset] = await db
			.insert(categorizationRulesets)
			.values({ version: 1, taxonomyVersionId: taxonomy.id, params: {} })
			.returning();
		if (!ruleset) throw new Error('ruleset not inserted');
		const published = async (revision: number, status: 'published' | 'blocked') => {
			const candidate = await createCandidate(db, { profileRevision: 5 });
			await upToDate(candidate.id, 5);
			await db.delete(jobs).where(eq(jobs.dedupKey, dedupKey('evidence.compute', candidate.id)));
			await db.insert(evidenceRuns).values({
				candidateId: candidate.id,
				inputRevision: revision,
				inputSnapshotSha256: randomSha256(),
				inputRefs: {},
				taxonomyVersionId: taxonomy.id,
				rulesetId: ruleset.id,
				asOf: new Date(),
				computedAt: new Date(),
				experienceSummary: {},
				status
			});
			return candidate.id;
		};
		const shown = await published(5, 'published');
		const older = await published(4, 'published');
		// A blocked run is taken off the card: it processes nothing.
		const blocked = await published(5, 'blocked');

		await reconcile('2026-10-06T11');

		expect(await reconciled([shown, older, blocked])).toEqual({
			[shown]: [],
			[older]: ['evidence.compute@5'],
			[blocked]: ['evidence.compute@5']
		});
	});

	it('reconciles a revision once and again after the profile moves', async () => {
		const { db } = database;
		const candidate = await createCandidate(db, { profileRevision: 2 });

		await reconcile('2026-10-06T12');
		expect(await reconciled([candidate.id])).toEqual({ [candidate.id]: all(2) });

		// Its jobs still wait: the next hour adds nothing.
		const next = await reconcile('2026-10-06T13');
		expect(next).toMatchObject({ evidence: 0, embed: 0, match: 0 });

		// They failed: the revision is not retried every hour, the failure stays visible.
		await db
			.update(jobs)
			.set({ status: 'failed', finishedAt: new Date(), attempts: 3 })
			.where(sql`${jobs.payload} ->> 'candidate_id' = ${candidate.id}`);
		await reconcile('2026-10-06T14');
		const [waitingAfterFailure] = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(jobs)
			.where(and(sql`${jobs.payload} ->> 'candidate_id' = ${candidate.id}`, eq(jobs.status, 'queued')));
		expect(waitingAfterFailure?.count).toBe(0);

		await db.update(candidates).set({ profileRevision: 3 }).where(eq(candidates.id, candidate.id));
		await reconcile('2026-10-06T15');
		expect(await reconciled([candidate.id])).toEqual({ [candidate.id]: all(3) });
	});

	it('takes a derivation computed on an earlier rule set for a lagging one, candidates and pools alike', async () => {
		const { db } = database;
		const taxonomy = await createTaxonomyVersion(db, { status: 'published', publishedAt: new Date() });
		const ruleset = async (table: typeof categorizationRulesets | typeof matchRulesets, version: number) => {
			const [row] = await db.insert(table).values({ version, taxonomyVersionId: taxonomy.id, params: {} }).returning();
			if (!row) throw new Error('rule set not inserted');
			return row.id;
		};
		const categorizationV1 = await ruleset(categorizationRulesets, 10);
		await ruleset(matchRulesets, 1);

		const candidate = await createCandidate(db, { profileRevision: 2 });
		await upToDate(candidate.id, 2);
		await db.insert(evidenceRuns).values({
			candidateId: candidate.id,
			inputRevision: 2,
			inputSnapshotSha256: randomSha256(),
			inputRefs: {},
			taxonomyVersionId: taxonomy.id,
			rulesetId: categorizationV1,
			asOf: new Date(),
			computedAt: new Date(),
			experienceSummary: {},
			status: 'published'
		});
		const company = await createCompany(db);
		const member = await createMember(db, company.id);
		const vacancy = await createOwnVacancy(
			db,
			{ companyId: company.id, memberId: member.id, taxonomyVersionId: taxonomy.id },
			{ poolCount: 3, poolCountedAt: new Date() }
		);
		const vacancyKey = `match:vacancy:${vacancy.id}`;
		const counted = async (status: 'succeeded' | 'failed') => {
			await db.insert(jobs).values({
				type: 'match.refresh',
				typeVersion: 1,
				payload: { scope: 'vacancy', vacancy_id: vacancy.id },
				inputVersion: String(vacancy.revision),
				dedupKey: vacancyKey,
				status,
				maxAttempts: 3,
				attempts: 1,
				finishedAt: new Date(),
				createdBy: { kind: 'system' }
			});
		};
		await counted('succeeded');
		const vacancyJobs = async () =>
			db
				.select({ inputVersion: jobs.inputVersion })
				.from(jobs)
				.where(
					and(
						eq(jobs.dedupKey, vacancyKey),
						eq(jobs.status, 'queued'),
						sql`${jobs.createdBy} ->> 'id' = 'derivations.reconcile'`
					)
				);

		const enqueued = async () => ({
			candidate: (await reconciled([candidate.id]))[candidate.id],
			vacancy: (await vacancyJobs()).map((job) => job.inputVersion)
		});
		const none = { candidate: [], vacancy: [] };

		// Everything stands on the rule sets in force.
		await reconcile('2026-10-07T10');
		expect(await enqueued()).toEqual(none);

		// New rule sets: the category, the matches and the pool of the vacancy were computed on the old ones.
		await ruleset(categorizationRulesets, 11);
		await ruleset(matchRulesets, 2);
		await reconcile('2026-10-07T11');
		expect(await enqueued()).toEqual({
			candidate: ['evidence.compute@2', 'match.refresh@2'],
			vacancy: [String(vacancy.revision)]
		});

		// Waiting, then failed: neither is enqueued again under the same rule sets.
		await reconcile('2026-10-07T12');
		expect(await enqueued()).toEqual({
			candidate: ['evidence.compute@2', 'match.refresh@2'],
			vacancy: [String(vacancy.revision)]
		});
		await db
			.update(jobs)
			.set({ status: 'failed', finishedAt: new Date(), attempts: 3 })
			.where(and(eq(jobs.status, 'queued'), sql`${jobs.createdBy} ->> 'id' = 'derivations.reconcile'`));
		await reconcile('2026-10-07T13');
		expect(await enqueued()).toEqual(none);

		// A recount of the pool under the rule set in force is processing, whatever its revision.
		await ruleset(matchRulesets, 3);
		await counted('succeeded');
		await reconcile('2026-10-07T14');
		expect(await enqueued()).toEqual({ candidate: ['match.refresh@2'], vacancy: [] });
	});

	it('continues itself while more derivations lag than one run enqueues', async () => {
		const { db } = database;
		// Every derivation of these candidates lags: more than one run enqueues.
		const count = Math.floor(MAX_ENQUEUED_PER_RUN / RECONCILED_TYPES.length) + 1;
		const accounts = await db
			.insert(users)
			.values(
				Array.from({ length: count }, () => ({
					status: 'active' as const,
					emailEnc: randomBytes(40),
					emailHmac: randomBytes(32).toString('hex')
				}))
			)
			.returning({ id: users.id });
		const lagging = await db
			.insert(candidates)
			.values(
				accounts.map((account) => ({
					userId: account.id,
					status: 'active' as const,
					searchStatus: 'active' as const,
					preferences: {},
					profileRevision: 1
				}))
			)
			.returning({ id: candidates.id });
		const ids = lagging.map((candidate) => candidate.id);
		const waitingRuns = () =>
			db
				.select({ dedupKey: jobs.dedupKey, inputVersion: jobs.inputVersion })
				.from(jobs)
				.where(and(eq(jobs.type, 'derivations.reconcile'), eq(jobs.status, 'queued')));

		expect(await reconcile('2026-10-08T10')).toMatchObject({ capped: true });
		expect(await waitingRuns()).toEqual([{ dedupKey: 'reconcile:2026-10-08T10', inputVersion: '2026-10-08T10' }]);

		expect(await runWaiting()).toMatchObject({ capped: false });
		expect(await waitingRuns()).toEqual([]);
		expect(Object.values(await reconciled(ids))).toEqual(ids.map(() => all(1)));
	});
});
