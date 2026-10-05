// Hiring process after an accepted invitation (docs/domain.md, section 13.7): it lives apart from the invitation, whose
// status never carries stages. Each side reports stages and the outcome in its own append-only messages; a side never
// changes the other side's reports, a correction supersedes the side's own previous report.
import { asc, eq } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Executor, Transaction } from '$lib/server/db';
import { candidates, hiringProcesses, hiringReports, invitations } from '$lib/server/db/schema';
import { emitCompanyEvent } from '$lib/server/events/emit';
import { enqueueJob } from '$lib/server/jobs/queue';
import { auditActor, type InvitationDeps, type RequestMeta } from '$lib/server/invitations/deps';
import { invalid, refuse } from '$lib/server/invitations/errors';
import { companyRecipients } from '$lib/server/invitations/notifications';
import { notify } from '$lib/server/notifications/notify';
import { policyById, requiredPolicy } from '$lib/server/invitations/policies';
import {
	hiringState,
	OUTCOMES,
	reportsInForce,
	type HiringState,
	type Outcome,
	type Party,
	type ReportFacts,
	type Stage
} from './state';

const DAY = 86_400_000;

type ProcessRow = typeof hiringProcesses.$inferSelect;

/**
 * Opens the process of an invitation accepted for the first time, in the transaction of the acceptance, and schedules
 * the first outcome request at its due date. Returns the process id.
 */
export async function openHiringProcess(
	tx: Transaction,
	invitation: { id: string; companyId: string; candidateId: string },
	at: Date,
	createdBy: { kind: 'user'; id: string }
): Promise<string> {
	const policy = await requiredPolicy(tx, 'hiring_policy', at);
	const outcomeDueAt = new Date(at.getTime() + policy.params.outcome_due_days * DAY);
	const [process] = await tx
		.insert(hiringProcesses)
		.values({
			invitationId: invitation.id,
			companyId: invitation.companyId,
			candidateId: invitation.candidateId,
			openedAt: at,
			outcomeDueAt,
			policyId: policy.id
		})
		.returning({ id: hiringProcesses.id });
	if (!process) throw new Error('hiring process not inserted');
	await enqueueJob(
		tx,
		'hiring.outcome_request',
		{ process_id: process.id, reminder: 0 },
		{ inputVersion: `${process.id}:0`, createdBy, runAfter: outcomeDueAt }
	);
	return process.id;
}

export async function processReports(executor: Executor, processId: string): Promise<ReportFacts[]> {
	const rows = await executor
		.select()
		.from(hiringReports)
		.where(eq(hiringReports.processId, processId))
		.orderBy(asc(hiringReports.reportedAt), asc(hiringReports.id));
	return rows.map((row) => ({
		id: row.id,
		party: row.party,
		kind: row.kind,
		stage: row.stage,
		outcome: row.outcome,
		startDate: row.startDate,
		reasonCode: row.reasonCode,
		supersedesReportId: row.supersedesReportId,
		reportedAt: row.reportedAt
	}));
}

/** The side the subject speaks for in the process; a stranger learns nothing about the process. */
function sideOf(subject: AccessSubject, process: ProcessRow, party: Party): void {
	const own =
		party === 'candidate'
			? subject.candidate?.id === process.candidateId
			: subject.membership?.status === 'active' && subject.membership.companyId === process.companyId;
	if (!own) throw refuse('not_found', 'not_party');
}

export interface HiringReportInput {
	party: Party;
	kind: 'stage' | 'outcome';
	stage?: Stage;
	outcome?: Outcome;
	/** `YYYY-MM-DD`, with `hired` only. */
	startDate?: string;
	reasonCode?: string;
	/** A correction of the side's own report in force of the same kind. */
	supersedesReportId?: string;
}

export interface HiringReportResult {
	reportId: string;
	state: HiringState;
}

/** A side reports a stage or the outcome of the process. */
export async function reportHiring(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	processId: string,
	input: HiringReportInput
): Promise<HiringReportResult> {
	if (subject.userId === null) throw refuse('unauthenticated', 'unauthenticated');
	const userId = subject.userId;
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const [process] = await tx.select().from(hiringProcesses).where(eq(hiringProcesses.id, processId)).for('update');
		if (!process) throw refuse('not_found', 'no_process');
		sideOf(subject, process, input.party);
		// A suspended company no longer reports; the candidate always may; staff never sets outcomes (domain 13.7).
		const access = can(subject, 'hiring.report', { companyId: process.companyId, candidateId: process.candidateId });
		if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);
		const policy = await policyById(tx, 'hiring_policy', process.policyId);

		if (input.kind === 'stage') {
			if (input.stage === undefined || !policy.params.stages.includes(input.stage)) {
				throw invalid('stage', 'Этап не из справочника процесса');
			}
			if (input.outcome !== undefined || input.startDate !== undefined || input.reasonCode !== undefined) {
				throw invalid('kind', 'Сообщение об этапе не содержит исхода');
			}
		} else {
			if (input.outcome === undefined || !OUTCOMES.includes(input.outcome) || input.stage !== undefined) {
				throw invalid('outcome', 'Исход не из справочника');
			}
			if (input.startDate !== undefined) {
				if (input.outcome !== 'hired') throw invalid('start_date', 'Дата выхода — только при найме');
				if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || Number.isNaN(Date.parse(input.startDate))) {
					throw invalid('start_date', 'Дата в формате ГГГГ-ММ-ДД');
				}
			}
			if (input.reasonCode !== undefined && !policy.params.outcome_reason_codes.includes(input.reasonCode)) {
				throw invalid('reason_code', 'Причина не из справочника');
			}
		}

		const reports = await processReports(tx, process.id);
		const inForce = reportsInForce(reports).filter((r) => r.party === input.party && r.kind === input.kind);
		if (input.supersedesReportId !== undefined) {
			if (!inForce.some((r) => r.id === input.supersedesReportId)) {
				throw refuse('conflict', 'supersedes_not_in_force');
			}
		} else if (input.kind === 'outcome' && inForce.length > 0) {
			throw refuse('conflict', 'outcome_already_reported');
		} else if (input.kind === 'stage' && inForce.some((r) => r.stage === input.stage)) {
			throw refuse('conflict', 'stage_already_reported');
		}

		const before = hiringState(process, reports, policy.params, now);
		const [report] = await tx
			.insert(hiringReports)
			.values({
				processId: process.id,
				party: input.party,
				reportedByUserId: userId,
				kind: input.kind,
				stage: input.kind === 'stage' ? (input.stage ?? null) : null,
				outcome: input.kind === 'outcome' ? (input.outcome ?? null) : null,
				startDate: input.startDate ?? null,
				reasonCode: input.reasonCode ?? null,
				supersedesReportId: input.supersedesReportId ?? null,
				reportedAt: now
			})
			.returning();
		if (!report) throw new Error('hiring report not inserted');
		const state = hiringState(process, await processReports(tx, process.id), policy.params, now);

		if (state.outcome === 'diverged' && before.outcome !== 'diverged') {
			// Both sides see that the other one reported otherwise, without the other side's reasons.
			const [candidate] = await tx
				.select({ userId: candidates.userId })
				.from(candidates)
				.where(eq(candidates.id, process.candidateId));
			if (!candidate) throw new Error(`candidate of process ${process.id} does not exist`);
			const companyUsers = await companyRecipientsOfProcess(tx, process);
			for (const recipient of [candidate.userId, ...companyUsers]) {
				await notify(tx, {
					userId: recipient,
					type: 'hiring.reports_diverged',
					objectId: process.id,
					stage: `${report.id}:${recipient}`,
					payload: { process_id: process.id }
				});
			}
		}

		await emitCompanyEvent(tx, {
			companyId: process.companyId,
			type: 'hiring.reported',
			invitationId: process.invitationId,
			data: {
				invitation_id: process.invitationId,
				hiring_process_id: process.id,
				report_id: report.id,
				party: input.party,
				kind: input.kind,
				value: input.kind === 'stage' ? (input.stage ?? '') : (input.outcome ?? ''),
				start_date: input.startDate ?? null,
				outcome_state: state.outcome
			},
			occurredAt: now
		});
		await recordAuditEvent(tx, {
			action: 'hiring.reported',
			outcome: 'success',
			actor: auditActor(subject, meta, input.party),
			object: { type: 'hiring_process', id: process.id },
			subjectCandidateId: process.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: {
				party: input.party,
				kind: input.kind,
				value: input.kind === 'stage' ? (input.stage ?? null) : (input.outcome ?? null),
				corrects: input.supersedesReportId ?? null
			},
			occurredAt: now
		});
		return { reportId: report.id, state };
	});
}

/** The company side of a process: the member who sent the invitation, otherwise the owners. */
export async function companyRecipientsOfProcess(
	tx: Transaction,
	process: { invitationId: string; companyId: string }
): Promise<string[]> {
	const [invitation] = await tx
		.select({ sentByMemberId: invitations.sentByMemberId })
		.from(invitations)
		.where(eq(invitations.id, process.invitationId));
	if (!invitation) throw new Error(`invitation of a process ${process.invitationId} does not exist`);
	return companyRecipients(tx, { companyId: process.companyId, sentByMemberId: invitation.sentByMemberId });
}

/** A report as the viewing side sees it: the other side's reasons stay with that side. */
export interface ReportView {
	id: string;
	party: Party;
	kind: 'stage' | 'outcome';
	stage: Stage | null;
	outcome: Outcome | null;
	startDate: string | null;
	reasonCode: string | null;
	supersedesReportId: string | null;
	reportedAt: Date;
}

export interface HiringProcessView {
	id: string;
	invitationId: string;
	viewer: Party;
	openedAt: Date;
	outcomeDueAt: Date;
	stage: HiringState['stage'];
	outcome: HiringState['outcome'];
	overdue: boolean;
	result: HiringState['result'];
	confirmedAt: Date | null;
	/** «The other side reported otherwise»: shown to both sides of a diverged process. */
	otherSideDiffers: boolean;
	reports: ReportView[];
}

/** The process as one of its sides sees it; a stranger gets `404`. */
export async function getHiringProcess(
	deps: InvitationDeps,
	subject: AccessSubject,
	processId: string
): Promise<HiringProcessView> {
	const executor = deps.db;
	const [process] = await executor.select().from(hiringProcesses).where(eq(hiringProcesses.id, processId));
	if (!process) throw refuse('not_found', 'no_process');
	const access = can(subject, 'invitation.read', { companyId: process.companyId, candidateId: process.candidateId });
	if (!access.allowed) throw refuse('not_found', 'not_party');
	const viewer: Party = subject.candidate?.id === process.candidateId ? 'candidate' : 'company';
	const policy = await policyById(executor, 'hiring_policy', process.policyId);
	const reports = await processReports(executor, process.id);
	const state = hiringState(process, reports, policy.params, deps.now());
	return {
		id: process.id,
		invitationId: process.invitationId,
		viewer,
		openedAt: process.openedAt,
		outcomeDueAt: process.outcomeDueAt,
		stage: state.stage,
		outcome: state.outcome,
		overdue: state.overdue,
		result: state.result,
		confirmedAt: state.confirmedAt,
		otherSideDiffers: state.outcome === 'diverged',
		reports: reports.map((report) => ({
			...report,
			reasonCode: report.party === viewer ? report.reasonCode : null
		}))
	};
}
