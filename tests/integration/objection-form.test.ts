// An objection to a test result from the screen of the result (docs/domain.md 12.5; ч. 4 ст. 16 152-ФЗ): the form posts
// to the owner of objections as `POST /api/v1/me/tests/decisions/{id}/objections` does — one open objection per
// decision, another candidate's decision is «not found» — the page shows the objection filed and takes no second one
// until it is withdrawn. The page and its actions run as their route runs them.
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { Actor } from '$lib/server/access/actor';
import { assessmentObjections, gradeDecisions, testArtifacts, testItems } from '$lib/server/db/schema';
import { recordDecision } from '../helpers/categories';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, randomSha256 } from '../helpers/factories';

// The route reads `config()`: its environment points at this file's database once it exists.
const env = vi.hoisted((): Record<string, string> => ({}));
vi.mock('$env/dynamic/private', () => ({ env }));

const { closeDb } = await import('$lib/server/db');
const { testEnvironment } = await import('../helpers/environment');
const decisionPage = await import('../../src/routes/(app)/me/tests/decisions/[decisionId]/+page.server');

let database: TestDatabase;
let requests = 0;

beforeAll(async () => {
	database = await createTestDatabase();
	Object.assign(env, testEnvironment({ DATABASE_URL: database.url, REDIS_URL: inject('redisUrl') }));
});

afterAll(async () => {
	await closeDb();
	await database.drop();
});

function sessionActor(userId: string): Actor {
	return {
		kind: 'session',
		userId,
		sessionHash: randomSha256(),
		authTime: new Date(),
		authMethod: 'password',
		csrfToken: `csrf-${randomBytes(4).toString('hex')}`
	};
}

function event(actor: Actor, request: Request, decisionId: string) {
	return {
		url: new URL(request.url),
		params: { decisionId },
		request,
		locals: { requestId: `req-objection-${++requests}`, actor },
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		depends: () => {}
	};
}

/** A candidate with a decided attempt whose artifacts are kept for a month: the decision takes an objection. */
async function decided() {
	const candidate = await createCandidate(database.db);
	const decision = await recordDecision(database.db, candidate.id, { specialization: 'backend', grade: 'junior' });
	const attemptId = await attemptOf(decision.id);
	const [item] = await database.db
		.insert(testItems)
		.values({
			attemptId,
			seq: 1,
			block: 'backend.http',
			format: 'single_choice',
			practice: false,
			familyKey: 'be.http.junior-0',
			familyVersion: 1,
			classId: 'a',
			instanceSeed: 'seed',
			instance: {},
			angoff: 0.5,
			servedAt: new Date(),
			status: 'served'
		})
		.returning({ id: testItems.id });
	if (!item) throw new Error('item not inserted');
	const kept = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
	await database.db
		.insert(testArtifacts)
		.values({ attemptId, itemId: item.id, seq: 1, kind: 'answer', sha256: randomSha256(), retentionUntil: kept });
	return { candidate, decisionId: decision.id, actor: sessionActor(candidate.userId) };
}

async function attemptOf(decisionId: string): Promise<string> {
	const [row] = await database.db
		.select({ attemptId: gradeDecisions.attemptId })
		.from(gradeDecisions)
		.where(eq(gradeDecisions.id, decisionId));
	if (!row) throw new Error(`decision ${decisionId} is not recorded`);
	return row.attemptId;
}

type ObjectAnswer =
	{ objectionOpened: true } | { status: number; data: { reason: string; problem: { code: string; message: string } } };

async function object(actor: Actor, decisionId: string, reason: string): Promise<ObjectAnswer> {
	const action = decisionPage.actions.object;
	if (!action) throw new Error('the page has no objection action');
	const form = new FormData();
	form.set('reason', reason);
	const url = `http://localhost/me/tests/decisions/${decisionId}?/object`;
	return (await action(
		event(actor, new Request(url, { method: 'POST', body: form }), decisionId) as never
	)) as ObjectAnswer;
}

async function withdraw(actor: Actor, decisionId: string, objectionId: string) {
	const action = decisionPage.actions.withdraw;
	if (!action) throw new Error('the page has no withdrawal action');
	const form = new FormData();
	form.set('objectionId', objectionId);
	const url = `http://localhost/me/tests/decisions/${decisionId}?/withdraw`;
	return action(event(actor, new Request(url, { method: 'POST', body: form }), decisionId) as never);
}

interface PageData {
	objections: { id: string; status: string; reason: string }[];
	intake: { state: 'active' } | { state: 'open'; until: string } | { state: 'closed'; text: string };
}

async function load(actor: Actor, decisionId: string): Promise<PageData> {
	const url = `http://localhost/me/tests/decisions/${decisionId}`;
	return (await decisionPage.load(event(actor, new Request(url), decisionId) as never)) as PageData;
}

const objectionsOf = (decisionId: string) =>
	database.db.select().from(assessmentObjections).where(eq(assessmentObjections.decisionId, decisionId));

describe('an objection from the screen of the result', () => {
	it('files the objection and takes no second one until it is withdrawn', async () => {
		const { decisionId, actor } = await decided();
		expect(await object(actor, decisionId, '  Второе задание оценено неверно  ')).toEqual({ objectionOpened: true });
		const [filed] = await objectionsOf(decisionId);
		expect(filed).toMatchObject({ status: 'open', reason: 'Второе задание оценено неверно' });

		// A second objection while the first waits: refused with the text kept in the form.
		const again = await object(actor, decisionId, 'Ещё раз');
		expect(again).toMatchObject({ status: 409, data: { reason: 'Ещё раз', problem: { code: 'conflict' } } });
		expect(await objectionsOf(decisionId)).toHaveLength(1);

		await withdraw(actor, decisionId, filed?.id ?? '');
		const [withdrawn] = await objectionsOf(decisionId);
		expect(withdrawn?.status).toBe('withdrawn');
		expect(await object(actor, decisionId, 'Подаю снова')).toEqual({ objectionOpened: true });
	});

	it("refuses another candidate's decision as not found and an empty reason as invalid", async () => {
		const { decisionId, actor } = await decided();
		const stranger = await createCandidate(database.db);
		expect(await object(sessionActor(stranger.userId), decisionId, 'Не моё решение')).toMatchObject({
			status: 404,
			data: { problem: { code: 'not_found' } }
		});
		expect(await object(actor, decisionId, '   ')).toMatchObject({
			status: 400,
			data: { problem: { code: 'length' } }
		});
		expect(await objectionsOf(decisionId)).toEqual([]);
	});

	it('takes no objection once the attempt is no longer kept', async () => {
		const candidate = await createCandidate(database.db);
		// Without kept artifacts the attempt is kept no longer than its decision.
		const decision = await recordDecision(database.db, candidate.id, { specialization: 'backend', grade: 'junior' });
		const actor = sessionActor(candidate.userId);
		expect((await load(actor, decision.id)).intake).toEqual({
			state: 'closed',
			text: 'Срок хранения попытки истёк: возражение больше не принимается'
		});
		expect(await object(actor, decision.id, 'Поздно')).toMatchObject({ status: 409 });
	});

	it('shows the objection waiting for its answer instead of the form', async () => {
		const candidate = await createCandidate(database.db);
		const decision = await recordDecision(database.db, candidate.id, { specialization: 'backend', grade: 'junior' });
		const [waiting] = await database.db
			.insert(assessmentObjections)
			.values({
				candidateId: candidate.id,
				decisionId: decision.id,
				reason: 'Балл за практику не засчитан',
				openedAt: new Date(),
				dueAt: new Date(Date.now() + 30 * 86_400_000),
				status: 'open'
			})
			.returning({ id: assessmentObjections.id });
		const page = await load(sessionActor(candidate.userId), decision.id);
		expect(page.objections.map((o) => [o.id, o.status])).toEqual([[waiting?.id, 'open']]);
		expect(page.intake).toEqual({ state: 'active' });
	});
});
