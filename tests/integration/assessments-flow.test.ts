// Platform assessments against the database: publishing the bank, the adaptive quiz from the first answer to the fact
// of the profile and its recalculation, the limits of `assessment_policy`, who may read attempt artifacts, their
// retention.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { annulAttempt } from '$lib/server/assessments/annul';
import { startAttempt } from '$lib/server/assessments/attempts';
import { readAssessmentBank, type BankEntry } from '$lib/server/assessments/bank';
import { publishAssessmentBank } from '$lib/server/assessments/publish';
import { answerQuizItem } from '$lib/server/assessments/quiz';
import { clearExpiredArtifacts } from '$lib/server/assessments/retention';
import { attemptForReview } from '$lib/server/assessments/review';
import { candidateAssessment, candidateAttempt, candidateCatalog } from '$lib/server/assessments/views';
import { loadVersion } from '$lib/server/assessments/versions';
import type { RequestMeta } from '$lib/server/auth/context';
import { loadSelfEvidence } from '$lib/server/candidates/profile';
import { createEvidenceHandler } from '$lib/server/evidence/job';
import {
	assessmentArtifacts,
	assessmentAttempts,
	assessments,
	assessmentScores,
	assessmentVersions,
	auditEvents,
	candidates,
	evidenceRuns,
	claims,
	jobs,
	productPolicies,
	sourceFacts,
	staffRoles
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { createLogger } from '$lib/server/jobs/log';
import { claimJob, completeJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { JOB_TYPES } from '$lib/server/jobs/registry';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createUser, randomSha256 } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const BANK_DIR = fileURLToPath(new URL('../../assessments', import.meta.url));

/** Policy v1 lets attempts follow each other; v2, in force from 2027, pauses a day between them. */
const POLICY_V1_FROM = new Date('2026-01-01T00:00:00Z');
const POLICY_V2_FROM = new Date('2027-01-01T00:00:00Z');
const NOW = new Date('2026-09-25T10:00:00Z');
const meta: RequestMeta = { requestId: 'req-attempts-flow', ip: '203.0.113.11', userAgent: 'vitest' };

let database: TestDatabase;
let bank: BankEntry[];
const assessmentIds = new Map<string, string>();

async function publishBank(entries: BankEntry[]) {
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		return await publishAssessmentBank(client, entries);
	} finally {
		await client.end({ timeout: 5 });
	}
}

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
	} finally {
		await client.end({ timeout: 5 });
	}
	bank = await readAssessmentBank(BANK_DIR);
	const published = await publishBank(bank);
	for (const item of published.assessments) assessmentIds.set(item.key, item.assessmentId);
	await database.db.insert(productPolicies).values([
		{
			kind: 'assessment_policy',
			version: 1,
			params: { max_attempts: 2, retake_interval_days: 0, artifact_retention_days: 365 },
			effectiveFrom: POLICY_V1_FROM
		},
		{
			kind: 'assessment_policy',
			version: 2,
			params: { max_attempts: 5, retake_interval_days: 1, artifact_retention_days: 365 },
			effectiveFrom: POLICY_V2_FROM
		}
	]);
});

afterAll(async () => {
	await database.drop();
});

function assessmentId(key: string): string {
	const id = assessmentIds.get(key);
	if (!id) throw new Error(`assessment ${key} is not published`);
	return id;
}

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

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('expected a refusal');
}

type Knows = 'none' | 'junior' | 'middle' | 'senior';

/** Answers the quiz to its end as a candidate who knows every question up to `knows`. */
async function passQuiz(subject: AccessSubject, key: string, knows: Knows, now = NOW): Promise<string> {
	const { attemptId } = await startAttempt(database.db, subject, assessmentId(key), now);
	for (let step = 0; step < 20; step++) {
		const detail = await candidateAssessment(database.db, subject, assessmentId(key), now);
		const active = detail.active;
		if (active?.kind !== 'quiz') return attemptId;
		const [attempt] = await database.db.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, attemptId));
		const version = await loadVersion(database.db, attempt?.versionId ?? '');
		if (version?.kind !== 'quiz') throw new Error('not a quiz');
		const item = version.itemBank.items.find((candidate) => candidate.id === active.question.id);
		if (!item) throw new Error('question outside the bank');
		const known =
			knows === 'senior' ||
			(knows === 'middle' && item.level !== 'senior') ||
			(knows === 'junior' && item.level === 'junior');
		const wrong = item.options.find((option) => option.id !== item.correct)?.id ?? '';
		await answerQuizItem(
			database.db,
			subject,
			attemptId,
			{
				itemId: item.id,
				optionId: known ? item.correct : wrong,
				signals: { elapsedMs: 5_000, pasteCount: 0, pastedChars: 0, blurCount: step % 2 }
			},
			now,
			`test-${step}`
		);
	}
	throw new Error('the quiz did not end in 20 answers');
}

const handler = createEvidenceHandler(() => NOW);

/** Runs waiting categorizations the way the worker does, until the one of the candidate has run. */
async function runCategorization(candidateId: string): Promise<void> {
	for (;;) {
		const claimed = await claimJob(database.db, `worker-${randomBytes(3).toString('hex')}`, ['evidence.compute']);
		if (claimed?.type !== 'evidence.compute') throw new Error(`no categorization job of ${candidateId} to run`);
		const job: ClaimedJob<'evidence.compute'> = {
			...claimed,
			type: 'evidence.compute',
			payload: JOB_TYPES['evidence.compute'].payload.parse(claimed.payload)
		};
		const result = await handler.run({
			job,
			db: database.db,
			signal: new AbortController().signal,
			requestId: `job:${job.id}`,
			log: createLogger({ service: 'test' }).child({ job_id: job.id })
		});
		expect(await completeJob(database.db, job, result)).toBe('succeeded');
		if (job.payload.candidate_id === candidateId) return;
	}
}

describe('bank publication', () => {
	it('publishes every assessment once and repeats as a no-op', async () => {
		expect(bank.filter((entry) => entry.kind === 'code_task')).toHaveLength(8);
		expect(bank.filter((entry) => entry.kind === 'quiz')).toHaveLength(12);
		const again = await publishBank(bank);
		expect(again.assessments.every((item) => item.outcome === 'unchanged')).toBe(true);
		const rows = await database.db.select().from(assessmentVersions).where(eq(assessmentVersions.status, 'published'));
		expect(rows).toHaveLength(20);
	});

	it('refuses changed content under a published version and retires the old version on a new one', async () => {
		const [first] = bank;
		if (!first) throw new Error('empty bank');
		const changed = { ...first, title: `${first.title} (изменено)`, contentSha256: randomSha256() };
		await expect(publishBank([...bank.slice(1), changed])).rejects.toThrow(/already published with other content/);

		const next = { ...first, version: first.version + 1, contentSha256: randomSha256() };
		const outcome = await publishBank([...bank.slice(1), next]);
		expect(outcome.assessments.find((item) => item.key === first.key)?.outcome).toBe('published');
		const versions = await database.db
			.select({ version: assessmentVersions.version, status: assessmentVersions.status })
			.from(assessmentVersions)
			.where(eq(assessmentVersions.assessmentId, assessmentId(first.key)))
			.orderBy(assessmentVersions.version);
		expect(versions).toEqual([
			{ version: first.version, status: 'retired' },
			{ version: first.version + 1, status: 'published' }
		]);
		await expect(publishBank(bank)).rejects.toThrow(/has v2 published/);
	});
});

describe('adaptive quiz', () => {
	it('converges, scores the attempt and turns the level into a fact that recalculates the profile', async () => {
		const subject = await candidateSubject();
		const candidateId = candidateIdOf(subject);
		const attemptId = await passQuiz(subject, 'quiz-python', 'middle');

		const [attempt] = await database.db.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, attemptId));
		expect(attempt?.status).toBe('scored');
		const steps = await database.db
			.select()
			.from(assessmentArtifacts)
			.where(and(eq(assessmentArtifacts.attemptId, attemptId), eq(assessmentArtifacts.kind, 'quiz_step')));
		expect(steps.length).toBeGreaterThanOrEqual(6);
		expect(steps.length).toBeLessThanOrEqual(10);
		const [score] = await database.db.select().from(assessmentScores).where(eq(assessmentScores.attemptId, attemptId));
		expect(score?.level).toBe('middle');
		expect(score?.scoredBy).toBe('automatic');
		expect(Number(score?.maxScore)).toBe(steps.length);

		const [fact] = await database.db
			.select()
			.from(sourceFacts)
			.where(and(eq(sourceFacts.candidateId, candidateId), eq(sourceFacts.source, 'platform_test')));
		expect(fact).toMatchObject({
			factType: 'test_score',
			trustLevel: 'platform_verified',
			ownershipBasis: 'own_attempt',
			ownershipRef: attemptId,
			eventKey: `test:assessment:${assessmentId('quiz-python')}`,
			sourceRecordRef: `test:score:${score?.id}`,
			status: 'active'
		});
		expect(fact?.payload).toMatchObject({
			skillKeys: ['python'],
			level: 'middle',
			gradeKey: 'middle',
			levelStrength: 0.6
		});
		const factClaims = await database.db
			.select()
			.from(claims)
			.where(eq(claims.factId, fact?.id ?? ''));
		expect(factClaims.map((claim) => [claim.skillKey, claim.extractor, claim.claimType])).toEqual([
			['python', 'source_mapping', 'skill_mention']
		]);

		const [candidate] = await database.db.select().from(candidates).where(eq(candidates.id, candidateId));
		const queued = await database.db
			.select()
			.from(jobs)
			.where(and(eq(jobs.type, 'evidence.compute'), eq(jobs.dedupKey, `evidence:${candidateId}`)));
		expect(queued.map((job) => [job.status, job.inputVersion])).toEqual([
			['queued', String(candidate?.profileRevision)]
		]);

		// The attempt as the candidate sees it: the answers with keys and explanations, and the signals as a journal.
		const detail = await candidateAttempt(database.db, subject, attemptId, NOW);
		expect(detail.quiz).toHaveLength(steps.length);
		expect(detail.quiz?.every((step) => step.explanation.length > 0)).toBe(true);
		expect(detail.score).toMatchObject({ level: 'middle', confirmed: true });
		expect(detail.score?.details).toMatchObject({ confidence: expect.any(Number) as number });
		expect(detail.signals.entries).toHaveLength(steps.length);
		expect(detail.signals.entries[0]).toMatchObject({ stage: 'quiz_step', client: { blurCount: 0 } });

		// Categorization reads the fact: python becomes a skill confirmed by the platform.
		await runCategorization(candidateId);
		const [run] = await database.db.select().from(evidenceRuns).where(eq(evidenceRuns.candidateId, candidateId));
		expect(run?.status).toBe('published');

		// The profile shows the fact as a test of the platform, with the version of the task and the attempt.
		const evidence = await loadSelfEvidence(database.db, subject, NOW);
		const shown = evidence.facts.find((item) => item.id === fact?.id);
		expect(shown).toMatchObject({
			source: 'platform_test',
			trustLevel: 'platform_verified',
			detail: {
				kind: 'test_score',
				testKind: 'quiz',
				level: 'middle',
				language: null,
				attemptId,
				score: Number(score?.score),
				maxScore: steps.length
			},
			supports: [{ skillKey: 'python', attestation: 'direct' }]
		});
		const [version] = await database.db
			.select({ title: assessments.title, version: assessmentVersions.version })
			.from(assessmentVersions)
			.innerJoin(assessments, eq(assessments.id, assessmentVersions.assessmentId))
			.where(eq(assessmentVersions.id, attempt?.versionId ?? ''));
		expect(shown?.detail).toMatchObject({ assessment: version?.title, version: version?.version });
		expect(evidence.skills.find((skill) => skill.skillKey === 'python')).toMatchObject({
			attestation: 'direct',
			badgeTrust: 'platform_verified'
		});
	});

	it('runs every quiz of the bank to a confirmed level and a fact of its skill', async () => {
		for (const entry of bank.filter((item) => item.kind === 'quiz')) {
			const subject = await candidateSubject();
			const attemptId = await passQuiz(subject, entry.key, 'middle');
			const [score] = await database.db
				.select()
				.from(assessmentScores)
				.where(eq(assessmentScores.attemptId, attemptId));
			expect(score?.level, entry.key).toBe('middle');
			const [fact] = await database.db
				.select()
				.from(sourceFacts)
				.where(and(eq(sourceFacts.candidateId, candidateIdOf(subject)), eq(sourceFacts.source, 'platform_test')));
			expect(fact?.payload, entry.key).toMatchObject({ skillKeys: entry.skillKeys, level: 'middle' });
		}
	});

	it('does not confirm a level for someone who knows nothing, and makes no fact', async () => {
		const subject = await candidateSubject();
		const attemptId = await passQuiz(subject, 'quiz-go', 'none');
		const [score] = await database.db.select().from(assessmentScores).where(eq(assessmentScores.attemptId, attemptId));
		expect(score?.level).toBe('not_confirmed');
		const facts = await database.db
			.select()
			.from(sourceFacts)
			.where(eq(sourceFacts.candidateId, candidateIdOf(subject)));
		expect(facts).toEqual([]);
		const queued = await database.db
			.select()
			.from(jobs)
			.where(eq(jobs.dedupKey, `evidence:${candidateIdOf(subject)}`));
		expect(queued).toEqual([]);
	});

	it('accepts only the current question and one of its options', async () => {
		const subject = await candidateSubject();
		const { attemptId } = await startAttempt(database.db, subject, assessmentId('quiz-sql'), NOW);
		const detail = await candidateAssessment(database.db, subject, assessmentId('quiz-sql'), NOW);
		if (detail.active?.kind !== 'quiz') throw new Error('no question');
		// The page never receives the key or the explanation of the question on screen.
		expect(Object.keys(detail.active.question).sort()).toEqual([
			'answered',
			'code',
			'id',
			'maxQuestions',
			'options',
			'prompt'
		]);
		const current = detail.active.question;
		const stale = await refusal(
			answerQuizItem(database.db, subject, attemptId, { itemId: 'quiz-sql-99', optionId: 'a', signals: null }, NOW, 't')
		);
		expect(stale.details?.[0]?.code).toBe('stale_question');
		const invalid = await refusal(
			answerQuizItem(database.db, subject, attemptId, { itemId: current.id, optionId: 'z', signals: null }, NOW, 't')
		);
		expect(invalid.code).toBe('validation_failed');
	});

	it('expires an attempt past its deadline instead of taking an answer', async () => {
		const subject = await candidateSubject();
		const { attemptId } = await startAttempt(database.db, subject, assessmentId('quiz-javascript'), NOW);
		const detail = await candidateAssessment(database.db, subject, assessmentId('quiz-javascript'), NOW);
		if (detail.active?.kind !== 'quiz') throw new Error('no question');
		const late = new Date(NOW.getTime() + 31 * 60_000);
		const expired = await refusal(
			answerQuizItem(
				database.db,
				subject,
				attemptId,
				{ itemId: detail.active.question.id, optionId: 'a', signals: null },
				late,
				't'
			)
		);
		expect(expired.details?.[0]?.code).toBe('attempt_expired');
		const [attempt] = await database.db.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, attemptId));
		expect(attempt?.status).toBe('expired');
	});
});

describe('attempt limits', () => {
	it('keeps one attempt in progress and stops at the limit of the policy', async () => {
		const subject = await candidateSubject();
		const id = assessmentId('quiz-javascript');
		await startAttempt(database.db, subject, id, NOW);
		const active = await refusal(startAttempt(database.db, subject, id, NOW));
		expect(active.details?.[0]?.code).toBe('attempt_active');

		// The first attempt expires unanswered and still counts; the second is answered; the third is refused.
		const later = new Date(NOW.getTime() + 60 * 60_000);
		await passQuiz(subject, 'quiz-javascript', 'junior', later);
		const exhausted = await refusal(startAttempt(database.db, subject, id, later));
		expect(exhausted.details?.[0]?.code).toBe('attempts_exhausted');
		const [entry] = (await candidateCatalog(database.db, subject, later)).filter((item) => item.assessmentId === id);
		expect(entry?.allowance).toMatchObject({ used: 2, max: 2, blocked: 'attempts_exhausted' });

		// Another assessment has its own limit.
		await expect(startAttempt(database.db, subject, assessmentId('quiz-go'), later)).resolves.toMatchObject({
			attemptId: expect.any(String) as string
		});
	});

	it('pauses between attempts when the policy in force says so', async () => {
		const subject = await candidateSubject();
		const at = new Date(POLICY_V2_FROM.getTime() + 3_600_000);
		await passQuiz(subject, 'quiz-python', 'junior', at);
		const paused = await refusal(
			startAttempt(database.db, subject, assessmentId('quiz-python'), new Date(at.getTime() + 60_000))
		);
		expect(paused.details?.[0]?.code).toBe('retake_interval');
		await expect(
			startAttempt(database.db, subject, assessmentId('quiz-python'), new Date(at.getTime() + 25 * 3_600_000))
		).resolves.toMatchObject({ attemptId: expect.any(String) as string });
	});

	it('lets a new attempt start once a limit-counted attempt is annulled for a platform failure', async () => {
		const subject = await candidateSubject();
		const id = assessmentId('quiz-javascript');
		const firstAttemptId = await passQuiz(subject, 'quiz-javascript', 'junior', NOW);
		const later = new Date(NOW.getTime() + 60 * 60_000);
		await passQuiz(subject, 'quiz-javascript', 'junior', later);
		const exhausted = await refusal(startAttempt(database.db, subject, id, later));
		expect(exhausted.details?.[0]?.code).toBe('attempts_exhausted');

		const operatorUser = await createUser(database.db);
		await database.db.insert(staffRoles).values({ userId: operatorUser.id, role: 'operator', grantedAt: new Date() });
		const operator: AccessSubject = {
			userId: operatorUser.id,
			via: 'session',
			candidate: null,
			membership: null,
			staff: { operator: true, admin: false, extraPermissions: [] }
		};
		await annulAttempt(database.db, operator, meta, firstAttemptId, 'technical_failure', later);

		await expect(startAttempt(database.db, subject, id, later)).resolves.toMatchObject({
			attemptId: expect.any(String) as string
		});
	});
});

describe('access to attempt artifacts', () => {
	it('shows an attempt only to its candidate and to an operator in a review, with a journal record', async () => {
		const owner = await candidateSubject();
		const attemptId = await passQuiz(owner, 'quiz-go', 'junior');

		const stranger = await candidateSubject();
		expect((await refusal(candidateAttempt(database.db, stranger, attemptId, NOW))).code).toBe('not_found');

		const employerUser = await createUser(database.db);
		const employer: AccessSubject = {
			userId: employerUser.id,
			via: 'session',
			candidate: null,
			membership: {
				memberId: employerUser.id,
				companyId: employerUser.id,
				role: 'owner',
				status: 'active',
				companyStatus: 'verified'
			},
			staff: { operator: false, admin: false, extraPermissions: [] }
		};
		expect((await refusal(candidateAttempt(database.db, employer, attemptId, NOW))).code).toBe('forbidden');
		expect((await refusal(attemptForReview(database.db, employer, attemptId, 'r'))).code).toBe('forbidden');
		expect((await refusal(attemptForReview(database.db, owner, attemptId, 'r'))).code).toBe('forbidden');

		const operatorUser = await createUser(database.db);
		await database.db.insert(staffRoles).values({ userId: operatorUser.id, role: 'operator', grantedAt: new Date() });
		const operator: AccessSubject = {
			userId: operatorUser.id,
			via: 'session',
			candidate: null,
			membership: null,
			staff: { operator: true, admin: false, extraPermissions: [] }
		};
		const review = await attemptForReview(database.db, operator, attemptId, 'review-1');
		expect(review.artifacts.length).toBeGreaterThan(0);
		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'assessment.artifact_viewed'), eq(auditEvents.objectId, attemptId)));
		expect(event).toMatchObject({ actorUserId: operatorUser.id, subjectCandidateId: candidateIdOf(owner) });
	});

	it('clears the content after the retention period and keeps the hashes and the score', async () => {
		const subject = await candidateSubject();
		const attemptId = await passQuiz(subject, 'quiz-sql', 'junior');
		const before = await database.db
			.select()
			.from(assessmentArtifacts)
			.where(eq(assessmentArtifacts.attemptId, attemptId))
			.orderBy(assessmentArtifacts.seq);
		const notYet = await database.db.transaction((tx) => clearExpiredArtifacts(tx, '2026-09-26', new Set()));
		expect(notYet.artifacts).toBe(0);

		const cleared = await database.db.transaction(async (tx) => {
			const count = (await clearExpiredArtifacts(tx, '2100-01-01', new Set())).artifacts;
			// The role is reset: the rest of the transaction works as the application again.
			const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
			expect(role?.role).not.toBe('fsp_retention');
			return count;
		});
		expect(cleared).toBeGreaterThanOrEqual(before.length);
		const after = await database.db
			.select()
			.from(assessmentArtifacts)
			.where(eq(assessmentArtifacts.attemptId, attemptId))
			.orderBy(assessmentArtifacts.seq);
		expect(after.map((row) => [row.seq, row.sha256, row.content])).toEqual(
			before.map((row) => [row.seq, row.sha256, null])
		);
		const detail = await candidateAttempt(database.db, subject, attemptId, NOW);
		expect(detail).toMatchObject({ cleared: true, quiz: [], score: { level: 'junior' } });
		// Outside the retention role the table stays append-only.
		await expect(
			database.db.update(assessmentArtifacts).set({ content: null }).where(eq(assessmentArtifacts.attemptId, attemptId))
		).rejects.toThrow();
	});
});

it('keeps assessments and their versions linked by the bank key', async () => {
	const rows = await database.db
		.select({ title: assessments.title, key: sql<string>`${assessmentVersions.itemBank} ->> 'key'` })
		.from(assessments)
		.innerJoin(assessmentVersions, eq(assessmentVersions.assessmentId, assessments.id))
		.where(eq(assessmentVersions.status, 'published'));
	expect(new Set(rows.map((row) => row.key))).toEqual(new Set(bank.map((entry) => entry.key)));
});
