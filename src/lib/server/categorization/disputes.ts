// Objections to a category (docs/domain.md 12.3; part 3–4 of article 16 of 152-FZ): the candidate opens one against the
// published run, an FSP operator takes it into review and answers within 30 days — upholding the category or replacing
// it by a manual decision that stands until the desired roles or the grounds of the category change. Permission checks
// belong to the caller (`dispute.manage` for the operator, `candidate.self.write` for the candidate). The job
// `dispute.deadline_watch` reminds the FSP staff of the deadline five days before it and once it has passed.
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database, Transaction } from '$lib/server/db';
import { runInForce } from '$lib/server/db/conditions';
import {
	candidates,
	categorizationRuns,
	categoryDisputes,
	fspLevelAssignments,
	skillInferences,
	staffRoles,
	users
} from '$lib/server/db/schema';
import { candidateSession } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import { defineHandler, type JobHandler } from '$lib/server/jobs/handler';
import { enqueueJob } from '$lib/server/jobs/queue';
import { notify } from '$lib/server/notifications/notify';
import { insertPublishedRun, matchesBasis, overrideBasisOf, type StoredAssignment } from './job';
import { loadRulesById, loadSnapshot } from './snapshot';
import type { ManualOverrideExplanation, RulesContext } from './types';

export type CategoryDispute = typeof categoryDisputes.$inferSelect;

const ACTIVE_STATUSES = ['open', 'in_review'] as const;
const REASON_MAX_LENGTH = 4000;
/** The deadline watch warns the assignee this long before the answer is due (domain 12.3). */
const WARN_BEFORE_DUE_MS = 5 * 24 * 60 * 60 * 1000;

function text(value: string, path: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > REASON_MAX_LENGTH) {
		throw new ApiError('validation_failed', {
			details: [{ path, code: 'length', message: `от 1 до ${REASON_MAX_LENGTH} символов` }]
		});
	}
	return trimmed;
}

async function lockDispute(tx: Transaction, disputeId: string): Promise<CategoryDispute> {
	const [dispute] = await tx.select().from(categoryDisputes).where(eq(categoryDisputes.id, disputeId)).for('update');
	if (!dispute) throw new ApiError('not_found');
	return dispute;
}

/** The candidate objects to the category currently published for them. */
export async function openDispute(
	db: Database,
	input: { candidateId: string; userId: string; runId: string; reason: string; requestId: string }
): Promise<CategoryDispute> {
	const reason = text(input.reason, 'reason');
	return db.transaction(async (tx) => {
		const [run] = await tx
			.select({ id: categorizationRuns.id })
			.from(categorizationRuns)
			.innerJoin(candidates, eq(candidates.id, categorizationRuns.candidateId))
			.where(
				and(
					eq(categorizationRuns.id, input.runId),
					eq(categorizationRuns.candidateId, input.candidateId),
					runInForce(categorizationRuns, candidates)
				)
			)
			.for('update', { of: categorizationRuns });
		// Another candidate's run and a run no longer shown are indistinguishable to the caller.
		if (!run) throw new ApiError('not_found');
		const [active] = await tx
			.select({ id: categoryDisputes.id })
			.from(categoryDisputes)
			.where(and(eq(categoryDisputes.runId, run.id), inArray(categoryDisputes.status, [...ACTIVE_STATUSES])));
		if (active) throw new ApiError('conflict', { message: 'По этой категории уже есть открытое возражение' });

		const [dispute] = await tx
			.insert(categoryDisputes)
			.values({
				candidateId: input.candidateId,
				runId: run.id,
				reason,
				openedAt: sql`now()`,
				dueAt: sql`now() + interval '30 days'`,
				status: 'open'
			})
			.returning();
		if (!dispute) throw new Error('dispute was not inserted');
		await enqueueJob(
			tx,
			'dispute.deadline_watch',
			{ dispute_id: dispute.id },
			{
				inputVersion: dispute.id,
				createdBy: { kind: 'user', id: input.userId },
				runAfter: new Date(dispute.dueAt.getTime() - WARN_BEFORE_DUE_MS)
			}
		);
		await recordAuditEvent(tx, {
			action: 'dispute.opened',
			outcome: 'success',
			actor: { kind: 'user', userId: input.userId },
			object: { type: 'category_dispute', id: dispute.id },
			subjectCandidateId: input.candidateId,
			requestId: input.requestId,
			details: { run_id: run.id }
		});
		return dispute;
	});
}

/** An operator takes the dispute into review as the responsible person; a dispute in review may be reassigned. */
export async function assignDispute(
	db: Database,
	input: { disputeId: string; operatorId: string; requestId: string }
): Promise<CategoryDispute> {
	return db.transaction(async (tx) => {
		const dispute = await lockDispute(tx, input.disputeId);
		if (!(ACTIVE_STATUSES as readonly string[]).includes(dispute.status)) throw new ApiError('conflict');
		const [updated] = await tx
			.update(categoryDisputes)
			.set({ status: 'in_review', assigneeId: input.operatorId })
			.where(eq(categoryDisputes.id, dispute.id))
			.returning();
		if (!updated) throw new Error('dispute disappeared while locked');
		await recordAuditEvent(tx, {
			action: 'dispute.assigned',
			outcome: 'success',
			actor: { kind: 'user', userId: input.operatorId },
			object: { type: 'category_dispute', id: dispute.id },
			subjectCandidateId: dispute.candidateId,
			// The assignee is the actor of the event; the candidate's export never names an operator's account.
			requestId: input.requestId
		});
		return updated;
	});
}

/** The candidate withdraws their objection before it is resolved. */
export async function withdrawDispute(
	db: Database,
	input: { disputeId: string; candidateId: string; userId: string; requestId: string }
): Promise<CategoryDispute> {
	return db.transaction(async (tx) => {
		const dispute = await lockDispute(tx, input.disputeId);
		if (dispute.candidateId !== input.candidateId) throw new ApiError('not_found');
		if (!(ACTIVE_STATUSES as readonly string[]).includes(dispute.status)) throw new ApiError('conflict');
		const [updated] = await tx
			.update(categoryDisputes)
			.set({ status: 'withdrawn' })
			.where(eq(categoryDisputes.id, dispute.id))
			.returning();
		if (!updated) throw new Error('dispute disappeared while locked');
		await recordAuditEvent(tx, {
			action: 'dispute.resolved',
			outcome: 'success',
			actor: { kind: 'user', userId: input.userId },
			object: { type: 'category_dispute', id: dispute.id },
			subjectCandidateId: dispute.candidateId,
			requestId: input.requestId,
			details: { status: 'withdrawn' }
		});
		return updated;
	});
}

/** The candidate learns the answer in the transaction of the decision; the answer itself is read on the category page. */
async function notifyDecided(tx: Transaction, dispute: CategoryDispute): Promise<void> {
	const [candidate] = await tx
		.select({ userId: candidates.userId })
		.from(candidates)
		.where(eq(candidates.id, dispute.candidateId));
	if (!candidate) throw new Error(`candidate ${dispute.candidateId} of dispute ${dispute.id} is missing`);
	await notify(tx, {
		userId: candidate.userId,
		type: 'dispute.decided',
		objectId: dispute.id,
		payload: { dispute_id: dispute.id, status: dispute.status }
	});
}

async function inReviewBy(tx: Transaction, disputeId: string, operatorId: string): Promise<CategoryDispute> {
	const dispute = await lockDispute(tx, disputeId);
	// Only the responsible operator answers, and only a dispute taken into review.
	if (dispute.status !== 'in_review' || dispute.assigneeId !== operatorId) throw new ApiError('conflict');
	return dispute;
}

/** The operator keeps the category and answers the candidate. */
export async function upholdCategory(
	db: Database,
	input: { disputeId: string; operatorId: string; resolution: string; requestId: string }
): Promise<CategoryDispute> {
	const resolution = text(input.resolution, 'resolution');
	return db.transaction(async (tx) => {
		const dispute = await inReviewBy(tx, input.disputeId, input.operatorId);
		const [updated] = await tx
			.update(categoryDisputes)
			.set({ status: 'resolved_upheld', resolution, resolvedAt: sql`now()`, notifiedAt: sql`now()` })
			.where(eq(categoryDisputes.id, dispute.id))
			.returning();
		if (!updated) throw new Error('dispute disappeared while locked');
		await notifyDecided(tx, updated);
		await recordAuditEvent(tx, {
			action: 'dispute.resolved',
			outcome: 'success',
			actor: { kind: 'user', userId: input.operatorId },
			object: { type: 'category_dispute', id: dispute.id },
			subjectCandidateId: dispute.candidateId,
			requestId: input.requestId,
			details: { status: 'resolved_upheld' }
		});
		return updated;
	});
}

export interface OverrideAxes {
	roleKey: string | null;
	grade: { min: string; max: string; confidence: number } | null;
	stackSkillKeys: string[];
}

function invalid(path: string, code: string, message: string): ApiError {
	return new ApiError('validation_failed', { details: [{ path, code, message }] });
}

/** Axes of a manual decision are keys of the disputed run's taxonomy, with a consistent grade range. */
function validateAxes(axes: OverrideAxes, rules: RulesContext): void {
	if (axes.roleKey !== null && !rules.roles.some((r) => r.key === axes.roleKey)) {
		throw invalid('axes.roleKey', 'unknown_role', 'Нет такой роли в версии таксономии');
	}
	if (axes.grade !== null) {
		const ordinal = (key: string) => rules.grades.find((g) => g.key === key)?.ordinal;
		const min = ordinal(axes.grade.min);
		const max = ordinal(axes.grade.max);
		if (min === undefined || max === undefined) throw invalid('axes.grade', 'unknown_grade', 'Нет такого грейда');
		if (min > max) throw invalid('axes.grade', 'range', 'Нижняя граница грейда выше верхней');
		const { confidence } = axes.grade;
		if (!(confidence >= 0 && confidence <= 1)) throw invalid('axes.grade.confidence', 'range', 'От 0 до 1');
	}
	const skills = new Set(rules.skills.map((s) => s.key));
	if (axes.stackSkillKeys.length > 3 || new Set(axes.stackSkillKeys).size !== axes.stackSkillKeys.length) {
		throw invalid('axes.stackSkillKeys', 'size', 'До трёх разных навыков');
	}
	for (const skill of axes.stackSkillKeys) {
		if (!skills.has(skill))
			throw invalid('axes.stackSkillKeys', 'unknown_skill', 'Нет такого навыка в версии таксономии');
	}
	if (axes.roleKey === null && axes.grade === null && axes.stackSkillKeys.length === 0) {
		throw invalid('axes', 'empty', 'Установите хотя бы одну ось категории');
	}
}

/**
 * The operator replaces the category by a manual decision: a `manual_override` run over the same input as the disputed
 * one, published in its place, with the operator as author and the resolution as reason (domain 12.1, 12.3). Skill
 * inferences and FSP levels do not change and are carried over. The decision is only possible while the desired roles
 * and the grounds of the disputed run are still the candidate's current ones — preferences, work format and catalog
 * visibility may have changed meanwhile, that alone does not block the answer; after a real change (desired roles or
 * grounds) the automatic calculation answers instead and the candidate may object again.
 */
export async function changeCategory(
	db: Database,
	input: { disputeId: string; operatorId: string; resolution: string; axes: OverrideAxes; requestId: string }
): Promise<{ dispute: CategoryDispute; runId: string }> {
	const resolution = text(input.resolution, 'resolution');
	return db.transaction(async (tx) => {
		const dispute = await inReviewBy(tx, input.disputeId, input.operatorId);
		const [disputed] = await tx.select().from(categorizationRuns).where(eq(categorizationRuns.id, dispute.runId));
		if (!disputed) throw new Error(`disputed run ${dispute.runId} is missing`);
		// Read outside the row lock, like the compute job reads its snapshot: `db`, not `tx`.
		const loaded = await loadSnapshot(db, dispute.candidateId);
		const current = loaded ? overrideBasisOf(loaded.snapshot) : null;
		if (disputed.status !== 'published' || current === null || !matchesBasis(disputed.inputRefs, current)) {
			throw new ApiError('conflict', { message: 'Категория пересчитана после возражения: решите по новой' });
		}
		const rules = await loadRulesById(tx, disputed.rulesetId);
		const { axes } = input;
		validateAxes(axes, rules);

		const explanation: ManualOverrideExplanation = {
			origin: 'manual_override',
			dispute_id: dispute.id,
			previous_run_id: disputed.id,
			ruleset_version: rules.rulesetVersion,
			taxonomy_version: rules.taxonomyLabel
		};
		const assignment: StoredAssignment = {
			rank: 'primary',
			roleStatus: axes.roleKey === null ? 'insufficient_data' : 'established',
			roleKey: axes.roleKey,
			score: null,
			gradeStatus: axes.grade === null ? 'insufficient_data' : 'established',
			gradeMin: axes.grade?.min ?? null,
			gradeMax: axes.grade?.max ?? null,
			gradeConfidence: axes.grade === null ? null : Number(axes.grade.confidence.toFixed(2)),
			stackStatus: axes.stackSkillKeys.length === 0 ? 'insufficient_data' : 'established',
			stackSkillKeys: axes.stackSkillKeys,
			explanation
		};
		const complete = axes.roleKey !== null && axes.grade !== null && axes.stackSkillKeys.length > 0;
		const runId = await insertPublishedRun(
			tx,
			{
				candidateId: dispute.candidateId,
				inputRevision: disputed.inputRevision,
				inputSnapshotSha256: disputed.inputSnapshotSha256,
				inputRefs: disputed.inputRefs,
				taxonomyVersionId: disputed.taxonomyVersionId,
				taxonomyLabel: rules.taxonomyLabel,
				rulesetId: disputed.rulesetId,
				rulesetVersion: rules.rulesetVersion,
				asOf: disputed.asOf,
				jobId: null,
				origin: { kind: 'manual_override', by: input.operatorId, reason: resolution },
				outcome: complete ? 'complete' : 'partial',
				// What the operator left unknown keeps the grounds the calculation named.
				missing: {
					role: axes.roleKey === null ? missingOf(disputed.missing, 'role') : [],
					grade: axes.grade === null ? missingOf(disputed.missing, 'grade') : [],
					stack: axes.stackSkillKeys.length === 0 ? missingOf(disputed.missing, 'stack') : []
				},
				experienceSummary: disputed.experienceSummary
			},
			[assignment],
			{ requestId: input.requestId, actor: { kind: 'user', userId: input.operatorId } }
		);
		const inferences = await tx.select().from(skillInferences).where(eq(skillInferences.runId, disputed.id));
		if (inferences.length > 0) {
			await tx.insert(skillInferences).values(
				inferences.map((row) => ({
					runId,
					candidateId: row.candidateId,
					skillKey: row.skillKey,
					strength: row.strength,
					strengthBand: row.strengthBand,
					attestation: row.attestation,
					badgeTrust: row.badgeTrust,
					contributions: row.contributions
				}))
			);
		}
		const levels = await tx.select().from(fspLevelAssignments).where(eq(fspLevelAssignments.runId, disputed.id));
		if (levels.length > 0) await tx.insert(fspLevelAssignments).values(levels.map((row) => ({ ...row, runId })));
		const [updated] = await tx
			.update(categoryDisputes)
			.set({
				status: 'resolved_changed',
				resolution,
				resolvedAt: sql`now()`,
				notifiedAt: sql`now()`,
				resultingRunId: runId
			})
			.where(eq(categoryDisputes.id, dispute.id))
			.returning();
		if (!updated) throw new Error('dispute disappeared while locked');
		await notifyDecided(tx, updated);
		await recordAuditEvent(tx, {
			action: 'dispute.resolved',
			outcome: 'success',
			actor: { kind: 'user', userId: input.operatorId },
			object: { type: 'category_dispute', id: dispute.id },
			subjectCandidateId: dispute.candidateId,
			requestId: input.requestId,
			details: { status: 'resolved_changed', resulting_run_id: runId }
		});
		return { dispute: updated, runId };
	});
}

const missingAxes = z.strictObject({
	role: z.array(z.looseObject({ code: z.string() })),
	grade: z.array(z.looseObject({ code: z.string() })),
	stack: z.array(z.looseObject({ code: z.string() }))
});

function missingOf(stored: unknown, axis: 'role' | 'grade' | 'stack') {
	return missingAxes.parse(stored)[axis];
}

/** Open and in-review disputes by due date, with the ones past due and due within the warning period marked. */
export async function disputeQueue(db: Database, now: Date = new Date()) {
	const rows = await db
		.select()
		.from(categoryDisputes)
		.where(inArray(categoryDisputes.status, [...ACTIVE_STATUSES]))
		.orderBy(asc(categoryDisputes.dueAt), asc(categoryDisputes.id));
	return rows.map((dispute) => ({
		dispute,
		overdue: dispute.dueAt.getTime() <= now.getTime(),
		dueSoon: dispute.dueAt.getTime() - now.getTime() <= WARN_BEFORE_DUE_MS
	}));
}

/**
 * Who is reminded of a dispute's deadline (domain 12.3): the responsible operator while they hold the role, otherwise
 * every operator, and every admin — of those who reach the dispute (domain 19.3): the staff of the candidate's demo
 * session, the staff outside sessions for a candidate outside them. Distinct user ids.
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
 * The deadline watch of one dispute, enqueued when it opens to run five days before `due_at`: a dispute still waiting
 * for its answer reminds the staff (`dispute.due_soon`) and enqueues its own next run at `due_at`, which reports the
 * overdue answer (`dispute.overdue`). A dispute answered, withdrawn or removed meanwhile ends the watch without anything. Each
 * recipient gets each stage once, however often the job runs.
 */
export const disputeDeadlineWatch: JobHandler<'dispute.deadline_watch'> = defineHandler({
	type: 'dispute.deadline_watch',
	concurrency: 2,
	run: ({ job }) => {
		const disputeId = job.payload.dispute_id;
		let stage: 'closed' | 'due_soon' | 'overdue' = 'closed';
		let notified = 0;
		return Promise.resolve({
			// Decided in the write under the dispute's lock: a dispute answered meanwhile is simply not reminded of.
			isCurrent: () => Promise.resolve(true),
			write: async (tx) => {
				const [dispute] = await tx
					.select({
						id: categoryDisputes.id,
						status: categoryDisputes.status,
						assigneeId: categoryDisputes.assigneeId,
						dueAt: categoryDisputes.dueAt,
						session: sql<string | null>`${candidateSession(categoryDisputes.candidateId)}`,
						// The clock of the queue, which captured the job at `run_after`.
						overdue: sql<boolean>`${categoryDisputes.dueAt} <= now()`
					})
					.from(categoryDisputes)
					.where(eq(categoryDisputes.id, disputeId))
					.for('update');
				// Removed with the candidate's account (account.purge), answered or withdrawn: nothing is due.
				if (!dispute || !(ACTIVE_STATUSES as readonly string[]).includes(dispute.status)) return;
				stage = dispute.overdue ? 'overdue' : 'due_soon';
				for (const userId of await deadlineRecipients(tx, dispute.assigneeId, dispute.session)) {
					const created = await notify(tx, {
						userId,
						type: stage === 'due_soon' ? 'dispute.due_soon' : 'dispute.overdue',
						objectId: dispute.id,
						// One notification per recipient and stage.
						stage: userId,
						payload: { dispute_id: dispute.id }
					});
					if (created) notified++;
				}
				if (stage === 'due_soon') {
					await enqueueJob(
						tx,
						'dispute.deadline_watch',
						{ dispute_id: dispute.id },
						{ inputVersion: dispute.id, createdBy: { kind: 'system', id: job.id }, runAfter: dispute.dueAt }
					);
				}
			},
			describe: () => ({ stage, notified })
		});
	}
});
