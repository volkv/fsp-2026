// Objections to test results as the FSP operator works them (domain 12.5): the queue by due date with the operator who
// answers, and the case of one objection — the objected decision, the candidate's categories, and nothing identifying
// the candidate beyond what the case needs. Within an active case the candidate's data is read in the `operator`
// projection chosen by `canShow`, and every opening is `operator.case_access` in the journal (domain 4.2). The attempt
// itself — clusters, answers, artifacts — is the case of the attempt in the review of tests. Decisions are the
// functions of `categories/objections.ts`; this module checks `objection.manage` before calling them. The operator works
// the objections within its reach: a clone operator of a demo session — those of its session only (domain 19.3).
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import { categoryHistory, type CategoryRecord } from '$lib/server/categories/read';
import {
	assignObjection,
	objectionQueue,
	resolveObjection,
	WARN_BEFORE_DUE_MS,
	type AssessmentObjection,
	type ObjectedDecision,
	type ObjectionAnswer,
	type ObjectionDecisions
} from '$lib/server/categories/objections';
import { auditActorOf, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { Database, Executor } from '$lib/server/db';
import { assessmentObjections, candidates, users } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';
import { canShow } from '$lib/server/visibility/can-show';

export type ObjectionStatus = AssessmentObjection['status'];

const ACTIVE: readonly ObjectionStatus[] = ['open', 'in_review'];
const RECENT_RESOLVED = 20;

export interface ObjectionQueueItem {
	id: string;
	status: ObjectionStatus;
	openedAt: Date;
	dueAt: Date;
	overdue: boolean;
	dueSoon: boolean;
	assignee: { id: string; name: string | null } | null;
	/** The objection is taken by the signed-in operator. */
	mine: boolean;
	isMinor: boolean;
}

export interface ResolvedObjection {
	id: string;
	outcome: AssessmentObjection['outcome'];
	resolvedAt: Date | null;
	assigneeName: string | null;
}

async function assigneeNames(executor: Executor, ids: readonly string[]): Promise<Map<string, string | null>> {
	if (ids.length === 0) return new Map();
	const rows = await executor
		.select({ id: users.id, name: users.displayName })
		.from(users)
		.where(inArray(users.id, [...new Set(ids)]));
	return new Map(rows.map((row) => [row.id, row.name]));
}

/** Open and in-review objections by due date, and the latest resolved ones. */
export async function objectionQueueView(
	db: Database,
	subject: AccessSubject,
	now: Date
): Promise<{ items: ObjectionQueueItem[]; resolved: ResolvedObjection[] }> {
	requirePermission(subject, 'objection.manage', null);
	const operatorId = sessionUserId(subject);
	const reach = await StaffReach.of(db, subject);
	const open = await objectionQueue(db, now);
	const candidateIds = [...new Set(open.map(({ objection }) => objection.candidateId))];
	const profiles =
		candidateIds.length === 0
			? []
			: await db
					.select({
						id: candidates.id,
						birthDate: candidates.birthDate,
						precision: candidates.birthDatePrecision,
						status: candidates.birthDateStatus
					})
					.from(candidates)
					.where(and(inArray(candidates.id, candidateIds), reach.rows(candidates.demoSessionId)));
	const reached = new Set(profiles.map((row) => row.id));
	const queue = open.filter(({ objection }) => reached.has(objection.candidateId));
	const minor = new Map(
		profiles.map((row) => {
			const band = ageBand({ birthDate: row.birthDate, precision: row.precision, status: row.status }, now);
			return [row.id, isMinorBand(band)];
		})
	);
	const resolved = await db
		.select({
			id: assessmentObjections.id,
			outcome: assessmentObjections.outcome,
			resolvedAt: assessmentObjections.resolvedAt,
			assigneeId: assessmentObjections.assigneeId
		})
		.from(assessmentObjections)
		.where(and(eq(assessmentObjections.status, 'resolved'), reach.candidate(assessmentObjections.candidateId)))
		.orderBy(desc(assessmentObjections.resolvedAt))
		.limit(RECENT_RESOLVED);
	const names = await assigneeNames(db, [
		...queue.flatMap(({ objection }) => (objection.assigneeId ? [objection.assigneeId] : [])),
		...resolved.flatMap((row) => (row.assigneeId ? [row.assigneeId] : []))
	]);
	return {
		items: queue.map(({ objection, overdue, dueSoon }) => ({
			id: objection.id,
			status: objection.status,
			openedAt: objection.openedAt,
			dueAt: objection.dueAt,
			overdue,
			dueSoon,
			assignee: objection.assigneeId
				? { id: objection.assigneeId, name: names.get(objection.assigneeId) ?? null }
				: null,
			mine: objection.assigneeId === operatorId,
			isMinor: minor.get(objection.candidateId) ?? false
		})),
		resolved: resolved.map((row) => ({
			id: row.id,
			outcome: row.outcome,
			resolvedAt: row.resolvedAt,
			assigneeName: row.assigneeId ? (names.get(row.assigneeId) ?? null) : null
		}))
	};
}

export interface ObjectionCase {
	id: string;
	status: ObjectionStatus;
	reason: string;
	/** Clusters the candidate disagrees with (`test_items.id`). */
	items: string[];
	openedAt: Date;
	dueAt: Date;
	overdue: boolean;
	dueSoon: boolean;
	assignee: { id: string; name: string | null } | null;
	mine: boolean;
	outcome: AssessmentObjection['outcome'];
	resolution: string | null;
	resolvedAt: Date | null;
	resultingDecisionId: string | null;
	decision: ObjectedDecision;
	/** Present while the case is active: a closed case gives no access to the candidate's data. */
	candidate: { isMinor: boolean; categories: CategoryRecord[] } | null;
}

/** The demo session of a candidate. */
async function sessionOfCandidate(executor: Executor, candidateId: string): Promise<string | null> {
	const [row] = await executor
		.select({ session: candidates.demoSessionId })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} of an objection is missing`);
	return row.session;
}

async function objectionInReach(db: Database, subject: AccessSubject, objectionId: string) {
	if (!z.uuid().safeParse(objectionId).success) throw new ApiError('not_found');
	const [objection] = await db.select().from(assessmentObjections).where(eq(assessmentObjections.id, objectionId));
	if (!objection) throw new ApiError('not_found');
	const reach = await StaffReach.of(db, subject);
	reach.require(await sessionOfCandidate(db, objection.candidateId));
	return { objection, reach };
}

/**
 * One objection. While it is active, the candidate's data is read in the `operator` projection of `canShow` with the
 * case as context, and the access is journaled; a resolved objection shows the answer and the decision only.
 */
export async function objectionCase(
	db: Database,
	decisions: ObjectionDecisions,
	subject: AccessSubject,
	meta: RequestMeta,
	objectionId: string,
	now: Date
): Promise<ObjectionCase> {
	requirePermission(subject, 'objection.manage', null);
	const operatorId = sessionUserId(subject);
	const { objection, reach } = await objectionInReach(db, subject, objectionId);
	const decision = await decisions.find(db, objection.decisionId);
	if (!decision) throw new Error(`decision ${objection.decisionId} of objection ${objection.id} is missing`);
	const [assignee] = objection.assigneeId
		? await db.select({ name: users.displayName }).from(users).where(eq(users.id, objection.assigneeId))
		: [];
	const active = ACTIVE.includes(objection.status);
	let candidate: ObjectionCase['candidate'] = null;
	if (active) {
		const policy = await loadVisibilityPolicy(db, now);
		const facts = (await loadVisibilityFacts(db, [objection.candidateId], { now, policy, viewerCompanyId: null })).get(
			objection.candidateId
		);
		if (!facts) throw new Error(`candidate ${objection.candidateId} of an objection is missing`);
		const shown = canShow(
			{ ...facts, caseAccess: true },
			{ kind: 'staff', userId: operatorId, role: 'operator', demoSessionId: reach.session },
			{ kind: 'case', caseType: 'objection', caseId: objection.id }
		);
		if (!shown.allowed || shown.projection !== 'operator') throw new ApiError('not_found');
		const [row] = await db
			.select({
				birthDate: candidates.birthDate,
				precision: candidates.birthDatePrecision,
				status: candidates.birthDateStatus
			})
			.from(candidates)
			.where(eq(candidates.id, objection.candidateId));
		if (!row) throw new Error(`candidate ${objection.candidateId} of an objection is missing`);
		candidate = {
			isMinor: isMinorBand(ageBand({ birthDate: row.birthDate, precision: row.precision, status: row.status }, now)),
			categories: await categoryHistory(db, objection.candidateId)
		};
		await recordAuditEvent(db, {
			action: 'operator.case_access',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'assessment_objection', id: objection.id },
			subjectCandidateId: objection.candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { case_type: 'objection', case_id: objection.id }
		});
	}
	return {
		id: objection.id,
		status: objection.status,
		reason: objection.reason,
		items: objection.items ?? [],
		openedAt: objection.openedAt,
		dueAt: objection.dueAt,
		overdue: active && objection.dueAt.getTime() <= now.getTime(),
		dueSoon: active && objection.dueAt.getTime() - now.getTime() <= WARN_BEFORE_DUE_MS,
		assignee: objection.assigneeId ? { id: objection.assigneeId, name: assignee?.name ?? null } : null,
		mine: objection.assigneeId === operatorId,
		outcome: objection.outcome,
		resolution: objection.resolution,
		resolvedAt: objection.resolvedAt,
		resultingDecisionId: objection.resultingDecisionId,
		decision,
		candidate
	};
}

/** The operator takes the objection into review as the one who answers it. */
export async function takeObjection(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	objectionId: string
): Promise<void> {
	requirePermission(subject, 'objection.manage', null);
	await objectionInReach(db, subject, objectionId);
	await assignObjection(db, { objectionId, operatorId: sessionUserId(subject), requestId: meta.requestId });
}

/** The answer of the responsible operator: the decision stays, the attempt is annulled, or the clusters are rescored. */
export async function answerObjection(
	db: Database,
	decisions: ObjectionDecisions,
	subject: AccessSubject,
	meta: RequestMeta,
	objectionId: string,
	answer: ObjectionAnswer
): Promise<AssessmentObjection> {
	requirePermission(subject, 'objection.manage', null);
	await objectionInReach(db, subject, objectionId);
	return resolveObjection(db, decisions, {
		objectionId,
		operatorId: sessionUserId(subject),
		answer,
		requestId: meta.requestId
	});
}
