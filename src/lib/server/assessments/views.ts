// What the candidate sees of platform assessments (docs/domain.md, 10.4): the catalog with coverage and limits, the
// assessment with its current attempt, and an attempt with its own artifacts. Hidden tests show only their verdicts;
// their input, expected output and the program output on them never leave the server. Another candidate's attempt is
// `not_found`.
import { and, desc, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import type { Executor } from '$lib/server/db';
import { assessmentArtifacts, assessmentAttempts, assessmentScores, jobs, sourceFacts } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { allowanceOf, attemptsOf, ownCandidateId, type AttemptAllowance, type AttemptRow } from './attempts';
import type { Coverage } from './bank';
import { assessmentPolicy } from './policy';
import { quizState, quizStepSchema } from './quiz';
import { parseSignalLog, type SignalLog } from './signals';
import { parseStatement, type StatementBlock } from './statement';
import { loadVersion, loadVersions, publishedVersions, type LoadedVersion } from './versions';

export type AttemptStatus = AttemptRow['status'];

/** `started` past its deadline is shown as expired; the row follows on the next change. */
function effective(attempt: AttemptRow, now: Date): AttemptRow {
	return attempt.status === 'started' && attempt.deadlineAt <= now ? { ...attempt, status: 'expired' } : attempt;
}

export interface ScoreView {
	score: number;
	maxScore: number;
	level: string;
	/** The level of the version was reached, and the attempt became a fact of the profile. */
	confirmed: boolean;
	scoredAt: Date;
	details: Record<string, unknown>;
	fact: { id: string; status: string; skillKeys: string[] } | null;
}

export interface AttemptSummary {
	id: string;
	version: number;
	status: AttemptStatus;
	startedAt: Date;
	deadlineAt: Date;
	submittedAt: Date | null;
	score: ScoreView | null;
}

export interface CatalogEntry {
	assessmentId: string;
	versionId: string;
	version: number;
	kind: 'code_task' | 'quiz';
	title: string;
	summary: string;
	/** Code task: its stack and level; a quiz spans levels. */
	stack: string | null;
	level: string | null;
	skillKeys: string[];
	languages: string[];
	timeLimitMinutes: number;
	/** Quiz: at most this many questions. */
	maxQuestions: number | null;
	coverage: Coverage;
	allowance: AttemptAllowance;
	/** The best confirmed level among the candidate's attempts; the profile counts the best one. */
	best: ScoreView | null;
	last: AttemptSummary | null;
}

async function scoresOf(executor: Executor, attemptIds: string[]): Promise<Map<string, ScoreView>> {
	if (attemptIds.length === 0) return new Map();
	// A review adds a score that supersedes the previous one; the one in force is not superseded (domain 10.3).
	const superseded = executor
		.select({ id: assessmentScores.supersedesScoreId })
		.from(assessmentScores)
		.where(and(inArray(assessmentScores.attemptId, attemptIds), isNotNull(assessmentScores.supersedesScoreId)));
	const rows = await executor
		.select()
		.from(assessmentScores)
		.where(and(inArray(assessmentScores.attemptId, attemptIds), notInArray(assessmentScores.id, superseded)));
	const facts = await executor
		.select({
			id: sourceFacts.id,
			status: sourceFacts.status,
			ref: sourceFacts.sourceRecordRef,
			payload: sourceFacts.payload
		})
		.from(sourceFacts)
		.where(
			and(
				eq(sourceFacts.source, 'platform_test'),
				inArray(
					sourceFacts.sourceRecordRef,
					rows.map((row) => `test:score:${row.id}`)
				)
			)
		);
	const factByRef = new Map(facts.map((fact) => [fact.ref, fact]));
	const views = new Map<string, ScoreView>();
	for (const row of rows) {
		const fact = factByRef.get(`test:score:${row.id}`);
		const payload = (fact?.payload ?? {}) as { skillKeys?: string[]; details?: Record<string, unknown> };
		views.set(row.attemptId, {
			score: Number(row.score),
			maxScore: Number(row.maxScore),
			level: row.level,
			confirmed: fact !== undefined,
			scoredAt: row.createdAt,
			details: payload.details ?? {},
			fact: fact ? { id: fact.id, status: fact.status, skillKeys: payload.skillKeys ?? [] } : null
		});
	}
	return views;
}

const LEVEL_ORDER = ['junior', 'middle', 'senior'];

function summaries(
	attempts: AttemptRow[],
	versions: Map<string, LoadedVersion>,
	scores: Map<string, ScoreView>,
	now: Date
) {
	return attempts.map((raw): AttemptSummary => {
		const attempt = effective(raw, now);
		return {
			id: attempt.id,
			version: versions.get(attempt.versionId)?.version ?? 0,
			status: attempt.status,
			startedAt: attempt.startedAt,
			deadlineAt: attempt.deadlineAt,
			submittedAt: attempt.submittedAt,
			score: scores.get(attempt.id) ?? null
		};
	});
}

async function entryOf(
	executor: Executor,
	candidateId: string,
	version: LoadedVersion,
	policy: { max_attempts: number; retake_interval_days: number },
	now: Date
): Promise<{ entry: CatalogEntry; attempts: AttemptSummary[] }> {
	const rows = (await attemptsOf(executor, candidateId, version.assessmentId)).map((row) => effective(row, now));
	const versions = await loadVersions(
		executor,
		rows.map((row) => row.versionId)
	);
	const scores = await scoresOf(
		executor,
		rows.map((row) => row.id)
	);
	const attempts = summaries(rows, versions, scores, now);
	const confirmed = attempts.filter((attempt) => attempt.score?.confirmed);
	const best =
		confirmed.sort((a, b) => LEVEL_ORDER.indexOf(b.score?.level ?? '') - LEVEL_ORDER.indexOf(a.score?.level ?? ''))[0]
			?.score ?? null;
	const code = version.kind === 'code_task' ? version : null;
	return {
		entry: {
			assessmentId: version.assessmentId,
			versionId: version.id,
			version: version.version,
			kind: version.kind,
			title: version.title,
			summary: version.itemBank.summary,
			stack: code?.itemBank.stack ?? null,
			level: code?.itemBank.level ?? null,
			skillKeys: version.skillKeys,
			languages: code ? [...code.scorer.languages] : [],
			timeLimitMinutes: version.scorer.timeLimitMinutes,
			maxQuestions: version.kind === 'quiz' ? version.itemBank.rule.stop.maxItems : null,
			coverage: version.coverage,
			allowance: allowanceOf(rows, policy, now),
			best,
			last: attempts.at(-1) ?? null
		},
		attempts
	};
}

export async function candidateCatalog(executor: Executor, subject: AccessSubject, now: Date): Promise<CatalogEntry[]> {
	const candidateId = ownCandidateId(subject, 'read');
	const policy = await assessmentPolicy(executor, now);
	const entries: CatalogEntry[] = [];
	for (const version of await publishedVersions(executor)) {
		entries.push((await entryOf(executor, candidateId, version, policy.params, now)).entry);
	}
	const kindOrder = { code_task: 0, quiz: 1 };
	return entries.sort(
		(a, b) =>
			kindOrder[a.kind] - kindOrder[b.kind] ||
			(a.stack ?? a.skillKeys[0] ?? '').localeCompare(b.stack ?? b.skillKeys[0] ?? '') ||
			LEVEL_ORDER.indexOf(a.level ?? '') - LEVEL_ORDER.indexOf(b.level ?? '')
	);
}

export interface QuizQuestion {
	id: string;
	prompt: string;
	code: string | null;
	options: { id: string; text: string }[];
	/** Answers given so far and the most the quiz asks. */
	answered: number;
	maxQuestions: number;
}

export type ActiveAttempt =
	| { kind: 'code_task'; attemptId: string; deadlineAt: Date; languages: string[] }
	| { kind: 'quiz'; attemptId: string; deadlineAt: Date; question: QuizQuestion }
	| { kind: 'pending'; attemptId: string };

export interface AssessmentDetail {
	entry: CatalogEntry;
	statement: StatementBlock[] | null;
	/** Open tests of a code task: examples the candidate may run locally. */
	openTests: { id: string; stdin: string; expected: string }[];
	active: ActiveAttempt | null;
	attempts: AttemptSummary[];
	retentionDays: number;
}

export async function candidateAssessment(
	executor: Executor,
	subject: AccessSubject,
	assessmentId: string,
	now: Date
): Promise<AssessmentDetail> {
	const candidateId = ownCandidateId(subject, 'read');
	const [version] = await publishedVersions(executor, assessmentId);
	if (!version) throw new ApiError('not_found', { message: 'Задание не найдено или снято с публикации' });
	const policy = await assessmentPolicy(executor, now);
	const { entry, attempts } = await entryOf(executor, candidateId, version, policy.params, now);

	let active: ActiveAttempt | null = null;
	const current = attempts.find((attempt) => attempt.status === 'started' || attempt.status === 'submitted');
	if (current?.status === 'submitted') active = { kind: 'pending', attemptId: current.id };
	if (current?.status === 'started') {
		const [row] = await executor.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, current.id));
		const attemptVersion = row ? await loadVersion(executor, row.versionId) : null;
		if (!row || !attemptVersion) throw new Error(`attempt ${current.id} lost its version`);
		if (attemptVersion.kind === 'code_task') {
			active = {
				kind: 'code_task',
				attemptId: row.id,
				deadlineAt: row.deadlineAt,
				languages: [...attemptVersion.scorer.languages]
			};
		} else {
			const state = await quizState(executor, row, attemptVersion);
			if (!state.current) throw new Error(`quiz attempt ${row.id} is started but has no question left`);
			active = {
				kind: 'quiz',
				attemptId: row.id,
				deadlineAt: row.deadlineAt,
				question: {
					id: state.current.id,
					prompt: state.current.prompt,
					code: state.current.code ?? null,
					options: state.current.options,
					answered: state.steps.length,
					maxQuestions: attemptVersion.itemBank.rule.stop.maxItems
				}
			};
		}
	}
	return {
		entry,
		statement: version.kind === 'code_task' ? parseStatement(version.itemBank.statement) : null,
		openTests:
			version.kind === 'code_task'
				? version.scorer.tests
						.filter((test) => !test.hidden)
						.map(({ id, stdin, expected }) => ({ id, stdin, expected }))
				: [],
		active,
		attempts,
		retentionDays: policy.params.artifact_retention_days
	};
}

export interface TestView {
	id: string;
	hidden: boolean;
	verdict: string;
	skipped: boolean;
	cpuTimeMs: number;
	memoryKb: number;
	/** Open tests only: the input, the expected output and the start of the program output. */
	stdin: string | null;
	expected: string | null;
	stdoutPreview: string | null;
}

export interface CodeAttemptView {
	/** `null` — the content was cleared after the retention period; the hash stays. */
	submission: { language: string; source: string } | null;
	compile: { status: string; stderr: string } | null;
	tests: TestView[];
	/** How the run of the submission goes: waiting in the queue, running, done, or failed on the side of the platform. */
	run: 'queued' | 'running' | 'done' | 'failed' | 'none';
}

export interface QuizStepView {
	itemId: string;
	prompt: string;
	code: string | null;
	options: { id: string; text: string }[];
	answer: string;
	correct: boolean;
	correctOption: string;
	explanation: string;
}

export interface AttemptDetail {
	id: string;
	assessmentId: string;
	title: string;
	kind: 'code_task' | 'quiz';
	version: number;
	status: AttemptStatus;
	startedAt: Date;
	deadlineAt: Date;
	submittedAt: Date | null;
	score: ScoreView | null;
	coverage: Coverage;
	code: CodeAttemptView | null;
	/** Answers with keys and explanations, once the quiz is over. */
	quiz: QuizStepView[] | null;
	/** Some artifacts are past their retention period: their content is cleared, hashes and the score remain. */
	cleared: boolean;
	signals: SignalLog;
}

type ArtifactRow = Pick<typeof assessmentArtifacts.$inferSelect, 'id' | 'kind' | 'content' | 'seq'>;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

async function codeView(
	executor: Executor,
	artifacts: ArtifactRow[],
	version: LoadedVersion
): Promise<CodeAttemptView> {
	const submissionRow = artifacts.find((artifact) => artifact.kind === 'code_submission');
	const submission = record(submissionRow?.content);
	let run: CodeAttemptView['run'] = 'none';
	if (submissionRow) {
		const [job] = await executor
			.select({ status: jobs.status })
			.from(jobs)
			.where(eq(jobs.dedupKey, `assessment.run:${submissionRow.id}`))
			.orderBy(desc(jobs.createdAt))
			.limit(1);
		const judged = artifacts.some((artifact) => artifact.kind === 'run_result');
		if (judged) run = 'done';
		else if (job?.status === 'queued') run = 'queued';
		else if (job?.status === 'running') run = 'running';
		else if (job) run = 'failed';
	}
	const tests = version.kind === 'code_task' ? version.scorer.tests : [];
	const byId = new Map(tests.map((test) => [test.id, test]));
	let compile: CodeAttemptView['compile'] = null;
	const views: TestView[] = [];
	for (const artifact of artifacts) {
		if (artifact.kind !== 'run_result') continue;
		const content = record(artifact.content);
		if (content === null) continue;
		if (content.stage === 'compile') {
			compile = {
				status: String(content.status),
				stderr: typeof content.stderr === 'string' ? content.stderr : ''
			};
			continue;
		}
		const id = String(content.test_id);
		const hidden = content.hidden === true;
		const test = byId.get(id);
		views.push({
			id,
			hidden,
			verdict: String(content.verdict),
			skipped: content.skipped === true,
			cpuTimeMs: Number(content.cpu_time_ms ?? 0),
			memoryKb: Number(content.memory_kb ?? 0),
			stdin: hidden ? null : (test?.stdin ?? null),
			expected: hidden ? null : (test?.expected ?? null),
			stdoutPreview: hidden ? null : typeof content.stdout_preview === 'string' ? content.stdout_preview : null
		});
	}
	return {
		submission:
			submission && typeof submission.source === 'string'
				? { language: String(submission.language), source: submission.source }
				: null,
		compile,
		tests: views,
		run
	};
}

export async function candidateAttempt(
	executor: Executor,
	subject: AccessSubject,
	attemptId: string,
	now: Date
): Promise<AttemptDetail> {
	const candidateId = ownCandidateId(subject, 'read');
	const [row] = await executor
		.select()
		.from(assessmentAttempts)
		.where(and(eq(assessmentAttempts.id, attemptId), eq(assessmentAttempts.candidateId, candidateId)));
	if (!row) throw new ApiError('not_found');
	const attempt = effective(row, now);
	const version = await loadVersion(executor, attempt.versionId);
	if (!version) throw new Error(`attempt ${attempt.id} lost its version`);
	const artifacts = await executor
		.select({
			id: assessmentArtifacts.id,
			kind: assessmentArtifacts.kind,
			content: assessmentArtifacts.content,
			seq: assessmentArtifacts.seq
		})
		.from(assessmentArtifacts)
		.where(eq(assessmentArtifacts.attemptId, attempt.id))
		.orderBy(assessmentArtifacts.seq);
	const scores = await scoresOf(executor, [attempt.id]);

	let quiz: QuizStepView[] | null = null;
	if (version.kind === 'quiz' && attempt.status !== 'started') {
		const items = new Map(version.itemBank.items.map((item) => [item.id, item]));
		quiz = [];
		for (const artifact of artifacts) {
			if (artifact.kind !== 'quiz_step' || artifact.content === null) continue;
			const step = quizStepSchema.parse(artifact.content);
			const item = items.get(step.item_id);
			if (!item) throw new Error(`quiz step ${artifact.id} refers to an item outside its version`);
			quiz.push({
				itemId: item.id,
				prompt: item.prompt,
				code: item.code ?? null,
				options: item.options,
				answer: step.answer,
				correct: step.correct,
				correctOption: item.correct,
				explanation: item.explanation
			});
		}
	}
	return {
		id: attempt.id,
		assessmentId: version.assessmentId,
		title: version.title,
		kind: version.kind,
		version: version.version,
		status: attempt.status,
		startedAt: attempt.startedAt,
		deadlineAt: attempt.deadlineAt,
		submittedAt: attempt.submittedAt,
		score: scores.get(attempt.id) ?? null,
		coverage: version.coverage,
		code: version.kind === 'code_task' ? await codeView(executor, artifacts, version) : null,
		quiz,
		cleared: artifacts.some((artifact) => artifact.content === null),
		signals: parseSignalLog(attempt.integritySignals)
	};
}
