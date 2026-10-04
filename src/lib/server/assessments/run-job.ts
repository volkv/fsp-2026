// Job `assessment.run` (docs/domain.md, 17.2; docs/contracts.md, 6.4): runs the submitted code of a code task in the
// sandbox outside any transaction, then writes the run artifacts and the score conditionally — only while the attempt
// is still `submitted` and has no run result. A failure of the sandbox never becomes a verdict against the candidate:
// it is retried once, and after that the attempt stays `submitted` without a score for an operator to look into.
// Without `pd_processing` in effect the code is not run and a result is not written.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '$lib/server/config';
import { processingAllowed } from '$lib/server/consent/processing';
import type { Transaction } from '$lib/server/db';
import { assessmentArtifacts, assessmentAttempts } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { runResultArtifacts } from '$lib/server/sandbox/artifacts';
import { GoJudgeRunner } from '$lib/server/sandbox/runner';
import type { RunResponse, SandboxRunner } from '$lib/server/sandbox/types';
import type { CodeScorer } from './bank';
import { assessmentPolicy, retentionUntil } from './policy';
import { appendArtifacts, recordAutomaticScore, type ScoredLevel } from './scoring';
import { loadVersion, type CodeVersion } from './versions';

const submissionContent = z.looseObject({ language: z.string().min(1), source: z.string() });

/** Passed tests and the level of the version they reach (`tests_passed` scale). */
export function codeTaskLevel(
	version: CodeVersion,
	response: RunResponse
): { passed: number; total: number; level: ScoredLevel } {
	const total = version.scorer.tests.length;
	const passed = response.tests.filter((test) => test.verdict === 'accepted').length;
	const reached = [...version.levelScale.thresholds]
		.sort((a, b) => b.minRatio - a.minRatio)
		.find((threshold) => passed / total >= threshold.minRatio);
	return {
		passed,
		total,
		level: reached
			? {
					level: reached.level,
					// A practical task confirms skills, not a grade: one task is not a level test (domain 9.3).
					confirmed: { level: reached.level, levelStrength: reached.levelStrength, gradeKey: null }
				}
			: { level: version.levelScale.below, confirmed: null }
	};
}

function runRequest(artifactId: string, scorer: CodeScorer, language: string, source: string) {
	return {
		requestId: artifactId,
		language,
		source,
		tests: scorer.tests,
		limits: scorer.limits,
		checker: scorer.checker
	};
}

let configuredRunner: SandboxRunner | null = null;

/** The sandbox of this process: one runner, so its limit of concurrent runs holds across jobs. */
function sandboxRunner(): SandboxRunner {
	configuredRunner ??= new GoJudgeRunner({
		baseUrl: config().sandbox.url,
		maxConcurrentRuns: config().sandbox.maxConcurrentRuns
	});
	return configuredRunner;
}

const stale: JobResult = { isCurrent: () => Promise.resolve(false), write: () => Promise.resolve() };

export function createAssessmentRunHandler(
	runner: () => SandboxRunner,
	now: () => Date = () => new Date()
): JobHandler<'assessment.run'> {
	return defineHandler({
		type: 'assessment.run',
		concurrency: 2,
		run: async ({ job, db, requestId, signal }) => {
			const artifactId = job.payload.artifact_id;
			const [submission] = await db
				.select({
					kind: assessmentArtifacts.kind,
					content: assessmentArtifacts.content,
					attemptId: assessmentArtifacts.attemptId,
					candidateId: assessmentAttempts.candidateId,
					versionId: assessmentAttempts.versionId,
					status: assessmentAttempts.status
				})
				.from(assessmentArtifacts)
				.innerJoin(assessmentAttempts, eq(assessmentAttempts.id, assessmentArtifacts.attemptId))
				.where(eq(assessmentArtifacts.id, artifactId));
			if (!submission || submission.kind !== 'code_submission') {
				throw new JobFailure('submission_missing', `artifact ${artifactId} is not a code submission`, {
					retryable: false
				});
			}
			if (submission.status !== 'submitted') return stale;
			if (!(await processingAllowed(db, submission.candidateId, now()))) return stale;
			// The content is gone only after the retention period, long after any run could still be waiting.
			const parsed = submissionContent.safeParse(submission.content);
			if (!parsed.success) {
				throw new JobFailure('submission_unreadable', `artifact ${artifactId} has no code to run`, {
					retryable: false
				});
			}
			const version = await loadVersion(db, submission.versionId);
			if (version?.kind !== 'code_task') {
				throw new JobFailure('version_mismatch', `attempt ${submission.attemptId} is not on a code task`, {
					retryable: false
				});
			}
			if (version.status === 'defective') return stale;

			signal.throwIfAborted();
			const result = await runner().run(
				runRequest(artifactId, version.scorer, parsed.data.language, parsed.data.source)
			);
			if (!result.ok) {
				const { code, retryable, message } = result.error;
				// `invalid_request` and `unsupported_language` are defects of the task, not of the candidate (contracts 6.4).
				throw new JobFailure(`sandbox_${code}`, message, { retryable });
			}
			const response = result.value;
			if (response.tests.some((test) => test.verdict === 'sandbox_error')) {
				throw new JobFailure('sandbox_test_failed', 'the sandbox failed to run a test', { retryable: true });
			}
			const drafts = runResultArtifacts(response, version.scorer.tests);
			const { passed, total, level } = codeTaskLevel(version, response);
			const at = now();

			return {
				isCurrent: async (tx: Transaction) => {
					const [attempt] = await tx
						.select({ status: assessmentAttempts.status })
						.from(assessmentAttempts)
						.where(eq(assessmentAttempts.id, submission.attemptId))
						.for('update');
					if (attempt?.status !== 'submitted') return false;
					if (!(await processingAllowed(tx, submission.candidateId, at))) return false;
					const [judged] = await tx
						.select({ id: assessmentArtifacts.id })
						.from(assessmentArtifacts)
						.where(
							and(eq(assessmentArtifacts.attemptId, submission.attemptId), eq(assessmentArtifacts.kind, 'run_result'))
						)
						.limit(1);
					return judged === undefined;
				},
				write: async (tx: Transaction) => {
					const policy = await assessmentPolicy(tx, at);
					await appendArtifacts(
						tx,
						submission.attemptId,
						drafts.map((draft) => ({ kind: draft.kind, content: draft.content })),
						at,
						retentionUntil(policy, at)
					);
					await recordAutomaticScore(tx, {
						attempt: { id: submission.attemptId, candidateId: submission.candidateId },
						version,
						score: passed,
						maxScore: total,
						level,
						language: response.language.key,
						details: { passed, total, language_version: response.language.version },
						now: at,
						requestId,
						createdBy: { kind: 'system', id: job.id }
					});
				},
				describe: () => ({ passed, total, level: level.level })
			};
		}
	});
}

export const assessmentRun = createAssessmentRunHandler(sandboxRunner);
