import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Executor } from '$lib/server/db';
import { candidates, jobs } from '$lib/server/db/schema';
import { claimJob, completeJob, enqueueJob, failJob, recoverExpiredLeases } from '$lib/server/jobs/queue';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { expectDbError, SQLSTATE } from '../helpers/errors';
import { createCandidate } from '../helpers/factories';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.drop();
});

const system = { kind: 'system' as const };

/** A profile change: the revision moves and the recalculation is enqueued in the same transaction. */
async function changeProfile(db: Executor, candidateId: string): Promise<{ revision: number; joined: boolean }> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.update(candidates)
			.set({ profileRevision: sql`${candidates.profileRevision} + 1` })
			.where(eq(candidates.id, candidateId))
			.returning({ revision: candidates.profileRevision });
		if (!row) throw new Error('candidate not found');
		const { joined } = await enqueueJob(
			tx,
			'categorization.compute',
			{ candidate_id: candidateId },
			{
				inputVersion: String(row.revision),
				createdBy: system
			}
		);
		return { revision: row.revision, joined };
	});
}

async function currentRevision(db: Executor, candidateId: string): Promise<number> {
	const [row] = await db
		.select({ revision: candidates.profileRevision })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error('candidate not found');
	return row.revision;
}

describe('job queue', () => {
	it('processes revision 2 that arrives while revision 1 runs', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);

		expect(await changeProfile(db, candidate.id)).toEqual({ revision: 1, joined: false });
		const first = await claimJob(db, 'worker-a', ['categorization.compute']);
		if (!first) throw new Error('revision 1 was not captured');
		const seenByFirst = await currentRevision(db, candidate.id);

		// Revision 2 arrives while revision 1 runs: a new waiting job; revision 3 joins it.
		expect(await changeProfile(db, candidate.id)).toEqual({ revision: 2, joined: false });
		expect(await changeProfile(db, candidate.id)).toEqual({ revision: 3, joined: true });
		// The waiting job is not captured while the job of the same key runs.
		expect(await claimJob(db, 'worker-b', ['categorization.compute'])).toBeNull();

		const written: number[] = [];
		const firstOutcome = await completeJob(db, first, {
			isCurrent: async (tx) => (await currentRevision(tx, candidate.id)) === seenByFirst,
			write: () => {
				written.push(seenByFirst);
				return Promise.resolve();
			}
		});
		expect(firstOutcome).toBe('discarded_stale');

		const second = await claimJob(db, 'worker-b', ['categorization.compute']);
		if (!second) throw new Error('the waiting job was lost');
		const seenBySecond = await currentRevision(db, candidate.id);
		expect(seenBySecond).toBe(3);
		const secondOutcome = await completeJob(db, second, {
			isCurrent: async (tx) => (await currentRevision(tx, candidate.id)) === seenBySecond,
			write: () => {
				written.push(seenBySecond);
				return Promise.resolve();
			}
		});
		expect(secondOutcome).toBe('succeeded');
		expect(written).toEqual([3]);

		const rows = await db
			.select({ status: jobs.status })
			.from(jobs)
			.where(eq(jobs.dedupKey, `categorization:${candidate.id}`))
			.orderBy(jobs.createdAt);
		expect(rows.map((row) => row.status)).toEqual(['discarded_stale', 'succeeded']);
	});

	it('enqueues nothing when the change is rolled back', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		await expect(
			db.transaction(async (tx) => {
				await enqueueJob(
					tx,
					'categorization.compute',
					{ candidate_id: candidate.id },
					{ inputVersion: '1', createdBy: system }
				);
				throw new Error('change failed');
			})
		).rejects.toThrow('change failed');
		const rows = await db
			.select()
			.from(jobs)
			.where(eq(jobs.dedupKey, `categorization:${candidate.id}`));
		expect(rows).toEqual([]);
	});

	it('keeps one running job per key even against a direct update', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		await changeProfile(db, candidate.id);
		const running = await claimJob(db, 'worker-a', ['categorization.compute']);
		if (!running) throw new Error('not captured');
		await changeProfile(db, candidate.id);
		await expectDbError(
			db
				.update(jobs)
				.set({ status: 'running', leaseOwner: 'rogue', leaseExpiresAt: sql`now() + interval '1 minute'` })
				.where(and(eq(jobs.dedupKey, `categorization:${candidate.id}`), eq(jobs.status, 'queued'))),
			SQLSTATE.uniqueViolation
		);
	});

	it('returns a job of a crashed worker to the queue and retries it', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		await db.transaction((tx) =>
			enqueueJob(tx, 'profile.embed', { candidate_id: candidate.id }, { inputVersion: '0', createdBy: system })
		);
		const claimed = await claimJob(db, 'worker-a', ['profile.embed']);
		if (!claimed) throw new Error('not captured');
		await db
			.update(jobs)
			.set({ leaseExpiresAt: sql`now() - interval '1 second'` })
			.where(eq(jobs.id, claimed.id));
		expect(await recoverExpiredLeases(db)).toBe(1);
		// The crashed worker can no longer write its result.
		expect(
			await completeJob(db, claimed, { isCurrent: () => Promise.resolve(true), write: () => Promise.resolve() })
		).toBe('lease_lost');
		await db
			.update(jobs)
			.set({ runAfter: sql`now()` })
			.where(eq(jobs.id, claimed.id));
		const retried = await claimJob(db, 'worker-b', ['profile.embed']);
		expect(retried?.id).toBe(claimed.id);
		expect(retried?.attempt).toBe(2);
	});

	it('fails a job on a permanent error', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		await db.transaction((tx) =>
			enqueueJob(
				tx,
				'candidate.majority_transition',
				{ candidate_id: candidate.id },
				{ inputVersion: '2026-10-05', createdBy: system }
			)
		);
		const claimed = await claimJob(db, 'worker-a', ['candidate.majority_transition']);
		if (!claimed) throw new Error('not captured');
		expect(await failJob(db, claimed, { code: 'invalid_state', retryable: false, message: 'no birth date' })).toBe(
			'failed'
		);
		const [row] = await db.select().from(jobs).where(eq(jobs.id, claimed.id));
		expect(row?.status).toBe('failed');
		expect(row?.lastError).toEqual({ code: 'invalid_state', retryable: false, message: 'no birth date' });
	});
});
