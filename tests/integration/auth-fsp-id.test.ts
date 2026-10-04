// «Войти через ФСП ID» against the FSP simulator (`services/fsp-mock`) run as a process: the OIDC client with PKCE,
// state bound to the browser, nonce and `iss`; sign-in by `(issuer, subject)`; registration after the first sign-in;
// no linking by email; linking and unlinking from a signed-in account — within the demo session of an account
// registered in one; the athlete link with its first `fsp.sync`; an unreachable provider or flow store sends the
// browser back with an explanation instead of an error page.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { authenticateSession } from '$lib/server/auth/authenticate';
import type { AuthDeps, RequestMeta } from '$lib/server/auth/context';
import { FSP_FLOW_COOKIE } from '$lib/server/auth/http';
import { readPendingSignup } from '$lib/server/auth/fsp-signup';
import {
	completeFspSignIn,
	confirmFspAchievements,
	unlinkFspIdentity,
	type VisitorDemoSession
} from '$lib/server/auth/identities';
import { createFspIdClient, type FspIdClient, type StartAuthorizationInput } from '$lib/server/auth/oidc';
import { grantProfileConsent } from '$lib/server/auth/onboarding';
import { register, type RegistrationInput } from '$lib/server/auth/registration';
import { sha256Hex } from '$lib/server/auth/secrets';
import { readSession, sessionRef, type SessionRef } from '$lib/server/auth/sessions';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	athleteLinks,
	auditEvents,
	candidates,
	claims,
	consentEvents,
	demoSessions,
	externalIdentities,
	jobs,
	passwordCredentials,
	sourceFacts,
	users,
	verificationReceipts
} from '$lib/server/db/schema';
import { consentRevocationCleanup } from '$lib/server/erasure/fsp-import';
import { HttpAchievementsSource } from '$lib/server/fsp/adapter';
import { ServiceGrantIssuer } from '$lib/server/fsp/grant';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import { createFspSyncHandler } from '$lib/server/fsp/sync';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import type { MailMessage, Mailer } from '$lib/server/mail/mailer';
import type { Redis } from '$lib/server/redis';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { testEnvironment } from '../helpers/environment';
import { createPublishedDocument, createUser, randomSha256 } from '../helpers/factories';

// The routes read `config()`: each scenario below points it at the services it needs and imports the routes afresh.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const MOCK_MAIN = fileURLToPath(new URL('../../services/fsp-mock/src/main.ts', import.meta.url));
const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const CLIENT_ID = 'fsp-career-auth-test';
const CLIENT_SECRET = 'auth-test-client-secret-0123456789abcdef';
const ASSERTION_SECRET = 'auth-test-assertion-secret-0123456789abcdef';
const CONTROL_TOKEN = 'auth-test-control-token-0123456789abcdef';
const REDIRECT_URI = 'http://app.test/auth/fsp/callback';
const PASSWORD = 'correct horse battery';

let database: TestDatabase;
let redis: Redis;
let mock: ChildProcess;
let mockOrigin: string;
let client: FspIdClient;
let documents: { userAgreement: string; pdProcessing: string; fspImport: string };
const mockLog: string[] = [];
const sent: MailMessage[] = [];

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 3)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 4)
});
const recordingMailer: Mailer = {
	send(message) {
		sent.push(message);
		return Promise.resolve({ ok: true, value: { messageId: randomUUID() } });
	}
};

function deps(): AuthDeps {
	return {
		db: database.db,
		redis,
		crypto,
		mailer: recordingMailer,
		appOrigin: 'http://app.test',
		now: () => new Date()
	};
}

function meta(): RequestMeta {
	return { requestId: `test-${randomUUID()}`, ip: '10.30.0.1', userAgent: 'vitest' };
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createNetServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() => {
				if (address && typeof address === 'object') resolve(address.port);
				else reject(new Error('no port'));
			});
		});
	});
}

async function waitForHealth(origin: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (mock.exitCode !== null) throw new Error(`fsp-mock exited: ${mockLog.join('')}`);
		try {
			if ((await fetch(`${origin}/health`)).ok) return;
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`fsp-mock did not become healthy: ${mockLog.join('')}`);
}

interface MockAccount {
	sub: string;
	title: string;
	account: { email: string; givenName: string; familyName: string };
}

async function demoAccount(title: string): Promise<MockAccount> {
	const response = await fetch(`${mockOrigin}/mock/accounts`, {
		headers: { authorization: `Bearer ${CONTROL_TOKEN}` }
	});
	const { items } = (await response.json()) as { items: MockAccount[] };
	const found = items.find((item) => item.title === title);
	if (!found) throw new Error(`no demo account «${title}»`);
	return found;
}

/** A browser of the provider side: keeps its cookies and follows nothing by itself. */
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

/**
 * Starts a flow, signs in at the provider as `sub` and returns the URL the provider sends the browser back to, with the
 * `state` the application put into the binding cookie.
 */
async function authorize(input: StartAuthorizationInput, sub: string, browser = new Browser()) {
	const started = await client.startAuthorization(input);
	if (!started.ok) throw new Error(`authorization not started: ${started.error.message}`);
	let url = new URL(started.value.redirectUrl);
	let loginShown = false;
	for (let hop = 0; hop < 10; hop++) {
		if (url.href.startsWith(REDIRECT_URI)) return { callbackUrl: url, state: started.value.state, loginShown };
		let response = await browser.request(url.href);
		if (response.status === 200 && url.pathname.includes('/login-actions/')) {
			loginShown = true;
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
	throw new Error('too many redirects');
}

async function signInAt(sub: string, current: SessionRef | null = null) {
	const { callbackUrl, state } = await authorize({ intent: 'login', returnTo: '/onboarding' }, sub);
	const completed = await client.completeAuthorization({ callbackUrl, browserState: state });
	if (!completed.ok) throw new Error(`authorization failed: ${completed.error.code}`);
	return {
		authorization: completed.value,
		outcome: await completeFspSignIn(deps(), meta(), completed.value, current, null)
	};
}

function registrationInput(overrides: Partial<RegistrationInput>): RegistrationInput {
	return {
		email: `person-${randomUUID()}@example.org`,
		displayName: 'Тестовый Человек',
		password: PASSWORD,
		role: 'candidate',
		birthDate: '1999-04-12',
		company: null,
		documents: { userAgreementId: documents.userAgreement, employerTermsId: null },
		fsp: null,
		demoSession: null,
		...overrides
	};
}

async function sessionOf(sessionId: string): Promise<SessionRef> {
	const session = await readSession(redis, sessionId, new Date());
	if (!session) throw new Error('session does not exist');
	return sessionRef(session);
}

/** Registration after the first sign-in through FSP ID, as the form submits it. */
async function registerThroughFsp(title: string, overrides: Partial<RegistrationInput> = {}) {
	const account = await demoAccount(title);
	const { outcome } = await signInAt(account.sub);
	if (outcome.kind !== 'signup') throw new Error(`expected a registration, got ${outcome.kind}`);
	const pending = await readPendingSignup(redis, outcome.pendingToken);
	if (!pending) throw new Error('the provider result was not held');
	const result = await register(
		deps(),
		meta(),
		registrationInput({ email: `fsp-${randomUUID()}@example.org`, password: null, fsp: pending, ...overrides })
	);
	if (!result.ok) throw new Error(`registration refused: ${JSON.stringify(result)}`);
	return { ...result, account };
}

async function journal(action: string) {
	return database.db.select().from(auditEvents).where(eq(auditEvents.action, action));
}

beforeAll(async () => {
	database = await createTestDatabase();
	redis = createClient({ url: inject('redisUrl') });
	await redis.connect();
	const port = await freePort();
	mockOrigin = `http://127.0.0.1:${port}`;
	mock = spawn(process.execPath, [MOCK_MAIN], {
		env: {
			PATH: process.env.PATH ?? '',
			FSP_MOCK_ORIGIN: mockOrigin,
			PORT: String(port),
			HOST: '127.0.0.1',
			FSP_MOCK_CLIENT_ID: CLIENT_ID,
			FSP_MOCK_CLIENT_SECRET: CLIENT_SECRET,
			FSP_MOCK_REDIRECT_URIS: REDIRECT_URI,
			FSP_MOCK_ASSERTION_SECRET: ASSERTION_SECRET,
			FSP_MOCK_CONTROL_TOKEN: CONTROL_TOKEN,
			FSP_MOCK_ATHLETES: '200'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	mock.stdout?.on('data', (chunk: Buffer) => mockLog.push(chunk.toString('utf8')));
	mock.stderr?.on('data', (chunk: Buffer) => mockLog.push(chunk.toString('utf8')));
	await waitForHealth(mockOrigin);
	client = createFspIdClient(
		{
			issuer: `${mockOrigin}/realms/fsp`,
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
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
});

afterAll(async () => {
	if (mock.exitCode === null) {
		const exited = new Promise((resolve) => mock.once('exit', resolve));
		mock.kill('SIGTERM');
		await exited;
	}
	redis.destroy();
	await database.drop();
});

describe('sign-in through FSP ID', () => {
	it('holds the first sign-in for registration, then signs the same identity in', async () => {
		const registration = await registerThroughFsp('Алгоритмист, КМС');
		const [identity] = await database.db
			.select()
			.from(externalIdentities)
			.where(eq(externalIdentities.userId, registration.userId));
		expect(identity).toMatchObject({
			issuer: `${mockOrigin}/realms/fsp`,
			subject: registration.account.sub,
			linkMethod: 'signup_via_provider'
		});
		expect(identity?.profileClaims).toMatchObject({ given_name: registration.account.account.givenName });
		// The account has no password and its address still needs our confirmation.
		expect(
			await database.db.select().from(passwordCredentials).where(eq(passwordCredentials.userId, registration.userId))
		).toEqual([]);
		const [user] = await database.db.select().from(users).where(eq(users.id, registration.userId));
		expect(user?.status).toBe('pending_email');
		const actor = await authenticateSession({ db: database.db, redis, now: () => new Date() }, registration.sessionId);
		expect(actor?.authMethod).toBe('fsp_id');

		const again = await signInAt(registration.account.sub);
		expect(again.outcome).toMatchObject({ kind: 'signed_in', userId: registration.userId, returnTo: '/onboarding' });
		const logins = (await journal('auth.login')).filter((e) => e.actorUserId === registration.userId);
		expect(logins.map((e) => e.details)).toEqual([{ method: 'fsp_id' }]);
		const registered = (await journal('auth.registered')).filter((e) => e.actorUserId === registration.userId);
		expect(registered.map((e) => e.details)).toEqual([{ method: 'fsp_id' }]);
	});

	it('never links or signs in by a matching address: the person chooses a path first', async () => {
		const account = await demoAccount('Капитан, backend, МС');
		const local = await register(deps(), meta(), registrationInput({ email: account.account.email.toUpperCase() }));
		expect(local.ok).toBe(true);
		if (!local.ok) return;

		const { outcome } = await signInAt(account.sub);
		expect(outcome).toMatchObject({ kind: 'signup', emailConflict: true });
		// Neither a session for the local account nor an identity appears.
		expect(
			await database.db.select().from(externalIdentities).where(eq(externalIdentities.subject, account.sub))
		).toEqual([]);
		// Only the registration of the local account is journaled: no sign-in, neither before nor by the provider.
		expect((await journal('auth.login')).filter((e) => e.actorUserId === local.userId)).toEqual([]);
		expect((await journal('auth.registered')).filter((e) => e.actorUserId === local.userId)).toHaveLength(1);
		// Registering with the same address is refused; the local account stays as it was.
		if (outcome.kind !== 'signup') return;
		const pending = await readPendingSignup(redis, outcome.pendingToken);
		const attempt = await register(
			deps(),
			meta(),
			registrationInput({ email: account.account.email, password: null, fsp: pending })
		);
		expect(attempt).toMatchObject({ ok: false, errors: { email: expect.any(String) as unknown } });
	});

	it('refuses a replayed callback, a callback in another browser, a foreign iss, a wrong nonce and verifier', async () => {
		const account = await demoAccount('Онлайн-отбор против очного финала');
		const login = { intent: 'login' as const, returnTo: '/onboarding' };

		const first = await authorize(login, account.sub);
		const elsewhere = await client.completeAuthorization({ callbackUrl: first.callbackUrl, browserState: undefined });
		expect(elsewhere).toMatchObject({ ok: false, error: { code: 'state_invalid' } });
		const other = await authorize(login, account.sub);
		const swapped = await client.completeAuthorization({ callbackUrl: first.callbackUrl, browserState: other.state });
		expect(swapped).toMatchObject({ ok: false, error: { code: 'state_invalid' } });
		expect((await client.completeAuthorization({ callbackUrl: first.callbackUrl, browserState: first.state })).ok).toBe(
			true
		);
		const replay = await client.completeAuthorization({ callbackUrl: first.callbackUrl, browserState: first.state });
		expect(replay).toMatchObject({ ok: false, error: { code: 'state_invalid' } });

		const foreign = await authorize(login, account.sub);
		foreign.callbackUrl.searchParams.set('iss', 'https://evil.example/realms/fsp');
		const mixUp = await client.completeAuthorization({ callbackUrl: foreign.callbackUrl, browserState: foreign.state });
		expect(mixUp).toMatchObject({ ok: false, error: { code: 'iss_mismatch' } });

		const tamper = async (field: 'nonce' | 'codeVerifier') => {
			const flow = await authorize(login, account.sub);
			const key = `oidc_flow:${sha256Hex(flow.state)}`;
			const stored = JSON.parse((await redis.get(key)) ?? '{}') as Record<string, unknown>;
			stored[field] = createHash('sha256').update(randomUUID()).digest('base64url');
			await redis.set(key, JSON.stringify(stored), { expiration: { type: 'EX', value: 60 } });
			return client.completeAuthorization({ callbackUrl: flow.callbackUrl, browserState: flow.state });
		};
		expect(await tamper('nonce')).toMatchObject({ ok: false, error: { code: 'token_invalid' } });
		expect(await tamper('codeVerifier')).toMatchObject({ ok: false, error: { code: 'provider_error' } });
	});
});

describe('linking FSP ID to an existing account', () => {
	it('links after a new login at the provider, and refuses an identity of another account', async () => {
		const local = await register(deps(), meta(), registrationInput({}));
		if (!local.ok) throw new Error('registration refused');
		const session = await sessionOf(local.sessionId);
		const account = await demoAccount('Школьница, 16 лет, командный призёр');

		// The provider shows its login page again even to a browser that has just signed in (prompt=login).
		const browser = new Browser();
		await authorize({ intent: 'login', returnTo: '/' }, account.sub, browser);
		const link = await authorize(
			{ intent: 'link', forUserId: local.userId, returnTo: '/account' },
			account.sub,
			browser
		);
		expect(link.loginShown).toBe(true);
		const completed = await client.completeAuthorization({ callbackUrl: link.callbackUrl, browserState: link.state });
		if (!completed.ok) throw new Error(completed.error.code);

		// The flow of one user returned into another user's session: refused.
		const intruder = await register(deps(), meta(), registrationInput({}));
		if (!intruder.ok) throw new Error('registration refused');
		expect(await completeFspSignIn(deps(), meta(), completed.value, await sessionOf(intruder.sessionId), null)).toEqual(
			{
				kind: 'refused',
				reason: 'session_mismatch'
			}
		);

		expect(await completeFspSignIn(deps(), meta(), completed.value, session, null)).toEqual({
			kind: 'linked',
			returnTo: '/account'
		});
		const [identity] = await database.db
			.select()
			.from(externalIdentities)
			.where(eq(externalIdentities.subject, account.sub));
		expect(identity).toMatchObject({ userId: local.userId, linkMethod: 'linked_by_user' });

		// Now the same FSP ID for the intruder's account is refused and journaled.
		const second = await authorize({ intent: 'link', forUserId: intruder.userId, returnTo: '/account' }, account.sub);
		const secondDone = await client.completeAuthorization({
			callbackUrl: second.callbackUrl,
			browserState: second.state
		});
		if (!secondDone.ok) throw new Error(secondDone.error.code);
		expect(
			await completeFspSignIn(deps(), meta(), secondDone.value, await sessionOf(intruder.sessionId), null)
		).toEqual({
			kind: 'refused',
			reason: 'identity_already_linked'
		});
		const refused = (await journal('identity.link_refused')).filter((e) => e.actorUserId === intruder.userId);
		expect(refused).toHaveLength(1);
	});
});

/** A live demo session, as `/demo` opens it for a visitor. */
async function openDemoSession(): Promise<string> {
	const [session] = await database.db
		.insert(demoSessions)
		.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + 86_400_000) })
		.returning({ id: demoSessions.id });
	if (!session) throw new Error('demo session not inserted');
	return session.id;
}

/** The visitor's demo session as the registration form hands it over on a demonstration stand. */
const inSession =
	(sessionId: string): VisitorDemoSession =>
	() =>
		Promise.resolve({ ok: true, sessionId });

/** «Привязать ФСП ID» from the account page of `userId`, completed with a new login at the provider as `sub`. */
async function linkFrom(userId: string, current: SessionRef, sub: string) {
	const link = await authorize({ intent: 'link', forUserId: userId, returnTo: '/account' }, sub);
	const completed = await client.completeAuthorization({ callbackUrl: link.callbackUrl, browserState: link.state });
	if (!completed.ok) throw new Error(completed.error.code);
	return completeFspSignIn(deps(), meta(), completed.value, current, null);
}

/** What the worker does with the one queued `fsp.sync` job, against the simulator of this file. */
async function runSync(): Promise<string> {
	const sql = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(sql, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await sql.end({ timeout: 5 });
	}
	const claimed = await claimJob(database.db, 'auth-test', ['fsp.sync']);
	if (claimed?.type !== 'fsp.sync') throw new Error('no fsp.sync job to run');
	const job: ClaimedJob<'fsp.sync'> = {
		...claimed,
		type: 'fsp.sync',
		payload: JOB_TYPES['fsp.sync'].payload.parse(claimed.payload)
	};
	const handler = createFspSyncHandler(() => ({
		source: new HttpAchievementsSource({
			baseUrl: mockOrigin,
			webhookSecret: 'auth-test-webhook-secret-0123456789abcdef'
		}),
		grants: new ServiceGrantIssuer({
			issuer: `${mockOrigin}/realms/fsp`,
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			assertionSecret: ASSERTION_SECRET
		}),
		signer: createReceiptSigner({ issuer: 'http://platform.test', keyId: 'test-1', seed: Buffer.alloc(32, 7) })
	}));
	const result = await handler.run({
		job,
		db: database.db,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log: createLogger({}, () => undefined)
	});
	return completeJob(database.db, job, result);
}

describe('linking FSP ID to an account registered within a demo session', () => {
	it('links within the session, imports the achievements into its profile, and refuses a clone of the cast', async () => {
		const { db } = database;
		const session = await openDemoSession();
		const other = await openDemoSession();
		const account = await demoAccount('Командный призёр без специализации');

		// A visitor registers by password within their demo session and links their FSP ID from the account page.
		const visitor = await register(deps(), meta(), registrationInput({ demoSession: inSession(session) }));
		if (!visitor.ok) throw new Error(`registration refused: ${JSON.stringify(visitor)}`);
		const current = await sessionOf(visitor.sessionId);
		expect(await linkFrom(visitor.userId, current, account.sub)).toEqual({ kind: 'linked', returnTo: '/account' });
		expect(
			await db.select().from(externalIdentities).where(eq(externalIdentities.userId, visitor.userId))
		).toMatchObject([{ subject: account.sub, linkMethod: 'linked_by_user', demoSessionId: session }]);

		// Another account of the same session cannot take the identity; an account of another session links its own.
		const neighbour = await register(deps(), meta(), registrationInput({ demoSession: inSession(session) }));
		if (!neighbour.ok) throw new Error('registration refused');
		expect(await linkFrom(neighbour.userId, await sessionOf(neighbour.sessionId), account.sub)).toEqual({
			kind: 'refused',
			reason: 'identity_already_linked'
		});
		const elsewhere = await register(deps(), meta(), registrationInput({ demoSession: inSession(other) }));
		if (!elsewhere.ok) throw new Error('registration refused');
		expect(await linkFrom(elsewhere.userId, await sessionOf(elsewhere.sessionId), account.sub)).toMatchObject({
			kind: 'linked'
		});

		// «Подтвердить достижения из ФСП»: the athlete link of the session, the import, the achievements in the profile.
		expect(await grantProfileConsent(deps(), meta(), current, documents.pdProcessing)).toEqual({ ok: true });
		const confirmed = await confirmFspAchievements(deps(), meta(), current, {
			issuer: `${mockOrigin}/realms/fsp`,
			documentId: documents.fspImport
		});
		if (!confirmed.ok) throw new Error(confirmed.reason);
		const [link] = await db.select().from(athleteLinks).where(eq(athleteLinks.id, confirmed.linkId));
		expect(link).toMatchObject({ userId: visitor.userId, sourceAthleteId: account.sub, demoSessionId: session });
		expect(await runSync()).toBe('succeeded');
		const [candidate] = await db.select().from(candidates).where(eq(candidates.userId, visitor.userId));
		const facts = await db
			.select()
			.from(sourceFacts)
			.where(and(eq(sourceFacts.candidateId, candidate?.id ?? ''), eq(sourceFacts.source, 'fsp')));
		expect(facts.length).toBeGreaterThan(0);

		// A clone of the cast in the session is never reached through FSP ID, linking included.
		const clone = await createUser(db, { demoSessionId: session, seedBatchId: 'demo-1' });
		const cloneSession = { ...current, userId: clone.id };
		expect(await linkFrom(clone.id, cloneSession, (await demoAccount('Длинная история')).sub)).toEqual({
			kind: 'refused',
			reason: 'demo_account'
		});
		expect(await db.select().from(externalIdentities).where(eq(externalIdentities.userId, clone.id))).toEqual([]);
	});
});

describe('achievements and unlinking', () => {
	it('links the athlete with the consent and queues the first import in one transaction', async () => {
		const registration = await registerThroughFsp('Длинная история');
		const session = await sessionOf(registration.sessionId);
		const refusedBeforeConsent = await confirmFspAchievements(deps(), meta(), session, {
			issuer: `${mockOrigin}/realms/fsp`,
			documentId: documents.fspImport
		});
		expect(refusedBeforeConsent).toEqual({ ok: false, reason: 'not_candidate' });
		expect(await grantProfileConsent(deps(), meta(), session, documents.pdProcessing)).toEqual({ ok: true });

		const confirmed = await confirmFspAchievements(deps(), meta(), session, {
			issuer: `${mockOrigin}/realms/fsp`,
			documentId: documents.fspImport
		});
		if (!confirmed.ok) throw new Error(confirmed.reason);
		const [link] = await database.db.select().from(athleteLinks).where(eq(athleteLinks.id, confirmed.linkId));
		expect(link).toMatchObject({
			userId: registration.userId,
			sourceAthleteId: registration.account.sub,
			resolutionMethod: 'subject_equals_athlete_id',
			status: 'active'
		});
		const [job] = await database.db.select().from(jobs).where(eq(jobs.id, confirmed.jobId));
		expect(job).toMatchObject({ type: 'fsp.sync', status: 'queued', payload: { athlete_link_id: confirmed.linkId } });
		const [consent] = await database.db
			.select()
			.from(consentEvents)
			.where(and(eq(consentEvents.kind, 'fsp_import'), eq(consentEvents.signerUserId, registration.userId)));
		expect(job?.inputVersion).toBe(`${confirmed.linkId}:${consent?.id ?? ''}`);
	});

	it('unlinks only with a way back in, withdrawing imported facts and cancelling the waiting import; the cleanup removes every version', async () => {
		const registration = await registerThroughFsp('Командный призёр без специализации');
		const issuer = `${mockOrigin}/realms/fsp`;
		const session = await sessionOf(registration.sessionId);
		await grantProfileConsent(deps(), meta(), session, documents.pdProcessing);
		const confirmed = await confirmFspAchievements(deps(), meta(), session, {
			issuer,
			documentId: documents.fspImport
		});
		if (!confirmed.ok) throw new Error(confirmed.reason);
		const [candidate] = await database.db.select().from(candidates).where(eq(candidates.userId, registration.userId));
		const [consent] = await database.db
			.select()
			.from(consentEvents)
			.where(and(eq(consentEvents.kind, 'fsp_import'), eq(consentEvents.signerUserId, registration.userId)));
		const [fact] = await database.db
			.insert(sourceFacts)
			.values({
				candidateId: candidate?.id ?? '',
				source: 'fsp',
				factType: 'competition_result',
				sourceRecordRef: `result-${randomUUID()}`,
				trustLevel: 'fsp_verified',
				ownershipBasis: 'athlete_link',
				ownershipRef: confirmed.linkId,
				consentEventId: consent?.id ?? null,
				payload: { place: 2 },
				payloadSha256: sha256Hex(randomUUID()),
				observedAt: new Date(),
				lastVerifiedAt: new Date(),
				status: 'active'
			})
			.returning();
		await database.db.insert(claims).values({
			candidateId: candidate?.id ?? '',
			factId: fact?.id ?? '',
			claimType: 'achievement_mention',
			rawText: '2 место',
			polarity: 'asserted',
			extractor: 'source_mapping',
			status: 'active'
		});
		// Earlier versions of records of the link: one replaced by a new version, one annulled at the source. They left
		// the profile before the unlinking, but their payload, claims and receipts are still personal data of the link.
		const retired = [];
		for (const status of ['superseded', 'annulled'] as const) {
			const payloadSha256 = sha256Hex(randomUUID());
			const [row] = await database.db
				.insert(sourceFacts)
				.values({
					candidateId: candidate?.id ?? '',
					source: 'fsp',
					factType: 'competition_result',
					sourceRecordRef: `result-${randomUUID()}`,
					trustLevel: 'fsp_verified',
					ownershipBasis: 'athlete_link',
					ownershipRef: confirmed.linkId,
					consentEventId: consent?.id ?? null,
					payload: { place: 3 },
					payloadSha256,
					observedAt: new Date(),
					lastVerifiedAt: new Date(),
					status,
					statusReason: status === 'superseded' ? 'source_new_version' : 'source_annulled'
				})
				.returning();
			if (!row) throw new Error('fact not inserted');
			retired.push(row);
			await database.db.insert(claims).values({
				candidateId: candidate?.id ?? '',
				factId: row.id,
				claimType: 'achievement_mention',
				rawText: '3 место',
				polarity: 'asserted',
				extractor: 'source_mapping',
				status: 'invalidated'
			});
			await database.db.insert(verificationReceipts).values({
				handle: Array.from(randomBytes(26), (byte) => 'abcdefghijklmnopqrstuvwxyz234567'[byte % 32]).join(''),
				factId: row.id,
				factPayloadSha256: payloadSha256,
				disclosureLevel: 'generalized',
				statement: { receipt_version: 1 },
				statementSha256: sha256Hex(randomUUID()),
				signature: 'signature',
				signingKeyId: 'test-1',
				commitmentNonce: randomBytes(16),
				issuedAt: new Date()
			});
		}
		const linkFactIds = [fact?.id ?? '', ...retired.map((row) => row.id)];

		// Without a password and another identity the person would lose every way in.
		expect(await unlinkFspIdentity(deps(), meta(), session, issuer)).toEqual({
			ok: false,
			reason: 'last_sign_in_method'
		});
		await database.db
			.insert(passwordCredentials)
			.values({ userId: registration.userId, hash: '$argon2id$v=19$m=19456,t=2,p=1$x$y', changedAt: new Date() });
		const stale = { ...session, authTime: new Date(Date.now() - 11 * 60_000) };
		expect(await unlinkFspIdentity(deps(), meta(), stale, issuer)).toEqual({ ok: false, reason: 'stale_auth' });

		expect(await unlinkFspIdentity(deps(), meta(), session, issuer)).toEqual({ ok: true, withdrawnFacts: 3 });
		expect(
			await database.db.select().from(externalIdentities).where(eq(externalIdentities.userId, registration.userId))
		).toEqual([]);
		const [link] = await database.db.select().from(athleteLinks).where(eq(athleteLinks.id, confirmed.linkId));
		expect(link).toMatchObject({ status: 'unlinked', basisIdentityId: null });
		const [job] = await database.db.select().from(jobs).where(eq(jobs.id, confirmed.jobId));
		expect(job?.status).toBe('cancelled');
		const [withdrawn] = await database.db
			.select()
			.from(sourceFacts)
			.where(eq(sourceFacts.id, fact?.id ?? ''));
		expect(withdrawn).toMatchObject({ status: 'withdrawn', statusReason: 'identity_unlinked' });
		const [claim] = await database.db
			.select()
			.from(claims)
			.where(eq(claims.factId, fact?.id ?? ''));
		expect(claim?.status).toBe('invalidated');
		const [after] = await database.db
			.select()
			.from(candidates)
			.where(eq(candidates.id, candidate?.id ?? ''));
		expect(after?.evidenceFloorRevision).toBe(after?.profileRevision);
		expect((after?.profileRevision ?? 0) > (candidate?.profileRevision ?? 0)).toBe(true);
		expect((await journal('identity.unlinked')).filter((e) => e.actorUserId === registration.userId)).toHaveLength(1);
		expect(
			await database.db
				.select({ status: sourceFacts.status })
				.from(sourceFacts)
				.where(inArray(sourceFacts.id, linkFactIds))
		).toEqual(linkFactIds.map(() => ({ status: 'withdrawn' })));

		// The cleanup of the ended link removes every version of its records, not only the one active at the unlinking.
		const cleanup = (await claimJob(database.db, 'auth-test', [
			'consent.revocation_cleanup'
		])) as ClaimedJob<'consent.revocation_cleanup'> | null;
		if (!cleanup) throw new Error('the cleanup is not queued');
		expect(cleanup.payload).toEqual({ athlete_link_id: confirmed.linkId });
		const result = await consentRevocationCleanup.run({
			job: cleanup,
			db: database.db,
			signal: new AbortController().signal,
			requestId: `job:${cleanup.id}`,
			log: createLogger({}, () => undefined)
		});
		expect(await completeJob(database.db, cleanup, result)).toBe('succeeded');
		expect(await database.db.select().from(sourceFacts).where(inArray(sourceFacts.id, linkFactIds))).toEqual([]);
		expect(await database.db.select().from(claims).where(inArray(claims.factId, linkFactIds))).toEqual([]);
		expect(
			await database.db.select().from(verificationReceipts).where(inArray(verificationReceipts.factId, linkFactIds))
		).toEqual([]);
	});
});

/** A flow store whose commands fail, as a Redis connection that dropped after the client was made. */
const brokenStore = {
	set: () => Promise.reject(new Error('The client is closed')),
	getDel: () => Promise.reject(new Error('The client is closed'))
} as unknown as Redis;

interface RouteScenario {
	signIn: (typeof import('../../src/routes/auth/fsp/+server'))['GET'];
	link: (typeof import('../../src/routes/auth/fsp/link/+server'))['POST'];
	callback: (typeof import('../../src/routes/auth/fsp/callback/+server'))['GET'];
	closeRedis: () => void;
	closeDb: () => Promise<void>;
}

/** The routes with a fresh `config()` and Redis connection over the given environment. */
async function routesOver(overrides: Record<string, string>): Promise<RouteScenario> {
	for (const name of Object.keys(env)) Reflect.deleteProperty(env, name);
	Object.assign(
		env,
		testEnvironment({
			DATABASE_URL: database.url,
			REDIS_URL: inject('redisUrl'),
			FSP_ID_ISSUER: `${mockOrigin}/realms/fsp`,
			FSP_ID_CLIENT_ID: CLIENT_ID,
			FSP_ID_CLIENT_SECRET: CLIENT_SECRET,
			FSP_ID_REDIRECT_URI: REDIRECT_URI,
			...overrides
		})
	);
	vi.resetModules();
	return {
		signIn: (await import('../../src/routes/auth/fsp/+server')).GET,
		link: (await import('../../src/routes/auth/fsp/link/+server')).POST,
		callback: (await import('../../src/routes/auth/fsp/callback/+server')).GET,
		closeRedis: (await import('$lib/server/redis')).closeRedis,
		closeDb: (await import('$lib/server/db')).closeDb
	};
}

/** The part of a request event the FSP ID routes read. */
function routeEvent(url: string, actor: 'anonymous' | 'session', cookies: Record<string, string> = {}) {
	const jar = new Map<string, string>(Object.entries(cookies));
	const requestId = `route-${randomUUID()}`;
	const event = {
		url: new URL(url),
		request: new Request(url),
		getClientAddress: () => '10.30.0.2',
		locals: {
			requestId,
			actor:
				actor === 'session'
					? {
							kind: 'session',
							userId: randomUUID(),
							sessionHash: sha256Hex(randomUUID()),
							authTime: new Date(),
							authMethod: 'password',
							csrfToken: randomUUID()
						}
					: { kind: 'anonymous' }
		},
		cookies: {
			get: (name: string) => jar.get(name),
			set: (name: string, value: string) => void jar.set(name, value),
			delete: (name: string) => void jar.delete(name)
		}
	};
	return { event: event as never, requestId };
}

/** Where the route sends the browser; an error page instead of a redirect fails the test. */
async function redirectOf(handler: (event: never) => unknown, event: never): Promise<string> {
	try {
		await handler(event);
	} catch (thrown) {
		if (typeof thrown === 'object' && thrown !== null && 'location' in thrown && 'status' in thrown) {
			expect(thrown.status).toBe(303);
			return String(thrown.location);
		}
		throw thrown;
	}
	throw new Error('the route answered without a redirect');
}

describe('when FSP ID or the flow store is unreachable', () => {
	it('sends a visitor back to the sign-in page when the provider does not answer', async () => {
		const unreachable = `http://127.0.0.1:${await freePort()}/realms/fsp`;
		const routes = await routesOver({ FSP_ID_ISSUER: unreachable });
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const start = routeEvent('http://app.test/auth/fsp', 'anonymous');
			expect(await redirectOf(routes.signIn, start.event)).toBe('/login?error=fsp_unavailable');
			expect(logged.mock.calls.flat().join(' ')).toContain(start.requestId);

			const link = routeEvent('http://app.test/auth/fsp/link', 'session');
			expect(await redirectOf(routes.link, link.event)).toBe('/account?fsp=failed');
			expect(logged.mock.calls.flat().join(' ')).toContain(link.requestId);
		} finally {
			logged.mockRestore();
			routes.closeRedis();
		}
	});

	it('sends the browser back with an explanation instead of an error page when Redis is down', async () => {
		const routes = await routesOver({ REDIS_URL: `redis://127.0.0.1:${await freePort()}` });
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const start = routeEvent('http://app.test/auth/fsp', 'anonymous');
			expect(await redirectOf(routes.signIn, start.event)).toBe('/login?error=fsp_failed');
			expect(logged.mock.calls.flat().join(' ')).toContain(start.requestId);

			const link = routeEvent('http://app.test/auth/fsp/link', 'session');
			expect(await redirectOf(routes.link, link.event)).toBe('/account?fsp=failed');

			const back = routeEvent('http://app.test/auth/fsp/callback?state=s&code=c', 'anonymous');
			expect(await redirectOf(routes.callback, back.event)).toBe('/login?error=fsp_failed');
			expect(logged.mock.calls.flat().join(' ')).toContain(back.requestId);
		} finally {
			logged.mockRestore();
			routes.closeRedis();
		}
	});

	it('sends the browser back with an explanation when the database fails after the provider answered', async () => {
		const routes = await routesOver({ DATABASE_URL: `postgres://app:app@127.0.0.1:${await freePort()}/app` });
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const { sub } = await demoAccount('Капитан, backend, МС');
			const visitor = await authorize({ intent: 'login', returnTo: '/onboarding' }, sub);
			const back = routeEvent(visitor.callbackUrl.href, 'anonymous', { [FSP_FLOW_COOKIE]: visitor.state });
			expect(await redirectOf(routes.callback, back.event)).toBe('/login?error=fsp_failed');
			expect(logged.mock.calls.flat().join(' ')).toContain(back.requestId);

			const linking = await authorize({ intent: 'link', returnTo: '/account', forUserId: randomUUID() }, sub);
			const signedIn = routeEvent(linking.callbackUrl.href, 'session', { [FSP_FLOW_COOKIE]: linking.state });
			expect(await redirectOf(routes.callback, signedIn.event)).toBe('/account?fsp=failed');
			expect(logged.mock.calls.flat().join(' ')).toContain(signedIn.requestId);
		} finally {
			logged.mockRestore();
			routes.closeRedis();
			await routes.closeDb();
		}
	});

	it('reports a flow store that fails its commands as a result, not an exception', async () => {
		const broken = createFspIdClient(
			{
				issuer: `${mockOrigin}/realms/fsp`,
				clientId: CLIENT_ID,
				clientSecret: CLIENT_SECRET,
				redirectUri: REDIRECT_URI,
				scopes: 'openid profile email'
			},
			{ redis: brokenStore, now: () => new Date() }
		);
		expect(await broken.startAuthorization({ intent: 'login', returnTo: '/onboarding' })).toMatchObject({
			ok: false,
			error: { code: 'store_unavailable', retryable: true }
		});
		const callbackUrl = new URL(`${REDIRECT_URI}?state=s&code=c`);
		expect(await broken.completeAuthorization({ callbackUrl, browserState: 's' })).toMatchObject({
			ok: false,
			error: { code: 'store_unavailable', retryable: true }
		});
	});
});
