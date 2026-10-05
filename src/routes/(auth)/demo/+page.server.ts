import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { clearSessionCookie, requestMeta, sessionOf, setSessionCookie } from '$lib/server/auth/http';
import { destroySession } from '$lib/server/auth/sessions';
import { config } from '$lib/server/config';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import {
	DEMO_EVICTABLE_MINUTES,
	DEMO_IDLE_MINUTES,
	idleEndOf,
	lastEndOf,
	nextStandReset,
	redisDemoActivity
} from '$lib/server/demo/activity';
import { castOriginals, castRoles, cloneEmail, DemoCastMissing, type CastRole } from '$lib/server/demo/cast';
import { MAX_LIVE_SESSIONS } from '$lib/server/demo/clone';
import { readSeedData, seedsDirectory } from '$lib/server/demo/data';
import {
	DEMO_SESSION_COOKIE,
	DEMO_SESSION_REFUSALS,
	enterDemoRole,
	sessionByToken,
	setDemoCookie,
	type LiveDemoSession
} from '$lib/server/demo/visit';
import { redis } from '$lib/server/redis';
import { objectStore } from '$lib/server/storage/object-store';
import type { Actions, PageServerLoad } from './$types';

/** What the FSP ID callback sends here with `?fsp=`: why the sign-in did not happen. */
const FSP_NOTICES: Record<string, string> = {
	demo_account:
		'Через ФСП ID в героев сценария не войти: их учётки — шаблон, с которого копируется каждая демо-сессия. Выберите роль ниже — для вас откроется своя копия.',
	...Object.fromEntries(
		Object.entries(DEMO_SESSION_REFUSALS).map(([reason, text]) => [
			reason,
			`Вход через ФСП ID на демо-стенде проходит в вашей демо-сессии, а открыть её не удалось. ${text}`
		])
	)
};

/** The screen exists on a demonstration stand only. */
function requireDemo(event: RequestEvent): void {
	if (config().demo === null) error(404, { message: 'Не найдено', requestId: event.locals.requestId });
}

/** The demo session of the browser and its token: the link being joined first, then the cookie. */
async function currentSession(
	event: RequestEvent,
	token: string | null,
	now: Date
): Promise<{ session: LiveDemoSession; token: string } | null> {
	for (const candidate of [token, event.cookies.get(DEMO_SESSION_COOKIE) ?? null]) {
		if (!candidate) continue;
		const session = await sessionByToken(db(), candidate, now);
		if (session) return { session, token: candidate };
	}
	return null;
}

/** The role the signed-in account plays in the demo session, if it is one of its clones. */
async function currentRole(event: RequestEvent, sessionId: string, roles: readonly CastRole[]): Promise<string | null> {
	const session = sessionOf(event);
	if (!session) return null;
	const [row] = await db()
		.select({ hmac: users.emailHmac, demoSession: users.demoSessionId })
		.from(users)
		.where(eq(users.id, session.userId));
	if (row?.demoSession !== sessionId) return null;
	const crypto = fieldCrypto();
	return roles.find((role) => crypto.lookupHmac('email', cloneEmail(role.email, sessionId)) === row.hmac)?.key ?? null;
}

export const load: PageServerLoad = async (event) => {
	requireDemo(event);
	const now = new Date();
	// With `DEMO_NIGHTLY_RESET` off nothing resets the stand: no reset time to show, a session ends at its own end.
	const resetAt = config().demo?.nightlyReset === true ? nextStandReset(now) : null;
	const roles = castRoles(await readSeedData(seedsDirectory()));
	// FSP ID does not sign in to the heroes of the scenario (their originals or clones), and signs an athlete in within
	// the visitor's demo session: the callback sends here when either stops it.
	const fsp = event.url.searchParams.get('fsp');
	const fspNotice = fsp === null ? null : (FSP_NOTICES[fsp] ?? null);
	let names: Map<string, string | null>;
	try {
		const originals = await castOriginals(db(), fieldCrypto(), roles);
		names = new Map([...originals.users].map(([key, user]) => [key, user.displayName]));
	} catch (cause) {
		if (!(cause instanceof DemoCastMissing)) throw cause;
		return { seeded: false as const, roles: [], session: null, joining: null, fspNotice, resetAt };
	}
	const joining = event.url.searchParams.get('join');
	const current = await currentSession(event, joining, now);
	// Coming back to the screen of the session is a use of it: the idle time starts again, as the page then says.
	if (current) await redisDemoActivity(await redis()).touch(current.session.id, now);
	return {
		seeded: true as const,
		roles: roles.map((role) => ({
			key: role.key,
			group: role.group,
			code: role.code,
			part: role.part,
			name: names.get(role.key) ?? role.email
		})),
		session: current
			? {
					idleEndsAt: idleEndOf(current.session.expiresAt, now),
					endsAt: lastEndOf(current.session.expiresAt, now),
					endsAtReset: resetAt !== null && resetAt.getTime() <= current.session.expiresAt.getTime(),
					ownResumeAt: current.session.ownResumeAt,
					token: current.token,
					joinLink: `${config().appOrigin}/demo?join=${encodeURIComponent(current.token)}`,
					role: await currentRole(event, current.session.id, roles)
				}
			: null,
		idleHours: DEMO_IDLE_MINUTES / 60,
		evictableMinutes: DEMO_EVICTABLE_MINUTES,
		maxSessions: MAX_LIVE_SESSIONS,
		resetAt,
		// A link that opens no live session says so instead of silently opening a new one.
		joining: joining !== null && current?.token !== joining ? ('expired' as const) : null,
		fspNotice
	};
};

export const actions: Actions = {
	enter: async (event) => {
		requireDemo(event);
		const form = await event.request.formData();
		const roleKey = form.get('role');
		const joining = form.get('join');
		const data = await readSeedData(seedsDirectory());
		const role = castRoles(data).find((r) => r.key === roleKey);
		if (!role) return fail(400, { message: 'Выберите роль сценария' });
		const now = new Date();
		const entry = await enterDemoRole(
			{ db: db(), redis: await redis(), crypto: fieldCrypto(), store: objectStore(), now: () => now },
			{
				data,
				role,
				tokens: [
					typeof joining === 'string' && joining !== '' ? joining : null,
					event.cookies.get(DEMO_SESSION_COOKIE) ?? null
				],
				address: event.getClientAddress(),
				previous: sessionOf(event),
				meta: requestMeta(event)
			}
		);
		if (entry.kind === 'refused') {
			return fail(entry.reason === 'address_budget' ? 429 : 503, { message: DEMO_SESSION_REFUSALS[entry.reason] });
		}
		setDemoCookie(event.cookies, entry.token, entry.session.expiresAt, now);
		setSessionCookie(event.cookies, entry.signInSessionId);
		redirect(303, role.home);
	},

	leave: async (event) => {
		requireDemo(event);
		const session = sessionOf(event);
		if (session) {
			await destroySession(await redis(), session);
			clearSessionCookie(event.cookies);
		}
		event.cookies.delete(DEMO_SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
		redirect(303, '/demo');
	}
};
