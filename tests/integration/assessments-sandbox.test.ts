// Code tasks of the bank against the real sandbox image: every reference solution passes every test of its task in
// every accepted language, and a submission goes the whole way — the code before the run, the job, the verdicts, the
// score, the fact and the recalculation — or, when wrong, stops at the score without a fact. A sandbox that cannot be
// reached never turns into a verdict against the candidate.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { and, asc, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { startAttempt } from '$lib/server/assessments/attempts';
import { readAssessmentBank, type BankEntry, type CodeScorer } from '$lib/server/assessments/bank';
import { submitCode } from '$lib/server/assessments/code';
import { publishAssessmentBank } from '$lib/server/assessments/publish';
import { createAssessmentRunHandler } from '$lib/server/assessments/run-job';
import { candidateAttempt } from '$lib/server/assessments/views';
import {
	assessmentArtifacts,
	assessmentAttempts,
	assessmentScores,
	candidates,
	jobs,
	productPolicies,
	sourceFacts
} from '$lib/server/db/schema';
import { JobFailure } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, failJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { GoJudgeRunner } from '$lib/server/sandbox/runner';
import type { SandboxRunner } from '$lib/server/sandbox/types';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate } from '../helpers/factories';

const SANDBOX_DIR = fileURLToPath(new URL('../../services/sandbox', import.meta.url));
const BANK_DIR = fileURLToPath(new URL('../../assessments', import.meta.url));
const IMAGE = 'fsp-sandbox:test';
const GO_JUDGE_PORT = 5050;

/** The sandbox service of compose.yaml, option for option (as in sandbox.test.ts). */
class SandboxContainer extends GenericContainer {
	constructor() {
		super(IMAGE);
		this.withExposedPorts(GO_JUDGE_PORT)
			.withDroppedCapabilities('ALL')
			.withAddedCapabilities('SYS_ADMIN', 'SETUID', 'SETGID', 'SETFCAP')
			.withSecurityOpt(
				'no-new-privileges:true',
				`seccomp=${readFileSync(`${SANDBOX_DIR}/seccomp.json`, 'utf8')}`,
				'apparmor=unconfined'
			)
			.withTmpFs({ '/tmp': 'size=64m', '/run': 'size=1m' })
			.withSharedMemorySize(128 * 1024 * 1024)
			.withResourcesQuota({ memory: 1.5, cpu: 2 })
			.withWaitStrategy(Wait.forHealthCheck())
			.withStartupTimeout(60_000);
		const hostConfig: typeof this.hostConfig & { CgroupnsMode?: 'private' | 'host' } = this.hostConfig;
		hostConfig.ReadonlyRootfs = true;
		hostConfig.PidsLimit = 512;
		hostConfig.CgroupnsMode = 'private';
		hostConfig.MemorySwap = 1536 * 1024 * 1024;
	}
}

let container: StartedTestContainer;
let runner: GoJudgeRunner;
let database: TestDatabase;
let bank: BankEntry[];
const assessmentIds = new Map<string, string>();
const NOW = new Date('2026-09-25T10:00:00Z');

beforeAll(async () => {
	await promisify(execFile)('docker', ['build', '--quiet', '--tag', IMAGE, SANDBOX_DIR], {
		maxBuffer: 16 * 1024 * 1024
	});
	container = await new SandboxContainer().start();
	runner = new GoJudgeRunner({
		baseUrl: `http://${container.getHost()}:${container.getMappedPort(GO_JUDGE_PORT)}`,
		maxConcurrentRuns: 2
	});
	database = await createTestDatabase();
	bank = await readAssessmentBank(BANK_DIR);
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		for (const item of (await publishAssessmentBank(client, bank)).assessments)
			assessmentIds.set(item.key, item.assessmentId);
	} finally {
		await client.end({ timeout: 5 });
	}
	await database.db.insert(productPolicies).values({
		kind: 'assessment_policy',
		version: 1,
		params: { max_attempts: 3, retake_interval_days: 0, artifact_retention_days: 365 },
		effectiveFrom: new Date('2026-01-01T00:00:00Z')
	});
}, 900_000);

afterAll(async () => {
	await database.drop();
	await container.stop();
});

function codeTask(key: string): BankEntry & { scorer: CodeScorer } {
	const entry = bank.find((candidate) => candidate.key === key);
	if (entry?.scorer.type !== 'sandbox_judge') throw new Error(`${key} is not a code task`);
	return entry as BankEntry & { scorer: CodeScorer };
}

describe('the bank of code tasks', () => {
	const tasks = () => bank.filter((entry) => entry.kind === 'code_task');

	it('covers four stacks with a junior and a middle task each', () => {
		const byStack = new Map<string, string[]>();
		for (const entry of tasks()) {
			if (entry.itemBank.type !== 'code_statement') throw new Error('not a code task');
			byStack.set(entry.itemBank.stack, [...(byStack.get(entry.itemBank.stack) ?? []), entry.itemBank.level].sort());
		}
		expect(Object.fromEntries(byStack)).toEqual({
			go: ['junior', 'middle'],
			java: ['junior', 'middle'],
			javascript: ['junior', 'middle'],
			python: ['junior', 'middle']
		});
	});

	it('accepts every reference solution on every test in every language of its task', async () => {
		for (const entry of tasks()) {
			if (entry.scorer.type !== 'sandbox_judge') throw new Error('not a code task');
			for (const language of entry.scorer.languages) {
				const source = entry.references[language];
				if (source === undefined) throw new Error(`${entry.key} has no ${language} reference`);
				const result = await runner.run({
					requestId: `${entry.key}-${language}`,
					language,
					source,
					tests: entry.scorer.tests,
					limits: entry.scorer.limits,
					checker: entry.scorer.checker
				});
				if (!result.ok) throw new Error(`${entry.key}/${language}: ${JSON.stringify(result.error)}`);
				const failed = result.value.tests.filter((test) => test.verdict !== 'accepted');
				expect(failed.map((test) => `${entry.key}/${language}/${test.id}: ${test.verdict}`)).toEqual([]);
			}
		}
	}, 600_000);
});

async function candidateSubject(): Promise<AccessSubject> {
	const candidate = await createCandidate(database.db);
	return {
		userId: candidate.userId,
		via: 'session',
		candidate: { id: candidate.id, status: 'active' },
		membership: null,
		staff: { operator: false, admin: false, extraPermissions: [] }
	};
}

const candidateIdOf = (subject: AccessSubject) => {
	if (!subject.candidate) throw new Error('not a candidate');
	return subject.candidate.id;
};

/** Runs the waiting `assessment.run` job as the worker does; a handled failure goes back through the queue. */
async function runAssessmentJob(sandbox: SandboxRunner) {
	const handler = createAssessmentRunHandler(
		() => sandbox,
		() => NOW
	);
	const claimed = await claimJob(database.db, `worker-${randomBytes(3).toString('hex')}`, ['assessment.run']);
	if (claimed?.type !== 'assessment.run') throw new Error('no assessment.run job to run');
	const job: ClaimedJob<'assessment.run'> = {
		...claimed,
		type: 'assessment.run',
		payload: JOB_TYPES['assessment.run'].payload.parse(claimed.payload)
	};
	try {
		const result = await handler.run({
			job,
			db: database.db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: createLogger({ service: 'test' }).child({ job_id: job.id })
		});
		return await completeJob(database.db, job, result);
	} catch (error) {
		if (!(error instanceof JobFailure)) throw error;
		return failJob(database.db, job, { code: error.code, retryable: error.retryable, message: error.message });
	}
}

async function submit(subject: AccessSubject, key: string, language: string, source: string) {
	const { attemptId } = await startAttempt(database.db, subject, assessmentIds.get(key) ?? '', NOW);
	const { artifactId } = await submitCode(
		database.db,
		subject,
		attemptId,
		{ language, source, signals: { elapsedMs: 600_000, pasteCount: 1, pastedChars: 420, blurCount: 3 } },
		NOW
	);
	return { attemptId, artifactId };
}

describe('a code task attempt', () => {
	it('judges a correct solution, scores it and turns it into a fact that recalculates the profile', async () => {
		const subject = await candidateSubject();
		const candidateId = candidateIdOf(subject);
		const task = codeTask('js-cart-total');
		const { attemptId, artifactId } = await submit(subject, task.key, 'typescript', task.references.typescript ?? '');

		const [submitted] = await database.db.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, attemptId));
		expect(submitted?.status).toBe('submitted');
		const [code] = await database.db.select().from(assessmentArtifacts).where(eq(assessmentArtifacts.id, artifactId));
		expect(code).toMatchObject({ seq: 1, kind: 'code_submission' });
		const [queued] = await database.db
			.select()
			.from(jobs)
			.where(eq(jobs.dedupKey, `assessment.run:${artifactId}`));
		expect(queued?.status).toBe('queued');
		// Before the run the candidate sees the submission waiting in the queue.
		expect((await candidateAttempt(database.db, subject, attemptId, NOW)).code?.run).toBe('queued');

		expect(await runAssessmentJob(runner)).toBe('succeeded');

		const artifacts = await database.db
			.select()
			.from(assessmentArtifacts)
			.where(eq(assessmentArtifacts.attemptId, attemptId))
			.orderBy(asc(assessmentArtifacts.seq));
		// The code, the compile step (TypeScript strips types before the run) and one result per test.
		expect(artifacts.map((artifact) => artifact.kind)).toEqual([
			'code_submission',
			'run_result',
			...task.scorer.tests.map(() => 'run_result')
		]);
		const [score] = await database.db.select().from(assessmentScores).where(eq(assessmentScores.attemptId, attemptId));
		expect(score).toMatchObject({ level: 'junior', scoredBy: 'automatic', scorerVersion: 'sandbox_judge@1' });
		expect(Number(score?.score)).toBe(task.scorer.tests.length);

		const [fact] = await database.db
			.select()
			.from(sourceFacts)
			.where(and(eq(sourceFacts.candidateId, candidateId), eq(sourceFacts.source, 'platform_test')));
		// Solved in TypeScript: the coverage confirms both skills; a practical task never carries a grade.
		expect(fact?.payload).toMatchObject({
			skillKeys: ['javascript', 'typescript'],
			level: 'junior',
			gradeKey: null,
			language: 'typescript'
		});
		const [candidate] = await database.db.select().from(candidates).where(eq(candidates.id, candidateId));
		const [categorization] = await database.db
			.select()
			.from(jobs)
			.where(eq(jobs.dedupKey, `categorization:${candidateId}`));
		expect(categorization).toMatchObject({ status: 'queued', inputVersion: String(candidate?.profileRevision) });

		// The candidate sees open tests in full and hidden tests by verdict only.
		const detail = await candidateAttempt(database.db, subject, attemptId, NOW);
		expect(detail.code?.run).toBe('done');
		expect(detail.code?.submission?.language).toBe('typescript');
		const open = detail.code?.tests.filter((test) => !test.hidden) ?? [];
		const hidden = detail.code?.tests.filter((test) => test.hidden) ?? [];
		expect(open.length).toBeGreaterThan(0);
		expect(hidden.length).toBeGreaterThan(0);
		expect(open.every((test) => test.stdin !== null && test.expected !== null && test.stdoutPreview !== null)).toBe(
			true
		);
		expect(hidden.every((test) => test.stdin === null && test.expected === null && test.stdoutPreview === null)).toBe(
			true
		);
		expect(hidden.every((test) => test.verdict === 'accepted')).toBe(true);
		expect(detail.signals.entries).toEqual([
			{
				at: NOW.toISOString(),
				stage: 'code_submission',
				client: { elapsedMs: 600_000, pasteCount: 1, pastedChars: 420, blurCount: 3 }
			}
		]);
	});

	it('scores a wrong solution without a fact and without touching the profile', async () => {
		const subject = await candidateSubject();
		const candidateId = candidateIdOf(subject);
		const task = codeTask('py-access-log');
		// Counts the classes right but ignores the tie rule of the slowest path.
		const wrong = (task.references.python3 ?? '').replace(
			'or (ms == slowest[0] and path < slowest[1])',
			'or (ms == slowest[0] and path > slowest[1])'
		);
		expect(wrong).not.toBe(task.references.python3);
		const { attemptId } = await submit(subject, task.key, 'python3', wrong);
		expect(await runAssessmentJob(runner)).toBe('succeeded');

		const [score] = await database.db.select().from(assessmentScores).where(eq(assessmentScores.attemptId, attemptId));
		expect(score?.level).toBe('not_passed');
		expect(Number(score?.score)).toBeLessThan(Number(score?.maxScore));
		const detail = await candidateAttempt(database.db, subject, attemptId, NOW);
		expect(detail.code?.tests.some((test) => test.verdict === 'wrong_answer')).toBe(true);
		expect(detail.status).toBe('scored');
		expect(await database.db.select().from(sourceFacts).where(eq(sourceFacts.candidateId, candidateId))).toEqual([]);
		expect(
			await database.db
				.select()
				.from(jobs)
				.where(eq(jobs.dedupKey, `categorization:${candidateId}`))
		).toEqual([]);
	});

	it('keeps the attempt submitted without a score when the sandbox cannot be reached', async () => {
		const subject = await candidateSubject();
		const task = codeTask('go-word-frequency');
		const { attemptId } = await submit(subject, task.key, 'go', task.references.go ?? '');
		const unreachable = new GoJudgeRunner({ baseUrl: 'http://127.0.0.1:9', maxConcurrentRuns: 1 });

		// Retried once, then failed: the platform failed, not the candidate.
		expect(await runAssessmentJob(unreachable)).toBe('queued');
		await database.db
			.update(jobs)
			.set({ runAfter: new Date(Date.now() - 1_000) })
			.where(eq(jobs.type, 'assessment.run'));
		expect(await runAssessmentJob(unreachable)).toBe('failed');

		const [attempt] = await database.db.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, attemptId));
		expect(attempt?.status).toBe('submitted');
		expect(await database.db.select().from(assessmentScores).where(eq(assessmentScores.attemptId, attemptId))).toEqual(
			[]
		);
		const detail = await candidateAttempt(database.db, subject, attemptId, NOW);
		expect(detail.code).toMatchObject({ run: 'failed', tests: [] });
	});
});
