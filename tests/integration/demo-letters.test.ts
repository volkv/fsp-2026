// Letters of a demo session (docs/domain.md, section 19.3): a letter to the representative of a candidate of the
// session is kept with the session and read on its letters page, with a link that works; a letter of the stand outside
// sessions is never kept. The notifications of the session's accounts show there as the letters they would be. The
// page is a clone's, for the letters of its own session only: for another session, a real account or an anonymous
// visitor it does not exist. The confirmation of the address and the password reset of an account registered within the
// session are kept too, and the browser holding the session reads them signed in to nothing — the letters to the
// accounts of its own session and no other letter. Removing the session removes its letters.
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { Actor } from '$lib/server/access/actor';
import {
	candidates,
	demoLetters,
	demoSessions,
	legalDocuments,
	legalRepresentatives,
	notifications,
	representations,
	users
} from '$lib/server/db/schema';
import type { MailMessage, Mailer } from '$lib/server/mail/mailer';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createPublishedDocument, createUser, randomSha256 } from '../helpers/factories';

// The pages read `config()`: its environment points at this file's database once it exists.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const { closeDb } = await import('$lib/server/db');
const { config } = await import('$lib/server/config');
const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { sendConsentLetter } = await import('$lib/server/consent/representative');
const { purgeDemoSession } = await import('$lib/server/demo/purge');
const { DEMO_SESSION_COOKIE } = await import('$lib/server/demo/visit');
const { cloneEmail } = await import('$lib/server/demo/cast');
const { requestPasswordReset, resetPassword } = await import('$lib/server/auth/recovery');
const { register } = await import('$lib/server/auth/registration');
const { verifyEmail } = await import('$lib/server/auth/verification');
const { sha256Hex } = await import('$lib/server/auth/secrets');
const { testEnvironment } = await import('../helpers/environment');
const listPage = await import('../../src/routes/(app)/demo/mail/+page.server');
const letterPage = await import('../../src/routes/(app)/demo/mail/[id]/+page.server');
const consentPage = await import('../../src/routes/(auth)/representative/consent/+page.server');

const DAY = 86_400_000;

/** A demonstration stand: the letters page reads the demo session of the browser's cookie on it only. */
const DEMONSTRATION_STAND = {
	DEMO_MODE: 'true',
	FSP_MOCK_SEED: 'demo-letters',
	FSP_MOCK_ATHLETES: '200',
	FSP_MOCK_CONTROL_TOKEN: 'demo-letters-control-token-0123456789',
	FSP_ID_ISSUER: 'http://127.0.0.1:1/realms/fsp',
	FSP_ID_CLIENT_ID: 'demo-letters',
	FSP_ID_CLIENT_SECRET: 'demo-letters-client-secret',
	FSP_ID_REDIRECT_URI: 'http://127.0.0.1:1/auth/fsp/callback',
	FSP_ACHIEVEMENTS_ADAPTER: 'mock',
	FSP_ACHIEVEMENTS_BASE_URL: 'http://127.0.0.1:1',
	FSP_WEBHOOK_SECRET: 'demo-letters-webhook-secret-0123456789',
	FSP_ASSERTION_SECRET: 'demo-letters-assertion-secret-0123456789'
};
const REDIS_DATABASE = 14;
const meta = { requestId: 'demo-letters-test', ip: '127.0.0.1', userAgent: 'vitest' };

/** Letters as the mailbox of the stand receives them. */
class Outbox implements Mailer {
	readonly letters: MailMessage[] = [];

	send(message: MailMessage) {
		this.letters.push(message);
		return Promise.resolve({ ok: true as const, value: { messageId: `letter-${this.letters.length}` } });
	}
}

/** The removal of a session with no files: the store is never asked. */
const noFiles: ObjectStore = {
	put: () => Promise.reject(new Error('no files in this test')),
	get: () => Promise.reject(new Error('no files in this test')),
	delete: () => Promise.reject(new Error('no files in this test')),
	exists: () => Promise.reject(new Error('no files in this test'))
};

let database: TestDatabase;
let redis: Redis;
const outbox = new Outbox();

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
	const published = { publishedAt: new Date(Date.now() - 10 * DAY) };
	for (const kind of ['pd_processing', 'catalog_visibility', 'fsp_import', 'user_agreement'] as const) {
		await createPublishedDocument(database.db, kind, published);
	}
});

afterAll(async () => {
	redis.destroy();
	await closeDb();
	await database.drop();
});

const letterDeps = () => ({
	db: database.db,
	crypto: fieldCrypto(),
	mailer: outbox,
	appOrigin: config().appOrigin,
	now: () => new Date()
});

/** Join tokens of the sessions this file opened, by session: the cookie a browser of the session holds. */
const joinTokens = new Map<string, string>();

async function demoSession(createdAt = new Date()): Promise<string> {
	const token = randomBytes(24).toString('base64url');
	const [row] = await database.db
		.insert(demoSessions)
		.values({
			joinTokenSha256: sha256Hex(token),
			seedBatchId: 'demo-1',
			expiresAt: new Date(createdAt.getTime() + DAY),
			createdAt
		})
		.returning();
	if (!row) throw new Error('demo session not inserted');
	joinTokens.set(row.id, token);
	return row.id;
}

async function account(session: string | null, displayName: string) {
	const crypto = fieldCrypto();
	const email = `${displayName.toLowerCase()}-${randomBytes(4).toString('hex')}@example.org`;
	const [user] = await database.db
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			displayName,
			demoSessionId: session
		})
		.returning();
	if (!user) throw new Error('user not inserted');
	return { ...user, email };
}

/** A candidate aged 16 whose representative's authority the operator verified, in the session when one is given. */
async function teenager(session: string | null) {
	const crypto = fieldCrypto();
	const user = await account(session, 'Alice');
	const birth = new Date(Date.now() - 30 * DAY);
	birth.setUTCFullYear(birth.getUTCFullYear() - 16);
	const [candidate] = await database.db
		.insert(candidates)
		.values({
			userId: user.id,
			status: 'active',
			searchStatus: 'active',
			preferences: {},
			birthDate: birth.toISOString().slice(0, 10),
			birthDatePrecision: 'day',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified',
			demoSessionId: session
		})
		.returning();
	if (!candidate) throw new Error('candidate not inserted');
	const representativeEmail = `parent-${randomBytes(4).toString('hex')}@example.org`;
	const [representative] = await database.db
		.insert(legalRepresentatives)
		.values({
			fullNameEnc: crypto.encrypt('Захарова Елена Викторовна', 'legal_representatives.full_name'),
			emailEnc: crypto.encrypt(representativeEmail, 'legal_representatives.email'),
			emailHmac: crypto.lookupHmac('email', representativeEmail)
		})
		.returning();
	if (!representative) throw new Error('representative not inserted');
	const [representation] = await database.db
		.insert(representations)
		.values({
			candidateId: candidate.id,
			representativeId: representative.id,
			relation: 'parent',
			status: 'authority_verified',
			invitedAt: new Date(Date.now() - 2 * DAY),
			contactConfirmedAt: new Date(Date.now() - 2 * DAY)
		})
		.returning();
	if (!representation) throw new Error('representation not inserted');
	return { userId: user.id, candidateId: candidate.id, representationId: representation.id, representativeEmail };
}

/** The operator's letter with the consents to sign. */
async function sendLetter(teen: { userId: string; representationId: string }) {
	expect(await sendConsentLetter(letterDeps(), meta, { kind: 'system' }, teen.representationId)).toEqual({
		ok: true
	});
}

const session = (userId: string): Actor => ({
	kind: 'session',
	userId,
	sessionHash: randomSha256(),
	authTime: new Date(),
	authMethod: 'password',
	csrfToken: 'csrf'
});

/** A browser of the page: signed in as `actor`, holding the cookie of the demo session `browserSession` if given. */
function event(actor: Actor, url: string, params: Record<string, string> = {}, browserSession: string | null = null) {
	const token = browserSession === null ? undefined : joinTokens.get(browserSession);
	return {
		url: new URL(url),
		params,
		request: new Request(url),
		cookies: { get: (name: string) => (name === DEMO_SESSION_COOKIE ? token : undefined) },
		locals: { requestId: 'req-page', actor },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		depends: () => {}
	};
}

interface ListData {
	scope: string;
	letters: {
		id: string;
		status: string;
		subject: string;
		recipient: { kind: string; address: string; name?: string };
	}[];
}
interface LetterData {
	letter: { id: string; status: string; subject: string; text: string; recipient: { address: string } };
}

const list = async (actor: Actor, browserSession: string | null = null) =>
	(await listPage.load(event(actor, 'http://localhost/demo/mail', {}, browserSession) as never)) as ListData;
const open = async (actor: Actor, id: string, browserSession: string | null = null) =>
	(await letterPage.load(
		event(actor, `http://localhost/demo/mail/${id}`, { id }, browserSession) as never
	)) as LetterData;

const authDeps = () => ({ ...letterDeps(), redis });

/** An account a visitor registered by password within the session: its address is the session's form of the typed one. */
async function registeredInSession(sessionId: string, displayName: string) {
	const crypto = fieldCrypto();
	const typed = `${displayName.toLowerCase()}-${randomBytes(4).toString('hex')}@example.org`;
	const address = cloneEmail(typed, sessionId);
	const user = await createUser(database.db, {
		status: 'active',
		emailEnc: crypto.encrypt(address, 'users.email'),
		emailHmac: crypto.lookupHmac('email', address),
		displayName,
		demoSessionId: sessionId
	});
	return { userId: user.id, typed, address };
}

describe('letters of a demo session', () => {
	it('keeps the letter to the representative of a session candidate, and its link works', async () => {
		const sessionId = await demoSession();
		const teen = await teenager(sessionId);
		await sendLetter(teen);

		const kept = await database.db.select().from(demoLetters).where(eq(demoLetters.demoSessionId, sessionId));
		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatchObject({ kind: 'consents', objectType: 'representation', objectId: teen.representationId });
		// The address is masked and the body, which carries the one-time link, is encrypted.
		expect(kept[0]?.recipientMasked).toBe(`pa***@example.org`);
		expect(Buffer.from(kept[0]?.bodyEnc ?? []).toString('utf8')).not.toContain('token=');

		const { letters } = await list(session(teen.userId));
		const letter = letters.find((item) => item.recipient.kind === 'representative');
		expect(letter).toMatchObject({ status: 'sent', recipient: { address: 'pa***@example.org' } });
		if (!letter) throw new Error('no letter on the page');

		const opened = await open(session(teen.userId), letter.id);
		const sent = outbox.letters.findLast((item) => item.to === teen.representativeEmail);
		expect(opened.letter.text).toBe(sent?.text);
		const link = /(https?:\/\/\S+\/representative\/consent\?token=\S+)/.exec(opened.letter.text)?.[1];
		if (link === undefined) throw new Error('the letter has no link');
		const url = new URL(link);
		expect(url.origin).toBe(config().appOrigin);
		const page = (await consentPage.load({ url } as never)) as { form: { candidateName: string } | null };
		expect(page.form).toMatchObject({ candidateName: 'Alice' });
	});

	it('keeps no letter of a candidate outside demo sessions', async () => {
		const before = await database.db.$count(demoLetters);
		const teen = await teenager(null);
		await sendLetter(teen);
		expect(outbox.letters.findLast((item) => item.to === teen.representativeEmail)).toBeDefined();
		expect(await database.db.$count(demoLetters)).toBe(before);
	});

	it('shows the notifications of the session accounts since it opened as letters that would be sent', async () => {
		const openedAt = new Date(Date.now() - 60_000);
		const sessionId = await demoSession(openedAt);
		const teen = await teenager(sessionId);
		const notification = (createdAt: Date) => ({
			userId: teen.userId,
			type: 'representation.decided',
			category: 'account' as const,
			objectType: 'representation',
			objectId: teen.representationId,
			dedupKey: `demo-letters-${randomBytes(6).toString('hex')}`,
			payload: { result: 'verified' },
			createdAt
		});
		const [fresh, copied] = await database.db
			.insert(notifications)
			.values([notification(new Date()), notification(new Date(openedAt.getTime() - DAY))])
			.returning();
		if (!fresh || !copied) throw new Error('notifications not inserted');

		const { letters } = await list(session(teen.userId));
		expect(letters.map((item) => item.id)).toEqual([fresh.id]);
		expect(letters[0]).toMatchObject({ status: 'not_delivered', recipient: { kind: 'account' } });
		const opened = await open(session(teen.userId), fresh.id);
		expect(opened.letter.subject).toContain('Полномочия представителя подтверждены');
		expect(opened.letter.text).toContain(`${config().appOrigin}/notifications/${fresh.id}`);
		// A notification copied with the cast is not a letter of the session.
		await expect(open(session(teen.userId), copied.id)).rejects.toMatchObject({ status: 404 });
	});

	it('is a page of a clone for its own session only', async () => {
		const first = await demoSession();
		const second = await demoSession();
		const teen = await teenager(first);
		await sendLetter(teen);
		const [letter] = await database.db.select().from(demoLetters).where(eq(demoLetters.demoSessionId, first));
		if (!letter) throw new Error('no letter kept');
		const otherClone = await account(second, 'Bob');
		const person = await account(null, 'Carol');

		await expect(open(session(otherClone.id), letter.id)).rejects.toMatchObject({ status: 404 });
		expect((await list(session(otherClone.id))).letters).toEqual([]);
		await expect(list(session(person.id))).rejects.toMatchObject({ status: 404 });
		await expect(open(session(person.id), letter.id)).rejects.toMatchObject({ status: 404 });
		await expect(list({ kind: 'anonymous' })).rejects.toMatchObject({ status: 404 });
		await expect(open(session(teen.userId), 'not-an-id')).rejects.toMatchObject({ status: 404 });
	});

	it('keeps the password reset of an account of the session, read by the browser of the session signed in to nothing', async () => {
		const sessionId = await demoSession();
		const other = await demoSession();
		const visitor = await registeredInSession(sessionId, 'Dana');
		const teen = await teenager(sessionId);
		await sendLetter(teen);

		// The visitor forgot the password: the letter leaves for the mailbox of the stand and is kept with the session.
		await requestPasswordReset(authDeps(), visitor.typed, sessionId);
		const [kept] = await database.db
			.select()
			.from(demoLetters)
			.where(and(eq(demoLetters.demoSessionId, sessionId), eq(demoLetters.kind, 'password_reset')));
		expect(kept).toMatchObject({ objectType: 'user', objectId: visitor.userId, recipientMasked: 'da***@example.org' });
		expect(Buffer.from(kept?.bodyEnc ?? []).toString('utf8')).not.toContain('token=');
		if (!kept) throw new Error('no reset letter kept');

		// Signed in to nothing, the browser of the session reads the resets of its session, and nothing else of it.
		const guest = await list({ kind: 'anonymous' }, sessionId);
		expect(guest.scope).toBe('accounts');
		expect(guest.letters.map((letter) => letter.id)).toEqual([kept.id]);
		expect(guest.letters[0]).toMatchObject({ status: 'sent', recipient: { kind: 'account', name: 'Dana' } });
		const [representativeLetter] = await database.db
			.select()
			.from(demoLetters)
			.where(and(eq(demoLetters.demoSessionId, sessionId), eq(demoLetters.kind, 'consents')));
		if (!representativeLetter) throw new Error('no representative letter kept');
		await expect(open({ kind: 'anonymous' }, representativeLetter.id, sessionId)).rejects.toMatchObject({
			status: 404
		});

		// The browser of another session, and one without a session, read nothing of it.
		expect((await list({ kind: 'anonymous' }, other)).letters).toEqual([]);
		await expect(open({ kind: 'anonymous' }, kept.id, other)).rejects.toMatchObject({ status: 404 });
		await expect(open({ kind: 'anonymous' }, kept.id)).rejects.toMatchObject({ status: 404 });

		// The link of the letter sets the new password.
		const opened = await open({ kind: 'anonymous' }, kept.id, sessionId);
		expect(opened.letter.text).toBe(outbox.letters.findLast((item) => item.to === visitor.address)?.text);
		const token = /\/password\/reset\?token=([^\s&]+)/.exec(opened.letter.text)?.[1];
		if (token === undefined) throw new Error('the letter has no link');
		expect(await resetPassword(authDeps(), meta, decodeURIComponent(token), 'a brand new passphrase for dana')).toEqual(
			{ ok: true }
		);

		// A signed-in account of the session reads the reset among every letter of the session.
		const signedIn = await list(session(teen.userId));
		expect(signedIn.scope).toBe('all');
		expect(signedIn.letters.map((letter) => letter.id)).toEqual(
			expect.arrayContaining([kept.id, representativeLetter.id])
		);
	});

	it('keeps the confirmation of the address of an account registered in the session, its link confirms it', async () => {
		const sessionId = await demoSession();
		const other = await demoSession();
		const otherClone = await account(other, 'Bob');
		const [agreement] = await database.db
			.select({ id: legalDocuments.id })
			.from(legalDocuments)
			.where(eq(legalDocuments.kind, 'user_agreement'));
		if (!agreement) throw new Error('no user agreement published');
		const typed = `fedor-${randomBytes(4).toString('hex')}@example.org`;
		const registration = await register(authDeps(), meta, {
			email: typed,
			displayName: 'Фёдор',
			password: 'correct horse battery staple',
			role: 'candidate',
			birthDate: '2001-03-14',
			company: null,
			documents: { userAgreementId: agreement.id, employerTermsId: null },
			fsp: null,
			demoSession: () => Promise.resolve({ ok: true, sessionId })
		});
		if (!registration.ok) throw new Error(`registration refused: ${JSON.stringify(registration)}`);
		expect(registration.letter).toBe('sent');
		const unconfirmed = async () =>
			(await database.db.select().from(users).where(eq(users.id, registration.userId)))[0]?.emailVerifiedAt;
		expect(await unconfirmed()).toBeNull();

		// The account itself reads it among the letters of its session, as the letter that left for the stand's mailbox.
		const { letters } = await list(session(registration.userId));
		const letter = letters.find((item) => item.subject.includes('Подтвердите почту'));
		expect(letter).toMatchObject({ status: 'sent', recipient: { kind: 'account', name: 'Фёдор' } });
		if (!letter) throw new Error('no confirmation letter on the page');
		// So does the browser of the session signed in to nothing; another session, by its clone or its browser, does not.
		expect((await list({ kind: 'anonymous' }, sessionId)).letters.map((item) => item.id)).toContain(letter.id);
		expect((await list(session(otherClone.id))).letters).toEqual([]);
		await expect(open(session(otherClone.id), letter.id)).rejects.toMatchObject({ status: 404 });
		await expect(open({ kind: 'anonymous' }, letter.id, other)).rejects.toMatchObject({ status: 404 });

		// The link of the letter confirms the address, as outside demo sessions.
		const opened = await open(session(registration.userId), letter.id);
		expect(opened.letter.text).toBe(outbox.letters.findLast((item) => item.to === cloneEmail(typed, sessionId))?.text);
		const token = /\/verify-email\?token=([^\s&]+)/.exec(opened.letter.text)?.[1];
		if (token === undefined) throw new Error('the letter has no link');
		expect(await verifyEmail(authDeps(), meta, decodeURIComponent(token))).toEqual({
			ok: true,
			userId: registration.userId
		});
		expect(await unconfirmed()).toBeInstanceOf(Date);
	});

	it('keeps no reset letter of an account outside demo sessions', async () => {
		const before = await database.db.$count(demoLetters);
		const person = await account(null, 'Erin');
		await requestPasswordReset(authDeps(), person.email, null);
		expect(outbox.letters.findLast((item) => item.to === person.email)).toBeDefined();
		expect(await database.db.$count(demoLetters)).toBe(before);
	});

	it('goes with the session when it is removed', async () => {
		const sessionId = await demoSession();
		const teen = await teenager(sessionId);
		await sendLetter(teen);
		const other = await demoSession();
		const otherTeen = await teenager(other);
		await sendLetter(otherTeen);
		expect(await database.db.$count(demoLetters, eq(demoLetters.demoSessionId, sessionId))).toBe(1);

		const purged = await purgeDemoSession(
			{ db: database.db, redis, store: noFiles },
			sessionId,
			new Date(),
			meta.requestId
		);
		expect(purged?.rowsRemoved).toBeGreaterThan(0);
		expect(await database.db.$count(demoLetters, eq(demoLetters.demoSessionId, sessionId))).toBe(0);
		expect(await database.db.$count(demoLetters, eq(demoLetters.demoSessionId, other))).toBe(1);
	});
});
