// Complaints of candidates about offers (docs/domain.md, section 13.14). The candidate the offer is addressed to
// complains once per offer — a reason from the list and their own account of what happened; an FSP operator decides:
// no consequence, a warning to the company, or its suspension with the reason `complaint`. The candidate sees the
// status and the operator's explanation; the company learns only of an upheld complaint, by its reason, never who
// complained or in what words. Upheld complaints count in the facts of trust in the company (section 5.6).
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { StaffReach } from '$lib/server/access/demo-actor';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { auditActorOf, requirePermission, sessionUserId, type ActionContext } from '$lib/server/companies/context';
import { companyTrust, type CompanyTrust } from '$lib/server/companies/trust';
import { suspendInTransaction } from '$lib/server/companies/verification';
import type { Database, Executor, Transaction } from '$lib/server/db';
import {
	COMPLAINT_DECISIONS,
	COMPLAINT_REASONS,
	candidates,
	companies,
	companyMembers,
	invitationComplaints,
	invitations,
	invitationTerms
} from '$lib/server/db/schema';
import { demoSessionOfUser, inDemoScope } from '$lib/server/demo/scope';
import { ApiError } from '$lib/server/errors/api-error';
import type { RequestMeta } from '$lib/server/invitations/deps';
import { invalid, refuse } from '$lib/server/invitations/errors';
import { candidateSide, lockInvitation, termsSalary } from '$lib/server/invitations/records';
import type { OfferedSalary } from '$lib/server/invitations/terms';
import { notify } from '$lib/server/notifications/notify';

export type ComplaintReason = (typeof COMPLAINT_REASONS)[number];
export type ComplaintDecision = (typeof COMPLAINT_DECISIONS)[number];
type ComplaintRow = typeof invitationComplaints.$inferSelect;

export const COMPLAINT_TEXT_MIN = 10;
export const COMPLAINT_TEXT_MAX = 2000;

const RECENT_DECIDED = 20;

export interface ComplaintDeps {
	db: Database;
	now: () => Date;
}

/** The complaint as the candidate who filed it sees it. */
export interface CandidateComplaint {
	id: string;
	reasonCode: ComplaintReason;
	text: string;
	status: ComplaintRow['status'];
	decision: ComplaintDecision | null;
	resolution: string | null;
	createdAt: Date;
	decidedAt: Date | null;
}

function candidateView(row: ComplaintRow): CandidateComplaint {
	return {
		id: row.id,
		reasonCode: row.reasonCode,
		text: row.text,
		status: row.status,
		decision: row.decision,
		resolution: row.resolution,
		createdAt: row.createdAt,
		decidedAt: row.decidedAt
	};
}

/** The offer of the candidate within their demo place, or `404` as one that does not exist. */
async function requireOwnOffer(executor: Executor, subject: AccessSubject, invitation: { companyId: string }) {
	const [company] = await executor
		.select({ demoSessionId: companies.demoSessionId, demoOriginal: companies.demoOriginal })
		.from(companies)
		.where(eq(companies.id, invitation.companyId));
	if (!company) throw new Error(`company ${invitation.companyId} does not exist`);
	if (!inDemoScope(company, await demoSessionOfUser(executor, subject.userId))) {
		throw refuse('not_found', 'not_in_demo_scope');
	}
}

function validText(value: string): string {
	const text = value.trim();
	if (text.length < COMPLAINT_TEXT_MIN || text.length > COMPLAINT_TEXT_MAX) {
		throw invalid('text', `Опишите, что произошло: от ${COMPLAINT_TEXT_MIN} до ${COMPLAINT_TEXT_MAX} символов`);
	}
	return text;
}

const reasonSchema = z.enum(COMPLAINT_REASONS);

/**
 * The candidate complains about the offer addressed to them — in any status, an accepted one included: what went
 * wrong often shows at the interview. One complaint per offer: a second is `409 complaint_exists`.
 */
export async function fileComplaint(
	deps: ComplaintDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	invitationId: string,
	input: { reasonCode: string; text: string }
): Promise<CandidateComplaint> {
	const side = candidateSide(subject);
	const reason = reasonSchema.safeParse(input.reasonCode);
	if (!reason.success) throw invalid('reason_code', 'Выберите причину из списка');
	const text = validText(input.text);
	return deps.db.transaction(async (tx) => {
		const invitation = await lockInvitation(tx, invitationId);
		if (!invitation || invitation.candidateId !== side.candidateId) throw refuse('not_found', 'not_addressee');
		await requireOwnOffer(tx, subject, invitation);
		const access = can(subject, 'complaint.create', { candidateId: invitation.candidateId });
		if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);
		if (invitation.currentTermsId === null) throw new Error(`invitation ${invitation.id} has no terms`);
		const [existing] = await tx
			.select({ id: invitationComplaints.id })
			.from(invitationComplaints)
			.where(
				and(
					eq(invitationComplaints.invitationId, invitation.id),
					eq(invitationComplaints.candidateId, side.candidateId)
				)
			);
		if (existing) {
			throw refuse('conflict', 'complaint_exists', [
				{ code: 'complaint_exists', message: 'Жалоба на это предложение уже подана' }
			]);
		}
		const [row] = await tx
			.insert(invitationComplaints)
			.values({
				invitationId: invitation.id,
				companyId: invitation.companyId,
				candidateId: side.candidateId,
				termsId: invitation.currentTermsId,
				reasonCode: reason.data,
				text,
				status: 'open'
			})
			.returning();
		if (!row) throw new Error('complaint not inserted');
		await recordAuditEvent(tx, {
			action: 'complaint.filed',
			outcome: 'success',
			actor: { kind: 'user', userId: side.userId },
			object: { type: 'invitation_complaint', id: row.id },
			subjectCandidateId: side.candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			details: { company_id: invitation.companyId, reason_code: reason.data }
		});
		return candidateView(row);
	});
}

/** The candidate's complaint about the offer, or `null` — none was filed. A stranger gets `404`. */
export async function complaintOfOffer(
	deps: ComplaintDeps,
	subject: AccessSubject,
	invitationId: string
): Promise<CandidateComplaint | null> {
	const side = candidateSide(subject);
	const [invitation] = await deps.db
		.select({ candidateId: invitations.candidateId, companyId: invitations.companyId, purgedAt: invitations.purgedAt })
		.from(invitations)
		.where(eq(invitations.id, invitationId));
	if (!invitation || invitation.purgedAt !== null || invitation.candidateId !== side.candidateId) {
		throw refuse('not_found', 'not_addressee');
	}
	await requireOwnOffer(deps.db, subject, invitation);
	const [row] = await deps.db
		.select()
		.from(invitationComplaints)
		.where(
			and(eq(invitationComplaints.invitationId, invitationId), eq(invitationComplaints.candidateId, side.candidateId))
		);
	return row ? candidateView(row) : null;
}

// --- Operator ---------------------------------------------------------------------------------------------------------

export interface ComplaintQueueItem {
	id: string;
	companyId: string;
	companyName: string;
	reasonCode: ComplaintReason;
	status: ComplaintRow['status'];
	decision: ComplaintDecision | null;
	createdAt: Date;
	decidedAt: Date | null;
}

/** Open complaints, oldest first, and the latest decided ones, within the operator's reach. */
export async function complaintQueue(
	executor: Executor,
	subject: AccessSubject
): Promise<{ open: ComplaintQueueItem[]; decided: ComplaintQueueItem[] }> {
	requirePermission(subject, 'complaint.review', null);
	sessionUserId(subject);
	const reach = (await StaffReach.of(executor, subject)).rows(companies.demoSessionId);
	const select = {
		id: invitationComplaints.id,
		companyId: invitationComplaints.companyId,
		companyName: companies.displayName,
		reasonCode: invitationComplaints.reasonCode,
		status: invitationComplaints.status,
		decision: invitationComplaints.decision,
		createdAt: invitationComplaints.createdAt,
		decidedAt: invitationComplaints.decidedAt
	};
	const open = await executor
		.select(select)
		.from(invitationComplaints)
		.innerJoin(companies, eq(companies.id, invitationComplaints.companyId))
		.where(and(eq(invitationComplaints.status, 'open'), reach))
		.orderBy(asc(invitationComplaints.createdAt), asc(invitationComplaints.id));
	const decided = await executor
		.select(select)
		.from(invitationComplaints)
		.innerJoin(companies, eq(companies.id, invitationComplaints.companyId))
		.where(and(eq(invitationComplaints.status, 'decided'), reach))
		.orderBy(desc(invitationComplaints.decidedAt), desc(invitationComplaints.id))
		.limit(RECENT_DECIDED);
	return { open, decided };
}

export interface ComplaintCase {
	id: string;
	reasonCode: ComplaintReason;
	text: string;
	status: ComplaintRow['status'];
	decision: ComplaintDecision | null;
	resolution: string | null;
	createdAt: Date;
	decidedAt: Date | null;
	company: {
		id: string;
		displayName: string;
		inn: string;
		status: (typeof companies.$inferSelect)['status'];
		/** The suspension of the company is still possible: the admission policy lets it act. */
		suspendable: boolean;
	};
	/** The offer as the candidate saw it: every version with its range, the one complained about marked. */
	offer: {
		invitationId: string;
		status: (typeof invitations.$inferSelect)['status'];
		versions: { id: string; version: number; title: string; salary: OfferedSalary; createdAt: Date }[];
		complainedTermsId: string;
	};
	/** Other complaints about the company: how many are open and how many were upheld. */
	companyComplaints: { open: number; upheld: number; dismissed: number };
	trust: CompanyTrust;
}

/** One complaint as the operator reviews it; every opening is `operator.case_access` in the journal. */
export async function complaintCase(
	deps: ComplaintDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	complaintId: string
): Promise<ComplaintCase> {
	requirePermission(subject, 'complaint.review', null);
	sessionUserId(subject);
	if (!z.uuid().safeParse(complaintId).success) throw new ApiError('not_found');
	const executor = deps.db;
	const [row] = await executor
		.select({ complaint: invitationComplaints, company: companies, invitationStatus: invitations.status })
		.from(invitationComplaints)
		.innerJoin(companies, eq(companies.id, invitationComplaints.companyId))
		.innerJoin(invitations, eq(invitations.id, invitationComplaints.invitationId))
		.where(eq(invitationComplaints.id, complaintId));
	if (!row) throw new ApiError('not_found');
	(await StaffReach.of(executor, subject)).require(row.company.demoSessionId);
	const { complaint, company } = row;
	const versions = await executor
		.select()
		.from(invitationTerms)
		.where(eq(invitationTerms.invitationId, complaint.invitationId))
		.orderBy(asc(invitationTerms.version));
	const others = await executor
		.select({ status: invitationComplaints.status, decision: invitationComplaints.decision, n: count() })
		.from(invitationComplaints)
		.where(eq(invitationComplaints.companyId, company.id))
		.groupBy(invitationComplaints.status, invitationComplaints.decision);
	const sum = (match: (o: { status: string; decision: string | null }) => boolean) =>
		others.filter(match).reduce((total, o) => total + o.n, 0);
	await recordAuditEvent(executor, {
		action: 'operator.case_access',
		outcome: 'success',
		actor: auditActorOf(subject),
		object: { type: 'invitation_complaint', id: complaint.id },
		subjectCandidateId: complaint.candidateId,
		requestId: meta.requestId,
		ip: meta.ip,
		userAgent: meta.userAgent,
		details: { case_type: 'complaint', case_id: complaint.id }
	});
	return {
		id: complaint.id,
		reasonCode: complaint.reasonCode,
		text: complaint.text,
		status: complaint.status,
		decision: complaint.decision,
		resolution: complaint.resolution,
		createdAt: complaint.createdAt,
		decidedAt: complaint.decidedAt,
		company: {
			id: company.id,
			displayName: company.displayName,
			inn: company.inn,
			status: company.status,
			suspendable: company.status === 'draft' || company.status === 'submitted' || company.status === 'verified'
		},
		offer: {
			invitationId: complaint.invitationId,
			status: row.invitationStatus,
			versions: versions.map((terms) => ({
				id: terms.id,
				version: terms.version,
				title: terms.title,
				salary: termsSalary(terms),
				createdAt: terms.createdAt
			})),
			complainedTermsId: complaint.termsId
		},
		companyComplaints: {
			open: sum((o) => o.status === 'open'),
			upheld: sum((o) => o.decision === 'warning' || o.decision === 'suspension'),
			dismissed: sum((o) => o.decision === 'no_action')
		},
		trust: await companyTrust(executor, company.id, deps.now())
	};
}

async function candidateUserId(tx: Transaction, candidateId: string): Promise<string> {
	const [row] = await tx.select({ userId: candidates.userId }).from(candidates).where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} does not exist`);
	return row.userId;
}

/** Active owners of the company: the warning and the suspension by a complaint reach them. */
async function ownerUsers(tx: Transaction, companyId: string): Promise<string[]> {
	const rows = await tx
		.select({ userId: companyMembers.userId })
		.from(companyMembers)
		.where(
			and(
				eq(companyMembers.companyId, companyId),
				eq(companyMembers.status, 'active'),
				eq(companyMembers.role, 'owner')
			)
		);
	return rows.flatMap((row) => (row.userId === null ? [] : [row.userId]));
}

/**
 * The operator decides an open complaint: `no_action`, `warning` or `suspension` with an explanation the candidate
 * reads. A suspension suspends the company in the same transaction with the reason `complaint`; a company already
 * closed by the admission policy cannot be suspended again (`409 not_admitted`) — the operator decides otherwise.
 */
export async function decideComplaint(
	deps: ComplaintDeps,
	ctx: ActionContext,
	complaintId: string,
	input: { decision: string; resolution: string }
): Promise<void> {
	requirePermission(ctx.subject, 'complaint.review', null);
	const operatorId = sessionUserId(ctx.subject);
	const decision = z.enum(COMPLAINT_DECISIONS).safeParse(input.decision);
	if (!decision.success) throw invalid('decision', 'Выберите решение');
	const resolution = input.resolution.trim();
	if (resolution.length < COMPLAINT_TEXT_MIN || resolution.length > COMPLAINT_TEXT_MAX) {
		throw invalid(
			'resolution',
			`Объяснение для кандидата — от ${COMPLAINT_TEXT_MIN} до ${COMPLAINT_TEXT_MAX} символов`
		);
	}
	if (!z.uuid().safeParse(complaintId).success) throw new ApiError('not_found');
	await deps.db.transaction(async (tx) => {
		const now = deps.now();
		const [complaint] = await tx
			.select()
			.from(invitationComplaints)
			.where(eq(invitationComplaints.id, complaintId))
			.for('update');
		if (!complaint) throw new ApiError('not_found');
		const [company] = await tx
			.select({ demoSessionId: companies.demoSessionId })
			.from(companies)
			.where(eq(companies.id, complaint.companyId));
		if (!company) throw new Error(`company ${complaint.companyId} does not exist`);
		(await StaffReach.of(tx, ctx.subject)).require(company.demoSessionId);
		if (complaint.status !== 'open') {
			throw refuse('conflict', 'already_decided', [{ code: 'already_decided', message: 'Жалоба уже рассмотрена' }]);
		}
		if (decision.data === 'suspension') {
			await suspendInTransaction(
				tx,
				ctx,
				complaint.companyId,
				{ reasonCode: 'complaint', complaintId: complaint.id },
				now
			);
		}
		await tx
			.update(invitationComplaints)
			.set({ status: 'decided', decision: decision.data, resolution, decidedBy: operatorId, decidedAt: now })
			.where(eq(invitationComplaints.id, complaint.id));
		await recordAuditEvent(tx, {
			action: 'complaint.decided',
			outcome: 'success',
			actor: auditActorOf(ctx.subject),
			object: { type: 'invitation_complaint', id: complaint.id },
			subjectCandidateId: complaint.candidateId,
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			details: { company_id: complaint.companyId, decision: decision.data }
		});
		await notify(tx, {
			userId: await candidateUserId(tx, complaint.candidateId),
			type: 'complaint.decided',
			objectId: complaint.id,
			payload: { complaint_id: complaint.id, decision: decision.data }
		});
		if (decision.data !== 'no_action') {
			for (const userId of await ownerUsers(tx, complaint.companyId)) {
				await notify(tx, {
					userId,
					type: 'company.complaint_upheld',
					objectId: complaint.companyId,
					stage: `${complaint.id}:${userId}`,
					payload: { decision: decision.data, reason_code: complaint.reasonCode }
				});
			}
		}
	});
}
