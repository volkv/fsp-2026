// A machine candidate taking a test against the database: the sandbox as the `test.run` job sees it, the job run as
// the worker runs it, and an attempt answered to its end — every computed key right or wrong, a program the fake
// sandbox accepts or refuses, the step «измени своё решение», QA cases.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AccessSubject } from '../../src/lib/server/access/permissions';
import type { ItemInstance } from '../../src/lib/server/assessments/contract/bank';
import type { SpecializationKey } from '../../src/lib/server/assessments/contract/catalog';
import { answerItem, type AnswerPayload, type EngineDeps } from '../../src/lib/server/assessments/engine';
import { createTestRunHandler } from '../../src/lib/server/assessments/run-job';
import type { GradeStanding } from '../../src/lib/server/assessments/standing';
import { attemptState } from '../../src/lib/server/assessments/views';
import type { Database } from '../../src/lib/server/db';
import { testItems } from '../../src/lib/server/db/schema';
import { JobFailure } from '../../src/lib/server/jobs/handler';
import { createLogger } from '../../src/lib/server/jobs/log';
import { claimJob, completeJob, failJob, type ClaimedJob } from '../../src/lib/server/jobs/queue';
import { JOB_TYPES } from '../../src/lib/server/jobs/registry';
import type { RunRequest, RunResponse, SandboxRunner, Verdict } from '../../src/lib/server/sandbox/types';

/** The sandbox as the job sees it: programs get `verdict`; a QA harness runs in the local Python. */
export class FakeSandbox implements SandboxRunner {
	readonly contractVersion = 'v1' as const;
	verdict: (testId: string) => Verdict = () => 'accepted';
	down = false;
	requests: RunRequest[] = [];
	languages() {
		return Promise.resolve({ ok: true as const, value: [] });
	}
	run(request: RunRequest) {
		this.requests.push(request);
		if (this.down) {
			return Promise.resolve({
				ok: false as const,
				error: { code: 'unavailable' as const, retryable: true, message: 'the sandbox is down' }
			});
		}
		const harness = request.tests[0]?.id === 'harness';
		const tests = request.tests.map((test) => {
			const output = harness ? execFileSync('python3', ['-c', request.source], { input: test.stdin }).toString() : null;
			return {
				id: test.id,
				verdict: harness ? ('wrong_answer' as const) : this.verdict(test.id),
				cpuTimeMs: 1,
				wallTimeMs: 1,
				memoryKb: 1,
				exitCode: 0,
				signal: null,
				stdoutSha256: '0'.repeat(64),
				stdoutPreview: output
			};
		});
		const response: RunResponse = {
			requestId: request.requestId,
			engine: { name: 'fake', version: '1' },
			language: { key: request.language, version: '1' },
			compile: null,
			tests
		};
		return Promise.resolve({ ok: true as const, value: response });
	}
}

/** Cases of the QA step: the bounds in reverse order kill every mutant of the changed specification. */
export const STEP_CASES = [
	{ input: '5 9 1', expected: '5' },
	{ input: '0 9 1', expected: '1' },
	{ input: '10 9 1', expected: '9' },
	{ input: '0 1 9', expected: '1' },
	{ input: '10 1 9', expected: '9' },
	{ input: '8 1 9', expected: '8' }
];

export const STRONG_CASES = [
	{ input: '5 1 9', expected: '5' },
	{ input: '0 1 9', expected: '1' },
	{ input: '10 1 9', expected: '9' },
	{ input: '8 1 9', expected: '8' },
	{ input: '1 1 9', expected: '1' }
];

/** How a machine candidate answers: every computed key right or wrong; a program and its step; QA cases. */
export interface Behaviour {
	correct: boolean;
	cases?: { input: string; expected: string }[];
}

export interface AttemptRunner {
	/** Runs the waiting `test.run` job as the worker does; a handled failure goes back through the queue. */
	runTestJob: (standing: GradeStanding, specialization: SpecializationKey) => Promise<unknown>;
	/**
	 * Answers the attempt to its end: the key of a computed item (or a wrong value), a program the fake sandbox accepts,
	 * the step «измени своё решение», QA cases; the sandbox job runs after every submission.
	 */
	takeAttempt: (
		subject: AccessSubject,
		attemptId: string,
		standing: GradeStanding,
		specialization: SpecializationKey,
		behaviour: Behaviour
	) => Promise<Awaited<ReturnType<typeof attemptState>>>;
}

/** The runner over the database of a test file (read when called: it is created in `beforeAll`). */
export function attemptRunner(context: {
	db: () => Database;
	sandbox: FakeSandbox;
	deps: (standing: GradeStanding, specialization: SpecializationKey) => EngineDeps;
	requestId: string;
}): AttemptRunner {
	const { sandbox, deps } = context;

	async function runTestJob(standing: GradeStanding, specialization: SpecializationKey) {
		const db = context.db();
		const handler = createTestRunHandler(() => sandbox, deps(standing, specialization));
		const claimed = await claimJob(db, `worker-${randomBytes(3).toString('hex')}`, ['test.run']);
		if (claimed?.type !== 'test.run') throw new Error('no test.run job to run');
		const job: ClaimedJob<'test.run'> = {
			...claimed,
			type: 'test.run',
			payload: JOB_TYPES['test.run'].payload.parse(claimed.payload)
		};
		try {
			const result = await handler.run({
				job,
				db,
				signal: new AbortController().signal,
				requestId: `job:${job.id}`,
				log: createLogger({ service: 'test' }).child({ job_id: job.id })
			});
			return await completeJob(db, job, result);
		} catch (error) {
			if (!(error instanceof JobFailure)) throw error;
			await failJob(db, job, { code: error.code, retryable: error.retryable, message: error.message });
			return error;
		}
	}

	async function takeAttempt(
		subject: AccessSubject,
		attemptId: string,
		standing: GradeStanding,
		specialization: SpecializationKey,
		behaviour: Behaviour
	) {
		const db = context.db();
		for (let guard = 0; guard < 40; guard += 1) {
			const state = await attemptState(db, subject, attemptId, new Date());
			if (state.status !== 'in_progress') return state;
			if (state.current === null) throw new Error('the attempt waits for nothing');
			const [item] = await db
				.select()
				.from(testItems)
				.where(and(eq(testItems.attemptId, attemptId), eq(testItems.seq, state.current)));
			if (!item) throw new Error('no current item');
			const instance = item.instance as ItemInstance;
			let payload: AnswerPayload;
			let sandboxed = false;
			if (item.status === 'answered') {
				const step = instance.changeStep;
				if (!step) throw new Error('answered without a step');
				payload = step.qa
					? { kind: 'change_step_cases', cases: behaviour.cases ?? STEP_CASES }
					: {
							kind: 'change_step_code',
							language: instance.practice?.languages[0] ?? 'python3',
							source: 'print(2)'
						};
				sandboxed = true;
			} else if (instance.practice) {
				payload = { kind: 'code', language: instance.practice.languages[0] ?? 'python3', source: 'print(2)' };
				sandboxed = true;
			} else if (instance.qa) {
				payload = { kind: 'cases', cases: behaviour.cases ?? STRONG_CASES };
				sandboxed = true;
			} else {
				const key = instance.answer?.kind === 'exact' ? instance.answer.value : '';
				payload = { kind: 'answer', answer: behaviour.correct ? key : `${key}0` };
			}
			await answerItem(
				db,
				deps(standing, specialization),
				subject,
				{
					attemptId,
					seq: item.seq,
					payload,
					signals: { elapsedMs: 30_000, pasteCount: 0, pastedChars: 0, blurCount: 1 }
				},
				{ now: new Date(), requestId: context.requestId }
			);
			if (sandboxed) await runTestJob(standing, specialization);
		}
		throw new Error('the attempt did not end');
	}

	return { runTestJob, takeAttempt };
}
