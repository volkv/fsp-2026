// Use of a demo session on the `/demo` screen itself (docs/domain.md, section 19.3): a visitor who comes back to
// `/demo` — with the session's cookie or its join link, signed in to a role or not — is using the session, exactly as
// an authenticated request of one of its clones is. The idle clock `demo.purge` reads (the idle time of the terms,
// `src/lib/server/demo/terms.ts`) must move with that visit, or a judge reading the screen between roles, with no
// request of a clone in between, would see their session end under them. This file opens a session, backdates its
// last use close to the idle limit, then loads `/demo` with its cookie and checks that the visit pushes the deadline
// out from the moment of the visit, not from the backdated one. The modes of the stand follow: the nightly reset
// (`DEMO_NIGHTLY_RESET`) and the review by the jury (`DEMO_REVIEW_MODE`), whose sessions live a week after their last
// use.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { auditEvents, demoSessions } from '$lib/server/db/schema';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createUser } from '../helpers/factories';
import { testEnvironment } from '../helpers/environment';

const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

/** A demonstration stand: `/demo` exists only when `config().demo` is set (`requireDemo` in the route). */
const DEMONSTRATION_STAND = {
	DEMO_MODE: 'true',
	FSP_MOCK_SEED: 'demo-activity',
	FSP_MOCK_ATHLETES: '200',
	FSP_MOCK_CONTROL_TOKEN: 'demo-activity-control-token-0123456789',
	FSP_ID_ISSUER: 'http://127.0.0.1:1/realms/fsp',
	FSP_ID_CLIENT_ID: 'demo-activity',
	FSP_ID_CLIENT_SECRET: 'demo-activity-client-secret',
	FSP_ID_REDIRECT_URI: 'http://127.0.0.1:1/auth/fsp/callback',
	FSP_ACHIEVEMENTS_ADAPTER: 'mock',
	FSP_ACHIEVEMENTS_BASE_URL: 'http://127.0.0.1:1',
	FSP_WEBHOOK_SECRET: 'demo-activity-webhook-secret-0123456789',
	FSP_ASSERTION_SECRET: 'demo-activity-assertion-secret-0123456789'
};
const REDIS_DATABASE = 4;
const DAY = 86_400_000;
const REQUEST_ID = 'demo-activity-test';

const { closeDb } = await import('$lib/server/db');
const { config } = await import('$lib/server/config');
const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { castRoles } = await import('$lib/server/demo/cast');
const { readSeedData, seedsDirectory } = await import('$lib/server/demo/data');
const { redisDemoActivity } = await import('$lib/server/demo/activity');
const { demoTerms } = await import('$lib/server/demo/terms');
const { publishPolicies, readPolicyRelease } = await import('../../scripts/seed-policies');
const { purgeDemoSession, purgeExpiredDemoSessions } = await import('$lib/server/demo/purge');
const { DEMO_SESSION_COOKIE } = await import('$lib/server/demo/visit');
const { sha256Hex } = await import('$lib/server/auth/secrets');
const demoPage = await import('../../src/routes/(auth)/demo/+page.server');

let database: TestDatabase;
let redis: Redis;

/** No session of this file's tests uploads a file of its own. */
const noFiles: ObjectStore = {
	put: () => Promise.reject(new Error('no files in this test')),
	get: () => Promise.reject(new Error('no files in this test')),
	delete: () => Promise.reject(new Error('no files in this test')),
	exists: () => Promise.reject(new Error('no files in this test'))
};

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(
		env,
		testEnvironment({
			DATABASE_URL: database.url,
			REDIS_URL: `${inject('redisUrl')}/${REDIS_DATABASE}`,
			...DEMONSTRATION_STAND
		})
	);
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishPolicies(client, await readPolicyRelease(fileURLToPath(new URL('../../policies', import.meta.url))));
	} finally {
		await client.end({ timeout: 5 });
	}
	// The route's `load` rejects with `DemoCastMissing` unless every role of the cast has an account outside sessions
	// (`castOriginals`) and every hero has a candidate profile; a company or its membership are not needed to satisfy it,
	// so this seeds the accounts and the heroes' profiles only, not the full demo cast.
	const roles = castRoles(await readSeedData(seedsDirectory()));
	const crypto = fieldCrypto();
	for (const role of roles) {
		const user = await createUser(database.db, {
			emailEnc: crypto.encrypt(role.email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', role.email),
			displayName: role.key,
			seedBatchId: 'demo-1'
		});
		if (role.group === 'candidate') await createCandidate(database.db, { userId: user.id });
	}
});

afterAll(async () => {
	redis.destroy();
	await closeDb();
	await database.drop();
});

/** A live demo session with a real join token, its cookie the way a browser holding it would send it. */
async function openSession(): Promise<{ id: string; token: string }> {
	const token = randomBytes(24).toString('base64url');
	const now = new Date();
	const [row] = await database.db
		.insert(demoSessions)
		.values({
			joinTokenSha256: sha256Hex(token),
			seedBatchId: 'demo-1',
			expiresAt: new Date(now.getTime() + DAY),
			createdAt: now
		})
		.returning();
	if (!row) throw new Error('demo session not inserted');
	return { id: row.id, token };
}

/** A browser on `/demo` holding `token`, signed in to nothing: the load reads the cookie regardless. */
function pageEvent(token: string) {
	return {
		url: new URL('http://localhost/demo'),
		params: {},
		request: new Request('http://localhost/demo'),
		cookies: { get: (name: string) => (name === DEMO_SESSION_COOKIE ? token : undefined) },
		locals: { requestId: REQUEST_ID, actor: { kind: 'anonymous' as const } },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		depends: () => {}
	};
}

describe('a visit to /demo', () => {
	it('is a demonstration stand for this file, `/demo` included', () => {
		expect(config().demo).not.toBeNull();
	});

	it('touches the activity of the live session its cookie names, past what an untouched session would survive', async () => {
		const session = await openSession();
		const activity = redisDemoActivity(redis);
		const now = Date.now();
		const { idleMinutes } = await demoTerms(database.db);
		// A minute short of idle: an untouched session would still be alive now, but gone by the time `asIfUntouched`
		// checks it.
		const stale = new Date(now - (idleMinutes - 1) * 60_000);
		await activity.touch(session.id, stale);

		const loaded = (await demoPage.load(pageEvent(session.token) as never)) as {
			seeded: boolean;
			session: { token: string } | null;
		};
		expect(loaded.seeded).toBe(true);
		expect(loaded.session?.token).toBe(session.token);

		const touched = await activity.lastUsed([session.id]);
		expect(touched.get(session.id)?.getTime()).toBeGreaterThan(stale.getTime());

		// Had the visit not moved the last use, `demo.purge` would find the session idle by now; the visit pushed the
		// deadline out from the moment it happened, not from the backdated one.
		const asIfUntouched = new Date(stale.getTime() + idleMinutes * 60_000 + 60_000);
		const outcome = await purgeExpiredDemoSessions(
			{ db: database.db, redis, store: noFiles },
			asIfUntouched,
			REQUEST_ID
		);
		expect(outcome.idle).not.toContain(session.id);
		expect(outcome.purged.map((p) => p.sessionId)).not.toContain(session.id);

		await purgeDemoSession({ db: database.db, redis, store: noFiles }, session.id, new Date(), REQUEST_ID);
	});
});

describe('the nightly reset of the stand, DEMO_NIGHTLY_RESET', () => {
	// `config()` is read once per module instance: each mode loads the modules afresh over its own environment.
	async function standWith(nightlyReset: 'true' | 'false') {
		env.DEMO_NIGHTLY_RESET = nightlyReset;
		vi.resetModules();
		try {
			const activity = await import('$lib/server/demo/activity');
			const scheduler = await import('$lib/server/jobs/scheduler');
			return { activity, scheduled: scheduler.periodicJobsFor(['demo.reset', 'demo.purge']).map((job) => job.type) };
		} finally {
			delete env.DEMO_NIGHTLY_RESET;
			vi.resetModules();
		}
	}

	// 10:00 Moscow time: the stand's own end is a day away, the reset comes at 00:00 UTC.
	const morning = new Date('2026-10-13T07:00:00Z');
	const dayLater = new Date(morning.getTime() + DAY);
	const reset = new Date('2026-10-14T00:00:00Z');

	it('on: the worker schedules the reset and no session outlives it', async () => {
		const { activity, scheduled } = await standWith('true');
		expect(scheduled).toEqual(['demo.reset', 'demo.purge']);
		expect(activity.lastEndOf(dayLater, morning)).toEqual(reset);
	});

	it('off: no reset is scheduled, sessions are purged by time and live to their own end', async () => {
		const { activity, scheduled } = await standWith('false');
		expect(scheduled).toEqual(['demo.purge']);
		expect(activity.lastEndOf(dayLater, morning)).toEqual(dayLater);
		const evening = new Date('2026-10-13T20:00:00Z');
		expect(activity.idleEndOf(dayLater, evening, 480)).toEqual(new Date(evening.getTime() + 480 * 60_000));
	});

	it('turned off after the night was enqueued: the job of that night resets nothing and says so', async () => {
		const { db } = database;
		// The night of 2026-09-02 was enqueued the day before, while the flag was on; it is due now.
		env.DEMO_NIGHTLY_RESET = 'true';
		vi.resetModules();
		try {
			const scheduler = await import('$lib/server/jobs/scheduler');
			const entry = scheduler.periodicJobsFor(['demo.reset'])[0];
			if (!entry) throw new Error('the nightly reset is not scheduled with the flag on');
			expect(await scheduler.schedulePeriodicJob(db, entry, new Date('2026-09-01T15:00:00Z'))).toBe('enqueued');
		} finally {
			delete env.DEMO_NIGHTLY_RESET;
			vi.resetModules();
		}

		// The worker restarts with the flag off and picks the job up.
		env.DEMO_NIGHTLY_RESET = 'false';
		vi.resetModules();
		try {
			const { claimJob } = await import('$lib/server/jobs/queue');
			const { createDemoResetHandler } = await import('$lib/server/demo/job');
			const { createLogger } = await import('$lib/server/jobs/log');
			const job = await claimJob(db, 'demo-activity-worker', ['demo.reset']);
			expect(job?.payload).toEqual({ kind: 'nightly', date: '2026-09-02' });
			if (job?.type !== 'demo.reset') throw new Error('the nightly job was not claimed');
			const handler = createDemoResetHandler(() => Promise.reject(new Error('the stand must not be touched')));
			const result = await handler.run({
				job: { ...job, type: 'demo.reset', payload: { kind: 'nightly', date: '2026-09-02' } },
				db,
				signal: new AbortController().signal,
				requestId: 'job:nightly-off',
				log: createLogger({ component: 'test' }, () => {})
			});
			expect(result.describe?.()).toEqual({ kind: 'nightly', skipped: 'nightly_reset_off' });
			const [skipped] = await db
				.select({ action: auditEvents.action, details: auditEvents.details })
				.from(auditEvents)
				.where(eq(auditEvents.requestId, 'job:nightly-off'));
			expect(skipped).toEqual({
				action: 'demo.reset_skipped',
				details: { date: '2026-09-02', reason: 'nightly_reset_off' }
			});
		} finally {
			delete env.DEMO_NIGHTLY_RESET;
			vi.resetModules();
		}
	});
});

describe('the review by the jury, DEMO_REVIEW_MODE', () => {
	const MINUTE = 60_000;

	it('keeps a session a week after its last use and its own resume no longer than the session', async () => {
		const regular = await demoTerms(database.db);
		expect(regular).toEqual({
			review: false,
			sessionHours: 24,
			ownResumeHours: 24,
			idleMinutes: 480,
			evictableMinutes: 20
		});

		env.DEMO_REVIEW_MODE = 'true';
		env.DEMO_NIGHTLY_RESET = 'false';
		vi.resetModules();
		try {
			const terms = await import('$lib/server/demo/terms');
			const purge = await import('$lib/server/demo/purge');
			const review = await terms.demoTerms(database.db);
			expect(review).toEqual({
				review: true,
				sessionHours: 720,
				ownResumeHours: null,
				idleMinutes: 7 * 24 * 60,
				evictableMinutes: 24 * 60
			});

			// A judge back after six days finds the session; one gone for more than a week does not.
			const back = await openSession();
			const gone = await openSession();
			await database.db
				.update(demoSessions)
				.set({ createdAt: new Date(Date.now() - 10 * DAY), expiresAt: new Date(Date.now() + 20 * DAY) })
				.where(inArray(demoSessions.id, [back.id, gone.id]));
			const activity = redisDemoActivity(redis);
			await activity.touch(back.id, new Date(Date.now() - 6 * DAY));
			await activity.touch(gone.id, new Date(Date.now() - 7 * DAY - MINUTE));
			const outcome = await purge.purgeExpiredDemoSessions(
				{ db: database.db, redis, store: noFiles },
				new Date(),
				REQUEST_ID
			);
			expect(outcome.idle).toContain(gone.id);
			expect(outcome.idle).not.toContain(back.id);
			expect(outcome.purged.map((p) => p.sessionId)).toContain(gone.id);

			// An own resume uploaded now does not bring the end of the session forward: it goes with the session.
			const visit = await import('$lib/server/demo/visit');
			const [before] = await database.db.select().from(demoSessions).where(eq(demoSessions.id, back.id));
			const uploadedAt = new Date();
			expect(await visit.shortenForOwnResume(database.db, back.id, review, uploadedAt)).toEqual(before?.expiresAt);
			const [after] = await database.db.select().from(demoSessions).where(eq(demoSessions.id, back.id));
			expect(after?.ownResumeAt).toEqual(uploadedAt);
			await purge.purgeDemoSession({ db: database.db, redis, store: noFiles }, back.id, new Date(), REQUEST_ID);
		} finally {
			delete env.DEMO_REVIEW_MODE;
			delete env.DEMO_NIGHTLY_RESET;
			vi.resetModules();
		}
	});
});
