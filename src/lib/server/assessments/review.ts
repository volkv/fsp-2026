// The operator of FSP reviews platform attempts (docs/domain.md, 10.2–10.4 and 18.2). The list shows the attempts
// that ask for a person first: those whose journal has pastes or departures from the page — a signal for a human,
// never a verdict — and those stuck in `submitted` after a failure of the sandbox; the whole list shows the latest
// ones. The case reads an attempt in full: the version, the code or the answers, every test with its data, the
// scores and the facts they became, and the signals. Each reading is written to the journal; an employer never gets
// here. A clone operator of a demo session reaches the attempts of its session only (domain 19.3).
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { StaffReach } from '$lib/server/access/demo-actor';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Database, Executor } from '$lib/server/db';
import {
	assessmentArtifacts,
	assessmentAttempts,
	assessments,
	assessmentScores,
	assessmentVersions,
	candidates,
	sourceFacts
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { quizStepSchema } from './quiz';
import { parseSignalLog, type SignalLog } from './signals';
import { loadVersion, type LoadedVersion } from './versions';

type AttemptRow = typeof assessmentAttempts.$inferSelect;
type ArtifactRow = typeof assessmentArtifacts.$inferSelect;
type ScoreRow = typeof assessmentScores.$inferSelect;

/** Statuses an operator reviews: the attempt was sent, whatever became of it. */
const REVIEWED: AttemptRow['status'][] = ['submitted', 'scored', 'annulled'];
/** A submission the sandbox has not judged for this long is stuck, not waiting in the queue. */
const STUCK_AFTER_MS = 30 * 60_000;
const LIST_LIMIT = 100;

export type ReviewFilter = 'attention' | 'all';

function requireReview(subject: AccessSubject): void {
	const access = can(subject, 'assessment.review', null);
	if (!access.allowed) throw new ApiError(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
}

/** Totals of the signal journal an operator looks at first. */
export interface SignalSummary {
	pastes: number;
	pastedChars: number;
	departures: number;
	/** Entries whose page sent no signals (scripts off or an old page). */
	silent: number;
}

export function summarizeSignals(log: SignalLog): SignalSummary {
	const summary: SignalSummary = { pastes: 0, pastedChars: 0, departures: 0, silent: 0 };
	for (const entry of log.entries) {
		if (entry.client === null) {
			summary.silent++;
			continue;
		}
		summary.pastes += entry.client.pasteCount;
		summary.pastedChars += entry.client.pastedChars;
		summary.departures += entry.client.blurCount;
	}
	return summary;
}

/** The score in force: the last of the chain of `supersedes`. */
function currentScore(scores: readonly ScoreRow[]): ScoreRow | null {
	const superseded = new Set(
		scores.flatMap((score) => (score.supersedesScoreId === null ? [] : [score.supersedesScoreId]))
	);
	return scores.find((score) => !superseded.has(score.id)) ?? null;
}

export interface ReviewListItem {
	attemptId: string;
	title: string;
	kind: 'code_task' | 'quiz' | 'open_answer';
	version: number;
	status: AttemptRow['status'];
	submittedAt: Date | null;
	/** Level of the score in force; `null` — not scored. */
	level: string | null;
	signals: SignalSummary;
	/** `submitted` without a result for longer than `STUCK_AFTER_MS`. */
	stuck: boolean;
	annulReason: AttemptRow['annulReason'];
}

/** A pasted fragment or a departure from the page in any entry of the journal. */
const signalled = sql`exists (
	select 1 from jsonb_array_elements(coalesce(${assessmentAttempts.integritySignals} -> 'entries', '[]'::jsonb)) entry
	where coalesce((entry -> 'client' ->> 'pasteCount')::int, 0) > 0
		or coalesce((entry -> 'client' ->> 'blurCount')::int, 0) > 0
)`;

/** A submission the sandbox has not judged since `stuckBefore`. */
function stuckSince(stuckBefore: Date): SQL {
	return sql`(${assessmentAttempts.status} = 'submitted' and ${assessmentAttempts.submittedAt} < ${stuckBefore.toISOString()}::timestamptz)`;
}

/** The attempts of a filter within the operator's reach, over `assessment_attempts` joined with `candidates`. */
function reviewConditions(reach: StaffReach, filter: ReviewFilter, stuckBefore: Date): SQL[] {
	const conditions: SQL[] = [inArray(assessmentAttempts.status, REVIEWED), reach.rows(candidates.demoSessionId)];
	if (filter === 'attention') {
		conditions.push(
			sql`((${assessmentAttempts.status} in ('submitted', 'scored') and ${signalled}) or ${stuckSince(stuckBefore)})`
		);
	}
	return conditions;
}

/**
 * Attempts for the operator: `attention` — sent attempts not annulled whose journal has pastes or departures, and
 * submissions stuck without a result; `all` — the latest sent attempts, annulled ones too. Newest first, the latest
 * `LIST_LIMIT` of them; `attemptsForReviewCount` counts the whole queue.
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
	const conditions = reviewConditions(reach, filter, stuckBefore);
	const rows = await executor
		.select({
			attempt: assessmentAttempts,
			title: assessments.title,
			kind: assessments.kind,
			version: assessmentVersions.version
		})
		.from(assessmentAttempts)
		.innerJoin(candidates, eq(candidates.id, assessmentAttempts.candidateId))
		.innerJoin(assessmentVersions, eq(assessmentVersions.id, assessmentAttempts.versionId))
		.innerJoin(assessments, eq(assessments.id, assessmentVersions.assessmentId))
		.where(and(...conditions))
		.orderBy(desc(assessmentAttempts.submittedAt), desc(assessmentAttempts.id))
		.limit(LIST_LIMIT);
	const attemptIds = rows.map((row) => row.attempt.id);
	const scores =
		attemptIds.length === 0
			? []
			: await executor
					.select()
					.from(assessmentScores)
					.where(inArray(assessmentScores.attemptId, attemptIds))
					.orderBy(desc(assessmentScores.createdAt), desc(assessmentScores.id));
	return rows.map(({ attempt, title, kind, version }) => ({
		attemptId: attempt.id,
		title,
		kind,
		version,
		status: attempt.status,
		submittedAt: attempt.submittedAt,
		level: currentScore(scores.filter((score) => score.attemptId === attempt.id))?.level ?? null,
		signals: summarizeSignals(parseSignalLog(attempt.integritySignals)),
		stuck: attempt.status === 'submitted' && attempt.submittedAt !== null && attempt.submittedAt < stuckBefore,
		annulReason: attempt.annulReason
	}));
}

/** The whole `attention` queue of the operator: its size and, of it, the submissions stuck without a result. */
export async function attemptsForReviewCount(
	executor: Executor,
	subject: AccessSubject,
	now: Date
): Promise<{ attention: number; stuck: number }> {
	requireReview(subject);
	const reach = await StaffReach.of(executor, subject);
	const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);
	const [row] = await executor
		.select({
			attention: count(),
			stuck: sql<number>`count(*) filter (where ${stuckSince(stuckBefore)})::int`
		})
		.from(assessmentAttempts)
		.innerJoin(candidates, eq(candidates.id, assessmentAttempts.candidateId))
		.where(and(...reviewConditions(reach, 'attention', stuckBefore)));
	if (!row) throw new Error('a count returned no row');
	return row;
}

export interface ReviewedTest {
	id: string;
	hidden: boolean;
	verdict: string;
	skipped: boolean;
	cpuTimeMs: number;
	wallTimeMs: number;
	memoryKb: number;
	exitCode: number | null;
	/** The data of the test from the version, hidden tests included. */
	stdin: string | null;
	expected: string | null;
	/** Only open tests keep the start of the program output; a hidden one keeps its hash. */
	stdoutPreview: string | null;
	stdoutSha256: string | null;
}

export interface ReviewedCode {
	submission: { language: string; source: string; sourceSha256: string | null } | null;
	compile: { status: string; stderr: string } | null;
	tests: ReviewedTest[];
}

export interface ReviewedQuizStep {
	itemId: string;
	itemVersion: number;
	prompt: string;
	code: string | null;
	options: { id: string; text: string }[];
	answer: string;
	correct: boolean;
	correctOption: string;
	ability: number;
	standardError: number;
}

export interface ReviewedFact {
	id: string;
	status: (typeof sourceFacts.$inferSelect)['status'];
	statusReason: string | null;
	scoreId: string | null;
}

export interface AttemptForReview {
	attempt: AttemptRow;
	version: LoadedVersion;
	artifacts: ArtifactRow[];
	signals: SignalLog;
	/** Every score of the attempt, newest first; `current` is the one in force. */
	scores: ScoreRow[];
	current: ScoreRow | null;
	/** The facts of the profile the scores of the attempt became. */
	facts: ReviewedFact[];
	code: ReviewedCode | null;
	quiz: ReviewedQuizStep[] | null;
	/** Some artifacts are past their retention period: their content is cleared, hashes and scores remain. */
	cleared: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const number = (value: unknown): number => (typeof value === 'number' ? value : 0);

function codeOf(artifacts: readonly ArtifactRow[], version: LoadedVersion): ReviewedCode | null {
	if (version.kind !== 'code_task') return null;
	const tests = new Map(version.scorer.tests.map((test) => [test.id, test]));
	const submission = record(artifacts.find((artifact) => artifact.kind === 'code_submission')?.content);
	let compile: ReviewedCode['compile'] = null;
	const reviewed: ReviewedTest[] = [];
	for (const artifact of artifacts) {
		const content = artifact.kind === 'run_result' ? record(artifact.content) : null;
		if (content === null) continue;
		if (content.stage === 'compile') {
			compile = { status: String(content.status), stderr: text(content.stderr) ?? '' };
			continue;
		}
		const id = String(content.test_id);
		const test = tests.get(id);
		reviewed.push({
			id,
			hidden: content.hidden === true,
			verdict: String(content.verdict),
			skipped: content.skipped === true,
			cpuTimeMs: number(content.cpu_time_ms),
			wallTimeMs: number(content.wall_time_ms),
			memoryKb: number(content.memory_kb),
			exitCode: typeof content.exit_code === 'number' ? content.exit_code : null,
			stdin: test?.stdin ?? null,
			expected: test?.expected ?? null,
			stdoutPreview: text(content.stdout_preview),
			stdoutSha256: text(content.stdout_sha256)
		});
	}
	const source = text(submission?.source);
	return {
		submission:
			submission && source !== null
				? { language: String(submission.language), source, sourceSha256: text(submission.source_sha256) }
				: null,
		compile,
		tests: reviewed
	};
}

function quizOf(artifacts: readonly ArtifactRow[], version: LoadedVersion): ReviewedQuizStep[] | null {
	if (version.kind !== 'quiz') return null;
	const items = new Map(version.itemBank.items.map((item) => [item.id, item]));
	const steps: ReviewedQuizStep[] = [];
	for (const artifact of artifacts) {
		if (artifact.kind !== 'quiz_step' || artifact.content === null) continue;
		const step = quizStepSchema.parse(artifact.content);
		const item = items.get(step.item_id);
		if (!item) throw new Error(`quiz step ${artifact.id} refers to an item outside its version`);
		steps.push({
			itemId: item.id,
			itemVersion: step.item_version,
			prompt: item.prompt,
			code: item.code ?? null,
			options: item.options,
			answer: step.answer,
			correct: step.correct,
			correctOption: item.correct,
			ability: step.ability_estimate_after.ability,
			standardError: step.ability_estimate_after.standard_error
		});
	}
	return steps;
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
			.select({ attempt: assessmentAttempts, demoSessionId: candidates.demoSessionId })
			.from(assessmentAttempts)
			.innerJoin(candidates, eq(candidates.id, assessmentAttempts.candidateId))
			.where(eq(assessmentAttempts.id, attemptId));
		if (!row) throw new ApiError('not_found');
		reach.require(row.demoSessionId);
		const { attempt } = row;
		const version = await loadVersion(tx, attempt.versionId);
		if (!version) throw new Error(`attempt ${attempt.id} lost its version`);
		const artifacts = await tx
			.select()
			.from(assessmentArtifacts)
			.where(eq(assessmentArtifacts.attemptId, attempt.id))
			.orderBy(asc(assessmentArtifacts.seq));
		const scores = await tx
			.select()
			.from(assessmentScores)
			.where(eq(assessmentScores.attemptId, attempt.id))
			.orderBy(desc(assessmentScores.createdAt), desc(assessmentScores.id));
		const facts = await tx
			.select({
				id: sourceFacts.id,
				status: sourceFacts.status,
				statusReason: sourceFacts.statusReason,
				payload: sourceFacts.payload
			})
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
			object: { type: 'assessment_attempt', id: attempt.id },
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
			version,
			artifacts,
			signals: parseSignalLog(attempt.integritySignals),
			scores,
			current: currentScore(scores),
			facts: facts.map((fact) => ({
				id: fact.id,
				status: fact.status,
				statusReason: fact.statusReason,
				scoreId: text(record(fact.payload)?.scoreId)
			})),
			code: codeOf(artifacts, version),
			quiz: quizOf(artifacts, version),
			cleared: artifacts.some((artifact) => artifact.content === null)
		};
	});
}
