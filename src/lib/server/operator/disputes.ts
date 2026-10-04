// Objections to a category as the FSP operator works them (domain 12.3): the queue by due date with the operator who
// answers, and the case of one objection. The candidate's data opens only within an active case, in the `operator`
// projection chosen by `canShow`, and every opening is `operator.case_access` in the journal (domain 4.2). Decisions
// are the functions of `categorization/disputes.ts`; this module checks `dispute.manage` before calling them. The
// operator works the objections within its reach: a clone operator of a demo session — those of its session only
// (domain 19.3).
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import {
	assignDispute,
	changeCategory,
	disputeQueue,
	upholdCategory,
	type OverrideAxes
} from '$lib/server/categorization/disputes';
import { auditActorOf, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { Database, Executor } from '$lib/server/db';
import {
	candidates,
	categorizationRuns,
	categoryAssignments,
	categoryDisputes,
	files,
	fspLevelAssignments,
	resumeDocuments,
	skillInferences,
	users
} from '$lib/server/db/schema';
import { vocabularyOf, type Vocabulary } from '$lib/server/employer/vocabulary';
import { ApiError } from '$lib/server/errors/api-error';
import { loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';
import { canShow } from '$lib/server/visibility/can-show';

export type DisputeStatus = (typeof categoryDisputes.$inferSelect)['status'];

const ACTIVE: readonly DisputeStatus[] = ['open', 'in_review'];
const RECENT_RESOLVED = 20;

export interface DisputeQueueItem {
	id: string;
	status: DisputeStatus;
	openedAt: Date;
	dueAt: Date;
	overdue: boolean;
	dueSoon: boolean;
	assignee: { id: string; name: string | null } | null;
	/** The objection is taken by the signed-in operator. */
	mine: boolean;
	/** Role of the disputed category; `null` — the role axis is not established. */
	roleKey: string | null;
	isMinor: boolean;
}

export interface ResolvedDispute {
	id: string;
	status: DisputeStatus;
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
export async function disputeQueueView(
	db: Database,
	subject: AccessSubject,
	now: Date
): Promise<{ items: DisputeQueueItem[]; resolved: ResolvedDispute[] }> {
	requirePermission(subject, 'dispute.manage', null);
	const operatorId = sessionUserId(subject);
	const reach = await StaffReach.of(db, subject);
	const open = await disputeQueue(db, now);
	const candidateIds = [...new Set(open.map(({ dispute }) => dispute.candidateId))];
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
	const queue = open.filter(({ dispute }) => reached.has(dispute.candidateId));
	const runIds = queue.map(({ dispute }) => dispute.runId);
	const roles =
		runIds.length === 0
			? []
			: await db
					.select({ runId: categoryAssignments.runId, roleKey: categoryAssignments.roleKey })
					.from(categoryAssignments)
					.where(
						and(
							inArray(categoryAssignments.runId, runIds),
							eq(categoryAssignments.rank, 'primary'),
							eq(categoryAssignments.roleStatus, 'established')
						)
					);
	const roleOf = new Map(roles.map((row) => [row.runId, row.roleKey]));
	const minor = new Map(
		profiles.map((row) => {
			const band = ageBand({ birthDate: row.birthDate, precision: row.precision, status: row.status }, now);
			return [row.id, isMinorBand(band)];
		})
	);
	const resolved = await db
		.select({
			id: categoryDisputes.id,
			status: categoryDisputes.status,
			resolvedAt: categoryDisputes.resolvedAt,
			assigneeId: categoryDisputes.assigneeId
		})
		.from(categoryDisputes)
		.where(
			and(
				inArray(categoryDisputes.status, ['resolved_upheld', 'resolved_changed']),
				reach.candidate(categoryDisputes.candidateId)
			)
		)
		.orderBy(desc(categoryDisputes.resolvedAt))
		.limit(RECENT_RESOLVED);
	const names = await assigneeNames(db, [
		...queue.flatMap(({ dispute }) => (dispute.assigneeId ? [dispute.assigneeId] : [])),
		...resolved.flatMap((row) => (row.assigneeId ? [row.assigneeId] : []))
	]);
	return {
		items: queue.map(({ dispute, overdue, dueSoon }) => ({
			id: dispute.id,
			status: dispute.status,
			openedAt: dispute.openedAt,
			dueAt: dispute.dueAt,
			overdue,
			dueSoon,
			assignee: dispute.assigneeId ? { id: dispute.assigneeId, name: names.get(dispute.assigneeId) ?? null } : null,
			mine: dispute.assigneeId === operatorId,
			roleKey: roleOf.get(dispute.runId) ?? null,
			isMinor: minor.get(dispute.candidateId) ?? false
		})),
		resolved: resolved.map((row) => ({
			id: row.id,
			status: row.status,
			resolvedAt: row.resolvedAt,
			assigneeName: row.assigneeId ? (names.get(row.assigneeId) ?? null) : null
		}))
	};
}

type AxisStatus = 'established' | 'insufficient_data';

export interface CaseAssignment {
	rank: 'primary' | 'secondary';
	role: { status: AxisStatus; key: string | null };
	grade: { status: AxisStatus; min: string | null; max: string | null; confidence: number | null };
	stack: { status: AxisStatus; skillKeys: string[] };
}

const missingSchema = z.strictObject({
	role: z.array(z.looseObject({ code: z.string() })),
	grade: z.array(z.looseObject({ code: z.string() })),
	stack: z.array(z.looseObject({ code: z.string() }))
});

export type MissingByAxis = z.infer<typeof missingSchema>;

export interface CaseRun {
	id: string;
	origin: 'automatic' | 'manual_override';
	outcome: 'complete' | 'partial' | 'insufficient_data';
	status: (typeof categorizationRuns.$inferSelect)['status'];
	computedAt: Date;
	inputRevision: number;
	assignments: CaseAssignment[];
	missing: MissingByAxis;
}

/** What the operator sees of the candidate within the case: the `operator` projection, minus what the case does not need. */
export interface CaseCandidate {
	candidateId: string;
	isMinor: boolean;
	desiredRoleKeys: string[];
	skills: {
		skillKey: string;
		band: 'weak' | 'moderate' | 'strong';
		attestation: 'direct' | 'derived' | 'claimed';
		badgeTrust: 'fsp_verified' | 'platform_verified' | 'public_verifiable' | null;
	}[];
	fspLevels: { discipline: string; level: string }[];
	/** The current resume, readable by the operator within this case (`storage/access.ts`, context `case`). */
	resume: { fileId: string; declaredName: string; parseStatus: string } | null;
}

export interface DisputeCase {
	id: string;
	status: DisputeStatus;
	reason: string;
	openedAt: Date;
	dueAt: Date;
	overdue: boolean;
	dueSoon: boolean;
	assignee: { id: string; name: string | null } | null;
	mine: boolean;
	resolution: string | null;
	resolvedAt: Date | null;
	disputed: CaseRun;
	resulting: CaseRun | null;
	/** Present while the case is active: a closed case gives no access to the candidate's data. */
	candidate: CaseCandidate | null;
	/**
	 * The disputed run is no longer the published one (a new calculation replaced it): a manual decision is refused. A
	 * change of the grounds that has not been recalculated yet is found by `changeCategory` itself at the moment of the
	 * decision.
	 */
	stale: boolean;
	/** Roles, grades and skills of the disputed run's taxonomy version: the axes a manual decision may take. */
	vocabulary: Vocabulary;
}

const WARN_BEFORE_DUE_MS = 5 * 24 * 60 * 60 * 1000;

async function caseRun(executor: Executor, runId: string): Promise<CaseRun> {
	const [run] = await executor.select().from(categorizationRuns).where(eq(categorizationRuns.id, runId));
	if (!run) throw new Error(`run ${runId} of a dispute is missing`);
	const assignments = await executor
		.select()
		.from(categoryAssignments)
		.where(eq(categoryAssignments.runId, runId))
		.orderBy(categoryAssignments.rank);
	return {
		id: run.id,
		origin: run.origin,
		outcome: run.outcome,
		status: run.status,
		computedAt: run.computedAt,
		inputRevision: run.inputRevision,
		assignments: assignments.map((row) => ({
			rank: row.rank,
			role: { status: row.roleStatus, key: row.roleKey },
			grade: {
				status: row.gradeStatus,
				min: row.gradeMin,
				max: row.gradeMax,
				confidence: row.gradeConfidence === null ? null : Number(row.gradeConfidence)
			},
			stack: { status: row.stackStatus, skillKeys: row.stackSkillKeys }
		})),
		missing: missingSchema.parse(run.missing)
	};
}

/**
 * One objection. While it is active, the candidate's data is read in the `operator` projection of `canShow` with the
 * case as context, and the access is journaled; a resolved objection shows the answer and the runs only.
 */
export async function disputeCase(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	disputeId: string,
	now: Date
): Promise<DisputeCase> {
	requirePermission(subject, 'dispute.manage', null);
	const operatorId = sessionUserId(subject);
	if (!z.uuid().safeParse(disputeId).success) throw new ApiError('not_found');
	const [dispute] = await db.select().from(categoryDisputes).where(eq(categoryDisputes.id, disputeId));
	if (!dispute) throw new ApiError('not_found');
	const reach = await StaffReach.of(db, subject);
	reach.require(await sessionOfCandidate(db, dispute.candidateId));
	const disputed = await caseRun(db, dispute.runId);
	const resulting = dispute.resultingRunId ? await caseRun(db, dispute.resultingRunId) : null;
	const [assignee] = dispute.assigneeId
		? await db.select({ name: users.displayName }).from(users).where(eq(users.id, dispute.assigneeId))
		: [];
	const [runRow] = await db
		.select({ taxonomyVersionId: categorizationRuns.taxonomyVersionId })
		.from(categorizationRuns)
		.where(eq(categorizationRuns.id, dispute.runId));
	if (!runRow) throw new Error(`run ${dispute.runId} of a dispute is missing`);

	const active = ACTIVE.includes(dispute.status);
	let candidate: CaseCandidate | null = null;
	if (active) {
		const policy = await loadVisibilityPolicy(db, now);
		const facts = (await loadVisibilityFacts(db, [dispute.candidateId], { now, policy, viewerCompanyId: null })).get(
			dispute.candidateId
		);
		if (!facts) throw new Error(`candidate ${dispute.candidateId} of a dispute is missing`);
		const decision = canShow(
			{ ...facts, caseAccess: true },
			{ kind: 'staff', userId: operatorId, role: 'operator', demoSessionId: reach.session },
			{ kind: 'case', caseType: 'dispute', caseId: dispute.id }
		);
		if (!decision.allowed || decision.projection !== 'operator') throw new ApiError('not_found');
		candidate = await caseCandidate(db, dispute.candidateId, dispute.runId, now);
		await recordAuditEvent(db, {
			action: 'operator.case_access',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'category_dispute', id: dispute.id },
			subjectCandidateId: dispute.candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { case_type: 'dispute', case_id: dispute.id }
		});
	}
	return {
		id: dispute.id,
		status: dispute.status,
		reason: dispute.reason,
		openedAt: dispute.openedAt,
		dueAt: dispute.dueAt,
		overdue: active && dispute.dueAt.getTime() <= now.getTime(),
		dueSoon: active && dispute.dueAt.getTime() - now.getTime() <= WARN_BEFORE_DUE_MS,
		assignee: dispute.assigneeId ? { id: dispute.assigneeId, name: assignee?.name ?? null } : null,
		mine: dispute.assigneeId === operatorId,
		resolution: dispute.resolution,
		resolvedAt: dispute.resolvedAt,
		disputed,
		resulting,
		candidate,
		stale: disputed.status !== 'published',
		vocabulary: await vocabularyOf(db, runRow.taxonomyVersionId)
	};
}

async function caseCandidate(
	executor: Executor,
	candidateId: string,
	runId: string,
	now: Date
): Promise<CaseCandidate> {
	const [row] = await executor
		.select({
			desiredRoleKeys: candidates.desiredRoleKeys,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			birthStatus: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} is missing`);
	const skills = await executor
		.select({
			skillKey: skillInferences.skillKey,
			band: skillInferences.strengthBand,
			attestation: skillInferences.attestation,
			badgeTrust: skillInferences.badgeTrust
		})
		.from(skillInferences)
		.where(eq(skillInferences.runId, runId))
		.orderBy(desc(skillInferences.strength));
	const levels = await executor
		.select({ discipline: fspLevelAssignments.discipline, level: fspLevelAssignments.level })
		.from(fspLevelAssignments)
		.where(eq(fspLevelAssignments.runId, runId));
	const [resume] = await executor
		.select({
			fileId: resumeDocuments.fileId,
			declaredName: files.declaredName,
			parseStatus: resumeDocuments.parseStatus
		})
		.from(resumeDocuments)
		.innerJoin(files, eq(files.id, resumeDocuments.fileId))
		.where(and(eq(resumeDocuments.candidateId, candidateId), eq(resumeDocuments.isCurrent, true)));
	const band = ageBand({ birthDate: row.birthDate, precision: row.precision, status: row.birthStatus }, now);
	return {
		candidateId,
		isMinor: isMinorBand(band),
		desiredRoleKeys: row.desiredRoleKeys,
		skills: skills.map((skill) => ({
			skillKey: skill.skillKey,
			band: skill.band,
			attestation: skill.attestation,
			badgeTrust: skill.badgeTrust === 'claimed' ? null : skill.badgeTrust
		})),
		fspLevels: levels,
		resume: resume ?? null
	};
}

/** The demo session of a candidate. */
async function sessionOfCandidate(executor: Executor, candidateId: string): Promise<string | null> {
	const [row] = await executor
		.select({ session: candidates.demoSessionId })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} of a dispute is missing`);
	return row.session;
}

/** An objection outside the operator's reach is «not found», as one that does not exist. */
async function requireDisputeInReach(db: Database, subject: AccessSubject, disputeId: string): Promise<void> {
	if (!z.uuid().safeParse(disputeId).success) throw new ApiError('not_found');
	const [dispute] = await db
		.select({ candidateId: categoryDisputes.candidateId })
		.from(categoryDisputes)
		.where(eq(categoryDisputes.id, disputeId));
	if (!dispute) throw new ApiError('not_found');
	(await StaffReach.of(db, subject)).require(await sessionOfCandidate(db, dispute.candidateId));
}

/** The operator takes the objection into review as the one who answers it. */
export async function takeDispute(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	disputeId: string
): Promise<void> {
	requirePermission(subject, 'dispute.manage', null);
	await requireDisputeInReach(db, subject, disputeId);
	await assignDispute(db, { disputeId, operatorId: sessionUserId(subject), requestId: meta.requestId });
}

/** The answer of the responsible operator: keep the category, or replace it by a manual decision with its grounds. */
export type DisputeAnswer =
	{ kind: 'uphold'; resolution: string } | { kind: 'change'; resolution: string; axes: OverrideAxes };

export async function answerDispute(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	disputeId: string,
	answer: DisputeAnswer
): Promise<void> {
	requirePermission(subject, 'dispute.manage', null);
	await requireDisputeInReach(db, subject, disputeId);
	const operatorId = sessionUserId(subject);
	if (answer.kind === 'uphold') {
		await upholdCategory(db, { disputeId, operatorId, resolution: answer.resolution, requestId: meta.requestId });
	} else {
		await changeCategory(db, {
			disputeId,
			operatorId,
			resolution: answer.resolution,
			axes: answer.axes,
			requestId: meta.requestId
		});
	}
}
