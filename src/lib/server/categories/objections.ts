// Objections to a test result (docs/domain.md 12.5; parts 3–4 of article 16 of 152-FZ): the candidate objects to a grade
// decision while the artifacts of the attempt are kept, an FSP operator takes the objection into review and answers
// within 30 days. The outcomes: `upheld` — the decision stays; `annulled` — the attempt is annulled as not counted
// (`objection_upheld`); `rescored` — the operator corrects the scores of clusters, the procedure decides again on the
// same clusters, and the new decision replaces the old one. Either way the category is brought to the decisions that
// remain (`applyGradeDecisions`) in the transaction of the answer.
//
// The decision, the attempt and their annulment and rescoring belong to the engine of the test; this module reaches
// them only through `ObjectionDecisions`. Permission checks belong to the caller (`objection.manage` for the operator,
// `candidate.self.write` for the candidate). The job `objection.deadline_watch` reminds the FSP staff of the deadline
// five days before it and once it has passed.
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { GradeKey, SpecializationKey } from '$lib/server/assessments/contract/catalog';
import type { DecisionOutcome } from '$lib/server/assessments/contract/procedure';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database, Executor, Transaction } from '$lib/server/db';
import { assessmentObjections, candidates, OBJECTION_OUTCOMES, staffRoles, users } from '$lib/server/db/schema';
import { candidateSession } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import { defineHandler, type JobHandler } from '$lib/server/jobs/handler';
import { enqueueJob } from '$lib/server/jobs/queue';
import { notify } from '$lib/server/notifications/notify';
import { holdAttemptArtifacts, ENGINE_OBJECTION_DECISIONS } from '$lib/server/assessments/objection-decisions';
import type { GradeDecisionReader } from './decisions';
import { applyGradeDecisions, type Journal } from './publish';

export type AssessmentObjection = typeof assessmentObjections.$inferSelect;
export type ObjectionOutcome = (typeof OBJECTION_OUTCOMES)[number];

const ACTIVE_STATUSES = ['open', 'in_review'] as const;
export const OBJECTION_REASON_MAX_LENGTH = 2000;
const RESOLUTION_MAX_LENGTH = 4000;
/** The deadline watch warns the staff this long before the answer is due (domain 12.5). */
export const WARN_BEFORE_DUE_MS = 5 * 24 * 60 * 60 * 1000;

/** The objected decision as this module needs it; the engine of the test reads it from `grade_decisions`. */
export interface ObjectedDecision {
	id: string;
	candidateId: string;
	attemptId: string;
	specialization: SpecializationKey;
	grade: GradeKey;
	outcome: DecisionOutcome;
	/** `superseded` — replaced by the decision of a review. */
	status: 'valid' | 'annulled' | 'superseded';
	decidedAt: Date;
	/** The artifacts of the attempt are kept until then: an objection is possible while they are (domain 12.5). */
	artifactsKeptUntil: Date;
}

/** A corrected score of one cluster with the operator's grounds (contracts 9.3, `rescored_items`). */
export interface RescoredItem {
	seq: number;
	score: number;
	reason: string;
}

/**
 * What the outcomes of an objection do to the decision, carried out by the engine of the test in the transaction of
 * the answer. `annul` annuls the attempt with `objection_upheld` — the decision stops counting with
 * `objection_annulled`. `rescore` records the new decision with `supersedes_decision_id` — the old one stops counting
 * with `objection_rescored` — and returns the id of the new decision. The category is then brought to the decisions by
 * `applyGradeDecisions`, which reads them through the same port.
 */
export interface ObjectionDecisions extends GradeDecisionReader {
	find(executor: Executor, decisionId: string): Promise<ObjectedDecision | null>;
	annul(tx: Transaction, decision: ObjectedDecision, journal: Journal): Promise<void>;
	rescore(
		tx: Transaction,
		decision: ObjectedDecision,
		items: readonly RescoredItem[],
		journal: Journal
	): Promise<string>;
}

/** The one place where objections meet the engine of the test: its implementation on `grade_decisions`. */
export const OBJECTION_DECISIONS: ObjectionDecisions = ENGINE_OBJECTION_DECISIONS;

function text(value: string, path: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > max) {
		throw new ApiError('validation_failed', {
			details: [{ path, code: 'length', message: `от 1 до ${max} символов` }]
		});
	}
	return trimmed;
}

async function lockObjection(tx: Transaction, objectionId: string): Promise<AssessmentObjection> {
	const [objection] = await tx
		.select()
		.from(assessmentObjections)
		.where(eq(assessmentObjections.id, objectionId))
		.for('update');
	if (!objection) throw new ApiError('not_found');
	return objection;
}

/** Whether a decision takes an objection now: a decision in force, while the artifacts of its attempt are kept. */
export type ObjectionWindow = { open: true; until: Date } | { open: false; reason: 'not_in_force' | 'expired' };

export const OBJECTION_CLOSED_TEXTS: Record<Extract<ObjectionWindow, { open: false }>['reason'], string> = {
	not_in_force: 'Решение уже аннулировано: возражать не против чего',
	expired: 'Срок хранения попытки истёк: возражение больше не принимается'
};

export function objectionWindow(decision: ObjectedDecision, now: Date): ObjectionWindow {
	if (decision.status !== 'valid') return { open: false, reason: 'not_in_force' };
	if (now.getTime() > decision.artifactsKeptUntil.getTime()) return { open: false, reason: 'expired' };
	return { open: true, until: decision.artifactsKeptUntil };
}

/**
 * The candidate objects to their own decision (domain 12.5): while the artifacts of the attempt are kept, one open
 * objection per decision. Another candidate's decision is «not found».
 */
export async function openObjection(
	db: Database,
	decisions: ObjectionDecisions,
	input: {
		candidateId: string;
		userId: string;
		decisionId: string;
		reason: string;
		items?: readonly string[];
		requestId: string;
		now: Date;
	}
): Promise<AssessmentObjection> {
	const reason = text(input.reason, 'reason', OBJECTION_REASON_MAX_LENGTH);
	const decision = await decisions.find(db, input.decisionId);
	if (!decision || decision.candidateId !== input.candidateId) throw new ApiError('not_found');
	const term = objectionWindow(decision, input.now);
	if (!term.open) throw new ApiError('conflict', { message: OBJECTION_CLOSED_TEXTS[term.reason] });
	return db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({ id: candidates.id })
			.from(candidates)
			.where(eq(candidates.id, input.candidateId))
			.for('update');
		if (!candidate) throw new ApiError('not_found');
		const [active] = await tx
			.select({ id: assessmentObjections.id })
			.from(assessmentObjections)
			.where(
				and(
					eq(assessmentObjections.decisionId, decision.id),
					inArray(assessmentObjections.status, [...ACTIVE_STATUSES])
				)
			);
		if (active) throw new ApiError('conflict', { message: 'По этому решению уже есть открытое возражение' });
		const [objection] = await tx
			.insert(assessmentObjections)
			.values({
				candidateId: input.candidateId,
				decisionId: decision.id,
				reason,
				items: input.items && input.items.length > 0 ? [...new Set(input.items)] : null,
				openedAt: sql`now()`,
				dueAt: sql`now() + interval '30 days'`,
				status: 'open'
			})
			.returning();
		if (!objection) throw new Error('objection was not inserted');
		// The artifacts of the attempt are evidence of the review: kept until the answer is due plus 30 days (domain 10.7).
		await holdAttemptArtifacts(tx, decision.attemptId, objection.dueAt);
		await enqueueJob(
			tx,
			'objection.deadline_watch',
			{ objection_id: objection.id },
			{
				inputVersion: objection.id,
				createdBy: { kind: 'user', id: input.userId },
				runAfter: new Date(objection.dueAt.getTime() - WARN_BEFORE_DUE_MS)
			}
		);
		await recordAuditEvent(tx, {
			action: 'objection.opened',
			outcome: 'success',
			actor: { kind: 'user', userId: input.userId },
			object: { type: 'assessment_objection', id: objection.id },
			subjectCandidateId: input.candidateId,
			requestId: input.requestId,
			details: { decision_id: decision.id }
		});
		return objection;
	});
}

/** An operator takes the objection into review as the responsible person; one in review may be reassigned. */
export async function assignObjection(
	db: Database,
	input: { objectionId: string; operatorId: string; requestId: string }
): Promise<AssessmentObjection> {
	return db.transaction(async (tx) => {
		const objection = await lockObjection(tx, input.objectionId);
		if (!(ACTIVE_STATUSES as readonly string[]).includes(objection.status)) throw new ApiError('conflict');
		const [updated] = await tx
			.update(assessmentObjections)
			.set({ status: 'in_review', assigneeId: input.operatorId })
			.where(eq(assessmentObjections.id, objection.id))
			.returning();
		if (!updated) throw new Error('objection disappeared while locked');
		await recordAuditEvent(tx, {
			action: 'objection.assigned',
			outcome: 'success',
			actor: { kind: 'user', userId: input.operatorId },
			object: { type: 'assessment_objection', id: objection.id },
			subjectCandidateId: objection.candidateId,
			// The assignee is the actor of the event; the candidate's export never names an operator's account.
			requestId: input.requestId
		});
		return updated;
	});
}

/** The candidate withdraws their objection before it is resolved. */
export async function withdrawObjection(
	db: Database,
	input: { objectionId: string; candidateId: string; userId: string; requestId: string }
): Promise<AssessmentObjection> {
	return db.transaction(async (tx) => {
		const objection = await lockObjection(tx, input.objectionId);
		if (objection.candidateId !== input.candidateId) throw new ApiError('not_found');
		if (!(ACTIVE_STATUSES as readonly string[]).includes(objection.status)) throw new ApiError('conflict');
		const [updated] = await tx
			.update(assessmentObjections)
			.set({ status: 'withdrawn' })
			.where(eq(assessmentObjections.id, objection.id))
			.returning();
		if (!updated) throw new Error('objection disappeared while locked');
		await recordAuditEvent(tx, {
			action: 'objection.resolved',
			outcome: 'success',
			actor: { kind: 'user', userId: input.userId },
			object: { type: 'assessment_objection', id: objection.id },
			subjectCandidateId: objection.candidateId,
			requestId: input.requestId,
			details: { status: 'withdrawn' }
		});
		return updated;
	});
}

export type ObjectionAnswer =
	| { outcome: 'upheld'; resolution: string }
	| { outcome: 'annulled'; resolution: string }
	| { outcome: 'rescored'; resolution: string; items: readonly RescoredItem[] };

function validRescoredItems(items: readonly RescoredItem[]): RescoredItem[] {
	const problems = items.flatMap((item, index) => {
		const path = `rescored_items.${index}`;
		const out = [];
		if (!Number.isInteger(item.seq) || item.seq < 1)
			out.push({ path: `${path}.seq`, code: 'invalid', message: 'Номер слота' });
		if (!(item.score >= 0 && item.score <= 1)) out.push({ path: `${path}.score`, code: 'range', message: 'От 0 до 1' });
		if (item.reason.trim().length === 0) out.push({ path: `${path}.reason`, code: 'required', message: 'Обоснование' });
		return out;
	});
	if (items.length === 0) problems.push({ path: 'rescored_items', code: 'required', message: 'Хотя бы один кластер' });
	if (new Set(items.map((item) => item.seq)).size !== items.length) {
		problems.push({ path: 'rescored_items', code: 'duplicate', message: 'Каждый кластер — один раз' });
	}
	if (problems.length > 0) throw new ApiError('validation_failed', { details: problems });
	return items.map((item) => ({ ...item, reason: item.reason.trim() }));
}

/**
 * The responsible operator answers the objection taken into review (domain 12.5). The outcome is carried out on the
 * decision in the same transaction — annulment or a rescored decision by the engine of the test — and the candidate is
 * notified of the outcome only; the explanation is read in the product.
 */
export async function resolveObjection(
	db: Database,
	decisions: ObjectionDecisions,
	input: { objectionId: string; operatorId: string; answer: ObjectionAnswer; requestId: string }
): Promise<AssessmentObjection> {
	const resolution = text(input.answer.resolution, 'resolution', RESOLUTION_MAX_LENGTH);
	const items = input.answer.outcome === 'rescored' ? validRescoredItems(input.answer.items) : [];
	const journal: Journal = { requestId: input.requestId, actor: { kind: 'user', userId: input.operatorId } };
	return db.transaction(async (tx) => {
		const objection = await lockObjection(tx, input.objectionId);
		// Only the responsible operator answers, and only an objection taken into review.
		if (objection.status !== 'in_review' || objection.assigneeId !== input.operatorId) throw new ApiError('conflict');
		const decision = await decisions.find(tx, objection.decisionId);
		if (!decision) throw new Error(`decision ${objection.decisionId} of objection ${objection.id} is missing`);
		let resultingDecisionId: string | null = null;
		if (input.answer.outcome !== 'upheld' && decision.status !== 'valid') {
			throw new ApiError('conflict', { message: 'Решение уже аннулировано: остаётся только оставить его в силе' });
		}
		if (input.answer.outcome === 'annulled') await decisions.annul(tx, decision, journal);
		if (input.answer.outcome === 'rescored')
			resultingDecisionId = await decisions.rescore(tx, decision, items, journal);
		if (input.answer.outcome !== 'upheld') {
			await applyGradeDecisions(tx, decision.candidateId, decision.specialization, journal, decisions);
		}
		const [updated] = await tx
			.update(assessmentObjections)
			.set({
				status: 'resolved',
				outcome: input.answer.outcome,
				resolution,
				resultingDecisionId,
				resolvedAt: sql`now()`,
				notifiedAt: sql`now()`
			})
			.where(eq(assessmentObjections.id, objection.id))
			.returning();
		if (!updated) throw new Error('objection disappeared while locked');
		const [candidate] = await tx
			.select({ userId: candidates.userId })
			.from(candidates)
			.where(eq(candidates.id, objection.candidateId));
		if (!candidate) throw new Error(`candidate ${objection.candidateId} of objection ${objection.id} is missing`);
		await notify(tx, {
			userId: candidate.userId,
			type: 'objection.decided',
			objectId: objection.id,
			payload: { outcome: input.answer.outcome }
		});
		await recordAuditEvent(tx, {
			action: 'objection.resolved',
			outcome: 'success',
			actor: journal.actor,
			object: { type: 'assessment_objection', id: objection.id },
			subjectCandidateId: objection.candidateId,
			requestId: input.requestId,
			details: { status: 'resolved', outcome: input.answer.outcome, resulting_decision_id: resultingDecisionId }
		});
		return updated;
	});
}

/** The candidate's own objections, the latest first: the screen «Категория и грейд» and the export. */
export async function candidateObjections(executor: Executor, candidateId: string): Promise<AssessmentObjection[]> {
	return executor
		.select()
		.from(assessmentObjections)
		.where(eq(assessmentObjections.candidateId, candidateId))
		.orderBy(desc(assessmentObjections.openedAt), desc(assessmentObjections.id));
}

/** Open and in-review objections by due date, with the ones past due and due within the warning period marked. */
export async function objectionQueue(executor: Executor, now: Date) {
	const rows = await executor
		.select()
		.from(assessmentObjections)
		.where(inArray(assessmentObjections.status, [...ACTIVE_STATUSES]))
		.orderBy(asc(assessmentObjections.dueAt), asc(assessmentObjections.id));
	return rows.map((objection) => ({
		objection,
		overdue: objection.dueAt.getTime() <= now.getTime(),
		dueSoon: objection.dueAt.getTime() - now.getTime() <= WARN_BEFORE_DUE_MS
	}));
}

/**
 * Who is reminded of an objection's deadline (domain 12.5): the responsible operator while they hold the role,
 * otherwise every operator, and every admin — of those who reach the objection (domain 19.3): the staff of the
 * candidate's demo session, the staff outside sessions for a candidate outside them. Distinct user ids.
 */
async function deadlineRecipients(
	tx: Transaction,
	assigneeId: string | null,
	session: string | null
): Promise<string[]> {
	const staff = await tx
		.select({ userId: staffRoles.userId, role: staffRoles.role })
		.from(staffRoles)
		.innerJoin(users, eq(users.id, staffRoles.userId))
		.where(
			and(
				isNull(staffRoles.revokedAt),
				session === null ? isNull(users.demoSessionId) : eq(users.demoSessionId, session)
			)
		);
	const operators = staff.filter((row) => row.role === 'operator').map((row) => row.userId);
	const admins = staff.filter((row) => row.role === 'admin').map((row) => row.userId);
	const answering = assigneeId !== null && operators.includes(assigneeId) ? [assigneeId] : operators;
	return [...new Set([...answering, ...admins])].sort();
}

/**
 * The deadline watch of one objection, enqueued when it opens to run five days before `due_at`: an objection still
 * waiting for its answer reminds the staff (`objection.due_soon`) and enqueues its own next run at `due_at`, which
 * reports the overdue answer (`objection.overdue`). An objection answered, withdrawn or removed meanwhile ends the watch
 * without anything. Each recipient gets each stage once, however often the job runs.
 */
export const objectionDeadlineWatch: JobHandler<'objection.deadline_watch'> = defineHandler({
	type: 'objection.deadline_watch',
	concurrency: 2,
	run: ({ job }) => {
		const objectionId = job.payload.objection_id;
		let stage: 'closed' | 'due_soon' | 'overdue' = 'closed';
		let notified = 0;
		return Promise.resolve({
			// Decided in the write under the objection's lock: one answered meanwhile is simply not reminded of.
			isCurrent: () => Promise.resolve(true),
			write: async (tx) => {
				const [objection] = await tx
					.select({
						id: assessmentObjections.id,
						status: assessmentObjections.status,
						assigneeId: assessmentObjections.assigneeId,
						dueAt: assessmentObjections.dueAt,
						session: sql<string | null>`${candidateSession(assessmentObjections.candidateId)}`,
						// The clock of the queue, which captured the job at `run_after`.
						overdue: sql<boolean>`${assessmentObjections.dueAt} <= now()`
					})
					.from(assessmentObjections)
					.where(eq(assessmentObjections.id, objectionId))
					.for('update');
				// Removed with the candidate's account (account.purge), answered or withdrawn: nothing is due.
				if (!objection || !(ACTIVE_STATUSES as readonly string[]).includes(objection.status)) return;
				stage = objection.overdue ? 'overdue' : 'due_soon';
				for (const userId of await deadlineRecipients(tx, objection.assigneeId, objection.session)) {
					const created = await notify(tx, {
						userId,
						type: stage === 'due_soon' ? 'objection.due_soon' : 'objection.overdue',
						objectId: objection.id,
						// One notification per recipient and stage.
						stage: userId,
						payload: { objection_id: objection.id }
					});
					if (created) notified++;
				}
				if (stage === 'due_soon') {
					await enqueueJob(
						tx,
						'objection.deadline_watch',
						{ objection_id: objection.id },
						{ inputVersion: objection.id, createdBy: { kind: 'system', id: job.id }, runAfter: objection.dueAt }
					);
				}
			},
			describe: () => ({ stage, notified })
		});
	}
});
