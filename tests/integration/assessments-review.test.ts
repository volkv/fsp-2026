// Review and annulment of platform attempts by the operator of FSP against the database (domain 10.2–10.4, 19.1):
// the list asks a person to look at attempts with pastes or departures from the page; the case reads the attempt in
// full under the journal; the annulment takes the fact «confirmed by the platform» out of the profile — its claims
// are invalidated, a receipt of it answers `annulled`, the evidence floor rises and the category is recalculated —
// cancels a waiting run of a submission, notifies the candidate, and a repeated annulment changes nothing. Without the
// right nothing is read. The first screen of the cabinet counts the attempts that ask for a person.
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { annulAttempt, ownAttemptAnnulment } from '$lib/server/assessments/annul';
import { startAttempt } from '$lib/server/assessments/attempts';
import { readAssessmentBank } from '$lib/server/assessments/bank';
import { submitCode } from '$lib/server/assessments/code';
import { publishAssessmentBank } from '$lib/server/assessments/publish';
import { answerQuizItem } from '$lib/server/assessments/quiz';
import { attemptForReview, attemptsForReview, attemptsForReviewCount } from '$lib/server/assessments/review';
import { candidateAssessment } from '$lib/server/assessments/views';
import { loadVersion } from '$lib/server/assessments/versions';
import type { RequestMeta } from '$lib/server/auth/context';
import {
	assessmentAttempts,
	auditEvents,
	candidates,
	claims,
	jobs,
	notifications,
	productPolicies,
	sourceFacts,
	staffRoles,
	verificationReceipts
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { verifyReceipt } from '$lib/server/fsp/receipts';
import { createFieldCrypto } from '$lib/server/crypto/fields';
import { notificationFacts } from '$lib/server/notifications/content';
import { openNotification } from '$lib/server/notifications/inbox';
import { notificationLetter } from '$lib/server/notifications/templates';
import { operatorOverview } from '$lib/server/operator/overview';
import { publishTaxonomy } from '$lib/server/taxonomy/publish';
import { buildRelease, readTaxonomyDatasets } from '$lib/server/taxonomy/release';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createUser, randomSha256 } from '../helpers/factories';

const TAXONOMY_DIR = fileURLToPath(new URL('../../taxonomy', import.meta.url));
const BANK_DIR = fileURLToPath(new URL('../../assessments', import.meta.url));
const NOW = new Date('2026-09-25T10:00:00Z');
const meta: RequestMeta = { requestId: 'req-review', ip: '203.0.113.9', userAgent: 'vitest' };

const crypto = createFieldCrypto({
	keys: new Map([[1, Buffer.alloc(32, 5)]]),
	activeVersion: 1,
	hmacSecret: Buffer.alloc(32, 6)
});

let database: TestDatabase;
let operator: AccessSubject;
const assessmentIds = new Map<string, string>();

beforeAll(async () => {
	database = await createTestDatabase();
	const client = postgres(database.url, { max: 1, onnotice: () => {} });
	try {
		await publishTaxonomy(client, buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)));
		const published = await publishAssessmentBank(client, await readAssessmentBank(BANK_DIR));
		for (const item of published.assessments) assessmentIds.set(item.key, item.assessmentId);
	} finally {
		await client.end({ timeout: 5 });
	}
	await database.db.insert(productPolicies).values({
		kind: 'assessment_policy',
		version: 1,
		params: { max_attempts: 5, retake_interval_days: 0, artifact_retention_days: 365 },
		effectiveFrom: new Date('2026-01-01T00:00:00Z')
	});
	const user = await createUser(database.db);
	await database.db.insert(staffRoles).values({ userId: user.id, role: 'operator', grantedAt: new Date() });
	operator = {
		userId: user.id,
		via: 'session',
		candidate: null,
		membership: null,
		staff: { operator: true, admin: false, extraPermissions: [] }
	};
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

/** The candidate's notifications of annulments, with the letter each would be. */
async function annulNotices(subject: AccessSubject) {
	const rows = await database.db
		.select()
		.from(notifications)
		.where(and(eq(notifications.userId, subject.userId ?? ''), eq(notifications.type, 'assessment.annulled')));
	return Promise.all(
		rows.map(async (row) => {
			const facts = await notificationFacts(database.db, crypto, { ...row, type: 'assessment.annulled' });
			if (!facts) throw new Error('the candidate does not see the notification');
			const letter = notificationLetter('c@example.org', 'assessment.annulled', facts, row.payload as never, {
				open: `http://app.test/notifications/${row.id}`,
				settings: 'http://app.test/settings'
			});
			return { row, letter };
		})
	);
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

/** Answers every question right; the page reports a departure on every other answer. */
async function passQuiz(subject: AccessSubject, key: string): Promise<string> {
	const { attemptId } = await startAttempt(database.db, subject, assessmentId(key), NOW);
	for (let step = 0; step < 20; step++) {
		const detail = await candidateAssessment(database.db, subject, assessmentId(key), NOW);
		const active = detail.active;
		if (active?.kind !== 'quiz') return attemptId;
		const [attempt] = await database.db.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, attemptId));
		const version = await loadVersion(database.db, attempt?.versionId ?? '');
		if (version?.kind !== 'quiz') throw new Error('not a quiz');
		const item = version.itemBank.items.find((candidate) => candidate.id === active.question.id);
		if (!item) throw new Error('question outside the bank');
		await answerQuizItem(
			database.db,
			subject,
			attemptId,
			{
				itemId: item.id,
				optionId: item.correct,
				signals: { elapsedMs: 5_000, pasteCount: 0, pastedChars: 0, blurCount: step % 2 }
			},
			NOW,
			`test-${step}`
		);
	}
	throw new Error('the quiz did not end in 20 answers');
}

/** A receipt of the fact as a verifier holds it: its status follows the fact. */
async function receiptOf(factId: string, payloadSha256: string): Promise<string> {
	const handle = Array.from(randomBytes(26), (byte) => 'abcdefghijklmnopqrstuvwxyz234567'[byte % 32]).join('');
	await database.db.insert(verificationReceipts).values({
		handle,
		factId,
		factPayloadSha256: payloadSha256,
		disclosureLevel: 'generalized',
		statement: { receipt_version: 1 },
		statementSha256: randomSha256(),
		signature: 'signature',
		signingKeyId: 'test-1',
		commitmentNonce: randomBytes(16),
		issuedAt: NOW
	});
	return handle;
}

describe('review of attempts', () => {
	it('keeps the list, the case and the annulment from anybody but the operator', async () => {
		const subject = await candidateSubject();
		const attemptId = await passQuiz(subject, 'quiz-go');
		const admin: AccessSubject = { ...operator, staff: { operator: false, admin: true, extraPermissions: [] } };
		for (const outsider of [subject, admin]) {
			expect((await refusal(attemptsForReview(database.db, outsider, 'all', NOW))).code).toBe('forbidden');
			expect((await refusal(attemptForReview(database.db, outsider, attemptId, 'r'))).code).toBe('forbidden');
			expect((await refusal(annulAttempt(database.db, outsider, meta, attemptId, 'plagiarism', NOW))).code).toBe(
				'forbidden'
			);
		}
		const [attempt] = await database.db.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, attemptId));
		expect(attempt?.status).toBe('scored');
	});

	it('lists an attempt with departures for attention and reads it in full under the journal', async () => {
		const subject = await candidateSubject();
		const attemptId = await passQuiz(subject, 'quiz-sql');
		const attention = await attemptsForReview(database.db, operator, 'attention', NOW);
		const item = attention.find((entry) => entry.attemptId === attemptId);
		expect(item).toMatchObject({ status: 'scored', kind: 'quiz', stuck: false, annulReason: null });
		expect(item?.signals.departures).toBeGreaterThan(0);
		expect(item?.level).not.toBeNull();
		// The first screen counts what the queue lists.
		expect((await operatorOverview(database.db, operator, NOW)).attempts).toEqual({
			attention: attention.length,
			stuck: attention.filter((entry) => entry.stuck).length
		});

		const review = await attemptForReview(database.db, operator, attemptId, 'review-1');
		expect(review.quiz?.length).toBe(review.artifacts.filter((artifact) => artifact.kind === 'quiz_step').length);
		expect(review.quiz?.every((step) => step.correct)).toBe(true);
		expect(review.current?.id).toBe(review.scores[0]?.id);
		expect(review.facts).toEqual([
			expect.objectContaining({ status: 'active', statusReason: null, scoreId: review.current?.id })
		]);
		const events = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.objectId, attemptId), eq(auditEvents.actorUserId, operator.userId ?? '')));
		expect(events.map((event) => event.action).sort()).toEqual(['assessment.artifact_viewed', 'operator.case_access']);
		expect(events.find((event) => event.action === 'operator.case_access')?.details).toEqual({
			case_type: 'assessment',
			case_id: attemptId
		});
	});
});

describe('annulment', () => {
	it('annuls the fact and its receipt, recalculates the profile and is idempotent', async () => {
		const subject = await candidateSubject();
		const candidateId = candidateIdOf(subject);
		const attemptId = await passQuiz(subject, 'quiz-python');
		const [fact] = await database.db
			.select()
			.from(sourceFacts)
			.where(and(eq(sourceFacts.ownershipRef, attemptId), eq(sourceFacts.source, 'platform_test')));
		if (!fact) throw new Error('the attempt became no fact');
		const handle = await receiptOf(fact.id, fact.payloadSha256);
		expect((await verifyReceipt(database.db, handle))?.status).toBe('valid');
		const [before] = await database.db.select().from(candidates).where(eq(candidates.id, candidateId));
		expect(await ownAttemptAnnulment(database.db, subject, attemptId)).toBeNull();

		const outcome = await annulAttempt(database.db, operator, meta, attemptId, 'plagiarism', NOW);
		expect(outcome).toEqual({ annulled: true, factsAnnulled: 1 });
		// The candidate reads why on the page of the attempt; another candidate does not find it.
		expect(await ownAttemptAnnulment(database.db, subject, attemptId)).toEqual({
			reason: 'plagiarism',
			annulledAt: NOW,
			countsTowardLimit: true
		});
		expect((await refusal(ownAttemptAnnulment(database.db, await candidateSubject(), attemptId))).code).toBe(
			'not_found'
		);

		const [attempt] = await database.db.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, attemptId));
		expect(attempt).toMatchObject({
			status: 'annulled',
			annulReason: 'plagiarism',
			annulledBy: operator.userId,
			annulledAt: NOW
		});
		const [after] = await database.db.select().from(sourceFacts).where(eq(sourceFacts.id, fact.id));
		expect(after).toMatchObject({ status: 'annulled', statusReason: 'attempt_annulled' });
		const factClaims = await database.db.select().from(claims).where(eq(claims.factId, fact.id));
		expect(factClaims.length).toBeGreaterThan(0);
		expect(factClaims.every((claim) => claim.status === 'invalidated')).toBe(true);
		expect((await verifyReceipt(database.db, handle))?.status).toBe('annulled');

		const [candidate] = await database.db.select().from(candidates).where(eq(candidates.id, candidateId));
		expect(candidate?.profileRevision).toBe((before?.profileRevision ?? 0) + 1);
		expect(candidate?.evidenceFloorRevision).toBe(candidate?.profileRevision);
		const recalculation = await database.db
			.select()
			.from(jobs)
			.where(
				and(eq(jobs.type, 'evidence.compute'), eq(jobs.status, 'queued'), eq(jobs.dedupKey, `evidence:${candidateId}`))
			);
		expect(recalculation).toHaveLength(1);

		const annulments = () =>
			database.db
				.select()
				.from(auditEvents)
				.where(and(eq(auditEvents.action, 'assessment.annulled'), eq(auditEvents.objectId, attemptId)));
		const [event] = await annulments();
		expect(event).toMatchObject({
			actorUserId: operator.userId,
			subjectCandidateId: candidateId,
			details: { reason: 'plagiarism', previous_status: 'scored', facts_annulled: 1 }
		});

		expect(await annulAttempt(database.db, operator, meta, attemptId, 'technical_failure', NOW)).toEqual({
			annulled: false,
			factsAnnulled: 0
		});
		expect(await annulments()).toHaveLength(1);
		const [still] = await database.db.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, attemptId));
		expect(still?.annulReason).toBe('plagiarism');
		const [unchanged] = await database.db.select().from(candidates).where(eq(candidates.id, candidateId));
		expect(unchanged?.profileRevision).toBe(candidate?.profileRevision);

		// The candidate is told once: the test and whether the attempt still counts, the reason as a code.
		const [notice, ...more] = await annulNotices(subject);
		expect(more).toEqual([]);
		expect(notice?.row).toMatchObject({
			category: 'account',
			objectType: 'assessment_attempt',
			objectId: attemptId,
			payload: { attempt_id: attemptId, reason: 'plagiarism' }
		});
		expect(notice?.letter.text).toContain('аннулировал попытку теста «');
		expect(notice?.letter.text).toContain('Попытка засчитывается в лимит');
		expect(notice?.letter.text).not.toContain('plagiarism');
		if (!notice || subject.userId === null) throw new Error('no notification');
		expect(await openNotification(database.db, subject.userId, notice.row.id, NOW)).toMatchObject({
			target: { kind: 'candidate_attempt', attemptId }
		});
		// Nobody else is led to the attempt.
		expect(await openNotification(database.db, operator.userId ?? '', notice.row.id, NOW)).toBeNull();
	});

	it('cancels the waiting run of a submission and refuses an attempt that was not sent', async () => {
		const subject = await candidateSubject();
		const { attemptId } = await startAttempt(database.db, subject, assessmentId('py-access-log'), NOW);
		const early = await refusal(annulAttempt(database.db, operator, meta, attemptId, 'technical_failure', NOW));
		expect(early.code).toBe('conflict');
		expect(early.details?.[0]?.code).toBe('attempt_not_sent');

		const { artifactId } = await submitCode(
			database.db,
			subject,
			attemptId,
			{ language: 'python3', source: 'print(1)\n', signals: null },
			NOW
		);
		const runJob = () =>
			database.db
				.select({ status: jobs.status })
				.from(jobs)
				.where(and(eq(jobs.type, 'assessment.run'), eq(jobs.dedupKey, `assessment.run:${artifactId}`)));
		expect(await runJob()).toEqual([{ status: 'queued' }]);

		expect(await annulAttempt(database.db, operator, meta, attemptId, 'technical_failure', NOW)).toEqual({
			annulled: true,
			factsAnnulled: 0
		});
		expect(await runJob()).toEqual([{ status: 'cancelled' }]);
		const [event] = await database.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'assessment.annulled'), eq(auditEvents.objectId, attemptId)));
		expect(event?.details).toEqual({ reason: 'technical_failure', previous_status: 'submitted', facts_annulled: 0 });
		const [notice] = await annulNotices(subject);
		expect(notice?.letter.text).toContain('Попытка не засчитывается в лимит');
		expect(await ownAttemptAnnulment(database.db, subject, attemptId)).toMatchObject({
			reason: 'technical_failure',
			countsTowardLimit: false
		});

		const all = await attemptsForReview(database.db, operator, 'all', NOW);
		expect(all.find((entry) => entry.attemptId === attemptId)).toMatchObject({
			status: 'annulled',
			annulReason: 'technical_failure'
		});
		const attention = await attemptsForReview(database.db, operator, 'attention', NOW);
		expect(attention.some((entry) => entry.attemptId === attemptId)).toBe(false);
	});
});

describe('the size of the queue', () => {
	it('counts every attempt that asks for a person, beyond the latest hundred the list shows', async () => {
		const before = await attemptsForReviewCount(database.db, operator, NOW);
		const subject = await candidateSubject();
		const { attemptId } = await startAttempt(database.db, subject, assessmentId('py-access-log'), NOW);
		const [started] = await database.db.select().from(assessmentAttempts).where(eq(assessmentAttempts.id, attemptId));
		if (!started) throw new Error('attempt not started');
		// Submissions the sandbox has not judged for an hour: each one is stuck.
		const submittedAt = new Date(NOW.getTime() - 3_600_000);
		await database.db.insert(assessmentAttempts).values(
			Array.from({ length: 101 }, () => ({
				candidateId: started.candidateId,
				versionId: started.versionId,
				startedAt: submittedAt,
				submittedAt,
				deadlineAt: NOW,
				status: 'submitted' as const
			}))
		);

		expect(await attemptsForReview(database.db, operator, 'attention', NOW)).toHaveLength(100);
		const counted = { attention: before.attention + 101, stuck: before.stuck + 101 };
		expect(await attemptsForReviewCount(database.db, operator, NOW)).toEqual(counted);
		expect((await operatorOverview(database.db, operator, NOW)).attempts).toEqual(counted);
		const candidate: AccessSubject = { ...operator, staff: { operator: false, admin: false, extraPermissions: [] } };
		expect((await refusal(attemptsForReviewCount(database.db, candidate, NOW))).code).toBe('forbidden');
	});
});
