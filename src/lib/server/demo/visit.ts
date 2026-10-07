// A visitor's way into the demo scenario (docs/domain.md, section 19.3): the demo session of the browser, found by the
// join token it keeps; the roles of the cast; entering a role opens a sign-in session of that role's clone. The join
// token is a bearer secret of the whole demo session — the link with it opens the same session in another browser. A
// browser without a live session gets a new one within the budget of its address (`RATE_LIMIT_RULES.demoSession`);
// entering another role of the session it has costs nothing of that budget. A sign-in with FSP ID of an athlete without
// an account of the seed, and a registration by password, take place in the visitor's session as well
// (`auth/identities.ts`, `auth/registration.ts`).
import type { Cookies } from '@sveltejs/kit';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { RequestMeta } from '$lib/server/auth/context';
import type { VisitorDemoSession } from '$lib/server/auth/identities';
import { createSession, destroySession, type SessionRef } from '$lib/server/auth/sessions';
import { sha256Hex } from '$lib/server/auth/secrets';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor } from '$lib/server/db';
import { demoSessions, users } from '$lib/server/db/schema';
import { consume, RATE_LIMIT_RULES, redisRateLimitStore } from '$lib/server/http/rate-limit';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';
import { redisDemoActivity } from './activity';
import { DemoCastMissing, cloneEmail, type CastRole } from './cast';
import { DemoSessionsExhausted, openDemoSession } from './clone';
import { readSeedData, seedsDirectory, type SeedData } from './data';
import { demoTerms, type DemoTerms } from './terms';

/** Cookie with the join token of the browser's demo session. */
export const DEMO_SESSION_COOKIE = '__Host-demo_session';

/** Keeps the join token in the browser for as long as the session lives. */
export function setDemoCookie(cookies: Cookies, token: string, expiresAt: Date, now: Date): void {
	cookies.set(DEMO_SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000))
	});
}

export interface LiveDemoSession {
	id: string;
	expiresAt: Date;
	ownResumeAt: Date | null;
}

const liveColumns = { id: demoSessions.id, expiresAt: demoSessions.expiresAt, ownResumeAt: demoSessions.ownResumeAt };

/** The live demo session of a join token; `null` — no such session or its time is over. */
export async function sessionByToken(executor: Executor, token: string, now: Date): Promise<LiveDemoSession | null> {
	const [row] = await executor
		.select(liveColumns)
		.from(demoSessions)
		.where(and(eq(demoSessions.joinTokenSha256, sha256Hex(token)), gt(demoSessions.expiresAt, now)));
	return row ?? null;
}

/**
 * The live demo session of the browser's cookie, where an account registered within it is found (the sign-in by password,
 * the password reset) and whose password resets the browser reads (`demo/letters.ts`); `null` — none. Opens no session.
 */
export async function sessionOfBrowser(
	executor: Executor,
	cookies: Cookies,
	now: Date
): Promise<LiveDemoSession | null> {
	const token = cookies.get(DEMO_SESSION_COOKIE);
	return token === undefined ? null : sessionByToken(executor, token, now);
}

/** The live demo session a signed-in clone belongs to; `null` — the account is not a clone of a live session. */
export async function sessionOfAccount(executor: Executor, userId: string, now: Date): Promise<LiveDemoSession | null> {
	const [row] = await executor
		.select(liveColumns)
		.from(users)
		.innerJoin(demoSessions, eq(demoSessions.id, users.demoSessionId))
		.where(and(eq(users.id, userId), isNotNull(users.demoSessionId), gt(demoSessions.expiresAt, now)));
	return row ?? null;
}

/** The clone of a role in a demo session, found by the address the clone was given. */
export async function cloneOfRole(
	executor: Executor,
	crypto: FieldCrypto,
	sessionId: string,
	role: CastRole
): Promise<string> {
	const [row] = await executor
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				eq(users.emailHmac, crypto.lookupHmac('email', cloneEmail(role.email, sessionId))),
				eq(users.demoSessionId, sessionId),
				eq(users.status, 'active')
			)
		);
	if (!row) throw new Error(`demo session ${sessionId} has no clone of ${role.key}`);
	return row.id;
}

/**
 * Signs the browser in as a clone: a new session id, the previous session of the browser ended. The clone has no
 * password; the session records the password method, as the seed does for the originals.
 */
export async function signInAsClone(
	redis: Redis,
	input: { userId: string; previous: SessionRef | null; ip: string | null; ua: string | null },
	now: Date
): Promise<string> {
	if (input.previous) await destroySession(redis, input.previous);
	const { sessionId } = await createSession(
		redis,
		{ userId: input.userId, authMethod: 'password', authTime: now, ip: input.ip, ua: input.ua },
		now
	);
	return sessionId;
}

/**
 * The visitor uploads a resume of their own: from now on the demo session lives no longer than the resume may — in
 * review, as long as the session itself (`ownResumeHours` is `null`). Returns the new end of the session.
 */
export async function shortenForOwnResume(
	executor: Executor,
	sessionId: string,
	terms: Pick<DemoTerms, 'ownResumeHours'>,
	now: Date
): Promise<Date> {
	const ownResumeAt = sql`coalesce(${demoSessions.ownResumeAt}, ${now.toISOString()}::timestamptz)`;
	const until =
		terms.ownResumeHours === null ? null : new Date(now.getTime() + terms.ownResumeHours * 3_600_000).toISOString();
	const [row] = await executor
		.update(demoSessions)
		.set(
			until === null
				? { ownResumeAt }
				: { expiresAt: sql`least(${demoSessions.expiresAt}, ${until}::timestamptz)`, ownResumeAt }
		)
		.where(eq(demoSessions.id, sessionId))
		.returning({ expiresAt: demoSessions.expiresAt });
	if (!row) throw new Error(`demo session ${sessionId} is gone`);
	return row.expiresAt;
}

export interface EnterDeps {
	db: Database;
	redis: Redis;
	crypto: FieldCrypto;
	store: ObjectStore;
	now: () => Date;
}

export interface VisitorInput {
	data: SeedData;
	/** Join tokens the browser presents, the first live one wins: the link being joined, then the cookie. */
	tokens: readonly (string | null)[];
	/** The address of the request: the budget of new sessions is counted by it. */
	address: string;
	meta: RequestMeta;
}

export interface EnterInput extends VisitorInput {
	role: CastRole;
	/** The sign-in session the browser has now; entering a role ends it. */
	previous: SessionRef | null;
}

/** Why a new demo session was not opened, for the visitor. */
export const DEMO_SESSION_REFUSALS = {
	address_budget:
		'С этого адреса сегодня открыто слишком много демо-сессий. Войдите в роль своей сессии по её ссылке или попробуйте завтра.',
	stand_full: 'Сейчас открыто слишком много демо-сессий. Попробуйте через несколько минут.',
	not_seeded: 'Демо-данные стенда ещё засеваются. Попробуйте через несколько минут.'
} as const satisfies Record<DemoRefusal['reason'], string>;

export type DemoRefusal = {
	kind: 'refused';
	reason: 'address_budget' | 'stand_full' | 'not_seeded';
	retryAfterSeconds: number | null;
};

export type VisitorSession =
	| {
			kind: 'live';
			session: LiveDemoSession;
			/** The join token of the session, for the cookie of the browser. */
			token: string;
			/** The session was opened for this visit, not joined. */
			opened: boolean;
	  }
	| DemoRefusal;

export type DemoEntry =
	| {
			kind: 'entered';
			session: LiveDemoSession;
			/** The join token of the session, for the cookie of the browser. */
			token: string;
			/** The new sign-in session of the clone. */
			signInSessionId: string;
			/** The session was opened by this entry, not joined. */
			opened: boolean;
	  }
	| DemoRefusal;

/**
 * The demo session of the visitor: the live session of one of the tokens, or a new one opened for the browser within
 * the budget of its address. The session is marked as used now.
 */
async function visitorSession(deps: EnterDeps, input: VisitorInput): Promise<VisitorSession> {
	const now = deps.now();
	let current: { session: LiveDemoSession; token: string } | null = null;
	for (const token of input.tokens) {
		if (!token) continue;
		const session = await sessionByToken(deps.db, token, now);
		if (session) {
			current = { session, token };
			break;
		}
	}
	let opened = false;
	if (!current) {
		const budget = await consume(redisRateLimitStore(deps.redis), RATE_LIMIT_RULES.demoSession, input.address);
		if (!budget.allowed) return { kind: 'refused', reason: 'address_budget', retryAfterSeconds: budget.resetSeconds };
		try {
			const created = await openDemoSession(
				{
					db: deps.db,
					crypto: deps.crypto,
					store: deps.store,
					activity: redisDemoActivity(deps.redis),
					now: () => now
				},
				input.data,
				await demoTerms(deps.db),
				input.meta
			);
			current = {
				session: { id: created.sessionId, expiresAt: created.expiresAt, ownResumeAt: null },
				token: created.joinToken
			};
			opened = true;
		} catch (cause) {
			if (cause instanceof DemoSessionsExhausted)
				return { kind: 'refused', reason: 'stand_full', retryAfterSeconds: null };
			if (cause instanceof DemoCastMissing) return { kind: 'refused', reason: 'not_seeded', retryAfterSeconds: null };
			throw cause;
		}
	}
	await redisDemoActivity(deps.redis).touch(current.session.id, now);
	return { kind: 'live', session: current.session, token: current.token, opened };
}

/** Enters a role of the scenario in the visitor's demo session: the browser signs in as the clone of the role. */
export async function enterDemoRole(deps: EnterDeps, input: EnterInput): Promise<DemoEntry> {
	const visit = await visitorSession(deps, input);
	if (visit.kind === 'refused') return visit;
	const userId = await cloneOfRole(deps.db, deps.crypto, visit.session.id, input.role);
	const signInSessionId = await signInAsClone(
		deps.redis,
		{ userId, previous: input.previous, ip: input.meta.ip, ua: input.meta.userAgent },
		deps.now()
	);
	return { kind: 'entered', session: visit.session, token: visit.token, signInSessionId, opened: visit.opened };
}

/** What a request of the browser brings to find its demo session or have one opened. */
export interface BrowserVisit {
	cookies: Cookies;
	/** The address of the request: the budget of new sessions is counted by it. */
	address: string;
	meta: RequestMeta;
}

/**
 * The demo session of the browser for an account written within it — a sign-in with FSP ID of an athlete without an
 * account, a registration by password (`auth/identities.ts`, `auth/registration.ts`): the live session of its cookie, or
 * one opened as `/demo` opens it, its join token given to the browser as `/demo` gives it. Asked for only when the
 * account is about to be written, so nothing is opened before.
 */
export function visitorDemoSessionOf(deps: EnterDeps, visit: BrowserVisit): VisitorDemoSession {
	return async () => {
		const found = await visitorSession(deps, {
			data: await readSeedData(seedsDirectory()),
			tokens: [visit.cookies.get(DEMO_SESSION_COOKIE) ?? null],
			address: visit.address,
			meta: visit.meta
		});
		if (found.kind === 'refused') return { ok: false, reason: found.reason };
		if (found.opened) setDemoCookie(visit.cookies, found.token, found.session.expiresAt, deps.now());
		return { ok: true, sessionId: found.session.id };
	};
}
