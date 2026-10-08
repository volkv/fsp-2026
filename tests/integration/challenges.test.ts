// Calls of companies (docs/domain.md, 13.12): a call is delivered regularly to the candidates of its categories the
// company sees — once per pair for all time, not to a candidate who got any call within the interval, those longest
// without a call first; an unopened delivery is reminded once; after the end the unopened ones expire. Opening a call
// refreshes nothing, a submitted solution refreshes the profile; the company sees solutions by pseudonym, a withdrawn one
// not at all, and invites from a solution. A demo session runs the calls of its companies on its own clock: «промотать
// неделю» shows the next cycle at once and touches no other call.
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	dismissDelivery,
	myChallenges,
	openDelivery,
	submitSolution,
	withdrawSolution
} from '$lib/server/challenges/candidate';
import {
	challengeSolutionsOf,
	createChallenge,
	updateChallenge,
	type ChallengeDeps,
	type ChallengeInput
} from '$lib/server/challenges/company';
import { advanceDemoClock, deliverChallenges, DEMO_CLOCK_STEP_SECONDS } from '$lib/server/challenges/deliver';
import { lastConfirmedActions } from '$lib/server/challenges/freshness';
import {
	challengeDeliveries,
	challengeSolutions,
	companies,
	companyChallenges,
	demoSessions,
	notifications
} from '$lib/server/db/schema';
import { createInvitation } from '$lib/server/invitations/send';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { offerTerms } from '../helpers/factories';
import {
	DAY,
	contactWorld,
	detailCode,
	employer,
	person,
	refusal,
	testCrypto,
	type ContactWorld
} from '../helpers/contact';

const HOUR = 3_600_000;
const meta = { requestId: 'test-challenges', ip: '127.0.0.1', userAgent: 'vitest' };
let database: TestDatabase;
let world: ContactWorld;
let clock = new Date();

const deps = (): ChallengeDeps => ({ db: database.db, crypto: testCrypto, now: () => clock });
const invitationDeps = () => ({ db: database.db, crypto: testCrypto, now: () => clock });

const call = (overrides: Partial<ChallengeInput> = {}): ChallengeInput & { publish: boolean } => ({
	title: 'Идемпотентный приём платежей',
	statement:
		'Сервис принимает платёж и иногда получает один и тот же запрос дважды. Опишите, как сделать приём идемпотентным.',
	answerKind: 'approach',
	specialization: 'backend',
	grades: ['middle'],
	salaryMin: 250_000,
	salaryMax: 320_000,
	salaryCurrency: 'RUB',
	salaryTaxBase: 'gross',
	goal: 'Найти инженера в команду платежей',
	timeLimitMinutes: 20,
	endsAt: new Date(clock.getTime() + 30 * DAY),
	publish: true,
	...overrides
});

/** One run of the hourly job at the clock of the test. */
const run = () => database.db.transaction((tx) => deliverChallenges(tx, clock, 'all', 'test-run'));

const deliveriesOf = (challengeId: string) =>
	database.db.select().from(challengeDeliveries).where(eq(challengeDeliveries.challengeId, challengeId));

beforeAll(async () => {
	database = await createTestDatabase();
	world = await contactWorld(database, ['backend', 'frontend']);
});

afterAll(async () => {
	await database.drop();
});

describe('the regular delivery of a call', () => {
	it('delivers to the candidates of its categories the company sees, once per pair, and reminds once', async () => {
		clock = new Date();
		const company = await employer(database.db);
		const middles: Awaited<ReturnType<typeof person>>[] = [];
		for (let i = 0; i < 3; i += 1) {
			middles.push(await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } }));
		}
		const senior = await person(database.db, world, { category: { specialization: 'backend', grade: 'senior' } });
		const frontend = await person(database.db, world, { category: { specialization: 'frontend', grade: 'middle' } });
		const hidden = await person(database.db, world, {
			category: { specialization: 'backend', grade: 'middle' },
			visibility: 'hidden'
		});
		const challenge = await createChallenge(deps(), company.subject, meta, call());

		await run();
		const first = await deliveriesOf(challenge.id);
		const delivered = new Set(first.map((d) => d.candidateId));
		for (const candidate of middles) expect(delivered.has(candidate.id)).toBe(true);
		for (const outside of [senior, frontend, hidden]) expect(delivered.has(outside.id)).toBe(false);
		const toldFirst = await database.db
			.select({ type: notifications.type })
			.from(notifications)
			.where(eq(notifications.userId, middles[0]?.userId ?? ''));
		expect(toldFirst.filter((n) => n.type === 'challenge.delivered')).toHaveLength(1);

		// The same run again, and the next one after the period: nothing is delivered twice.
		await run();
		const late = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		clock = new Date(clock.getTime() + 25 * HOUR);
		await run();
		const second = await deliveriesOf(challenge.id);
		expect(second.filter((d) => delivered.has(d.candidateId))).toHaveLength(delivered.size);
		expect(second.map((d) => d.candidateId)).toContain(late.id);
		expect(new Set(second.map((d) => d.candidateId)).size).toBe(second.length);

		// Unopened for three days: reminded once, never again.
		const opened = middles[1];
		if (!opened) throw new Error('no candidate');
		const openedDelivery = second.find((d) => d.candidateId === opened.id);
		if (!openedDelivery) throw new Error('no delivery');
		await openDelivery(deps(), opened.subject, openedDelivery.id);
		clock = new Date(clock.getTime() + 3 * DAY);
		await run();
		clock = new Date(clock.getTime() + 2 * DAY);
		await run();
		const reminded = await database.db
			.select({ userId: notifications.userId })
			.from(notifications)
			.where(eq(notifications.type, 'challenge.reminder'));
		const remindedUsers = reminded.map((n) => n.userId);
		expect(remindedUsers.filter((id) => id === middles[0]?.userId)).toHaveLength(1);
		expect(remindedUsers).not.toContain(opened.userId);
	});

	it('skips a candidate who got any call within the interval, the longest without a call first', async () => {
		clock = new Date();
		const one = await employer(database.db);
		const two = await employer(database.db);
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'senior' } });
		const firstCall = await createChallenge(deps(), one.subject, meta, call({ grades: ['senior'] }));
		await run();
		expect((await deliveriesOf(firstCall.id)).map((d) => d.candidateId)).toContain(candidate.id);
		const secondCall = await createChallenge(deps(), two.subject, meta, call({ grades: ['senior'] }));
		await run();
		expect((await deliveriesOf(secondCall.id)).map((d) => d.candidateId)).not.toContain(candidate.id);
		clock = new Date(clock.getTime() + 8 * DAY);
		await run();
		expect((await deliveriesOf(secondCall.id)).map((d) => d.candidateId)).toContain(candidate.id);
	});

	it('expires the unopened deliveries and closes the call after its end', async () => {
		clock = new Date();
		const company = await employer(database.db);
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'junior' } });
		const challenge = await createChallenge(
			deps(),
			company.subject,
			meta,
			call({ grades: ['junior'], endsAt: new Date(clock.getTime() + 2 * DAY) })
		);
		await run();
		clock = new Date(clock.getTime() + 3 * DAY);
		await run();
		const [delivery] = await deliveriesOf(challenge.id);
		expect(delivery).toMatchObject({ candidateId: candidate.id, status: 'expired' });
		const [row] = await database.db.select().from(companyChallenges).where(eq(companyChallenges.id, challenge.id));
		expect(row?.status).toBe('closed');
		if (!delivery) throw new Error('no delivery');
		const closed = await refusal(submitSolution(deps(), candidate.subject, meta, delivery.id, 'Поздний ответ'));
		expect([closed.code, detailCode(closed)]).toEqual(['conflict', 'challenge_closed']);
	});
});

describe('a solution of a call', () => {
	it('refreshes the profile, opening does not; the company sees it by pseudonym and invites from it', async () => {
		clock = new Date();
		const company = await employer(database.db);
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'middle' } });
		const challenge = await createChallenge(deps(), company.subject, meta, call({ grades: ['middle', 'senior'] }));
		await run();
		const [delivery] = (await deliveriesOf(challenge.id)).filter((d) => d.candidateId === candidate.id);
		if (!delivery) throw new Error('no delivery');

		await openDelivery(deps(), candidate.subject, delivery.id);
		expect((await lastConfirmedActions(database.db, [candidate.id])).has(candidate.id)).toBe(false);
		const solved = await submitSolution(
			deps(),
			candidate.subject,
			meta,
			delivery.id,
			'Ключ идемпотентности в заголовке и уникальный индекс в таблице платежей.'
		);
		expect(solved.status).toBe('solved');
		const solution = solved.solution;
		if (!solution) throw new Error('no solution');
		expect((await lastConfirmedActions(database.db, [candidate.id])).get(candidate.id)).toEqual(solution.submittedAt);
		const twice = await refusal(submitSolution(deps(), candidate.subject, meta, delivery.id, 'Ещё раз'));
		expect(detailCode(twice)).toBe('already_submitted');

		const seen = await challengeSolutionsOf(deps(), company.subject, challenge.id);
		expect(seen.solutions).toEqual([
			expect.objectContaining({
				id: solution.id,
				pseudonym: testCrypto.pseudonym(candidate.id, company.company.id),
				category: { specialization: 'backend', grade: 'middle' }
			})
		]);
		expect(JSON.stringify(seen)).not.toContain(candidate.id);

		// Another company sees no solution of this call and cannot name it in an offer.
		const other = await employer(database.db);
		expect((await refusal(challengeSolutionsOf(deps(), other.subject, challenge.id))).code).toBe('not_found');
		const foreign = await refusal(
			createInvitation(invitationDeps(), other.subject, meta, {
				...offerTerms({
					whyYou: [{ text: 'Решение вызова', source: { kind: 'challenge_solution', ref: solution.id } }]
				}),
				candidateId: candidate.id
			})
		);
		expect(foreign.code).toBe('validation_failed');

		const offer = await createInvitation(invitationDeps(), company.subject, meta, {
			...offerTerms({
				whyYou: [{ text: 'Сильный подход к идемпотентности', source: { kind: 'challenge_solution', ref: solution.id } }]
			}),
			candidateId: candidate.id
		});
		expect(offer.invitationId).toBeTruthy();
		const [invited] = await database.db.select().from(challengeSolutions).where(eq(challengeSolutions.id, solution.id));
		expect(invited?.companyDecision).toBe('invited');
	});

	it('is withdrawn by the candidate at any time, and the company no longer sees it', async () => {
		clock = new Date();
		const company = await employer(database.db);
		const candidate = await person(database.db, world, { category: { specialization: 'backend', grade: 'intern' } });
		const challenge = await createChallenge(deps(), company.subject, meta, call({ grades: ['intern'] }));
		await run();
		const [delivery] = await deliveriesOf(challenge.id);
		if (!delivery) throw new Error('no delivery');
		const solved = await submitSolution(deps(), candidate.subject, meta, delivery.id, 'Подход с очередью');
		if (!solved.solution) throw new Error('no solution');
		await withdrawSolution(deps(), candidate.subject, meta, delivery.id, solved.solution.id);
		expect((await challengeSolutionsOf(deps(), company.subject, challenge.id)).solutions).toEqual([]);
		const [row] = await database.db
			.select()
			.from(challengeSolutions)
			.where(eq(challengeSolutions.id, solved.solution.id));
		expect(row).toMatchObject({ status: 'withdrawn', content: null });
		expect((await lastConfirmedActions(database.db, [candidate.id])).has(candidate.id)).toBe(false);
		// Another candidate's delivery is not theirs to act on.
		const stranger = await person(database.db, world, {});
		expect((await refusal(openDelivery(deps(), stranger.subject, delivery.id))).code).toBe('not_found');
		expect((await refusal(dismissDelivery(deps(), stranger.subject, delivery.id))).code).toBe('not_found');
		expect(await myChallenges(deps(), stranger.subject)).toEqual([]);
	});

	it('keeps the terms of a published call', async () => {
		clock = new Date();
		const company = await employer(database.db);
		const challenge = await createChallenge(deps(), company.subject, meta, call());
		const edited = await refusal(updateChallenge(deps(), company.subject, meta, challenge.id, { goal: 'Другая цель' }));
		expect(detailCode(edited)).toBe('challenge_published');
		const longer = await updateChallenge(deps(), company.subject, meta, challenge.id, {
			endsAt: new Date(clock.getTime() + 40 * DAY)
		});
		expect(longer.endsAt.getTime()).toBe(clock.getTime() + 40 * DAY);
		const blocked = await refusal(
			createChallenge(
				deps(),
				company.subject,
				meta,
				call({ statement: `${call().statement} Только мужчины до 30 лет.` })
			)
		);
		expect([blocked.code, detailCode(blocked)]).toEqual(['policy_violation', 'text_blocked']);
		const dollars = await refusal(createChallenge(deps(), company.subject, meta, call({ salaryCurrency: 'USD' })));
		expect(detailCode(dollars)).toBe('salary_not_rub');
	});
});

describe('the managed clock of a demo session', () => {
	it('shows the next cycle of delivery at once and touches no other call', async () => {
		clock = new Date();
		const [session] = await database.db
			.insert(demoSessions)
			.values({
				joinTokenSha256: randomBytes(32).toString('hex'),
				seedBatchId: 'test',
				expiresAt: new Date(clock.getTime() + DAY)
			})
			.returning();
		if (!session) throw new Error('no session');
		const company = await employer(database.db, { demoSessionId: session.id });
		const outside = await employer(database.db);
		const first = await person(database.db, world, {
			category: { specialization: 'backend', grade: 'senior' },
			demoSessionId: session.id
		});
		const sessionCall = await createChallenge(deps(), company.subject, meta, call({ grades: ['senior'] }));
		const outsideCall = await createChallenge(deps(), outside.subject, meta, call({ grades: ['senior'] }));
		await run();
		expect((await deliveriesOf(sessionCall.id)).map((d) => d.candidateId)).toContain(first.id);
		const [outsideBefore] = await database.db
			.select()
			.from(companyChallenges)
			.where(eq(companyChallenges.id, outsideCall.id));

		// A new candidate of the session: without the clock, the next cycle would wait a day.
		const second = await person(database.db, world, {
			category: { specialization: 'backend', grade: 'senior' },
			demoSessionId: session.id
		});
		await run();
		expect((await deliveriesOf(sessionCall.id)).map((d) => d.candidateId)).not.toContain(second.id);
		const advanced = await advanceDemoClock(database.db, company.subject, meta, clock);
		expect(advanced.clockOffsetSeconds).toBe(DEMO_CLOCK_STEP_SECONDS);
		const after = await deliveriesOf(sessionCall.id);
		expect(after.map((d) => d.candidateId)).toEqual(expect.arrayContaining([first.id, second.id]));
		// Delivered at the real moment; the clock of the session, a week ahead, is the moment the interval counts.
		const delivered = after.find((d) => d.candidateId === second.id);
		expect(delivered?.deliveredAt.getTime()).toBe(clock.getTime());
		expect(delivered?.clockAt.getTime()).toBe(clock.getTime() + DEMO_CLOCK_STEP_SECONDS * 1000);
		// The first one, unopened for a week of the session, is reminded; the call outside the session is untouched.
		const reminded = after.find((d) => d.candidateId === first.id);
		expect(reminded?.remindedAt).not.toBeNull();
		const [outsideAfter] = await database.db
			.select()
			.from(companyChallenges)
			.where(eq(companyChallenges.id, outsideCall.id));
		expect(outsideAfter?.lastDeliveryRunAt).toEqual(outsideBefore?.lastDeliveryRunAt);
		const [sessionRow] = await database.db.select().from(demoSessions).where(eq(demoSessions.id, session.id));
		expect(sessionRow?.clockOffsetSeconds).toBe(DEMO_CLOCK_STEP_SECONDS);
		// An account outside sessions has no clock to move.
		expect((await refusal(advanceDemoClock(database.db, outside.subject, meta, clock))).code).toBe('forbidden');
		// The company of the session is still one of the session.
		const [companyRow] = await database.db
			.select({ session: companies.demoSessionId })
			.from(companies)
			.where(and(eq(companies.id, company.company.id)));
		expect(companyRow?.session).toBe(session.id);
	});

	it('counts the interval within the place of the call: a session holds back neither another one nor the platform', async () => {
		clock = new Date();
		const newSession = async () => {
			const [row] = await database.db
				.insert(demoSessions)
				.values({
					joinTokenSha256: randomBytes(32).toString('hex'),
					seedBatchId: 'test',
					expiresAt: new Date(clock.getTime() + 60 * DAY)
				})
				.returning();
			if (!row) throw new Error('no session');
			return row;
		};
		const sessionA = await newSession();
		const sessionB = await newSession();
		const inA = await employer(database.db, { demoSessionId: sessionA.id });
		const inB = await employer(database.db, { demoSessionId: sessionB.id });
		const platform = await employer(database.db);
		// A candidate outside sessions: every session and the platform see them.
		const shared = await person(database.db, world, { category: { specialization: 'frontend', grade: 'senior' } });
		const lead = (overrides: Partial<ChallengeInput> = {}) =>
			call({
				specialization: 'frontend',
				grades: ['senior'],
				endsAt: new Date(clock.getTime() + 50 * DAY),
				...overrides
			});
		const delivers = async (challengeId: string) =>
			(await deliveriesOf(challengeId)).some((d) => d.candidateId === shared.id);

		const callA = await createChallenge(deps(), inA.subject, meta, lead());
		await run();
		expect(await delivers(callA.id)).toBe(true);
		// A call of session A within the interval holds back neither session B nor a company outside sessions.
		const callB = await createChallenge(deps(), inB.subject, meta, lead());
		const callPlatform = await createChallenge(deps(), platform.subject, meta, lead());
		await run();
		expect(await delivers(callB.id)).toBe(true);
		expect(await delivers(callPlatform.id)).toBe(true);

		// «Промотать неделю» in A: the next call of A reaches the candidate on the clock of A, at the real moment.
		const nextA = await createChallenge(deps(), inA.subject, meta, lead());
		await advanceDemoClock(database.db, inA.subject, meta, clock);
		const [deliveredA] = (await deliveriesOf(nextA.id)).filter((d) => d.candidateId === shared.id);
		expect(deliveredA?.deliveredAt.getTime()).toBe(clock.getTime());
		// Session B and the platform keep their own interval: within it, the next calls wait.
		const nextB = await createChallenge(deps(), inB.subject, meta, lead());
		const nextPlatform = await createChallenge(deps(), platform.subject, meta, lead());
		await run();
		expect(await delivers(nextB.id)).toBe(false);
		expect(await delivers(nextPlatform.id)).toBe(false);
		// Past their interval they deliver: the week A moved on its clock holds back nobody else.
		clock = new Date(clock.getTime() + 8 * DAY);
		await run();
		expect(await delivers(nextB.id)).toBe(true);
		expect(await delivers(nextPlatform.id)).toBe(true);
	});
});
