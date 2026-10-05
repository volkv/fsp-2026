// The one writer of categories (docs/domain.md, sections 12.3, 12.4): the category of a specialization is whatever
// `resolveCategory` of the contract gives over all grade decisions of that specialization, and only the decisions of
// tests change it. The engine of the test calls `applyGradeDecisions` in the transaction that records, annuls or
// replaces a decision. Replacing or deleting the resume, an FSP sync and a public profile change the evidence of the
// profile and never the category (domain 12.6).
import { and, eq, sql } from 'drizzle-orm';
import {
	CATALOG,
	confirmedStack,
	gradeDefinition,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import {
	categoryChange,
	GRADE_POLICY,
	resolveCategory,
	type CategoryChange
} from '$lib/server/assessments/contract/policy';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import type { Transaction } from '$lib/server/db';
import { candidateCategories, candidates } from '$lib/server/db/schema';
import { enqueueJob, type JobCreator } from '$lib/server/jobs/queue';
import { notify } from '$lib/server/notifications/notify';
import { GRADE_DECISIONS, type DecisionRecord, type GradeDecisionReader } from './decisions';

export interface Journal {
	requestId: string;
	actor: AuditActor;
}

/** What the decisions did to the category of the specialization. */
export interface AppliedCategory {
	change: CategoryChange;
	/** The category in force after the change; `null` — none. */
	categoryId: string | null;
	/** Categories revoked because the decision they stood on stopped counting. */
	revoked: string[];
}

function creatorOf(actor: AuditActor): JobCreator {
	return actor.kind === 'user' || actor.kind === 'api_key' ? { kind: 'user', id: actor.userId } : { kind: 'system' };
}

/**
 * A change of the category is a change of the profile: matches, caches and vectors of the previous revision stop
 * counting (domain 12.4), and the evidence is recalculated with the test fact the decision wrote.
 */
async function moveRevision(tx: Transaction, candidateId: string, createdBy: JobCreator): Promise<void> {
	const [row] = await tx
		.update(candidates)
		.set({ profileRevision: sql`${candidates.profileRevision} + 1` })
		.where(eq(candidates.id, candidateId))
		.returning({ revision: candidates.profileRevision, userId: candidates.userId });
	if (!row) throw new Error(`candidate ${candidateId} is missing`);
	const inputVersion = String(row.revision);
	await enqueueJob(tx, 'evidence.compute', { candidate_id: candidateId }, { inputVersion, createdBy });
	await enqueueJob(tx, 'match.refresh', { scope: 'candidate', candidate_id: candidateId }, { inputVersion, createdBy });
}

async function userOf(tx: Transaction, candidateId: string): Promise<string> {
	const [row] = await tx
		.select({ userId: candidates.userId })
		.from(candidates)
		.where(eq(candidates.id, candidateId))
		.for('update');
	if (!row) throw new Error(`candidate ${candidateId} is missing`);
	return row.userId;
}

/**
 * Brings the category of the specialization to its decisions (domain 12.4): `resolveCategory` over all of them is the
 * category in force, `categoryChange` names the step. A category whose decision stopped counting is revoked with the
 * reason of that decision; the one the remaining decisions support — a new one, or a replaced one coming back with its
 * own `assigned_at` — is in force. Calling it again changes nothing. The candidate row is locked: the decisions of one
 * candidate are applied one change at a time.
 */
export async function applyGradeDecisions(
	tx: Transaction,
	candidateId: string,
	specialization: SpecializationKey,
	journal: Journal,
	reader: GradeDecisionReader = GRADE_DECISIONS
): Promise<AppliedCategory> {
	const userId = await userOf(tx, candidateId);
	const decisions = await reader.decisionsOf(tx, candidateId, specialization);
	const byId = new Map(decisions.map((decision) => [decision.id, decision]));
	const decisionOf = (id: string): DecisionRecord => {
		const decision = byId.get(id);
		if (!decision) throw new Error(`category of ${candidateId} stands on decision ${id} the reader does not know`);
		return decision;
	};
	const rows = await tx
		.select()
		.from(candidateCategories)
		.where(
			and(eq(candidateCategories.candidateId, candidateId), eq(candidateCategories.specialization, specialization))
		)
		.for('update');
	const current = rows.find((row) => row.status === 'active') ?? null;
	const resolved = resolveCategory(decisions, GRADE_POLICY);
	const change = categoryChange(
		current ? [{ ...decisionOf(current.decisionId), valid: true }] : [],
		decisions,
		GRADE_POLICY
	);
	const now = new Date();

	const revoked: string[] = [];
	for (const row of rows) {
		const decision = decisionOf(row.decisionId);
		if (row.status === 'revoked' || decision.valid) continue;
		if (decision.invalidReason === null) throw new Error(`decision ${decision.id} stopped counting without a reason`);
		await tx
			.update(candidateCategories)
			.set({ status: 'revoked', revokeReason: decision.invalidReason, endedAt: row.endedAt ?? now })
			.where(eq(candidateCategories.id, row.id));
		revoked.push(row.id);
		await recordAuditEvent(tx, {
			action: 'category.revoked',
			outcome: 'success',
			actor: journal.actor,
			object: { type: 'candidate_category', id: row.id },
			subjectCandidateId: candidateId,
			requestId: journal.requestId,
			details: { reason: decision.invalidReason, decision_id: decision.id }
		});
	}

	if (change.action === 'keep') {
		if (current && resolved && current.confidentUpgradeUntil?.getTime() !== resolved.confidentUpgradeUntil?.getTime()) {
			await tx
				.update(candidateCategories)
				.set({ confidentUpgradeUntil: resolved.confidentUpgradeUntil })
				.where(eq(candidateCategories.id, current.id));
		}
		return { change, categoryId: current?.id ?? null, revoked };
	}

	if (current && !revoked.includes(current.id)) {
		await tx
			.update(candidateCategories)
			.set({ status: 'superseded', endedAt: resolved?.assignedAt ?? now })
			.where(eq(candidateCategories.id, current.id));
	}
	let categoryId: string | null = null;
	if (resolved) {
		const decision = decisionOf(resolved.decisionId);
		const existing = rows.find((row) => row.decisionId === resolved.decisionId && row.status === 'superseded');
		if (existing) {
			await tx
				.update(candidateCategories)
				.set({ status: 'active', endedAt: null, confidentUpgradeUntil: resolved.confidentUpgradeUntil })
				.where(eq(candidateCategories.id, existing.id));
			categoryId = existing.id;
		} else {
			if (decision.catalogVersion !== CATALOG.version) {
				throw new Error(`decision ${decision.id} is of catalog ${decision.catalogVersion}, not ${CATALOG.version}`);
			}
			if (decision.practiceLanguage === null) throw new Error(`confirmed decision ${decision.id} has no practice`);
			const definition = gradeDefinition(specialization, resolved.grade);
			const [inserted] = await tx
				.insert(candidateCategories)
				.values({
					candidateId,
					specialization,
					grade: resolved.grade,
					catalogVersion: decision.catalogVersion,
					decisionId: decision.id,
					bankReleaseId: decision.bankReleaseId,
					confirmedBlocks: [...definition.defining],
					confirmedSkillKeys: confirmedStack(definition, decision.practiceLanguage),
					confidentUpgradeUntil: resolved.confidentUpgradeUntil,
					status: 'active',
					assignedAt: resolved.assignedAt
				})
				.returning({ id: candidateCategories.id });
			if (!inserted) throw new Error(`category of decision ${decision.id} was not inserted`);
			categoryId = inserted.id;
		}
		if (current && !revoked.includes(current.id)) {
			await recordAuditEvent(tx, {
				action: 'category.superseded',
				outcome: 'success',
				actor: journal.actor,
				object: { type: 'candidate_category', id: current.id },
				subjectCandidateId: candidateId,
				requestId: journal.requestId,
				details: { by_category_id: categoryId }
			});
		}
		await recordAuditEvent(tx, {
			action: 'category.assigned',
			outcome: 'success',
			actor: journal.actor,
			object: { type: 'candidate_category', id: categoryId },
			subjectCandidateId: candidateId,
			requestId: journal.requestId,
			details: {
				specialization,
				grade: resolved.grade,
				decision_id: decision.id,
				bank_release_id: decision.bankReleaseId,
				change: change.action
			}
		});
	}

	if (change.action === 'assign' || change.action === 'supersede') {
		if (categoryId === null) throw new Error(`${change.action} without a category in force`);
		await notify(tx, {
			userId,
			type: 'category.assigned',
			objectId: categoryId,
			payload: { specialization, grade: change.grade }
		});
	} else if (current) {
		const reason = decisionOf(current.decisionId).invalidReason;
		if (reason === null) throw new Error(`category ${current.id} ended by ${change.action} with its decision in force`);
		await notify(tx, {
			userId,
			type: 'category.revoked',
			objectId: current.id,
			payload: { reason, restored: change.action === 'restore' }
		});
	}
	await moveRevision(tx, candidateId, creatorOf(journal.actor));
	return { change, categoryId, revoked };
}
