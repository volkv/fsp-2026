// Registration, address confirmation, sign-in by password, lockout, reset and sessions against a real database, Redis
// and SMTP server (Mailpit in a container): letters are read back from the mailbox, links are followed as a person would.
import { randomUUID } from 'node:crypto';
import { hash as argon2 } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { createClient } from 'redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { authenticateSession } from '$lib/server/auth/authenticate';
import type { AuthDeps, RequestMeta } from '$lib/server/auth/context';
import { loginWithPassword } from '$lib/server/auth/login';
import {
	confirmRepresentativeContact,
	grantProfileConsent,
	inviteRepresentative,
	onboardingState,
	redeclareBirthDate
} from '$lib/server/auth/onboarding';
import { register, type RegistrationInput } from '$lib/server/auth/registration';
import { changePassword, requestPasswordReset, resetPassword } from '$lib/server/auth/recovery';
import { sha256Hex } from '$lib/server/auth/secrets';
import { createSession, readSession, SESSION_ABSOLUTE_SECONDS, sessionRef } from '$lib/server/auth/sessions';
import { signOut, signOutEverywhere } from '$lib/server/auth/signout';
import { verifyEmail } from '$lib/server/auth/verification';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	candidates,
	candidateSurveys,
	gradeDeclarations,
	companies,
	companyMembers,
	consentEvents,
	documentAcceptances,
	legalRepresentatives,
	notificationChannels,
	passwordCredentials,
	representations,
	users
} from '$lib/server/db/schema';
import { createSmtpMailer } from '$lib/server/mail/mailer';
import type { Redis } from '$lib/server/redis';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createPublishedDocument, createTaxonomyVersion } from '../helpers/factories';

const MAILPIT_IMAGE = 'axllent/mailpit:v1.31.2';
const APP_ORIGIN = 'http://app.test';
const PASSWORD = 'correct horse battery';

let database: TestDatabase;
let redis: Redis;
let mailpit: StartedTestContainer;
let mailApi: string;
let documents: { userAgreement: string; employerTerms: string; pdProcessing: string };

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});
const clock = { now: new Date() };
let smtpUrl: string;

function deps(): AuthDeps {
	return {
		db: database.db,
		redis,
		crypto,
		mailer: createSmtpMailer({ smtpUrl, from: 'ФСП Карьера <no-reply@fsp-career.test>' }),
		appOrigin: APP_ORIGIN,
		now: () => clock.now
	};
}

let address = 0;
/** Every test signs in from its own address, so the per-address counters of parallel tests do not meet. */
function meta(ip = `10.20.${Math.floor(++address / 250)}.${address % 250}`): RequestMeta {
	return { requestId: `test-${randomUUID()}`, ip, userAgent: 'vitest' };
}

const newEmail = () => `person-${randomUUID()}@example.org`;

function yearsAgo(years: number, days = 0): string {
	const date = new Date(clock.now);
	date.setUTCFullYear(date.getUTCFullYear() - years);
	date.setUTCDate(date.getUTCDate() - days);
	return date.toISOString().slice(0, 10);
}

function candidateInput(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
	return {
		email: newEmail(),
		displayName: 'Анна Смирнова',
		password: PASSWORD,
		role: 'candidate',
		birthDate: yearsAgo(22),
		company: null,
		documents: { userAgreementId: documents.userAgreement, employerTermsId: null },
		fsp: null,
		demoSession: null,
		...overrides
	};
}

/** A valid 10-digit INN with a random body: the check digit is computed as the registry does. */
function randomInn(): string {
	const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
	const body = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
	const sum = weights.reduce((total, weight, index) => total + weight * (body[index] ?? 0), 0);
	return [...body, (sum % 11) % 10].join('');
}

interface Letter {
	subject: string;
	text: string;
}

/** Letters to the address, newest first, as the mailbox shows them. */
async function lettersTo(to: string): Promise<Letter[]> {
	const search = await fetch(`${mailApi}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
	const { messages } = (await search.json()) as { messages: { ID: string; Subject: string }[] };
	return Promise.all(
		messages.map(async (message) => {
			const body = (await (await fetch(`${mailApi}/api/v1/message/${message.ID}`)).json()) as { Text: string };
			return { subject: message.Subject, text: body.Text };
		})
	);
}

/** Waits for a letter to the address whose subject contains `subject` and returns the token of its link. */
async function tokenFromLetter(to: string, subject: string): Promise<string> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const letter = (await lettersTo(to)).find((l) => l.subject.includes(subject));
		if (letter) {
			const match = /token=([A-Za-z0-9_-]+)/.exec(letter.text);
			if (!match?.[1]) throw new Error(`letter «${letter.subject}» has no token link`);
			return decodeURIComponent(match[1]);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`no letter «${subject}» to ${to}`);
}

async function registered(overrides: Partial<RegistrationInput> = {}) {
	const input = candidateInput(overrides);
	const result = await register(deps(), meta(), input);
	if (!result.ok) throw new Error(`registration refused: ${JSON.stringify(result)}`);
	return { ...result, email: input.email };
}

async function actorOf(sessionId: string) {
	return authenticateSession({ db: database.db, redis, now: () => clock.now }, sessionId);
}

async function sessionOf(sessionId: string) {
	const session = await readSession(redis, sessionId, clock.now);
	if (!session) throw new Error('session does not exist');
	return sessionRef(session);
}

async function emailChannels(userId: string) {
	const rows = await database.db
		.select({ status: notificationChannels.status })
		.from(notificationChannels)
		.where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, 'email')));
	return rows.map((r) => r.status);
}

async function journal(action: string, objectId: string) {
	return database.db
		.select()
		.from(auditEvents)
		.where(and(eq(auditEvents.action, action), eq(auditEvents.objectId, objectId)));
}

beforeAll(async () => {
	[database, mailpit] = await Promise.all([
		createTestDatabase(),
		new GenericContainer(MAILPIT_IMAGE)
			.withExposedPorts(1025, 8025)
			.withWaitStrategy(Wait.forHttp('/readyz', 8025))
			.start()
	]);
	smtpUrl = `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`;
	mailApi = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
	redis = createClient({ url: inject('redisUrl') });
	await redis.connect();
	const { db } = database;
	documents = {
		userAgreement: (await createPublishedDocument(db, 'user_agreement')).id,
		employerTerms: (await createPublishedDocument(db, 'employer_terms')).id,
		pdProcessing: (await createPublishedDocument(db, 'pd_processing')).id
	};
	// The clock of the tests starts after the documents are published.
	clock.now = new Date();
});

afterAll(async () => {
	redis.destroy();
	await Promise.all([database.drop(), mailpit.stop()]);
});

describe('registration of a candidate', () => {
	it('creates the account, signs in and sends a confirmation that activates it once', async () => {
		const account = await registered();
		const [user] = await database.db.select().from(users).where(eq(users.id, account.userId));
		expect(user?.status).toBe('pending_email');
		expect(user?.emailHmac).toBe(crypto.lookupHmac('email', account.email.toUpperCase()));
		// The address is stored encrypted only.
		expect(Buffer.from(user?.emailEnc ?? []).toString('utf8')).not.toContain(account.email);
		const [candidate] = await database.db.select().from(candidates).where(eq(candidates.userId, account.userId));
		expect(candidate).toMatchObject({
			status: 'onboarding',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified',
			visibility: 'hidden'
		});
		const accepted = await database.db
			.select()
			.from(documentAcceptances)
			.where(eq(documentAcceptances.userId, account.userId));
		expect(accepted.map((a) => a.documentId)).toEqual([documents.userAgreement]);
		expect(account.letter).toBe('sent');
		expect((await actorOf(account.sessionId))?.userId).toBe(account.userId);

		const token = await tokenFromLetter(account.email, 'Подтвердите почту');
		expect(await verifyEmail(deps(), meta(), token)).toEqual({ ok: true, userId: account.userId });
		const [verified] = await database.db.select().from(users).where(eq(users.id, account.userId));
		expect(verified?.status).toBe('active');
		expect(verified?.emailVerifiedAt).not.toBeNull();
		expect(await journal('auth.email_verified', account.userId)).toHaveLength(1);
		expect(await emailChannels(account.userId)).toEqual(['active']);
		// Single use: the same link does not confirm twice.
		expect(await verifyEmail(deps(), meta(), token)).toEqual({ ok: false, reason: 'invalid_token' });
		expect(await emailChannels(account.userId)).toEqual(['active']);
	});

	it('opens the profile with the personal-data consent given on its own screen', async () => {
		const account = await registered();
		const session = await sessionOf(account.sessionId);
		expect(await grantProfileConsent(deps(), meta(), session, documents.pdProcessing)).toEqual({ ok: true });
		const [candidate] = await database.db.select().from(candidates).where(eq(candidates.userId, account.userId));
		expect(candidate?.status).toBe('active');
		const [consent] = await database.db
			.select()
			.from(consentEvents)
			.where(eq(consentEvents.subjectCandidateId, candidate?.id ?? ''));
		expect(consent).toMatchObject({
			kind: 'pd_processing',
			action: 'grant',
			signerKind: 'subject',
			signerUserId: account.userId,
			method: 'separate_screen_button'
		});
		expect(consent?.evidence).toMatchObject({ session_hash: session.hash, ip: expect.any(String) as unknown });
		// A second grant on the same path is not offered.
		expect(await grantProfileConsent(deps(), meta(), session, documents.pdProcessing)).toEqual({
			ok: false,
			reason: 'not_applicable'
		});
	});

	it('refuses a taken address in any letter case, invalid fields and a superseded document', async () => {
		const first = await registered();
		const again = await register(deps(), meta(), candidateInput({ email: first.email.toUpperCase() }));
		expect(again).toMatchObject({
			ok: false,
			errors: { email: expect.stringContaining('уже зарегистрирован') as unknown }
		});

		const invalid = await register(
			deps(),
			meta(),
			candidateInput({ email: 'not-an-address', password: 'short', birthDate: '2031-02-30', displayName: 'A' })
		);
		if (invalid.ok || !('errors' in invalid)) throw new Error(`expected field errors, got ${JSON.stringify(invalid)}`);
		expect(Object.keys(invalid.errors).sort()).toEqual(['birthDate', 'displayName', 'email', 'password']);

		const stale = await register(
			deps(),
			meta(),
			candidateInput({ documents: { userAgreementId: documents.pdProcessing, employerTermsId: null } })
		);
		expect(stale).toMatchObject({ ok: false, errors: { documents: expect.any(String) as unknown } });
	});
});

describe('registration of an employer', () => {
	it('creates a draft company with the registrant as its owner and records both agreements', async () => {
		const inn = randomInn();
		const account = await registered({
			role: 'employer',
			birthDate: null,
			company: { inn, name: 'ООО «Тест»' },
			documents: { userAgreementId: documents.userAgreement, employerTermsId: documents.employerTerms }
		});
		const [company] = await database.db.select().from(companies).where(eq(companies.inn, inn));
		expect(company?.status).toBe('draft');
		const [member] = await database.db.select().from(companyMembers).where(eq(companyMembers.userId, account.userId));
		expect(member).toMatchObject({ companyId: company?.id, role: 'owner', status: 'active' });
		const accepted = await database.db
			.select()
			.from(documentAcceptances)
			.where(eq(documentAcceptances.userId, account.userId));
		expect(accepted.find((a) => a.documentId === documents.employerTerms)?.companyId).toBe(company?.id);
		// Candidate and employer do not mix in one account.
		expect(await database.db.select().from(candidates).where(eq(candidates.userId, account.userId))).toEqual([]);
		expect((await onboardingState(deps(), account.userId)).role).toBe('employer');

		const duplicate = await register(
			deps(),
			meta(),
			candidateInput({
				role: 'employer',
				birthDate: null,
				company: { inn, name: 'Другая' },
				documents: { userAgreementId: documents.userAgreement, employerTermsId: documents.employerTerms }
			})
		);
		expect(duplicate).toMatchObject({
			ok: false,
			errors: { inn: expect.stringContaining('уже на платформе') as unknown }
		});
		const wrongChecksum = inn.slice(0, 9) + String((Number(inn[9]) + 1) % 10);
		const invalid = await register(
			deps(),
			meta(),
			candidateInput({
				role: 'employer',
				birthDate: null,
				company: { inn: wrongChecksum, name: 'ООО «Опечатка»' },
				documents: { userAgreementId: documents.userAgreement, employerTermsId: documents.employerTerms }
			})
		);
		expect(invalid).toMatchObject({ ok: false, errors: { inn: expect.any(String) as unknown } });
	});
});

describe('age on the registration path', () => {
	it('keeps a 15-year-old in the protected mode and invites a representative', async () => {
		const account = await registered({ birthDate: yearsAgo(15, 30) });
		const session = await sessionOf(account.sessionId);
		expect(await grantProfileConsent(deps(), meta(), session, documents.pdProcessing)).toEqual({ ok: true });
		let state = await onboardingState(deps(), account.userId);
		expect(state.candidate).toMatchObject({ status: 'active', minor: true, representative: null });
		const [candidate] = await database.db.select().from(candidates).where(eq(candidates.userId, account.userId));
		expect(candidate?.visibility).toBe('hidden');
		expect(state.complete).toBe(false);

		const own = await inviteRepresentative(deps(), meta(), session, {
			fullName: 'Смирнова Мария Ивановна',
			email: account.email,
			relation: 'parent'
		});
		expect(own).toMatchObject({ ok: false, reason: 'invalid', errors: { email: expect.any(String) as unknown } });

		const parent = newEmail();
		const invited = await inviteRepresentative(deps(), meta(), session, {
			fullName: 'Смирнова Мария Ивановна',
			email: parent,
			relation: 'parent'
		});
		expect(invited).toEqual({ ok: true, letterSent: true });
		const [representation] = await database.db
			.select()
			.from(representations)
			.where(eq(representations.candidateId, candidate?.id ?? ''));
		expect(representation).toMatchObject({ status: 'invited', relation: 'parent' });
		const [representative] = await database.db
			.select()
			.from(legalRepresentatives)
			.where(eq(legalRepresentatives.id, representation?.representativeId ?? ''));
		expect(crypto.decrypt(representative?.emailEnc ?? new Uint8Array(), 'legal_representatives.email')).toBe(parent);
		state = await onboardingState(deps(), account.userId);
		expect(state.candidate?.representative).toBe('invited');
		// The steps of the candidate are done; the address is still waiting for its confirmation.
		expect(state.complete).toBe(false);
		await verifyEmail(deps(), meta(), await tokenFromLetter(account.email, 'Подтвердите почту'));
		// The survey and the declared grade complete the registration (domain 12.2).
		state = await onboardingState(deps(), account.userId);
		expect(state.candidate).toMatchObject({ survey: null, declaredGrade: null });
		expect(state.complete).toBe(false);
		const profileId = candidate?.id ?? '';
		const [survey] = await database.db
			.insert(candidateSurveys)
			.values({
				candidateId: profileId,
				version: 1,
				catalogVersion: '2026.10.1',
				taxonomyVersionId: (await createTaxonomyVersion(database.db)).id,
				direction: 'development',
				specialization: 'frontend',
				declaredSkillKeys: ['javascript'],
				preferences: {}
			})
			.returning({ id: candidateSurveys.id });
		if (!survey) throw new Error('survey not inserted');
		expect((await onboardingState(deps(), account.userId)).complete).toBe(false);
		await database.db.insert(gradeDeclarations).values({
			candidateId: profileId,
			surveyId: survey.id,
			specialization: 'frontend',
			grade: 'intern',
			hint: { version: 1, suggested: null, bases: [], caveats: [] },
			declaredAt: new Date()
		});
		state = await onboardingState(deps(), account.userId);
		expect(state.candidate).toMatchObject({
			survey: { version: 1, specialization: 'frontend' },
			declaredGrade: 'intern'
		});
		expect(state.complete).toBe(true);

		const token = await tokenFromLetter(parent, 'законного представителя');
		expect(await confirmRepresentativeContact(deps(), meta(), token)).toEqual({ ok: true });
		const [confirmed] = await database.db
			.select()
			.from(representations)
			.where(eq(representations.id, representation?.id ?? ''));
		expect(confirmed?.status).toBe('contact_confirmed');
		expect(await journal('representation.contact_confirmed', representation?.id ?? '')).toHaveLength(1);
	});

	it('refuses the profile under 14 keeping only the day it opens, and lets the person return on that day', async () => {
		const birthDate = yearsAgo(13, 10);
		const account = await registered({ birthDate });
		const [candidate] = await database.db.select().from(candidates).where(eq(candidates.userId, account.userId));
		const fourteenth = `${String(Number(birthDate.slice(0, 4)) + 14)}${birthDate.slice(4)}`;
		expect(candidate).toMatchObject({ status: 'ineligible_age', birthDate: null, eligibleFrom: fourteenth });
		const session = await sessionOf(account.sessionId);
		expect(await grantProfileConsent(deps(), meta(), session, documents.pdProcessing)).toEqual({
			ok: false,
			reason: 'not_applicable'
		});
		expect(await redeclareBirthDate(deps(), session, birthDate)).toEqual({ ok: false, reason: 'not_applicable' });

		const saved = clock.now;
		clock.now = new Date(`${fourteenth}T12:00:00Z`);
		try {
			expect(await redeclareBirthDate(deps(), session, birthDate)).toEqual({ ok: true, eligible: true });
		} finally {
			clock.now = saved;
		}
		const [returned] = await database.db.select().from(candidates).where(eq(candidates.userId, account.userId));
		expect(returned).toMatchObject({ status: 'onboarding', birthDate, eligibleFrom: null });
	});
});

describe('sign-in by password', () => {
	it('signs in with a new session id, and refuses a wrong password and an unknown address alike', async () => {
		const account = await registered();
		const previous = await sessionOf(account.sessionId);
		const signedIn = await loginWithPassword(
			deps(),
			meta(),
			{ email: account.email, password: PASSWORD, demoSessionId: null },
			previous
		);
		expect(signedIn.ok).toBe(true);
		if (!signedIn.ok) return;
		expect(signedIn.sessionId).not.toBe(account.sessionId);
		// The session of the browser before the sign-in is gone: its id does not survive the privilege change.
		expect(await actorOf(account.sessionId)).toBeNull();
		expect((await actorOf(signedIn.sessionId))?.authMethod).toBe('password');

		const wrong = await loginWithPassword(
			deps(),
			meta(),
			{ email: account.email, password: 'wrong password!', demoSessionId: null },
			null
		);
		const unknown = await loginWithPassword(
			deps(),
			meta(),
			{ email: newEmail(), password: PASSWORD, demoSessionId: null },
			null
		);
		expect(wrong).toEqual({ ok: false, reason: 'invalid_credentials', retryAfterSeconds: null });
		expect(unknown).toEqual(wrong);
		const failures = await journal('auth.login', account.userId);
		// Registration is its own event, not a sign-in.
		expect(failures.map((e) => e.outcome).sort()).toEqual(['failure', 'success']);
		expect((await journal('auth.registered', account.userId)).map((e) => e.details)).toEqual([{ method: 'password' }]);
	});

	it('locks the account after five failures, even for the right password, until the lock ends', async () => {
		const account = await registered();
		const ip = meta().ip ?? '';
		for (let attempt = 1; attempt <= 4; attempt++) {
			const result = await loginWithPassword(
				deps(),
				meta(ip),
				{ email: account.email, password: `wrong-${attempt}-x`, demoSessionId: null },
				null
			);
			expect(result).toMatchObject({ ok: false, reason: 'invalid_credentials' });
		}
		const fifth = await loginWithPassword(
			deps(),
			meta(ip),
			{ email: account.email, password: 'wrong-5-xxxx', demoSessionId: null },
			null
		);
		expect(fifth).toMatchObject({ ok: false, reason: 'locked' });
		const [user] = await database.db.select().from(users).where(eq(users.id, account.userId));
		expect(user?.lockedUntil?.getTime()).toBeGreaterThan(clock.now.getTime());
		expect(await journal('auth.lockout', account.userId)).toHaveLength(1);

		// Locked means the password is not even checked — from any address.
		const right = await loginWithPassword(
			deps(),
			meta(),
			{ email: account.email, password: PASSWORD, demoSessionId: null },
			null
		);
		expect(right).toMatchObject({ ok: false, reason: 'locked' });

		const saved = clock.now;
		clock.now = new Date((user?.lockedUntil?.getTime() ?? 0) + 1_000);
		try {
			const after = await loginWithPassword(
				deps(),
				meta(),
				{ email: account.email, password: PASSWORD, demoSessionId: null },
				null
			);
			expect(after.ok).toBe(true);
		} finally {
			clock.now = saved;
		}
	});

	it('refuses an address that has used up its failures before checking any password', async () => {
		const account = await registered();
		const ip = '10.99.99.99';
		for (let attempt = 0; attempt < 30; attempt++) {
			await loginWithPassword(
				deps(),
				meta(ip),
				{ email: newEmail(), password: 'guess-guess-guess', demoSessionId: null },
				null
			);
		}
		const result = await loginWithPassword(
			deps(),
			meta(ip),
			{ email: account.email, password: PASSWORD, demoSessionId: null },
			null
		);
		expect(result).toMatchObject({ ok: false, reason: 'address_limited' });
		expect(
			(await loginWithPassword(deps(), meta(), { email: account.email, password: PASSWORD, demoSessionId: null }, null))
				.ok
		).toBe(true);
	});

	it('recomputes a hash with parameters below the current ones on sign-in', async () => {
		const account = await registered();
		const weak = await argon2(PASSWORD, { memoryCost: 4096, timeCost: 1, parallelism: 1 });
		await database.db
			.update(passwordCredentials)
			.set({ hash: weak })
			.where(eq(passwordCredentials.userId, account.userId));
		expect(
			(await loginWithPassword(deps(), meta(), { email: account.email, password: PASSWORD, demoSessionId: null }, null))
				.ok
		).toBe(true);
		const [credential] = await database.db
			.select()
			.from(passwordCredentials)
			.where(eq(passwordCredentials.userId, account.userId));
		expect(credential?.hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
	});
});

describe('password reset', () => {
	it('sets a new password by the letter, ends every session and lifts the lock', async () => {
		const account = await registered();
		await database.db
			.update(users)
			.set({ lockedUntil: new Date(clock.now.getTime() + 600_000) })
			.where(eq(users.id, account.userId));
		expect(await emailChannels(account.userId)).toEqual([]);
		await requestPasswordReset(deps(), account.email.toUpperCase(), null);
		const token = await tokenFromLetter(account.email, 'Сброс пароля');

		// A weak password does not use the letter up.
		expect(await resetPassword(deps(), meta(), token, 'short')).toMatchObject({ ok: false, reason: 'weak' });
		expect(await resetPassword(deps(), meta(), token, 'a brand new passphrase')).toEqual({ ok: true });
		expect(await resetPassword(deps(), meta(), token, 'another new passphrase')).toEqual({
			ok: false,
			reason: 'invalid_token'
		});
		expect(await actorOf(account.sessionId)).toBeNull();
		const [user] = await database.db.select().from(users).where(eq(users.id, account.userId));
		// The letter reached the address: it is confirmed as well and becomes a delivery channel.
		expect(user).toMatchObject({ lockedUntil: null, status: 'active' });
		expect(await emailChannels(account.userId)).toEqual(['active']);
		expect(
			(
				await loginWithPassword(
					deps(),
					meta(),
					{ email: account.email, password: 'a brand new passphrase', demoSessionId: null },
					null
				)
			).ok
		).toBe(true);
		expect((await lettersTo(account.email)).some((l) => l.subject.includes('Пароль изменён'))).toBe(true);
		expect(await journal('auth.password_reset', account.userId)).toHaveLength(1);
	});

	it('sends nothing for an address nobody registered', async () => {
		const stranger = newEmail();
		await requestPasswordReset(deps(), stranger, null);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await lettersTo(stranger)).toEqual([]);
	});
});

describe('sessions', () => {
	it('ends a session whose account is suspended, and one past its absolute lifetime', async () => {
		const suspended = await registered();
		await database.db.update(users).set({ status: 'suspended' }).where(eq(users.id, suspended.userId));
		expect(await actorOf(suspended.sessionId)).toBeNull();
		expect(await redis.exists(`session:${sha256Hex(suspended.sessionId)}`)).toBe(0);

		const old = await registered();
		const saved = clock.now;
		clock.now = new Date(saved.getTime() + (SESSION_ABSOLUTE_SECONDS + 60) * 1000);
		try {
			expect(await actorOf(old.sessionId)).toBeNull();
		} finally {
			clock.now = saved;
		}
	});

	it('signs out one browser or every device, and journals both', async () => {
		const account = await registered();
		const second = await createSession(
			redis,
			{ userId: account.userId, authMethod: 'password', authTime: clock.now, ip: null, ua: null },
			clock.now
		);
		const third = await createSession(
			redis,
			{ userId: account.userId, authMethod: 'password', authTime: clock.now, ip: null, ua: null },
			clock.now
		);
		await signOut(deps(), meta(), sessionRef(third.session));
		expect(await actorOf(third.sessionId)).toBeNull();
		expect(await actorOf(second.sessionId)).not.toBeNull();

		expect(await signOutEverywhere(deps(), meta(), await sessionOf(account.sessionId))).toBe(2);
		expect(await actorOf(account.sessionId)).toBeNull();
		expect(await actorOf(second.sessionId)).toBeNull();
		expect(await journal('auth.logout', account.userId)).toHaveLength(1);
		const [revoked] = await journal('session.revoked_all', account.userId);
		expect(revoked?.details).toEqual({ count: 2 });
	});

	it('changes the password only with the current one and keeps just the rotated session', async () => {
		const account = await registered();
		const other = await createSession(
			redis,
			{ userId: account.userId, authMethod: 'password', authTime: clock.now, ip: null, ua: null },
			clock.now
		);
		const session = await sessionOf(account.sessionId);
		expect(
			await changePassword(deps(), meta(), session, { current: 'not the password', next: 'another passphrase' })
		).toEqual({ ok: false, reason: 'wrong_current' });
		const changed = await changePassword(deps(), meta(), session, { current: PASSWORD, next: 'another passphrase' });
		expect(changed.ok).toBe(true);
		if (!changed.ok) return;
		expect(await actorOf(account.sessionId)).toBeNull();
		expect(await actorOf(other.sessionId)).toBeNull();
		expect((await actorOf(changed.sessionId))?.userId).toBe(account.userId);
		expect(await journal('auth.password_changed', account.userId)).toHaveLength(1);
	});
});
