// The engine's side of objections (docs/domain.md, 12.5): `ObjectionDecisions` of the owner of objections, carried out
// on the engine's tables. `decisionsOf` — the decisions the owner of categories resolves; `find` — the objected decision
// with how long the artifacts of its attempt are kept; `annul` — the outcome «аннулировано»: the attempt annulled with
// `objection_upheld`, not counted; `rescore` — the outcome «пересчитано»: corrected scores of some clusters, the
// procedure replayed by the contract's `redecide` over the clusters as served, the new decision superseding the old one.
// The owner of objections then brings the category to the decisions itself (`applyGradeDecisions`) in the same
// transaction. Opening an objection holds the artifacts of the attempt until its answer is due plus 30 days.
import { and, asc, eq, lt, max } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { ObjectedDecision, ObjectionDecisions, RescoredItem } from '$lib/server/categories/objections';
import type { Journal } from '$lib/server/categories/publish';
import type { Executor, Transaction } from '$lib/server/db';
import { gradeDecisions, testArtifacts, testAttempts, testItems } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { annulAttemptIn } from './annul';
import { GRADE_KEYS, type SpecializationKey } from './contract/catalog';
import { PROCEDURE, SCALE, redecide, type ClusterResult } from './contract/procedure';
import { decisionRecords } from './decision-records';
import { decisionValues, ruleOf } from './engine';

const DAY_MS = 86_400_000;
/** The artifacts of an attempt with an open objection are kept until the answer is due plus this long (domain 10.7). */
export const OBJECTION_HOLD_DAYS = 30;

async function find(executor: Executor, decisionId: string): Promise<ObjectedDecision | null> {
	const [row] = await executor
		.select({ decision: gradeDecisions, keptUntil: max(testArtifacts.retentionUntil) })
		.from(gradeDecisions)
		.leftJoin(testArtifacts, eq(testArtifacts.attemptId, gradeDecisions.attemptId))
		.where(eq(gradeDecisions.id, decisionId))
		.groupBy(gradeDecisions.id);
	if (!row) return null;
	const { decision } = row;
	const grade = GRADE_KEYS.find((g) => g === decision.grade);
	if (!grade) throw new Error(`decision ${decision.id} of unknown grade ${decision.grade}`);
	// Every decided attempt has artifacts; without any, nothing is kept beyond the decision.
	const keptUntil = row.keptUntil === null ? decision.decidedAt : new Date(`${row.keptUntil}T23:59:59.999Z`);
	return {
		id: decision.id,
		candidateId: decision.candidateId,
		attemptId: decision.attemptId,
		specialization: decision.specialization as SpecializationKey,
		grade,
		outcome: decision.outcome,
		status: decision.status,
		decidedAt: decision.decidedAt,
		artifactsKeptUntil: keptUntil
	};
}

/** The valid decision locked for a change; a decision already annulled or superseded cannot be changed again. */
async function lockValid(tx: Transaction, decisionId: string) {
	const [decision] = await tx.select().from(gradeDecisions).where(eq(gradeDecisions.id, decisionId)).for('update');
	if (!decision) throw new ApiError('not_found');
	if (decision.status !== 'valid') {
		throw new ApiError('conflict', {
			message: 'Решение уже аннулировано или пересмотрено',
			details: [{ code: 'decision_not_valid', message: 'Решение уже аннулировано или пересмотрено' }]
		});
	}
	return decision;
}

const userOf = (journal: Journal): string | null =>
	journal.actor.kind === 'user' || journal.actor.kind === 'api_key' ? journal.actor.userId : null;

async function annul(tx: Transaction, objected: ObjectedDecision, journal: Journal): Promise<void> {
	const decision = await lockValid(tx, objected.id);
	await annulAttemptIn(tx, null, {
		attemptId: decision.attemptId,
		reason: 'objection_upheld',
		annulledBy: userOf(journal),
		actor: journal.actor,
		requestId: journal.requestId,
		ip: null,
		userAgent: null,
		now: new Date()
	});
}

async function rescore(
	tx: Transaction,
	objected: ObjectedDecision,
	rescored: readonly RescoredItem[],
	journal: Journal
): Promise<string> {
	const now = new Date();
	const decision = await lockValid(tx, objected.id);
	const [attempt] = await tx.select().from(testAttempts).where(eq(testAttempts.id, decision.attemptId)).for('update');
	if (!attempt) throw new Error(`attempt ${decision.attemptId} is missing`);
	const items = await tx
		.select()
		.from(testItems)
		.where(eq(testItems.attemptId, attempt.id))
		.orderBy(asc(testItems.seq));
	const corrections = new Map(rescored.map((r) => [r.seq, r]));
	rescored.forEach((r, index) => {
		const item = items.find((i) => i.seq === r.seq);
		if (!item || item.score === null) {
			throw new ApiError('validation_failed', {
				details: [
					{ path: `rescored_items.${index}.seq`, code: 'unknown_item', message: `Кластер ${r.seq} не оценивался` }
				]
			});
		}
		const scaled = r.score * SCALE;
		if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
			throw new ApiError('validation_failed', {
				details: [{ path: `rescored_items.${index}.score`, code: 'scale', message: 'Балл кратен 0,05' }]
			});
		}
	});
	// The clusters as served, up to the last scored one: slots are never added after the fact.
	const clusters: ClusterResult[] = [];
	for (const item of items) {
		if (item.score === null) break;
		clusters.push({
			block: item.block,
			angoff: item.angoff,
			score: corrections.get(item.seq)?.score ?? item.score,
			practice: item.practice
		});
	}
	const next = redecide(PROCEDURE, ruleOf(attempt), clusters);
	for (const item of items) {
		const correction = corrections.get(item.seq);
		if (!correction) continue;
		const detail = (item.scoreDetail ?? {}) as Record<string, unknown> & { reviews?: unknown[] };
		await tx
			.update(testItems)
			.set({
				score: correction.score,
				scoreDetail: {
					...detail,
					reviews: [
						...(detail.reviews ?? []),
						{ previous: item.score, score: correction.score, reason: correction.reason, at: now.toISOString() }
					]
				}
			})
			.where(eq(testItems.id, item.id));
	}
	await tx.update(gradeDecisions).set({ status: 'superseded' }).where(eq(gradeDecisions.id, decision.id));
	const [row] = await tx
		.insert(gradeDecisions)
		.values({ ...decisionValues(attempt, next, now), supersedesDecisionId: decision.id })
		.returning({ id: gradeDecisions.id });
	if (!row) throw new Error('decision was not inserted');
	await recordAuditEvent(tx, {
		action: 'assessment.score_revised',
		outcome: 'success',
		actor: journal.actor,
		object: { type: 'test_attempt', id: attempt.id },
		subjectCandidateId: attempt.candidateId,
		requestId: journal.requestId,
		occurredAt: now,
		details: { superseded_decision_id: decision.id, decision_id: row.id, rescored_items: rescored.length }
	});
	return row.id;
}

/** The engine's implementation of the port of objections. */
export const ENGINE_OBJECTION_DECISIONS: ObjectionDecisions = { decisionsOf: decisionRecords, find, annul, rescore };

/**
 * An objection was opened: the artifacts of the attempt are kept until its answer is due plus `OBJECTION_HOLD_DAYS`
 * (domain 10.7), never shortened. The table is append-only; only a later `retention_until` is let through.
 */
export async function holdAttemptArtifacts(tx: Transaction, attemptId: string, dueAt: Date): Promise<void> {
	const until = new Date(dueAt.getTime() + OBJECTION_HOLD_DAYS * DAY_MS).toISOString().slice(0, 10);
	await tx
		.update(testArtifacts)
		.set({ retentionUntil: until })
		.where(and(eq(testArtifacts.attemptId, attemptId), lt(testArtifacts.retentionUntil, until)));
}
