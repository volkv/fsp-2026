// The bootstrap administrator from the environment (docs/domain.md, section 4.1): created once with the confirmed
// address, the password and the administrator role, journaled without the password; a repeated start changes nothing,
// the password is set again only on request and may leave the environment once the account exists; the account signs
// in by password on a stand whose seed accounts do not, and switches a vacancy source on. An address of a demo account
// or of an account that is not active is refused.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
	BootstrapAdminRefused,
	ensureBootstrapAdmin,
	type BootstrapAdminDeps
} from '$lib/server/admin/bootstrap/ensure';
import { switchVacancySource } from '$lib/server/admin/sources';
import { authenticateSession } from '$lib/server/auth/authenticate';
import type { AuthDeps, RequestMeta } from '$lib/server/auth/context';
import { loginWithPassword } from '$lib/server/auth/login';
import { hashPassword } from '$lib/server/auth/password';
import { createSession, readSession } from '$lib/server/auth/sessions';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import {
	auditEvents,
	notificationChannels,
	passwordCredentials,
	staffRoles,
	users,
	vacancySources
} from '$lib/server/db/schema';
import type { Redis } from '$lib/server/redis';
import { HABR_SOURCE_KEY, registerVacancySources } from '$lib/server/vacancies/sources/definitions';
import { createTestDatabase, type TestDatabase } from '../helpers/database';

const REDIS_DATABASE = 15;
const PASSWORD = 'stand administrator 2026';
const NEW_PASSWORD = 'another administrator secret';

let database: TestDatabase;
let redis: Redis;

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 1)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 2)
});
const now = () => new Date();

const deps = (): BootstrapAdminDeps => ({ db: database.db, crypto, redis: () => Promise.resolve(redis), now });

const authDeps = (): AuthDeps => ({
	db: database.db,
	redis,
	crypto,
	mailer: { send: () => Promise.reject(new Error('no letters are sent here')) },
	appOrigin: 'http://app.test',
	now
});

let address = 0;
const meta = (): RequestMeta => ({
	requestId: `test-${randomUUID()}`,
	ip: `10.40.0.${++address}`,
	userAgent: 'vitest'
});
const newEmail = () => `admin-${randomUUID()}@example.org`;

/** `password: null` — the environment no longer holds it, as after the first start. */
async function ensure(email: string, options: { password?: string | null; resetPassword?: boolean } = {}) {
	return ensureBootstrapAdmin(deps(), {
		email,
		password: options.password === undefined ? PASSWORD : options.password,
		resetPassword: options.resetPassword ?? false,
		requestId: `bootstrap-${randomUUID()}`
	});
}

async function signIn(email: string, password: string) {
	return loginWithPassword(authDeps(), meta(), { email, password, demoSessionId: null }, null);
}

/** Every journal event about the account, as stored. */
async function journalOf(userId: string) {
	return database.db.select().from(auditEvents).where(eq(auditEvents.objectId, userId));
}

async function refusal(promise: Promise<unknown>): Promise<BootstrapAdminRefused> {
	const error = await promise.then(
		() => null,
		(cause: unknown) => cause
	);
	if (!(error instanceof BootstrapAdminRefused)) throw new Error(`expected a refusal, got ${String(error)}`);
	return error;
}

beforeAll(async () => {
	database = await createTestDatabase();
	await registerVacancySources(database.sql);
	redis = createClient({ url: `${inject('redisUrl')}/${REDIS_DATABASE}` });
	await redis.connect();
	await redis.flushDb();
});

afterAll(async () => {
	redis.destroy();
	await database.drop();
});

describe('bootstrap administrator', () => {
	it('is created once: active, confirmed address, Argon2id password, administrator role, journaled', async () => {
		const email = newEmail();
		const first = await ensure(email);
		expect(first).toMatchObject({ created: true, roleGranted: true, passwordSet: true, sessionsRevoked: 0 });

		const [user] = await database.db.select().from(users).where(eq(users.id, first.userId));
		expect(user).toMatchObject({ status: 'active', seedBatchId: null, demoSessionId: null });
		expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
		expect(user?.emailHmac).toBe(crypto.lookupHmac('email', email));
		if (!user?.emailEnc) throw new Error('the address is not stored');
		expect(Buffer.from(user.emailEnc).includes(Buffer.from(email))).toBe(false);
		expect(crypto.decrypt(user.emailEnc, 'users.email')).toBe(email);

		const [credential] = await database.db
			.select()
			.from(passwordCredentials)
			.where(eq(passwordCredentials.userId, first.userId));
		expect(credential?.hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

		const roles = await database.db.select().from(staffRoles).where(eq(staffRoles.userId, first.userId));
		expect(roles).toMatchObject([{ role: 'admin', extraPermissions: [], grantedBy: null, revokedAt: null }]);
		const channels = await database.db
			.select()
			.from(notificationChannels)
			.where(eq(notificationChannels.userId, first.userId));
		expect(channels).toMatchObject([{ kind: 'email', status: 'active' }]);

		const journal = await journalOf(first.userId);
		expect(journal.map((event) => event.action).sort()).toEqual(['auth.registered', 'staff.role_granted']);
		for (const event of journal) expect(event).toMatchObject({ actorKind: 'system', outcome: 'success' });
		expect(journal.find((event) => event.action === 'staff.role_granted')?.details).toMatchObject({
			role: 'admin',
			via: 'environment'
		});
		// Neither the password nor its hash reach the journal.
		const stored = JSON.stringify(journal);
		expect(stored).not.toContain(PASSWORD);
		expect(stored).not.toContain(credential?.hash ?? 'no hash');

		// A repeated start with another password changes nothing: the administrator may have changed it since.
		const again = await ensure(email, { password: NEW_PASSWORD });
		expect(again).toEqual({
			userId: first.userId,
			created: false,
			roleGranted: false,
			passwordSet: false,
			sessionsRevoked: 0
		});
		const [kept] = await database.db
			.select()
			.from(passwordCredentials)
			.where(eq(passwordCredentials.userId, first.userId));
		expect(kept?.hash).toBe(credential?.hash);
		expect(await journalOf(first.userId)).toHaveLength(2);
		expect(
			await database.db
				.select()
				.from(users)
				.where(eq(users.emailHmac, crypto.lookupHmac('email', email)))
		).toHaveLength(1);
	});

	it('signs in by password on a stand whose seed accounts do not, and switches a vacancy source on', async () => {
		const email = newEmail();
		const { userId } = await ensure(email);
		// A seed account with the same kind of password is refused before its password is checked (domain 19.3).
		const seedEmail = newEmail();
		const [seeded] = await database.db
			.insert(users)
			.values({
				status: 'active',
				emailEnc: crypto.encrypt(seedEmail, 'users.email'),
				emailHmac: crypto.lookupHmac('email', seedEmail),
				emailVerifiedAt: now(),
				seedBatchId: 'demo-test'
			})
			.returning({ id: users.id });
		if (!seeded) throw new Error('seed account not inserted');
		await database.db
			.insert(passwordCredentials)
			.values({ userId: seeded.id, hash: await hashPassword(PASSWORD), changedAt: now() });
		expect(await signIn(seedEmail, PASSWORD)).toMatchObject({ ok: false, reason: 'demo_account' });

		expect(await signIn(email, 'not the password at all')).toMatchObject({ ok: false, reason: 'invalid_credentials' });
		const login = await signIn(email, PASSWORD);
		if (!login.ok) throw new Error(`sign-in refused: ${login.reason}`);
		expect(login.userId).toBe(userId);

		const actor = await authenticateSession({ db: database.db, redis, now }, login.sessionId);
		if (!actor) throw new Error('the session is not valid');
		const subject = await loadAccessSubject(database.db, actor);
		expect(subject.staff).toMatchObject({ admin: true, operator: false });

		const switched = await switchVacancySource(
			{ db: database.db, now },
			{ subject, meta: meta() },
			{ source: HABR_SOURCE_KEY, enabled: true }
		);
		expect(switched).toMatchObject({ changed: true });
		const [source] = await database.db.select().from(vacancySources).where(eq(vacancySources.key, HABR_SOURCE_KEY));
		expect(source?.enabled).toBe(true);
	});

	it('sets the password again only on request, ending every session of the account', async () => {
		const email = newEmail();
		const { userId } = await ensure(email);
		const { sessionId } = await createSession(
			redis,
			{ userId, authMethod: 'password', authTime: now(), ip: null, ua: null },
			now()
		);
		await database.db
			.update(users)
			.set({ lockedUntil: new Date(Date.now() + 3_600_000) })
			.where(eq(users.id, userId));

		const reset = await ensure(email, { password: NEW_PASSWORD, resetPassword: true });
		expect(reset).toMatchObject({ userId, created: false, roleGranted: false, passwordSet: true, sessionsRevoked: 1 });
		expect(await readSession(redis, sessionId, now())).toBeNull();
		expect(await signIn(email, PASSWORD)).toMatchObject({ ok: false, reason: 'invalid_credentials' });
		expect(await signIn(email, NEW_PASSWORD)).toMatchObject({ ok: true, userId });

		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.objectId, userId), eq(auditEvents.action, 'auth.password_reset')));
		expect(event).toMatchObject({ actorKind: 'system', details: { via: 'environment' } });
		expect(JSON.stringify(event)).not.toContain(NEW_PASSWORD);
	});

	it('needs the password to create the account or reset it, not to confirm an existing one', async () => {
		const email = newEmail();
		const missing = await refusal(ensure(email, { password: null }));
		expect(missing.message).toContain('BOOTSTRAP_ADMIN_PASSWORD is required');
		expect(
			await database.db
				.select()
				.from(users)
				.where(eq(users.emailHmac, crypto.lookupHmac('email', email)))
		).toHaveLength(0);

		const { userId } = await ensure(email);
		// The password left the environment after the first start: the next start confirms the role and keeps the password.
		expect(await ensure(email, { password: null })).toEqual({
			userId,
			created: false,
			roleGranted: false,
			passwordSet: false,
			sessionsRevoked: 0
		});
		expect(await signIn(email, PASSWORD)).toMatchObject({ ok: true, userId });
		// A revoked role is granted again by the address alone.
		await database.db
			.update(staffRoles)
			.set({ revokedAt: now(), revokedBy: userId })
			.where(eq(staffRoles.userId, userId));
		expect(await ensure(email, { password: null })).toMatchObject({ userId, roleGranted: true, passwordSet: false });

		const reset = await refusal(ensure(email, { password: null, resetPassword: true }));
		expect(reset.message).toContain('--reset-password needs BOOTSTRAP_ADMIN_PASSWORD');
		expect(await signIn(email, PASSWORD)).toMatchObject({ ok: true, userId });
	});

	it('grants the role to a real active account of the address and keeps its password', async () => {
		const email = newEmail();
		const hash = await hashPassword('the person chose this one');
		const [person] = await database.db
			.insert(users)
			.values({
				status: 'active',
				emailEnc: crypto.encrypt(email, 'users.email'),
				emailHmac: crypto.lookupHmac('email', email),
				emailVerifiedAt: now()
			})
			.returning({ id: users.id });
		if (!person) throw new Error('account not inserted');
		await database.db.insert(passwordCredentials).values({ userId: person.id, hash, changedAt: now() });

		expect(await ensure(email)).toMatchObject({
			userId: person.id,
			created: false,
			roleGranted: true,
			passwordSet: false
		});
		const [credential] = await database.db
			.select()
			.from(passwordCredentials)
			.where(eq(passwordCredentials.userId, person.id));
		expect(credential?.hash).toBe(hash);
	});

	it('refuses an address of a demo account, of an account that is not active, and a weak password', async () => {
		const seedEmail = newEmail();
		await database.db.insert(users).values({
			status: 'active',
			emailEnc: crypto.encrypt(seedEmail, 'users.email'),
			emailHmac: crypto.lookupHmac('email', seedEmail),
			seedBatchId: 'demo-test'
		});
		expect((await refusal(ensure(seedEmail))).message).toContain('demo data');

		const pendingEmail = newEmail();
		await database.db.insert(users).values({
			status: 'pending_email',
			emailEnc: crypto.encrypt(pendingEmail, 'users.email'),
			emailHmac: crypto.lookupHmac('email', pendingEmail)
		});
		expect((await refusal(ensure(pendingEmail))).message).toContain('pending_email');

		const weak = await refusal(ensure(newEmail(), { password: 'short' }));
		expect(weak.message).toContain('BOOTSTRAP_ADMIN_PASSWORD');
		expect(weak.message).not.toContain('short');
		// Nothing of the refusals is left: no role besides those granted above.
		const admins = await database.db.select().from(staffRoles).where(eq(staffRoles.role, 'admin'));
		const adminIds = new Set(admins.map((row) => row.userId));
		for (const address of [seedEmail, pendingEmail]) {
			const [row] = await database.db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.emailHmac, crypto.lookupHmac('email', address)));
			expect(adminIds.has(row?.id ?? '')).toBe(false);
		}
	});
});
