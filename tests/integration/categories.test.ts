// The one owner of categories against the database (docs/domain.md, sections 12.4, 12.5, 12.7): the category of a
// specialization is what `resolveCategory` gives over its grade decisions — a higher grade replaces it, a decision that
// stops counting revokes what stood on it and gives way to what the remaining ones support — changes of the profile
// evidence never touch it, a candidate without one is apart from every category output, and objections to test
// results are answered by the operator who took them.
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admitCandidates, admittedCategories } from '$lib/server/categories/admission';
import {
	assignObjection,
	objectionQueue,
	openObjection,
	resolveObjection,
	withdrawObjection,
	type ObjectedDecision,
	type ObjectionDecisions
} from '$lib/server/categories/objections';
import { activeCategories, categoryHistory, categoryPredicate, policyCategory } from '$lib/server/categories/read';
import {
	assessmentObjections,
	auditEvents,
	candidateCategories,
	candidates,
	jobs,
	notifications
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { recordEvidenceChange } from '$lib/server/resumes/revision';
import { decide, invalidate, invalidateIn, recordDecisionIn } from '../helpers/categories';
import { GRADE_DECISIONS } from '$lib/server/categories/decisions';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createUser } from '../helpers/factories';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.drop();
});

const DAY = 86_400_000;

async function categoriesOf(candidateId: string) {
	return database.db
		.select()
		.from(candidateCategories)
		.where(eq(candidateCategories.candidateId, candidateId))
		.orderBy(candidateCategories.assignedAt);
}

async function revisionOf(candidateId: string) {
	const [row] = await database.db
		.select({ revision: candidates.profileRevision })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	return row?.revision;
}

describe('publication of a category', () => {
	it('assigns a confirmed grade with the stack of its defining blocks and keeps it on a failure', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const before = await revisionOf(candidate.id);

		const failed = await decide(db, candidate.id, {
			specialization: 'backend',
			grade: 'middle',
			outcome: 'not_confirmed'
		});
		expect(failed.applied).toEqual({ change: { action: 'keep' }, categoryId: null, revoked: [] });
		expect(await categoriesOf(candidate.id)).toEqual([]);
		expect(await revisionOf(candidate.id)).toBe(before);

		const { decision, applied } = await decide(db, candidate.id, { specialization: 'backend', grade: 'junior' });
		expect(applied.change).toEqual({ action: 'assign', grade: 'junior' });
		const [category] = await categoriesOf(candidate.id);
		expect(category).toMatchObject({
			specialization: 'backend',
			grade: 'junior',
			status: 'active',
			decisionId: decision.id,
			bankReleaseId: 'test-release',
			confirmedBlocks: ['be.db', 'be.api'],
			endedAt: null,
			revokeReason: null
		});
		// The skills of the defining blocks and the practice language — never those of another block of the grade.
		expect(category?.confirmedSkillKeys).toEqual(['databases', 'python', 'rest', 'sql']);
		expect(category?.confirmedSkillKeys).not.toContain('algorithms');
		expect(category?.assignedAt).toEqual(decision.decidedAt);

		// The change of the category is a change of the profile: a new revision with its recalculations.
		expect(await revisionOf(candidate.id)).toBe((before ?? 0) + 1);
		const queued = await db
			.select({ type: jobs.type })
			.from(jobs)
			.where(and(eq(jobs.status, 'queued'), eq(jobs.inputVersion, String((before ?? 0) + 1))));
		expect(queued.map((job) => job.type)).toEqual(expect.arrayContaining(['evidence.compute', 'match.refresh']));
		const [event] = await db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'category.assigned'), eq(auditEvents.objectId, category?.id ?? '')));
		expect(event?.details).toMatchObject({ specialization: 'backend', grade: 'junior', decision_id: decision.id });
		const [notice] = await db
			.select()
			.from(notifications)
			.where(and(eq(notifications.userId, candidate.userId), eq(notifications.type, 'category.assigned')));
		expect(notice).toMatchObject({ objectId: category?.id, category: 'account' });
	});

	it('replaces the category by a higher grade and keeps it on a lower one', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const decidedAt = new Date(Date.now() - 100 * DAY);
		const first = await decide(db, candidate.id, { specialization: 'qa', grade: 'junior', decidedAt });
		const next = await decide(db, candidate.id, { specialization: 'qa', grade: 'middle' });
		expect(next.applied.change).toEqual({ action: 'supersede', from: 'junior', grade: 'middle' });
		const lower = await decide(db, candidate.id, { specialization: 'qa', grade: 'junior' });
		expect(lower.applied.change).toEqual({ action: 'keep' });
		expect(await categoriesOf(candidate.id)).toHaveLength(2);
		const [junior, middle] = await categoriesOf(candidate.id);
		expect(junior).toMatchObject({ grade: 'junior', status: 'superseded', decisionId: first.decision.id });
		expect(junior?.endedAt).not.toBeNull();
		expect(middle).toMatchObject({ grade: 'middle', status: 'active', decisionId: next.decision.id });
		expect(await policyCategory(db, candidate.id, 'qa')).toMatchObject({ grade: 'middle' });
	});

	it('keeps categories of different specializations, one in force per specialization', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		await decide(db, candidate.id, { specialization: 'backend', grade: 'middle' });
		await decide(db, candidate.id, { specialization: 'frontend', grade: 'junior' });
		const held = (await activeCategories(db, [candidate.id])).get(candidate.id) ?? [];
		expect(held.map((c) => [c.specialization, c.grade])).toEqual([
			['backend', 'middle'],
			['frontend', 'junior']
		]);
		const [backend] = held;
		if (!backend) throw new Error('no category');
		// The database refuses a second category in force of one specialization, whoever writes it.
		await expect(
			db.insert(candidateCategories).values({
				candidateId: candidate.id,
				specialization: 'backend',
				grade: 'senior',
				catalogVersion: backend.catalogVersion,
				decisionId: backend.decisionId,
				bankReleaseId: backend.bankReleaseId,
				confirmedBlocks: [],
				confirmedSkillKeys: [],
				status: 'active',
				assignedAt: new Date()
			})
		).rejects.toThrow();
	});

	it('takes the right to the next grade off once a test is taken on it', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const confident = await decide(db, candidate.id, { specialization: 'backend', grade: 'junior', confident: true });
		const [category] = await categoriesOf(candidate.id);
		expect(category?.confidentUpgradeUntil).toEqual(new Date(confident.decision.decidedAt.getTime() + 30 * DAY));
		const failed = await decide(db, candidate.id, {
			specialization: 'backend',
			grade: 'middle',
			outcome: 'not_confirmed',
			viaConfidentUpgrade: true
		});
		expect(failed.applied.change).toEqual({ action: 'keep' });
		expect(await policyCategory(db, candidate.id, 'backend')).toMatchObject({
			grade: 'junior',
			confidentUpgradeUntil: null
		});
	});
});

describe('revocation', () => {
	it('revokes the category of an annulled decision and gives way to the one it replaced', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const junior = await decide(db, candidate.id, {
			specialization: 'backend',
			grade: 'junior',
			decidedAt: new Date(Date.now() - 100 * DAY)
		});
		const middle = await decide(db, candidate.id, { specialization: 'backend', grade: 'middle' });
		const [assignedBefore] = await categoriesOf(candidate.id);

		const applied = await invalidate(db, candidate.id, middle.decision.id, 'decision_annulled');
		expect(applied.change).toEqual({ action: 'restore', from: 'middle', grade: 'junior' });
		expect(applied.revoked).toHaveLength(1);
		const history = await categoryHistory(db, candidate.id);
		expect(history.map((c) => [c.grade, c.status, c.revokeReason])).toEqual([
			['middle', 'revoked', 'decision_annulled'],
			['junior', 'active', null]
		]);
		// The restored category keeps its own assignment: a failure higher up never lowers a confirmed grade.
		const restored = history.find((c) => c.grade === 'junior');
		expect(restored?.assignedAt).toEqual(assignedBefore?.assignedAt);
		expect(restored?.endedAt).toBeNull();
		expect(restored?.decisionId).toBe(junior.decision.id);
		const [notice] = await db
			.select()
			.from(notifications)
			.where(and(eq(notifications.userId, candidate.userId), eq(notifications.type, 'category.revoked')));
		expect(notice?.payload).toEqual({ reason: 'decision_annulled', restored: true });

		// A decision whose category was replaced since: its category is revoked, the one in force stays.
		const again = await decide(db, candidate.id, { specialization: 'backend', grade: 'middle' });
		const kept = await invalidate(db, candidate.id, junior.decision.id, 'decision_annulled');
		expect(kept.change).toEqual({ action: 'keep' });
		const held = (await activeCategories(db, [candidate.id])).get(candidate.id);
		expect(held?.map((c) => [c.grade, c.decisionId])).toEqual([['middle', again.decision.id]]);
		expect((await categoryHistory(db, candidate.id)).find((c) => c.decisionId === junior.decision.id)).toMatchObject({
			status: 'revoked',
			revokeReason: 'decision_annulled'
		});
	});

	it('after a chain of annulments holds what the remaining decisions support', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const junior = await decide(db, candidate.id, {
			specialization: 'devops',
			grade: 'junior',
			decidedAt: new Date(Date.now() - 300 * DAY)
		});
		const middle = await decide(db, candidate.id, {
			specialization: 'devops',
			grade: 'middle',
			decidedAt: new Date(Date.now() - 200 * DAY)
		});
		const senior = await decide(db, candidate.id, { specialization: 'devops', grade: 'senior' });
		expect((await invalidate(db, candidate.id, middle.decision.id, 'decision_annulled')).change).toEqual({
			action: 'keep'
		});
		expect((await invalidate(db, candidate.id, senior.decision.id, 'decision_annulled')).change).toEqual({
			action: 'restore',
			from: 'senior',
			grade: 'junior'
		});
		const held = (await activeCategories(db, [candidate.id])).get(candidate.id);
		expect(held?.map((c) => [c.grade, c.decisionId, c.assignedAt])).toEqual([
			['junior', junior.decision.id, junior.decision.decidedAt]
		]);
	});

	it('replaces a rescored decision: what stood on the old one is revoked, the new one applies', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		const old = await decide(db, candidate.id, { specialization: 'data_ml', grade: 'junior' });
		await database.db.transaction((tx) => invalidateIn(tx, old.decision.id, 'objection_rescored'));
		const rescored = await decide(db, candidate.id, {
			specialization: 'data_ml',
			grade: 'junior',
			outcome: 'not_confirmed'
		});
		expect(rescored.applied.change).toEqual({ action: 'revoke', from: 'junior' });
		expect((await categoriesOf(candidate.id)).map((c) => [c.status, c.revokeReason])).toEqual([
			['revoked', 'objection_rescored']
		]);
	});
});

describe('the evidence of the profile and the category', () => {
	it('keeps the category when the resume is replaced: the evidence is withdrawn, the category stays', async () => {
		const { db } = database;
		const candidate = await createCandidate(db);
		await decide(db, candidate.id, { specialization: 'backend', grade: 'middle' });
		// What replacing or deleting the resume does in its transaction (`resumes/upload.ts`, `resumes/delete.ts`).
		await db.transaction((tx) =>
			recordEvidenceChange(tx, {
				candidateId: candidate.id,
				withdrawal: true,
				reason: 'resume_replaced',
				requestId: 'test',
				actor: { kind: 'system' },
				createdBy: { kind: 'system' }
			})
		);
		const held = (await activeCategories(db, [candidate.id])).get(candidate.id);
		expect(held?.map((c) => [c.specialization, c.grade])).toEqual([['backend', 'middle']]);
		const [row] = await db.select().from(candidates).where(eq(candidates.id, candidate.id));
		expect(row?.evidenceFloorRevision).toBe(row?.profileRevision);
	});
});

describe('a candidate without a category', () => {
	it('is apart from the categories a vacancy admits, while one of another specialization is in neither list', async () => {
		const { db } = database;
		const backend = await createCandidate(db);
		const senior = await createCandidate(db);
		const frontend = await createCandidate(db);
		const none = await createCandidate(db);
		await decide(db, backend.id, { specialization: 'backend', grade: 'middle' });
		await decide(db, senior.id, { specialization: 'backend', grade: 'junior' });
		await decide(db, frontend.id, { specialization: 'frontend', grade: 'middle' });
		const ordinals = new Map([
			['intern', 0],
			['junior', 1],
			['middle', 2],
			['senior', 3],
			['lead', 4]
		]);
		const admitted = admittedCategories({ roleKey: 'backend', grade: { min: 'middle', max: 'lead' } }, ordinals);
		expect(admitted).toEqual({ specializations: ['backend'], grades: ['middle', 'senior'] });
		const admission = await admitCandidates(db, [backend.id, senior.id, frontend.id, none.id], admitted);
		expect(admission).toEqual({ admitted: [backend.id], unconfirmed: [none.id] });

		// A role no test checks admits nobody; a Lead-only vacancy neither.
		expect(admittedCategories({ roleKey: 'onec', grade: null }, ordinals)).toBeNull();
		expect(admittedCategories({ roleKey: 'backend', grade: { min: 'lead', max: 'lead' } }, ordinals)).toBeNull();
		expect((await admitCandidates(db, [backend.id, none.id], null)).admitted).toEqual([]);

		const rows = await db
			.select({ id: candidates.id })
			.from(candidates)
			.where(
				and(
					inArray(candidates.id, [backend.id, senior.id, frontend.id, none.id]),
					categoryPredicate(candidates.id, { specializations: ['backend'], grades: ['middle'] })
				)
			);
		expect(rows.map((r) => r.id)).toEqual([backend.id]);
		expect(() => categoryPredicate(candidates.id, { grades: [] })).toThrow(/empty/);
	});
});

describe('objections to a test result', () => {
	/** The engine of the test as objections reach it: the decisions it keeps, annulled or replaced by a review. */
	function engine(): ObjectionDecisions & { decisions: Map<string, ObjectedDecision> } {
		const decisions = new Map<string, ObjectedDecision>();
		return {
			decisions,
			decisionsOf: (...args) => GRADE_DECISIONS.decisionsOf(...args),
			find: (_, id) => Promise.resolve(decisions.get(id) ?? null),
			annul: async (tx, decision) => {
				decisions.set(decision.id, { ...decision, status: 'annulled' });
				await invalidateIn(tx, decision.id, 'objection_annulled');
			},
			rescore: async (tx, decision) => {
				await invalidateIn(tx, decision.id, 'objection_rescored');
				const next = await recordDecisionIn(tx, decision.candidateId, {
					specialization: decision.specialization,
					grade: decision.grade
				});
				return next.id;
			}
		};
	}

	async function decided(fake: ReturnType<typeof engine>, outcome: 'confirmed' | 'not_confirmed' = 'confirmed') {
		const { db } = database;
		const candidate = await createCandidate(db);
		const { decision } = await decide(db, candidate.id, { specialization: 'backend', grade: 'junior', outcome });
		fake.decisions.set(decision.id, {
			id: decision.id,
			candidateId: candidate.id,
			attemptId: decision.id,
			specialization: decision.specialization,
			grade: decision.grade,
			outcome: decision.outcome,
			status: 'valid',
			decidedAt: decision.decidedAt,
			artifactsKeptUntil: new Date(Date.now() + 90 * DAY)
		});
		return { candidate, decision };
	}

	const open = (fake: ObjectionDecisions, candidate: { id: string; userId: string }, decisionId: string) =>
		openObjection(database.db, fake, {
			candidateId: candidate.id,
			userId: candidate.userId,
			decisionId,
			reason: '  Второе задание оценено неверно  ',
			requestId: 'test',
			now: new Date()
		});

	it('opens with a 30-day deadline and a deadline watch, one at a time per decision, only the own one', async () => {
		const { db } = database;
		const fake = engine();
		const { candidate, decision } = await decided(fake, 'not_confirmed');
		const objection = await open(fake, candidate, decision.id);
		expect(objection).toMatchObject({ status: 'open', reason: 'Второе задание оценено неверно', assigneeId: null });
		expect(objection.dueAt.getTime() - objection.openedAt.getTime()).toBe(30 * DAY);
		const [watch] = await db
			.select()
			.from(jobs)
			.where(eq(jobs.dedupKey, `objection:${objection.id}`));
		expect(watch?.runAfter.getTime()).toBe(objection.dueAt.getTime() - 5 * DAY);
		await expect(open(fake, candidate, decision.id)).rejects.toMatchObject({ code: 'conflict' });
		const other = await createCandidate(db);
		await expect(open(fake, other, decision.id)).rejects.toMatchObject({ code: 'not_found' });

		const late = await decided(fake);
		const kept = fake.decisions.get(late.decision.id);
		if (!kept) throw new Error('no decision');
		fake.decisions.set(late.decision.id, { ...kept, artifactsKeptUntil: new Date(Date.now() - DAY) });
		await expect(open(fake, late.candidate, late.decision.id)).rejects.toBeInstanceOf(ApiError);

		const queue = await objectionQueue(db, new Date(objection.dueAt.getTime() - 60_000));
		expect(queue.find((q) => q.objection.id === objection.id)).toMatchObject({ overdue: false, dueSoon: true });
	});

	it('is answered only by the operator who took it into review; the candidate may withdraw it', async () => {
		const { db } = database;
		const fake = engine();
		const { candidate, decision } = await decided(fake);
		const operator = await createUser(db);
		const objection = await open(fake, candidate, decision.id);
		const answer = { outcome: 'upheld' as const, resolution: 'Оценка верна по артефактам' };
		await expect(
			resolveObjection(db, fake, { objectionId: objection.id, operatorId: operator.id, answer, requestId: 't' })
		).rejects.toMatchObject({ code: 'conflict' });
		await assignObjection(db, { objectionId: objection.id, operatorId: operator.id, requestId: 't' });
		const other = await createUser(db);
		await expect(
			resolveObjection(db, fake, { objectionId: objection.id, operatorId: other.id, answer, requestId: 't' })
		).rejects.toMatchObject({ code: 'conflict' });
		const upheld = await resolveObjection(db, fake, {
			objectionId: objection.id,
			operatorId: operator.id,
			answer,
			requestId: 't'
		});
		expect(upheld).toMatchObject({ status: 'resolved', outcome: 'upheld', resultingDecisionId: null });
		expect((await activeCategories(db, [candidate.id])).get(candidate.id)).toHaveLength(1);
		const [notice] = await db
			.select()
			.from(notifications)
			.where(and(eq(notifications.objectId, objection.id), eq(notifications.type, 'objection.decided')));
		expect(notice).toMatchObject({ userId: candidate.userId, payload: { outcome: 'upheld' } });

		const second = await open(fake, candidate, decision.id);
		const withdrawn = await withdrawObjection(db, {
			objectionId: second.id,
			candidateId: candidate.id,
			userId: candidate.userId,
			requestId: 't'
		});
		expect(withdrawn.status).toBe('withdrawn');
		await expect(
			withdrawObjection(db, {
				objectionId: second.id,
				candidateId: candidate.id,
				userId: candidate.userId,
				requestId: 't'
			})
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('annuls the attempt and revokes the category, or rescores and replaces the decision', async () => {
		const { db } = database;
		const fake = engine();
		const operator = await createUser(db);
		const take = async (objectionId: string) =>
			assignObjection(db, { objectionId, operatorId: operator.id, requestId: 't' });

		const first = await decided(fake);
		const annulled = await open(fake, first.candidate, first.decision.id);
		await take(annulled.id);
		await resolveObjection(db, fake, {
			objectionId: annulled.id,
			operatorId: operator.id,
			answer: { outcome: 'annulled', resolution: 'Задание с дефектом' },
			requestId: 't'
		});
		expect((await categoriesOf(first.candidate.id)).map((c) => [c.status, c.revokeReason])).toEqual([
			['revoked', 'objection_annulled']
		]);

		const second = await decided(fake);
		const rescored = await open(fake, second.candidate, second.decision.id);
		await take(rescored.id);
		await expect(
			resolveObjection(db, fake, {
				objectionId: rescored.id,
				operatorId: operator.id,
				answer: { outcome: 'rescored', resolution: 'Пересчитано', items: [] },
				requestId: 't'
			})
		).rejects.toMatchObject({ code: 'validation_failed' });
		const resolved = await resolveObjection(db, fake, {
			objectionId: rescored.id,
			operatorId: operator.id,
			answer: { outcome: 'rescored', resolution: 'Пересчитано', items: [{ seq: 3, score: 1, reason: 'верный ответ' }] },
			requestId: 't'
		});
		expect(resolved.resultingDecisionId).not.toBeNull();
		const history = await categoryHistory(db, second.candidate.id);
		expect(history.map((c) => [c.status, c.decisionId])).toEqual([
			['active', resolved.resultingDecisionId],
			['revoked', second.decision.id]
		]);
		const [row] = await db.select().from(assessmentObjections).where(eq(assessmentObjections.id, rescored.id));
		expect(row?.status).toBe('resolved');
	});
});
