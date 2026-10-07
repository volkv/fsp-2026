// Reset of the demonstration stand (docs/domain.md, section 19.2; counterexample 46): every table of the schema has a
// decision — reference data stay, demonstration data go — and a table without one stops the reset. Append-only tables
// are emptied, and their guards are in force again after the reset.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { publishLegalDocuments, readLegalRelease } from '../../scripts/seed-legal';
import { publishPolicies, readPolicyRelease } from '../../scripts/seed-policies';
import { ensureBootstrapAdmin } from '$lib/server/admin/bootstrap/ensure';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	candidates,
	consentEvents,
	demoSessions,
	embeddingSpaces,
	files,
	jobs,
	notificationChannels,
	notificationPreferences,
	passwordCredentials,
	searchSettings,
	staffRoles,
	users
} from '$lib/server/db/schema';
import {
	compareWithPlan,
	DEMO_RESET_PLAN,
	DemoResetPlanMismatch,
	resetDemo,
	schemaTables
} from '$lib/server/demo/reset';
import { recordAuditEvent } from '$lib/server/audit/record';
import { currentDocument } from '$lib/server/auth/documents';
import { enqueueDemoReindex } from '$lib/server/demo/job';
import { BGE_M3_Q8 } from '$lib/server/embeddings/definitions';
import { enqueueJob } from '$lib/server/jobs/queue';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore, StoredObject } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { expectDbError, SQLSTATE } from '../helpers/errors';
import { createCandidate, createUser } from '../helpers/factories';

const ROOT = new URL('../../', import.meta.url);
const REDIS_DATABASE = 7;

let database: TestDatabase;
let redis: Redis;

/** Objects by key; the reset removes those of the removed files. */
class RecordingStore implements ObjectStore {
	readonly objects = new Map<string, Uint8Array>();
	put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
		this.objects.set(key, bytes);
		return Promise.resolve();
	}
	get(): Promise<StoredObject | null> {
		return Promise.resolve(null);
	}
	delete(key: string): Promise<void> {
		this.objects.delete(key);
		return Promise.resolve();
	}
	exists(key: string): Promise<boolean> {
		return Promise.resolve(this.objects.has(key));
	}
}

/** The simulator's control endpoint as the reset calls it. */
function simulator() {
	const calls: string[] = [];
	const fetch: typeof globalThis.fetch = (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push(`${init?.method ?? 'GET'} ${url}`);
		return Promise.resolve(new Response(null, { status: 204 }));
	};
	return { calls, fetch };
}

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(fileURLToPath(new URL('taxonomy', ROOT)))));
		await publishLegalDocuments(client, await readLegalRelease(fileURLToPath(new URL('legal', ROOT))));
		await publishPolicies(client, await readPolicyRelease(fileURLToPath(new URL('policies', ROOT))));
	} finally {
		await client.end({ timeout: 5 });
	}
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
});

afterAll(async () => {
	redis.destroy();
	await database.drop();
});

const countOf = async (table: string) => {
	const [row] = await database.sql<{ n: number }[]>`select count(*)::int as n from ${database.sql(table)}`;
	return row?.n ?? 0;
};

describe('demo reset plan', () => {
	it('has a decision for every table of the migrated schema and names no other table', async () => {
		const tables = await schemaTables(database.db);
		expect(tables.length).toBeGreaterThan(70);
		expect(compareWithPlan(tables)).toEqual({ unplanned: [], missing: [] });
		// Reference data are few and named: taxonomy, legal texts, policies, rule sets, bank, sources, spaces, runs.
		const reference = Object.entries(DEMO_RESET_PLAN).filter(([, d]) => d.kind === 'reference');
		expect(reference.map(([table]) => table)).toContain('legal_documents');
		expect(reference.map(([table]) => table)).not.toContain('users');
	});

	it('refuses to run while the database has a table without a decision', async () => {
		const store = new RecordingStore();
		const mock = simulator();
		await database.sql`create table demo_probe (id integer primary key)`;
		try {
			const refusal = resetDemo(
				{
					db: database.db,
					redis,
					store,
					fspMock: { origin: 'http://simulator.test', controlToken: 'x'.repeat(32) },
					fetch: mock.fetch
				},
				{ requestId: 'test', trigger: 'manual' }
			);
			await expect(refusal).rejects.toThrow(DemoResetPlanMismatch);
			await expect(refusal).rejects.toThrow(/demo_probe/);
			expect(mock.calls).toEqual([]);
		} finally {
			await database.sql`drop table demo_probe`;
		}
	});
});

describe('demo reset', () => {
	it('empties the demonstration data and keeps the reference data, the reset jobs and the guards', async () => {
		const { db } = database;
		const store = new RecordingStore();
		const mock = simulator();

		// Demonstration data across the modules, append-only tables among them.
		const candidate = await createCandidate(db, { seedBatchId: 'demo-test' });
		const document = await currentDocument(db, 'catalog_visibility', new Date());
		if (!document) throw new Error('catalog consent text is not published');
		await db.insert(consentEvents).values({
			subjectCandidateId: candidate.id,
			kind: 'catalog_visibility',
			documentId: document.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: candidate.userId,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date()
		});
		const storageKey = `resume/${crypto.randomUUID()}`;
		await store.put(storageKey, Uint8Array.from([1, 2, 3]));
		await db.insert(files).values({
			ownerUserId: candidate.userId,
			purpose: 'resume',
			storageKey,
			sha256: randomBytes(32).toString('hex'),
			sizeBytes: 3,
			declaredName: 'resume.txt',
			detectedMime: 'text/plain',
			status: 'ready'
		});
		await recordAuditEvent(db, {
			action: 'auth.logout',
			outcome: 'success',
			actor: { kind: 'user', userId: candidate.userId },
			requestId: 'test'
		});
		await db.transaction(async (tx) => {
			await enqueueJob(
				tx,
				'evidence.compute',
				{ candidate_id: candidate.id },
				{ inputVersion: '1', createdBy: { kind: 'system' } }
			);
			await enqueueJob(
				tx,
				'demo.reset',
				{ kind: 'nightly', date: '2026-10-12' },
				{ inputVersion: 'x', createdBy: { kind: 'system' } }
			);
		});
		await redis.set('session:probe', '1');

		const reference = {
			legal: await countOf('legal_documents'),
			policies: await countOf('product_policies'),
			taxonomy: await countOf('taxonomy_versions'),
			skills: await countOf('skills')
		};
		expect(reference.legal).toBeGreaterThan(0);

		const summary = await resetDemo(
			{
				db,
				redis,
				store,
				fspMock: { origin: 'http://simulator.test', controlToken: 'x'.repeat(32) },
				fetch: mock.fetch
			},
			{ requestId: 'demo-reset-test', trigger: 'manual' }
		);

		for (const [table, decision] of Object.entries(DEMO_RESET_PLAN)) {
			if (decision.kind === 'clear' && table !== 'audit_events') expect(await countOf(table), table).toBe(0);
		}
		expect(await db.select().from(users)).toEqual([]);
		expect(await db.select().from(candidates)).toEqual([]);
		// The reset job of the night stays; so does the journal event of the reset itself, and nothing else.
		expect((await db.select({ type: jobs.type }).from(jobs)).map((j) => j.type)).toEqual(['demo.reset']);
		const events = await db.select({ action: auditEvents.action, details: auditEvents.details }).from(auditEvents);
		expect(events).toEqual([
			{
				action: 'demo.reset',
				details: {
					trigger: 'manual',
					tables_cleared: summary.tablesCleared,
					rows_kept: summary.rowsKept,
					files_removed: 1
				}
			}
		]);
		expect(summary.filesRemoved).toBe(1);
		expect(store.objects.has(storageKey)).toBe(false);
		expect(await redis.get('session:probe')).toBeNull();
		expect(mock.calls).toEqual(['POST http://simulator.test/mock/reset']);

		expect(await countOf('legal_documents')).toBe(reference.legal);
		expect(await countOf('product_policies')).toBe(reference.policies);
		expect(await countOf('taxonomy_versions')).toBe(reference.taxonomy);
		expect(await countOf('skills')).toBe(reference.skills);
		expect(await db.select().from(files).where(eq(files.storageKey, storageKey))).toEqual([]);

		// The append-only guards are in force again: the reset switched them off inside its own transaction only.
		const again = await createCandidate(db);
		await db.insert(consentEvents).values({
			subjectCandidateId: again.id,
			kind: 'catalog_visibility',
			documentId: document.id,
			action: 'grant',
			signerKind: 'subject',
			signerUserId: again.userId,
			method: 'separate_screen_button',
			evidence: {},
			occurredAt: new Date()
		});
		await expectDbError(database.sql`delete from consent_events`, SQLSTATE.restrictViolation);
		await expectDbError(database.sql`truncate consent_events cascade`, SQLSTATE.restrictViolation);
	});
});

describe('demo reset and the real staff', () => {
	it('keeps the bootstrap administrator with its password, role and email, and the staff it named; demo accounts go', async () => {
		const { db } = database;
		const crypto = createFieldCrypto({
			keys: new Map([[1, Buffer.alloc(32, 1)]]),
			activeVersion: 1,
			hmacSecret: Buffer.alloc(32, 2)
		});
		const deps = { db, crypto, redis: () => Promise.resolve(redis), now: () => new Date() };
		const input = {
			email: 'stand-admin@example.org',
			password: 'stand administrator 2026',
			resetPassword: false,
			requestId: 'test'
		};
		const admin = await ensureBootstrapAdmin(deps, input);
		// An operator the administrator named, and a real visitor without a role.
		const operator = await createUser(db);
		await db
			.insert(staffRoles)
			.values({ userId: operator.id, role: 'operator', grantedBy: admin.userId, grantedAt: new Date() });
		const visitor = await createUser(db);
		// The administrator of the seed and a clone of it in a demo session.
		const seedAdmin = await createUser(db, { seedBatchId: 'demo-test' });
		await db.insert(staffRoles).values({ userId: seedAdmin.id, role: 'admin', grantedBy: null, grantedAt: new Date() });
		const [session] = await db
			.insert(demoSessions)
			.values({
				joinTokenSha256: randomBytes(32).toString('hex'),
				seedBatchId: 'demo-test',
				expiresAt: new Date(Date.now() + 86_400_000)
			})
			.returning({ id: demoSessions.id });
		if (!session) throw new Error('demo session not inserted');
		const clone = await createUser(db, { seedBatchId: 'demo-test', demoSessionId: session.id });
		await db.insert(staffRoles).values({ userId: clone.id, role: 'admin', grantedBy: null, grantedAt: new Date() });
		// Email channels of everyone, the operator's settings of notifications and a visitor's.
		for (const userId of [operator.id, visitor.id, seedAdmin.id, clone.id]) {
			await db.insert(notificationChannels).values({ userId, kind: 'email', status: 'active', linkedAt: new Date() });
		}
		for (const userId of [operator.id, visitor.id]) {
			await db.insert(notificationPreferences).values({ userId, category: 'objections', channels: [] });
		}
		const [hashBefore] = await db
			.select({ hash: passwordCredentials.hash })
			.from(passwordCredentials)
			.where(eq(passwordCredentials.userId, admin.userId));

		await resetDemo(
			{
				db,
				redis,
				store: new RecordingStore(),
				fspMock: { origin: 'http://simulator.test', controlToken: 'x'.repeat(32) },
				fetch: simulator().fetch
			},
			{ requestId: 'demo-reset-staff', trigger: 'manual' }
		);

		const kept = await db.select({ id: users.id }).from(users);
		expect(kept.map((row) => row.id).sort()).toEqual([admin.userId, operator.id].sort());
		for (const gone of [visitor.id, seedAdmin.id, clone.id]) expect(kept.map((row) => row.id)).not.toContain(gone);
		expect(await db.select().from(demoSessions)).toEqual([]);
		const roles = await db.select({ userId: staffRoles.userId, role: staffRoles.role }).from(staffRoles);
		expect(roles).toEqual(
			expect.arrayContaining([
				{ userId: admin.userId, role: 'admin' },
				{ userId: operator.id, role: 'operator' }
			])
		);
		expect(roles).toHaveLength(2);
		const [hashAfter] = await db
			.select({ hash: passwordCredentials.hash })
			.from(passwordCredentials)
			.where(eq(passwordCredentials.userId, admin.userId));
		expect(hashAfter?.hash).toBe(hashBefore?.hash);

		// The real staff keep their email and their settings: the letters of the stand keep reaching them.
		const channels = await db
			.select({ userId: notificationChannels.userId, kind: notificationChannels.kind })
			.from(notificationChannels);
		expect(channels).toEqual(
			expect.arrayContaining([
				{ userId: admin.userId, kind: 'email' },
				{ userId: operator.id, kind: 'email' }
			])
		);
		expect(channels).toHaveLength(2);
		expect(
			await db
				.select({ userId: notificationPreferences.userId, channels: notificationPreferences.channels })
				.from(notificationPreferences)
		).toEqual([{ userId: operator.id, channels: [] }]);
		// The next start of the application finds the administrator as it is.
		expect(await ensureBootstrapAdmin(deps, input)).toMatchObject({
			userId: admin.userId,
			created: false,
			roleGranted: false,
			passwordSet: false
		});
		expect(
			await db
				.select({ kind: notificationChannels.kind })
				.from(notificationChannels)
				.where(eq(notificationChannels.userId, admin.userId))
		).toEqual([{ kind: 'email' }]);
	});
});

describe('demo.reset embedding reindex', () => {
	const SPACE = 'demo-reset-test@r1/q:none/d:none/mean/l2/4/t512/sections-v1';

	it('enqueues embedding.reindex for the space search uses, and nothing without one', async () => {
		const { db } = database;
		expect(await enqueueDemoReindex(db)).toEqual([]);
		expect(await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.type, 'embedding.reindex'))).toEqual([]);

		await db.insert(embeddingSpaces).values({
			id: SPACE,
			modelName: 'test-embedder',
			modelRevision: 'r1',
			dimension: 4,
			queryPrefix: '',
			documentPrefix: '',
			pooling: 'mean',
			normalization: 'l2',
			maxInputTokens: 512,
			chunkingVersion: 'sections-v1',
			status: 'active',
			activatedAt: new Date()
		});
		await db.update(searchSettings).set({ activeEmbeddingSpaceId: SPACE });

		expect(await enqueueDemoReindex(db)).toEqual([SPACE]);
		const queued = await db
			.select({ inputVersion: jobs.inputVersion })
			.from(jobs)
			.where(eq(jobs.dedupKey, `reindex:${SPACE}`));
		expect(queued).toEqual([{ inputVersion: SPACE }]);
	});

	it('enqueues it for a space of a known definition still being built, whose job the reset emptied', async () => {
		const { db } = database;
		// The first seed of a stand with a new space: the start registered the space and enqueued its reindex, the reset
		// that followed emptied the queue.
		const building = { ...BGE_M3_Q8, status: 'building' as const };
		const unknown = { ...BGE_M3_Q8, id: `${BGE_M3_Q8.id}-unknown`, status: 'building' as const };
		await db.insert(embeddingSpaces).values([building, unknown]);
		await db.delete(jobs).where(eq(jobs.type, 'embedding.reindex'));

		expect(await enqueueDemoReindex(db)).toEqual([SPACE, BGE_M3_Q8.id]);
		const queued = await db
			.select({ spaceId: sql<string>`${jobs.payload}->>'space_id'` })
			.from(jobs)
			.where(eq(jobs.type, 'embedding.reindex'));
		expect(queued.map((job) => job.spaceId).sort()).toEqual([SPACE, BGE_M3_Q8.id].sort());
	});
});
