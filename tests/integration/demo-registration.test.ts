// Registration by password on a demonstration stand (docs/domain.md, 19.3): the account is created within the visitor's
// demo session — the account, the profile or the company belong to that session. Two visitors registering the same
// address in two sessions get an account each, seen from its own session only, confirmed without a letter (the session's
// form of an address is no mailbox the visitor reads) and signed in to by password from that session only; the removal
// of a session takes its account with it. A clone of the cast is refused a sign-in by password within its session as
// the original is outside. The taxpayer number of a company is taken within its session only. The sign-in and the
// password reset find the account of the browser's session first, whatever its status, then the one outside sessions; an
// account of the seed gets no reset letter. Outside demonstration mode the registration is what it was: outside
// sessions, with a letter.
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { AuthDeps, RequestMeta } from '$lib/server/auth/context';
import type { VisitorDemoSession } from '$lib/server/auth/identities';
import { loginWithPassword } from '$lib/server/auth/login';
import { requestPasswordReset, resetPassword } from '$lib/server/auth/recovery';
import { hashPassword } from '$lib/server/auth/password';
import { accountAddress, register, type RegistrationInput } from '$lib/server/auth/registration';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	candidates,
	companies,
	companyMembers,
	demoSessions,
	emailTokens,
	passwordCredentials,
	users
} from '$lib/server/db/schema';
import { cloneEmail } from '$lib/server/demo/cast';
import { purgeDemoSession } from '$lib/server/demo/purge';
import { demoScope } from '$lib/server/demo/scope';
import type { MailMessage } from '$lib/server/mail/mailer';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { testEnvironment } from '../helpers/environment';
import { createPublishedDocument, createUser, randomSha256 } from '../helpers/factories';

const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const PASSWORD = 'correct horse battery';

let database: TestDatabase;
let redis: Redis;
let documents: { userAgreement: string; employerTerms: string };
/** Every letter the registrations of this file sent. */
const sent: MailMessage[] = [];

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 7)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 8)
});

function deps(): AuthDeps {
	return {
		db: database.db,
		redis,
		crypto,
		mailer: {
			send: (message) => {
				sent.push(message);
				return Promise.resolve({ ok: true, value: { messageId: randomUUID() } });
			}
		},
		appOrigin: 'http://app.test',
		now: () => new Date()
	};
}

let address = 0;
/** Every call signs in from its own address, so the per-address counters of the tests do not meet. */
function meta(): RequestMeta {
	address++;
	return {
		requestId: `test-${randomUUID()}`,
		ip: `10.60.${Math.floor(address / 250)}.${address % 250}`,
		userAgent: 'vitest'
	};
}

const noObjects: ObjectStore = {
	put: () => Promise.reject(new Error('no objects in this test')),
	get: () => Promise.resolve(null),
	delete: () => Promise.resolve(),
	exists: () => Promise.resolve(false)
};

/** The visitor's demo session as the registration form hands it over on a demonstration stand. */
const inSession =
	(sessionId: string): VisitorDemoSession =>
	() =>
		Promise.resolve({ ok: true, sessionId });

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

/** A valid 10-digit INN with a random body: the check digit is computed as the registry does. */
function randomInn(): string {
	const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
	const body = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
	const sum = weights.reduce((total, weight, index) => total + weight * (body[index] ?? 0), 0);
	return [...body, (sum % 11) % 10].join('');
}

function candidateInput(email: string, demoSession: VisitorDemoSession | null): RegistrationInput {
	return {
		email,
		displayName: 'Анна Смирнова',
		password: PASSWORD,
		role: 'candidate',
		birthDate: '2001-03-14',
		company: null,
		documents: { userAgreementId: documents.userAgreement, employerTermsId: null },
		fsp: null,
		demoSession
	};
}

async function registered(input: RegistrationInput) {
	const result = await register(deps(), meta(), input);
	if (!result.ok) throw new Error(`registration refused: ${JSON.stringify(result)}`);
	return result;
}

async function signIn(email: string, demoSessionId: string | null, password = PASSWORD) {
	return loginWithPassword(deps(), meta(), { email, password, demoSessionId }, null);
}

async function userOf(userId: string) {
	const [row] = await database.db.select().from(users).where(eq(users.id, userId));
	if (!row) throw new Error(`no account ${userId}`);
	return row;
}

async function candidateOf(userId: string) {
	const [row] = await database.db.select().from(candidates).where(eq(candidates.userId, userId));
	if (!row) throw new Error(`no candidate of ${userId}`);
	return row;
}

/** Profiles a viewer of the session (`null` — outside sessions) sees, among the given ones. */
async function candidatesVisibleTo(viewerSession: string | null, ids: string[]): Promise<string[]> {
	const rows = await database.db
		.select({ id: candidates.id })
		.from(candidates)
		.where(and(inArray(candidates.id, ids), demoScope(candidates, viewerSession)));
	return rows.map((row) => row.id).sort();
}

/** Companies a viewer of the session (`null` — outside sessions) sees, among the given ones. */
async function companiesVisibleTo(viewerSession: string | null, ids: string[]): Promise<string[]> {
	const rows = await database.db
		.select({ id: companies.id })
		.from(companies)
		.where(and(inArray(companies.id, ids), demoScope(companies, viewerSession)));
	return rows.map((row) => row.id).sort();
}

function lettersTo(address: string): MailMessage[] {
	return sent.filter((message) => message.to === address);
}

beforeAll(async () => {
	database = await createTestDatabase();
	redis = createClient({ url: inject('redisUrl') });
	await redis.connect();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl') }));
	documents = {
		userAgreement: (await createPublishedDocument(database.db, 'user_agreement')).id,
		employerTerms: (await createPublishedDocument(database.db, 'employer_terms')).id
	};
}, 120_000);

afterAll(async () => {
	redis.destroy();
	await database.drop();
});

describe('registration by password on a demonstration stand', () => {
	it('gives each visitor an account of their own session, seen and signed in to there only, gone with it', async () => {
		const { db } = database;
		const email = `visitor-${randomUUID()}@example.org`;
		const first = await openSession();
		const second = await openSession();

		// Two visitors, two sessions, the same address typed.
		const inFirst = await registered(candidateInput(email, inSession(first)));
		const inSecond = await registered(candidateInput(email, inSession(second)));
		expect(inSecond.userId).not.toBe(inFirst.userId);
		for (const [registration, session] of [
			[inFirst, first],
			[inSecond, second]
		] as const) {
			const user = await userOf(registration.userId);
			expect(user).toMatchObject({ demoSessionId: session, seedBatchId: null, status: 'active' });
			expect(user.emailHmac).toBe(crypto.lookupHmac('email', cloneEmail(email, session)));
			// Confirmed as the clones of the cast are: no letter and no link to follow.
			expect(user.emailVerifiedAt).not.toBeNull();
			expect(registration.letter).toBe('not_needed');
			expect(lettersTo(cloneEmail(email, session))).toEqual([]);
			expect(await db.select().from(emailTokens).where(eq(emailTokens.userId, registration.userId))).toEqual([]);
			expect(await candidateOf(registration.userId)).toMatchObject({ demoSessionId: session, demoOriginal: false });
		}
		expect(lettersTo(email)).toEqual([]);

		// Each profile is seen from its own session only: not by the other session nor outside sessions.
		const profiles = [(await candidateOf(inFirst.userId)).id, (await candidateOf(inSecond.userId)).id];
		expect(await candidatesVisibleTo(first, profiles)).toEqual([profiles[0]]);
		expect(await candidatesVisibleTo(second, profiles)).toEqual([profiles[1]]);
		expect(await candidatesVisibleTo(null, profiles)).toEqual([]);

		// The password signs in to the account of the browser's session; outside sessions the address has no account.
		expect(await signIn(email, first)).toMatchObject({ ok: true, userId: inFirst.userId });
		expect(await signIn(email, second)).toMatchObject({ ok: true, userId: inSecond.userId });
		expect(await signIn(email, null)).toEqual({ ok: false, reason: 'invalid_credentials', retryAfterSeconds: null });
		// The session's form of the address typed outside the session reaches nothing either.
		expect(await signIn(cloneEmail(email, first), null)).toEqual({
			ok: false,
			reason: 'invalid_credentials',
			retryAfterSeconds: null
		});

		// The removal of a session takes its account; the other session keeps its own.
		expect(await purgeDemoSession({ db, redis, store: noObjects }, first, new Date(), 'test-purge')).not.toBeNull();
		expect(await db.select().from(users).where(eq(users.id, inFirst.userId))).toEqual([]);
		expect(await db.select().from(candidates).where(eq(candidates.userId, inFirst.userId))).toEqual([]);
		expect(await signIn(email, first)).toMatchObject({ ok: false, reason: 'invalid_credentials' });
		expect(await signIn(email, second)).toMatchObject({ ok: true, userId: inSecond.userId });
	});

	it('creates the company of an employer within the session, seen from it only', async () => {
		const session = await openSession();
		const other = await openSession();
		const email = `hr-${randomUUID()}@example.org`;
		const registration = await registered({
			...candidateInput(email, inSession(session)),
			role: 'employer',
			birthDate: null,
			company: { inn: randomInn(), name: 'ООО Демо' },
			documents: { userAgreementId: documents.userAgreement, employerTermsId: documents.employerTerms }
		});
		expect(await userOf(registration.userId)).toMatchObject({ demoSessionId: session, status: 'active' });
		const [company] = await database.db
			.select({ id: companies.id, demoSessionId: companies.demoSessionId, role: companyMembers.role })
			.from(companyMembers)
			.innerJoin(companies, eq(companies.id, companyMembers.companyId))
			.where(eq(companyMembers.userId, registration.userId));
		expect(company).toMatchObject({ demoSessionId: session, role: 'owner' });
		if (!company) throw new Error('no company');
		expect(await companiesVisibleTo(session, [company.id])).toEqual([company.id]);
		expect(await companiesVisibleTo(other, [company.id])).toEqual([]);
		expect(await companiesVisibleTo(null, [company.id])).toEqual([]);
		expect(await signIn(email, session)).toMatchObject({ ok: true, userId: registration.userId });
	});

	it('takes the taxpayer number of a company within the session only', async () => {
		const inn = randomInn();
		const first = await openSession();
		const second = await openSession();
		const employer = (session: string | null, email = `hr-${randomUUID()}@example.org`): RegistrationInput => ({
			...candidateInput(email, session === null ? null : inSession(session)),
			role: 'employer',
			birthDate: null,
			company: { inn, name: 'ООО Один ИНН' },
			documents: { userAgreementId: documents.userAgreement, employerTermsId: documents.employerTerms }
		});
		const companiesWith = async () =>
			(await database.db.select({ session: companies.demoSessionId }).from(companies).where(eq(companies.inn, inn)))
				.map((row) => row.session ?? 'outside')
				.sort();

		// Outside sessions and in each of two sessions the same number registers a company of its own.
		await registered(employer(null));
		await registered(employer(first));
		await registered(employer(second));
		expect(await companiesWith()).toEqual([first, second, 'outside'].sort());

		// A second company with the number in the same place is refused, and nothing of it is written.
		for (const session of [first, null]) {
			const email = `hr-${randomUUID()}@example.org`;
			const refused = await register(deps(), meta(), employer(session, email));
			expect(refused).toMatchObject({ ok: false, errors: { inn: expect.stringContaining('ИНН') as unknown } });
			expect(
				await database.db
					.select()
					.from(users)
					.where(eq(users.emailHmac, crypto.lookupHmac('email', accountAddress(email, session))))
			).toEqual([]);
		}
		expect(await companiesWith()).toEqual([first, second, 'outside'].sort());
	});

	it('resets the password of the account of the browser’s session, not of another session or outside sessions', async () => {
		const email = `forgot-${randomUUID()}@example.org`;
		const first = await openSession();
		const second = await openSession();
		const inFirst = await registered(candidateInput(email, inSession(first)));
		await registered(candidateInput(email, inSession(second)));

		// Outside sessions the address has no account, and the session's form of it typed there reaches nothing.
		await requestPasswordReset(deps(), email, null);
		await requestPasswordReset(deps(), cloneEmail(email, first), null);
		expect(lettersTo(email)).toEqual([]);
		expect(lettersTo(cloneEmail(email, first))).toEqual([]);

		// From the browser of the first session: the account of that session, the letter to its address.
		await requestPasswordReset(deps(), email, first);
		const letters = lettersTo(cloneEmail(email, first));
		expect(letters.map((letter) => letter.subject)).toEqual([expect.stringContaining('Сброс пароля')]);
		expect(lettersTo(cloneEmail(email, second))).toEqual([]);
		const token = /token=([^\s"&]+)/.exec(letters[0]?.text ?? '')?.[1];
		if (!token) throw new Error('the reset letter has no link');
		expect(await resetPassword(deps(), meta(), decodeURIComponent(token), 'a brand new passphrase')).toEqual({
			ok: true
		});
		expect(await signIn(email, first, 'a brand new passphrase')).toMatchObject({ ok: true, userId: inFirst.userId });
		// The other session keeps its password.
		expect(await signIn(email, second)).toMatchObject({ ok: true });
		expect(await signIn(email, second, 'a brand new passphrase')).toMatchObject({ ok: false });
	});

	it('finds the account of the browser’s session first for the sign-in and the reset alike, whatever its status', async () => {
		const email = `blocked-${randomUUID()}@example.org`;
		const session = await openSession();
		const outside = await registered(candidateInput(email, null));
		await database.db.update(users).set({ status: 'active' }).where(eq(users.id, outside.userId));
		const inside = await registered(candidateInput(email, inSession(session)));
		await database.db.update(users).set({ status: 'suspended' }).where(eq(users.id, inside.userId));
		const before = sent.length;

		// The suspended account of the session answers for the address: neither form reaches the account outside sessions.
		expect(await signIn(email, session)).toEqual({ ok: false, reason: 'account_inactive', retryAfterSeconds: null });
		await requestPasswordReset(deps(), email, session);
		expect(sent.slice(before)).toEqual([]);

		// Without the session the address is the account outside sessions for both.
		expect(await signIn(email, null)).toMatchObject({ ok: true, userId: outside.userId });
		await requestPasswordReset(deps(), email, null);
		expect(sent.slice(before).map((letter) => letter.to)).toEqual([email]);
	});

	it('sends no reset letter to an account of the demo seed', async () => {
		const session = await openSession();
		const castEmail = `cast-${randomUUID()}@example.org`;
		for (const [address, demoSessionId] of [
			[castEmail, null],
			[cloneEmail(castEmail, session), session]
		] as const) {
			await createUser(database.db, {
				emailEnc: crypto.encrypt(address, 'users.email'),
				emailHmac: crypto.lookupHmac('email', address),
				demoSessionId,
				seedBatchId: 'demo-1'
			});
		}
		await requestPasswordReset(deps(), castEmail, session);
		await requestPasswordReset(deps(), castEmail, null);
		expect(lettersTo(castEmail)).toEqual([]);
		expect(lettersTo(cloneEmail(castEmail, session))).toEqual([]);
	});

	it('refuses a password to a clone of the cast within its session before checking it', async () => {
		const session = await openSession();
		const castEmail = `cast-${randomUUID()}@example.org`;
		const address = cloneEmail(castEmail, session);
		const clone = await createUser(database.db, {
			emailEnc: crypto.encrypt(address, 'users.email'),
			emailHmac: crypto.lookupHmac('email', address),
			demoSessionId: session,
			seedBatchId: 'demo-1'
		});
		await database.db
			.insert(passwordCredentials)
			.values({ userId: clone.id, hash: await hashPassword(PASSWORD), changedAt: new Date() });
		for (const attempt of [PASSWORD, 'a wrong password']) {
			expect(await signIn(castEmail, session, attempt)).toEqual({
				ok: false,
				reason: 'demo_account',
				retryAfterSeconds: null
			});
		}
	});

	it('asks for the session only for a valid form, and writes nothing when the session cannot be had', async () => {
		const email = `refused-${randomUUID()}@example.org`;
		const invalid = await register(deps(), meta(), {
			...candidateInput(email, () => Promise.reject(new Error('the demo session must not be asked for'))),
			password: 'short'
		});
		expect(invalid).toMatchObject({ ok: false, errors: { password: expect.any(String) as unknown } });

		const refused = await register(
			deps(),
			meta(),
			candidateInput(email, () => Promise.resolve({ ok: false, reason: 'stand_full' }))
		);
		expect(refused).toEqual({ ok: false, demoRefused: 'stand_full' });
		for (const form of [email, cloneEmail(email, randomUUID())]) {
			expect(
				await database.db
					.select()
					.from(users)
					.where(eq(users.emailHmac, crypto.lookupHmac('email', form)))
			).toEqual([]);
		}
	});

	it('refuses the registration when the demo session ended before it was written', async () => {
		const session = await openSession();
		await database.db.update(demoSessions).set({ expiresAt: new Date() }).where(eq(demoSessions.id, session));
		const result = await register(
			deps(),
			meta(),
			candidateInput(`late-${randomUUID()}@example.org`, inSession(session))
		);
		expect(result).toMatchObject({
			ok: false,
			errors: { documents: expect.stringContaining('Демо-сессия закончилась') as unknown }
		});
		expect(await database.db.select().from(users).where(eq(users.demoSessionId, session))).toEqual([]);
	});
});

describe('outside demonstration mode', () => {
	it('creates the account outside sessions with the address as typed, to be confirmed by the letter', async () => {
		const email = `plain-${randomUUID()}@example.org`;
		const registration = await registered(candidateInput(email, null));
		const user = await userOf(registration.userId);
		expect(user).toMatchObject({ demoSessionId: null, status: 'pending_email', emailVerifiedAt: null });
		expect(user.emailHmac).toBe(crypto.lookupHmac('email', email));
		expect(registration.letter).toBe('sent');
		expect(lettersTo(email).map((letter) => letter.subject)).toEqual([expect.stringContaining('Подтвердите почту')]);
		expect(await signIn(email, null)).toMatchObject({ ok: true, userId: registration.userId });

		// A browser with a demo session still reaches the account outside sessions when its session has none.
		const session = await openSession();
		expect(await signIn(email, session)).toMatchObject({ ok: true, userId: registration.userId });
	});
});
