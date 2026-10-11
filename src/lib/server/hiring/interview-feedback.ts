// The employer's feedback after the interview (docs/domain.md, section 13.7): how the level the candidate showed compares
// with the grade the test confirmed. It is an outside criterion of the test's validity, read by the operator by category
// and bank release; a recalibration of the thresholds is the operator's process, nothing here changes a category, a
// grade or an order of candidates. The company that holds the accepted offer leaves it once, may correct it for a short
// while, and the candidate sees it in full: it is data about them (152-FZ, art. 14). Other companies never see it.
import { and, desc, eq, isNull, lte, or, gt, sql } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import {
	blockDefinition,
	CATALOG,
	gradeOrdinal,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Executor } from '$lib/server/db';
import {
	candidateCategories,
	candidates,
	hiringProcesses,
	INTERVIEW_COMMENT_MAX,
	INTERVIEW_FEEDBACK_OUTCOMES,
	INTERVIEW_LEVELS,
	interviewFeedback,
	invitations,
	invitationTerms
} from '$lib/server/db/schema';
import { companySession, outsideDemoSessions } from '$lib/server/demo/scope';
import { auditActor, type InvitationDeps, type RequestMeta } from '$lib/server/invitations/deps';
import { invalid, refuse } from '$lib/server/invitations/errors';
import { smallCell, type SmallCell } from '$lib/server/operator/small-numbers';

export type InterviewLevel = (typeof INTERVIEW_LEVELS)[number];
export type InterviewFeedbackOutcome = (typeof INTERVIEW_FEEDBACK_OUTCOMES)[number];

/** How long after leaving it the company may still correct its feedback. */
export const INTERVIEW_FEEDBACK_EDIT_HOURS = 24;
const HOUR = 3_600_000;

export interface InterviewFeedbackInput {
	level: InterviewLevel;
	/** `{block code: level}` over the blocks of the category; empty — the whole only. */
	blockLevels: Record<string, InterviewLevel>;
	outcome: InterviewFeedbackOutcome;
	/** Short, without personal data; `null` — none. */
	comment: string | null;
}

export interface InterviewFeedbackView extends InterviewFeedbackInput {
	id: string;
	specialization: SpecializationKey;
	grade: GradeKey;
	bankReleaseId: string;
	createdAt: Date;
	updatedAt: Date;
	/** Until when the company may correct it; `null` — the window is closed. */
	editableUntil: Date | null;
}

/** The blocks of a category the company may judge one by one, with their titles. */
export interface FeedbackBlock {
	code: string;
	title: string;
}

/** What the company side of an accepted offer needs for the form: the grade at the offer and the feedback, if left. */
export interface CompanyInterviewFeedback {
	/** `null` — the accepted terms carried no confirmed category: there is no grade to compare with. */
	category: { specialization: SpecializationKey; grade: GradeKey; blocks: FeedbackBlock[] } | null;
	feedback: InterviewFeedbackView | null;
}

type ProcessRow = typeof hiringProcesses.$inferSelect;
type FeedbackRow = typeof interviewFeedback.$inferSelect;

const isLevel = (value: unknown): value is InterviewLevel =>
	typeof value === 'string' && (INTERVIEW_LEVELS as readonly string[]).includes(value);

/** The title of a block in the catalog in force; a block a newer catalog dropped keeps its code. */
function blockTitle(code: string): string {
	return CATALOG.blocks.some((block) => block.code === code) ? blockDefinition(code).title : code;
}

function blockLevelsOf(row: FeedbackRow): Record<string, InterviewLevel> {
	const stored = row.blockLevels as Record<string, unknown>;
	const levels: Record<string, InterviewLevel> = {};
	for (const [code, level] of Object.entries(stored)) {
		if (!isLevel(level)) throw new Error(`interview feedback ${row.id} holds an unknown level of ${code}`);
		levels[code] = level;
	}
	return levels;
}

function viewOf(row: FeedbackRow, now: Date): InterviewFeedbackView {
	const until = new Date(row.createdAt.getTime() + INTERVIEW_FEEDBACK_EDIT_HOURS * HOUR);
	return {
		id: row.id,
		level: row.level,
		blockLevels: blockLevelsOf(row),
		outcome: row.outcome,
		comment: row.comment,
		specialization: row.specialization,
		grade: row.grade,
		bankReleaseId: row.bankReleaseId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		editableUntil: now < until ? until : null
	};
}

/**
 * The category the accepted terms recorded (domain 13.5) as the row that was in force when the terms were sent: its bank
 * release is the one the feedback calibrates. `null` — the terms carried no confirmed category.
 */
async function categoryOfTerms(executor: Executor, process: ProcessRow) {
	const [terms] = await executor
		.select({ id: invitationTerms.id, category: invitationTerms.category, createdAt: invitationTerms.createdAt })
		.from(invitations)
		.innerJoin(invitationTerms, eq(invitationTerms.id, invitations.acceptedTermsId))
		.where(and(eq(invitations.id, process.invitationId), isNull(invitations.purgedAt)));
	if (!terms) throw new Error(`hiring process ${process.id} has no accepted terms`);
	const snapshot = terms.category as { specialization: string; grade: string } | null;
	if (snapshot === null) return { termsId: terms.id, category: null };
	const [category] = await executor
		.select()
		.from(candidateCategories)
		.where(
			and(
				eq(candidateCategories.candidateId, process.candidateId),
				sql`${candidateCategories.specialization} = ${snapshot.specialization}`,
				sql`${candidateCategories.grade} = ${snapshot.grade}`,
				lte(candidateCategories.assignedAt, terms.createdAt),
				or(isNull(candidateCategories.endedAt), gt(candidateCategories.endedAt, terms.createdAt))
			)
		)
		.orderBy(desc(candidateCategories.assignedAt))
		.limit(1);
	if (!category) throw new Error(`the category of the terms ${terms.id} was not in force when they were sent`);
	return { termsId: terms.id, category };
}

/** The company side of the process, which may report on it; anyone else learns nothing about it. */
function requireCompanySide(subject: AccessSubject, process: ProcessRow): string {
	const membership = subject.membership;
	if (membership?.status !== 'active' || membership.companyId !== process.companyId) {
		throw refuse('not_found', 'not_party');
	}
	const access = can(subject, 'hiring.report', { companyId: process.companyId, candidateId: process.candidateId });
	if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);
	return membership.memberId;
}

/** The input checked against the blocks of the category; free text is trimmed and bounded. */
function checkedInput(input: InterviewFeedbackInput, blocks: readonly string[]): InterviewFeedbackInput {
	if (!isLevel(input.level)) throw invalid('level', 'Уровень — ниже, соответствует или выше');
	if (!(INTERVIEW_FEEDBACK_OUTCOMES as readonly string[]).includes(input.outcome)) {
		throw invalid('outcome', 'Исход не из справочника');
	}
	for (const [code, level] of Object.entries(input.blockLevels)) {
		if (!blocks.includes(code)) throw invalid('block_levels', 'Блок не из подтверждённой категории');
		if (!isLevel(level)) throw invalid('block_levels', 'Уровень блока — ниже, соответствует или выше');
	}
	const comment = input.comment?.trim() ?? '';
	if (comment.length > INTERVIEW_COMMENT_MAX) {
		throw invalid('comment', `Комментарий — не длиннее ${INTERVIEW_COMMENT_MAX} символов`);
	}
	return { ...input, comment: comment === '' ? null : comment };
}

async function lockedProcess(executor: Executor, processId: string): Promise<ProcessRow> {
	const [process] = await executor
		.select()
		.from(hiringProcesses)
		.where(eq(hiringProcesses.id, processId))
		.for('update');
	if (!process) throw refuse('not_found', 'no_process');
	return process;
}

/** The company leaves its feedback on the interview of an accepted offer, once per process. */
export async function leaveInterviewFeedback(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	processId: string,
	input: InterviewFeedbackInput
): Promise<InterviewFeedbackView> {
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const process = await lockedProcess(tx, processId);
		const memberId = requireCompanySide(subject, process);
		const { termsId, category } = await categoryOfTerms(tx, process);
		if (category === null) throw refuse('conflict', 'no_confirmed_grade');
		const [existing] = await tx
			.select({ id: interviewFeedback.id })
			.from(interviewFeedback)
			.where(eq(interviewFeedback.processId, process.id));
		if (existing) throw refuse('conflict', 'feedback_already_left');
		const checked = checkedInput(input, category.confirmedBlocks);
		const [row] = await tx
			.insert(interviewFeedback)
			.values({
				processId: process.id,
				companyId: process.companyId,
				candidateId: process.candidateId,
				termsId,
				categoryId: category.id,
				specialization: category.specialization,
				grade: category.grade,
				bankReleaseId: category.bankReleaseId,
				level: checked.level,
				blockLevels: checked.blockLevels,
				outcome: checked.outcome,
				comment: checked.comment,
				createdByMemberId: memberId,
				createdAt: now,
				updatedAt: now
			})
			.returning();
		if (!row) throw new Error('interview feedback not inserted');
		await journal(tx, subject, meta, process, row, 'hiring.interview_feedback_left', now);
		return viewOf(row, now);
	});
}

/** The company corrects its feedback within `INTERVIEW_FEEDBACK_EDIT_HOURS` of leaving it. */
export async function reviseInterviewFeedback(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	processId: string,
	input: InterviewFeedbackInput
): Promise<InterviewFeedbackView> {
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const process = await lockedProcess(tx, processId);
		requireCompanySide(subject, process);
		const [existing] = await tx.select().from(interviewFeedback).where(eq(interviewFeedback.processId, process.id));
		if (!existing) throw refuse('not_found', 'no_feedback');
		if (viewOf(existing, now).editableUntil === null) throw refuse('conflict', 'edit_window_closed');
		const [category] = await tx
			.select({ confirmedBlocks: candidateCategories.confirmedBlocks })
			.from(candidateCategories)
			.where(eq(candidateCategories.id, existing.categoryId));
		if (!category) throw new Error(`the category of interview feedback ${existing.id} disappeared`);
		const checked = checkedInput(input, category.confirmedBlocks);
		const [row] = await tx
			.update(interviewFeedback)
			.set({
				level: checked.level,
				blockLevels: checked.blockLevels,
				outcome: checked.outcome,
				comment: checked.comment,
				updatedAt: now
			})
			.where(eq(interviewFeedback.id, existing.id))
			.returning();
		if (!row) throw new Error('interview feedback not updated');
		await journal(tx, subject, meta, process, row, 'hiring.interview_feedback_revised', now);
		return viewOf(row, now);
	});
}

async function journal(
	executor: Executor,
	subject: AccessSubject,
	meta: RequestMeta,
	process: ProcessRow,
	row: FeedbackRow,
	action: 'hiring.interview_feedback_left' | 'hiring.interview_feedback_revised',
	now: Date
): Promise<void> {
	// Codes only: the comment is free text and stays out of the journal (domain 18.1).
	await recordAuditEvent(executor, {
		action,
		outcome: 'success',
		actor: auditActor(subject, meta, 'company'),
		object: { type: 'hiring_process', id: process.id },
		subjectCandidateId: process.candidateId,
		requestId: meta.requestId,
		ip: meta.ip ?? null,
		userAgent: meta.userAgent ?? null,
		details: {
			level: row.level,
			outcome: row.outcome,
			bank_release_id: row.bankReleaseId,
			blocks: Object.keys(row.blockLevels as Record<string, unknown>).length,
			with_comment: row.comment !== null
		},
		occurredAt: now
	});
}

/** The company side of a process: the grade at the offer with its blocks, and the feedback the company left. */
export async function companyInterviewFeedback(
	deps: InvitationDeps,
	subject: AccessSubject,
	processId: string
): Promise<CompanyInterviewFeedback> {
	const executor = deps.db;
	const [process] = await executor.select().from(hiringProcesses).where(eq(hiringProcesses.id, processId));
	if (!process) throw refuse('not_found', 'no_process');
	const membership = subject.membership;
	if (membership?.status !== 'active' || membership.companyId !== process.companyId) {
		throw refuse('not_found', 'not_party');
	}
	const [row] = await executor.select().from(interviewFeedback).where(eq(interviewFeedback.processId, process.id));
	const { category } = await categoryOfTerms(executor, process);
	return {
		category:
			category === null
				? null
				: {
						specialization: category.specialization,
						grade: category.grade,
						blocks: category.confirmedBlocks.map((code) => ({ code, title: blockTitle(code) }))
					},
		feedback: row ? viewOf(row, deps.now()) : null
	};
}

/** What the candidate sees of the feedback about them: all of it, with the block titles. */
export interface CandidateInterviewFeedback extends InterviewFeedbackView {
	blocks: (FeedbackBlock & { level: InterviewLevel })[];
}

/** The feedback of the company on the candidate's interview; `null` — none left. Only the candidate of the process. */
export async function candidateInterviewFeedback(
	deps: InvitationDeps,
	subject: AccessSubject,
	processId: string
): Promise<CandidateInterviewFeedback | null> {
	const executor = deps.db;
	const [process] = await executor.select().from(hiringProcesses).where(eq(hiringProcesses.id, processId));
	if (!process || subject.candidate?.id !== process.candidateId) throw refuse('not_found', 'not_party');
	const [row] = await executor.select().from(interviewFeedback).where(eq(interviewFeedback.processId, process.id));
	if (!row) return null;
	const view = viewOf(row, deps.now());
	return {
		...view,
		// The candidate does not correct it: the window is the company's.
		editableUntil: null,
		blocks: Object.entries(view.blockLevels).map(([code, level]) => ({ code, title: blockTitle(code), level }))
	};
}

// --- The operator's calibration ------------------------------------------------------------------------------------

export interface CalibrationLevels {
	total: SmallCell;
	below: SmallCell;
	matches: SmallCell;
	above: SmallCell;
	/** `matches / total`; only when the total is not suppressed, otherwise it would give the counts back. */
	agreement: number | null;
}

export interface CalibrationRow extends CalibrationLevels {
	specialization: SpecializationKey;
	grade: GradeKey;
	bankReleaseId: string;
	/** Blocks the companies judged one by one; a block of fewer judgements than the threshold shows «< N». */
	blocks: ({ code: string; title: string } & Omit<CalibrationLevels, 'agreement'>)[];
}

export interface InterviewCalibration {
	threshold: number;
	total: SmallCell;
	/** Some of the feedback is about seeded demo candidates. */
	synthetic: boolean;
	rows: CalibrationRow[];
}

interface Counts {
	total: number;
	below: number;
	matches: number;
	above: number;
}

const emptyCounts = (): Counts => ({ total: 0, below: 0, matches: 0, above: 0 });

function add(counts: Counts, level: InterviewLevel): void {
	counts.total += 1;
	counts[level] += 1;
}

/**
 * Agreement of the confirmed grade with the interviews, by category and bank release, for the operator (domain 13.9):
 * counts below the threshold of `catalog_policy` are «< N». Feedback of companies of demo sessions is left out.
 */
export async function interviewCalibration(
	executor: Executor,
	subject: AccessSubject,
	threshold: number
): Promise<InterviewCalibration> {
	const access = can(subject, 'fsp_analytics.read', null);
	if (!access.allowed) {
		throw refuse(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden', 'not_operator');
	}
	const rows = await executor
		.select({
			specialization: interviewFeedback.specialization,
			grade: interviewFeedback.grade,
			bankReleaseId: interviewFeedback.bankReleaseId,
			level: interviewFeedback.level,
			blockLevels: interviewFeedback.blockLevels,
			seeded: sql<boolean>`${candidates.seedBatchId} is not null`
		})
		.from(interviewFeedback)
		.innerJoin(candidates, eq(candidates.id, interviewFeedback.candidateId))
		.where(outsideDemoSessions(companySession(interviewFeedback.companyId)));

	const groups = new Map<
		string,
		{ key: Omit<CalibrationRow, keyof CalibrationLevels | 'blocks'>; counts: Counts; blocks: Map<string, Counts> }
	>();
	const all = emptyCounts();
	for (const row of rows) {
		const id = `${row.specialization}|${row.grade}|${row.bankReleaseId}`;
		const group = groups.get(id) ?? {
			key: { specialization: row.specialization, grade: row.grade, bankReleaseId: row.bankReleaseId },
			counts: emptyCounts(),
			blocks: new Map<string, Counts>()
		};
		groups.set(id, group);
		add(group.counts, row.level);
		add(all, row.level);
		for (const [code, level] of Object.entries(row.blockLevels as Record<string, unknown>)) {
			if (!isLevel(level)) throw new Error(`interview feedback holds an unknown level of block ${code}`);
			const block = group.blocks.get(code) ?? emptyCounts();
			group.blocks.set(code, block);
			add(block, level);
		}
	}
	const cell = (value: number) => smallCell(value, threshold);
	const cells = (counts: Counts) => ({
		total: cell(counts.total),
		below: cell(counts.below),
		matches: cell(counts.matches),
		above: cell(counts.above)
	});
	return {
		threshold,
		total: cell(all.total),
		synthetic: rows.some((row) => row.seeded),
		rows: [...groups.values()]
			.sort(
				(a, b) =>
					a.key.specialization.localeCompare(b.key.specialization) ||
					gradeOrdinal(a.key.grade) - gradeOrdinal(b.key.grade) ||
					a.key.bankReleaseId.localeCompare(b.key.bankReleaseId)
			)
			.map(({ key, counts, blocks }) => ({
				...key,
				...cells(counts),
				agreement: counts.total >= threshold ? counts.matches / counts.total : null,
				blocks: [...blocks.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([code, block]) => ({ code, title: blockTitle(code), ...cells(block) }))
			}))
	};
}
