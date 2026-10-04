// Retention of the stored files of attempt artifacts (docs/domain.md 10.4, 15.1): `retention.sweep` removes the object
// of an expired artifact from the bucket first and then its `files` row and the reference, keeping the artifact row
// with its hash; a failed removal leaves every row in place and the next attempt removes the same object again.
import { eq, sql } from 'drizzle-orm';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	assessmentArtifacts,
	assessmentAttempts,
	assessments,
	assessmentVersions,
	files,
	jobs
} from '$lib/server/db/schema';
import { JobFailure } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, enqueueJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { createRetentionSweepHandler } from '$lib/server/jobs/retention';
import { S3ObjectStore, StorageError, type ObjectStore } from '$lib/server/storage/object-store';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate } from '../helpers/factories';
import { startStorage } from '../helpers/storage';

let database: TestDatabase;
let storage: StartedTestContainer;
let s3: ObjectStore;

/** The bucket, with removals refused while `failing` is set. */
class FlakyStore implements ObjectStore {
	failing = false;
	readonly inner: ObjectStore;
	constructor(inner: ObjectStore) {
		this.inner = inner;
	}
	put(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string) {
		return this.inner.put(key, bytes, contentType);
	}
	get(key: string, signal?: AbortSignal) {
		return this.inner.get(key, signal);
	}
	exists(key: string) {
		return this.inner.exists(key);
	}
	delete(key: string): Promise<void> {
		if (this.failing) return Promise.reject(new StorageError('storage is down', { retryable: true }));
		return this.inner.delete(key);
	}
}
let store: FlakyStore;

beforeAll(async () => {
	const [started, created] = await Promise.all([startStorage(), createTestDatabase()]);
	storage = started.container;
	database = created;
	s3 = new S3ObjectStore(started.settings);
	store = new FlakyStore(s3);
}, 180_000);

afterAll(async () => {
	await database.drop();
	await storage.stop();
});

const handler = createRetentionSweepHandler(() => ({ store }));
const log = createLogger({}, () => undefined);

/** Claims the due sweep and runs it once; returns how the job ended. */
async function sweepOnce(): Promise<'succeeded' | 'queued' | 'failed'> {
	const claimed = (await claimJob(database.db, 'retention-test', [
		'retention.sweep'
	])) as ClaimedJob<'retention.sweep'> | null;
	if (!claimed) throw new Error('no retention.sweep job is due');
	try {
		const result = await handler.run({
			job: claimed,
			db: database.db,
			signal: new AbortController().signal,
			requestId: `job:${claimed.id}`,
			log
		});
		const outcome = await completeJob(database.db, claimed, result);
		if (outcome !== 'succeeded') throw new Error(`sweep ended ${outcome}`);
		return outcome;
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		const outcome = await failJob(database.db, claimed, {
			code: error.code,
			retryable: error.retryable,
			message: error.message
		});
		if (outcome !== 'queued' && outcome !== 'failed')
			throw new Error(`sweep failure ended ${outcome}`, { cause: error });
		return outcome;
	}
}

async function attemptOf(candidateId: string): Promise<string> {
	const { db } = database;
	const [assessment] = await db
		.insert(assessments)
		.values({ kind: 'code_task', title: 'Go', skillKeys: ['go'] })
		.returning({ id: assessments.id });
	if (!assessment) throw new Error('assessment not inserted');
	const [version] = await db
		.insert(assessmentVersions)
		.values({
			assessmentId: assessment.id,
			version: 1,
			contentSha256: 'a'.repeat(64),
			scorer: {},
			levelScale: {},
			coverage: {},
			status: 'published'
		})
		.returning({ id: assessmentVersions.id });
	if (!version) throw new Error('assessment version not inserted');
	const startedAt = new Date('2020-03-01T10:00:00Z');
	const [attempt] = await db
		.insert(assessmentAttempts)
		.values({
			candidateId,
			versionId: version.id,
			startedAt,
			submittedAt: startedAt,
			deadlineAt: new Date('2020-03-01T11:00:00Z'),
			status: 'submitted'
		})
		.returning({ id: assessmentAttempts.id });
	if (!attempt) throw new Error('attempt not inserted');
	return attempt.id;
}

/** A code submission stored in the bucket, kept until `retentionUntil`. */
async function storedArtifact(input: { ownerUserId: string; attemptId: string; seq: number; retentionUntil: string }) {
	const { db } = database;
	const fileId = crypto.randomUUID();
	const storageKey = `assessment_artifact/${fileId}`;
	const bytes = new TextEncoder().encode(`package main // ${input.seq}`);
	await s3.put(storageKey, bytes, 'text/plain');
	await db.insert(files).values({
		id: fileId,
		ownerUserId: input.ownerUserId,
		purpose: 'assessment_artifact',
		storageKey,
		sha256: 'd'.repeat(64),
		sizeBytes: bytes.byteLength,
		declaredName: 'main.go',
		detectedMime: 'text/plain',
		status: 'ready'
	});
	const [artifact] = await db
		.insert(assessmentArtifacts)
		.values({
			attemptId: input.attemptId,
			seq: input.seq,
			kind: 'code_submission',
			content: { language: 'go' },
			fileId,
			sha256: 'e'.repeat(64),
			retentionUntil: input.retentionUntil
		})
		.returning({ id: assessmentArtifacts.id });
	if (!artifact) throw new Error('artifact not inserted');
	return { artifactId: artifact.id, fileId, storageKey };
}

describe('retention.sweep over attempt artifact files', () => {
	it('removes the object, then the file row and the reference; a failed removal is repeated without loss', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const attemptId = await attemptOf(candidate.id);
		const expired = await storedArtifact({
			ownerUserId: candidate.userId,
			attemptId,
			seq: 1,
			retentionUntil: '2021-03-01'
		});
		const kept = await storedArtifact({
			ownerUserId: candidate.userId,
			attemptId,
			seq: 2,
			retentionUntil: '2100-01-01'
		});
		const { jobId } = await db.transaction((tx) =>
			enqueueJob(
				tx,
				'retention.sweep',
				{ date: '2026-10-08' },
				{ inputVersion: '2026-10-08', createdBy: { kind: 'system' } }
			)
		);

		store.failing = true;
		expect(await sweepOnce()).toBe('queued');
		const [job] = await db.select({ lastError: jobs.lastError }).from(jobs).where(eq(jobs.id, jobId));
		expect(job?.lastError).toMatchObject({ code: 'storage_unavailable', retryable: true });
		// Nothing was removed: the row, the reference and the object wait for the next attempt.
		expect(await db.select().from(files).where(eq(files.id, expired.fileId))).toHaveLength(1);
		const [waiting] = await db
			.select({ fileId: assessmentArtifacts.fileId, content: assessmentArtifacts.content })
			.from(assessmentArtifacts)
			.where(eq(assessmentArtifacts.id, expired.artifactId));
		expect(waiting).toEqual({ fileId: expired.fileId, content: { language: 'go' } });
		expect(await s3.exists(expired.storageKey)).toBe(true);

		store.failing = false;
		await db
			.update(jobs)
			.set({ runAfter: sql`now() - interval '1 second'` })
			.where(eq(jobs.id, jobId));
		expect(await sweepOnce()).toBe('succeeded');
		expect(await s3.exists(expired.storageKey)).toBe(false);
		expect(await db.select().from(files).where(eq(files.id, expired.fileId))).toEqual([]);
		const rows = await db
			.select({
				id: assessmentArtifacts.id,
				fileId: assessmentArtifacts.fileId,
				content: assessmentArtifacts.content,
				sha256: assessmentArtifacts.sha256
			})
			.from(assessmentArtifacts)
			.where(eq(assessmentArtifacts.attemptId, attemptId))
			.orderBy(assessmentArtifacts.seq);
		expect(rows).toEqual([
			{ id: expired.artifactId, fileId: null, content: null, sha256: 'e'.repeat(64) },
			{ id: kept.artifactId, fileId: kept.fileId, content: { language: 'go' }, sha256: 'e'.repeat(64) }
		]);
		// The artifact inside its retention keeps its file and object.
		expect(await db.select().from(files).where(eq(files.id, kept.fileId))).toHaveLength(1);
		expect(await s3.exists(kept.storageKey)).toBe(true);
	});
});
