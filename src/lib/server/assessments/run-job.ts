// Job `test.run` (docs/domain.md, 10.3, 17.2; docs/contracts.md, 6.4–6.5): scores a practice cluster in the sandbox
// outside any transaction, then writes the run artifacts and the score conditionally — only while the cluster still
// waits for this submission. A program: one request with every test of every group of its instance (or of its step
// «измени своё решение»). QA test cases: the harness with the correct reference first; a case failing on it scores 0;
// otherwise the harness with every mutant, one run — for the task or for the changed specification of its step. A failure of the sandbox is never a verdict against the candidate:
// one retry, then the cluster stays `awaiting_sandbox` for an operator (contracts 6.4).
// Without `pd_processing` in effect nothing is run and nothing is written.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '$lib/server/config';
import { processingAllowed } from '$lib/server/consent/processing';
import type { Transaction } from '$lib/server/db';
import { testArtifacts, testAttempts, testItems } from '$lib/server/db/schema';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { runResultArtifacts } from '$lib/server/sandbox/artifacts';
import { GoJudgeRunner } from '$lib/server/sandbox/runner';
import type { RunRequest, RunResponse, SandboxRunner } from '$lib/server/sandbox/types';
import { familyModule, releaseById } from './bank-store';
import type { FamilyModule, ItemInstance } from './contract/bank';
import { advance, appendArtifacts, type EngineDeps } from './engine';
import {
	SandboxFailure,
	groupsScore,
	harnessLimits,
	harnessLine,
	practiceRunRequest,
	qaCasesStdin,
	qaScore,
	withChangeStep,
	type QaCase
} from './score';
import { OWNER_STANDING } from './standing';

const submissionContent = z.looseObject({
	language: z.string().min(1),
	source: z.string(),
	stage: z.enum(['task', 'change_step'])
});
const casesContent = z.looseObject({
	stage: z.enum(['task', 'change_step']),
	cases: z.array(z.strictObject({ input: z.string(), expected: z.string() }))
});

interface Scored {
	/** What the run gives the item: its final score, or the task part before the step. */
	score: number;
	detail: Record<string, unknown>;
	runs: { request: RunRequest; response: RunResponse }[];
}

async function run(runner: SandboxRunner, request: RunRequest): Promise<RunResponse> {
	const result = await runner.run(request);
	if (!result.ok) {
		const { code, retryable, message } = result.error;
		// `invalid_request` and `unsupported_language` are defects of the task, not of the candidate (contracts 6.4).
		throw new JobFailure(`sandbox_${code}`, message, { retryable });
	}
	return result.value;
}

function asRetryable(error: unknown): never {
	if (error instanceof SandboxFailure) throw new JobFailure('sandbox_run_failed', error.message, { retryable: true });
	throw error;
}

async function scoreProgram(
	runner: SandboxRunner,
	artifactId: string,
	instance: ItemInstance,
	stage: 'task' | 'change_step',
	language: string,
	source: string
): Promise<Scored> {
	const groups = stage === 'task' ? (instance.practice?.groups ?? []) : (instance.changeStep?.groups ?? []);
	const request = practiceRunRequest(artifactId, instance, groups, language, source);
	const response = await run(runner, request);
	try {
		const scored = groupsScore(groups, response);
		return {
			score: scored.score,
			detail: { passed_groups: scored.passedGroups, total_groups: scored.totalGroups, groups: scored.groups },
			runs: [{ request, response }]
		};
	} catch (error) {
		return asRetryable(error);
	}
}

function harnessRequest(requestId: string, source: string, cases: readonly QaCase[], mutants: number): RunRequest {
	return {
		requestId,
		language: 'python3',
		source,
		// The harness prints one line, read from the preview; the candidate never sees it.
		tests: [{ id: 'harness', stdin: qaCasesStdin(cases), expected: '', hidden: false }],
		limits: harnessLimits(mutants),
		checker: { kind: 'exact' }
	};
}

async function scoreCases(
	runner: SandboxRunner,
	artifactId: string,
	instance: ItemInstance,
	deps: { harness: NonNullable<FamilyModule['harness']>; rubric: Parameters<typeof qaScore>[1] },
	cases: readonly QaCase[],
	part: 'task' | 'change_step'
): Promise<Scored> {
	const qa = part === 'task' ? instance.qa : instance.changeStep?.qa;
	if (!qa) throw new JobFailure('not_qa', `instance ${instance.family} has no QA ${part}`, { retryable: false });
	const reference = harnessRequest(
		`${artifactId}:reference`,
		deps.harness(instance, 'reference', part).source,
		cases,
		1
	);
	const referenceResponse = await run(runner, reference);
	const runs = [{ request: reference, response: referenceResponse }];
	try {
		const referenceLine = harnessLine(referenceResponse, cases.length);
		let mutantLine: string | null = null;
		if (!referenceLine.includes('0')) {
			const mutants = harnessRequest(
				`${artifactId}:mutants`,
				deps.harness(instance, 'mutants', part).source,
				cases,
				qa.mutants.length
			);
			const mutantResponse = await run(runner, mutants);
			runs.push({ request: mutants, response: mutantResponse });
			mutantLine = harnessLine(mutantResponse, qa.mutants.length);
		}
		const scored = qaScore(instance, deps.rubric, referenceLine, mutantLine, part);
		return {
			score: scored.score,
			detail: {
				outcome: scored.outcome,
				cases_on_reference: scored.casesOnReference,
				killed: scored.killed,
				non_equivalent: scored.nonEquivalent,
				kill_ratio: scored.killRatio,
				matrix: scored.matrix
			},
			runs
		};
	} catch (error) {
		return asRetryable(error);
	}
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

export function createTestRunHandler(
	runner: () => SandboxRunner,
	deps: EngineDeps,
	now: () => Date = () => new Date()
): JobHandler<'test.run'> {
	return defineHandler({
		type: 'test.run',
		concurrency: 2,
		run: async ({ job, db, requestId, signal }) => {
			const artifactId = job.payload.artifact_id;
			const [row] = await db
				.select({ artifact: testArtifacts, item: testItems, attempt: testAttempts })
				.from(testArtifacts)
				.innerJoin(testItems, eq(testItems.id, testArtifacts.itemId))
				.innerJoin(testAttempts, eq(testAttempts.id, testArtifacts.attemptId))
				.where(eq(testArtifacts.id, artifactId));
			if (!row || (row.artifact.kind !== 'code_submission' && row.artifact.kind !== 'qa_cases')) {
				throw new JobFailure('submission_missing', `artifact ${artifactId} is not a submission`, { retryable: false });
			}
			const { artifact, item, attempt } = row;
			if (attempt.status !== 'in_progress' || item.status !== 'awaiting_sandbox') return stale;
			if (!(await processingAllowed(db, attempt.candidateId, now()))) return stale;
			const instance = item.instance as ItemInstance;
			let scored: Scored;
			let stage: 'task' | 'change_step' = 'task';
			let language: string | null = null;
			signal.throwIfAborted();
			if (artifact.kind === 'code_submission') {
				const parsed = submissionContent.safeParse(artifact.content);
				if (!parsed.success) {
					throw new JobFailure('submission_unreadable', `artifact ${artifactId} has no code to run`, {
						retryable: false
					});
				}
				stage = parsed.data.stage;
				language = parsed.data.language;
				scored = await scoreProgram(runner(), artifactId, instance, stage, parsed.data.language, parsed.data.source);
			} else {
				const parsed = casesContent.safeParse(artifact.content);
				if (!parsed.success) {
					throw new JobFailure('submission_unreadable', `artifact ${artifactId} has no test cases`, {
						retryable: false
					});
				}
				const release = await releaseById(db, attempt.bankReleaseId);
				const family = release.families.find((f) => f.descriptor.key === item.familyKey);
				if (!family)
					throw new JobFailure('family_missing', `family ${item.familyKey} is not in its release`, {
						retryable: false
					});
				const module = await (deps.modules ?? familyModule)(family, release);
				if (!module.harness) {
					throw new JobFailure('harness_missing', `family ${item.familyKey} has no harness`, { retryable: false });
				}
				stage = parsed.data.stage;
				scored = await scoreCases(
					runner(),
					artifactId,
					instance,
					{ harness: module.harness, rubric: family.descriptor.rubric },
					parsed.data.cases,
					stage
				);
			}
			const drafts = scored.runs.flatMap(({ request, response }) =>
				runResultArtifacts(response, request.tests).map((draft) => ({
					kind: draft.kind,
					content: { ...draft.content, seq: item.seq, stage }
				}))
			);
			const at = now();

			return {
				isCurrent: async (tx: Transaction) => {
					const [locked] = await tx
						.select({ status: testAttempts.status })
						.from(testAttempts)
						.where(eq(testAttempts.id, attempt.id))
						.for('update');
					if (locked?.status !== 'in_progress') return false;
					if (!(await processingAllowed(tx, attempt.candidateId, at))) return false;
					const [current] = await tx
						.select({ status: testItems.status })
						.from(testItems)
						.where(and(eq(testItems.id, item.id), eq(testItems.status, 'awaiting_sandbox')));
					return current !== undefined;
				},
				write: async (tx: Transaction) => {
					await appendArtifacts(tx, attempt.id, item.id, drafts, at);
					const previous = (item.scoreDetail ?? {}) as Record<string, unknown> & { task?: { score: number } };
					const step = instance.changeStep;
					if (stage === 'task' && step) {
						// The task is scored; the step «измени своё решение» opens for the candidate.
						await tx
							.update(testItems)
							.set({ status: 'answered', scoreDetail: { language, task: { score: scored.score, ...scored.detail } } })
							.where(eq(testItems.id, item.id));
						return;
					}
					const score =
						stage === 'change_step' && step
							? withChangeStep(previous.task?.score ?? 0, scored.score, step.weight)
							: scored.score;
					const detail =
						stage === 'change_step'
							? { ...previous, step: { score: scored.score, ...scored.detail } }
							: { language, task: { score: scored.score, ...scored.detail } };
					await tx
						.update(testItems)
						.set({ status: 'scored', score, scoreDetail: detail })
						.where(eq(testItems.id, item.id));
					const [fresh] = await tx.select().from(testAttempts).where(eq(testAttempts.id, attempt.id));
					if (!fresh) throw new Error(`attempt ${attempt.id} is missing`);
					await advance(tx, deps, fresh, { now: at, requestId, createdBy: { kind: 'system', id: job.id } });
				},
				describe: () => ({ stage, score: scored.score })
			};
		}
	});
}

export const testRun = createTestRunHandler(sandboxRunner, { standing: OWNER_STANDING });
