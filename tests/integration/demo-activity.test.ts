// Use of a demo session on the `/demo` screen itself (docs/domain.md, section 19.3): a visitor who comes back to
// `/demo` — with the session's cookie or its join link, signed in to a role or not — is using the session, exactly as
// an authenticated request of one of its clones is. The idle clock `demo.purge` reads (`DEMO_IDLE_MINUTES`,
// `src/lib/server/demo/activity.ts`) must move with that visit, or a judge reading the screen between roles, with no
// request of a clone in between, would see their session end under them. This file opens a session, backdates its
// last use close to the idle limit, then loads `/demo` with its cookie and checks that the visit pushes the deadline
// out from the moment of the visit, not from the backdated one.
import { randomBytes } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { demoSessions } from '$lib/server/db/schema';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createUser } from '../helpers/factories';
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
const { DEMO_IDLE_MINUTES, redisDemoActivity } = await import('$lib/server/demo/activity');
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
	// The route's `load` rejects with `DemoCastMissing` unless every role of the cast has an account outside sessions
	// (`castOriginals`); a profile, a company or its membership are not needed to satisfy it, so this seeds accounts
	// only, not the full demo cast.
	const roles = castRoles(await readSeedData(seedsDirectory()));
	const crypto = fieldCrypto();
	for (const role of roles) {
		await createUser(database.db, {
			emailEnc: crypto.encrypt(role.email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', role.email),
			displayName: role.key,
			seedBatchId: 'demo-1'
		});
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
		// A minute short of idle: an untouched session would still be alive now, but gone by the time `asIfUntouched`
		// checks it.
		const stale = new Date(now - (DEMO_IDLE_MINUTES - 1) * 60_000);
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
		const asIfUntouched = new Date(stale.getTime() + DEMO_IDLE_MINUTES * 60_000 + 60_000);
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
