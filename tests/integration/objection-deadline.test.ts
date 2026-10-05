// `objection.deadline_watch` (docs/domain.md 12.5, 3.7): five days before the answer to an objection is due the FSP staff
// are reminded — the responsible operator while they hold the role, otherwise every operator, and every admin — and at
// `due_at` they learn that the answer is overdue. An answered or withdrawn objection reminds nobody. Every recipient gets
// each stage once however often the job runs; the letter names the deadline, never the candidate or the objection; the
// link leads an operator to the queue of objections and an admin to the staff management. Only the staff who reach the
// objection are reminded (domain 19.3): the clones of the candidate's demo session, the staff outside sessions for a
// candidate outside them.
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	assignObjection,
	objectionDeadlineWatch,
	openObjection,
	withdrawObjection,
	type ObjectionDecisions
} from '$lib/server/categories/objections';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import { assessmentObjections, demoSessions, jobs, notifications, staffRoles } from '$lib/server/db/schema';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { notificationFacts } from '$lib/server/notifications/content';
import { notificationLinks } from '$lib/server/notifications/deliver';
import { openNotification } from '$lib/server/notifications/inbox';
import { notificationLetter, telegramText } from '$lib/server/notifications/templates';
import { isNotificationType } from '$lib/server/notifications/types';
import { recordDecision } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createUser, randomSha256 } from '../helpers/factories';

const DAY = 86_400_000;
const REASON = 'Я третий год пишу бэкенд на Go';
const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 4)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 6)
});

let database: TestDatabase;
/** The decisions objected to: the engine of the test as objections reach it. */
const decided = new Map<string, string>();
const decisions: ObjectionDecisions = {
	decisionsOf: () => Promise.reject(new Error('not used')),
	find: (_, id) => {
		const candidateId = decided.get(id);
		return Promise.resolve(
			candidateId === undefined
				? null
				: {
						id,
						candidateId,
						attemptId: id,
						specialization: 'backend',
						grade: 'middle',
						outcome: 'not_confirmed',
						status: 'valid',
						decidedAt: new Date(),
						artifactsKeptUntil: new Date(Date.now() + 90 * DAY)
					}
		);
	},
	annul: () => Promise.reject(new Error('not used')),
	rescore: () => Promise.reject(new Error('not used'))
};
const staff = { assignee: '', operator: '', admin: '', revoked: '' };

async function grantRole(role: 'operator' | 'admin', revoked = false, demoSessionId?: string): Promise<string> {
	const user = await createUser(database.db, { demoSessionId });
	await database.db.insert(staffRoles).values({
		userId: user.id,
		role,
		grantedAt: new Date(Date.now() - DAY),
		...(revoked ? { revokedAt: new Date(), revokedBy: user.id } : {})
	});
	return user.id;
}

beforeAll(async () => {
	database = await createTestDatabase();
	staff.assignee = await grantRole('operator');
	staff.operator = await grantRole('operator');
	staff.admin = await grantRole('admin');
	staff.revoked = await grantRole('operator', true);
});

afterAll(async () => {
	await database.drop();
});

/** An objection against a decision of a test, opened by the candidate now; in the demo session given, a clone's. */
async function objection(demoSessionId?: string) {
	const { db } = database;
	const userId = demoSessionId ? (await createUser(db, { demoSessionId })).id : undefined;
	const candidate = await createCandidate(db, { profileRevision: 1, userId, demoSessionId });
	const decisionId = (
		await recordDecision(db, candidate.id, { specialization: 'backend', grade: 'junior', outcome: 'not_confirmed' })
	).id;
	decided.set(decisionId, candidate.id);
	const opened = await openObjection(db, decisions, {
		candidateId: candidate.id,
		userId: candidate.userId,
		decisionId,
		reason: REASON,
		requestId: 'r',
		now: new Date()
	});
	return { candidate, opened };
}

const watchJobs = (objectionId: string) =>
	database.db
		.select({ id: jobs.id, status: jobs.status, runAfter: jobs.runAfter })
		.from(jobs)
		.where(and(eq(jobs.type, 'objection.deadline_watch'), eq(jobs.dedupKey, `objection:${objectionId}`)))
		.orderBy(jobs.createdAt, jobs.id);

/** Moves the deadline to `dueInMs` from now and lets the waiting watch run now, as the queue would at its time. */
async function reachWatch(objectionId: string, dueInMs: number): Promise<void> {
	// One reading of the clock: two could straddle a millisecond and break `due_at = opened_at + 30 days`.
	const dueAt = Date.now() + dueInMs;
	await database.db
		.update(assessmentObjections)
		// The objection was opened 30 days before its deadline (part 4 of article 16).
		.set({ dueAt: new Date(dueAt), openedAt: new Date(dueAt - 30 * DAY) })
		.where(eq(assessmentObjections.id, objectionId));
	await database.db
		.update(jobs)
		.set({ runAfter: sql`now()` })
		.where(and(eq(jobs.dedupKey, `objection:${objectionId}`), eq(jobs.status, 'queued')));
}

/** Runs the waiting watch of the objection as the worker does. */
async function runWatch(objectionId: string) {
	const { db } = database;
	const claimed = (await claimJob(db, 'deadline-test', [
		'objection.deadline_watch'
	])) as ClaimedJob<'objection.deadline_watch'> | null;
	if (!claimed) throw new Error('no deadline watch to run');
	expect(claimed.payload.objection_id).toBe(objectionId);
	const result = await objectionDeadlineWatch.run({
		job: claimed,
		db,
		signal: new AbortController().signal,
		requestId: `job:${claimed.id}`,
		log: createLogger({}, () => undefined)
	});
	expect(await completeJob(db, claimed, result)).toBe('succeeded');
	return result.describe?.();
}

const reminders = (objectionId: string) =>
	database.db
		.select()
		.from(notifications)
		.where(eq(notifications.objectId, objectionId))
		.orderBy(notifications.type, notifications.userId);

const recipients = (rows: { userId: string; type: string }[]) => rows.map((row) => `${row.type}:${row.userId}`).sort();

async function messagesOf(notification: typeof notifications.$inferSelect) {
	if (!isNotificationType(notification.type)) throw new Error(`unknown type ${notification.type}`);
	const facts = await notificationFacts(database.db, crypto, { ...notification, type: notification.type });
	if (!facts) return null;
	const letter = notificationLetter(
		'someone@example.org',
		notification.type,
		facts,
		notification.payload as Record<string, unknown>,
		notificationLinks('https://career.test', notification.id)
	);
	return { facts, letter, telegram: telegramText(notification.type) };
}

describe('objection.deadline_watch', () => {
	it('is enqueued with the objection to run five days before the answer is due', async () => {
		const { opened } = await objection();
		const [watch] = await watchJobs(opened.id);
		expect(watch?.status).toBe('queued');
		expect(opened.dueAt.getTime() - (watch?.runAfter.getTime() ?? 0)).toBe(5 * DAY);
	});

	it('reminds the responsible operator and the admins, then reports the overdue answer at the deadline', async () => {
		const { opened } = await objection();
		await assignObjection(database.db, { objectionId: opened.id, operatorId: staff.assignee, requestId: 'r' });

		await reachWatch(opened.id, 5 * DAY - 60_000);
		expect(await runWatch(opened.id)).toEqual({ stage: 'due_soon', notified: 2 });
		const dueSoon = await reminders(opened.id);
		expect(recipients(dueSoon)).toEqual(
			[`objection.due_soon:${staff.assignee}`, `objection.due_soon:${staff.admin}`].sort()
		);
		const [, next] = await watchJobs(opened.id);
		const [current] = await database.db
			.select({ dueAt: assessmentObjections.dueAt })
			.from(assessmentObjections)
			.where(eq(assessmentObjections.id, opened.id));
		expect(next?.status).toBe('queued');
		expect(next?.runAfter.getTime()).toBe(current?.dueAt.getTime());

		// The letter names the deadline only: no candidate, no reason of the objection.
		const dueOn = current?.dueAt.toISOString().slice(0, 10).split('-').reverse().join('.');
		for (const notification of dueSoon) {
			const messages = await messagesOf(notification);
			expect(messages?.letter.subject).toBe('Скоро истекает срок ответа на возражение — ФСП | Карьера');
			expect(messages?.letter.text).toContain(`истекает ${dueOn}`);
			expect(messages?.letter.text).not.toContain(REASON);
			expect(messages?.telegram).toBe('Скоро истекает срок ответа на возражение — ФСП | Карьера');
			const opened = await openNotification(database.db, notification.userId, notification.id, new Date());
			expect(opened?.target).toEqual(
				notification.userId === staff.admin ? { kind: 'admin_staff' } : { kind: 'operator_objections' }
			);
		}

		// Delivered again before the deadline: nobody is reminded twice, the watch of the deadline stays one.
		await reachWatch(opened.id, 5 * DAY - 60_000);
		expect(await runWatch(opened.id)).toEqual({ stage: 'due_soon', notified: 0 });
		expect((await watchJobs(opened.id)).filter((job) => job.status === 'queued')).toHaveLength(1);

		await reachWatch(opened.id, -60_000);
		expect(await runWatch(opened.id)).toEqual({ stage: 'overdue', notified: 2 });
		const all = await reminders(opened.id);
		expect(recipients(all.filter((row) => row.type === 'objection.overdue'))).toEqual(
			[`objection.overdue:${staff.assignee}`, `objection.overdue:${staff.admin}`].sort()
		);
		expect((await watchJobs(opened.id)).filter((job) => job.status === 'queued')).toEqual([]);
		const overdue = all.find((row) => row.type === 'objection.overdue' && row.userId === staff.assignee);
		if (!overdue) throw new Error('no overdue reminder');
		expect((await messagesOf(overdue))?.letter.subject).toBe(
			'Просрочен ответ на возражение по результату теста — ФСП | Карьера'
		);
	});

	it('reminds every operator when nobody answers for the objection, never a revoked one', async () => {
		const { opened } = await objection();
		// The responsible operator lost the role: the objection is everyone's again.
		const former = await grantRole('operator');
		await assignObjection(database.db, { objectionId: opened.id, operatorId: former, requestId: 'r' });
		await database.db
			.update(staffRoles)
			.set({ revokedAt: new Date(), revokedBy: staff.admin })
			.where(eq(staffRoles.userId, former));

		await reachWatch(opened.id, 5 * DAY - 60_000);
		await runWatch(opened.id);
		expect(recipients(await reminders(opened.id))).toEqual(
			[staff.assignee, staff.operator, staff.admin].map((id) => `objection.due_soon:${id}`).sort()
		);
		expect(recipients(await reminders(opened.id))).not.toContain(`objection.due_soon:${staff.revoked}`);
	});

	it('reminds nobody of an answered or withdrawn objection', async () => {
		const { candidate, opened } = await objection();
		await reachWatch(opened.id, 5 * DAY - 60_000);
		await runWatch(opened.id);
		const sent = await reminders(opened.id);
		expect(sent.length).toBeGreaterThan(0);

		await withdrawObjection(database.db, {
			objectionId: opened.id,
			candidateId: candidate.id,
			userId: candidate.userId,
			requestId: 'r'
		});
		// A reminder still waiting for its delivery is not sent any more.
		for (const notification of sent) expect(await messagesOf(notification)).toBeNull();

		await reachWatch(opened.id, -60_000);
		expect(await runWatch(opened.id)).toEqual({ stage: 'closed', notified: 0 });
		expect(await reminders(opened.id)).toHaveLength(sent.length);
		expect((await watchJobs(opened.id)).filter((job) => job.status === 'queued')).toEqual([]);
	});

	it("reminds the staff of the candidate's demo session only, and the staff outside sessions of the others", async () => {
		const [session] = await database.db
			.insert(demoSessions)
			.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + DAY) })
			.returning({ id: demoSessions.id });
		if (!session) throw new Error('demo session not inserted');
		const cloneOperator = await grantRole('operator', false, session.id);
		const cloneAdmin = await grantRole('admin', false, session.id);

		const cloned = await objection(session.id);
		await reachWatch(cloned.opened.id, 5 * DAY - 60_000);
		expect(await runWatch(cloned.opened.id)).toEqual({ stage: 'due_soon', notified: 2 });
		expect(recipients(await reminders(cloned.opened.id))).toEqual(
			[cloneOperator, cloneAdmin].map((id) => `objection.due_soon:${id}`).sort()
		);

		const real = await objection();
		await reachWatch(real.opened.id, 5 * DAY - 60_000);
		await runWatch(real.opened.id);
		expect(recipients(await reminders(real.opened.id))).toEqual(
			[staff.assignee, staff.operator, staff.admin].map((id) => `objection.due_soon:${id}`).sort()
		);
	});
});
