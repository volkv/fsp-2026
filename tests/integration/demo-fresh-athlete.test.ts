// «Войти через ФСП ID» with an athlete who has no account of the seed, on a demonstration stand (docs/domain.md, 19.3):
// the account is created within the visitor's demo session — the identity, the account, the profile, the athlete link
// and the imported achievements belong to that session. Another visitor signing in as the same athlete gets an account
// of their own in their own session; neither account is seen from the other session nor from outside sessions, a clone
// of the cast is still refused, and the removal of a session takes its account with it. Outside demonstration mode the
// account is created outside sessions, as before.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { AuthDeps, RequestMeta } from '$lib/server/auth/context';
import { readPendingSignup } from '$lib/server/auth/fsp-signup';
import { completeFspSignIn, confirmFspAchievements, type VisitorDemoSession } from '$lib/server/auth/identities';
import { createFspIdClient, type FspIdClient } from '$lib/server/auth/oidc';
import { grantProfileConsent } from '$lib/server/auth/onboarding';
import { register } from '$lib/server/auth/registration';
import { readSession, sessionRef, type SessionRef } from '$lib/server/auth/sessions';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import { athleteLinks, candidates, demoSessions, externalIdentities, sourceFacts, users } from '$lib/server/db/schema';
import { cloneEmail } from '$lib/server/demo/cast';
import { purgeDemoSession } from '$lib/server/demo/purge';
import { demoScope } from '$lib/server/demo/scope';
import { HttpAchievementsSource } from '$lib/server/fsp/adapter';
import { ServiceGrantIssuer } from '$lib/server/fsp/grant';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { createFspSyncHandler } from '$lib/server/fsp/sync';
import { JobFailure } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { testEnvironment } from '../helpers/environment';
import { createPublishedDocument, createUser, randomSha256 } from '../helpers/factories';
import { FSP_MOCK_CREDENTIALS, startFspMock, type FspMock } from '../helpers/fsp-mock';

const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
/** The redirect URI the simulator of the helper accepts; the browser stops there and never calls it. */
const REDIRECT_URI = 'http://127.0.0.1:1/auth/fsp/callback';
const FRESH = 'Длинная история';
const HERO = 'Капитан, backend, МС';

let database: TestDatabase;
let redis: Redis;
let mock: FspMock;
let client: FspIdClient;
let documents: { userAgreement: string; pdProcessing: string; fspImport: string };

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 5)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 6)
});

function deps(): AuthDeps {
	return {
		db: database.db,
		redis,
		crypto,
		mailer: { send: () => Promise.resolve({ ok: true, value: { messageId: randomUUID() } }) },
		appOrigin: 'http://app.test',
		now: () => new Date()
	};
}

function meta(): RequestMeta {
	return { requestId: `test-${randomUUID()}`, ip: '10.40.0.1', userAgent: 'vitest' };
}

const noObjects: ObjectStore = {
	put: () => Promise.reject(new Error('no objects in this test')),
	get: () => Promise.resolve(null),
	delete: () => Promise.resolve(),
	exists: () => Promise.resolve(false)
};

/** The provider side of a browser: keeps its cookies and follows nothing by itself. */
class Browser {
	readonly #cookies = new Map<string, string>();

	async request(url: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.#cookies.size > 0) headers.set('cookie', [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; '));
		const response = await fetch(url, { ...init, headers, redirect: 'manual' });
		for (const line of response.headers.getSetCookie()) {
			const [pair = ''] = line.split(';');
			const separator = pair.indexOf('=');
			const name = pair.slice(0, separator).trim();
			const value = pair.slice(separator + 1).trim();
			if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) this.#cookies.delete(name);
			else this.#cookies.set(name, value);
		}
		return response;
	}
}

/** Signs in at the provider as `sub` in a fresh browser and completes the authorization. */
async function authorizeAs(sub: string) {
	const started = await client.startAuthorization({ intent: 'login', returnTo: '/onboarding' });
	if (!started.ok) throw new Error(`authorization not started: ${started.error.message}`);
	const browser = new Browser();
	let url = new URL(started.value.redirectUrl);
	for (let hop = 0; hop < 10 && !url.href.startsWith(REDIRECT_URI); hop++) {
		let response = await browser.request(url.href);
		if (response.status === 200 && url.pathname.includes('/login-actions/')) {
			response = await browser.request(`${url.href}/login`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ sub }).toString()
			});
		}
		const location = response.headers.get('location');
		if (!location) throw new Error(`provider answered ${response.status} without a redirect at ${url.pathname}`);
		url = new URL(location, url);
	}
	const completed = await client.completeAuthorization({ callbackUrl: url, browserState: started.value.state });
	if (!completed.ok) throw new Error(`authorization failed: ${completed.error.code}`);
	return completed.value;
}

/** The visitor's demo session as the callback hands it over on a demonstration stand. */
const inSession =
	(sessionId: string): VisitorDemoSession =>
	() =>
		Promise.resolve({ ok: true, sessionId });

async function signIn(sub: string, demo: VisitorDemoSession | null) {
	return completeFspSignIn(deps(), meta(), await authorizeAs(sub), null, demo);
}

async function sessionOf(sessionId: string): Promise<SessionRef> {
	const session = await readSession(redis, sessionId, new Date());
	if (!session) throw new Error('session does not exist');
	return sessionRef(session);
}

/** The first sign-in continues with the registration form; the address typed is the one FSP ID gave. */
async function registerAs(sub: string, email: string, demo: VisitorDemoSession | null) {
	const outcome = await signIn(sub, demo);
	if (outcome.kind !== 'signup') throw new Error(`expected a registration, got ${outcome.kind}`);
	const pending = await readPendingSignup(redis, outcome.pendingToken);
	if (!pending) throw new Error('the provider result was not held');
	const result = await register(deps(), meta(), {
		email,
		displayName: 'Денис Макаров',
		password: null,
		role: 'candidate',
		birthDate: '2002-05-10',
		company: null,
		documents: { userAgreementId: documents.userAgreement, employerTermsId: null },
		fsp: pending,
		demoSession: null
	});
	if (!result.ok) throw new Error(`registration refused: ${JSON.stringify(result)}`);
	return { ...result, pending, emailConflict: outcome.emailConflict };
}

/**
 * A live demo session opened a minute ago: its opening is set here rather than taken from the clock of the database,
 * so a test may end it at a moment of its own that comes after the opening (`demo_sessions_expiry`).
 */
async function openSession(): Promise<string> {
	const now = Date.now();
	const [session] = await database.db
		.insert(demoSessions)
		.values({
			joinTokenSha256: randomSha256(),
			seedBatchId: 'demo-1',
			createdAt: new Date(now - 60_000),
			expiresAt: new Date(now + 86_400_000)
		})
		.returning({ id: demoSessions.id });
	if (!session) throw new Error('demo session not inserted');
	return session.id;
}

async function candidateOf(userId: string) {
	const [row] = await database.db.select().from(candidates).where(eq(candidates.userId, userId));
	if (!row) throw new Error(`no candidate of ${userId}`);
	return row;
}

/** Profiles a viewer of the session (`null` — outside sessions) sees, among the given ones. */
async function visibleTo(viewerSession: string | null, candidateIds: string[]): Promise<string[]> {
	const rows = await database.db
		.select({ id: candidates.id })
		.from(candidates)
		.where(and(inArray(candidates.id, candidateIds), demoScope(candidates, viewerSession)));
	return rows.map((row) => row.id).sort();
}

/** What the worker does with the one queued `fsp.sync` job. */
async function runSync(): Promise<string> {
	const { db } = database;
	const claimed = await claimJob(db, 'test-worker', ['fsp.sync']);
	if (claimed?.type !== 'fsp.sync') throw new Error('no fsp.sync job to run');
	const job: ClaimedJob<'fsp.sync'> = {
		...claimed,
		type: 'fsp.sync',
		payload: JOB_TYPES['fsp.sync'].payload.parse(claimed.payload)
	};
	const handler = createFspSyncHandler(() => ({
		source: new HttpAchievementsSource({ baseUrl: mock.origin, webhookSecret: FSP_MOCK_CREDENTIALS.webhookSecret }),
		grants: new ServiceGrantIssuer({
			issuer: mock.issuer,
			clientId: FSP_MOCK_CREDENTIALS.clientId,
			clientSecret: FSP_MOCK_CREDENTIALS.clientSecret,
			assertionSecret: FSP_MOCK_CREDENTIALS.assertionSecret
		}),
		signer: createReceiptSigner({ issuer: 'http://platform.test', keyId: 'test-1', seed: Buffer.alloc(32, 7) })
	}));
	try {
		const result = await handler.run({
			job,
			db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: createLogger({}, () => undefined)
		});
		return await completeJob(db, job, result);
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		return failJob(db, job, { code: error.code, retryable: error.retryable, message: error.message });
	}
}

/** Consents and «Подтвердить достижения из ФСП», then the import runs. */
async function importAchievements(signInSessionId: string) {
	const session = await sessionOf(signInSessionId);
	expect(await grantProfileConsent(deps(), meta(), session, documents.pdProcessing)).toEqual({ ok: true });
	const confirmed = await confirmFspAchievements(deps(), meta(), session, {
		issuer: mock.issuer,
		documentId: documents.fspImport
	});
	if (!confirmed.ok) throw new Error(confirmed.reason);
	expect(await runSync()).toBe('succeeded');
	return confirmed.linkId;
}

beforeAll(async () => {
	database = await createTestDatabase();
	const sql = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(sql, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await sql.end({ timeout: 5 });
	}
	redis = createClient({ url: inject('redisUrl') });
	await redis.connect();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl') }));
	mock = await startFspMock({ athletes: 200 });
	client = createFspIdClient(
		{
			issuer: mock.issuer,
			clientId: FSP_MOCK_CREDENTIALS.clientId,
			clientSecret: FSP_MOCK_CREDENTIALS.clientSecret,
			redirectUri: REDIRECT_URI,
			scopes: 'openid profile email'
		},
		{ redis, now: () => new Date() }
	);
	const { db } = database;
	documents = {
		userAgreement: (await createPublishedDocument(db, 'user_agreement')).id,
		pdProcessing: (await createPublishedDocument(db, 'pd_processing')).id,
		fspImport: (await createPublishedDocument(db, 'fsp_import')).id
	};
}, 120_000);

afterAll(async () => {
	await mock.stop();
	redis.destroy();
	await database.drop();
});

describe('an athlete without an account of the seed signs in with FSP ID on a demonstration stand', () => {
	it('gets an account within each visitor’s demo session, seen there only, and gone with the session', async () => {
		const { db } = database;
		const sub = await mock.heroId(FRESH);
		const email = `fresh-${randomUUID()}@example.org`;
		const first = await openSession();
		const second = await openSession();

		// Two visitors, two sessions, the same athlete and the same address typed.
		const inFirst = await registerAs(sub, email, inSession(first));
		const inSecond = await registerAs(sub, email, inSession(second));
		expect(inFirst.pending.demoSessionId).toBe(first);
		expect(inSecond.emailConflict).toBe(false);
		expect(inSecond.userId).not.toBe(inFirst.userId);
		for (const [registration, session] of [
			[inFirst, first],
			[inSecond, second]
		] as const) {
			const [user] = await db.select().from(users).where(eq(users.id, registration.userId));
			expect(user).toMatchObject({ demoSessionId: session, seedBatchId: null });
			expect(user?.emailHmac).toBe(crypto.lookupHmac('email', cloneEmail(email, session)));
			const identities = await db
				.select()
				.from(externalIdentities)
				.where(eq(externalIdentities.userId, registration.userId));
			expect(identities).toMatchObject([{ issuer: mock.issuer, subject: sub, demoSessionId: session }]);
			expect(await candidateOf(registration.userId)).toMatchObject({ demoSessionId: session, demoOriginal: false });
		}

		// Signing in again within a session reaches the account of that session.
		expect(await signIn(sub, inSession(first))).toMatchObject({ kind: 'signed_in', userId: inFirst.userId });
		expect(await signIn(sub, inSession(second))).toMatchObject({ kind: 'signed_in', userId: inSecond.userId });
		// Outside sessions the athlete still has no account: a sign-in there is a registration again.
		expect(await signIn(sub, null)).toMatchObject({ kind: 'signup', emailConflict: false });

		// The achievements are imported into the account of the session.
		const linkId = await importAchievements(inFirst.sessionId);
		const [link] = await db.select().from(athleteLinks).where(eq(athleteLinks.id, linkId));
		expect(link).toMatchObject({
			userId: inFirst.userId,
			sourceAthleteId: sub,
			demoSessionId: first,
			status: 'active'
		});
		const profileFirst = await candidateOf(inFirst.userId);
		expect(
			(await db.select().from(sourceFacts).where(eq(sourceFacts.candidateId, profileFirst.id))).length
		).toBeGreaterThan(0);
		const secondLink = await importAchievements(inSecond.sessionId);
		expect(secondLink).not.toBe(linkId);

		// Each profile is seen from its own session only: not by the other session nor outside sessions.
		const profileSecond = await candidateOf(inSecond.userId);
		const both = [profileFirst.id, profileSecond.id];
		expect(await visibleTo(first, both)).toEqual([profileFirst.id]);
		expect(await visibleTo(second, both)).toEqual([profileSecond.id]);
		expect(await visibleTo(null, both)).toEqual([]);

		// The removal of the session takes the account with its identity, link and facts; the other stays.
		expect(await purgeDemoSession({ db, redis, store: noObjects }, first, new Date(), 'test-purge')).not.toBeNull();
		expect(await db.select().from(users).where(eq(users.id, inFirst.userId))).toEqual([]);
		expect(await db.select().from(externalIdentities).where(eq(externalIdentities.demoSessionId, first))).toEqual([]);
		expect(await db.select().from(athleteLinks).where(eq(athleteLinks.id, linkId))).toEqual([]);
		expect(await db.select().from(sourceFacts).where(eq(sourceFacts.candidateId, profileFirst.id))).toEqual([]);
		expect(await db.select().from(users).where(eq(users.id, inSecond.userId))).toHaveLength(1);
		expect(await signIn(sub, inSession(second))).toMatchObject({ kind: 'signed_in', userId: inSecond.userId });
	});

	it('refuses a clone of the cast within the session and does not open a session for an account outside them', async () => {
		const { db } = database;
		const session = await openSession();
		const sub = await mock.heroId(HERO);
		const clone = await createUser(db, { demoSessionId: session, seedBatchId: 'demo-1' });
		await db.insert(externalIdentities).values({
			userId: clone.id,
			issuer: mock.issuer,
			subject: sub,
			linkedAt: new Date(),
			linkMethod: 'signup_via_provider',
			demoSessionId: session
		});
		expect(await signIn(sub, inSession(session))).toEqual({ kind: 'refused', reason: 'demo_account' });

		// A real account of the stand is reached outside sessions: the visitor's demo session is not asked for.
		const person = await createUser(db);
		const other = `real-${randomUUID()}`;
		await db.insert(externalIdentities).values({
			userId: person.id,
			issuer: mock.issuer,
			subject: other,
			linkedAt: new Date(),
			linkMethod: 'linked_by_user'
		});
		const outcome = await completeFspSignIn(
			deps(),
			meta(),
			{ ...(await authorizeAs(sub)), identity: { issuer: mock.issuer, subject: other } },
			null,
			() => Promise.reject(new Error('the demo session must not be asked for'))
		);
		expect(outcome).toMatchObject({ kind: 'signed_in', userId: person.id });

		// The visitor's session could not be had: the sign-in stops with the reason.
		const refused = await signIn(await mock.heroId(FRESH), () => Promise.resolve({ ok: false, reason: 'stand_full' }));
		expect(refused).toEqual({ kind: 'refused', reason: 'stand_full' });
	});

	it('refuses the registration when the demo session ended after the sign-in', async () => {
		const { db } = database;
		const session = await openSession();
		const outcome = await signIn(await mock.heroId(FRESH), inSession(session));
		if (outcome.kind !== 'signup') throw new Error(`expected a registration, got ${outcome.kind}`);
		const pending = await readPendingSignup(redis, outcome.pendingToken);
		await db.update(demoSessions).set({ expiresAt: new Date() }).where(eq(demoSessions.id, session));
		const result = await register(deps(), meta(), {
			email: `late-${randomUUID()}@example.org`,
			displayName: 'Денис Макаров',
			password: null,
			role: 'candidate',
			birthDate: '2002-05-10',
			company: null,
			documents: { userAgreementId: documents.userAgreement, employerTermsId: null },
			fsp: pending,
			demoSession: null
		});
		expect(result).toMatchObject({
			ok: false,
			errors: { documents: expect.stringContaining('Демо-сессия') as unknown }
		});
		expect(await db.select().from(users).where(eq(users.demoSessionId, session))).toEqual([]);
	});
});

describe('outside demonstration mode', () => {
	it('creates the account of the athlete outside sessions, with the address as typed', async () => {
		const { db } = database;
		const sub = await mock.heroId('Аннулированный и предварительный результаты');
		const email = `plain-${randomUUID()}@example.org`;
		const registration = await registerAs(sub, email, null);
		expect(registration.pending.demoSessionId).toBeNull();
		const [user] = await db.select().from(users).where(eq(users.id, registration.userId));
		expect(user).toMatchObject({ demoSessionId: null });
		expect(user?.emailHmac).toBe(crypto.lookupHmac('email', email));
		const [identity] = await db
			.select()
			.from(externalIdentities)
			.where(eq(externalIdentities.userId, registration.userId));
		expect(identity).toMatchObject({ subject: sub, demoSessionId: null });
		expect(await signIn(sub, null)).toMatchObject({ kind: 'signed_in', userId: registration.userId });
	});
});
