// The operator of FSP reviews attempts of the test (docs/domain.md, 10.7, 12.5; contracts 5.5). The list shows first
// the attempts that ask for a person: a journal with pastes or departures from the page — a signal for a human, never a
// verdict — and a cluster waiting for the sandbox longer than 30 minutes; the whole list shows the latest ones. The case
// reads an attempt in full: the decision, the plan, every cluster with its instance whole (statement, key, hidden tests,
// mutants), the candidate's answers and runs, the scores with their detail, the Angoff estimates, the release and the
// signals. Each reading is written to the journal; an employer never gets here. A clone operator of a demo session
// reaches the attempts of its session only (domain 19.3).
import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { StaffReach } from '$lib/server/access/demo-actor';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database, Executor } from '$lib/server/db';
import { candidates, gradeDecisions, sourceFacts, testArtifacts, testAttempts, testItems } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import type { ItemInstance } from './contract/bank';
import { parseSignalLog, summarizeSignals, type SignalLog, type SignalSummary } from './signals';
import { testTitle } from './titles';

type AttemptRow = typeof testAttempts.$inferSelect;

/** A cluster the sandbox has not scored for this long is stuck, not waiting in the queue. */
export const STUCK_AFTER_MS = 30 * 60_000;
const LIST_LIMIT = 100;

export type ReviewFilter = 'attention' | 'all';

function requireReview(subject: AccessSubject): void {
	const access = can(subject, 'assessment.review', null);
	if (!access.allowed) throw new ApiError(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
}

export interface ReviewListItem {
	attemptId: string;
	title: string;
	specialization: string;
	grade: string;
	bankReleaseId: string;
	status: AttemptRow['status'];
	startedAt: Date;
	seeded: boolean;
	outcome: (typeof gradeDecisions.$inferSelect)['outcome'] | null;
	signals: SignalSummary;
	stuck: boolean;
	annulReason: AttemptRow['annulReason'];
}

/** A pasted fragment or a departure from the page in any entry of the journal. */
const signalled = sql`exists (
	select 1 from jsonb_array_elements(coalesce(${testAttempts.integritySignals} -> 'entries', '[]'::jsonb)) entry
	where coalesce((entry -> 'client' ->> 'pasteCount')::int, 0) > 0
		or coalesce((entry -> 'client' ->> 'blurCount')::int, 0) > 0
)`;

/** A cluster awaiting the sandbox since before `stuckBefore`. */
function stuckSince(stuckBefore: Date): SQL {
	return sql`exists (select 1 from ${testItems} where ${testItems.attemptId} = ${testAttempts.id}
		and ${testItems.status} = 'awaiting_sandbox' and ${testItems.answeredAt} < ${stuckBefore.toISOString()}::timestamptz)`;
}

function reviewConditions(reach: StaffReach, filter: ReviewFilter, stuckBefore: Date): SQL[] {
	const conditions: SQL[] = [reach.rows(candidates.demoSessionId)];
	if (filter === 'attention') {
		conditions.push(sql`((${testAttempts.status} <> 'annulled' and ${signalled}) or ${stuckSince(stuckBefore)})`);
	}
	return conditions;
}

/**
 * Attempts for the operator: `attention` — attempts not annulled whose journal has pastes or departures, and clusters
 * stuck without a sandbox result; `all` — the latest attempts, annulled ones too. Newest first, at most `LIST_LIMIT`.
 */
export async function attemptsForReview(
	executor: Executor,
	subject: AccessSubject,
	filter: ReviewFilter,
	now: Date
): Promise<ReviewListItem[]> {
	requireReview(subject);
	const reach = await StaffReach.of(executor, subject);
	const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);
	const rows = await executor
		.select({
			attempt: testAttempts,
			stuck: sql<boolean>`${stuckSince(stuckBefore)}`,
			outcome: gradeDecisions.outcome
		})
		.from(testAttempts)
		.innerJoin(candidates, eq(candidates.id, testAttempts.candidateId))
		.leftJoin(gradeDecisions, and(eq(gradeDecisions.attemptId, testAttempts.id), eq(gradeDecisions.status, 'valid')))
		.where(and(...reviewConditions(reach, filter, stuckBefore)))
		.orderBy(desc(testAttempts.startedAt), desc(testAttempts.id))
		.limit(LIST_LIMIT);
	return rows.map(({ attempt, stuck, outcome }) => ({
		attemptId: attempt.id,
		title: testTitle(attempt.specialization, attempt.grade),
		specialization: attempt.specialization,
		grade: attempt.grade,
		bankReleaseId: attempt.bankReleaseId,
		status: attempt.status,
		startedAt: attempt.startedAt,
		seeded: attempt.seeded,
		outcome,
		signals: summarizeSignals(parseSignalLog(attempt.integritySignals)),
		stuck,
		annulReason: attempt.annulReason
	}));
}

/** The whole `attention` queue of the operator: its size and, of it, the attempts stuck without a sandbox result. */
export async function attemptsForReviewCount(
	executor: Executor,
	subject: AccessSubject,
	now: Date
): Promise<{ attention: number; stuck: number }> {
	requireReview(subject);
	const reach = await StaffReach.of(executor, subject);
	const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);
	const [row] = await executor
		.select({ attention: count(), stuck: sql<number>`count(*) filter (where ${stuckSince(stuckBefore)})::int` })
		.from(testAttempts)
		.innerJoin(candidates, eq(candidates.id, testAttempts.candidateId))
		.where(and(...reviewConditions(reach, 'attention', stuckBefore)));
	if (!row) throw new Error('a count returned no row');
	return row;
}

export interface ReviewedItem {
	item: typeof testItems.$inferSelect;
	instance: ItemInstance;
	artifacts: (typeof testArtifacts.$inferSelect)[];
}

export interface AttemptForReview {
	attempt: AttemptRow;
	title: string;
	decisions: (typeof gradeDecisions.$inferSelect)[];
	items: ReviewedItem[];
	signals: SignalLog;
	facts: { id: string; status: (typeof sourceFacts.$inferSelect)['status']; statusReason: string | null }[];
	/** Some artifacts are past their retention period: their content is cleared, hashes and scores remain. */
	cleared: boolean;
}

export async function attemptForReview(
	database: Database,
	subject: AccessSubject,
	attemptId: string,
	requestId: string
): Promise<AttemptForReview> {
	requireReview(subject);
	if (subject.userId === null) throw new ApiError('unauthenticated');
	const userId = subject.userId;
	const reach = await StaffReach.of(database, subject);
	return database.transaction(async (tx) => {
		const [row] = await tx
			.select({ attempt: testAttempts, demoSessionId: candidates.demoSessionId })
			.from(testAttempts)
			.innerJoin(candidates, eq(candidates.id, testAttempts.candidateId))
			.where(eq(testAttempts.id, attemptId));
		if (!row) throw new ApiError('not_found');
		reach.require(row.demoSessionId);
		const { attempt } = row;
		const items = await tx
			.select()
			.from(testItems)
			.where(eq(testItems.attemptId, attempt.id))
			.orderBy(asc(testItems.seq));
		const artifacts = await tx
			.select()
			.from(testArtifacts)
			.where(eq(testArtifacts.attemptId, attempt.id))
			.orderBy(asc(testArtifacts.seq));
		const decisions = await tx
			.select()
			.from(gradeDecisions)
			.where(eq(gradeDecisions.attemptId, attempt.id))
			.orderBy(desc(gradeDecisions.decidedAt));
		const facts = await tx
			.select({ id: sourceFacts.id, status: sourceFacts.status, statusReason: sourceFacts.statusReason })
			.from(sourceFacts)
			.where(
				and(
					eq(sourceFacts.source, 'platform_test'),
					eq(sourceFacts.ownershipBasis, 'own_attempt'),
					eq(sourceFacts.ownershipRef, attempt.id)
				)
			)
			.orderBy(desc(sourceFacts.id));
		const journal = {
			outcome: 'success' as const,
			actor: { kind: 'user' as const, userId },
			object: { type: 'test_attempt', id: attempt.id },
			subjectCandidateId: attempt.candidateId,
			requestId
		};
		await recordAuditEvent(tx, {
			...journal,
			action: 'operator.case_access',
			details: { case_type: 'assessment', case_id: attempt.id }
		});
		await recordAuditEvent(tx, {
			...journal,
			action: 'assessment.artifact_viewed',
			details: { artifact_count: artifacts.length }
		});
		return {
			attempt,
			title: testTitle(attempt.specialization, attempt.grade),
			decisions,
			items: items.map((item) => ({
				item,
				instance: item.instance as ItemInstance,
				artifacts: artifacts.filter((a) => a.itemId === item.id)
			})),
			signals: parseSignalLog(attempt.integritySignals),
			facts,
			cleared: artifacts.some((artifact) => artifact.content === null)
		};
	});
}
