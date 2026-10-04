// The erasure ledger applied again after a restore (docs/domain.md, section 19.2; case 39): a backup is taken, then a
// candidate deletes the account, a staff member whose role was taken away deletes theirs and a demo session is removed.
// The dump restored from before all that brings them back, with a ledger that does not name them; the ledger exported
// from the live database before the restore, replayed into the restored one, erases the candidate again — rows, the
// object restored into the bucket, the request moment of the ledger kept — removes the demo session, and leaves the
// staff account as restored, named with its reason. A second replay changes nothing.
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { Database } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import {
	auditEvents,
	candidates,
	consentEvents,
	demoSessions,
	erasureLedger,
	files,
	staffRoles,
	users
} from '$lib/server/db/schema';
import { purgeDemoSession } from '$lib/server/demo/purge';
import { purgeAccountNow } from '$lib/server/erasure/purge';
import {
	exportLedger,
	formatLedger,
	parseLedger,
	replayLedger,
	type ReplayDeps
} from '$lib/server/erasure/replay/ledger';
import { beginAccountDeletion } from '$lib/server/erasure/request';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore, StoredObject } from '$lib/server/storage/object-store';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { testEnvironment } from '../helpers/environment';
import { createCandidate, createUser, randomSha256 } from '../helpers/factories';

const REDIS_DATABASE = 13;

const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

/** The bucket: objects by key. */
class MemoryStore implements ObjectStore {
	readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
	put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
		this.objects.set(key, bytes);
		return Promise.resolve();
	}
	get(key: string): Promise<StoredObject | null> {
		if (!this.objects.has(key)) return Promise.resolve(null);
		throw new Error('the replay reads no object');
	}
	delete(key: string): Promise<void> {
		this.objects.delete(key);
		return Promise.resolve();
	}
	exists(key: string): Promise<boolean> {
		return Promise.resolve(this.objects.has(key));
	}
}

let live: TestDatabase;
let restoredName: string;
let restoredClient: postgres.Sql;
let restored: Database;
let redis: Redis;
const store = new MemoryStore();

const people = { candidate: '', candidateProfile: '', resumeKey: '', bystander: '', staff: '', clone: '', session: '' };
let exported = '';
let requestedAt: Date;

async function adminSql<T>(work: (admin: postgres.Sql) => Promise<T>): Promise<T> {
	const admin = postgres(inject('databaseUrl'), { max: 1, onnotice: () => undefined });
	try {
		return await work(admin);
	} finally {
		await admin.end({ timeout: 5 });
	}
}

const deps = (db: Database): ReplayDeps => ({ db, redis, store, now: () => new Date() });

beforeAll(async () => {
	live = await createTestDatabase();
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
	Object.assign(env, testEnvironment({ DATABASE_URL: live.url, REDIS_URL: `${inject('redisUrl')}/${REDIS_DATABASE}` }));
	const db = live.db;

	// The live stand before the backup.
	const candidate = await createCandidate(db);
	people.candidate = candidate.userId;
	people.candidateProfile = candidate.id;
	people.resumeKey = `resume/${crypto.randomUUID()}`;
	await db.insert(files).values({
		ownerUserId: candidate.userId,
		purpose: 'resume',
		storageKey: people.resumeKey,
		sha256: randomSha256(),
		sizeBytes: 3,
		declaredName: 'resume.pdf',
		detectedMime: 'application/pdf',
		status: 'ready'
	});
	await store.put(people.resumeKey, new Uint8Array([1, 2, 3]));
	people.bystander = (await createCandidate(db)).userId;
	const staff = await createCandidate(db);
	people.staff = staff.userId;
	await db.insert(staffRoles).values({ userId: staff.userId, role: 'operator', grantedAt: new Date() });
	const [session] = await db
		.insert(demoSessions)
		.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-test', expiresAt: new Date(Date.now() + 3_600_000) })
		.returning({ id: demoSessions.id });
	if (!session) throw new Error('demo session not inserted');
	people.session = session.id;
	people.clone = (await createUser(db, { demoSessionId: session.id })).id;

	// The backup: a copy of the live database as it is now.
	await live.sql.end({ timeout: 5 });
	const liveName = new URL(live.url).pathname.slice(1);
	restoredName = `restored_${randomBytes(5).toString('hex')}`;
	await adminSql((admin) => admin.unsafe(`create database ${restoredName} template ${liveName}`));
	const liveClient = postgres(live.url, { max: 4, onnotice: () => undefined });
	const liveDb = drizzle({ client: liveClient, schema, casing: 'snake_case' });

	// After the backup: the candidate deletes the account, the staff member loses the role and deletes theirs, the demo
	// session of a visitor who uploaded a resume of their own is removed and its account enters the ledger.
	requestedAt = new Date(Date.now() - 60_000);
	for (const userId of [people.candidate, people.staff]) {
		if (userId === people.staff) {
			await liveDb
				.update(staffRoles)
				.set({ revokedAt: requestedAt, revokedBy: people.bystander })
				.where(eq(staffRoles.userId, userId));
		}
		const refusal = await liveDb.transaction((tx) =>
			beginAccountDeletion(tx, {
				userId,
				cause: 'account_deleted',
				actor: { kind: 'user', userId },
				requestId: 'replay-test:live',
				at: requestedAt
			})
		);
		expect(refusal).toBeNull();
		await purgeAccountNow(deps(liveDb), userId, 'replay-test:live');
	}
	await purgeDemoSession(deps(liveDb), people.session, new Date(), 'replay-test:live');
	await liveDb.insert(erasureLedger).values({ userId: people.clone, requestedAt, purgedAt: new Date() });
	expect(store.objects.has(people.resumeKey)).toBe(false);

	// Before the restore: the ledger is exported from the live database.
	exported = formatLedger(await exportLedger(liveDb));
	await liveClient.end({ timeout: 5 });

	// The restore: the dump of the backup, and the files of the bucket from its mirror of the same time.
	const restoredUrl = new URL(live.url);
	restoredUrl.pathname = `/${restoredName}`;
	restoredClient = postgres(restoredUrl.toString(), { max: 4, onnotice: () => undefined });
	restored = drizzle({ client: restoredClient, schema, casing: 'snake_case' });
	await store.put(people.resumeKey, new Uint8Array([1, 2, 3]));
});

afterAll(async () => {
	await restoredClient.end({ timeout: 5 });
	await adminSql(async (admin) => {
		await admin.unsafe(`drop database if exists ${restoredName} with (force)`);
		await admin.unsafe(`drop database if exists ${new URL(live.url).pathname.slice(1)} with (force)`);
	});
	await redis.quit();
});

const statusOf = async (userId: string) =>
	(await restored.select({ status: users.status }).from(users).where(eq(users.id, userId)))[0]?.status;

describe('the erasure ledger after a restore', () => {
	it('exports one line per entry that reads back as the same entries', () => {
		const entries = parseLedger(exported);
		expect(entries.map((entry) => entry.userId).sort()).toEqual([people.candidate, people.staff, people.clone].sort());
		expect(formatLedger(entries)).toBe(exported);
		expect(() => parseLedger(`${exported}{"user_id":"x"}\n`)).toThrow(/line 4 of the ledger is not an entry/);
	});

	it('brings the deleted people back, and a replay erases them again except the one it must not touch', async () => {
		// The restore brought everything back and the ledger does not name them.
		expect(await statusOf(people.candidate)).toBe('active');
		expect(await statusOf(people.staff)).toBe('active');
		expect(await statusOf(people.clone)).toBe('active');
		expect(await restored.select().from(erasureLedger)).toEqual([]);

		const summary = await replayLedger(deps(restored), parseLedger(exported), 'replay-test:restore');

		expect(summary.outcomes).toEqual({ deleted_again: 1, purged: 0, demo_session_removed: 1, already_erased: 0 });
		expect(summary.refused).toEqual([{ userId: people.staff, reason: 'staff_role' }]);

		// The candidate: a tombstone again, the profile too, the resume gone from the rows and from the bucket.
		const [account] = await restored.select().from(users).where(eq(users.id, people.candidate));
		expect(account).toMatchObject({ status: 'deleted', emailEnc: null, emailHmac: null });
		const [profile] = await restored.select().from(candidates).where(eq(candidates.id, people.candidateProfile));
		expect(profile).toMatchObject({ status: 'deleted', birthDate: null, visibility: 'hidden' });
		expect(await restored.select().from(files).where(eq(files.ownerUserId, people.candidate))).toEqual([]);
		expect(store.objects.has(people.resumeKey)).toBe(false);
		expect(
			await restored.select().from(consentEvents).where(eq(consentEvents.subjectCandidateId, people.candidateProfile))
		).toEqual([]);
		// The deletion began again as the system's act, not the person's.
		const requested = await restored
			.select({ actorKind: auditEvents.actorKind, cause: sql<string>`${auditEvents.details} ->> 'cause'` })
			.from(auditEvents)
			.where(eq(auditEvents.action, 'account.deletion_requested'));
		expect(requested).toEqual([{ actorKind: 'system', cause: 'ledger_replay' }]);
		const consent = await restored
			.select({ action: auditEvents.action, actorKind: auditEvents.actorKind })
			.from(auditEvents)
			.where(eq(auditEvents.subjectCandidateId, people.candidateProfile));
		expect(consent).toContainEqual({ action: 'consent.lapsed', actorKind: 'system' });
		expect(consent.map((event) => event.action)).not.toContain('consent.revoked');
		// The ledger names the candidate with the moment of the request, and the purge of the replay.
		const [entry] = await restored.select().from(erasureLedger).where(eq(erasureLedger.userId, people.candidate));
		expect(entry?.requestedAt.getTime()).toBe(requestedAt.getTime());
		expect(entry?.purgedAt).not.toBeNull();

		// The demo session went with its clone.
		expect(await restored.select().from(demoSessions).where(eq(demoSessions.id, people.session))).toEqual([]);
		expect(await statusOf(people.clone)).toBeUndefined();

		// The staff account is left as restored, with its role, for the operator to decide.
		expect(await statusOf(people.staff)).toBe('active');
		expect(await restored.select().from(erasureLedger).where(eq(erasureLedger.userId, people.staff))).toEqual([]);

		// The bystander is untouched.
		expect(await statusOf(people.bystander)).toBe('active');
	});

	it('changes nothing on a second replay of the same export', async () => {
		const journal = async () => (await restored.select({ id: auditEvents.id }).from(auditEvents)).length;
		const before = await journal();
		const summary = await replayLedger(deps(restored), parseLedger(exported), 'replay-test:again');
		expect(summary.outcomes).toEqual({ deleted_again: 0, purged: 0, demo_session_removed: 0, already_erased: 2 });
		expect(summary.refused).toEqual([{ userId: people.staff, reason: 'staff_role' }]);
		expect(await journal()).toBe(before);
	});
});
